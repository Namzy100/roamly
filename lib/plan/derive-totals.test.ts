import { describe, expect, it } from "vitest";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";

import {
  completionFor,
  deriveDayTravelSummary,
  withDerivedBudget,
  withDerivedDayTotals,
} from "./derive-totals";
import { deriveExpectedLegs } from "./expected-legs";
import { buildRoutingSummary } from "./summary";
import { FIXTURE_POLICY } from "./test-fixtures";
import {
  FIXTURE_PLACES as P,
  estimatedSegment,
  fixtureDay,
  fixtureItem,
  fixturePlan,
  routedResult,
} from "./test-fixtures";
import { toTravelSegment } from "@/lib/routing";
import { validateSummaryReconciliation } from "./validate-derived";

/**
 * Derived totals, and the invariant that keeps them honest: a number is never
 * exposed without the completeness that says how much of the day it covers.
 */

function routedSegment(minutes: number, meters: number) {
  return toTravelSegment(
    { id: "leg", fromPlaceId: P.a.placeId, toPlaceId: P.b.placeId },
    routedResult(P.a, P.b, { seconds: minutes * 60, meters }),
  );
}

describe("deriveDayTravelSummary", () => {
  it("splits routed and estimated durations", () => {
    const day = fixtureDay(1, [
      fixtureItem("i1", P.a, { travelToNext: routedSegment(10, 600) }),
      fixtureItem("i2", P.b, { travelToNext: estimatedSegment("e", P.b, P.c, 7) }),
      fixtureItem("i3", P.c),
    ]);

    const travel = deriveDayTravelSummary(day);

    expect(travel.routedDurationMinutes).toBe(10);
    expect(travel.estimatedDurationMinutes).toBe(7);
    expect(travel.knownDurationMinutes).toBe(17);
    expect(travel.routedDistanceMeters).toBe(600);
    expect(travel.routedLegs).toBe(1);
    expect(travel.estimatedLegs).toBe(1);
  });

  it("gives an unavailable leg zero minutes and its own count", () => {
    const day = fixtureDay(1, [
      fixtureItem("i1", P.a, { travelToNext: routedSegment(10, 600) }),
      fixtureItem("i2", P.b, {
        travelToNext: {
          id: "leg-2",
          fromPlaceId: P.b.placeId,
          toPlaceId: P.c.placeId,
          note: null,
          status: "unavailable",
          requestedMode: "WALK",
          reason: "no_route",
          userMessage: "No route could be found between these two places.",
        },
      }),
      fixtureItem("i3", P.c),
    ]);

    const travel = deriveDayTravelSummary(day);

    // Zero minutes, but never invisible: the count is what stops the day from
    // reading as though there were no second journey.
    expect(travel.knownDurationMinutes).toBe(10);
    expect(travel.unavailableLegs).toBe(1);
    expect(travel.completeness).toBe("partial");
  });

  it("reports unavailable when every attempted leg failed", () => {
    const day = fixtureDay(1, [
      fixtureItem("i1", P.a, {
        travelToNext: {
          id: "leg-1",
          fromPlaceId: P.a.placeId,
          toPlaceId: P.b.placeId,
          note: null,
          status: "unavailable",
          requestedMode: "WALK",
          reason: "no_route",
          userMessage: "No route could be found.",
        },
      }),
      fixtureItem("i2", P.b),
    ]);

    expect(deriveDayTravelSummary(day).completeness).toBe("unavailable");
  });

  it("counts pending legs when an expected total is supplied", () => {
    const day = fixtureDay(1, [
      fixtureItem("i1", P.a, { travelToNext: routedSegment(10, 600) }),
      fixtureItem("i2", P.b),
    ]);

    expect(deriveDayTravelSummary(day, { expectedLegs: 3 }).pendingLegs).toBe(2);
    // Null, not zero, when no policy has been applied — "we do not know how many
    // legs were expected" is different from "none are outstanding".
    expect(deriveDayTravelSummary(day).pendingLegs).toBeNull();
  });

  it("never reports a negative pending count", () => {
    const day = fixtureDay(1, [
      fixtureItem("i1", P.a, { travelToNext: routedSegment(10, 600) }),
      fixtureItem("i2", P.b),
    ]);
    expect(deriveDayTravelSummary(day, { expectedLegs: 0 }).pendingLegs).toBe(0);
  });

  it("reports not_attempted for a day with no travel at all", () => {
    const day = fixtureDay(1, [fixtureItem("i1", P.a)]);
    expect(deriveDayTravelSummary(day).completeness).toBe("not_attempted");
  });
});

describe("completionFor", () => {
  it("covers every band", () => {
    expect(completionFor({ expected: 0, routed: 0, unavailable: 0, pending: 0 })).toBe(
      "not_attempted",
    );
    expect(completionFor({ expected: 3, routed: 3, unavailable: 0, pending: 0 })).toBe(
      "complete",
    );
    expect(completionFor({ expected: 3, routed: 1, unavailable: 2, pending: 0 })).toBe(
      "partial",
    );
    expect(completionFor({ expected: 3, routed: 0, unavailable: 3, pending: 0 })).toBe(
      "unavailable",
    );
    expect(completionFor({ expected: 3, routed: 0, unavailable: 0, pending: 3 })).toBe(
      "not_attempted",
    );
  });
});

describe("withDerivedDayTotals", () => {
  it("recomputes totalTravelMinutes from the segments", () => {
    const day = {
      ...fixtureDay(1, [
        fixtureItem("i1", P.a, { travelToNext: routedSegment(10, 600) }),
        fixtureItem("i2", P.b),
      ]),
      // A deliberately wrong caller-supplied total.
      totalTravelMinutes: 999,
    };

    expect(withDerivedDayTotals(day).totalTravelMinutes).toBe(10);
  });

  it("recomputes dayTotal from the item costs", () => {
    const day = {
      ...fixtureDay(1, [
        fixtureItem("i1", P.a, { estimatedCost: 12 }),
        fixtureItem("i2", P.b, { estimatedCost: 8 }),
      ]),
      dayTotal: 999,
    };

    expect(withDerivedDayTotals(day).dayTotal).toBe(20);
  });

  it("does not mutate the day it was given", () => {
    const day = fixtureDay(1, [fixtureItem("i1", P.a)]);
    const before = JSON.parse(JSON.stringify(day));
    withDerivedDayTotals(day);
    expect(day).toEqual(before);
  });
});

describe("withDerivedBudget", () => {
  const days = [
    fixtureDay(1, [fixtureItem("i1", P.a, { estimatedCost: 30 })]),
    fixtureDay(2, [fixtureItem("i2", P.b, { estimatedCost: 20 })]),
  ];

  it("recomputes the total from the categories", () => {
    const budget = withDerivedBudget(
      {
        ...mockTripPlan.budget,
        flights: 100,
        accommodation: 200,
        food: 50,
        activities: 25,
        transport: 25,
        total: 999_999,
        remaining: -1,
        perTraveler: -1,
      },
      days,
      2,
    );

    expect(budget.total).toBe(400);
    expect(budget.remaining).toBe(budget.requestedBudget - 400);
    expect(budget.perTraveler).toBe(200);
  });

  it("recomputes byDay from the day totals", () => {
    const budget = withDerivedBudget(mockTripPlan.budget, days, 2);
    expect(budget.byDay).toEqual([
      { dayNumber: 1, amount: 30 },
      { dayNumber: 2, amount: 20 },
    ]);
  });

  it("leaves the category amounts exactly as given", () => {
    // Nothing in the schema attributes an item cost to a category, so deriving
    // these would mean inventing an attribution rule.
    const budget = withDerivedBudget(mockTripPlan.budget, days, 2);
    expect(budget.food).toBe(mockTripPlan.budget.food);
    expect(budget.transport).toBe(mockTripPlan.budget.transport);
  });

  it("keeps the transport estimate independent of routing", () => {
    // Routing affects time, not money. An unroutable leg must not make the trip
    // look cheaper.
    const withRoutes = withDerivedBudget(mockTripPlan.budget, days, 2);
    const withoutRoutes = withDerivedBudget(mockTripPlan.budget, days, 2);
    expect(withRoutes.transport).toBe(withoutRoutes.transport);
  });
});

describe("summary reconciliation", () => {
  it("reconciles exactly for a mixed plan", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a, { travelToNext: routedSegment(10, 600) }),
        fixtureItem("i2", P.b, { travelToNext: estimatedSegment("e", P.b, P.c) }),
        fixtureItem("i3", P.c),
      ]),
    ]);

    const summary = buildRoutingSummary(
      plan,
      deriveExpectedLegs(plan, FIXTURE_POLICY),
    );

    expect(validateSummaryReconciliation(summary)).toEqual([]);
    expect(summary.expectedLegs).toBe(
      summary.routedLegs +
        summary.estimatedLegs +
        summary.unavailableLegs +
        summary.pendingLegs,
    );
    expect(summary.attemptedLegs).toBe(
      summary.routedLegs + summary.unavailableLegs,
    );
  });

  it("makes trip totals the exact sum of the days", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("d1i1", P.a, { travelToNext: routedSegment(10, 600) }),
        fixtureItem("d1i2", P.b),
      ]),
      fixtureDay(2, [
        fixtureItem("d2i1", P.a, { travelToNext: routedSegment(5, 300) }),
        fixtureItem("d2i2", P.b),
      ]),
    ]);

    const summary = buildRoutingSummary(
      plan,
      deriveExpectedLegs(plan, FIXTURE_POLICY),
    );

    expect(summary.daySummaries).toHaveLength(2);
    expect(summary.routedLegs).toBe(
      summary.daySummaries.reduce((sum, day) => sum + day.routedLegs, 0),
    );
    expect(summary.totalRoutedDistanceMeters).toBe(900);
    expect(validateSummaryReconciliation(summary)).toEqual([]);
  });

  it("never folds an unavailable leg into the routed count", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a, {
          travelToNext: {
            id: "leg-1",
            fromPlaceId: P.a.placeId,
            toPlaceId: P.b.placeId,
            note: null,
            status: "unavailable",
            requestedMode: "WALK",
            reason: "no_route",
            userMessage: "No route could be found.",
          },
        }),
        fixtureItem("i2", P.b),
      ]),
    ]);

    const summary = buildRoutingSummary(
      plan,
      deriveExpectedLegs(plan, FIXTURE_POLICY),
    );

    expect(summary.routedLegs).toBe(0);
    expect(summary.unavailableLegs).toBe(1);
    expect(summary.attemptedLegs).toBe(1);
    expect(summary.totalRoutedDurationSeconds).toBe(0);
    expect(summary.completion).toBe("unavailable");
  });

  it("reports not_attempted for an untouched plan", () => {
    const summary = buildRoutingSummary(mockTripPlan, []);
    // Every leg is an estimate and none was expected under an empty leg set, so
    // the plan is honestly described as never routed.
    expect(summary.routedLegs).toBe(0);
    expect(summary.estimatedLegs).toBeGreaterThan(0);
    expect(validateSummaryReconciliation(summary)).toEqual([]);
  });
});
