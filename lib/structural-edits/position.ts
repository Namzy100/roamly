import type { TargetPosition } from "@/lib/refinement/commands";
import type { ItineraryItem } from "@/lib/schemas";

/**
 * Turning a named position into an insertion index.
 *
 * ## Why a position and not an index
 *
 * An index is a fact about an array. Between the render that produced the control and the
 * click that used it, an array can gain or lose an entry — another tab, an undo, a repair —
 * and "insert at 2" then means somewhere nobody asked for. Naming the neighbour makes the
 * request a fact about the *itinerary*, and an id that is no longer there is a clean
 * refusal rather than a silent misplacement.
 *
 * ## Order versus time
 *
 * This module resolves *sequence*. The clock is `schedule.ts`'s job, and the two are kept
 * apart deliberately: a day's items are stored in `order` and rendered in that order, but
 * what makes an itinerary correct is the times. So a position decides which neighbours the
 * new stop sits between, and the neighbours' times decide what window it may occupy.
 */

export type ResolvedPosition = {
  /** Where in the array the item goes: `0` is first, `items.length` is last. */
  index: number;
  /** The item that will precede it, or null when it becomes the first. */
  before: ItineraryItem | null;
  /** The item that will follow it, or null when it becomes the last. */
  after: ItineraryItem | null;
};

export type PositionFailure = {
  code: "target_item_not_found";
  message: string;
  itemId: string;
};

/**
 * The insertion point for a position within a list the item is **not** already in.
 *
 * For a same-day move the caller removes the item first and resolves against the remainder,
 * so an item can never be positioned relative to itself.
 */
export function resolvePosition(
  items: ItineraryItem[],
  position: TargetPosition,
): { ok: true; value: ResolvedPosition } | { ok: false; error: PositionFailure } {
  if (position.kind === "end") {
    return {
      ok: true,
      value: {
        index: items.length,
        before: items.length > 0 ? items[items.length - 1] : null,
        after: null,
      },
    };
  }

  const anchorIndex = items.findIndex((item) => item.id === position.itemId);
  if (anchorIndex === -1) {
    return {
      ok: false,
      error: {
        code: "target_item_not_found",
        message: `There is no stop "${position.itemId}" on that day to place this ${position.kind}.`,
        itemId: position.itemId,
      },
    };
  }

  const index = position.kind === "before" ? anchorIndex : anchorIndex + 1;

  return {
    ok: true,
    value: {
      index,
      before: index > 0 ? items[index - 1] : null,
      after: index < items.length ? items[index] : null,
    },
  };
}

/**
 * Inserts at an index and renumbers `order` across the whole day.
 *
 * `order` is renumbered rather than nudged because it is what the cards and the routing-leg
 * derivation read. A day whose `order` values disagreed with its array would render one
 * sequence and route another.
 *
 * Items whose `order` is already correct come back as the **same object**, so preservation
 * is `===`-checkable by a test rather than merely deep-equal.
 */
export function insertAt(
  items: ItineraryItem[],
  index: number,
  item: ItineraryItem,
): ItineraryItem[] {
  const next = [...items.slice(0, index), item, ...items.slice(index)];
  return renumber(next);
}

/** Removes by id and renumbers. Returns the list unchanged when the id is absent. */
export function removeById(
  items: ItineraryItem[],
  itemId: string,
): ItineraryItem[] {
  if (!items.some((item) => item.id === itemId)) return items;
  return renumber(items.filter((item) => item.id !== itemId));
}

export function renumber(items: ItineraryItem[]): ItineraryItem[] {
  return items.map((item, index) =>
    item.order === index ? item : { ...item, order: index },
  );
}
