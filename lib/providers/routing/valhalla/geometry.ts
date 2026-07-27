import { validateRoutedGeometry, type RoutedGeometry } from "@/lib/routing";

import { RoutingProviderError } from "../errors";

/**
 * The one authoritative encoded-polyline decoder.
 *
 * ## Why not a dependency
 *
 * The algorithm is forty lines, has not changed since Google published it in
 * 2008, and the failure mode we actually care about is not "the algorithm is
 * wrong" — it is "the precision is wrong" or "latitude and longitude got
 * swapped". A dependency does not help with either; a fixture test does. Adding
 * a package here would mean auditing someone else's precision default and
 * output ordering anyway, which is most of the work with none of the clarity.
 *
 * ## Precision
 *
 * Valhalla encodes at **6 decimal places** (1e-6°, ~0.11 m), not the 5 that
 * Google Directions and most polyline libraries default to. Decoding a Valhalla
 * shape at precision 5 does not fail — it silently produces coordinates ten
 * times too large, which lands a Lisbon walk somewhere in the Arctic Ocean. The
 * precision is therefore an explicit, tested parameter with no forgiving
 * default, and `geometry.test.ts` pins a known fixture so a change to it cannot
 * pass unnoticed.
 *
 * ## Output ordering
 *
 * The wire format is `latitude, longitude`. Every map renderer, and GeoJSON
 * itself, wants `longitude, latitude`. The swap happens here, once, and is
 * asserted directly in tests — a swapped pair produces a coordinate that still
 * validates, which is exactly why it needs a test rather than a comment.
 */

export const VALHALLA_POLYLINE_PRECISION = 6;

/**
 * Decodes an encoded polyline into `[longitude, latitude]` pairs.
 *
 * Throws on a malformed string rather than returning a partial line. A shape
 * that ends mid-varint is corrupt, and the coordinates decoded before that point
 * are not a shorter route — they are the beginning of one whose remainder is
 * unknown.
 */
export function decodePolyline(
  encoded: string,
  precision: number = VALHALLA_POLYLINE_PRECISION,
): [number, number][] {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new RoutingProviderError(
      "invalid_response",
      "Route shape was empty or not a string",
    );
  }

  const factor = 10 ** precision;
  const coordinates: [number, number][] = [];

  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    // Two varints per point: latitude delta, then longitude delta.
    const latDelta = readVarint();
    const lonDelta = readVarint();

    latitude += latDelta;
    longitude += lonDelta;

    coordinates.push([longitude / factor, latitude / factor]);
  }

  return coordinates;

  function readVarint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      if (index >= encoded.length) {
        throw new RoutingProviderError(
          "invalid_response",
          "Route shape ended mid-value — the encoded string is truncated",
        );
      }

      byte = encoded.charCodeAt(index) - 63;
      index += 1;

      // The encoding only ever produces printable ASCII from 63 upward. Anything
      // below that is not a polyline, and continuing would yield plausible
      // rubbish rather than an error.
      if (byte < 0) {
        throw new RoutingProviderError(
          "invalid_response",
          "Route shape contained a character outside the polyline alphabet",
        );
      }

      result |= (byte & 0x1f) << shift;
      shift += 5;

      // 6 continuation groups is already 30 bits; a 7th means the value is not a
      // coordinate delta and the string is not what we think it is.
      if (shift > 35) {
        throw new RoutingProviderError(
          "invalid_response",
          "Route shape contained an over-long encoded value",
        );
      }
    } while (byte >= 0x20);

    // The low bit is the sign, and negatives are stored one's-complemented.
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}

/**
 * Decodes and validates in one step — the only form callers should use.
 *
 * Returns a discriminated result rather than throwing for the validation half,
 * because a shape that decodes cleanly but describes one point is a routing
 * outcome (`unavailable`) rather than a provider protocol error.
 */
export function decodeRouteGeometry(
  encoded: string,
  precision: number = VALHALLA_POLYLINE_PRECISION,
):
  | { ok: true; geometry: RoutedGeometry }
  | { ok: false; detail: string } {
  let coordinates: [number, number][];
  try {
    coordinates = decodePolyline(encoded, precision);
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error ? error.message : "Route shape could not be decoded",
    };
  }

  const validation = validateRoutedGeometry(coordinates);
  if (!validation.ok) return { ok: false, detail: validation.detail };

  return { ok: true, geometry: validation.geometry };
}
