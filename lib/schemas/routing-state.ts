import { z } from "zod";

/**
 * The routing-enrichment vocabulary that the *plan schema itself* needs.
 *
 * ## Why these live here rather than in `lib/plan/`
 *
 * `TripPlan` persists the applied policy and the coverage summary, so
 * `lib/schemas/trip-plan.ts` has to import them. `lib/plan/` in turn imports
 * `TripPlan`, and `lib/routing/derive.ts` imports `@/lib/schemas` — so putting
 * these anywhere else creates a module cycle. They are domain vocabulary, the
 * same as `TravelMode` or `PlaceCategory`, and this is where domain vocabulary
 * lives.
 *
 * `ModePolicySchema` is imported from `@/lib/routing/schemas` rather than the
 * `@/lib/routing` barrel for the same reason: the barrel pulls in `derive.ts`,
 * which imports back into this directory.
 */
import { ModePolicySchema } from "@/lib/routing/schemas";

/**
 * Whether a day's routing brackets the accommodation.
 *
 * `none` by default. A plan whose first stop is a 10:30 café did not begin with
 * a walk from the hotel — the traveller may have had breakfast there, arrived
 * from the airport, or gone for a run. Asserting that leg would be inventing a
 * journey, which is the one thing this codebase does not do.
 */
export const AccommodationRoutingPolicySchema = z.enum(["none", "bracket-day"]);
export type AccommodationRoutingPolicy = z.infer<
  typeof AccommodationRoutingPolicySchema
>;

/**
 * What happens to a travel segment that already exists.
 *
 * The three differ in **what is attempted** as well as in what is replaced,
 * which is what makes them genuinely distinct rather than three names for one
 * rule:
 *
 * | policy | attempts a leg whose segment is… | replaces |
 * | --- | --- | --- |
 * | `preserve-routed` (default) | estimated, unavailable, or absent | those three |
 * | `replace-estimates` | estimated or absent only | those two |
 * | `refresh-all` | every leg | everything, routed included |
 *
 * `preserve-routed` is the default because it is the safest *useful* answer: a
 * fact we already have is never overwritten and never re-requested, while a leg
 * that previously failed gets another chance. `replace-estimates` additionally
 * declines to retry known failures, which is right when a provider is known to
 * be struggling. `refresh-all` is the only way to overwrite a routed segment,
 * and it has to be asked for explicitly.
 */
export const ExistingSegmentPolicySchema = z.enum([
  "preserve-routed",
  "replace-estimates",
  "refresh-all",
]);
export type ExistingSegmentPolicy = z.infer<typeof ExistingSegmentPolicySchema>;

export const DEFAULT_EXISTING_SEGMENT_POLICY: ExistingSegmentPolicy =
  "preserve-routed";

/**
 * The policy actually used for a run, recorded on the plan.
 *
 * The one part of enrichment that is **not** derivable from the segments
 * afterwards. Without it, "3 of 8 legs routed" is unreadable: a different mode
 * policy expects a different number of legs, so the denominator only means
 * something alongside the policy that produced it.
 */
export const AppliedRoutingPolicySchema = z.object({
  modePolicy: ModePolicySchema,
  accommodation: AccommodationRoutingPolicySchema,
  existingSegments: ExistingSegmentPolicySchema,
});
export type AppliedRoutingPolicy = z.infer<typeof AppliedRoutingPolicySchema>;

/**
 * How much of a plan, or of one day, has real routing behind it.
 *
 *  - `not_attempted` — no run has happened, or no legs were expected
 *  - `complete` — every expected leg is routed
 *  - `partial` — some routed, some not
 *  - `unavailable` — legs were attempted and none succeeded
 */
export const RoutingCompletionSchema = z.enum([
  "complete",
  "partial",
  "not_attempted",
  "unavailable",
]);
export type RoutingCompletion = z.infer<typeof RoutingCompletionSchema>;

const COUNT_FIELDS = {
  expectedLegs: z.number().int().nonnegative(),
  attemptedLegs: z.number().int().nonnegative(),
  routedLegs: z.number().int().nonnegative(),
  estimatedLegs: z.number().int().nonnegative(),
  unavailableLegs: z.number().int().nonnegative(),
  pendingLegs: z.number().int().nonnegative(),
  totalRoutedDistanceMeters: z.number().finite().nonnegative(),
  totalRoutedDurationSeconds: z.number().finite().nonnegative(),
  completion: RoutingCompletionSchema,
} as const;

export const RoutingDaySummarySchema = z.object({
  dayNumber: z.number().int().positive(),
  ...COUNT_FIELDS,
});
export type RoutingDaySummary = z.infer<typeof RoutingDaySummarySchema>;

/**
 * Trip-level counts, plus the per-day breakdown they are the sum of.
 *
 * The reconciliation rules, enforced in `lib/plan/validate-derived.ts` and
 * asserted directly in tests:
 *
 *  - `expected = routed + estimated + unavailable + pending`
 *  - `attempted = routed + unavailable` — a pending leg was never asked about,
 *    and a retained estimate was not attempted under this policy
 *  - trip counts equal the sum of the day counts, exactly
 *  - `unavailable` is never folded into `routed`; they are different claims
 */
export const RoutingEnrichmentSummarySchema = z.object({
  ...COUNT_FIELDS,
  daySummaries: z.array(RoutingDaySummarySchema),
});
export type RoutingEnrichmentSummary = z.infer<
  typeof RoutingEnrichmentSummarySchema
>;
