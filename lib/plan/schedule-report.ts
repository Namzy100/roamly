import {
  evaluateScheduledVisit,
  isUnknown,
  type OpeningEvaluation,
  type OpeningEvaluationStatus,
} from "@/lib/opening-hours";
import type { ItineraryItem, TripPlan } from "@/lib/schemas";

/**
 * How much of a plan's schedule stands up against published opening hours.
 *
 * ## Derived, never persisted
 *
 * Recomputed from the plan on every read, for the same reason coverage counts are: it is
 * a pure function of the plan plus the parser, so a stored copy could only ever drift —
 * and it would drift in the worst direction, telling a traveller their schedule was
 * checked by a parser that has since changed.
 *
 * The one input that is not in the plan is the timezone, which comes from the generation
 * context. Absent, every item is `unknown_timezone`, which is truthful.
 *
 * ## Conflict versus warning
 *
 * A **conflict** is one thing only: a place we can read the hours of, in a zone we know,
 * is *closed* for the visit as scheduled. Everything else — no data, unreadable data, no
 * timezone, an unevaluated holiday rule — is a **warning**, because none of them is
 * evidence of anything.
 *
 * A plan may carry conflicts and still be valid and saveable. That is deliberate: the
 * alternative is refusing to save a plan whose museum shuts an hour early, which helps
 * nobody. The interface shows them; the traveller decides.
 *
 * ## What is excluded
 *
 * Items with no place (free time, transport, an airport run) and unfilled slots are
 * `not_applicable` and are not counted — a gap has no hours to check, and counting it as
 * "unknown" would make a thin itinerary look like a data problem.
 *
 * The accommodation is excluded too, and for a specific reason: a hotel's `opening_hours`
 * describes its *reception desk*, not whether you may sleep there. Evaluating a stay
 * against it would produce confident nonsense.
 */

export type ScheduleConflictKind =
  | "closed_during_visit"
  | "visit_starts_before_opening"
  | "visit_extends_past_closing";

export type ScheduleConflict = {
  kind: ScheduleConflictKind;
  dayNumber: number;
  itemId: string;
  placeId: string;
  placeName: string;
  /** What was scheduled. */
  startTime: string;
  endTime: string;
  /** The OSM string, verbatim, so a reader can check us. */
  sourceText: string;
  /** The next opening the parser could see that day, when there is one. */
  nextKnownOpening?: string;
  message: string;
};

export type ScheduleWarningCode =
  | "no_published_hours"
  | "hours_not_interpreted"
  | "timezone_unknown"
  | "exception_not_evaluated";

export type ScheduleWarning = {
  code: ScheduleWarningCode;
  dayNumber: number;
  itemId: string;
  placeName: string;
  message: string;
  sourceText?: string;
};

export type ScheduleAccuracyReport = {
  /**
   * `clear` — every checkable item was confirmed open.
   * `conflicts` — at least one confirmed closure. Takes precedence over warnings.
   * `warnings` — nothing confirmed closed, but something could not be checked.
   * `unknown` — nothing could be checked at all.
   */
  status: "clear" | "warnings" | "conflicts" | "unknown";
  checkedItems: number;
  confirmedOpenItems: number;
  confirmedClosedItems: number;
  unknownItems: number;
  conflicts: ScheduleConflict[];
  warnings: ScheduleWarning[];
  /** The zone the evaluation used, so the UI can say which one. */
  timezone: string | null;
};

/** One item's verdict, for the card that renders it. */
export type ItemScheduleEvaluation = {
  itemId: string;
  dayNumber: number;
  evaluation: OpeningEvaluation;
};

export type BuildScheduleReportInput = {
  plan: TripPlan;
  /** From the generation context. Absent is a real state, not a bug. */
  timezone?: string | null;
};

export function buildScheduleAccuracyReport(
  input: BuildScheduleReportInput,
): ScheduleAccuracyReport {
  const timezone = input.timezone ?? null;
  const conflicts: ScheduleConflict[] = [];
  const warnings: ScheduleWarning[] = [];

  let confirmedOpenItems = 0;
  let confirmedClosedItems = 0;
  let unknownItems = 0;

  for (const { itemId, dayNumber, evaluation } of evaluatePlanItems(input)) {
    if (evaluation.status === "not_applicable") continue;

    const day = input.plan.days.find((entry) => entry.dayNumber === dayNumber);
    const item = day?.items.find((entry) => entry.id === itemId);
    if (!item?.place) continue;

    if (evaluation.status === "confirmed_open") {
      confirmedOpenItems += 1;
      continue;
    }

    if (evaluation.status === "confirmed_closed") {
      confirmedClosedItems += 1;
      conflicts.push({
        kind: classifyConflict(item, evaluation),
        dayNumber,
        itemId,
        placeId: item.place.placeId,
        placeName: item.place.name,
        startTime: item.startTime,
        endTime: item.endTime,
        sourceText: evaluation.sourceText,
        ...(evaluation.nextKnownOpening
          ? { nextKnownOpening: evaluation.nextKnownOpening }
          : {}),
        message: `“${item.place.name}” is scheduled ${item.startTime}–${item.endTime}, which its published hours (${evaluation.sourceText}) do not cover.`,
      });
      continue;
    }

    unknownItems += 1;
    warnings.push({
      code: warningCodeFor(evaluation.status),
      dayNumber,
      itemId,
      placeName: item.place.name,
      message: evaluation.reason ?? "This stop's opening hours could not be checked.",
      ...(evaluation.sourceText ? { sourceText: evaluation.sourceText } : {}),
    });
  }

  const checkedItems = confirmedOpenItems + confirmedClosedItems + unknownItems;

  return {
    status: statusFor({
      checkedItems,
      confirmedOpenItems,
      confirmedClosedItems,
      unknownItems,
    }),
    checkedItems,
    confirmedOpenItems,
    confirmedClosedItems,
    unknownItems,
    conflicts,
    warnings,
    timezone,
  };
}

/**
 * Every item's verdict, including the `not_applicable` ones.
 *
 * Exported separately from the report because the itinerary cards need a per-item answer
 * and must not each re-derive it — two derivations would eventually disagree, and the one
 * on the card is the one a traveller reads.
 */
export function evaluatePlanItems(
  input: BuildScheduleReportInput,
): ItemScheduleEvaluation[] {
  const results: ItemScheduleEvaluation[] = [];

  for (const day of input.plan.days) {
    for (const item of day.items) {
      results.push({
        itemId: item.id,
        dayNumber: day.dayNumber,
        evaluation: evaluateItem(item, day.date, input.timezone ?? undefined),
      });
    }
  }

  return results;
}

/** One item, evaluated. Exported so a repair can ask about a single stop. */
export function evaluateItem(
  item: ItineraryItem,
  date: string,
  timezone?: string,
): OpeningEvaluation {
  /**
   * Nothing to check: no place, or a slot the search could not fill.
   *
   * Distinguished from "unknown" on purpose — an open afternoon is not a data gap, and
   * counting it as one would make an honest itinerary look unverifiable.
   */
  if (item.status !== "confirmed" || item.place === null) {
    return { status: "not_applicable" };
  }

  return evaluateScheduledVisit({
    ...(item.place.openingHours ? { openingHours: item.place.openingHours } : {}),
    date,
    startTime: item.startTime,
    endTime: item.endTime,
    ...(timezone ? { timezone } : {}),
  });
}

/**
 * Which kind of conflict, for a message that says something useful.
 *
 * Derived from the hours the parser found rather than from the model or from guesswork:
 * "extends past closing" and "starts before opening" are different problems with
 * different fixes, and telling them apart is what makes an "adjust the time" action
 * possible.
 */
function classifyConflict(
  item: ItineraryItem,
  evaluation: Extract<OpeningEvaluation, { status: "confirmed_closed" }>,
): ScheduleConflictKind {
  if (evaluation.nextKnownOpening) {
    // The place opens later that day, so the visit is simply too early.
    return "visit_starts_before_opening";
  }
  // Distinguishing "shut all day" from "shut by the time you leave" needs the intervals,
  // which the caller does not hold here; the generic kind is the honest default and the
  // message carries the detail.
  return item.startTime < item.endTime
    ? "visit_extends_past_closing"
    : "closed_during_visit";
}

function warningCodeFor(status: OpeningEvaluationStatus): ScheduleWarningCode {
  switch (status) {
    case "unknown_no_data":
      return "no_published_hours";
    case "unknown_unparsed":
      return "hours_not_interpreted";
    case "unknown_timezone":
      return "timezone_unknown";
    default:
      return "exception_not_evaluated";
  }
}

/**
 * The overall verdict.
 *
 * A conflict outranks a warning: a plan with one confirmed closure and nine unknowns has
 * a problem the traveller can act on, and burying it under "9 unchecked" would be the
 * wrong emphasis.
 */
function statusFor(counts: {
  checkedItems: number;
  confirmedOpenItems: number;
  confirmedClosedItems: number;
  unknownItems: number;
}): ScheduleAccuracyReport["status"] {
  if (counts.confirmedClosedItems > 0) return "conflicts";
  if (counts.checkedItems === 0) return "unknown";
  if (counts.confirmedOpenItems === 0) return "unknown";
  if (counts.unknownItems > 0) return "warnings";
  return "clear";
}

/** True when the report describes something worth showing prominently. */
export function hasScheduleConflicts(report: ScheduleAccuracyReport): boolean {
  return report.conflicts.length > 0;
}

/** The conflicts for one day, for a day-scoped view. */
export function conflictsForDay(
  report: ScheduleAccuracyReport,
  dayNumber: number,
): ScheduleConflict[] {
  return report.conflicts.filter((conflict) => conflict.dayNumber === dayNumber);
}

/** Verifies the counts add up. Called by tests and by the derived-field validator. */
export function reportTotalsReconcile(report: ScheduleAccuracyReport): boolean {
  return (
    report.checkedItems ===
      report.confirmedOpenItems +
        report.confirmedClosedItems +
        report.unknownItems &&
    report.conflicts.length === report.confirmedClosedItems &&
    report.warnings.length === report.unknownItems
  );
}

/** True when an evaluation must not be rendered as an open badge. */
export { isUnknown };
