import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ItineraryItem, TripPlace } from "@/lib/schemas";

import { routingCache } from "./cache";
import { routeDayPlaces, routeItineraryDay } from "./day";

/**
 * The day pipeline end to end, with a mocked `fetch`.
 *
 * The derivation rules are covered exhaustively in `lib/routing/derive.test.ts`;
 * what is tested here is the composition — that results land on the right legs,
 * that a partial failure keeps its successes, and that nothing is reordered or
 * mutated on the way through.
 */

const SHAPE = "kb|yhAnkylPjvB_uCpxBoyF";

function place(slug: string, lat: number, lng: number): TripPlace {
  return {
    placeId: `mock_${slug}`,
    name: slug,
    category: "attraction",
    coordinates: { lat, lng },
    source: {
      provider: "mock",
      canonicalId: `mock_${slug}`,
      attribution: "Sample data",
    },
  };
}

const A = place("a", 38.71, -9.14);
const B = place("b", 38.712, -9.138);
const C = place("c", 38.714, -9.136);

function item(id: string, tripPlace: TripPlace | null): ItineraryItem {
  return {
    locked: false,
    id,
    order: 0,
    kind: "attraction",
    mealType: null,
    title: id,
    rationale: "because",
    status: "confirmed",
    place: tripPlace,
    startTime: "10:00",
    endTime: "11:00",
    estimatedCost: 0,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
  };
}

function routeResponse(time: number, length: number): Response {
  const summary = { time, length };
  return new Response(
    JSON.stringify({
      trip: {
        status: 0,
        units: "kilometers",
        summary,
        legs: [{ summary, shape: SHAPE }],
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function noRouteResponse(): Response {
  return new Response(
    JSON.stringify({ error_code: 170, error: "Locations are in unconnected regions." }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routingCache.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeItineraryDay", () => {
  it("routes every consecutive pair and summarises them", async () => {
    fetchMock
      .mockResolvedValueOnce(routeResponse(120, 0.2))
      .mockResolvedValueOnce(routeResponse(180, 0.3));

    const day = await routeItineraryDay({
      dayNumber: 2,
      items: [item("1", A), item("2", B), item("3", C)],
    });

    expect(day.dayNumber).toBe(2);
    expect(day.legs).toHaveLength(2);
    expect(day.summary).toEqual({
      total: 2,
      routed: 2,
      unavailable: 0,
      routedDistanceMeters: 500,
      routedDurationSeconds: 300,
    });
    expect(day.attribution).toContain("Valhalla");
  });

  it("pairs each result with its own leg, in order", async () => {
    fetchMock
      .mockResolvedValueOnce(routeResponse(120, 0.2))
      .mockResolvedValueOnce(routeResponse(999, 9.9));

    const day = await routeItineraryDay({
      dayNumber: 1,
      items: [item("1", A), item("2", B), item("3", C)],
    });

    expect(day.legs[0].fromItemId).toBe("1");
    expect(day.legs[0].result.status === "routed" && day.legs[0].result.durationSeconds).toBe(
      120,
    );
    expect(day.legs[1].fromItemId).toBe("2");
    expect(day.legs[1].result.status === "routed" && day.legs[1].result.durationSeconds).toBe(
      999,
    );
  });

  it("keeps successful legs when one is unroutable", async () => {
    fetchMock
      .mockResolvedValueOnce(routeResponse(120, 0.2))
      .mockResolvedValueOnce(noRouteResponse());

    const day = await routeItineraryDay({
      dayNumber: 1,
      items: [item("1", A), item("2", B), item("3", C)],
    });

    expect(day.summary.routed).toBe(1);
    expect(day.summary.unavailable).toBe(1);
    // Totals cover routed legs only — an unroutable leg must not read as zero
    // minutes of travel and shorten the day.
    expect(day.summary.routedDurationSeconds).toBe(120);
  });

  it("returns an empty result for a one-stop day without calling out", async () => {
    const day = await routeItineraryDay({ dayNumber: 1, items: [item("1", A)] });

    expect(day.legs).toEqual([]);
    expect(day.summary.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not mutate the items it was given", async () => {
    fetchMock.mockImplementation(() => routeResponse(120, 0.2));

    const items = [item("1", A), item("2", B)];
    const snapshot = JSON.parse(JSON.stringify(items));

    await routeItineraryDay({ dayNumber: 1, items });

    expect(items).toEqual(snapshot);
  });

  it("routes a day independently, never across days", async () => {
    fetchMock.mockImplementation(() => routeResponse(120, 0.2));

    const monday = await routeItineraryDay({
      dayNumber: 1,
      items: [item("1", A), item("2", B)],
    });
    const tuesday = await routeItineraryDay({
      dayNumber: 2,
      items: [item("3", C), item("4", A)],
    });

    // No leg joins B (end of Monday) to C (start of Tuesday).
    expect(monday.legs).toHaveLength(1);
    expect(tuesday.legs).toHaveLength(1);
    const allPairs = [...monday.legs, ...tuesday.legs].map(
      (leg) => `${leg.fromPlaceId}->${leg.toPlaceId}`,
    );
    expect(allPairs).not.toContain(`${B.placeId}->${C.placeId}`);
  });

  it("excludes the accommodation unless asked", async () => {
    fetchMock.mockImplementation(() => routeResponse(120, 0.2));

    const withoutStay = await routeItineraryDay({
      dayNumber: 1,
      items: [item("1", A), item("2", B)],
      accommodation: place("stay", 38.709, -9.141),
    });
    expect(withoutStay.legs).toHaveLength(1);
  });

  it("brackets the day with the accommodation when asked", async () => {
    fetchMock.mockImplementation(() => routeResponse(120, 0.2));

    const withStay = await routeItineraryDay({
      dayNumber: 1,
      items: [item("1", A), item("2", B)],
      accommodation: place("stay", 38.709, -9.141),
      includeAccommodation: true,
    });
    expect(withStay.legs).toHaveLength(3);
  });
});

describe("routeDayPlaces", () => {
  it("routes a bare list of places in the order given", async () => {
    fetchMock.mockImplementation(() => routeResponse(120, 0.2));

    const day = await routeDayPlaces({ places: [C, A, B], dayNumber: 1 });

    // Deliberately out of geographic order — nothing here optimises a route.
    expect(day.legs.map((leg) => leg.fromPlaceId)).toEqual([C.placeId, A.placeId]);
  });

  it("returns an empty result for fewer than two places", async () => {
    const day = await routeDayPlaces({ places: [A] });
    expect(day.legs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies a forced mode to every leg", async () => {
    fetchMock.mockImplementation(() => routeResponse(120, 0.2));

    const day = await routeDayPlaces({
      places: [A, B, C],
      modePolicy: {
        walkMaxMeters: 1_800,
        driveMinMeters: 8_000,
        allowDriveInMiddleBand: false,
        forcedMode: "bicycle",
      },
    });

    expect(day.legs.map((leg) => leg.mode)).toEqual(["bicycle", "bicycle"]);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(call[1].body as string).costing).toBe("bicycle");
    }
  });
});
