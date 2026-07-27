"use client";

import { MapPin, Star } from "lucide-react";

import {
  PRICE_LEVEL_LABELS,
  placeCategoryLabel,
  type ItineraryItem,
  type TripPlace,
} from "@/lib/schemas";

/**
 * The places this stop could become.
 *
 * ## Every option here is selectable
 *
 * The list comes from `alternativesForItem`, which filters on `alternativeIsSelectable` — the same
 * predicate, asked in the same order, that the applier enforces. So this component does no gating of
 * its own: an option it renders is one the save will accept. A picker that had to explain why a
 * choice failed after the fact would be a picker nobody trusts twice.
 *
 * ## A `placeId` leaves here and nothing else
 *
 * The name, rating and category are rendered so a traveller can recognise the place; none of them is
 * sent. `select-alternative` carries a `placeId` because a place *is* its id — a name is a label two
 * places can share, and identity by label is how a swap silently lands somewhere else.
 *
 * ## Deliberately not a dialog
 *
 * Choosing between six nearby cafés means comparing them against the day around them: what is
 * before, what is after, how far the walk was. The same reason the time editor is inline.
 */
export function StopAlternatives({
  item,
  places,
  busy,
  onSelect,
  onCancel,
}: {
  item: ItineraryItem;
  /** From `alternativesForItem`. Ordered open-first, capped, and never empty when this renders. */
  places: TripPlace[];
  busy: boolean;
  onSelect: (placeId: string) => void;
  onCancel: () => void;
}) {
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
       * promise selection semantics (a current value, arrow-key traversal) that pressing one of these
       * does not have. The label names the stop, because several of these can exist on a page.
       */}
      <div
        role="group"
        aria-label={`Alternatives for “${item.title}”`}
        className="flex flex-col gap-1.5"
      >
        {places.map((place) => (
          <button
            key={place.placeId}
            type="button"
            disabled={busy}
            onClick={() => onSelect(place.placeId)}
            data-testid="alternative-option"
            data-place-id={place.placeId}
            className="flex w-full flex-col gap-0.5 rounded-lg border border-line bg-cream-raised px-2.5 py-2 text-left transition-colors hover:border-forest-soft/60 hover:bg-sand/60 disabled:opacity-50"
          >
            <span className="flex items-start gap-1.5 text-xs font-medium text-ink">
              <MapPin
                aria-hidden
                className="mt-0.5 size-3 shrink-0 text-ink-muted"
              />
              <span className="min-w-0">{place.name}</span>
            </span>

            <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-[1.125rem] text-[0.6875rem] text-ink-muted">
              <span>{placeCategoryLabel(place)}</span>
              {place.rating !== undefined ? (
                <span className="inline-flex items-center gap-1">
                  <Star
                    aria-hidden
                    className="size-2.5 fill-terracotta text-terracotta"
                  />
                  <span className="font-medium text-ink">{place.rating}</span>
                  {place.userRatingCount !== undefined ? (
                    <span>
                      ({place.userRatingCount.toLocaleString("en-GB")})
                    </span>
                  ) : null}
                </span>
              ) : null}
              {place.priceLevel ? (
                <span>{PRICE_LEVEL_LABELS[place.priceLevel]}</span>
              ) : null}
            </span>
          </button>
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
