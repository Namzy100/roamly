/**
 * The map adapter boundary.
 *
 * Everything the itinerary workspace passes to a map renderer is defined here as
 * plain data. No MapLibre (or any other provider) type appears in this file, and
 * the workspace imports nothing else from the map layer. Swapping the renderer
 * means rewriting `components/map/trip-map.tsx` and nothing above it.
 *
 * Equally, nothing on this side of the boundary travels the other way: map
 * instances, viewport state, and style objects never enter the Zustand store,
 * the trip schemas, or the itinerary components.
 */

export type MapPlaceKind = "stop" | "accommodation";

export type VisibleMapPlace = {
  /** Identity for *selection*. Matches the itinerary card's item id. */
  itemId: string;
  /** Canonical place identity, carried through from the places provider. */
  placeId: string;
  /**
   * The number shown on the marker, taken from the itinerary's own numbering so
   * a card and its marker can never disagree. Numbering can therefore have gaps
   * when an item is excluded from the map.
   */
  sequenceNumber: number;
  name: string;
  latitude: number;
  longitude: number;
  kind: MapPlaceKind;
  /**
   * Which day this place belongs to; `null` for the accommodation, which spans
   * the whole trip. Needed so the sequence line can separate each day's run in
   * the All Days view.
   */
  dayNumber: number | null;
};

export type DayFilterValue = number | "all";

/**
 * One routed path, ready to draw.
 *
 * Plain data, like everything else here. `mode` is the routing vocabulary in
 * lower case because that is what the routing domain speaks; the map uses it
 * only to pick a colour and never to make a claim. There is no arm of this type
 * that can express an unavailable leg — a leg we could not route contributes no
 * `MapRouteLine` at all, so there is nothing for the renderer to get wrong.
 */
export type MapRouteLine = {
  /** Identity for selection and for React keys. Never an array index. */
  legId: string;
  mode: "walk" | "drive" | "bicycle";
  /** GeoJSON order, `[longitude, latitude]`, at least two points. */
  coordinates: [longitude: number, latitude: number][];
  dayNumber: number | null;
  /** Emphasised when the corresponding itinerary leg is selected. */
  selected?: boolean;
};

export type TripMapProps = {
  places: VisibleMapPlace[];
  /**
   * Real routed geometry, drawn as a second layer *alongside* the sequence line
   * — never instead of it. Empty by default, so every existing caller keeps
   * exactly the behaviour it had.
   */
  routes?: MapRouteLine[];
  selectedItemId: string | null;
  activeDayNumber: DayFilterValue;
  onSelectItem: (itemId: string, source: "map") => void;
  className?: string;
};

/** West/south/east/north, in degrees. */
export type MapBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/** What the camera should do, expressed without reference to any map library. */
export type CameraTarget =
  | { type: "bounds"; bounds: MapBounds }
  | { type: "center"; longitude: number; latitude: number }
  | { type: "none" };

/**
 * A day's stops as an ordered line. Represents **itinerary order only** — the
 * sequence in which places are visited. It is not a routed path along roads or
 * transit, carries no distance or duration meaning, and must never be described
 * as navigation. Real travel figures come from the Routes layer and live on
 * `TravelSegment`.
 */
export type SequenceLine = {
  dayNumber: number;
  coordinates: [longitude: number, latitude: number][];
};

/**
 * Minimal GeoJSON for the routed-path layer, so this module needs no GeoJSON
 * dependency and the renderer receives plain data rather than a provider shape.
 */
export type RouteFeature = {
  type: "Feature";
  properties: {
    legId: string;
    mode: "walk" | "drive" | "bicycle";
    dayNumber: number | null;
    selected: boolean;
  };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

export type RouteFeatureCollection = {
  type: "FeatureCollection";
  features: RouteFeature[];
};
