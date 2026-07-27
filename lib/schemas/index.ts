/**
 * Single import surface for the domain vocabulary.
 *
 * Every type here is inferred from its Zod schema via `z.infer` — there are no
 * hand-written interface duplicates to drift out of sync.
 */
export * from "./enums";
export * from "./generation";
export * from "./place";
export * from "./pool";
export * from "./routing-state";
export * from "./trip-request";
export * from "./trip-plan";
