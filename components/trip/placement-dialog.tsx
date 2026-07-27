"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { OpeningHoursBadge } from "@/components/trip/opening-hours-badge";
import { evaluateItem } from "@/lib/plan/schedule-report";
import type { TargetPosition } from "@/lib/refinement/commands";
import type { ItineraryDay, ItineraryItem } from "@/lib/schemas";
import {
  defaultDurationMinutes,
  resolveInsertionTimes,
  resolvePosition,
  removeById,
} from "@/lib/structural-edits";

/**
 * Choosing a day, a position and optionally a time — for both structural edits.
 *
 * ## One dialog, two callers
 *
 * Promoting a backup and moving a stop ask the traveller exactly the same three questions, and
 * the preview they need is identical: where it lands, when, whether the place is open then, and
 * what it does to the day. Two dialogs would drift apart, and the one that drifted would be the
 * one used less.
 *
 * ## The preview is computed by the real code
 *
 * The time shown comes from `resolveInsertionTimes` and the badge from `evaluateItem` — the same
 * functions the edit itself will call. A preview computed a second way would eventually differ
 * from the outcome, and a preview that can lie is worse than none.
 *
 * ## No drag and drop
 *
 * The day and the position are explicit controls: a `<select>` and a list of radio buttons.
 * Drag-and-drop is the obvious interaction and is not implemented, deliberately — it is
 * keyboard-hostile, it needs a touch story of its own, and every affordance here has to work
 * without a pointer.
 */

export type PlacementRequest = {
  /** What is being placed, for the heading. */
  label: string;
  /** Which day it starts on, and whether it may stay there. */
  sourceDayNumber: number;
  /** The item being moved, for its duration and its hours. Absent for a promotion. */
  item?: ItineraryItem;
  /** The kind, for a promotion's default duration. */
  kind: ItineraryItem["kind"];
  /** The place's own `opening_hours`, for the preview badge. */
  openingHours?: string;
  placeName?: string;
};

export function PlacementDialog({
  request,
  days,
  timezone,
  busy,
  errorMessage,
  onCancel,
  onConfirm,
}: {
  request: PlacementRequest;
  days: ItineraryDay[];
  timezone: string | null;
  busy: boolean;
  /** From the last attempt, when it failed. Rendered in the dialog, not as a toast. */
  errorMessage: string | null;
  onCancel: () => void;
  onConfirm: (input: {
    targetDayNumber: number;
    targetPosition: TargetPosition;
    startTime?: string;
    endTime?: string;
  }) => void;
}) {
  const titleId = useId();
  const [targetDayNumber, setTargetDayNumber] = useState(request.sourceDayNumber);
  const [positionKey, setPositionKey] = useState("end");
  const [useExplicitTimes, setUseExplicitTimes] = useState(false);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Escape closes, and Tab cannot leave.
   *
   * `aria-modal` tells a screen reader to hide the background, so screen-reader users were already
   * contained. A sighted keyboard user was not: Tab past the last button walked into the page behind a
   * blurred backdrop, with the focus ring somewhere invisible. Both handlers live in one listener so
   * they cannot get out of step.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
        // A disabled confirm button is common here — the preview refuses impossible placements — so
        // the list is recomputed on every Tab rather than cached.
      ].filter((node) => node.offsetParent !== null || node === document.activeElement);

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  /**
   * The element that opened the dialog, captured during the **first render**.
   *
   * It cannot be captured in an effect. React runs a component's mount effects in declaration order,
   * so by the time any effect below runs, the "focus into the dialog" effect has already moved focus to
   * the close button — and the captured "opener" would be the dialog's own X. Restoring focus to a
   * button that is mid-unmount drops it to `<body>`, which is precisely the regression this is here to
   * prevent.
   *
   * Reading `document.activeElement` during render is a side-effect-free DOM read of a value that is
   * already settled, and a ref initialiser runs exactly once.
   */
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );

  // Focus lands inside the dialog on open, so a keyboard user is not left behind.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  /** Focus goes back where it came from, so a keyboard user does not restart from the top. */
  useEffect(
    () => () => {
      const opener = openerRef.current;
      if (opener && document.body.contains(opener)) opener.focus();
    },
    [],
  );

  const targetDay = days.find((day) => day.dayNumber === targetDayNumber);

  /**
   * The positions on offer.
   *
   * The moved item is excluded from its own day's list, because "before itself" is not a
   * position — resolving it would be off by one and "after itself" would be a no-op.
   */
  const positionOptions = useMemo(() => {
    const items = targetDay
      ? request.item && targetDay.dayNumber === request.sourceDayNumber
        ? removeById(targetDay.items, request.item.id)
        : targetDay.items
      : [];

    return [
      ...items.map((item) => ({
        key: `before:${item.id}`,
        label: `Before ${item.title} (${item.startTime})`,
        position: { kind: "before" as const, itemId: item.id },
      })),
      { key: "end", label: "At the end of the day", position: { kind: "end" as const } },
    ];
  }, [targetDay, request.item, request.sourceDayNumber]);

  const selected =
    positionOptions.find((option) => option.key === positionKey) ??
    positionOptions[positionOptions.length - 1];

  /* -- the preview, from the real code ------------------------------------- */

  const preview = useMemo(() => {
    if (!targetDay || !selected) return null;

    const items =
      request.item && targetDay.dayNumber === request.sourceDayNumber
        ? removeById(targetDay.items, request.item.id)
        : targetDay.items;

    const position = resolvePosition(items, selected.position);
    if (!position.ok) return { error: position.error.message };

    const duration = request.item
      ? Math.max(
          15,
          minutes(request.item.endTime) - minutes(request.item.startTime),
        )
      : defaultDurationMinutes(request.kind);

    const times = resolveInsertionTimes({
      position: position.value,
      durationMinutes: duration,
      ...(useExplicitTimes && startTime && endTime
        ? { requested: { startTime, endTime } }
        : {}),
    });

    if (!times.ok) return { error: times.error.message };

    /**
     * The hours badge is evaluated against the **target** date.
     *
     * That is the whole reason the preview exists for a cross-day move: a stop that is fine on
     * Tuesday can be shut on Sunday, and the traveller should see that before they commit
     * rather than as a warning afterwards.
     */
    const evaluation = evaluateItem(
      {
        ...(request.item ?? PLACEHOLDER_ITEM),
        status: "confirmed",
        place: request.openingHours
          ? ({
              ...(request.item?.place ?? PLACEHOLDER_PLACE),
              openingHours: request.openingHours,
            } as ItineraryItem["place"])
          : (request.item?.place ?? PLACEHOLDER_PLACE),
        startTime: times.value.startTime,
        endTime: times.value.endTime,
      },
      targetDay.date,
      timezone ?? undefined,
    );

    return { times: times.value, evaluation };
  }, [
    targetDay,
    selected,
    request,
    useExplicitTimes,
    startTime,
    endTime,
    timezone,
  ]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="placement-dialog"
      ref={panelRef}
      className="fixed inset-0 z-50 flex items-end justify-center bg-forest/30 p-0 backdrop-blur-sm sm:items-center sm:p-6"
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl border border-line bg-cream-raised p-5 shadow-raised sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="font-display text-lg text-forest">
            {request.label}
          </h2>
          <button
            type="button"
            ref={closeRef}
            onClick={onCancel}
            aria-label="Close without changing anything"
            className="rounded-full p-1 text-ink-muted transition-colors hover:text-forest"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        {/* -- day ---------------------------------------------------------- */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Day</span>
          <select
            data-testid="placement-day"
            value={targetDayNumber}
            onChange={(event) => {
              setTargetDayNumber(Number(event.target.value));
              setPositionKey("end");
            }}
            className="rounded-xl border border-line bg-cream px-3 py-2 text-sm text-ink"
          >
            {days.map((day) => (
              <option key={day.dayNumber} value={day.dayNumber}>
                Day {day.dayNumber} — {day.date} · {day.theme}
              </option>
            ))}
          </select>
        </label>

        {/* -- position ----------------------------------------------------- */}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">Position</legend>
          <div
            data-testid="placement-positions"
            className="flex flex-col gap-1 rounded-xl border border-line bg-cream p-2"
          >
            {positionOptions.map((option) => (
              <label
                key={option.key}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-sand/60"
              >
                <input
                  type="radio"
                  name="placement-position"
                  value={option.key}
                  checked={selected?.key === option.key}
                  onChange={() => setPositionKey(option.key)}
                  data-position-key={option.key}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* -- times -------------------------------------------------------- */}
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              data-testid="placement-explicit-times"
              checked={useExplicitTimes}
              onChange={(event) => setUseExplicitTimes(event.target.checked)}
            />
            <span>Set the times myself</span>
          </label>

          {useExplicitTimes ? (
            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-ink-muted">Start</span>
                <input
                  type="time"
                  data-testid="placement-start"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                  className="rounded-xl border border-line bg-cream px-3 py-2 text-sm text-ink"
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-xs text-ink-muted">End</span>
                <input
                  type="time"
                  data-testid="placement-end"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                  className="rounded-xl border border-line bg-cream px-3 py-2 text-sm text-ink"
                />
              </label>
            </div>
          ) : (
            <p className="text-xs text-ink-muted">
              A free slot at that position will be chosen for you. If there is no room,
              nothing is changed and you can set the times instead.
            </p>
          )}
        </div>

        {/* -- preview ------------------------------------------------------ */}
        <div
          data-testid="placement-preview"
          className="flex flex-col gap-1.5 rounded-xl bg-sand/60 p-3 text-xs"
        >
          {preview && "error" in preview ? (
            <p
              data-testid="placement-preview-problem"
              className="flex items-start gap-1.5 text-ink"
            >
              <CircleAlert
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-terracotta"
              />
              <span>{preview.error}</span>
            </p>
          ) : preview ? (
            <>
              <p className="text-ink">
                <span className="font-medium">
                  Day {targetDayNumber} · {preview.times.startTime}–
                  {preview.times.endTime}
                </span>
                {targetDay ? <span className="text-ink-muted"> on {targetDay.date}</span> : null}
              </p>
              <div>
                <OpeningHoursBadge evaluation={preview.evaluation} />
              </div>
              {targetDayNumber !== request.sourceDayNumber ? (
                <p className="text-ink-muted">
                  Travel times either side of both days will be cleared and can be
                  recalculated afterwards.
                </p>
              ) : (
                <p className="text-ink-muted">
                  Travel times around this stop will be cleared and can be recalculated
                  afterwards.
                </p>
              )}
            </>
          ) : null}
        </div>

        {errorMessage ? (
          <p
            role="alert"
            data-testid="placement-error"
            className="rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-relaxed text-ink"
          >
            {errorMessage}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            data-testid="placement-confirm"
            disabled={busy || !selected || (preview !== null && "error" in preview)}
            onClick={() =>
              selected &&
              onConfirm({
                targetDayNumber,
                targetPosition: selected.position,
                ...(useExplicitTimes && startTime && endTime
                  ? { startTime, endTime }
                  : {}),
              })
            }
          >
            {request.item ? "Move this stop" : "Add to itinerary"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * A stand-in used only to evaluate a *promotion's* hours preview.
 *
 * `evaluateItem` needs an item shape; a promotion does not have one yet. Nothing from this
 * placeholder reaches the plan — the real item is built by `applyPromoteBackup` from the pool's
 * canonical record.
 */
const PLACEHOLDER_PLACE = {
  placeId: "preview",
  name: "preview",
  category: "attraction" as const,
  coordinates: { lat: 0, lng: 0 },
  source: {
    provider: "mock" as const,
    canonicalId: "preview",
    attribution: "preview",
  },
};

const PLACEHOLDER_ITEM: ItineraryItem = {
  locked: false,
  id: "preview",
  order: 0,
  kind: "attraction",
  mealType: null,
  title: "preview",
  rationale: "preview",
  status: "confirmed",
  place: PLACEHOLDER_PLACE,
  startTime: "09:00",
  endTime: "10:00",
  estimatedCost: 0,
  costNote: null,
  bookingRequired: false,
  tip: null,
  travelToNext: null,
};

function minutes(time: string): number {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}
