import { z } from "zod";

/**
 * The Ollama `/api/chat` response envelope.
 *
 * Two shapes have to be tolerated, and the difference is not cosmetic:
 *
 *  - a completed non-streaming reply: `{ message: { content }, done: true, … }`
 *  - an error: `{ error: "model 'x' not found, try pulling it first" }`, returned
 *    with **HTTP 200** by some versions
 *
 * That second case is the common one in practice — a base URL pointing at a
 * running Ollama with the configured model not pulled — so it is a first-class
 * field rather than a parse failure. Reporting "the response was unreadable" when
 * the server plainly said which model is missing would be the least useful
 * possible translation.
 *
 * `message.content` is optional because a thinking-capable model can return an
 * empty content string alongside a populated `thinking` field. That is an empty
 * response, not a malformed one, and the two need different handling.
 *
 * `.loose()` throughout: Ollama adds timing and token fields freely across
 * versions, and none of them are load-bearing here.
 */

export const OllamaChatResponseSchema = z
  .object({
    error: z.string().optional(),
    done: z.boolean().optional(),
    done_reason: z.string().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.string().optional(),
        /** Reasoning traces. Read for nothing — never surfaced, never parsed. */
        thinking: z.string().optional(),
      })
      .loose()
      .optional(),
    prompt_eval_count: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional(),
  })
  .loose();
export type OllamaChatResponse = z.infer<typeof OllamaChatResponseSchema>;
