import type { CameraTarget, MapBounds } from "./types";

/**
 * Anything with a position. Widened from `VisibleMapPlace` so route vertices can
 * be included in a fit without either type having to know about the other.
 */
type Positioned = { longitude: number; latitude: number };

/**
 * Smallest box containing every point, or `null` for an empty list.
 *
 * A single point — or several at identical coordinates — produces a degenerate
 * box with zero span. Callers must not hand that straight to a fit-bounds call:
 * every map library resolves a zero-span box by zooming to its maximum, which
 * looks like a bug. `cameraTargetFor` handles that case instead.
 */
export function boundsOf(places: Positioned[]): MapBounds | null {
  if (places.length === 0) return null;

  let west = places[0].longitude;
  let east = places[0].longitude;
  let south = places[0].latitude;
  let north = places[0].latitude;

  for (const place of places) {
    if (place.longitude < west) west = place.longitude;
    if (place.longitude > east) east = place.longitude;
    if (place.latitude < south) south = place.latitude;
    if (place.latitude > north) north = place.latitude;
  }

  return { west, south, east, north };
}

/** True when a box is a point, within floating-point tolerance. */
export function isDegenerate(bounds: MapBounds, epsilon = 1e-7): boolean {
  return (
    Math.abs(bounds.east - bounds.west) < epsilon &&
    Math.abs(bounds.north - bounds.south) < epsilon
  );
}

/**
 * What the camera should do for a set of points.
 *
 *  - no points       → leave the camera alone; the panel shows an empty state
 *  - one point, or a
 *    degenerate box   → centre on it and let the caller cap the zoom
 *  - otherwise        → fit the box
 */
export function cameraTargetFor(places: Positioned[]): CameraTarget {
  const bounds = boundsOf(places);
  if (bounds === null) return { type: "none" };

  if (isDegenerate(bounds)) {
    return {
      type: "center",
      longitude: bounds.west,
      latitude: bounds.south,
    };
  }

  return { type: "bounds", bounds };
}

/**
 * Whether a point sits inside a box that has been shrunk by `insetRatio` on each
 * axis.
 *
 * Used to decide if a newly selected marker needs the camera to move. The inset
 * means a marker technically on screen but hard against an edge — or under the
 * panel's overlay chrome — still counts as needing a nudge, while a marker
 * comfortably in view does not, so the user's zoom is left alone.
 */
export function isWithinViewport(
  point: { longitude: number; latitude: number },
  viewport: MapBounds,
  insetRatio = 0.12,
): boolean {
  const lngInset = (viewport.east - viewport.west) * insetRatio;
  const latInset = (viewport.north - viewport.south) * insetRatio;

  return (
    point.longitude >= viewport.west + lngInset &&
    point.longitude <= viewport.east - lngInset &&
    point.latitude >= viewport.south + latInset &&
    point.latitude <= viewport.north - latInset
  );
}
