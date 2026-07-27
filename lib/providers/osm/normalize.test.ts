import { describe, expect, it } from "vitest";

import { testOsmPlace } from "@/lib/map/test-fixtures";
import { TripPlaceSchema } from "@/lib/schemas/place";

import {
  capPerCategory,
  dedupeAndOrder,
  normalizeBoundingBox,
  normalizeGeocodeResult,
  normalizeOverpassElement,
} from "./normalize";
import {
  NominatimSearchResultSchema,
  OverpassElementSchema,
  elementCoordinates,
} from "./schemas";

const FETCHED_AT = "2026-07-26T10:00:00.000Z";

/**
 * Fixtures are minimal reductions of responses captured live on 2026-07-26, not
 * invented shapes. No test in this file touches the network.
 */
const NOMINATIM_LISBON = {
  osm_type: "relation",
  osm_id: 5400890,
  lat: "38.7077507",
  lon: "-9.1365919",
  name: "Lisboa",
  display_name: "Lisboa, Portugal",
  category: "boundary",
  type: "administrative",
  addresstype: "city",
  boundingbox: ["38.6913994", "38.7967584", "-9.2298356", "-9.0863328"],
  address: { city: "Lisboa", country: "Portugal", country_code: "pt" },
};

const OVERPASS_NODE = {
  type: "node",
  id: 1623055925,
  lat: 38.7124,
  lon: -9.1381,
  tags: {
    name: "Museu Geológico",
    tourism: "museum",
    "addr:street": "Rua da Academia das Ciências",
    "addr:housenumber": "19",
    "addr:postcode": "1200-151",
    "addr:city": "Lisboa",
    website: "https://example.org",
    opening_hours: "Mo-Fr 10:00-17:00",
    wheelchair: "limited",
  },
};

/** Ways and relations carry `center` instead of top-level lat/lon under `out center`. */
const OVERPASS_WAY = {
  type: "way",
  id: 4567890,
  center: { lat: 38.7301, lon: -9.1531 },
  tags: { name: "Parque Eduardo VII", leisure: "park" },
};

describe("raw response validation", () => {
  it("accepts a real Nominatim result", () => {
    expect(NominatimSearchResultSchema.safeParse(NOMINATIM_LISBON).success).toBe(
      true,
    );
  });

  it("coerces Nominatim's string coordinates to finite numbers", () => {
    const parsed = NominatimSearchResultSchema.parse(NOMINATIM_LISBON);
    expect(parsed.lat).toBeCloseTo(38.7077507, 6);
    expect(typeof parsed.lat).toBe("number");
  });

  it("rejects a malformed coordinate", () => {
    for (const lat of ["not-a-number", "", "NaN", "1e999"]) {
      const result = NominatimSearchResultSchema.safeParse({
        ...NOMINATIM_LISBON,
        lat,
      });
      expect(result.success, `lat=${lat}`).toBe(false);
    }
  });

  it("rejects an out-of-range coordinate", () => {
    expect(
      NominatimSearchResultSchema.safeParse({ ...NOMINATIM_LISBON, lat: "91" })
        .success,
    ).toBe(false);
  });

  it("rejects a missing identity", () => {
    const { osm_id: _omitted, ...withoutId } = NOMINATIM_LISBON;
    expect(NominatimSearchResultSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects an unsupported OSM type", () => {
    expect(
      NominatimSearchResultSchema.safeParse({
        ...NOMINATIM_LISBON,
        osm_type: "street",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid Overpass node", () => {
    expect(OverpassElementSchema.safeParse(OVERPASS_NODE).success).toBe(true);
  });

  it("accepts a way with a center instead of top-level coordinates", () => {
    const parsed = OverpassElementSchema.parse(OVERPASS_WAY);
    expect(elementCoordinates(parsed)).toEqual({ lat: 38.7301, lon: -9.1531 });
  });

  it("reports no coordinates when an element has neither shape", () => {
    const parsed = OverpassElementSchema.parse({
      type: "relation",
      id: 12,
      tags: { name: "X", leisure: "park" },
    });
    expect(elementCoordinates(parsed)).toBeNull();
  });
});

describe("normalizeGeocodeResult", () => {
  it("normalises a real result and builds the canonical id", () => {
    const raw = NominatimSearchResultSchema.parse(NOMINATIM_LISBON);
    const result = normalizeGeocodeResult(raw, FETCHED_AT);

    expect(result).not.toBeNull();
    expect(result?.canonicalId).toBe("osm:relation:5400890");
    expect(result?.name).toBe("Lisboa");
    expect(result?.countryCode).toBe("pt");
    expect(result?.source).toEqual({
      provider: "openstreetmap",
      osmType: "relation",
      osmId: "5400890",
      fetchedAt: FETCHED_AT,
    });
  });

  it("maps Nominatim's [south, north, west, east] bounding box correctly", () => {
    // Nominatim's ordering is unusual; mixing it up yields a valid box in the
    // wrong place, which no schema would catch.
    const box = normalizeBoundingBox([
      "38.6913994",
      "38.7967584",
      "-9.2298356",
      "-9.0863328",
    ]);
    expect(box).toEqual({
      south: 38.6913994,
      north: 38.7967584,
      west: -9.2298356,
      east: -9.0863328,
    });
  });

  it("rejects an inverted or non-numeric bounding box", () => {
    expect(normalizeBoundingBox(["10", "5", "0", "1"])).toBeUndefined();
    expect(normalizeBoundingBox(["a", "b", "c", "d"])).toBeUndefined();
    expect(normalizeBoundingBox(["1", "2", "3"])).toBeUndefined();
    expect(normalizeBoundingBox(undefined)).toBeUndefined();
  });

  it("falls back to the leading display-name segment when name is absent", () => {
    const { name: _dropped, ...withoutName } = NOMINATIM_LISBON;
    const raw = NominatimSearchResultSchema.parse(withoutName);
    expect(normalizeGeocodeResult(raw, FETCHED_AT)?.name).toBe("Lisboa");
  });

  it("omits the bounding box and country when the provider did not supply them", () => {
    const { boundingbox: _b, address: _a, ...bare } = NOMINATIM_LISBON;
    const raw = NominatimSearchResultSchema.parse(bare);
    const result = normalizeGeocodeResult(raw, FETCHED_AT);
    expect(result).not.toBeNull();
    expect("boundingBox" in (result as object)).toBe(false);
    expect("countryCode" in (result as object)).toBe(false);
  });
});

describe("normalizeOverpassElement", () => {
  it("maps tags to a controlled category and canonical id", () => {
    const element = OverpassElementSchema.parse(OVERPASS_NODE);
    const place = normalizeOverpassElement(element, FETCHED_AT);

    expect(place).not.toBeNull();
    expect(place?.placeId).toBe("osm:node:1623055925");
    expect(place?.category).toBe("museum");
    expect(place?.source.provider).toBe("openstreetmap");
    expect(place?.source.canonicalId).toBe(place?.placeId);
    expect(place?.source.osmType).toBe("node");
    expect(place?.source.osmId).toBe("1623055925");
    expect(place?.source.attribution).toContain("OpenStreetMap");
  });

  it("retains optional metadata the provider supplied", () => {
    const element = OverpassElementSchema.parse(OVERPASS_NODE);
    const place = normalizeOverpassElement(element, FETCHED_AT);

    expect(place?.address).toBe(
      "Rua da Academia das Ciências 19, 1200-151 Lisboa",
    );
    expect(place?.website).toBe("https://example.org");
    // Kept verbatim and unparsed — we never claim the place is open now.
    expect(place?.openingHours).toBe("Mo-Fr 10:00-17:00");
    expect(place?.wheelchair).toBe("limited");
  });

  it("leaves missing metadata absent rather than null or empty", () => {
    const element = OverpassElementSchema.parse(OVERPASS_WAY);
    const place = normalizeOverpassElement(element, FETCHED_AT);

    expect(place).not.toBeNull();
    const record = place as Record<string, unknown>;
    for (const field of [
      "address",
      "website",
      "phone",
      "cuisine",
      "openingHours",
      "wheelchair",
      "outdoorSeating",
      "takeaway",
    ]) {
      expect(field in record, `${field} should be absent`).toBe(false);
    }
  });

  it("never invents a rating, review count or price level", () => {
    const element = OverpassElementSchema.parse(OVERPASS_NODE);
    const record = normalizeOverpassElement(element, FETCHED_AT) as Record<
      string,
      unknown
    >;
    expect("rating" in record).toBe(false);
    expect("userRatingCount" in record).toBe(false);
    expect("priceLevel" in record).toBe(false);
    expect("editorialSummary" in record).toBe(false);
  });

  it("uses the way's center coordinate", () => {
    const element = OverpassElementSchema.parse(OVERPASS_WAY);
    const place = normalizeOverpassElement(element, FETCHED_AT);
    expect(place?.coordinates).toEqual({ lat: 38.7301, lng: -9.1531 });
    expect(place?.placeId).toBe("osm:way:4567890");
  });

  it("drops an element with no tags", () => {
    const element = OverpassElementSchema.parse({
      type: "node",
      id: 5,
      lat: 1,
      lon: 2,
    });
    expect(normalizeOverpassElement(element, FETCHED_AT)).toBeNull();
  });

  it("drops an element with no name", () => {
    const element = OverpassElementSchema.parse({
      type: "node",
      id: 5,
      lat: 1,
      lon: 2,
      tags: { tourism: "museum" },
    });
    expect(normalizeOverpassElement(element, FETCHED_AT)).toBeNull();
  });

  it("drops an element whose tags match no allowlisted category", () => {
    const element = OverpassElementSchema.parse({
      type: "node",
      id: 5,
      lat: 1,
      lon: 2,
      tags: { name: "Some Bench", amenity: "bench" },
    });
    expect(normalizeOverpassElement(element, FETCHED_AT)).toBeNull();
  });

  it("drops an element with no coordinate at all", () => {
    const element = OverpassElementSchema.parse({
      type: "relation",
      id: 7,
      tags: { name: "Nowhere", leisure: "park" },
    });
    expect(normalizeOverpassElement(element, FETCHED_AT)).toBeNull();
  });

  it("does not coerce non-boolean OSM values into booleans", () => {
    const element = OverpassElementSchema.parse({
      ...OVERPASS_NODE,
      tags: { ...OVERPASS_NODE.tags, outdoor_seating: "seasonal", takeaway: "only" },
    });
    const record = normalizeOverpassElement(element, FETCHED_AT) as Record<
      string,
      unknown
    >;
    expect("outdoorSeating" in record).toBe(false);
    expect("takeaway" in record).toBe(false);
  });

  it("splits a multi-value cuisine tag", () => {
    const element = OverpassElementSchema.parse({
      ...OVERPASS_NODE,
      tags: { ...OVERPASS_NODE.tags, amenity: "restaurant", cuisine: "portuguese;seafood" },
    });
    expect(normalizeOverpassElement(element, FETCHED_AT)?.cuisine).toEqual([
      "portuguese",
      "seafood",
    ]);
  });

  it("omits an address built from a house number with no street", () => {
    const element = OverpassElementSchema.parse({
      ...OVERPASS_NODE,
      tags: {
        name: "Nameless Corner",
        tourism: "museum",
        "addr:housenumber": "19",
      },
    });
    const record = normalizeOverpassElement(element, FETCHED_AT) as Record<
      string,
      unknown
    >;
    expect("address" in record).toBe(false);
  });

  it("produces records that satisfy the domain schema", () => {
    for (const raw of [OVERPASS_NODE, OVERPASS_WAY]) {
      const element = OverpassElementSchema.parse(raw);
      const place = normalizeOverpassElement(element, FETCHED_AT);
      expect(TripPlaceSchema.safeParse(place).success).toBe(true);
    }
  });
});

describe("dedupeAndOrder", () => {
  const nodeA = normalizeOverpassElement(
    OverpassElementSchema.parse(OVERPASS_NODE),
    FETCHED_AT,
  )!;
  const wayB = normalizeOverpassElement(
    OverpassElementSchema.parse(OVERPASS_WAY),
    FETCHED_AT,
  )!;

  it("removes duplicate canonical identities", () => {
    expect(dedupeAndOrder([nodeA, nodeA, wayB])).toHaveLength(2);
  });

  it("is deterministic regardless of input order", () => {
    const forward = dedupeAndOrder([nodeA, wayB]).map((p) => p.placeId);
    const reverse = dedupeAndOrder([wayB, nodeA]).map((p) => p.placeId);
    expect(forward).toEqual(reverse);
  });

  it("orders by category, then name, then id", () => {
    // museum < park alphabetically, so the museum comes first.
    expect(dedupeAndOrder([wayB, nodeA]).map((p) => p.category)).toEqual([
      "museum",
      "park",
    ]);
  });

  it("keeps the first record when identities collide", () => {
    const renamed = { ...nodeA, name: "Different Name" };
    expect(dedupeAndOrder([nodeA, renamed])[0].name).toBe(nodeA.name);
  });
});

describe("capPerCategory", () => {
  it("limits each category independently", () => {
    const places = [
      testOsmPlace({ osmId: "1", category: "cafe" }),
      testOsmPlace({ osmId: "2", category: "cafe" }),
      testOsmPlace({ osmId: "3", category: "cafe" }),
      testOsmPlace({ osmId: "4", category: "museum" }),
    ];

    const capped = capPerCategory(places, 2);
    expect(capped.filter((p) => p.category === "cafe")).toHaveLength(2);
    expect(capped.filter((p) => p.category === "museum")).toHaveLength(1);
  });

  it("keeps everything when the limit exceeds the counts", () => {
    const places = [
      testOsmPlace({ osmId: "1", category: "cafe" }),
      testOsmPlace({ osmId: "2", category: "museum" }),
    ];
    expect(capPerCategory(places, 10)).toHaveLength(2);
  });
});
