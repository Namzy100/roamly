import { isMappableItem, type ItineraryItem, type TripPlace } from "@/lib/schemas";

import {
  accommodationLegEndpointId,
  routingLegId,
} from "./leg-id";
import { DEFAULT_MODE_POLICY, haversineMeters, selectMode } from "./mode-policy";
import type { DayLeg, ModePolicy, RouteLocation } from "./types";

/**
 * Turning a day into the legs worth routing.
 *
 * Pure, synchronous, and provider-free — it is the part of the enrichment
 * pipeline that decides *what to ask*, separated from the part that asks, so the
 * rules below can be tested exhaustively without a network at all.
 *
 * **This is the single authority.** Routing orchestration, enrichment
 * validation, completeness counting and the tests all derive expected legs
 * through this module. Re-deriving them anywhere else would let two answers to
 * "which legs should exist" drift apart, and the whole enrichment contract rests
 * on them agreeing.
 *
 * The rules, in order:
 *
 *  1. **Only place-backed, filled stops.** `isMappableItem` — the same predicate
 *     the map uses — so an unavailable slot or a placeless afternoon is skipped
 *     rather than routed from a guessed coordinate. Nothing here invents a
 *     location, ever.
 *  2. **Consecutive after filtering.** Skipping stop 3 makes 2→4 a real leg: the
 *     traveller does walk that, because stop 3 is not happening. This is the one
 *     place the derivation differs from "adjacent in the array", and it is
 *     correct.
 *  3. **Order is preserved and never changed.** No reordering, no optimisation,
 *     no travelling-salesman. The itinerary's sequence is the itinerary's to own.
 *  4. **One day at a time.** A day is an independent routing unit; nothing joins
 *     the last stop of one day to the first of the next.
 *  5. **The source plan is never mutated.** Everything returned is new.
 *  6. **A zero-distance hop is collapsed, not routed.** See `COLLAPSE_EPSILON`.
 */

/**
 * Two consecutive stops closer together than this are treated as one location
 * and no leg is produced.
 *
 * The documented rule for duplicate consecutive places. It is not an error — a
 * plan can legitimately list "lunch at the market" and "browse the market" as
 * two stops — but there is no journey between them, and asking a routing engine
 * for one yields either a zero-distance result (which the routed arm forbids) or
 * a nonsense loop around the block. 10 m is below the accuracy of any place
 * coordinate we hold, so it cannot collapse a leg anyone actually walks.
 */
export const COLLAPSE_EPSILON_METERS = 10;

/** A stop reduced to what routing needs. */
export type RoutingStop = {
  /** Selection identity — an itinerary item id, or a synthetic accommodation one. */
  itemId: string;
  placeId: string;
  location: RouteLocation;
};

export type DeriveDayLegsInput = {
  items: ItineraryItem[];
  /**
   * Which day these items belong to. Part of every leg's identity, so a result
   * for Tuesday can never be attached to Wednesday.
   */
  dayNumber: number;
  /** Included at the ends only when the policy asks for it. */
  accommodation?: TripPlace;
  modePolicy?: ModePolicy;
  /**
   * Whether the day starts and ends at the accommodation. Off by default: a plan
   * that begins mid-morning at a café did not start with a walk from the hotel,
   * and asserting it did would be an invented leg.
   */
  includeAccommodation?: boolean;
};

export function deriveDayLegs(input: DeriveDayLegsInput): DayLeg[] {
  const stops: RoutingStop[] = [];

  if (input.includeAccommodation && input.accommodation) {
    stops.push(
      toStop(accommodationLegEndpointId("origin"), input.accommodation),
    );
  }

  for (const item of input.items) {
    if (!isMappableItem(item)) continue;
    stops.push(toStop(item.id, item.place));
  }

  if (input.includeAccommodation && input.accommodation) {
    stops.push(
      toStop(accommodationLegEndpointId("return"), input.accommodation),
    );
  }

  return deriveLegsFromStops(stops, input.dayNumber, input.modePolicy);
}

/**
 * The same derivation for a bare list of places.
 *
 * Used by the routing API's day endpoint and the dev surface, which hold
 * verified places from discovery rather than a full itinerary. Identical rules —
 * order preserved, nothing invented — so the two paths cannot drift apart.
 */
export function deriveLegsFromPlaces(
  places: TripPlace[],
  modePolicy?: ModePolicy,
  dayNumber = 1,
): DayLeg[] {
  return deriveLegsFromStops(
    // Index-suffixed, because the same place may legitimately appear twice in a
    // day and each visit needs its own leg identity.
    places.map((place, index) => toStop(`stop-${index}`, place)),
    dayNumber,
    modePolicy,
  );
}

/** The shared core. Everything above is an adapter onto this. */
export function deriveLegsFromStops(
  stops: RoutingStop[],
  dayNumber: number,
  modePolicy: ModePolicy = DEFAULT_MODE_POLICY,
): DayLeg[] {
  const legs: DayLeg[] = [];

  for (let index = 0; index < stops.length - 1; index += 1) {
    const from = stops[index];
    const to = stops[index + 1];

    const straightLineMeters = haversineMeters(from.location, to.location);

    // Two stops at effectively the same point. Documented rule: collapse.
    if (straightLineMeters < COLLAPSE_EPSILON_METERS) continue;

    const selection = selectMode(straightLineMeters, modePolicy);

    // The policy declining to choose is a real outcome, not an error — see
    // `mode-policy.ts`. The leg is dropped rather than routed under a guess.
    if (selection.mode === null) continue;

    legs.push({
      id: routingLegId({
        dayNumber,
        fromItemId: from.itemId,
        toItemId: to.itemId,
        mode: selection.mode,
      }),
      dayNumber,
      fromItemId: from.itemId,
      toItemId: to.itemId,
      fromPlaceId: from.placeId,
      toPlaceId: to.placeId,
      origin: from.location,
      destination: to.location,
      mode: selection.mode,
      straightLineMeters,
    });
  }

  return legs;
}

function toStop(itemId: string, place: TripPlace): RoutingStop {
  return {
    itemId,
    placeId: place.placeId,
    location: {
      latitude: place.coordinates.lat,
      longitude: place.coordinates.lng,
      canonicalPlaceId: place.placeId,
    },
  };
}
