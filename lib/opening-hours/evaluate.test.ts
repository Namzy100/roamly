import { describe, expect, it } from "vitest";

import { evaluateScheduledVisit, openIntervalsForDate } from "./evaluate";
import {
  DATES,
  MALFORMED_HOURS,
  SUPPORTED_HOURS,
  TIMEZONES,
  UNSUPPORTED_HOURS,
} from "./fixtures";
import { isConfirmed, isUnknown } from "./types";

/**
 * The two claims this module is allowed to make, and the many it is not.
 *
 * Every `unknown_*` case below is a case where a lenient implementation would have said
 * "closed" — and "closed" is a claim a traveller may act on by not going.
 */

function evaluate(input: {
  openingHours?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string | undefined;
}) {
  return evaluateScheduledVisit({
    date: input.date ?? DATES.monday,
    startTime: input.startTime ?? "10:00",
    endTime: input.endTime ?? "11:00",
    timezone: "timezone" in input ? input.timezone : TIMEZONES.lisbon,
    ...(input.openingHours === undefined
      ? {}
      : { openingHours: input.openingHours }),
  });
}

describe("evaluateScheduledVisit — confirmed open", () => {
  it("confirms a visit inside published hours", () => {
    const result = evaluate({ openingHours: SUPPORTED_HOURS.weekdayRange });

    expect(result.status).toBe("confirmed_open");
    if (result.status !== "confirmed_open") return;
    expect(result.interval).toEqual({
      opensAt: "09:00",
      closesAt: "17:00",
      crossesMidnight: false,
    });
    expect(result.sourceText).toBe(SUPPORTED_HOURS.weekdayRange);
  });

  it("confirms a visit that exactly fills an open period", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.weekdayRange,
        startTime: "09:00",
        endTime: "17:00",
      }).status,
    ).toBe("confirmed_open");
  });

  it("confirms a visit inside the second interval of a split day", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.splitDay,
        startTime: "14:00",
        endTime: "15:00",
      }).status,
    ).toBe("confirmed_open");
  });

  it("confirms any time when the place is always open", () => {
    for (const startTime of ["00:00", "03:15", "23:00"]) {
      expect(
        evaluate({
          openingHours: SUPPORTED_HOURS.alwaysOpen,
          startTime,
          endTime: "23:59",
        }).status,
        startTime,
      ).toBe("confirmed_open");
    }
  });

  it("confirms a visit inside an interval that closes at midnight", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.midnightClose,
        startTime: "23:00",
        endTime: "24:00",
      }).status,
    ).toBe("confirmed_open");
  });

  it("confirms a visit inside an overnight interval before midnight", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.overnight,
        date: DATES.saturday,
        startTime: "21:00",
        endTime: "23:00",
      }).status,
    ).toBe("confirmed_open");
  });

  /**
   * A visit that itself crosses midnight, inside an interval that also does. Both are
   * expressed as an end earlier than the start, and the containment test has to line them
   * up rather than treating either as reversed.
   */
  it("confirms a visit that crosses midnight inside an overnight interval", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.overnight,
        date: DATES.saturday,
        startTime: "23:00",
        endTime: "01:00",
      }).status,
    ).toBe("confirmed_open");
  });

  /**
   * Sunday 00:30 is inside Saturday's `18:00-02:00`. The interval belongs to the previous
   * calendar day, which is why the previous day's rules are consulted at all.
   */
  it("confirms an early-morning visit inside yesterday's overnight interval", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.overnight,
        date: DATES.sunday,
        startTime: "00:30",
        endTime: "01:30",
      }).status,
    ).toBe("confirmed_open");
  });
});

describe("evaluateScheduledVisit — confirmed closed", () => {
  it("reports a closed day", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.weekdayRange,
      date: DATES.saturday,
    });

    expect(result.status).toBe("confirmed_closed");
  });

  it("reports a day a later rule closed", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.closedOneDay,
        date: DATES.wednesday,
      }).status,
    ).toBe("confirmed_closed");
  });

  it("reports a visit before opening, with the same-day opening time", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.weekdayRange,
      startTime: "07:00",
      endTime: "08:00",
    });

    expect(result.status).toBe("confirmed_closed");
    if (result.status !== "confirmed_closed") return;
    expect(result.nextKnownOpening).toBe("09:00");
  });

  /**
   * The case the whole-visit rule exists for. A traveller arriving at 16:30 for a museum
   * that shuts at 17:00 gets half an hour, and calling that "open" is the least useful
   * answer available.
   */
  it("reports a visit that runs past closing time", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.weekdayRange,
      startTime: "16:30",
      endTime: "18:00",
    });

    expect(result.status).toBe("confirmed_closed");
  });

  it("reports a visit spanning a lunch break", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.splitDay,
        startTime: "11:30",
        endTime: "13:30",
      }).status,
    ).toBe("confirmed_closed");
  });

  it("offers the afternoon opening when the visit falls in the lunch gap", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.splitDay,
      startTime: "12:15",
      endTime: "12:45",
    });

    expect(result.status).toBe("confirmed_closed");
    if (result.status !== "confirmed_closed") return;
    expect(result.nextKnownOpening).toBe("13:00");
  });

  it("offers no next opening when the day is over", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.weekdayRange,
      startTime: "19:00",
      endTime: "20:00",
    });

    expect(result.status).toBe("confirmed_closed");
    if (result.status !== "confirmed_closed") return;
    expect(result.nextKnownOpening).toBeUndefined();
  });

  it("reports a place recorded as closed", () => {
    expect(evaluate({ openingHours: SUPPORTED_HOURS.closed }).status).toBe(
      "confirmed_closed",
    );
  });
});

describe("evaluateScheduledVisit — what it refuses to claim", () => {
  /**
   * The central invariant. Every one of these is a case where the place may well be open,
   * and answering "closed" would tell a traveller not to go.
   */
  it("never reports closed merely because something is unknown", () => {
    const unknowable = [
      { label: "no data", input: {} },
      { label: "empty string", input: { openingHours: "   " } },
      {
        label: "no timezone",
        input: {
          openingHours: SUPPORTED_HOURS.weekdayRange,
          timezone: undefined,
        },
      },
      {
        label: "invalid timezone",
        input: {
          openingHours: SUPPORTED_HOURS.weekdayRange,
          timezone: TIMEZONES.invalid,
        },
      },
      {
        label: "public holiday rule",
        input: { openingHours: UNSUPPORTED_HOURS.publicHoliday },
      },
      {
        label: "seasonal rule",
        input: { openingHours: UNSUPPORTED_HOURS.seasonal },
      },
      {
        label: "malformed hours",
        input: { openingHours: MALFORMED_HOURS.invalidHour },
      },
      { label: "bad date", input: { openingHours: "24/7", date: "not-a-date" } },
    ];

    for (const entry of unknowable) {
      const result = evaluate(entry.input);
      expect(isUnknown(result), entry.label).toBe(true);
      expect(isConfirmed(result), entry.label).toBe(false);
    }
  });

  it("reports missing data as such", () => {
    const result = evaluate({});
    expect(result.status).toBe("unknown_no_data");
  });

  it("reports an unparsable string as unparsed and keeps the original", () => {
    const result = evaluate({ openingHours: MALFORMED_HOURS.invalidDay });

    expect(result.status).toBe("unknown_unparsed");
    if (result.status !== "unknown_unparsed") return;
    expect(result.sourceText).toBe(MALFORMED_HOURS.invalidDay);
  });

  /**
   * The holiday clause is the reason `unsupported_syntax` is not just "unparsed with extra
   * steps": `Mo-Fr 09:00-17:00; PH off` is readable as weekday hours, and reading it that
   * way is wrong exactly when it matters.
   */
  it("reports a holiday rule as unparsed rather than reading the half it understands", () => {
    const result = evaluate({ openingHours: UNSUPPORTED_HOURS.publicHoliday });

    expect(result.status).toBe("unknown_unparsed");
    if (result.status !== "unknown_unparsed") return;
    expect(result.sourceText).toBe(UNSUPPORTED_HOURS.publicHoliday);
  });

  it("reports an unknown timezone before attempting to parse", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.weekdayRange,
      timezone: undefined,
    });

    expect(result.status).toBe("unknown_timezone");
    if (result.status !== "unknown_timezone") return;
    expect(result.sourceText).toBe(SUPPORTED_HOURS.weekdayRange);
  });

  it("reports an unrecognised timezone as unknown, not invalid data", () => {
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.weekdayRange,
        timezone: TIMEZONES.invalid,
      }).status,
    ).toBe("unknown_timezone");
  });

  it("keeps the source text on every state that has one", () => {
    const source = UNSUPPORTED_HOURS.sunset;
    const result = evaluate({ openingHours: source });

    expect(result.status).toBe("unknown_unparsed");
    if (!("sourceText" in result)) throw new Error("expected source text");
    expect(result.sourceText).toBe(source);
  });
});

describe("evaluateScheduledVisit — daylight saving", () => {
  /**
   * 01:30 on 2026-03-29 in Lisbon does not exist. The place's hours are not what is wrong,
   * so this is `unknown_exception` rather than `confirmed_closed` — the schedule is the
   * problem and the traveller should be told that instead.
   */
  it("cannot evaluate a local time the clocks skipped", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.alwaysOpen,
      date: DATES.dstSpringForward,
      startTime: "01:30",
      endTime: "02:30",
      timezone: TIMEZONES.lisbon,
    });

    expect(result.status).toBe("unknown_exception");
  });

  it("cannot evaluate a local time that happens twice", () => {
    const result = evaluate({
      openingHours: SUPPORTED_HOURS.alwaysOpen,
      date: DATES.dstFallBack,
      startTime: "02:30",
      endTime: "03:00",
      timezone: TIMEZONES.berlin,
    });

    expect(result.status).toBe("unknown_exception");
  });

  it("evaluates normally on the rest of a transition day", () => {
    expect(
      evaluate({
        openingHours: "Mo-Su 09:00-17:00",
        date: DATES.dstSpringForward,
        startTime: "10:00",
        endTime: "11:00",
        timezone: TIMEZONES.lisbon,
      }).status,
    ).toBe("confirmed_open");
  });
});

describe("evaluateScheduledVisit — determinism and isolation", () => {
  /**
   * A traveller in Honolulu planning Lisbon must see Lisbon's answer. If the device zone
   * leaked in, a 10:00 Lisbon visit would be evaluated against 23:00 the day before.
   */
  it("gives the same answer whatever the machine's timezone is", () => {
    const original = process.env.TZ;
    const statuses: string[] = [];

    try {
      for (const zone of ["Pacific/Honolulu", "Asia/Tokyo", "UTC", "Europe/Berlin"]) {
        process.env.TZ = zone;
        statuses.push(
          evaluate({
            openingHours: SUPPORTED_HOURS.weekdayRange,
            date: DATES.monday,
            startTime: "09:30",
            endTime: "10:30",
          }).status,
        );
      }
    } finally {
      process.env.TZ = original;
    }

    expect(new Set(statuses)).toEqual(new Set(["confirmed_open"]));
  });

  it("is deterministic", () => {
    const input = {
      openingHours: SUPPORTED_HOURS.twoRules,
      date: DATES.saturday,
      startTime: "13:00",
      endTime: "15:00",
    };
    expect(JSON.stringify(evaluate(input))).toBe(
      JSON.stringify(evaluate(input)),
    );
  });

  it("never consults the clock", () => {
    // A date years in the past evaluates by rule, not by "has it happened".
    expect(
      evaluate({
        openingHours: SUPPORTED_HOURS.weekdayRange,
        date: "2001-09-10",
        startTime: "10:00",
        endTime: "11:00",
      }).status,
    ).toBe("confirmed_open");
  });
});

describe("openIntervalsForDate", () => {
  it("lists the open intervals for a day", () => {
    expect(
      openIntervalsForDate({
        openingHours: SUPPORTED_HOURS.splitDay,
        date: DATES.monday,
        timezone: TIMEZONES.lisbon,
      }),
    ).toEqual([
      { opensAt: "09:00", closesAt: "12:00", crossesMidnight: false },
      { opensAt: "13:00", closesAt: "17:00", crossesMidnight: false },
    ]);
  });

  /**
   * Emptiness here is deliberately ambiguous — "closed that day" and "we could not tell"
   * both produce `[]`, so a caller must never read it as closure. Only
   * `evaluateScheduledVisit` may make that call.
   */
  it("returns nothing for anything it cannot interpret", () => {
    const cases = [
      {},
      { openingHours: SUPPORTED_HOURS.weekdayRange },
      { openingHours: UNSUPPORTED_HOURS.publicHoliday, timezone: TIMEZONES.lisbon },
      { openingHours: MALFORMED_HOURS.invalidHour, timezone: TIMEZONES.lisbon },
      { openingHours: "24/7", date: "nonsense", timezone: TIMEZONES.lisbon },
    ];

    for (const entry of cases) {
      expect(
        openIntervalsForDate({ date: DATES.monday, ...entry }),
        JSON.stringify(entry),
      ).toEqual([]);
    }
  });

  it("returns nothing for a day the place is closed", () => {
    expect(
      openIntervalsForDate({
        openingHours: SUPPORTED_HOURS.weekdayRange,
        date: DATES.saturday,
        timezone: TIMEZONES.lisbon,
      }),
    ).toEqual([]);
  });
});
