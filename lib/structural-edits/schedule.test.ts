import { describe, expect, it } from "vitest";

import { fixtureItem } from "@/lib/plan/test-fixtures";
import { FIXTURE_PLACES } from "@/lib/plan/test-fixtures";

import { resolvePosition } from "./position";
import {
  SCHEDULE_LIMITS,
  defaultDurationMinutes,
  durationOf,
  resolveInsertionTimes,
  windowFor,
} from "./schedule";

/**
 * A day with a real gap in it: 09:00–10:00, then nothing until 14:00, then 14:00–15:00.
 *
 * The stops are place-backed so the transition floor applies — a gap either side of a
 * placeless block is not a journey anyone makes, and the two cases behave differently.
 */
const DAY = [
  fixtureItem("a", FIXTURE_PLACES.a, { order: 0, startTime: "09:00", endTime: "10:00" }),
  fixtureItem("b", FIXTURE_PLACES.b, { order: 1, startTime: "14:00", endTime: "15:00" }),
];

function positionAfter(itemId: string) {
  const result = resolvePosition(DAY, { kind: "after", itemId });
  if (!result.ok) throw new Error("fixture position did not resolve");
  return result.value;
}

function positionEnd(items = DAY) {
  const result = resolvePosition(items, { kind: "end" });
  if (!result.ok) throw new Error("fixture position did not resolve");
  return result.value;
}

describe("windowFor", () => {
  it("bounds the gap by the transition floor on both sides", () => {
    const { earliest, latest } = windowFor(positionAfter("a"));

    // 10:00 + 10 minutes, and 14:00 − 10 minutes.
    expect(earliest).toBe(10 * 60 + SCHEDULE_LIMITS.minTransitionMinutes);
    expect(latest).toBe(14 * 60 - SCHEDULE_LIMITS.minTransitionMinutes);
  });

  it("uses the day's own bounds at the ends", () => {
    const first = resolvePosition(DAY, { kind: "before", itemId: "a" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(windowFor(first.value).earliest).toBe(SCHEDULE_LIMITS.earliestMinutes);
    expect(windowFor(positionEnd()).latest).toBe(SCHEDULE_LIMITS.latestMinutes);
  });

  /**
   * A gap beside an unfilled slot is not a journey, so no transition allowance applies —
   * matching `validateSchedule`, which would otherwise reject what this produced.
   */
  it("applies no transition floor next to a placeless block", () => {
    const withGap = [
      fixtureItem("free", null, { order: 0, startTime: "09:00", endTime: "10:00" }),
      DAY[1],
    ];
    const position = resolvePosition(withGap, { kind: "after", itemId: "free" });
    expect(position.ok).toBe(true);
    if (!position.ok) return;

    expect(windowFor(position.value).earliest).toBe(10 * 60);
  });
});

describe("resolveInsertionTimes — derived slots", () => {
  it("places the stop as early as the window allows, on a five-minute grid", () => {
    const result = resolveInsertionTimes({
      position: positionAfter("a"),
      durationMinutes: 60,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ startTime: "10:10", endTime: "11:10" });
  });

  it("rounds a window that starts off-grid up to the next grid point", () => {
    const odd = [
      fixtureItem("a", FIXTURE_PLACES.a, {
        order: 0,
        startTime: "09:00",
        endTime: "09:52",
      }),
      DAY[1],
    ];
    const position = resolvePosition(odd, { kind: "after", itemId: "a" });
    expect(position.ok).toBe(true);
    if (!position.ok) return;

    const result = resolveInsertionTimes({
      position: position.value,
      durationMinutes: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 09:52 + 10 = 10:02, rounded up to 10:05.
    expect(result.value.startTime).toBe("10:05");
  });

  it("places at the start of the day when it goes first", () => {
    const position = resolvePosition(DAY, { kind: "before", itemId: "a" });
    expect(position.ok).toBe(true);
    if (!position.ok) return;

    const result = resolveInsertionTimes({
      position: position.value,
      durationMinutes: 30,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.startTime).toBe("05:00");
  });

  it("places after the last stop when it goes at the end", () => {
    const result = resolveInsertionTimes({
      position: positionEnd(),
      durationMinutes: 60,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ startTime: "15:10", endTime: "16:10" });
  });

  /**
   * The refusal is the important half: the alternatives were inserting two stops at once, or
   * asking a model to invent a slot.
   */
  it("refuses when the gap is too small", () => {
    const result = resolveInsertionTimes({
      position: positionAfter("a"),
      durationMinutes: 300,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "no_slot_available" },
    });
    if (result.ok) return;
    expect(result.error.message).toContain("set the times yourself");
  });

  it("refuses when there is no gap at all", () => {
    const packed = [
      fixtureItem("a", FIXTURE_PLACES.a, {
        order: 0,
        startTime: "09:00",
        endTime: "10:00",
      }),
      fixtureItem("b", FIXTURE_PLACES.b, {
        order: 1,
        startTime: "10:10",
        endTime: "11:00",
      }),
    ];
    const position = resolvePosition(packed, { kind: "after", itemId: "a" });
    expect(position.ok).toBe(true);
    if (!position.ok) return;

    expect(
      resolveInsertionTimes({ position: position.value, durationMinutes: 30 }),
    ).toMatchObject({ ok: false, error: { code: "no_slot_available" } });
  });

  it("honours the minimum visit length even for a shorter request", () => {
    const result = resolveInsertionTimes({
      position: positionAfter("a"),
      durationMinutes: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ startTime: "10:10", endTime: "10:25" });
  });

  it("is deterministic", () => {
    const input = { position: positionAfter("a"), durationMinutes: 45 };
    expect(resolveInsertionTimes(input)).toEqual(resolveInsertionTimes(input));
  });
});

describe("resolveInsertionTimes — explicit times", () => {
  it("uses times inside the window", () => {
    const result = resolveInsertionTimes({
      position: positionAfter("a"),
      durationMinutes: 60,
      requested: { startTime: "11:00", endTime: "12:30" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ startTime: "11:00", endTime: "12:30" });
  });

  it("requires both or neither", () => {
    expect(
      resolveInsertionTimes({
        position: positionAfter("a"),
        durationMinutes: 60,
        requested: { startTime: "11:00" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_times" } });
  });

  it("rejects an end that is not after its start", () => {
    expect(
      resolveInsertionTimes({
        position: positionAfter("a"),
        durationMinutes: 60,
        requested: { startTime: "11:00", endTime: "11:00" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_times" } });
  });

  it("rejects a visit shorter than the floor", () => {
    expect(
      resolveInsertionTimes({
        position: positionAfter("a"),
        durationMinutes: 60,
        requested: { startTime: "11:00", endTime: "11:05" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_times" } });
  });

  it("rejects times outside the day's planning window", () => {
    const position = resolvePosition(DAY, { kind: "before", itemId: "a" });
    expect(position.ok).toBe(true);
    if (!position.ok) return;

    expect(
      resolveInsertionTimes({
        position: position.value,
        durationMinutes: 60,
        requested: { startTime: "03:00", endTime: "04:00" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_times" } });
  });

  /**
   * Checked against the chosen *position*, not merely against the day. Times that are free
   * elsewhere would otherwise produce a stop whose sequence and clock disagree — and
   * `validateSchedule` sorts by time, so the day would silently reorder itself.
   */
  it("rejects times that collide with the neighbours at that position", () => {
    const result = resolveInsertionTimes({
      position: positionAfter("a"),
      durationMinutes: 60,
      requested: { startTime: "16:00", endTime: "17:00" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_times" } });
    if (result.ok) return;
    expect(result.error.message).toContain("free window");
  });

  it("rejects times that overlap the previous stop", () => {
    expect(
      resolveInsertionTimes({
        position: positionAfter("a"),
        durationMinutes: 60,
        requested: { startTime: "09:30", endTime: "10:30" },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_times" } });
  });
});

describe("durations", () => {
  it("reads a moved item's own length", () => {
    expect(durationOf(DAY[0])).toBe(60);
  });

  it("never returns less than the minimum visit", () => {
    expect(
      durationOf(
        fixtureItem("tiny", null, { startTime: "09:00", endTime: "09:05" }),
      ),
    ).toBe(SCHEDULE_LIMITS.minItemMinutes);
  });

  /**
   * A promotion has no duration of its own, so one comes from a documented table rather than
   * from an average of the day — an average would move as the day was edited, making the
   * dialog's preview change for reasons unrelated to the promotion.
   */
  it("gives a promotion a duration by kind", () => {
    expect(defaultDurationMinutes("meal")).toBe(75);
    expect(defaultDurationMinutes("attraction")).toBe(90);
    expect(defaultDurationMinutes("viewpoint")).toBe(45);
    for (const kind of [
      "meal",
      "attraction",
      "experience",
      "viewpoint",
      "rest",
      "transport",
      "logistics",
    ] as const) {
      expect(defaultDurationMinutes(kind)).toBeGreaterThanOrEqual(
        SCHEDULE_LIMITS.minItemMinutes,
      );
    }
  });
});
