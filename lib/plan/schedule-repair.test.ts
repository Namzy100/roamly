import { describe, expect, it } from "vitest";

import { SUPPORTED_HOURS, TIMEZONES, UNSUPPORTED_HOURS } from "@/lib/opening-hours/fixtures";
import type { ItineraryItem, TripPlace, TripPlan } from "@/lib/schemas";

import { buildScheduleAccuracyReport } from "./schedule-report";
import { repairScheduleConflicts } from "./schedule-repair";
import {
  FIXTURE_PLACES,
  fixtureDay,
  fixtureItem,
  fixturePlan,
} from "./test-fixtures";

/** Day 1 of a fixture plan is Saturday 2026-09-12; day 3 is Monday the 14th. */
const SATURDAY = 1;
const MONDAY = 3;

function withHours(place: TripPlace, openingHours?: string): TripPlace {
  return openingHours === undefined ? place : { ...place, openingHours };
}

function planOf(entries: { day: number; item: ItineraryItem }[]): TripPlan {
  const dayNumbers = [...new Set(entries.map((entry) => entry.day))].sort();
  return fixturePlan(
    dayNumbers.map((dayNumber) =>
      fixtureDay(
        dayNumber,
        entries
          .filter((entry) => entry.day === dayNumber)
          .map((entry, index) => ({ ...entry.item, order: index })),
      ),
    ),
  );
}

function repair(
  entries: { day: number; item: ItineraryItem }[],
  timezone: string | null = TIMEZONES.lisbon,
) {
  return repairScheduleConflicts({ plan: planOf(entries), timezone });
}

function itemAt(plan: TripPlan, dayNumber: number, itemId: string) {
  const day = plan.days.find((entry) => entry.dayNumber === dayNumber);
  return day?.items.find((entry) => entry.id === itemId);
}

describe("repairScheduleConflicts — what it fixes", () => {
  it("moves a stop scheduled before opening into the open interval", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    expect(result.changes).toHaveLength(1);
    expect(result.unresolvedItemIds).toEqual([]);

    const moved = itemAt(result.plan, MONDAY, "early");
    expect(moved?.startTime).toBe("10:00");
    // The duration is preserved, not stretched to fill the interval.
    expect(moved?.endTime).toBe("11:00");
  });

  it("moves a stop that overran closing back inside the interval", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("late", withHours(FIXTURE_PLACES.a, "Mo-Fr 09:00-17:00"), {
          startTime: "16:30",
          endTime: "18:00",
        }),
      },
    ]);

    const moved = itemAt(result.plan, MONDAY, "late");
    expect(moved?.startTime).toBe("09:00");
    expect(moved?.endTime).toBe("10:30");
  });

  it("moves a stop out of a lunch closure into the afternoon interval", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("lunchgap", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.splitDay), {
          startTime: "12:15",
          endTime: "12:45",
        }),
      },
    ]);

    const moved = itemAt(result.plan, MONDAY, "lunchgap");
    expect(moved?.startTime).toBe("09:00");
    expect(moved?.endTime).toBe("09:30");
  });

  it("records what it moved, and why", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    expect(result.changes[0]).toEqual({
      dayNumber: MONDAY,
      itemId: "early",
      placeName: FIXTURE_PLACES.a.name,
      from: { startTime: "07:00", endTime: "08:00" },
      to: { startTime: "10:00", endTime: "11:00" },
      interval: { opensAt: "10:00", closesAt: "18:00", crossesMidnight: false },
    });
  });

  it("leaves the repaired plan free of that conflict", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    const report = buildScheduleAccuracyReport({
      plan: result.plan,
      timezone: TIMEZONES.lisbon,
    });
    expect(report.conflicts).toEqual([]);
    expect(report.status).toBe("clear");
  });

  it("does not land on top of another stop", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("fixed", withHours(FIXTURE_PLACES.b, "24/7"), {
          startTime: "10:00",
          endTime: "12:00",
        }),
      },
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    const moved = itemAt(result.plan, MONDAY, "early");
    // 10:00–12:00 is taken and needs a ten-minute gap after it; candidates step in
    // quarter-hours, so the first that fits is 12:15 rather than 12:10.
    expect(moved?.startTime).toBe("12:15");
    expect(itemAt(result.plan, MONDAY, "fixed")?.startTime).toBe("10:00");
  });

  /**
   * `order` is what the cards and the routing legs are built from. A stop moved from the
   * morning to the afternoon whose `order` still says "first" would give a day whose
   * displayed sequence and whose actual times disagree.
   */
  it("renumbers order to match the new times", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("morning", withHours(FIXTURE_PLACES.a, "Mo-Fr 15:00-18:00"), {
          startTime: "09:00",
          endTime: "10:00",
        }),
      },
      {
        day: MONDAY,
        item: fixtureItem("midday", withHours(FIXTURE_PLACES.b, "24/7"), {
          startTime: "11:00",
          endTime: "12:00",
        }),
      },
    ]);

    const day = result.plan.days.find((entry) => entry.dayNumber === MONDAY);
    expect(day?.items.map((item) => item.id)).toEqual(["midday", "morning"]);
    expect(day?.items.map((item) => item.order)).toEqual([0, 1]);
  });
});

describe("repairScheduleConflicts — what it refuses to do", () => {
  it("does nothing at all when there is no conflict", () => {
    const entries = [
      {
        day: MONDAY,
        item: fixtureItem("fine", withHours(FIXTURE_PLACES.a, "Mo-Fr 09:00-18:00")),
      },
    ];
    const plan = planOf(entries);
    const result = repairScheduleConflicts({ plan, timezone: TIMEZONES.lisbon });

    expect(result.changes).toEqual([]);
    // The same object, not an equal copy: nothing was rebuilt.
    expect(result.plan).toBe(plan);
  });

  /**
   * Absence of evidence is not evidence of a problem. None of these is a conflict, so
   * none of them may cause the itinerary to be rearranged.
   */
  it("does not touch a stop whose hours could not be read", () => {
    for (const hours of [
      undefined,
      UNSUPPORTED_HOURS.publicHoliday,
      UNSUPPORTED_HOURS.seasonal,
      "Mo-Fr 25:00-26:00",
    ]) {
      const entries = [
        {
          day: MONDAY,
          item: fixtureItem("x", withHours(FIXTURE_PLACES.a, hours), {
            startTime: "07:00",
            endTime: "08:00",
          }),
        },
      ];
      const plan = planOf(entries);
      const result = repairScheduleConflicts({ plan, timezone: TIMEZONES.lisbon });

      expect(result.changes, String(hours)).toEqual([]);
      expect(result.plan, String(hours)).toBe(plan);
    }
  });

  it("does nothing without a timezone", () => {
    const entries = [
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ];
    const plan = planOf(entries);
    const result = repairScheduleConflicts({ plan, timezone: null });

    expect(result.changes).toEqual([]);
    expect(result.plan).toBe(plan);
  });

  /**
   * Closed all day. There is no slot to move into, and the honest outcome is to report
   * the conflict rather than to move the stop somewhere it is equally shut.
   */
  it("reports a stop it cannot place, and leaves it where it was", () => {
    const result = repair([
      {
        day: SATURDAY,
        item: fixtureItem("weekend", withHours(FIXTURE_PLACES.a, "Mo-Fr 09:00-17:00"), {
          startTime: "10:00",
          endTime: "11:00",
        }),
      },
    ]);

    expect(result.changes).toEqual([]);
    expect(result.unresolvedItemIds).toEqual(["weekend"]);
    expect(itemAt(result.plan, SATURDAY, "weekend")?.startTime).toBe("10:00");
  });

  it("reports a stop too long for any open interval", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("marathon", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-11:00"), {
          startTime: "14:00",
          endTime: "18:00",
        }),
      },
    ]);

    expect(result.unresolvedItemIds).toEqual(["marathon"]);
    expect(itemAt(result.plan, MONDAY, "marathon")?.startTime).toBe("14:00");
  });

  it("reports a stop the day has no room for", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("blocker", withHours(FIXTURE_PLACES.b, "24/7"), {
          startTime: "09:00",
          endTime: "18:00",
        }),
      },
      {
        day: MONDAY,
        item: fixtureItem("squeezed", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-17:00"), {
          startTime: "19:00",
          endTime: "20:00",
        }),
      },
    ]);

    expect(result.changes).toEqual([]);
    expect(result.unresolvedItemIds).toEqual(["squeezed"]);
  });

  it("never changes a place, only a time", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    expect(itemAt(result.plan, MONDAY, "early")?.place?.placeId).toBe(
      FIXTURE_PLACES.a.placeId,
    );
  });

  it("never moves a stop to another day", () => {
    const result = repair([
      {
        day: SATURDAY,
        item: fixtureItem("weekend", withHours(FIXTURE_PLACES.a, "Mo-Fr 09:00-17:00")),
      },
      {
        day: MONDAY,
        item: fixtureItem("weekday", withHours(FIXTURE_PLACES.b, "24/7")),
      },
    ]);

    expect(
      result.plan.days.find((day) => day.dayNumber === MONDAY)?.items.map((i) => i.id),
    ).toEqual(["weekday"]);
    expect(
      result.plan.days.find((day) => day.dayNumber === SATURDAY)?.items.map((i) => i.id),
    ).toEqual(["weekend"]);
  });

  it("never promotes a backup", () => {
    const plan = planOf([
      {
        day: SATURDAY,
        item: fixtureItem("weekend", withHours(FIXTURE_PLACES.a, "Mo-Fr 09:00-17:00")),
      },
    ]);
    const withBackup: TripPlan = {
      ...plan,
      days: plan.days.map((day) => ({
        ...day,
        backups: [
          {
            id: "bk-1",
            title: "Backup museum",
            kind: "attraction" as const,
            reason: "A second option in case the first is shut.",
            place: withHours(FIXTURE_PLACES.c, "24/7"),
            estimatedCost: 10,
            slotItemId: "weekend",
          },
        ],
      })),
    };

    const result = repairScheduleConflicts({
      plan: withBackup,
      timezone: TIMEZONES.lisbon,
    });

    expect(result.changes).toEqual([]);
    expect(itemAt(result.plan, SATURDAY, "weekend")?.place?.placeId).toBe(
      FIXTURE_PLACES.a.placeId,
    );
  });

  it("does not touch an item with no place", () => {
    const result = repair([
      {
        day: MONDAY,
        item: fixtureItem("free", null, {
          kind: "rest",
          startTime: "03:00",
          endTime: "04:00",
        }),
      },
    ]);

    expect(result.changes).toEqual([]);
    expect(itemAt(result.plan, MONDAY, "free")?.startTime).toBe("03:00");
  });
});

describe("repairScheduleConflicts — stability", () => {
  it("is deterministic", () => {
    const entries = [
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, SUPPORTED_HOURS.splitDay), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ];

    expect(JSON.stringify(repair(entries))).toBe(JSON.stringify(repair(entries)));
  });

  /**
   * One pass. A second run over an already-repaired plan finds nothing left to do, which
   * is what "at most one repair" means in practice: the operation is idempotent rather
   * than iterative.
   */
  it("is idempotent", () => {
    const first = repair([
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
    ]);

    const second = repairScheduleConflicts({
      plan: first.plan,
      timezone: TIMEZONES.lisbon,
    });

    expect(second.changes).toEqual([]);
    expect(second.plan).toBe(first.plan);
  });

  it("leaves every unrelated day untouched", () => {
    const entries = [
      {
        day: MONDAY,
        item: fixtureItem("early", withHours(FIXTURE_PLACES.a, "Mo-Fr 10:00-18:00"), {
          startTime: "07:00",
          endTime: "08:00",
        }),
      },
      {
        day: SATURDAY,
        item: fixtureItem("fine", withHours(FIXTURE_PLACES.b, "24/7")),
      },
    ];
    const plan = planOf(entries);
    const result = repairScheduleConflicts({ plan, timezone: TIMEZONES.lisbon });

    const before = plan.days.find((day) => day.dayNumber === SATURDAY);
    const after = result.plan.days.find((day) => day.dayNumber === SATURDAY);
    expect(after).toBe(before);
  });
});
