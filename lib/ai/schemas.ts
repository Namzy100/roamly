import { z } from "zod";

import {
  CostEstimateSchema,
  MealTypeSchema,
  PaceSchema,
  PlaceCategorySchema,
} from "@/lib/schemas";

/**
 * The two model contracts, and the one thing they have in common: neither can
 * express a place.
 *
 * ## Read this before adding a field
 *
 * The no-invention rule is not enforced by asking nicely. It is enforced by the
 * *shape* of what a model is allowed to return. The strategy schema has nowhere
 * to put a business name, a coordinate or a price it claims to know. The assembly
 * schema has nowhere to put a `TripPlace` — it can only name a `placeId` that the
 * server already discovered, and the server attaches the canonical record itself.
 *
 * A new field that could carry provider-shaped data reopens that hole, and no
 * amount of prompt wording closes it again. `prohibited.ts` is the second line of
 * defence for exactly this reason: Zod *strips* unknown keys rather than
 * rejecting them, so a model that volunteers `latitude` would sail through
 * `parse()` unnoticed. The raw payload is scanned before it is parsed.
 *
 * ## Why the day count is not in the schema
 *
 * Zod can say "between one and seven days". It cannot say "exactly as many days
 * as this trip has", because that depends on the request. Those cross-field
 * invariants live in `validate-strategy.ts` and `validate-assembly.ts`, which is
 * also where the errors can be phrased for a repair pass.
 */

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour HH:MM time");

/**
 * Slot ids are positional and deterministic: `d3-s2` is the second requirement of
 * day three. Making the id derivable from its position is what lets assembly
 * reference a slot without the two calls needing to share state, and what lets
 * validation detect an invented slot rather than accepting any string.
 */
const SLOT_ID = z
  .string()
  .regex(/^d[1-7]-s[1-9]$/, "Slot ids look like d2-s3");

/**
 * Item and backup ids must survive `lib/routing/leg-id.ts`, which builds a leg
 * identity by joining fields with colons and **rejects** an item id containing
 * one. A permissive `z.string()` here would let a model choose `lunch:day2` and
 * blow up at routing time, several steps away from the cause.
 */
const GENERATED_ID = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{2,39}$/,
    "Ids are 3–40 characters of lower-case letters, digits, hyphens and underscores",
  );

/* ========================================================================== */
/* Call #1 — strategy                                                          */
/* ========================================================================== */

/**
 * Budget shares, not amounts.
 *
 * A model asked for currency amounts will produce arithmetic, and arithmetic is
 * the one thing it must not be trusted for — every total in this codebase is
 * recomputed by `lib/plan/derive-totals.ts`. Shares are a genuine planning
 * judgement ("this trip should lean on food rather than tickets"), they are
 * currency-free, and they reconcile against 1 by a check the model cannot fudge.
 */
export const BudgetAllocationSchema = z.object({
  flights: z.number().min(0).max(1),
  accommodation: z.number().min(0).max(1),
  food: z.number().min(0).max(1),
  activities: z.number().min(0).max(1),
  localTransport: z.number().min(0).max(1),
  buffer: z.number().min(0).max(1),
});
export type BudgetAllocation = z.infer<typeof BudgetAllocationSchema>;

export const SearchRequirementSchema = z.object({
  slotId: SLOT_ID,
  /** Allowlist only. This is what keeps user text out of Overpass QL. */
  category: PlaceCategorySchema,
  purpose: z.string().trim().min(5).max(200),
  /**
   * A neighbourhood *name* the model would like this slot to sit in. Never
   * geocoded and never sent to a provider — it is prompt context for assembly,
   * because the model can compare it against candidate addresses itself.
   */
  preferredArea: z.string().trim().min(2).max(80).optional(),
  targetTime: HHMM.optional(),
  /** Non-null marks this as a meal slot, which assembly must fill or mark unavailable. */
  mealType: MealTypeSchema.nullable(),
  required: z.boolean(),
  /** How many candidates of this category assembly should be shown. Bounded. */
  candidateLimit: z.number().int().min(1).max(12),
});
export type SearchRequirement = z.infer<typeof SearchRequirementSchema>;

export const StrategyDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(7),
  theme: z.string().trim().min(3).max(80),
  pace: PaceSchema,
  searchRequirements: z.array(SearchRequirementSchema).min(1).max(6),
});
export type StrategyDay = z.infer<typeof StrategyDaySchema>;

export const TripStrategySchema = z.object({
  destinationSummary: z.string().trim().min(40).max(1400),
  /**
   * An area name, for the traveller and for assembly's benefit. Not a hotel, not
   * an address, and never resolved to coordinates — the destination centre comes
   * from Nominatim and nowhere else.
   */
  recommendedBaseArea: z.string().trim().min(2).max(80),
  languageNote: z.string().trim().min(10).max(400),
  currencyNote: z.string().trim().min(10).max(400),
  seasonalNote: z.string().trim().min(10).max(400),
  /**
   * The discovery radius, in metres, clamped again in `discovery.ts` and once
   * more by the Overpass query builder. Three clamps rather than one because this
   * number decides how much of somebody else's volunteer service we consume.
   */
  recommendedRadiusMeters: z.number().int().min(1000).max(15_000),
  budgetAllocation: BudgetAllocationSchema,
  days: z.array(StrategyDaySchema).min(1).max(7),
  practicalConsiderations: z
    .array(z.string().trim().min(10).max(400))
    .min(1)
    .max(8),
});
export type TripStrategy = z.infer<typeof TripStrategySchema>;

/* ========================================================================== */
/* Call #2 — assembly                                                         */
/* ========================================================================== */

/**
 * The one non-place category set an item may claim.
 *
 * Kept narrow on purpose: these are the blocks a day legitimately needs that no
 * OSM search can supply — getting somewhere, doing nothing, an airport run,
 * checking in. Anything else is a place, and a place needs a `placeId`.
 */
export const NonPlaceCategorySchema = z.enum([
  "transport",
  "free-time",
  "airport",
  "accommodation",
]);
export type NonPlaceCategory = z.infer<typeof NonPlaceCategorySchema>;

/**
 * A cost the model proposes.
 *
 * The full `CostEstimate` shape is accepted so the contract is legible, but three
 * of its fields are not the model's to decide: `basis` must be
 * `category-estimate`, `currency` must be the request's, and `disclaimer` is
 * overwritten with our own wording. Validation rejects the first two rather than
 * silently correcting them — a model claiming `provider-tag` is asserting the
 * price came from a data source, and that is a claim, not a formatting slip.
 */
export const ModelCostEstimateSchema = CostEstimateSchema;

const PlaceItemSchema = z.object({
  kind: z.literal("place"),
  itemId: GENERATED_ID,
  slotId: SLOT_ID,
  /** Must be a member of the supplied candidate list. Checked, not hoped for. */
  placeId: z.string().min(1).max(120),
  /** Must equal the canonical record's category. A mismatch is a hard error. */
  category: PlaceCategorySchema,
  mealType: MealTypeSchema.nullable(),
  startTime: HHMM,
  endTime: HHMM,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20).max(900),
  estimatedCost: ModelCostEstimateSchema,
  reservationRecommended: z.boolean(),
  notes: z.string().trim().min(5).max(400).optional(),
});

const NonPlaceItemSchema = z.object({
  kind: z.literal("non-place"),
  itemId: GENERATED_ID,
  category: NonPlaceCategorySchema,
  startTime: HHMM,
  endTime: HHMM,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20).max(900),
  estimatedCost: ModelCostEstimateSchema,
  notes: z.string().trim().min(5).max(400).optional(),
});

/**
 * A slot the model could not fill from what it was given.
 *
 * The most important arm in the union. Without it, a model facing a day with no
 * discovered café has two options — omit the slot silently, or invent a café —
 * and both are worse than saying so. This arm is what makes "we found nothing
 * here" an expressible, first-class answer, and it is why a sparse destination
 * produces a `partial` result rather than a fabricated one.
 */
const UnavailableItemSchema = z.object({
  kind: z.literal("unavailable"),
  itemId: GENERATED_ID,
  slotId: SLOT_ID,
  reason: z.string().trim().min(10).max(300),
  startTime: HHMM.optional(),
  endTime: HHMM.optional(),
});

export const AssemblyItemSchema = z.discriminatedUnion("kind", [
  PlaceItemSchema,
  NonPlaceItemSchema,
  UnavailableItemSchema,
]);
export type AssemblyItem = z.infer<typeof AssemblyItemSchema>;

export const AssemblyBackupSchema = z.object({
  backupId: GENERATED_ID,
  slotId: SLOT_ID,
  /** Absent means "no alternative was available", which needs a reason. */
  placeId: z.string().min(1).max(120).optional(),
  reason: z.string().trim().min(10).max(300),
  estimatedCost: ModelCostEstimateSchema.optional(),
  unavailableReason: z.string().trim().min(10).max(300).optional(),
});
export type AssemblyBackup = z.infer<typeof AssemblyBackupSchema>;

export const AssemblyDaySchema = z.object({
  dayNumber: z.number().int().min(1).max(7),
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(30).max(900),
  items: z.array(AssemblyItemSchema).min(1).max(10),
  backups: z.array(AssemblyBackupSchema).max(4),
});
export type AssemblyDay = z.infer<typeof AssemblyDaySchema>;

export const GeneratedTripAssemblySchema = z.object({
  title: z.string().trim().min(5).max(140),
  destinationOverview: z.string().trim().min(60).max(1600),
  recommendedNeighborhood: z.object({
    name: z.string().trim().min(2).max(80),
    why: z.string().trim().min(30).max(700),
  }),
  days: z.array(AssemblyDaySchema).min(1).max(7),
  practicalNotes: z
    .array(
      z.object({
        title: z.string().trim().min(3).max(90),
        body: z.string().trim().min(20).max(600),
      }),
    )
    .min(1)
    .max(8),
});
export type GeneratedTripAssembly = z.infer<typeof GeneratedTripAssemblySchema>;

/* ========================================================================== */
/* What the model is shown                                                     */
/* ========================================================================== */

/**
 * A candidate, as the model sees it.
 *
 * Every field is copied verbatim from the canonical pool record. Missing stays
 * missing: there is no `rating`, no `priceLevel`, no `isOpenNow` and no quality
 * score, because OpenStreetMap supplies none of those and synthesising one for
 * the model to reason about would put a fabricated fact into the plan by the back
 * door.
 *
 * `sourceFacts` is prose built mechanically from tags that *are* present, so the
 * model can weigh "has outdoor seating" without us inventing a schema field per
 * OSM tag. `openingHours` is included raw and labelled as uninterpreted — the
 * model may not conclude a place is open at a given hour, and the prompt says so.
 */
export type ModelPlaceCandidate = {
  placeId: string;
  name: string;
  category: z.infer<typeof PlaceCategorySchema>;
  categoryLabel?: string;
  latitude: number;
  longitude: number;
  address?: string;
  cuisine?: string;
  openingHours?: string;
  website?: string;
  sourceFacts: string[];
};

/* ========================================================================== */
/* Repair                                                                      */
/* ========================================================================== */

/**
 * What a repair pass is told.
 *
 * Codes rather than prose, so the report is compact, stable and testable, with
 * one human sentence each. Deliberately *not* the raw validator output: that can
 * carry internal detail, and a repair prompt is not a debugging channel.
 */
export type GenerationViolation = {
  code: string;
  message: string;
  dayNumber?: number;
  slotId?: string;
  itemId?: string;
  placeId?: string;
};

/**
 * Whether a violation is worth one repair attempt.
 *
 * Scheduling, cost and selection mistakes are ordinary and a second pass fixes
 * them. Identity violations are not: a model that referenced a `placeId` outside
 * the pool, or attached provider facts, has done the one thing the architecture
 * forbids, and asking it again invites it to try a different fabrication. Those
 * fail the whole generation.
 */
const UNREPAIRABLE_CODES = new Set([
  "place_outside_pool",
  "prohibited_field",
  "backup_outside_pool",
  "pool_violation",
  "attached_place_mismatch",
]);

export function isRepairable(violations: GenerationViolation[]): boolean {
  return (
    violations.length > 0 &&
    violations.every((violation) => !UNREPAIRABLE_CODES.has(violation.code))
  );
}
