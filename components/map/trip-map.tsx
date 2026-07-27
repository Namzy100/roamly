"use client";

import "maplibre-gl/dist/maplibre-gl.css";

import { Navigation } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  AttributionControl,
  Layer,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Source,
  type MapRef,
} from "react-map-gl/maplibre";

import { NumberedMarker } from "@/components/map/numbered-marker";
import { useMapCamera } from "@/components/map/use-map-camera";
import {
  BASEMAP_STYLE_URL,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
} from "@/lib/map/basemap";
import { buildRouteGeoJson } from "@/lib/map/routes";
import { buildSequenceGeoJson } from "@/lib/map/sequence";
import type { TripMapProps } from "@/lib/map/types";
import { cn } from "@/lib/utils";

/**
 * The MapLibre renderer — the **only** file in the app that imports a map
 * library. Everything above it speaks `VisibleMapPlace` and nothing else.
 *
 * MapLibre's stylesheet is imported here rather than in the root layout, so it
 * ships with this component's chunk instead of on every page including the
 * landing page. This is the single import of it anywhere.
 */
export function TripMap({
  places,
  routes = [],
  selectedItemId,
  activeDayNumber,
  onSelectItem,
  className,
  dayLabel,
  isVisible = true,
  onError,
}: TripMapProps & {
  /** Day context, shown as a chip so the map says which day it is showing. */
  dayLabel: string;
  /** False while the mobile Plan tab has the map hidden. */
  isVisible?: boolean;
  onError?: (error: Error) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const [ready, setReady] = useState(false);
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);

  useMapCamera({
    mapRef,
    places,
    routes,
    activeDayNumber,
    selectedItemId,
    isVisible,
    ready,
  });

  const sequence = buildSequenceGeoJson(places);
  const routeGeometry = buildRouteGeoJson(routes);

  const handleError = useCallback(
    (event: { error?: Error }) => {
      // MapLibre reports tile and style failures here rather than throwing, so
      // this is the only place a basemap outage becomes visible to us.
      const error =
        event.error instanceof Error
          ? event.error
          : new Error("MapLibre failed to load the basemap");
      if (process.env.NODE_ENV !== "production") {
        console.error("[roamly] map error", error);
      }
      onError?.(error);
    },
    [onError],
  );

  return (
    <div
      className={cn(
        "relative size-full overflow-hidden rounded-2xl border border-line bg-sand",
        className,
      )}
    >
      <MapLibreMap
        ref={mapRef}
        mapStyle={BASEMAP_STYLE_URL}
        initialViewState={{ ...DEFAULT_CENTER, zoom: DEFAULT_ZOOM }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        onLoad={() => setReady(true)}
        onError={handleError}
        // Attribution is added explicitly below so it can be positioned; the
        // default control is suppressed to avoid rendering it twice.
        attributionControl={false}
        // Nothing here needs to know where the user is, and asking would be an
        // unprompted permission prompt.
        trackResize
        dragRotate={false}
        touchZoomRotate
        pitchWithRotate={false}
        style={{ width: "100%", height: "100%" }}
      >
        {/*
         * Itinerary order, not a route. One line per day from a single source and
         * a single layer — see lib/map/sequence.ts.
         *
         * This layer stays even when routed geometry is present. Visit order and
         * walked path are different facts, and the dashed line is the only thing
         * that still shows the day's shape across a leg we could not route.
         */}
        <Source id="roamly-sequence" type="geojson" data={sequence}>
          <Layer
            id="roamly-sequence-line"
            type="line"
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{
              "line-color": "#2f4f3f",
              "line-opacity": 0.5,
              "line-width": 2,
              "line-dasharray": [2, 1.6],
            }}
          />
        </Source>

        {/*
         * Real routed geometry. A second source and a second layer, deliberately
         * — sharing one source would make the two indistinguishable in the style
         * and force a per-feature branch on every paint property.
         *
         * Solid and stronger than the sequence line, and drawn after it so it
         * reads as the concrete thing on top of the schematic one. An unroutable
         * leg contributes no feature, so there is nothing here that could be
         * mistaken for a path we do not have.
         */}
        <Source id="roamly-routes" type="geojson" data={routeGeometry}>
          {/* A pale casing, so a dark route stays legible over dark basemap ink. */}
          <Layer
            id="roamly-route-casing"
            type="line"
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{
              "line-color": "#fbf7ef",
              "line-opacity": 0.85,
              "line-width": ["case", ["get", "selected"], 9, 7],
            }}
          />
          <Layer
            id="roamly-route-line"
            type="line"
            layout={{ "line-cap": "round", "line-join": "round" }}
            paint={{
              // Mode-coloured, matching the dev surface legend.
              "line-color": [
                "match",
                ["get", "mode"],
                "walk",
                "#2f4f3f",
                "drive",
                "#b4552d",
                "bicycle",
                "#4a6d8c",
                "#2f4f3f",
              ],
              "line-opacity": ["case", ["get", "selected"], 1, 0.85],
              "line-width": ["case", ["get", "selected"], 5, 3.5],
            }}
          />
        </Source>

        {places.map((place) => (
          <Marker
            // Keyed by itemId, never by array index — a day change reorders and
            // refilters this list, and index keys would recycle the wrong DOM.
            key={place.itemId}
            longitude={place.longitude}
            latitude={place.latitude}
            anchor="center"
            // Let the button handle the click; without this MapLibre swallows it
            // as a map drag on touch devices.
            onClick={(event) => event.originalEvent.stopPropagation()}
          >
            <NumberedMarker
              place={place}
              selected={place.itemId === selectedItemId}
              hovered={place.itemId === hoveredItemId}
              onSelect={() => onSelectItem(place.itemId, "map")}
              onHoverChange={(hovered) =>
                setHoveredItemId(hovered ? place.itemId : null)
              }
            />
          </Marker>
        ))}

        <NavigationControl
          position="top-right"
          showCompass={false}
          visualizePitch={false}
        />

        {/*
         * Required attribution. `compact={false}` keeps the OpenStreetMap credit
         * permanently legible rather than behind an "i" toggle. Never hide this.
         */}
        <AttributionControl position="bottom-right" compact={false} />
      </MapLibreMap>

      {/*
       * Day context, matching the fallback renderer's chip so the two look and
       * read the same. Sits above the canvas and must not eat map gestures.
       */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start p-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-cream-raised/90 px-2.5 py-1 text-[0.6875rem] font-medium text-forest backdrop-blur-sm">
          <Navigation aria-hidden className="size-3" />
          {dayLabel}
        </span>
      </div>

      {!ready ? (
        <div
          className="pointer-events-none absolute inset-0 animate-pulse bg-sand"
          aria-hidden
        />
      ) : null}
    </div>
  );
}
