import "server-only";

import type { TripStrategy } from "@/lib/ai";
import { LIMITS, OSM_ATTRIBUTION } from "@/lib/providers/osm/config";
import { discoverPlaces } from "@/lib/providers/osm";
import {
  PLACE_CATEGORY_LABELS,
  buildVerifiedPlacePool,
  type GeocodedDestinationRecord,
  type GenerationWarning,
  type PlaceCategory,
  type TripPlace,
} from "@/lib/schemas";
import { MAX_PERSISTED_POOL_PLACES } from "@/lib/schemas/generation";

import type { DiscoveryOutcome } from "./types";

/**
 * Strategy → one exact `VerifiedPlacePool`.
 *
 * The hinge of the whole phase. Everything before it is a model deciding what
 * *kinds* of place a trip needs; everything after it may only reference what this
 * function actually found.
 *
 * ## Bounded, and bounded where it can be audited
 *
 * Overpass is a volunteer service. The caps below are enforced here rather than
 * trusted to the strategy, because "the model asked for a 40 km radius" is not a
 * reason to issue a 40 km query:
 *
 *  - at most `MAX_DISCOVERY_REQUESTS` Overpass requests per generation
 *  - at most `LIMITS.maxCategoriesPerRequest` (8) categories per request
 *  - a radius clamped here, and clamped again by the query builder
 *  - a per-category result cap, and a total pool cap
 *
 * The requests run concurrently, which sounds like it contradicts restraint and
 * does not: the process-wide limiter in `lib/providers/osm/rate-limit.ts` serialises
 * them at one per second regardless. Issuing them together lets the limiter own the
 * pacing instead of duplicating it here, and the total is capped at three either way.
 *
 * ## Partial discovery is a result, not an error
 *
 * A category that returns nothing produces a warning and an empty bucket. It never
 * produces a substituted category, a widened radius on a second attempt, or a
 * fabricated place. The assembly call is told which categories came back empty, so
 * it can mark those slots unavailable rather than guessing why its options are thin.
 */

/**
 * Three requests, 8 categories each — 24 slots against a 22-entry allowlist, so a
 * strategy can ask for every category in the vocabulary and still fit. There is no
 * plausible fourth request.
 */
export const MAX_DISCOVERY_REQUESTS = 3;

/** Ceilings applied before the query builder's own. */
export const DISCOVERY_LIMITS = {
  minRadiusMeters: 1_000,
  maxRadiusMeters: 12_000,
  minPerCategory: 4,
  maxPerCategory: 15,
  maxPoolPlaces: MAX_PERSISTED_POOL_PLACES,
} as const;

export type DiscoverForStrategyInput = {
  strategy: TripStrategy;
  destination: GeocodedDestinationRecord;
  signal?: AbortSignal;
};

export async function discoverForStrategy(
  input: DiscoverForStrategyInput,
): Promise<DiscoveryOutcome> {
  const categories = requestedCategories(input.strategy);
  const radiusMeters = clampRadius(input.strategy.recommendedRadiusMeters);
  const limitPerCategory = perCategoryLimit(input.strategy);

  const batches = chunk(categories, LIMITS.maxCategoriesPerRequest).slice(
    0,
    MAX_DISCOVERY_REQUESTS,
  );

  const dropped = categories.slice(
    batches.reduce((count, batch) => count + batch.length, 0),
  );

  const center = {
    latitude: input.destination.latitude,
    longitude: input.destination.longitude,
  };

  /**
   * `allSettled`, not `all`.
   *
   * One batch failing must not lose the other two. A trip with restaurants and
   * museums but no viewpoints is a usable trip with an honest gap; a trip with
   * nothing because the third query timed out is a wasted model call.
   */
  const settled = await Promise.allSettled(
    batches.map((batch) =>
      discoverPlaces({
        center,
        categories: batch,
        radiusMeters,
        limitPerCategory,
        signal: input.signal,
      }),
    ),
  );

  const warnings: GenerationWarning[] = [];
  const places: TripPlace[] = [];
  const emptyCategories = new Set<PlaceCategory>();
  let discardedCount = 0;

  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      // The provider's own message is not repeated: it can name a host. The
      // categories are ours and are safe, and they are what makes the warning
      // actionable.
      for (const category of batches[index]) emptyCategories.add(category);
      warnings.push({
        code: "discovery_batch_failed",
        message: `The place search for ${describeCategories(batches[index])} did not complete, so those slots may be left open.`,
      });
      return;
    }

    places.push(...result.value.places);
    discardedCount += result.value.discarded.total;
    for (const category of result.value.query.categoriesWithNoResults) {
      emptyCategories.add(category);
    }
  });

  for (const category of dropped) {
    emptyCategories.add(category);
    warnings.push({
      code: "discovery_category_dropped",
      message: `The plan asked for more kinds of place than one generation may search for, so ${PLACE_CATEGORY_LABELS[category]} was not searched.`,
    });
  }

  for (const category of emptyCategories) {
    if (dropped.includes(category)) continue;
    warnings.push({
      code: "discovery_empty_category",
      message: `OpenStreetMap has no ${PLACE_CATEGORY_LABELS[category].toLowerCase()} mapped within ${Math.round(radiusMeters / 100) / 10} km of this destination, so any slot needing one is left open.`,
    });
  }

  /**
   * Ordered and capped *before* the pool is built, so the pool is exactly what the
   * model will be shown and exactly what validation will check against. Building a
   * larger pool and truncating the prompt separately would create two different
   * ideas of what was discovered — and the model's would be the smaller one.
   */
  const ordered = orderForPool(places);
  const capped = ordered.slice(0, DISCOVERY_LIMITS.maxPoolPlaces);

  if (ordered.length > capped.length) {
    warnings.push({
      code: "discovery_pool_capped",
      message: `The search found ${ordered.length} places; the best ${capped.length} were kept for planning.`,
    });
  }

  const fetchedAt = new Date().toISOString();

  const pool = buildVerifiedPlacePool(capped, {
    /**
     * Deterministic and self-describing. The same destination, radius and category
     * set always yields the same pool id, so a cached run and a fresh one are
     * indistinguishable — and nobody reading a log can mistake it for
     * `plan-derived:…`, which is the fallback with no provenance.
     */
    poolId: [
      "discovery",
      input.destination.canonicalId,
      radiusMeters,
      categories.join("+"),
    ].join(":"),
    createdAt: fetchedAt,
    categories,
    attribution: OSM_ATTRIBUTION,
    destination: {
      canonicalId: input.destination.canonicalId,
      name: input.destination.name,
      latitude: input.destination.latitude,
      longitude: input.destination.longitude,
    },
  });

  return {
    pool,
    summary: {
      categoriesRequested: categories,
      categoriesWithNoResults: [...emptyCategories].sort(),
      radiusMeters,
      requestCount: batches.length,
      candidateCount: pool.places.length,
      discardedCount,
      attribution: OSM_ATTRIBUTION,
    },
    warnings,
  };
}

/**
 * Every category the strategy asked for, deduplicated, in a stable order.
 *
 * Sorted rather than kept in strategy order: the order decides which categories
 * survive the request cap, and "whichever day the model happened to mention it on"
 * is not a defensible tie-break. Sorting makes the cap deterministic and the pool id
 * stable.
 */
export function requestedCategories(strategy: TripStrategy): PlaceCategory[] {
  const seen = new Set<PlaceCategory>();
  for (const day of strategy.days) {
    for (const slot of day.searchRequirements) seen.add(slot.category);
  }
  return [...seen].sort();
}

export function clampRadius(requested: number): number {
  if (!Number.isFinite(requested)) return LIMITS.defaultRadiusMeters;
  return Math.min(
    DISCOVERY_LIMITS.maxRadiusMeters,
    Math.max(DISCOVERY_LIMITS.minRadiusMeters, Math.round(requested)),
  );
}

/**
 * The per-category result cap, from the largest `candidateLimit` the strategy asked
 * for.
 *
 * The *largest* rather than an average, because the cap is per category and a
 * category serving a slot that wanted eight options should return eight. Clamped at
 * both ends: too few makes the assembly call's choice illusory, too many spends
 * prompt budget on candidates it will never reach.
 */
export function perCategoryLimit(strategy: TripStrategy): number {
  const requested = Math.max(
    ...strategy.days.flatMap((day) =>
      day.searchRequirements.map((slot) => slot.candidateLimit),
    ),
  );
  if (!Number.isFinite(requested)) return DISCOVERY_LIMITS.minPerCategory;
  return Math.min(
    DISCOVERY_LIMITS.maxPerCategory,
    Math.max(DISCOVERY_LIMITS.minPerCategory, requested),
  );
}

/**
 * Deduplicated and ordered deterministically.
 *
 * Two batches can legitimately return the same element — a `historic=church` matches
 * both `historic_site` and `place_of_worship` filters — and a pool may not contain a
 * duplicate id, so the first occurrence wins. The ordering is category then name,
 * matching `dedupeAndOrder`, so the pool reads the same regardless of which batch
 * finished first.
 */
export function orderForPool(places: TripPlace[]): TripPlace[] {
  const byId = new Map<string, TripPlace>();
  for (const place of places) {
    if (!byId.has(place.placeId)) byId.set(place.placeId, place);
  }
  return [...byId.values()].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    const byName = a.name.localeCompare(b.name, "en");
    if (byName !== 0) return byName;
    return a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
  });
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function describeCategories(categories: PlaceCategory[]): string {
  return categories
    .map((category) => PLACE_CATEGORY_LABELS[category].toLowerCase())
    .join(", ");
}
