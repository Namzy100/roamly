"use client";

import { CircleHelp, Clock, DoorClosed, DoorOpen } from "lucide-react";

import type { OpeningEvaluation } from "@/lib/opening-hours";
import { cn } from "@/lib/utils";

/**
 * What we can honestly say about a stop's opening hours.
 *
 * ## Never green for unknown
 *
 * There are three visual states, not two: open, closed, and *we do not know*. The third
 * is the common one — most OpenStreetMap places have no `opening_hours` tag — and it must
 * not borrow the appearance of either answer. A green badge on a stop whose hours we never
 * read would be a claim we have no basis for, and a red one would be worse.
 *
 * ## Icons and words, not colour alone
 *
 * Each state has a distinct icon *and* distinct text, so the distinction survives
 * greyscale, colour blindness and a screen reader. Colour is the third channel, never the
 * first — and the unknown state is deliberately neutral rather than amber, because amber
 * reads as a warning and "nobody has recorded this" is not one.
 *
 * ## The source string, verbatim
 *
 * Whatever we say, the OSM string travels with it in the tooltip so a traveller can check
 * us. When we could not read it, the string *is* the answer: showing `Mo-Fr 09:00-17:00; PH
 * off` and admitting we do not interpret the second clause is more useful than showing
 * nothing.
 */

type Presentation = {
  icon: typeof DoorOpen;
  label: string;
  /** For the screen reader and the tooltip. Says why, not just what. */
  detail: string;
  className: string;
};

export function presentationFor(evaluation: OpeningEvaluation): Presentation | null {
  switch (evaluation.status) {
    // Nothing to say: no place, or a slot the search could not fill.
    case "not_applicable":
      return null;

    case "confirmed_open":
      return {
        icon: DoorOpen,
        label: "Open then",
        detail: `OpenStreetMap records this place as open ${evaluation.interval.opensAt}–${evaluation.interval.closesAt} on this day.`,
        className: "bg-forest-soft/15 text-forest",
      };

    case "confirmed_closed":
      return {
        icon: DoorClosed,
        label: "Closed then",
        detail: evaluation.nextKnownOpening
          ? `OpenStreetMap's published hours (${evaluation.sourceText}) do not cover this slot. It opens at ${evaluation.nextKnownOpening} that day.`
          : `OpenStreetMap's published hours (${evaluation.sourceText}) do not cover this slot.`,
        // The darker token: 11px text on a terracotta tint needs 4.5:1, and the fill colour is 3.3:1.
        className: "bg-terracotta/15 text-terracotta-ink",
      };

    /**
     * The four unknowns share one appearance and differ in wording.
     *
     * Sharing the appearance is right: to a traveller they are the same fact — we cannot
     * tell — and giving each its own colour would imply a gradient of confidence that does
     * not exist. The wording differs because the *reason* is actionable in different ways.
     */
    case "unknown_no_data":
      return {
        icon: CircleHelp,
        label: "Hours unknown",
        detail:
          "OpenStreetMap has no opening hours recorded for this place, so we cannot say whether it is open. Worth checking before you go.",
        className: "bg-sand text-ink-muted",
      };

    case "unknown_unparsed":
      return {
        icon: CircleHelp,
        label: "Hours not checked",
        detail: `This planner does not interpret these hours, so they are shown as recorded: ${evaluation.sourceText}`,
        className: "bg-sand text-ink-muted",
      };

    case "unknown_timezone":
      return {
        icon: CircleHelp,
        label: "Hours not checked",
        detail:
          "The destination's timezone could not be determined, so local opening times cannot be compared with the schedule.",
        className: "bg-sand text-ink-muted",
      };

    case "unknown_exception":
      return {
        icon: Clock,
        label: "Hours uncertain",
        detail:
          evaluation.reason ??
          "These hours include a rule this planner does not evaluate, so the answer for this date is not certain.",
        className: "bg-sand text-ink-muted",
      };
  }
}

export function OpeningHoursBadge({
  evaluation,
  className,
}: {
  evaluation: OpeningEvaluation;
  className?: string;
}) {
  const presentation = presentationFor(evaluation);
  if (!presentation) return null;

  const Icon = presentation.icon;

  return (
    <span
      // `title` for a pointer, and the same text in the label for everyone else. The
      // status is announced as words, never inferred from the colour.
      title={presentation.detail}
      data-hours-status={evaluation.status}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
        presentation.className,
        className,
      )}
    >
      <Icon aria-hidden className="size-3" />
      {presentation.label}
      <span className="sr-only">. {presentation.detail}</span>
    </span>
  );
}
