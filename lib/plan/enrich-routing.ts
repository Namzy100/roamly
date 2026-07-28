import {
  fingerprintForLeg,
  toTravelSegment,
  type RoutedDayResult,
  type RoutedDayLeg,
} from "@/lib/routing";
import {
  TripPlanSchema,
  assertItineraryUsesPool,
  PoolValidationError,
  type AppliedRoutingPolicy,
  type ItineraryDay,
  type ItineraryItem,
  type TravelSegment,
  type TripPlan,
  type VerifiedPlacePool,
} from "@/lib/schemas";

import {
  withDerivedBudget,
  withDerivedDayTotals,
} from "./derive-totals";
import {
  deriveExpectedLegs,
  indexExpectedLegs,
  owningItemIdForLeg,
  type ExpectedLeg,
} from "./expected-legs";
import { buildRoutingSummary } from "./summary";
import type { EnrichedTripPlanResult, PlanEnrichmentError } from "./types";
import { coordinatesMatch, validateEnrichedPlan } from "./validate-derived";

/**
 * The immutable plan builder.
 *
 * Takes a plan, its pool, and the routing results, and returns a **new** plan.
 * The input is never touched — not the plan, not the pool, not the days, not the
 * items. Everything returned is freshly constructed, which is what makes it safe
 * to compute an enrichment in memory, validate it, and only then decide whether
 * to save it.
 *
 * ## Two kinds of failure, deliberately separated
 *
 * A **provider** failure — "there is no walking route between these two points"
 * — is normal, expected, and produces a perfectly valid plan with an
 * `unavailable` segment on that leg. It returns `partial`.
 *
 * A **contract** violation — a result for a leg that does not exist, a mode that
 * does not match, coordinates belonging to a different place — is a bug. It
 * returns `failed` with no plan at all, because a plan assembled from mismatched
 * parts is worse than one that was never enriched.
 *
 * ## What it will not do
 *
 * Reorder stops. Replace a place. Mutate the source. Merge an old estimate's
 * duration with new geometry. Accept a caller's derived totals. Attach a result
 * to a leg whose identity, endpoints or mode disagree with it.
 */

export type EnrichTripPlanInput = {
  plan: TripPlan;
  placePool: VerifiedPlacePool;
  routedDays: RoutedDayResult[];
  routingPolicy: AppliedRoutingPolicy;
  /** ISO timestamp recorded as `plan.routing.lastRoutedAt`. */
  generatedAt?: string;
};

export function enrichTripPlanWithRouting(
  input: EnrichTripPlanInput,
): EnrichedTripPlanResult {
  const { plan, placePool, routedDays, routingPolicy } = input;

  const errors: PlanEnrichmentError[] = [];

  // 1 — the plan must reference only pool places, with faithful copies. This is
  //     the Phase 3 no-invention gate, re-run here because enrichment is the
  //     first thing since generation to rebuild the plan.
  try {
    assertItineraryUsesPool(collectAttachedPlaces(plan), placePool);
  } catch (error) {
    if (error instanceof PoolValidationError) {
      return {
        status: "failed",
        errors: [{ code: "pool_violation", message: error.message }],
      };
    }
    throw error;
  }

  // 2 — the expected leg set, from the single authority.
  const expectedLegs = deriveExpectedLegs(plan, routingPolicy);
  const expectedById = indexExpectedLegs(expectedLegs);
  const knownDayNumbers = new Set(plan.days.map((day) => day.dayNumber));

  // 3 — validate every incoming result against its expected leg.
  const resultsByLegId = new Map<string, RoutedDayLeg>();

  for (const routedDay of routedDays) {
    if (routedDay.dayNumber === null || !knownDayNumbers.has(routedDay.dayNumber)) {
      errors.push({
        code: "unknown_day",
        message: `Routing result references day ${routedDay.dayNumber}, which is not in this plan`,
        ...(routedDay.dayNumber === null ? {} : { dayNumber: routedDay.dayNumber }),
      });
      continue;
    }

    for (const leg of routedDay.legs) {
      const expected = expectedById.get(leg.id);

      if (!expected) {
        errors.push({
          code: "unknown_leg",
          message: `No expected leg matches ${leg.id}`,
          legId: leg.id,
          dayNumber: routedDay.dayNumber,
        });
        continue;
      }

      if (resultsByLegId.has(leg.id)) {
        errors.push({
          code: "duplicate_result",
          message: `Two results were supplied for leg ${leg.id}`,
          legId: leg.id,
          dayNumber: routedDay.dayNumber,
        });
        continue;
      }

      errors.push(...validateLegAgainstExpectation(leg, expected));
      resultsByLegId.set(leg.id, leg);
    }
  }

  if (errors.length > 0) return { status: "failed", errors };

  // 4 — build the new plan. Nothing above this line has written anything.
  const days = plan.days.map((day) =>
    withDerivedDayTotals(
      rebuildDay(day, expectedLegs, resultsByLegId, routingPolicy),
    ),
  );

  const candidate: TripPlan = {
    ...plan,
    days,
    budget: withDerivedBudget(plan.budget, days, plan.request.travelers),
    routing: {
      policy: routingPolicy,
      lastRoutedAt: input.generatedAt ?? new Date().toISOString(),
      // Placeholder; replaced below once the plan it describes exists.
      summary: EMPTY_SUMMARY,
    },
  };

  const summary = buildRoutingSummary(candidate, expectedLegs);
  const enriched: TripPlan = {
    ...candidate,
    routing: { ...candidate.routing!, summary },
  };

  // 5 — validate the *output*, then re-parse it. A builder that checks only its
  //     inputs proves nothing about what it produced.
  const derivedErrors = validateEnrichedPlan(enriched, summary);
  if (derivedErrors.length > 0) {
    return { status: "failed", errors: derivedErrors };
  }

  const parsed = TripPlanSchema.safeParse(enriched);
  if (!parsed.success) {
    return {
      status: "failed",
      errors: [
        {
          code: "invalid_plan",
          message: `Enriched plan failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        },
      ],
    };
  }

  return {
    status: summary.completion === "complete" ? "complete" : "partial",
    plan: parsed.data,
    summary,
  };
}

/* -------------------------------------------------------------------------- */

const EMPTY_SUMMARY = {
  expectedLegs: 0,
  attemptedLegs: 0,
  routedLegs: 0,
  estimatedLegs: 0,
  unavailableLegs: 0,
  pendingLegs: 0,
  totalRoutedDistanceMeters: 0,
  totalRoutedDurationSeconds: 0,
  completion: "not_attempted" as const,
  daySummaries: [],
};

/**
 * Everything about a result that must agree with the leg it claims to be.
 *
 * The leg id already encodes day, both item ids and the mode, so a mismatch here
 * means the id and the payload disagree — which is exactly the kind of
 * inconsistency that would otherwise attach a real duration to the wrong walk.
 */
function validateLegAgainstExpectation(
  leg: RoutedDayLeg,
  expected: ExpectedLeg,
): PlanEnrichmentError[] {
  const errors: PlanEnrichmentError[] = [];
  const context = { legId: leg.id, dayNumber: expected.dayNumber };

  if (leg.mode !== expected.mode) {
    errors.push({
      ...context,
      code: "mode_mismatch",
      message: `Leg ${leg.id} was routed as ${leg.mode}, expected ${expected.mode}`,
    });
  }

  if (leg.fromPlaceId !== expected.fromPlaceId) {
    errors.push({
      ...context,
      code: "origin_mismatch",
      message: `Leg ${leg.id} starts at ${leg.fromPlaceId}, expected ${expected.fromPlaceId}`,
    });
  }

  if (leg.toPlaceId !== expected.toPlaceId) {
    errors.push({
      ...context,
      code: "destination_mismatch",
      message: `Leg ${leg.id} ends at ${leg.toPlaceId}, expected ${expected.toPlaceId}`,
    });
  }

  if (!coordinatesMatch(leg.origin, expected.origin)) {
    errors.push({
      ...context,
      code: "coordinate_mismatch",
      message: `Leg ${leg.id} origin does not correspond to the canonical place`,
    });
  }

  if (!coordinatesMatch(leg.destination, expected.destination)) {
    errors.push({
      ...context,
      code: "coordinate_mismatch",
      message: `Leg ${leg.id} destination does not correspond to the canonical place`,
    });
  }

  // The routed result's own endpoints must match the leg's too, or the segment
  // would carry geometry belonging to a different journey.
  if (leg.result.status === "routed") {
    if (
      !coordinatesMatch(leg.result.origin, expected.origin) ||
      !coordinatesMatch(leg.result.destination, expected.destination)
    ) {
      errors.push({
        ...context,
        code: "coordinate_mismatch",
        message: `Routed geometry for ${leg.id} does not correspond to its endpoints`,
      });
    }
    if (leg.result.mode !== expected.mode) {
      errors.push({
        ...context,
        code: "mode_mismatch",
        message: `Routed result for ${leg.id} is ${leg.result.mode}, expected ${expected.mode}`,
      });
    }
  }

  return errors;
}

/**
 * Rebuilds one day's items with their new travel segments.
 *
 * Item order, ids and every canonical field are copied through. The only thing
 * that changes is `travelToNext`, and only where the replacement policy allows.
 */
function rebuildDay(
  day: ItineraryDay,
  expectedLegs: ExpectedLeg[],
  resultsByLegId: Map<string, RoutedDayLeg>,
  /**
   * The whole policy, not only its `existingSegments` field.
   *
   * Widened when route-input fingerprints arrived: a fingerprint has to record the mode thresholds and the day-bracketing
   * decision as well, because both change what a leg *is*. Passing the one field would mean the fingerprint could not see
   * the inputs it exists to capture.
   */
  policy: AppliedRoutingPolicy,
): ItineraryDay {
  // Which leg, if any, hangs off each item. Built from the expected set, so an
  // item with no eligible successor keeps whatever it had.
  const legByOwningItem = new Map<string, ExpectedLeg>();
  for (const leg of expectedLegs) {
    if (leg.dayNumber !== day.dayNumber) continue;
    const owner = owningItemIdForLeg(leg);
    if (owner !== null) legByOwningItem.set(owner, leg);
  }

  const items: ItineraryItem[] = day.items.map((item) => {
    const leg = legByOwningItem.get(item.id);
    if (!leg) return { ...item };

    const routed = resultsByLegId.get(leg.id);
    if (!routed) return { ...item };

    const next = resolveSegment(item.travelToNext, routed, policy);
    return next === item.travelToNext ? { ...item } : { ...item, travelToNext: next };
  });


  return { ...day, items };
}

/**
 * The replacement decision for one leg.
 *
 * The policy table lives on `ExistingSegmentPolicySchema`; this is its
 * implementation. Note the two things that never happen: an existing routed
 * segment is not overwritten except under `refresh-all`, and an old estimate's
 * duration is never combined with new geometry — a segment is replaced whole or
 * left whole.
 */
function resolveSegment(
  existing: TravelSegment | null,
  routed: RoutedDayLeg,
  policy: AppliedRoutingPolicy,
): TravelSegment {
  const replacement = toTravelSegment(
    { id: routed.id, fromPlaceId: routed.fromPlaceId, toPlaceId: routed.toPlaceId },
    routed.result,
    // Editorial notes describe the journey and survive re-routing; a routed
    // result has no note of its own to contribute.
    existing?.note ?? null,
    /*
     * Stamped here, at the one place a provider result becomes a stored segment.
     *
     * `routed` is the expected leg the request was built from, so its place ids, coordinates and mode are exactly the
     * inputs the router consumed. Deriving the fingerprint anywhere later would mean deriving it from the plan as it is
     * *now*, which would make every segment trivially self-consistent and the check worthless.
     */
    fingerprintForLeg(routed, policy),
  );

  if (existing === null) return replacement;

  switch (policy.existingSegments) {
    case "refresh-all":
      return replacement;

    case "replace-estimates":
      // A known failure is left alone: under this policy the caller has said
      // they do not want failures retried, so re-writing one would be churn.
      return existing.status === "estimated" ? replacement : existing;

    case "preserve-routed":
      return existing.status === "routed" ? existing : replacement;
  }
}

function collectAttachedPlaces(plan: TripPlan) {
  const places = plan.days.flatMap((day) =>
    day.items.flatMap((item) => (item.place ? [item.place] : [])),
  );
  const stay = plan.accommodation?.place;
  return stay ? [...places, stay] : places;
}
