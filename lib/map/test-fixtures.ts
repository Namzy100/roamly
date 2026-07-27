import {
  TRIP_PLAN_SCHEMA_VERSION,
  TripPlanSchema,
  type ItineraryDay,
  type ItineraryItem,
  type TripPlace,
  type TripPlan,
} from "@/lib/schemas";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";

/**
 * Small, hand-built plans for the map derivations.
 *
 * The Lisbon mock is deliberately all-confirmed and fully placed, so it cannot
 * exercise the exclusion rules. These fixtures cover the shapes the pipeline will
 * eventually produce — unavailable slots, placeless downtime, single-stop days —
 * without polluting the demo data with cases a reviewer would find confusing.
 */

export function testPlace(overrides: Partial<TripPlace> = {}): TripPlace {
  const placeId = overrides.placeId ?? "p_1";

  const base: TripPlace = {
    placeId,
    name: "Test Place",
    category: "museum",
    address: "1 Test Street",
    coordinates: { lat: 38.7, lng: -9.14 },
    source: {
      provider: "mock",
      canonicalId: placeId,
      attribution: "Test fixture",
    },
  };

  // `source.canonicalId` must track `placeId`, so it is derived after the spread
  // rather than before — unless the caller supplied a source deliberately, which
  // the pool tests do in order to exercise mismatch detection.
  const merged = { ...base, ...overrides };
  if (!overrides.source) {
    merged.source = { ...base.source, canonicalId: merged.placeId };
  }
  return merged;
}

export function testItem(overrides: Partial<ItineraryItem> = {}): ItineraryItem {
  return {
    id: "i_1",
    order: 0,
    kind: "attraction",
    mealType: null,
    title: "Test Item",
    rationale: "Because.",
    status: "confirmed",
    locked: false,
    place: testPlace(),
    startTime: "09:00",
    endTime: "10:00",
    estimatedCost: 10,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
    ...overrides,
  };
}

export function testDay(
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
    totalTravelMinutes: 0,
  };
}

/** Builds a valid plan around the given days, reusing the mock's scaffolding. */
export function testPlan(days: ItineraryDay[]): TripPlan {
  return TripPlanSchema.parse({
    ...mockTripPlan,
    id: "test-plan",
    schemaVersion: TRIP_PLAN_SCHEMA_VERSION,
    days,
    budget: {
      ...mockTripPlan.budget,
      byDay: days.map((day) => ({
        dayNumber: day.dayNumber,
        amount: day.dayTotal,
      })),
    },
  });
}

/**
 * The accommodation place id the mock uses, for assertions.
 *
 * The sample plan always has one; the non-null assertion documents that rather
 * than making every call site defensive about a fixture we control.
 */
export const MOCK_STAY_PLACE_ID = mockTripPlan.accommodation!.place.placeId;

/**
 * A realistically-shaped OSM-sourced place, for pool and normalisation tests.
 *
 * Deliberately separate from `testPlace`, which is mock-sourced: the two provider
 * paths have different invariants and conflating them in one helper would make the
 * tests less clear about which is being exercised.
 */
export function testOsmPlace(
  overrides: Partial<TripPlace> & {
    osmType?: "node" | "way" | "relation";
    osmId?: string;
  } = {},
): TripPlace {
  const osmType = overrides.osmType ?? "node";
  const osmId = overrides.osmId ?? "240109189";
  const placeId = overrides.placeId ?? `osm:${osmType}:${osmId}`;

  const base: TripPlace = {
    placeId,
    name: "Museu Nacional do Azulejo",
    category: "museum",
    coordinates: { lat: 38.7248, lng: -9.115 },
    source: {
      provider: "openstreetmap",
      canonicalId: placeId,
      osmType,
      osmId,
      fetchedAt: "2026-07-26T10:00:00.000Z",
      attribution: "© OpenStreetMap contributors (ODbL)",
    },
  };

  const { osmType: _t, osmId: _i, ...placeOverrides } = overrides;
  return { ...base, ...placeOverrides };
}
