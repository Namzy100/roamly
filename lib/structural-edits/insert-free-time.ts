import type { z } from "zod";

import { minutesOfDay } from "@/lib/ai";
import type { InsertFreeTimeCommandSchema } from "@/lib/refinement/commands";
import type { ItineraryItem } from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { indexForStartTime, locateDay, mintItemId } from "./locate";
import { insertAt, type ResolvedPosition } from "./position";
import { resolveInsertionTimes } from "./schedule";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

type InsertFreeTimeCommand = z.infer<typeof InsertFreeTimeCommandSchema>;

/**
 * Deliberate downtime, put into a day.
 *
 * ## Position follows time, not the other way round
 *
 * `promote-backup` and `move-item` take a position and derive the times. This is the inverse: the
 * traveller says *when*, and where it sits in the sequence follows, because a day's order is a
 * consequence of its clock. Accepting a position here would let someone place free time "after
 * lunch" at 09:00 and produce a day whose array order and times disagree — which `validateSchedule`
 * would then quietly resolve by sorting.
 *
 * ## Why no new item kind, and no new nullable case
 *
 * The result is an ordinary `ItineraryItem` with `kind: "rest"` and `place: null`. Every module
 * that matters already handles that shape: `isMappableItem` keeps it off the map,
 * `deriveExpectedLegs` skips placeless blocks so **inserting free time between two stops does not
 * invalidate the routed leg between them**, and `validateSchedule` does not count it as a stop, so
 * the pace caps are unaffected and the transition floor is not applied either side of it. A
 * `free-time` kind would mean teaching six modules about a case identical to one they know.
 *
 * ## Free of charge, honestly
 *
 * `estimatedCost` is zero and `costEstimate` is absent rather than a zero carrying provenance.
 * There is nothing to estimate — the traveller has asked for an hour of not spending money — and
 * attaching a cost basis to that would be provenance for a figure nobody derived.
 */

export function applyInsertFreeTime(
  input: StructuralEditInput & { command: InsertFreeTimeCommand },
): StructuralEditResult {
  const { plan, command } = input;

  const located = locateDay(plan, command.dayNumber);
  if (!located.ok) return failed(located.error);

  const { dayIndex, day } = located.value;

  const startMinutes = minutesOfDay(command.startTime);
  const index = indexForStartTime(day, startMinutes, minutesOfDay);

  /**
   * Built directly rather than through `resolvePosition`, because there is no anchor item to name
   * — the index came from the clock. The neighbours are whatever the day already has either side.
   */
  const position: ResolvedPosition = {
    index,
    before: index > 0 ? day.items[index - 1] : null,
    after: index < day.items.length ? day.items[index] : null,
  };

  /**
   * The same validator every other insertion uses, with the traveller's times as `requested`.
   *
   * So an overlap, a too-short block, times outside the planning day, and times that do not fit the
   * gap at this point all refuse here — with the free window named — rather than being accepted and
   * then rearranged.
   */
  const times = resolveInsertionTimes({
    position,
    durationMinutes: minutesOfDay(command.endTime) - startMinutes,
    requested: { startTime: command.startTime, endTime: command.endTime },
  });

  if (!times.ok) {
    return failed({
      code: times.error.code,
      message: times.error.message,
      dayNumber: command.dayNumber,
    });
  }

  const item: ItineraryItem = {
    id: mintItemId(plan, `d${command.dayNumber}-free`),
    // `insertAt` renumbers the whole day, so this is a placeholder rather than a claim.
    order: index,
    kind: "rest",
    mealType: null,
    title: command.title ?? "Free time",
    /**
     * Stated as a fact about who decided, not as a recommendation.
     *
     * Every other item's `rationale` explains why a planner chose it. This one has no planner
     * behind it, and writing "a relaxed afternoon to recharge before dinner" would be inventing a
     * justification for somebody else's decision.
     */
    rationale: "Time you set aside yourself.",
    status: "confirmed",
    locked: false,
    place: null,
    startTime: times.value.startTime,
    endTime: times.value.endTime,
    estimatedCost: 0,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
  };

  const days = plan.days.map((entry, dayPosition) =>
    dayPosition === dayIndex
      ? { ...entry, items: insertAt(entry.items, index, item) }
      : entry,
  );

  return commitStructuralEdit({
    action: "insert-free-time",
    before: plan,
    generation: input.generation,
    days,
    revisionBefore: input.revisionBefore,
    affectedDays: [command.dayNumber],
    validateDays: [{ dayNumber: day.dayNumber, baseline: day }],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
