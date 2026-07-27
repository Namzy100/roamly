import type { MapRouteLine, RouteFeatureCollection } from "./types";

/**
 * Routed geometry as GeoJSON, for the map's second line layer.
 *
 * ## Why this is separate from `sequence.ts`
 *
 * "The order I visit things" and "the path I walk between them" are different
 * facts, and a map that shows only the second has silently thrown the first
 * away. A day with one unroutable leg would appear to have a gap in the
 * itinerary rather than a gap in our knowledge of the roads. So both layers
 * exist, always, with distinct styling — dashed and muted for order, solid and
 * stronger for the real path.
 *
 * ## No line for an unavailable leg
 *
 * A leg we could not route contributes no feature. Not a straight line, not a
 * dotted "approximate" line, nothing. Drawing anything would be inventing a
 * path, and the itinerary panel is where the traveller is told there is a gap.
 * Callers pass only routed geometry in; there is no arm of `MapRouteLine` that
 * could express an unavailable one.
 *
 * One source, one layer, one feature per leg — not one overlay per segment. A
 * five-day trip is ~19 legs, and nineteen sources would be nineteen style
 * recalculations on every day change.
 */
export function buildRouteGeoJson(
  routes: MapRouteLine[],
): RouteFeatureCollection {
  return {
    type: "FeatureCollection",
    features: routes.map((route) => ({
      type: "Feature",
      properties: {
        legId: route.legId,
        mode: route.mode,
        dayNumber: route.dayNumber,
        // Rides along as a feature property so the layer can emphasise the
        // selected leg with a paint expression rather than a second source.
        selected: route.selected === true,
      },
      geometry: { type: "LineString", coordinates: route.coordinates },
    })),
  };
}

/**
 * Every coordinate the routes touch, for camera fitting.
 *
 * A routed path can bulge well outside the box its two endpoints describe — a
 * one-way system, a river crossing, a road that goes the long way round a hill.
 * Fitting to the markers alone therefore clips the route, so the camera is given
 * both sets of points.
 */
export function routeCoordinates(
  routes: MapRouteLine[],
): { longitude: number; latitude: number }[] {
  return routes.flatMap((route) =>
    route.coordinates.map(([longitude, latitude]) => ({ longitude, latitude })),
  );
}
