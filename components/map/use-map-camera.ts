"use client";

import { useEffect, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";

import {
  FIT_PADDING,
  MAX_FIT_ZOOM,
} from "@/lib/map/basemap";
import { cameraTargetFor, isWithinViewport } from "@/lib/map/bounds";
import { routeCoordinates } from "@/lib/map/routes";
import type {
  DayFilterValue,
  MapRouteLine,
  VisibleMapPlace,
} from "@/lib/map/types";

/**
 * Owns the camera. Nothing else in the app moves the map.
 *
 * Three separate concerns, deliberately kept in separate effects because they
 * fire on different triggers and must not interfere:
 *
 *  1. **Day change** refits the whole set of visible places. Keyed on the day and
 *     the place identities — *not* on selection, so choosing a marker never
 *     refits and throws away the zoom the user set.
 *  2. **Selection** pans only when the selected marker is outside a slightly
 *     inset viewport. A marker already comfortably on screen moves nothing, and
 *     the zoom level is never touched.
 *  3. **Becoming visible** (the mobile Plan→Map switch) resizes the canvas, and
 *     refits only when the camera has never been fitted against real dimensions
 *     or the container's geometry has since changed materially. A map initialised
 *     inside a `display: none` container measures 0×0, and bounds fitted for a
 *     wide viewport leave edge markers off-screen in a narrow one.
 */
export function useMapCamera({
  mapRef,
  places,
  routes = [],
  activeDayNumber,
  selectedItemId,
  isVisible,
  ready,
}: {
  mapRef: React.RefObject<MapRef | null>;
  places: VisibleMapPlace[];
  /**
   * Included in every fit. A routed path bulges outside the box its endpoints
   * describe — a one-way system, a river crossing, a road round a hill — so
   * fitting to the markers alone clips the route.
   */
  routes?: MapRouteLine[];
  activeDayNumber: DayFilterValue;
  selectedItemId: string | null;
  isVisible: boolean;
  ready: boolean;
}) {
  /**
   * The container dimensions the last successful fit was computed against, or
   * null if no fit has run against a real (non-zero) viewport yet.
   */
  const fittedSizeRef = useRef<{ width: number; height: number } | null>(null);

  // A stable key for "the set of places changed", so the fit effect does not
  // re-run on every render just because the array identity changed. Route
  // identities are folded in — not their coordinates, which would make the key
  // enormous for a 300-point walk — so an arriving route triggers one refit.
  const placesKey = [
    ...places.map((place) => `${place.itemId}@${place.longitude},${place.latitude}`),
    ...routes.map((route) => `${route.legId}#${route.coordinates.length}`),
  ].join("|");

  /**
   * Markers and route vertices together. Fitting to the markers alone leaves a
   * route that loops outside them clipped at the edge of the viewport.
   */
  const fitPoints = [...places, ...routeCoordinates(routes)];

  // 1 — refit when the day (or the resulting place set) changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const target = cameraTargetFor(fitPoints);
    if (target.type === "none") return;

    // Guard against fitting while the container is collapsed; effect 3 handles
    // the refit once it has real dimensions.
    const container = map.getContainer();
    const hasSize = container.clientWidth > 0 && container.clientHeight > 0;
    if (!hasSize) return;

    if (target.type === "bounds") {
      map.fitBounds(
        [
          [target.bounds.west, target.bounds.south],
          [target.bounds.east, target.bounds.north],
        ],
        { padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, duration: 600 },
      );
    } else {
      map.easeTo({
        center: [target.longitude, target.latitude],
        zoom: MAX_FIT_ZOOM,
        duration: 600,
      });
    }

    fittedSizeRef.current = {
      width: container.clientWidth,
      height: container.clientHeight,
    };
    // `placesKey` stands in for `places`; see note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, ready, activeDayNumber, placesKey]);

  // 2 — keep the selected marker in view, without changing zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selectedItemId) return;

    const selected = places.find((place) => place.itemId === selectedItemId);
    if (!selected) return;

    const bounds = map.getBounds();
    const viewport = {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    };

    if (isWithinViewport(selected, viewport)) return;

    map.easeTo({
      center: [selected.longitude, selected.latitude],
      duration: 400,
    });
    // Intentionally excludes `places`: this must react to the selection, not to
    // the list being rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, ready, selectedItemId]);

  // 3 — the container just became visible (mobile Plan → Map).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !isVisible) return;

    map.resize();

    const container = map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) return;

    /**
     * Refit only when the camera has never been fitted against real dimensions,
     * or when the container's geometry has changed materially since it was —
     * a device rotation, or a window crossing the split-screen breakpoint. Bounds
     * computed for a wide viewport leave edge markers off-screen in a narrow one.
     *
     * The 10% threshold keeps ordinary reflow (a scrollbar appearing, a mobile
     * toolbar collapsing) from throwing away a zoom the user set deliberately,
     * while still catching a breakpoint or orientation change.
     */
    const last = fittedSizeRef.current;
    const changedMaterially =
      last !== null &&
      (Math.abs(width - last.width) / last.width > 0.1 ||
        Math.abs(height - last.height) / last.height > 0.1);

    if (last !== null && !changedMaterially) return;

    const target = cameraTargetFor(fitPoints);
    if (target.type === "none") return;

    if (target.type === "bounds") {
      map.fitBounds(
        [
          [target.bounds.west, target.bounds.south],
          [target.bounds.east, target.bounds.north],
        ],
        // No animation: this is a first paint, not a transition, and animating
        // from a bogus zero-size camera is what produces the flicker.
        { padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, duration: 0 },
      );
    } else {
      map.jumpTo({
        center: [target.longitude, target.latitude],
        zoom: MAX_FIT_ZOOM,
      });
    }

    fittedSizeRef.current = { width, height };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapRef, ready, isVisible, placesKey]);
}
