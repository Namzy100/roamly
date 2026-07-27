import { haversineMeters } from "@/lib/routing";
import type { RoutingEnrichmentSummary, TripPlan } from "@/lib/schemas";

import { daySegments, deriveDayTravelSummary } from "./derive-totals";
import type { PlanEnrichmentError } from "./types";

/**
 * The invariants a finished plan must satisfy before anyone is allowed to see
 * it, let alone save it.
 *
 * These run *after* the builder has done its work, on its own output. That is
 * the point: a builder that checks only its inputs proves nothing about what it
 * produced, and every failure mode this phase cares about — a count that does
 * not reconcile, a total that under-reports, geometry on the wrong arm — is a
 * property of the result.
 *
 * Nothing here repairs anything. A violation returns an error and the enrichment
 * fails, because a plan that quietly disagrees with itself is worse than no
 * enrichment at all.
 */

/**
 * How far a routed endpoint may sit from its canonical place, in metres.
 *
 * The result's `origin`/`destination` are echoes of what we asked for, not the
 * provider's snapped coordinates, so in practice the difference is zero. The
 * tolerance exists for two reasons: a future provider might echo snapped points,
 * and a caller might hand us a doctored result.
 *
 * 50 m is a deliberate compromise. It comfortably absorbs a road snap, and it
 * catches a result attached to a wholly different stop — the realistic failure.
 * It cannot catch a swap between two stops less than 50 m apart, which is why
 * leg identity, not coordinates, is the primary guard; this is defence in depth.
 */
export const COORDINATE_TOLERANCE_METERS = 50;

export function validateEnrichedPlan(
  plan: TripPlan,
  summary: RoutingEnrichmentSummary,
): PlanEnrichmentError[] {
  const errors: PlanEnrichmentError[] = [];

  errors.push(...validateSummaryReconciliation(summary));
  errors.push(...validateSegmentShapes(plan));
  errors.push(...validateDayTotals(plan));

  return errors;
}

/**
 * The counting identities. Arithmetic, so they are exact rather than tolerant.
 */
export function validateSummaryReconciliation(
  summary: RoutingEnrichmentSummary,
): PlanEnrichmentError[] {
  const errors: PlanEnrichmentError[] = [];

  const check = (
    label: string,
    actual: number,
    expected: number,
    dayNumber?: number,
  ) => {
    if (actual !== expected) {
      errors.push({
        code: "derived_mismatch",
        message: `${label}: got ${actual}, expected ${expected}`,
        ...(dayNumber === undefined ? {} : { dayNumber }),
      });
    }
  };

  for (const day of summary.daySummaries) {
    check(
      `day ${day.dayNumber} expected legs`,
      day.expectedLegs,
      day.routedLegs + day.estimatedLegs + day.unavailableLegs + day.pendingLegs,
      day.dayNumber,
    );
    check(
      `day ${day.dayNumber} attempted legs`,
      day.attemptedLegs,
      day.routedLegs + day.unavailableLegs,
      day.dayNumber,
    );
  }

  // Trip totals must be the exact sum of the days, with nothing added or lost.
  const sum = (pick: (day: RoutingEnrichmentSummary["daySummaries"][number]) => number) =>
    summary.daySummaries.reduce((total, day) => total + pick(day), 0);

  check("trip expected legs", summary.expectedLegs, sum((d) => d.expectedLegs));
  check("trip attempted legs", summary.attemptedLegs, sum((d) => d.attemptedLegs));
  check("trip routed legs", summary.routedLegs, sum((d) => d.routedLegs));
  check("trip estimated legs", summary.estimatedLegs, sum((d) => d.estimatedLegs));
  check(
    "trip unavailable legs",
    summary.unavailableLegs,
    sum((d) => d.unavailableLegs),
  );
  check("trip pending legs", summary.pendingLegs, sum((d) => d.pendingLegs));

  // An unavailable leg counted as routed is the single most damaging possible
  // miscount, so it gets its own explicit assertion rather than relying on the
  // identities above to catch it indirectly.
  if (summary.routedLegs + summary.unavailableLegs !== summary.attemptedLegs) {
    errors.push({
      code: "derived_mismatch",
      message: "Unavailable legs must not be folded into routed legs",
    });
  }

  return errors;
}

/**
 * Per-segment rules that the Zod union permits structurally but which are still
 * wrong in context.
 *
 * Two invariants this phase cares about are **not** here, because they are not
 * expressible as failures: `provider` is a literal `"valhalla"` on the routed
 * arm and a literal `"mock"` on the estimated arm, so "a routed segment claiming
 * a mock provider" and "an estimate claiming a provider route" are already
 * impossible to construct. TypeScript narrows a check for either to `never`.
 * They are asserted in the contract tests against hand-built objects, which is
 * the only place they can be attempted.
 */
export function validateSegmentShapes(plan: TripPlan): PlanEnrichmentError[] {
  const errors: PlanEnrichmentError[] = [];

  for (const day of plan.days) {
    for (const segment of daySegments(day)) {
      if (segment.status === "routed") {
        if (segment.geometry.coordinates.length < 2) {
          errors.push({
            code: "derived_mismatch",
            message: `Routed segment ${segment.id} has unusable geometry`,
            legId: segment.id,
            dayNumber: day.dayNumber,
          });
        }
        if (segment.distanceMeters <= 0 || segment.durationSeconds <= 0) {
          errors.push({
            code: "derived_mismatch",
            message: `Routed segment ${segment.id} reports a zero measurement`,
            legId: segment.id,
            dayNumber: day.dayNumber,
          });
        }
      }
    }
  }

  return errors;
}

/** `totalTravelMinutes` must equal what the segments actually say. */
export function validateDayTotals(plan: TripPlan): PlanEnrichmentError[] {
  const errors: PlanEnrichmentError[] = [];

  for (const day of plan.days) {
    const travel = deriveDayTravelSummary(day);
    if (day.totalTravelMinutes !== travel.knownDurationMinutes) {
      errors.push({
        code: "derived_mismatch",
        message: `Day ${day.dayNumber} reports ${day.totalTravelMinutes} travel minutes; its segments sum to ${travel.knownDurationMinutes}`,
        dayNumber: day.dayNumber,
      });
    }

    const expectedTotal =
      Math.round(
        day.items.reduce((sum, item) => sum + item.estimatedCost, 0) * 100,
      ) / 100;
    if (day.dayTotal !== expectedTotal) {
      errors.push({
        code: "derived_mismatch",
        message: `Day ${day.dayNumber} reports a total of ${day.dayTotal}; its items sum to ${expectedTotal}`,
        dayNumber: day.dayNumber,
      });
    }
  }

  return errors;
}

/** True when two points are close enough to be the same place. */
export function coordinatesMatch(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
  toleranceMeters = COORDINATE_TOLERANCE_METERS,
): boolean {
  return haversineMeters(a, b) <= toleranceMeters;
}
