import {
  buildVerifiedPlacePool,
  type PlaceCategory,
  type TripPlan,
  type TripPlace,
  type VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * A pool built from a plan's own attached places.
 *
 * ## What this is honestly for, and what it is not
 *
 * The pool's real job is to be the *external* record a plan is checked against:
 * "these places came out of a provider search, and the itinerary may reference
 * nothing else". A pool derived from the plan cannot make that claim — it is the
 * plan checking itself, and it would happily validate a fabricated place.
 *
 * It exists because the deterministic sample trip predates discovery and has no
 * pool to retain. For that plan the derived pool still does real work during
 * enrichment: it is what the routed endpoints are checked against, so a result
 * attached to the wrong stop is caught. It just cannot also prove provenance,
 * and nothing here pretends it does.
 *
 * When generation lands, the discovery pool travels with the plan and is passed
 * in directly. This helper is then only for plans that never had one.
 *
 * It still runs full `buildVerifiedPlacePool` validation, so a plan carrying a
 * malformed place fails here rather than silently routing it.
 */
export function derivePlanPlacePool(plan: TripPlan): VerifiedPlacePool {
  const seen = new Set<string>();
  const places: TripPlace[] = [];

  const add = (place: TripPlace) => {
    if (seen.has(place.placeId)) return;
    seen.add(place.placeId);
    places.push(place);
  };

  for (const day of plan.days) {
    for (const item of day.items) {
      if (item.place) add(item.place);
    }
  }
  // The accommodation can be a leg endpoint under `bracket-day`, so it belongs
  // in the pool even though it is never an itinerary stop.
  if (plan.accommodation) add(plan.accommodation.place);

  const categories = [
    ...new Set(places.map((place) => place.category)),
  ] as PlaceCategory[];

  return buildVerifiedPlacePool(places, {
    // Deterministic and clearly marked, so nobody mistakes it in a log for a
    // discovery pool.
    poolId: `plan-derived:${plan.id}`,
    createdAt: plan.createdAt,
    categories,
    attribution: places[0]?.source.attribution ?? "Sample data",
    destination: {
      canonicalId: `plan-destination:${plan.id}`,
      name: plan.destination.city,
      latitude: plan.destination.center.lat,
      longitude: plan.destination.center.lng,
    },
  });
}
