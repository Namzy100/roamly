"use client";

import dynamic from "next/dynamic";
import { useCallback, useState, useSyncExternalStore } from "react";

import { MapErrorBoundary } from "@/components/map/map-error-boundary";
import { MapFallback } from "@/components/map/map-fallback";
import type { TripMapProps } from "@/lib/map/types";

/**
 * MapLibre is loaded only in the browser and only for this panel.
 *
 * `ssr: false` keeps `maplibre-gl` out of the server bundle — it touches `window`
 * at module scope — and splits the map code out of the landing page's chunk,
 * which never shows a map. Its `loading` state doubles as the initial skeleton.
 */
const TripMap = dynamic(
  () => import("@/components/map/trip-map").then((mod) => mod.TripMap),
  { ssr: false, loading: () => <MapSkeleton /> },
);

const FALLBACK_MESSAGE =
  "The map couldn't load right now, so here's a simplified view. Every stop is still listed and selectable.";
const NO_WEBGL_MESSAGE =
  "Your browser can't display the interactive map, so here's a simplified view. Every stop is still listed and selectable.";

/**
 * Decides *which* map renders, and degrades in one place.
 *
 * The itinerary must stay usable whatever happens here, so every failure path
 * lands on `MapFallback` — still interactive, still showing the day's shape —
 * rather than on an error message where the map used to be.
 */
export function MapPanel({
  places,
  routes,
  selectedItemId,
  activeDayNumber,
  onSelectItem,
  dayLabel,
  isVisible = true,
}: TripMapProps & { dayLabel: string; isVisible?: boolean }) {
  const webGlSupported = useWebGlSupport();
  // Set from MapLibre's error callback and the error boundary — both event
  // handlers, never an effect.
  const [runtimeFailed, setRuntimeFailed] = useState(false);

  const handleError = useCallback(() => setRuntimeFailed(true), []);

  const fallback = (
    <MapFallback
      places={places}
      selectedItemId={selectedItemId}
      onSelectItem={onSelectItem}
      dayLabel={dayLabel}
      reason={webGlSupported ? FALLBACK_MESSAGE : NO_WEBGL_MESSAGE}
    />
  );

  if (!webGlSupported || runtimeFailed) return fallback;

  return (
    <MapErrorBoundary onError={handleError} fallback={fallback}>
      <TripMap
        places={places}
        routes={routes}
        selectedItemId={selectedItemId}
        activeDayNumber={activeDayNumber}
        onSelectItem={onSelectItem}
        dayLabel={dayLabel}
        isVisible={isVisible}
        onError={handleError}
      />
    </MapErrorBoundary>
  );
}

/** Matches the map panel's footprint so the swap does not shift the layout. */
export function MapSkeleton() {
  return (
    <div
      className="size-full animate-pulse rounded-2xl border border-line bg-sand"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading the map…</span>
    </div>
  );
}

/**
 * WebGL support, read as an external store.
 *
 * Capability never changes during a session, so `subscribe` is a no-op and the
 * value is probed once and cached at module scope. `getServerSnapshot` optimises
 * for the common case (supported); if the client disagrees,
 * `useSyncExternalStore` re-renders after hydration without a mismatch warning.
 */
const noopSubscribe = () => () => {};

let webGlProbe: boolean | null = null;

function readWebGlSupport(): boolean {
  // Test hook: lets the browser-verification script force the fallback path
  // without disabling WebGL at the browser level.
  if (
    typeof window !== "undefined" &&
    (window as { __roamlyForceMapFallback?: boolean }).__roamlyForceMapFallback
  ) {
    return false;
  }

  if (webGlProbe !== null) return webGlProbe;
  webGlProbe = probeWebGl();
  return webGlProbe;
}

function useWebGlSupport(): boolean {
  return useSyncExternalStore(noopSubscribe, readWebGlSupport, () => true);
}

/**
 * Detects WebGL without instantiating MapLibre.
 *
 * The probe context is released immediately: browsers cap the number of live
 * WebGL contexts, and leaking one can starve the real map.
 */
function probeWebGl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!context) return false;

    const lose = (context as WebGLRenderingContext).getExtension?.(
      "WEBGL_lose_context",
    ) as { loseContext(): void } | null;
    lose?.loseContext();

    return true;
  } catch {
    return false;
  }
}
