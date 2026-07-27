import "server-only";

/**
 * Turning model text into JSON, and refusing to guess.
 *
 * Both adapters ask for JSON and both providers usually oblige. "Usually" is the
 * problem: a model instructed to emit JSON will occasionally wrap it in a
 * markdown fence, and a smaller local model will occasionally add a sentence
 * before it. Neither is a fabrication and neither should sink a generation, so two
 * narrow accommodations are made — and only two:
 *
 *  1. a fenced block is unwrapped
 *  2. leading and trailing prose around a single balanced top-level object is trimmed
 *
 * What is deliberately **not** done is repair. No quote-fixing, no trailing-comma
 * stripping, no brace-balancing, no "extract the first thing that looks like a
 * field". Truncated or malformed output becomes `invalid_response`, because a
 * half-parsed itinerary is indistinguishable from a complete one to everything
 * downstream, and the repair pass exists precisely so we do not have to guess.
 *
 * Balance is tracked with string- and escape-awareness, so a brace inside a
 * description — "the square (bracketed by cafés)" — cannot end the object early.
 */

export type ModelJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "empty_response" | "invalid_response"; detail: string };

export function parseModelJson(raw: string | undefined | null): ModelJsonResult {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "empty_response", detail: "no content field" };
  }

  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty_response", detail: "content was blank" };
  }

  const candidate = extractObject(stripFence(text));
  if (candidate === null) {
    return {
      ok: false,
      reason: "invalid_response",
      detail: "no balanced JSON object in the response",
    };
  }

  try {
    const value: unknown = JSON.parse(candidate);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        reason: "invalid_response",
        detail: "response was not a JSON object",
      };
    }
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      reason: "invalid_response",
      detail: "response was not valid JSON",
    };
  }
}

/** ```json … ``` or ``` … ``` */
function stripFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  return match ? match[1].trim() : text;
}

/**
 * The first balanced `{…}` region, or null.
 *
 * Returns null rather than the longest-looking substring when braces never
 * balance: unbalanced braces mean the output was truncated, and a truncated
 * object must fail rather than parse to something shorter than intended.
 */
function extractObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}
