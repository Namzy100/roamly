import { parseOpeningHours, toMinutes } from "./parser";
import {
  DAYS_OF_WEEK,
  MINUTES_PER_DAY,
  PARSER_VERSION,
  type DayOfWeek,
  type OpeningInterval,
  type OpeningRule,
  type ParseResult,
  type WeeklyOpeningSchedule,
} from "./types";

/**
 * Turning parsed rules into a week an evaluator can read without reasoning about order.
 *
 * ## Later wins, and why that has to happen here
 *
 * `Mo-Su 09:00-17:00; We off` means the place is shut on Wednesday. OSM's semantics are
 * that a later rule **overrides** an earlier one for the days it names — it does not add
 * to it. An evaluator walking the rule list would have to know that, and every evaluator
 * would have to know it identically.
 *
 * So normalisation collapses the list into one set of intervals per day, applying the
 * override as it goes. After this, "is Wednesday open at 10:00?" is a lookup.
 *
 * ## Overlapping intervals are merged, not rejected
 *
 * `Mo 09:00-12:00,11:00-17:00` is odd data, and the only sane reading is the union —
 * nobody writes two intervals meaning "closed in the overlap". Merging is safe because
 * it can only ever *widen* the open period, and a wider open period cannot turn a real
 * closure into a false `confirmed_open`… except at the boundary, which is why adjacent
 * intervals are merged only when they genuinely touch or overlap.
 */

/** The normalised week: intervals per day, override already applied. */
export type NormalizedWeek = Record<DayOfWeek, OpeningInterval[]>;

export type NormalizeResult =
  | { ok: true; schedule: WeeklyOpeningSchedule; week: NormalizedWeek }
  | { ok: false; reason: Extract<ParseResult, { ok: false }>["reason"]; detail: string };

export function normalizeOpeningHours(input: {
  sourceText: string;
  timezone: string;
}): NormalizeResult {
  const parsed = parseOpeningHours(input.sourceText);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, detail: parsed.detail };
  }

  const week = emptyWeek();

  for (const rule of parsed.rules) {
    for (const day of rule.days) {
      /**
       * Replacement, not accumulation — this is the override.
       *
       * An empty interval list is a meaningful value: it is what `off` produces, and it
       * is how a later rule closes a day an earlier rule opened.
       */
      week[day] = mergeIntervals(rule.intervals);
    }
  }

  return {
    ok: true,
    week,
    schedule: {
      timezone: input.timezone,
      sourceText: input.sourceText,
      // Derived back from the normalised week, so what is stored is what will be
      // evaluated. Rebuilding from the parsed rules would let the two disagree.
      rules: weekToRules(week),
      exceptions: parsed.exceptions,
      parserVersion: PARSER_VERSION,
    },
  };
}

function emptyWeek(): NormalizedWeek {
  return {
    Mo: [],
    Tu: [],
    We: [],
    Th: [],
    Fr: [],
    Sa: [],
    Su: [],
  };
}

/**
 * Sorted, with touching or overlapping intervals unioned.
 *
 * An overnight interval is never merged with a same-day one: it belongs partly to the
 * following day and combining the two would produce something that is not an interval.
 */
export function mergeIntervals(intervals: OpeningInterval[]): OpeningInterval[] {
  const overnight = intervals.filter((interval) => interval.crossesMidnight);
  const sameDay = intervals
    .filter((interval) => !interval.crossesMidnight)
    .map((interval) => ({
      from: toMinutes(interval.opensAt),
      to: toMinutes(interval.closesAt),
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const merged: { from: number; to: number }[] = [];
  for (const interval of sameDay) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) {
      last.to = Math.max(last.to, interval.to);
      continue;
    }
    merged.push({ ...interval });
  }

  return [
    ...merged.map((interval) => ({
      opensAt: formatMinuteOfDay(interval.from),
      closesAt: formatMinuteOfDay(interval.to),
      crossesMidnight: false,
    })),
    ...overnight,
  ];
}

/** One rule per distinct interval set, so equivalent inputs normalise identically. */
function weekToRules(week: NormalizedWeek): OpeningRule[] {
  const byKey = new Map<string, { days: DayOfWeek[]; intervals: OpeningInterval[] }>();

  for (const day of DAYS_OF_WEEK) {
    const intervals = week[day];
    const key = JSON.stringify(intervals);
    const entry = byKey.get(key);
    if (entry) entry.days.push(day);
    else byKey.set(key, { days: [day], intervals });
  }

  // Days with no intervals are a real statement — "closed" — and are kept.
  return [...byKey.values()];
}

function formatMinuteOfDay(total: number): string {
  if (total === MINUTES_PER_DAY) return "24:00";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** The day-of-week key for an ISO `YYYY-MM-DD`, or null when it is not a date. */
export function dayOfWeekFor(date: string): DayOfWeek | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  /**
   * Parsed as UTC midnight on purpose.
   *
   * `new Date("2026-09-12")` is UTC in every engine, and the *calendar* weekday of a
   * local date is the same in every timezone — so this needs no zone and cannot be
   * shifted by the machine running it. Using the local-time constructor here is the
   * classic way to get yesterday's weekday west of Greenwich.
   */
  const instant = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(instant.getTime())) return null;

  // `getUTCDay` is 0 = Sunday; our table is Monday-first.
  const index = (instant.getUTCDay() + 6) % 7;
  return DAYS_OF_WEEK[index];
}

/** The previous calendar day, for evaluating an overnight interval that began yesterday. */
export function previousDay(day: DayOfWeek): DayOfWeek {
  const index = DAYS_OF_WEEK.indexOf(day);
  return DAYS_OF_WEEK[(index + 6) % 7];
}
