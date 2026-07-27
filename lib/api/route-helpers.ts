import "server-only";

import type { z } from "zod";

import { LIMITS } from "@/lib/providers/osm/config";
import { isProviderError } from "@/lib/providers/osm/errors";
import { isRoutingProviderError } from "@/lib/providers/routing/errors";
import { PoolValidationError } from "@/lib/schemas/pool";

/**
 * Shared route-boundary behaviour.
 *
 * Two jobs: bound and validate what comes in, and make sure only user-safe
 * information goes out. A provider hostname, a stack trace or a raw upstream body
 * must never reach the browser — the internal detail is logged server-side instead.
 */

export type JsonErrorBody = {
  error: { code: string; message: string };
};

export function jsonError(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } } satisfies JsonErrorBody, {
    status,
  });
}

/**
 * Reads and validates a JSON body with a hard size ceiling.
 *
 * The ceiling is checked against the actual bytes read rather than
 * `Content-Length`, which a client controls and can simply lie about.
 */
export async function readJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
  options: { maxBytes?: number } = {},
): Promise<
  { ok: true; data: z.infer<T> } | { ok: false; response: Response }
> {
  // Each route sets its own ceiling: a geocode query is a few hundred bytes,
  // while a day of stops is legitimately larger. The default stays tight.
  const maxBytes = options.maxBytes ?? LIMITS.maxRequestBodyBytes;

  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: jsonError(400, "unreadable_body", "Could not read the request body."),
    };
  }

  if (text.length > maxBytes) {
    return {
      ok: false,
      response: jsonError(
        413,
        "body_too_large",
        "That request was too large.",
      ),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: jsonError(400, "invalid_json", "Expected a JSON body."),
    };
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    // The field path is safe to share — it describes *our* contract, not the
    // provider's. The raw value is not echoed back.
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") || "body";
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_request",
        `Invalid request: ${path} — ${issue?.message ?? "failed validation"}`,
      ),
    };
  }

  return { ok: true, data: result.data };
}

/**
 * Turns any thrown value into a user-safe response.
 *
 * `ProviderError` already carries a deliberately vague `userMessage` and an HTTP
 * status; everything else collapses to a generic 500. Internal detail goes to the
 * server log only.
 */
export function toErrorResponse(error: unknown, context: string): Response {
  if (isRoutingProviderError(error)) {
    console.error(
      `[roamly] ${context} routing failure`,
      JSON.stringify({
        kind: error.kind,
        provider: error.provider,
        status: error.status,
        // Valhalla's own error code, logged for diagnosis and never returned.
        providerCode: error.providerCode,
        message: error.message,
      }),
    );
    return jsonError(error.httpStatus, error.kind, error.userMessage);
  }

  if (isProviderError(error)) {
    console.error(
      `[roamly] ${context} provider failure`,
      JSON.stringify({
        kind: error.kind,
        provider: error.provider,
        status: error.status,
        message: error.message,
      }),
    );
    return jsonError(error.httpStatus, error.kind, error.userMessage);
  }

  if (error instanceof PoolValidationError) {
    console.error(`[roamly] ${context} pool validation failed`, error.message);
    return jsonError(
      500,
      "pool_invalid",
      "The discovered places failed verification and were not returned.",
    );
  }

  console.error(`[roamly] ${context} unexpected failure`, error);
  return jsonError(500, "unexpected", "Something went wrong. Please try again.");
}
