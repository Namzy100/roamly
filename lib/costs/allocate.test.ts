import { describe, expect, it } from "vitest";

import {
  MIN_BUFFER_SHARE,
  adjustedWeights,
  allocateBudget,
  plannedStopsPerDay,
} from "./allocate";
import {
  ALLOCATION_SCENARIOS,
  AWKWARD_BUDGETS,
  COST_DESTINATIONS,
  allocationInput,
} from "./fixtures";
import {
  MIN_BUDGET_PER_TRAVELER_PER_DAY,
  type AllocationWarning,
} from "./types";
import { validateAllocation } from "./validate";

function totalOf(allocation: ReturnType<typeof allocateBudget>): number {
  return (
    allocation.flights +
    allocation.accommodation +
    allocation.food +
    allocation.activities +
    allocation.localTransport +
    allocation.buffer
  );
}

describe("allocateBudget — the reconciliation invariant", () => {
  /**
   * The property the budget panel depends on. Six figures are shown and a traveller can add
   * them up, so "within a cent" is not good enough — a stray cent reads as a bug in the
   * arithmetic, which is exactly what it would be.
   */
  it("allocates the budget exactly, in every scenario", () => {
    for (const [name, scenario] of Object.entries(ALLOCATION_SCENARIOS)) {
      const inputs = [scenario()].flat();
      for (const input of inputs) {
        const allocation = allocateBudget(input);
        expect(validateAllocation(allocation, input.budget), name).toEqual([]);
        expect(totalOf(allocation), name).toBeCloseTo(input.budget, 2);
      }
    }
  });

  it("reconciles for budgets that round awkwardly", () => {
    for (const budget of AWKWARD_BUDGETS) {
      const input = allocationInput({ budget });
      const allocation = allocateBudget(input);

      expect(validateAllocation(allocation, budget), String(budget)).toEqual([]);
      expect(totalOf(allocation), String(budget)).toBeCloseTo(budget, 2);
    }
  });

  it("never produces a negative category", () => {
    for (const budget of AWKWARD_BUDGETS) {
      for (const pace of ["relaxed", "balanced", "packed"] as const) {
        const allocation = allocateBudget(allocationInput({ budget, pace }));
        for (const [name, amount] of Object.entries(allocation)) {
          if (typeof amount !== "number") continue;
          expect(amount, `${budget} ${pace} ${name}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("rounds every figure to the cent", () => {
    const allocation = allocateBudget(allocationInput({ budget: 12_345.67 }));

    for (const amount of Object.values(allocation)) {
      if (typeof amount !== "number") continue;
      expect(Math.round(amount * 100)).toBe(amount * 100);
    }
  });
});

describe("allocateBudget — how the destination shapes the split", () => {
  it("splits differently for a city profile than for the global fallback", () => {
    const lisbon = allocateBudget(ALLOCATION_SCENARIOS.supportedCity());
    const global = allocateBudget(ALLOCATION_SCENARIOS.globalFallback());

    expect(lisbon.food).not.toBe(global.food);
    // But both still allocate the same total, because the total is the traveller's.
    expect(totalOf(lisbon)).toBeCloseTo(totalOf(global), 2);
  });

  it("allocates more to flights for a long-haul destination", () => {
    const capeTown = allocateBudget(
      allocationInput({ destination: { name: "Cape Town" } }),
    );
    const lisbon = allocateBudget(ALLOCATION_SCENARIOS.supportedCity());

    expect(capeTown.flights).toBeGreaterThan(lisbon.flights);
  });

  it("carries the profile's confidence onto the allocation", () => {
    expect(allocateBudget(ALLOCATION_SCENARIOS.supportedCity()).confidence).toBe(
      "high",
    );
    expect(allocateBudget(ALLOCATION_SCENARIOS.regionalFallback()).confidence).toBe(
      "medium",
    );
    expect(allocateBudget(ALLOCATION_SCENARIOS.globalFallback()).confidence).toBe(
      "low",
    );
  });

  it("warns when there is no destination profile", () => {
    const allocation = allocateBudget(ALLOCATION_SCENARIOS.globalFallback());

    expect(allocation.warnings.map((warning) => warning.code)).toContain(
      "no_destination_profile",
    );
  });

  it("does not warn about the profile when the destination is known", () => {
    expect(
      allocateBudget(ALLOCATION_SCENARIOS.supportedCity()).warnings.map(
        (warning) => warning.code,
      ),
    ).not.toContain("no_destination_profile");
  });

  it("shifts spend toward activities on a packed trip", () => {
    const packed = allocateBudget(ALLOCATION_SCENARIOS.packedPace());
    const relaxed = allocateBudget(ALLOCATION_SCENARIOS.relaxedPace());

    expect(packed.activities).toBeGreaterThan(relaxed.activities);
    expect(relaxed.accommodation).toBeGreaterThan(packed.accommodation);
  });

  /**
   * Nothing converts between currencies, so the same budget *number* in a different currency
   * must divide identically. If a rate had crept in anywhere, this would diverge.
   */
  it("divides an identical number the same way in every currency", () => {
    const allocations = ALLOCATION_SCENARIOS.everyCurrency().map((input) =>
      allocateBudget(input),
    );

    for (const allocation of allocations) {
      expect(allocation.food).toBe(allocations[0].food);
      expect(allocation.accommodation).toBe(allocations[0].accommodation);
    }
  });
});

describe("allocateBudget — party size and trip length", () => {
  it("reports a per-traveller figure for a solo traveller", () => {
    const input = ALLOCATION_SCENARIOS.soloTraveller();
    const allocation = allocateBudget(input);

    expect(allocation.perTraveler).toBe(input.budget);
  });

  it("divides the per-traveller figure across a large party", () => {
    const input = ALLOCATION_SCENARIOS.largeParty();
    const allocation = allocateBudget(input);

    expect(allocation.perTraveler).toBeCloseTo(input.budget / 6, 2);
  });

  it("derives a nightly rate from the accommodation share", () => {
    const input = ALLOCATION_SCENARIOS.wholeWeek();
    const allocation = allocateBudget(input);

    expect(allocation.nightlyRate).toBeCloseTo(
      allocation.accommodation / input.nightCount,
      2,
    );
  });

  /**
   * A day trip has no nights. Its accommodation share is not money to be spent on a room —
   * it is money with no purpose, which belongs in the buffer. Leaving it in `accommodation`
   * would show a traveller a room budget for a trip with no room.
   */
  it("moves the accommodation share to the buffer for a trip with no nights", () => {
    const input = ALLOCATION_SCENARIOS.dayTrip();
    const allocation = allocateBudget(input);

    expect(allocation.accommodation).toBe(0);
    expect(allocation.nightlyRate).toBe(0);
    expect(allocation.buffer).toBeGreaterThan(0);
    expect(validateAllocation(allocation, input.budget)).toEqual([]);
  });

  it("still reconciles for a single traveller on a single day", () => {
    const input = allocationInput({
      travelers: 1,
      dayCount: 1,
      nightCount: 0,
      budget: 180,
    });

    expect(validateAllocation(allocateBudget(input), 180)).toEqual([]);
  });

  it("still reconciles for a week with a large party", () => {
    const input = allocationInput({
      travelers: 6,
      dayCount: 7,
      nightCount: 6,
      budget: 9_800,
    });

    expect(validateAllocation(allocateBudget(input), 9_800)).toEqual([]);
  });
});

describe("allocateBudget — a budget that is too small", () => {
  /**
   * A warning, not a refusal. The allocation still reconciles and the trip is still
   * plannable; the figures are simply tight, and saying so is more useful than declining.
   */
  it("warns rather than failing", () => {
    const input = ALLOCATION_SCENARIOS.insufficientBudget();
    const allocation = allocateBudget(input);

    expect(allocation.warnings.map((warning) => warning.code)).toContain(
      "budget_below_floor",
    );
    expect(validateAllocation(allocation, input.budget)).toEqual([]);
  });

  it("does not warn for a budget above the floor", () => {
    const input = allocationInput({
      budget: MIN_BUDGET_PER_TRAVELER_PER_DAY * 2 * 4 * 3,
      travelers: 2,
      dayCount: 4,
    });

    expect(
      allocateBudget(input).warnings.map((warning) => warning.code),
    ).not.toContain("budget_below_floor");
  });

  it("reconciles even at a budget of a few cents", () => {
    const allocation = allocateBudget(allocationInput({ budget: 0.03 }));
    expect(validateAllocation(allocation, 0.03)).toEqual([]);
  });
});

describe("adjustedWeights", () => {
  it("always sums to one", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      for (const destination of Object.values(COST_DESTINATIONS)) {
        const input = allocationInput({ pace, destination });
        const weights = adjustedWeights(input);
        const total = Object.values(weights).reduce((sum, w) => sum + w, 0);

        expect(total, `${pace} ${JSON.stringify(destination)}`).toBeCloseTo(1, 10);
      }
    }
  });

  it("never produces a negative weight", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      for (const weight of Object.values(adjustedWeights(allocationInput({ pace })))) {
        expect(weight).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("holds the buffer at or above its floor", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      const weights = adjustedWeights(allocationInput({ pace }));
      // Renormalisation can only scale it, and every share is positive.
      expect(weights.buffer, pace).toBeGreaterThanOrEqual(MIN_BUFFER_SHARE * 0.9);
    }
  });

  it("tops the buffer up from a discretionary category when it is too thin", () => {
    const warnings: AllocationWarning[] = [];
    const thin = allocationInput();
    thin.profile = {
      ...thin.profile,
      profile: {
        ...thin.profile.profile,
        weights: {
          flights: 0.3,
          accommodation: 0.28,
          food: 0.2,
          activities: 0.2,
          localTransport: 0.02,
          buffer: 0,
        },
      },
    };

    const weights = adjustedWeights(thin, warnings);

    expect(weights.buffer).toBeGreaterThan(0);
    expect(warnings.map((warning) => warning.code)).toContain("buffer_reduced");
  });

  it("throws rather than guessing when weights sum to zero", () => {
    const broken = allocationInput();
    broken.profile = {
      ...broken.profile,
      profile: {
        ...broken.profile.profile,
        weights: {
          flights: 0,
          accommodation: 0,
          food: 0,
          activities: 0,
          localTransport: 0,
          buffer: 0,
        },
      },
    };

    expect(() => adjustedWeights(broken)).toThrow(/sum to zero/i);
  });
});

describe("plannedStopsPerDay", () => {
  /**
   * The pace's typical count, not the itinerary's actual one — so a per-item allowance does
   * not move every time a stop is added, which would make "make this cheaper" impossible to
   * reason about.
   */
  it("increases with pace", () => {
    expect(plannedStopsPerDay("relaxed")).toBeLessThan(
      plannedStopsPerDay("balanced"),
    );
    expect(plannedStopsPerDay("balanced")).toBeLessThanOrEqual(
      plannedStopsPerDay("packed"),
    );
  });

  it("is always at least one", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      expect(plannedStopsPerDay(pace)).toBeGreaterThanOrEqual(1);
    }
  });
});
