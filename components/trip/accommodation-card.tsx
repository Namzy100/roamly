import { BedDouble, Check, MapPin, SearchX } from "lucide-react";

import { formatMoney } from "@/lib/format";
import type { AccommodationRecommendation, Currency } from "@/lib/schemas";

export function AccommodationCard({
  accommodation,
  currency,
}: {
  accommodation: AccommodationRecommendation | null;
  currency: Currency;
}) {
  if (accommodation === null) return <NoAccommodation />;

  const { place } = accommodation;

  return (
    <section
      aria-labelledby="stay-heading"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          id="stay-heading"
          className="flex items-center gap-2 font-display text-lg text-forest"
        >
          <BedDouble aria-hidden className="size-4 text-terracotta" />
          Where you&apos;ll stay
        </h3>
        <span className="shrink-0 rounded-full border border-terracotta/40 bg-terracotta/10 px-2 py-0.5 text-[0.6875rem] font-semibold text-terracotta">
          Estimate
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <p className="font-display text-xl leading-snug text-forest">
          {place.name}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-ink-muted">
          <MapPin aria-hidden className="size-3" />
          {accommodation.neighborhood}
          {/*
            * No rating. OpenStreetMap supplies none for a hotel any more than for a café, so this only ever rendered for the
            * mock sample — see the note in `itinerary-item-card.tsx` for the full reasoning.
            */}
        </p>
      </div>

      <div className="flex items-baseline justify-between gap-3 border-y border-line py-2.5">
        <span className="text-xs text-ink-muted">
          {formatMoney(accommodation.nightlyRate, currency)} ×{" "}
          {accommodation.nights}{" "}
          {accommodation.nights === 1 ? "night" : "nights"}
        </span>
        <span className="font-display text-xl text-forest">
          {formatMoney(accommodation.total, currency)}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-ink-muted text-pretty">
        {accommodation.whyItFits}
      </p>

      <ul className="flex flex-col gap-1.5">
        {accommodation.amenities.map((amenity) => (
          <li
            key={amenity}
            className="flex items-start gap-1.5 text-xs text-ink"
          >
            <Check aria-hidden className="mt-0.5 size-3 shrink-0 text-forest" />
            {amenity}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * No stay to recommend, said plainly.
 *
 * The alternative — a plausible-looking hotel nobody searched for — is the exact
 * fabrication the pool boundary exists to prevent, and it would be the easiest
 * place in the app to slip one in. A gap the traveller can see is the honest
 * outcome, and it tells them something true: this destination's map data is thin
 * on places to stay.
 */
function NoAccommodation() {
  return (
    <section
      aria-labelledby="stay-heading"
      data-testid="accommodation-unavailable"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <h3
        id="stay-heading"
        className="flex items-center gap-2 font-display text-lg text-forest"
      >
        <BedDouble aria-hidden className="size-4 text-terracotta" />
        Where you&apos;ll stay
      </h3>

      <p className="flex items-start gap-2 text-sm leading-relaxed text-ink-muted text-pretty">
        <SearchX aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          The place search found no hotel, hostel or guest house mapped in
          OpenStreetMap near this destination, so there is nothing to recommend
          here. Rather than suggest somewhere that was never found, this is left
          for you to book yourself — the itinerary works from the centre of town.
        </span>
      </p>
    </section>
  );
}
