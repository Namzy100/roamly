import type { ItineraryItem, TripPlan } from "@/lib/schemas";

import type { RefinementActionType } from "./commands";
import type { RefinementSummary } from "./types";

/**
 * What changed, computed by comparing the two plans.
 *
 * ## Why it is derived rather than accumulated
 *
 * Each handler knows what it did and could report it directly. That report would be
 * a *claim* about the edit; this is a *measurement* of it. If a handler ever changes
 * something it did not mean to — an unrelated day, a stop it thought it preserved —
 * an accumulated summary would say nothing while a derived one shows it, and the
 * traveller is the one who would otherwise find out.
 *
 * It is the same reasoning as `buildRoutingSummary` deriving coverage from the
 * finished plan rather than counting as it goes.
 *
 * ## Identity is by item id
 *
 * A stop that kept its id is the same stop; one with a new id is a different stop,
 * even at the same place. That is what makes a replacement show up as one removal
 * and one addition rather than as a mysterious edit, and it is consistent with how
 * leg identity treats the same distinction.
 */
export function buildRefinementSummary(input: {
  action: RefinementActionType;
  before: TripPlan;
  after: TripPlan;
  invalidatedLegIds: string[];
  revisionBefore: number;
  /** Days the action was aimed at. Measured changes are added to these. */
  affectedDays?: number[];
}): RefinementSummary {
  const beforeItems = indexItems(input.before);
  const afterItems = indexItems(input.after);

  const removedItemIds: string[] = [];
  const addedItemIds: string[] = [];
  const changedItemIds: string[] = [];
  const preservedItemIds: string[] = [];

  for (const [itemId, item] of beforeItems) {
    const next = afterItems.get(itemId);
    if (!next) {
      removedItemIds.push(itemId);
      continue;
    }
    // Reference equality first: the handlers return untouched items as the *same*
    // object, so this is both the common case and the strongest possible signal.
    if (next === item || itemsEqual(item, next)) preservedItemIds.push(itemId);
    else changedItemIds.push(itemId);
  }

  for (const itemId of afterItems.keys()) {
    if (!beforeItems.has(itemId)) addedItemIds.push(itemId);
  }

  const affected = new Set(input.affectedDays ?? []);
  for (const day of input.after.days) {
    for (const item of day.items) {
      if (addedItemIds.includes(item.id) || changedItemIds.includes(item.id)) {
        affected.add(day.dayNumber);
      }
    }
  }
  for (const day of input.before.days) {
    for (const item of day.items) {
      if (removedItemIds.includes(item.id)) affected.add(day.dayNumber);
    }
  }

  return {
    action: input.action,
    changedItemIds: changedItemIds.sort(),
    addedItemIds: addedItemIds.sort(),
    removedItemIds: removedItemIds.sort(),
    preservedItemIds: preservedItemIds.sort(),
    // Deduplicated: a leg can be reported once even if two days touched it.
    invalidatedLegIds: [...new Set(input.invalidatedLegIds)].sort(),
    affectedDays: [...affected].sort((a, b) => a - b),
    previousEstimatedTotal: input.before.budget.total,
    newEstimatedTotal: input.after.budget.total,
    revisionBefore: input.revisionBefore,
  };
}

/**
 * Leg ids whose stored result is in `before` and gone from `after`.
 *
 * **Measured, not reported.** An earlier version asked each handler which legs it had
 * invalidated, and it was wrong in two places: an applier that clears a replaced
 * stop's own segment removes it *before* re-keying can notice, and regeneration builds
 * a fresh plan that never held the old segments at all. Both cases produced an empty
 * list beside a plan whose routes had visibly gone.
 *
 * Comparing the two plans cannot make that mistake: a segment either survived or it
 * did not, whichever code path removed it.
 */
export function invalidatedLegIdsBetween(
  before: TripPlan,
  after: TripPlan,
): string[] {
  const surviving = new Set(segmentIds(after));
  return segmentIds(before).filter((legId) => !surviving.has(legId));
}

function segmentIds(plan: TripPlan): string[] {
  return plan.days.flatMap((day) =>
    day.items.flatMap((item) => (item.travelToNext ? [item.travelToNext.id] : [])),
  );
}

function indexItems(plan: TripPlan): Map<string, ItineraryItem> {
  const index = new Map<string, ItineraryItem>();
  for (const day of plan.days) {
    for (const item of day.items) index.set(item.id, item);
  }
  return index;
}

/**
 * Whether two items with the same id describe the same stop.
 *
 * Compares only what a traveller would notice: the place, the schedule, the money
 * and the status. `travelToNext` is deliberately excluded — a route being
 * invalidated is reported separately as `invalidatedLegIds`, and folding it in here
 * would mark every stop on a rerouted day as "changed" when the stop itself did not
 * move.
 */
function itemsEqual(a: ItineraryItem, b: ItineraryItem): boolean {
  return (
    a.place?.placeId === b.place?.placeId &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.estimatedCost === b.estimatedCost &&
    a.status === b.status &&
    a.title === b.title &&
    a.order === b.order
  );
}
