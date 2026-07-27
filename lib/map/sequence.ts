import type { SequenceLine, VisibleMapPlace } from "./types";

/**
 * Builds the itinerary sequence lines.
 *
 * **This is visit order, not a route.** The line joins consecutive stops with
 * straight segments. It does not follow roads, rails or footpaths, it is not
 * produced by a routing engine, and no distance or duration may be derived from
 * it. Real travel figures live on `TravelSegment`, sourced separately.
 *
 * Rules:
 *  - accommodation is excluded — it is a base, not a step in the day
 *  - one line per day, so All Days never joins the last stop of one day to the
 *    first of the next
 *  - a day with fewer than two stops yields no line
 */
export function buildSequenceLines(
  places: VisibleMapPlace[],
): SequenceLine[] {
  const byDay = new Map<number, VisibleMapPlace[]>();

  for (const place of places) {
    if (place.kind !== "stop") continue;
    if (place.dayNumber === null) continue;
    const existing = byDay.get(place.dayNumber);
    if (existing) existing.push(place);
    else byDay.set(place.dayNumber, [place]);
  }

  const lines: SequenceLine[] = [];
  for (const [dayNumber, dayPlaces] of [...byDay.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    if (dayPlaces.length < 2) continue;
    const ordered = [...dayPlaces].sort(
      (a, b) => a.sequenceNumber - b.sequenceNumber,
    );
    lines.push({
      dayNumber,
      coordinates: ordered.map((place) => [place.longitude, place.latitude]),
    });
  }

  return lines;
}

/** Minimal GeoJSON shapes, so this module needs no GeoJSON dependency. */
type LineStringFeature = {
  type: "Feature";
  properties: { dayNumber: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

export type SequenceFeatureCollection = {
  type: "FeatureCollection";
  features: LineStringFeature[];
};

/**
 * The sequence lines as a GeoJSON `FeatureCollection`.
 *
 * One feature per day, drawn by a single map line layer. Deliberately not one
 * DOM element or one source per segment: 23 stops would mean 18 overlays to
 * create, position and tear down on every day change.
 *
 * `dayNumber` rides along as a feature property so the layer can vary colour per
 * day in the All Days view without needing a separate source per day.
 */
export function buildSequenceGeoJson(
  places: VisibleMapPlace[],
): SequenceFeatureCollection {
  return {
    type: "FeatureCollection",
    features: buildSequenceLines(places).map((line) => ({
      type: "Feature",
      properties: { dayNumber: line.dayNumber },
      geometry: { type: "LineString", coordinates: line.coordinates },
    })),
  };
}
