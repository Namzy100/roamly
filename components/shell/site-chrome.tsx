import Link from "next/link";

import { OfflineBanner } from "@/components/shell/offline-banner";

/** The compass rose doubles as the wordmark glyph. */
function Mark() {
  return (
    <span
      aria-hidden
      className="flex size-8 items-center justify-center rounded-lg bg-forest text-primary-foreground"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none">
        <path
          d="M12 2.5 14.6 9.4 21.5 12l-6.9 2.6L12 21.5 9.4 14.6 2.5 12l6.9-2.6z"
          fill="currentColor"
          opacity="0.9"
        />
      </svg>
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-cream/85 backdrop-blur-md">
      {/* Above the chrome, so it is the first thing read when connectivity drops. */}
      <OfflineBanner />
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-lg"
          aria-label="Roamly home"
        >
          <Mark />
          <span className="font-display text-xl tracking-tight text-forest">
            Roamly
          </span>
        </Link>

        <div className="flex items-center gap-2">
          {/*
            * "Portfolio prototype", not "demo build · sample data".
            *
            * The old wording was true when every itinerary was a fixture. It is now false: trips are
            * built from real OpenStreetMap places, and telling a visitor otherwise undersells the
            * product *and* misdescribes it. "Prototype" is the honest word — it is not production
            * infrastructure and does not claim to be.
            */}
          <span className="hidden rounded-full border border-line bg-cream-raised px-3 py-1 text-xs text-ink-muted sm:inline-flex">
            Portfolio prototype
          </span>
          <Link
            href="/#builder"
            className="rounded-full bg-forest px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-forest-soft"
          >
            Plan a trip
          </Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-cream">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <p className="text-sm text-ink-muted">
          Roamly — a portfolio prototype. Places come from OpenStreetMap; every price is an estimate.
        </p>
        <p className="text-xs text-ink-muted">
          Flight and stay figures are estimates, never live quotes.
        </p>
      </div>
    </footer>
  );
}
