"use client";

import { useId, useState } from "react";

import { formatTimeRange } from "@/lib/format";
import { MAX_ITEM_DURATION_MINUTES } from "@/lib/refinement/commands";
import type { ItineraryItem } from "@/lib/schemas";
import { SCHEDULE_LIMITS, durationOf } from "@/lib/structural-edits";
import type { EditedItemPreview } from "@/lib/structural-edits/preview-item";

/**
 * Changing how long a stop lasts, inside the card it belongs to.
 *
 * ## Why this is not the time editor with a third field
 *
 * `set-item-time` and `set-item-duration` answer different questions. "Move the museum to three"
 * states both ends; "give me another half hour there" states a length and leaves one end alone —
 * and *which* end is the whole content of the second request. One form with start, end and length
 * would have to infer the anchor from whichever field was touched last, which is guessing at intent
 * the interface can simply ask about, and it would let somebody enter three numbers that contradict
 * each other.
 *
 * So the length gets its own control and the anchor is asked outright. A radio group, because the
 * two answers are exclusive and both are ordinary: extending a visit forwards and arriving earlier
 * for it are equally common things to want.
 *
 * ## The resulting times are the applier's, not this form's
 *
 * `describe` runs the real edit and stops short of writing, so the times shown under the anchor
 * choice are the times a save would store — including the day-bound clamp and the neighbour check.
 * Computing `start + minutes` here would agree with the applier right up until one of those rules
 * moved, and the disagreement would read as a form promising a time the Save button then refuses.
 *
 * It is also why there is no separate validity check: a refusal and a set of resulting times are
 * two arms of one answer, so they cannot come apart.
 *
 * ## Minutes, not a duration picker
 *
 * A number field stepping by five, matching the grid `resolveInsertionTimes` snaps derived slots to.
 * The bounds are the command's own — `SCHEDULE_LIMITS.minItemMinutes`, below which a stop is not a
 * visit, and `MAX_ITEM_DURATION_MINUTES` above. Given to the browser as `min`/`max` so its spinner
 * behaves, and enforced by the schema regardless, because an attribute is only a suggestion.
 */
export function StopDurationEditor({
  item,
  window: freeWindow,
  busy,
  describe,
  onSave,
  onCancel,
}: {
  item: ItineraryItem;
  /** The gap this stop could occupy, from `freeWindowForItem`. Null when it could not be located. */
  window: { earliest: string; latest: string } | null;
  busy: boolean;
  /** What the edit would do, from the hook's `preview` — the real applier, held back. */
  describe: (input: {
    durationMinutes: number;
    anchor: "start" | "end";
  }) => EditedItemPreview;
  onSave: (input: { durationMinutes: number; anchor: "start" | "end" }) => void;
  onCancel: () => void;
}) {
  const current = durationOf(item);

  const [minutes, setMinutes] = useState(String(current));
  const [anchor, setAnchor] = useState<"start" | "end">("start");

  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const outcomeId = `${fieldId}-outcome`;

  const durationMinutes = Number(minutes);

  /**
   * Asked only once the number is a plausible one that differs from what is stored.
   *
   * A field emptied mid-typing is not a request, and an untouched editor announcing "this changes
   * nothing" would be scolding somebody for opening it. `no_change` is a real refusal and the right
   * answer on Save — just not before anything has been typed.
   */
  const usable =
    minutes !== "" &&
    Number.isInteger(durationMinutes) &&
    durationMinutes >= SCHEDULE_LIMITS.minItemMinutes &&
    durationMinutes <= MAX_ITEM_DURATION_MINUTES &&
    durationMinutes !== current;

  const outcome = usable ? describe({ durationMinutes, anchor }) : null;
  const refusal =
    outcome?.status === "refused"
      ? outcome.message
      : outcome?.status === "unknown"
        ? "That length cannot be applied to this stop."
        : null;
  const canSave = usable && outcome?.status === "ready" && !busy;

  return (
    <form
      data-testid="duration-editor"
      data-item-id={item.id}
      aria-label={`Change how long “${item.title}” lasts`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave({ durationMinutes, anchor });
      }}
      className="flex flex-col gap-2.5"
    >
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${fieldId}-minutes`}
          className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted"
        >
          Length
        </label>
        <span className="flex items-center gap-1.5">
          <input
            id={`${fieldId}-minutes`}
            type="number"
            inputMode="numeric"
            required
            min={SCHEDULE_LIMITS.minItemMinutes}
            max={MAX_ITEM_DURATION_MINUTES}
            step={5}
            value={minutes}
            disabled={busy}
            data-testid="duration-editor-minutes"
            {...(freeWindow ? { "aria-describedby": hintId } : {})}
            onChange={(event) => setMinutes(event.target.value)}
            className="w-20 rounded-lg border border-line bg-cream-raised px-2 py-1 font-mono text-xs tabular-nums text-ink focus-visible:border-forest-soft disabled:opacity-50"
          />
          <span className="text-xs text-ink-muted">minutes</span>
        </span>
      </div>

      {/*
        * The anchor, as a real radio group.
        *
        * A `<fieldset>` with a `<legend>` so the pair is announced as one question with a name.
        * Two bare labels would reach a screen reader as two unrelated controls, and which of the two
        * is being chosen is the entire content of this command.
        */}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted">
          Which end stays put
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {(
            [
              { value: "start", label: `Keep the start · ${item.startTime}` },
              { value: "end", label: `Keep the end · ${item.endTime}` },
            ] as const
          ).map((option) => (
            <label
              key={option.value}
              className="inline-flex items-center gap-1.5 text-xs text-ink"
            >
              <input
                type="radio"
                name={`${fieldId}-anchor`}
                value={option.value}
                checked={anchor === option.value}
                disabled={busy}
                data-testid={`duration-editor-anchor-${option.value}`}
                onChange={() => setAnchor(option.value)}
                className="size-3.5 accent-forest disabled:opacity-50"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {/*
        * What the save would store.
        *
        * A polite live region rather than plain text: it changes as the number and the anchor
        * change, and somebody who cannot see it re-render would otherwise have to tab away and back
        * to discover that 90 minutes anchored to the end means an 08:00 start.
        */}
      {outcome?.status === "ready" ? (
        <p
          id={outcomeId}
          aria-live="polite"
          data-testid="duration-editor-outcome"
          className="text-[0.6875rem] text-ink-muted"
        >
          Would become{" "}
          <span className="font-mono tabular-nums text-ink">
            {formatTimeRange(outcome.startTime, outcome.endTime)}
          </span>
        </p>
      ) : null}

      {freeWindow ? (
        <p id={hintId} className="text-[0.6875rem] text-ink-muted">
          Free here:{" "}
          <span className="font-mono tabular-nums text-ink">
            {formatTimeRange(freeWindow.earliest, freeWindow.latest)}
          </span>
        </p>
      ) : null}

      {/*
        * `role="alert"` for the same reason the time editor has one: this appears in response to the
        * traveller's own typing, and it is why Save is unavailable.
        */}
      {refusal ? (
        <p
          id={errorId}
          role="alert"
          data-testid="duration-editor-error"
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
          data-testid="duration-editor-cancel"
          className="rounded-full border border-line bg-cream-raised px-2.5 py-1 text-[0.6875rem] font-medium text-ink-muted transition-colors hover:text-forest disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          data-testid="duration-editor-save"
          {...(refusal
            ? { "aria-describedby": errorId }
            : outcome?.status === "ready"
              ? { "aria-describedby": outcomeId }
              : {})}
          className="rounded-full border border-forest bg-forest px-2.5 py-1 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-forest/90 disabled:opacity-50"
        >
          Save length
        </button>
      </div>
    </form>
  );
}
