import { findProhibitedFields } from "./prohibited";
import {
  TripStrategySchema,
  type GenerationViolation,
  type TripStrategy,
} from "./schemas";

/**
 * Strategy validation — everything Zod cannot express.
 *
 * The order matters and is not cosmetic:
 *
 *  1. **prohibited keys, on the raw payload** — before `parse()` strips them and
 *     the evidence disappears (see `prohibited.ts`)
 *  2. **schema** — shape, ranges, the category allowlist
 *  3. **cross-field invariants** — day count against *this* trip, slot ids against
 *     their position, budget shares against 1
 *
 * Violations are collected rather than thrown one at a time, because the whole
 * point is to hand a repair pass one complete report. A model told about three
 * problems fixes three; a model told about the first fixes one and fails again on
 * the second.
 */

export type StrategyValidationInput = {
  /** The raw parsed JSON from the provider, before any Zod work. */
  raw: unknown;
  /** Inclusive day count from the validated `TripRequest`. Not negotiable. */
  expectedDayCount: number;
};

export type StrategyValidationResult =
  | { ok: true; strategy: TripStrategy; violations: [] }
  | { ok: false; violations: GenerationViolation[] };

/** Shares must reconcile to 1. A cent of slack, not a policy decision. */
export const BUDGET_ALLOCATION_TOLERANCE = 0.02;

/** Enough for a packed day; low enough to bound the Overpass work. */
export const MAX_SLOTS_PER_DAY = 6;

export function validateStrategy(
  input: StrategyValidationInput,
): StrategyValidationResult {
  const violations: GenerationViolation[] = [];

  // 1 — identity and provider facts. Nothing is allowed here: a strategy that
  //     names a business or a coordinate has done the prohibited thing, and this
  //     code is on the unrepairable list.
  for (const finding of findProhibitedFields(input.raw)) {
    violations.push({
      code: "prohibited_field",
      message: `Strategy output contained the field "${finding.path}", which a planning strategy may never assert. Categories and areas only — never places, coordinates, ratings, prices or routes.`,
    });
  }
  if (violations.length > 0) return { ok: false, violations };

  // 2 — shape.
  const parsed = TripStrategySchema.safeParse(input.raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 12)) {
      violations.push({
        code: "strategy_schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      });
    }
    return { ok: false, violations };
  }
  const strategy = parsed.data;

  // 3 — cross-field invariants.
  violations.push(...validateDayCoverage(strategy, input.expectedDayCount));
  violations.push(...validateSlots(strategy));
  violations.push(...validateBudgetAllocation(strategy));

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, strategy, violations: [] };
}

/**
 * Exactly one entry per trip day, numbered 1..n.
 *
 * A model that returns six days for a five-day trip has not made a rounding
 * error — it has planned a different trip, and quietly dropping the sixth day
 * would hand the traveller an itinerary that is missing whatever the model
 * considered important enough to put there.
 */
function validateDayCoverage(
  strategy: TripStrategy,
  expectedDayCount: number,
): GenerationViolation[] {
  const violations: GenerationViolation[] = [];

  if (strategy.days.length !== expectedDayCount) {
    violations.push({
      code: "strategy_day_count",
      message: `This trip has exactly ${expectedDayCount} day${expectedDayCount === 1 ? "" : "s"}, but the strategy described ${strategy.days.length}. Produce one entry per day, numbered 1 to ${expectedDayCount}.`,
    });
  }

  const seen = new Set<number>();
  for (const day of strategy.days) {
    if (day.dayNumber < 1 || day.dayNumber > expectedDayCount) {
      violations.push({
        code: "strategy_day_number",
        message: `Day ${day.dayNumber} is outside this trip, which runs from day 1 to day ${expectedDayCount}.`,
        dayNumber: day.dayNumber,
      });
      continue;
    }
    if (seen.has(day.dayNumber)) {
      violations.push({
        code: "strategy_duplicate_day",
        message: `Day ${day.dayNumber} was described more than once.`,
        dayNumber: day.dayNumber,
      });
      continue;
    }
    seen.add(day.dayNumber);
  }

  for (let dayNumber = 1; dayNumber <= expectedDayCount; dayNumber += 1) {
    if (!seen.has(dayNumber)) {
      violations.push({
        code: "strategy_missing_day",
        message: `Day ${dayNumber} was not described at all.`,
        dayNumber,
      });
    }
  }

  return violations;
}

/**
 * Slot ids are positional, and the position is checked.
 *
 * `d3-s2` must be the second requirement of day three. Accepting any unique
 * string would work right up until assembly referenced a slot that existed in a
 * different day's list, at which point the two calls would be talking past each
 * other with no way to notice.
 */
function validateSlots(strategy: TripStrategy): GenerationViolation[] {
  const violations: GenerationViolation[] = [];
  const globalIds = new Set<string>();

  for (const day of strategy.days) {
    if (day.searchRequirements.length > MAX_SLOTS_PER_DAY) {
      violations.push({
        code: "strategy_slot_count",
        message: `Day ${day.dayNumber} requested ${day.searchRequirements.length} slots; at most ${MAX_SLOTS_PER_DAY} are allowed.`,
        dayNumber: day.dayNumber,
      });
    }

    const mealTypes = new Set<string>();

    day.searchRequirements.forEach((slot, index) => {
      const expectedId = `d${day.dayNumber}-s${index + 1}`;
      if (slot.slotId !== expectedId) {
        violations.push({
          code: "strategy_slot_id",
          message: `Slot ids are positional: requirement ${index + 1} of day ${day.dayNumber} must be "${expectedId}", not "${slot.slotId}".`,
          dayNumber: day.dayNumber,
          slotId: slot.slotId,
        });
      }

      if (globalIds.has(slot.slotId)) {
        violations.push({
          code: "strategy_duplicate_slot",
          message: `Slot "${slot.slotId}" appears more than once across the trip.`,
          slotId: slot.slotId,
        });
      }
      globalIds.add(slot.slotId);

      if (slot.mealType !== null) {
        if (mealTypes.has(slot.mealType)) {
          violations.push({
            code: "strategy_duplicate_meal",
            message: `Day ${day.dayNumber} has two ${slot.mealType} slots. One per meal per day.`,
            dayNumber: day.dayNumber,
            slotId: slot.slotId,
          });
        }
        mealTypes.add(slot.mealType);
      }
    });
  }

  return violations;
}

/**
 * Shares that add up.
 *
 * The check is on the raw shares rather than on money, so it holds regardless of
 * budget or currency, and it runs before anything is multiplied out — a set of
 * shares summing to 1.4 would otherwise produce a plan 40 % over budget with
 * every individual figure looking reasonable.
 */
function validateBudgetAllocation(
  strategy: TripStrategy,
): GenerationViolation[] {
  const shares = Object.values(strategy.budgetAllocation);
  const total = shares.reduce((sum, share) => sum + share, 0);

  if (Math.abs(total - 1) > BUDGET_ALLOCATION_TOLERANCE) {
    return [
      {
        code: "strategy_budget_allocation",
        message: `Budget shares must add up to 1.0 (they are fractions of the total budget); these add up to ${total.toFixed(3)}.`,
      },
    ];
  }
  return [];
}
