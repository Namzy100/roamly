"use client";

import { CircleAlert, Clock, MapPin, Route } from "lucide-react";

import { formatMoney, formatTimeRange } from "@/lib/format";
import { placeCategoryLabel, type ItineraryItem } from "@/lib/schemas";
import type {
  AlternativeRelationFact,
  StopAlternative,
} from "@/lib/structural-edits";
import { cn } from "@/lib/utils";

/**
 * The places this stop could become, and why each one differs.
 *
 * ## Comparison, not ranking
 *
 * Every line here is a fact Roamly holds: a straight-line distance, a published opening rule, the
 * planning-estimate band, a provider tag read verbatim. Nothing is scored and nothing is called
 * better — OpenStreetMap gives this application no rating, no review count and no popularity
 * signal, so a "top pick" badge would be an opinion wearing the clothes of data. The order is
 * `stopAlternatives`' own: open first, then nearest to the place being replaced.
 *
 * Ratings and price levels are deliberately **not** shown, though `TripPlace` can carry them. They
 * exist only on the mock sample — OSM supplies neither — so they would appear on the demo trip and
 * vanish on every real one, and in a list whose whole purpose is comparison a number that is
 * present for some options and absent for others is worse than one absent for all.
 *
 * ## Facts true of every option are stated once
 *
 * A swap is same-category by construction, so "Same category" and the indoor/outdoor label hold for
 * all five cards. Repeating them would pad every card and every screen-reader announcement with the
 * one thing that cannot distinguish two options, so they are lifted into the group's description.
 * The derivation flags them `universal`; this component does not decide it.
 *
 * ## A `placeId` leaves here and nothing else
 *
 * The name, the category and the facts are rendered so a traveller can recognise and compare; none
 * of them is sent. `select-alternative` carries a `placeId` because a place *is* its id — a name is
 * a label two places can share, and identity by label is how a swap silently lands somewhere else.
 *
 * ## Deliberately not a dialog
 *
 * Choosing between five nearby cafés means comparing them against the day around them: what is
 * before, what is after, how far the walk was. The same reason the time editor is inline.
 */
export function StopAlternatives({
  item,
  alternatives,
  busy,
  onSelect,
  onCancel,
}: {
  item: ItineraryItem;
  /** From `stopAlternatives`. Ordered, capped at five, and never empty when this renders. */
  alternatives: StopAlternative[];
  busy: boolean;
  onSelect: (placeId: string) => void;
  onCancel: () => void;
}) {
  const shared = sharedFacts(alternatives);

  return (
    <div
      data-testid="alternatives"
      data-item-id={item.id}
      className="flex flex-col gap-2"
    >
      {/*
       * A group rather than a listbox.
       *
       * These are buttons that each perform an edit, not options that set a value — a listbox would
       * promise selection semantics (a current value, arrow-key traversal) that pressing one of
       * these does not have. The label names the stop, because several can exist on a page.
       */}
      <div
        role="group"
        aria-label={`Alternatives for “${item.title}”`}
        aria-describedby={`alternatives-${item.id}-note`}
        className="flex flex-col gap-1.5"
      >
        {/*
         * The description, announced once when the group is entered.
         *
         * Carries the facts that hold for every option plus the caveat governing every distance
         * below it. Stating the straight-line caveat here rather than only inside each detail means
         * it is heard before the numbers rather than after each one.
         */}
        <p
          id={`alternatives-${item.id}-note`}
          className="text-[0.6875rem] leading-relaxed text-ink-muted text-pretty"
        >
          {shared.length > 0 ? `${shared.join(" · ")}. ` : ""}
          Distances are straight-line, not walking routes. Estimates are planning
          figures, not prices.
        </p>

        {alternatives.map((alternative) => (
          <AlternativeCard
            key={alternative.placeId}
            alternative={alternative}
            busy={busy}
            onSelect={onSelect}
          />
        ))}
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          data-testid="alternatives-cancel"
          className="rounded-full border border-line bg-cream-raised px-2.5 py-1 text-[0.6875rem] font-medium text-ink-muted transition-colors hover:text-forest disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * One alternative, as a single button.
 *
 * ## Why the whole card is the control
 *
 * One tap target rather than a card with a button in the corner: on a phone the corner button is
 * the smaller target and the card is what a thumb aims at anyway. It also keeps the accessible name
 * and the visible content identical — everything a sighted traveller compares is read out, in the
 * same order, rather than being reduced to "Swap, button" beside an unread block of facts.
 *
 * The visually-hidden "Swap in" prefix is what makes the name state an *action*. The visible name
 * follows it unchanged, so the accessible name still contains the visible label (WCAG 2.5.3).
 *
 * ## A refused option is disabled, not hidden
 *
 * `stopAlternatives` runs the real applier, so when one is refused we hold its reason. Showing the
 * option greyed with its sentence is the honest answer; dropping it from a list that claims to be
 * the alternatives is not. In practice this is near-unreachable — the picker filters on the same
 * predicate the applier enforces — which is exactly why it must not fail silently if it happens.
 */
function AlternativeCard({
  alternative,
  busy,
  onSelect,
}: {
  alternative: StopAlternative;
  busy: boolean;
  onSelect: (placeId: string) => void;
}) {
  const { canonicalPlace: place, schedulePreview: preview } = alternative;
  const refused = preview.status === "invalid";
  const distinguishing = alternative.relationFacts.filter(
    (relationFact) => !relationFact.universal,
  );

  return (
    <button
      type="button"
      disabled={busy || refused}
      onClick={() => onSelect(alternative.placeId)}
      data-testid="alternative-option"
      data-place-id={alternative.placeId}
      data-schedule-status={preview.status}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border bg-cream-raised px-2.5 py-2 text-left transition-colors disabled:opacity-60",
        refused
          ? "border-terracotta/50"
          : "border-line hover:border-forest-soft/60 hover:bg-sand/60",
      )}
    >
      <span className="flex items-start gap-1.5 text-xs font-medium text-ink">
        <MapPin aria-hidden className="mt-0.5 size-3 shrink-0 text-ink-muted" />
        <span className="min-w-0">
          <span className="sr-only">Swap in </span>
          {place.name}
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-[1.125rem] text-[0.6875rem] text-ink-muted">
        <span>{placeCategoryLabel(place)}</span>
        <span className="inline-flex items-center gap-1">
          <Clock aria-hidden className="size-2.5" />
          {formatTimeRange(preview.resultingStartTime, preview.resultingEndTime)}
        </span>
        <span>
          {alternative.estimatedCost.amount === 0
            ? "Free"
            : formatMoney(
                alternative.estimatedCost.amount,
                alternative.estimatedCost.currency,
              )}
        </span>
      </span>

      {distinguishing.length > 0 ? (
        <span className="flex flex-wrap gap-1 pl-[1.125rem]">
          {distinguishing.map((relationFact) => (
            <FactChip key={relationFact.kind} fact={relationFact} />
          ))}
        </span>
      ) : null}

      {/*
       * The routing consequence, as a count rather than a warning.
       *
       * A swap clears the measurements around the stop, so on a routed trip every option carries
       * this and a caution would mark all five while distinguishing none. What the traveller needs
       * is the number and the fact that recalculating is what fixes it.
       *
       * Rendered only when there is a number: a trip whose routes were never calculated has no
       * measurement to lose, and "0 travel times would need recalculating" is noise.
       */}
      {preview.affectedRouteLegIds.length > 0 ? (
        <span
          className="flex items-center gap-1 pl-[1.125rem] text-[0.625rem] text-ink-muted"
          data-testid="alternative-routes"
          data-leg-count={preview.affectedRouteLegIds.length}
        >
          <Route aria-hidden className="size-2.5" />
          {preview.affectedRouteLegIds.length} travel time
          {preview.affectedRouteLegIds.length === 1 ? "" : "s"} would need
          recalculating
        </span>
      ) : null}

      {refused && preview.refusalMessage ? (
        <span
          className="flex items-start gap-1 pl-[1.125rem] text-[0.625rem] text-terracotta"
          data-testid="alternative-refusal"
          data-refusal-code={preview.refusalCode}
        >
          <CircleAlert aria-hidden className="mt-px size-2.5 shrink-0" />
          <span>{preview.refusalMessage}</span>
        </span>
      ) : null}
    </button>
  );
}

/** One relation fact. `caution` is a confirmed problem; an unknown is not one. */
function FactChip({ fact }: { fact: AlternativeRelationFact }) {
  return (
    <span
      data-testid="alternative-fact"
      data-fact-kind={fact.kind}
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium",
        fact.tone === "caution"
          ? "bg-terracotta/15 text-terracotta"
          : "bg-sand text-forest",
      )}
    >
      {fact.label}
      {fact.detail ? (
        <span className="font-normal text-ink-muted"> · {fact.detail}</span>
      ) : null}
    </span>
  );
}

/**
 * The labels every option shares, for the group description.
 *
 * Reads the derivation's `universal` flag rather than comparing the lists, because the flag records
 * *why* the fact is shared — it follows from the same-category rule — where a comparison would also
 * lift a fact that happened to coincide across five options and then stop lifting it the moment a
 * sixth place joined the pool.
 *
 * Deduplicated by label: "Indoor option" is emitted per alternative and there is only one of it to
 * say.
 */
function sharedFacts(alternatives: StopAlternative[]): string[] {
  const labels = new Set<string>();

  for (const alternative of alternatives) {
    for (const fact of alternative.relationFacts) {
      if (fact.universal) labels.add(fact.label);
    }
  }

  return [...labels];
}
