import type { z } from "zod";

import { minutesOfDay } from "@/lib/ai";
import type {
  SetItemDurationCommandSchema,
  SetItemTimeCommandSchema,
} from "@/lib/refinement/commands";
import type { ItineraryItem, TripPlan } from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { locateItem, positionOfExistingItem } from "./locate";
import { isEditLocked, lockRefusalFor } from "./locks";
import {
  SCHEDULE_LIMITS,
  durationOf,
  formatDayMinutes,
  resolveInsertionTimes,
} from "./schedule";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

type SetItemTimeCommand = z.infer<typeof SetItemTimeCommandSchema>;
type SetItemDurationCommand = z.infer<typeof SetItemDurationCommandSchema>;

/**
 * Re-timing and resizing one stop.
 *
 * ## Honoured exactly, or refused — never reordered
 *
 * The Phase 6B applier this replaces accepted any times that produced a structurally valid day and
 * then re-sorted the day by start time. That is right for an automatic repair searching for an
 * open slot, and wrong for a typed time: a traveller who moves an 11:00 museum to 15:00 would get
 * their whole afternoon resequenced around it, having asked for one stop to move.
 *
 * So the times are validated against the **free window at the stop's current position** — the gap
 * its own neighbours leave — and refused, with that window named, when they do not fit. Sequence
 * and clock stay in agreement without anything moving that the traveller did not move. If they
 * genuinely want the museum after dinner, that is a `move-item`, and the interface offers it.
 *
 * ## The routed leg survives
 *
 * `travelToNext` is **kept**, unlike a move. A stop that shifts within its own slot still travels
 * to the same next stop, and a routed leg is a distance and a duration — facts about a journey,
 * not about a time of day. Valhalla has no live traffic, so there is nothing about 15:00 that
 * makes a measurement taken for 11:00 untrue. Clearing it would throw away a real measurement and
 * charge the traveller a re-route for changing a clock.
 *
 * That is also why a re-time honestly reports zero invalidated legs.
 *
 * ## One applier for two commands
 *
 * `set-item-time` and `set-item-duration` differ only in how the requested window is *derived* —
 * given outright, or computed from a length and an anchored end. Everything after that is
 * identical, and splitting them would mean two copies of the window check.
 */

export function applySetItemSchedule(
  input: StructuralEditInput & {
    command: SetItemTimeCommand | SetItemDurationCommand;
  },
): StructuralEditResult {
  const { plan, command } = input;

  const located = locateItem(plan, command.dayNumber, command.itemId);
  if (!located.ok) return failed(located.error);

  const { dayIndex, day, itemIndex, item } = located.value;

  const refusal = lockRefusalFor(item);
  if (refusal) {
    return failed({ ...refusal, dayNumber: command.dayNumber, itemId: item.id });
  }

  const requested =
    command.type === "set-item-time"
      ? {
          ok: true as const,
          value: { startTime: command.startTime, endTime: command.endTime },
        }
      : windowFromDuration(item, command);

  if (!requested.ok) {
    return failed({
      ...requested.error,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  if (
    requested.value.startTime === item.startTime &&
    requested.value.endTime === item.endTime
  ) {
    return failed({
      code: "no_change",
      message: `“${item.title}” is already scheduled for ${item.startTime}–${item.endTime}.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  /**
   * The same validator a promotion and a move use, given the stop's own position.
   *
   * `durationMinutes` is passed for completeness and goes unused: `resolveInsertionTimes` derives
   * a slot only when nothing was requested, and something always is here.
   */
  const times = resolveInsertionTimes({
    position: positionOfExistingItem(day, itemIndex),
    durationMinutes: durationOf(item),
    requested: requested.value,
  });

  if (!times.ok) {
    return failed({
      code: times.error.code,
      message: times.error.message,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  const retimed: ItineraryItem = {
    ...item,
    startTime: times.value.startTime,
    endTime: times.value.endTime,
  };

  const days = plan.days.map((entry, index) =>
    index === dayIndex
      ? {
          ...entry,
          // Every other item is the same object it was, so preservation is `===`-checkable.
          items: entry.items.map((candidate, position) =>
            position === itemIndex ? retimed : candidate,
          ),
        }
      : entry,
  );

  return commitStructuralEdit({
    action: command.type,
    before: plan,
    generation: input.generation,
    days,
    revisionBefore: input.revisionBefore,
    affectedDays: [command.dayNumber],
    validateDays: [{ dayNumber: day.dayNumber, baseline: day }],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });
}

/**
 * A duration and an anchor, turned into a window.
 *
 * Only the day's own bounds are checked here, because they are what arithmetic can violate before
 * a time even exists — a twelve-hour stop anchored at 20:00 has no representable end. Whether the
 * window *fits between the neighbours* is `resolveInsertionTimes`' question, and asking it in two
 * places is how the two answers would eventually differ.
 */
function windowFromDuration(
  item: ItineraryItem,
  command: SetItemDurationCommand,
):
  | { ok: true; value: { startTime: string; endTime: string } }
  | { ok: false; error: { code: "invalid_times"; message: string } } {
  if (command.anchor === "start") {
    const end = minutesOfDay(item.startTime) + command.durationMinutes;
    if (end > SCHEDULE_LIMITS.latestMinutes) {
      return {
        ok: false,
        error: {
          code: "invalid_times",
          message: `${command.durationMinutes} minutes from ${item.startTime} would run past ${formatDayMinutes(SCHEDULE_LIMITS.latestMinutes)}, the end of the planning day. Start earlier, or make it shorter.`,
        },
      };
    }
    return {
      ok: true,
      value: { startTime: item.startTime, endTime: formatDayMinutes(end) },
    };
  }

  const start = minutesOfDay(item.endTime) - command.durationMinutes;
  if (start < SCHEDULE_LIMITS.earliestMinutes) {
    return {
      ok: false,
      error: {
        code: "invalid_times",
        message: `${command.durationMinutes} minutes ending at ${item.endTime} would start before ${formatDayMinutes(SCHEDULE_LIMITS.earliestMinutes)}, the start of the planning day. Finish later, or make it shorter.`,
      },
    };
  }

  return {
    ok: true,
    value: { startTime: formatDayMinutes(start), endTime: item.endTime },
  };
}

/**
 * Whether the interface should offer a time or duration control for this stop.
 *
 * The same predicate the applier enforces, so the control appears exactly when using it would
 * work. Two answers to "can this be re-timed" show up as a field that fails on save.
 */
export function itemIsRetimable(item: ItineraryItem): boolean {
  return !isEditLocked(item);
}

/**
 * The window this stop could occupy, for a preview.
 *
 * Exported so the editor can say "13:00–17:30 is free here" *before* the traveller types, rather
 * than only refusing afterwards. Read from the same `positionOfExistingItem` the applier validates
 * against, so the stated window and the enforced one are the same window.
 *
 * The transition floor is applied only beside a real visit, matching `windowFor` and
 * `validateSchedule` — a gap either side of an unfilled placeholder is not a journey anyone makes.
 */
export function freeWindowForItem(
  plan: TripPlan,
  dayNumber: number,
  itemId: string,
): { earliest: string; latest: string } | null {
  const located = locateItem(plan, dayNumber, itemId);
  if (!located.ok) return null;

  const position = positionOfExistingItem(
    located.value.day,
    located.value.itemIndex,
  );

  const earliest = position.before
    ? Math.max(
        minutesOfDay(position.before.endTime) +
          (isStop(position.before) ? SCHEDULE_LIMITS.minTransitionMinutes : 0),
        SCHEDULE_LIMITS.earliestMinutes,
      )
    : SCHEDULE_LIMITS.earliestMinutes;

  const latest = position.after
    ? Math.min(
        minutesOfDay(position.after.startTime) -
          (isStop(position.after) ? SCHEDULE_LIMITS.minTransitionMinutes : 0),
        SCHEDULE_LIMITS.latestMinutes,
      )
    : SCHEDULE_LIMITS.latestMinutes;

  return {
    earliest: formatDayMinutes(earliest),
    latest: formatDayMinutes(latest),
  };
}

function isStop(item: ItineraryItem): boolean {
  return item.status === "confirmed" && item.place !== null;
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
