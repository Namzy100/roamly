import { haversineMeters } from "@/lib/routing";
import type {
  PlaceCategory,
  TripPlace,
  TripPlan,
  VerifiedPlacePool,
} from "@/lib/schemas";

import { collectAttachedPlaces } from "./commit";
import type { PlacePoolChangeSummary } from "./types";

/**
 * What a refreshed place search changed.
 *
 * ## Identity is the canonical id, and nothing else
 *
 * Two records are the same place when their `placeId` matches. Not when their names match —
 * "Café Buenos Aires" and "Cafe Buenos Aires" are string-different and place-identical, while
 * two "Manteigaria" branches are string-identical and place-different. Name matching would
 * get both cases wrong, in opposite directions, and silently.
 *
 * ## Identity and facts are compared separately
 *
 * A place whose name was corrected by a mapper is the *same place with a better record*, and
 * belongs in `changedCanonicalRecords` rather than in added-and-removed. Conflating the two
 * would tell a traveller their museum had disappeared and a new one had arrived, when a
 * typo was fixed.
 *
 * ## Coordinates get a tolerance; nothing else does
 *
 * OSM coordinates for the same node drift by metres as mappers refine geometry, and a
 * one-metre change is not information. Every other field is compared exactly, because a
 * changed website or a changed category *is* information. The tolerance is explicit rather
 * than implied by rounding.
 *
 * ## Deterministic
 *
 * Every list is sorted. The same two pools always produce a byte-identical diff, which is
 * what lets a preview be compared against what actually happened.
 */

/**
 * Below this, a coordinate change is mapper refinement rather than a moved place.
 *
 * Smaller than `COORDINATE_TOLERANCE_METERS` (50 m, used for "did a routed leg start where
 * the stop is?") on purpose: that question is about whether a provider snapped to the right
 * road, this one is about whether a record changed, and 25 m is about the width of a large
 * building.
 */
export const POOL_COORDINATE_TOLERANCE_METERS = 25;

const COMPARED_FIELDS = [
  "name",
  "coordinates",
  "category",
  "address",
  "website",
  "phone",
  "openingHours",
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

export function diffPlacePools(input: {
  previous: VerifiedPlacePool;
  next: VerifiedPlacePool;
  /** Used to single out the places the itinerary actually depends on. */
  plan: TripPlan;
}): PlacePoolChangeSummary {
  const previousById = new Map(
    input.previous.places.map((place) => [place.placeId, place]),
  );
  const nextById = new Map(input.next.places.map((place) => [place.placeId, place]));

  const addedPlaceIds: string[] = [];
  const removedPlaceIds: string[] = [];
  const retainedPlaceIds: string[] = [];
  const changedCanonicalRecords: PlacePoolChangeSummary["changedCanonicalRecords"] =
    [];

  for (const [placeId, previous] of previousById) {
    const next = nextById.get(placeId);
    if (!next) {
      removedPlaceIds.push(placeId);
      continue;
    }

    retainedPlaceIds.push(placeId);
    const changedFields = changedFieldsBetween(previous, next);
    if (changedFields.length > 0) {
      changedCanonicalRecords.push({ placeId, changedFields });
    }
  }

  for (const placeId of nextById.keys()) {
    if (!previousById.has(placeId)) addedPlaceIds.push(placeId);
  }

  /**
   * The places the plan depends on that the new search no longer has.
   *
   * The subset of `removedPlaceIds` that matters: a removed candidate nobody chose is
   * housekeeping, and a removed *stop* is a decision the traveller has to make.
   */
  const used = new Set(
    collectAttachedPlaces(input.plan).map((place) => place.placeId),
  );
  const missingUsedPlaceIds = removedPlaceIds.filter((placeId) =>
    used.has(placeId),
  );

  return {
    previousCount: input.previous.places.length,
    newCount: input.next.places.length,
    addedPlaceIds: addedPlaceIds.sort(),
    removedPlaceIds: removedPlaceIds.sort(),
    retainedPlaceIds: retainedPlaceIds.sort(),
    changedCanonicalRecords: changedCanonicalRecords.sort((a, b) =>
      a.placeId.localeCompare(b.placeId),
    ),
    missingUsedPlaceIds: missingUsedPlaceIds.sort(),
    categoryChanges: categoryChanges(input.previous, input.next),
  };
}

function changedFieldsBetween(
  previous: TripPlace,
  next: TripPlace,
): ComparedField[] {
  const changed: ComparedField[] = [];

  if (previous.name !== next.name) changed.push("name");

  const metres = haversineMeters(
    { latitude: previous.coordinates.lat, longitude: previous.coordinates.lng },
    { latitude: next.coordinates.lat, longitude: next.coordinates.lng },
  );
  if (metres > POOL_COORDINATE_TOLERANCE_METERS) changed.push("coordinates");

  if (previous.category !== next.category) changed.push("category");
  if ((previous.address ?? null) !== (next.address ?? null)) changed.push("address");
  if ((previous.website ?? null) !== (next.website ?? null)) changed.push("website");
  if ((previous.phone ?? null) !== (next.phone ?? null)) changed.push("phone");
  if ((previous.openingHours ?? null) !== (next.openingHours ?? null)) {
    changed.push("openingHours");
  }

  // In the declared order, so two equivalent diffs serialise identically.
  return COMPARED_FIELDS.filter((field) => changed.includes(field));
}

function categoryChanges(
  previous: VerifiedPlacePool,
  next: VerifiedPlacePool,
): PlacePoolChangeSummary["categoryChanges"] {
  const categories = [
    ...new Set([
      ...previous.places.map((place) => place.category),
      ...next.places.map((place) => place.category),
    ]),
  ].sort() as PlaceCategory[];

  return categories.map((category) => ({
    category,
    previousCount: previous.places.filter((place) => place.category === category)
      .length,
    newCount: next.places.filter((place) => place.category === category).length,
  }));
}

/** Categories the refreshed search returned nothing for but the old one had. */
export function categoriesNowEmpty(
  changes: PlacePoolChangeSummary,
): PlaceCategory[] {
  return changes.categoryChanges
    .filter((entry) => entry.previousCount > 0 && entry.newCount === 0)
    .map((entry) => entry.category);
}
