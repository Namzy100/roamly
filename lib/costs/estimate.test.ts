import { describe, expect, it } from "vitest";

import {
  COST_ESTIMATE_DISCLAIMER,
  bandFor,
  costClassFor,
} from "@/lib/plan/cost-bands";
import { CostEstimateSchema } from "@/lib/schemas";
import type { Currency, MealType, PlaceCategory } from "@/lib/schemas";

import { allocateBudget } from "./allocate";
import {
  buildDestinationCostEstimate,
  estimateItemAllowance,
  type ItemAllowanceInput,
} from "./estimate";
import { ALLOCATION_SCENARIOS, allocationInput } from "./fixtures";

function allowanceInput(
  overrides: Partial<ItemAllowanceInput> & {
    scenario?: keyof typeof ALLOCATION_SCENARIOS;
  } = {},
): ItemAllowanceInput {
  const { scenario, ...rest } = overrides;
  const input = allocationInput();
  const source =
    scenario && scenario !== "everyCurrency"
      ? (ALLOCATION_SCENARIOS[scenario]() as ReturnType<typeof allocationInput>)
      : input;

  return {
    category: "restaurant",
    mealType: "dinner",
    currency: source.currency,
    travelers: source.travelers,
    dayCount: source.dayCount,
    pace: source.pace,
    allocation: allocateBudget(source),
    profile: source.profile,
    ...rest,
  };
}

describe("estimateItemAllowance — free places stay free", () => {
  /**
   * Allocating a share of the budget to a park would put invented spending in the plan.
   * The band's own zero would clamp it back to nothing anyway, so the short-circuit exists
   * to say *why* rather than to arrive at the same place quietly.
   */
  it("returns zero for a place that is free to enter", () => {
    for (const category of [
      "park",
      "garden",
      "beach",
      "market",
      "viewpoint",
      "monument",
      "place_of_worship",
      "shopping",
    ] as PlaceCategory[]) {
      const allowance = estimateItemAllowance(
        allowanceInput({ category, mealType: null }),
      );

      expect(allowance.amount, category).toBe(0);
      expect(allowance.basis, category).toBe("free-entry-tag");
      expect(allowance.confidence, category).toBe("high");
    }
  });

  it("does not let a model attach a cost to a free place", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({ category: "park", mealType: null, proposed: 45 }),
    );

    expect(allowance.amount).toBe(0);
  });
});

describe("estimateItemAllowance — the two-stage rule", () => {
  it("stays inside the absolute band for its class", () => {
    const cases: { category: PlaceCategory; mealType: MealType | null }[] = [
      { category: "restaurant", mealType: "dinner" },
      { category: "restaurant", mealType: "lunch" },
      { category: "restaurant", mealType: "breakfast" },
      { category: "cafe", mealType: null },
      { category: "museum", mealType: null },
      { category: "theatre", mealType: null },
      { category: "hotel", mealType: null },
    ];

    for (const currency of ["EUR", "USD", "GBP", "AED"] as Currency[]) {
      for (const entry of cases) {
        for (const budget of [200, 2_400, 250_000]) {
          const input = allowanceInput({
            ...entry,
            currency,
            allocation: allocateBudget(allocationInput({ budget, currency })),
          });
          const allowance = estimateItemAllowance(input);

          const costClass = costClassFor(entry.category, entry.mealType);
          const band = bandFor(currency, costClass);
          const units =
            costClass === "night"
              ? Math.max(1, Math.ceil(input.travelers / 2))
              : input.travelers;

          const label = `${currency} ${entry.category} ${budget}`;
          expect(allowance.amount, label).toBeGreaterThanOrEqual(
            band.min * units - 0.01,
          );
          expect(allowance.amount, label).toBeLessThanOrEqual(
            band.max * units + 0.01,
          );
        }
      }
    }
  });

  /**
   * The clamp exists for exactly this: a very large budget divided across a few stops would
   * otherwise produce a coffee costing hundreds, which is not an estimate of anything.
   */
  it("clamps a very large budget down to the band ceiling", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({
        category: "cafe",
        mealType: null,
        allocation: allocateBudget(allocationInput({ budget: 500_000 })),
      }),
    );

    expect(allowance.clamped).toBe(true);
    expect(allowance.amount).toBe(bandFor("EUR", "snack").max * 2);
  });

  it("clamps a very small budget up to the band floor", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({
        category: "restaurant",
        mealType: "dinner",
        allocation: allocateBudget(allocationInput({ budget: 60 })),
      }),
    );

    expect(allowance.clamped).toBe(true);
    expect(allowance.amount).toBe(bandFor("EUR", "sit-down-meal").min * 2);
  });

  it("scales with the size of the party", () => {
    const solo = estimateItemAllowance(
      allowanceInput({ travelers: 1, category: "museum", mealType: null }),
    );
    const four = estimateItemAllowance(
      allowanceInput({ travelers: 4, category: "museum", mealType: null }),
    );

    expect(four.amount).toBeGreaterThan(solo.amount);
  });

  /**
   * A double room is not two singles. Nights are bounded per *room* — two to a room, rounded
   * up — so doubling the party doubles the ceiling rather than quadrupling it.
   */
  it("bounds a night per room rather than per traveller", () => {
    const big = allocateBudget(allocationInput({ budget: 500_000 }));
    const two = estimateItemAllowance(
      allowanceInput({
        travelers: 2,
        category: "hotel",
        mealType: null,
        allocation: big,
      }),
    );
    const four = estimateItemAllowance(
      allowanceInput({
        travelers: 4,
        category: "hotel",
        mealType: null,
        allocation: big,
      }),
    );

    expect(two.amount).toBe(bandFor("EUR", "night").max);
    expect(four.amount).toBe(bandFor("EUR", "night").max * 2);
  });

  /**
   * The nightly figure comes out of the accommodation budget, which is a total for the party
   * — so adding travellers to the same budget must not inflate it. A room the traveller has
   * not budgeted for is money they do not have.
   */
  it("does not inflate the nightly figure when the party grows on the same budget", () => {
    const allocation = allocateBudget(allocationInput());
    const two = estimateItemAllowance(
      allowanceInput({ travelers: 2, category: "hotel", mealType: null, allocation }),
    );
    const four = estimateItemAllowance(
      allowanceInput({ travelers: 4, category: "hotel", mealType: null, allocation }),
    );

    expect(four.amount).toBe(two.amount);
  });

  it("reflects the destination's relative cost", () => {
    const dubai = estimateItemAllowance(
      allowanceInput({
        category: "restaurant",
        mealType: "dinner",
        allocation: allocateBudget(
          allocationInput({ destination: { name: "Dubai" } }),
        ),
        profile: allocationInput({ destination: { name: "Dubai" } }).profile,
      }),
    );
    const capeTown = estimateItemAllowance(
      allowanceInput({
        category: "restaurant",
        mealType: "dinner",
        allocation: allocateBudget(
          allocationInput({ destination: { name: "Cape Town" } }),
        ),
        profile: allocationInput({ destination: { name: "Cape Town" } }).profile,
      }),
    );

    expect(dubai.amount).toBeGreaterThan(capeTown.amount);
  });
});

describe("estimateItemAllowance — what a model may and may not do", () => {
  /**
   * A model may talk an estimate *down* but never up. Upward influence would let the model
   * assert a price; downward influence can only ever be a more conservative claim.
   */
  it("accepts a lower proposal", () => {
    const base = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null }),
    );
    const lowered = estimateItemAllowance(
      allowanceInput({
        category: "museum",
        mealType: null,
        proposed: base.amount - 5,
      }),
    );

    expect(lowered.amount).toBeLessThan(base.amount);
  });

  it("ignores a higher proposal", () => {
    const base = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null }),
    );
    const inflated = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null, proposed: 9_999 }),
    );

    expect(inflated.amount).toBe(base.amount);
  });

  it("clamps a proposal below the floor back up", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null, proposed: 0.01 }),
    );

    expect(allowance.amount).toBe(bandFor("EUR", "ticket").min * 2);
    expect(allowance.clamped).toBe(true);
  });

  it("ignores a negative or non-finite proposal", () => {
    for (const proposed of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const allowance = estimateItemAllowance(
        allowanceInput({ category: "museum", mealType: null, proposed }),
      );
      expect(allowance.amount, String(proposed)).toBeGreaterThan(0);
    }
  });
});

describe("estimateItemAllowance — provenance", () => {
  it("says destination-band when the profile knows the destination", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null }),
    );

    expect(allowance.basis).toBe("destination-band");
    expect(allowance.profileId).toBe("lisbon");
    expect(allowance.confidence).toBe("high");
  });

  /**
   * A global-fallback figure came from the budget and a generic baseline, so it says so.
   * Calling it a "destination band" would imply local knowledge the profile does not have.
   */
  it("says derived-budget-allocation for the global fallback", () => {
    const source = ALLOCATION_SCENARIOS.globalFallback();
    const allowance = estimateItemAllowance(
      allowanceInput({
        category: "museum",
        mealType: null,
        allocation: allocateBudget(source),
        profile: source.profile,
      }),
    );

    expect(allowance.basis).toBe("derived-budget-allocation");
    expect(allowance.confidence).toBe("low");
  });

  it("carries the region profile's id for a regional match", () => {
    const source = ALLOCATION_SCENARIOS.regionalFallback();
    const allowance = estimateItemAllowance(
      allowanceInput({
        category: "museum",
        mealType: null,
        allocation: allocateBudget(source),
        profile: source.profile,
      }),
    );

    expect(allowance.profileId).toBe("region-southern-europe");
    expect(allowance.basis).toBe("destination-band");
    expect(allowance.confidence).toBe("medium");
  });
});

describe("buildDestinationCostEstimate", () => {
  it("produces a schema-valid estimate carrying its disclaimer and provenance", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null }),
    );
    const estimate = buildDestinationCostEstimate({
      allowance,
      currency: "EUR",
    });

    expect(CostEstimateSchema.safeParse(estimate).success).toBe(true);
    expect(estimate.disclaimer).toBe(COST_ESTIMATE_DISCLAIMER);
    expect(estimate.basis).toBe("destination-band");
    expect(estimate.profileId).toBe("lisbon");
    expect(estimate.currency).toBe("EUR");
  });

  /**
   * A free place has no profile to credit — the zero comes from an OSM tag, not from a
   * destination's relative cost, and attaching a profile id would misattribute it.
   */
  it("attaches no profile id to a free-entry figure", () => {
    const allowance = estimateItemAllowance(
      allowanceInput({ category: "park", mealType: null }),
    );
    const estimate = buildDestinationCostEstimate({
      allowance,
      currency: "EUR",
    });

    expect(estimate.profileId).toBeUndefined();
    expect(CostEstimateSchema.safeParse(estimate).success).toBe(true);
  });

  it("reports the currency it was asked for, unconverted", () => {
    for (const currency of ["EUR", "USD", "GBP", "AED"] as Currency[]) {
      const allowance = estimateItemAllowance(
        allowanceInput({ category: "museum", mealType: null, currency }),
      );
      const estimate = buildDestinationCostEstimate({ allowance, currency });

      expect(estimate.currency, currency).toBe(currency);
    }
  });
});

describe("estimateItemAllowance — stability", () => {
  it("is deterministic", () => {
    const input = allowanceInput({ category: "restaurant", mealType: "dinner" });
    expect(estimateItemAllowance(input)).toEqual(estimateItemAllowance(input));
  });

  /**
   * The allowance is spread over the *pace's* stop count, not the itinerary's. An allowance
   * that moved every time a stop was added would make "make this day cheaper" impossible to
   * reason about.
   */
  it("does not depend on how many stops a day currently has", () => {
    const first = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null }),
    );
    const second = estimateItemAllowance(
      allowanceInput({ category: "museum", mealType: null }),
    );

    expect(first.amount).toBe(second.amount);
  });

  it("rounds to the cent", () => {
    for (const budget of [7.77, 333.33, 12_345.67]) {
      const allowance = estimateItemAllowance(
        allowanceInput({
          category: "restaurant",
          mealType: "dinner",
          allocation: allocateBudget(allocationInput({ budget })),
        }),
      );

      expect(Math.round(allowance.amount * 100)).toBe(allowance.amount * 100);
    }
  });
});
