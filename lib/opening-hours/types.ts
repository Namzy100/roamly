/**
 * The opening-hours domain, and the one claim it is allowed to make.
 *
 * ## What "confirmed" means here
 *
 * `confirmed_open` means: **the OpenStreetMap rule we were given, parsed by this
 * parser, says this place is open for the whole of this scheduled visit, in the
 * destination's timezone.** It does not mean the place is open. It does not mean the
 * data is current. A shop that closed last year still has its old hours in OSM.
 *
 * That distinction is the whole reason this module exists as a separate domain with
 * its own vocabulary rather than a boolean on `TripPlace`. A boolean would be read as
 * "open", and we have no basis for that.
 *
 * ## Why there are five kinds of unknown
 *
 * Because they call for different things from the traveller, and collapsing them into
 * one "unknown" would make the interface unable to be useful:
 *
 *  - `unknown_no_data` — OSM has no hours. Check before you go.
 *  - `unknown_unparsed` — OSM has hours we cannot read. The string is shown verbatim so
 *    a human can read it themselves.
 *  - `unknown_timezone` — we do not know the destination's timezone, so "09:00" has no
 *    determinate meaning.
 *  - `unknown_exception` — a rule mentions something we deliberately do not interpret
 *    (a public holiday, say), so the answer for this date is not knowable from what we
 *    parsed.
 *  - `not_applicable` — the item has no place to have hours: free time, an unfilled
 *    slot, an airport run.
 *
 * ## The rule that is never broken
 *
 * Absence of evidence is never evidence of closure. Nothing here returns
 * `confirmed_closed` because data is missing, unreadable, or possibly stale — only
 * because a rule we successfully parsed says so.
 */

/** Two-letter OSM day keys, in OSM's own order. Monday first, as the syntax uses. */
export const DAYS_OF_WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number];

/**
 * Minutes since local midnight.
 *
 * The unit throughout, because it makes interval arithmetic trivial and makes the one
 * awkward case — `24:00` as end-of-day — representable as 1440 rather than as a time
 * that does not exist.
 */
export type MinuteOfDay = number;

export const MINUTES_PER_DAY = 24 * 60;

export type OpeningInterval = {
  /** `HH:MM`, local wall clock. */
  opensAt: string;
  /** `HH:MM`, local wall clock. `24:00` is legal and means end of day. */
  closesAt: string;
  /**
   * True when the interval runs past midnight into the following day, as in
   * `Fr-Sa 18:00-02:00`. The closing time then belongs to the *next* calendar day,
   * which is why this cannot be inferred from the strings at evaluation time.
   */
  crossesMidnight: boolean;
};

export type OpeningRule = {
  days: DayOfWeek[];
  intervals: OpeningInterval[];
};

/**
 * Something in the source we deliberately did not interpret.
 *
 * Recorded rather than ignored: a rule mentioning public holidays means our answer for
 * *any* date could be wrong on a holiday, and the traveller is owed that caveat even
 * on a Tuesday.
 */
export type OpeningException = {
  kind: "public-holiday" | "school-holiday" | "seasonal" | "comment" | "other";
  /** The fragment of the source this came from, for display. Never re-parsed. */
  sourceFragment: string;
};

/**
 * The parsed, normalised week.
 *
 * `rules` is normalised: one entry per distinct set of days, with OSM's later-wins
 * override semantics already applied, so an evaluator never has to reason about rule
 * order. `parserVersion` is stored so a plan evaluated by an older parser can be told
 * apart from one evaluated by this one.
 */
export type WeeklyOpeningSchedule = {
  timezone: string;
  sourceText: string;
  rules: OpeningRule[];
  exceptions: OpeningException[];
  parserVersion: string;
};

/** Bump when the accepted grammar or the normalisation changes. */
export const PARSER_VERSION = "1.0.0";

export type OpeningEvaluationStatus =
  | "confirmed_open"
  | "confirmed_closed"
  | "unknown_no_data"
  | "unknown_unparsed"
  | "unknown_timezone"
  | "unknown_exception"
  | "not_applicable";

export type OpeningEvaluation =
  | {
      status: "confirmed_open";
      sourceText: string;
      /** The interval the visit fits inside, for display. */
      interval: OpeningInterval;
    }
  | {
      status: "confirmed_closed";
      sourceText: string;
      /**
       * The next opening this parser can see, as `HH:MM` on the visit's own day, when
       * there is one. Absent when the place does not open again that day — we do not
       * search forward across days, because a "next Tuesday" answer invites treating
       * it as a booking-grade fact.
       */
      nextKnownOpening?: string;
    }
  | {
      status: Exclude<
        OpeningEvaluationStatus,
        "confirmed_open" | "confirmed_closed"
      >;
      /** Plain language, safe to render. Never a parser token. */
      reason?: string;
      /** Present whenever there was a source string, so a human can read it. */
      sourceText?: string;
    };

/** True for the two states that rest on a successfully parsed rule. */
export function isConfirmed(
  evaluation: OpeningEvaluation,
): evaluation is Extract<
  OpeningEvaluation,
  { status: "confirmed_open" | "confirmed_closed" }
> {
  return (
    evaluation.status === "confirmed_open" ||
    evaluation.status === "confirmed_closed"
  );
}

/**
 * True when the evaluation is a genuine unknown.
 *
 * Used by the UI to decide what *not* to claim — an unknown must never render as an
 * open badge, which is the single most likely way this feature could mislead someone.
 */
export function isUnknown(evaluation: OpeningEvaluation): boolean {
  return !isConfirmed(evaluation) && evaluation.status !== "not_applicable";
}

/* -------------------------------------------------------------------------- */
/* Parse results                                                              */
/* -------------------------------------------------------------------------- */

export type ParseFailureReason =
  | "empty"
  | "too_long"
  | "too_many_rules"
  | "too_many_intervals"
  | "unsupported_syntax"
  | "invalid_day"
  | "invalid_time"
  | "zero_length_interval"
  | "contradictory_rule"
  | "malformed";

export type ParseResult =
  | { ok: true; rules: OpeningRule[]; exceptions: OpeningException[] }
  | {
      ok: false;
      reason: ParseFailureReason;
      /** What we could not read, for a diagnostic. Never shown as a claim. */
      detail: string;
    };

/**
 * Hard bounds, checked before any work.
 *
 * `opening_hours` is user-contributed free text arriving from a public API, so it is
 * untrusted input. The bounds make the parser's runtime provably finite without any
 * reasoning about the grammar, which is a stronger guarantee than "the regexes look
 * linear".
 */
export const PARSER_LIMITS = {
  maxSourceLength: 512,
  maxRules: 24,
  maxIntervalsPerRule: 8,
  maxDaySpecsPerRule: 8,
} as const;
