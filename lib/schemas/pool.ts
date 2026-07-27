import { z } from "zod";

import {
  PlaceCategorySchema,
  TripPlaceSchema,
  isOsmSourced,
  type TripPlace,
} from "./place";

/**
 * The verified place pool — the mechanism behind the no-invention rule.
 *
 * An itinerary may only reference places that came out of a real provider search.
 * The pool *is* that search's result set, and `assertItineraryUsesPool` is the gate
 * that makes the rule mechanical rather than a hope about model behaviour.
 *
 * ## No silent repair
 *
 * Every check below throws. Nothing is dropped, coerced, deduplicated-away or
 * patched up. A pool that fails validation is a bug in the pipeline that produced
 * it, and quietly fixing it would hide exactly the failure this exists to catch —
 * a fabricated place slipping into a plan.
 */

export const VerifiedPlacePoolSchema = z.object({
  poolId: z.string().min(1),
  createdAt: z.string().min(1),
  places: z.array(TripPlaceSchema),
  categories: z.array(PlaceCategorySchema),
  attribution: z.string().min(1),
  /** The geocoded destination this pool was built around, when there was one. */
  destination: z
    .object({
      canonicalId: z.string().min(1),
      name: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});
export type VerifiedPlacePool = z.infer<typeof VerifiedPlacePoolSchema>;

export class PoolValidationError extends Error {
  readonly code:
    | "duplicate_place_id"
    | "malformed_source_identity"
    | "placeid_source_mismatch"
    | "missing_coordinates"
    | "missing_name"
    | "unsupported_category"
    | "mock_claims_osm_source"
    | "osm_identity_mismatch"
    | "attached_place_mismatch"
    | "place_outside_pool";
  readonly placeId?: string;

  constructor(
    code: PoolValidationError["code"],
    message: string,
    placeId?: string,
  ) {
    super(message);
    this.name = "PoolValidationError";
    this.code = code;
    this.placeId = placeId;
  }
}

/**
 * Builds a pool, validating every record.
 *
 * Throws on the first problem rather than collecting them: a pool is all-or-nothing,
 * and a partially valid pool is not something any caller should be able to use.
 */
export function buildVerifiedPlacePool(
  places: TripPlace[],
  meta: {
    poolId: string;
    createdAt: string;
    categories: VerifiedPlacePool["categories"];
    attribution: string;
    destination?: VerifiedPlacePool["destination"];
  },
): VerifiedPlacePool {
  const seen = new Set<string>();

  for (const place of places) {
    assertPlaceIsVerifiable(place);

    if (seen.has(place.placeId)) {
      throw new PoolValidationError(
        "duplicate_place_id",
        `Pool contains ${place.placeId} more than once`,
        place.placeId,
      );
    }
    seen.add(place.placeId);
  }

  return VerifiedPlacePoolSchema.parse({
    poolId: meta.poolId,
    createdAt: meta.createdAt,
    places,
    categories: meta.categories,
    attribution: meta.attribution,
    ...(meta.destination ? { destination: meta.destination } : {}),
  });
}

/**
 * The per-place invariants.
 *
 * Exported so the discovery route can reject a bad record before it ever reaches
 * pool construction.
 */
export function assertPlaceIsVerifiable(place: TripPlace): void {
  if (!place.name.trim()) {
    throw new PoolValidationError(
      "missing_name",
      `Place ${place.placeId} has no name`,
      place.placeId,
    );
  }

  if (
    !Number.isFinite(place.coordinates.lat) ||
    !Number.isFinite(place.coordinates.lng)
  ) {
    throw new PoolValidationError(
      "missing_coordinates",
      `Place ${place.placeId} has no usable coordinates`,
      place.placeId,
    );
  }

  if (!PlaceCategorySchema.safeParse(place.category).success) {
    throw new PoolValidationError(
      "unsupported_category",
      `Place ${place.placeId} has category ${JSON.stringify(place.category)}, which is not in the allowlist`,
      place.placeId,
    );
  }

  // The identity a place claims must be the identity it carries.
  if (place.source.canonicalId !== place.placeId) {
    throw new PoolValidationError(
      "placeid_source_mismatch",
      `Place ${place.placeId} declares source.canonicalId ${place.source.canonicalId}`,
      place.placeId,
    );
  }

  if (place.source.provider === "openstreetmap") {
    if (!isOsmSourced(place)) {
      throw new PoolValidationError(
        "malformed_source_identity",
        `OSM-sourced place ${place.placeId} is missing osmType or osmId`,
        place.placeId,
      );
    }
    // Imported lazily to keep the schema layer free of provider imports at module
    // scope; the check itself is pure.
    const expected = `osm:${place.source.osmType}:${place.source.osmId}`;
    if (expected !== place.placeId) {
      throw new PoolValidationError(
        "osm_identity_mismatch",
        `Place ${place.placeId} does not reconstruct from ${place.source.osmType}/${place.source.osmId}`,
        place.placeId,
      );
    }
  }

  /**
   * Mock data must never dress itself up as provider data. Without this, the
   * deterministic sample could be mistaken for verified OSM results — which would
   * make the whole "verified" claim meaningless.
   */
  if (place.source.provider === "mock") {
    if (place.source.osmType !== undefined || place.source.osmId !== undefined) {
      throw new PoolValidationError(
        "mock_claims_osm_source",
        `Mock place ${place.placeId} must not carry OSM element identity`,
        place.placeId,
      );
    }
  }
}

/**
 * Confirms an itinerary only references places from the pool, and that the copies
 * attached to items are faithful.
 *
 * The second half matters as much as the first: a placeId can be in the pool while
 * the attached record has had its name or coordinates altered, which would put a
 * real id on a place that is no longer the same place.
 */
export function assertItineraryUsesPool(
  attachedPlaces: TripPlace[],
  pool: VerifiedPlacePool,
  /**
   * Places the itinerary may still reference that are no longer in the pool (Phase 6C).
   *
   * Empty for generation, for refinement and for routing a trip whose pool has never been
   * refreshed — so the check stays exactly as strict as it was for every path that existed
   * before this parameter did. It is non-empty only after a deliberate pool refresh that
   * the traveller confirmed, and only for places the plan already used.
   *
   * This is the *widening*, written down in one place rather than spread across call
   * sites: an existing reference may resolve to a retained record, and a newly selected
   * place may not — because every candidate list is derived from the pool, which does not
   * contain these.
   */
  retainedPlaces: TripPlace[] = [],
): void {
  const byId = new Map(pool.places.map((place) => [place.placeId, place]));

  for (const retained of retainedPlaces) {
    if (byId.has(retained.placeId)) {
      /**
       * A place cannot be both current and retained.
       *
       * If it were, "is this place in the latest search?" would have two answers, and the
       * one the code happened to read first would decide whether the traveller is warned.
       */
      throw new PoolValidationError(
        "duplicate_place_id",
        `Place ${retained.placeId} is in pool ${pool.poolId} and also recorded as retained after a refresh`,
        retained.placeId,
      );
    }
    byId.set(retained.placeId, retained);
  }

  for (const attached of attachedPlaces) {
    const canonical = byId.get(attached.placeId);
    if (!canonical) {
      throw new PoolValidationError(
        "place_outside_pool",
        `Itinerary references ${attached.placeId}, which is not in pool ${pool.poolId}`,
        attached.placeId,
      );
    }

    if (attached.name !== canonical.name) {
      throw new PoolValidationError(
        "attached_place_mismatch",
        `Place ${attached.placeId} was renamed from ${JSON.stringify(canonical.name)} to ${JSON.stringify(attached.name)}`,
        attached.placeId,
      );
    }

    // Exact comparison. Coordinates come from the provider as given; a change of
    // any size means the record was edited, and "how far is too far" is not a
    // judgement this gate should be making.
    if (
      attached.coordinates.lat !== canonical.coordinates.lat ||
      attached.coordinates.lng !== canonical.coordinates.lng
    ) {
      throw new PoolValidationError(
        "attached_place_mismatch",
        `Place ${attached.placeId} had its coordinates altered`,
        attached.placeId,
      );
    }

    if (attached.category !== canonical.category) {
      throw new PoolValidationError(
        "attached_place_mismatch",
        `Place ${attached.placeId} had its category changed from ${canonical.category} to ${attached.category}`,
        attached.placeId,
      );
    }

    if (attached.source.provider !== canonical.source.provider) {
      throw new PoolValidationError(
        "attached_place_mismatch",
        `Place ${attached.placeId} had its provider changed`,
        attached.placeId,
      );
    }
  }
}

/** Non-throwing form, for surfaces that want to report rather than fail. */
export function validatePool(
  places: TripPlace[],
): { ok: true } | { ok: false; error: PoolValidationError } {
  try {
    const seen = new Set<string>();
    for (const place of places) {
      assertPlaceIsVerifiable(place);
      if (seen.has(place.placeId)) {
        throw new PoolValidationError(
          "duplicate_place_id",
          `Duplicate ${place.placeId}`,
          place.placeId,
        );
      }
      seen.add(place.placeId);
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof PoolValidationError) return { ok: false, error };
    throw error;
  }
}
