import type { TripGenerationContext } from "@/lib/schemas";

/**
 * Whether this trip's stops can be changed right now.
 *
 * ## Why it is one function
 *
 * Three surfaces ask the question — the refine panel, the per-stop action, the
 * per-backup action — and they must give the same answer. Two of them disagreeing is
 * not a cosmetic bug: it offers a traveller a button that cannot work, and the
 * explanation only arrives after they press it.
 *
 * The rule mirrors `resolveRefinementProvider` on the server, which is the authority.
 * This is the client-safe restatement used to decide what to *offer*; the server still
 * refuses an unmeetable request regardless.
 *
 * ## The two conditions
 *
 * **A saved place pool.** Without one there is nothing to verify a chosen place
 * against, and the derived pool would be the plan vouching for itself. That rules out
 * the fixed sample and anything saved before discovery existed.
 *
 * **A planner that may act on this trip.** A real model always may. The deterministic
 * planner may only refine a trip it built itself — using it on a model-generated trip
 * would put template output inside a plan labelled as model-generated, which is the
 * substitution the architecture forbids.
 */
export function canRefinePlaces(input: {
  generation: Pick<TripGenerationContext, "provider"> | null;
  /** Whether a real model is configured. `null` means not yet known. */
  modelAvailable: boolean | null;
}): boolean {
  if (!input.generation) return false;
  if (input.modelAvailable === true) return true;
  // A template refining its own work is the same planner doing the same job.
  return input.generation.provider === "deterministic";
}

/** Why the actions are unavailable, in words a traveller can act on. */
export function refinementUnavailableReason(input: {
  generation: Pick<TripGenerationContext, "provider"> | null;
}): string {
  if (!input.generation) {
    return "This trip has no saved place search behind it, so its stops cannot be verified against one. Only trips generated since place discovery was added can be refined.";
  }
  return "This trip was generated with an AI planner, and none is configured here — so its stops cannot be changed. Recalculating routes still works.";
}
