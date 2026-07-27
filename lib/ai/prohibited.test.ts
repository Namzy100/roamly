import { describe, expect, it } from "vitest";

import { PROHIBITED_KEYS, findProhibitedFields } from "./prohibited";
import { TripStrategySchema } from "./schemas";

/**
 * The scan exists because Zod strips rather than rejects. The first test below is
 * the one that justifies the whole module — it proves the fabrication really would
 * vanish silently without it.
 */
describe("findProhibitedFields", () => {
  it("catches what Zod would have stripped without telling anyone", () => {
    const withFabrication = {
      recommendedBaseArea: "Alfama",
      latitude: 38.7,
      rating: 4.6,
    };

    // The premise: `parse` succeeds and the invented fields disappear.
    const stripped = TripStrategySchema.partial().parse(withFabrication);
    expect(stripped).not.toHaveProperty("latitude");
    expect(stripped).not.toHaveProperty("rating");

    // The scan sees them, because it runs on the raw object.
    const findings = findProhibitedFields(withFabrication);
    expect(findings.map((finding) => finding.key).sort()).toEqual([
      "latitude",
      "rating",
    ]);
  });

  it("passes a payload that asserts nothing", () => {
    expect(
      findProhibitedFields({
        days: [{ dayNumber: 1, theme: "Alfama", pace: "balanced" }],
        recommendedBaseArea: "the old town",
      }),
    ).toEqual([]);
  });

  it("matches regardless of spelling or case", () => {
    for (const key of ["place_id", "placeID", "PlaceId", "Place-Id"]) {
      expect(findProhibitedFields({ [key]: "x" })).toHaveLength(1);
    }
  });

  it("finds fields nested inside arrays and objects, and reports the path", () => {
    const findings = findProhibitedFields({
      days: [{ items: [{ slotId: "d1-s1", coordinates: { lat: 1, lng: 2 } }] }],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe("days[0].items[0].coordinates");
  });

  it("allows placeId when assembly asks for it, and nothing else", () => {
    const raw = { placeId: "osm:node:1", rating: 5 };

    const findings = findProhibitedFields(raw, { allow: ["placeId"] });
    expect(findings.map((finding) => finding.key)).toEqual(["rating"]);
  });

  it("stops descending at a prohibited container rather than listing every leaf", () => {
    const findings = findProhibitedFields({
      place: { name: "invented", latitude: 1, rating: 5 },
    });

    // One finding — the fabricated container — not three.
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("place");
  });

  it("covers identity, provider facts and routing facts", () => {
    for (const key of ["placeId", "rating", "durationMinutes", "geometry"]) {
      expect(PROHIBITED_KEYS).toContain(key.toLowerCase());
    }
  });

  it("ignores primitives, null and arrays at the root", () => {
    expect(findProhibitedFields(null)).toEqual([]);
    expect(findProhibitedFields("rating")).toEqual([]);
    expect(findProhibitedFields([1, 2, 3])).toEqual([]);
  });
});
