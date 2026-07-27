import { describe, expect, it } from "vitest";

import { DATES, TIMEZONES } from "./fixtures";
import {
  isSupportedTimezone,
  offsetMinutesAt,
  resolveDestinationTimezone,
  resolveWallClock,
} from "./timezone";

describe("resolveDestinationTimezone", () => {
  it("resolves a known city by name", () => {
    expect(
      resolveDestinationTimezone({ name: "Lisbon", countryCode: "pt" }),
    ).toEqual({ timezone: "Europe/Lisbon", source: "city" });
  });

  it("resolves a city from a segment of the display name", () => {
    expect(
      resolveDestinationTimezone({
        name: "Ciutat Vella",
        displayName: "Ciutat Vella, Barcelona, Catalonia, Spain",
        countryCode: "es",
      }),
    ).toEqual({ timezone: "Europe/Madrid", source: "city" });
  });

  it("ignores case and surrounding whitespace", () => {
    expect(
      resolveDestinationTimezone({ name: "  CAPE TOWN  " })?.timezone,
    ).toBe("Africa/Johannesburg");
  });

  it("resolves a single-timezone country from its code alone", () => {
    expect(
      resolveDestinationTimezone({ name: "Naples", countryCode: "IT" }),
    ).toEqual({ timezone: "Europe/Rome", source: "country" });
  });

  /**
   * The reason the module exists. Lisbon and Funchal are both Portugal and an hour apart,
   * so "pt" is not an answer — picking the mainland would be silently wrong for Madeira
   * with nothing in the output to reveal it.
   */
  it("refuses to guess for a country with more than one timezone", () => {
    expect(
      resolveDestinationTimezone({ name: "Alentejo", countryCode: "pt" }),
    ).toBeNull();
    expect(
      resolveDestinationTimezone({ name: "Karoo", countryCode: "za" }),
    ).toBeNull();
    expect(
      resolveDestinationTimezone({ name: "Nowhere", countryCode: "us" }),
    ).toBeNull();
  });

  it("returns null for a country not in the table", () => {
    expect(
      resolveDestinationTimezone({ name: "Somewhere", countryCode: "zz" }),
    ).toBeNull();
  });

  it("returns null with nothing to go on", () => {
    expect(resolveDestinationTimezone({})).toBeNull();
    expect(resolveDestinationTimezone({ name: "" })).toBeNull();
  });

  it("only returns zones the platform recognises", () => {
    const destinations = [
      { name: "Lisbon" },
      { name: "Dubai" },
      { name: "Cape Town" },
      { name: "Athens" },
      { name: "Barcelona" },
      { name: "Rome", countryCode: "it" },
      { name: "Tokyo", countryCode: "jp" },
    ];

    for (const destination of destinations) {
      const resolved = resolveDestinationTimezone(destination);
      expect(resolved, destination.name).not.toBeNull();
      expect(isSupportedTimezone(resolved!.timezone), resolved!.timezone).toBe(
        true,
      );
    }
  });
});

describe("isSupportedTimezone", () => {
  it("accepts real IANA zones", () => {
    expect(isSupportedTimezone(TIMEZONES.lisbon)).toBe(true);
    expect(isSupportedTimezone("UTC")).toBe(true);
  });

  it("rejects an invented zone", () => {
    expect(isSupportedTimezone(TIMEZONES.invalid)).toBe(false);
    expect(isSupportedTimezone("")).toBe(false);
  });
});

describe("offsetMinutesAt", () => {
  it("reads a positive offset", () => {
    expect(
      offsetMinutesAt(new Date("2026-07-15T12:00:00Z"), TIMEZONES.berlin),
    ).toBe(120);
  });

  it("reads a zero offset as zero rather than null", () => {
    expect(offsetMinutesAt(new Date("2026-01-15T12:00:00Z"), "UTC")).toBe(0);
    // Lisbon is GMT+00:00 in winter, which formats as a bare "GMT".
    expect(
      offsetMinutesAt(new Date("2026-01-15T12:00:00Z"), TIMEZONES.lisbon),
    ).toBe(0);
  });

  it("reads a half-hour offset", () => {
    expect(offsetMinutesAt(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata")).toBe(
      330,
    );
  });

  it("follows the zone across a DST transition", () => {
    const winter = offsetMinutesAt(
      new Date("2026-01-15T12:00:00Z"),
      TIMEZONES.berlin,
    );
    const summer = offsetMinutesAt(
      new Date("2026-07-15T12:00:00Z"),
      TIMEZONES.berlin,
    );

    expect(winter).toBe(60);
    expect(summer).toBe(120);
  });

  it("returns null for an invalid zone", () => {
    expect(offsetMinutesAt(new Date(), TIMEZONES.invalid)).toBeNull();
  });
});

describe("resolveWallClock", () => {
  it("resolves an ordinary local time to the instant it names", () => {
    const result = resolveWallClock({
      date: DATES.saturday,
      time: "10:00",
      timezone: TIMEZONES.lisbon,
    });

    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    // Lisbon is WEST (+01:00) in September.
    expect(result.offsetMinutes).toBe(60);
    expect(result.instant.toISOString()).toBe("2026-09-12T09:00:00.000Z");
  });

  it("resolves in a zone with no DST at all", () => {
    const result = resolveWallClock({
      date: DATES.saturday,
      time: "14:30",
      timezone: TIMEZONES.johannesburg,
    });

    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    expect(result.offsetMinutes).toBe(120);
  });

  /**
   * 2026-03-29 in Lisbon: the clock goes 00:59 → 02:00, so 01:30 is a time that never
   * happens. Naive offset arithmetic would silently produce 00:30 or 02:30 and report
   * success; this must report that the wall clock does not exist.
   */
  it("reports a skipped local time on the spring-forward morning", () => {
    expect(
      resolveWallClock({
        date: DATES.dstSpringForward,
        time: "01:30",
        timezone: TIMEZONES.lisbon,
      }),
    ).toEqual({ status: "skipped" });
  });

  it("still resolves times either side of the spring-forward gap", () => {
    for (const time of ["00:30", "03:30", "10:00"]) {
      expect(
        resolveWallClock({
          date: DATES.dstSpringForward,
          time,
          timezone: TIMEZONES.lisbon,
        }).status,
        time,
      ).toBe("exact");
    }
  });

  /**
   * 2026-10-25 in Berlin: 02:00 → 01:00, so 02:30 occurs twice. "Is it open at 02:30?"
   * has two answers, and the caller is told so rather than being handed one of them.
   */
  it("reports an ambiguous local time on the fall-back morning", () => {
    const result = resolveWallClock({
      date: DATES.dstFallBack,
      time: "02:30",
      timezone: TIMEZONES.berlin,
    });

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    // The first occurrence, still on summer time.
    expect(result.offsetMinutes).toBe(120);
  });

  it("treats 24:00 as midnight rather than an invalid instant", () => {
    const result = resolveWallClock({
      date: DATES.saturday,
      time: "24:00",
      timezone: TIMEZONES.lisbon,
    });

    expect(result.status).toBe("exact");
  });

  it("rejects an invalid timezone", () => {
    expect(
      resolveWallClock({
        date: DATES.saturday,
        time: "10:00",
        timezone: TIMEZONES.invalid,
      }),
    ).toEqual({ status: "invalid_timezone" });
  });

  it("rejects a malformed date", () => {
    expect(
      resolveWallClock({
        date: "not-a-date",
        time: "10:00",
        timezone: TIMEZONES.lisbon,
      }),
    ).toEqual({ status: "invalid_timezone" });
  });

  /**
   * A traveller in Honolulu planning Lisbon must get Lisbon's answer. Nothing here may
   * read `process.env.TZ`, and the only way to be sure is to move it and check.
   */
  it("does not consult the machine's timezone", () => {
    const original = process.env.TZ;
    const results: string[] = [];

    try {
      for (const zone of ["Pacific/Honolulu", "Asia/Tokyo", "UTC"]) {
        process.env.TZ = zone;
        const result = resolveWallClock({
          date: DATES.saturday,
          time: "10:00",
          timezone: TIMEZONES.lisbon,
        });
        expect(result.status, zone).toBe("exact");
        if (result.status === "exact") results.push(result.instant.toISOString());
      }
    } finally {
      process.env.TZ = original;
    }

    expect(new Set(results).size).toBe(1);
  });

  it("is deterministic", () => {
    const input = {
      date: DATES.dstFallBack,
      time: "02:30",
      timezone: TIMEZONES.berlin,
    };
    expect(JSON.stringify(resolveWallClock(input))).toBe(
      JSON.stringify(resolveWallClock(input)),
    );
  });
});
