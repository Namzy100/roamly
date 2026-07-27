import {
  Bike,
  Bus,
  Car,
  Footprints,
  Loader2,
  RefreshCw,
  RouteOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatDistance, formatDuration } from "@/lib/format";
import { ESTIMATE_LABEL, ROUTED_BASIS_LABEL } from "@/lib/routing";
import {
  TRAVEL_MODE_LABELS,
  type TravelMode,
  type TravelSegment,
} from "@/lib/schemas";

const MODE_ICONS: Record<TravelMode, LucideIcon> = {
  WALK: Footprints,
  TRANSIT: Bus,
  DRIVE: Car,
  BICYCLE: Bike,
};

/** A long hop is worth flagging visually — it is the thing that ruins days. */
const LONG_LEG_MINUTES = 45;

/**
 * One leg between two stops, rendered according to what we actually know.
 *
 * Three visually distinct states, because they are three different claims:
 *
 *  - **routed** — a measured duration and distance, credited to OpenStreetMap
 *    road data. No hedging, because there is nothing to hedge.
 *  - **estimated** — the same figures with "Estimated" attached and the basis
 *    available. Never dressed up as measured.
 *  - **unavailable** — "Route unavailable" and the reason. No number is shown,
 *    not even a zero, and no line is drawn on the map.
 *
 * Wording is constrained: never "live traffic", "fastest right now", "real-time
 * conditions" or "transit route". Valhalla routes over OpenStreetMap geometry
 * with a costing profile, and this deployment has no traffic or transit feed.
 */
export function TravelSegmentRow({
  segment,
  onRetry,
  retrying = false,
}: {
  segment: TravelSegment;
  /**
   * Offered on an unavailable leg only (Phase 6A).
   *
   * A routed leg has nothing to retry and an estimate is not a failure — putting a
   * button on either would invite requests that cost a donated server something and
   * the traveller nothing.
   */
  onRetry?: (legId: string) => void;
  retrying?: boolean;
}) {
  if (segment.status === "unavailable") {
    return (
      <SegmentShell>
        <span
          className="inline-flex items-center gap-1.5 text-ink-muted"
          data-testid="travel-segment"
          data-status="unavailable"
          data-leg-id={segment.id}
        >
          <RouteOff aria-hidden className="size-3.5" />
          <span className="font-medium text-ink">Route unavailable</span>
        </span>
        <span className="text-ink-muted">·</span>
        <span className="text-ink-muted">{segment.userMessage}</span>

        {onRetry ? (
          <button
            type="button"
            onClick={() => onRetry(segment.id)}
            disabled={retrying}
            data-testid="retry-route"
            data-leg-id={segment.id}
            className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-medium text-forest transition-colors hover:border-forest-soft/60 hover:bg-sand/60 disabled:opacity-50"
          >
            {retrying ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : (
              <RefreshCw aria-hidden className="size-3" />
            )}
            Retry
          </button>
        ) : null}
      </SegmentShell>
    );
  }

  const Icon = MODE_ICONS[segment.mode];
  const minutes =
    segment.status === "routed"
      ? segment.durationMinutes
      : segment.estimatedDurationMinutes;
  const meters =
    segment.status === "routed"
      ? segment.distanceMeters
      : segment.estimatedDistanceMeters;
  const isLong = minutes >= LONG_LEG_MINUTES;

  return (
    <SegmentShell>
      <span
        className="inline-flex items-center gap-1.5 text-ink-muted"
        data-testid="travel-segment"
        data-status={segment.status}
        data-mode={segment.mode}
      >
        <Icon aria-hidden className="size-3.5" />
        <span className="font-medium text-ink">
          {TRAVEL_MODE_LABELS[segment.mode]}
        </span>
      </span>

      <span className="text-ink-muted">·</span>
      <span className={isLong ? "font-medium text-terracotta" : "text-ink-muted"}>
        {formatDuration(minutes)}
      </span>

      {meters !== undefined ? (
        <>
          <span className="text-ink-muted">·</span>
          <span className="text-ink-muted">{formatDistance(meters)}</span>
        </>
      ) : null}

      {/*
       * The provenance chip. Present on both arms and worded differently, so a
       * reader never has to guess which kind of number they are looking at.
       * `title` carries the longer explanation without spending a line on it.
       */}
      <span
        className="rounded-full bg-sand px-2 py-0.5 text-[0.625rem] text-forest"
        title={
          segment.status === "routed"
            ? "Computed from OpenStreetMap road data. Not live traffic."
            : segment.disclaimer
        }
        data-testid="segment-basis"
      >
        {segment.status === "routed" ? ROUTED_BASIS_LABEL : ESTIMATE_LABEL}
      </span>

      {segment.note ? (
        <span className="w-full text-ink-muted sm:w-auto">
          <span className="hidden sm:inline">· </span>
          {segment.note}
        </span>
      ) : null}
    </SegmentShell>
  );
}

/** The dotted rail that continues the vertical line between two stops. */
function SegmentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 pl-4 sm:pl-5">
      <div
        aria-hidden
        className="ml-[0.4375rem] flex w-px flex-col items-center self-stretch border-l border-dashed border-line"
      />
      <div className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-2.5 text-xs">
        {children}
      </div>
    </div>
  );
}
