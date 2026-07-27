import { describe, expect, it } from "vitest";

import { routingLegId } from "@/lib/routing";

import { enrichTripPlanWithRouting } from "./enrich-routing";
import { deriveExpectedLegs } from "./expected-legs";
import { derivePlanPlacePool } from "./pool";
import { planRoutingPolicy } from "./policy";
import {
  FIXTURE_PLACES as P,
  FIXTURE_POLICY,
  estimatedSegment,
  fixtureDay,
  fixtureItem,
  fixturePlan,
  routedDay,
  routedLeg,
  routedResult,
  unavailableResult,
} from "./test-fixtures";

/**
 * The immutable plan builder.
 *
 * Three groups of assertion, in order of what they protect: that nothing is
 * mutated, that the replacement rules are exactly what they claim, and that a
 * mismatched result cannot reach a plan.
 */

const AT = "2026-07-27T10:00:00.000Z";

/** A two-day plan: day 1 has three stops, day 2 has two. */
function twoDayPlan(options: { withEstimates?: boolean } = {}) {
  const est = options.withEstimates ?? false;

  const day1 = fixtureDay(1, [
    fixtureItem("d1i1", P.a, {
      travelToNext: est ? estimatedSegment("old-1", P.a, P.b, 8) : null,
    }),
    fixtureItem("d1i2", P.b, {
      travelToNext: est ? estimatedSegment("old-2", P.b, P.c, 9) : null,
    }),
    fixtureItem("d1i3", P.c),
  ]);

  const day2 = fixtureDay(2, [
    fixtureItem("d2i1", P.a, {
      travelToNext: est ? estimatedSegment("old-3", P.a, P.b, 7) : null,
    }),
    fixtureItem("d2i2", P.b),
  ]);

  return fixturePlan([day1, day2]);
}

function enrich(
  plan: ReturnType<typeof twoDayPlan>,
  routedDays: Parameters<typeof enrichTripPlanWithRouting>[0]["routedDays"],
  policy = FIXTURE_POLICY,
) {
  return enrichTripPlanWithRouting({
    plan,
    placePool: derivePlanPlacePool(plan),
    routedDays,
    routingPolicy: policy,
    generatedAt: AT,
  });
}

/** The three legs a two-day plan expects under the default policy. */
function legsFor(plan: ReturnType<typeof twoDayPlan>) {
  return {
    d1a: routedLeg({
      dayNumber: 1,
      fromItemId: "d1i1",
      toItemId: "d1i2",
      from: P.a,
      to: P.b,
    }),
    d1b: routedLeg({
      dayNumber: 1,
      fromItemId: "d1i2",
      toItemId: "d1i3",
      from: P.b,
      to: P.c,
    }),
    d2a: routedLeg({
      dayNumber: 2,
      fromItemId: "d2i1",
      toItemId: "d2i2",
      from: P.a,
      to: P.b,
    }),
    expected: deriveExpectedLegs(plan, FIXTURE_POLICY),
  };
}

describe("enrichTripPlanWithRouting — immutability", () => {
  it("does not mutate the source plan", () => {
    const plan = twoDayPlan({ withEstimates: true });
    const before = JSON.parse(JSON.stringify(plan));
    const legs = legsFor(plan);

    enrich(plan, [routedDay(1, [legs.d1a, legs.d1b]), routedDay(2, [legs.d2a])]);

    expect(plan).toEqual(before);
  });

  it("does not mutate the pool", () => {
    const plan = twoDayPlan();
    const pool = derivePlanPlacePool(plan);
    const before = JSON.parse(JSON.stringify(pool));
    const legs = legsFor(plan);

    enrichTripPlanWithRouting({
      plan,
      placePool: pool,
      routedDays: [routedDay(1, [legs.d1a])],
      routingPolicy: FIXTURE_POLICY,
      generatedAt: AT,
    });

    expect(pool).toEqual(before);
  });

  it("returns a different object than it was given", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a])]);

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    expect(result.plan).not.toBe(plan);
    expect(result.plan.days[0]).not.toBe(plan.days[0]);
  });
});

describe("enrichTripPlanWithRouting — identity and order", () => {
  it("preserves item ids and order", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a, legs.d1b])]);

    if (result.status === "failed") throw new Error("unexpected failure");
    expect(result.plan.days[0].items.map((item) => item.id)).toEqual([
      "d1i1",
      "d1i2",
      "d1i3",
    ]);
    expect(result.plan.days.map((day) => day.dayNumber)).toEqual([1, 2]);
  });

  it("attaches each result to the item that owns its leg", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);

    const result = enrich(plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
          result: routedResult(P.a, P.b, { seconds: 300 }),
        }),
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i2",
          toItemId: "d1i3",
          from: P.b,
          to: P.c,
          result: routedResult(P.b, P.c, { seconds: 900 }),
        }),
      ]),
    ]);
    void legs;

    if (result.status === "failed") throw new Error("unexpected failure");
    const [first, second] = result.plan.days[0].items;
    expect(first.travelToNext?.status === "routed" && first.travelToNext.durationSeconds).toBe(
      300,
    );
    expect(
      second.travelToNext?.status === "routed" && second.travelToNext.durationSeconds,
    ).toBe(900);
  });

  it("leaves the last item of a day with no travel segment", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a, legs.d1b])]);

    if (result.status === "failed") throw new Error("unexpected failure");
    expect(result.plan.days[0].items[2].travelToNext).toBeNull();
  });
});

describe("enrichTripPlanWithRouting — replacement policy", () => {
  it("replaces an estimate with a routed segment", () => {
    const plan = twoDayPlan({ withEstimates: true });
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a])]);

    if (result.status === "failed") throw new Error("unexpected failure");
    expect(result.plan.days[0].items[0].travelToNext?.status).toBe("routed");
  });

  it("replaces an estimate with an unavailable segment", () => {
    const plan = twoDayPlan({ withEstimates: true });
    const result = enrich(plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
          result: unavailableResult(),
        }),
      ]),
    ]);

    if (result.status === "failed") throw new Error("unexpected failure");
    const segment = result.plan.days[0].items[0].travelToNext;
    expect(segment?.status).toBe("unavailable");
    // No number survives from the estimate it replaced.
    expect(segment && "estimatedDurationMinutes" in segment).toBe(false);
    expect(segment && "durationMinutes" in segment).toBe(false);
  });

  it("never merges an old estimate's duration with new geometry", () => {
    const plan = twoDayPlan({ withEstimates: true });
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a])]);

    if (result.status === "failed") throw new Error("unexpected failure");
    const segment = result.plan.days[0].items[0].travelToNext;
    if (segment?.status !== "routed") throw new Error("expected routed");
    // The estimate said 8 minutes; the route says 600 s = 10 min. The routed
    // figure wins entirely — a segment is replaced whole or left whole.
    expect(segment.durationMinutes).toBe(10);
    expect(segment.provider).toBe("valhalla");
  });

  it("preserves an existing routed segment by default", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);

    const once = enrich(plan, [routedDay(1, [legs.d1a])]);
    if (once.status === "failed") throw new Error("unexpected failure");

    // A second run with a different duration must not overwrite the first.
    const twice = enrich(once.plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
          result: routedResult(P.a, P.b, { seconds: 4_242 }),
        }),
      ]),
    ]);

    if (twice.status === "failed") throw new Error("unexpected failure");
    const segment = twice.plan.days[0].items[0].travelToNext;
    expect(segment?.status === "routed" && segment.durationSeconds).toBe(600);
  });

  it("overwrites a routed segment under refresh-all", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);

    const once = enrich(plan, [routedDay(1, [legs.d1a])]);
    if (once.status === "failed") throw new Error("unexpected failure");

    const twice = enrich(
      once.plan,
      [
        routedDay(1, [
          routedLeg({
            dayNumber: 1,
            fromItemId: "d1i1",
            toItemId: "d1i2",
            from: P.a,
            to: P.b,
            result: routedResult(P.a, P.b, { seconds: 4_242 }),
          }),
        ]),
      ],
      planRoutingPolicy({ existingSegments: "refresh-all" }),
    );

    if (twice.status === "failed") throw new Error("unexpected failure");
    const segment = twice.plan.days[0].items[0].travelToNext;
    expect(segment?.status === "routed" && segment.durationSeconds).toBe(4_242);
  });

  it("leaves a known failure alone under replace-estimates", () => {
    const plan = twoDayPlan({ withEstimates: true });

    const failed = enrich(plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
          result: unavailableResult(),
        }),
      ]),
    ]);
    if (failed.status === "failed") throw new Error("unexpected failure");

    // Under `replace-estimates` a previously-unavailable leg is not rewritten,
    // even when a fresh routed result is supplied for it.
    const retried = enrich(
      failed.plan,
      [
        routedDay(1, [
          routedLeg({
            dayNumber: 1,
            fromItemId: "d1i1",
            toItemId: "d1i2",
            from: P.a,
            to: P.b,
          }),
        ]),
      ],
      planRoutingPolicy({ existingSegments: "replace-estimates" }),
    );

    if (retried.status === "failed") throw new Error("unexpected failure");
    expect(retried.plan.days[0].items[0].travelToNext?.status).toBe("unavailable");
  });

  it("retries a known failure under the default policy", () => {
    const plan = twoDayPlan({ withEstimates: true });

    const failed = enrich(plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
          result: unavailableResult(),
        }),
      ]),
    ]);
    if (failed.status === "failed") throw new Error("unexpected failure");

    const retried = enrich(failed.plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
        }),
      ]),
    ]);

    if (retried.status === "failed") throw new Error("unexpected failure");
    expect(retried.plan.days[0].items[0].travelToNext?.status).toBe("routed");
  });

  it("keeps an editorial note across replacement", () => {
    const plan = twoDayPlan({ withEstimates: true });
    const withNote = fixturePlan([
      fixtureDay(1, [
        fixtureItem("d1i1", P.a, {
          travelToNext: {
            ...estimatedSegment("old-1", P.a, P.b),
            note: "Downhill through Baixa.",
          },
        }),
        fixtureItem("d1i2", P.b),
      ]),
    ]);
    void plan;

    const result = enrich(withNote, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
        }),
      ]),
    ]);

    if (result.status === "failed") throw new Error("unexpected failure");
    expect(result.plan.days[0].items[0].travelToNext?.note).toBe(
      "Downhill through Baixa.",
    );
  });
});

describe("enrichTripPlanWithRouting — contract violations", () => {
  const plan = twoDayPlan();

  it("rejects a result for an unknown day", () => {
    const result = enrich(plan, [
      routedDay(9, [
        routedLeg({
          dayNumber: 9,
          fromItemId: "d1i1",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
        }),
      ]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("unknown_day");
  });

  it("rejects a result for a leg that does not exist", () => {
    const result = enrich(plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "d1i1",
          toItemId: "ghost",
          from: P.a,
          to: P.b,
        }),
      ]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("unknown_leg");
  });

  it("rejects two results for the same leg", () => {
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a, legs.d1a])]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("duplicate_result");
  });

  it("rejects a mode that does not match the expected leg", () => {
    // The id says walk, the payload says drive.
    const legs = legsFor(plan);
    const result = enrich(plan, [
      routedDay(1, [{ ...legs.d1a, mode: "drive" as const }]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.some((error) => error.code === "mode_mismatch")).toBe(true);
  });

  it("rejects an origin place that does not match", () => {
    const legs = legsFor(plan);
    const result = enrich(plan, [
      routedDay(1, [{ ...legs.d1a, fromPlaceId: "mock_c" }]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.some((error) => error.code === "origin_mismatch")).toBe(
      true,
    );
  });

  it("rejects a destination place that does not match", () => {
    const legs = legsFor(plan);
    const result = enrich(plan, [
      routedDay(1, [{ ...legs.d1a, toPlaceId: "mock_stay" }]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(
      result.errors.some((error) => error.code === "destination_mismatch"),
    ).toBe(true);
  });

  it("rejects coordinates outside the tolerance", () => {
    const legs = legsFor(plan);
    const result = enrich(plan, [
      routedDay(1, [
        {
          ...legs.d1a,
          // ~1.1 km away — far outside the 50 m tolerance.
          origin: { latitude: 38.72, longitude: -9.14 },
        },
      ]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(
      result.errors.some((error) => error.code === "coordinate_mismatch"),
    ).toBe(true);
  });

  it("accepts coordinates inside the tolerance", () => {
    const legs = legsFor(plan);
    const result = enrich(plan, [
      routedDay(1, [
        {
          ...legs.d1a,
          // ~11 m — a plausible road snap.
          origin: { latitude: 38.7101, longitude: -9.14 },
        },
      ]),
    ]);

    expect(result.status).not.toBe("failed");
  });

  it("rejects routed geometry whose endpoints belong elsewhere", () => {
    const legs = legsFor(plan);
    const result = enrich(plan, [
      routedDay(1, [
        {
          ...legs.d1a,
          result: routedResult(P.c, P.stay),
        },
      ]),
    ]);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(
      result.errors.some((error) => error.code === "coordinate_mismatch"),
    ).toBe(true);
  });

  it("rejects a plan referencing a place outside its pool", () => {
    const outsider = fixturePlan([
      fixtureDay(1, [
        fixtureItem("x1", P.a),
        fixtureItem("x2", P.b),
      ]),
    ]);
    const emptyPool = {
      ...derivePlanPlacePool(outsider),
      places: [],
    };

    const result = enrichTripPlanWithRouting({
      plan: outsider,
      placePool: emptyPool,
      routedDays: [],
      routingPolicy: FIXTURE_POLICY,
      generatedAt: AT,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("pool_violation");
  });

  it("returns no plan at all when it fails", () => {
    const result = enrich(plan, [
      routedDay(1, [
        routedLeg({
          dayNumber: 1,
          fromItemId: "ghost",
          toItemId: "d1i2",
          from: P.a,
          to: P.b,
        }),
      ]),
    ]);

    expect(result.status).toBe("failed");
    expect("plan" in result).toBe(false);
  });
});

describe("enrichTripPlanWithRouting — result status", () => {
  it("reports complete when every expected leg is routed", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);

    const result = enrich(plan, [
      routedDay(1, [legs.d1a, legs.d1b]),
      routedDay(2, [legs.d2a]),
    ]);

    expect(result.status).toBe("complete");
    if (result.status === "failed") return;
    expect(result.summary.routedLegs).toBe(3);
    expect(result.summary.pendingLegs).toBe(0);
  });

  it("reports partial when a leg is unavailable", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);

    const result = enrich(plan, [
      routedDay(1, [
        legs.d1a,
        { ...legs.d1b, result: unavailableResult() },
      ]),
      routedDay(2, [legs.d2a]),
    ]);

    expect(result.status).toBe("partial");
    if (result.status === "failed") return;
    expect(result.summary.routedLegs).toBe(2);
    expect(result.summary.unavailableLegs).toBe(1);
  });

  it("reports partial when a leg was never attempted", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);

    const result = enrich(plan, [routedDay(1, [legs.d1a])]);

    expect(result.status).toBe("partial");
    if (result.status === "failed") return;
    expect(result.summary.pendingLegs).toBe(2);
    expect(result.summary.attemptedLegs).toBe(1);
  });

  it("records the applied policy and timestamp on the plan", () => {
    const plan = twoDayPlan();
    const legs = legsFor(plan);
    const result = enrich(plan, [routedDay(1, [legs.d1a])]);

    if (result.status === "failed") throw new Error("unexpected failure");
    expect(result.plan.routing?.lastRoutedAt).toBe(AT);
    expect(result.plan.routing?.policy).toEqual(FIXTURE_POLICY);
  });

  it("routes accommodation legs when the policy brackets the day", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("d1i1", P.a), fixtureItem("d1i2", P.b)]),
    ]);
    const policy = planRoutingPolicy({ accommodation: "bracket-day" });
    const expected = deriveExpectedLegs(plan, policy);

    // stay → a → b → stay
    expect(expected).toHaveLength(3);
    expect(expected[0].id).toBe(
      routingLegId({
        dayNumber: 1,
        fromItemId: "@accommodation-origin",
        toItemId: "d1i1",
        mode: "walk",
      }),
    );
  });
});
