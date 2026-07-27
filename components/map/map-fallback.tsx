"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Info, Navigation } from "lucide-react";

import { NumberedMarker } from "@/components/map/numbered-marker";
import { OSM_ATTRIBUTION_TEXT } from "@/lib/map/basemap";
import type { TripMapProps } from "@/lib/map/types";
import { projectPoints } from "@/lib/trip/project";
import { useState } from "react";

/**
 * The no-WebGL, no-tiles fallback.
 *
 * This is the Phase 1 placeholder, kept deliberately rather than deleted: when
 * MapLibre cannot start — no WebGL, blocked tile host, style fetch failure — a
 * schematic that still shows the shape of the day and stays clickable is far more
 * useful than an error box. It speaks the same `TripMapProps` contract as the
 * real map, so `MapPanel` can substitute one for the other.
 *
 * Pins are positioned by `projectPoints`, which preserves relative geography but
 * is not a map projection and offers no zoom or pan.
 */
export function MapFallback({
  places,
  selectedItemId,
  onSelectItem,
  dayLabel,
  reason,
}: Pick<TripMapProps, "places" | "selectedItemId" | "onSelectItem"> & {
  dayLabel: string;
  /** Shown to the user. Must stay plain language — no stack traces, no provider names. */
  reason?: string;
}) {
  const reduceMotion = useReducedMotion();
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);

  const points = projectPoints(
    places.map((place) => ({ lat: place.latitude, lng: place.longitude })),
  );

  const polyline = points
    .map((point) => `${point.xPct.toFixed(2)},${point.yPct.toFixed(2)}`)
    .join(" ");

  return (
    <div className="relative size-full overflow-hidden rounded-2xl border border-line bg-sand">
      {/* Schematic ground: graticule, a river band, two green masses. */}
      <div aria-hidden className="absolute inset-0">
        <svg
          className="size-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern
              id="roamly-fallback-grid"
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M8 0H0V8"
                fill="none"
                stroke="var(--line)"
                strokeWidth="0.3"
              />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#roamly-fallback-grid)" />
          <path
            d="M-5 78 C 20 70, 38 86, 62 76 S 92 68, 105 74 L 105 105 L -5 105 Z"
            fill="var(--forest)"
            opacity="0.09"
          />
          <ellipse cx="18" cy="24" rx="16" ry="11" fill="var(--forest)" opacity="0.07" />
          <ellipse cx="83" cy="42" rx="13" ry="9" fill="var(--forest)" opacity="0.07" />
        </svg>
      </div>

      {points.length > 1 ? (
        <svg
          aria-hidden
          className="absolute inset-0 size-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <polyline
            points={polyline}
            fill="none"
            stroke="var(--forest)"
            strokeOpacity="0.35"
            strokeWidth="0.5"
            strokeDasharray="1.6 1.4"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-cream-raised/90 px-2.5 py-1 text-[0.6875rem] font-medium text-forest backdrop-blur-sm">
          <Navigation aria-hidden className="size-3" />
          {dayLabel}
        </span>
      </div>

      <ul className="absolute inset-0 list-none">
        {places.map((place, index) => {
          const point = points[index];
          const selected = place.itemId === selectedItemId;
          return (
            <li
              key={place.itemId}
              className="absolute"
              style={{
                left: `${point.xPct}%`,
                top: `${point.yPct}%`,
                zIndex: selected ? 30 : 10,
              }}
            >
              <motion.div
                className="-translate-x-1/2 -translate-y-1/2"
                initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 420, damping: 28 }
                }
              >
                <NumberedMarker
                  place={place}
                  selected={selected}
                  hovered={place.itemId === hoveredItemId}
                  onSelect={() => onSelectItem(place.itemId, "map")}
                  onHoverChange={(hovered) =>
                    setHoveredItemId(hovered ? place.itemId : null)
                  }
                />
              </motion.div>
            </li>
          );
        })}
      </ul>

      {places.length === 0 ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <p className="max-w-xs text-center text-sm text-ink-muted">
            No mapped stops for this day.
          </p>
        </div>
      ) : null}

      {/*
       * `pointer-events-none`: this overlay sits on top of the markers, and a
       * status message must never swallow a click meant for the stop underneath.
       */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1.5 p-3">
        {reason ? (
          <p
            role="status"
            className="flex items-start gap-1.5 rounded-lg border border-line bg-cream-raised/95 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-ink backdrop-blur-sm"
          >
            <Info aria-hidden className="mt-px size-3 shrink-0 text-terracotta" />
            <span>{reason}</span>
          </p>
        ) : null}
        {/* Attribution stays visible even in the fallback. */}
        <p className="self-end rounded bg-cream-raised/90 px-1.5 py-0.5 text-[0.625rem] text-ink-muted">
          {OSM_ATTRIBUTION_TEXT}
        </p>
      </div>
    </div>
  );
}
