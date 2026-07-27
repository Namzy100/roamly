import {
  PlaceCategorySchema,
  type PlaceCategory,
} from "@/lib/schemas/place";

/**
 * The category allowlist, and the single reviewed mapping onto OSM tags.
 *
 * This module is the boundary that keeps user input out of Overpass QL. Queries
 * are built **only** from the literal tag pairs below — a caller supplies a
 * category name, we look it up, and if it is not here the request fails. No
 * caller-supplied string ever reaches the query text, so there is no injection
 * path through key or value.
 *
 * Tag choices follow OSM convention. Where a concept spans several tags (an
 * attraction, a historic site) all reasonable spellings are listed, because OSM
 * tagging is genuinely inconsistent across regions and picking one would silently
 * miss places.
 */

export type OsmTagFilter = {
  key: string;
  value: string;
};

/** Every filter is OR'd within a category: any match makes the place a candidate. */
const CATEGORY_TAGS: Record<PlaceCategory, readonly OsmTagFilter[]> = {
  restaurant: [{ key: "amenity", value: "restaurant" }],
  cafe: [{ key: "amenity", value: "cafe" }],
  bar: [
    { key: "amenity", value: "bar" },
    { key: "amenity", value: "pub" },
  ],
  fast_food: [{ key: "amenity", value: "fast_food" }],
  hotel: [{ key: "tourism", value: "hotel" }],
  hostel: [{ key: "tourism", value: "hostel" }],
  guest_house: [
    { key: "tourism", value: "guest_house" },
    { key: "tourism", value: "apartment" },
  ],
  museum: [{ key: "tourism", value: "museum" }],
  gallery: [{ key: "tourism", value: "artwork" }],
  attraction: [{ key: "tourism", value: "attraction" }],
  monument: [
    { key: "historic", value: "monument" },
    { key: "historic", value: "memorial" },
  ],
  viewpoint: [{ key: "tourism", value: "viewpoint" }],
  park: [{ key: "leisure", value: "park" }],
  garden: [{ key: "leisure", value: "garden" }],
  beach: [{ key: "natural", value: "beach" }],
  market: [
    { key: "amenity", value: "marketplace" },
    { key: "shop", value: "greengrocer" },
  ],
  place_of_worship: [{ key: "amenity", value: "place_of_worship" }],
  theatre: [{ key: "amenity", value: "theatre" }],
  music_venue: [
    { key: "amenity", value: "nightclub" },
    { key: "amenity", value: "music_venue" },
  ],
  shopping: [
    { key: "shop", value: "department_store" },
    { key: "shop", value: "mall" },
  ],
  winery: [
    { key: "craft", value: "winery" },
    { key: "shop", value: "wine" },
  ],
  historic_site: [
    { key: "historic", value: "castle" },
    { key: "historic", value: "ruins" },
    { key: "historic", value: "archaeological_site" },
    { key: "historic", value: "church" },
  ],
};

/**
 * Reverse lookup, built once.
 *
 * Ordered by category declaration so a place matching several categories resolves
 * deterministically — a `historic=church` is a `historic_site`, not sometimes one
 * thing and sometimes another depending on iteration order.
 */
const TAG_TO_CATEGORY: ReadonlyMap<string, PlaceCategory> = (() => {
  const map = new Map<string, PlaceCategory>();
  for (const [category, filters] of Object.entries(CATEGORY_TAGS) as [
    PlaceCategory,
    readonly OsmTagFilter[],
  ][]) {
    for (const filter of filters) {
      const key = `${filter.key}=${filter.value}`;
      if (!map.has(key)) map.set(key, category);
    }
  }
  return map;
})();

export const ALL_PLACE_CATEGORIES: readonly PlaceCategory[] =
  PlaceCategorySchema.options;

/** Narrowing guard — the allowlist check callers should use. */
export function isAllowedCategory(value: unknown): value is PlaceCategory {
  return PlaceCategorySchema.safeParse(value).success;
}

/**
 * The tag filters for a category.
 *
 * Throws on anything not in the allowlist. Returning an empty array instead would
 * let an unknown category produce an empty-but-valid query, which is exactly the
 * silent failure this module exists to prevent.
 */
export function tagFiltersFor(category: PlaceCategory): readonly OsmTagFilter[] {
  const filters = CATEGORY_TAGS[category];
  if (!filters || filters.length === 0) {
    throw new Error(`No OSM tag mapping for category ${JSON.stringify(category)}`);
  }
  return filters;
}

/**
 * Resolves a place's category from its OSM tags, or null when nothing matches.
 *
 * Null is meaningful: it means "we do not have a category for this", and the
 * normaliser drops the record rather than guessing. Better to lose a place than to
 * mislabel one.
 */
export function categoryFromTags(
  tags: Record<string, string> | undefined,
): PlaceCategory | null {
  if (!tags) return null;
  for (const [key, category] of TAG_TO_CATEGORY) {
    const [tagKey, tagValue] = key.split("=");
    if (tags[tagKey] === tagValue) return category;
  }
  return null;
}

/** Every tag key referenced by the allowlist. Used by tests to prove coverage. */
export function allowlistedTagKeys(): string[] {
  return [...new Set([...TAG_TO_CATEGORY.keys()].map((k) => k.split("=")[0]))]
    .sort();
}
