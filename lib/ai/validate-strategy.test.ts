import { describe, expect, it } from "vitest";

import { fixtureStrategy } from "@/lib/generate/test-fixtures";

import { validateStrategy } from "./validate-strategy";

const EXPECTED_DAYS = 2;

function validate(raw: unknown, expectedDayCount = EXPECTED_DAYS) {
  return validateStrategy({ raw, expectedDayCount });
}

function codes(result: ReturnType<typeof validate>): string[] {
  return result.violations.map((violation) => violation.code);
}

describe("validateStrategy", () => {
  it("accepts the baseline strategy", () => {
    const result = validate(fixtureStrategy());

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects a day count that is not this trip's", () => {
    const strategy = fixtureStrategy();
    const result = validate(strategy, 5);

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("strategy_day_count");
  });

  it("names the specific day that is missing rather than only the count", () => {
    const result = validate(fixtureStrategy(), 3);

    expect(codes(result)).toContain("strategy_missing_day");
    expect(
      result.violations.some((violation) => violation.dayNumber === 3),
    ).toBe(true);
  });

  /**
   * Day 6 rather than day 9: nine trips the schema's absolute `.max(7)` first, which
   * is the right layer for a bound that does not depend on the request. Six is
   * schema-valid and still outside a two-day trip, so it reaches the cross-field
   * check this test is actually about.
   */
  it("rejects a schema-valid day number that is outside this trip", () => {
    const strategy = fixtureStrategy();
    strategy.days[1].dayNumber = 6;

    expect(codes(validate(strategy))).toContain("strategy_day_number");
  });

  it("rejects a day number beyond any possible trip at the schema layer", () => {
    const strategy = fixtureStrategy();
    strategy.days[1].dayNumber = 9;

    expect(codes(validate(strategy))).toContain("strategy_schema");
  });

  it("rejects a duplicated day", () => {
    const strategy = fixtureStrategy();
    strategy.days[1].dayNumber = 1;

    expect(codes(validate(strategy))).toContain("strategy_duplicate_day");
  });

  it("rejects a category outside the allowlist", () => {
    const strategy = fixtureStrategy() as unknown as {
      days: { searchRequirements: { category: string }[] }[];
    };
    strategy.days[0].searchRequirements[0].category = "nightclub_district";

    const result = validate(strategy);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("strategy_schema");
  });

  it("rejects a slot id that does not match its position", () => {
    const strategy = fixtureStrategy();
    strategy.days[0].searchRequirements[1].slotId = "d1-s5";

    expect(codes(validate(strategy))).toContain("strategy_slot_id");
  });

  it("rejects more slots than a day may have", () => {
    const strategy = fixtureStrategy();
    const template = strategy.days[0].searchRequirements[0];
    strategy.days[0].searchRequirements = Array.from({ length: 7 }, (_, index) => ({
      ...template,
      slotId: `d1-s${index + 1}`,
      mealType: null,
    }));

    // The schema's own max fires first, which is the correct place for a bound
    // that does not depend on the request.
    expect(codes(validate(strategy))).toContain("strategy_schema");
  });

  it("rejects two slots for the same meal on one day", () => {
    const strategy = fixtureStrategy();
    strategy.days[0].searchRequirements[1].mealType = "breakfast";

    expect(codes(validate(strategy))).toContain("strategy_duplicate_meal");
  });

  it("rejects a candidate limit outside its bounds", () => {
    const strategy = fixtureStrategy();
    strategy.days[0].searchRequirements[0].candidateLimit = 99;

    expect(codes(validate(strategy))).toContain("strategy_schema");
  });

  it("rejects budget shares that do not add up to 1", () => {
    const strategy = fixtureStrategy();
    strategy.budgetAllocation.food = 0.6;

    const result = validate(strategy);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("strategy_budget_allocation");
  });

  it("accepts shares within the stated tolerance", () => {
    const strategy = fixtureStrategy();
    strategy.budgetAllocation.buffer = 0.04;

    expect(validate(strategy).ok).toBe(true);
  });

  it("rejects coordinates anywhere in the output", () => {
    const strategy = {
      ...fixtureStrategy(),
      recommendedBaseArea: "Alfama",
      latitude: 38.7223,
      longitude: -9.1393,
    };

    const result = validate(strategy);
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["prohibited_field", "prohibited_field"]);
  });

  it("rejects a business name field, and reports nothing else", () => {
    const strategy = {
      ...fixtureStrategy(),
      // Also breaks the day count, to prove the identity check short-circuits.
      days: [],
      placeName: "Cervejaria Ramiro",
    };

    const result = validate(strategy);
    expect(codes(result)).toEqual(["prohibited_field"]);
  });

  it("rejects a radius outside the permitted range", () => {
    const strategy = fixtureStrategy();
    strategy.recommendedRadiusMeters = 400_000;

    expect(codes(validate(strategy))).toContain("strategy_schema");
  });

  it("does not mutate the payload it was handed", () => {
    const strategy = fixtureStrategy();
    const snapshot = JSON.stringify(strategy);

    validate(strategy);
    expect(JSON.stringify(strategy)).toBe(snapshot);
  });
});
