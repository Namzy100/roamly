import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureRoutedPlan,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { ItineraryItem, TripPlan } from "@/lib/schemas";

import {
  isEditLocked,
  isStructurallyLocked,
  isTravellerLocked,
  lockRefusalFor,
  supportsTravellerLock,
} from "./locks";
import { applySetItemLock } from "./set-lock";
import type { StructuralEditResult } from "./types";

/**
 * Two locks that must never be confused.
 *
 * A `transport` or `logistics` block is fixed by the trip's **dates**, and no traveller preference
 * may release it. `item.locked` is the traveller's own pin, theirs to set and clear. Most of what
 * follows is about keeping those two answers apart — the bug this module exists to prevent is
 * `unlock-item` freeing the airport transfer.
 */

const TIMEZONE = "Europe/Lisbon";

function itemFrom(patch: Partial<ItineraryItem> = {}): ItineraryItem {
  return { ...fixtureSavedPlan().days[0].items[1], ...patch };
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

function setLock(input: {
  plan?: TripPlan;
  dayNumber?: number;
  itemId: string;
  type: "lock-item" | "unlock-item";
}): StructuralEditResult {
  return applySetItemLock({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: input.type,
      dayNumber: input.dayNumber ?? 1,
      itemId: input.itemId,
    },
  });
}

function itemIn(result: StructuralEditResult, itemId: string): ItineraryItem {
  if (result.status === "failed") throw new Error("expected the edit to succeed");
  const found = result.plan.days
    .flatMap((day) => day.items)
    .find((item) => item.id === itemId);
  if (!found) throw new Error(`no item ${itemId}`);
  return found;
}

describe("the lock predicates", () => {
  it("treats the date-fixed kinds as structurally locked, and nothing else", () => {
    expect(isStructurallyLocked(itemFrom({ kind: "transport" }))).toBe(true);
    expect(isStructurallyLocked(itemFrom({ kind: "logistics" }))).toBe(true);

    for (const kind of [
      "meal",
      "attraction",
      "experience",
      "viewpoint",
      "rest",
    ] as const) {
      expect(isStructurallyLocked(itemFrom({ kind })), kind).toBe(false);
    }
  });

  it("reads the traveller's pin from the field, independently of kind", () => {
    expect(isTravellerLocked(itemFrom({ locked: false }))).toBe(false);
    expect(isTravellerLocked(itemFrom({ locked: true }))).toBe(true);
    // A date-fixed block is not *traveller*-locked merely by being fixed.
    expect(isTravellerLocked(itemFrom({ kind: "transport", locked: false }))).toBe(
      false,
    );
  });

  it("refuses an edit when either lock applies", () => {
    expect(isEditLocked(itemFrom())).toBe(false);
    expect(isEditLocked(itemFrom({ locked: true }))).toBe(true);
    expect(isEditLocked(itemFrom({ kind: "transport" }))).toBe(true);
    expect(isEditLocked(itemFrom({ kind: "logistics", locked: true }))).toBe(true);
  });

  /**
   * When a stop is both, the structural reason wins — it is the one the traveller can do nothing
   * about, and "unlock it first" would be advice leading nowhere.
   */
  it("names the structural reason first when a stop is both", () => {
    const refusal = lockRefusalFor(itemFrom({ kind: "transport", locked: true }));
    expect(refusal?.code).toBe("item_structurally_locked");
    expect(refusal?.message).not.toContain("Unlock");
  });

  it("names the traveller's lock when that is the only one", () => {
    const refusal = lockRefusalFor(itemFrom({ locked: true }));
    expect(refusal?.code).toBe("item_locked");
    expect(refusal?.message).toContain("Unlock");
  });

  it("returns nothing at all for an editable stop", () => {
    expect(lockRefusalFor(itemFrom())).toBeNull();
  });

  it("offers the padlock only where it could be released", () => {
    expect(supportsTravellerLock(itemFrom())).toBe(true);
    expect(supportsTravellerLock(itemFrom({ locked: true }))).toBe(true);
    expect(supportsTravellerLock(itemFrom({ kind: "transport" }))).toBe(false);
    expect(supportsTravellerLock(itemFrom({ kind: "logistics" }))).toBe(false);
  });
});

describe("applySetItemLock", () => {
  it("sets the pin", () => {
    expect(
      itemIn(setLock({ itemId: "museum-one", type: "lock-item" }), "museum-one")
        .locked,
    ).toBe(true);
  });

  it("clears the pin", () => {
    const result = setLock({
      plan: planWith("museum-one", { locked: true }),
      itemId: "museum-one",
      type: "unlock-item",
    });
    expect(itemIn(result, "museum-one").locked).toBe(false);
  });

  /**
   * The reason `buildSummary` compares `locked` at all.
   *
   * A lock changes nothing else about the plan, so without that comparison the summary would report
   * zero changed stops and the undo entry would carry a label it could not evidence.
   */
  it("reports the stop as changed, even though nothing else moved", () => {
    const result = setLock({ itemId: "museum-one", type: "lock-item" });
    if (result.status === "failed") throw new Error("expected success");

    expect(result.summary.action).toBe("lock-item");
    expect(result.summary.changedItemIds).toEqual(["museum-one"]);
    expect(result.summary.addedItemIds).toEqual([]);
    expect(result.summary.removedItemIds).toEqual([]);
    expect(result.summary.affectedDays).toEqual([1]);
  });

  it("moves no time, no money and no route", () => {
    const before = fixtureSavedPlan();
    const result = setLock({
      plan: fixtureRoutedPlan(),
      itemId: "museum-one",
      type: "lock-item",
    });
    if (result.status === "failed") throw new Error("expected success");

    const item = itemIn(result, "museum-one");
    expect(item.startTime).toBe("10:30");
    expect(item.endTime).toBe("12:30");
    expect(item.estimatedCost).toBe(before.days[0].items[1].estimatedCost);
    expect(result.plan.days[0].dayTotal).toBe(before.days[0].dayTotal);
    expect(result.summary.invalidatedLegIds).toEqual([]);
    expect(result.summary.addedLegIds).toEqual([]);
  });

  /**
   * Two commands rather than one carrying a boolean, so a stale interface cannot silently agree with
   * a state it did not know about.
   */
  it("refuses to lock what is already locked, or unlock what is not", () => {
    expect(
      setLock({
        plan: planWith("museum-one", { locked: true }),
        itemId: "museum-one",
        type: "lock-item",
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "already_locked" }] });

    expect(setLock({ itemId: "museum-one", type: "unlock-item" })).toMatchObject({
      status: "failed",
      errors: [{ code: "not_locked" }],
    });
  });

  /**
   * The refusal that matters most: a padlock on the airport transfer would imply a freedom that does
   * not exist, and an unlock beside it would imply one that could never be granted.
   */
  it("refuses a date-fixed block in both directions", () => {
    for (const type of ["lock-item", "unlock-item"] as const) {
      const result = setLock({
        plan: planWith("museum-one", { kind: "transport" }),
        itemId: "museum-one",
        type,
      });

      expect(result.status, type).toBe("failed");
      if (result.status !== "failed") continue;
      expect(result.errors[0].code, type).toBe("item_structurally_locked");
    }
  });

  it("refuses a day or a stop that is not part of the trip", () => {
    expect(
      setLock({ dayNumber: 9, itemId: "museum-one", type: "lock-item" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "day_not_found" }] });

    expect(setLock({ itemId: "ghost", type: "lock-item" })).toMatchObject({
      status: "failed",
      errors: [{ code: "item_not_found" }],
    });
  });

  it("does not mutate the plan it was given", () => {
    const plan = fixtureSavedPlan();
    setLock({ plan, itemId: "museum-one", type: "lock-item" });
    expect(plan.days[0].items[1].locked).toBe(false);
  });
});
