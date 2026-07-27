import "server-only";

import {
  deriveExpectedLegsForDay,
  enrichTripPlanWithRouting,
  planRoutingPolicy,
  type EnrichedTripPlanResult,
  type RoutingPolicyOverrides,
} from "@/lib/plan";
import type { RoutedDayResult, RouteRequest } from "@/lib/routing";
import type { TripPlan, VerifiedPlacePool } from "@/lib/schemas";

import { ROUTING_ATTRIBUTION, ROUTING_LIMITS } from "./config";
import { RoutingProviderError } from "./errors";
import { routeSegments } from "./service";

/**
 * Whole-trip routing orchestration.
 *
 * Composition only, and deliberately thin:
 *
 *  1. bound the request — a trip is not allowed to be arbitrarily large
 *  2. derive the expected legs, day by day, from the single authority
 *  3. ask the normalized routing service for them
 *  4. hand the results to the immutable plan builder
 *  5. return the new plan
 *
 * ## What it does not do
 *
 * Talk to Valhalla. Every call goes through `routeSegments`, which owns caching,
 * pacing, bounded concurrency and the one-retry ceiling. Adding a retry here
 * would multiply against that one and turn a bad minute into a stampede.
 *
 * Persist anything. The orchestration is a pure transformation as far as storage
 * is concerned; the caller decides whether the result is worth saving, and does
 * so under an optimistic-concurrency check.
 *
 * Mutate the input plan. That is the builder's guarantee, and it is what makes
 * "compute, validate, then decide" possible at all.
 */

/**
 * The serverless duration budget, and how it is kept.
 *
 * A five-day trip is ~19 legs. At three concurrent requests and a 250 ms gap
 * between starts, a fully uncached run is roughly 19 × 250 ms of pacing plus the
 * provider's own latency — call it 8–15 s in practice, and slower when the demo
 * server is loaded. That is why the route sets `maxDuration` explicitly and why
 * the caps below exist rather than being left to good intentions.
 *
 * Cached legs cost nothing, so a re-run after a partial failure is fast.
 * Nothing here is instant, and the UI does not claim it is.
 */
export const TRIP_ROUTING_LIMITS = {
  maxDays: 7,
  maxStops: 24,
  maxLegs: 23,
  /**
   * The ceiling on a targeted retry (Phase 6A).
   *
   * Equal to `maxLegs`, because "retry all" through the retry path is a legitimate
   * request — but stated separately so the two can diverge if a retry ever needs to
   * be more restrictive than a first run.
   */
  maxRetryLegs: 23,
} as const;

export type RouteTripPlanInput = {
  plan: TripPlan;
  placePool: VerifiedPlacePool;
  policy?: RoutingPolicyOverrides;
  signal?: AbortSignal;
  /** Injected in tests so the enriched plan's timestamp is deterministic. */
  now?: () => string;
  /**
   * Route only these legs (Phase 6A), by stable leg id.
   *
   * The mechanism behind "retry this one route" and "retry the failures". Every id is
   * filtered against the plan's *currently expected* leg set, so an id from a stale
   * render — or from a leg the itinerary no longer contains — is dropped rather than
   * routed. Legs not named keep whatever segment they already had.
   *
   * Absent means every eligible leg, which is the existing whole-trip behaviour.
   *
   * ## Why this belongs here rather than in a new endpoint
   *
   * A targeted retry is the same orchestration with a smaller leg set: the same
   * expected-leg derivation, the same service, the same immutable builder, the same
   * validation. A parallel implementation would be a second answer to "which legs
   * exist", and the whole enrichment contract rests on there being one.
   */
  retryLegIds?: string[];
};

export type TripRoutingResult = EnrichedTripPlanResult & {
  attribution: string;
};

export async function routeTripPlan(
  input: RouteTripPlanInput,
): Promise<TripRoutingResult> {
  const policy = planRoutingPolicy(input.policy);
  const { plan } = input;

  assertWithinTripCaps(plan);

  /**
   * Legs are derived per day and then flattened for the request. Grouping is
   * preserved in the results because each leg's identity carries its day, so a
   * single ordered batch is safe *and* lets the concurrency limiter see the
   * whole trip at once rather than three legs at a time.
   */
  const legsByDay = plan.days.map((day) => ({
    dayNumber: day.dayNumber,
    legs: deriveExpectedLegsForDay(plan, day, policy),
  }));

  const expectedLegs = legsByDay.flatMap((entry) => entry.legs);

  if (expectedLegs.length > TRIP_ROUTING_LIMITS.maxLegs) {
    throw new RoutingProviderError(
      "invalid_locations",
      `A trip may route at most ${TRIP_ROUTING_LIMITS.maxLegs} legs, derived ${expectedLegs.length}`,
    );
  }

  /**
   * A targeted retry narrows the request set to legs the plan still expects.
   *
   * Deduplicated, and intersected with `expectedLegs` rather than trusted: the caller
   * is a browser holding a plan it read some seconds ago, and an id that no longer
   * describes an adjacency must not become a provider request.
   */
  const requested = input.retryLegIds
    ? new Set(input.retryLegIds)
    : null;
  const allLegs =
    requested === null
      ? expectedLegs
      : expectedLegs.filter((leg) => requested.has(leg.id));

  if (allLegs.length > TRIP_ROUTING_LIMITS.maxRetryLegs) {
    throw new RoutingProviderError(
      "invalid_locations",
      `A retry may route at most ${TRIP_ROUTING_LIMITS.maxRetryLegs} legs, received ${allLegs.length}`,
    );
  }

  const requests: RouteRequest[] = allLegs.map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    mode: leg.mode,
    units: "kilometers",
  }));

  // Order-preserving and never rejecting for a routing outcome, so index
  // alignment with `allLegs` is guaranteed and a partial failure survives.
  const results = await routeSegments(requests, { signal: input.signal });

  const resultByLegId = new Map(
    allLegs.map((leg, index) => [leg.id, results[index]]),
  );

  /**
   * Only the legs that were requested appear in the results.
   *
   * The builder treats a leg with no result as "leave whatever is there", which is
   * exactly right for a targeted retry: the untouched legs keep their existing
   * segments rather than being cleared and re-reported as pending.
   */
  const routedDays: RoutedDayResult[] = legsByDay.map((entry) => {
    const legs = entry.legs
      .filter((leg) => resultByLegId.has(leg.id))
      .map((leg) => ({
        ...leg,
        result: resultByLegId.get(leg.id)!,
      }));

    return {
      dayNumber: entry.dayNumber,
      legs,
      summary: {
        total: legs.length,
        routed: legs.filter((leg) => leg.result.status === "routed").length,
        unavailable: legs.filter((leg) => leg.result.status !== "routed").length,
        routedDistanceMeters: legs.reduce(
          (sum, leg) =>
            sum + (leg.result.status === "routed" ? leg.result.distanceMeters : 0),
          0,
        ),
        routedDurationSeconds: legs.reduce(
          (sum, leg) =>
            sum + (leg.result.status === "routed" ? leg.result.durationSeconds : 0),
          0,
        ),
      },
      attribution: ROUTING_ATTRIBUTION,
    };
  });

  const enriched = enrichTripPlanWithRouting({
    plan,
    placePool: input.placePool,
    routedDays,
    routingPolicy: policy,
    generatedAt: input.now?.() ?? new Date().toISOString(),
  });

  return { ...enriched, attribution: ROUTING_ATTRIBUTION };
}

/**
 * Rejects an oversized trip before any provider call.
 *
 * Throws rather than truncating. Routing four of a traveller's five days and
 * saying nothing would be the worst possible reading of "bounded".
 */
export function assertWithinTripCaps(plan: TripPlan): void {
  if (plan.days.length > TRIP_ROUTING_LIMITS.maxDays) {
    throw new RoutingProviderError(
      "invalid_locations",
      `A trip may span at most ${TRIP_ROUTING_LIMITS.maxDays} days, received ${plan.days.length}`,
    );
  }

  const stops = plan.days.reduce(
    (total, day) => total + day.items.filter((item) => item.place !== null).length,
    0,
  );
  if (stops > TRIP_ROUTING_LIMITS.maxStops) {
    throw new RoutingProviderError(
      "invalid_locations",
      `A trip may route at most ${TRIP_ROUTING_LIMITS.maxStops} stops, received ${stops}`,
    );
  }
}

/** Re-exported so the API route reads one module for its caps. */
export { ROUTING_LIMITS };
