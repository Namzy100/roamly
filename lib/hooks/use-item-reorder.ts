"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StructuralEditCommand } from "@/lib/refinement/commands";
import type { ItineraryDay } from "@/lib/schemas";
import type { PreparedStructuralEdit } from "@/lib/structural-edits";
import {
  announceEditedItem,
  describeEditedItem,
  type EditedItemPreview,
} from "@/lib/structural-edits/preview-item";
import {
  clampGapIndex,
  dayAtPoint,
  gapIndexForPointer,
  gapIndexOfItem,
  positionForGap,
  remainderIds,
  type CardBox,
  type DropRect,
} from "@/lib/trip/reorder";

/**
 * Reordering a stop by dragging it, or by moving it with the keyboard.
 *
 * ## One drag, one command
 *
 * A drag in progress writes nothing. It moves a *pending target* — a day and a gap — and that
 * target becomes a `move-item` command exactly once, when the drag finishes. Arrowing a stop down
 * four places therefore saves once rather than four times, which is not merely fewer writes: each
 * intermediate save would re-derive the stop's times from wherever it briefly sat, so where it
 * ended up would depend on the route it took to get there.
 *
 * It is the same `move-item` the placement dialog builds. No drag-specific applier, no
 * `reorder-item` command, and no path from here to the store that does not go through the caller's
 * `run` — see `lib/hooks/use-structural-edits.ts`.
 *
 * ## Pointer Events, and no library
 *
 * One code path covers mouse, touch and pen; native HTML5 drag-and-drop has no touch support at
 * all. The surface is a vertical list inside one day plus the day tabs, and the only genuinely
 * subtle part of it — which gap a coordinate means — is pure arithmetic living in
 * `lib/trip/reorder.ts`, where it is tested. `@dnd-kit/core` was last published in December 2024
 * and `@dnd-kit/react` is pre-1.0; neither earns a megabyte and an unstable API here.
 *
 * ## The keyboard path is not a fallback
 *
 * Space or Enter on the handle picks the stop up, the arrow keys move it, Enter drops it, Escape
 * puts it back. It runs this same state machine, produces the same command, and announces every
 * move — so the two are one feature rather than a feature and its accommodation.
 *
 * Keyboard movement stays **within the day**. Cross-day already has a keyboard path: the card's
 * "Move to another day" control opens the placement dialog, which collects a day *and* a position
 * and is a better instrument than counting arrow presses across a tab strip. Dragging onto a tab
 * adds a shortcut for pointers; it is not the only way to get there.
 *
 * ## Nothing is measured until a drag starts
 *
 * No geometry is read during render, so this is inert on the server and costs nothing until
 * somebody grabs a card. Cards and tabs are measured **once**, at drag start, which stays true
 * because the list deliberately does not reflow while dragging: the dragged card keeps its space
 * and an indicator marks the gap instead.
 */

/** The stop being moved, and where it would land. Present only while a drag is live. */
export type ReorderDrag = {
  itemId: string;
  itemTitle: string;
  sourceDayNumber: number;
  mode: "pointer" | "keyboard";
  targetDayNumber: number;
  /** A gap in the target day's list, counted with the moving stop taken out. */
  gapIndex: number;
  /**
   * The target has moved at least once since the stop was picked up.
   *
   * What separates "picked up, here is how this works" from "it would land at 14:05". Without it a
   * pick-up would immediately announce a position nobody has moved to, replacing the instructions
   * with a fact the traveller already had.
   */
  hasMoved: boolean;
};

export type ItemReorder = {
  drag: ReorderDrag | null;
  /** What the pending drop would do, from the real applier. Null when nothing is being dragged. */
  preview: EditedItemPreview | null;
  /** The live-region sentence. Empty while idle, so nothing is announced on mount. */
  announcement: string;
  startPointer: (
    input: { itemId: string; itemTitle: string; dayNumber: number },
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  startKeyboard: (input: {
    itemId: string;
    itemTitle: string;
    dayNumber: number;
  }) => void;
  /** Keyboard only: move the pending target by one place. */
  nudge: (delta: number) => void;
  commit: () => void;
  cancel: () => void;
  /** Whether the insertion indicator belongs in this gap of this day. */
  isTargetGap: (dayNumber: number, gapIndex: number) => boolean;
  /** Whether this day tab is the pending drop target, for highlighting it. */
  isTargetDay: (dayNumber: number) => boolean;
};

/** Where the cards and the day tabs were when the drag began. */
type Geometry = {
  cards: CardBox[];
  days: { dayNumber: number; rect: DropRect }[];
};

/**
 * Scoped to one day, because "All days" renders every day's cards at once.
 *
 * Measuring the lot would count another day's stops when deciding which gap the pointer is over —
 * a reorder inside day 3 that silently resolved against day 1's card positions.
 */
const cardSelector = (dayNumber: number) =>
  `[data-testid='itinerary-item'][data-day-number='${dayNumber}'][data-item-id]`;

const DAY_DROP_SELECTOR = "[data-day-drop]";

export function useItemReorder({
  days,
  disabled,
  preview: previewCommand,
  run,
}: {
  /**
   * The itinerary as it stands.
   *
   * Closed over directly rather than held in a ref, which is what makes the preview below a
   * function of something React can see change. It also settles what happens when the plan moves
   * mid-drag: the memo recomputes and the pointer listeners re-attach against the new list, which
   * is the right answer — a target resolved against an itinerary that no longer exists is exactly
   * the misplacement the position vocabulary is designed to prevent.
   */
  days: ItineraryDay[];
  /** An edit is saving. A drag must not begin, because its command would race that write. */
  disabled: boolean;
  preview: (command: StructuralEditCommand) => PreparedStructuralEdit;
  run: (command: StructuralEditCommand) => void;
}): ItemReorder {
  const [drag, setDrag] = useState<ReorderDrag | null>(null);
  const [settled, setSettled] = useState("");

  const geometry = useRef<Geometry | null>(null);

  const dayFor = useCallback(
    (dayNumber: number): ItineraryDay | undefined =>
      days.find((day) => day.dayNumber === dayNumber),
    [days],
  );

  const itemIdsFor = useCallback(
    (dayNumber: number): string[] =>
      dayFor(dayNumber)?.items.map((item) => item.id) ?? [],
    [dayFor],
  );

  /* -- what the pending drop would do --------------------------------------- */

  /**
   * The command a drag would produce, or null when it would produce none.
   *
   * Null for a target that is where the stop already is. `applyMoveItem` refuses that with
   * `same_position`, correctly — but somebody who picks a card up and puts it back has not made a
   * mistake, and reporting one would be scolding them for changing their mind. Declining to build a
   * command is not a second mutation path; it is the absence of one.
   */
  const commandFor = useCallback(
    (current: ReorderDrag): StructuralEditCommand | null => {
      const targetIds = itemIdsFor(current.targetDayNumber);
      const sameDay = current.targetDayNumber === current.sourceDayNumber;

      if (sameDay && current.gapIndex === gapIndexOfItem(targetIds, current.itemId)) {
        return null;
      }

      return {
        type: "move-item",
        sourceDayNumber: current.sourceDayNumber,
        targetDayNumber: current.targetDayNumber,
        itemId: current.itemId,
        targetPosition: positionForGap(
          remainderIds(targetIds, current.itemId),
          current.gapIndex,
        ),
      };
    },
    [itemIdsFor],
  );

  /**
   * The preview, recomputed only when the target moves.
   *
   * Running the whole applier on every pointer *event* would be wasteful; running it on every
   * change of gap is exactly right, and it is what makes the indicator's times the times the drop
   * will actually produce.
   *
   * The no-command case is previewed from the plan rather than skipped: "it would stay at
   * 09:00–10:30" is a true and useful thing for the indicator to say while a card hovers over its
   * own position, and it keeps the indicator from blanking out as the pointer passes home.
   */
  const preview = useMemo<EditedItemPreview | null>(() => {
    if (!drag) return null;

    const command = commandFor(drag);
    if (command) return describeEditedItem(previewCommand(command), drag.itemId);

    const day = dayFor(drag.targetDayNumber);
    const index = day?.items.findIndex((item) => item.id === drag.itemId) ?? -1;
    if (!day || index === -1) return { status: "unknown" };

    const item = day.items[index];
    return {
      status: "ready",
      dayNumber: day.dayNumber,
      startTime: item.startTime,
      endTime: item.endTime,
      position: index + 1,
      total: day.items.length,
    };
  }, [commandFor, dayFor, drag, previewCommand]);

  /* -- starting, moving, finishing ------------------------------------------ */

  const cancel = useCallback(() => {
    geometry.current = null;
    setDrag((current) => {
      if (current) {
        setSettled(`Cancelled. ${current.itemTitle} is back where it was.`);
      }
      return null;
    });
  }, []);

  const startKeyboard = useCallback(
    (input: { itemId: string; itemTitle: string; dayNumber: number }) => {
      if (disabled) return;

      const ids = itemIdsFor(input.dayNumber);
      const gapIndex = gapIndexOfItem(ids, input.itemId);
      if (gapIndex === -1) return;

      setDrag({
        itemId: input.itemId,
        itemTitle: input.itemTitle,
        sourceDayNumber: input.dayNumber,
        mode: "keyboard",
        targetDayNumber: input.dayNumber,
        gapIndex,
        hasMoved: false,
      });
    },
    [disabled, itemIdsFor],
  );

  const nudge = useCallback(
    (delta: number) => {
      setDrag((current) => {
        if (!current || current.mode !== "keyboard") return current;

        const remainder = remainderIds(
          itemIdsFor(current.targetDayNumber),
          current.itemId,
        );
        const next = clampGapIndex(current.gapIndex + delta, remainder.length);
        return next === current.gapIndex
          ? current
          : { ...current, gapIndex: next, hasMoved: true };
      });
    },
    [itemIdsFor],
  );

  const startPointer = useCallback(
    (
      input: { itemId: string; itemTitle: string; dayNumber: number },
      event: React.PointerEvent<HTMLElement>,
    ) => {
      if (disabled) return;
      // Secondary buttons raise context menus; a drag begun on one could never be released.
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const gapIndex = gapIndexOfItem(itemIdsFor(input.dayNumber), input.itemId);
      if (gapIndex === -1) return;

      geometry.current = measure(input.dayNumber);
      event.currentTarget.setPointerCapture(event.pointerId);
      /** Stops the press also becoming a text selection or a native image drag. */
      event.preventDefault();

      setDrag({
        itemId: input.itemId,
        itemTitle: input.itemTitle,
        sourceDayNumber: input.dayNumber,
        mode: "pointer",
        targetDayNumber: input.dayNumber,
        gapIndex,
        hasMoved: false,
      });
    },
    [disabled, itemIdsFor],
  );

  /**
   * Commit, or decline and say why.
   *
   * The command runs only when the preview says the edit would be accepted. A refused target — no
   * free gap there, the source day would be emptied — is reported in the applier's own words and
   * **nothing is written**, rather than being sent so the workspace can show that same sentence a
   * moment later as a failed save.
   *
   * A refused pointer drop ends the drag; a refused keyboard drop keeps it alive. Not an
   * inconsistency but a difference in the medium: a released pointer cannot be un-released, whereas
   * somebody who pressed Enter on a bad gap is still holding the stop and can arrow to a better one.
   */
  const commit = useCallback(() => {
    if (!drag) return;

    const finish = () => {
      geometry.current = null;
      setDrag(null);
    };

    const command = commandFor(drag);
    if (!command) {
      setSettled(`${drag.itemTitle} stayed where it was.`);
      finish();
      return;
    }

    if (preview?.status !== "ready") {
      setSettled(
        preview
          ? announceEditedItem(preview, drag.itemTitle)
          : `${drag.itemTitle} cannot be placed there.`,
      );
      if (drag.mode === "pointer") finish();
      return;
    }

    run(command);
    setSettled(
      `Dropped ${drag.itemTitle} at ${preview.startTime} to ${preview.endTime} on day ${preview.dayNumber}.`,
    );
    finish();
  }, [commandFor, drag, preview, run]);

  /* -- what is being said out loud ------------------------------------------ */

  /**
   * Derived while a stop is in the air, stored only once it has landed.
   *
   * The live half cannot be state. Every new target's sentence is built from the preview, which is
   * itself derived from the target — so setting it inside `nudge` would describe the gap the stop
   * has just left, and setting it from an effect would be a render whose only job is to catch up
   * with the render before it. Deriving it means the announcement and the indicator are two
   * readings of one value and cannot disagree.
   *
   * The terminal sentences — dropped, cancelled, stayed put — *are* state, because they outlive the
   * drag that produced them. They are what a screen reader should still be able to report after the
   * stop has been put down and `drag` is null again.
   */
  const announcement = drag
    ? drag.hasMoved && preview
      ? announceEditedItem(preview, drag.itemTitle)
      : pickUpSentence(drag, itemIdsFor(drag.sourceDayNumber).length)
    : settled;

  /* -- the pointer's own listeners ------------------------------------------ */

  /**
   * On `window`, and only while a pointer drag is live.
   *
   * The handle captures the pointer so events keep arriving after the finger leaves it, but the
   * *listeners* go on the window so a release over the map — or anywhere else — still ends the drag
   * rather than stranding it.
   */
  useEffect(() => {
    if (!drag || drag.mode !== "pointer") return;

    const onMove = (event: PointerEvent) => {
      const measured = geometry.current;
      if (!measured) return;

      const overDay = dayAtPoint(measured.days, {
        x: event.clientX,
        y: event.clientY,
      });

      setDrag((current) => {
        if (!current) return current;

        /**
         * A tab under the pointer wins, including the stop's own day.
         *
         * One rule rather than a special case: dropping on today's tab sends the stop to the end of
         * today, which is a real thing to want and reads exactly like dropping it on any other tab.
         */
        const targetDayNumber = overDay ?? current.sourceDayNumber;
        const gapIndex =
          overDay === null
            ? gapIndexForPointer(measured.cards, current.itemId, event.clientY)
            : remainderIds(itemIdsFor(overDay), current.itemId).length;

        return current.targetDayNumber === targetDayNumber &&
          current.gapIndex === gapIndex
          ? current
          : { ...current, targetDayNumber, gapIndex, hasMoved: true };
      });
    };

    const onUp = () => commit();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cancel, commit, drag, itemIdsFor]);

  /* -- what the interface asks ---------------------------------------------- */

  const isTargetGap = useCallback(
    (dayNumber: number, gapIndex: number) =>
      drag !== null &&
      drag.targetDayNumber === dayNumber &&
      drag.gapIndex === gapIndex,
    [drag],
  );

  const isTargetDay = useCallback(
    (dayNumber: number) =>
      drag !== null &&
      drag.mode === "pointer" &&
      drag.targetDayNumber === dayNumber,
    [drag],
  );

  return {
    drag,
    preview,
    announcement,
    startPointer,
    startKeyboard,
    nudge,
    commit,
    cancel,
    isTargetGap,
    isTargetDay,
  };
}

/**
 * What is said the moment a stop leaves the ground.
 *
 * The keyboard gets the controls, because nothing on screen has told anybody what the arrow keys do
 * and this is the first moment the answer matters. A pointer drag gets one short sentence: the hand
 * already knows how to move, and reciting keystrokes at somebody mid-gesture would be noise.
 */
function pickUpSentence(drag: ReorderDrag, dayLength: number): string {
  if (drag.mode === "pointer") return `Dragging ${drag.itemTitle}.`;

  return `Picked up ${drag.itemTitle}, position ${drag.gapIndex + 1} of ${dayLength} on day ${drag.sourceDayNumber}. Use the up and down arrows to move it, Enter to drop it, Escape to cancel.`;
}

/**
 * The cards and the day tabs, as rectangles.
 *
 * Queried from the document rather than collected through refs. A registry would need every card to
 * register and deregister on mount, unmount, day switch and filter change, and one stale entry in it
 * is a drop that lands on a card no longer there. The DOM already knows which cards exist; this
 * reads it once, inside an event handler, where a browser is guaranteed.
 */
function measure(sourceDayNumber: number): Geometry {
  const cards: CardBox[] = [];
  for (const node of document.querySelectorAll<HTMLElement>(
    cardSelector(sourceDayNumber),
  )) {
    const itemId = node.dataset.itemId;
    if (!itemId) continue;
    const rect = node.getBoundingClientRect();
    cards.push({ itemId, top: rect.top, height: rect.height });
  }

  const days: { dayNumber: number; rect: DropRect }[] = [];
  for (const node of document.querySelectorAll<HTMLElement>(DAY_DROP_SELECTOR)) {
    const dayNumber = Number(node.dataset.dayDrop);
    if (!Number.isInteger(dayNumber)) continue;
    const rect = node.getBoundingClientRect();
    days.push({
      dayNumber,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  return { cards, days };
}
