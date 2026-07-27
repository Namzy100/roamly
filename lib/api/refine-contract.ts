import { z } from "zod";

import {
  TripGenerationContextSchema,
  TripPlanSchema,
} from "@/lib/schemas";
import { AiRefinementCommandSchema } from "@/lib/refinement/commands";
import { REFINEMENT_STAGES } from "@/lib/refinement/types";

/**
 * The contract for `POST /api/trips/refine`.
 *
 * ## Why the plan and the pool cross the wire again
 *
 * The same reason as routing: persistence is browser-local, so the server has no copy
 * of the trip. It reads a plan and a pool, returns a new plan, and forgets both.
 *
 * The pool travelling with the request is what makes a refinement checkable — the
 * server verifies every chosen place against *the pool the client sent*, and that pool
 * is itself re-validated by `TripGenerationContextSchema` on the way in. A client
 * cannot widen the eligible set by sending a bigger pool than it holds, because the
 * plan is checked against that same pool: any place in the plan but not in the pool
 * fails, and any place added from a fabricated pool entry fails the pool's own
 * identity checks.
 *
 * ## What never crosses back
 *
 * The prompt, the model's raw output, the candidate list, a provider name, an HTTP
 * status, hidden reasoning, a stack trace. `failed` carries our own codes and
 * sentences; `unavailable` carries a reason from a closed set.
 *
 * ## Not here: `retry-routes`
 *
 * The request schema accepts only the four AI commands. Route retry goes to
 * `POST /api/trips/route` with `retryLegIds`, because it needs the routing provider,
 * the routing cache and that route's duration budget — and because this endpoint
 * making routing calls is precisely the boundary blur worth avoiding.
 */

/**
 * A plan (~45 KB) plus a pool (~40 KB) plus a command.
 *
 * The same ceiling the routing route uses, and for the same reason: the payload is
 * dominated by two structures whose sizes are already bounded elsewhere.
 */
export const REFINE_MAX_BODY_BYTES = 512 * 1024;

export const RefineTripRequestSchema = z.object({
  plan: TripPlanSchema,
  /**
   * The retained generation context, pool included.
   *
   * Required rather than optional: a trip with no context has no pool, and a
   * refinement with no pool has no way to verify a chosen place. The sample trip and
   * anything saved before Phase 5B therefore cannot be refined, which the UI reflects
   * by not offering the actions.
   */
  generation: TripGenerationContextSchema,
  command: AiRefinementCommandSchema,
  providerPreference: z
    .enum(["auto", "gemini", "ollama", "deterministic"])
    .default("auto"),
  /**
   * The revision the client read before starting. Echoed back untouched.
   *
   * The server does not check it — it has no storage to check against. This is a
   * token the guarded client-side save compares, not an authorisation.
   */
  expectedRevision: z.number().int().positive(),
  requestId: z.string().min(8).max(64),
});
export type RefineTripRequest = z.infer<typeof RefineTripRequestSchema>;

const RefinementSummarySchema = z.object({
  /**
   * Every action in the vocabulary, including the many this endpoint never returns.
   *
   * Only four actions reach this route; the rest are applied entirely in the browser. But the
   * *summary* is one shape the UI renders whatever produced it, and narrowing the enum here would
   * mean a client-built summary could not be described by the contract it shares with the
   * server-built one.
   *
   * By Phase 8 the locally-applied majority is the point rather than an exception: the editable
   * workspace is deterministic arithmetic over data the browser already holds, which is what makes
   * it instant and what keeps it working offline. This list stays exhaustive so it and
   * `REFINEMENT_ACTION_LABELS` cannot drift — the `Record` over `RefinementActionType` makes tsc
   * enforce the other direction.
   */
  action: z.enum([
    "regenerate-trip",
    "replace-item",
    "replace-backup",
    "adjust-day",
    "retry-routes",
    "resolve-hours-conflict",
    "recalculate-estimates",
    "promote-backup",
    "move-item",
    "refresh-place-pool",
    // Phase 8 — all locally applied.
    "set-item-time",
    "set-item-duration",
    "insert-free-time",
    "remove-item",
    "lock-item",
    "unlock-item",
    "select-alternative",
  ]),
  changedItemIds: z.array(z.string()),
  addedItemIds: z.array(z.string()),
  removedItemIds: z.array(z.string()),
  preservedItemIds: z.array(z.string()),
  invalidatedLegIds: z.array(z.string()),
  affectedDays: z.array(z.number().int().positive()),
  previousEstimatedTotal: z.number(),
  newEstimatedTotal: z.number(),
  revisionBefore: z.number().int().positive(),
  revisionAfter: z.number().int().positive().optional(),
});

const RefinementWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  dayNumber: z.number().int().positive().optional(),
  itemId: z.string().min(1).optional(),
});

const SuccessBase = {
  plan: TripPlanSchema,
  generationContext: TripGenerationContextSchema,
  summary: RefinementSummarySchema,
  expectedRevision: z.number().int().positive(),
  requestId: z.string().min(1),
};

export const RefineTripResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    ...SuccessBase,
    warnings: z.array(RefinementWarningSchema).length(0),
  }),
  z.object({
    /** A valid, saveable plan that carries notes worth showing. Still a 200. */
    status: z.literal("partial"),
    ...SuccessBase,
    warnings: z.array(RefinementWarningSchema).min(1),
  }),
  z.object({
    status: z.literal("refused"),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum([
      "not_configured",
      "rate_limited",
      "timeout",
      "provider_unavailable",
      "invalid_response",
      "empty_response",
      "aborted",
      "unknown",
    ]),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    /** Our codes and our sentences. Never a provider's. */
    errors: z.array(
      z.object({
        code: z.string().min(1),
        message: z.string().min(1),
        dayNumber: z.number().int().positive().optional(),
        itemId: z.string().min(1).optional(),
      }),
    ),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
]);
export type RefineTripResponse = z.infer<typeof RefineTripResponseSchema>;

/** A progress event on the refinement stream. Stage names only, never plan data. */
export const RefinementProgressEventSchema = z.object({
  stage: z.enum(REFINEMENT_STAGES),
});
export type RefinementProgressEvent = z.infer<
  typeof RefinementProgressEventSchema
>;
