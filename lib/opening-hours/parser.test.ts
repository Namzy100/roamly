import { describe, expect, it } from "vitest";

import {
  MALFORMED_HOURS,
  SUPPORTED_HOURS,
  UNSUPPORTED_HOURS,
} from "./fixtures";
import { parseOpeningHours, parseTime } from "./parser";
import { PARSER_LIMITS } from "./types";

/**
 * The parser's job is as much refusal as acceptance.
 *
 * Every `unsupported` case below is a real OSM string that a lenient parser would read
 * *half* of — and half of `Mo-Fr 09:00-17:00; PH off` is a confident wrong answer on a
 * public holiday. That is why they fail rather than degrade.
 */

function parse(source: string) {
  return parseOpeningHours(source);
}

/** The rules, or a failure marker — so two sources can be compared in one assertion. */
function rulesOf(source: string) {
  const result = parse(source);
  return result.ok ? result.rules : { failed: result.reason };
}

describe("parseOpeningHours — the supported subset", () => {
  it("reads a weekday range", () => {
    const result = parse(SUPPORTED_HOURS.weekdayRange);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toEqual([
      {
        days: ["Mo", "Tu", "We", "Th", "Fr"],
        intervals: [
          { opensAt: "09:00", closesAt: "17:00", crossesMidnight: false },
        ],
      },
    ]);
  });

  it("reads a comma-separated day list", () => {
    const result = parse(SUPPORTED_HOURS.commaDays);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].days).toEqual(["Mo", "We", "Fr"]);
  });

  it("wraps a day range across the weekend", () => {
    const result = parse(SUPPORTED_HOURS.weekend);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].days).toEqual(["Sa", "Su"]);
  });

  it("reads two intervals in one day", () => {
    const result = parse(SUPPORTED_HOURS.splitDay);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].intervals).toEqual([
      { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
      { opensAt: "13:00", closesAt: "17:00", crossesMidnight: false },
    ]);
  });

  it("reads semicolon-separated rules", () => {
    const result = parse(SUPPORTED_HOURS.twoRules);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules).toHaveLength(2);
    expect(result.rules[1].days).toEqual(["Sa"]);
  });

  it("reads 24/7 as every day, all day", () => {
    const result = parse(SUPPORTED_HOURS.alwaysOpen);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].days).toHaveLength(7);
    expect(result.rules[0].intervals[0]).toEqual({
      opensAt: "00:00",
      closesAt: "24:00",
      crossesMidnight: false,
    });
  });

  it("reads off and closed as no intervals", () => {
    for (const source of ["off", "closed", "Mo-Fr off", "Su closed"]) {
      const result = parse(source);
      expect(result.ok, source).toBe(true);
      if (!result.ok) continue;
      expect(result.rules[0].intervals, source).toEqual([]);
    }
  });

  it("marks an overnight interval as crossing midnight", () => {
    const result = parse(SUPPORTED_HOURS.overnight);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].intervals[0]).toEqual({
      opensAt: "18:00",
      closesAt: "02:00",
      crossesMidnight: true,
    });
  });

  it("reads a single day", () => {
    const result = parse(SUPPORTED_HOURS.singleDay);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].days).toEqual(["Tu"]);
  });

  it("applies a time-only rule to every day", () => {
    const result = parse(SUPPORTED_HOURS.timeOnly);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].days).toHaveLength(7);
  });

  it("tolerates untidy whitespace and lower case", () => {
    expect(rulesOf(SUPPORTED_HOURS.untidyWhitespace)).toEqual(
      rulesOf(SUPPORTED_HOURS.twoRules),
    );
    expect(rulesOf(SUPPORTED_HOURS.lowerCaseDays)).toEqual(
      rulesOf(SUPPORTED_HOURS.weekdayRange),
    );
  });

  it("accepts 24:00 as a closing time", () => {
    const result = parse(SUPPORTED_HOURS.midnightClose);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rules[0].intervals[0].closesAt).toBe("24:00");
    expect(result.rules[0].intervals[0].crossesMidnight).toBe(false);
  });

  it("is deterministic", () => {
    for (const source of Object.values(SUPPORTED_HOURS)) {
      expect(JSON.stringify(parse(source))).toBe(JSON.stringify(parse(source)));
    }
  });
});

describe("parseOpeningHours — refusals", () => {
  /**
   * The case that justifies the whole approach. A lenient parser reads the weekday clause
   * and drops `PH off`, which is right six days a week and wrong on the seventh.
   */
  it("refuses a rule mentioning public holidays rather than reading half of it", () => {
    const result = parse(UNSUPPORTED_HOURS.publicHoliday);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported_syntax");
    expect(result.detail.toUpperCase()).toContain("PH");
  });

  it("refuses every unsupported construct", () => {
    for (const [name, source] of Object.entries(UNSUPPORTED_HOURS)) {
      const result = parse(source);
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.reason, name).toBe("unsupported_syntax");
    }
  });

  it("rejects an impossible hour", () => {
    const result = parse(MALFORMED_HOURS.invalidHour);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_time");
  });

  it("rejects an impossible minute", () => {
    expect(parse(MALFORMED_HOURS.invalidMinute)).toMatchObject({
      ok: false,
      reason: "invalid_time",
    });
  });

  it("rejects an unknown day", () => {
    expect(parse(MALFORMED_HOURS.invalidDay)).toMatchObject({
      ok: false,
      reason: "invalid_day",
    });
  });

  /**
   * `off` already says closed, unambiguously. `09:00-09:00` is far more likely a
   * data-entry slip, and reading a slip as a factual claim about closure is the direction
   * this module refuses to guess in.
   */
  it("rejects a zero-length interval rather than reading it as closed", () => {
    expect(parse(MALFORMED_HOURS.zeroLength)).toMatchObject({
      ok: false,
      reason: "zero_length_interval",
    });
  });

  it("rejects a day spec with no times", () => {
    expect(parse(MALFORMED_HOURS.noTimes).ok).toBe(false);
  });

  it("rejects a single-digit hour", () => {
    expect(parse(MALFORMED_HOURS.singleDigitHour)).toMatchObject({
      ok: false,
      reason: "invalid_time",
    });
  });

  it("rejects an interval with no closing time", () => {
    expect(parse(MALFORMED_HOURS.reversedRange).ok).toBe(false);
  });

  it("rejects empty input", () => {
    expect(parse(MALFORMED_HOURS.empty)).toMatchObject({
      ok: false,
      reason: "empty",
    });
  });
});

describe("parseOpeningHours — bounds", () => {
  it("rejects input over the length limit without parsing it", () => {
    const long = `Mo-Fr 09:00-17:00; `.repeat(60);
    expect(long.length).toBeGreaterThan(PARSER_LIMITS.maxSourceLength);

    expect(parse(long)).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("rejects too many rules", () => {
    const many = Array.from(
      { length: PARSER_LIMITS.maxRules + 1 },
      () => "Mo 09:00-10:00",
    ).join(";");

    expect(parse(many)).toMatchObject({ ok: false, reason: "too_many_rules" });
  });

  it("rejects too many intervals in one rule", () => {
    const intervals = Array.from(
      { length: PARSER_LIMITS.maxIntervalsPerRule + 1 },
      (_, index) => `0${index}:00-0${index}:30`,
    ).join(",");

    expect(parse(`Mo ${intervals}`)).toMatchObject({
      ok: false,
      reason: "too_many_intervals",
    });
  });

  /**
   * A crude but real guard: `opening_hours` is untrusted free text from a public API, and
   * the bound is what makes the runtime finite by construction rather than by reasoning
   * about the grammar.
   */
  it("returns promptly on adversarial input", () => {
    const adversarial = `${"Mo-".repeat(200)}Fr 09:00-17:00`;
    const started = process.hrtime.bigint();

    parse(adversarial);

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeLessThan(50);
  });
});

describe("parseTime", () => {
  it("reads a valid HH:MM", () => {
    expect(parseTime("00:00")).toBe(0);
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("23:59")).toBe(1_439);
  });

  it("accepts 24:00 as end of day", () => {
    expect(parseTime("24:00")).toBe(1_440);
  });

  it("rejects 24:01 and beyond", () => {
    expect(parseTime("24:01")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("99:99")).toBeNull();
  });

  it("rejects anything that is not two-digit HH:MM", () => {
    for (const value of ["9:00", "0900", "09:00:00", "9am", "", "09-00"]) {
      expect(parseTime(value), value).toBeNull();
    }
  });
});
