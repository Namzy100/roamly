import { ExternalLink, Info, PlaneTakeoff } from "lucide-react";

import { formatMoney } from "@/lib/format";
import type { Currency, FlightEstimate } from "@/lib/schemas";

/**
 * Flight figures are always estimates in this product — there is no live
 * inventory and no booking. The "Estimate" badge, the basis line, and the
 * outbound search link are all mandatory: an unlabelled number sitting beside
 * real restaurant costs would read as a bookable fare.
 */
export function FlightEstimateCard({
  flights,
  currency,
  travelers,
}: {
  flights: FlightEstimate;
  currency: Currency;
  travelers: number;
}) {
  return (
    <section
      aria-labelledby="flights-heading"
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          id="flights-heading"
          className="flex items-center gap-2 font-display text-lg text-forest"
        >
          <PlaneTakeoff aria-hidden className="size-4 text-terracotta" />
          Flights
        </h3>
        <span className="shrink-0 rounded-full border border-terracotta/40 bg-terracotta/10 px-2 py-0.5 text-[0.6875rem] font-semibold text-terracotta">
          Estimate
        </span>
      </div>

      <p className="text-sm text-ink">
        {flights.departureCity} → {flights.destinationCity}
      </p>

      <div className="flex items-baseline gap-2">
        <span className="font-display text-2xl text-forest">
          {formatMoney(flights.total, currency)}
        </span>
        <span className="text-xs text-ink-muted">
          {formatMoney(flights.perTraveler, currency)} × {travelers}
        </span>
      </div>

      <dl className="flex flex-col gap-1 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Cabin</dt>
          <dd className="text-ink">{flights.cabin}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Duration</dt>
          <dd className="text-ink">{flights.typicalDuration}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Routing</dt>
          <dd className="text-right text-ink">{flights.typicalStops}</dd>
        </div>
      </dl>

      <p className="flex items-start gap-1.5 rounded-lg bg-sand/50 p-2.5 text-[0.6875rem] leading-relaxed text-ink-muted">
        <Info aria-hidden className="mt-px size-3 shrink-0" />
        <span>{flights.basis}</span>
      </p>

      <a
        href={flights.searchUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-forest px-4 py-2 text-sm font-medium text-forest transition-colors hover:bg-forest hover:text-primary-foreground"
      >
        Check live fares
        <ExternalLink aria-hidden className="size-3.5" />
      </a>
    </section>
  );
}
