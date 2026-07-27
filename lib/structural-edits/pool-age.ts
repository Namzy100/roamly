import type { TripGenerationContext } from "@/lib/schemas";

/**
 * How old a trip's place search is.
 *
 * ## A product threshold, not a claim about OpenStreetMap
 *
 * "Stale" here means *we last looked a while ago*. It does **not** mean the places have
 * closed, moved, or become invalid — OSM data for a museum may not change in a decade, and a
 * café can shut the week after a refresh. The wording throughout says "may be outdated" and
 * never "is outdated", because the second would be a claim about the world that the age of a
 * cache cannot support.
 *
 * The thresholds exist so a traveller can decide whether refreshing is worth an Overpass
 * request, and for no other reason.
 *
 * ## The clock is an argument
 *
 * `now` is passed in rather than read. A component reading `Date.now()` during render is the
 * classic hydration mismatch, and a test that depended on the real clock would pass today and
 * fail in a month. Every caller supplies it from an event handler or a fixture.
 */

export const POOL_AGE_THRESHOLDS = {
  /** Under a week: no reason to look again. */
  freshDays: 7,
  /** Under a month: worth knowing, not worth prompting. */
  agingDays: 30,
} as const;

export type PoolAgeState = "fresh" | "aging" | "stale" | "unknown";

export type PoolAge = {
  state: PoolAgeState;
  /** Whole days, or null when the pool has no readable timestamp. */
  ageDays: number | null;
  fetchedAt: string | null;
  placeCount: number;
  /** Never phrased as a claim about the places themselves. */
  label: string;
};

export function describePoolAge(input: {
  generation: TripGenerationContext | null;
  now: Date;
}): PoolAge {
  const generation = input.generation;

  if (!generation) {
    return {
      state: "unknown",
      ageDays: null,
      fetchedAt: null,
      placeCount: 0,
      label: "This trip has no saved place search behind it.",
    };
  }

  const placeCount = generation.placePool.places.length;
  const fetchedAt = generation.placePool.createdAt;
  const at = Date.parse(fetchedAt);

  if (!Number.isFinite(at)) {
    return {
      state: "unknown",
      ageDays: null,
      fetchedAt: null,
      placeCount,
      label: `${placeCount} places found. When the search ran is not recorded.`,
    };
  }

  /**
   * Floored, and clamped at zero.
   *
   * A negative age means the stored timestamp is ahead of this device's clock — a machine
   * with the wrong date, or a trip synced from one. "Updated −2 days ago" is nonsense, and
   * treating it as fresh is the harmless reading.
   */
  const ageDays = Math.max(
    0,
    Math.floor((input.now.getTime() - at) / (24 * 60 * 60 * 1_000)),
  );

  const state: PoolAgeState =
    ageDays < POOL_AGE_THRESHOLDS.freshDays
      ? "fresh"
      : ageDays < POOL_AGE_THRESHOLDS.agingDays
        ? "aging"
        : "stale";

  return { state, ageDays, fetchedAt, placeCount, label: labelFor(state, ageDays) };
}

function labelFor(state: PoolAgeState, ageDays: number): string {
  const when =
    ageDays === 0
      ? "today"
      : ageDays === 1
        ? "yesterday"
        : `${ageDays} days ago`;

  switch (state) {
    case "fresh":
      return `Place pool updated ${when}.`;
    case "aging":
      return `Place pool updated ${when}. Refreshing may find alternatives that have been mapped since.`;
    case "stale":
      // "May be outdated", never "is outdated". See the header note.
      return `Place pool updated ${when}, so it may be outdated. Refreshing looks again for what is mapped nearby.`;
    case "unknown":
      return "When this trip's place search ran is not recorded.";
  }
}

/**
 * Whether a refresh can be offered at all.
 *
 * Needs a real discovery context: a geocoded destination with an OSM identity, and a pool
 * that came from a search rather than from the plan itself. The sample trip has neither — its
 * pool id begins `plan-derived:` — and inventing an OSM context for it so the button could be
 * enabled would be fabricating provenance to make an interface tidier.
 */
export function canRefreshPool(generation: TripGenerationContext | null): boolean {
  if (!generation) return false;
  if (!generation.placePool.poolId.startsWith("discovery:")) return false;
  return generation.destination.source.provider === "openstreetmap";
}

export function refreshUnavailableReason(
  generation: TripGenerationContext | null,
): string | null {
  if (canRefreshPool(generation)) return null;

  if (!generation) {
    return "This is the sample itinerary, so there is no place search behind it to refresh. Plan a trip to get one.";
  }
  return "This trip's places did not come from a recorded OpenStreetMap search, so there is nothing to re-run. Generating a trip creates one.";
}
