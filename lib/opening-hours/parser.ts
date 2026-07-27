import {
  DAYS_OF_WEEK,
  MINUTES_PER_DAY,
  PARSER_LIMITS,
  type DayOfWeek,
  type OpeningException,
  type OpeningInterval,
  type OpeningRule,
  type ParseResult,
} from "./types";

/**
 * A conservative `opening_hours` parser.
 *
 * ## Why a subset, and why it is stated rather than approximated
 *
 * The OSM `opening_hours` grammar is large, genuinely ambiguous in places, and used
 * inconsistently across the world. A parser that tried to cover it would either be a
 * substantial project of its own or would quietly guess — and a guess here becomes
 * "this museum is open at 18:00" in a plan someone travels on.
 *
 * So the accepted grammar is small, written out below, and **anything outside it fails
 * loudly** as `unsupported_syntax`. The original string is always retained, so a
 * traveller reading a rule we cannot parse sees the rule itself rather than nothing.
 *
 * ```
 * schedule  := rule (';' rule)*
 * rule      := '24/7' | 'off' | dayspec 'off' | dayspec? timespec
 * dayspec   := dayrange (',' dayrange)*
 * dayrange  := DAY ('-' DAY)?
 * timespec  := interval (',' interval)*
 * interval  := HH:MM '-' HH:MM
 * ```
 *
 * ## Safety
 *
 * No dynamic evaluation. No dependency. Every regex is anchored, character-class based
 * and free of nested quantifiers, so none can backtrack catastrophically — and in any
 * case the input is length-bounded before a regex sees it, which makes the runtime
 * finite by construction rather than by analysis.
 *
 * Deterministic and locale-independent: day names are matched case-insensitively
 * against a fixed table, times are parsed digit by digit, and nothing consults the
 * system locale or clock.
 */

/**
 * Constructs we deliberately refuse.
 *
 * Checked as substrings *before* parsing, so an unsupported construct can never be
 * partially understood — a rule like `Mo-Fr 09:00-17:00; PH off` must not be read as
 * "weekdays nine to five" with the holiday clause silently dropped, because on a
 * holiday that reading is wrong.
 *
 * Each entry records what it is, so the caller can say which caveat applies.
 */
const UNSUPPORTED: { pattern: RegExp; kind: OpeningException["kind"] }[] = [
  { pattern: /\bPH\b/i, kind: "public-holiday" },
  { pattern: /\bSH\b/i, kind: "school-holiday" },
  { pattern: /\b(sunrise|sunset|dawn|dusk)\b/i, kind: "other" },
  { pattern: /\beaster\b/i, kind: "seasonal" },
  { pattern: /\bweek\b/i, kind: "other" },
  {
    pattern:
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i,
    kind: "seasonal",
  },
  // Quoted comments modify a rule's meaning, e.g. `Mo-Fr 09:00-17:00 "by appointment"`.
  { pattern: /"/, kind: "comment" },
  // Fallback separator, open-ended times, and week-number brackets.
  { pattern: /\|\|/, kind: "other" },
  { pattern: /\+/, kind: "other" },
  { pattern: /\[/, kind: "other" },
  { pattern: /\bunknown\b/i, kind: "other" },
];

const DAY_INDEX: Record<string, number> = Object.fromEntries(
  DAYS_OF_WEEK.map((day, index) => [day.toLowerCase(), index]),
);

/** `HH:MM`, two digits each. No single-digit hours, no seconds, no am/pm. */
const TIME_PATTERN = /^([0-9]{2}):([0-9]{2})$/;

export function parseOpeningHours(source: string): ParseResult {
  const text = source.trim();

  if (text.length === 0) {
    return { ok: false, reason: "empty", detail: "no source text" };
  }
  if (text.length > PARSER_LIMITS.maxSourceLength) {
    return {
      ok: false,
      reason: "too_long",
      detail: `${text.length} characters exceeds the ${PARSER_LIMITS.maxSourceLength} limit`,
    };
  }

  const exceptions: OpeningException[] = [];
  for (const entry of UNSUPPORTED) {
    const match = entry.pattern.exec(text);
    if (match) {
      exceptions.push({ kind: entry.kind, sourceFragment: match[0] });
    }
  }
  if (exceptions.length > 0) {
    /**
     * Refused rather than partially parsed.
     *
     * The caller reports `unknown_unparsed` and shows the original string. Reading the
     * supported half of a rule whose other half we do not understand is the one failure
     * mode that produces a confident wrong answer.
     */
    return {
      ok: false,
      reason: "unsupported_syntax",
      detail: exceptions.map((entry) => entry.sourceFragment).join(", "),
    };
  }

  const ruleTexts = text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (ruleTexts.length === 0) {
    return { ok: false, reason: "malformed", detail: text };
  }
  if (ruleTexts.length > PARSER_LIMITS.maxRules) {
    return {
      ok: false,
      reason: "too_many_rules",
      detail: `${ruleTexts.length} rules`,
    };
  }

  const rules: OpeningRule[] = [];
  for (const ruleText of ruleTexts) {
    const rule = parseRule(ruleText);
    if (!rule.ok) return rule;
    rules.push(rule.rule);
  }

  return { ok: true, rules, exceptions: [] };
}

type RuleResult =
  | { ok: true; rule: OpeningRule }
  | Extract<ParseResult, { ok: false }>;

function parseRule(text: string): RuleResult {
  const lower = text.toLowerCase();

  // `24/7` — always open. Represented explicitly rather than as 00:00-24:00 on every
  // day, so nothing downstream has to recognise that as a special case.
  if (lower === "24/7") {
    return {
      ok: true,
      rule: {
        days: [...DAYS_OF_WEEK],
        intervals: [{ opensAt: "00:00", closesAt: "24:00", crossesMidnight: false }],
      },
    };
  }

  // A bare `off` or `closed`: every day, no intervals.
  if (lower === "off" || lower === "closed") {
    return { ok: true, rule: { days: [...DAYS_OF_WEEK], intervals: [] } };
  }

  /**
   * Split the day part from the time part.
   *
   * The first token beginning with a digit starts the times, *except* for `24/7` which
   * is already handled. Day names never start with a digit in the supported subset, so
   * this split is unambiguous without a full tokeniser.
   */
  const parts = lower.split(/\s+/).filter((part) => part.length > 0);
  const firstTimeIndex = parts.findIndex((part) => /^[0-9]/.test(part));

  const dayText = (firstTimeIndex === -1 ? parts : parts.slice(0, firstTimeIndex))
    .join("")
    .trim();
  const timeText = (firstTimeIndex === -1 ? [] : parts.slice(firstTimeIndex))
    .join("")
    .trim();

  // `Mo-Fr off` / `Su closed`
  if (dayText.length > 0 && timeText.length === 0) {
    const tail = dayText.endsWith("off")
      ? "off"
      : dayText.endsWith("closed")
        ? "closed"
        : null;
    if (tail === null) {
      return { ok: false, reason: "malformed", detail: text };
    }
    const days = parseDays(dayText.slice(0, dayText.length - tail.length));
    if (!days.ok) return days;
    return { ok: true, rule: { days: days.days, intervals: [] } };
  }

  if (timeText.length === 0) {
    return { ok: false, reason: "malformed", detail: text };
  }

  /**
   * A time-only rule applies to every day.
   *
   * `09:00-17:00` on its own is common and unambiguous in the subset, and reading it as
   * "some unspecified day" would be less useful and no safer.
   */
  const days: DaysResult =
    dayText.length === 0
      ? { ok: true, days: [...DAYS_OF_WEEK] }
      : parseDays(dayText);
  if (!days.ok) return days;

  const intervals = parseIntervals(timeText);
  if (!intervals.ok) return intervals;

  return { ok: true, rule: { days: days.days, intervals: intervals.intervals } };
}

type DaysResult =
  | { ok: true; days: DayOfWeek[] }
  | Extract<ParseResult, { ok: false }>;

function parseDays(text: string): DaysResult {
  const specs = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (specs.length === 0) {
    return { ok: false, reason: "invalid_day", detail: text };
  }
  if (specs.length > PARSER_LIMITS.maxDaySpecsPerRule) {
    return { ok: false, reason: "malformed", detail: `${specs.length} day specs` };
  }

  const selected = new Set<DayOfWeek>();

  for (const spec of specs) {
    const [fromText, toText, ...rest] = spec.split("-");
    if (rest.length > 0) {
      return { ok: false, reason: "invalid_day", detail: spec };
    }

    const from = DAY_INDEX[fromText];
    if (from === undefined) {
      return { ok: false, reason: "invalid_day", detail: fromText };
    }

    if (toText === undefined) {
      selected.add(DAYS_OF_WEEK[from]);
      continue;
    }

    const to = DAY_INDEX[toText];
    if (to === undefined) {
      return { ok: false, reason: "invalid_day", detail: toText };
    }

    /**
     * Ranges wrap, as OSM's do: `Sa-Su` is the weekend and `Fr-Mo` is a long weekend
     * rather than an error. Bounded by seven iterations so a wrap cannot loop.
     */
    for (let step = 0; step <= 6; step += 1) {
      const index = (from + step) % 7;
      selected.add(DAYS_OF_WEEK[index]);
      if (index === to) break;
    }
  }

  // In OSM's declared order, so two equivalent specs normalise identically.
  return {
    ok: true,
    days: DAYS_OF_WEEK.filter((day) => selected.has(day)),
  };
}

type IntervalsResult =
  | { ok: true; intervals: OpeningInterval[] }
  | Extract<ParseResult, { ok: false }>;

function parseIntervals(text: string): IntervalsResult {
  const specs = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (specs.length === 0) {
    return { ok: false, reason: "malformed", detail: text };
  }
  if (specs.length > PARSER_LIMITS.maxIntervalsPerRule) {
    return {
      ok: false,
      reason: "too_many_intervals",
      detail: `${specs.length} intervals`,
    };
  }

  const intervals: OpeningInterval[] = [];

  for (const spec of specs) {
    const [opensText, closesText, ...rest] = spec.split("-");
    if (closesText === undefined || rest.length > 0) {
      return { ok: false, reason: "malformed", detail: spec };
    }

    const opens = parseTime(opensText);
    const closes = parseTime(closesText);
    if (opens === null) {
      return { ok: false, reason: "invalid_time", detail: opensText };
    }
    if (closes === null) {
      return { ok: false, reason: "invalid_time", detail: closesText };
    }

    /**
     * A zero-length interval is rejected rather than read as "closed".
     *
     * `off` already says closed, unambiguously. `09:00-09:00` is far more likely to be
     * a data-entry mistake, and treating a mistake as a factual claim about closure is
     * exactly the direction this module refuses to guess in.
     */
    if (opens === closes) {
      return { ok: false, reason: "zero_length_interval", detail: spec };
    }

    intervals.push({
      opensAt: formatMinutes(opens),
      closesAt: formatMinutes(closes),
      crossesMidnight: closes < opens,
    });
  }

  return { ok: true, intervals };
}

/**
 * `HH:MM` → minutes since midnight, or null.
 *
 * `24:00` is accepted and means **end of day** (1440), which is how OSM writes a
 * closing time of midnight. `25:00` and beyond are rejected: OSM does allow extended
 * hours like `26:00` in some regions, and supporting them would need a documented rule
 * about which day the time belongs to — so they are out of the subset rather than
 * guessed at.
 */
export function parseTime(text: string): number | null {
  const match = TIME_PATTERN.exec(text);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (minutes > 59) return null;
  if (hours === 24) return minutes === 0 ? MINUTES_PER_DAY : null;
  if (hours > 23) return null;

  return hours * 60 + minutes;
}

export function formatMinutes(total: number): string {
  if (total === MINUTES_PER_DAY) return "24:00";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Minutes since midnight for a `HH:MM` already known to be well-formed. */
export function toMinutes(time: string): number {
  const parsed = parseTime(time);
  if (parsed === null) {
    throw new Error(`Not a valid HH:MM time: ${JSON.stringify(time)}`);
  }
  return parsed;
}
