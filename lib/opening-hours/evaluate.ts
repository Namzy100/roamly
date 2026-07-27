import { toMinutes } from "./parser";
import {
  dayOfWeekFor,
  normalizeOpeningHours,
  previousDay,
  type NormalizedWeek,
} from "./normalize";
import { isSupportedTimezone, resolveWallClock } from "./timezone";
import {
  MINUTES_PER_DAY,
  type OpeningEvaluation,
  type OpeningInterval,
} from "./types";

/**
 * Does this scheduled visit fall inside published opening hours?
 *
 * ## The whole visit, not the start
 *
 * `confirmed_open` requires the **entire** interval to sit inside one open period. A
 * visit from 16:30 to 18:00 at a museum closing at 17:00 is a conflict, and reporting it
 * as open because the doors were open when you arrived would be the least useful
 * possible answer — that is exactly the situation a traveller wants warned about.
 *
 * ## The order of checks is the safety property
 *
 * No data → unknown. Unparsed → unknown. No timezone → unknown. Exceptions present →
 * unknown. Only when all four are satisfied does a parsed rule get to decide, and only
 * then can `confirmed_closed` be returned.
 *
 * That ordering is what makes "absence of evidence is never evidence of closure" true by
 * construction rather than by review.
 *
 * ## What the timezone is for
 *
 * Not conversion — both sides are already local wall-clock. It is for DST: a visit
 * scheduled at a local time that **does not exist** (spring forward) or happens twice
 * (fall back) cannot be evaluated honestly, and without a zone we cannot tell.
 */

export type EvaluateVisitInput = {
  /** The raw OSM string, or absent when the provider had none. */
  openingHours?: string;
  /** `YYYY-MM-DD`, the itinerary's own local date. */
  date: string;
  /** `HH:MM`, local. */
  startTime: string;
  /** `HH:MM`, local. May be earlier than `startTime` for a visit crossing midnight. */
  endTime: string;
  /** IANA zone. Absent means we do not know, which is a real state. */
  timezone?: string;
};

export function evaluateScheduledVisit(
  input: EvaluateVisitInput,
): OpeningEvaluation {
  const sourceText = input.openingHours?.trim();

  if (!sourceText) {
    return {
      status: "unknown_no_data",
      reason:
        "OpenStreetMap has no opening hours recorded for this place, so there is nothing to check against.",
    };
  }

  if (!input.timezone || !isSupportedTimezone(input.timezone)) {
    return {
      status: "unknown_timezone",
      sourceText,
      reason:
        "The destination's timezone could not be determined, so a local opening time cannot be compared with the schedule.",
    };
  }

  const normalised = normalizeOpeningHours({
    sourceText,
    timezone: input.timezone,
  });

  if (!normalised.ok) {
    return {
      status: "unknown_unparsed",
      sourceText,
      reason:
        normalised.reason === "unsupported_syntax"
          ? "These opening hours use a format this planner does not interpret, so they are shown as recorded for you to read."
          : "These opening hours could not be read, so they are shown as recorded for you to read.",
    };
  }

  /**
   * A rule mentioning something we do not interpret makes *every* date uncertain.
   *
   * A `PH off` clause does not only affect holidays: without evaluating it we cannot know
   * whether the date in question is one. The parser already refuses such strings, so this
   * is defence in depth for a schedule that reached here another way.
   */
  if (normalised.schedule.exceptions.length > 0) {
    return {
      status: "unknown_exception",
      sourceText,
      reason:
        "These opening hours include a rule this planner does not evaluate, such as public holidays, so the answer for this date is not certain.",
    };
  }

  const day = dayOfWeekFor(input.date);
  if (!day) {
    return {
      status: "unknown_unparsed",
      sourceText,
      reason: "The scheduled date could not be read.",
    };
  }

  const wallClock = resolveWallClock({
    date: input.date,
    time: input.startTime,
    timezone: input.timezone,
  });

  if (wallClock.status === "invalid_timezone") {
    return {
      status: "unknown_timezone",
      sourceText,
      reason: "The destination's timezone is not one this platform recognises.",
    };
  }

  /**
   * The clocks moved. Neither case can be answered honestly.
   *
   * `skipped` — the scheduled local time does not exist on this date. That is a schedule
   * problem rather than an opening-hours one, and it is surfaced as unknown rather than
   * as a closure, because the place's hours are not what is wrong.
   *
   * `ambiguous` — the local time occurs twice, so "is it open then?" has two answers.
   */
  if (wallClock.status === "skipped") {
    return {
      status: "unknown_exception",
      sourceText,
      reason:
        "The clocks change on this date and the scheduled local time does not exist, so opening hours cannot be checked against it.",
    };
  }
  if (wallClock.status === "ambiguous") {
    return {
      status: "unknown_exception",
      sourceText,
      reason:
        "The clocks change on this date and the scheduled local time occurs twice, so opening hours cannot be checked against it unambiguously.",
    };
  }

  const start = toMinutes(input.startTime);
  const rawEnd = toMinutes(input.endTime);
  /**
   * A visit crossing midnight is expressed as an end earlier than its start, matching how
   * an overnight opening interval is expressed. Extending past 1440 keeps the containment
   * test a single comparison rather than a special case.
   */
  const end = rawEnd <= start ? rawEnd + MINUTES_PER_DAY : rawEnd;

  const containing = findContainingInterval(normalised.week, day, start, end);
  if (containing) {
    return { status: "confirmed_open", sourceText, interval: containing };
  }

  const next = nextOpeningAfter(normalised.week, day, start);
  return {
    status: "confirmed_closed",
    sourceText,
    ...(next ? { nextKnownOpening: next } : {}),
  };
}

/**
 * The open interval that contains the whole visit, or null.
 *
 * Two families of interval can contain it: one belonging to the visit's own day, and an
 * overnight one that began the *previous* day and is still running — which is why the
 * previous day's rules are consulted at all.
 */
function findContainingInterval(
  week: NormalizedWeek,
  day: ReturnType<typeof dayOfWeekFor> & string,
  start: number,
  end: number,
): OpeningInterval | null {
  for (const interval of week[day]) {
    const from = toMinutes(interval.opensAt);
    const to = interval.crossesMidnight
      ? toMinutes(interval.closesAt) + MINUTES_PER_DAY
      : toMinutes(interval.closesAt);

    if (start >= from && end <= to) return interval;
  }

  // An interval that opened yesterday and runs into today, e.g. `Fr 18:00-02:00` when
  // the visit is at 00:30 on Saturday.
  for (const interval of week[previousDay(day)]) {
    if (!interval.crossesMidnight) continue;
    const from = toMinutes(interval.opensAt) - MINUTES_PER_DAY;
    const to = toMinutes(interval.closesAt);
    if (start >= from && end <= to) return interval;
  }

  return null;
}

/**
 * The next opening later the same day, as `HH:MM`, or undefined.
 *
 * Deliberately same-day only. Searching forward across days would produce an answer like
 * "opens Tuesday", which reads as a booking-grade fact about a place whose data may be
 * years old — and the traveller is better served by "closed then, here is the rule".
 */
function nextOpeningAfter(
  week: NormalizedWeek,
  day: ReturnType<typeof dayOfWeekFor> & string,
  start: number,
): string | undefined {
  const later = week[day]
    .map((interval) => toMinutes(interval.opensAt))
    .filter((opensAt) => opensAt > start)
    .sort((a, b) => a - b);

  if (later.length === 0) return undefined;

  const minutes = later[0];
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The open intervals for one day, for a repair that wants somewhere to move a visit to.
 *
 * Returns an empty array both for "closed that day" and for "we could not tell", so a
 * caller must not read emptiness as closure — `evaluateScheduledVisit` is the only thing
 * that may make that call.
 */
export function openIntervalsForDate(input: {
  openingHours?: string;
  date: string;
  timezone?: string;
}): OpeningInterval[] {
  if (!input.openingHours?.trim() || !input.timezone) return [];

  const normalised = normalizeOpeningHours({
    sourceText: input.openingHours,
    timezone: input.timezone,
  });
  if (!normalised.ok || normalised.schedule.exceptions.length > 0) return [];

  const day = dayOfWeekFor(input.date);
  if (!day) return [];

  return normalised.week[day];
}
