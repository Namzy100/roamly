import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureRoutedPlan,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { ItineraryItem, TripPlan } from "@/lib/schemas";

import { applyRemoveItem, itemIsRemovable } from "./remove-item";
import type { StructuralEditResult } from "./types";
import { validatePlanMembership } from "./validate";

/**
 * Day one: `cafe-one` (the only breakfast, €14), `museum-one` (€20), `dinner-one` (the only dinner,
 * €60) — €94. So `museum-one` is the only stop on that day a removal may touch, and the other two
 * exercise the meal-coverage refusal.
 *
 * Day two adds `afternoon-open`, a placeless rest block, removable because it carries no meal type.
 */

const TIMEZONE = "Europe/Lisbon";

function remove(input: {
  plan?: TripPlan;
  dayNumber?: number;
  itemId: string;
}): StructuralEditResult {
  return applyRemoveItem({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: "remove-item",
      dayNumber: input.dayNumber ?? 1,
      itemId: input.itemId,
    },
  });
}

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

/** The fixture with day one trimmed to a single stop, for the empty-day refusal. */
function planWithLoneStop(): TripPlan {
  const plan = fixtureSavedPlan();
  return {
    ...plan,
    days: plan.days.map((day) =>
      day.dayNumber === 1 ? { ...day, items: [day.items[1]] } : day,
    ),
  };
}

function dayOf(result: StructuralEditResult, dayNumber: number) {
  if (result.status === "failed") throw new Error("expected the edit to succeed");
  const day = result.plan.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) throw new Error(`no day ${dayNumber}`);
  return day;
}

describe("applyRemoveItem", () => {
  it("takes the stop out and renumbers what is left", () => {
    const day = dayOf(remove({ itemId: "museum-one" }), 1);

    expect(day.items.map((item) => item.id)).toEqual(["cafe-one", "dinner-one"]);
    expect(day.items.map((item) => item.order)).toEqual([0, 1]);
  });

  it("re-derives the day total from what remains", () => {
    // €94 less the museum's €20.
    expect(dayOf(remove({ itemId: "museum-one" }), 1).dayTotal).toBe(74);
  });

  it("leaves the other days alone", () => {
    const result = remove({ itemId: "museum-one" });
    if (result.status === "failed") throw new Error("expected success");

    const before = fixtureSavedPlan().days[1];
    const after = result.plan.days[1];
    expect(after.items.map((item) => item.id)).toEqual(
      before.items.map((item) => item.id),
    );
    expect(after.dayTotal).toBe(before.dayTotal);
  });

  it("does not re-time anything: the gap simply closes", () => {
    const day = dayOf(remove({ itemId: "museum-one" }), 1);
    expect(day.items[0].startTime).toBe("09:00");
    expect(day.items[1].startTime).toBe("19:30");
  });

  it("removes a placeless rest block, which has no meal to lose", () => {
    expect(
      dayOf(remove({ dayNumber: 2, itemId: "afternoon-open" }), 2).items.map(
        (item) => item.id,
      ),
    ).toEqual(["cafe-two", "museum-two", "dinner-two"]);
  });

  it("refuses to leave a day with nothing in it", () => {
    expect(remove({ plan: planWithLoneStop(), itemId: "museum-one" })).toMatchObject({
      status: "failed",
      errors: [{ code: "day_would_be_empty" }],
    });
  });

  /**
   * A meal may be swapped but not silently dropped — the invariant `validateSchedule` has enforced
   * since Phase 6A. Checked in the applier as well, so the message names the meal rather than
   * talking about refinements to somebody who pressed Remove.
   */
  it("refuses the day's only stop of a meal type, and says which", () => {
    const breakfast = remove({ itemId: "cafe-one" });
    expect(breakfast.status).toBe("failed");
    if (breakfast.status !== "failed") return;
    expect(breakfast.errors[0].code).toBe("schedule_invalid");
    expect(breakfast.errors[0].message).toContain("breakfast");

    expect(remove({ itemId: "dinner-one" })).toMatchObject({
      status: "failed",
      errors: [{ code: "schedule_invalid" }],
    });
  });

  it("allows a meal when another stop covers the same type", () => {
    // Give day one a second breakfast, and the first becomes removable.
    const plan = planWith("museum-one", { mealType: "breakfast" });
    expect(remove({ plan, itemId: "cafe-one" }).status).not.toBe("failed");
  });

  it("refuses a locked stop, and a date-fixed one, with different codes", () => {
    expect(
      remove({ plan: planWith("museum-one", { locked: true }), itemId: "museum-one" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "item_locked" }] });

    expect(
      remove({
        plan: planWith("museum-one", { kind: "logistics" }),
        itemId: "museum-one",
      }),
    ).toMatchObject({
      status: "failed",
      errors: [{ code: "item_structurally_locked" }],
    });
  });

  it("refuses a day or a stop that is not part of the trip", () => {
    expect(remove({ dayNumber: 9, itemId: "museum-one" })).toMatchObject({
      status: "failed",
      errors: [{ code: "day_not_found" }],
    });
    expect(remove({ itemId: "ghost" })).toMatchObject({
      status: "failed",
      errors: [{ code: "item_not_found" }],
    });
  });

  /**
   * A removal only ever *reduces* the set of attached places, so the invariant has strictly less to
   * check afterwards. This is the one edit that cannot introduce a place.
   */
  it("keeps the pool invariant, and detaches the place", () => {
    const result = remove({ itemId: "museum-one" });
    if (result.status === "failed") throw new Error("expected success");

    expect(
      validatePlanMembership({
        plan: result.plan,
        generation: result.generationContext,
      }),
    ).toEqual([]);

    const attached = result.plan.days
      .flatMap((day) => day.items)
      .map((item) => item.place?.placeId);
    expect(attached).not.toContain("osm:node:2001");
  });

  it("clears the leg that pointed at the removed place", () => {
    // The fixture routes day one's first leg, `cafe-one` → `museum-one`.
    const result = remove({ plan: fixtureRoutedPlan(), itemId: "museum-one" });
    if (result.status === "failed") throw new Error("expected success");

    expect(result.summary.invalidatedLegIds).toHaveLength(1);
    expect(result.plan.days[0].items[0].travelToNext).toBeNull();
  });

  it("reports the removal on the day it happened", () => {
    const result = remove({ itemId: "museum-one" });
    if (result.status === "failed") throw new Error("expected success");

    expect(result.summary.action).toBe("remove-item");
    expect(result.summary.removedItemIds).toEqual(["museum-one"]);
    expect(result.summary.addedItemIds).toEqual([]);
    expect(result.summary.affectedDays).toEqual([1]);
    expect(result.summary.revisionBefore).toBe(3);
  });
});

/**
 * The predicate exists so the control can be hidden rather than offered and then refused. These
 * assertions are the agreement between the two — if they diverge, the button starts lying.
 */
describe("itemIsRemovable", () => {
  it("agrees with the applier on every refusal", () => {
    const dayOne = fixtureSavedPlan().days[0];
    const [cafe, museum, dinner] = dayOne.items;

    expect(itemIsRemovable(dayOne, museum)).toBe(true);
    // Sole breakfast, sole dinner.
    expect(itemIsRemovable(dayOne, cafe)).toBe(false);
    expect(itemIsRemovable(dayOne, dinner)).toBe(false);
    // Both locks.
    expect(itemIsRemovable(dayOne, { ...museum, locked: true })).toBe(false);
    expect(itemIsRemovable(dayOne, { ...museum, kind: "transport" })).toBe(false);
    // The day's last stop.
    expect(itemIsRemovable({ ...dayOne, items: [museum] }, museum)).toBe(false);
  });

  it("allows the placeless rest block on day two", () => {
    const dayTwo = fixtureSavedPlan().days[1];
    const rest = dayTwo.items.find((item) => item.id === "afternoon-open");
    expect(rest).toBeDefined();
    if (!rest) return;
    expect(itemIsRemovable(dayTwo, rest)).toBe(true);
  });
});
