"use client";

import {
  CalendarCheck,
  CircleSlash,
  Lightbulb,
  MapPin,
  MapPinOff,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { formatMoney, formatTimeRange } from "@/lib/format";
import type { OpeningEvaluation } from "@/lib/opening-hours";
import {
  deriveLandmarkCardIntelligence,
  type IsoTimestamp,
  type PlaceIntelligence,
} from "@/lib/place-intelligence";
import { describeLandmarkContext } from "@/lib/trip/landmark-context";
import {
  ITEM_KIND_LABELS,
  placeCategoryLabel,
  type Currency,
  type ItineraryItem,
} from "@/lib/schemas";
import {
  cardElementId,
  cardTitleId,
  selectionLabelFor,
} from "@/lib/trip/item-card";
import { cn } from "@/lib/utils";

import { LandmarkContext } from "./landmark-context";
import { OpeningHoursBadge } from "./opening-hours-badge";

/**
 * One stop in the plan.
 *
 * ## Why this is no longer a single button
 *
 * Through Phase 7 the entire card was one `<button aria-pressed>`. That was the right shape while
 * selecting was the only thing a card could do: keyboard-reachable, self-announcing, and safe
 * precisely because it held nothing interactive inside it. The cost was that *nothing* could ever go
 * inside it — a button inside a button is invalid HTML that browsers resolve inconsistently — so the
 * replace and move controls had to sit outside the card, in the panel, visually orphaned from the
 * stop they act on.
 *
 * Phase 8 needs a per-stop menu, a time editor and eventually a drag handle. So the card becomes a
 * semantic `<article>` and selection becomes *one explicit control* inside it.
 *
 * ## The overlay, and why not a small button
 *
 * The selection control is an `absolute inset-0` button sitting *beneath* the content. That keeps the
 * whole card surface clickable — shrinking selection down to the number badge would have been a real
 * usability regression on touch — while leaving exactly one element that carries `aria-pressed`.
 * The content layer is `pointer-events-none` so presses fall through to it; the action row opts back
 * in with its own stacking context. No interactive element is nested inside another.
 *
 * Focus is unchanged in kind: the overlay is the single tab stop for selection, and the global
 * `:focus-visible` outline in `globals.css` draws around the whole card because the overlay spans it.
 *
 * ## Hover is on the region, not the control
 *
 * Mouse hover moved up to the `<article>` so that pointing at an action button does not read as
 * leaving the card and drop the map's highlight. Focus and blur stay on the selection control, which
 * preserves exactly the pre-existing behaviour: tabbing to an action does not move the map.
 */
export function ItineraryItemCard({
  item,
  dayNumber,
  displayNumber,
  currency,
  selected,
  hovered,
  dragging = false,
  openingHours,
  intelligence,
  now,
  onSelect,
  onHoverChange,
  actions,
  editor,
}: {
  item: ItineraryItem;
  /**
   * The day this card belongs to.
   *
   * Rendered as `data-day-number` because a reorder measures the cards it may drop between, and
   * "All days" puts every day's cards in one document. Without it a drag would count another day's
   * stops when deciding which gap the pointer is over. See `lib/hooks/use-item-reorder.ts`.
   */
  dayNumber: number;
  displayNumber: number;
  currency: Currency;
  selected: boolean;
  /** True when the matching map pin is hovered or focused. */
  hovered: boolean;
  /**
   * This card is the one being dragged.
   *
   * It keeps its place in the layout rather than being lifted out of flow: nothing reflows, so the
   * positions measured once at drag start stay true for the whole drag, and where it would land is
   * shown by an indicator rather than by a hole opening up.
   */
  dragging?: boolean;
  /**
   * What the published hours say about this stop, from the one authority.
   *
   * Passed in rather than derived here: the panel's accuracy summary and this badge must
   * agree, and two derivations of the same verdict would eventually disagree — with the
   * one on the card being the one a traveller actually reads.
   */
  openingHours?: OpeningEvaluation;
  /**
   * This stop's landmark enrichment, and nothing else's (Checkpoint 5B, section 10C).
   *
   * One entry, not the sidecar. A card handed the whole record would be one lookup away from rendering another
   * landmark's history under this stop's heading, which is the worst failure available here — and
   * `deriveLandmarkCardIntelligence` refuses a mismatched `canonicalPlaceId` precisely because that mistake is easy
   * to make one level up.
   *
   * Absent for every trip that has never been enriched, which is the ordinary case.
   */
  intelligence?: PlaceIntelligence | null;
  /**
   * The clock, supplied by the workspace and stable for the session.
   *
   * A parameter because freshness is a display gate: a stale description renders with a label and an expired
   * thumbnail does not render at all, and a card reading the clock itself would decide that differently on every
   * re-render — so a label could appear mid-hover. Without it the enrichment region is simply not rendered, since a
   * gate with no clock cannot be applied honestly.
   */
  now?: IsoTimestamp;
  onSelect: () => void;
  onHoverChange: (hovered: boolean) => void;
  /**
   * Controls that act on this stop, supplied by the panel.
   *
   * A slot rather than a fixed set of props: which actions a stop offers depends on the trip's
   * capabilities (a saved pool, a configured planner) and on the stop's own locks, and all of that
   * is already decided one level up. The card's job is to give them a place to live that is legal
   * HTML and reachable by keyboard.
   */
  actions?: ReactNode;
  /**
   * An editor this stop has opened — a time editor, a list of alternatives.
   *
   * A second slot rather than more `actions`, because it is a different thing in the same card: the
   * action row is a row of triggers of a fixed height, and this is a panel that appears because the
   * traveller asked for it. Rendering it here rather than in a dialog is what the inline editing
   * decision means in markup — the stop stays on screen, in its day, while its times change.
   *
   * The panel decides which stop may have one open, so a card never has to know about its siblings.
   */
  editor?: ReactNode;
}) {
  const { place } = item;
  const unavailable = item.status === "unavailable";

  /**
   * What this stop's enrichment permits showing.
   *
   * Two pure steps, in this order and nowhere else: `deriveLandmarkCardIntelligence` applies the trust, eligibility,
   * freshness and licence gates, and `describeLandmarkContext` turns what survived into rows. Both are memoised on
   * their inputs — not for speed, but so the region does not get a new object identity on every hover and re-render
   * the image beneath it.
   *
   * `null` whenever there is no clock, no place or nothing that passed. A card with no context renders no region at
   * all, which is why there is one `landmark` value rather than three conditions in the markup.
   */
  const landmark = useMemo(() => {
    if (!place || !now) return null;

    const derived = deriveLandmarkCardIntelligence({ place, intelligence, now });
    return describeLandmarkContext(derived);
  }, [place, intelligence, now]);

  return (
    <article
      id={cardElementId(item.id)}
      aria-labelledby={cardTitleId(item.id)}
      data-testid="itinerary-item"
      data-item-id={item.id}
      data-day-number={dayNumber}
      data-selected={selected ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      className={cn(
        "group/item relative w-full scroll-mt-6 rounded-2xl border bg-cream-raised p-4 text-left transition-all duration-200 sm:p-5",
        selected
          ? "border-terracotta shadow-raised ring-1 ring-terracotta"
          : hovered
            ? "border-forest-soft/60 shadow-card"
            : "border-line hover:border-forest-soft/50 hover:shadow-card",
        /*
         * Dimmed and outlined rather than moved.
         *
         * The card is the thing being carried, so it has to look picked up — but it must not change
         * size or leave the flow, because the drag's arithmetic rests on the list standing still.
         * Opacity and a dashed ring say "this one" without moving a pixel.
         */
        dragging && "opacity-60 ring-2 ring-dashed ring-forest-soft",
      )}
    >
      {/*
       * The one selection control.
       *
       * Beneath the content and spanning the card, so the entire surface still selects while only
       * this element carries `aria-pressed`. Its label is built in `lib/trip/item-card.ts` — the
       * card's own accessible name is the heading, which is a different and shorter thing.
       */}
      <button
        type="button"
        onClick={onSelect}
        onFocus={() => onHoverChange(true)}
        onBlur={() => onHoverChange(false)}
        aria-pressed={selected}
        aria-label={selectionLabelFor({ item, displayNumber })}
        data-testid="select-stop"
        data-item-id={item.id}
        className="absolute inset-0 z-0 rounded-2xl"
      />

      <div className="pointer-events-none relative flex gap-3.5 sm:gap-4">
        {/* Number — the shared handle between this card and its map pin. */}
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border font-display text-sm font-semibold transition-colors",
            selected
              ? "border-terracotta bg-terracotta text-accent-foreground"
              : "border-line bg-sand/70 text-forest group-hover/item:border-forest-soft/60",
          )}
        >
          {displayNumber}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs tabular-nums text-ink-muted">
              {formatTimeRange(item.startTime, item.endTime)}
            </span>
            <Badge
              variant="secondary"
              className="h-5 rounded-full px-2 text-[0.6875rem] font-medium"
            >
              {item.mealType
                ? item.mealType[0].toUpperCase() + item.mealType.slice(1)
                : ITEM_KIND_LABELS[item.kind]}
            </Badge>
            {item.bookingRequired ? (
              <span className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-terracotta">
                <CalendarCheck aria-hidden className="size-3" />
                Book ahead
              </span>
            ) : null}
            {/*
             * An unfilled slot stays in the itinerary so the gap is visible, but
             * it carries no map marker — hence the explicit note, rather than
             * leaving the traveller to wonder why no pin lights up.
             */}
            {unavailable ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-sand px-2 py-0.5 text-[0.6875rem] font-medium text-ink-muted">
                <CircleSlash aria-hidden className="size-3" />
                Not on the map
              </span>
            ) : null}
            {openingHours ? (
              <OpeningHoursBadge evaluation={openingHours} />
            ) : null}
          </div>

          <h4
            id={cardTitleId(item.id)}
            className="font-display text-lg leading-snug text-forest"
          >
            {item.title}
          </h4>

          {place ? (
            <div className="flex flex-col gap-1">
              <p className="flex items-start gap-1.5 text-sm font-medium text-ink">
                <MapPin
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-ink-muted"
                />
                <span className="min-w-0">{place.name}</span>
              </p>
              <p className="pl-5 text-xs text-ink-muted">{place.address}</p>
            </div>
          ) : (
            <p className="flex items-start gap-1.5 text-sm text-ink-muted">
              <MapPinOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>No fixed location — this one is yours to shape.</span>
            </p>
          )}

          <p className="text-sm leading-relaxed text-ink-muted text-pretty">
            {item.rationale}
          </p>

          {item.tip ? (
            <p className="flex items-start gap-1.5 rounded-lg bg-sand/50 p-2.5 text-xs leading-relaxed text-ink">
              <Lightbulb
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-terracotta"
              />
              <span>{item.tip}</span>
            </p>
          ) : null}

          <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
            {/*
              * The category, and no ranking signal beside it.
              *
              * `TripPlace` can carry `rating`, `userRatingCount` and `priceLevel`, and this row used to render all three.
              * They are gone, for a reason `docs/PROVIDER_RESEARCH.md` settled: OpenStreetMap supplies none of them, so they
              * existed **only** on the mock sample — visible on the demo trip and absent from every real one.
              *
              * That inconsistency is the argument. A star rating that appears for one trip and not the next is not a feature
              * with patchy coverage; it is an interface making a claim it can only sometimes support, and the traveller has
              * no way to know which case they are looking at.
              *
              * Nor will they ever be filled in. Checkpoint 5A rejected Google (no caching of Places content) and Yelp
              * (24-hour storage cap, no blending with other sources), and no accepted provider supplies a rating under terms
              * Roamly can meet. These were not placeholders waiting for data — they were dead UI.
              *
              * The schema keeps the fields: they are real facts about the mock fixture, and `lib/schemas/place.ts` already
              * documents them as mock-only. What changed is that no product surface reads them.
              */}
            <div className="flex items-center gap-3 text-xs text-ink-muted">
              {place ? <span>{placeCategoryLabel(place)}</span> : null}
            </div>

            <div className="text-right">
              <span className="font-display text-base text-forest">
                {item.estimatedCost === 0
                  ? "Free"
                  : formatMoney(item.estimatedCost, currency)}
              </span>
              {item.costNote ? (
                <span className="block text-[0.6875rem] text-ink-muted">
                  {item.costNote}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/*
       * The landmark region.
       *
       * `relative z-10` and a sibling of the `pointer-events-none` content, for the same reason the action row is: it
       * contains a disclosure and external links, and rendering it beneath the selection overlay would hand every
       * one of those clicks to a button whose job is to select the stop. Pressing "details" or a licence link must
       * not select the card.
       *
       * Below the stop's own details and above its actions, which is the order a traveller reads: what this place is,
       * then what it is historically, then what they can do to it.
       */}
      {landmark ? (
        <div
          data-testid="item-landmark"
          className="relative z-10 mt-3 border-t border-line/60 pt-3"
        >
          <LandmarkContext view={landmark} itemId={item.id} />
        </div>
      ) : null}

      {/*
       * The action row.
       *
       * `relative z-10` puts it above the selection overlay, and it is a sibling of the
       * `pointer-events-none` content rather than a descendant, so its buttons receive presses
       * normally and pressing one does not also select the card.
       */}
      {actions ? (
        <div
          data-testid="item-actions"
          className="relative z-10 mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-line/60 pt-3"
        >
          {actions}
        </div>
      ) : null}

      {/*
       * The open editor, beneath its own triggers.
       *
       * `relative z-10` for the same reason the action row has it: the selection overlay spans the
       * whole card, and an editor rendered under it would have its fields swallowed by a control
       * whose job is to select the stop. Sibling of the `pointer-events-none` content, never a
       * descendant.
       */}
      {editor ? (
        <div
          data-testid="item-editor"
          className="relative z-10 mt-3 border-t border-line/60 pt-3"
        >
          {editor}
        </div>
      ) : null}
    </article>
  );
}
