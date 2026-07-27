import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureRoutedPlan,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { ItineraryItem, TripPlan } from "@/lib/schemas";

import {
  applySetItemSchedule,
  freeWindowForItem,
  itemIsRetimable,
} from "./set-schedule";
import type { StructuralEditResult } from "./types";

/**
 * The fixture trip's day one: `cafe-one` 09:00–10:00, `museum-one` 10:30–12:30, `dinner-one`
 * 19:30–21:00 — all three real place-backed stops, so the ten-minute transition floor applies on
 * both sides of every one of them.
 *
 * That makes `museum-one`'s free window **10:10–19:20**, and most of what follows is about that
 * number: this applier's whole job is to honour times inside it and refuse times outside it
 * *without* rearranging the day to make them fit.
 */

const TIMEZONE = "Europe/Lisbon";

function retime(input: {
  plan?: TripPlan;
  dayNumber?: number;
  itemId: string;
  startTime: string;
  endTime: string;
}): StructuralEditResult {
  return applySetItemSchedule({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: "set-item-time",
      dayNumber: input.dayNumber ?? 1,
      itemId: input.itemId,
      startTime: input.startTime,
      endTime: input.endTime,
    },
  });
}

function resize(input: {
  plan?: TripPlan;
  dayNumber?: number;
  itemId: string;
  durationMinutes: number;
  anchor: "start" | "end";
}): StructuralEditResult {
  return applySetItemSchedule({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: "set-item-duration",
      dayNumber: input.dayNumber ?? 1,
      itemId: input.itemId,
      durationMinutes: input.durationMinutes,
      anchor: input.anchor,
    },
  });
}

/** The plan with one item rewritten, for the lock cases. */
function planWith(itemId: string, patch: Partial<ItineraryItem>): TripPlan {
  const plan = fixtureSavedPlan();
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      items: day.items.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      ),
    })),
  };
}

function itemIn(result: StructuralEditResult, itemId: string): ItineraryItem {
  if (result.status === "failed") throw new Error("expected the edit to succeed");
  const found = result.plan.days
    .flatMap((day) => day.items)
    .find((item) => item.id === itemId);
  if (!found) throw new Error(`no item ${itemId}`);
  return found;
}

function minutesBetween(start: string, end: string): number {
  const toMinutes = (time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  return toMinutes(end) - toMinutes(start);
}

describe("freeWindowForItem", () => {
  it("reports the gap the neighbours leave, with the transition floor on both sides", () => {
    expect(freeWindowForItem(fixtureSavedPlan(), 1, "museum-one")).toEqual({
      earliest: "10:10",
      latest: "19:20",
    });
  });

  it("opens to the day's own bounds for the first and last stops", () => {
    // Nothing before `cafe-one`, so the floor is the planning day's start.
    expect(freeWindowForItem(fixtureSavedPlan(), 1, "cafe-one")?.earliest).toBe(
      "05:00",
    );
    // Nothing after `dinner-one`, so the ceiling is the planning day's end.
    expect(freeWindowForItem(fixtureSavedPlan(), 1, "dinner-one")?.latest).toBe(
      "23:59",
    );
  });

  /**
   * The floor applies between two *visits*. Day two's `afternoon-open` is a placeless block, so
   * `museum-two` may run right up to it — a gap either side of a placeholder is not a journey.
   */
  it("does not charge a transition either side of a placeless block", () => {
    expect(freeWindowForItem(fixtureSavedPlan(), 2, "museum-two")?.latest).toBe(
      "13:00",
    );
  });

  it("returns null for a stop that is not there", () => {
    expect(freeWindowForItem(fixtureSavedPlan(), 1, "nope")).toBeNull();
    expect(freeWindowForItem(fixtureSavedPlan(), 9, "museum-one")).toBeNull();
  });
});

describe("applySetItemSchedule — times", () => {
  it("honours times inside the free window exactly", () => {
    const result = retime({
      itemId: "museum-one",
      startTime: "13:00",
      endTime: "15:00",
    });

    expect(result.status).not.toBe("failed");
    const item = itemIn(result, "museum-one");
    expect(item.startTime).toBe("13:00");
    expect(item.endTime).toBe("15:00");
  });

  /**
   * The behaviour this applier exists for.
   *
   * 21:30 is after `dinner-one` starts. The Phase 6B applier accepted this and re-sorted the day, so
   * the traveller's evening silently swapped round. This one refuses, and names the window.
   */
  it("refuses times that would jump a neighbour, and leaves the day's order untouched", () => {
    const before = fixtureSavedPlan();
    const result = retime({
      plan: before,
      itemId: "museum-one",
      startTime: "21:30",
      endTime: "22:30",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("invalid_times");
    // The message has to say where the room actually is, or the refusal is unactionable.
    expect(result.errors[0].message).toContain("10:10");
    expect(result.errors[0].message).toContain("19:20");

    // Nothing was mutated: the applier is pure, and the caller still holds its own plan.
    expect(before.days[0].items.map((item) => item.id)).toEqual([
      "cafe-one",
      "museum-one",
      "dinner-one",
    ]);
    expect(before.days[0].items[1].startTime).toBe("10:30");
  });

  it("refuses a start that eats into the previous stop's transition", () => {
    // `cafe-one` ends at 10:00, so a 10:00 start leaves no time to get anywhere.
    const result = retime({
      itemId: "museum-one",
      startTime: "10:00",
      endTime: "11:00",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("invalid_times");
  });

  it("refuses an end that is not after the start", () => {
    expect(
      retime({ itemId: "museum-one", startTime: "13:00", endTime: "13:00" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "invalid_times" }] });
  });

  it("refuses a stop shorter than the minimum visit", () => {
    expect(
      retime({ itemId: "museum-one", startTime: "13:00", endTime: "13:10" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "invalid_times" }] });
  });

  it("refuses times identical to the ones already stored", () => {
    expect(
      retime({ itemId: "museum-one", startTime: "10:30", endTime: "12:30" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "no_change" }] });
  });

  it("refuses a day or a stop that is not part of the trip", () => {
    expect(
      retime({
        itemId: "museum-one",
        dayNumber: 9,
        startTime: "13:00",
        endTime: "14:00",
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "day_not_found" }] });

    expect(
      retime({ itemId: "ghost", startTime: "13:00", endTime: "14:00" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "item_not_found" }] });
  });

  /**
   * A re-time keeps its sequence, so its adjacency is unchanged, so the measurement of the journey
   * leaving it is still true. Valhalla reports no live traffic, and there is nothing about 13:00
   * that makes a distance taken for 10:30 wrong.
   *
   * Asserted against a **routed** fixture, so "nothing invalidated" is a real observation rather
   * than vacuously true of a plan that holds no legs.
   */
  it("keeps the routed leg leaving the stop, and invalidates nothing", () => {
    const routed = fixtureRoutedPlan();
    const day = routed.days[0];

    /**
     * Whichever stop actually holds the routed leg — the fixture routes day one's *first* expected
     * leg, so today that is `cafe-one`. Found rather than named, so this keeps testing the property
     * if the fixture starts routing a different leg.
     */
    const target = day.items.find((item) => item.travelToNext?.status === "routed");
    expect(target).toBeDefined();
    if (!target) return;

    const result = applySetItemSchedule({
      plan: routed,
      generation: FIXTURE_GENERATION,
      revisionBefore: 3,
      timezone: TIMEZONE,
      command: {
        type: "set-item-duration",
        dayNumber: day.dayNumber,
        itemId: target.id,
        // Five minutes shorter, anchored at the start: it cannot collide with anything.
        durationMinutes: Math.max(
          15,
          minutesBetween(target.startTime, target.endTime) - 5,
        ),
        anchor: "start",
      },
    });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.summary.invalidatedLegIds).toEqual([]);
    expect(itemIn(result, target.id).travelToNext?.status).toBe("routed");
  });
});

describe("applySetItemSchedule — duration", () => {
  it("extends forwards from the start when anchored at the start", () => {
    const item = itemIn(
      resize({ itemId: "museum-one", durationMinutes: 180, anchor: "start" }),
      "museum-one",
    );
    expect(item.startTime).toBe("10:30");
    expect(item.endTime).toBe("13:30");
  });

  it("extends backwards from the end when anchored at the end", () => {
    const item = itemIn(
      resize({ itemId: "cafe-one", durationMinutes: 120, anchor: "end" }),
      "cafe-one",
    );
    expect(item.startTime).toBe("08:00");
    expect(item.endTime).toBe("10:00");
  });

  it("refuses a length that would run past the end of the planning day", () => {
    // 720 minutes from `dinner-one`'s 19:30 start would end at 07:30 the next morning.
    const result = resize({
      itemId: "dinner-one",
      durationMinutes: 720,
      anchor: "start",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("invalid_times");
    expect(result.errors[0].message).toContain("23:59");
  });

  it("refuses a length that would start before the planning day", () => {
    // 720 minutes ending at `cafe-one`'s 10:00 would start at 22:00 the previous night.
    const result = resize({
      itemId: "cafe-one",
      durationMinutes: 720,
      anchor: "end",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("invalid_times");
    expect(result.errors[0].message).toContain("05:00");
  });

  it("refuses a length that would overrun the next stop", () => {
    // 10:30 + 600 minutes is 20:30, past `dinner-one`'s 19:30 start.
    expect(
      resize({ itemId: "museum-one", durationMinutes: 600, anchor: "start" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "invalid_times" }] });
  });

  it("refuses a length that changes nothing", () => {
    expect(
      resize({ itemId: "museum-one", durationMinutes: 120, anchor: "start" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "no_change" }] });
  });
});

describe("applySetItemSchedule — locks", () => {
  it("refuses a stop the traveller has locked, and says it can be unlocked", () => {
    const result = retime({
      plan: planWith("museum-one", { locked: true }),
      itemId: "museum-one",
      startTime: "13:00",
      endTime: "15:00",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("item_locked");
    expect(result.errors[0].message).toContain("Unlock");
  });

  /**
   * A different code and a different sentence, because the advice differs. Telling somebody to
   * "unlock it first" about a block that has no unlock control is the failure worth avoiding.
   */
  it("refuses a date-fixed block with the code that says so", () => {
    const result = retime({
      plan: planWith("museum-one", { kind: "transport" }),
      itemId: "museum-one",
      startTime: "13:00",
      endTime: "15:00",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("item_structurally_locked");
    expect(result.errors[0].message).not.toContain("Unlock");
  });

  it("refuses a resize on a locked stop too", () => {
    expect(
      resize({
        plan: planWith("museum-one", { locked: true }),
        itemId: "museum-one",
        durationMinutes: 180,
        anchor: "start",
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "item_locked" }] });
  });
});

describe("itemIsRetimable", () => {
  it("agrees with the applier about both locks", () => {
    const museum = fixtureSavedPlan().days[0].items[1];

    expect(itemIsRetimable(museum)).toBe(true);
    expect(itemIsRetimable({ ...museum, locked: true })).toBe(false);
    expect(itemIsRetimable({ ...museum, kind: "transport" })).toBe(false);
    expect(itemIsRetimable({ ...museum, kind: "logistics" })).toBe(false);
  });
});
