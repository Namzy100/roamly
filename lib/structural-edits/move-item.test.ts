import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  fixtureSavedPlan,
  withPlaceHours,
} from "@/lib/refinement/test-fixtures";
import type { ItineraryItem, TripPlan } from "@/lib/schemas";

import { applyMoveItem, itemIsMovable } from "./move-item";
import type { StructuralEditResult } from "./types";

/**
 * The fixture trip: Lisbon, Saturday 2026-09-12 and Sunday the 13th, four stops on day one and
 * three on day two. Every itinerary item is a real place-backed stop, so the transition floor
 * applies throughout.
 */

const TIMEZONE = "Europe/Lisbon";

function move(input: {
  plan?: TripPlan;
  sourceDayNumber?: number;
  targetDayNumber?: number;
  itemId: string;
  targetPosition?: Parameters<typeof applyMoveItem>[0]["command"]["targetPosition"];
  startTime?: string;
  endTime?: string;
  generation?: typeof FIXTURE_GENERATION;
}): StructuralEditResult {
  return applyMoveItem({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: input.generation ?? FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: "move-item",
      sourceDayNumber: input.sourceDayNumber ?? 1,
      targetDayNumber: input.targetDayNumber ?? 2,
      itemId: input.itemId,
      targetPosition: input.targetPosition ?? { kind: "end" },
      ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
    },
  });
}

function itemsOf(plan: TripPlan, dayNumber: number): ItineraryItem[] {
  return plan.days.find((day) => day.dayNumber === dayNumber)?.items ?? [];
}

function idsOf(plan: TripPlan, dayNumber: number): string[] {
  return itemsOf(plan, dayNumber).map((item) => item.id);
}

describe("applyMoveItem — across days", () => {
  it("moves the stop and keeps its id", () => {
    const plan = fixtureSavedPlan();

    const result = move({ plan, itemId: "museum-one" });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(idsOf(result.plan, 1)).not.toContain("museum-one");
    expect(idsOf(result.plan, 2)).toContain("museum-one");
  });

  it("closes the gap on the source day without re-timing anything else", () => {
    const plan = fixtureSavedPlan();
    const before = itemsOf(plan, 1).filter((item) => item.id !== "museum-one");

    const result = move({ plan, itemId: "museum-one" });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const after = itemsOf(result.plan, 1);
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    for (const [index, item] of after.entries()) {
      expect(item.startTime).toBe(before[index].startTime);
      expect(item.endTime).toBe(before[index].endTime);
      // `order` is renumbered to close the hole the removal left.
      expect(item.order).toBe(index);
    }
  });

  it("keeps the place and the cost", () => {
    const plan = fixtureSavedPlan();
    const before = itemsOf(plan, 1).find((item) => item.id === "museum-one");

    const result = move({ plan, itemId: "museum-one" });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const after = itemsOf(result.plan, 2).find((item) => item.id === "museum-one");
    expect(after?.place?.placeId).toBe(before?.place?.placeId);
    expect(after?.estimatedCost).toBe(before?.estimatedCost);
    expect(after?.kind).toBe(before?.kind);
    expect(after?.mealType).toBe(before?.mealType);
  });

  it("keeps the visit's length", () => {
    const plan = fixtureSavedPlan();
    const before = itemsOf(plan, 1).find((item) => item.id === "museum-one")!;

    const result = move({ plan, itemId: "museum-one" });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const after = itemsOf(result.plan, 2).find((item) => item.id === "museum-one")!;
    expect(minutes(after.endTime) - minutes(after.startTime)).toBe(
      minutes(before.endTime) - minutes(before.startTime),
    );
  });

  it("recomputes both days' totals", () => {
    const plan = fixtureSavedPlan();
    const cost = itemsOf(plan, 1).find((item) => item.id === "museum-one")!
      .estimatedCost;

    const result = move({ plan, itemId: "museum-one" });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.plan.days[0].dayTotal).toBeCloseTo(plan.days[0].dayTotal - cost, 2);
    expect(result.plan.days[1].dayTotal).toBeCloseTo(plan.days[1].dayTotal + cost, 2);
    // The trip total is unchanged: the stop moved, it did not become cheaper.
    expect(result.plan.budget.total).toBeCloseTo(plan.budget.total, 2);
  });

  it("reports both days as affected", () => {
    const result = move({ itemId: "museum-one" });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    expect(result.summary.affectedDays).toEqual([1, 2]);
    expect(result.summary.changedItemIds).toContain("museum-one");
    expect(result.summary.addedItemIds).toEqual([]);
    expect(result.summary.removedItemIds).toEqual([]);
  });

  /**
   * Positioning, isolated from slot availability.
   *
   * The anchor is chosen as the stop after the day's widest gap, so the test fails only if
   * `before` puts the stop in the wrong place — not because a two-hour museum happens not to fit
   * ahead of whichever stop the fixture lists second.
   */
  it("inserts before a named stop", () => {
    const plan = fixtureSavedPlan();
    const anchor = widestGapAnchor(plan, 2);

    const result = move({
      plan,
      itemId: "museum-one",
      targetPosition: { kind: "before", itemId: anchor },
    });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    const ids = idsOf(result.plan, 2);
    expect(ids.indexOf("museum-one")).toBe(ids.indexOf(anchor) - 1);
  });

  it("moves a placeless free-time block", () => {
    const plan = fixtureSavedPlan();
    const withFreeTime: TripPlan = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              items: [
                ...day.items,
                {
                  ...day.items[0],
                  id: "free",
                  kind: "rest" as const,
                  place: null,
                  startTime: "21:00",
                  endTime: "22:00",
                  estimatedCost: 0,
                  travelToNext: null,
                },
              ],
            }
          : day,
      ),
    };

    const result = move({ plan: withFreeTime, itemId: "free" });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    expect(idsOf(result.plan, 2)).toContain("free");
  });
});

describe("applyMoveItem — within one day", () => {
  it("reorders and re-times", () => {
    const plan = fixtureSavedPlan();
    const firstId = idsOf(plan, 1)[0];

    const result = move({
      plan,
      itemId: firstId,
      sourceDayNumber: 1,
      targetDayNumber: 1,
      targetPosition: { kind: "end" },
    });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const ids = idsOf(result.plan, 1);
    expect(ids[ids.length - 1]).toBe(firstId);
    expect(ids).toHaveLength(plan.days[0].items.length);
    expect(itemsOf(result.plan, 1).map((item) => item.order)).toEqual(
      ids.map((_, index) => index),
    );
  });

  it("reports one affected day", () => {
    const plan = fixtureSavedPlan();
    const result = move({
      plan,
      itemId: idsOf(plan, 1)[0],
      sourceDayNumber: 1,
      targetDayNumber: 1,
    });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    expect(result.summary.affectedDays).toEqual([1]);
  });

  it("refuses a position relative to the stop itself", () => {
    const plan = fixtureSavedPlan();
    const id = idsOf(plan, 1)[1];

    expect(
      move({
        plan,
        itemId: id,
        sourceDayNumber: 1,
        targetDayNumber: 1,
        targetPosition: { kind: "before", itemId: id },
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "same_position" }] });
  });

  it("refuses a move that changes nothing", () => {
    const plan = fixtureSavedPlan();
    const lastId = idsOf(plan, 1)[plan.days[0].items.length - 1];
    const last = itemsOf(plan, 1).find((item) => item.id === lastId)!;

    expect(
      move({
        plan,
        itemId: lastId,
        sourceDayNumber: 1,
        targetDayNumber: 1,
        targetPosition: { kind: "end" },
        startTime: last.startTime,
        endTime: last.endTime,
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "same_position" }] });
  });
});

describe("applyMoveItem — what it refuses", () => {
  it("refuses a day the trip does not have", () => {
    expect(move({ itemId: "museum-one", targetDayNumber: 7 })).toMatchObject({
      status: "failed",
      errors: [{ code: "day_not_found" }],
    });
  });

  it("refuses a stop that is not on the source day", () => {
    expect(move({ itemId: "not-a-stop" })).toMatchObject({
      status: "failed",
      errors: [{ code: "item_not_found" }],
    });
  });

  it("refuses a target position that does not exist", () => {
    expect(
      move({
        itemId: "museum-one",
        targetPosition: { kind: "after", itemId: "gone" },
      }),
    ).toMatchObject({
      status: "failed",
      errors: [{ code: "target_item_not_found" }],
    });
  });

  /**
   * The lock, asserted. An arrival transfer on day three would describe a journey that does not
   * happen, and the dates rather than a preference are what pin it down.
   */
  it("refuses a transport or logistics block", () => {
    const plan = fixtureSavedPlan();
    const locked: TripPlan = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              items: day.items.map((item, position) =>
                position === 0
                  ? { ...item, kind: "transport" as const, place: null }
                  : item,
              ),
            }
          : day,
      ),
    };

    const result = move({ plan: locked, itemId: idsOf(locked, 1)[0] });
    /**
     * `item_structurally_locked` since Phase 8, not `item_locked`.
     *
     * The two are now different refusals carrying different advice: this one cannot be released at
     * all, while a traveller's own lock clears in a click. Reporting both as `item_locked` would make
     * the interface say "unlock it first" beside a block that has no unlock control.
     */
    expect(result).toMatchObject({
      status: "failed",
      errors: [{ code: "item_structurally_locked" }],
    });
    if (result.status !== "failed") return;
    expect(result.errors[0].message).toContain("cannot be changed");
  });

  /**
   * The traveller's own lock refuses a move too — added in Phase 8.
   *
   * Without this the padlock would be decorative for the action most likely to be a misdrag, which
   * is the one it most needs to prevent.
   */
  it("refuses a move of a stop the traveller has locked", () => {
    const plan = fixtureSavedPlan();
    const pinned: TripPlan = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              items: day.items.map((item, position) =>
                position === 1 ? { ...item, locked: true } : item,
              ),
            }
          : day,
      ),
    };

    const result = move({ plan: pinned, itemId: idsOf(pinned, 1)[1] });
    expect(result).toMatchObject({
      status: "failed",
      errors: [{ code: "item_locked" }],
    });
    if (result.status !== "failed") return;
    expect(result.errors[0].message).toContain("Unlock");
  });

  /** A day with no items fails its own schema, so the move is refused before it is built. */
  it("refuses a move that would empty the source day", () => {
    const plan = fixtureSavedPlan();
    const thin: TripPlan = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 0 ? { ...day, items: [day.items[0]] } : day,
      ),
    };

    expect(move({ plan: thin, itemId: idsOf(thin, 1)[0] })).toMatchObject({
      status: "failed",
      errors: [{ code: "day_would_be_empty" }],
    });
  });

  it("refuses explicit times that collide at the chosen position", () => {
    const plan = fixtureSavedPlan();
    const anchor = itemsOf(plan, 2)[0];

    expect(
      move({
        plan,
        itemId: "museum-one",
        targetPosition: { kind: "after", itemId: anchor.id },
        startTime: anchor.startTime,
        endTime: anchor.endTime,
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "invalid_times" }] });
  });

  it("refuses a move to a day with no room for it", () => {
    const plan = fixtureSavedPlan();
    const packed: TripPlan = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 1
          ? {
              ...day,
              items: [
                {
                  ...day.items[0],
                  startTime: "05:00",
                  endTime: "23:59",
                  travelToNext: null,
                },
              ],
            }
          : day,
      ),
    };

    expect(move({ plan: packed, itemId: "museum-one" })).toMatchObject({
      status: "failed",
      errors: [{ code: "no_slot_available" }],
    });
  });

  /**
   * A day may lose a meal to a move, but not its only one — that is a real loss, and the
   * baseline is the day as it was rather than as it became.
   */
  it("refuses a move that would remove the source day's only meal of a type", () => {
    const plan = fixtureSavedPlan();
    const dinner = itemsOf(plan, 1).find((item) => item.mealType === "dinner");
    expect(dinner).toBeDefined();

    const result = move({ plan, itemId: dinner!.id });

    expect(result).toMatchObject({
      status: "failed",
      errors: [{ code: "schedule_invalid" }],
    });
    if (result.status !== "failed") return;
    expect(result.errors[0].message).toContain("dinner");
  });

  it("returns no plan on failure", () => {
    const result = move({ itemId: "not-a-stop" });
    expect(result.status).toBe("failed");
    expect("plan" in result).toBe(false);
  });

  it("leaves the plan it was given untouched on failure", () => {
    const plan = fixtureSavedPlan();
    const snapshot = JSON.stringify(plan);

    move({ plan, itemId: "not-a-stop" });

    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

describe("applyMoveItem — routes and hours", () => {
  it("reports the adjacencies the move created", () => {
    const result = move({ itemId: "museum-one" });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    expect(result.summary.addedLegIds.length).toBeGreaterThan(0);
    // Both days gain adjacencies: the source bridges the gap, the target inserts.
    const days = new Set(
      result.summary.addedLegIds.map((legId) => legId.split(":")[1]),
    );
    expect(days).toEqual(new Set(["1", "2"]));
  });

  /**
   * A stop that is fine on Saturday can be shut on Sunday, and moving it is exactly how a
   * traveller discovers that — so the move succeeds and warns rather than refusing.
   */
  it("warns when the target date's hours say the place is shut", () => {
    // Day 2 is a Sunday; these hours cover neither day, so the conflict follows the stop.
    const plan = withPlaceHours(
      fixtureSavedPlan(),
      FIXTURE_PLACES.museumOne.placeId,
      "Mo-Fr 10:00-18:00",
    );

    const result = move({
      plan,
      itemId: "museum-one",
      generation: {
        ...FIXTURE_GENERATION,
        placePool: {
          ...FIXTURE_GENERATION.placePool,
          places: FIXTURE_GENERATION.placePool.places.map((place) =>
            place.placeId === FIXTURE_PLACES.museumOne.placeId
              ? { ...place, openingHours: "Mo-Fr 10:00-18:00" }
              : place,
          ),
        },
      },
    });

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "hours_conflict_after_edit",
    );
  });

  it("is deterministic", () => {
    const plan = fixtureSavedPlan();

    expect(JSON.stringify(move({ plan, itemId: "museum-one" }))).toBe(
      JSON.stringify(move({ plan, itemId: "museum-one" })),
    );
  });
});

describe("itemIsMovable", () => {
  it("is false for the blocks the dates pin down", () => {
    const plan = fixtureSavedPlan();
    const item = plan.days[0].items[0];

    expect(itemIsMovable({ ...item, kind: "transport" })).toBe(false);
    expect(itemIsMovable({ ...item, kind: "logistics" })).toBe(false);
  });

  it("is true for everything else", () => {
    const plan = fixtureSavedPlan();
    const item = plan.days[0].items[0];

    for (const kind of [
      "meal",
      "attraction",
      "experience",
      "viewpoint",
      "rest",
    ] as const) {
      expect(itemIsMovable({ ...item, kind }), kind).toBe(true);
    }
  });
});

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

/** The id of the stop that follows the day's widest free gap. */
function widestGapAnchor(plan: TripPlan, dayNumber: number): string {
  const items = itemsOf(plan, dayNumber);
  let bestId = items[items.length - 1].id;
  let bestGap = -1;

  for (let index = 1; index < items.length; index += 1) {
    const gap = minutes(items[index].startTime) - minutes(items[index - 1].endTime);
    if (gap > bestGap) {
      bestGap = gap;
      bestId = items[index].id;
    }
  }
  return bestId;
}
