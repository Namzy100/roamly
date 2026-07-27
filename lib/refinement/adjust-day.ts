import { kindForCategory } from "@/lib/generate/assemble-plan";
import {
  buildCostEstimate,
  clampPartyCost,
  costClassFor,
  withDerivedDayTotals,
} from "@/lib/plan";
import type {
  BackupOption,
  ItineraryDay,
  ItineraryItem,
  TripPlace,
  TripPlan,
} from "@/lib/schemas";

import { RefinementBuildError, rebuildBudget } from "./replace-item";
import type { AdjustDayResult } from "./schemas";
import type { RefinementWarning } from "./types";

/**
 * Rebuilding one day from a model's proposal.
 *
 * The largest of the three edits, and the one where the temptation to trust the
 * model is strongest — it returns a whole day, so it would be easy to accept it
 * wholesale. Nothing is accepted wholesale:
 *
 *  - every `placeId` is resolved against the **canonical map** built from the pool,
 *    and the pool's record is attached
 *  - every cost is **clamped** into its band
 *  - `order` is assigned from chronological position, not from the model's array
 *  - `kind` is derived from the canonical category, not taken from the model
 *  - times are the model's, and then the schedule validator decides
 *
 * ## Non-place blocks
 *
 * A day adjustment is the one refinement that may add "free time" — that is most of
 * what "more relaxed" means in practice. Those blocks carry no place, so they never
 * acquire a marker or a leg, and free time and accommodation blocks are forced to
 * zero cost for the same reason `assemble-plan.ts` does it: the stay is already a
 * budget line and pricing the block would double-count it.
 *
 * ## Other days
 *
 * Untouched, and returned by reference.
 */

export type AdjustDayInput = {
  plan: TripPlan;
  dayNumber: number;
  result: Extract<AdjustDayResult, { status: "adjusted" }>;
  /** Canonical records for every place the model was allowed to use. */
  canonicalByPlaceId: Map<string, TripPlace>;
};

export type AdjustDayOutcome = {
  plan: TripPlan;
  previousDay: ItineraryDay;
  day: ItineraryDay;
  warnings: RefinementWarning[];
};

export function applyDayAdjustment(input: AdjustDayInput): AdjustDayOutcome {
  const dayIndex = input.plan.days.findIndex(
    (day) => day.dayNumber === input.dayNumber,
  );
  if (dayIndex === -1) {
    throw new RefinementBuildError([
      {
        code: "day_not_found",
        message: `Day ${input.dayNumber} is not part of this trip.`,
        dayNumber: input.dayNumber,
      },
    ]);
  }

  const previousDay = input.plan.days[dayIndex];
  const warnings: RefinementWarning[] = [];
  const { currency, travelers, budget } = {
    currency: input.plan.request.currency,
    travelers: input.plan.request.travelers,
    budget: input.plan.request.budget,
  };

  /**
   * Chronological order, imposed rather than trusted — the same rule assembly
   * follows. `order` drives the map's numbering and the leg derivation, so a day
   * listed out of sequence would produce a route that doubles back.
   */
  const ordered = [...input.result.items].sort((a, b) => {
    const aTime = "startTime" in a ? (a.startTime ?? null) : null;
    const bTime = "startTime" in b ? (b.startTime ?? null) : null;
    if (aTime === null && bTime === null) return 0;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return aTime.localeCompare(bTime);
  });

  let lastEnd = "09:00";

  const items: ItineraryItem[] = ordered.map((item, index) => {
    if (item.kind === "place") {
      const canonical = input.canonicalByPlaceId.get(item.placeId);
      if (!canonical) {
        // Validation already proved membership, so a miss here is a pairing bug.
        throw new RefinementBuildError([
          {
            code: "place_outside_pool",
            message: `"${item.placeId}" has no canonical record; the day was paired with the wrong pool.`,
            dayNumber: input.dayNumber,
            placeId: item.placeId,
          },
        ]);
      }

      const cost = clampPartyCost({
        proposed: item.estimatedCost.amount,
        currency,
        costClass: costClassFor(canonical.category, item.mealType),
        travelers,
      });
      if (cost.clamped) {
        warnings.push({
          code: "cost_clamped",
          message: `The estimate for “${canonical.name}” was adjusted to the typical range for its kind of place.`,
          dayNumber: input.dayNumber,
          itemId: item.itemId,
        });
      }

      lastEnd = item.endTime;

      return {
        id: item.itemId,
        order: index,
        kind: kindForCategory(canonical.category, item.mealType),
        mealType: item.mealType,
        title: item.mealType ? item.title : canonical.name,
        rationale: item.description,
        status: "confirmed",
        place: canonical,
        startTime: item.startTime,
        endTime: item.endTime,
        estimatedCost: cost.amount,
        costNote: `Estimate for the whole party · ${item.estimatedCost.confidence} confidence`,
        costEstimate: buildCostEstimate({
          amount: cost.amount,
          currency,
          confidence: item.estimatedCost.confidence,
        }),
        bookingRequired: item.reservationRecommended,
        tip: item.notes ?? null,
        // Re-keyed by `rekeyDaySegments` once the whole day exists.
        travelToNext: null,
        locked: false,
      } satisfies ItineraryItem;
    }

    if (item.kind === "non-place") {
      const amount = nonPlaceCost(item.category, item.estimatedCost.amount, budget);
      lastEnd = item.endTime;

      return {
        id: item.itemId,
        order: index,
        kind: item.category === "free-time" ? "rest" : NON_PLACE_KIND[item.category],
        mealType: null,
        title: item.title,
        rationale: item.description,
        status: "confirmed",
        place: null,
        startTime: item.startTime,
        endTime: item.endTime,
        estimatedCost: amount,
        costNote: amount === 0 ? null : `Estimate for the whole party · low confidence`,
        costEstimate: buildCostEstimate({ amount, currency, confidence: "low" }),
        bookingRequired: false,
        tip: item.notes ?? null,
        travelToNext: null,
        locked: false,
      } satisfies ItineraryItem;
    }

    const startTime = item.startTime ?? lastEnd;
    const endTime = item.endTime ?? addHour(startTime);
    lastEnd = endTime;

    return {
      id: item.itemId,
      order: index,
      kind: "rest",
      mealType: item.mealType ?? null,
      title: "Slot left open",
      rationale: item.reason,
      status: "unavailable",
      place: null,
      startTime,
      endTime,
      estimatedCost: 0,
      costNote: null,
      bookingRequired: false,
      tip: null,
      travelToNext: null,
      locked: false,
    } satisfies ItineraryItem;
  });

  const backups: BackupOption[] = input.result.backups.map((backup) => {
    const canonical = input.canonicalByPlaceId.get(backup.placeId);
    if (!canonical) {
      throw new RefinementBuildError([
        {
          code: "place_outside_pool",
          message: `Backup "${backup.backupId}" has no canonical record.`,
          dayNumber: input.dayNumber,
          placeId: backup.placeId,
        },
      ]);
    }

    const cost = clampPartyCost({
      proposed: backup.estimatedCost?.amount ?? null,
      currency,
      costClass: costClassFor(canonical.category, null),
      travelers,
    });

    return {
      id: backup.backupId,
      title: canonical.name,
      kind: kindForCategory(canonical.category, null),
      reason: backup.reason,
      place: canonical,
      estimatedCost: cost.amount,
    };
  });

  const day = withDerivedDayTotals({
    ...previousDay,
    summary: input.result.summary,
    items,
    backups,
  });

  const days = input.plan.days.map((entry, index) =>
    index === dayIndex ? day : entry,
  );

  return {
    plan: {
      ...input.plan,
      days,
      budget: rebuildBudget(input.plan, days),
    },
    previousDay,
    day,
    warnings,
  };
}

const NON_PLACE_KIND = {
  transport: "transport",
  airport: "transport",
  "free-time": "rest",
  accommodation: "logistics",
} as const satisfies Record<string, ItineraryItem["kind"]>;

/**
 * Free time is free; an accommodation block is zero so the stay is not counted
 * twice; transport is capped at a tenth of the budget. Identical to generation's
 * rule, because a day that was adjusted and a day that was generated must price the
 * same block the same way.
 */
function nonPlaceCost(
  category: "transport" | "free-time" | "airport" | "accommodation",
  proposed: number,
  budget: number,
): number {
  if (category === "free-time" || category === "accommodation") return 0;
  const ceiling = Math.round(budget * 0.1);
  const amount = Number.isFinite(proposed) ? Math.max(0, proposed) : 0;
  return Math.min(ceiling, Math.round(amount * 100) / 100);
}

function addHour(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const total = Math.min(23 * 60 + 59, hours * 60 + minutes + 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
