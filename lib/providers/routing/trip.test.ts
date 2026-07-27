import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";
import { derivePlanPlacePool, deriveExpectedLegs, planRoutingPolicy } from "@/lib/plan";
import {
  FIXTURE_PLACES as P,
  fixtureDay,
  fixtureItem,
  fixturePlan,
} from "@/lib/plan/test-fixtures";
import type { TripPlan } from "@/lib/schemas";

import { routingCache } from "./cache";
import { RoutingProviderError } from "./errors";
import { assertWithinTripCaps, routeTripPlan, TRIP_ROUTING_LIMITS } from "./trip";

/**
 * Whole-trip orchestration with a mocked `fetch`. No public endpoint is
 * contacted.
 *
 * The behaviours worth pinning are the ones that only appear at trip scale:
 * that a partial failure survives, that the caps bite before any request, and
 * that the enriched plan is a new object with recomputed totals.
 */

const SHAPE = "kb|yhAnkylPjvB_uCpxBoyF";
const AT = "2026-07-27T10:00:00.000Z";

function routeResponse(time = 600, length = 0.64): Response {
  const summary = { time, length };
  return new Response(
    JSON.stringify({
      trip: { status: 0, units: "kilometers", summary, legs: [{ summary, shape: SHAPE }] },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function noRouteResponse(): Response {
  return new Response(
    JSON.stringify({ error_code: 170, error: "Locations are in unconnected regions." }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

/** Two days, three eligible legs, all short walks. */
function threeLegPlan(): TripPlan {
  return fixturePlan([
    fixtureDay(1, [
      fixtureItem("d1i1", P.a),
      fixtureItem("d1i2", P.b),
      fixtureItem("d1i3", P.c),
    ]),
    fixtureDay(2, [fixtureItem("d2i1", P.a), fixtureItem("d2i2", P.b)]),
  ]);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routingCache.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeTripPlan", () => {
  it("routes every expected leg and returns a complete plan", async () => {
    fetchMock.mockImplementation(() => routeResponse());
    const plan = threeLegPlan();

    const result = await routeTripPlan({
      plan,
      placePool: derivePlanPlacePool(plan),
      now: () => AT,
    });

    expect(result.status).toBe("complete");
    if (result.status === "failed") return;
    expect(result.summary.routedLegs).toBe(3);
    expect(result.summary.expectedLegs).toBe(3);
    // Two requests for three legs: day 1's a→b and day 2's a→b are the same
    // origin, destination and mode, so `routeSegments` collapses them. Three
    // distinct legs still each get their own result.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not mutate the source plan", async () => {
    fetchMock.mockImplementation(() => routeResponse());
    const plan = threeLegPlan();
    const before = JSON.parse(JSON.stringify(plan));

    await routeTripPlan({ plan, placePool: derivePlanPlacePool(plan), now: () => AT });

    expect(plan).toEqual(before);
    expect(plan.routing).toBeNull();
  });

  it("keeps successful legs when one fails", async () => {
    fetchMock
      .mockResolvedValueOnce(routeResponse())
      .mockResolvedValueOnce(noRouteResponse())
      .mockResolvedValueOnce(routeResponse());

    const plan = threeLegPlan();
    const result = await routeTripPlan({
      plan,
      placePool: derivePlanPlacePool(plan),
      now: () => AT,
    });

    expect(result.status).toBe("partial");
    if (result.status === "failed") return;
    expect(result.summary.routedLegs).toBe(2);
    expect(result.summary.unavailableLegs).toBe(1);
    // The two that worked are on the plan, not discarded with the one that did not.
    expect(result.summary.totalRoutedDurationSeconds).toBeGreaterThan(0);
  });

  it("recomputes day travel totals from the routed segments", async () => {
    fetchMock.mockImplementation(() => routeResponse(600));
    const plan = threeLegPlan();

    const result = await routeTripPlan({
      plan,
      placePool: derivePlanPlacePool(plan),
      now: () => AT,
    });

    if (result.status === "failed") throw new Error("unexpected failure");
    // Day 1 has two legs at 600 s = 10 min each.
    expect(result.plan.days[0].totalTravelMinutes).toBe(20);
    expect(result.plan.days[1].totalTravelMinutes).toBe(10);
  });

  it("leaves the budget's monetary categories untouched", async () => {
    fetchMock.mockImplementation(() => routeResponse());
    const plan = threeLegPlan();

    const result = await routeTripPlan({
      plan,
      placePool: derivePlanPlacePool(plan),
      now: () => AT,
    });

    if (result.status === "failed") throw new Error("unexpected failure");
    // Routing changes time, not money. A failed route must not make the trip
    // look cheaper, and a successful one must not make it dearer.
    expect(result.plan.budget.transport).toBe(plan.budget.transport);
    expect(result.plan.budget.food).toBe(plan.budget.food);
  });

  it("records the applied policy on the plan", async () => {
    fetchMock.mockImplementation(() => routeResponse());
    const plan = threeLegPlan();

    const result = await routeTripPlan({
      plan,
      placePool: derivePlanPlacePool(plan),
      policy: { accommodation: "none" },
      now: () => AT,
    });

    if (result.status === "failed") throw new Error("unexpected failure");
    expect(result.plan.routing?.lastRoutedAt).toBe(AT);
    expect(result.plan.routing?.policy.accommodation).toBe("none");
  });

  it("makes no request for a plan with no eligible legs", async () => {
    const plan = fixturePlan([fixtureDay(1, [fixtureItem("i1", P.a)])]);

    const result = await routeTripPlan({
      plan,
      placePool: derivePlanPlacePool(plan),
      now: () => AT,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    if (result.status === "failed") return;
    expect(result.summary.expectedLegs).toBe(0);
    expect(result.summary.completion).toBe("not_attempted");
  });

  it("reuses the cache on a second run", async () => {
    fetchMock.mockImplementation(() => routeResponse());
    const plan = threeLegPlan();
    const pool = derivePlanPlacePool(plan);

    await routeTripPlan({ plan, placePool: pool, now: () => AT });
    const firstRun = fetchMock.mock.calls.length;
    expect(firstRun).toBeGreaterThan(0);

    await routeTripPlan({ plan, placePool: pool, now: () => AT });
    // Every leg is cached, so a re-run after a partial failure is free.
    expect(fetchMock).toHaveBeenCalledTimes(firstRun);
  });

  it("propagates an abort", async () => {
    fetchMock.mockImplementation(() => routeResponse());
    const plan = threeLegPlan();
    const controller = new AbortController();
    controller.abort();

    await expect(
      routeTripPlan({
        plan,
        placePool: derivePlanPlacePool(plan),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("bounds the number of legs before any request", async () => {
    // The real Lisbon plan is 23 stops across five days, comfortably inside the
    // caps; a synthetic over-cap plan is what proves the guard fires.
    const plan = threeLegPlan();
    expect(() => assertWithinTripCaps(plan)).not.toThrow();
    expect(() => assertWithinTripCaps(mockTripPlan)).not.toThrow();
  });

  it("rejects a plan with too many stops without calling out", async () => {
    const overCap = {
      ...mockTripPlan,
      days: mockTripPlan.days.map((day) => ({
        ...day,
        items: [...day.items, ...day.items],
      })),
    } as TripPlan;

    expect(() => assertWithinTripCaps(overCap)).toThrow(RoutingProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Targeted retry (Phase 6A).
   *
   * The same orchestration with a smaller leg set — same expected-leg derivation, same
   * service, same builder. These assert the two properties that make it a *retry*
   * rather than a reroute: only the named legs are requested, and every other segment
   * survives untouched.
   */
  describe("targeted retry", () => {
    it("requests only the named legs, leaving the others alone", async () => {
      const plan = threeLegPlan();
      const expected = deriveExpectedLegs(plan, planRoutingPolicy());
      expect(expected.length).toBeGreaterThan(1);

      fetchMock.mockImplementation(() => routeResponse());

      const result = await routeTripPlan({
        plan,
        placePool: derivePlanPlacePool(plan),
        retryLegIds: [expected[0].id],
        now: () => AT,
      });

      // One provider request for one leg, rather than one per eligible leg.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.status).not.toBe("failed");
      if (result.status === "failed") return;

      const routed = result.plan.days
        .flatMap((day) => day.items)
        .filter((item) => item.travelToNext?.status === "routed");
      expect(routed).toHaveLength(1);
      expect(routed[0].travelToNext?.id).toBe(expected[0].id);
    });

    it("ignores an id the plan no longer expects", async () => {
      const plan = threeLegPlan();
      const expected = deriveExpectedLegs(plan, planRoutingPolicy());

      fetchMock.mockImplementation(() => routeResponse());

      await routeTripPlan({
        plan,
        placePool: derivePlanPlacePool(plan),
        // A stale id from an older render must not become a provider request.
        retryLegIds: [expected[0].id, "day:9:from:ghost:to:phantom:mode:walk"],
        now: () => AT,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("requests nothing when no named leg is still expected", async () => {
      const plan = threeLegPlan();

      fetchMock.mockImplementation(() => routeResponse());

      const result = await routeTripPlan({
        plan,
        placePool: derivePlanPlacePool(plan),
        retryLegIds: ["day:9:from:ghost:to:phantom:mode:walk"],
        now: () => AT,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // Still a valid plan: nothing was asked for, so nothing changed.
      expect(result.status).not.toBe("failed");
    });

    it("collapses duplicate ids into one request", async () => {
      const plan = threeLegPlan();
      const expected = deriveExpectedLegs(plan, planRoutingPolicy());

      fetchMock.mockImplementation(() => routeResponse());

      await routeTripPlan({
        plan,
        placePool: derivePlanPlacePool(plan),
        retryLegIds: [expected[0].id, expected[0].id, expected[0].id],
        now: () => AT,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("states its caps rather than leaving them implicit", () => {
    expect(TRIP_ROUTING_LIMITS).toEqual({
      maxDays: 7,
      maxStops: 24,
      maxLegs: 23,
      // Phase 6A: a targeted retry has its own ceiling, stated separately so the two
      // can diverge without one silently inheriting the other's value.
      maxRetryLegs: 23,
    });
  });
});

describe("the sample trip, end to end", () => {
  it("routes the real Lisbon plan into a complete enriched plan", async () => {
    fetchMock.mockImplementation(() => routeResponse());

    const pool = derivePlanPlacePool(mockTripPlan);
    const expected = deriveExpectedLegs(mockTripPlan, planRoutingPolicy());

    const result = await routeTripPlan({
      plan: mockTripPlan,
      placePool: pool,
      now: () => AT,
    });

    expect(result.status).toBe("complete");
    if (result.status === "failed") return;
    expect(result.summary.expectedLegs).toBe(expected.length);
    expect(result.summary.routedLegs).toBe(expected.length);
    // Every day still has its stops, in order, with ids intact.
    expect(result.plan.days.map((day) => day.items.length)).toEqual(
      mockTripPlan.days.map((day) => day.items.length),
    );
  });

  it("replaces the sample's estimates with routed segments", async () => {
    fetchMock.mockImplementation(() => routeResponse());

    const result = await routeTripPlan({
      plan: mockTripPlan,
      placePool: derivePlanPlacePool(mockTripPlan),
      now: () => AT,
    });

    if (result.status === "failed") throw new Error("unexpected failure");
    const statuses = new Set(
      result.plan.days.flatMap((day) =>
        day.items.flatMap((item) =>
          item.travelToNext ? [item.travelToNext.status] : [],
        ),
      ),
    );
    expect(statuses.has("routed")).toBe(true);
    expect(statuses.has("estimated")).toBe(false);
  });
});
