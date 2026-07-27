import type { TargetPosition } from "@/lib/refinement/commands";

/**
 * Turning a drag into a position.
 *
 * ## Why this is not in the component
 *
 * The repository has no jsdom and no React Testing Library, so anything left inside a pointer
 * handler is untestable by construction — and the arithmetic below is exactly the kind that is
 * wrong by one and looks right. So the component keeps the two things only a browser can do,
 * measuring elements and listening for pointers, and every decision made from those measurements
 * lives here as a pure function over plain numbers.
 *
 * ## Gaps, not indices
 *
 * A drop lands in a **gap**, and the gaps are counted in the day's list *with the dragged item
 * taken out* — because that is the list `resolvePosition` resolves against. `applyMoveItem` removes
 * the item before resolving a same-day move, so counting gaps in the rendered list instead would be
 * off by one for every drop below the item's own position: the single most likely bug in a
 * hand-rolled reorder and the hardest to notice, because it misplaces by one and only downwards.
 *
 * Gap `i` means "before the remainder's item `i`"; gap `remainder.length` means "at the end". A day
 * of *n* items therefore offers *n* gaps to the item being dragged, one of which is where it
 * already is.
 *
 * ## Positions, not indices, at the boundary
 *
 * The gap index never leaves this module as a number the command layer sees. `positionForGap` turns
 * it into a `TargetPosition` naming a neighbour, which is what makes a drop survive the list
 * changing between the drag and the drop — another tab, an undo — as a clean refusal rather than a
 * silent misplacement. `lib/structural-edits/position.ts` explains why that distinction is load
 * bearing; this module is the reason a drag cannot quietly opt out of it.
 */

/** One rendered card, measured. Viewport coordinates, as `getBoundingClientRect` gives them. */
export type CardBox = {
  itemId: string;
  top: number;
  height: number;
};

export type DropRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * The day's items with the dragged one removed — the list a drop is resolved against.
 *
 * Returns the list unchanged when the id is absent, which is what happens when a drag outlives the
 * item it started on. The drop then resolves against a real list and the applier refuses, rather
 * than anything being computed from a hole.
 */
export function remainderIds(
  itemIds: string[],
  movingItemId: string,
): string[] {
  return itemIds.filter((id) => id !== movingItemId);
}

/**
 * The gap a stop currently occupies.
 *
 * Its index in the *full* list, which is the same number as its gap in the remainder: everything
 * above it stays above it, and everything below it shifts up one. This is where a keyboard drag
 * starts, and what a finished drag is compared against to know whether anything actually moved.
 *
 * `-1` when the item is not in the list, so a caller cannot mistake "not here" for "first".
 */
export function gapIndexOfItem(itemIds: string[], movingItemId: string): number {
  return itemIds.indexOf(movingItemId);
}

/**
 * The gap a pointer is over.
 *
 * Counts how many of the *other* cards have their midpoint above the pointer. Midpoints rather than
 * edges because that is the rule a hand can predict: a card yields when you are more than half way
 * across it, so the indicator never sits still while the pointer crosses a boundary and never
 * flickers between two gaps at one position.
 *
 * The dragged card is skipped rather than removed from the measurements. It keeps its space in the
 * layout for the whole drag — nothing reflows, so boxes measured once at drag start stay true — and
 * counting it would make the gap under the pointer depend on which side of its own old position the
 * pointer came from, which is the off-by-one this module exists to prevent.
 */
export function gapIndexForPointer(
  boxes: CardBox[],
  movingItemId: string,
  pointerY: number,
): number {
  let gap = 0;
  for (const box of boxes) {
    if (box.itemId === movingItemId) continue;
    if (box.top + box.height / 2 < pointerY) gap += 1;
  }
  return gap;
}

/** Keeps a gap inside the list, for the arrow keys that would otherwise walk off either end. */
export function clampGapIndex(gapIndex: number, remainderLength: number): number {
  if (gapIndex < 0) return 0;
  if (gapIndex > remainderLength) return remainderLength;
  return gapIndex;
}

/**
 * A gap, as the command vocabulary states it.
 *
 * Always `before` or `end`, never `after`. Both would be correct, and offering the pair would give
 * two ways to name one drop — so a test asserting "dropped above the museum" would have to know
 * which of the two the geometry happened to produce. One representation means the command a drag
 * builds is a function of where it landed and of nothing else.
 */
export function positionForGap(
  remainder: string[],
  gapIndex: number,
): TargetPosition {
  const clamped = clampGapIndex(gapIndex, remainder.length);
  return clamped >= remainder.length
    ? { kind: "end" }
    : { kind: "before", itemId: remainder[clamped] };
}

/**
 * Which day tab a pointer is over, for a cross-day drop.
 *
 * Rectangles rather than `elementFromPoint`, for the same reason the card gaps are measured up
 * front: the handle captures the pointer for the whole drag, so every element under it reports as
 * the handle. Hit-testing has to be arithmetic the drag does itself rather than something the
 * browser volunteers about hover.
 *
 * Null when the pointer is over none of them, which is the common case — a reorder spends its whole
 * life outside the tab strip.
 */
export function dayAtPoint(
  targets: { dayNumber: number; rect: DropRect }[],
  point: { x: number; y: number },
): number | null {
  for (const target of targets) {
    if (containsPoint(target.rect, point)) return target.dayNumber;
  }
  return null;
}

function containsPoint(
  rect: DropRect,
  point: { x: number; y: number },
): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}
