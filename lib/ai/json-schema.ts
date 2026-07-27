import { z } from "zod";

/**
 * One Zod schema, two consumers: the prompt and the runtime.
 *
 * The schema in `schemas.ts` is the authority on what a valid answer is. Rather
 * than restating it in prose inside a prompt — where it would drift the first time
 * a field changed — it is converted to JSON Schema and embedded verbatim. The
 * model reads the same contract the validator enforces, so the two cannot
 * disagree.
 *
 * ## `reused: "inline"`
 *
 * Zod emits `$defs` and `$ref` for a schema used more than once. That is correct
 * JSON Schema and poor prompt material: a model reading `{"$ref": "#/$defs/x"}`
 * has to resolve pointers, and Ollama's constrained decoding does not accept them
 * at all. Inlining costs a few hundred tokens and removes a whole class of
 * failure.
 *
 * ## `oneOf` → `anyOf`
 *
 * Zod renders a discriminated union as `oneOf`. Ollama passes the schema to
 * llama.cpp's grammar compiler, which handles `anyOf` and is unreliable with
 * `oneOf`. For a discriminated union the two are equivalent — the discriminant
 * makes exactly one branch matchable — so the rewrite loses nothing.
 *
 * ## What is *not* done here
 *
 * No relaxation. Nothing widens a `minLength`, drops a `maxItems` or opens
 * `additionalProperties`. The prompt-facing schema and the enforcing schema
 * describe the same set of valid values; only their notation differs.
 */

type JsonSchemaNode = Record<string, unknown>;

/**
 * The JSON Schema for a Zod schema, in provider-friendly form.
 *
 * `io: "output"` matters: an input schema would describe pre-default,
 * pre-transform shapes, and what we need to describe is what the model must
 * *produce*.
 */
export function toProviderJsonSchema(schema: z.ZodType): JsonSchemaNode {
  const raw = z.toJSONSchema(schema, {
    io: "output",
    reused: "inline",
  }) as JsonSchemaNode;

  return normalise(raw);
}

/** The same schema as indented JSON, for embedding in a system instruction. */
export function jsonSchemaText(schema: z.ZodType): string {
  return JSON.stringify(toProviderJsonSchema(schema), null, 2);
}

function normalise(node: unknown): JsonSchemaNode {
  if (Array.isArray(node)) {
    return node.map(normalise) as unknown as JsonSchemaNode;
  }
  if (node === null || typeof node !== "object") {
    return node as JsonSchemaNode;
  }

  const out: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node as JsonSchemaNode)) {
    // A dialect declaration is noise in a prompt and is rejected by some
    // constrained-decoding backends.
    if (key === "$schema") continue;
    out[key === "oneOf" ? "anyOf" : key] = normalise(value);
  }
  return out;
}
