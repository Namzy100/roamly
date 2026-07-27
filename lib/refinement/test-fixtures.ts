import { assembleTripPlan, routingPolicyForPace } from "@/lib/generate";
import { deriveExpectedLegsForDay, type ExpectedLeg } from "@/lib/plan";
import {
  FIXTURE_DESTINATION,
  FIXTURE_PLACES,
  FIXTURE_REQUEST,
  fixtureAssembly,
  fixtureOsmPlace,
  fixturePool,
  fixtureStrategy,
} from "@/lib/generate/test-fixtures";
import {
  GENERATION_CONTEXT_SCHEMA_VERSION,
  type AppliedRoutingPolicy,
  type ItineraryItem,
  type TravelSegment,
  type TripGenerationContext,
  type TripPlan,
  type VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * A saved, generated trip — the thing every refinement test starts from.
 *
 * Built by running the **real** `assembleTripPlan` over the Phase 5B fixtures rather
 * than by hand-writing a plan. That matters: a hand-written fixture would drift from
 * what generation actually produces, and refinement tests would then be asserting
 * against a plan shape the app never creates.
 */

export const FIXTURE_POOL: VerifiedPlacePool = fixturePool();

export const FIXTURE_GENERATION: TripGenerationContext = {
  schemaVersion: GENERATION_CONTEXT_SCHEMA_VERSION,
  provider: "gemini",
  model: "gemini-test",
  generatedAt: "2026-07-27T10:00:00.000Z",
  destination: FIXTURE_DESTINATION,
  placePool: FIXTURE_POOL,
  discoverySummary: {
    categoriesRequested: ["cafe", "museum", "restaurant"],
    categoriesWithNoResults: [],
    radiusMeters: 4_000,
    requestCount: 1,
    candidateCount: FIXTURE_POOL.places.length,
    discardedCount: 0,
    attribution: "© OpenStreetMap contributors (ODbL)",
  },
  warnings: [],
  routingPolicy: routingPolicyForPace(FIXTURE_REQUEST.pace),
  /**
   * Phase 6B provenance, as a real Lisbon generation would record it.
   *
   * Present rather than absent because the interesting refinement tests are the ones where
   * hours *can* be evaluated; the "no timezone" path is exercised by omitting it in the
   * tests that want it.
   */
  destinationTimezone: { timezone: "Europe/Lisbon", source: "city" },
  costProfile: {
    profileId: "lisbon",
    version: "1.0.0",
    match: "city",
    confidence: "high",
  },
};

/** The demo planner's own trip, for the "a template may refine its own work" path. */
export const FIXTURE_DEMO_GENERATION: TripGenerationContext = {
  ...FIXTURE_GENERATION,
  provider: "deterministic",
  model: "demo-planner-1",
};

export function fixtureSavedPlan(): TripPlan {
  return assembleTripPlan({
    tripId: "trip-refine1",
    request: FIXTURE_REQUEST,
    destination: FIXTURE_DESTINATION,
    strategy: fixtureStrategy(),
    assembly: fixtureAssembly(),
    pool: FIXTURE_POOL,
    source: "generated",
    createdAt: "2026-07-27T10:00:00.000Z",
  }).plan;
}

export const FIXTURE_POLICY: AppliedRoutingPolicy = FIXTURE_GENERATION.routingPolicy;

/**
 * A routed segment on a leg id the caller names.
 *
 * Hand-built rather than obtained from the routing layer: these tests are about what
 * happens to a segment when the itinerary around it changes, and going through a
 * provider to get one would make them slow and dependent on the routing fixtures.
 */
export function fixtureRoutedSegment(
  leg: Pick<ExpectedLeg, "id" | "fromPlaceId" | "toPlaceId" | "mode">,
): TravelSegment {
  return {
    id: leg.id,
    fromPlaceId: leg.fromPlaceId,
    toPlaceId: leg.toPlaceId,
    note: null,
    status: "routed",
    provider: "valhalla",
    // Taken from the derived leg: a routed segment claiming a mode the leg does not
    // have would be a fixture that could never exist in the app.
    mode: leg.mode.toUpperCase() as "WALK" | "DRIVE" | "BICYCLE",
    distanceMeters: 1_200,
    durationSeconds: 900,
    durationMinutes: 15,
    geometry: {
      type: "LineString",
      coordinates: [
        [-9.1409, 38.7169],
        [-9.115, 38.7248],
      ],
    },
    fetchedAt: "2026-07-27T11:00:00.000Z",
    attribution: "© OpenStreetMap contributors · routed with Valhalla",
  };
}

export function fixtureUnavailableSegment(
  leg: Pick<ExpectedLeg, "id" | "fromPlaceId" | "toPlaceId" | "mode">,
): TravelSegment {
  return {
    id: leg.id,
    fromPlaceId: leg.fromPlaceId,
    toPlaceId: leg.toPlaceId,
    note: null,
    status: "unavailable",
    requestedMode: leg.mode.toUpperCase() as "WALK" | "DRIVE" | "BICYCLE",
    reason: "no_route",
    userMessage: "No walking route was found between these two stops.",
  };
}

/**
 * Attaches a segment to the item that owns the given leg, and updates the day's total.
 *
 * Returns a new plan; the input is untouched, like everything else in this codebase.
 */
export function withSegment(
  plan: TripPlan,
  dayNumber: number,
  itemId: string,
  segment: TravelSegment,
): TripPlan {
  return {
    ...plan,
    days: plan.days.map((day) => {
      if (day.dayNumber !== dayNumber) return day;

      const items: ItineraryItem[] = day.items.map((item) =>
        item.id === itemId ? { ...item, travelToNext: segment } : item,
      );

      const minutes = items.reduce((total, item) => {
        const entry = item.travelToNext;
        if (!entry) return total;
        if (entry.status === "routed") return total + entry.durationMinutes;
        if (entry.status === "estimated") {
          return total + entry.estimatedDurationMinutes;
        }
        return total;
      }, 0);

      return { ...day, items, totalTravelMinutes: minutes };
    }),
  };
}

/**
 * The legs a plan actually expects on a day, from the one authority.
 *
 * Derived rather than hand-written, because a leg id encodes the **mode**, and the
 * mode comes from the distance between two real coordinates. Writing
 * `mode:walk` into a fixture and being wrong produces a test that fails for a reason
 * that has nothing to do with what it is checking — which is exactly what happened
 * the first time these were written.
 */
export function expectedLegsFor(plan: TripPlan, dayNumber: number): ExpectedLeg[] {
  const day = plan.days.find((entry) => entry.dayNumber === dayNumber);
  if (!day) throw new Error(`fixture has no day ${dayNumber}`);
  return deriveExpectedLegsForDay(plan, day, FIXTURE_POLICY);
}

/** A trip that has been routed, so `plan.routing` is populated. */
export function fixtureRoutedPlan(): TripPlan {
  const plan = fixtureSavedPlan();
  const leg = expectedLegsFor(plan, 1)[0];
  if (!leg) throw new Error("fixture day 1 has no expected legs");

  const routed = withSegment(plan, 1, leg.fromItemId, fixtureRoutedSegment(leg));

  return {
    ...routed,
    routing: {
      policy: FIXTURE_POLICY,
      lastRoutedAt: "2026-07-27T11:00:00.000Z",
      summary: {
        expectedLegs: 1,
        attemptedLegs: 1,
        routedLegs: 1,
        estimatedLegs: 0,
        unavailableLegs: 0,
        pendingLegs: 0,
        totalRoutedDistanceMeters: 1_200,
        totalRoutedDurationSeconds: 900,
        completion: "complete",
        daySummaries: [
          {
            dayNumber: 1,
            expectedLegs: 1,
            attemptedLegs: 1,
            routedLegs: 1,
            estimatedLegs: 0,
            unavailableLegs: 0,
            pendingLegs: 0,
            totalRoutedDistanceMeters: 1_200,
            totalRoutedDurationSeconds: 900,
            completion: "complete",
          },
        ],
      },
    },
  };
}

/**
 * The id of the expected leg between two items, or null when none is expected.
 *
 * Looked up from the derivation rather than assembled from a template: the mode is
 * part of the identity and is decided by distance, so a hand-built id is a guess.
 */
export function legIdFor(
  plan: TripPlan,
  dayNumber: number,
  fromItemId: string,
  toItemId: string,
): string | null {
  const leg = expectedLegsFor(plan, dayNumber).find(
    (entry) => entry.fromItemId === fromItemId && entry.toItemId === toItemId,
  );
  return leg?.id ?? null;
}

/**
 * A discovered café the itinerary does not use.
 *
 * The Phase 5B fixture pool has exactly seven places and the fixture itinerary consumes all
 * seven, which is not what a real search result set looks like — generation's own tests
 * assert the pool is *larger* than the plan, because the unchosen candidates are what make
 * it evidence rather than self-assertion. Anything that needs a spare place to swap in adds
 * this one rather than reshaping the shared pool and disturbing the candidate counts other
 * tests assert.
 */
export const FIXTURE_SPARE_CAFE = fixtureOsmPlace(
  "1003",
  "Copenhagen Coffee Lab",
  "cafe",
  38.7135,
  -9.1451,
);

/** The context with one spare place in the pool, optionally with published hours. */
export function generationWithSpare(
  options: { openingHours?: string } = {},
): TripGenerationContext {
  const spare = options.openingHours
    ? { ...FIXTURE_SPARE_CAFE, openingHours: options.openingHours }
    : FIXTURE_SPARE_CAFE;

  return {
    ...FIXTURE_GENERATION,
    placePool: fixturePool([...Object.values(FIXTURE_PLACES), spare]),
  };
}

/**
 * The same plan with one place's `opening_hours` rewritten, everywhere it appears.
 *
 * The only way to create an hours conflict without a live provider. Rewritten on the plan
 * *and* on the pool's copy, because the two must agree — a plan whose item disagreed with
 * the pool about a place's own facts would be a fixture the app could not produce.
 */
export function withPlaceHours(
  plan: TripPlan,
  placeId: string,
  openingHours: string,
): TripPlan {
  const rewrite = <T extends { placeId: string }>(place: T): T =>
    place.placeId === placeId ? { ...place, openingHours } : place;

  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      items: day.items.map((item) =>
        item.place ? { ...item, place: rewrite(item.place) } : item,
      ),
      backups: day.backups.map((backup) => ({
        ...backup,
        place: rewrite(backup.place),
      })),
    })),
  };
}

/** The generation context with one pool place's hours rewritten to match. */
export function generationWithPlaceHours(
  placeId: string,
  openingHours: string,
): TripGenerationContext {
  return {
    ...FIXTURE_GENERATION,
    placePool: {
      ...FIXTURE_POOL,
      places: FIXTURE_POOL.places.map((place) =>
        place.placeId === placeId ? { ...place, openingHours } : place,
      ),
    },
  };
}

/** The context with no timezone, for the paths that must refuse to claim anything. */
export function generationWithoutTimezone(): TripGenerationContext {
  const context = { ...FIXTURE_GENERATION };
  delete context.destinationTimezone;
  return context;
}

export { FIXTURE_PLACES, FIXTURE_REQUEST, FIXTURE_DESTINATION };
