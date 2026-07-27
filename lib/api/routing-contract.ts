import { z } from "zod";

import {
  MatrixRequestSchema,
  ModePolicySchema,
  RoutedDayResultSchema,
  RouteLocationSchema,
  RouteRequestSchema,
  RouteResultSchema,
  RoutingMatrixSchema,
} from "@/lib/routing";
import { TripPlaceSchema } from "@/lib/schemas/place";

/**
 * Request and response contracts for the internal routing routes.
 *
 * Deliberately free of `server-only`: the dev verification surface is a client
 * component and needs these to build requests and parse responses. That is safe
 * precisely because this module contains no provider access, no endpoint, and no
 * provider-specific shape — only our own contract.
 *
 * Every response schema is the *normalised* domain shape. There is no field
 * anywhere below through which a raw Valhalla object, a provider hostname or an
 * upstream error code could reach the browser.
 */

/* -------------------------------------------------------------------------- */
/* POST /api/routes/route                                                      */
/* -------------------------------------------------------------------------- */

export const RouteApiRequestSchema = RouteRequestSchema;
export type RouteApiRequest = z.infer<typeof RouteApiRequestSchema>;

/**
 * Always 200 when the request was well formed, even for `no_route`.
 *
 * "There is no path between these two points" is a correct answer to a valid
 * question, and a 4xx would tell the client its request was wrong. The
 * discriminated `result` carries the outcome instead.
 */
export const RouteApiResponseSchema = z.object({
  result: RouteResultSchema,
  /** Whether this exact request was already known. Diagnostics, not product UI. */
  fromCache: z.boolean(),
  attribution: z.string().min(1),
});
export type RouteApiResponse = z.infer<typeof RouteApiResponseSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/routes/matrix                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Caps are restated here as well as in the provider config.
 *
 * Not redundant: this one rejects an oversized body before any server work
 * happens, and it is the boundary a hostile caller actually meets. The provider
 * cap is the backstop for internal callers that bypass the route.
 */
export const MatrixApiRequestSchema = MatrixRequestSchema.extend({
  sources: z.array(RouteLocationSchema).min(1).max(8),
  targets: z.array(RouteLocationSchema).min(1).max(8),
});
export type MatrixApiRequest = z.infer<typeof MatrixApiRequestSchema>;

export const MatrixApiResponseSchema = z.object({
  matrix: RoutingMatrixSchema,
  fromCache: z.boolean(),
  attribution: z.string().min(1),
});
export type MatrixApiResponse = z.infer<typeof MatrixApiResponseSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/routes/day                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A day's stops, as places rather than itinerary items.
 *
 * The route takes verified `TripPlace` records directly so the dev surface can
 * hand it discovery results without first assembling a fake itinerary. The
 * server never invents a coordinate: a stop with no place simply is not sent.
 *
 * Capped at 24 stops — a day with more than that is not a day, and 24 stops is
 * 23 legs, which at three concurrent requests is already a meaningful ask of a
 * donated server.
 */
export const DayApiRequestSchema = z.object({
  dayNumber: z.number().int().positive().nullable().optional(),
  stops: z.array(TripPlaceSchema).min(2).max(24),
  /** Forces every leg to one mode. Omit to let the policy choose. */
  mode: z.enum(["walk", "drive", "bicycle"]).optional(),
  modePolicy: ModePolicySchema.optional(),
});
export type DayApiRequest = z.infer<typeof DayApiRequestSchema>;

/**
 * Partial success is the expected shape, not an error case.
 *
 * `day.legs` carries a per-leg status, and `day.summary` counts them, so a
 * caller learns which legs routed without inspecting every entry. A day where
 * every leg failed still returns 200 with a fully `unavailable` set — the
 * request was valid, and the answer is "we could not route this".
 */
export const DayApiResponseSchema = z.object({
  day: RoutedDayResultSchema,
});
export type DayApiResponse = z.infer<typeof DayApiResponseSchema>;

/** The only error shape any routing route emits. No stack traces, no hostnames. */
export const RoutingApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});
export type RoutingApiError = z.infer<typeof RoutingApiErrorSchema>;
