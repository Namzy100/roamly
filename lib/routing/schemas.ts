import { z } from "zod";

import { LineStringGeometrySchema } from "@/lib/schemas/place";

import type {
  DayLeg,
  MatrixRequest,
  ModePolicy,
  RoutedDayResult,
  RoutedGeometry,
  RoutedSegment,
  RouteLocation,
  RouteRequest,
  RouteResult,
  RoutingMatrix,
  RoutingMode,
  RouteUnavailableReason,
  UnavailableRouteSegment,
} from "./types";

/**
 * Zod mirrors of the routing vocabulary.
 *
 * Deliberately free of `server-only`: the API contract and the dev verification
 * surface both parse routing responses in the browser. That is safe because
 * nothing here names an endpoint or describes a provider payload — these are our
 * own normalised shapes, and they are the exit boundary the adapter must satisfy.
 *
 * Types are **not** re-inferred here. `lib/routing/types.ts` is the single
 * definition; these schemas are asserted against it with `satisfies`, so a drift
 * between the two is a compile error rather than a runtime surprise.
 */

export const RoutingModeSchema = z.enum(["walk", "drive", "bicycle"]);

export const RouteLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  canonicalPlaceId: z.string().min(1).optional(),
});

export const RouteRequestSchema = z.object({
  origin: RouteLocationSchema,
  destination: RouteLocationSchema,
  mode: RoutingModeSchema,
  alternatives: z.boolean().optional(),
  language: z.string().min(2).max(16).optional(),
  units: z.literal("kilometers").optional(),
});

/**
 * Route geometry, with every rule that makes it renderable expressed in the
 * schema rather than left to a comment: `[longitude, latitude]`, at least two
 * points, all finite and in range. A malformed shape cannot pass this and become
 * a line on the map.
 *
 * Shared with the trip plan rather than restated, because two definitions of
 * "a line" is how two coordinate orders eventually appear in one codebase.
 */
export const RoutedGeometrySchema = LineStringGeometrySchema;

/**
 * A provider-routed leg.
 *
 * Distance and duration are `.positive()`, not `.nonnegative()`. Zero is how a
 * naive implementation says "failed", and the whole point of the union below is
 * that failure has its own arm with its own reason.
 */
export const RoutedSegmentSchema = z.object({
  status: z.literal("routed"),
  provider: z.literal("valhalla"),
  mode: RoutingModeSchema,
  origin: RouteLocationSchema,
  destination: RouteLocationSchema,
  distanceMeters: z.number().finite().positive(),
  durationSeconds: z.number().finite().positive(),
  geometry: RoutedGeometrySchema,
  fetchedAt: z.string().min(1),
  attribution: z.string().min(1),
});

export const RouteUnavailableReasonSchema = z.enum([
  "no_route",
  "provider_unavailable",
  "timeout",
  "rate_limited",
  "invalid_locations",
  "unsupported_mode",
  "invalid_response",
  "aborted",
  "unknown",
]);

/**
 * The failure arm. Note what is *absent*: no geometry, no distance, no duration.
 * There is no way to express "unavailable, and here is a line anyway".
 */
export const UnavailableRouteSegmentSchema = z.object({
  status: z.literal("unavailable"),
  requestedMode: RoutingModeSchema,
  reason: RouteUnavailableReasonSchema,
  userMessage: z.string().min(1),
  origin: RouteLocationSchema.optional(),
  destination: RouteLocationSchema.optional(),
});

export const RouteResultSchema = z.discriminatedUnion("status", [
  RoutedSegmentSchema,
  UnavailableRouteSegmentSchema,
]);

export const RoutingMatrixSchema = z.object({
  mode: RoutingModeSchema,
  sources: z.array(RouteLocationSchema).min(1),
  targets: z.array(RouteLocationSchema).min(1),
  durationsSeconds: z.array(z.array(z.number().finite().nonnegative().nullable())),
  distancesMeters: z.array(z.array(z.number().finite().nonnegative().nullable())),
  fetchedAt: z.string().min(1),
  provider: z.literal("valhalla"),
});

export const MatrixRequestSchema = z.object({
  sources: z.array(RouteLocationSchema).min(1),
  targets: z.array(RouteLocationSchema).min(1),
  mode: RoutingModeSchema,
});

export const ModePolicySchema = z.object({
  walkMaxMeters: z.number().finite().positive(),
  driveMinMeters: z.number().finite().positive(),
  allowDriveInMiddleBand: z.boolean(),
  forcedMode: RoutingModeSchema.optional(),
});

export const DayLegSchema = z.object({
  id: z.string().min(1),
  dayNumber: z.number().int().positive(),
  fromItemId: z.string().min(1),
  toItemId: z.string().min(1),
  fromPlaceId: z.string().min(1),
  toPlaceId: z.string().min(1),
  origin: RouteLocationSchema,
  destination: RouteLocationSchema,
  mode: RoutingModeSchema,
  straightLineMeters: z.number().finite().nonnegative(),
});

export const RoutedDayLegSchema = DayLegSchema.extend({
  result: RouteResultSchema,
});

export const RoutedDayResultSchema = z.object({
  dayNumber: z.number().int().positive().nullable(),
  legs: z.array(RoutedDayLegSchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    routed: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
    routedDistanceMeters: z.number().finite().nonnegative(),
    routedDurationSeconds: z.number().finite().nonnegative(),
  }),
  attribution: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Compile-time conformance                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ties each schema to its hand-written type.
 *
 * The repo's convention elsewhere is `z.infer` as the single source of truth,
 * which works when the schema *is* the definition. Here the definition is the
 * documented union in `./types.ts` and the schemas are a runtime restatement of
 * it — so instead of inferring, we assert **mutual assignability**. Add a field
 * to one and forget the other and this file stops compiling.
 *
 * Mutual assignability rather than the stricter identity trick, because
 * `RoutedDayLeg` is an intersection (`DayLeg & {result}`) and its schema
 * counterpart is a flat object. Those are the same type to every caller and
 * different types to an identity check, and flattening nine fields by hand to
 * satisfy the check would be the tail wagging the dog. Assignability still
 * catches an added, removed, renamed or re-typed field in either direction.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

type _Conformance = [
  Assert<Exact<z.infer<typeof RoutingModeSchema>, RoutingMode>>,
  Assert<Exact<z.infer<typeof RouteLocationSchema>, RouteLocation>>,
  Assert<Exact<z.infer<typeof RouteRequestSchema>, RouteRequest>>,
  Assert<Exact<z.infer<typeof RoutedGeometrySchema>, RoutedGeometry>>,
  Assert<Exact<z.infer<typeof RoutedSegmentSchema>, RoutedSegment>>,
  Assert<
    Exact<z.infer<typeof RouteUnavailableReasonSchema>, RouteUnavailableReason>
  >,
  Assert<
    Exact<z.infer<typeof UnavailableRouteSegmentSchema>, UnavailableRouteSegment>
  >,
  Assert<Exact<z.infer<typeof RouteResultSchema>, RouteResult>>,
  Assert<Exact<z.infer<typeof RoutingMatrixSchema>, RoutingMatrix>>,
  Assert<Exact<z.infer<typeof MatrixRequestSchema>, MatrixRequest>>,
  Assert<Exact<z.infer<typeof ModePolicySchema>, ModePolicy>>,
  Assert<Exact<z.infer<typeof DayLegSchema>, DayLeg>>,
  Assert<Exact<z.infer<typeof RoutedDayResultSchema>, RoutedDayResult>>,
];
