import { describe, expect, it } from "vitest";

import {
  clampGapIndex,
  dayAtPoint,
  gapIndexForPointer,
  gapIndexOfItem,
  positionForGap,
  remainderIds,
  type CardBox,
} from "./reorder";

/**
 * Four cards of unequal height, stacked from y=0.
 *
 * Unequal deliberately: equal heights would let an off-by-one in the midpoint arithmetic pass,
 * because every boundary would land on a round multiple of the same number.
 *
 *   a    0 → 100   midpoint  50
 *   b  100 → 160   midpoint 130
 *   c  160 → 300   midpoint 230
 *   d  300 → 340   midpoint 320
 */
const BOXES: CardBox[] = [
  { itemId: "a", top: 0, height: 100 },
  { itemId: "b", top: 100, height: 60 },
  { itemId: "c", top: 160, height: 140 },
  { itemId: "d", top: 300, height: 40 },
];

const IDS = ["a", "b", "c", "d"];

describe("remainderIds", () => {
  it("removes the stop being dragged", () => {
    expect(remainderIds(IDS, "c")).toEqual(["a", "b", "d"]);
  });

  it("returns the list unchanged when the id is absent", () => {
    expect(remainderIds(IDS, "gone")).toEqual(IDS);
  });
});

describe("gapIndexOfItem", () => {
  it("is the item's own index, which is also its gap in the remainder", () => {
    expect(gapIndexOfItem(IDS, "a")).toBe(0);
    expect(gapIndexOfItem(IDS, "c")).toBe(2);
  });

  it("is -1 for a stop that is not on the day", () => {
    expect(gapIndexOfItem(IDS, "gone")).toBe(-1);
  });
});

describe("gapIndexForPointer", () => {
  it("puts a pointer above every card in the first gap", () => {
    expect(gapIndexForPointer(BOXES, "a", 10)).toBe(0);
  });

  it("puts a pointer below every card in the last gap", () => {
    // Three cards remain once "a" is out, so the final gap is 3.
    expect(gapIndexForPointer(BOXES, "a", 1_000)).toBe(3);
  });

  it("swaps at a card's midpoint rather than at its edge", () => {
    // "b" spans 100–160, midpoint 130. Dragging "d" leaves a, b, c as the remainder.
    expect(gapIndexForPointer(BOXES, "d", 129)).toBe(1);
    expect(gapIndexForPointer(BOXES, "d", 131)).toBe(2);
  });

  /**
   * The bug this module exists to prevent.
   *
   * Counting the dragged card would put every gap below its old position one too high — a drop
   * landing one place further down than the indicator showed, and only ever downwards.
   */
  it("does not count the dragged card itself", () => {
    // Pointer at 250. Midpoints above it: a(50), b(130), c(230) — but "b" is the one being dragged.
    expect(gapIndexForPointer(BOXES, "b", 250)).toBe(2);
    // Counting it would have given 3, which is one place too far down.
    expect(gapIndexForPointer(BOXES, "z", 250)).toBe(3);
  });
});

describe("clampGapIndex", () => {
  it("holds the arrow keys inside the list", () => {
    expect(clampGapIndex(-1, 3)).toBe(0);
    expect(clampGapIndex(4, 3)).toBe(3);
    expect(clampGapIndex(2, 3)).toBe(2);
  });
});

describe("positionForGap", () => {
  const remainder = ["a", "b", "d"];

  it("names the stop the dragged one would sit above", () => {
    expect(positionForGap(remainder, 0)).toEqual({ kind: "before", itemId: "a" });
    expect(positionForGap(remainder, 2)).toEqual({ kind: "before", itemId: "d" });
  });

  it("uses `end` for the gap past the last stop", () => {
    expect(positionForGap(remainder, 3)).toEqual({ kind: "end" });
  });

  /** One representation per drop, so a drop names exactly one position. */
  it("never produces an `after` position", () => {
    for (let gap = -2; gap <= 6; gap += 1) {
      expect(positionForGap(remainder, gap).kind).not.toBe("after");
    }
  });

  it("clamps rather than reading off the end of the list", () => {
    expect(positionForGap(remainder, 99)).toEqual({ kind: "end" });
    expect(positionForGap(remainder, -3)).toEqual({ kind: "before", itemId: "a" });
  });

  it("uses `end` for an empty remainder, whatever the gap", () => {
    expect(positionForGap([], 0)).toEqual({ kind: "end" });
  });
});

describe("dayAtPoint", () => {
  const targets = [
    { dayNumber: 1, rect: { left: 0, top: 0, width: 80, height: 40 } },
    { dayNumber: 2, rect: { left: 90, top: 0, width: 80, height: 40 } },
  ];

  it("finds the tab under the pointer", () => {
    expect(dayAtPoint(targets, { x: 40, y: 20 })).toBe(1);
    expect(dayAtPoint(targets, { x: 120, y: 20 })).toBe(2);
  });

  it("is null in the gap between two tabs", () => {
    expect(dayAtPoint(targets, { x: 85, y: 20 })).toBeNull();
  });

  it("is null well away from the strip, which is where a reorder happens", () => {
    expect(dayAtPoint(targets, { x: 40, y: 400 })).toBeNull();
  });

  it("includes its own edges, so a press on the border still lands", () => {
    expect(dayAtPoint(targets, { x: 0, y: 0 })).toBe(1);
    expect(dayAtPoint(targets, { x: 80, y: 40 })).toBe(1);
  });
});
