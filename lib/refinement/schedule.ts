import { minutesOfDay } from "@/lib/ai";
// The file, not the `@/lib/generate` barrel: that barrel re-exports the `server-only`
// pipeline, and this module's client-safety claim has to be true rather than aspirational
// now that the schedule limits are reached from a browser-side repair.
import { STOPS_PER_DAY } from "@/lib/generate/pace-policy";
import type { ItineraryDay, ItineraryItem, Pace } from "@/lib/schemas";

/**
 * The authoritative schedule validator.
 *
 * Generation's `validate-assembly.ts` checks a *model's proposed* day. This checks
 * a **built** day — the `ItineraryItem[]` that is about to become part of a saved
 * plan — and it is the gate every refinement passes through, whatever produced the
 * change.
 *
 * The two are deliberately separate rather than one shared function, because they
 * validate different things at different points: one is a contract with a provider,
 * the other is an invariant of the domain object. They share the *primitives*
 * (`minutesOfDay`, the stop caps) rather than the checks, so a change to the
 * contract cannot silently loosen the invariant.
 *
 * ## What is not checked here
 *
 * Opening hours — deliberately, even though Phase 6B can now read them.
 * `lib/opening-hours` interprets a conservative subset of OSM's syntax and
 * `lib/plan/schedule-report.ts` reports what it finds, but that is a **report**, not a
 * validation gate. A plan whose museum shuts an hour early is still a valid plan: the
 * hours may be years out of date, the parser covers a subset, and refusing to save a
 * trip over an OSM tag would help nobody. So the schedule invariants below are
 * structural, the hours report is advisory, and the traveller decides.
 *
 * Travel feasibility beyond a minimum gap. Whether 20 minutes is enough to cross
 * town is a routing question, and routing has not run at refinement time. The
 * transition floor below is a sanity bound, not a claim.
 */

export const SCHEDULE_LIMITS = {
  /** Below this, a "stop" is not a visit. */
  minItemMinutes: 15,
  /**
   * The gap a schedule must leave between two consecutive stops.
   *
   * Not a routed figure and not presented as one — it is the floor below which the
   * plan is describing teleportation. Ten minutes will not cross a city, but a
   * schedule that leaves *zero* is wrong on its face, and that is what this
   * catches before any routing has happened.
   */
  minTransitionMinutes: 10,
  /** A plan does not cross midnight; days are independent routing units. */
  earliestMinutes: 5 * 60,
  latestMinutes: 23 * 60 + 59,
} as const;

export type ScheduleViolation = {
  code:
    | "invalid_interval"
    | "too_short"
    | "overlap"
    | "insufficient_transition"
    | "outside_day"
    | "stop_cap_exceeded"
    | "meal_coverage_lost";
  message: string;
  itemId?: string;
};

export type ValidateScheduleInput = {
  dayNumber: number;
  items: ItineraryItem[];
  pace: Pace;
  /**
   * Meal types the day is required to keep covering.
   *
   * Derived from the day as it stands, because that is what the traveller has and
   * what a refinement promised not to take away. A day that never had a dinner slot
   * is not required to grow one.
   */
  requiredMealTypes?: (string | null)[];
};

export function validateSchedule(
  input: ValidateScheduleInput,
): ScheduleViolation[] {
  const violations: ScheduleViolation[] = [];

  const scheduled = input.items
    .map((item) => ({
      itemId: item.id,
      start: minutesOfDay(item.startTime),
      end: minutesOfDay(item.endTime),
      startTime: item.startTime,
      endTime: item.endTime,
      /** An unfilled slot is a placeholder, not a visit — it is not a stop. */
      isStop: item.status === "confirmed" && item.place !== null,
      status: item.status,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  for (const entry of scheduled) {
    if (entry.end <= entry.start) {
      violations.push({
        code: "invalid_interval",
        message: `"${entry.itemId}" on day ${input.dayNumber} ends at ${entry.endTime}, which is not after its ${entry.startTime} start.`,
        itemId: entry.itemId,
      });
      continue;
    }

    /**
     * An unavailable slot is exempt from the duration floor: its times are a
     * placeholder for "this would have gone about here", and requiring a
     * fifteen-minute non-visit would be a rule about nothing.
     */
    if (
      entry.status === "confirmed" &&
      entry.end - entry.start < SCHEDULE_LIMITS.minItemMinutes
    ) {
      violations.push({
        code: "too_short",
        message: `"${entry.itemId}" on day ${input.dayNumber} lasts ${entry.end - entry.start} minutes; a stop needs at least ${SCHEDULE_LIMITS.minItemMinutes}.`,
        itemId: entry.itemId,
      });
    }

    if (
      entry.start < SCHEDULE_LIMITS.earliestMinutes ||
      entry.end > SCHEDULE_LIMITS.latestMinutes
    ) {
      violations.push({
        code: "outside_day",
        message: `"${entry.itemId}" on day ${input.dayNumber} runs from ${entry.startTime} to ${entry.endTime}, outside the day's bounds.`,
        itemId: entry.itemId,
      });
    }
  }

  for (let index = 1; index < scheduled.length; index += 1) {
    const previous = scheduled[index - 1];
    const current = scheduled[index];

    if (current.start < previous.end) {
      violations.push({
        code: "overlap",
        message: `On day ${input.dayNumber}, "${current.itemId}" starts at ${current.startTime} while "${previous.itemId}" runs until ${previous.endTime}.`,
        itemId: current.itemId,
      });
      continue;
    }

    // Only between two real visits. A gap either side of a placeholder is not a
    // journey anyone makes.
    if (
      previous.isStop &&
      current.isStop &&
      current.start - previous.end < SCHEDULE_LIMITS.minTransitionMinutes
    ) {
      violations.push({
        code: "insufficient_transition",
        message: `On day ${input.dayNumber}, "${current.itemId}" starts ${current.start - previous.end} minutes after "${previous.itemId}" ends; leave at least ${SCHEDULE_LIMITS.minTransitionMinutes} to get between them.`,
        itemId: current.itemId,
      });
    }
  }

  const stops = scheduled.filter((entry) => entry.isStop).length;
  const cap = STOPS_PER_DAY[input.pace].max;
  if (stops > cap) {
    violations.push({
      code: "stop_cap_exceeded",
      message: `Day ${input.dayNumber} has ${stops} stops; a ${input.pace} pace allows at most ${cap}.`,
    });
  }

  if (input.requiredMealTypes && input.requiredMealTypes.length > 0) {
    const covered = new Set(
      input.items
        .filter((item) => item.mealType !== null)
        .map((item) => item.mealType as string),
    );
    for (const mealType of input.requiredMealTypes) {
      if (mealType === null) continue;
      if (!covered.has(mealType)) {
        violations.push({
          code: "meal_coverage_lost",
          message: `Day ${input.dayNumber} no longer has a ${mealType} stop. A refinement may replace a meal but not remove one.`,
        });
      }
    }
  }

  return violations;
}

/** The meal types a day currently covers, filled or explicitly unavailable. */
export function currentMealTypes(day: ItineraryDay): string[] {
  return [
    ...new Set(
      day.items
        .filter((item) => item.mealType !== null)
        .map((item) => item.mealType as string),
    ),
  ].sort();
}

/** Place-backed, filled stops. The count the pace caps apply to. */
export function countStops(items: ItineraryItem[]): number {
  return items.filter((item) => item.status === "confirmed" && item.place !== null)
    .length;
}

/**
 * Whether every trip day's number and date still line up with the request.
 *
 * A refinement must not move a day. Dates are rebuilt from the request during
 * generation and copied through during refinement, so a mismatch means something
 * rewrote them — which is worth catching loudly rather than shipping a plan whose
 * Tuesday is dated Wednesday.
 */
export function validateDayAlignment(
  days: ItineraryDay[],
  expected: { dayNumber: number; date: string }[],
): ScheduleViolation[] {
  const byNumber = new Map(expected.map((entry) => [entry.dayNumber, entry.date]));

  return days.flatMap((day) => {
    const date = byNumber.get(day.dayNumber);
    if (date === undefined) {
      return [
        {
          code: "outside_day" as const,
          message: `Day ${day.dayNumber} is not part of this trip's dates.`,
        },
      ];
    }
    if (date !== day.date) {
      return [
        {
          code: "outside_day" as const,
          message: `Day ${day.dayNumber} is dated ${day.date}; the trip has it on ${date}.`,
        },
      ];
    }
    return [];
  });
}
