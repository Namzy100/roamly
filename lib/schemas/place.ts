import { z } from "zod";

import { PriceLevelSchema } from "./enums";

/**
 * A mappable place, and what "verified" means for it.
 *
 * ## What verified means in the free MVP
 *
 * A place is verified when it was returned by an OpenStreetMap-backed provider,
 * carries an OSM element type and id, has coordinates, has a non-empty name, has
 * tags matching an allowed category, was normalised by our own server, and its
 * canonical id belongs to the exact pool the itinerary was assembled from.
 *
 * It does **not** mean the place is well rated, currently open, bookable,
 * price-checked, editorially recommended, or even still trading.
 *
 * ## The rule that follows from that
 *
 * Every optional field below is optional because the provider may simply not have
 * it. Absent means absent. Nothing here may be inferred, defaulted or invented —
 * not ratings, not review counts, not price levels, not opening status, not
 * addresses, websites, phone numbers or cuisines. A missing field is a fact about
 * our data, and the UI says "unknown" rather than guessing.
 */

/**
 * Controlled category vocabulary.
 *
 * Closed on purpose: it is the allowlist that keeps user input out of Overpass
 * QL, and it is what pool validation checks against. Adding a category means
 * adding its OSM tag mapping in `lib/providers/osm/categories.ts` in the same
 * change.
 */
export const PlaceCategorySchema = z.enum([
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "hotel",
  "hostel",
  "guest_house",
  "museum",
  "gallery",
  "attraction",
  "monument",
  "viewpoint",
  "park",
  "garden",
  "beach",
  "market",
  "place_of_worship",
  "theatre",
  "music_venue",
  "shopping",
  "winery",
  "historic_site",
]);
export type PlaceCategory = z.infer<typeof PlaceCategorySchema>;

export const PLACE_CATEGORY_LABELS: Record<PlaceCategory, string> = {
  restaurant: "Restaurant",
  cafe: "Café",
  bar: "Bar",
  fast_food: "Fast food",
  hotel: "Hotel",
  hostel: "Hostel",
  guest_house: "Guest house",
  museum: "Museum",
  gallery: "Gallery",
  attraction: "Attraction",
  monument: "Monument",
  viewpoint: "Viewpoint",
  park: "Park",
  garden: "Garden",
  beach: "Beach",
  market: "Market",
  place_of_worship: "Place of worship",
  theatre: "Theatre",
  music_venue: "Music venue",
  shopping: "Shopping",
  winery: "Winery",
  historic_site: "Historic site",
};

export const OsmElementTypeSchema = z.enum(["node", "way", "relation"]);
export type OsmElementType = z.infer<typeof OsmElementTypeSchema>;

/** The only providers that may appear. `mock` is the deterministic sample data. */
export const PlaceProviderSchema = z.enum(["openstreetmap", "mock"]);
export type PlaceProvider = z.infer<typeof PlaceProviderSchema>;

/**
 * Where a place came from, and the identity it came with.
 *
 * `canonicalId` must equal the owning `TripPlace.placeId`. For OSM places it must
 * also reconstruct from `osmType` + `osmId`. Pool validation enforces both, so a
 * record cannot claim an identity it does not have — and mock records cannot
 * dress themselves up as OpenStreetMap data.
 */
export const PlaceSourceSchema = z.object({
  provider: PlaceProviderSchema,
  canonicalId: z.string().min(1),
  osmType: OsmElementTypeSchema.optional(),
  osmId: z.string().regex(/^\d+$/, "OSM ids are positive integers").optional(),
  /** ISO timestamp of the provider response this record came from. */
  fetchedAt: z.string().min(1).optional(),
  attribution: z.string().min(1),
});
export type PlaceSource = z.infer<typeof PlaceSourceSchema>;

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLngSchema>;

/**
 * A path, in GeoJSON's `[longitude, latitude]` order.
 *
 * A geographic primitive rather than a routing concept, which is why it lives
 * here beside `LatLng` — the routing domain and the trip plan both need it, and
 * defining it twice is how the two would eventually disagree about coordinate
 * order.
 *
 * The ordering is the trap worth naming: `LatLng` above is `{lat, lng}`, this is
 * `[lng, lat]`, and every routing provider emits `lat,lon`. The swap happens
 * once, at the provider boundary, and is asserted in tests.
 *
 * Two points minimum. A one-point "line" is a decoding failure, not a very short
 * journey, and callers must treat it as one.
 */
export const LineStringGeometrySchema = z.object({
  type: z.literal("LineString"),
  coordinates: z
    .array(
      z.tuple([
        z.number().finite().min(-180).max(180),
        z.number().finite().min(-90).max(90),
      ]),
    )
    .min(2, "A line needs at least two points"),
});
export type LineStringGeometry = z.infer<typeof LineStringGeometrySchema>;

export const TripPlaceSchema = z.object({
  /** Canonical identity. For OSM: `osm:node:123`. Always equals `source.canonicalId`. */
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: PlaceCategorySchema,
  /**
   * Human-readable category for display. The provider's own wording where it has
   * one, otherwise `PLACE_CATEGORY_LABELS[category]`. Never a claim about the
   * place beyond its category.
   */
  categoryLabel: z.string().min(1).optional(),
  coordinates: LatLngSchema,
  source: PlaceSourceSchema,

  // ---- Optional provider facts. Absent means the provider did not supply it. ----
  address: z.string().min(1).optional(),
  website: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  cuisine: z.array(z.string().min(1)).optional(),
  /**
   * Raw OSM `opening_hours`, verbatim.
   *
   * Stored unparsed, and stays that way: this field is the *provider's fact*, and
   * `lib/opening-hours` interprets it at read time without ever rewriting it. That
   * matters because the parser covers a deliberate subset — a string it cannot read
   * is shown to the traveller as recorded rather than being lost or normalised into
   * something we understood only half of.
   */
  openingHours: z.string().min(1).optional(),
  wheelchair: z.enum(["yes", "no", "limited", "designated"]).optional(),
  outdoorSeating: z.boolean().optional(),
  takeaway: z.boolean().optional(),

  /**
   * Present only for the mock sample data, which predates the free-provider
   * decision. OpenStreetMap supplies none of these, and nothing may synthesise
   * them — see the header note.
   */
  rating: z.number().min(0).max(5).optional(),
  userRatingCount: z.number().int().nonnegative().optional(),
  priceLevel: PriceLevelSchema.optional(),
  editorialSummary: z.string().min(1).optional(),
});
export type TripPlace = z.infer<typeof TripPlaceSchema>;

/**
 * A money figure with its provenance.
 *
 * Provider facts and planning estimates are separate data domains. An OSM tag
 * says what a place *is*; it does not say what a visit *costs*. This type exists
 * so a number can never be shown without saying where it came from and how much
 * to trust it. Not yet wired into the itinerary — the mock's figures stand.
 */
export const CostEstimateSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().length(3),
  /**
   * Where the number came from. The vocabulary is closed so a figure cannot claim a
   * provenance nobody implemented.
   *
   * Phase 6B added two, and the distinction between them matters:
   *
   *  - `destination-band` — allocated from the traveller's budget and shaped by a curated
   *    profile that actually knows this destination
   *  - `derived-budget-allocation` — allocated from the budget against a generic baseline,
   *    because no profile covers this destination. Correct, but uninformed, and it says so
   *    rather than implying local knowledge
   *
   * Widening the enum is backwards-compatible: no stored estimate can carry a value that
   * was not previously accepted.
   */
  basis: z.enum([
    "user-provided",
    "category-estimate",
    "free-entry-tag",
    "provider-tag",
    "destination-band",
    "derived-budget-allocation",
  ]),
  confidence: z.enum(["low", "medium", "high"]),
  disclaimer: z.string().min(1).optional(),
  /**
   * The cost profile this figure was shaped by, when one was involved.
   *
   * Optional, so every estimate written before profiles existed parses unchanged — and
   * deliberately *not* backfilled: inventing a provenance for an old estimate would be
   * exactly the false precision this field exists to avoid.
   */
  profileId: z.string().min(1).optional(),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

/** True when a place carries OSM element identity. */
export function isOsmSourced(
  place: TripPlace,
): place is TripPlace & {
  source: PlaceSource & { osmType: OsmElementType; osmId: string };
} {
  return (
    place.source.provider === "openstreetmap" &&
    place.source.osmType !== undefined &&
    place.source.osmId !== undefined
  );
}

/** Display label for a place's category, preferring the provider's wording. */
export function placeCategoryLabel(place: TripPlace): string {
  return place.categoryLabel ?? PLACE_CATEGORY_LABELS[place.category];
}
