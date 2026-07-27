import { describe, expect, it } from "vitest";

import { FIXTURE_PLACES, cost } from "@/lib/generate/test-fixtures";
import { TripPlanSchema } from "@/lib/schemas";

import { applyDayAdjustment } from "./adjust-day";
import type { ReplaceItemResult } from "./schemas";
import {
  applyBackupReplacement,
  applyBackupUnavailable,
} from "./replace-backup";
import {
  RefinementBuildError,
  applyItemReplacement,
  applyItemUnavailable,
  nextItemId,
} from "./replace-item";
import { fixtureSavedPlan } from "./test-fixtures";

/**
 * The immutable appliers.
 *
 * The recurring assertion is **reference equality** on untouched items. Deep equality
 * would pass for a rebuilt-but-identical object, and rebuilding everything is exactly
 * the drift worth catching: it would silently change item identity, which would silently
 * invalidate routes that did not need invalidating.
 */

const SELECTED: Extract<ReplaceItemResult, { status: "selected" }> = {
  status: "selected",
  placeId: FIXTURE_PLACES.cafeTwo.placeId,
  description:
    "Chosen because it is a short walk from the day's other stops and serves the same purpose in the morning.",
  estimatedCost: cost(16),
  reservationRecommended: false,
};

describe("applyItemReplacement", () => {
  function replaceFirstStop(overrides: Partial<typeof SELECTED> = {}) {
    const plan = fixtureSavedPlan();
    const target = plan.days[0].items[0];

    return {
      plan,
      target,
      outcome: applyItemReplacement({
        plan,
        dayNumber: 1,
        itemId: target.id,
        chosen: FIXTURE_PLACES.cafeTwo,
        result: { ...SELECTED, ...overrides },
      }),
    };
  }

  it("attaches the canonical record, not the model's idea of it", () => {
    const { outcome } = replaceFirstStop();
    const replaced = outcome.plan.days[0].items[0];

    expect(replaced.place).toEqual(FIXTURE_PLACES.cafeTwo);
  });

  it("keeps every other item as the same object", () => {
    const { plan, outcome } = replaceFirstStop();

    for (let index = 1; index < plan.days[0].items.length; index += 1) {
      expect(outcome.plan.days[0].items[index]).toBe(plan.days[0].items[index]);
    }
  });

  it("keeps every other day as the same object", () => {
    const { plan, outcome } = replaceFirstStop();

    expect(outcome.plan.days[1]).toBe(plan.days[1]);
  });

  /**
   * A new id, deliberately. Reusing the old one would keep the leg ids stable and let
   * routes for the *previous* place survive re-keying — real geometry on a journey
   * nobody makes.
   */
  it("gives the replacement a new, deterministic item id", () => {
    const { target, outcome } = replaceFirstStop();
    const replaced = outcome.plan.days[0].items[0];

    expect(replaced.id).not.toBe(target.id);
    expect(replaced.id).toBe(`${target.id}-r1`);
    expect(replaced.id).not.toContain(":");
  });

  it("drops the replaced stop's outgoing segment", () => {
    const { outcome } = replaceFirstStop();

    expect(outcome.plan.days[0].items[0].travelToNext).toBeNull();
  });

  it("keeps the original time window unless the model moved it", () => {
    const { target, outcome } = replaceFirstStop();
    const replaced = outcome.plan.days[0].items[0];

    expect(replaced.startTime).toBe(target.startTime);
    expect(replaced.endTime).toBe(target.endTime);
  });

  it("takes a new window when the model supplies one", () => {
    const { outcome } = replaceFirstStop({
      startTime: "11:00",
      endTime: "12:00",
    });
    // Sorting is the day builder's job, so find by place rather than by index.
    const replaced = outcome.plan.days[0].items.find(
      (item) => item.place?.placeId === FIXTURE_PLACES.cafeTwo.placeId,
    );

    expect(replaced?.startTime).toBe("11:00");
    expect(replaced?.endTime).toBe("12:00");
  });

  it("clamps an absurd estimate and warns", () => {
    const { outcome } = replaceFirstStop({ estimatedCost: cost(5_000) });
    const replaced = outcome.plan.days[0].items[0];

    expect(replaced.estimatedCost).toBeLessThan(100);
    expect(outcome.warnings.map((warning) => warning.code)).toContain(
      "cost_clamped",
    );
  });

  it("recomputes the day and budget totals", () => {
    const { outcome } = replaceFirstStop();
    const day = outcome.plan.days[0];

    const summed =
      Math.round(
        day.items.reduce((total, item) => total + item.estimatedCost, 0) * 100,
      ) / 100;
    expect(day.dayTotal).toBe(summed);

    const categories =
      outcome.plan.budget.flights +
      outcome.plan.budget.accommodation +
      outcome.plan.budget.food +
      outcome.plan.budget.activities +
      outcome.plan.budget.transport;
    expect(outcome.plan.budget.total).toBeCloseTo(
      Math.round(categories * 100) / 100,
      2,
    );
  });

  it("keeps a meal's heading and takes the place name otherwise", () => {
    const { target, outcome } = replaceFirstStop();
    // Day one's first stop is a meal, so the heading it already had stays — "Lunch"
    // is the right title whichever restaurant fills it.
    expect(outcome.plan.days[0].items[0].title).toBe(target.title);

    const plan = fixtureSavedPlan();
    const museum = plan.days[0].items[1];
    const swapped = applyItemReplacement({
      plan,
      dayNumber: 1,
      itemId: museum.id,
      chosen: FIXTURE_PLACES.museumTwo,
      result: { ...SELECTED, placeId: FIXTURE_PLACES.museumTwo.placeId },
    });

    expect(swapped.plan.days[0].items[1].title).toBe(FIXTURE_PLACES.museumTwo.name);
  });

  it("produces a schema-valid plan", () => {
    const { outcome } = replaceFirstStop();

    expect(TripPlanSchema.safeParse(outcome.plan).success).toBe(true);
  });

  it("does not mutate the source plan", () => {
    const plan = fixtureSavedPlan();
    const snapshot = JSON.stringify(plan);

    applyItemReplacement({
      plan,
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
      chosen: FIXTURE_PLACES.cafeTwo,
      result: SELECTED,
    });

    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("throws for a day or item that is not there", () => {
    const plan = fixtureSavedPlan();

    expect(() =>
      applyItemReplacement({
        plan,
        dayNumber: 5,
        itemId: plan.days[0].items[0].id,
        chosen: FIXTURE_PLACES.cafeTwo,
        result: SELECTED,
      }),
    ).toThrow(RefinementBuildError);

    expect(() =>
      applyItemReplacement({
        plan,
        dayNumber: 1,
        itemId: "not-a-real-item",
        chosen: FIXTURE_PLACES.cafeTwo,
        result: SELECTED,
      }),
    ).toThrow(RefinementBuildError);
  });
});

describe("applyItemUnavailable", () => {
  it("keeps the slot visible with no place and no cost", () => {
    const plan = fixtureSavedPlan();
    const target = plan.days[0].items[1];

    const outcome = applyItemUnavailable({
      plan,
      dayNumber: 1,
      itemId: target.id,
      reason: "No other museum was found within a workable distance of this day.",
    });

    const gap = outcome.plan.days[0].items[1];
    expect(gap.status).toBe("unavailable");
    expect(gap.place).toBeNull();
    expect(gap.estimatedCost).toBe(0);
    expect(gap.costEstimate).toBeUndefined();
    expect(gap.rationale).toContain("No other museum");
    expect(gap.title).toContain("no alternative found");
  });

  it("keeps its id, so a gap is the same slot rather than a new one", () => {
    const plan = fixtureSavedPlan();
    const target = plan.days[0].items[1];

    const outcome = applyItemUnavailable({
      plan,
      dayNumber: 1,
      itemId: target.id,
      reason: "Nothing eligible was available for this slot.",
    });

    expect(outcome.plan.days[0].items[1].id).toBe(target.id);
  });

  it("produces a schema-valid plan and warns", () => {
    const plan = fixtureSavedPlan();
    const outcome = applyItemUnavailable({
      plan,
      dayNumber: 1,
      itemId: plan.days[0].items[1].id,
      reason: "Nothing eligible was available for this slot.",
    });

    expect(TripPlanSchema.safeParse(outcome.plan).success).toBe(true);
    expect(outcome.warnings.map((warning) => warning.code)).toContain(
      "replacement_unavailable",
    );
  });
});

describe("nextItemId", () => {
  it("is deterministic and collision-free", () => {
    const plan = fixtureSavedPlan();
    const base = plan.days[0].items[0].id;

    expect(nextItemId(plan, base)).toBe(`${base}-r1`);
    expect(nextItemId(plan, base)).toBe(`${base}-r1`);
  });

  it("does not stack suffixes on a repeatedly replaced stop", () => {
    const plan = fixtureSavedPlan();

    expect(nextItemId(plan, "cafe-one-r3")).toBe("cafe-one-r1");
  });

  it("climbs past an id already in use", () => {
    const plan = fixtureSavedPlan();
    const taken = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              items: day.items.map((item, itemIndex) =>
                itemIndex === 2 ? { ...item, id: `${day.items[0].id}-r1` } : item,
              ),
            }
          : day,
      ),
    };

    expect(nextItemId(taken, taken.days[0].items[0].id)).toBe(
      `${taken.days[0].items[0].id}-r2`,
    );
  });
});

describe("applyBackupReplacement", () => {
  it("attaches the canonical record and the canonical name", () => {
    const plan = fixtureSavedPlan();
    const backup = plan.days[0].backups[0];

    const outcome = applyBackupReplacement({
      plan,
      dayNumber: 1,
      backupId: backup.id,
      chosen: FIXTURE_PLACES.museumOne,
      result: {
        status: "selected",
        placeId: FIXTURE_PLACES.museumOne.placeId,
        reason: "Indoors and a short walk away if the first choice is closed.",
      },
    });

    const replaced = outcome.plan.days[0].backups[0];
    expect(replaced.place).toEqual(FIXTURE_PLACES.museumOne);
    expect(replaced.title).toBe(FIXTURE_PLACES.museumOne.name);
    expect(replaced.id).toBe(backup.id);
  });

  /**
   * The property that makes backups cheap: they have no adjacency, so replacing one
   * cannot touch routing. Routing an unused backup would multiply provider traffic for
   * places nobody has decided to visit.
   */
  it("changes no item, no segment and no total", () => {
    const plan = fixtureSavedPlan();

    const outcome = applyBackupReplacement({
      plan,
      dayNumber: 1,
      backupId: plan.days[0].backups[0].id,
      chosen: FIXTURE_PLACES.museumOne,
      result: {
        status: "selected",
        placeId: FIXTURE_PLACES.museumOne.placeId,
        reason: "A nearby alternative of the same kind.",
      },
    });

    expect(outcome.plan.days[0].items).toBe(plan.days[0].items);
    expect(outcome.plan.days[0].dayTotal).toBe(plan.days[0].dayTotal);
    expect(outcome.plan.budget).toBe(plan.budget);
    expect(outcome.plan.days[1]).toBe(plan.days[1]);
  });

  it("drops a backup with no alternative, and says so", () => {
    const plan = fixtureSavedPlan();
    const backupId = plan.days[0].backups[0].id;

    const outcome = applyBackupUnavailable({
      plan,
      dayNumber: 1,
      backupId,
      reason: "The search returned no other museum nearby.",
    });

    expect(outcome.plan.days[0].backups).toHaveLength(
      plan.days[0].backups.length - 1,
    );
    expect(outcome.warnings.map((warning) => warning.code)).toContain(
      "backup_unavailable",
    );
    expect(TripPlanSchema.safeParse(outcome.plan).success).toBe(true);
  });

  it("throws for a backup that is not there", () => {
    const plan = fixtureSavedPlan();

    expect(() =>
      applyBackupUnavailable({
        plan,
        dayNumber: 1,
        backupId: "not-a-backup",
        reason: "x".repeat(20),
      }),
    ).toThrow(RefinementBuildError);
  });

  it("does not mutate the source plan", () => {
    const plan = fixtureSavedPlan();
    const snapshot = JSON.stringify(plan);

    applyBackupReplacement({
      plan,
      dayNumber: 1,
      backupId: plan.days[0].backups[0].id,
      chosen: FIXTURE_PLACES.museumOne,
      result: {
        status: "selected",
        placeId: FIXTURE_PLACES.museumOne.placeId,
        reason: "A nearby alternative of the same kind.",
      },
    });

    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

describe("applyDayAdjustment", () => {
  function adjust(items: unknown[]) {
    const plan = fixtureSavedPlan();
    const canonicalByPlaceId = new Map(
      Object.values(FIXTURE_PLACES).map((place) => [place.placeId, place]),
    );

    return {
      plan,
      outcome: applyDayAdjustment({
        plan,
        dayNumber: 1,
        result: {
          status: "adjusted",
          dayNumber: 1,
          summary:
            "A shorter day, with the afternoon left open and the two meals kept where they were.",
          items: items as never,
          backups: [],
        },
        canonicalByPlaceId,
      }),
    };
  }

  const CAFE_ITEM = {
    kind: "place" as const,
    itemId: "breakfast-kept",
    placeId: FIXTURE_PLACES.cafeOne.placeId,
    category: "cafe" as const,
    mealType: "breakfast" as const,
    startTime: "09:00",
    endTime: "10:00",
    title: "Breakfast",
    description: "Kept where it was, a short walk from the base area.",
    estimatedCost: cost(14),
    reservationRecommended: false,
  };

  const DINNER_ITEM = {
    kind: "place" as const,
    itemId: "dinner-kept",
    placeId: FIXTURE_PLACES.restaurantOne.placeId,
    category: "restaurant" as const,
    mealType: "dinner" as const,
    startTime: "19:30",
    endTime: "21:00",
    title: "Dinner",
    description: "Kept where it was, since the evening did not need changing.",
    estimatedCost: cost(60),
    reservationRecommended: true,
  };

  it("attaches canonical records and derives kind from the canonical category", () => {
    const { outcome } = adjust([CAFE_ITEM, DINNER_ITEM]);
    const day = outcome.plan.days[0];

    expect(day.items).toHaveLength(2);
    expect(day.items[0].place).toEqual(FIXTURE_PLACES.cafeOne);
    expect(day.items[0].kind).toBe("meal");
  });

  it("orders chronologically and numbers from zero", () => {
    const { outcome } = adjust([DINNER_ITEM, CAFE_ITEM]);
    const day = outcome.plan.days[0];

    expect(day.items.map((item) => item.startTime)).toEqual(["09:00", "19:30"]);
    expect(day.items.map((item) => item.order)).toEqual([0, 1]);
  });

  it("keeps a retained stop's id, so its routes are not invalidated needlessly", () => {
    const { outcome } = adjust([CAFE_ITEM, DINNER_ITEM]);

    expect(outcome.plan.days[0].items[0].id).toBe("breakfast-kept");
  });

  it("adds free time with no place, no marker and no cost", () => {
    const { outcome } = adjust([
      CAFE_ITEM,
      {
        kind: "non-place",
        itemId: "open-afternoon",
        category: "free-time",
        startTime: "13:00",
        endTime: "16:00",
        title: "Unscheduled afternoon",
        description:
          "Left open on purpose, so the day has somewhere for a long lunch to go.",
        estimatedCost: cost(40),
      },
      DINNER_ITEM,
    ]);

    const free = outcome.plan.days[0].items.find(
      (item) => item.id === "open-afternoon",
    );
    expect(free?.place).toBeNull();
    expect(free?.kind).toBe("rest");
    // Free time is free, whatever the model proposed.
    expect(free?.estimatedCost).toBe(0);
  });

  it("keeps an accommodation block at zero so the stay is not counted twice", () => {
    const { outcome } = adjust([
      CAFE_ITEM,
      {
        kind: "non-place",
        itemId: "check-in",
        category: "accommodation",
        startTime: "15:00",
        endTime: "15:30",
        title: "Check in",
        description: "Drop bags and take half an hour before heading back out.",
        estimatedCost: cost(180),
      },
      DINNER_ITEM,
    ]);

    expect(
      outcome.plan.days[0].items.find((item) => item.id === "check-in")
        ?.estimatedCost,
    ).toBe(0);
  });

  it("clamps a proposed estimate and warns", () => {
    const { outcome } = adjust([
      { ...CAFE_ITEM, estimatedCost: cost(9_000) },
      DINNER_ITEM,
    ]);

    expect(outcome.plan.days[0].items[0].estimatedCost).toBeLessThan(100);
    expect(outcome.warnings.map((warning) => warning.code)).toContain(
      "cost_clamped",
    );
  });

  it("leaves every other day as the same object", () => {
    const { plan, outcome } = adjust([CAFE_ITEM, DINNER_ITEM]);

    expect(outcome.plan.days[1]).toBe(plan.days[1]);
  });

  it("recomputes the day total and produces a valid plan", () => {
    const { outcome } = adjust([CAFE_ITEM, DINNER_ITEM]);
    const day = outcome.plan.days[0];

    const summed =
      Math.round(
        day.items.reduce((total, item) => total + item.estimatedCost, 0) * 100,
      ) / 100;
    expect(day.dayTotal).toBe(summed);
    expect(TripPlanSchema.safeParse(outcome.plan).success).toBe(true);
  });

  it("throws when a placeId has no canonical record", () => {
    const plan = fixtureSavedPlan();

    expect(() =>
      applyDayAdjustment({
        plan,
        dayNumber: 1,
        result: {
          status: "adjusted",
          dayNumber: 1,
          summary: "A day built around a place that does not exist in the pool.",
          items: [{ ...CAFE_ITEM, placeId: "osm:node:999999" }] as never,
          backups: [],
        },
        canonicalByPlaceId: new Map(),
      }),
    ).toThrow(RefinementBuildError);
  });

  it("does not mutate the source plan", () => {
    const plan = fixtureSavedPlan();
    const snapshot = JSON.stringify(plan);

    adjust([CAFE_ITEM, DINNER_ITEM]);
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});
