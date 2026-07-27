import "server-only";

import { discoverPlaces } from "@/lib/providers/osm";
import {
  MAX_PERSISTED_POOL_PLACES,
  buildVerifiedPlacePool,
  type DiscoverySummary,
  type GenerationWarning,
  type PlaceCategory,
  type TripPlace,
  type VerifiedPlacePool,
} from "@/lib/schemas";
import { OSM_ATTRIBUTION } from "@/lib/providers/osm/config";

import { DISCOVERY_LIMITS, clampRadius, orderForPool } from "./discovery";

/**
 * Re-running a saved trip's place search.
 *
 * ## What this shares with generation, and why
 *
 * The same `discoverPlaces` adapter, the same category batching, the same `allSettled`
 * tolerance, the same ordering, the same cap, the same pool-id construction. Not because it is
 * convenient but because the two pools must be *comparable*: a diff between a pool built one
 * way and a pool built another would report differences that came from the code rather than
 * from the map. Sharing the derivation is what makes the diff mean something.
 *
 * ## What it does not do
 *
 * It does not geocode. The trip already records the destination it was built around, with an
 * OSM identity, and re-geocoding "Lisbon" could resolve to a different Lisbon — silently
 * moving the trip. If the stored identity is missing, this fails and says so rather than
 * choosing.
 *
 * It does not call a model. It does not route. It does not persist, and it does not reconcile:
 * deciding what a changed pool *means* for an itinerary is `lib/structural-edits/reconcile-pool.ts`,
 * which is pure and runs after the traveller has seen the diff.
 */

/**
 * The wall-clock budget, inside the route's `maxDuration`.
 *
 * Discovery is three paced Overpass requests at 3–8 s each. 45 s covers the unlucky case with
 * room to return, and the route allows 60. Deliberately much smaller than generation's 90 s,
 * because there is no model call in here at all.
 */
export const REFRESH_POOL_BUDGET_MS = 45_000;

/** Bounded like generation's: at most three requests, at most eight categories each. */
const MAX_REFRESH_REQUESTS = 3;
const MAX_CATEGORIES_PER_REQUEST = 8;

export type RefreshPoolInput = {
  destination: {
    canonicalId: string;
    name: string;
    latitude: number;
    longitude: number;
  };
  /** The categories to search. Defaults to the ones the original search covered. */
  categories: PlaceCategory[];
  radiusMeters: number;
  /** Kept from the original search so the pool shape stays comparable. */
  limitPerCategory: number;
  signal?: AbortSignal;
  /** Injected in tests so pool ids and timestamps are deterministic. */
  now?: () => string;
};

export type RefreshPoolOutcome =
  | {
      status: "ok";
      pool: VerifiedPlacePool;
      summary: DiscoverySummary;
      warnings: GenerationWarning[];
      /** True when at least one batch failed, so the pool is thinner than the map. */
      partial: boolean;
    }
  | { status: "failed"; reason: "no_results"; message: string };

export async function refreshPlacePool(
  input: RefreshPoolInput,
): Promise<RefreshPoolOutcome> {
  const now = input.now ?? (() => new Date().toISOString());
  const radiusMeters = clampRadius(input.radiusMeters);
  const categories = [...new Set(input.categories)].sort();

  const batches = chunk(categories, MAX_CATEGORIES_PER_REQUEST).slice(
    0,
    MAX_REFRESH_REQUESTS,
  );
  const dropped = categories.slice(
    batches.reduce((count, batch) => count + batch.length, 0),
  );

  const settled = await Promise.allSettled(
    batches.map((batch) =>
      discoverPlaces({
        center: {
          latitude: input.destination.latitude,
          longitude: input.destination.longitude,
        },
        categories: batch,
        radiusMeters,
        limitPerCategory: clampPerCategory(input.limitPerCategory),
        signal: input.signal,
      }),
    ),
  );

  const warnings: GenerationWarning[] = [];
  const places: TripPlace[] = [];
  const emptyCategories = new Set<PlaceCategory>();
  let discardedCount = 0;
  let partial = false;

  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      /**
       * A failed batch is reported as **partial**, never as absence.
       *
       * This is the distinction that makes a refresh safe to offer: "Overpass did not answer
       * for museums" and "there are no museums here" look identical in a pool and mean
       * opposite things. Without this flag, a timeout would present as every museum having
       * vanished, and the traveller would be asked to reconcile a loss that did not happen.
       */
      partial = true;
      for (const category of batches[index]) emptyCategories.add(category);
      // The provider's own message is not repeated — it can name a host.
      warnings.push({
        code: "refresh_batch_failed",
        message: `The search for ${batches[index].join(", ").replace(/_/g, " ")} did not complete, so those places are missing from this refresh rather than gone from the map.`,
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
    partial = true;
    emptyCategories.add(category);
    warnings.push({
      code: "refresh_category_dropped",
      message: `More kinds of place were requested than one refresh may search for, so ${category.replace(/_/g, " ")} was not searched.`,
    });
  }

  const ordered = orderForPool(places);
  const capped = ordered.slice(0, MAX_PERSISTED_POOL_PLACES);

  if (ordered.length > capped.length) {
    warnings.push({
      code: "refresh_pool_capped",
      message: `The refreshed search found ${ordered.length} places; the best ${capped.length} were kept.`,
    });
  }

  /**
   * An empty result is a hard failure rather than an empty pool.
   *
   * Replacing a working pool with nothing would strand every stop in the itinerary at once,
   * and the overwhelmingly likely cause is a provider problem rather than a destination that
   * has lost every mapped place.
   */
  if (capped.length === 0) {
    return {
      status: "failed",
      reason: "no_results",
      message:
        "The refreshed search returned no places at all, which usually means the place service is unavailable rather than that the destination has changed. Nothing was altered.",
    };
  }

  const fetchedAt = now();

  return {
    status: "ok",
    partial,
    // Identical construction to generation's, so the two pools are comparable.
    pool: buildVerifiedPlacePool(capped, {
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
    }),
    summary: {
      categoriesRequested: categories,
      categoriesWithNoResults: [...emptyCategories].sort(),
      radiusMeters,
      requestCount: batches.length,
      candidateCount: capped.length,
      discardedCount,
      attribution: OSM_ATTRIBUTION,
    },
    warnings,
  };
}

function clampPerCategory(value: number): number {
  return Math.min(
    DISCOVERY_LIMITS.maxPerCategory,
    Math.max(DISCOVERY_LIMITS.minPerCategory, Math.round(value)),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
