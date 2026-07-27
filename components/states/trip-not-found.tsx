import { Compass, MapPinOff } from "lucide-react";
import Link from "next/link";

/**
 * Shown when a trip id has no matching plan in localStorage — a stale link, a
 * different browser, or cleared storage.
 *
 * This is a rendered state rather than a thrown `notFound()`: the trip only
 * exists client-side, so the miss is only knowable after hydration, and an
 * explicit panel explains *why* it is missing instead of showing a bare 404.
 */
export function TripNotFound({ tripId }: { tripId: string }) {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-20 sm:px-8">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl border border-line bg-cream-raised text-terracotta">
          <MapPinOff aria-hidden className="size-6" />
        </span>

        <div className="flex flex-col gap-2.5">
          <h1 className="font-display text-3xl text-forest">
            We couldn&apos;t find that trip
          </h1>
          <p className="text-sm leading-relaxed text-ink-muted text-pretty">
            Nothing is saved under{" "}
            <code className="rounded bg-sand px-1.5 py-0.5 font-mono text-xs text-ink">
              {tripId}
            </code>
            . Plans are stored in this browser only, so the link won&apos;t open
            on another device — and it disappears if site data is cleared.
          </p>
        </div>

        <Link
          href="/#builder"
          className="inline-flex items-center gap-2 rounded-full bg-forest px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-forest-soft"
        >
          <Compass aria-hidden className="size-4" />
          Plan a new trip
        </Link>
      </div>
    </main>
  );
}
