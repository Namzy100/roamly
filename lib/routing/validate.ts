import type { RoutedGeometry } from "./types";

/**
 * The value rules a routed result must satisfy before it is allowed to exist.
 *
 * These run at the adapter boundary, on data that has already passed a Zod shape
 * check. Shape validation says "there is a number here"; these say "the number
 * means something". `NaN`, `Infinity`, `0` and a two-point line that is actually
 * one point repeated all pass a naive schema and all describe a route that was
 * never found.
 */

/** Loose enough for any real coordinate, tight enough to catch a lat/lon swap. */
const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

export type GeometryValidationFailure =
  | "too_few_points"
  | "non_finite_coordinate"
  | "out_of_range_coordinate";

export type GeometryValidation =
  | { ok: true; geometry: RoutedGeometry }
  | { ok: false; reason: GeometryValidationFailure; detail: string };

/**
 * Validates a decoded shape as renderable route geometry.
 *
 * A single point is rejected: a route between two distinct places that resolves
 * to one coordinate is a decoding failure, not a very short walk. Callers turn a
 * rejection into an `unavailable` segment — never into a line the map would draw
 * incorrectly.
 */
export function validateRoutedGeometry(
  coordinates: [number, number][],
): GeometryValidation {
  if (coordinates.length < 2) {
    return {
      ok: false,
      reason: "too_few_points",
      detail: `Route geometry needs at least 2 points, received ${coordinates.length}`,
    };
  }

  for (const [longitude, latitude] of coordinates) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      return {
        ok: false,
        reason: "non_finite_coordinate",
        detail: "Route geometry contained a non-finite coordinate",
      };
    }
    if (Math.abs(latitude) > MAX_LATITUDE || Math.abs(longitude) > MAX_LONGITUDE) {
      return {
        ok: false,
        reason: "out_of_range_coordinate",
        detail: `Coordinate out of geographic range: ${longitude},${latitude}`,
      };
    }
  }

  return { ok: true, geometry: { type: "LineString", coordinates } };
}

/**
 * True when a distance or duration describes a journey that happened.
 *
 * Strictly positive, deliberately. Zero distance between two distinct stops
 * means the provider matched both to the same road segment, and zero duration
 * means nothing was computed — neither is a fact worth showing, and using zero
 * as a failure sentinel is exactly what the `unavailable` arm exists to replace.
 */
export function isUsableMeasurement(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
