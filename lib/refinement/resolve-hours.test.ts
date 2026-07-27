import { describe, expect, it } from "vitest";

import { buildScheduleAccuracyReport } from "@/lib/plan";
import type { TripPlan } from "@/lib/schemas";

import {
  applyHoursAdjustTime,
  applyHoursMarkUnavailable,
  applyHoursReplacePlace,
  hoursConflictCandidates,
  itemHasHoursConflict,
} from "./resolve-hours";
import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  FIXTURE_SPARE_CAFE,
  fixtureSavedPlan,
  generationWithSpare,
  withPlaceHours,
} from "./test-fixtures";

/**
 * The fixture trip is Lisbon, Saturday 2026-09-12 to Sunday the 13th, and its café is
 * scheduled 09:00–10:00 on day 1. Giving that café hours that open later creates a
 * repairable conflict; giving it weekday-only hours creates one that cannot be repaired by
 * moving the clock, because the whole trip is a weekend.
 */

const TIMEZONE = "Europe/Lisbon";
const CAFE = FIXTURE_PLACES.cafeOne.placeId;

/**
 * The fixture itinerary consumes all seven of the shared pool's places, so a swap needs a
 * pool with one spare — `generationWithSpare()` supplies it, as a café, which is why the
 * replacement tests conflict the café rather than anything else.
 */
const SPARE_CAFE = FIXTURE_SPARE_CAFE.placeId;

/** The plan's item id for a place, which `assembleTripPlan` decides. */
function itemIdFor(plan: TripPlan, placeId: string): string {
  for (const day of plan.days) {
    for (const item of day.items) {
      if (item.place?.placeId === placeId) return item.id;
    }
  }
  throw new Error(`fixture plan has no item for ${placeId}`);
}

function itemById(plan: TripPlan, dayNumber: number, itemId: string) {
  return plan.days
    .find((day) => day.dayNumber === dayNumber)
    ?.items.find((item) => item.id === itemId);
}

function conflictedPlan(hours = "Mo-Su 11:00-19:00") {
  const plan = withPlaceHours(fixtureSavedPlan(), CAFE, hours);
  return { plan, itemId: itemIdFor(plan, CAFE) };
}

describe("itemHasHoursConflict", () => {
  it("is true for a stop the published hours do not cover", () => {
    const { plan, itemId } = conflictedPlan();

    expect(
      itemHasHoursConflict({ plan, dayNumber: 1, itemId, timezone: TIMEZONE }),
    ).toBe(true);
  });

  it("is false for a stop inside its hours", () => {
    const plan = fixtureSavedPlan();
    const itemId = itemIdFor(plan, CAFE);

    expect(
      itemHasHoursConflict({ plan, dayNumber: 1, itemId, timezone: TIMEZONE }),
    ).toBe(false);
  });

  /**
   * The repair controls must not appear on evidence we do not have. Without a timezone
   * there is no claim to make, so there is nothing to offer to fix.
   */
  it("is false without a timezone, whatever the hours say", () => {
    const { plan, itemId } = conflictedPlan();

    expect(
      itemHasHoursConflict({ plan, dayNumber: 1, itemId, timezone: null }),
    ).toBe(false);
  });

  it("is false for a stop that does not exist", () => {
    const plan = fixtureSavedPlan();

    expect(
      itemHasHoursConflict({ plan, dayNumber: 1, itemId: "nope", timezone: TIMEZONE }),
    ).toBe(false);
    expect(
      itemHasHoursConflict({ plan, dayNumber: 99, itemId: "nope", timezone: TIMEZONE }),
    ).toBe(false);
  });
});

describe("applyHoursAdjustTime", () => {
  it("moves the stop into its published hours and clears the conflict", () => {
    const { plan, itemId } = conflictedPlan();

    const result = applyHoursAdjustTime({
      plan,
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = buildScheduleAccuracyReport({
      plan: result.plan,
      timezone: TIMEZONE,
    });
    expect(report.conflicts.map((conflict) => conflict.itemId)).not.toContain(itemId);
    expect(result.message).toContain("11:00");
  });

  it("keeps the place and the visit's length", () => {
    const { plan, itemId } = conflictedPlan();
    const before = itemById(plan, 1, itemId);

    const result = applyHoursAdjustTime({
      plan,
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = itemById(result.plan, 1, itemId);
    expect(after?.place?.placeId).toBe(before?.place?.placeId);
    expect(minutes(after!.endTime) - minutes(after!.startTime)).toBe(
      minutes(before!.endTime) - minutes(before!.startTime),
    );
  });

  /**
   * `09:15-19:00` keeps the café first, so nothing else changes position and every other
   * stop can be checked with `===` — a far stronger claim than deep equality, and one that
   * fails loudly if some future edit starts rebuilding untouched items.
   */
  it("leaves every other stop as the same object when the sequence is unchanged", () => {
    const { plan, itemId } = conflictedPlan("Mo-Su 09:15-19:00");

    const result = applyHoursAdjustTime({
      plan,
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(itemById(result.plan, 1, itemId)?.startTime).toBe("09:15");
    for (const before of plan.days[0].items) {
      if (before.id === itemId) continue;
      expect(itemById(result.plan, 1, before.id)).toBe(before);
    }
    // And every other day is the day it was.
    expect(result.plan.days[1]).toBe(plan.days[1]);
  });

  /**
   * When the move *does* reorder the day, `order` has to follow — it is what the cards and
   * the routing legs are built from. Nothing else about an unrelated stop may change.
   */
  it("changes only order on the stops a reordering move passes", () => {
    const { plan, itemId } = conflictedPlan();

    const result = applyHoursAdjustTime({
      plan,
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const before of plan.days[0].items) {
      if (before.id === itemId) continue;
      const after = itemById(result.plan, 1, before.id);
      expect({ ...after, order: 0 }).toEqual({ ...before, order: 0 });
    }
    expect(result.plan.days[1]).toBe(plan.days[1]);
  });

  it("refuses without a timezone, and returns the error alone", () => {
    const { plan, itemId } = conflictedPlan();

    const result = applyHoursAdjustTime({
      plan,
      dayNumber: 1,
      itemId,
      timezone: null,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "hours_unknown" } });
  });

  /**
   * Closed all weekend, and the trip is a weekend. The action refuses and *says which
   * options remain*, rather than moving the stop somewhere it is equally shut.
   */
  it("refuses when the day has no open slot at all", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const result = applyHoursAdjustTime({
      plan,
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "no_open_slot" } });
    if (result.ok) return;
    expect(result.error.message).toContain("Replacing the place");
  });

  it("reports a stop that is not on the day", () => {
    const plan = fixtureSavedPlan();

    expect(
      applyHoursAdjustTime({
        plan,
        dayNumber: 1,
        itemId: "not-a-stop",
        timezone: TIMEZONE,
      }),
    ).toMatchObject({ ok: false, error: { code: "item_not_found" } });
  });
});

describe("applyHoursReplacePlace", () => {

  it("refuses a place that is not in the trip's saved pool", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const result = applyHoursReplacePlace({
      plan,
      generation: FIXTURE_GENERATION,
      dayNumber: 1,
      itemId,
      placeId: "osm:node:999999",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "place_outside_pool" },
    });
  });

  it("refuses when the trip has no saved pool", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    expect(
      applyHoursReplacePlace({
        plan,
        generation: null,
        dayNumber: 1,
        itemId,
        placeId: SPARE_CAFE,
      }),
    ).toMatchObject({ ok: false, error: { code: "pool_unavailable" } });
  });

  it("refuses a place already somewhere in the trip", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    expect(
      applyHoursReplacePlace({
        plan,
        generation: FIXTURE_GENERATION,
        dayNumber: 1,
        itemId,
        placeId: FIXTURE_PLACES.museumOne.placeId,
      }),
    ).toMatchObject({ ok: false, error: { code: "place_already_used" } });
  });

  it("puts a pool place in the slot at the same time", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");
    const before = itemById(plan, 1, itemId);

    const result = applyHoursReplacePlace({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      placeId: SPARE_CAFE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const swapped = result.plan.days[0].items.find(
      (item) => item.place?.placeId === SPARE_CAFE,
    );
    expect(swapped).toBeDefined();
    expect(swapped?.startTime).toBe(before?.startTime);
    expect(swapped?.endTime).toBe(before?.endTime);
    expect(swapped?.mealType).toBe(before?.mealType);
    // The pool's record, attached whole and unmodified.
    expect(swapped?.place).toEqual(FIXTURE_SPARE_CAFE);
  });

  /**
   * A new id, so the routes that measured journeys to the old place cannot survive
   * re-keying and attach real geometry to a journey nobody makes.
   */
  it("gives the replacement a new item id", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const result = applyHoursReplacePlace({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      placeId: SPARE_CAFE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(itemById(result.plan, 1, itemId)).toBeUndefined();
    const swapped = result.plan.days[0].items.find(
      (item) => item.place?.placeId === SPARE_CAFE,
    );
    expect(swapped?.id).not.toBe(itemId);
    expect(swapped?.travelToNext).toBeNull();
  });

  it("leaves every other stop as the same object", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const result = applyHoursReplacePlace({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      placeId: SPARE_CAFE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const before of plan.days[0].items) {
      if (before.id === itemId) continue;
      expect(itemById(result.plan, 1, before.id)).toBe(before);
    }
    expect(result.plan.days[1]).toBe(plan.days[1]);
  });

  /**
   * The traveller chose it. If its hours also clash the report keeps saying so — the
   * action does not second-guess the choice, and it does not hide the consequence.
   */
  it("allows a replacement whose own hours also clash, and still reports it", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const result = applyHoursReplacePlace({
      plan,
      generation: generationWithSpare({ openingHours: "Mo-Fr 09:00-17:00" }),
      dayNumber: 1,
      itemId,
      placeId: SPARE_CAFE,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = buildScheduleAccuracyReport({
      plan: result.plan,
      timezone: TIMEZONE,
    });
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].placeId).toBe(SPARE_CAFE);
  });
});

describe("applyHoursMarkUnavailable", () => {
  it("keeps the slot, drops the place, and says why", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");
    const before = itemById(plan, 1, itemId);

    const result = applyHoursMarkUnavailable({ plan, dayNumber: 1, itemId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = itemById(result.plan, 1, itemId);
    expect(after?.status).toBe("unavailable");
    expect(after?.place).toBeNull();
    expect(after?.startTime).toBe(before?.startTime);
    expect(after?.estimatedCost).toBe(0);
    expect(after?.costEstimate).toBeUndefined();
    expect(after?.rationale).toContain("Fábrica Coffee");
  });

  it("removes the conflict, because there is no longer a place to check", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const result = applyHoursMarkUnavailable({ plan, dayNumber: 1, itemId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(
      buildScheduleAccuracyReport({ plan: result.plan, timezone: TIMEZONE }).conflicts,
    ).toEqual([]);
  });

  it("takes the stop's cost out of the day total and the budget", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");
    const cost = itemById(plan, 1, itemId)!.estimatedCost;
    expect(cost).toBeGreaterThan(0);

    const result = applyHoursMarkUnavailable({ plan, dayNumber: 1, itemId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.days[0].dayTotal).toBeCloseTo(plan.days[0].dayTotal - cost, 2);
    expect(result.plan.budget.total).toBeLessThan(plan.budget.total);
  });

  it("refuses when the slot is already open", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");
    const first = applyHoursMarkUnavailable({ plan, dayNumber: 1, itemId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(
      applyHoursMarkUnavailable({ plan: first.plan, dayNumber: 1, itemId }),
    ).toMatchObject({ ok: false, error: { code: "no_change" } });
  });
});

describe("hoursConflictCandidates", () => {

  it("offers same-category places from the trip's own pool", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const candidates = hoursConflictCandidates({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.category).toBe("cafe");
      expect(
        generationWithSpare().placePool.places.some(
          (place) => place.placeId === candidate.placeId,
        ),
      ).toBe(true);
    }
  });

  it("excludes places already in the trip", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const candidates = hoursConflictCandidates({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });

    expect(candidates.map((place) => place.placeId)).not.toContain(CAFE);
  });

  it("excludes a candidate the hours say is also shut", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const candidates = hoursConflictCandidates({
      plan,
      generation: generationWithSpare({ openingHours: "Mo-Fr 09:00-17:00" }),
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });

    expect(candidates.map((place) => place.placeId)).not.toContain(SPARE_CAFE);
  });

  /**
   * Absence of data is not evidence a place is shut. Excluding unknowns would silently
   * narrow the traveller's choice on no evidence at all.
   */
  it("includes a candidate whose hours are unknown", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const candidates = hoursConflictCandidates({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      timezone: TIMEZONE,
    });

    // The spare café has no `opening_hours` at all.
    expect(candidates.map((place) => place.placeId)).toContain(SPARE_CAFE);
  });

  it("returns nothing without a pool", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    expect(
      hoursConflictCandidates({
        plan,
        generation: null,
        dayNumber: 1,
        itemId,
        timezone: TIMEZONE,
      }),
    ).toEqual([]);
  });

  it("still offers candidates when the timezone is unknown", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    const candidates = hoursConflictCandidates({
      plan,
      generation: generationWithSpare(),
      dayNumber: 1,
      itemId,
      timezone: null,
    });

    // Nothing can be confirmed open or closed, so nothing is filtered out on hours.
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("respects the limit", () => {
    const { plan, itemId } = conflictedPlan("Mo-Fr 09:00-17:00");

    expect(
      hoursConflictCandidates({
        plan,
        generation: generationWithSpare(),
        dayNumber: 1,
        itemId,
        timezone: TIMEZONE,
        limit: 1,
      }),
    ).toHaveLength(1);
  });
});

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}
