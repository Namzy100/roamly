"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Images,
  Info,
  Loader2,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useOnlineStatus } from "@/lib/hooks/use-online-status";
import { useTripIntelligence } from "@/lib/hooks/use-trip-intelligence";
import {
  describeLandmarkPanel,
  type LandmarkPanelViewModel,
} from "@/lib/trip/landmark-panel";
import { cn } from "@/lib/utils";

/**
 * The landmark-context panel (Checkpoint 5B, section 10B).
 *
 * ## Nothing here decides anything
 *
 * Every label, every count, every "may this be pressed" comes from `describeLandmarkPanel`, and every sentence about
 * a place comes from `lib/trip/trip-intelligence-ui.ts` by way of the hook. That is not tidiness for its own sake:
 * the repository has no jsdom, so a branch written in this file is a branch no test can reach. What is left here is
 * markup, ARIA wiring and two pieces of local interaction state — the things a browser has to verify anyway.
 *
 * ## No request happens because this rendered
 *
 * There is no effect that fetches. Wikimedia and Wikidata are volunteer infrastructure and a serial enrichment pass
 * takes the better part of a minute, so opening a trip must cost them nothing. The only paths to a request are the
 * two `onClick` handlers below.
 *
 * ## The disabled reason is rendered, not a tooltip
 *
 * `aria-describedby` points the button at a visible paragraph. A `title` attribute would be hover-only — unreachable
 * by touch, unreachable by keyboard, and announced inconsistently — and this is precisely the case where the reason
 * matters more than the control: a traveller whose trip is four restaurants needs to know the itinerary is why,
 * not to be left guessing at a greyed-out button.
 */
export function LandmarkControls({ tripId }: { tripId: string }) {
  const online = useOnlineStatus();
  const {
    status,
    message,
    matched,
    unresolved,
    progress,
    canRetry,
    eligibleCount,
    uncheckedCount,
    hasIntelligence,
    enrich,
    refresh,
    clear,
    cancel,
  } = useTripIntelligence(tripId);

  /** Whether the confirmation dialog is open. Local, because a dialog is not trip state. */
  const [confirming, setConfirming] = useState(false);

  const headingId = useId();
  const reasonId = useId();

  const panel = describeLandmarkPanel({
    status,
    message,
    matched,
    unresolved,
    progress,
    canRetry,
    eligibleCount,
    uncheckedCount,
    hasIntelligence,
    online,
  });

  /**
   * The dialog closes when the clear worked, and stays open when it did not.
   *
   * Decided inside the click from `clear()`'s own answer rather than from the next render. A revision conflict leaves
   * the sidecar in place and returns `false`, so the dialog stays where it is and shows the reason — a dialog that
   * closed on confirm would report the failure behind its own backdrop as it disappeared.
   */
  const confirmClear = (): boolean => {
    const cleared = clear();
    if (cleared) setConfirming(false);
    return cleared;
  };

  const run = () => {
    void (panel.primary.action === "refresh" ? refresh() : enrich());
  };

  return (
    <section
      aria-labelledby={headingId}
      data-testid="landmark-controls"
      data-landmark-status={status}
      data-has-intelligence={hasIntelligence ? "true" : "false"}
      data-eligible-count={eligibleCount}
      data-unchecked-count={uncheckedCount}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3
            id={headingId}
            className="flex items-center gap-2 font-display text-lg text-forest"
          >
            <Images aria-hidden className="size-4 text-terracotta" />
            {panel.heading}
          </h3>
          <p className="max-w-md text-xs leading-relaxed text-ink-muted">
            {panel.supporting}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/*
           * Cancel comes first, so the control that stops something is not behind the control that starts it. It
           * exists only while a request is in flight — `describeLandmarkPanel` withholds it during the save, where
           * there is nothing left to abort but a synchronous store write.
           */}
          {panel.cancel ? (
            <Button
              type="button"
              onClick={cancel}
              data-testid="cancel-landmarks"
              className="h-9 gap-1.5 bg-transparent text-ink-muted hover:text-forest"
            >
              {panel.cancel.label}
            </Button>
          ) : null}

          <Button
            type="button"
            onClick={run}
            disabled={panel.primary.disabledReason !== null}
            /* The reason is a visible paragraph below, not a tooltip. See the note above. */
            aria-describedby={
              panel.primary.disabledReason ? reasonId : undefined
            }
            aria-busy={panel.primary.busy}
            data-testid="run-landmarks"
            data-action={panel.primary.action}
            /* Set when pressing this again is the retry, so a browser check can assert the action it retries with. */
            data-retry={panel.retry ? "true" : "false"}
            className="h-9 gap-1.5"
          >
            {panel.primary.busy ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Images aria-hidden className="size-3.5" />
            )}
            {/*
             * The label does not change while running.
             *
             * Swapping it for "Checking…" would rename the control mid-operation, which a screen reader reports as a
             * different button appearing. The spinner and `aria-busy` carry the state; the live region carries the
             * detail.
             */}
            {panel.primary.label}
          </Button>

          {panel.clear ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirming(true)}
              disabled={panel.clear.disabled}
              data-testid="clear-landmarks"
              className="h-9 gap-1.5 text-ink-muted hover:text-forest"
            >
              <Trash2 aria-hidden className="size-3.5" />
              {panel.clear.label}
            </Button>
          ) : null}
        </div>
      </div>

      {panel.primary.disabledReason ? (
        <p
          id={reasonId}
          data-testid="landmark-disabled-reason"
          className="flex items-start gap-2 rounded-xl bg-sand/60 px-3.5 py-2.5 text-xs leading-relaxed text-ink"
        >
          <Info
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
          />
          {panel.primary.disabledReason}
        </p>
      ) : null}

      {panel.progress ? <ProgressRow progress={panel.progress} /> : null}

      {panel.outcome ? (
        <p
          /* A problem is announced immediately; a success is left to the polite region below. */
          role={panel.outcome.tone === "problem" ? "alert" : undefined}
          data-testid="landmark-outcome"
          data-tone={panel.outcome.tone}
          className={cn(
            "flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs leading-relaxed text-ink",
            panel.outcome.tone === "problem"
              ? "border border-destructive/30 bg-destructive/[0.06]"
              : "bg-sand/60",
          )}
        >
          {panel.outcome.tone === "problem" ? (
            <AlertTriangle
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-destructive"
            />
          ) : panel.outcome.tone === "success" ? (
            <CheckCircle2
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-forest"
            />
          ) : (
            <Info
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
            />
          )}
          {panel.outcome.message}
        </p>
      ) : null}

      {/*
       * One live region for the whole panel.
       *
       * `polite` rather than `assertive`: a lookup runs for the better part of a minute and interrupting a reader
       * every few seconds would make the page unusable. The sentence itself is assembled by the view model, so what
       * is heard and what is shown cannot describe different situations.
       */}
      <p className="sr-only" aria-live="polite">
        {panel.announcement}
      </p>

      {confirming ? (
        <ClearLandmarkDialog
          /* Only a problem *this* dialog caused. See `attempted` inside it. */
          problem={
            panel.outcome?.tone === "problem" ? panel.outcome.message : null
          }
          onCancel={() => setConfirming(false)}
          onConfirm={confirmClear}
        />
      ) : null}
    </section>
  );
}

/**
 * How far the last lookup got.
 *
 * Every figure is rendered as text as well as as a bar, because a bar is the one element in this panel that a
 * screen reader, a text browser and a stylesheet-blocking extension all fail to convey. `role="progressbar"` with
 * `aria-valuetext` gives the same numbers to assistive technology in one string.
 */
function ProgressRow({
  progress,
}: {
  progress: NonNullable<LandmarkPanelViewModel["progress"]>;
}) {
  return (
    <div
      data-testid="landmark-progress"
      data-checked={progress.checked}
      data-total={progress.total}
      data-matched={progress.matched}
      data-unresolved={progress.unresolved}
      data-completed-calls={progress.completedCalls}
      data-maximum-calls={progress.maximumCalls}
      data-percent={progress.percent}
      className="flex flex-col gap-2 rounded-xl bg-sand/60 px-3.5 py-2.5 text-xs"
    >
      <p className="font-medium text-ink">{progress.phaseLine}</p>

      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.countLine}. ${progress.resultLine}.`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full rounded-full bg-forest-soft transition-[width] duration-300"
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-muted">
        <span data-testid="landmark-count-line">{progress.countLine}</span>
        <span data-testid="landmark-result-line">{progress.resultLine}</span>
        {/* Completed, never "current". A count of the past cannot promise a request that may not happen. */}
        <span data-testid="landmark-call-line">{progress.callLine}</span>
      </div>
    </div>
  );
}

/**
 * The confirmation before forgetting a trip's landmark context.
 *
 * ## Why a confirmation at all
 *
 * Clearing is cheap to do and expensive to undo: getting the context back means another serial pass against two
 * volunteer services, and there is no undo entry for it. That asymmetry is the whole test for whether an action
 * needs a confirmation.
 *
 * ## The focus handling follows `placement-dialog.tsx`
 *
 * Deliberately the same shape rather than a second approach: Escape and Tab in one listener so they cannot drift
 * apart, the opener captured **during the first render** because an effect would capture the dialog's own first
 * focus target, and focus restored only if the opener is still in the document.
 */
function ClearLandmarkDialog({
  problem,
  onCancel,
  onConfirm,
}: {
  /** The panel's current problem, shown only after this dialog has actually tried. */
  problem: string | null;
  onCancel: () => void;
  /** Clears, and reports whether it worked. `false` keeps this dialog open with the reason. */
  onConfirm: () => boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();

  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);

  /**
   * The duplicate-confirmation guard, as a ref rather than as the rendered `busy`.
   *
   * A second click landing in the same tick reads the closure's stale `busy`, and `disabled` has not been committed
   * yet — the same reason `use-trip-intelligence.ts` guards its own in-flight state with a ref.
   */
  const fired = useRef(false);

  /**
   * One confirmation, and a refusal re-arms the button.
   *
   * All of it in the handler, because `clear()` answers synchronously. Re-arming matters: a traveller whose other tab
   * has since closed must be able to press again, and a guard that latched for good would strand them. A *successful*
   * clear never reaches the re-arm — the panel has already unmounted this dialog by then.
   */
  const confirm = () => {
    if (fired.current) return;
    fired.current = true;
    setAttempted(true);
    setBusy(true);

    if (!onConfirm()) {
      fired.current = false;
      setBusy(false);
    }
  };

  /** Escape closes, and Tab cannot leave. One listener, for the reason `placement-dialog.tsx` gives. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;

      const node = panelRef.current;
      if (!node) return;

      const focusable = [
        ...node.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
        // Recomputed on every Tab: the confirm button disables itself mid-clear, and a cached list would
        // still send focus to it.
      ].filter(
        (element) =>
          element.offsetParent !== null || element === document.activeElement,
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !node.contains(active))) {
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
   * The element that opened this, captured during the **first render**.
   *
   * Not in an effect: mount effects run in declaration order, so by then the focus effect below has already moved
   * focus into the dialog and the captured "opener" would be this dialog's own Cancel button. Restoring focus to a
   * button that is unmounting drops it to `<body>`.
   */
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );

  /**
   * Focus lands on the keep-it button, not on the destructive one.
   *
   * The destructive choice must not be one keypress from a traveller who opened this dialog by accident, and keeping
   * things is the safe default for a confirmation whose whole purpose is a second look.
   */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  /** Focus goes back to the Clear trigger, if it is still there to receive it. */
  useEffect(
    () => () => {
      const opener = openerRef.current;
      if (opener && document.body.contains(opener)) opener.focus();
    },
    [],
  );

  const shownProblem = attempted ? problem : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="clear-landmarks-dialog"
      ref={panelRef}
      /* Ends at the bottom on a narrow screen and centres above `sm`, the same as every other dialog here. */
      className="fixed inset-0 z-50 flex items-end justify-center bg-forest/30 p-0 backdrop-blur-sm sm:items-center sm:p-6"
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-2xl border border-line bg-cream-raised p-5 shadow-raised sm:rounded-2xl">
        <h2 id={titleId} className="font-display text-lg text-forest">
          Clear landmark context?
        </h2>

        <p id={descriptionId} className="text-sm leading-relaxed text-ink-muted">
          {/*
           * States the scope in both directions. "Only" is the load-bearing word: a traveller about to remove
           * something from a saved trip needs to know their itinerary, times and costs are not part of it.
           */}
          This removes only the landmark photos and context added from Wikidata
          and Wikimedia Commons. Your itinerary, times, costs and notes are not
          affected. You can add the context again later.
        </p>

        {shownProblem ? (
          <p
            role="alert"
            data-testid="clear-landmarks-problem"
            className="rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-relaxed text-ink"
          >
            {shownProblem}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="destructive"
            onClick={confirm}
            disabled={busy}
            aria-busy={busy}
            data-testid="clear-landmarks-confirm"
            className="h-9 gap-1.5"
          >
            <Trash2 aria-hidden className="size-3.5" />
            {/*
             * "Clear it", not "Clear landmark context".
             *
             * The trigger that opened this dialog carries the longer name and is still in the document behind it, and
             * two buttons with one accessible name is exactly the ambiguity `aria-modal` is not required to resolve.
             * The dialog's heading and description already say what "it" is.
             */}
            Clear it
          </Button>
          <Button
            type="button"
            variant="ghost"
            ref={cancelRef}
            onClick={onCancel}
            data-testid="clear-landmarks-cancel"
            className="h-9"
          >
            Keep it
          </Button>
        </div>
      </div>
    </div>
  );
}
