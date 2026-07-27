import { describe, expect, it } from "vitest";

import { SUPPORTED_HOURS, TIMEZONES, UNSUPPORTED_HOURS } from "@/lib/opening-hours/fixtures";
import type { ItineraryItem, TripPlace } from "@/lib/schemas";

import {
  buildScheduleAccuracyReport,
  conflictsForDay,
  evaluateItem,
  evaluatePlanItems,
  hasScheduleConflicts,
  reportTotalsReconcile,
} from "./schedule-report";
import {
  FIXTURE_PLACES,
  fixtureDay,
  fixtureItem,
  fixturePlan,
} from "./test-fixtures";

/**
 * Day 1 of a fixture plan is 2026-09-12, a Saturday; day 3 is Monday the 14th. That is what
 * makes "closed at the weekend" and "open on a weekday" testable without a test having to
 * work out a weekday in its head.
 */
const SATURDAY_DAY = 1;
const MONDAY_DAY = 3;

function withHours(place: TripPlace, openingHours?: string): TripPlace {
  return openingHours === undefined ? place : { ...place, openingHours };
}

function planWith(
  items: { day: number; item: ItineraryItem }[],
): ReturnType<typeof fixturePlan> {
  const dayNumbers = [...new Set(items.map((entry) => entry.day))].sort();
  return fixturePlan(
    dayNumbers.map((dayNumber) =>
      fixtureDay(
        dayNumber,
        items
          .filter((entry) => entry.day === dayNumber)
          .map((entry, index) => ({ ...entry.item, order: index })),
      ),
    ),
  );
}

function report(
  items: { day: number; item: ItineraryItem }[],
  timezone: string | null = TIMEZONES.lisbon,
) {
  return buildScheduleAccuracyReport({ plan: planWith(items), timezone });
}

describe("buildScheduleAccuracyReport — a clear schedule", () => {
  it("confirms a weekday visit inside published hours", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange), {
          startTime: "10:00",
          endTime: "11:00",
        }),
      },
    ]);

    expect(result.status).toBe("clear");
    expect(result.checkedItems).toBe(1);
    expect(result.confirmedOpenItems).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.timezone).toBe(TIMEZONES.lisbon);
  });

  it("counts every confirmed stop across days", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, "Mo-Su 09:00-18:00")),
      },
      {
        day: MONDAY_DAY,
        item: fixtureItem("b", withHours(FIXTURE_PLACES.b, "24/7"), {
          startTime: "14:00",
          endTime: "15:00",
        }),
      },
      {
        day: SATURDAY_DAY,
        item: fixtureItem("c", withHours(FIXTURE_PLACES.c, "Sa-Su 10:00-16:00")),
      },
    ]);

    expect(result.status).toBe("clear");
    expect(result.confirmedOpenItems).toBe(3);
    expect(reportTotalsReconcile(result)).toBe(true);
  });
});

describe("buildScheduleAccuracyReport — conflicts", () => {
  it("reports a stop scheduled on a day the place is closed", () => {
    const result = report([
      {
        day: SATURDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange)),
      },
    ]);

    expect(result.status).toBe("conflicts");
    expect(hasScheduleConflicts(result)).toBe(true);
    expect(result.confirmedClosedItems).toBe(1);
    expect(result.conflicts).toHaveLength(1);

    const [conflict] = result.conflicts;
    expect(conflict.itemId).toBe("a");
    expect(conflict.dayNumber).toBe(SATURDAY_DAY);
    expect(conflict.placeId).toBe(FIXTURE_PLACES.a.placeId);
    // The OSM string verbatim, so a traveller can check us.
    expect(conflict.sourceText).toBe(SUPPORTED_HOURS.weekdayRange);
    expect(conflict.message).toContain(SUPPORTED_HOURS.weekdayRange);
  });

  it("classifies a visit before opening and offers the opening time", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    const [conflict] = result.conflicts;
    expect(conflict.kind).toBe("visit_starts_before_opening");
    expect(conflict.nextKnownOpening).toBe("09:00");
  });

  it("classifies a visit that runs past closing", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange), {
          startTime: "16:30",
          endTime: "18:00",
        }),
      },
    ]);

    const [conflict] = result.conflicts;
    expect(conflict.kind).toBe("visit_extends_past_closing");
    expect(conflict.nextKnownOpening).toBeUndefined();
  });

  /**
   * A conflict is actionable and a warning is not, so one confirmed closure must not be
   * buried under nine unknowns.
   */
  it("ranks a conflict above warnings", () => {
    const result = report([
      {
        day: SATURDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange)),
      },
      { day: SATURDAY_DAY, item: fixtureItem("b", FIXTURE_PLACES.b) },
      {
        day: SATURDAY_DAY,
        item: fixtureItem("c", withHours(FIXTURE_PLACES.c, UNSUPPORTED_HOURS.publicHoliday)),
      },
    ]);

    expect(result.status).toBe("conflicts");
    expect(result.conflicts).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(reportTotalsReconcile(result)).toBe(true);
  });

  it("scopes conflicts to a day", () => {
    const result = report([
      {
        day: SATURDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange)),
      },
      {
        day: MONDAY_DAY,
        item: fixtureItem("b", withHours(FIXTURE_PLACES.b, SUPPORTED_HOURS.weekdayRange)),
      },
    ]);

    expect(conflictsForDay(result, SATURDAY_DAY)).toHaveLength(1);
    expect(conflictsForDay(result, MONDAY_DAY)).toHaveLength(0);
    expect(conflictsForDay(result, 99)).toHaveLength(0);
  });
});

describe("buildScheduleAccuracyReport — warnings, which are never conflicts", () => {
  /**
   * The invariant, at plan level: none of these is evidence a place is shut, so none of them
   * may produce a conflict a traveller might act on by not going.
   */
  it("never turns unknown data into a conflict", () => {
    const cases: { label: string; hours?: string; timezone?: string | null }[] = [
      { label: "no hours recorded", hours: undefined },
      { label: "holiday rule", hours: UNSUPPORTED_HOURS.publicHoliday },
      { label: "seasonal rule", hours: UNSUPPORTED_HOURS.seasonal },
      { label: "malformed", hours: "Mo-Fr 25:00-26:00" },
      {
        label: "no timezone",
        hours: SUPPORTED_HOURS.weekdayRange,
        timezone: null,
      },
    ];

    for (const entry of cases) {
      const result = report(
        [
          {
            day: MONDAY_DAY,
            item: fixtureItem("a", withHours(FIXTURE_PLACES.a, entry.hours)),
          },
        ],
        entry.timezone === undefined ? TIMEZONES.lisbon : entry.timezone,
      );

      expect(result.conflicts, entry.label).toEqual([]);
      expect(result.confirmedClosedItems, entry.label).toBe(0);
      expect(result.warnings, entry.label).toHaveLength(1);
      expect(result.unknownItems, entry.label).toBe(1);
    }
  });

  it("codes a missing string as no published hours", () => {
    const result = report([
      { day: MONDAY_DAY, item: fixtureItem("a", FIXTURE_PLACES.a) },
    ]);

    expect(result.warnings[0].code).toBe("no_published_hours");
    expect(result.warnings[0].sourceText).toBeUndefined();
    expect(result.status).toBe("unknown");
  });

  it("codes an unreadable string as not interpreted and keeps it", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, UNSUPPORTED_HOURS.publicHoliday)),
      },
    ]);

    expect(result.warnings[0].code).toBe("hours_not_interpreted");
    expect(result.warnings[0].sourceText).toBe(UNSUPPORTED_HOURS.publicHoliday);
  });

  it("codes an absent timezone as such, for every item", () => {
    const result = report(
      [
        {
          day: MONDAY_DAY,
          item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange)),
        },
        {
          day: MONDAY_DAY,
          item: fixtureItem("b", withHours(FIXTURE_PLACES.b, "24/7")),
        },
      ],
      null,
    );

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "timezone_unknown",
      "timezone_unknown",
    ]);
    expect(result.timezone).toBeNull();
    expect(result.status).toBe("unknown");
  });

  it("reports warnings as the status when something was confirmed too", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, "Mo-Su 09:00-18:00")),
      },
      { day: MONDAY_DAY, item: fixtureItem("b", FIXTURE_PLACES.b) },
    ]);

    expect(result.status).toBe("warnings");
    expect(result.confirmedOpenItems).toBe(1);
    expect(result.unknownItems).toBe(1);
  });
});

describe("buildScheduleAccuracyReport — what is not checked", () => {
  /**
   * An open afternoon is not a data gap. Counting it as unknown would make an honest
   * itinerary look unverifiable.
   */
  it("ignores items with no place", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, "Mo-Su 09:00-18:00")),
      },
      {
        day: MONDAY_DAY,
        item: fixtureItem("free", null, {
          kind: "rest",
          startTime: "13:00",
          endTime: "14:00",
        }),
      },
    ]);

    expect(result.checkedItems).toBe(1);
    expect(result.status).toBe("clear");
  });

  it("ignores a slot the search could not fill", () => {
    const result = report([
      {
        day: MONDAY_DAY,
        item: fixtureItem("unfilled", null, { status: "unavailable" }),
      },
    ]);

    expect(result.checkedItems).toBe(0);
    expect(result.status).toBe("unknown");
    expect(result.warnings).toEqual([]);
  });

  /**
   * A hotel's `opening_hours` describes its reception desk, not whether you may sleep there.
   * The accommodation is not an itinerary item, so it is never evaluated — asserted here
   * because a plausible future edit is to start including it.
   */
  it("does not evaluate the accommodation", () => {
    const plan = planWith([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, "Mo-Su 09:00-18:00")),
      },
    ]);
    const result = buildScheduleAccuracyReport({
      plan: {
        ...plan,
        accommodation: {
          ...plan.accommodation!,
          place: withHours(FIXTURE_PLACES.stay, SUPPORTED_HOURS.weekdayRange),
        },
      },
      timezone: TIMEZONES.lisbon,
    });

    expect(result.checkedItems).toBe(1);
    expect(result.status).toBe("clear");
  });

  it("reports an empty plan as unknown rather than clear", () => {
    const result = report([
      { day: MONDAY_DAY, item: fixtureItem("free", null, { kind: "rest" }) },
    ]);

    expect(result.status).toBe("unknown");
    expect(result.checkedItems).toBe(0);
    expect(reportTotalsReconcile(result)).toBe(true);
  });
});

describe("evaluatePlanItems", () => {
  it("returns a verdict for every item, including the ones not applicable", () => {
    const plan = planWith([
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, "Mo-Su 09:00-18:00")),
      },
      { day: MONDAY_DAY, item: fixtureItem("free", null, { kind: "rest" }) },
    ]);

    const evaluations = evaluatePlanItems({ plan, timezone: TIMEZONES.lisbon });

    expect(evaluations).toHaveLength(2);
    expect(evaluations[0].evaluation.status).toBe("confirmed_open");
    expect(evaluations[1].evaluation.status).toBe("not_applicable");
    expect(evaluations[0].dayNumber).toBe(MONDAY_DAY);
  });

  /**
   * The cards and the report must agree — two derivations of the same verdict would
   * eventually disagree, and the one on the card is the one a traveller reads.
   */
  it("agrees with the report about every item", () => {
    const items = [
      {
        day: MONDAY_DAY,
        item: fixtureItem("open", withHours(FIXTURE_PLACES.a, "Mo-Su 09:00-18:00")),
      },
      {
        day: SATURDAY_DAY,
        item: fixtureItem("closed", withHours(FIXTURE_PLACES.b, SUPPORTED_HOURS.weekdayRange)),
      },
      { day: SATURDAY_DAY, item: fixtureItem("unknown", FIXTURE_PLACES.c) },
    ];
    const plan = planWith(items);
    const evaluations = evaluatePlanItems({ plan, timezone: TIMEZONES.lisbon });
    const result = buildScheduleAccuracyReport({ plan, timezone: TIMEZONES.lisbon });

    const closed = evaluations.filter(
      (entry) => entry.evaluation.status === "confirmed_closed",
    );
    expect(closed.map((entry) => entry.itemId)).toEqual(
      result.conflicts.map((conflict) => conflict.itemId),
    );
  });
});

describe("evaluateItem", () => {
  it("is not applicable for an item with no place", () => {
    expect(
      evaluateItem(fixtureItem("x", null), "2026-09-14", TIMEZONES.lisbon).status,
    ).toBe("not_applicable");
  });

  it("is not applicable for an unavailable item even when it has a place", () => {
    expect(
      evaluateItem(
        fixtureItem("x", withHours(FIXTURE_PLACES.a, "24/7"), {
          status: "unavailable",
        }),
        "2026-09-14",
        TIMEZONES.lisbon,
      ).status,
    ).toBe("not_applicable");
  });

  it("evaluates a confirmed item against the day's date", () => {
    const item = fixtureItem(
      "x",
      withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange),
    );

    expect(evaluateItem(item, "2026-09-14", TIMEZONES.lisbon).status).toBe(
      "confirmed_open",
    );
    expect(evaluateItem(item, "2026-09-12", TIMEZONES.lisbon).status).toBe(
      "confirmed_closed",
    );
  });

  it("is unknown without a timezone", () => {
    expect(
      evaluateItem(
        fixtureItem("x", withHours(FIXTURE_PLACES.a, "24/7")),
        "2026-09-14",
      ).status,
    ).toBe("unknown_timezone");
  });
});

describe("the report is derived, not remembered", () => {
  it("is a pure function of the plan and the timezone", () => {
    const items = [
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.twoRules)),
      },
    ];

    expect(JSON.stringify(report(items))).toBe(JSON.stringify(report(items)));
  });

  it("changes when the timezone does, without the plan changing", () => {
    const items = [
      {
        day: MONDAY_DAY,
        item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange)),
      },
    ];

    expect(report(items, TIMEZONES.lisbon).status).toBe("clear");
    expect(report(items, null).status).toBe("unknown");
  });

  it("reconciles its totals in every scenario above", () => {
    const scenarios = [
      [{ day: MONDAY_DAY, item: fixtureItem("a", withHours(FIXTURE_PLACES.a, "24/7")) }],
      [
        {
          day: SATURDAY_DAY,
          item: fixtureItem("a", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.weekdayRange)),
        },
      ],
      [{ day: MONDAY_DAY, item: fixtureItem("a", FIXTURE_PLACES.a) }],
      [{ day: MONDAY_DAY, item: fixtureItem("a", null, { kind: "rest" }) }],
    ];

    for (const scenario of scenarios) {
      expect(reportTotalsReconcile(report(scenario))).toBe(true);
    }
  });
});
