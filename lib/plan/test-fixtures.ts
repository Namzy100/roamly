import { mockTripPlan } from "@/lib/mock/lisbon-trip";
import {
  routingLegId,
  type RoutedDayLeg,
  type RoutedDayResult,
  type RouteResult,
  type RoutingMode,
} from "@/lib/routing";
import {
  TripPlanSchema,
  type AppliedRoutingPolicy,
  type ItineraryDay,
  type ItineraryItem,
  type TravelSegment,
  type TripPlace,
  type TripPlan,
} from "@/lib/schemas";

import { DEFAULT_ROUTING_POLICY } from "./policy";

/**
 * Small, hand-built plans and routing results for the enrichment tests.
 *
 * The Lisbon mock is five full days of estimates, which is the wrong shape for
 * asserting a single replacement rule. These fixtures are deliberately minimal —
 * two or three stops, one or two days — so a test's failure points at the rule
 * it was checking rather than at a fixture forty stops long.
 *
 * Coordinates are real Baixa points a few hundred metres apart, so the default
 * mode policy resolves them to walking legs without any special casing.
 */

/** ~230 m apart each — comfortably inside the walking band. */
export const FIXTURE_PLACES = {
  a: fixturePlace("a", 38.71, -9.14),
  b: fixturePlace("b", 38.712, -9.138),
  c: fixturePlace("c", 38.714, -9.136),
  stay: fixturePlace("stay", 38.709, -9.141),
} as const;

export function fixturePlace(
  slug: string,
  lat: number,
  lng: number,
): TripPlace {
  return {
    placeId: `mock_${slug}`,
    name: slug,
    category: "attraction",
    coordinates: { lat, lng },
    source: {
      provider: "mock",
      canonicalId: `mock_${slug}`,
      attribution: "Sample data — not sourced from any provider",
    },
  };
}

export function fixtureItem(
  id: string,
  place: TripPlace | null,
  overrides: Partial<ItineraryItem> = {},
): ItineraryItem {
  return {
    id,
    order: 0,
    kind: "attraction",
    mealType: null,
    title: id,
    rationale: "Because.",
    status: "confirmed",
    locked: false,
    place,
    startTime: "10:00",
    endTime: "11:00",
    estimatedCost: 10,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
    ...overrides,
  };
}

export function fixtureDay(
  dayNumber: number,
  items: ItineraryItem[],
): ItineraryDay {
  return {
    dayNumber,
    date: `2026-09-${String(11 + dayNumber).padStart(2, "0")}`,
    theme: `Day ${dayNumber}`,
    summary: "Summary.",
    items,
    backups: [],
    dayTotal: items.reduce((sum, item) => sum + item.estimatedCost, 0),
    totalTravelMinutes: items.reduce(
      (sum, item) =>
        sum +
        (item.travelToNext?.status === "estimated"
          ? item.travelToNext.estimatedDurationMinutes
          : item.travelToNext?.status === "routed"
            ? item.travelToNext.durationMinutes
            : 0),
      0,
    ),
  };
}

/**
 * A valid plan around the given days, reusing the mock's scaffolding.
 *
 * The accommodation is swapped for a fixture place so `bracket-day` produces
 * walkable legs rather than a 25 km hop to the real hotel's coordinates.
 */
export function fixturePlan(days: ItineraryDay[]): TripPlan {
  return TripPlanSchema.parse({
    ...mockTripPlan,
    id: "fixture-plan",
    days,
    accommodation: { ...mockTripPlan.accommodation, place: FIXTURE_PLACES.stay },
    budget: {
      ...mockTripPlan.budget,
      byDay: days.map((day) => ({
        dayNumber: day.dayNumber,
        amount: day.dayTotal,
      })),
    },
    routing: null,
  });
}

export function estimatedSegment(
  id: string,
  from: TripPlace,
  to: TripPlace,
  minutes = 8,
): TravelSegment {
  return {
    id,
    fromPlaceId: from.placeId,
    toPlaceId: to.placeId,
    note: null,
    status: "estimated",
    provider: "mock",
    mode: "WALK",
    estimatedDurationMinutes: minutes,
    estimatedDistanceMeters: 600,
    basis: "Sample itinerary data — written by hand, not measured",
    confidence: "low",
    disclaimer: "Estimated travel time. Not routed.",
  };
}

/** Three Baixa points, so decoded geometry lands where the fixture places are. */
const FIXTURE_SHAPE_COORDINATES: [number, number][] = [
  [-9.14, 38.71],
  [-9.139, 38.711],
  [-9.138, 38.712],
];

export function routedResult(
  from: TripPlace,
  to: TripPlace,
  options: { mode?: RoutingMode; seconds?: number; meters?: number } = {},
): RouteResult {
  return {
    status: "routed",
    provider: "valhalla",
    mode: options.mode ?? "walk",
    origin: {
      latitude: from.coordinates.lat,
      longitude: from.coordinates.lng,
      canonicalPlaceId: from.placeId,
    },
    destination: {
      latitude: to.coordinates.lat,
      longitude: to.coordinates.lng,
      canonicalPlaceId: to.placeId,
    },
    distanceMeters: options.meters ?? 640,
    durationSeconds: options.seconds ?? 600,
    geometry: { type: "LineString", coordinates: FIXTURE_SHAPE_COORDINATES },
    fetchedAt: "2026-07-27T09:00:00.000Z",
    attribution: "© OpenStreetMap contributors (ODbL) — routing by Valhalla",
  };
}

export function unavailableResult(
  mode: RoutingMode = "walk",
  reason: Extract<RouteResult, { status: "unavailable" }>["reason"] = "no_route",
): RouteResult {
  return {
    status: "unavailable",
    requestedMode: mode,
    reason,
    userMessage: "No route could be found between these two places.",
  };
}

/**
 * A routed leg matching what `deriveExpectedLegs` would produce for the pair.
 *
 * Built through the same `routingLegId` constructor the derivation uses, so a
 * fixture cannot accidentally test against an id format that no longer exists.
 */
export function routedLeg(input: {
  dayNumber: number;
  fromItemId: string;
  toItemId: string;
  from: TripPlace;
  to: TripPlace;
  mode?: RoutingMode;
  result?: RouteResult;
}): RoutedDayLeg {
  const mode = input.mode ?? "walk";
  return {
    id: routingLegId({
      dayNumber: input.dayNumber,
      fromItemId: input.fromItemId,
      toItemId: input.toItemId,
      mode,
    }),
    dayNumber: input.dayNumber,
    fromItemId: input.fromItemId,
    toItemId: input.toItemId,
    fromPlaceId: input.from.placeId,
    toPlaceId: input.to.placeId,
    origin: {
      latitude: input.from.coordinates.lat,
      longitude: input.from.coordinates.lng,
      canonicalPlaceId: input.from.placeId,
    },
    destination: {
      latitude: input.to.coordinates.lat,
      longitude: input.to.coordinates.lng,
      canonicalPlaceId: input.to.placeId,
    },
    mode,
    straightLineMeters: 260,
    result: input.result ?? routedResult(input.from, input.to, { mode }),
  };
}

export function routedDay(
  dayNumber: number,
  legs: RoutedDayLeg[],
): RoutedDayResult {
  const routed = legs.filter((leg) => leg.result.status === "routed");
  return {
    dayNumber,
    legs,
    summary: {
      total: legs.length,
      routed: routed.length,
      unavailable: legs.length - routed.length,
      routedDistanceMeters: routed.reduce(
        (sum, leg) =>
          sum + (leg.result.status === "routed" ? leg.result.distanceMeters : 0),
        0,
      ),
      routedDurationSeconds: routed.reduce(
        (sum, leg) =>
          sum + (leg.result.status === "routed" ? leg.result.durationSeconds : 0),
        0,
      ),
    },
    attribution: "© OpenStreetMap contributors (ODbL) — routing by Valhalla",
  };
}

export const FIXTURE_POLICY: AppliedRoutingPolicy = DEFAULT_ROUTING_POLICY;
