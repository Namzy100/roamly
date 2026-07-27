import {
  TripPlaceSchema,
  type PlaceCategory,
  type TripPlace,
} from "@/lib/schemas/place";

import { categoryFromTags } from "./categories";
import { OSM_ATTRIBUTION } from "./config";
import { normalizeOsmType, toCanonicalId } from "./identity";
import {
  elementCoordinates,
  type NominatimSearchResult,
  type OverpassElement,
} from "./schemas";

/**
 * Raw provider records → normalised domain records.
 *
 * The rule throughout: **missing stays missing.** Every optional field is copied
 * only when the provider actually supplied it. Nothing is defaulted, inferred from
 * a neighbouring tag, or filled with a plausible value — no ratings, no review
 * counts, no price levels, no open/closed status, no invented addresses.
 *
 * Records that cannot be represented truthfully are dropped, not repaired. A place
 * with no name, no coordinate, or no category we recognise is not a place we can
 * put on a map and describe honestly, so it does not enter the pool.
 */

export type GeocodedDestination = {
  canonicalId: string;
  name: string;
  displayName: string;
  latitude: number;
  longitude: number;
  boundingBox?: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  countryCode?: string;
  source: {
    provider: "openstreetmap";
    osmType: "node" | "way" | "relation";
    osmId: string;
    fetchedAt: string;
  };
};

/**
 * Normalises one Nominatim search result, or returns null if it cannot be trusted.
 *
 * Null rather than throwing: one malformed record among ten should not lose the
 * other nine.
 */
export function normalizeGeocodeResult(
  raw: NominatimSearchResult,
  fetchedAt: string,
): GeocodedDestination | null {
  const osmType = normalizeOsmType(raw.osm_type);
  if (!osmType) return null;

  let canonicalId: string;
  try {
    canonicalId = toCanonicalId(osmType, raw.osm_id);
  } catch {
    return null;
  }

  // Nominatim always sends `display_name`; `name` is absent for some records, in
  // which case the leading segment of the display name is the place's own name
  // rather than an invention.
  const name = raw.name?.trim() || raw.display_name.split(",")[0]?.trim();
  if (!name) return null;

  const result: GeocodedDestination = {
    canonicalId,
    name,
    displayName: raw.display_name,
    latitude: raw.lat,
    longitude: raw.lon,
    source: {
      provider: "openstreetmap",
      osmType,
      osmId: String(raw.osm_id),
      fetchedAt,
    },
  };

  const boundingBox = normalizeBoundingBox(raw.boundingbox);
  if (boundingBox) result.boundingBox = boundingBox;

  const countryCode = raw.address?.country_code?.toLowerCase();
  if (countryCode) result.countryCode = countryCode;

  return result;
}

/**
 * Nominatim's `boundingbox` is `[south, north, west, east]`.
 *
 * That ordering is unusual — most APIs use west/south/east/north — and mixing them
 * up produces a box that validates but sits in the wrong place. Hence an explicit,
 * commented remap plus a sanity check.
 */
export function normalizeBoundingBox(
  raw: string[] | undefined,
): GeocodedDestination["boundingBox"] | undefined {
  if (!raw || raw.length !== 4) return undefined;

  const [south, north, west, east] = raw.map(Number);
  if (![south, north, west, east].every(Number.isFinite)) return undefined;
  if (south > north || west > east) return undefined;
  if (south < -90 || north > 90 || west < -180 || east > 180) return undefined;

  return { south, west, north, east };
}

/**
 * Normalises one Overpass element into a `TripPlace`, or null when it cannot be.
 *
 * Dropped when: no recognised category, no name, or no coordinate. Each of those is
 * a genuine gap rather than something to paper over.
 */
export function normalizeOverpassElement(
  element: OverpassElement,
  fetchedAt: string,
): TripPlace | null {
  const tags = element.tags;
  if (!tags) return null;

  const category = categoryFromTags(tags);
  if (!category) return null;

  const name = tags.name?.trim();
  if (!name) return null;

  const coordinates = elementCoordinates(element);
  if (!coordinates) return null;

  let canonicalId: string;
  try {
    canonicalId = toCanonicalId(element.type, element.id);
  } catch {
    return null;
  }

  const place: TripPlace = {
    placeId: canonicalId,
    name,
    category,
    coordinates: { lat: coordinates.lat, lng: coordinates.lon },
    source: {
      provider: "openstreetmap",
      canonicalId,
      osmType: element.type,
      osmId: String(element.id),
      fetchedAt,
      attribution: OSM_ATTRIBUTION,
    },
  };

  // Optional fields, each copied only when genuinely present.
  const address = composeAddress(tags);
  if (address) place.address = address;

  const website = tags.website?.trim() || tags["contact:website"]?.trim();
  if (website) place.website = website;

  const phone = tags.phone?.trim() || tags["contact:phone"]?.trim();
  if (phone) place.phone = phone;

  const cuisine = tags.cuisine
    ?.split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (cuisine && cuisine.length > 0) place.cuisine = cuisine;

  // Kept verbatim and unparsed. We do not claim the place is open now.
  const openingHours = tags.opening_hours?.trim();
  if (openingHours) place.openingHours = openingHours;

  const wheelchair = tags.wheelchair?.trim();
  if (
    wheelchair === "yes" ||
    wheelchair === "no" ||
    wheelchair === "limited" ||
    wheelchair === "designated"
  ) {
    place.wheelchair = wheelchair;
  }

  const outdoorSeating = parseOsmBoolean(tags.outdoor_seating);
  if (outdoorSeating !== undefined) place.outdoorSeating = outdoorSeating;

  const takeaway = parseOsmBoolean(tags.takeaway);
  if (takeaway !== undefined) place.takeaway = takeaway;

  // Final gate: the schema is the authority on what a valid place is.
  const parsed = TripPlaceSchema.safeParse(place);
  return parsed.success ? parsed.data : null;
}

/**
 * Builds a street address from `addr:*` tags — only when there is enough to be
 * useful. A bare house number with no street is worse than no address at all.
 */
function composeAddress(tags: Record<string, string>): string | undefined {
  const street = tags["addr:street"]?.trim();
  const houseNumber = tags["addr:housenumber"]?.trim();
  const city = tags["addr:city"]?.trim();
  const postcode = tags["addr:postcode"]?.trim();

  if (!street) {
    // Without a street, only a city+postcode pair says anything locating.
    if (city && postcode) return `${postcode} ${city}`;
    return undefined;
  }

  const line = houseNumber ? `${street} ${houseNumber}` : street;
  const tail = [postcode, city].filter(Boolean).join(" ");
  return tail ? `${line}, ${tail}` : line;
}

/** OSM booleans are `yes`/`no`, sometimes with other values we must not coerce. */
function parseOsmBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalised = value.trim().toLowerCase();
  if (normalised === "yes") return true;
  if (normalised === "no") return false;
  // "seasonal", "limited", "only" and friends are not booleans. Leave absent.
  return undefined;
}

/**
 * Deduplicates by canonical id and orders deterministically.
 *
 * Ordering is category, then name, then id — stable across runs regardless of the
 * order Overpass returned, so cached and fresh results look identical and snapshot
 * comparisons are meaningful. Sorting by distance would be friendlier, but it is
 * not the normaliser's job to decide relevance.
 */
export function dedupeAndOrder(places: TripPlace[]): TripPlace[] {
  const byId = new Map<string, TripPlace>();
  for (const place of places) {
    if (!byId.has(place.placeId)) byId.set(place.placeId, place);
  }

  return [...byId.values()].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    const nameOrder = a.name.localeCompare(b.name, "en");
    if (nameOrder !== 0) return nameOrder;
    return a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
  });
}

/** Groups by category, for per-category caps applied after normalisation. */
export function capPerCategory(
  places: TripPlace[],
  limitPerCategory: number,
): TripPlace[] {
  const counts = new Map<PlaceCategory, number>();
  const kept: TripPlace[] = [];
  for (const place of places) {
    const used = counts.get(place.category) ?? 0;
    if (used >= limitPerCategory) continue;
    counts.set(place.category, used + 1);
    kept.push(place);
  }
  return kept;
}
