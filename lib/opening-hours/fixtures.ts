/**
 * Opening-hours fixtures.
 *
 * Real strings, in the shapes OpenStreetMap actually contains — including the messy ones.
 * The unsupported group matters as much as the supported one: those are the strings that
 * must produce `unknown_unparsed` rather than a confident half-reading, and each is here
 * because it appears in real data.
 *
 * Dates are chosen deliberately. 2026-09-12 is a Saturday and 2026-09-14 a Monday, which
 * is what makes the weekday/weekend cases meaningful; the DST dates are the real European
 * transitions for 2026.
 */

export const SUPPORTED_HOURS = {
  weekdayRange: "Mo-Fr 09:00-17:00",
  commaDays: "Mo,We,Fr 10:00-16:00",
  weekend: "Sa-Su 10:00-18:00",
  splitDay: "Mo-Fr 09:00-12:00,13:00-17:00",
  twoRules: "Mo-Fr 09:00-17:00; Sa 10:00-14:00",
  alwaysOpen: "24/7",
  closed: "off",
  closedOneDay: "Mo-Su 09:00-17:00; We off",
  overnight: "Fr-Sa 18:00-02:00",
  singleDay: "Tu 11:00-15:00",
  timeOnly: "08:00-20:00",
  untidyWhitespace: "  Mo-Fr   09:00-17:00  ;   Sa  10:00-14:00 ",
  lowerCaseDays: "mo-fr 09:00-17:00",
  midnightClose: "Mo-Su 18:00-24:00",
} as const;

/**
 * Strings the parser must refuse.
 *
 * Grouped by why. The holiday and seasonal cases are the ones with teeth: a parser that
 * read `Mo-Fr 09:00-17:00; PH off` as "weekdays nine to five" would be right six days a
 * week and wrong on the day it mattered.
 */
export const UNSUPPORTED_HOURS = {
  publicHoliday: "Mo-Fr 09:00-17:00; PH off",
  schoolHoliday: "Mo-Fr 09:00-17:00; SH 10:00-14:00",
  sunset: "Mo-Su sunrise-sunset",
  weekNumbers: "week 1-20 Mo-Fr 09:00-17:00",
  seasonal: "Apr-Oct Mo-Su 09:00-19:00",
  easter: "Mo-Su 09:00-17:00; easter off",
  comment: 'Mo-Fr 09:00-17:00 "by appointment"',
  openEnded: "Mo-Fr 09:00+",
  fallback: "Mo-Fr 09:00-17:00 || Sa 10:00-14:00",
  explicitUnknown: "unknown",
} as const;

/** Strings that are simply broken. Rejected with a specific reason, not silently. */
export const MALFORMED_HOURS = {
  invalidHour: "Mo-Fr 25:00-26:00",
  invalidMinute: "Mo-Fr 09:70-17:00",
  invalidDay: "Xx-Fr 09:00-17:00",
  zeroLength: "Mo 09:00-09:00",
  noTimes: "Mo-Fr",
  singleDigitHour: "Mo-Fr 9:00-17:00",
  reversedRange: "Mo-Fr 09:00",
  empty: "   ",
} as const;

/** 2026 calendar anchors, so a test never has to work out a weekday in its head. */
export const DATES = {
  /** Saturday. */
  saturday: "2026-09-12",
  /** Sunday. */
  sunday: "2026-09-13",
  /** Monday. */
  monday: "2026-09-14",
  /** Wednesday — the day `closedOneDay` shuts. */
  wednesday: "2026-09-16",
  /** European spring forward: 01:00→02:00 UTC, so 01:30 does not exist in Lisbon. */
  dstSpringForward: "2026-03-29",
  /** European fall back: 02:00→01:00, so 01:30 happens twice in Berlin. */
  dstFallBack: "2026-10-25",
} as const;

export const TIMEZONES = {
  lisbon: "Europe/Lisbon",
  berlin: "Europe/Berlin",
  dubai: "Asia/Dubai",
  /** No DST, so it isolates rule logic from transition logic. */
  johannesburg: "Africa/Johannesburg",
  invalid: "Mars/Olympus_Mons",
} as const;
