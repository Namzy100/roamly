"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CalendarArrowDown,
  Clock,
  Coffee,
  Footprints,
  GripVertical,
  Hourglass,
  Loader2,
  Lock,
  LockOpen,
  Repeat,
  Shuffle,
  Timer,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { FreeTimeForm } from "@/components/trip/free-time-form";
import { ItineraryItemCard } from "@/components/trip/itinerary-item-card";
import { StopAlternatives } from "@/components/trip/stop-alternatives";
import { StopDurationEditor } from "@/components/trip/stop-duration-editor";
import { StopTimeEditor } from "@/components/trip/stop-time-editor";
import { TravelSegmentRow } from "@/components/trip/travel-segment-row";
import {
  formatDayLabel,
  formatDuration,
  formatMoney,
  formatTimeRange,
} from "@/lib/format";
import type { ItemReorder } from "@/lib/hooks/use-item-reorder";
import { deriveDayTravelSummary } from "@/lib/plan";
import type { OpeningEvaluation } from "@/lib/opening-hours";
import type { StructuralEditCommand } from "@/lib/refinement/commands";
import type { EditedItemPreview } from "@/lib/structural-edits/preview-item";
import {
  isTravellerLocked,
  supportsTravellerLock,
} from "@/lib/structural-edits/locks";
import { itemIsMovable } from "@/lib/structural-edits/move-item";
import { itemIsRemovable } from "@/lib/structural-edits/remove-item";
import { itemIsRetimable } from "@/lib/structural-edits/set-schedule";
import {
  isMappableItem,
  type Currency,
  type ItineraryDay,
  type ItineraryItem,
  type TripPlace,
} from "@/lib/schemas";
import type { DayFilter } from "@/lib/store/workspace-store";
import { cardElementId } from "@/lib/trip/item-card";
import type { VisibleItem } from "@/lib/trip/visible-items";
import { cn } from "@/lib/utils";

/**
 * The chronological plan.
 *
 * When a selection originates on the map, this panel scrolls the matching card
 * into view. That only happens for map-originated selections — scrolling in
 * response to the user's own click would fight their scroll position.
 *
 * ## Where the editing controls come from
 *
 * Every structural edit this panel offers is expressed as a `StructuralEditCommand` handed to
 * `onCommand`. The panel therefore holds no save logic, no revision, and no idea that a store
 * exists: it decides *which* edits a stop can offer and what they are called, and the hook's one
 * execution path decides everything else. That is what keeps a control from acquiring its own
 * semantics — the most it can do is build the wrong command, which the appliers refuse.
 */

/** Which inline editor a stop has open. One at a time, across the whole panel. */
type OpenEditor = { itemId: string; kind: EditorKind };

type EditorKind = "time" | "duration" | "alternatives";

export function ItineraryPanel({
  days,
  visibleItems,
  selectedDay,
  selectedItemId,
  hoveredItemId,
  selectionSource,
  currency,
  onSelectItem,
  onHoverItem,
  onReplaceItem,
  onRetryRoute,
  onMoveItem,
  onCommand,
  checkCommand,
  describeCommand,
  reorder,
  alternativesFor,
  freeWindowFor,
  canMoveItems = false,
  openingHoursByItemId,
  busyItemId = null,
  busyLegId = null,
  canReplace = false,
  editBusy = false,
}: {
  days: ItineraryDay[];
  visibleItems: VisibleItem[];
  selectedDay: DayFilter;
  selectedItemId: string | null;
  hoveredItemId: string | null;
  selectionSource: "list" | "map" | "day" | null;
  currency: Currency;
  onSelectItem: (itemId: string) => void;
  onHoverItem: (itemId: string | null) => void;
  /**
   * Phase 6A per-stop actions, all optional so the panel still renders for a trip
   * that cannot be refined — the sample, or anything with no saved place pool.
   */
  onReplaceItem?: (input: { dayNumber: number; itemId: string }) => void;
  onRetryRoute?: (legId: string) => void;
  /**
   * Moving a stop to another day (Phase 6C).
   *
   * Still its own callback rather than a command, because it opens the placement dialog instead of
   * running an edit — the day and the position have to be *collected* first. The dialog issues the
   * `move-item` command through the same execution path afterwards.
   */
  onMoveItem?: (input: { dayNumber: number; itemId: string }) => void;
  canMoveItems?: boolean;
  /**
   * The one way this panel changes an itinerary (Phase 8).
   *
   * Absent means the trip cannot be structurally edited at all — no saved pool — and every control
   * gated on it disappears, in keeping with how `onReplaceItem` already works. There is no second
   * `canEdit` flag to fall out of step with it.
   */
  onCommand?: (command: StructuralEditCommand) => void;
  /**
   * What a command *would* be refused for, without running it.
   *
   * The hook's `preview`, so the answer is the applier's own. Lets the time editor show the refusal
   * as the traveller types rather than after they commit.
   */
  checkCommand?: (command: StructuralEditCommand) => string | null;
  /**
   * What a command *would* produce, in full — the resulting times as well as any refusal.
   *
   * A richer answer than `checkCommand` and from the same `preview`, for the two places that have
   * to state an outcome rather than merely permit one: the length editor, which says what the new
   * times would be, and the drag indicator, which says where a stop would land. Kept separate
   * rather than replacing `checkCommand`, because a form that only needs to know whether Save is
   * available should not have to reach into a plan to find out.
   */
  describeCommand?: (
    command: StructuralEditCommand,
    itemId: string,
  ) => EditedItemPreview;
  /**
   * The reorder drag, if this trip may be reordered at all.
   *
   * Owned by the workspace rather than by this panel, because a drag can end on the day tabs —
   * which are the workspace's, not the itinerary's. The panel renders the handles, the indicator
   * and the announcement; every decision about where a stop would land is the hook's.
   */
  reorder?: ItemReorder;
  /** The places a stop could be swapped to, from `alternativesForItem`. */
  alternativesFor?: (input: {
    dayNumber: number;
    itemId: string;
  }) => TripPlace[];
  /** The gap a stop could occupy, from `freeWindowForItem`. */
  freeWindowFor?: (input: { dayNumber: number; itemId: string }) => {
    earliest: string;
    latest: string;
  } | null;
  /**
   * The opening-hours verdict per stop, derived once by the workspace (Phase 6B).
   *
   * A map rather than a per-card computation, so every card and the accuracy panel read the
   * same verdict — two derivations would eventually disagree, and the card is what a
   * traveller reads.
   */
  openingHoursByItemId?: Map<string, OpeningEvaluation>;
  busyItemId?: string | null;
  busyLegId?: string | null;
  canReplace?: boolean;
  /** A structural edit is saving. Every control is disabled so two cannot race one revision. */
  editBusy?: boolean;
}) {
  const reduceMotion = useReducedMotion();

  /**
   * One open editor at a time, held here rather than in each card.
   *
   * Two open time editors would be two sets of pending times, and saving one would silently
   * invalidate the other's window — so opening one closes the other by construction. A card cannot
   * decide this for itself, because it would have to know about its siblings.
   */
  const [open, setOpen] = useState<OpenEditor | null>(null);
  const [freeTimeDay, setFreeTimeDay] = useState<number | null>(null);

  /** One set of keyboard instructions, pointed at by every drag handle in the panel. */
  const reorderHelpId = useId();

  useEffect(() => {
    if (selectionSource !== "map" || !selectedItemId) return;
    const node = document.getElementById(cardElementId(selectedItemId));
    node?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  }, [selectedItemId, selectionSource, reduceMotion]);

  const shownDays =
    selectedDay === "all"
      ? days
      : days.filter((day) => day.dayNumber === selectedDay);

  const numberOf = new Map(
    visibleItems.map((entry) => [entry.item.id, entry.displayNumber]),
  );

  if (shownDays.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-sand/30 p-10 text-center">
        <p className="text-sm text-ink-muted">
          No days to show. Pick another day above.
        </p>
      </div>
    );
  }

  /**
   * Run a command and close whatever was open.
   *
   * Closing unconditionally rather than only on success: the outcome arrives asynchronously, and an
   * editor left open over a saved edit shows stale times as though they were pending. A refusal is
   * reported by the workspace's own status line, which is where every other failure is read.
   */
  const runAndClose = (command: StructuralEditCommand) => {
    setOpen(null);
    setFreeTimeDay(null);
    onCommand?.(command);
  };

  return (
    <div className="flex flex-col gap-8">
      {/*
        * The reorder's running commentary.
        *
        * `assertive` rather than the `polite` every other live region in this app uses, and for a
        * reason specific to dragging: a move is a *continuous* interaction, so a queued
        * announcement would describe a gap the stop has already passed. Interrupting is the correct
        * behaviour when the previous sentence has been superseded.
        *
        * Empty while idle, so nothing is read out on mount.
        */}
      {reorder ? (
        <p
          className="sr-only"
          aria-live="assertive"
          aria-atomic="true"
          data-testid="reorder-announcement"
        >
          {reorder.announcement}
        </p>
      ) : null}

      {/*
        * How the handle works, said once for the whole panel.
        *
        * Every handle points at this with `aria-describedby`. Repeating the sentence in each
        * handle's label would make tabbing through a day read like a manual, and putting it only in
        * the announcement would tell somebody the controls *after* they had guessed at them.
        */}
      {reorder ? (
        <p id={reorderHelpId} className="sr-only">
          Press Space or Enter to pick this stop up, the up and down arrow keys to move it within
          the day, Enter to drop it, and Escape to cancel.
        </p>
      ) : null}

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={String(selectedDay)}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
          className="flex flex-col gap-8"
        >
          {shownDays.map((day) => (
            <section
              key={day.dayNumber}
              aria-labelledby={`day-${day.dayNumber}-heading`}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3
                    id={`day-${day.dayNumber}-heading`}
                    className="font-display text-2xl text-forest"
                  >
                    <span className="text-terracotta">Day {day.dayNumber}</span>{" "}
                    · {day.theme}
                  </h3>
                  <span className="text-xs text-ink-muted">
                    {formatDayLabel(day.date)}
                  </span>
                </div>

                <p className="text-sm leading-relaxed text-ink-muted text-pretty">
                  {day.summary}
                </p>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock aria-hidden className="size-3.5" />
                    {day.items.length} stops
                  </span>
                  <DayTravelChip day={day} />
                  <span className="font-medium text-forest">
                    {formatMoney(day.dayTotal, currency)}
                  </span>

                  {/*
                    * Free time belongs to the day, not to a gap between two stops.
                    *
                    * `insert-free-time` takes a day and two times, so a per-gap control would imply
                    * the gap was part of the request. It is not — the times say where it goes.
                    */}
                  {onCommand && checkCommand ? (
                    <button
                      type="button"
                      disabled={editBusy}
                      aria-expanded={freeTimeDay === day.dayNumber}
                      data-testid="add-free-time"
                      data-day-number={day.dayNumber}
                      onClick={() =>
                        setFreeTimeDay((current) =>
                          current === day.dayNumber ? null : day.dayNumber,
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-cream-raised px-2.5 py-1 text-[0.6875rem] font-medium text-forest transition-colors hover:border-forest-soft/60 hover:bg-sand/60 disabled:opacity-50"
                    >
                      <Coffee aria-hidden className="size-3" />
                      Add free time
                    </button>
                  ) : null}
                </div>

                {onCommand && checkCommand && freeTimeDay === day.dayNumber ? (
                  <FreeTimeForm
                    dayNumber={day.dayNumber}
                    busy={editBusy}
                    check={(values) =>
                      checkCommand({
                        type: "insert-free-time",
                        dayNumber: day.dayNumber,
                        ...values,
                      })
                    }
                    onSave={(values) =>
                      runAndClose({
                        type: "insert-free-time",
                        dayNumber: day.dayNumber,
                        ...values,
                      })
                    }
                    onCancel={() => setFreeTimeDay(null)}
                  />
                ) : null}
              </div>

              <ol className="flex flex-col">
                {day.items.map((item, index) => {
                  /**
                   * Which gap sits immediately above this card.
                   *
                   * Gaps are counted in the day's list *with the dragged stop removed*, because that
                   * is the list `resolvePosition` resolves against — so every card below the one
                   * being carried is one gap earlier than its rendered index suggests. Getting this
                   * wrong would draw the indicator one place off, and only downwards.
                   *
                   * The dragged card gets no indicator above it: the gap there is the same gap as
                   * the one above the next card that stayed put, and drawing both would show two
                   * insertion points for one drop.
                   */
                  const draggedIndex =
                    reorder?.drag?.sourceDayNumber === day.dayNumber
                      ? day.items.findIndex(
                          (entry) => entry.id === reorder.drag?.itemId,
                        )
                      : -1;
                  const gapAbove =
                    draggedIndex !== -1 && draggedIndex < index
                      ? index - 1
                      : index;
                  const beingDragged = reorder?.drag?.itemId === item.id;

                  /*
                   * The action row lives **inside** the card.
                   *
                   * It could not before Phase 8: the card was a single `<button>`, and a button
                   * inside a button is invalid HTML that browsers resolve unpredictably, so these
                   * controls had to be siblings floating beneath the stop they act on. The card is
                   * an `<article>` with one explicit selection control now, so they belong to it.
                   *
                   * Left `undefined` when a stop offers nothing, so the card does not render a
                   * bordered, empty row. §18 of the brief: no empty rows for absent data.
                   */
                  const alternatives =
                    alternativesFor?.({
                      dayNumber: day.dayNumber,
                      itemId: item.id,
                    }) ?? [];

                  const openKind = open?.itemId === item.id ? open.kind : null;

                  const actions = stopActions({
                    item,
                    day,
                    busyItemId,
                    editBusy,
                    openKind,
                    alternativeCount: alternatives.length,
                    onToggle: (kind) =>
                      setOpen((current) =>
                        current?.itemId === item.id && current.kind === kind
                          ? null
                          : { itemId: item.id, kind },
                      ),
                    ...(canReplace && onReplaceItem ? { onReplaceItem } : {}),
                    ...(canMoveItems && onMoveItem ? { onMoveItem } : {}),
                    ...(onCommand ? { onCommand: runAndClose } : {}),
                    ...(reorder ? { reorder, reorderHelpId } : {}),
                  });

                  const editor = stopEditor({
                    item,
                    dayNumber: day.dayNumber,
                    openKind,
                    alternatives,
                    editBusy,
                    close: () => setOpen(null),
                    run: runAndClose,
                    ...(checkCommand ? { checkCommand } : {}),
                    ...(describeCommand ? { describeCommand } : {}),
                    ...(freeWindowFor ? { freeWindowFor } : {}),
                    ...(onCommand ? { onCommand } : {}),
                  });

                  return (
                    <li key={item.id} className="flex flex-col">
                      {beingDragged ? null : (
                        <InsertionIndicator
                          active={
                            reorder?.isTargetGap(day.dayNumber, gapAbove) ?? false
                          }
                          preview={reorder?.preview ?? null}
                        />
                      )}

                      <motion.div
                        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: reduceMotion ? 0 : 0.28,
                          delay: reduceMotion
                            ? 0
                            : Math.min(index * 0.04, 0.24),
                          ease: "easeOut",
                        }}
                      >
                        <ItineraryItemCard
                          item={item}
                          dayNumber={day.dayNumber}
                          displayNumber={numberOf.get(item.id) ?? index + 1}
                          currency={currency}
                          selected={item.id === selectedItemId}
                          hovered={item.id === hoveredItemId}
                          dragging={beingDragged}
                          {...(openingHoursByItemId?.get(item.id)
                            ? {
                                openingHours: openingHoursByItemId.get(item.id),
                              }
                            : {})}
                          onSelect={() => onSelectItem(item.id)}
                          onHoverChange={(hovered) =>
                            onHoverItem(hovered ? item.id : null)
                          }
                          {...(actions ? { actions } : {})}
                          {...(editor ? { editor } : {})}
                        />
                      </motion.div>

                      {item.travelToNext ? (
                        <TravelSegmentRow
                          segment={item.travelToNext}
                          {...(onRetryRoute ? { onRetry: onRetryRoute } : {})}
                          retrying={busyLegId === item.travelToNext.id}
                        />
                      ) : null}
                    </li>
                  );
                })}

                {/*
                  * The gap after the last stop.
                  *
                  * Its own list item because the others hang above a card and this one hangs below
                  * everything — and `aria-hidden`, like the rest, because the live region already
                  * says where the stop would land. A screen reader meeting "lands here, 17:40" as an
                  * extra entry in the day would be told twice and counted once too often.
                  */}
                {reorder?.drag ? (
                  <li aria-hidden className="flex flex-col">
                    <InsertionIndicator
                      active={reorder.isTargetGap(
                        day.dayNumber,
                        endGapIndex(day, reorder.drag.itemId),
                      )}
                      preview={reorder.preview}
                    />
                  </li>
                ) : null}
              </ol>
            </section>
          ))}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * The controls a single stop offers, or nothing.
 *
 * One place decides, so the card never has to. Each control is gated on the predicate that owns the
 * question, and every one of those predicates is the same function the applier enforces:
 *
 *  - `isMappableItem` for replacing — a stop with no place has nothing to swap
 *  - `itemIsMovable` for moving — `isEditLocked` inverted, covering both the structural lock on
 *    transport and the traveller's own pin
 *  - `itemIsRetimable` for the time editor
 *  - `itemIsRemovable` for removing — the lock, the last stop on a day, and meal coverage
 *  - `supportsTravellerLock` for the padlock — false on a block whose lock could never be released
 *  - a non-empty `alternativesForItem` for swapping
 *
 * Asking the applier's own predicate is what makes a control appear exactly when pressing it would
 * work. Two answers to "can this be removed" show up as a button that fails.
 *
 * Returning `undefined` rather than an empty array is what lets the card skip the bordered row.
 *
 * A handler absent means the capability is absent: the caller passes `onReplaceItem` only when the
 * trip has a saved pool to draw from, so there is no second `canReplace` test here to fall out of
 * step with it.
 */
function stopActions({
  item,
  day,
  busyItemId,
  editBusy,
  openKind,
  alternativeCount,
  onToggle,
  onReplaceItem,
  onMoveItem,
  onCommand,
  reorder,
  reorderHelpId,
}: {
  item: ItineraryItem;
  day: ItineraryDay;
  busyItemId: string | null;
  editBusy: boolean;
  openKind: EditorKind | null;
  alternativeCount: number;
  onToggle: (kind: EditorKind) => void;
  onReplaceItem?: (input: { dayNumber: number; itemId: string }) => void;
  onMoveItem?: (input: { dayNumber: number; itemId: string }) => void;
  onCommand?: (command: StructuralEditCommand) => void;
  reorder?: ItemReorder;
  reorderHelpId?: string;
}): ReactNode | undefined {
  const dayNumber = day.dayNumber;

  /** Any edit in flight disables every control, so two cannot race for one revision. */
  const busy = busyItemId !== null || editBusy;

  const controls: ReactNode[] = [];

  /*
   * The drag handle leads the row, pushed to its left edge.
   *
   * Gated on `itemIsMovable`, the same predicate the applier enforces and the same one the "Move to
   * another day" control uses — so locking a stop takes its handle away rather than letting a drag
   * begin and be refused on drop.
   *
   * A day of one stop has nowhere to reorder to, and a handle there would be a control whose every
   * outcome is "it stayed where it was".
   */
  if (reorder && reorderHelpId && itemIsMovable(item) && day.items.length > 1) {
    controls.push(
      <ReorderHandle
        key="reorder"
        item={item}
        dayNumber={dayNumber}
        reorder={reorder}
        helpId={reorderHelpId}
        disabled={busy}
      />,
    );
  }

  if (onReplaceItem && isMappableItem(item)) {
    controls.push(
      <StopActionButton
        key="replace"
        testId="replace-stop"
        itemId={item.id}
        disabled={busy}
        onClick={() => onReplaceItem({ dayNumber, itemId: item.id })}
        icon={
          busyItemId === item.id ? (
            <Loader2 aria-hidden className="size-3 animate-spin" />
          ) : (
            <Repeat aria-hidden className="size-3" />
          )
        }
        label="Replace this stop"
      />,
    );
  }

  /*
   * Moving is offered for any stop the dates do not pin down — including a placeless free-time
   * block, which is a perfectly reasonable thing to shuffle.
   */
  if (onMoveItem && itemIsMovable(item)) {
    controls.push(
      <StopActionButton
        key="move"
        testId="move-stop"
        itemId={item.id}
        disabled={busy}
        onClick={() => onMoveItem({ dayNumber, itemId: item.id })}
        icon={<CalendarArrowDown aria-hidden className="size-3" />}
        label="Move to another day"
      />,
    );
  }

  if (onCommand && itemIsRetimable(item)) {
    controls.push(
      <StopActionButton
        key="time"
        testId="edit-time"
        itemId={item.id}
        disabled={busy}
        expanded={openKind === "time"}
        onClick={() => onToggle("time")}
        icon={<Timer aria-hidden className="size-3" />}
        label="Change time"
      />,
    );
  }

  /*
   * Length is a separate trigger from time, because they are separate commands.
   *
   * Gated on the same `itemIsRetimable`, since both end up in `applySetItemSchedule` and both are
   * refused by the same lock. What differs is the question asked: two times, or a length and the
   * end that stays put.
   */
  if (onCommand && itemIsRetimable(item)) {
    controls.push(
      <StopActionButton
        key="duration"
        testId="edit-duration"
        itemId={item.id}
        disabled={busy}
        expanded={openKind === "duration"}
        onClick={() => onToggle("duration")}
        icon={<Hourglass aria-hidden className="size-3" />}
        label="Change length"
      />,
    );
  }

  /*
   * Offered only when there is something to offer.
   *
   * A "Swap" control on a stop whose category has no unused places left would open an empty list,
   * which is a worse answer than not being there — the place pool panel is where a traveller learns
   * the pool is exhausted.
   */
  if (onCommand && alternativeCount > 0) {
    controls.push(
      <StopActionButton
        key="alternatives"
        testId="swap-stop"
        itemId={item.id}
        disabled={busy}
        expanded={openKind === "alternatives"}
        onClick={() => onToggle("alternatives")}
        icon={<Shuffle aria-hidden className="size-3" />}
        label={`Swap (${alternativeCount})`}
      />,
    );
  }

  /*
   * Two commands rather than one toggle carrying a boolean.
   *
   * The request states the intended outcome, so a stale interface cannot flip a lock it believed was
   * off — locking something already locked is a refusal rather than a silent no-op reading as
   * success. Which of the two to send is read from the item this render drew.
   */
  if (onCommand && supportsTravellerLock(item)) {
    const locked = isTravellerLocked(item);
    controls.push(
      <StopActionButton
        key="lock"
        testId={locked ? "unlock-stop" : "lock-stop"}
        itemId={item.id}
        disabled={busy}
        onClick={() =>
          onCommand({
            type: locked ? "unlock-item" : "lock-item",
            dayNumber,
            itemId: item.id,
          })
        }
        icon={
          locked ? (
            <Lock aria-hidden className="size-3" />
          ) : (
            <LockOpen aria-hidden className="size-3" />
          )
        }
        label={locked ? "Unlock stop" : "Lock stop"}
      />,
    );
  }

  /*
   * No confirmation step, deliberately.
   *
   * `applyRefinement` captures the one-level undo snapshot in the same write, and the refusals that
   * matter — locked, would empty the day, would lose the day's only meal — block the genuinely
   * destructive cases before anything happens. `needsConfirmation` reserves prompts for regeneration
   * and the pool refresh, which are the two edits undo cannot cheaply reverse.
   */
  if (onCommand && itemIsRemovable(day, item)) {
    controls.push(
      <StopActionButton
        key="remove"
        testId="remove-stop"
        itemId={item.id}
        disabled={busy}
        onClick={() =>
          onCommand({ type: "remove-item", dayNumber, itemId: item.id })
        }
        icon={<Trash2 aria-hidden className="size-3" />}
        label="Remove stop"
      />,
    );
  }

  return controls.length > 0 ? controls : undefined;
}

/**
 * The editor a stop has open, or nothing.
 *
 * Separate from `stopActions` because the two answer different questions — which triggers exist,
 * versus which panel is showing — and folding them together would let the action row and the editor
 * disagree about what is open.
 */
function stopEditor({
  item,
  dayNumber,
  openKind,
  alternatives,
  editBusy,
  close,
  run,
  checkCommand,
  describeCommand,
  freeWindowFor,
  onCommand,
}: {
  item: ItineraryItem;
  dayNumber: number;
  openKind: EditorKind | null;
  alternatives: TripPlace[];
  editBusy: boolean;
  close: () => void;
  run: (command: StructuralEditCommand) => void;
  checkCommand?: (command: StructuralEditCommand) => string | null;
  describeCommand?: (
    command: StructuralEditCommand,
    itemId: string,
  ) => EditedItemPreview;
  freeWindowFor?: (input: { dayNumber: number; itemId: string }) => {
    earliest: string;
    latest: string;
  } | null;
  onCommand?: (command: StructuralEditCommand) => void;
}): ReactNode | undefined {
  if (!onCommand || openKind === null) return undefined;

  if (openKind === "duration") {
    /*
     * The editor states the resulting times, so without `describeCommand` there is nothing to open
     * — the trigger is gated on the same pair, exactly as the time editor is on `checkCommand`.
     */
    if (!describeCommand) return undefined;

    return (
      <StopDurationEditor
        item={item}
        window={freeWindowFor?.({ dayNumber, itemId: item.id }) ?? null}
        busy={editBusy}
        describe={(values) =>
          describeCommand(
            {
              type: "set-item-duration",
              dayNumber,
              itemId: item.id,
              ...values,
            },
            item.id,
          )
        }
        onSave={(values) =>
          run({
            type: "set-item-duration",
            dayNumber,
            itemId: item.id,
            ...values,
          })
        }
        onCancel={close}
      />
    );
  }

  if (openKind === "time") {
    /*
     * The editor's whole premise is showing the refusal before the save, so without `checkCommand`
     * there is nothing to open — the trigger is gated on the same pair.
     */
    if (!checkCommand) return undefined;

    return (
      <StopTimeEditor
        item={item}
        window={freeWindowFor?.({ dayNumber, itemId: item.id }) ?? null}
        busy={editBusy}
        check={(times) =>
          checkCommand({
            type: "set-item-time",
            dayNumber,
            itemId: item.id,
            ...times,
          })
        }
        onSave={(times) =>
          run({ type: "set-item-time", dayNumber, itemId: item.id, ...times })
        }
        onCancel={close}
      />
    );
  }

  if (alternatives.length === 0) return undefined;

  return (
    <StopAlternatives
      item={item}
      places={alternatives}
      busy={editBusy}
      onSelect={(alternativePlaceId) =>
        run({
          type: "select-alternative",
          dayNumber,
          itemId: item.id,
          alternativePlaceId,
        })
      }
      onCancel={close}
    />
  );
}

/**
 * One control in a stop's action row.
 *
 * A shared component rather than a repeated class string: these have to stay visually
 * indistinguishable from one another, and Phase 8 added four more of them.
 */
function StopActionButton({
  testId,
  itemId,
  disabled,
  expanded,
  onClick,
  icon,
  label,
}: {
  testId: string;
  itemId: string;
  disabled: boolean;
  /** Set only on the controls that toggle an editor, so the rest carry no misleading state. */
  expanded?: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      data-item-id={itemId}
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      className="inline-flex items-center gap-1 rounded-full border border-line bg-cream-raised px-2.5 py-1 text-[0.6875rem] font-medium text-forest transition-colors hover:border-forest-soft/60 hover:bg-sand/60 disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The gap after a day's last stop, counted the way the drag counts gaps.
 *
 * One fewer than the day's length when the stop being dragged is on this day, because the gaps are
 * counted with it taken out. The same subtraction the indicator above each card makes, written once
 * so the last gap and the others cannot disagree about which day they are numbering.
 */
function endGapIndex(day: ItineraryDay, draggedItemId: string): number {
  return day.items.some((item) => item.id === draggedItemId)
    ? day.items.length - 1
    : day.items.length;
}

/**
 * The grip that starts a reorder.
 *
 * ## One control, two input methods
 *
 * `onPointerDown` begins a drag; Space and Enter begin the same drag from the keyboard, and the
 * arrows move it. Both drive the identical state machine in `useItemReorder` and both end in one
 * `move-item` — the keyboard path is not a reduced version of the pointer one.
 *
 * ## How "picked up" is announced, and why not with `aria-pressed`
 *
 * Through the accessible **name**, which changes to say the stop is moving and how to drop it, plus
 * the panel's live region. Not through `aria-pressed`, for two reasons that point the same way.
 *
 * The first is local: the card already has exactly one control carrying a pressed state — the
 * selection overlay — and that is what "this stop is selected" means here. A second pressed control
 * inside the same region would give one card two toggle states and leave a screen-reader user to
 * work out which of them is the selection. The map marker reads that same state, so the ambiguity
 * would not stay inside the card either.
 *
 * The second is general: `aria-grabbed` was the attribute for this and is deprecated with no
 * replacement, so a descriptive name and a live region are what a drag has to announce itself with
 * regardless.
 *
 * `touch-none` is load bearing: without `touch-action: none` the browser claims a vertical drag for
 * scrolling before the first `pointermove` ever arrives, and the handle simply would not work on a
 * phone.
 */
function ReorderHandle({
  item,
  dayNumber,
  reorder,
  helpId,
  disabled,
}: {
  item: ItineraryItem;
  dayNumber: number;
  reorder: ItemReorder;
  helpId: string;
  disabled: boolean;
}) {
  const grabbed = reorder.drag?.itemId === item.id;

  return (
    <button
      type="button"
      data-testid="reorder-handle"
      data-item-id={item.id}
      data-grabbed={grabbed ? "true" : "false"}
      disabled={disabled}
      aria-describedby={helpId}
      aria-label={
        grabbed
          ? `Moving ${item.title}. Arrow keys to reposition, Enter to drop, Escape to cancel.`
          : `Reorder ${item.title}`
      }
      onPointerDown={(event) =>
        reorder.startPointer(
          { itemId: item.id, itemTitle: item.title, dayNumber },
          event,
        )
      }
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          if (grabbed) reorder.commit();
          else
            reorder.startKeyboard({
              itemId: item.id,
              itemTitle: item.title,
              dayNumber,
            });
          return;
        }

        if (!grabbed) return;

        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          reorder.nudge(event.key === "ArrowDown" ? 1 : -1);
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          reorder.cancel();
        }
      }}
      className={cn(
        "mr-auto inline-flex touch-none items-center gap-1 rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors disabled:opacity-50",
        grabbed
          ? "cursor-grabbing border-forest bg-forest text-primary-foreground"
          : "cursor-grab border-line bg-cream-raised text-forest hover:border-forest-soft/60 hover:bg-sand/60",
      )}
    >
      <GripVertical aria-hidden className="size-3" />
      {grabbed ? "Moving" : "Reorder"}
    </button>
  );
}

/**
 * The line showing where a dragged stop would land, and when.
 *
 * Always rendered, and merely invisible when it is not the target — so the list's height does not
 * change as the indicator moves between gaps. A conditionally-mounted indicator would nudge every
 * card below it down by its own height at the moment it appeared, invalidating the measurements the
 * drag took at the start and making the gap under the pointer shift as a consequence of the pointer
 * arriving there.
 *
 * `aria-hidden` because the live region already announces all of this, in fuller words.
 */
function InsertionIndicator({
  active,
  preview,
}: {
  active: boolean;
  preview: EditedItemPreview | null;
}) {
  return (
    <div
      aria-hidden
      data-testid="drop-indicator"
      data-active={active ? "true" : "false"}
      className={cn(
        "flex h-6 items-center gap-2 overflow-hidden transition-opacity",
        active ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <span
        className={cn(
          "h-0.5 flex-1 rounded-full",
          preview?.status === "refused" ? "bg-terracotta" : "bg-forest",
        )}
      />
      {active && preview ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
            preview.status === "ready"
              ? "bg-forest text-primary-foreground"
              : "bg-terracotta text-accent-foreground",
          )}
        >
          {preview.status === "ready"
            ? formatTimeRange(preview.startTime, preview.endTime)
            : "Will not fit"}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A day's travel time, with the completeness that makes it readable.
 *
 * `totalTravelMinutes` is routed plus retained estimates; an unavailable leg
 * contributes zero. Shown alone that is an under-count presented as a fact — a
 * day with two unroutable hops would read as a day with less walking in it. The
 * suffix is what keeps the number honest, and it is derived from the day's own
 * segments so it cannot disagree with them.
 */
function DayTravelChip({ day }: { day: ItineraryDay }) {
  const travel = deriveDayTravelSummary(day);

  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid="day-travel"
      data-routed-legs={travel.routedLegs}
      data-unavailable-legs={travel.unavailableLegs}
    >
      <Footprints aria-hidden className="size-3.5" />
      {formatDuration(travel.knownDurationMinutes)} travelling
      {travel.unavailableLegs > 0 ? (
        <span className="text-terracotta">
          · {travel.unavailableLegs} route
          {travel.unavailableLegs === 1 ? "" : "s"} unavailable
        </span>
      ) : null}
      {travel.routedLegs > 0 && travel.estimatedLegs > 0 ? (
        <span className="text-ink-muted">· part estimated</span>
      ) : null}
    </span>
  );
}
