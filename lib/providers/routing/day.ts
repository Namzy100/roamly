import "server-only";

import { deriveDayLegs, deriveLegsFromPlaces } from "@/lib/routing";
import type {
  DayLeg,
  ModePolicy,
  RoutedDayLeg,
  RoutedDayResult,
  RouteRequest,
} from "@/lib/routing";
import type { ItineraryItem, TripPlace } from "@/lib/schemas";

import { ROUTING_ATTRIBUTION } from "./config";
import { routeSegments } from "./service";

/**
 * The route-enrichment pipeline for one day.
 *
 * Composition only: `deriveDayLegs` decides what to ask (pure, exhaustively
 * tested without a network), `routeSegments` asks (bounded, cached, paced), and
 * this function pairs the answers back to the legs in order.
 *
 * ## What it does not do
 *
 * It does not reorder stops, does not mutate the plan it was given, and does not
 * attach anything to a `TripPlan`. The plan is immutable and versioned, and
 * grafting routed segments onto a new version is the orchestration phase's job —
 * doing it here would mean this function needed a plan builder, a schema bump
 * path and a persistence story, none of which belong in a routing pipeline.
 *
 * ## Why one day at a time
 *
 * A day is an independent routing unit. Joining the last stop of Tuesday to the
 * first of Wednesday would produce a leg nobody travels, and routing five days
 * as one continuous request would make one bad leg mid-week take out the whole
 * trip.
 */

export type RouteItineraryDayInput = {
  items: ItineraryItem[];
  accommodation?: TripPlace;
  modePolicy?: ModePolicy;
  /** Whether the day begins and ends at the accommodation. Off by default. */
  includeAccommodation?: boolean;
  /** Part of every leg's identity, so a result cannot land on another day. */
  dayNumber: number;
  signal?: AbortSignal;
};

export async function routeItineraryDay(
  input: RouteItineraryDayInput,
): Promise<RoutedDayResult> {
  return routeDerivedLegs(
    deriveDayLegs({
      items: input.items,
      dayNumber: input.dayNumber,
      accommodation: input.accommodation,
      modePolicy: input.modePolicy,
      includeAccommodation: input.includeAccommodation,
    }),
    input.dayNumber,
    input.signal,
  );
}

/**
 * The same pipeline for a bare list of verified places.
 *
 * What `POST /api/routes/day` and the dev surface use: they hold discovery
 * results, not a full itinerary, and building a fake `ItineraryItem` around each
 * place purely to satisfy a signature would invent times, costs and rationales
 * that nothing then reads.
 */
export async function routeDayPlaces(input: {
  places: TripPlace[];
  modePolicy?: ModePolicy;
  dayNumber?: number | null;
  signal?: AbortSignal;
}): Promise<RoutedDayResult> {
  return routeDerivedLegs(
    deriveLegsFromPlaces(input.places, input.modePolicy, input.dayNumber ?? 1),
    input.dayNumber ?? null,
    input.signal,
  );
}

async function routeDerivedLegs(
  legs: DayLeg[],
  dayNumber: number | null,
  signal?: AbortSignal,
): Promise<RoutedDayResult> {
  if (legs.length === 0) return emptyResult(dayNumber);

  const requests: RouteRequest[] = legs.map((leg) => ({
    origin: leg.origin,
    destination: leg.destination,
    mode: leg.mode,
    units: "kilometers",
  }));

  // Order-preserving, so index alignment with `legs` is guaranteed rather than
  // hoped for. `routeSegments` never rejects for a routing outcome.
  const results = await routeSegments(requests, { signal });

  const routedLegs: RoutedDayLeg[] = legs.map((leg, index) => ({
    ...leg,
    result: results[index],
  }));

  return {
    dayNumber,
    legs: routedLegs,
    summary: summarise(routedLegs),
    attribution: ROUTING_ATTRIBUTION,
  };
}

/**
 * Counts and totals, over routed legs only.
 *
 * An unavailable leg contributes nothing — not a zero, not an estimate. A day
 * total that quietly absorbed missing legs as zero minutes would read as a
 * shorter day than it is, which is the failure mode this whole phase exists to
 * remove.
 */
function summarise(legs: RoutedDayLeg[]): RoutedDayResult["summary"] {
  let routed = 0;
  let unavailable = 0;
  let routedDistanceMeters = 0;
  let routedDurationSeconds = 0;

  for (const leg of legs) {
    if (leg.result.status === "routed") {
      routed += 1;
      routedDistanceMeters += leg.result.distanceMeters;
      routedDurationSeconds += leg.result.durationSeconds;
    } else {
      unavailable += 1;
    }
  }

  return {
    total: legs.length,
    routed,
    unavailable,
    routedDistanceMeters,
    routedDurationSeconds,
  };
}

function emptyResult(dayNumber: number | null): RoutedDayResult {
  return {
    dayNumber,
    legs: [],
    summary: {
      total: 0,
      routed: 0,
      unavailable: 0,
      routedDistanceMeters: 0,
      routedDurationSeconds: 0,
    },
    attribution: ROUTING_ATTRIBUTION,
  };
}
