import { describe, expect, it } from "vitest";

import {
  FIXTURE_PLACES as P,
  estimatedSegment,
  fixtureDay,
  fixtureItem,
  fixturePlan,
  routedResult,
} from "@/lib/plan/test-fixtures";
import { toTravelSegment } from "@/lib/routing";
import type { TravelSegment } from "@/lib/schemas";

import { buildRouteGeoJson } from "./routes";
import { deriveMapRouteLines, planHasRoutedGeometry } from "./derive-routes";
import { buildSequenceGeoJson } from "./sequence";
import { deriveVisibleMapPlaces } from "./derive";

/**
 * Plan → route lines.
 *
 * The rule under test is that only a routed segment reaches the map. An estimate
 * has no geometry and an unavailable leg has nothing to draw, and neither may
 * produce a line that a traveller would read as a road.
 */

function routed(id: string): TravelSegment {
  return {
    ...toTravelSegment(
      { id, fromPlaceId: P.a.placeId, toPlaceId: P.b.placeId },
      routedResult(P.a, P.b),
    ),
  };
}

function unavailable(id: string): TravelSegment {
  return {
    id,
    fromPlaceId: P.a.placeId,
    toPlaceId: P.b.placeId,
    note: null,
    status: "unavailable",
    requestedMode: "WALK",
    reason: "no_route",
    userMessage: "No route could be found between these two places.",
  };
}

/** Day 1 has one routed and one estimated leg; day 2 has one routed. */
function mixedPlan() {
  return fixturePlan([
    fixtureDay(1, [
      fixtureItem("d1i1", P.a, { travelToNext: routed("day:1:from:d1i1:to:d1i2:mode:walk") }),
      fixtureItem("d1i2", P.b, { travelToNext: estimatedSegment("est", P.b, P.c) }),
      fixtureItem("d1i3", P.c),
    ]),
    fixtureDay(2, [
      fixtureItem("d2i1", P.a, { travelToNext: routed("day:2:from:d2i1:to:d2i2:mode:walk") }),
      fixtureItem("d2i2", P.b),
    ]),
  ]);
}

describe("deriveMapRouteLines", () => {
  it("draws only routed segments", () => {
    const lines = deriveMapRouteLines(mixedPlan(), "all");

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.coordinates.length >= 2)).toBe(true);
  });

  it("draws nothing for an estimated segment", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a, { travelToNext: estimatedSegment("est", P.a, P.b) }),
        fixtureItem("i2", P.b),
      ]),
    ]);

    expect(deriveMapRouteLines(plan, "all")).toEqual([]);
  });

  it("draws nothing for an unavailable segment", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a, { travelToNext: unavailable("leg") }),
        fixtureItem("i2", P.b),
      ]),
    ]);

    expect(deriveMapRouteLines(plan, "all")).toEqual([]);
  });

  it("draws nothing for a plan that has never been routed", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);

    expect(deriveMapRouteLines(plan, "all")).toEqual([]);
    expect(planHasRoutedGeometry(plan)).toBe(false);
  });

  it("filters to the active day", () => {
    const lines = deriveMapRouteLines(mixedPlan(), 2);

    expect(lines).toHaveLength(1);
    expect(lines[0].dayNumber).toBe(2);
  });

  it("separates days in the All Days view", () => {
    const lines = deriveMapRouteLines(mixedPlan(), "all");

    // One feature per leg, each tagged with its own day, so the layer can vary
    // colour per day exactly as the sequence line does.
    expect(lines.map((line) => line.dayNumber)).toEqual([1, 2]);
  });

  it("uses the segment's own leg id as identity, never an index", () => {
    const lines = deriveMapRouteLines(mixedPlan(), "all");

    expect(lines[0].legId).toBe("day:1:from:d1i1:to:d1i2:mode:walk");
    expect(lines[1].legId).toBe("day:2:from:d2i1:to:d2i2:mode:walk");
    // Filtering to day 2 must not renumber anything.
    expect(deriveMapRouteLines(mixedPlan(), 2)[0].legId).toBe(
      "day:2:from:d2i1:to:d2i2:mode:walk",
    );
  });

  it("preserves visit order", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a, { travelToNext: routed("leg-1") }),
        fixtureItem("i2", P.b, { travelToNext: routed("leg-2") }),
        fixtureItem("i3", P.c),
      ]),
    ]);

    expect(deriveMapRouteLines(plan, "all").map((line) => line.legId)).toEqual([
      "leg-1",
      "leg-2",
    ]);
  });

  it("marks the leg leaving the selected stop", () => {
    const lines = deriveMapRouteLines(mixedPlan(), "all", {
      selectedItemId: "d2i1",
    });

    expect(lines.map((line) => line.selected)).toEqual([false, true]);
  });

  it("emits the lowercase routing mode the map speaks", () => {
    const lines = deriveMapRouteLines(mixedPlan(), "all");
    expect(lines.every((line) => line.mode === "walk")).toBe(true);
  });

  it("does not mutate the plan", () => {
    const plan = mixedPlan();
    const before = JSON.parse(JSON.stringify(plan));
    deriveMapRouteLines(plan, "all");
    expect(plan).toEqual(before);
  });
});

describe("planHasRoutedGeometry", () => {
  it("is true once any leg is routed", () => {
    expect(planHasRoutedGeometry(mixedPlan())).toBe(true);
  });
});

describe("routes coexist with the sequence line", () => {
  it("keeps the dashed sequence line alongside real geometry", () => {
    const plan = mixedPlan();
    const places = deriveVisibleMapPlaces(plan, 1);
    const sequence = buildSequenceGeoJson(places);
    const routes = buildRouteGeoJson(deriveMapRouteLines(plan, 1));

    // Both exist. The sequence line is what still shows the day's shape across
    // the estimated leg, which the routed layer does not draw.
    expect(sequence.features.length).toBeGreaterThan(0);
    expect(routes.features).toHaveLength(1);
  });

  it("keeps the sequence line when nothing could be routed", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a, { travelToNext: unavailable("leg") }),
        fixtureItem("i2", P.b),
      ]),
    ]);

    const places = deriveVisibleMapPlaces(plan, 1);
    expect(buildSequenceGeoJson(places).features).toHaveLength(1);
    expect(buildRouteGeoJson(deriveMapRouteLines(plan, 1)).features).toEqual([]);
  });
});
