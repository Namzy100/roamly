import type {
  ItineraryDay,
  PlaceCategory,
  TripPlace,
  TripPlan,
  VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * Which places Roamly may ask Wikimedia about, and how many.
 *
 * ## What eligibility is not
 *
 * It is **not** a claim that a Wikidata entity exists. It answers one narrower question: *is this the kind of place a
 * public-interest encyclopaedia would plausibly cover, such that asking is a reasonable use of a volunteer-run
 * service?* A museum that turns out to have no entity was still eligible; a café with an entity was never eligible.
 *
 * Keeping those apart is what stops the helper being used as a lookup. Nothing here fetches, and nothing here can —
 * it takes a plan and a pool and returns places.
 *
 * ## Why a category allow-list rather than a heuristic
 *
 * The failure to design against is this checkpoint's own words: "no enrichment request for every restaurant in a
 * pool". A discovery pass for a five-day trip can return a hundred cafés and restaurants, and a heuristic that asked
 * about "anything with a name" would issue a hundred requests to learn a hundred times that a café is not a landmark.
 *
 * So the policy is a closed set, stated once, in one place. A category outside it produces no request at all — which
 * is cheaper than any cache, because the request is never formed.
 *
 * ## Serial requests, so the cap is the real control
 *
 * `docs/PROVIDER_RESEARCH.md` records that Wikimedia publishes **no numeric rate limit** for the read path, and that
 * etiquette asks for serial rather than parallel requests. With no published budget, the honest design is a hard
 * ceiling on how many places one trip may ever ask about, and prioritisation so the ones that matter are inside it.
 */

/**
 * Categories where a Wikimedia entity is plausible enough to be worth asking about.
 *
 * Each inclusion is a public-interest place with genuine encyclopaedic coverage. The exclusions are as deliberate:
 *
 *  - **`market`** is excluded although a famous market hall is a landmark. Most tagged markets are ordinary shopping,
 *    and this set errs towards the cheap answer for the common case.
 *  - **`music_venue`** is excluded although a famous concert hall is one. In OSM the tag lands far more often on bars
 *    with a stage, and "branch business" and "temporary venue" are exactly what this checkpoint rules out. `theatre`
 *    is kept because the tag is far more selective.
 *  - **`place_of_worship`** is included even though the brief asked for *major* religious buildings and "major" is not
 *    derivable from an OSM tag. What makes it safe is that everything here must also clear the name and priority gates
 *    below: a parish church can be asked about, gets no answer, and costs one request from a bounded budget — where
 *    excluding the category outright would lose every cathedral in Europe.
 */
const ELIGIBLE_CATEGORIES: ReadonlySet<PlaceCategory> = new Set<PlaceCategory>([
  "museum",
  "gallery",
  "monument",
  "historic_site",
  "attraction",
  "viewpoint",
  "park",
  "garden",
  "beach",
  "place_of_worship",
  "theatre",
]);

/**
 * Categories that are commercial premises, not public-interest places.
 *
 * Listed rather than inferred as "not eligible", so a refusal can name the reason, and so adding a category to the
 * schema forces a decision here instead of silently defaulting either way.
 */
const COMMERCIAL_CATEGORIES: ReadonlySet<PlaceCategory> =
  new Set<PlaceCategory>([
    "restaurant",
    "cafe",
    "bar",
    "fast_food",
    "hotel",
    "hostel",
    "guest_house",
    "shopping",
    "winery",
    "market",
    "music_venue",
  ]);

/**
 * The most places one trip may ever ask Wikimedia about.
 *
 * Twelve. A five-day trip schedules roughly two or three landmarks a day, so this covers the scheduled set of a
 * realistic trip with a little room, and bounds the worst case at twelve **serial** requests rather than at the size
 * of the pool.
 *
 * Chosen to be defensible rather than tuned: with no published rate limit, a number justified only by "it seemed to
 * work" would be a guess dressed as a budget. Twelve is small enough that the serial requirement is comfortable and
 * large enough that a traveller's actual itinerary fits.
 */
export const MAX_LANDMARK_CANDIDATES_PER_TRIP = 12;

/**
 * The shortest name worth asking about.
 *
 * An OSM `name` of one or two characters is a mapping artefact rather than a name, and it could not be matched on
 * anyway — `wikidata-identity` refuses name-only evidence, and a two-character name corroborates nothing.
 */
const MINIMUM_NAME_LENGTH = 3;

export type EligibilityRefusalCode =
  | "commercial_premises"
  | "category_not_eligible"
  | "name_too_short";

export type LandmarkEligibility =
  | { eligible: true }
  | { eligible: false; code: EligibilityRefusalCode; reason: string };

/**
 * Whether Roamly may ask Wikimedia about this place.
 *
 * Deterministic and total: the same place always gets the same answer, and every `PlaceCategory` reaches one of the
 * three arms. Says nothing about whether an entity exists.
 */
export function landmarkEligibility(place: TripPlace): LandmarkEligibility {
  if (COMMERCIAL_CATEGORIES.has(place.category)) {
    return {
      eligible: false,
      code: "commercial_premises",
      reason: `A ${place.category} is commercial premises rather than a public-interest place, so no request is made.`,
    };
  }

  if (!ELIGIBLE_CATEGORIES.has(place.category)) {
    return {
      eligible: false,
      code: "category_not_eligible",
      reason: `The category “${place.category}” is not on the landmark allow-list.`,
    };
  }

  if (place.name.trim().length < MINIMUM_NAME_LENGTH) {
    return {
      eligible: false,
      code: "name_too_short",
      reason:
        "The name is too short to identify or corroborate anything, so asking would cost a request for an answer nothing could use.",
    };
  }

  return { eligible: true };
}

/** The common case, phrased as a question. */
export function isLandmarkEligible(place: TripPlace): boolean {
  return landmarkEligibility(place).eligible;
}

export type LandmarkCandidate = {
  place: TripPlace;
  /**
   * Why this place is in the list, which is also its priority band.
   *
   *  - `scheduled` — the traveller has this stop in their itinerary. Enriching it changes what they see.
   *  - `backup` — a fallback they may promote. Worth having ready, but only after every scheduled stop.
   *  - `pool` — an unused search result. Enriching it changes nothing until they choose it, so it is last and is
   *    usually cut by the cap. Present at all only so a trip with few scheduled landmarks still gets some benefit.
   */
  source: "scheduled" | "backup" | "pool";
  /** Set for `scheduled` and `backup`, so ordering can follow the trip rather than the pool. */
  dayNumber?: number;
};

const SOURCE_RANK: Record<LandmarkCandidate["source"], number> = {
  scheduled: 0,
  backup: 1,
  pool: 2,
};

/**
 * The places one trip may ask about, in the order to ask, capped.
 *
 * ## Why scheduled stops come first, and it is not merely a preference
 *
 * The cap means the tail is genuinely discarded. If ordering were pool-first, a trip whose pool holds forty museums
 * would spend its entire budget on museums the traveller never sees and enrich none of the ones they visit. So the
 * order *is* the priority: itinerary, then fallbacks, then the rest.
 *
 * ## Deterministic, and total
 *
 * Band, then day, then name, then `placeId`. The last two make it total, so the same trip always produces the same
 * twelve — which is what makes a cache useful and the tests meaningful. A place scheduled on two days appears once: it
 * is one place, and asking twice would spend two of twelve on one answer.
 *
 * Pure. Nothing here fetches, which is also how "no provider call on initial landing-page load" is guaranteed rather
 * than remembered — a derivation cannot make a request, so the only way to issue one is to call a client deliberately,
 * somewhere else, after this has decided what to ask about.
 */
export function selectLandmarkCandidates(input: {
  plan: TripPlan;
  pool?: VerifiedPlacePool | null;
  limit?: number;
}): LandmarkCandidate[] {
  const byPlaceId = new Map<string, LandmarkCandidate>();

  const consider = (candidate: LandmarkCandidate): void => {
    if (!isLandmarkEligible(candidate.place)) return;

    const existing = byPlaceId.get(candidate.place.placeId);
    /* First band wins: a place both scheduled and in the pool is a scheduled place. */
    if (
      existing &&
      SOURCE_RANK[existing.source] <= SOURCE_RANK[candidate.source]
    ) {
      return;
    }
    byPlaceId.set(candidate.place.placeId, candidate);
  };

  for (const day of input.plan.days) {
    for (const item of day.items) {
      if (!item.place) continue;
      consider({
        place: item.place,
        source: "scheduled",
        dayNumber: day.dayNumber,
      });
    }
  }

  for (const day of input.plan.days) {
    for (const place of backupsOf(day)) {
      consider({ place, source: "backup", dayNumber: day.dayNumber });
    }
  }

  for (const place of input.pool?.places ?? []) {
    consider({ place, source: "pool" });
  }

  const ordered = [...byPlaceId.values()].sort((a, b) => {
    const byBand = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (byBand !== 0) return byBand;

    const byDay =
      (a.dayNumber ?? Number.MAX_SAFE_INTEGER) -
      (b.dayNumber ?? Number.MAX_SAFE_INTEGER);
    if (byDay !== 0) return byDay;

    const byName = a.place.name.localeCompare(b.place.name, "en");
    if (byName !== 0) return byName;

    return a.place.placeId < b.place.placeId
      ? -1
      : a.place.placeId > b.place.placeId
        ? 1
        : 0;
  });

  return ordered.slice(0, input.limit ?? MAX_LANDMARK_CANDIDATES_PER_TRIP);
}

/** A day's backup places. Extracted because `backups` is a `BackupOption[]`, not a place list. */
function backupsOf(day: ItineraryDay): TripPlace[] {
  return day.backups.map((backup) => backup.place);
}
