import { z } from "zod";

/**
 * The Gemini response envelope, parsed at the boundary.
 *
 * ## Why everything is optional
 *
 * This is not laziness about the API surface — it is the API surface. The three
 * shapes that matter are all legal HTTP 200 responses:
 *
 *  - a normal answer: one candidate, with content parts
 *  - a prompt-level block: `promptFeedback.blockReason` and **no `candidates` key
 *    at all**
 *  - a candidate-level stop: a candidate with a `finishReason` and no `content`
 *
 * A schema that required `candidates` would turn the second into a parse failure,
 * reported as "invalid response" when the truthful answer is "the model declined".
 * A schema that required `content` would turn the third into the same lie. So the
 * envelope is permissive and `generate.ts` distinguishes the cases explicitly.
 *
 * `.loose()` because the API adds fields — `modelVersion`, `responseId`,
 * `groundingMetadata` — and a strict object would reject a response that is
 * perfectly usable the day one appears.
 */

const GeminiPartSchema = z
  .object({
    text: z.string().optional(),
  })
  .loose();

const GeminiContentSchema = z
  .object({
    parts: z.array(GeminiPartSchema).optional(),
    role: z.string().optional(),
  })
  .loose();

export const GeminiCandidateSchema = z
  .object({
    content: GeminiContentSchema.optional(),
    finishReason: z.string().optional(),
    index: z.number().optional(),
  })
  .loose();
export type GeminiCandidate = z.infer<typeof GeminiCandidateSchema>;

export const GeminiUsageSchema = z
  .object({
    promptTokenCount: z.number().int().nonnegative().optional(),
    candidatesTokenCount: z.number().int().nonnegative().optional(),
    totalTokenCount: z.number().int().nonnegative().optional(),
  })
  .loose();

export const GeminiResponseSchema = z
  .object({
    candidates: z.array(GeminiCandidateSchema).optional(),
    promptFeedback: z
      .object({
        blockReason: z.string().optional(),
      })
      .loose()
      .optional(),
    usageMetadata: GeminiUsageSchema.optional(),
  })
  .loose();
export type GeminiResponse = z.infer<typeof GeminiResponseSchema>;
