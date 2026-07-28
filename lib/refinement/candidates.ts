import type { ModelPlaceCandidate } from "@/lib/ai";
import { toCandidate } from "@/lib/generate/candidates";
import { haversineMeters } from "@/lib/routing";
import type {
  ItineraryDay,
  PlaceCategory,
  TripPlace,
  TripPlan,
  VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * Deriving which places a refinement may choose from.
 *
 * **The single authority.** Item replacement, backup replacement and day
 * adjustment all narrow the pool through this module, so "what is eligible" has
 * one answer. Two derivations would eventually disagree, and the one that was
 * wrong would be the one that let an ineligible place through.
 *
 * ## Filtering, and the line it does not cross
 *
 * Every filter below is a fact: is this place in the saved pool, is it the right
 * category, is it already used today, is it within a sane distance of the stop it
 * would replace. None of them is a judgement about quality, and there is
 * deliberately **no score of any kind** — no relevance, no popularity, no
 * "recommended". OpenStreetMap supplies nothing to build one from, so any number
 * we produced would be our opinion presented to the model as data, and it would
 * come back out the other side inside a sentence a traveller would read as a fact.
 *
 * ## Ordering
 *
 * **Distance from the anchor, ascending; ties broken by name, then by `placeId`.**
 *
 * Distance is used because it is a real, checkable property and because a nearer
 * replacement is genuinely better for the *schedule* — it keeps the day's travel
 * roughly as it was, which is the whole point of swapping one stop rather than
 * replanning. That is a claim about geometry, not about the place.
 *
 * The tie-breaks make the order total, so the same pool and the same anchor always
 * produce the same prompt. When there is no anchor (a day adjustment has no single
 * stop to measure from) the order falls back to the pool's own — category, then
 * name, then id — which is likewise deterministic.
 */

/** A refinement prompt is small; a long list only crowds the answer. */
export const MAX_REFINEMENT_CANDIDATES = 30;

/**
 * How far from the stop being replaced a candidate may sit.
 *
 * Generous, because the pool is already bounded by the discovery radius and a
 * traveller asking to replace a stop may well accept one across town. It exists to
 * stop a replacement landing 20 km away and quietly turning a walk into a taxi.
 */
export const REPLACEMENT_RADIUS_METERS = 6_000;

export type CandidateFilter = {
  /**
   * Only these categories are eligible.
   *
   * `undefined` means no category filter. An **empty array means nothing is
   * eligible** — the two are deliberately different. `filterForReplacement` returns
   * an empty list when a preference rules out every category ("quieter" on a trip
   * whose only option is a bar), and treating that as "no filter" would offer every
   * kind of place instead of admitting the request cannot be met.
   */
  categories?: PlaceCategory[];
  /** Never offered — the place being replaced. */
  excludePlaceIds?: string[];
  /** Distance is measured from here, and bounds eligibility when `radiusMeters` is set. */
  anchor?: { lat: number; lng: number };
  radiusMeters?: number;
  /**
   * `true` keeps indoor-ish categories, `false` keeps outdoor-ish ones.
   *
   * Note what is **not** here: a "cheaper" filter. Cost bands are per category and
   * a replacement preserves the category, so every eligible candidate shares one
   * band — "cheaper" cannot be expressed as a filter. It is passed to the model as
   * a preference about the *allowance* and then verified: the replacement's
   * estimate must actually be lower. See `validate.ts`.
   */
  indoor?: boolean;
  limit?: number;
};

/**
 * Categories that are indoors in any weather.
 *
 * A judgement about the *kind of place*, not about a specific one, and a shallow
 * one — a market may be covered or not. It is used only to order a preference the
 * traveller expressed, never to make a claim in the plan, and "indoor" never
 * appears in generated text.
 *
 * Exported for `lib/structural-edits/stop-alternatives.ts`, which labels an option
 * indoor or outdoor on a comparison card. Shared rather than copied: two sets would
 * eventually disagree about a winery, and the disagreement would show up as a filter
 * and a label contradicting each other about the same place.
 */
export const INDOOR_CATEGORIES: ReadonlySet<PlaceCategory> = new Set([
  "museum",
  "gallery",
  "theatre",
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "shopping",
  "winery",
  "place_of_worship",
  "hotel",
  "hostel",
  "guest_house",
]);

/** Categories a traveller asking for "quieter" is unlikely to want. */
const BUSY_CATEGORIES: ReadonlySet<PlaceCategory> = new Set([
  "bar",
  "music_venue",
  "fast_food",
  "shopping",
  "market",
]);

export type EligibleCandidates = {
  places: TripPlace[];
  candidates: ModelPlaceCandidate[];
  /** True when the cap left something out, so the caller can warn. */
  truncated: boolean;
};

export function deriveEligibleCandidates(
  pool: VerifiedPlacePool,
  filter: CandidateFilter,
): EligibleCandidates {
  const excluded = new Set(filter.excludePlaceIds ?? []);
  // `undefined` → no filter. `[]` → a set that matches nothing, which is the point.
  const categories = filter.categories ? new Set(filter.categories) : null;

  const anchor = filter.anchor ?? null;

  const eligible = pool.places.filter((place) => {
    if (excluded.has(place.placeId)) return false;
    if (categories && !categories.has(place.category)) return false;

    if (anchor && filter.radiusMeters !== undefined) {
      const metres = haversineMeters(
        { latitude: anchor.lat, longitude: anchor.lng },
        { latitude: place.coordinates.lat, longitude: place.coordinates.lng },
      );
      if (metres > filter.radiusMeters) return false;
    }

    if (filter.indoor !== undefined) {
      if (INDOOR_CATEGORIES.has(place.category) !== filter.indoor) return false;
    }

    return true;
  });

  const ordered = orderCandidates(eligible, anchor);
  const limit = filter.limit ?? MAX_REFINEMENT_CANDIDATES;
  const kept = ordered.slice(0, limit);

  return {
    places: kept,
    // `toCandidate` is generation's own projection, reused verbatim: the model must
    // see a replacement candidate exactly as it saw the original.
    candidates: kept.map(toCandidate),
    truncated: ordered.length > kept.length,
  };
}

/**
 * Distance ascending from the anchor, then name, then id. Total and stable.
 *
 * Without an anchor the pool's own order is preserved, which is already total.
 */
export function orderCandidates(
  places: TripPlace[],
  anchor: { lat: number; lng: number } | null,
): TripPlace[] {
  if (!anchor) return [...places];

  const distanceOf = new Map(
    places.map((place) => [
      place.placeId,
      haversineMeters(
        { latitude: anchor.lat, longitude: anchor.lng },
        { latitude: place.coordinates.lat, longitude: place.coordinates.lng },
      ),
    ]),
  );

  return [...places].sort((a, b) => {
    const byDistance =
      (distanceOf.get(a.placeId) ?? 0) - (distanceOf.get(b.placeId) ?? 0);
    // Rounded to the metre before comparing, so float noise cannot make the order
    // depend on which two places happen to be 0.4 mm apart.
    if (Math.round(byDistance) !== 0) return byDistance;
    const byName = a.name.localeCompare(b.name, "en");
    if (byName !== 0) return byName;
    return a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
  });
}

/**
 * The places a plan is already using, so a replacement does not duplicate one.
 *
 * `scope: "day"` is the right default for a stop replacement — visiting the same
 * museum on two different days is a legitimate plan, and excluding the whole trip
 * would shrink a thin pool for no reason. `scope: "trip"` is available for
 * regeneration-adjacent work.
 */
export function placesInUse(
  plan: TripPlan,
  scope: ({ day: ItineraryDay } | { trip: true }) & {
    /**
     * Whether a place that is currently only a *backup* counts as in use.
     *
     * `true` (the default) is right for replacing a stop: offering the day's own
     * fallback as its replacement is not an alternative.
     *
     * `false` is right for a day adjustment, because a backup is not a scheduled stop
     * — promoting one into the day is a perfectly good way to make the day cheaper or
     * fuller, and excluding it would rule out the obvious answer.
     */
    includeBackups?: boolean;
  },
): Set<string> {
  const days = "day" in scope ? [scope.day] : plan.days;
  const includeBackups = scope.includeBackups ?? true;
  const used = new Set<string>();

  for (const day of days) {
    for (const item of day.items) {
      if (item.place) used.add(item.place.placeId);
    }
    if (!includeBackups) continue;
    for (const backup of day.backups) {
      used.add(backup.place.placeId);
    }
  }

  return used;
}

/**
 * Turning a replacement command's preferences into a filter.
 *
 * `category` widens the eligible set to a different kind of place; everything else
 * narrows it. A preference that leaves nothing eligible produces
 * `no_eligible_candidates`, which is a truthful outcome — better than relaxing the
 * preference silently and handing back something the traveller did not ask for.
 */
export function filterForReplacement(input: {
  pool: VerifiedPlacePool;
  current: TripPlace;
  excludePlaceIds: string[];
  preferences?: {
    cheaper?: boolean;
    quieter?: boolean;
    indoor?: boolean;
    outdoor?: boolean;
    category?: PlaceCategory;
  };
}): CandidateFilter {
  const preferences = input.preferences ?? {};

  /**
   * The category is preserved unless the traveller explicitly asked for another.
   *
   * A slot exists for a reason — a lunch slot filled with a museum is not a
   * refinement, it is a different day. Overriding it is possible and has to be
   * asked for.
   */
  const categories: PlaceCategory[] = preferences.category
    ? [preferences.category]
    : [input.current.category];

  const filter: CandidateFilter = {
    categories,
    excludePlaceIds: [input.current.placeId, ...input.excludePlaceIds],
    anchor: input.current.coordinates,
    radiusMeters: REPLACEMENT_RADIUS_METERS,
  };

  if (preferences.indoor === true) filter.indoor = true;
  if (preferences.outdoor === true) filter.indoor = false;

  if (preferences.quieter === true) {
    filter.categories = categories.filter(
      (category) => !BUSY_CATEGORIES.has(category),
    );
    // A quieter café is still a café. If the only eligible category was a busy one
    // the request cannot be met, and saying so beats offering a nightclub.
  }

  return filter;
}

/** True when the traveller asked for something cheaper than what is there now. */
export function wantsCheaper(preferences?: { cheaper?: boolean }): boolean {
  return preferences?.cheaper === true;
}
