import type { ItineraryItem } from "@/lib/schemas";

import type { PreparedStructuralEdit } from "./prepare";

/**
 * Where a stop would end up, read out of the edit that would put it there.
 *
 * ## Why this reads the result rather than predicting it
 *
 * A drag has to say what it will do *before* it does it — "lands at 14:05–15:35", or "there is no
 * free 90-minute gap at that point in the day" — and there are two ways to produce that sentence.
 * One is to re-derive the slot in the component from the neighbours' times. The other is to run the
 * real applier, stop short of writing, and *look at the plan it built*.
 *
 * Only the second is trustworthy. `resolveInsertionTimes` grids to five minutes, applies the
 * transition floor beside real visits but not beside placeholders, and clamps to the planning day;
 * a component reproducing that would agree with it until one of those rules changed, and the
 * disagreement would surface as an indicator promising a time the drop then refuses. Since
 * `prepareStructuralCommand` is pure and writes nothing, the honest preview costs no more than the
 * dishonest one — so this takes the prepared edit and simply finds the item in it.
 *
 * ## Three arms, because "cannot say" is not "refused"
 *
 * `refused` carries the applier's own sentence and is something the traveller can act on.
 * `unknown` means the edit would succeed but this stop is not in its result — which no current
 * command produces for the stop it names, and which must therefore not be rendered as a refusal.
 * Folding the two together would file a bug and "there is no free gap here" under one message.
 */

export type EditedItemPreview =
  | {
      status: "ready";
      dayNumber: number;
      startTime: string;
      endTime: string;
      /** One-based, for an announcement a traveller can count against the screen. */
      position: number;
      total: number;
    }
  | { status: "refused"; message: string }
  | { status: "unknown" };

export function describeEditedItem(
  prepared: PreparedStructuralEdit,
  itemId: string,
): EditedItemPreview {
  if (prepared.status === "refused") {
    return { status: "refused", message: prepared.message };
  }

  for (const day of prepared.plan.days) {
    const index = day.items.findIndex(
      (item: ItineraryItem) => item.id === itemId,
    );
    if (index === -1) continue;

    const item = day.items[index];
    return {
      status: "ready",
      dayNumber: day.dayNumber,
      startTime: item.startTime,
      endTime: item.endTime,
      position: index + 1,
      total: day.items.length,
    };
  }

  return { status: "unknown" };
}

/**
 * The same preview, as one sentence for a live region.
 *
 * Phrased for someone who cannot see the indicator, so it names the day and the position as well as
 * the clock — "day 2, position 3 of 5" is the part a sighted traveller reads off the screen. The
 * refusal is passed through unchanged, because the appliers already phrase their refusals for a
 * traveller and softening it here would lose the half that says what to do instead.
 */
export function announceEditedItem(
  preview: EditedItemPreview,
  itemTitle: string,
): string {
  switch (preview.status) {
    case "ready":
      return `${itemTitle}: day ${preview.dayNumber}, position ${preview.position} of ${preview.total}, ${preview.startTime} to ${preview.endTime}.`;
    case "refused":
      return `Cannot drop here. ${preview.message}`;
    case "unknown":
      return `${itemTitle} cannot be placed there.`;
  }
}
