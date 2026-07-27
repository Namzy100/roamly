import { describe, expect, it } from "vitest";

import { allocateBudget } from "./allocate";
import { allocationInput } from "./fixtures";
import { DESTINATION_COST_PROFILES } from "./profiles";
import type { DestinationCostProfile } from "./types";
import {
  assertAllocationReconciles,
  validateAllocation,
  validateBandCoverage,
  validateProfileTable,
} from "./validate";

/**
 * The validators are checked against *broken* input, because that is the only way to know
 * they would catch a real mistake. A validator that only ever sees valid data is a
 * validator nobody has tested.
 */

const GOOD = DESTINATION_COST_PROFILES[0];

function broken(overrides: Partial<DestinationCostProfile>): DestinationCostProfile {
  return { ...GOOD, ...overrides };
}

describe("validateAllocation", () => {
  it("passes a real allocation", () => {
    const input = allocationInput();
    expect(validateAllocation(allocateBudget(input), input.budget)).toEqual([]);
  });

  it("catches a total that does not match the budget", () => {
    const allocation = allocateBudget(allocationInput());

    expect(
      validateAllocation({ ...allocation, food: allocation.food + 1 }, 2_400),
    ).toEqual([
      {
        code: "allocation_does_not_reconcile",
        message: expect.stringContaining("2400.00"),
      },
    ]);
  });

  it("catches a negative category", () => {
    const allocation = allocateBudget(allocationInput());

    const issues = validateAllocation(
      { ...allocation, buffer: -1, food: allocation.food + allocation.buffer + 1 },
      2_400,
    );

    expect(issues.map((issue) => issue.code)).toContain("negative_allocation");
  });

  /**
   * Half a cent of slack, because the addends are themselves cent-rounded. Anything larger
   * is a real leak and shows up as a budget panel that does not add up.
   */
  it("tolerates sub-cent floating-point noise but nothing more", () => {
    const allocation = allocateBudget(allocationInput());

    expect(validateAllocation(allocation, 2_400.001)).toEqual([]);
    expect(validateAllocation(allocation, 2_400.02)).toHaveLength(1);
  });

  it("throws in its asserting form", () => {
    const allocation = allocateBudget(allocationInput());

    expect(() => assertAllocationReconciles(allocation, 2_400)).not.toThrow();
    expect(() => assertAllocationReconciles(allocation, 999)).toThrow(
      /not valid/i,
    );
  });
});

describe("validateProfileTable", () => {
  it("passes the curated table", () => {
    expect(validateProfileTable()).toEqual([]);
  });

  it("catches weights that do not sum to one", () => {
    const issues = validateProfileTable([
      broken({
        weights: { ...GOOD.weights, food: GOOD.weights.food + 0.1 },
      }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("weights_do_not_sum");
  });

  it("catches a negative weight", () => {
    const issues = validateProfileTable([
      broken({
        weights: { ...GOOD.weights, buffer: -0.04, food: GOOD.weights.food + 0.08 },
      }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("negative_weight");
  });

  it("catches a band whose low exceeds its high", () => {
    const issues = validateProfileTable([
      broken({
        relativeCost: {
          ...GOOD.relativeCost,
          ticket: { low: 2, typical: 1, high: 0.5, unit: "per-person" },
        },
      }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("invalid_band_order");
  });

  it("catches a multiplier of zero, which is not a relative cost", () => {
    const issues = validateProfileTable([
      broken({
        relativeCost: {
          ...GOOD.relativeCost,
          snack: { low: 0, typical: 0, high: 0, unit: "per-person" },
        },
      }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("non_positive_multiplier");
  });

  it("catches a missing cost class", () => {
    const withoutNight = { ...GOOD.relativeCost } as Record<string, unknown>;
    delete withoutNight.night;

    const issues = validateProfileTable([
      broken({
        relativeCost: withoutNight as DestinationCostProfile["relativeCost"],
      }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("missing_cost_class");
  });

  it("catches a missing accommodation style", () => {
    const withoutLuxury = { ...GOOD.accommodation } as Record<string, unknown>;
    delete withoutLuxury.luxury;

    const issues = validateProfileTable([
      broken({
        accommodation: withoutLuxury as DestinationCostProfile["accommodation"],
      }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("missing_cost_class");
  });

  it("catches a duplicated profile id", () => {
    const issues = validateProfileTable([GOOD, GOOD]);

    expect(issues.map((issue) => issue.code)).toContain("duplicate_profile_id");
  });

  /**
   * A key claimed twice would make table *order* decide the answer, so moving a row in
   * `profiles.ts` would silently change every estimate for that destination.
   */
  it("catches a destination key claimed by two profiles", () => {
    const issues = validateProfileTable([
      GOOD,
      broken({ profileId: "other", destinationKeys: [GOOD.destinationKeys[0]] }),
    ]);

    expect(issues.map((issue) => issue.code)).toContain("duplicate_destination_key");
  });

  it("catches a missing source note", () => {
    const issues = validateProfileTable([broken({ sourceNote: "   " })]);

    expect(issues.map((issue) => issue.code)).toContain("missing_source_note");
  });
});

describe("validateBandCoverage", () => {
  /**
   * The profile table and the absolute band table are separate on purpose — the profile
   * decides shape, the band decides plausibility — and this is the seam where a class added
   * to one and not the other would otherwise surface as an undefined band at estimate time.
   */
  it("finds an absolute band in every currency for every priced class", () => {
    expect(validateBandCoverage()).toEqual([]);
  });
});
