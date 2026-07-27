"use client";

import { useState } from "react";
import {
  CircleCheck,
  CircleHelp,
  Clock,
  DoorClosed,
  Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { ScheduleAccuracyReport, ScheduleConflict } from "@/lib/plan";
import type { TripPlace } from "@/lib/schemas";
import { cn } from "@/lib/utils";

/**
 * What the published opening hours say about this itinerary, and what to do about it.
 *
 * ## Conflicts and warnings are different things, and look different
 *
 * A **conflict** is the one claim this app will make about a closure: hours we could read,
 * in a zone we know, that do not cover the slot. Those get repair controls, because there
 * is something to repair.
 *
 * A **warning** is an absence — no tag, a syntax we do not interpret, an unknown zone. Those
 * get no controls, because there is nothing to fix: the schedule may be perfectly fine and
 * we simply cannot tell. Offering a "fix" would imply we knew something was wrong.
 *
 * ## Why unknown hours are stated at all
 *
 * They are the common case, and hiding them would let a traveller assume every stop had
 * been checked. Counting them out loud — "6 of 9 stops could not be checked" — is the
 * difference between an itinerary that has been verified and one that merely looks it.
 */

export function ScheduleAccuracy({
  report,
  onAdjustTime,
  onMarkUnavailable,
  onReplacePlace,
  candidatesFor,
  canAdjustTime,
  busy,
}: {
  report: ScheduleAccuracyReport;
  onAdjustTime: (conflict: ScheduleConflict) => void;
  onMarkUnavailable: (conflict: ScheduleConflict) => void;
  onReplacePlace: (conflict: ScheduleConflict, placeId: string) => void;
  /** The trip's own pool, filtered — computed by the caller, never searched here. */
  candidatesFor: (conflict: ScheduleConflict) => TripPlace[];
  /**
   * Whether a move would actually find somewhere to move to.
   *
   * Asked before the button is drawn rather than after it is pressed. A day that is closed
   * outright, or full, has nowhere to put the stop — and offering "Move to opening hours"
   * there is offering a control that can only explain itself by failing.
   */
  canAdjustTime: (conflict: ScheduleConflict) => boolean;
  busy: boolean;
}) {
  const heading = HEADINGS[report.status];

  return (
    <section
      aria-labelledby="schedule-accuracy-heading"
      data-testid="schedule-accuracy"
      data-schedule-status={report.status}
      className="rounded-2xl border border-line bg-cream-raised p-4 sm:p-5"
    >
      <div className="flex items-start gap-2.5">
        <heading.icon
          aria-hidden
          className={cn("mt-0.5 size-4 shrink-0", heading.iconClassName)}
        />
        <div className="min-w-0 flex-1">
          <h3
            id="schedule-accuracy-heading"
            className="font-display text-base text-forest"
          >
            {heading.title}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted text-pretty">
            {summarise(report)}
          </p>
          {report.timezone ? (
            <p className="mt-1 text-xs text-ink-muted">
              Checked against local time in {report.timezone.replace("_", " ")}.
            </p>
          ) : null}
        </div>
      </div>

      {report.conflicts.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-3">
          {report.conflicts.map((conflict) => (
            <ConflictRow
              key={conflict.itemId}
              conflict={conflict}
              candidates={candidatesFor(conflict)}
              canAdjustTime={canAdjustTime(conflict)}
              busy={busy}
              onAdjustTime={() => onAdjustTime(conflict)}
              onMarkUnavailable={() => onMarkUnavailable(conflict)}
              onReplacePlace={(placeId) => onReplacePlace(conflict, placeId)}
            />
          ))}
        </ul>
      ) : null}

      {report.warnings.length > 0 ? (
        <details className="mt-4 rounded-xl bg-sand/50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-forest">
            {report.warnings.length} stop
            {report.warnings.length === 1 ? "" : "s"} we could not check
          </summary>
          <ul
            data-testid="schedule-warnings"
            className="mt-2 flex flex-col gap-2"
          >
            {report.warnings.map((warning) => (
              <li
                key={warning.itemId}
                data-warning-code={warning.code}
                className="text-xs leading-relaxed text-ink-muted"
              >
                <span className="font-medium text-ink">
                  Day {warning.dayNumber} · {warning.placeName}
                </span>
                <span className="block">{warning.message}</span>
                {warning.sourceText ? (
                  <span className="mt-0.5 block font-mono text-[0.6875rem] text-ink">
                    {warning.sourceText}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ConflictRow({
  conflict,
  candidates,
  canAdjustTime,
  busy,
  onAdjustTime,
  onMarkUnavailable,
  onReplacePlace,
}: {
  conflict: ScheduleConflict;
  candidates: TripPlace[];
  canAdjustTime: boolean;
  busy: boolean;
  onAdjustTime: () => void;
  onMarkUnavailable: () => void;
  onReplacePlace: (placeId: string) => void;
}) {
  const [showCandidates, setShowCandidates] = useState(false);

  return (
    <li
      data-testid="schedule-conflict"
      data-item-id={conflict.itemId}
      data-conflict-kind={conflict.kind}
      className="rounded-xl border border-terracotta/30 bg-terracotta/5 p-3"
    >
      <p className="flex items-start gap-1.5 text-sm font-medium text-ink">
        <DoorClosed aria-hidden className="mt-0.5 size-3.5 shrink-0 text-terracotta" />
        <span className="min-w-0">
          Day {conflict.dayNumber} · {conflict.placeName}
        </span>
      </p>
      <p className="mt-1 pl-5 text-xs leading-relaxed text-ink-muted">
        Scheduled {conflict.startTime}–{conflict.endTime}.{" "}
        {conflict.nextKnownOpening
          ? `It opens at ${conflict.nextKnownOpening} that day.`
          : "Its published hours do not cover that day."}
      </p>
      {/* The provider's own string, verbatim, so a traveller can check us. */}
      <p className="mt-1 pl-5 font-mono text-[0.6875rem] text-ink">
        {conflict.sourceText}
      </p>

      <div
        className="mt-2.5 flex flex-wrap gap-2 pl-5"
        data-can-adjust={canAdjustTime ? "true" : "false"}
      >
        {canAdjustTime ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            data-testid="hours-adjust-time"
            onClick={onAdjustTime}
          >
            Move to opening hours
          </Button>
        ) : null}
        {candidates.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-expanded={showCandidates}
            data-testid="hours-replace-place"
            data-open={showCandidates ? "true" : "false"}
            onClick={() => setShowCandidates((open) => !open)}
          >
            Choose another place
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          data-testid="hours-mark-unavailable"
          onClick={onMarkUnavailable}
        >
          Leave the slot open
        </Button>
      </div>

      {showCandidates ? (
        <ul
          data-testid="hours-candidates"
          className="mt-2.5 flex flex-col gap-1.5 pl-5"
        >
          {candidates.map((candidate) => (
            <li key={candidate.placeId}>
              <button
                type="button"
                disabled={busy}
                data-testid="hours-candidate"
                data-place-id={candidate.placeId}
                onClick={() => onReplacePlace(candidate.placeId)}
                className="w-full rounded-lg border border-line bg-cream-raised px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:border-forest-soft/60 disabled:opacity-60"
              >
                <span className="font-medium">{candidate.name}</span>
                {/*
                 * The candidate's own hours, or an honest blank. A candidate with no tag is
                 * offered rather than hidden — absence of data is not evidence it is shut —
                 * and saying so here is what stops it looking like a verified alternative.
                 */}
                <span className="mt-0.5 block text-[0.6875rem] text-ink-muted">
                  {candidate.openingHours ??
                    "No opening hours recorded — worth checking"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const HEADINGS: Record<
  ScheduleAccuracyReport["status"],
  { title: string; icon: typeof Info; iconClassName: string }
> = {
  clear: {
    title: "Schedule checked against opening hours",
    icon: CircleCheck,
    iconClassName: "text-forest",
  },
  conflicts: {
    title: "Some stops clash with published opening hours",
    icon: DoorClosed,
    iconClassName: "text-terracotta",
  },
  warnings: {
    title: "Schedule partly checked against opening hours",
    icon: Clock,
    iconClassName: "text-ink-muted",
  },
  unknown: {
    title: "Opening hours could not be checked",
    icon: CircleHelp,
    iconClassName: "text-ink-muted",
  },
};

/**
 * The counts, in a sentence.
 *
 * Both numbers always appear when both are non-zero, because "3 confirmed open" on its own
 * reads as a verified itinerary when six other stops were never checked.
 */
function summarise(report: ScheduleAccuracyReport): string {
  if (report.checkedItems === 0) {
    return report.timezone === null
      ? "This trip's destination timezone could not be determined, so no stop could be checked against its opening hours. OpenStreetMap's own hours are shown on each stop where it has them."
      : "None of this trip's stops has opening hours recorded in OpenStreetMap, so none could be checked.";
  }

  const parts: string[] = [];
  if (report.confirmedOpenItems > 0) {
    parts.push(
      `${report.confirmedOpenItems} of ${report.checkedItems} stops are inside their published hours`,
    );
  }
  if (report.confirmedClosedItems > 0) {
    parts.push(
      `${report.confirmedClosedItems} ${report.confirmedClosedItems === 1 ? "is" : "are"} scheduled outside them`,
    );
  }
  if (report.unknownItems > 0) {
    parts.push(
      `${report.unknownItems} could not be checked because OpenStreetMap has no hours recorded or records them in a format this planner does not interpret`,
    );
  }

  return `${parts.join(", and ")}.`;
}
