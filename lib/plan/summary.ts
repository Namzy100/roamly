import type {
  RoutingDaySummary,
  RoutingEnrichmentSummary,
  TripPlan,
} from "@/lib/schemas";

import { completionFor, daySegments } from "./derive-totals";
import type { ExpectedLeg } from "./expected-legs";

/**
 * Coverage counts, built from the enriched plan and the expected-leg set.
 *
 * Derived from the finished plan rather than accumulated during enrichment, on
 * purpose: a counter incremented alongside the work can drift from the work, and
 * this way the summary is a *statement about the plan* that can be recomputed
 * and re-checked at any point, including on read.
 *
 * The reconciliation identities, asserted in `validate-derived.ts` and in tests:
 *
 *   expected  = routed + estimated + unavailable + pending
 *   attempted = routed + unavailable
 *   trip[k]   = Σ days[k]   for every count k
 *
 * `attempted` deliberately excludes retained estimates and pending legs. A leg
 * whose estimate was kept was not asked about under this policy, and a pending
 * leg was never asked about at all — folding either into "attempted" would
 * inflate the denominator of any success rate computed from these numbers.
 */
export function buildRoutingSummary(
  plan: TripPlan,
  expectedLegs: ExpectedLeg[],
): RoutingEnrichmentSummary {
  const expectedByDay = new Map<number, number>();
  for (const leg of expectedLegs) {
    expectedByDay.set(leg.dayNumber, (expectedByDay.get(leg.dayNumber) ?? 0) + 1);
  }

  const daySummaries: RoutingDaySummary[] = plan.days.map((day) => {
    let routedLegs = 0;
    let estimatedLegs = 0;
    let unavailableLegs = 0;
    let totalRoutedDistanceMeters = 0;
    let totalRoutedDurationSeconds = 0;

    for (const segment of daySegments(day)) {
      switch (segment.status) {
        case "routed":
          routedLegs += 1;
          totalRoutedDistanceMeters += segment.distanceMeters;
          totalRoutedDurationSeconds += segment.durationSeconds;
          break;
        case "estimated":
          estimatedLegs += 1;
          break;
        case "unavailable":
          unavailableLegs += 1;
          break;
      }
    }

    /**
     * The expected count is the denominator, but the attached segments are the
     * ground truth. If a policy change means fewer legs are expected than are
     * attached, the expected count is raised to match rather than reporting a
     * negative pending — the segments exist, and pretending otherwise would
     * break the reconciliation identity.
     */
    const attached = routedLegs + estimatedLegs + unavailableLegs;
    const expectedLegsForDay = Math.max(
      expectedByDay.get(day.dayNumber) ?? 0,
      attached,
    );
    const pendingLegs = expectedLegsForDay - attached;

    return {
      dayNumber: day.dayNumber,
      expectedLegs: expectedLegsForDay,
      attemptedLegs: routedLegs + unavailableLegs,
      routedLegs,
      estimatedLegs,
      unavailableLegs,
      pendingLegs,
      totalRoutedDistanceMeters: round(totalRoutedDistanceMeters),
      totalRoutedDurationSeconds: round(totalRoutedDurationSeconds),
      completion: completionFor({
        expected: expectedLegsForDay,
        routed: routedLegs,
        unavailable: unavailableLegs,
        pending: pendingLegs,
      }),
    };
  });

  const totals = daySummaries.reduce(
    (acc, day) => ({
      expectedLegs: acc.expectedLegs + day.expectedLegs,
      attemptedLegs: acc.attemptedLegs + day.attemptedLegs,
      routedLegs: acc.routedLegs + day.routedLegs,
      estimatedLegs: acc.estimatedLegs + day.estimatedLegs,
      unavailableLegs: acc.unavailableLegs + day.unavailableLegs,
      pendingLegs: acc.pendingLegs + day.pendingLegs,
      totalRoutedDistanceMeters:
        acc.totalRoutedDistanceMeters + day.totalRoutedDistanceMeters,
      totalRoutedDurationSeconds:
        acc.totalRoutedDurationSeconds + day.totalRoutedDurationSeconds,
    }),
    {
      expectedLegs: 0,
      attemptedLegs: 0,
      routedLegs: 0,
      estimatedLegs: 0,
      unavailableLegs: 0,
      pendingLegs: 0,
      totalRoutedDistanceMeters: 0,
      totalRoutedDurationSeconds: 0,
    },
  );

  return {
    ...totals,
    totalRoutedDistanceMeters: round(totals.totalRoutedDistanceMeters),
    totalRoutedDurationSeconds: round(totals.totalRoutedDurationSeconds),
    completion: completionFor({
      expected: totals.expectedLegs,
      routed: totals.routedLegs,
      unavailable: totals.unavailableLegs,
      pending: totals.pendingLegs,
    }),
    daySummaries,
  };
}

/**
 * Three decimal places on metres and seconds.
 *
 * Provider figures are fractional (`681.558` s), and summing a dozen of them
 * accumulates float noise that makes an exact reconciliation assertion fail for
 * reasons that have nothing to do with routing.
 */
function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
