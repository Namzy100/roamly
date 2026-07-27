import {
  allocateBudget,
  buildDestinationCostEstimate,
  costProfileById,
  estimateItemAllowance,
  resolveCostProfile,
  validateAllocation,
  type BudgetAllocation,
  type ResolvedCostProfile,
} from "@/lib/costs";
import { withDerivedBudget, withDerivedDayTotals } from "@/lib/plan";
import {
  tripDayCount,
  tripNightCount,
  type ItineraryDay,
  type ItineraryItem,
  type TripGenerationContext,
  type TripPlan,
} from "@/lib/schemas";

import type { RefinementError } from "./types";

/**
 * "Recalculate cost estimates" — the money, and only the money.
 *
 * ## What it touches
 *
 * `item.estimatedCost`, `item.costEstimate`, `item.costNote`, the five budget categories
 * and every derived total. That is the complete list.
 *
 * ## What it must not touch, and why saying so matters
 *
 * Places, times, dates, order, item ids, backups, travel segments, routing results,
 * accommodation, the flight estimate. A traveller pressing a button labelled "recalculate
 * cost estimates" and finding their Tuesday rearranged would have every reason never to
 * press anything again. The tests assert unrelated items come back **by reference**, which
 * is a stronger claim than deep equality.
 *
 * ## No AI, no OpenStreetMap, no routing, no clock
 *
 * The inputs are the request's own budget, the destination's curated profile and the
 * plan's own places. Nothing is fetched, nothing is asked of a model, and the same plan
 * always re-estimates to the same figures — which is what makes the action safe to offer
 * and its result safe to compare against the old one.
 *
 * ## The two-stage rule, unchanged
 *
 * Each allowance is allocated from the traveller's budget and then clamped into the
 * absolute band for its class in the traveller's currency. There is no exchange rate here
 * because there is nothing to exchange: the profile holds multipliers, and the bands are
 * hand-written per currency.
 */

export type ReestimateOutcome =
  | {
      ok: true;
      plan: TripPlan;
      /** Old versus new, for the confirmation the traveller is shown. */
      previousTotal: number;
      newTotal: number;
      previousConfidence: string | null;
      profile: ResolvedCostProfile;
      allocation: BudgetAllocation;
      changedItemIds: string[];
      message: string;
    }
  | { ok: false; error: RefinementError };

export function reestimatePlanCosts(input: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
}): ReestimateOutcome {
  const { plan } = input;

  /**
   * The profile is resolved from the destination, not read from the recorded provenance.
   *
   * That is the point of the action: the curated table may have gained a city or corrected
   * a weight since the trip was generated, and re-estimating against the *stored* id would
   * reproduce the old figures exactly. The stored id is still used — as the "before" the
   * traveller is shown.
   */
  const profile = resolveProfileFor(input);

  const dayCount = Math.max(1, tripDayCount(plan.request));
  const nightCount = Math.max(0, tripNightCount(plan.request));

  const allocation = allocateBudget({
    budget: plan.request.budget,
    currency: plan.request.currency,
    travelers: plan.request.travelers,
    dayCount,
    nightCount,
    pace: plan.request.pace,
    accommodationStyle: plan.request.accommodation,
    profile,
  });

  /**
   * The identity is asserted before a single figure is written.
   *
   * A budget panel whose six categories do not add up to the total is a visible bug, and
   * this is the last point at which it can be caught rather than shown.
   */
  const allocationIssues = validateAllocation(allocation, plan.request.budget);
  if (allocationIssues.length > 0) {
    return {
      ok: false,
      error: {
        code: "cost_basis_invalid",
        message: `The budget could not be divided consistently: ${allocationIssues[0].message}`,
      },
    };
  }

  const changedItemIds: string[] = [];
  /**
   * Every item whose estimate was rewritten, including ones whose *amount* did not move.
   *
   * The two differ, and the difference matters: an item can come out at the same figure
   * while its provenance changes — same money, now justified by a destination profile rather
   * than by the generic category band. Leaving the old basis in place would mean a figure
   * claiming a provenance that no longer produced it, so the estimate is rewritten and only
   * `changedItemIds` stays about money.
   */
  const repricedItemIds: string[] = [];

  const days = plan.days.map((day) =>
    reestimateDay({
      day,
      plan,
      profile,
      allocation,
      dayCount,
      changedItemIds,
      repricedItemIds,
    }),
  );

  /**
   * The two categories the items determine, re-derived; the other three carried through.
   *
   * Flights and accommodation are estimated once at generation from the same allocation,
   * and re-deriving them here from the *new* allocation would silently move money the
   * traveller has already seen attributed. `transport` has no per-item source at all — the
   * schema has no cost category on an item — so recomputing it would mean inventing an
   * attribution rule.
   */
  const budget = withDerivedBudget(
    {
      ...plan.budget,
      food: sumWhere(days, (item) => item.kind === "meal"),
      activities: sumWhere(
        days,
        (item) =>
          item.kind !== "meal" &&
          item.kind !== "transport" &&
          item.kind !== "logistics",
      ),
    },
    days,
    plan.request.travelers,
  );

  const previousTotal = plan.budget.total;
  const newTotal = budget.total;

  if (repricedItemIds.length === 0 && previousTotal === newTotal) {
    return {
      ok: false,
      error: {
        code: "no_change",
        message:
          "The estimates are already up to date against this destination's cost profile.",
      },
    };
  }

  return {
    ok: true,
    plan: { ...plan, days, budget },
    previousTotal,
    newTotal,
    previousConfidence: input.generation?.costProfile?.confidence ?? null,
    profile,
    allocation,
    changedItemIds,
    message: messageFor({ previousTotal, newTotal, currency: plan.request.currency }),
  };
}

/**
 * The profile for this trip's destination.
 *
 * Prefers the geocoded destination the generation context recorded, because it carries a
 * country code and a display name the plan itself does not. Falls back to the plan's own
 * destination name, which is what the sample trip and any pre-Phase-5B trip has.
 */
function resolveProfileFor(input: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
}): ResolvedCostProfile {
  const destination = input.generation?.destination;

  return resolveCostProfile(
    destination
      ? {
          name: destination.name,
          displayName: destination.displayName,
          ...(destination.countryCode
            ? { countryCode: destination.countryCode }
            : {}),
        }
      : { name: input.plan.destination.city },
  );
}

function reestimateDay(context: {
  day: ItineraryDay;
  plan: TripPlan;
  profile: ResolvedCostProfile;
  allocation: BudgetAllocation;
  dayCount: number;
  changedItemIds: string[];
  repricedItemIds: string[];
}): ItineraryDay {
  const {
    day,
    plan,
    profile,
    allocation,
    dayCount,
    changedItemIds,
    repricedItemIds,
  } = context;
  let anyChanged = false;

  const items = day.items.map((item) => {
    /**
     * Nothing to price.
     *
     * An unfilled slot and a free-time block both cost nothing, and giving either one an
     * allowance would put spending in the budget that corresponds to no visit.
     */
    if (item.status !== "confirmed" || item.place === null) return item;

    const allowance = estimateItemAllowance({
      category: item.place.category,
      mealType: item.mealType,
      currency: plan.request.currency,
      travelers: plan.request.travelers,
      dayCount,
      pace: plan.request.pace,
      allocation,
      profile,
    });

    const estimate = buildDestinationCostEstimate({
      allowance,
      currency: plan.request.currency,
    });

    const amountMoved = allowance.amount !== item.estimatedCost;
    const provenanceMoved =
      item.costEstimate?.basis !== estimate.basis ||
      item.costEstimate?.profileId !== estimate.profileId ||
      item.costEstimate?.confidence !== estimate.confidence;

    if (!amountMoved && !provenanceMoved) return item;

    anyChanged = true;
    repricedItemIds.push(item.id);
    if (amountMoved) changedItemIds.push(item.id);

    return {
      ...item,
      estimatedCost: allowance.amount,
      costNote:
        allowance.amount === 0
          ? "Free to enter, from OpenStreetMap's own tag"
          : `Estimate for the whole party · ${allowance.confidence} confidence`,
      costEstimate: estimate,
    };
  });

  // The same day object when nothing on it moved, so preservation is `===`-checkable.
  return anyChanged ? withDerivedDayTotals({ ...day, items }) : day;
}

function sumWhere(
  days: ItineraryDay[],
  predicate: (item: ItineraryItem) => boolean,
): number {
  return (
    Math.round(
      days
        .flatMap((day) => day.items)
        .filter(predicate)
        .reduce((total, item) => total + item.estimatedCost, 0) * 100,
    ) / 100
  );
}

function messageFor(input: {
  previousTotal: number;
  newTotal: number;
  currency: string;
}): string {
  const delta = Math.round((input.newTotal - input.previousTotal) * 100) / 100;
  if (delta === 0) {
    return "The estimates were recalculated and the total is unchanged.";
  }
  return delta > 0
    ? `Estimates recalculated: the planned total is ${Math.abs(delta)} ${input.currency} higher than before.`
    : `Estimates recalculated: the planned total is ${Math.abs(delta)} ${input.currency} lower than before.`;
}

/**
 * The provenance a re-estimate should record, for the generation context.
 *
 * Returned rather than written, because the caller owns the atomic save and this module
 * owns the arithmetic. A pre-Phase-6B trip has no recorded profile and gains one here —
 * which is honest, because the figures it now carries *were* produced by that profile. Old
 * figures are never retro-labelled; they are replaced.
 */
export function costProfileProvenance(profile: ResolvedCostProfile): {
  profileId: string;
  version: string;
  match: ResolvedCostProfile["match"];
  confidence: ResolvedCostProfile["confidence"];
} {
  return {
    profileId: profile.profile.profileId,
    version: profile.profile.version,
    match: profile.match,
    confidence: profile.confidence,
  };
}

/** The stored profile, for showing what the previous figures were based on. */
export function previousCostProfile(
  generation: TripGenerationContext | null,
): { profileId: string; version: string; known: boolean } | null {
  const recorded = generation?.costProfile;
  if (!recorded) return null;

  return {
    profileId: recorded.profileId,
    version: recorded.version,
    // False when the table no longer contains it — the id is still shown, unexplained
    // rather than silently replaced with a profile that is not the one that was used.
    known: costProfileById(recorded.profileId) !== null,
  };
}
