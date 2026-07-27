import {
  buildScheduleAccuracyReport,
  deriveExpectedLegs,
  withDerivedBudget,
  withDerivedDayTotals,
} from "@/lib/plan";
import { invalidatedLegIdsBetween } from "@/lib/refinement/summary";
import { rekeyPlanSegments } from "@/lib/refinement/invalidate-routes";
import {
  currentMealTypes,
  validateSchedule,
} from "@/lib/refinement/schedule";
import {
  PoolValidationError,
  TripPlanSchema,
  assertItineraryUsesPool,
  type ItineraryDay,
  type ItineraryItem,
  type TripGenerationContext,
  type TripPlan,
} from "@/lib/schemas";

import type {
  StructuralEditAction,
  StructuralEditError,
  StructuralEditResult,
  StructuralEditSummary,
  StructuralEditWarning,
} from "./types";

/**
 * The one place a structural edit becomes a plan.
 *
 * ## Why every applier goes through here
 *
 * A promotion and a cross-day move are different edits with the same obligations: re-derive
 * the day totals, re-key the routes, re-validate the schedule of every touched day,
 * re-check the pool, re-parse the plan, and measure what changed rather than report what
 * was intended. Two appliers each doing that would be two chances to forget one — and the
 * one most easily forgotten is the pool check, which is the invariant everything else rests
 * on.
 *
 * ## Measured, not claimed
 *
 * `invalidatedLegIds` comes from comparing the segments before and after, not from an
 * applier saying which it cleared. Phase 6A learned that the hard way: an applier that
 * removes a segment before re-keying can see it reports nothing, beside a plan whose routes
 * have visibly gone.
 *
 * ## Nothing partial escapes
 *
 * Every check runs before a `TripPlan` is returned, and a failure returns errors alone. The
 * caller still holds the plan it passed in, unmodified, because nothing here mutates.
 *
 * ## One deliberate cost: object identity does not survive
 *
 * The final `TripPlanSchema.safeParse` returns *parsed* data, which Zod rebuilds — so unrelated
 * items come back deep-equal rather than `===`. The refinement appliers do keep identity,
 * because they do not re-parse.
 *
 * The parse is kept anyway. A structural edit rearranges the itinerary rather than swapping one
 * field, so it is the change most likely to produce a shape the schema would reject, and
 * catching that here rather than at the store boundary is worth losing a test convenience for.
 * The appliers still return untouched items by reference *into* this function, so preservation
 * is enforced where it is cheap and asserted by deep equality where it is not.
 */

export type CommitInput = {
  action: StructuralEditAction;
  before: TripPlan;
  generation: TripGenerationContext;
  /** The rebuilt days, in trip order. Untouched days must be the same objects. */
  days: ItineraryDay[];
  revisionBefore: number;
  /** Days the edit was aimed at; measured changes are added to these. */
  affectedDays: number[];
  removedBackupIds?: string[];
  /** Days whose schedule must be re-validated, with the baseline to check against. */
  validateDays: { dayNumber: number; baseline: ItineraryDay }[];
  timezone?: string | null;
  warnings?: StructuralEditWarning[];
  /** Retained legacy places, for the widened pool check. Empty for everything else. */
  retainedPlaces?: TripGenerationContext["retainedPlaces"];
  generationOverride?: TripGenerationContext;
  /**
   * A replacement accommodation, when the edit changed it.
   *
   * `undefined` means "leave it alone"; `null` means "this trip no longer has one", which is
   * a real outcome of a pool refresh whose search no longer returns the hotel. The two must
   * be distinguishable, which is why this is not simply optional-nullable on the plan.
   */
  accommodationOverride?: TripPlan["accommodation"] | undefined;
};

export function commitStructuralEdit(input: CommitInput): StructuralEditResult {
  const errors: StructuralEditError[] = [];
  const warnings: StructuralEditWarning[] = [...(input.warnings ?? [])];

  /* -- 1. every touched day must still be a valid day ---------------------- */

  for (const target of input.validateDays) {
    const day = input.days.find((entry) => entry.dayNumber === target.dayNumber);
    if (!day) continue;

    const violations = validateSchedule({
      dayNumber: day.dayNumber,
      items: day.items,
      pace: input.before.request.pace,
      /**
       * The baseline is the day **as it was**.
       *
       * A structural edit may move a meal but not remove the day's only one, and taking the
       * required set from the *new* day would make the check vacuous — it would always
       * pass, because it would be comparing the day to itself.
       */
      requiredMealTypes: currentMealTypes(target.baseline),
    });

    if (violations.length > 0) {
      errors.push({
        code:
          violations[0].code === "meal_coverage_lost"
            ? "schedule_invalid"
            : "schedule_invalid",
        message: violations[0].message,
        dayNumber: day.dayNumber,
        ...(violations[0].itemId ? { itemId: violations[0].itemId } : {}),
      });
    }
  }

  if (errors.length > 0) return { status: "failed", errors };

  /* -- 2. totals, then routes --------------------------------------------- */

  const withTotals = input.days.map((day) =>
    input.validateDays.some((target) => target.dayNumber === day.dayNumber)
      ? withDerivedDayTotals(day)
      : day,
  );

  const rebuilt: TripPlan = {
    ...input.before,
    days: withTotals,
    ...(input.accommodationOverride !== undefined
      ? { accommodation: input.accommodationOverride }
      : {}),
    budget: rebuildBudget(input.before, withTotals),
  };

  /**
   * Re-keyed across the **whole** plan rather than only the touched days.
   *
   * Cheap, and a day that should not have changed but did is exactly the bug worth
   * catching. The policy comes from the generation context, so a relaxed trip is measured
   * against relaxed thresholds however long ago it was generated.
   */
  const rekeyed = rekeyPlanSegments({
    plan: rebuilt,
    policy: input.generation.routingPolicy,
  });

  const invalidatedLegIds = invalidatedLegIdsBetween(input.before, rekeyed.plan);

  /**
   * Adjacencies that did not exist before, measured against the *expected* leg set.
   *
   * Not against the segments the plan happened to hold: a trip whose routes have never been
   * calculated holds none, so every leg would read as newly added and "2 new journeys to
   * measure" would become "eleven". What the traveller needs is the journeys the edit
   * *created*, which is a question about the itinerary's shape rather than about what has been
   * measured so far.
   */
  const legsBefore = new Set(
    deriveExpectedLegs(input.before, input.generation.routingPolicy).map(
      (leg) => leg.id,
    ),
  );
  const addedLegIds = deriveExpectedLegs(
    rekeyed.plan,
    input.generation.routingPolicy,
  )
    .map((leg) => leg.id)
    .filter((legId) => !legsBefore.has(legId));

  /* -- 3. the plan, and the places it references -------------------------- */

  const parsed = TripPlanSchema.safeParse(rekeyed.plan);
  if (!parsed.success) {
    return {
      status: "failed",
      errors: [
        {
          code: "plan_invalid",
          message: `The edited itinerary did not pass validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        },
      ],
    };
  }

  const generation = input.generationOverride ?? input.generation;
  const retained = (input.retainedPlaces ?? generation.retainedPlaces ?? []).map(
    (entry) => entry.place,
  );

  try {
    assertItineraryUsesPool(
      collectAttachedPlaces(parsed.data),
      generation.placePool,
      retained,
    );
  } catch (error) {
    if (error instanceof PoolValidationError) {
      return {
        status: "failed",
        errors: [
          {
            code: "pool_violation",
            message: error.message,
            ...(error.placeId ? { placeId: error.placeId } : {}),
          },
        ],
      };
    }
    throw error;
  }

  /* -- 4. what the traveller should be told ------------------------------- */

  if (invalidatedLegIds.length > 0) {
    warnings.push({
      code: "routes_invalidated",
      message: `${invalidatedLegIds.length} travel time${invalidatedLegIds.length === 1 ? "" : "s"} no longer described a journey in this itinerary and ${invalidatedLegIds.length === 1 ? "was" : "were"} cleared. Recalculate to measure the new ones.`,
    });
  }

  /**
   * The hours report is recomputed against the **new** dates.
   *
   * A stop that was fine on Tuesday can be shut on Sunday, and moving it is exactly how a
   * traveller would discover that — so the edit succeeds and says so, rather than refusing
   * a move the traveller may want anyway.
   */
  const report = buildScheduleAccuracyReport({
    plan: parsed.data,
    timezone: input.timezone ?? null,
  });

  for (const conflict of report.conflicts) {
    if (!input.affectedDays.includes(conflict.dayNumber)) continue;
    warnings.push({
      code: "hours_conflict_after_edit",
      message: conflict.message,
      dayNumber: conflict.dayNumber,
      itemId: conflict.itemId,
      placeId: conflict.placeId,
    });
  }

  const summary = buildSummary({
    action: input.action,
    before: input.before,
    after: parsed.data,
    invalidatedLegIds,
    addedLegIds,
    removedBackupIds: input.removedBackupIds ?? [],
    affectedDays: input.affectedDays,
    revisionBefore: input.revisionBefore,
  });

  if (warnings.length === 0) {
    return {
      status: "success",
      plan: parsed.data,
      generationContext: generation,
      summary,
    };
  }

  return {
    status: "partial",
    plan: parsed.data,
    generationContext: generation,
    summary,
    warnings,
  };
}

/**
 * What changed, measured by comparing the two plans.
 *
 * Structurally similar to `buildRefinementSummary` and deliberately not shared with it: this
 * one reports leg *additions* and backup *removals*, which a refinement has no concept of,
 * and it reports days rather than preserved item ids, which is what the structural UI shows.
 */
export function buildSummary(input: {
  action: StructuralEditAction;
  before: TripPlan;
  after: TripPlan;
  invalidatedLegIds: string[];
  addedLegIds: string[];
  removedBackupIds: string[];
  affectedDays: number[];
  revisionBefore: number;
}): StructuralEditSummary {
  const beforeItems = indexItems(input.before);
  const afterItems = indexItems(input.after);

  const addedItemIds: string[] = [];
  const removedItemIds: string[] = [];
  const changedItemIds: string[] = [];

  for (const [itemId, entry] of beforeItems) {
    const next = afterItems.get(itemId);
    if (!next) {
      removedItemIds.push(itemId);
      continue;
    }
    // A day change or a time change both count; `order` alone does not, because a
    // renumbering is bookkeeping rather than something a traveller did.
    if (
      entry.dayNumber !== next.dayNumber ||
      entry.item.startTime !== next.item.startTime ||
      entry.item.endTime !== next.item.endTime ||
      entry.item.place?.placeId !== next.item.place?.placeId ||
      entry.item.status !== next.item.status ||
      entry.item.estimatedCost !== next.item.estimatedCost ||
      /**
       * `locked` is compared because for `lock-item` it is the *only* thing that changes.
       *
       * Without it a lock would report zero changed items, the summary would describe an edit that
       * did nothing, and the undo entry would carry a label it could not evidence. `title` and
       * `rationale` stay deliberately absent: they move as a *consequence* of a place swap, which
       * `placeId` already catches.
       */
      entry.item.locked !== next.item.locked
    ) {
      changedItemIds.push(itemId);
    }
  }

  for (const itemId of afterItems.keys()) {
    if (!beforeItems.has(itemId)) addedItemIds.push(itemId);
  }

  const affected = new Set(input.affectedDays);
  for (const itemId of [...addedItemIds, ...changedItemIds]) {
    const entry = afterItems.get(itemId);
    if (entry) affected.add(entry.dayNumber);
  }
  for (const itemId of removedItemIds) {
    const entry = beforeItems.get(itemId);
    if (entry) affected.add(entry.dayNumber);
  }

  return {
    action: input.action,
    affectedDays: [...affected].sort((a, b) => a - b),
    changedItemIds: changedItemIds.sort(),
    addedItemIds: addedItemIds.sort(),
    removedItemIds: removedItemIds.sort(),
    invalidatedLegIds: [...new Set(input.invalidatedLegIds)].sort(),
    addedLegIds: [...new Set(input.addedLegIds)].sort(),
    removedBackupIds: [...input.removedBackupIds].sort(),
    revisionBefore: input.revisionBefore,
  };
}

/**
 * Food and activities re-derived from the items; the rest carried through.
 *
 * The same split every other applier uses. Flights, accommodation and transport are not
 * derivable from items — the schema has no per-item cost category — so recomputing them
 * would mean inventing an attribution rule.
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

function indexItems(
  plan: TripPlan,
): Map<string, { item: ItineraryItem; dayNumber: number }> {
  const index = new Map<string, { item: ItineraryItem; dayNumber: number }>();
  for (const day of plan.days) {
    for (const item of day.items) {
      index.set(item.id, { item, dayNumber: day.dayNumber });
    }
  }
  return index;
}

export function collectAttachedPlaces(plan: TripPlan) {
  const places = plan.days.flatMap((day) => [
    ...day.items.flatMap((item) => (item.place ? [item.place] : [])),
    ...day.backups.map((backup) => backup.place),
  ]);
  if (plan.accommodation) places.push(plan.accommodation.place);
  return places;
}
