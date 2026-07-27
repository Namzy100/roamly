import { z } from "zod";

import { ModelCostEstimateSchema } from "@/lib/ai";
import { MealTypeSchema, PlaceCategorySchema } from "@/lib/schemas";

/**
 * What a refinement asks a model for — deliberately much smaller than an assembly.
 *
 * ## Why not reuse the assembly schema
 *
 * Because the question is different. Replacing one stop is not "produce an
 * itinerary"; it is "choose one of these thirty places, or tell me none of them
 * fit". Asking for a whole `TripPlan` back for a single swap would mean revalidating
 * five days to change one line, and it would give the model an opportunity to alter
 * four days nobody asked about.
 *
 * The rule holds throughout: **`placeId` and nothing else.** None of these shapes
 * has a field for a name, a coordinate, a rating or a route figure, so the same
 * prohibited-key scan applies and the same pool membership check applies.
 *
 * ## Why `unavailable` is an arm of every one of them
 *
 * A refinement that cannot be satisfied has to be able to say so. Without this arm
 * a model asked to find a cheaper café where none exists has two options — pick a
 * more expensive one and claim it is cheaper, or invent one — and both are worse
 * than "no eligible alternative was available". It is the same reasoning as the
 * `unavailable` itinerary item, at a smaller scale.
 */

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour HH:MM time");

const GENERATED_ID = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{2,39}$/,
    "Ids are 3–40 characters of lower-case letters, digits, hyphens and underscores",
  );

/* ========================================================================== */
/* Replace one item                                                           */
/* ========================================================================== */

export const ReplaceItemResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("selected"),
    /** Must be one of the supplied candidates. Checked, not trusted. */
    placeId: z.string().min(1).max(120),
    /**
     * Optional: a like-for-like swap usually keeps the original window. The model
     * may shift it — a market that wants a morning, say — and the schedule
     * validator then has to accept the whole day.
     */
    startTime: HHMM.optional(),
    endTime: HHMM.optional(),
    description: z.string().trim().min(20).max(900),
    estimatedCost: ModelCostEstimateSchema,
    reservationRecommended: z.boolean(),
    notes: z.string().trim().min(5).max(400).optional(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string().trim().min(10).max(300),
  }),
]);
export type ReplaceItemResult = z.infer<typeof ReplaceItemResultSchema>;

/* ========================================================================== */
/* Replace one backup                                                         */
/* ========================================================================== */

export const ReplaceBackupResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("selected"),
    placeId: z.string().min(1).max(120),
    reason: z.string().trim().min(10).max(300),
    estimatedCost: ModelCostEstimateSchema.optional(),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string().trim().min(10).max(300),
  }),
]);
export type ReplaceBackupResult = z.infer<typeof ReplaceBackupResultSchema>;

/* ========================================================================== */
/* Adjust one day                                                             */
/* ========================================================================== */

/**
 * One day, rebuilt.
 *
 * Note the absence of `slotId`. Generation's assembly needs slots because the two
 * calls have to agree about what the day requires without sharing state. A day
 * adjustment has the *built* day in front of it, so what matters is what the day
 * ends up containing — meal coverage, stop count, a valid schedule, pool membership
 * — and every one of those is checkable directly. Threading a reconstructed slot
 * model through would add a second source of truth for no gain.
 */
const RefinedPlaceItemSchema = z.object({
  kind: z.literal("place"),
  itemId: GENERATED_ID,
  placeId: z.string().min(1).max(120),
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

const RefinedNonPlaceItemSchema = z.object({
  kind: z.literal("non-place"),
  itemId: GENERATED_ID,
  category: z.enum(["transport", "free-time", "airport", "accommodation"]),
  startTime: HHMM,
  endTime: HHMM,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20).max(900),
  estimatedCost: ModelCostEstimateSchema,
  notes: z.string().trim().min(5).max(400).optional(),
});

const RefinedUnavailableItemSchema = z.object({
  kind: z.literal("unavailable"),
  itemId: GENERATED_ID,
  reason: z.string().trim().min(10).max(300),
  startTime: HHMM.optional(),
  endTime: HHMM.optional(),
  /** Kept so a removed meal can still be reported as a covered-but-empty slot. */
  mealType: MealTypeSchema.nullable().optional(),
});

export const RefinedDayItemSchema = z.discriminatedUnion("kind", [
  RefinedPlaceItemSchema,
  RefinedNonPlaceItemSchema,
  RefinedUnavailableItemSchema,
]);
export type RefinedDayItem = z.infer<typeof RefinedDayItemSchema>;

export const RefinedDayBackupSchema = z.object({
  backupId: GENERATED_ID,
  placeId: z.string().min(1).max(120),
  reason: z.string().trim().min(10).max(300),
  estimatedCost: ModelCostEstimateSchema.optional(),
});

export const AdjustDayResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("adjusted"),
    dayNumber: z.number().int().min(1).max(7),
    summary: z.string().trim().min(30).max(900),
    items: z.array(RefinedDayItemSchema).min(1).max(10),
    backups: z.array(RefinedDayBackupSchema).max(4),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.string().trim().min(10).max(300),
  }),
]);
export type AdjustDayResult = z.infer<typeof AdjustDayResultSchema>;

/**
 * Schema names, used in the prompt and in provider requests.
 *
 * Centralised because the name appears in the instruction text and in the request
 * body, and two spellings of it would make a prompt reference a type the request
 * does not mention.
 */
export const REFINEMENT_SCHEMA_NAMES = {
  replaceItem: "ReplaceItemResult",
  replaceBackup: "ReplaceBackupResult",
  adjustDay: "AdjustDayResult",
} as const;
