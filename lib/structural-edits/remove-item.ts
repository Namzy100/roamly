import type { z } from "zod";

import type { RemoveItemCommandSchema } from "@/lib/refinement/commands";
import type { ItineraryDay, ItineraryItem } from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { locateItem } from "./locate";
import { isEditLocked, lockRefusalFor } from "./locks";
import { removeById } from "./position";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

type RemoveItemCommand = z.infer<typeof RemoveItemCommandSchema>;

/**
 * Dropping a stop out of the itinerary.
 *
 * ## Why removal cannot break the pool invariant
 *
 * It adds nothing. The place simply stops being referenced, which returns it to the pool's *unused*
 * set — where every candidate derivation will find it again. This is the one edit that can only
 * reduce the set of attached places, so `assertItineraryUsesPool` has strictly less to check
 * afterwards.
 *
 * The opposite case is the one to watch: a **retained** place this stop was the last reference to.
 * `validateRetainedPlaces` treats an unreferenced retained entry as a hard failure — correctly,
 * because that is how the collection would quietly become a second pool. So removing the last user
 * of a retained place is refused at the save boundary, with the reason stated. Silently dropping the
 * retained entry instead would be this module editing the generation context, which is not its job.
 *
 * ## What is refused, and why the button knows in advance
 *
 * A locked stop; a structurally locked one; the day's last item, because `ItineraryDaySchema`
 * requires at least one and the alternative is a plan that fails its own schema; and the day's only
 * stop of a meal type.
 *
 * `itemIsRemovable` answers all four, so the control can be hidden rather than offered and then
 * refused — the same discipline `hasOpenSlot` uses for the hours repair.
 *
 * ## The gap simply closes
 *
 * Nothing is re-timed. The traveller removed one stop; sliding their whole afternoon earlier to
 * fill the space would be a second edit they did not ask for. `rekeyPlanSegments` clears the leg
 * that pointed at the removed place, and `commitStructuralEdit` measures and reports it.
 */

export function applyRemoveItem(
  input: StructuralEditInput & { command: RemoveItemCommand },
): StructuralEditResult {
  const { plan, command } = input;

  const located = locateItem(plan, command.dayNumber, command.itemId);
  if (!located.ok) return failed(located.error);

  const { dayIndex, day, item } = located.value;

  const refusal = lockRefusalFor(item);
  if (refusal) {
    return failed({ ...refusal, dayNumber: command.dayNumber, itemId: item.id });
  }

  if (day.items.length === 1) {
    return failed({
      code: "day_would_be_empty",
      message: `Day ${command.dayNumber} would have nothing left in it. Add something there first, or remove a different stop.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  /**
   * Checked here as well as in the commit, so the message names the meal.
   *
   * `commitStructuralEdit` would catch it — `validateSchedule` compares against the day's previous
   * meal coverage — but its wording is written for a refinement ("a refinement may replace a meal
   * but not remove one"), which is the wrong thing to say to somebody who deliberately pressed
   * Remove.
   */
  if (removalWouldLoseMeal(day, item)) {
    return failed({
      code: "schedule_invalid",
      message: `“${item.title}” is day ${command.dayNumber}'s only ${item.mealType} stop. Swap it for something else instead, or move it to another day.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  const days = plan.days.map((entry, position) =>
    position === dayIndex
      ? { ...entry, items: removeById(entry.items, item.id) }
      : entry,
  );

  return commitStructuralEdit({
    action: "remove-item",
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
 * Whether removing this item would leave the day without a meal type it currently covers.
 *
 * Only meals matter: `currentMealTypes` is derived from `mealType`, and an item with a null
 * `mealType` can always go.
 */
function removalWouldLoseMeal(day: ItineraryDay, item: ItineraryItem): boolean {
  if (item.mealType === null) return false;

  return !day.items.some(
    (candidate) => candidate.id !== item.id && candidate.mealType === item.mealType,
  );
}

/**
 * Whether the interface should offer a Remove control for this stop.
 *
 * All four refusals, in the order the applier checks them, so the button appears exactly when
 * pressing it would work.
 */
export function itemIsRemovable(
  day: ItineraryDay,
  item: ItineraryItem,
): boolean {
  if (isEditLocked(item)) return false;
  if (day.items.length === 1) return false;
  return !removalWouldLoseMeal(day, item);
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
