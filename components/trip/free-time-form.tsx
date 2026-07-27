"use client";

import { useId, useState } from "react";

import { MAX_FREE_TIME_TITLE } from "@/lib/refinement/commands";

/**
 * Adding deliberate downtime to a day.
 *
 * ## Why this lives in the day header
 *
 * `insert-free-time` takes a day and two times — not a position, and not a neighbouring item. So the
 * control belongs to the day rather than to any stop in it: a per-gap button would imply the gap it
 * sat in was part of the request, and it is not. The times say where it goes.
 *
 * ## The one free-text field in the vocabulary
 *
 * `title` is the traveller's own label — "nap", "swim", "call home" — and no closed list could offer
 * it. It is safe because it is *data about their trip* and never an instruction: rendered as text,
 * never interpolated into a prompt, length-capped so it cannot become a payload. Left blank, the
 * applier picks the neutral wording; there is no placeholder pretending to be a value.
 *
 * The cap is applied here *and* in the schema. `maxLength` is a courtesy that stops someone typing
 * past the limit and losing the tail on submit; the schema is what actually decides, because a
 * `maxLength` attribute is a suggestion to a browser and this command can also arrive from outside.
 *
 * ## Nothing is invented for the times
 *
 * Both fields start empty and Save stays unavailable until they are filled. Pre-filling a plausible
 * slot would be putting words in the traveller's mouth about the one thing this command is for, and a
 * default that happened to collide with an existing stop would greet them with a refusal they did not
 * cause.
 */
export function FreeTimeForm({
  dayNumber,
  busy,
  check,
  onSave,
  onCancel,
}: {
  dayNumber: number;
  busy: boolean;
  /** The refusal these values would produce, or null. The hook's `preview`, so it is the real rule. */
  check: (input: {
    startTime: string;
    endTime: string;
    title?: string;
  }) => string | null;
  onSave: (input: {
    startTime: string;
    endTime: string;
    title?: string;
  }) => void;
  onCancel: () => void;
}) {
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [title, setTitle] = useState("");

  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  const trimmed = title.trim();
  const values = {
    startTime,
    endTime,
    ...(trimmed ? { title: trimmed } : {}),
  };

  const complete = startTime !== "" && endTime !== "";
  const refusal = complete ? check(values) : null;
  const canSave = complete && refusal === null && !busy;

  return (
    <form
      data-testid="free-time-form"
      data-day-number={dayNumber}
      aria-label={`Add free time to day ${dayNumber}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        onSave(values);
      }}
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-cream-raised p-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${fieldId}-start`}
            className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted"
          >
            Start
          </label>
          <input
            id={`${fieldId}-start`}
            type="time"
            required
            value={startTime}
            disabled={busy}
            data-testid="free-time-start"
            onChange={(event) => setStartTime(event.target.value)}
            className="rounded-lg border border-line bg-cream px-2 py-1 font-mono text-xs tabular-nums text-ink focus-visible:border-forest-soft disabled:opacity-50"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor={`${fieldId}-end`}
            className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted"
          >
            End
          </label>
          <input
            id={`${fieldId}-end`}
            type="time"
            required
            value={endTime}
            disabled={busy}
            data-testid="free-time-end"
            onChange={(event) => setEndTime(event.target.value)}
            className="rounded-lg border border-line bg-cream px-2 py-1 font-mono text-xs tabular-nums text-ink focus-visible:border-forest-soft disabled:opacity-50"
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label
            htmlFor={`${fieldId}-title`}
            className="text-[0.6875rem] font-medium uppercase tracking-wide text-ink-muted"
          >
            Label{" "}
            <span className="normal-case tracking-normal">(optional)</span>
          </label>
          <input
            id={`${fieldId}-title`}
            type="text"
            value={title}
            disabled={busy}
            maxLength={MAX_FREE_TIME_TITLE}
            data-testid="free-time-title"
            onChange={(event) => setTitle(event.target.value)}
            className="min-w-0 rounded-lg border border-line bg-cream px-2 py-1 text-xs text-ink focus-visible:border-forest-soft disabled:opacity-50"
          />
        </div>
      </div>

      {refusal ? (
        <p
          id={errorId}
          role="alert"
          data-testid="free-time-error"
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
          data-testid="free-time-cancel"
          className="rounded-full border border-line bg-cream px-2.5 py-1 text-[0.6875rem] font-medium text-ink-muted transition-colors hover:text-forest disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          data-testid="free-time-save"
          {...(refusal ? { "aria-describedby": errorId } : {})}
          className="rounded-full border border-forest bg-forest px-2.5 py-1 text-[0.6875rem] font-medium text-primary-foreground transition-colors hover:bg-forest/90 disabled:opacity-50"
        >
          Add free time
        </button>
      </div>
    </form>
  );
}
