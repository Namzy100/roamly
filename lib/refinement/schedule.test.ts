import { describe, expect, it } from "vitest";

import { STOPS_PER_DAY } from "@/lib/generate";
import type { ItineraryItem } from "@/lib/schemas";

import {
  SCHEDULE_LIMITS,
  countStops,
  currentMealTypes,
  validateDayAlignment,
  validateSchedule,
} from "./schedule";
import { fixtureSavedPlan } from "./test-fixtures";

/**
 * The authoritative schedule validator, on a **built** day.
 *
 * Separate from generation's assembly validator on purpose: one is a contract with a
 * provider, this is an invariant of the domain object. Sharing the primitives but not
 * the checks means a change to the contract cannot silently loosen the invariant.
 */

const PLAN = fixtureSavedPlan();

function stop(
  id: string,
  startTime: string,
  endTime: string,
  overrides: Partial<ItineraryItem> = {},
): ItineraryItem {
  const template = PLAN.days[0].items[0];
  return { ...template, id, startTime, endTime, travelToNext: null, ...overrides };
}

function validate(items: ItineraryItem[], pace: "relaxed" | "balanced" | "packed" = "balanced") {
  return validateSchedule({ dayNumber: 1, items, pace });
}

function codes(items: ItineraryItem[], pace?: "relaxed" | "balanced" | "packed") {
  return validate(items, pace).map((violation) => violation.code);
}

describe("validateSchedule", () => {
  it("accepts a well-formed day", () => {
    expect(
      validate([stop("a", "09:00", "10:00"), stop("b", "10:30", "11:30")]),
    ).toEqual([]);
  });

  it("accepts the real generated day it came from", () => {
    expect(
      validateSchedule({
        dayNumber: 1,
        items: PLAN.days[0].items,
        pace: PLAN.request.pace,
      }),
    ).toEqual([]);
  });

  it("rejects an end at or before its start", () => {
    expect(codes([stop("a", "12:00", "09:00")])).toContain("invalid_interval");
    expect(codes([stop("a", "12:00", "12:00")])).toContain("invalid_interval");
  });

  it("rejects a stop too short to be a visit", () => {
    expect(
      codes([stop("a", "09:00", `09:${String(SCHEDULE_LIMITS.minItemMinutes - 5).padStart(2, "0")}`)]),
    ).toContain("too_short");
  });

  /**
   * An unavailable slot's times are a placeholder for "this would have gone about
   * here", so a duration floor would be a rule about nothing.
   */
  it("exempts an unavailable slot from the duration floor", () => {
    const gap = stop("gap", "09:00", "09:05", {
      status: "unavailable",
      place: null,
      estimatedCost: 0,
    });
    delete (gap as { costEstimate?: unknown }).costEstimate;

    expect(codes([gap])).not.toContain("too_short");
  });

  it("rejects overlapping stops", () => {
    expect(
      codes([stop("a", "09:00", "11:00"), stop("b", "10:00", "12:00")]),
    ).toContain("overlap");
  });

  /**
   * Not a routed figure and not presented as one — it is the floor below which the
   * plan is describing teleportation.
   */
  it("rejects two stops with no time to get between them", () => {
    expect(
      codes([stop("a", "09:00", "10:00"), stop("b", "10:00", "11:00")]),
    ).toContain("insufficient_transition");

    expect(
      codes([
        stop("a", "09:00", "10:00"),
        stop(
          "b",
          `10:${String(SCHEDULE_LIMITS.minTransitionMinutes).padStart(2, "0")}`,
          "11:00",
        ),
      ]),
    ).not.toContain("insufficient_transition");
  });

  it("does not require a transition either side of a placeless block", () => {
    const free = stop("free", "10:00", "11:00", { place: null });

    expect(
      codes([stop("a", "09:00", "10:00"), free]),
    ).not.toContain("insufficient_transition");
  });

  it("rejects a day that runs outside its bounds", () => {
    expect(codes([stop("a", "02:00", "03:00")])).toContain("outside_day");
  });

  it("caps stops by pace", () => {
    const many = Array.from({ length: 6 }, (_, index) =>
      stop(`s${index}`, `0${index + 4}:00`.slice(-5), `0${index + 4}:30`.slice(-5)),
    );

    // Six stops is inside a packed day and beyond a relaxed one.
    expect(codes(many, "relaxed")).toContain("stop_cap_exceeded");
    expect(STOPS_PER_DAY.packed.max).toBeGreaterThanOrEqual(6);
  });

  it("does not count an unavailable slot or a free-time block as a stop", () => {
    const gap = stop("gap", "09:00", "10:00", {
      status: "unavailable",
      place: null,
      estimatedCost: 0,
    });
    delete (gap as { costEstimate?: unknown }).costEstimate;
    const free = stop("free", "10:30", "11:30", { place: null });

    expect(countStops([gap, free])).toBe(0);
    expect(countStops([stop("a", "12:00", "13:00"), gap, free])).toBe(1);
  });

  it("reports a lost meal when a baseline is supplied", () => {
    const violations = validateSchedule({
      dayNumber: 1,
      items: [stop("a", "09:00", "10:00", { mealType: null })],
      pace: "balanced",
      requiredMealTypes: ["breakfast"],
    });

    expect(violations.map((violation) => violation.code)).toContain(
      "meal_coverage_lost",
    );
  });

  it("counts an unavailable slot that carries the meal type as coverage", () => {
    const gap = stop("gap", "19:30", "21:00", {
      status: "unavailable",
      place: null,
      estimatedCost: 0,
      mealType: "dinner",
    });
    delete (gap as { costEstimate?: unknown }).costEstimate;

    const violations = validateSchedule({
      dayNumber: 1,
      items: [gap],
      pace: "balanced",
      requiredMealTypes: ["dinner"],
    });

    // "No restaurant was available for dinner" is a visible, honest gap.
    expect(violations.map((violation) => violation.code)).not.toContain(
      "meal_coverage_lost",
    );
  });

  it("does not interpret opening hours", () => {
    // Deliberately absent: OSM's `opening_hours` is retained uninterpreted, so a
    // validator that guessed would turn an unknown into a confident wrong claim.
    const lateStop = stop("late", "22:00", "23:00");

    expect(codes([lateStop])).toEqual([]);
  });
});

describe("currentMealTypes", () => {
  it("lists the meals a day covers, deduplicated and sorted", () => {
    expect(currentMealTypes(PLAN.days[0])).toEqual(["breakfast", "dinner"]);
  });
});

describe("validateDayAlignment", () => {
  it("accepts days whose numbers and dates match the trip", () => {
    const expected = PLAN.days.map((day) => ({
      dayNumber: day.dayNumber,
      date: day.date,
    }));

    expect(validateDayAlignment(PLAN.days, expected)).toEqual([]);
  });

  it("rejects a day whose date moved", () => {
    const expected = PLAN.days.map((day, index) => ({
      dayNumber: day.dayNumber,
      date: index === 0 ? "2026-09-20" : day.date,
    }));

    const violations = validateDayAlignment(PLAN.days, expected);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("dated");
  });

  it("rejects a day the trip does not have", () => {
    const violations = validateDayAlignment(PLAN.days, [
      { dayNumber: 1, date: PLAN.days[0].date },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("not part of this trip");
  });
});
