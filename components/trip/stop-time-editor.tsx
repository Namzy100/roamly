"use client";

import { useId, useState } from "react";

import { formatTimeRange } from "@/lib/format";
import type { ItineraryItem } from "@/lib/schemas";

/**
 * Editing one stop's clock, inside the card it belongs to.
 *
 * ## Why inline rather than a dialog
 *
 * Changing a time is a two-field edit whose whole meaning is *relative to its neighbours* — the stop
 * before it, the stop after it, the gap between them. A modal covers exactly the context the
 * traveller needs to make the decision. So the editor opens in place, the day stays on screen, and
 * the free window is stated above the buttons rather than inferred from what the card used to say.
 *
 * ## The refusal arrives before the save, not after
 *
 * `check` is the hook's `preview` — the real applier, stopped one step short of writing. So typing
 * 09:00 into a stop whose window starts at 10:30 shows the applier's own sentence immediately, and
 * the Save control is disabled while it does. Nothing is written to find that out.
 *
 * That is only trustworthy because it is the *same* function the save runs. A second validator here
 * that approximated the rules would eventually disagree with the one that decides, and the
 * disagreement would surface as a form that refuses a valid time or accepts an invalid one.
 *
 * ## Two times, never a duration
 *
 * A traveller dragging a card's bottom edge has expressed an anchor; one typing two times has
 * expressed both ends, so this issues `set-item-time` and never `set-item-duration`. The anchor
 * exists for the drag that comes next, and inventing one here — "they changed the end, so anchor the
 * start" — would be guessing at intent the interface does not have.
 */
export function StopTimeEditor({
  item,
  window: freeWindow,
  busy,
  check,
  onSave,
  onCancel,
}: {
  item: ItineraryItem;
  /**
   * The gap this stop could occupy, from `freeWindowForItem`.
   *
   * Null when the day or the stop could not be located, in which case the hint is omitted rather
   * than guessed — the check still refuses anything that does not fit.
   */
  window: { earliest: string; latest: string } | null;
  busy: boolean;
  /** The refusal this pair of times would produce, or null when it would be accepted. */
  check: (times: { startTime: string; endTime: string }) => string | null;
  onSave: (times: { startTime: string; endTime: string }) => void;
  onCancel: () => void;
}) {
  const [startTime, setStartTime] = useState(item.startTime);
  const [endTime, setEndTime] = useState(item.endTime);

  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  /**
   * Only asked once the times differ from the ones already saved.
   *
   * An untouched editor showing "this changes nothing" would be scolding somebody for opening it.
   * `no_change` is a real refusal from the applier, and it is the right answer on Save — just not
   * before the traveller has typed anything.
   */
  const touched = startTime !== item.startTime || endTime !== item.endTime;
  const refusal = touched ? check({ startTime, endTime }) : null;
  const canSave = touched && refusal === null && !busy;

  return (
    <form
      data-testid="time-editor"
      data-item-id={item.id}
      aria-label={`Change the time of “${item.title}”`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({ startTime, endTime });
      }}
      className="flex flex-col gap-2.5"
    >
      <div className="flex flex-wrap items-end gap-3">
        <TimeField
          id={`${fieldId}-start`}
          label="Start"
          value={startTime}
          disabled={busy}
          describedBy={freeWindow ? hintId : undefined}
          onChange={setStartTime}
          testId="time-editor-start"
        />
        <TimeField
          id={`${fieldId}-end`}
          label="End"
          value={endTime}
          disabled={busy}
          describedBy={freeWindow ? hintId : undefined}
          onChange={setEndTime}
          testId="time-editor-end"
        />
      </div>

      {/*
       * The window, stated before it is needed.
       *
       * Read from the same `positionOfExistingItem` the applier validates against, so the gap named
       * here is the gap enforced on save.
       */}
      {freeWindow ? (
        <p id={hintId} className="text-[0.6875rem] text-ink-muted">
          Free here:{" "}
          <span className="font-mono tabular-nums text-ink">
            {formatTimeRange(freeWindow.earliest, freeWindow.latest)}
          </span>
        </p>
      ) : null}

      {/*
       * `role="alert"` rather than a polite live region: this appears in response to the traveller's
       * own typing and it is the reason Save is unavailable, so it warrants an interruption.
       */}
      {refusal ? (
        <p
          id={errorId}
          role="alert"
          data-testid="time-editor-error"
          className="text-[0.6875rem] leading-relaxed text-terracotta"
        >
          {refusal}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid="time-editor-cancel"
          className="rounded-full border border-line bg-cream-raised px-2.5 py-1 text-[0.6875rem] font-medium text-ink-muted transition-colors hover:text-forest disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          data-testid="time-editor-save"
          {...(refusal ? { "aria-describedby": errorId } : {})}
          className="rounded-full border border-forest bg-forest px-2.5 py-1 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-forest/90 disabled:opacity-50"
        >
          Save time
        </button>
      </div>
    </form>
  );
}

/**
 * One `HH:MM` field.
 *
 * `type="time"` because the platform control is better than anything hand-rolled: locale-aware,
 * keyboard-navigable, and on touch it opens the picker the traveller already knows. Its value is
 * always `HH:MM` 24-hour, which is exactly what `TimeOfDaySchema` accepts, so nothing parses between
 * the field and the command.
 */
function TimeField({
  id,
  label,
  value,
  disabled,
  describedBy,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  describedBy: string | undefined;
  onChange: (value: string) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted"
      >
        {label}
      </label>
      <input
        id={id}
        type="time"
        required
        value={value}
        disabled={disabled}
        data-testid={testId}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-line bg-cream-raised px-2 py-1 font-mono text-xs tabular-nums text-ink focus-visible:border-forest-soft disabled:opacity-50"
      />
    </div>
  );
}
