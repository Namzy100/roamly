import {
  PoolValidationError,
  assertItineraryUsesPool,
  validatePool,
  type TripGenerationContext,
  type TripPlan,
} from "@/lib/schemas";
import { MAX_RETAINED_PLACES } from "@/lib/schemas";

import { collectAttachedPlaces } from "./commit";
import type { StructuralEditError } from "./types";

/**
 * The checks that keep the widened pool invariant honest.
 *
 * ## Why this file exists at all
 *
 * Phase 6C loosened one rule: an itinerary reference may resolve to a *retained* place rather
 * than a pool member. A loosened rule with no compensating checks is a deleted rule, so the
 * loosening is paid for here, mechanically:
 *
 *  - a placeId may not be in the pool **and** retained — otherwise "did the latest search find
 *    this?" has two answers and whichever the code reads first decides whether the traveller
 *    is warned
 *  - a retained place that no plan item references is a **failure**, not tidy-up. It means the
 *    collection is accumulating, which is how it would quietly become a second pool
 *  - the collection is capped, so a bug that retained indiscriminately fails loudly
 *
 * ## Non-throwing
 *
 * Returns errors rather than throwing, because every caller is either building a preview or
 * deciding whether to save — and neither wants an exception for a condition it is asking
 * about.
 */

export function validateRetainedPlaces(input: {
  plan: TripPlan;
  generation: TripGenerationContext;
}): StructuralEditError[] {
  const retained = input.generation.retainedPlaces ?? [];
  if (retained.length === 0) return [];

  const errors: StructuralEditError[] = [];

  if (retained.length > MAX_RETAINED_PLACES) {
    errors.push({
      code: "pool_invalid",
      message: `${retained.length} retained places exceeds the ${MAX_RETAINED_PLACES} a trip may hold.`,
    });
  }

  const poolIds = new Set(
    input.generation.placePool.places.map((place) => place.placeId),
  );
  const referenced = new Set(
    collectAttachedPlaces(input.plan).map((place) => place.placeId),
  );
  const seen = new Set<string>();

  for (const entry of retained) {
    const placeId = entry.place.placeId;

    if (seen.has(placeId)) {
      errors.push({
        code: "pool_invalid",
        message: `Place ${placeId} is recorded as retained twice.`,
        placeId,
      });
    }
    seen.add(placeId);

    if (poolIds.has(placeId)) {
      errors.push({
        code: "pool_invalid",
        message: `Place ${placeId} is in the active pool and also recorded as retained, so whether the latest search found it is ambiguous.`,
        placeId,
      });
    }

    if (!referenced.has(placeId)) {
      errors.push({
        code: "retained_not_referenced",
        message: `Place ${placeId} is retained but nothing in the itinerary uses it, so it should have been dropped.`,
        placeId,
      });
    }
  }

  const poolCheck = validatePool(retained.map((entry) => entry.place));
  if (!poolCheck.ok) {
    errors.push({
      code: "pool_invalid",
      message: `A retained place is not a verifiable record: ${poolCheck.error.message}`,
      ...(poolCheck.error.placeId ? { placeId: poolCheck.error.placeId } : {}),
    });
  }

  return errors;
}

/**
 * The full membership check for a saved trip, retained places included.
 *
 * The gate a structural edit and a reconciliation both pass through before anything is
 * written, and the one place the widened invariant is spelled out in code:
 *
 * > every attached place resolves to the active pool **or** to a recorded retained place that
 * > the plan currently uses.
 */
export function validatePlanMembership(input: {
  plan: TripPlan;
  generation: TripGenerationContext;
}): StructuralEditError[] {
  const errors = validateRetainedPlaces(input);
  if (errors.length > 0) return errors;

  try {
    assertItineraryUsesPool(
      collectAttachedPlaces(input.plan),
      input.generation.placePool,
      (input.generation.retainedPlaces ?? []).map((entry) => entry.place),
    );
  } catch (error) {
    if (error instanceof PoolValidationError) {
      return [
        {
          code: "pool_violation",
          message: error.message,
          ...(error.placeId ? { placeId: error.placeId } : {}),
        },
      ];
    }
    throw error;
  }

  return [];
}

/**
 * Whether a place may be *newly selected* — the narrow half of the invariant.
 *
 * Every candidate list is derived from the pool, which does not contain retained places, so
 * this is belt and braces rather than the primary defence. It exists because "the pool is the
 * only source of candidates" is an invariant maintained by several modules, and a single
 * predicate is something a new one can be asked to call.
 */
export function placeIsSelectable(
  generation: TripGenerationContext,
  placeId: string,
): boolean {
  return generation.placePool.places.some((place) => place.placeId === placeId);
}

/** Places the plan uses that only the retained collection vouches for. */
export function retainedPlaceIds(
  generation: TripGenerationContext | null,
): Set<string> {
  return new Set(
    (generation?.retainedPlaces ?? []).map((entry) => entry.place.placeId),
  );
}
