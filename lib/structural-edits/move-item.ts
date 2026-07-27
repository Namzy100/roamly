import type { MoveItemCommandSchema } from "@/lib/refinement/commands";
import type { z } from "zod";
import type { ItineraryItem } from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { isEditLocked, lockRefusalFor } from "./locks";
import { insertAt, removeById, resolvePosition } from "./position";
import { durationOf, resolveInsertionTimes } from "./schedule";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

type MoveItemCommand = z.infer<typeof MoveItemCommandSchema>;

/**
 * Moving one stop to another day, or to another point in the same day.
 *
 * ## The id is stable, and that is the point
 *
 * A move is the same stop in a different place. Minting a new id would invalidate the routes
 * either side of where it *lands* as well as the ones it leaves — punishing the traveller
 * for the move with two extra pending legs — and it would break every reference the
 * interface holds. The day number changes; the identity does not.
 *
 * ## What may not move
 *
 * `transport` and `logistics` blocks are locked. Those are the airport run and the check-in
 * — they are anchored to the trip's edges by the dates, not by preference, and a plan whose
 * arrival transfer sat on day three would be describing a journey that does not happen. The
 * lock is a product rule and is stated as one rather than hidden behind a validation error.
 *
 * A move is also refused when it would empty the source day: `ItineraryDaySchema` requires
 * at least one item, so the alternative is a plan that fails its own schema.
 *
 * ## Costs travel with the stop
 *
 * `estimatedCost` and `costEstimate` are untouched. A museum does not cost more on Thursday,
 * and re-deriving the figure because the day changed would move money for a reason the
 * traveller did not ask about. Both days' totals are recomputed from the items, which is a
 * different thing.
 */

/**
 * The lock predicates now live in `./locks.ts`.
 *
 * Phase 6C kept the `transport`/`logistics` set here privately, because this was the only applier
 * that needed it. Phase 8 added a traveller-settable lock and six more appliers that must honour
 * both, so the set and its refusal messages moved to one place — two copies is how one applier
 * would eventually let a locked stop be dragged.
 */

export function applyMoveItem(
  input: StructuralEditInput & { command: MoveItemCommand },
): StructuralEditResult {
  const { plan, command } = input;

  const sourceIndex = plan.days.findIndex(
    (day) => day.dayNumber === command.sourceDayNumber,
  );
  if (sourceIndex === -1) {
    return failed({
      code: "day_not_found",
      message: `Day ${command.sourceDayNumber} is not part of this trip.`,
      dayNumber: command.sourceDayNumber,
    });
  }

  const targetIndex = plan.days.findIndex(
    (day) => day.dayNumber === command.targetDayNumber,
  );
  if (targetIndex === -1) {
    return failed({
      code: "day_not_found",
      message: `Day ${command.targetDayNumber} is not part of this trip.`,
      dayNumber: command.targetDayNumber,
    });
  }

  const sourceDay = plan.days[sourceIndex];
  const item = sourceDay.items.find((entry) => entry.id === command.itemId);
  if (!item) {
    return failed({
      code: "item_not_found",
      message: `Stop "${command.itemId}" is not on day ${command.sourceDayNumber}.`,
      dayNumber: command.sourceDayNumber,
      itemId: command.itemId,
    });
  }

  /**
   * Both locks, in one check.
   *
   * Phase 6C refused only the date-fixed kinds. A traveller's own lock has to refuse here too, or
   * the padlock would be decorative for the one action most likely to be a misdrag.
   */
  const refusal = lockRefusalFor(item);
  if (refusal) {
    return failed({
      ...refusal,
      dayNumber: command.sourceDayNumber,
      itemId: item.id,
    });
  }

  const sameDay = command.sourceDayNumber === command.targetDayNumber;

  if (!sameDay && sourceDay.items.length === 1) {
    return failed({
      code: "day_would_be_empty",
      message: `Day ${command.sourceDayNumber} would have nothing left in it. Add something there first, or move a different stop.`,
      dayNumber: command.sourceDayNumber,
    });
  }

  /* -- where it lands ------------------------------------------------------- */

  /**
   * The item is removed *before* the position is resolved.
   *
   * Otherwise "after itself" would resolve to its own index and the move would be a no-op
   * dressed as a change, and "before itself" would be off by one.
   */
  const targetItemsWithoutIt = sameDay
    ? removeById(plan.days[targetIndex].items, item.id)
    : plan.days[targetIndex].items;

  if (
    command.targetPosition.kind !== "end" &&
    command.targetPosition.itemId === item.id
  ) {
    return failed({
      code: "same_position",
      message: "A stop cannot be placed relative to itself.",
      itemId: item.id,
    });
  }

  const position = resolvePosition(targetItemsWithoutIt, command.targetPosition);
  if (!position.ok) {
    return failed({
      code: "target_item_not_found",
      message: position.error.message,
      dayNumber: command.targetDayNumber,
      itemId: position.error.itemId,
    });
  }

  const times = resolveInsertionTimes({
    position: position.value,
    durationMinutes: durationOf(item),
    ...(command.startTime !== undefined || command.endTime !== undefined
      ? {
          requested: {
            ...(command.startTime !== undefined
              ? { startTime: command.startTime }
              : {}),
            ...(command.endTime !== undefined ? { endTime: command.endTime } : {}),
          },
        }
      : {}),
  });

  if (!times.ok) {
    return failed({
      code: times.error.code,
      message: times.error.message,
      dayNumber: command.targetDayNumber,
      itemId: item.id,
    });
  }

  if (
    sameDay &&
    times.value.startTime === item.startTime &&
    times.value.endTime === item.endTime &&
    position.value.index === sourceDay.items.indexOf(item)
  ) {
    return failed({
      code: "same_position",
      message: "That stop is already there.",
      dayNumber: command.targetDayNumber,
      itemId: item.id,
    });
  }

  const moved: ItineraryItem = {
    ...item,
    startTime: times.value.startTime,
    endTime: times.value.endTime,
    /**
     * The leg leaving this stop is cleared.
     *
     * It measured a journey to whatever used to follow, and after a move that is a different
     * place — or nothing at all. `rekeyPlanSegments` handles the legs *into* it.
     */
    travelToNext: null,
  };

  /* -- rebuild the day or days --------------------------------------------- */

  const days = plan.days.map((day, index) => {
    if (sameDay && index === targetIndex) {
      return { ...day, items: insertAt(targetItemsWithoutIt, position.value.index, moved) };
    }
    if (index === sourceIndex) {
      /**
       * The gap simply closes.
       *
       * Nothing else is re-timed: the traveller moved one stop, and shifting their whole
       * afternoon to fill the space would be a second edit they did not ask for.
       */
      return { ...day, items: removeById(day.items, item.id) };
    }
    if (index === targetIndex) {
      return { ...day, items: insertAt(day.items, position.value.index, moved) };
    }
    return day;
  });

  return commitStructuralEdit({
    action: "move-item",
    before: plan,
    generation: input.generation,
    days,
    revisionBefore: input.revisionBefore,
    affectedDays: sameDay
      ? [command.targetDayNumber]
      : [command.sourceDayNumber, command.targetDayNumber],
    /**
     * Both days are validated, and each against **its own** previous state.
     *
     * The source has to keep its meal coverage — moving the only dinner off a day is a real
     * loss — and the target has to stay inside its pace cap.
     */
    validateDays: sameDay
      ? [{ dayNumber: sourceDay.dayNumber, baseline: sourceDay }]
      : [
          { dayNumber: sourceDay.dayNumber, baseline: sourceDay },
          { dayNumber: plan.days[targetIndex].dayNumber, baseline: plan.days[targetIndex] },
        ],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });
}

/**
 * Whether a stop may be moved at all, for enabling the control and the drag handle.
 *
 * Now covers the traveller's lock as well as the date-fixed kinds, so locking a stop visibly takes
 * its handle away rather than letting a drag begin and fail.
 */
export function itemIsMovable(item: ItineraryItem): boolean {
  return !isEditLocked(item);
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
