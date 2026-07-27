import { z } from "zod";

import { PlaceCategorySchema } from "@/lib/schemas";
import {
  TripGenerationContextSchema,
  TripPlanSchema,
  VerifiedPlacePoolSchema,
} from "@/lib/schemas";

/**
 * The contract for `POST /api/trips/refresh-pool`.
 *
 * ## Why this is not part of `/api/trips/refine`
 *
 * The refinement route talks to a *model*. This one talks to Overpass. They have different
 * duration budgets, different failure vocabularies, different rate-limit behaviour and
 * different caches, and a route that did both would have to hold the union of all four. The
 * boundary is worth keeping sharp for the same reason `retry-routes` goes to the routing
 * route: each endpoint asks one service.
 *
 * ## Preview, not commit
 *
 * The response carries a refreshed pool, a diff, and a reconciliation preview **per policy** —
 * and no updated plan. The server has no storage and no business deciding what a changed pool
 * means for someone's itinerary; the traveller sees the diff, chooses a policy, and the browser
 * applies the pure reconciliation and saves under its revision guard.
 *
 * Both previews are returned from one request on purpose. There are only two policies, the diff
 * is already in hand, and asking Overpass again because the traveller changed their mind at the
 * confirmation step would be rude to a donated service.
 *
 * ## What never crosses back
 *
 * A raw Overpass payload, a provider host, an HTTP status, a query string. Warnings carry our
 * own codes and our own sentences.
 */

/** A plan (~45 KB) plus a context with its pool (~45 KB). The routing route's ceiling. */
export const REFRESH_POOL_MAX_BODY_BYTES = 512 * 1024;

export const ReconciliationPolicySchema = z.enum([
  "keep-valid-and-flag-missing",
  "replace-missing-with-unavailable",
]);

export const RefreshPoolRequestSchema = z.object({
  plan: TripPlanSchema,
  /**
   * Required, and it carries the destination identity this refresh uses.
   *
   * A trip with no context has no recorded search to re-run and no OSM identity to search
   * around — so the sample trip cannot be refreshed, which the interface reflects by
   * explaining rather than by offering a button that fails.
   */
  generation: TripGenerationContextSchema,
  /** Absent means "the categories the original search covered". */
  categories: z.array(PlaceCategorySchema).min(1).max(8).optional(),
  /** Absent means "the radius the original search used". Clamped server-side regardless. */
  radiusMeters: z.number().int().min(1_000).max(12_000).optional(),
  /**
   * The policy the traveller has preselected.
   *
   * Accepted and deliberately **not** used to narrow the response: previews for *both* policies
   * come back from one search, so changing their mind at the confirmation step costs no second
   * Overpass request. The field stays because the client's intent belongs in the request.
   */
  reconciliation: ReconciliationPolicySchema,
  /**
   * The revision the client read before starting. Echoed back untouched.
   *
   * The server does not check it — there is nothing to check against. It is a token the
   * guarded client-side save compares, not an authorisation.
   */
  expectedRevision: z.number().int().positive(),
  requestId: z.string().min(8).max(64),
});
export type RefreshPoolRequest = z.infer<typeof RefreshPoolRequestSchema>;

const ChangedRecordSchema = z.object({
  placeId: z.string().min(1),
  changedFields: z.array(
    z.enum([
      "name",
      "coordinates",
      "category",
      "address",
      "website",
      "phone",
      "openingHours",
    ]),
  ),
});

export const PlacePoolChangeSummarySchema = z.object({
  previousCount: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  addedPlaceIds: z.array(z.string().min(1)),
  removedPlaceIds: z.array(z.string().min(1)),
  retainedPlaceIds: z.array(z.string().min(1)),
  changedCanonicalRecords: z.array(ChangedRecordSchema),
  missingUsedPlaceIds: z.array(z.string().min(1)),
  categoryChanges: z.array(
    z.object({
      category: PlaceCategorySchema,
      previousCount: z.number().int().nonnegative(),
      newCount: z.number().int().nonnegative(),
    }),
  ),
});

const StructuralWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  dayNumber: z.number().int().positive().optional(),
  itemId: z.string().min(1).optional(),
  placeId: z.string().min(1).optional(),
});

export const ReconciliationPreviewSchema = z.object({
  policy: ReconciliationPolicySchema,
  refreshedItemIds: z.array(z.string().min(1)),
  retainedItemIds: z.array(z.string().min(1)),
  unavailableItemIds: z.array(z.string().min(1)),
  removedBackupIds: z.array(z.string().min(1)),
  accommodationMissing: z.boolean(),
  retainedPlaceCount: z.number().int().nonnegative(),
  invalidatedLegIds: z.array(z.string().min(1)),
  warnings: z.array(StructuralWarningSchema),
});

export const RefreshPoolResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    pool: VerifiedPlacePoolSchema,
    /** What the refreshed search did, for the context the client will save. */
    discoverySummary: TripGenerationContextSchema.shape.discoverySummary,
    changes: PlacePoolChangeSummarySchema,
    /** One entry per policy, so the confirmation step needs no second search. */
    previews: z.array(ReconciliationPreviewSchema).length(2),
    /** True when a batch failed, so the pool is thinner than the map rather than the map thinner. */
    partial: z.boolean(),
    warnings: z.array(StructuralWarningSchema),
    expectedRevision: z.number().int().positive(),
    requestId: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.enum([
      "destination_unavailable",
      "no_results",
      "pool_invalid",
      "timeout",
      "aborted",
      "provider_unavailable",
      "unknown",
    ]),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
]);
export type RefreshPoolResponse = z.infer<typeof RefreshPoolResponseSchema>;
