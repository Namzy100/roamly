import {
  buildCostEstimate,
  clampPartyCost,
  costClassFor,
  withDerivedBudget,
  withDerivedDayTotals,
} from "@/lib/plan";
// The file, not the `@/lib/generate` barrel: that barrel re-exports the `server-only`
// pipeline, and this module is reached from the browser through the Phase 6B repairs.
import { kindForCategory } from "@/lib/generate/assemble-plan";
import type {
  ItineraryDay,
  ItineraryItem,
  TripPlace,
  TripPlan,
} from "@/lib/schemas";

import type { ReplaceItemResult } from "./schemas";
import type { RefinementError, RefinementWarning } from "./types";

/**
 * Swapping one stop for another, and preserving everything else exactly.
 *
 * ## What "preserved" means here
 *
 * Every other item is returned **by reference**. Not cloned, not rebuilt from its
 * fields — the same object. That is deliberate and it is checkable: a test can
 * assert `after.days[0].items[2] === before.days[0].items[2]`, which is a far
 * stronger statement than deep equality. If a future change starts rebuilding
 * unrelated items, the test fails and someone has to say why.
 *
 * The same applies to unaffected days: `plan.days[n]` is the original object unless
 * `n` is the day being edited.
 *
 * ## The canonical record
 *
 * The chosen place is taken from the pool and attached whole. The model supplied a
 * `placeId`, a description, a cost and a time window; it supplied nothing about the
 * place, and there is no code path here that would let it.
 *
 * ## The time window
 *
 * Kept from the item being replaced unless the model asked to move it. A like-for-
 * like swap should not silently reschedule the day, and a replacement that *does*
 * need a different window has to say so and then survive the schedule validator.
 */

export type ReplaceItemInput = {
  plan: TripPlan;
  dayNumber: number;
  itemId: string;
  /** Already validated as a member of the eligible subset. */
  chosen: TripPlace;
  result: Extract<ReplaceItemResult, { status: "selected" }>;
};

export type ReplaceItemOutcome = {
  plan: TripPlan;
  /** The day the edit landed on, before the edit. For the summary and the checks. */
  previousDay: ItineraryDay;
  replacedItemId: string;
  warnings: RefinementWarning[];
};

export class RefinementBuildError extends Error {
  readonly errors: RefinementError[];

  constructor(errors: RefinementError[]) {
    super(errors[0]?.message ?? "Refinement could not be built");
    this.name = "RefinementBuildError";
    this.errors = errors;
  }
}

export function applyItemReplacement(
  input: ReplaceItemInput,
): ReplaceItemOutcome {
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
  const itemIndex = previousDay.items.findIndex((item) => item.id === input.itemId);
  if (itemIndex === -1) {
    throw new RefinementBuildError([
      {
        code: "item_not_found",
        message: `Stop "${input.itemId}" is not on day ${input.dayNumber}.`,
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    ]);
  }

  const original = previousDay.items[itemIndex];
  const warnings: RefinementWarning[] = [];

  const mealType = original.mealType;
  const cost = clampPartyCost({
    proposed: input.result.estimatedCost.amount,
    currency: input.plan.request.currency,
    costClass: costClassFor(input.chosen.category, mealType),
    travelers: input.plan.request.travelers,
  });

  if (cost.clamped) {
    warnings.push({
      code: "cost_clamped",
      message: `The estimate for “${input.chosen.name}” was adjusted to the typical range for its kind of place.`,
      dayNumber: input.dayNumber,
      itemId: original.id,
    });
  }

  /**
   * A **new** item id.
   *
   * Tempting to reuse the old one — it would keep the leg ids stable and avoid
   * invalidating routes. That is exactly why it must not be done: the routes for the
   * old stop measured journeys to a different place, and reusing the id would let
   * them survive re-keying and put real geometry on a journey nobody makes. A new id
   * makes the invalidation automatic and correct.
   */
  const replacement: ItineraryItem = {
    locked: false,
    id: nextItemId(input.plan, original.id),
    order: original.order,
    kind: kindForCategory(input.chosen.category, mealType),
    mealType,
    title: titleFor(input.result, input.chosen, original),
    rationale: input.result.description,
    status: "confirmed",
    // The pool's record, attached unchanged.
    place: input.chosen,
    startTime: input.result.startTime ?? original.startTime,
    endTime: input.result.endTime ?? original.endTime,
    estimatedCost: cost.amount,
    costNote: `Estimate for the whole party · ${input.result.estimatedCost.confidence} confidence`,
    costEstimate: buildCostEstimate({
      amount: cost.amount,
      currency: input.plan.request.currency,
      confidence: input.result.estimatedCost.confidence,
    }),
    bookingRequired: input.result.reservationRecommended,
    tip: input.result.notes ?? null,
    /**
     * No travel. The leg leaving this stop measured a journey from a different
     * place, and `rekeyDaySegments` will assign whatever the new adjacency
     * legitimately has — which is nothing, until routing runs again.
     */
    travelToNext: null,
  };

  // Everything except the replaced item is the same object it was.
  const items = previousDay.items.map((item, index) =>
    index === itemIndex ? replacement : item,
  );

  const day = withDerivedDayTotals({ ...previousDay, items });
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
    replacedItemId: original.id,
    warnings,
  };
}

/**
 * Marks an item unavailable, keeping its place in the day.
 *
 * Used when the model reports that nothing eligible fits. The slot stays visible
 * with the reason attached, which is the same choice generation makes — a traveller
 * who asked for an alternative and got silence would not know whether the request
 * failed or the day changed.
 */
export function applyItemUnavailable(input: {
  plan: TripPlan;
  dayNumber: number;
  itemId: string;
  reason: string;
}): ReplaceItemOutcome {
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
  const itemIndex = previousDay.items.findIndex((item) => item.id === input.itemId);
  if (itemIndex === -1) {
    throw new RefinementBuildError([
      {
        code: "item_not_found",
        message: `Stop "${input.itemId}" is not on day ${input.dayNumber}.`,
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    ]);
  }

  const original = previousDay.items[itemIndex];

  const gap: ItineraryItem = {
    ...original,
    status: "unavailable",
    place: null,
    title: `${original.title} — no alternative found`,
    rationale: input.reason,
    estimatedCost: 0,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
  };
  delete (gap as { costEstimate?: unknown }).costEstimate;

  const items = previousDay.items.map((item, index) =>
    index === itemIndex ? gap : item,
  );
  const day = withDerivedDayTotals({ ...previousDay, items });
  const days = input.plan.days.map((entry, index) =>
    index === dayIndex ? day : entry,
  );

  return {
    plan: { ...input.plan, days, budget: rebuildBudget(input.plan, days) },
    previousDay,
    replacedItemId: original.id,
    warnings: [
      {
        code: "replacement_unavailable",
        message: input.reason,
        dayNumber: input.dayNumber,
        itemId: original.id,
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */

/**
 * A fresh, collision-free item id derived from the old one.
 *
 * Deterministic rather than random: the same replacement always produces the same
 * id, which keeps refinement reproducible and makes a failing test say the same
 * thing twice. The `-r{n}` suffix survives `leg-id`'s charset rules (no colon) and
 * the counter climbs until the id is unused anywhere in the trip.
 */
export function nextItemId(plan: TripPlan, baseId: string): string {
  const used = new Set(
    plan.days.flatMap((day) => day.items.map((item) => item.id)),
  );

  // Strip an existing suffix so a stop replaced three times does not become
  // `x-r1-r1-r1`.
  const root = baseId.replace(/-r\d+$/, "");

  for (let attempt = 1; attempt < 1_000; attempt += 1) {
    const candidate = `${root}-r${attempt}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new RefinementBuildError([
    {
      code: "item_not_replaceable",
      message: `Could not derive a free item id from "${baseId}".`,
    },
  ]);
}

/**
 * The card's heading.
 *
 * A meal keeps its meal-shaped title — "Lunch" is the right heading whichever
 * restaurant fills it — and anything else takes the canonical place name, which is a
 * provider fact and better than a model's paraphrase of one.
 */
function titleFor(
  result: Extract<ReplaceItemResult, { status: "selected" }>,
  chosen: TripPlace,
  original: ItineraryItem,
): string {
  if (original.mealType !== null) return original.title;
  return chosen.name;
}

/**
 * Food and activities re-derived from the items; the rest carried through.
 *
 * The same split `assemble-plan.ts` uses, so a replacement moves money between the
 * two categories exactly as generation would have. Flights, accommodation and
 * transport are untouched — a stop swap does not change what a flight costs.
 */
function rebuildBudget(plan: TripPlan, days: ItineraryDay[]) {
  const sum = (predicate: (item: ItineraryItem) => boolean) =>
    Math.round(
      days
        .flatMap((day) => day.items)
        .filter(predicate)
        .reduce((total, item) => total + item.estimatedCost, 0) * 100,
    ) / 100;

  return withDerivedBudget(
    {
      ...plan.budget,
      food: sum((item) => item.kind === "meal"),
      activities: sum(
        (item) =>
          item.kind !== "meal" &&
          item.kind !== "transport" &&
          item.kind !== "logistics",
      ),
    },
    days,
    plan.request.travelers,
  );
}

export { rebuildBudget };
