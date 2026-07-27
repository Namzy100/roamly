import { describe, expect, it } from "vitest";

import type { StructuralEditCommand } from "@/lib/refinement/commands";
import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";

import { prepareStructuralCommand } from "./prepare";
import { announceEditedItem, describeEditedItem } from "./preview-item";

/**
 * Previews are asserted through the **real** dispatcher, never a hand-built result.
 *
 * The whole claim this module makes is that what a drag promises is what a drop stores. A fixture
 * `PreparedStructuralEdit` assembled by hand would exercise the object walk and nothing else — it
 * could not catch the one failure that matters, which is a preview and an applier disagreeing about
 * a slot.
 */

const TIMEZONE = "Europe/Lisbon";

function prepare(command: StructuralEditCommand) {
  return prepareStructuralCommand({
    plan: fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 1,
    timezone: TIMEZONE,
    command,
  });
}

const PLAN = fixtureSavedPlan();
const DAY_ONE = PLAN.days[0];
const FIRST = DAY_ONE.items[0];
const LAST = DAY_ONE.items[DAY_ONE.items.length - 1];

/** The move used throughout: the day's last stop, lifted to the top of the same day. */
const MOVE_LAST_TO_TOP: StructuralEditCommand = {
  type: "move-item",
  sourceDayNumber: DAY_ONE.dayNumber,
  targetDayNumber: DAY_ONE.dayNumber,
  itemId: LAST.id,
  targetPosition: { kind: "before", itemId: FIRST.id },
};

describe("describeEditedItem", () => {
  it("reports where a moved stop lands, and when", () => {
    const preview = describeEditedItem(prepare(MOVE_LAST_TO_TOP), LAST.id);

    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;

    expect(preview.dayNumber).toBe(DAY_ONE.dayNumber);
    expect(preview.position).toBe(1);
    expect(preview.total).toBe(DAY_ONE.items.length);
    expect(preview.startTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(preview.endTime).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });

  /**
   * The property everything else rests on.
   *
   * Not "the times look plausible" but "the times are the ones that would be stored" — read back
   * out of the very plan a commit would write.
   */
  it("reports the times the edit would actually store", () => {
    const prepared = prepare(MOVE_LAST_TO_TOP);

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;

    const stored = prepared.plan.days
      .flatMap((day) => day.items)
      .find((item) => item.id === LAST.id);

    expect(describeEditedItem(prepared, LAST.id)).toMatchObject({
      status: "ready",
      startTime: stored?.startTime,
      endTime: stored?.endTime,
    });
  });

  it("passes a refusal through in the applier's own words", () => {
    /** Twelve hours anchored to its start runs off the end of the planning day. */
    const prepared = prepare({
      type: "set-item-duration",
      dayNumber: DAY_ONE.dayNumber,
      itemId: LAST.id,
      durationMinutes: 12 * 60,
      anchor: "start",
    });

    expect(prepared.status).toBe("refused");
    if (prepared.status !== "refused") return;

    expect(describeEditedItem(prepared, LAST.id)).toEqual({
      status: "refused",
      message: prepared.message,
    });
  });

  it("reports a resize's resulting window rather than the length asked for", () => {
    /**
     * Shortened rather than lengthened, and by a length the stop does not already have.
     *
     * Shrinking inside a slot the stop already occupies cannot collide with a neighbour, so this
     * asserts the *shape* of a successful preview without depending on how much slack the fixture's
     * afternoon happens to have. Asking for its current length would be `no_change`, which is a
     * refusal — correctly, but not the one under test here.
     */
    const prepared = prepare({
      type: "set-item-duration",
      dayNumber: DAY_ONE.dayNumber,
      itemId: FIRST.id,
      durationMinutes: 45,
      anchor: "start",
    });

    const preview = describeEditedItem(prepared, FIRST.id);

    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") return;

    // The anchored end is untouched and the other one moved: a window, not an echoed number.
    expect(preview.startTime).toBe(FIRST.startTime);
    expect(preview.endTime).not.toBe(FIRST.endTime);
  });

  /**
   * `unknown` is not a refusal, and must not be rendered as one.
   *
   * An edit that succeeds while the named stop is missing from its result is a bug, and showing
   * "there is no free gap" for it would file that bug under something a traveller could fix.
   */
  it("says `unknown` for a stop the successful result does not contain", () => {
    expect(describeEditedItem(prepare(MOVE_LAST_TO_TOP), "no-such-stop")).toEqual(
      { status: "unknown" },
    );
  });
});

describe("announceEditedItem", () => {
  it("names the day, the position and the clock", () => {
    expect(
      announceEditedItem(
        {
          status: "ready",
          dayNumber: 2,
          startTime: "14:05",
          endTime: "15:35",
          position: 3,
          total: 5,
        },
        "Museu do Azulejo",
      ),
    ).toBe("Museu do Azulejo: day 2, position 3 of 5, 14:05 to 15:35.");
  });

  it("keeps the refusal's own sentence, which is the half that says what to do instead", () => {
    expect(
      announceEditedItem(
        { status: "refused", message: "There is no free 90-minute gap there." },
        "Museu do Azulejo",
      ),
    ).toBe("Cannot drop here. There is no free 90-minute gap there.");
  });

  it("does not dress `unknown` up as a refusal", () => {
    const announcement = announceEditedItem({ status: "unknown" }, "A stop");
    expect(announcement).toBe("A stop cannot be placed there.");
    expect(announcement).not.toContain("Cannot drop here");
  });
});
