import { describe, expect, it } from "vitest";

import {
  identityMatchesCanonicalId,
  InvalidOsmIdentityError,
  isCanonicalId,
  normalizeOsmType,
  parseCanonicalId,
  requireCanonicalId,
  toCanonicalId,
} from "./identity";

describe("toCanonicalId", () => {
  it("builds node, way and relation ids", () => {
    expect(toCanonicalId("node", 240109189)).toBe("osm:node:240109189");
    expect(toCanonicalId("way", "12345")).toBe("osm:way:12345");
    expect(toCanonicalId("relation", 5400890)).toBe("osm:relation:5400890");
  });

  it("keeps the three element types in separate id spaces", () => {
    // The whole reason type is part of the identity: OSM numbers nodes, ways and
    // relations independently, so the same integer names three different things.
    const id = 240109189;
    const ids = new Set([
      toCanonicalId("node", id),
      toCanonicalId("way", id),
      toCanonicalId("relation", id),
    ]);
    expect(ids.size).toBe(3);
  });

  it("rejects non-numeric, negative, zero and padded ids", () => {
    expect(() => toCanonicalId("node", "abc")).toThrow(InvalidOsmIdentityError);
    expect(() => toCanonicalId("node", "-5")).toThrow(InvalidOsmIdentityError);
    expect(() => toCanonicalId("node", "0")).toThrow(InvalidOsmIdentityError);
    expect(() => toCanonicalId("node", "12.5")).toThrow(InvalidOsmIdentityError);
    // Two spellings of one identity would break deduplication.
    expect(() => toCanonicalId("node", "007")).toThrow(InvalidOsmIdentityError);
  });

  it("rejects an unknown element type", () => {
    expect(() =>
      toCanonicalId("street" as unknown as "node", 1),
    ).toThrow(InvalidOsmIdentityError);
  });

  it("rejects injection attempts in the id", () => {
    expect(() => toCanonicalId("node", "1;drop")).toThrow(InvalidOsmIdentityError);
    expect(() => toCanonicalId("node", "1 OR 1=1")).toThrow(InvalidOsmIdentityError);
  });
});

describe("parseCanonicalId", () => {
  it("round-trips every element type", () => {
    for (const type of ["node", "way", "relation"] as const) {
      const id = toCanonicalId(type, 987654);
      expect(parseCanonicalId(id)).toEqual({ osmType: type, osmId: "987654" });
    }
  });

  it("returns null for anything that is not a canonical id", () => {
    expect(parseCanonicalId("mock_hotel")).toBeNull();
    expect(parseCanonicalId("osm:node:")).toBeNull();
    expect(parseCanonicalId("osm:node:abc")).toBeNull();
    expect(parseCanonicalId("osm:street:1")).toBeNull();
    expect(parseCanonicalId("osm:node:1:extra")).toBeNull();
    expect(parseCanonicalId("")).toBeNull();
    expect(parseCanonicalId("osm:node:0")).toBeNull();
    expect(parseCanonicalId("osm:node:007")).toBeNull();
  });

  it("has a throwing counterpart for hard-failure paths", () => {
    expect(() => requireCanonicalId("nope")).toThrow(InvalidOsmIdentityError);
    expect(requireCanonicalId("osm:way:5").osmId).toBe("5");
  });

  it("exposes a boolean form", () => {
    expect(isCanonicalId("osm:relation:9")).toBe(true);
    expect(isCanonicalId("mock_x")).toBe(false);
  });
});

describe("identityMatchesCanonicalId", () => {
  it("accepts a matching pair", () => {
    expect(identityMatchesCanonicalId("osm:node:42", "node", "42")).toBe(true);
  });

  it("rejects a mismatched type or id", () => {
    expect(identityMatchesCanonicalId("osm:node:42", "way", "42")).toBe(false);
    expect(identityMatchesCanonicalId("osm:node:42", "node", "43")).toBe(false);
  });

  it("rejects rather than throws on malformed input", () => {
    expect(identityMatchesCanonicalId("osm:node:42", "node", "abc")).toBe(false);
  });
});

describe("normalizeOsmType", () => {
  it("accepts full words and single letters", () => {
    expect(normalizeOsmType("node")).toBe("node");
    expect(normalizeOsmType("N")).toBe("node");
    expect(normalizeOsmType("w")).toBe("way");
    expect(normalizeOsmType("RELATION")).toBe("relation");
  });

  it("returns null for anything else", () => {
    expect(normalizeOsmType("point")).toBeNull();
    expect(normalizeOsmType("")).toBeNull();
  });
});
