// The file rather than the `@/lib/generate` barrel, which re-exports the `server-only`
// pipeline. This module runs in the browser: "recalculate estimates" is computed there.
import { STOPS_PER_DAY } from "@/lib/generate/pace-policy";

import {
  MIN_BUDGET_PER_TRAVELER_PER_DAY,
  type AllocationInput,
  type AllocationWarning,
  type BudgetAllocation,
  type CategoryWeights,
} from "./types";

/**
 * Dividing a traveller's budget, deterministically and without inventing money.
 *
 * ## The invariant
 *
 * `flights + accommodation + food + activities + localTransport + buffer` equals the
 * budget **exactly**. Not within a cent — exactly, because the budget panel shows all six
 * and a leak would be visible as figures that do not add up.
 *
 * That is achieved by allocating five categories to the nearest cent and giving the buffer
 * whatever remains, rather than by rounding six numbers and hoping. The buffer absorbing
 * the rounding is also the right choice semantically: it is the deliberate slack, so a few
 * cents of it moving is meaningless, whereas a few cents appearing in "flights" is a
 * figure nobody chose.
 *
 * ## Where the destination comes in
 *
 * Only through `weights`. A destination where dining matters more and tickets less shifts
 * the split; it does not change the total, because the total is the traveller's.
 *
 * ## No model, no network, no clock
 *
 * Pure arithmetic over the request and a curated table. The same inputs always produce the
 * same allocation, which is what makes "recalculate estimates" a safe action to offer.
 */

/** The buffer is protected: pace and profile may squeeze it, never below this share. */
export const MIN_BUFFER_SHARE = 0.02;

/**
 * How pace shifts the split.
 *
 * A packed trip does more paid things and eats more meals out; a relaxed one spends less on
 * both and proportionally more on where it is staying. Small adjustments — pace is a real
 * signal but a weak one next to the destination.
 */
const PACE_ADJUSTMENT: Record<
  AllocationInput["pace"],
  Partial<Record<keyof CategoryWeights, number>>
> = {
  relaxed: { activities: -0.02, food: -0.01, accommodation: +0.03 },
  balanced: {},
  packed: { activities: +0.03, localTransport: +0.01, accommodation: -0.04 },
};

export function allocateBudget(input: AllocationInput): BudgetAllocation {
  const warnings: AllocationWarning[] = [];

  if (input.profile.match === "global") {
    warnings.push({
      code: "no_destination_profile",
      message:
        "No cost profile is available for this destination, so the estimates use a generic baseline and are correspondingly rough.",
    });
  }

  const perTravellerPerDay =
    input.budget / Math.max(1, input.travelers) / Math.max(1, input.dayCount);
  if (perTravellerPerDay < MIN_BUDGET_PER_TRAVELER_PER_DAY) {
    /**
     * A warning, not a refusal.
     *
     * The allocation still reconciles and the plan is still buildable; the figures are just
     * tight. Refusing to plan a cheap trip would be worse than planning it and saying so.
     */
    warnings.push({
      code: "budget_below_floor",
      message: `This budget works out at about ${Math.round(perTravellerPerDay)} per traveller per day, which is below what these estimates assume — expect the allowances to be tight.`,
    });
  }

  const weights = adjustedWeights(input, warnings);

  /**
   * Five categories to the cent; the buffer takes the remainder.
   *
   * `Math.round` on each of six shares can drift by up to three cents from the total. The
   * remainder approach cannot drift at all.
   */
  const flights = money(input.budget * weights.flights);
  const accommodation = money(input.budget * weights.accommodation);
  const food = money(input.budget * weights.food);
  const activities = money(input.budget * weights.activities);
  const localTransport = money(input.budget * weights.localTransport);

  const allocated = flights + accommodation + food + activities + localTransport;
  const buffer = money(input.budget - allocated);

  if (buffer < 0) {
    /**
     * Unreachable while the weights sum to 1 and each is non-negative, which
     * `adjustedWeights` guarantees. Kept as a hard failure rather than a clamp: a negative
     * buffer would mean the arithmetic above is wrong, and silently correcting it would
     * hide that.
     */
    throw new Error(
      `Budget allocation over-committed: allocated ${allocated} of ${input.budget}`,
    );
  }

  const nights = Math.max(0, input.nightCount);
  const nightlyRate = nights > 0 ? money(accommodation / nights) : 0;

  return {
    flights,
    accommodation,
    food,
    activities,
    localTransport,
    buffer,
    nightlyRate,
    perTraveler: money(input.budget / Math.max(1, input.travelers)),
    confidence: input.profile.confidence,
    warnings,
  };
}

/**
 * The profile's weights, adjusted for pace and renormalised.
 *
 * Renormalisation is what keeps the invariant true: an adjustment that pushed the sum to
 * 1.02 would silently allocate 2 % more money than the traveller has.
 */
export function adjustedWeights(
  input: Pick<AllocationInput, "pace" | "profile" | "nightCount">,
  warnings: AllocationWarning[] = [],
): CategoryWeights {
  const base = { ...input.profile.profile.weights };
  const adjustment = PACE_ADJUSTMENT[input.pace];

  for (const key of Object.keys(base) as (keyof CategoryWeights)[]) {
    base[key] = Math.max(0, base[key] + (adjustment[key] ?? 0));
  }

  /**
   * A day trip has no nights, so its accommodation share is not money that should sit
   * unspent — it goes to the buffer, which is where money with no purpose belongs.
   */
  if (input.nightCount === 0 && base.accommodation > 0) {
    base.buffer += base.accommodation;
    base.accommodation = 0;
  }

  if (base.buffer < MIN_BUFFER_SHARE) {
    const shortfall = MIN_BUFFER_SHARE - base.buffer;
    // Taken from the largest discretionary category rather than spread thinly, so the
    // adjustment is traceable.
    const donor = base.activities >= base.food ? "activities" : "food";
    const taken = Math.min(shortfall, base[donor]);
    base[donor] -= taken;
    base.buffer += taken;

    warnings.push({
      code: "buffer_reduced",
      message:
        "The contingency share was topped up from the activities budget so there is something held back.",
    });
  }

  const total = Object.values(base).reduce((sum, share) => sum + share, 0);
  if (total <= 0) {
    throw new Error("Category weights sum to zero, which cannot be normalised");
  }

  return Object.fromEntries(
    (Object.keys(base) as (keyof CategoryWeights)[]).map((key) => [
      key,
      base[key] / total,
    ]),
  ) as CategoryWeights;
}

/**
 * How many paid stops a day is planned around, for spreading the activities budget.
 *
 * Uses the pace's *typical* count rather than the actual itinerary, so the per-item
 * allowance is stable while a day is being edited — an allowance that moved every time a
 * stop was added would make "cheaper" impossible to reason about.
 */
export function plannedStopsPerDay(pace: AllocationInput["pace"]): number {
  const range = STOPS_PER_DAY[pace];
  return Math.max(1, Math.round((range.min + range.max) / 2));
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}
