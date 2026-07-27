/**
 * The opening-hours domain's public surface.
 *
 * Pure, client-safe and provider-free: no `server-only`, no network, no clock read, no
 * `TripPlan` import. That is what lets the whole subject be unit-tested against string
 * fixtures, and what lets the browser evaluate hours without a round trip.
 *
 * Nothing here knows about itineraries. Plan-level aggregation is
 * `lib/plan/schedule-report.ts`.
 */

export {
  DAYS_OF_WEEK,
  MINUTES_PER_DAY,
  PARSER_LIMITS,
  PARSER_VERSION,
  isConfirmed,
  isUnknown,
  type DayOfWeek,
  type MinuteOfDay,
  type OpeningEvaluation,
  type OpeningEvaluationStatus,
  type OpeningException,
  type OpeningInterval,
  type OpeningRule,
  type ParseFailureReason,
  type ParseResult,
  type WeeklyOpeningSchedule,
} from "./types";

export {
  formatMinutes,
  parseOpeningHours,
  parseTime,
  toMinutes,
} from "./parser";

export {
  dayOfWeekFor,
  mergeIntervals,
  normalizeOpeningHours,
  previousDay,
  type NormalizedWeek,
  type NormalizeResult,
} from "./normalize";

export {
  isSupportedTimezone,
  offsetMinutesAt,
  resolveDestinationTimezone,
  resolveWallClock,
  type TimezoneResolution,
  type WallClockResolution,
} from "./timezone";

export {
  evaluateScheduledVisit,
  openIntervalsForDate,
  type EvaluateVisitInput,
} from "./evaluate";
