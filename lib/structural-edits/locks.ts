import type { ItemKind, ItineraryItem } from "@/lib/schemas";

/**
 * The two locks, in one file so they cannot be confused.
 *
 * ## Why they are different things
 *
 * A `transport` or `logistics` block is fixed by the trip's **dates**. The airport transfer
 * happens on the day the flight lands, and a plan whose arrival transfer sat on day three would
 * be describing a journey nobody takes. That is a product rule, and no traveller preference
 * should be able to switch it off.
 *
 * `item.locked` is the opposite: a traveller decided this stop matters and would like the
 * interface — and the assistant — to leave it alone. It is theirs to set and theirs to clear.
 *
 * Phase 6C had only the first and called its error code `item_locked`. Phase 8 adds the second.
 * Reusing one predicate for both would mean `unlock-item` could free the airport run, which is
 * exactly the bug this file exists to prevent: "may this be edited?" and "may this be unlocked?"
 * are different questions, and each applier asks the one that matches what it is about to do.
 *
 * ## Why by `kind` rather than by position
 *
 * The first item of a day is not inherently fixed, and matching on a title like "Arrive at"
 * would break in any other language. `kind` is the field generation actually sets for this
 * purpose.
 */

/**
 * Kinds the trip's dates pin in place.
 *
 * Owned here rather than in `move-item.ts`, which held it privately in Phase 6C: five more
 * appliers need the same answer in Phase 8, and two copies of this set is how one of them would
 * eventually disagree about whether a check-in can be dragged.
 */
export const STRUCTURALLY_LOCKED_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "transport",
  "logistics",
]);

/** Fixed by the trip's dates. Not something a traveller can release. */
export function isStructurallyLocked(item: ItineraryItem): boolean {
  return STRUCTURALLY_LOCKED_KINDS.has(item.kind);
}

/** Pinned by the traveller. Released by `unlock-item`. */
export function isTravellerLocked(item: ItineraryItem): boolean {
  return item.locked;
}

/**
 * Whether any edit that moves, re-times, resizes, removes or re-places this stop must refuse.
 *
 * The single question every applier asks. Combining the two here rather than at each call site
 * is what stops one applier honouring the traveller's lock and another quietly ignoring it.
 */
export function isEditLocked(item: ItineraryItem): boolean {
  return isStructurallyLocked(item) || isTravellerLocked(item);
}

/**
 * Why an edit was refused, as a code and a sentence — or `null` when the stop is editable.
 *
 * Shaped so a caller can write `const refusal = lockRefusalFor(item); if (refusal) return
 * failed({ ...refusal, dayNumber, itemId: item.id });`
 *
 * The two messages differ because the two situations differ: one is something the traveller can
 * undo in a click, and the other is not. Telling someone to "unlock it first" about a block with
 * no unlock control would be the worse failure.
 *
 * The structural check comes first. A locked airport transfer is *both*, and the sentence that
 * helps is the one naming the reason they cannot do anything about.
 */
export function lockRefusalFor(item: ItineraryItem): {
  code: "item_locked" | "item_structurally_locked";
  message: string;
} | null {
  if (isStructurallyLocked(item)) {
    return {
      code: "item_structurally_locked",
      message: `“${item.title}” is fixed to this day by the trip's dates — arrival, departure and check-in blocks cannot be changed.`,
    };
  }

  if (item.locked) {
    return {
      code: "item_locked",
      message: `“${item.title}” is locked. Unlock it first if you want to change it.`,
    };
  }

  return null;
}

/**
 * Whether the traveller's padlock control should appear at all.
 *
 * False for structurally locked blocks: offering a padlock on something already immovable, whose
 * lock could never be released, is a control that means nothing.
 */
export function supportsTravellerLock(item: ItineraryItem): boolean {
  return !isStructurallyLocked(item);
}
