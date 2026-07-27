import { z } from "zod";

/**
 * Zod for the **raw** Valhalla payloads.
 *
 * These shapes never leave the adapter. Nothing outside
 * `lib/providers/routing/valhalla/` imports this file, which is what keeps the
 * provider replaceable: a different engine means a new `schemas.ts` and a new
 * `normalize.ts`, and no change at all above them.
 *
 * Verified against live responses from `valhalla1.openstreetmap.de` on
 * 2026-07-26, not recalled. Anything not modelled here must be confirmed against
 * a recorded response before code depends on it.
 *
 * ## What is deliberately not modelled
 *
 * `maneuvers` — we send `directions_type: "none"` and do not build turn-by-turn
 * UI in this phase, so requesting and parsing them would be bandwidth and
 * surface area spent on nothing. `trip.locations`, `trip.summary.has_toll` and
 * the rest are passed over in silence: `.loose()` is not used, but Zod object
 * parsing ignores unknown keys by default, so a new field upstream does not
 * break us.
 */

/**
 * A leg or trip summary.
 *
 * `time` is **seconds** and `length` is in the requested units — kilometres, in
 * every request we make. Both are `number`, not integers: Valhalla returns
 * `681.558` seconds and `0.881` km.
 */
export const ValhallaSummarySchema = z.object({
  time: z.number(),
  length: z.number(),
});

export const ValhallaLegSchema = z.object({
  summary: ValhallaSummarySchema,
  /** Encoded polyline, precision 6. See `./geometry.ts`. */
  shape: z.string(),
});

export const ValhallaTripSchema = z.object({
  /**
   * `0` means a route was found. Any other value is a provider-level failure
   * inside an HTTP 200, which is why it is required rather than optional.
   */
  status: z.number(),
  status_message: z.string().optional(),
  units: z.string().optional(),
  language: z.string().optional(),
  summary: ValhallaSummarySchema,
  legs: z.array(ValhallaLegSchema),
});

export const ValhallaRouteResponseSchema = z.object({
  trip: ValhallaTripSchema,
});

/**
 * Valhalla's error body.
 *
 * Arrives with HTTP 400 for input and no-route failures alike — the distinction
 * is in `error_code`, not the status. See `NO_ROUTE_ERROR_CODES` below.
 */
export const ValhallaErrorResponseSchema = z.object({
  error_code: z.number(),
  error: z.string(),
  status_code: z.number().optional(),
  status: z.string().optional(),
});

/**
 * The `error_code` values that mean "we looked and there is no path", as opposed
 * to "your request was wrong".
 *
 * Confirmed live: 154 for the two Lisbon-to-Madeira points (distance limit) and
 * 170 for unconnected regions. 171 and 442 are documented in Valhalla's error
 * table and included for completeness.
 *
 * The distinction matters because these are the only failures worth caching, and
 * the only ones that must never be retried.
 */
export const NO_ROUTE_ERROR_CODES = new Set([
  154, // Path distance exceeds the max distance limit
  170, // Locations are in unconnected regions
  171, // No suitable edges near location
  442, // No path could be found for input
]);

/**
 * `error_code` values meaning our request was malformed or out of bounds.
 *
 * Never retried: a second identical request gets a second identical rejection.
 */
export const INVALID_INPUT_ERROR_CODES = new Set([
  106, // Try any of the actions
  110, 111, 112, 113, 114, // Insufficiently specified required parameter
  120, 121, 122, 123, 124, 125, // Insufficient/invalid locations
  130, 131, 132, 133, // Failed to parse location / costing / options
  140, 141, 142, // Action does not support multimodal / arrive_by / depart_at
  150, 151, 152, 153, // Exceeded max locations / distance / matrix limits
  160, 161, 162, 163, // Date/time parsing
]);

export const ValhallaMatrixCellSchema = z.object({
  from_index: z.number().int().nonnegative(),
  to_index: z.number().int().nonnegative(),
  /**
   * Seconds, or `null` when the pair is unreachable.
   *
   * `.nullable()` is load-bearing. Coercing an unreachable cell to `0` would
   * make it look like the two points are on top of each other, which is the most
   * expensive possible misreading of a travel matrix.
   */
  time: z.number().nullable(),
  /** In the requested units — kilometres. `null` when unreachable. */
  distance: z.number().nullable(),
});

export const ValhallaMatrixResponseSchema = z.object({
  sources_to_targets: z.array(z.array(ValhallaMatrixCellSchema)),
  units: z.string().optional(),
});
