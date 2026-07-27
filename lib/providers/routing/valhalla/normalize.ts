import { isUsableMeasurement } from "@/lib/routing";
import type {
  RoutedGeometry,
  RouteLocation,
  RouteRequest,
  RoutedSegment,
  RoutingMatrix,
  MatrixRequest,
} from "@/lib/routing";

import { ROUTING_ATTRIBUTION } from "../config";
import { RoutingProviderError } from "../errors";
import { decodeRouteGeometry } from "./geometry";
import {
  ValhallaMatrixResponseSchema,
  ValhallaRouteResponseSchema,
} from "./schemas";

/**
 * Raw Valhalla → normalised routing domain.
 *
 * The last file that knows what Valhalla's payload looks like. Everything
 * leaving here is `lib/routing` vocabulary, and every rejection is explicit —
 * nothing is defaulted, coerced or rounded into existence.
 *
 * ## Unit conversions, stated once
 *
 * | Valhalla | Ours |
 * | --- | --- |
 * | `summary.time` — seconds, fractional | `durationSeconds`, seconds |
 * | `summary.length` — kilometres (we always request `units: kilometers`) | `distanceMeters`, metres |
 * | `shape` — polyline6, `lat,lon` | `geometry.coordinates`, `[lon,lat]` |
 *
 * The kilometre assumption is not left implicit: `units` is sent on every
 * request *and* checked on every response, because a silently-imperial length
 * would be 1.6× wrong and entirely plausible-looking.
 */

const KM_TO_METERS = 1_000;

/**
 * Turns a `/route` payload into a `RoutedSegment`.
 *
 * Rejects, rather than repairs:
 *  - a non-zero `trip.status` (a provider-level error inside an HTTP 200)
 *  - a trip with no legs
 *  - a non-finite or non-positive time or length
 *  - a shape that will not decode, or decodes to fewer than two points
 *  - a response claiming units we did not ask for
 *
 * Multi-leg trips are summed rather than truncated. We only ever send two
 * locations, so a multi-leg response means the provider inserted a via point;
 * taking leg 0 alone would report a fraction of the journey as the whole of it.
 */
export function normalizeRouteResponse(
  raw: unknown,
  request: RouteRequest,
  fetchedAt: string,
): RoutedSegment {
  const parsed = ValhallaRouteResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RoutingProviderError(
      "invalid_response",
      `Unexpected route response shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }

  const trip = parsed.data.trip;

  // A well-formed body can still carry a failure. HTTP 200 is not the answer.
  if (trip.status !== 0) {
    throw new RoutingProviderError(
      "no_route",
      `Provider reported trip status ${trip.status}: ${trip.status_message ?? "no message"}`,
      { providerCode: trip.status },
    );
  }

  if (trip.legs.length === 0) {
    throw new RoutingProviderError(
      "invalid_response",
      "Route response contained a trip with no legs",
    );
  }

  assertKilometres(trip.units);

  const durationSeconds = trip.legs.reduce((sum, leg) => sum + leg.summary.time, 0);
  const distanceMeters =
    trip.legs.reduce((sum, leg) => sum + leg.summary.length, 0) * KM_TO_METERS;

  if (!isUsableMeasurement(durationSeconds)) {
    throw new RoutingProviderError(
      "invalid_response",
      `Route duration was not a usable number: ${durationSeconds}`,
    );
  }
  if (!isUsableMeasurement(distanceMeters)) {
    throw new RoutingProviderError(
      "invalid_response",
      `Route distance was not a usable number: ${distanceMeters}`,
    );
  }

  const geometry = joinLegShapes(trip.legs.map((leg) => leg.shape));

  return {
    status: "routed",
    provider: "valhalla",
    mode: request.mode,
    origin: request.origin,
    destination: request.destination,
    distanceMeters,
    durationSeconds,
    geometry,
    fetchedAt,
    attribution: ROUTING_ATTRIBUTION,
  };
}

/**
 * Decodes each leg's shape and concatenates them into one line.
 *
 * The join drops the duplicated seam point: consecutive legs share their
 * boundary coordinate, and leaving both in produces a zero-length sub-segment
 * that some renderers draw as a visible artefact.
 */
function joinLegShapes(shapes: string[]): RoutedGeometry {
  const coordinates: [number, number][] = [];

  for (const shape of shapes) {
    const decoded = decodeRouteGeometry(shape);
    if (!decoded.ok) {
      throw new RoutingProviderError(
        "invalid_response",
        `Route shape could not be used: ${decoded.detail}`,
      );
    }

    const points = decoded.geometry.coordinates;
    const isSeam =
      coordinates.length > 0 && samePoint(coordinates[coordinates.length - 1], points[0]);
    coordinates.push(...(isSeam ? points.slice(1) : points));
  }

  if (coordinates.length < 2) {
    throw new RoutingProviderError(
      "invalid_response",
      "Joined route geometry had fewer than two points",
    );
  }

  return { type: "LineString", coordinates };
}

/** Equal to within polyline-6's own resolution. */
function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/**
 * Turns a `/sources_to_targets` payload into a `RoutingMatrix`.
 *
 * Dimensions are checked exactly against what we asked for. A matrix indexed
 * positionally is unusable if a row is missing — the caller would silently read
 * the wrong pair's duration — so a mismatch is a hard rejection rather than a
 * pad or a truncate.
 *
 * `null` cells survive as `null`. Coercing an unreachable pair to zero would say
 * the two points are on top of each other, which is the worst available
 * misreading of a travel matrix.
 */
export function normalizeMatrixResponse(
  raw: unknown,
  request: MatrixRequest,
  fetchedAt: string,
): RoutingMatrix {
  const parsed = ValhallaMatrixResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RoutingProviderError(
      "invalid_response",
      `Unexpected matrix response shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }

  assertKilometres(parsed.data.units);

  const rows = parsed.data.sources_to_targets;

  if (rows.length !== request.sources.length) {
    throw new RoutingProviderError(
      "invalid_response",
      `Matrix had ${rows.length} rows, expected ${request.sources.length}`,
    );
  }

  const durationsSeconds: Array<Array<number | null>> = [];
  const distancesMeters: Array<Array<number | null>> = [];

  for (const [rowIndex, row] of rows.entries()) {
    if (row.length !== request.targets.length) {
      throw new RoutingProviderError(
        "invalid_response",
        `Matrix row ${rowIndex} had ${row.length} cells, expected ${request.targets.length}`,
      );
    }

    durationsSeconds.push(row.map((cell) => cell.time));
    distancesMeters.push(
      row.map((cell) => (cell.distance === null ? null : cell.distance * KM_TO_METERS)),
    );
  }

  return {
    mode: request.mode,
    sources: request.sources,
    targets: request.targets,
    durationsSeconds,
    distancesMeters,
    fetchedAt,
    provider: "valhalla",
  };
}

/**
 * Every request sends `units: "kilometers"`. If a response disagrees, the
 * numbers are 1.6× wrong and look entirely reasonable — so it is checked rather
 * than assumed.
 */
function assertKilometres(units: string | undefined): void {
  if (units !== undefined && units !== "kilometers" && units !== "km") {
    throw new RoutingProviderError(
      "invalid_response",
      `Provider answered in "${units}" after we requested kilometers`,
    );
  }
}

/** Valhalla's location shape. Built here so no caller assembles one by hand. */
export function toProviderLocation(location: RouteLocation): {
  lat: number;
  lon: number;
} {
  return { lat: location.latitude, lon: location.longitude };
}
