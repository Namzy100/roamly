import {
  COST_ESTIMATE_DISCLAIMER,
  bandFor,
  costClassFor,
} from "@/lib/plan/cost-bands";
import type {
  CostEstimate,
  Currency,
  MealType,
  PlaceCategory,
} from "@/lib/schemas";

import { plannedStopsPerDay } from "./allocate";
import type {
  BudgetAllocation,
  CostClassKey,
  ResolvedCostProfile,
} from "./types";

/**
 * One stop's allowance, from the budget rather than from a price list.
 *
 * ## The two-stage rule
 *
 * 1. **Allocate.** The category budget for the day is divided across the stops that day is
 *    planned around, then scaled by how expensive this *kind* of place is at this
 *    destination relative to the others there.
 * 2. **Clamp.** The result is pulled into the absolute band for that class in the
 *    traveller's currency.
 *
 * Stage one makes the figure proportionate to what the traveller has and to where they are.
 * Stage two makes it plausible: a £20,000 budget must not produce a £400 coffee, and a £300
 * one must not produce a £2 dinner.
 *
 * The bands in stage two are the only absolute money in the system, are hand-written per
 * currency, and are never derived from one another — so no exchange rate is involved
 * anywhere in this file.
 *
 * ## What the model may not do
 *
 * Override the band. A model may propose an amount and it is clamped; it cannot select a
 * different band, change the class, or price a category the profile does not cover.
 */

export type ItemAllowanceInput = {
  category: PlaceCategory;
  mealType: MealType | null;
  currency: Currency;
  travelers: number;
  dayCount: number;
  pace: "relaxed" | "balanced" | "packed";
  allocation: BudgetAllocation;
  profile: ResolvedCostProfile;
  /** A model's proposal, when there is one. Clamped, never trusted. */
  proposed?: number | null;
};

export type ItemAllowance = {
  amount: number;
  /** True when the band moved the figure, so the caller can warn. */
  clamped: boolean;
  basis: CostEstimate["basis"];
  confidence: CostEstimate["confidence"];
  profileId: string;
};

export function estimateItemAllowance(
  input: ItemAllowanceInput,
): ItemAllowance {
  const costClass = costClassFor(input.category, input.mealType);

  /**
   * A place that is free to enter stays free.
   *
   * Allocating a share of the budget to a park would put invented spending in the plan, and
   * the band's own zero would then clamp it back — going through the motions to arrive at
   * the same place. Short-circuiting says why.
   */
  if (costClass === "free") {
    return {
      amount: 0,
      clamped: false,
      basis: "free-entry-tag",
      confidence: "high",
      profileId: input.profile.profile.profileId,
    };
  }

  const allocated = allocateForClass(costClass, input);
  const band = bandFor(input.currency, costClass);
  const units =
    costClass === "night"
      ? Math.max(1, Math.ceil(input.travelers / 2))
      : Math.max(1, input.travelers);

  const min = money(band.min * units);
  const max = money(band.max * units);

  /**
   * A model's proposal competes with the allocation rather than replacing it: whichever is
   * lower is used, so a model cannot talk the estimate *up*, only down. It is then clamped
   * to the floor like anything else.
   */
  const candidate =
    input.proposed !== null && input.proposed !== undefined && Number.isFinite(input.proposed)
      ? Math.min(allocated, Math.max(0, input.proposed))
      : allocated;

  const amount = money(Math.min(max, Math.max(min, candidate)));

  return {
    amount,
    clamped: amount !== money(candidate),
    /**
     * `destination-band` when the profile actually knows this destination, otherwise
     * `derived-budget-allocation` — the figure came from the budget and a generic baseline,
     * and the basis says so rather than implying local knowledge.
     */
    basis:
      input.profile.match === "global"
        ? "derived-budget-allocation"
        : "destination-band",
    confidence: input.profile.confidence,
    profileId: input.profile.profile.profileId,
  };
}

/**
 * The share of the relevant category budget one stop of this class gets.
 *
 * Meals draw on `food`, tickets on `activities`, a room on `accommodation`. Divided by the
 * number of such stops the *pace* plans for rather than the number the itinerary currently
 * has, so an allowance does not move every time a day is edited.
 */
function allocateForClass(
  costClass: Exclude<ReturnType<typeof costClassFor>, "free">,
  input: ItemAllowanceInput,
): number {
  const relative = input.profile.profile.relativeCost[costClass as CostClassKey];
  const multiplier = relative?.typical ?? 1;
  const days = Math.max(1, input.dayCount);

  if (costClass === "night") {
    return money(input.allocation.nightlyRate * multiplier);
  }

  const isMeal =
    costClass === "snack" ||
    costClass === "casual-meal" ||
    costClass === "sit-down-meal" ||
    costClass === "premium-meal";

  if (isMeal) {
    // Two or three meals a day is the shape every pace produces, so the food budget is
    // divided by days and then by a nominal two-and-a-half meals.
    const perDay = input.allocation.food / days;
    return money((perDay / 2.5) * multiplier);
  }

  const perDay = input.allocation.activities / days;
  return money((perDay / plannedStopsPerDay(input.pace)) * multiplier);
}

/**
 * A complete `CostEstimate` from an allowance.
 *
 * The only way one should be built in this domain: `basis`, `confidence`, `profileId` and
 * the disclaimer all travel together, so a figure cannot reach a traveller without saying
 * what it is.
 */
export function buildDestinationCostEstimate(input: {
  allowance: ItemAllowance;
  currency: Currency;
}): CostEstimate {
  return {
    amount: input.allowance.amount,
    currency: input.currency,
    basis: input.allowance.basis,
    confidence: input.allowance.confidence,
    disclaimer: COST_ESTIMATE_DISCLAIMER,
    ...(input.allowance.basis === "free-entry-tag"
      ? {}
      : { profileId: input.allowance.profileId }),
  };
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}
