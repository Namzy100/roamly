import { findProhibitedFields } from "@/lib/ai";
import { withDerivedBudget, withDerivedDayTotals } from "@/lib/plan";
import {
  TripPlanSchema,
  assertItineraryUsesPool,
  PoolValidationError,
  tripDayCount,
  type Currency,
  type ItineraryDay,
  type TripPlace,
  type TripPlan,
  type VerifiedPlacePool,
} from "@/lib/schemas";
import { addDays, format, parseISO } from "date-fns";

import {
  AdjustDayResultSchema,
  ReplaceBackupResultSchema,
  ReplaceItemResultSchema,
  type AdjustDayResult,
  type ReplaceBackupResult,
  type ReplaceItemResult,
} from "./schemas";
import {
  countStops,
  currentMealTypes,
  validateDayAlignment,
  validateSchedule,
} from "./schedule";
import type { RefinementError } from "./types";

/**
 * Refinement validation.
 *
 * Two layers, and the second is the one that matters most.
 *
 * **Model output** is checked the same way generation checks it: prohibited keys on
 * the raw payload first (before Zod strips them), then the schema, then pool
 * membership and category agreement. Identical discipline, because a refinement is
 * just as capable of naming a place that does not exist as a first generation is.
 *
 * **The built plan** is then checked as a whole — the pool gate, the schema, day
 * alignment, and every day's schedule. A refinement touches one day, so it would be
 * tempting to validate only that day; the plan is revalidated entirely because a
 * cheap check that covers the blast radius of a bug is worth more than a narrow one
 * that assumes the bug is where we expected.
 *
 * ## Verifying the action's own promise
 *
 * The distinctive part. "Make this day cheaper" is a claim, and a model can return a
 * perfectly valid day that costs more. So each adjustment is checked against what it
 * said it would do: cheaper means the day total went down, more-relaxed means the
 * stop count did not go up, more-packed means it did not exceed the pace cap. A
 * refinement that did not do what the button said is a failure, not a result.
 */

export type ModelValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: RefinementError[] };

/* -------------------------------------------------------------------------- */
/* Model output                                                               */
/* -------------------------------------------------------------------------- */

export function validateReplaceItemResult(input: {
  raw: unknown;
  eligible: TripPlace[];
  currency: Currency;
  /** When the traveller asked for cheaper, the figure it has to beat. */
  cheaperThan?: number;
}): ModelValidation<ReplaceItemResult> {
  const prohibited = scanProhibited(input.raw);
  if (prohibited.length > 0) return { ok: false, errors: prohibited };

  const parsed = ReplaceItemResultSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        {
          code: "schema_invalid",
          message: `Replacement did not match its contract: ${describeIssue(parsed.error)}`,
        },
      ],
    };
  }

  // Bound to a local so the discriminant narrows across the checks below; a
  // property access on `parsed.data` re-widens at each statement.
  const result = parsed.data;
  if (result.status === "unavailable") return { ok: true, value: result };

  const errors: RefinementError[] = [];
  const chosen = input.eligible.find((place) => place.placeId === result.placeId);

  if (!chosen) {
    // Unrepairable by construction: the model was handed the complete eligible list.
    errors.push({
      code: "place_outside_pool",
      message: `"${result.placeId}" was not one of the alternatives offered for this stop.`,
      placeId: result.placeId,
    });
  }

  errors.push(...validateCostClaims(result.estimatedCost, input.currency));

  if (
    input.cheaperThan !== undefined &&
    result.estimatedCost.amount > input.cheaperThan
  ) {
    errors.push({
      code: "action_not_honoured",
      message: `A cheaper alternative was requested, but the replacement is estimated at ${result.estimatedCost.amount} against ${input.cheaperThan}.`,
    });
  }

  if ((result.startTime === undefined) !== (result.endTime === undefined)) {
    errors.push({
      code: "schedule_invalid",
      message:
        "A replacement may keep the original time window or supply a new one, but not half of one.",
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: result };
}

export function validateReplaceBackupResult(input: {
  raw: unknown;
  eligible: TripPlace[];
  currency: Currency;
}): ModelValidation<ReplaceBackupResult> {
  const prohibited = scanProhibited(input.raw);
  if (prohibited.length > 0) return { ok: false, errors: prohibited };

  const parsed = ReplaceBackupResultSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        {
          code: "schema_invalid",
          message: `Backup replacement did not match its contract: ${describeIssue(parsed.error)}`,
        },
      ],
    };
  }

  const result = parsed.data;
  if (result.status === "unavailable") return { ok: true, value: result };

  const errors: RefinementError[] = [];
  if (!input.eligible.some((place) => place.placeId === result.placeId)) {
    errors.push({
      code: "place_outside_pool",
      message: `"${result.placeId}" was not one of the alternatives offered for this backup.`,
      placeId: result.placeId,
    });
  }

  if (result.estimatedCost) {
    errors.push(...validateCostClaims(result.estimatedCost, input.currency));
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: result };
}

export function validateAdjustDayResult(input: {
  raw: unknown;
  dayNumber: number;
  eligible: TripPlace[];
  /** Places already in the day, which may legitimately be kept. */
  retained: TripPlace[];
  currency: Currency;
  /** Item ids used elsewhere in the trip, which this day must not reuse. */
  itemIdsElsewhere: Set<string>;
}): ModelValidation<AdjustDayResult> {
  const prohibited = scanProhibited(input.raw);
  if (prohibited.length > 0) return { ok: false, errors: prohibited };

  const parsed = AdjustDayResultSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: [
        {
          code: "schema_invalid",
          message: `Day adjustment did not match its contract: ${describeIssue(parsed.error)}`,
        },
      ],
    };
  }

  const result = parsed.data;
  if (result.status === "unavailable") return { ok: true, value: result };

  const errors: RefinementError[] = [];

  if (result.dayNumber !== input.dayNumber) {
    errors.push({
      code: "day_not_found",
      message: `The adjustment is for day ${result.dayNumber}, but day ${input.dayNumber} was asked about.`,
      dayNumber: input.dayNumber,
    });
  }

  /**
   * A place may be kept or swapped, so both the eligible alternatives and the
   * places already in the day are acceptable. Anything else was never offered.
   */
  const allowed = new Map(
    [...input.eligible, ...input.retained].map((place) => [place.placeId, place]),
  );

  const seenItemIds = new Set<string>();
  const seenPlaceIds = new Set<string>();

  for (const item of result.items) {
    if (input.itemIdsElsewhere.has(item.itemId) || seenItemIds.has(item.itemId)) {
      errors.push({
        code: "schema_invalid",
        message: `Item id "${item.itemId}" is already in use. Ids must be unique across the trip.`,
        dayNumber: input.dayNumber,
        itemId: item.itemId,
      });
    }
    seenItemIds.add(item.itemId);

    if (item.kind !== "unavailable") {
      errors.push(...validateCostClaims(item.estimatedCost, input.currency));
    }

    if (item.kind !== "place") continue;

    const canonical = allowed.get(item.placeId);
    if (!canonical) {
      errors.push({
        code: "place_outside_pool",
        message: `"${item.placeId}" was not among the places available for day ${input.dayNumber}.`,
        dayNumber: input.dayNumber,
        placeId: item.placeId,
      });
      continue;
    }

    if (canonical.category !== item.category) {
      errors.push({
        code: "schema_invalid",
        message: `"${item.placeId}" is a ${canonical.category} but was scheduled as a ${item.category}.`,
        dayNumber: input.dayNumber,
        placeId: item.placeId,
      });
    }

    if (seenPlaceIds.has(item.placeId)) {
      errors.push({
        code: "schema_invalid",
        message: `"${item.placeId}" appears twice on day ${input.dayNumber}.`,
        dayNumber: input.dayNumber,
        placeId: item.placeId,
      });
    }
    seenPlaceIds.add(item.placeId);
  }

  for (const backup of result.backups) {
    if (!allowed.has(backup.placeId)) {
      errors.push({
        code: "place_outside_pool",
        message: `Backup "${backup.backupId}" refers to "${backup.placeId}", which was not offered.`,
        dayNumber: input.dayNumber,
        placeId: backup.placeId,
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: result };
}

/* -------------------------------------------------------------------------- */
/* The built plan                                                             */
/* -------------------------------------------------------------------------- */

export type PlanValidationInput = {
  plan: TripPlan;
  pool: VerifiedPlacePool;
  /** Days whose schedules changed. Others are still checked; this only scopes messages. */
  affectedDays?: number[];
};

/**
 * Everything a refined plan must satisfy before it may be saved.
 *
 * Ordered cheapest-first so a schema failure is not buried under a schedule report,
 * and the pool gate runs last because it is the one whose failure means "a place got
 * in that should not have" — the loudest possible outcome, and worth reaching with
 * everything else already known good.
 */
export function validateRefinedPlan(
  input: PlanValidationInput,
): RefinementError[] {
  const errors: RefinementError[] = [];

  const parsed = TripPlanSchema.safeParse(input.plan);
  if (!parsed.success) {
    return [
      {
        code: "plan_invalid",
        message: `The refined plan is not a valid trip: ${describeIssue(parsed.error)}`,
      },
    ];
  }
  const plan = parsed.data;

  errors.push(
    ...validateDayAlignment(plan.days, expectedDayDates(plan)).map((violation) => ({
      code: "plan_invalid" as const,
      message: violation.message,
    })),
  );

  for (const day of plan.days) {
    /**
     * No `requiredMealTypes` here, deliberately.
     *
     * This validator sees only the finished plan, so the only baseline available to it
     * would be the day's *own* meals — which makes the check vacuous: a day that
     * dropped its breakfast simply no longer requires one. Meal coverage is a
     * *relative* claim and is checked against the previous day in
     * `validateAdjustmentHonoured`, which has both.
     */
    const violations = validateSchedule({
      dayNumber: day.dayNumber,
      items: day.items,
      pace: plan.request.pace,
    });

    for (const violation of violations) {
      errors.push({
        code:
          violation.code === "stop_cap_exceeded"
            ? "stop_cap_exceeded"
            : violation.code === "meal_coverage_lost"
              ? "meal_coverage_lost"
              : "schedule_invalid",
        message: violation.message,
        dayNumber: day.dayNumber,
        ...(violation.itemId ? { itemId: violation.itemId } : {}),
      });
    }

    // Derived totals must agree with the items they are derived from. A refinement
    // that forgot to recompute would otherwise ship a day whose total is stale.
    const recomputed = withDerivedDayTotals(day);
    if (recomputed.dayTotal !== day.dayTotal) {
      errors.push({
        code: "plan_invalid",
        message: `Day ${day.dayNumber} reports ${day.dayTotal} but its items sum to ${recomputed.dayTotal}.`,
        dayNumber: day.dayNumber,
      });
    }
    if (recomputed.totalTravelMinutes !== day.totalTravelMinutes) {
      errors.push({
        code: "plan_invalid",
        message: `Day ${day.dayNumber} reports ${day.totalTravelMinutes} travel minutes but its segments sum to ${recomputed.totalTravelMinutes}.`,
        dayNumber: day.dayNumber,
      });
    }
  }

  const budget = withDerivedBudget(plan.budget, plan.days, plan.request.travelers);
  if (budget.total !== plan.budget.total) {
    errors.push({
      code: "plan_invalid",
      message: `The budget total is ${plan.budget.total} but its categories sum to ${budget.total}.`,
    });
  }

  try {
    assertItineraryUsesPool(collectAttached(plan), input.pool);
  } catch (error) {
    if (error instanceof PoolValidationError) {
      errors.push({
        code: "pool_violation",
        message: error.message,
        ...(error.placeId ? { placeId: error.placeId } : {}),
      });
    } else {
      throw error;
    }
  }

  return errors;
}

/**
 * Every preserved place and item actually survived.
 *
 * A preserve constraint the model merely received is a preference; one that is
 * checked afterwards is a guarantee, and this is where it becomes the latter.
 */
export function validatePreserved(input: {
  plan: TripPlan;
  preserve?: { placeIds?: string[]; itemIds?: string[] };
}): RefinementError[] {
  if (!input.preserve) return [];

  const placeIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const day of input.plan.days) {
    for (const item of day.items) {
      itemIds.add(item.id);
      if (item.place) placeIds.add(item.place.placeId);
    }
  }

  const errors: RefinementError[] = [];
  for (const placeId of input.preserve.placeIds ?? []) {
    if (!placeIds.has(placeId)) {
      errors.push({
        code: "preserve_violated",
        message: `"${placeId}" was marked to keep but is not in the new itinerary.`,
        placeId,
      });
    }
  }
  for (const itemId of input.preserve.itemIds ?? []) {
    if (!itemIds.has(itemId)) {
      errors.push({
        code: "preserve_violated",
        message: `Stop "${itemId}" was marked to keep but is not in the new itinerary.`,
        itemId,
      });
    }
  }

  return errors;
}

/**
 * The adjustment did what its button said.
 *
 * Checked against the *previous* day, so the claim is relative and cannot be
 * satisfied by coincidence. A "cheaper" day that stayed exactly the same price is
 * accepted — nothing got worse, and demanding a strict decrease would fail a day
 * that was already at its floor.
 */
export function validateAdjustmentHonoured(input: {
  adjustment: "cheaper" | "more-relaxed" | "more-packed";
  before: ItineraryDay;
  after: ItineraryDay;
  pace: TripPlan["request"]["pace"];
  stopCap: number;
}): RefinementError[] {
  const beforeStops = countStops(input.before.items);
  const afterStops = countStops(input.after.items);

  /**
   * Meal coverage, against the day as it was.
   *
   * The baseline has to be the *previous* day: a validator that asks the new day which
   * meals it requires will always be satisfied, because a day that dropped its
   * breakfast no longer claims to have one. An adjustment may move a meal or swap
   * where it happens; it may not quietly delete one.
   */
  const mealErrors = validateMealCoverage(input.before, input.after);
  if (mealErrors.length > 0) return mealErrors;

  switch (input.adjustment) {
    case "cheaper":
      if (input.after.dayTotal > input.before.dayTotal) {
        return [
          {
            code: "action_not_honoured",
            message: `Day ${input.after.dayNumber} was asked to be cheaper but went from ${input.before.dayTotal} to ${input.after.dayTotal}.`,
            dayNumber: input.after.dayNumber,
          },
        ];
      }
      return [];

    case "more-relaxed":
      if (afterStops > beforeStops) {
        return [
          {
            code: "action_not_honoured",
            message: `Day ${input.after.dayNumber} was asked to be more relaxed but went from ${beforeStops} stops to ${afterStops}.`,
            dayNumber: input.after.dayNumber,
          },
        ];
      }
      return [];

    case "more-packed":
      if (afterStops > input.stopCap) {
        return [
          {
            code: "stop_cap_exceeded",
            message: `Day ${input.after.dayNumber} would have ${afterStops} stops; a ${input.pace} pace allows at most ${input.stopCap}.`,
            dayNumber: input.after.dayNumber,
          },
        ];
      }
      if (afterStops < beforeStops) {
        return [
          {
            code: "action_not_honoured",
            message: `Day ${input.after.dayNumber} was asked to be fuller but went from ${beforeStops} stops to ${afterStops}.`,
            dayNumber: input.after.dayNumber,
          },
        ];
      }
      return [];
  }
}

/**
 * Every meal the day used to cover, it must still cover.
 *
 * An `unavailable` slot counts as coverage when it carries the meal type: "no
 * restaurant was available for dinner" is a visible, honest gap, whereas dinner simply
 * vanishing from the day is not.
 */
export function validateMealCoverage(
  before: ItineraryDay,
  after: ItineraryDay,
): RefinementError[] {
  const covered = new Set(
    after.items
      .filter((item) => item.mealType !== null)
      .map((item) => item.mealType as string),
  );

  return currentMealTypes(before)
    .filter((mealType) => !covered.has(mealType))
    .map((mealType) => ({
      code: "meal_coverage_lost" as const,
      message: `Day ${after.dayNumber} no longer has a ${mealType} stop. An adjustment may move or swap a meal, but not remove one.`,
      dayNumber: after.dayNumber,
    }));
}

/* -------------------------------------------------------------------------- */

/**
 * `placeId` is the one identity field a refinement may use. Everything else in the
 * prohibited list stays banned, which is what stops a name or a coordinate arriving
 * beside the id.
 */
function scanProhibited(raw: unknown): RefinementError[] {
  return findProhibitedFields(raw, { allow: ["placeId"] }).map((finding) => ({
    code: "prohibited_field" as const,
    message: `Refinement output contained the field "${finding.path}". Reference places by placeId only — names, coordinates, ratings and route figures are the server's.`,
  }));
}

function validateCostClaims(
  cost: { amount: number; currency: string; basis: string },
  currency: Currency,
): RefinementError[] {
  const errors: RefinementError[] = [];

  if (cost.basis !== "category-estimate") {
    errors.push({
      code: "cost_basis_invalid",
      message: `A refined cost claims a basis of "${cost.basis}". Every generated cost is a planning estimate.`,
    });
  }
  if (cost.currency !== currency) {
    errors.push({
      code: "cost_basis_invalid",
      message: `A refined cost is priced in ${cost.currency}; this trip's budget is in ${currency}. Do not convert.`,
    });
  }
  if (!Number.isFinite(cost.amount) || cost.amount < 0) {
    errors.push({
      code: "cost_basis_invalid",
      message: "A refined cost has an unusable amount.",
    });
  }

  return errors;
}

function collectAttached(plan: TripPlan): TripPlace[] {
  const places = plan.days.flatMap((day) => [
    ...day.items.flatMap((item) => (item.place ? [item.place] : [])),
    ...day.backups.map((backup) => backup.place),
  ]);
  const stay = plan.accommodation?.place;
  return stay ? [...places, stay] : places;
}

/** Day numbers and dates rebuilt from the request, which a refinement may not move. */
export function expectedDayDates(
  plan: TripPlan,
): { dayNumber: number; date: string }[] {
  const start = parseISO(plan.request.startDate);
  return Array.from({ length: tripDayCount(plan.request) }, (_, index) => ({
    dayNumber: index + 1,
    date: format(addDays(start, index), "yyyy-MM-dd"),
  }));
}

function describeIssue(error: { issues: { path: unknown[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return "unknown";
  return `${issue.path.join(".") || "(root)"} — ${issue.message}`;
}
