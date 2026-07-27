"use client";

import {
  AlertTriangle,
  Calculator,
  Check,
  ChevronDown,
  Coins,
  Loader2,
  RefreshCw,
  RouteOff,
  Sparkles,
  Redo2,
  Undo2,
  Waypoints,
  Wind,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AiStatusResponse } from "@/lib/api/generate-contract";
import {
  offlineReasonFor,
  useOnlineStatus,
} from "@/lib/hooks/use-online-status";
import { formatMoney } from "@/lib/format";
import {
  canRefinePlaces,
  refinementUnavailableReason,
} from "@/lib/refinement/eligibility";
import {
  REFINEMENT_STAGE_LABELS,
  ROUTE_RETRY_STAGE_LABELS,
} from "@/lib/refinement/types";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";
import type { RefinementJobState } from "@/lib/store/refinement-job-store";
import { cn } from "@/lib/utils";

/**
 * The "Refine trip" surface.
 *
 * ## Why a disclosure rather than a popover
 *
 * A popover needs focus trapping, an escape handler, outside-click detection and
 * positioning logic, and gets all four subtly wrong on a phone. A `<details>`-style
 * disclosure with a real button is keyboard-navigable and screen-reader-correct for
 * free, works identically at every width, and cannot trap anyone. The panel is closed
 * by default so it does not compete with the itinerary.
 *
 * ## What is disabled, and what is explained
 *
 * The AI actions are disabled — never hidden — when no planner can refine this trip,
 * with the reason inline. Hiding them would leave a traveller wondering whether the
 * feature exists; a silent fallback to the demo planner on a model-generated trip is
 * the substitution the architecture forbids.
 *
 * While something is running, *conflicting* actions are disabled rather than all of
 * them: a route retry and a day adjustment cannot both write, so both are held, but the
 * panel stays legible and the running action names itself.
 *
 * Regeneration asks for confirmation because it discards every choice the traveller has
 * accumulated. A single replacement does not, because it is one click to undo.
 */

export function RefinePanel({
  plan,
  generation,
  availability,
  job,
  selectedDay,
  undoableAction,
  redoableAction,
  undoDepth,
  redoDepth,
  onRegenerate,
  onAdjustDay,
  onRetryRoutes,
  onRecalculateEstimates,
  onUndo,
  onRedo,
  onCancel,
  onDismiss,
}: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
  availability: AiStatusResponse | null;
  job: RefinementJobState;
  /** The day the workspace is showing, or `null` in All Days. */
  selectedDay: number | null;
  /**
   * The next step back, and how many there are.
   *
   * The count is the *actual* depth rather than the twenty the history is allowed. Both bounds in
   * `lib/store/history.ts` are real — a long routed trip reaches the byte budget at around
   * fourteen entries — so a control claiming twenty would run out earlier than it promised, which
   * is the direction of wrongness that costs trust.
   */
  undoableAction: string | null;
  redoableAction: string | null;
  undoDepth: number;
  redoDepth: number;
  onRegenerate: () => void;
  onAdjustDay: (
    dayNumber: number,
    adjustment: "cheaper" | "more-relaxed" | "more-packed",
  ) => void;
  onRetryRoutes: (scope: "unavailable-only" | "all") => void;
  /**
   * Recompute every cost estimate against the destination's current profile (Phase 6B).
   *
   * Not gated on `aiEnabled`: it needs no planner, no OpenStreetMap request and no routing —
   * only the traveller's budget, the curated profile and the plan's own places.
   */
  onRecalculateEstimates: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const online = useOnlineStatus();
  const [open, setOpen] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  const running = job.status === "running";

  // Move focus to the confirmation so a keyboard user is not left behind by a
  // control that appeared somewhere else on the page.
  useEffect(() => {
    if (confirmingRegenerate) confirmRef.current?.focus();
  }, [confirmingRegenerate]);

  /**
   * One shared answer to "can these stops be changed?", so this panel and the per-stop
   * and per-backup actions cannot disagree — a disagreement offers a button that cannot
   * work and explains itself only after it is pressed.
   */
  /**
   * Offline, no planner action can work, whatever the configuration says.
   *
   * Folded into the same predicate the per-stop and per-backup controls read, so the whole surface
   * agrees — a panel that disabled itself while an itinerary row still offered "Replace this stop"
   * would be the disagreement worth avoiding.
   */
  const aiEnabled =
    online &&
    canRefinePlaces({
      generation,
      modelAvailable: availability?.modelAvailable ?? null,
    });

  const unavailableLegs = plan.routing?.summary.unavailableLegs ?? 0;
  const hasRouting = plan.routing !== null;

  return (
    <section
      aria-labelledby="refine-heading"
      data-testid="refine-panel"
      data-open={open}
      data-ai-enabled={aiEnabled}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3
            id="refine-heading"
            className="flex items-center gap-2 font-display text-lg text-forest"
          >
            <Sparkles aria-hidden className="size-4 text-terracotta" />
            Refine this trip
          </h3>
          <p className="max-w-md text-xs leading-relaxed text-ink-muted">
            Change one stop, reshape a day, or start the itinerary again — always from
            the same places that were found for this destination. Nothing is saved
            until the change has been checked.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {undoableAction !== null && !running ? (
            <Button
              type="button"
              variant="outline"
              onClick={onUndo}
              data-testid="undo-refinement"
              data-depth={undoDepth}
              /*
               * The depth goes in the accessible name, not in the visible label.
               *
               * "Undo change time" is what the control does; "1 of 6" is context somebody skimming
               * the button does not need and somebody navigating by voice or screen reader does.
               * Putting the number in the label would also make the button resize on every edit.
               */
              aria-label={`Undo ${undoableAction.toLowerCase()} — ${undoDepth} step${undoDepth === 1 ? "" : "s"} back available`}
              className="h-9 gap-1.5"
            >
              <Undo2 aria-hidden className="size-3.5" />
              Undo {undoableAction.toLowerCase()}
            </Button>
          ) : null}

          {redoableAction !== null && !running ? (
            <Button
              type="button"
              variant="outline"
              onClick={onRedo}
              data-testid="redo-refinement"
              data-depth={redoDepth}
              aria-label={`Redo ${redoableAction.toLowerCase()} — ${redoDepth} step${redoDepth === 1 ? "" : "s"} forward available`}
              className="h-9 gap-1.5"
            >
              <Redo2 aria-hidden className="size-3.5" />
              Redo {redoableAction.toLowerCase()}
            </Button>
          ) : null}

          <Button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-controls="refine-actions"
            data-testid="refine-toggle"
            className="h-9 gap-1.5"
          >
            {open ? "Close" : "Refine"}
            <ChevronDown
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
          </Button>
        </div>
      </div>

      {running ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl bg-sand/60 px-3.5 py-2.5 text-xs"
          data-testid="refine-progress"
          data-stage={job.stage ?? ""}
          data-action={job.action}
        >
          <span className="inline-flex items-center gap-2 font-medium text-forest">
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {job.action === "retry-routes"
              ? ROUTE_RETRY_STAGE_LABELS.recalculating
              : job.stage
                ? REFINEMENT_STAGE_LABELS[job.stage]
                : REFINEMENT_STAGE_LABELS.reviewing}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            data-testid="cancel-refinement"
            className="h-8"
          >
            Cancel
          </Button>
          <span className="text-ink-muted">
            Your trip is untouched until this finishes.
          </span>
        </div>
      ) : null}

      {job.status === "success" || job.status === "partial" ? (
        <Outcome job={job} currency={plan.budget.currency} onDismiss={onDismiss} />
      ) : null}

      {job.status === "error" || job.status === "conflict" ? (
        <p
          role="alert"
          data-testid="refine-error"
          data-job-status={job.status}
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-ink"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-destructive"
          />
          <span className="flex-1">{job.message}</span>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      ) : null}

      {open ? (
        <div id="refine-actions" className="flex flex-col gap-4 border-t border-line pt-4">
          {!aiEnabled ? (
            <p
              data-testid="refine-ai-unavailable"
              className="text-xs leading-relaxed text-ink-muted"
            >
              {refinementUnavailableReason({ generation })}
            </p>
          ) : null}

          <ActionGroup label="This day">
            {selectedDay === null ? (
              <p className="text-xs text-ink-muted">
                Pick a single day above to adjust it.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  icon={Coins}
                  disabled={!aiEnabled || running}
                  onClick={() => onAdjustDay(selectedDay, "cheaper")}
                  testId="adjust-day-cheaper"
                >
                  Make day {selectedDay} cheaper
                </ActionButton>
                <ActionButton
                  icon={Wind}
                  disabled={!aiEnabled || running}
                  onClick={() => onAdjustDay(selectedDay, "more-relaxed")}
                  testId="adjust-day-relaxed"
                >
                  More relaxed
                </ActionButton>
                <ActionButton
                  icon={Sparkles}
                  disabled={!aiEnabled || running}
                  onClick={() => onAdjustDay(selectedDay, "more-packed")}
                  testId="adjust-day-packed"
                >
                  Fit more in
                </ActionButton>
              </div>
            )}
          </ActionGroup>

          <ActionGroup label="Routes">
            <div className="flex flex-wrap gap-2">
              <ActionButton
                icon={RouteOff}
                disabled={running || !online || unavailableLegs === 0}
                onClick={() => onRetryRoutes("unavailable-only")}
                testId="retry-unavailable-routes"
              >
                Retry {unavailableLegs > 0 ? `${unavailableLegs} ` : ""}unavailable
                route{unavailableLegs === 1 ? "" : "s"}
              </ActionButton>
              <ActionButton
                icon={Waypoints}
                disabled={running || !online}
                onClick={() => onRetryRoutes("all")}
                testId="recalculate-all-routes"
              >
                {hasRouting ? "Recalculate all routes" : "Calculate all routes"}
              </ActionButton>
            </div>
            <p className="text-xs text-ink-muted">
              {online
                ? "Route retries need no AI planner — they come from OpenStreetMap road data."
                : offlineReasonFor("route")}
            </p>
          </ActionGroup>

          <ActionGroup label="Cost estimates">
            <div className="flex flex-wrap gap-2">
              <ActionButton
                icon={Calculator}
                disabled={running}
                onClick={onRecalculateEstimates}
                testId="recalculate-estimates"
              >
                Recalculate cost estimates
              </ActionButton>
            </div>
            <p className="text-xs text-ink-muted">
              Re-divides your stated budget using this destination&rsquo;s cost profile.
              No AI, no searches, and nothing about your itinerary moves — only the
              figures.
            </p>
          </ActionGroup>

          <ActionGroup label="The whole trip">
            {confirmingRegenerate ? (
              <div
                className="flex flex-col gap-2 rounded-xl border border-terracotta/40 bg-terracotta/[0.07] p-3.5"
                data-testid="regenerate-confirm"
              >
                <p className="text-xs leading-relaxed text-ink">
                  This rebuilds every day from the same places that were found for this
                  destination. Your current itinerary, and any routes you have
                  calculated, will be replaced — one Undo will bring them back.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    ref={confirmRef}
                    type="button"
                    onClick={() => {
                      setConfirmingRegenerate(false);
                      onRegenerate();
                    }}
                    data-testid="regenerate-confirm-yes"
                    className="h-9"
                  >
                    Yes, regenerate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirmingRegenerate(false)}
                    className="h-9"
                  >
                    Keep what I have
                  </Button>
                </div>
              </div>
            ) : (
              <ActionButton
                icon={RefreshCw}
                disabled={!aiEnabled || running}
                onClick={() => setConfirmingRegenerate(true)}
                testId="regenerate-trip"
              >
                Regenerate the whole itinerary
              </ActionButton>
            )}
          </ActionGroup>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {running
          ? job.action === "retry-routes"
            ? ROUTE_RETRY_STAGE_LABELS.recalculating
            : job.stage
              ? REFINEMENT_STAGE_LABELS[job.stage]
              : ""
          : job.status === "success"
            ? "Change applied."
            : job.status === "partial"
              ? "Change applied, with notes."
              : ""}
      </p>
    </section>
  );
}

/**
 * What the change actually did.
 *
 * Derived server-side by comparing the two plans, so it reports what happened rather
 * than what was intended — including the routes that need recalculating, which is the
 * one consequence a traveller would otherwise discover by noticing a line had gone.
 */
function Outcome({
  job,
  currency,
  onDismiss,
}: {
  job: Extract<RefinementJobState, { status: "success" | "partial" }>;
  currency: TripPlan["budget"]["currency"];
  onDismiss: () => void;
}) {
  const { summary } = job;
  const delta = summary.newEstimatedTotal - summary.previousEstimatedTotal;

  return (
    <div
      className="flex flex-col gap-2 rounded-xl bg-sand/60 px-3.5 py-2.5 text-xs"
      data-testid="refine-outcome"
      data-action={summary.action}
      data-changed={summary.changedItemIds.length}
      data-added={summary.addedItemIds.length}
      data-removed={summary.removedItemIds.length}
      data-invalidated-legs={summary.invalidatedLegIds.length}
      data-revision-after={summary.revisionAfter ?? ""}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium text-forest">
          <Check aria-hidden className="size-3.5" />
          Change applied
        </span>

        {summary.addedItemIds.length + summary.removedItemIds.length +
        summary.changedItemIds.length >
        0 ? (
          <span className="text-ink-muted">
            {describeItemChanges(summary)}
          </span>
        ) : null}

        {delta !== 0 ? (
          <span className={delta < 0 ? "text-forest" : "text-ink-muted"}>
            {delta < 0 ? "−" : "+"}
            {formatMoney(Math.abs(delta), currency)}
          </span>
        ) : null}

        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto underline underline-offset-2"
        >
          Dismiss
        </button>
      </div>

      {/*
        * The deterministic actions carry a sentence of their own: "moved to 12:45, inside
        * its published hours of 10:00–18:00" says something the counts cannot.
        */}
      {job.status === "success" && job.message ? (
        <p data-testid="refine-outcome-message" className="text-ink-muted">
          {job.message}
        </p>
      ) : null}

      {summary.invalidatedLegIds.length > 0 ? (
        <p className="text-ink-muted">
          {summary.invalidatedLegIds.length} route
          {summary.invalidatedLegIds.length === 1 ? "" : "s"} no longer matched the
          itinerary and {summary.invalidatedLegIds.length === 1 ? "was" : "were"}{" "}
          cleared. Recalculate to measure them again.
        </p>
      ) : null}

      {job.status === "partial"
        ? job.warnings.map((warning, index) => (
            <p key={`${warning.code}-${index}`} className="text-ink-muted">
              {warning.message}
            </p>
          ))
        : null}
    </div>
  );
}

function describeItemChanges(summary: {
  changedItemIds: string[];
  addedItemIds: string[];
  removedItemIds: string[];
}): string {
  const parts: string[] = [];
  if (summary.addedItemIds.length > 0) {
    parts.push(`${summary.addedItemIds.length} added`);
  }
  if (summary.removedItemIds.length > 0) {
    parts.push(`${summary.removedItemIds.length} removed`);
  }
  if (summary.changedItemIds.length > 0) {
    parts.push(`${summary.changedItemIds.length} changed`);
  }
  return parts.join(" · ");
}

function ActionGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow text-ink-muted">{label}</span>
      {children}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  disabled,
  onClick,
  testId,
  children,
}: {
  icon: typeof Coins;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="h-9 gap-1.5 text-xs"
    >
      <Icon aria-hidden className="size-3.5" />
      {children}
    </Button>
  );
}
