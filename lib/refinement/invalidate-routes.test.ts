import { describe, expect, it } from "vitest";

import { FIXTURE_PLACES } from "@/lib/generate/test-fixtures";
import { isRoutedSegment, type ItineraryItem, type TripPlan } from "@/lib/schemas";

import {
  clearAllRoutes,
  rekeyDaySegments,
  rekeyPlanSegments,
  selectRetryLegs,
} from "./invalidate-routes";
import {
  FIXTURE_POLICY,
  expectedLegsFor,
  fixtureRoutedPlan,
  fixtureRoutedSegment,
  fixtureSavedPlan,
  fixtureUnavailableSegment,
  legIdFor,
  withSegment,
} from "./test-fixtures";

/**
 * Route invalidation is the part of this phase most likely to be wrong in a way nobody
 * notices: a stale routed line on the map is a real measurement of a journey the
 * traveller is no longer making.
 *
 * Every case below exercises the same underlying rule — keep a segment if and only if
 * its leg id is still expected — and the tests exist to prove one rule covers all five
 * situations the brief lists separately.
 *
 * Leg ids are always **derived**, never spelled out: an id encodes the mode, the mode
 * comes from the distance between two real coordinates, and a hand-written
 * `mode:walk` is a guess. (It was wrong the first time these were written.)
 */

/** Replaces one day's items and returns a whole new plan. */
function withDayItems(
  plan: TripPlan,
  dayNumber: number,
  items: ItineraryItem[],
): TripPlan {
  return {
    ...plan,
    days: plan.days.map((day) =>
      day.dayNumber === dayNumber ? { ...day, items } : day,
    ),
  };
}

describe("rekeyDaySegments", () => {
  it("keeps a segment whose adjacency is unchanged", () => {
    const plan = fixtureRoutedPlan();

    const rekeyed = rekeyDaySegments({
      day: plan.days[0],
      plan,
      policy: FIXTURE_POLICY,
    });

    expect(rekeyed.invalidatedLegIds).toEqual([]);
    const kept = rekeyed.day.items.find((item) => item.travelToNext !== null);
    expect(kept).toBeDefined();
    expect(isRoutedSegment(kept!.travelToNext!)).toBe(true);
  });

  it("drops a segment whose leg no longer exists — a replaced stop", () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];

    /**
     * Renaming the *destination* item changes the leg id, because the id contains both
     * item ids. That is the property the whole module rests on, and it is why a
     * replacement is given a new item id rather than reusing the old one.
     */
    const items = plan.days[0].items.map((item) =>
      item.id === leg.toItemId ? { ...item, id: `${item.id}-r1` } : item,
    );
    const changed = withDayItems(plan, 1, items);

    const rekeyed = rekeyDaySegments({
      day: changed.days[0],
      plan: changed,
      policy: FIXTURE_POLICY,
    });

    expect(rekeyed.invalidatedLegIds).toEqual([leg.id]);
    expect(rekeyed.pendingLegIds).not.toContain(leg.id);
    expect(rekeyed.pendingLegIds.length).toBeGreaterThan(0);
  });

  it("retains no geometry for a dropped adjacency", () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];
    const items = plan.days[0].items.map((item) =>
      item.id === leg.toItemId ? { ...item, id: `${item.id}-r1` } : item,
    );
    const changed = withDayItems(plan, 1, items);

    const rekeyed = rekeyDaySegments({
      day: changed.days[0],
      plan: changed,
      policy: FIXTURE_POLICY,
    });

    expect(
      rekeyed.day.items.some(
        (item) => item.travelToNext && isRoutedSegment(item.travelToNext),
      ),
    ).toBe(false);
  });

  it("creates a pending leg between surviving neighbours when a stop is removed", () => {
    const plan = fixtureSavedPlan();
    const legs = expectedLegsFor(plan, 1);
    expect(legs.length).toBeGreaterThanOrEqual(2);

    // Route the first two hops.
    let routed = plan;
    for (const leg of legs.slice(0, 2)) {
      routed = withSegment(
        routed,
        1,
        leg.fromItemId,
        fixtureRoutedSegment(leg),
      );
    }

    // Remove the stop that sits between them.
    const middleItemId = legs[0].toItemId;
    const trimmed = withDayItems(
      routed,
      1,
      routed.days[0].items.filter((item) => item.id !== middleItemId),
    );

    const rekeyed = rekeyDaySegments({
      day: trimmed.days[0],
      plan: trimmed,
      policy: FIXTURE_POLICY,
    });

    /**
     * One invalidation, not two — and the difference is worth stating.
     *
     * The removed item *carried* its outgoing segment, so that one left with it and
     * was never seen by the re-keying. What remains is the incoming segment, attached
     * to the surviving previous stop, and it names a destination that is gone.
     *
     * So "both legs are dropped" is true of the plan, while only one of them is
     * something this function had to drop.
     */
    expect(rekeyed.invalidatedLegIds).toEqual([legs[0].id]);
    // And the new first→third adjacency is expected but unrouted.
    const bridged = legIdFor(trimmed, 1, legs[0].fromItemId, legs[1].toItemId);
    expect(bridged).not.toBeNull();
    expect(rekeyed.pendingLegIds).toContain(bridged);
  });

  it("invalidates the direct leg when a stop is inserted between two routed ones", () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];

    const inserted: ItineraryItem = {
      ...plan.days[0].items[0],
      id: "inserted-stop",
      startTime: "10:20",
      endTime: "10:35",
      // A real pool place, so the derivation produces genuine legs either side.
      place: FIXTURE_PLACES.restaurantTwo,
      travelToNext: null,
    };

    const fromIndex = plan.days[0].items.findIndex(
      (item) => item.id === leg.fromItemId,
    );
    const withInsert = withDayItems(plan, 1, [
      ...plan.days[0].items.slice(0, fromIndex + 1),
      inserted,
      ...plan.days[0].items.slice(fromIndex + 1),
    ]);

    const rekeyed = rekeyDaySegments({
      day: withInsert.days[0],
      plan: withInsert,
      policy: FIXTURE_POLICY,
    });

    expect(rekeyed.invalidatedLegIds).toEqual([leg.id]);
    expect(
      rekeyed.pendingLegIds.some((legId) => legId.includes("inserted-stop")),
    ).toBe(true);
  });

  it("invalidates the changed adjacencies when a day is reordered", () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];

    const items = plan.days[0].items;
    const fromIndex = items.findIndex((item) => item.id === leg.fromItemId);
    const toIndex = items.findIndex((item) => item.id === leg.toItemId);

    const swapped = [...items];
    [swapped[fromIndex], swapped[toIndex]] = [swapped[toIndex], swapped[fromIndex]];
    const reordered = withDayItems(
      plan,
      1,
      swapped.map((item, index) => ({ ...item, order: index })),
    );

    const rekeyed = rekeyDaySegments({
      day: reordered.days[0],
      plan: reordered,
      policy: FIXTURE_POLICY,
    });

    // The reversed adjacency is a different journey and a different id.
    expect(rekeyed.invalidatedLegIds).toContain(leg.id);
  });

  /**
   * The failure this guards against: a plan that gains an unavailable slot shifts every
   * later array index, and a position-keyed implementation would reattach every result
   * to the wrong leg.
   */
  it("does not key on array position", () => {
    const plan = fixtureRoutedPlan();

    const gap: ItineraryItem = {
      ...plan.days[0].items[0],
      id: "a-gap",
      status: "unavailable",
      place: null,
      startTime: "07:00",
      endTime: "07:30",
      estimatedCost: 0,
      travelToNext: null,
    };
    delete (gap as { costEstimate?: unknown }).costEstimate;

    const withGap = withDayItems(
      plan,
      1,
      [gap, ...plan.days[0].items].map((item, index) => ({ ...item, order: index })),
    );

    const rekeyed = rekeyDaySegments({
      day: withGap.days[0],
      plan: withGap,
      policy: FIXTURE_POLICY,
    });

    // The gap is not a stop, so no adjacency changed and the routed leg survives.
    expect(rekeyed.invalidatedLegIds).toEqual([]);
  });

  it("drops a segment from an item that no longer has a successor", () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];

    const onlyFirst = withDayItems(
      plan,
      1,
      plan.days[0].items.filter((item) => item.id === leg.fromItemId),
    );

    const rekeyed = rekeyDaySegments({
      day: onlyFirst.days[0],
      plan: onlyFirst,
      policy: FIXTURE_POLICY,
    });

    expect(rekeyed.invalidatedLegIds).toEqual([leg.id]);
    expect(rekeyed.day.items[0].travelToNext).toBeNull();
  });

  it("returns the same item objects where nothing changed", () => {
    const plan = fixtureRoutedPlan();

    const rekeyed = rekeyDaySegments({
      day: plan.days[0],
      plan,
      policy: FIXTURE_POLICY,
    });

    // Reference equality — a stronger claim than deep equality, and what makes
    // "unrelated items are untouched" checkable rather than asserted.
    const last = plan.days[0].items.length - 1;
    expect(rekeyed.day.items[last]).toBe(plan.days[0].items[last]);
  });

  it("does not mutate the plan it was given", () => {
    const plan = fixtureRoutedPlan();
    const snapshot = JSON.stringify(plan);

    rekeyDaySegments({ day: plan.days[0], plan, policy: FIXTURE_POLICY });
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

describe("rekeyPlanSegments", () => {
  it("checks every day, not only the changed one", () => {
    const plan = fixtureRoutedPlan();

    const rekeyed = rekeyPlanSegments({ plan, policy: FIXTURE_POLICY });

    expect(rekeyed.invalidatedLegIds).toEqual([]);
    expect(rekeyed.pendingLegIds.length).toBeGreaterThan(0);
    expect(rekeyed.plan.days).toHaveLength(plan.days.length);
  });
});

describe("clearAllRoutes", () => {
  it("drops every segment and the routing state with it", () => {
    const plan = fixtureRoutedPlan();

    const cleared = clearAllRoutes(plan);

    expect(cleared.invalidatedLegIds).toHaveLength(1);
    for (const day of cleared.plan.days) {
      for (const item of day.items) expect(item.travelToNext).toBeNull();
      expect(day.totalTravelMinutes).toBe(0);
    }
    // The applied policy and coverage summary described a run against an itinerary
    // that no longer exists.
    expect(cleared.plan.routing).toBeNull();
  });

  it("does not mutate the plan", () => {
    const plan = fixtureRoutedPlan();
    const snapshot = JSON.stringify(plan);

    clearAllRoutes(plan);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

describe("selectRetryLegs", () => {
  it("selects failed and never-attempted legs under unavailable-only", () => {
    const plan = fixtureRoutedPlan();
    const legs = expectedLegsFor(plan, 1);
    const routedLegId = legs[0].id;

    const withFailure =
      legs.length > 1
        ? withSegment(
            plan,
            1,
            legs[1].fromItemId,
            fixtureUnavailableSegment(legs[1]),
          )
        : plan;

    const selection = selectRetryLegs({
      plan: withFailure,
      policy: FIXTURE_POLICY,
      scope: "unavailable-only",
    });

    // A leg that already succeeded is not re-requested — that is the difference
    // between "retry the failures" and "route the whole trip".
    expect(selection.legIds).not.toContain(routedLegId);
    if (legs.length > 1) expect(selection.legIds).toContain(legs[1].id);
  });

  it("selects everything eligible under all", () => {
    const plan = fixtureRoutedPlan();
    const legs = expectedLegsFor(plan, 1);

    const selection = selectRetryLegs({
      plan,
      policy: FIXTURE_POLICY,
      scope: "all",
    });

    expect(selection.legIds).toContain(legs[0].id);
  });

  it("honours an explicit leg list and reports ids the plan no longer expects", () => {
    const plan = fixtureRoutedPlan();
    const real = expectedLegsFor(plan, 1)[0].id;
    const ghost = "day:1:from:ghost:to:phantom:mode:walk";

    const selection = selectRetryLegs({
      plan,
      policy: FIXTURE_POLICY,
      scope: "all",
      legIds: [real, ghost],
    });

    expect(selection.legIds).toEqual([real]);
    expect(selection.rejectedLegIds).toEqual([ghost]);
  });

  it("collapses duplicate ids", () => {
    const plan = fixtureRoutedPlan();
    const real = expectedLegsFor(plan, 1)[0].id;

    expect(
      selectRetryLegs({
        plan,
        policy: FIXTURE_POLICY,
        scope: "all",
        legIds: [real, real, real],
      }).legIds,
    ).toEqual([real]);
  });

  it("scopes to one day when asked", () => {
    const plan = fixtureRoutedPlan();

    const dayTwo = selectRetryLegs({
      plan,
      policy: FIXTURE_POLICY,
      scope: "all",
      dayNumber: 2,
    });

    expect(dayTwo.legIds.length).toBeGreaterThan(0);
    expect(dayTwo.legIds.every((legId) => legId.startsWith("day:2:"))).toBe(true);
  });

  it("returns nothing when a named leg is already routed and only failures were asked for", () => {
    const plan = fixtureRoutedPlan();
    const routedLegId = expectedLegsFor(plan, 1)[0].id;

    // An explicit list is honoured as-is — "retry this one" is a deliberate request,
    // even for a leg that succeeded.
    expect(
      selectRetryLegs({
        plan,
        policy: FIXTURE_POLICY,
        scope: "unavailable-only",
        legIds: [routedLegId],
      }).legIds,
    ).toEqual([routedLegId]);

    // Without a list, the scope decides, and a success is not a failure.
    expect(
      selectRetryLegs({
        plan,
        policy: FIXTURE_POLICY,
        scope: "unavailable-only",
      }).legIds,
    ).not.toContain(routedLegId);
  });
});
