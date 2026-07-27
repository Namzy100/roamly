import { describe, expect, it } from "vitest";

import {
  FIXTURE_DESTINATION,
  FIXTURE_PLACES,
  fixturePool,
} from "@/lib/generate/test-fixtures";
import { routingPolicyForPace } from "@/lib/generate/pace-policy";
import { mockTripPlan } from "@/lib/mock/lisbon-trip";
import {
  GENERATION_CONTEXT_SCHEMA_VERSION,
  MAX_PERSISTED_POOL_PLACES,
  TripGenerationContextSchema,
  type TripGenerationContext,
} from "@/lib/schemas";

import {
  TripRecordSchema,
  createTripRecord,
  nextRevision,
} from "./trip-record";

/**
 * The retained generation context, and the guarantee it carries.
 *
 * The point of the whole record is that a generated trip cannot exist without the
 * pool that proves its places were discovered. So these tests are about what the
 * envelope refuses: an unversioned context, an unbounded pool, a corrupt pool, and a
 * routing write that quietly drops the context on its way past.
 */

const NOW = "2026-07-27T10:00:00.000Z";
const LATER = "2026-07-27T10:05:00.000Z";

function context(
  overrides: Partial<TripGenerationContext> = {},
): TripGenerationContext {
  return {
    schemaVersion: GENERATION_CONTEXT_SCHEMA_VERSION,
    provider: "gemini",
    model: "gemini-test",
    generatedAt: NOW,
    destination: FIXTURE_DESTINATION,
    placePool: fixturePool(),
    discoverySummary: {
      categoriesRequested: ["cafe", "museum", "restaurant"],
      categoriesWithNoResults: [],
      radiusMeters: 4_000,
      requestCount: 1,
      candidateCount: 7,
      discardedCount: 3,
      attribution: "© OpenStreetMap contributors (ODbL)",
    },
    warnings: [],
    routingPolicy: routingPolicyForPace("balanced"),
    ...overrides,
  };
}

describe("TripGenerationContextSchema", () => {
  it("accepts a complete context", () => {
    expect(TripGenerationContextSchema.safeParse(context()).success).toBe(true);
  });

  it("re-validates the pool on read rather than taking it on trust", () => {
    const corrupt = context();
    // A pool whose attached identity does not reconstruct: the exact thing the
    // no-invention gate exists to catch, arriving from localStorage.
    const parsed = TripGenerationContextSchema.safeParse({
      ...corrupt,
      placePool: {
        ...corrupt.placePool,
        places: [{ ...FIXTURE_PLACES.cafeOne, coordinates: { lat: 999, lng: 0 } }],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("bounds the stored pool", () => {
    const oversized = Array.from(
      { length: MAX_PERSISTED_POOL_PLACES + 1 },
      (_, index) => ({
        ...FIXTURE_PLACES.cafeOne,
        placeId: `osm:node:${70_000 + index}`,
        source: {
          ...FIXTURE_PLACES.cafeOne.source,
          canonicalId: `osm:node:${70_000 + index}`,
          osmId: String(70_000 + index),
        },
      }),
    );

    const parsed = TripGenerationContextSchema.safeParse({
      ...context(),
      placePool: { ...fixturePool(), places: oversized },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an unversioned or wrongly versioned context", () => {
    const { schemaVersion: _dropped, ...withoutVersion } = context();

    expect(TripGenerationContextSchema.safeParse(withoutVersion).success).toBe(false);
    expect(
      TripGenerationContextSchema.safeParse({ ...context(), schemaVersion: 99 })
        .success,
    ).toBe(false);
  });

  it("rejects a provider outside the closed set", () => {
    expect(
      TripGenerationContextSchema.safeParse({ ...context(), provider: "openai" })
        .success,
    ).toBe(false);
  });

  it("requires the routing policy the pace implied", () => {
    const { routingPolicy: _dropped, ...withoutPolicy } = context();

    expect(TripGenerationContextSchema.safeParse(withoutPolicy).success).toBe(false);
  });

  it("keeps the pool's unselected candidates, which is the point of retaining it", () => {
    const parsed = TripGenerationContextSchema.parse(context());

    // Seven discovered places, whatever the itinerary ended up using.
    expect(parsed.placePool.places).toHaveLength(7);
  });
});

describe("the stored envelope", () => {
  it("saves a plan and its context together at revision 1", () => {
    const record = createTripRecord(mockTripPlan, NOW, context());

    expect(record.revision).toBe(1);
    expect(record.generation?.provider).toBe("gemini");
    expect(TripRecordSchema.safeParse(record).success).toBe(true);
  });

  it("parses a record saved before generation existed, reporting no context", () => {
    // A v2 envelope: `.nullable().default(null)` rather than a STORE_VERSION bump, so
    // nobody's saved trips are discarded to add a field.
    const parsed = TripRecordSchema.safeParse({
      revision: 3,
      createdAt: NOW,
      updatedAt: LATER,
      plan: mockTripPlan,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.generation).toBeNull();
  });

  it("carries the context through a routing write untouched", () => {
    // Routing does not change how a trip was generated.
    const record = createTripRecord(mockTripPlan, NOW, context());
    const routed = nextRevision(record, mockTripPlan, LATER);

    expect(routed.revision).toBe(2);
    expect(routed.generation).toBe(record.generation);
  });

  it("replaces the context on a regeneration", () => {
    const record = createTripRecord(mockTripPlan, NOW, context());
    const regenerated = nextRevision(
      record,
      mockTripPlan,
      LATER,
      context({ provider: "ollama", model: "qwen3:8b" }),
    );

    expect(regenerated.revision).toBe(2);
    expect(regenerated.generation?.provider).toBe("ollama");
  });

  it("can clear the context explicitly, without an accidental drop being possible", () => {
    const record = createTripRecord(mockTripPlan, NOW, context());

    // `undefined` preserves, `null` clears. Two different intentions, two arguments.
    expect(nextRevision(record, mockTripPlan, LATER, null).generation).toBeNull();
    expect(nextRevision(record, mockTripPlan, LATER).generation).not.toBeNull();
  });

  it("does not mutate the record it replaces", () => {
    const record = createTripRecord(mockTripPlan, NOW, context());
    nextRevision(record, mockTripPlan, LATER, context({ provider: "ollama" }));

    expect(record.revision).toBe(1);
    expect(record.generation?.provider).toBe("gemini");
  });

  it("keeps generation out of the plan itself", () => {
    const record = createTripRecord(mockTripPlan, NOW, context());

    // Provenance is a fact about a run, not about a trip. Two plans with identical
    // itineraries must compare equal.
    expect("generation" in record.plan).toBe(false);
    expect("provider" in record.plan).toBe(false);
    expect("placePool" in record.plan).toBe(false);
  });

  it("drops a record whose context is corrupt rather than rendering it", () => {
    const parsed = TripRecordSchema.safeParse({
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      plan: mockTripPlan,
      generation: { provider: "gemini" },
    });

    expect(parsed.success).toBe(false);
  });
});
