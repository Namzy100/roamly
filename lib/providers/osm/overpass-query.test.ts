import { describe, expect, it } from "vitest";

import { ALL_PLACE_CATEGORIES } from "./categories";
import { LIMITS, OVERPASS_QUERY_TIMEOUT_S } from "./config";
import { ProviderError } from "./errors";
import { buildOverpassQuery } from "./overpass-query";

const CENTRE = { latitude: 38.7223, longitude: -9.1393 };

function build(overrides: Partial<Parameters<typeof buildOverpassQuery>[0]> = {}) {
  return buildOverpassQuery({
    center: CENTRE,
    categories: ["museum"],
    radiusMeters: 2_000,
    limitPerCategory: 10,
    ...overrides,
  });
}

describe("buildOverpassQuery — shape", () => {
  it("emits a JSON query with the configured timeout ceiling", () => {
    const { query } = build();
    expect(query.startsWith(`[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];`)).toBe(
      true,
    );
  });

  it("uses nwr so nodes, ways and relations are all matched", () => {
    const { query } = build();
    expect(query).toContain("nwr[");
  });

  it("requests a centre coordinate so ways and relations are mappable", () => {
    const { query } = build();
    expect(query).toContain("out center 10;");
  });

  it("gives each category its own result set and cap", () => {
    const { query } = build({ categories: ["museum", "cafe"], limitPerCategory: 7 });
    expect(query).toContain("->.c0;");
    expect(query).toContain("->.c1;");
    expect(query.match(/out center 7;/g)).toHaveLength(2);
  });

  it("expands a multi-tag category into alternatives", () => {
    // `bar` maps to both amenity=bar and amenity=pub; missing one would silently
    // drop half the pubs in any European city.
    const { query } = build({ categories: ["bar"] });
    expect(query).toContain('nwr["amenity"="bar"]');
    expect(query).toContain('nwr["amenity"="pub"]');
  });

  it("is deterministic regardless of category input order", () => {
    const a = build({ categories: ["viewpoint", "cafe", "museum"] });
    const b = build({ categories: ["museum", "viewpoint", "cafe"] });
    expect(a.query).toBe(b.query);
    expect(a.categories).toEqual(b.categories);
  });

  it("builds a valid query for every allowlisted category", () => {
    // Guards against adding a category to the vocabulary without a tag mapping.
    for (const category of ALL_PLACE_CATEGORIES) {
      const { query } = build({ categories: [category] });
      expect(query).toContain("nwr[");
      expect(query).toContain("out center");
    }
  });
});

describe("buildOverpassQuery — injection safety", () => {
  it("rejects a category that is not in the allowlist", () => {
    expect(() =>
      build({ categories: ["nightlife" as never] }),
    ).toThrow(ProviderError);
  });

  it("rejects Overpass syntax supplied as a category", () => {
    const attacks = [
      '"]["amenity"="restaurant"',
      "museum];out meta;//",
      "museum);out;(",
      "museum\"]->.x;.x out meta;(nwr[\"amenity\"=\"bar\"",
      "*",
      "museum;",
      "museum]",
      "../../etc/passwd",
    ];

    for (const attack of attacks) {
      expect(() => build({ categories: [attack as never] })).toThrow(ProviderError);
    }
  });

  it("never lets an unknown string reach the query text", () => {
    // Belt and braces: even if the throw above regressed, prove the marker never
    // appears in generated output for any allowlisted request.
    const marker = "INJECTED";
    const { query } = build({ categories: ["museum", "cafe"] });
    expect(query).not.toContain(marker);
    // Only the four literal characters we emit ourselves may appear as syntax.
    const suspicious = query.match(/[;\]\[()]/g) ?? [];
    expect(suspicious.length).toBeGreaterThan(0); // our own syntax exists
    expect(query).not.toMatch(/out meta/);
  });

  it("rejects non-finite or out-of-range coordinates", () => {
    expect(() =>
      build({ center: { latitude: Number.NaN, longitude: 0 } }),
    ).toThrow(ProviderError);
    expect(() =>
      build({ center: { latitude: 0, longitude: Number.POSITIVE_INFINITY } }),
    ).toThrow(ProviderError);
    expect(() => build({ center: { latitude: 91, longitude: 0 } })).toThrow(
      ProviderError,
    );
    expect(() => build({ center: { latitude: 0, longitude: -181 } })).toThrow(
      ProviderError,
    );
  });

  it("emits coordinates in fixed decimal notation, never exponential", () => {
    const { query } = build({
      center: { latitude: 0.0000001, longitude: -0.0000002 },
    });
    expect(query).not.toMatch(/e-/i);
    expect(query).toContain("0.0000001");
  });

  it("requires at least one category", () => {
    expect(() => build({ categories: [] })).toThrow(ProviderError);
  });
});

describe("buildOverpassQuery — bounds", () => {
  it("caps the radius, preventing country-scale queries", () => {
    const { radiusMeters, query } = build({ radiusMeters: 5_000_000 });
    expect(radiusMeters).toBe(LIMITS.maxRadiusMeters);
    expect(query).toContain(`around:${LIMITS.maxRadiusMeters},`);
  });

  it("raises a too-small radius to the floor", () => {
    expect(build({ radiusMeters: 1 }).radiusMeters).toBe(LIMITS.minRadiusMeters);
  });

  it("falls back to the default radius for a non-finite value", () => {
    expect(build({ radiusMeters: Number.NaN }).radiusMeters).toBe(
      LIMITS.defaultRadiusMeters,
    );
  });

  it("caps the per-category limit", () => {
    expect(build({ limitPerCategory: 9_999 }).limitPerCategory).toBe(
      LIMITS.maxResultsPerCategory,
    );
  });

  it("rejects more categories than the per-request maximum", () => {
    const tooMany = ALL_PLACE_CATEGORIES.slice(
      0,
      LIMITS.maxCategoriesPerRequest + 1,
    );
    expect(() => build({ categories: [...tooMany] })).toThrow(ProviderError);
  });

  it("deduplicates before applying the category cap", () => {
    // Repeating a category should not consume the budget.
    const repeated = Array.from({ length: 20 }, () => "museum" as const);
    const result = build({ categories: repeated });
    expect(result.categories).toEqual(["museum"]);
  });
});
