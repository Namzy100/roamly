import { z } from "zod";

import {
  AccommodationRoutingPolicySchema,
  ExistingSegmentPolicySchema,
  RoutingEnrichmentSummarySchema,
  TripPlanSchema,
  VerifiedPlacePoolSchema,
} from "@/lib/schemas";
import { ModePolicySchema } from "@/lib/routing";

/**
 * Request and response contract for `POST /api/trips/route`.
 *
 * ## Why the whole plan crosses the wire
 *
 * Persistence is browser-local, so the server has no copy of the trip to work
 * from. Two designs were possible: send the plan and let the server transform it
 * (**A**), or let the browser call the narrow per-day routing endpoints and run
 * the pure enrichment modules itself (**B**).
 *
 * **A** is what this is. The plan is ~45 KB and the pool ~11 KB for a five-day
 * trip, which is a comfortable POST. In exchange, the whole orchestration —
 * expected-leg derivation, bounded concurrency, the plan builder and every
 * validation invariant — runs in one place, server-side, where the provider
 * limiter and cache already live. Under **B** the browser would drive the
 * concurrency ceiling, which is precisely the thing that must not be client-
 * controllable when it is protecting someone else's donated server.
 *
 * The server persists nothing. It reads a plan, returns a new one, and forgets
 * both; the guarded save happens in the browser against the revision it read
 * before starting.
 *
 * Deliberately free of `server-only`: the workspace parses these responses.
 */

/** ~60 KB of plan and pool, plus generous headroom. Checked against real bytes. */
export const TRIP_ROUTING_MAX_BODY_BYTES = 512 * 1024;

export const TripRoutingPolicyInputSchema = z.object({
  modePolicy: ModePolicySchema.partial().optional(),
  accommodation: AccommodationRoutingPolicySchema.optional(),
  existingSegments: ExistingSegmentPolicySchema.optional(),
});
export type TripRoutingPolicyInput = z.infer<typeof TripRoutingPolicyInputSchema>;

export const TripRoutingRequestSchema = z.object({
  plan: TripPlanSchema,
  placePool: VerifiedPlacePoolSchema,
  policy: TripRoutingPolicyInputSchema.optional(),
  /**
   * The revision the client read before starting. Echoed back untouched so the
   * guarded save can compare against it without having to remember it across an
   * await it does not control.
   *
   * The server does **not** check it — it has no storage to check against. This
   * is a token, not an authorisation.
   */
  expectedRevision: z.number().int().positive(),
  /**
   * Route only these legs (Phase 6A), by stable leg id.
   *
   * Absent means every eligible leg — the original whole-trip behaviour, unchanged.
   * Present means a targeted retry: "retry this route" sends one id, "retry the
   * failures" sends the ids of the legs that failed or were never attempted.
   *
   * The server filters them against the plan's currently expected leg set, so an id
   * from a stale render cannot cause a request for a journey the itinerary no longer
   * contains. Legs not named keep the segments they already have.
   *
   * Bounded at the same ceiling as a whole trip, since "retry everything" is a
   * legitimate request through this field.
   */
  retryLegIds: z.array(z.string().min(1).max(200)).max(23).optional(),
});
export type TripRoutingRequest = z.infer<typeof TripRoutingRequestSchema>;

/**
 * Partial success is a first-class response, not an error.
 *
 * A trip where six of seven legs routed comes back 200 with `status: "partial"`
 * and a full plan. Only a contract violation — a result that does not match its
 * leg — produces `failed`, and then there is no plan, because a plan assembled
 * from mismatched parts is worse than an unenriched one.
 */
export const TripRoutingResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("complete"),
    plan: TripPlanSchema,
    summary: RoutingEnrichmentSummarySchema,
    expectedRevision: z.number().int().positive(),
    attribution: z.string().min(1),
  }),
  z.object({
    status: z.literal("partial"),
    plan: TripPlanSchema,
    summary: RoutingEnrichmentSummarySchema,
    expectedRevision: z.number().int().positive(),
    attribution: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    /** Codes and messages are ours, never a provider's. */
    errors: z.array(
      z.object({
        code: z.string().min(1),
        message: z.string().min(1),
        legId: z.string().min(1).optional(),
        dayNumber: z.number().int().positive().optional(),
      }),
    ),
    expectedRevision: z.number().int().positive(),
  }),
]);
export type TripRoutingResponse = z.infer<typeof TripRoutingResponseSchema>;
