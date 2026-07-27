import { describe, expect, it } from "vitest";

import { InsertFreeTimeCommandSchema } from "@/lib/refinement/commands";
import {
  FIXTURE_GENERATION,
  fixtureRoutedPlan,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { isMappableItem, type TripPlan } from "@/lib/schemas";

import { applyInsertFreeTime } from "./insert-free-time";
import type { StructuralEditResult } from "./types";
import { validatePlanMembership } from "./validate";

/**
 * Day one of the fixture leaves a long afternoon open: `museum-one` ends at 12:30 and `dinner-one`
 * does not begin until 19:30. With the transition floor either side that is a free window of
 * **12:40–19:20**, which is where almost everything below is inserted.
 */

const TIMEZONE = "Europe/Lisbon";

function insert(input: {
  plan?: TripPlan;
  dayNumber?: number;
  startTime: string;
  endTime: string;
  title?: string;
}): StructuralEditResult {
  return applyInsertFreeTime({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: "insert-free-time",
      dayNumber: input.dayNumber ?? 1,
      startTime: input.startTime,
      endTime: input.endTime,
      ...(input.title !== undefined ? { title: input.title } : {}),
    },
  });
}

function dayOf(result: StructuralEditResult, dayNumber: number) {
  if (result.status === "failed") throw new Error("expected the edit to succeed");
  const day = result.plan.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) throw new Error(`no day ${dayNumber}`);
  return day;
}

describe("applyInsertFreeTime", () => {
  it("puts the block where its times say it belongs, not where a caller asked", () => {
    const day = dayOf(insert({ startTime: "14:00", endTime: "16:00" }), 1);

    expect(day.items.map((item) => item.id)).toEqual([
      "cafe-one",
      "museum-one",
      expect.stringContaining("d1-free"),
      "dinner-one",
    ]);
    // Sequence and clock agree, which is the whole reason position is derived from time here.
    expect(day.items.map((item) => item.startTime)).toEqual([
      "09:00",
      "10:30",
      "14:00",
      "19:30",
    ]);
  });

  it("renumbers order across the day", () => {
    expect(
      dayOf(insert({ startTime: "14:00", endTime: "16:00" }), 1).items.map(
        (item) => item.order,
      ),
    ).toEqual([0, 1, 2, 3]);
  });

  it("builds an ordinary placeless rest block, free and unlocked", () => {
    const block = dayOf(insert({ startTime: "14:00", endTime: "16:00" }), 1).items[2];

    expect(block.kind).toBe("rest");
    expect(block.place).toBeNull();
    expect(block.mealType).toBeNull();
    expect(block.estimatedCost).toBe(0);
    expect(block.locked).toBe(false);
    expect(block.status).toBe("confirmed");
    expect(block.bookingRequired).toBe(false);
    expect(block.travelToNext).toBeNull();
    // No provenance, because no figure was derived.
    expect(block.costEstimate).toBeUndefined();
    // And it carries no map marker.
    expect(isMappableItem(block)).toBe(false);
  });

  it("uses the traveller's label, or a plain default", () => {
    expect(
      dayOf(insert({ startTime: "14:00", endTime: "16:00" }), 1).items[2].title,
    ).toBe("Free time");
    expect(
      dayOf(insert({ startTime: "14:00", endTime: "16:00", title: "Swim" }), 1)
        .items[2].title,
    ).toBe("Swim");
  });

  it("costs nothing, so the day's total does not move", () => {
    const before = fixtureSavedPlan().days[0].dayTotal;
    expect(dayOf(insert({ startTime: "14:00", endTime: "16:00" }), 1).dayTotal).toBe(
      before,
    );
  });

  it("refuses times that collide with a stop", () => {
    // 11:00 is inside `museum-one`'s 10:30–12:30.
    expect(insert({ startTime: "11:00", endTime: "12:00" })).toMatchObject({
      status: "failed",
      errors: [{ code: "invalid_times" }],
    });
  });

  it("refuses times that run into the next stop", () => {
    // 19:20 is the last minute free before `dinner-one`.
    expect(insert({ startTime: "18:00", endTime: "19:25" })).toMatchObject({
      status: "failed",
      errors: [{ code: "invalid_times" }],
    });
  });

  it("refuses a block shorter than a stop's minimum", () => {
    expect(insert({ startTime: "14:00", endTime: "14:10" })).toMatchObject({
      status: "failed",
      errors: [{ code: "invalid_times" }],
    });
  });

  it("refuses an end that is not after the start", () => {
    expect(insert({ startTime: "14:00", endTime: "13:00" })).toMatchObject({
      status: "failed",
      errors: [{ code: "invalid_times" }],
    });
  });

  it("refuses a day that is not part of the trip", () => {
    expect(insert({ dayNumber: 9, startTime: "14:00", endTime: "16:00" })).toMatchObject(
      { status: "failed", errors: [{ code: "day_not_found" }] },
    );
  });

  it("mints an id that does not collide", () => {
    const first = insert({ startTime: "14:00", endTime: "15:00" });
    if (first.status === "failed") throw new Error("expected success");

    const second = applyInsertFreeTime({
      plan: first.plan,
      generation: FIXTURE_GENERATION,
      revisionBefore: 4,
      timezone: TIMEZONE,
      command: {
        type: "insert-free-time",
        dayNumber: 1,
        startTime: "16:00",
        endTime: "17:00",
      },
    });

    const ids = dayOf(second, 1).items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * `deriveExpectedLegs` skips placeless blocks, so free time dropped into a day does not come
   * between two stops as far as routing is concerned — the journey between them is the same
   * journey, and its measurement stays.
   */
  it("invalidates no routed legs and creates none", () => {
    const result = insert({
      plan: fixtureRoutedPlan(),
      startTime: "14:00",
      endTime: "16:00",
    });

    if (result.status === "failed") throw new Error("expected success");
    expect(result.summary.invalidatedLegIds).toEqual([]);
    expect(result.summary.addedLegIds).toEqual([]);
  });

  it("adds no place, so the pool invariant still holds", () => {
    const result = insert({ startTime: "14:00", endTime: "16:00" });
    if (result.status === "failed") throw new Error("expected success");

    expect(
      validatePlanMembership({
        plan: result.plan,
        generation: result.generationContext,
      }),
    ).toEqual([]);
  });

  it("reports the new block as added, on the day it landed", () => {
    const result = insert({ startTime: "14:00", endTime: "16:00" });
    if (result.status === "failed") throw new Error("expected success");

    expect(result.summary.action).toBe("insert-free-time");
    expect(result.summary.addedItemIds).toHaveLength(1);
    expect(result.summary.removedItemIds).toEqual([]);
    expect(result.summary.affectedDays).toEqual([1]);
  });
});

/**
 * The label is the one free-text field in the whole command vocabulary, so its bounds are part of
 * the safety argument rather than an input nicety.
 */
describe("InsertFreeTimeCommandSchema — the label", () => {
  const base = {
    type: "insert-free-time",
    dayNumber: 1,
    startTime: "14:00",
    endTime: "16:00",
  };

  it("accepts an ordinary label and trims it", () => {
    expect(
      InsertFreeTimeCommandSchema.parse({ ...base, title: "  Nap  " }).title,
    ).toBe("Nap");
  });

  it("is optional", () => {
    expect(InsertFreeTimeCommandSchema.safeParse(base).success).toBe(true);
  });

  it("rejects an empty or whitespace-only label", () => {
    for (const title of ["", "   ", "\t"]) {
      expect(
        InsertFreeTimeCommandSchema.safeParse({ ...base, title }).success,
        JSON.stringify(title),
      ).toBe(false);
    }
  });

  it("caps the length, so a label cannot become a payload", () => {
    expect(
      InsertFreeTimeCommandSchema.safeParse({ ...base, title: "a".repeat(80) })
        .success,
    ).toBe(true);
    expect(
      InsertFreeTimeCommandSchema.safeParse({ ...base, title: "a".repeat(81) })
        .success,
    ).toBe(false);
  });

  it("rejects control and formatting characters rather than stripping them", () => {
    // A newline, a bell, and a zero-width space — the last is the one that looks harmless.
    for (const title of ["nap\nswim", "nap", "nap​swim"]) {
      expect(
        InsertFreeTimeCommandSchema.safeParse({ ...base, title }).success,
        JSON.stringify(title),
      ).toBe(false);
    }
  });

  it("still has nowhere to put a place, a coordinate or a route fact", () => {
    const parsed = InsertFreeTimeCommandSchema.parse({
      ...base,
      title: "Nap",
      placeId: "osm:node:1001",
      latitude: 38.7,
      durationMinutes: 30,
    });

    for (const field of ["placeId", "latitude", "durationMinutes"]) {
      expect(parsed, field).not.toHaveProperty(field);
    }
  });
});
