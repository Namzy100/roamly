import { describe, expect, it } from "vitest";

import { DATES, SUPPORTED_HOURS, TIMEZONES } from "./fixtures";
import {
  dayOfWeekFor,
  mergeIntervals,
  normalizeOpeningHours,
  previousDay,
} from "./normalize";
import { PARSER_VERSION } from "./types";

function normalize(sourceText: string, timezone: string = TIMEZONES.lisbon) {
  return normalizeOpeningHours({ sourceText, timezone });
}

describe("normalizeOpeningHours", () => {
  it("produces one interval set per day", () => {
    const result = normalize(SUPPORTED_HOURS.twoRules);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.week.Mo).toEqual([
      { opensAt: "09:00", closesAt: "17:00", crossesMidnight: false },
    ]);
    expect(result.week.Sa).toEqual([
      { opensAt: "10:00", closesAt: "14:00", crossesMidnight: false },
    ]);
    expect(result.week.Su).toEqual([]);
  });

  /**
   * The rule that cannot live in the evaluator: OSM semantics are that a later rule
   * *replaces* an earlier one for the days it names. Accumulating instead would leave
   * Wednesday open, and a traveller would arrive at a shut door.
   */
  it("lets a later rule close a day an earlier rule opened", () => {
    const result = normalize(SUPPORTED_HOURS.closedOneDay);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.week.We).toEqual([]);
    expect(result.week.Tu).toEqual([
      { opensAt: "09:00", closesAt: "17:00", crossesMidnight: false },
    ]);
  });

  it("lets a later rule narrow a day rather than widen it", () => {
    const result = normalize("Mo-Su 09:00-17:00; Su 11:00-13:00");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.week.Su).toEqual([
      { opensAt: "11:00", closesAt: "13:00", crossesMidnight: false },
    ]);
  });

  it("keeps an overnight interval on the day it starts", () => {
    const result = normalize(SUPPORTED_HOURS.overnight);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.week.Fr).toEqual([
      { opensAt: "18:00", closesAt: "02:00", crossesMidnight: true },
    ]);
    // Saturday's own rule, not Friday's spillover.
    expect(result.week.Sa).toEqual([
      { opensAt: "18:00", closesAt: "02:00", crossesMidnight: true },
    ]);
    expect(result.week.Su).toEqual([]);
  });

  it("opens every day for 24/7", () => {
    const result = normalize(SUPPORTED_HOURS.alwaysOpen);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const intervals of Object.values(result.week)) {
      expect(intervals).toEqual([
        { opensAt: "00:00", closesAt: "24:00", crossesMidnight: false },
      ]);
    }
  });

  it("records the timezone, source text and parser version on the schedule", () => {
    const result = normalize(SUPPORTED_HOURS.weekdayRange, TIMEZONES.dubai);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.timezone).toBe(TIMEZONES.dubai);
    expect(result.schedule.sourceText).toBe(SUPPORTED_HOURS.weekdayRange);
    expect(result.schedule.parserVersion).toBe(PARSER_VERSION);
    expect(result.schedule.exceptions).toEqual([]);
  });

  it("groups days with identical intervals into one stored rule", () => {
    const result = normalize(SUPPORTED_HOURS.weekdayRange);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.rules).toEqual([
      {
        days: ["Mo", "Tu", "We", "Th", "Fr"],
        intervals: [
          { opensAt: "09:00", closesAt: "17:00", crossesMidnight: false },
        ],
      },
      { days: ["Sa", "Su"], intervals: [] },
    ]);
  });

  /**
   * What is stored has to be what will be evaluated. Rebuilding the rules from the parsed
   * list rather than from the normalised week would let the two disagree about an override.
   */
  it("stores rules that round-trip to the same week", () => {
    const first = normalize(SUPPORTED_HOURS.closedOneDay);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const rendered = first.schedule.rules
      .map((rule) =>
        rule.intervals.length === 0
          ? `${rule.days.join(",")} off`
          : `${rule.days.join(",")} ${rule.intervals
              .map((interval) => `${interval.opensAt}-${interval.closesAt}`)
              .join(",")}`,
      )
      .join("; ");

    const second = normalize(rendered);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.week).toEqual(first.week);
  });

  it("passes a parse failure through with its reason", () => {
    const result = normalize("Mo-Fr 09:00-17:00; PH off");

    expect(result).toMatchObject({ ok: false, reason: "unsupported_syntax" });
  });

  it("is deterministic", () => {
    for (const source of Object.values(SUPPORTED_HOURS)) {
      expect(JSON.stringify(normalize(source))).toBe(
        JSON.stringify(normalize(source)),
      );
    }
  });
});

describe("mergeIntervals", () => {
  it("unions overlapping same-day intervals", () => {
    expect(
      mergeIntervals([
        { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
        { opensAt: "11:00", closesAt: "17:00", crossesMidnight: false },
      ]),
    ).toEqual([{ opensAt: "09:00", closesAt: "17:00", crossesMidnight: false }]);
  });

  it("unions intervals that merely touch", () => {
    expect(
      mergeIntervals([
        { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
        { opensAt: "12:00", closesAt: "17:00", crossesMidnight: false },
      ]),
    ).toEqual([{ opensAt: "09:00", closesAt: "17:00", crossesMidnight: false }]);
  });

  /**
   * A real lunch break must survive. Merging across it would report a museum open at
   * 12:30 when it is shut, which is the exact failure this module exists to prevent.
   */
  it("leaves a genuine gap alone", () => {
    const split = [
      { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
      { opensAt: "13:00", closesAt: "17:00", crossesMidnight: false },
    ];
    expect(mergeIntervals(split)).toEqual(split);
  });

  it("sorts intervals given out of order", () => {
    expect(
      mergeIntervals([
        { opensAt: "13:00", closesAt: "17:00", crossesMidnight: false },
        { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
      ]),
    ).toEqual([
      { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
      { opensAt: "13:00", closesAt: "17:00", crossesMidnight: false },
    ]);
  });

  it("never merges an overnight interval into a same-day one", () => {
    const result = mergeIntervals([
      { opensAt: "09:00", closesAt: "17:00", crossesMidnight: false },
      { opensAt: "18:00", closesAt: "02:00", crossesMidnight: true },
    ]);

    expect(result).toHaveLength(2);
    expect(result[1].crossesMidnight).toBe(true);
  });

  it("returns nothing for nothing", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("dayOfWeekFor", () => {
  it("reads the calendar weekday", () => {
    expect(dayOfWeekFor(DATES.saturday)).toBe("Sa");
    expect(dayOfWeekFor(DATES.sunday)).toBe("Su");
    expect(dayOfWeekFor(DATES.monday)).toBe("Mo");
    expect(dayOfWeekFor(DATES.wednesday)).toBe("We");
  });

  /**
   * The classic bug this guards: `new Date("2026-09-12")` is UTC midnight, and reading its
   * *local* weekday west of Greenwich gives Friday. The calendar weekday of a plain date is
   * the same everywhere, so this must not depend on where the process runs.
   */
  it("does not depend on the machine's timezone", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["Pacific/Honolulu", "Pacific/Kiritimati", "UTC"]) {
        process.env.TZ = zone;
        expect(dayOfWeekFor(DATES.saturday), zone).toBe("Sa");
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("rejects anything that is not an ISO date", () => {
    for (const value of ["2026-9-12", "12/09/2026", "2026-13-01", "", "today"]) {
      expect(dayOfWeekFor(value), value).toBeNull();
    }
  });
});

describe("previousDay", () => {
  it("steps back one day, wrapping at the start of the week", () => {
    expect(previousDay("Tu")).toBe("Mo");
    expect(previousDay("Mo")).toBe("Su");
    expect(previousDay("Su")).toBe("Sa");
  });
});
