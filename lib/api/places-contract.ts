import { z } from "zod";

import { GeocodedDestinationSchema } from "@/lib/schemas/generation";
import { PlaceCategorySchema, TripPlaceSchema } from "@/lib/schemas/place";

/**
 * Request and response contracts for the internal places routes.
 *
 * Deliberately free of `server-only`: the dev verification surface is a client
 * component and needs these types and schemas to build requests and parse
 * responses. That is safe precisely because this module contains no provider
 * access, no endpoint, and no provider-specific shape — only our own contract.
 */

export const GeocodeRequestSchema = z.object({
  destination: z.string().trim().min(1).max(120),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .optional(),
});
export type GeocodeRequest = z.infer<typeof GeocodeRequestSchema>;

/**
 * Re-exported rather than redefined.
 *
 * The shape moved to `lib/schemas/generation.ts` when the stored generation
 * context started needing it too. Two copies of a coordinate-bounded schema is one
 * of the more reliable ways to end up with two different opinions about what a
 * valid latitude is.
 */
export { GeocodedDestinationSchema };

export const GeocodeResponseSchema = z.object({
  query: z.string(),
  candidates: z.array(GeocodedDestinationSchema),
  attribution: z.string().min(1),
  fetchedAt: z.string().min(1),
  fromCache: z.boolean(),
});
export type GeocodeResponse = z.infer<typeof GeocodeResponseSchema>;

export const DiscoverRequestSchema = z.object({
  center: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  /** Only allowlisted categories. An unknown value is rejected here, before the query builder. */
  categories: z.array(PlaceCategorySchema).min(1).max(8),
  radiusMeters: z.number().int().min(100).max(30_000).optional(),
  limitPerCategory: z.number().int().min(1).max(40).optional(),
});
export type DiscoverRequest = z.infer<typeof DiscoverRequestSchema>;

export const DiscoverResponseSchema = z.object({
  places: z.array(TripPlaceSchema),
  categoriesRequested: z.array(PlaceCategorySchema),
  query: z.object({
    center: z.object({
      latitude: z.number(),
      longitude: z.number(),
    }),
    radiusMeters: z.number(),
    limitPerCategory: z.number(),
    categoriesWithNoResults: z.array(PlaceCategorySchema),
  }),
  discarded: z.object({
    total: z.number().int().nonnegative(),
    noCategory: z.number().int().nonnegative(),
    noName: z.number().int().nonnegative(),
    noCoordinates: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  }),
  fetchedAt: z.string().min(1),
  attribution: z.string().min(1),
  fromCache: z.boolean(),
  /** Result of running the discovered places through pool validation. */
  pool: z.object({
    valid: z.boolean(),
    poolId: z.string().min(1),
    placeCount: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),
});
export type DiscoverResponse = z.infer<typeof DiscoverResponseSchema>;

/** The only error shape either route emits. No stack traces, no provider names. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
