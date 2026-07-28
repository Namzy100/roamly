import { describe, expect, it } from "vitest";

import { fixtureOsmPlace } from "@/lib/generate/test-fixtures";
import type { PlaceCategory, TripPlace } from "@/lib/schemas";

import {
  evaluateWikidataCandidate,
  isValidQid,
  looksLikeBranch,
  parseWikipediaTag,
  planWikidataLookup,
  toleranceMetersFor,
  LANDMARK_AREA_TOLERANCE_METERS,
  LANDMARK_POINT_TOLERANCE_METERS,
  type WikidataCandidate,
} from "./wikidata-identity";

/**
 * Wikidata identity, tested against the failure that would be visible to a traveller.
 *
 * That failure is a **photograph of the wrong building** on a stop they are standing outside. Every rejection below is a
 * plausible-looking wrong match: a same-named church in another city, a chain outlet inheriting the chain's article, a
 * museum matched to its neighbour because both are museums.
 *
 * The tolerance tests are the other half. A landmark is not a point, and a rule tight enough to keep branches apart would
 * reject a monastery against its own centroid — so the tolerance is per category, and both directions are asserted.
 */

const MUSEUM: TripPlace = {
  ...fixtureOsmPlace(
    "2001",
    "Museu Nacional do Azulejo",
    "museum",
    38.7248,
    -9.115,
  ),
  address: "R. Me. Deus 4",
};

/** `~0.000009°` of latitude is about a metre, which makes these distances readable. */
function nearby(
  metresNorth: number,
  overrides: Partial<WikidataCandidate> = {},
): WikidataCandidate {
  return {
    qid: "Q1476040",
    label: "Museu Nacional do Azulejo",
    coordinates: { lat: 38.7248 + metresNorth * 0.000009, lng: -9.115 },
    ...overrides,
  };
}

function placeOf(category: PlaceCategory, name = "Somewhere"): TripPlace {
  return fixtureOsmPlace("9001", name, category, 38.7248, -9.115);
}

describe("QID validation", () => {
  it("accepts a real QID and refuses everything else", () => {
    expect(isValidQid("Q1")).toBe(true);
    expect(isValidQid("Q1476040")).toBe(true);

    for (const bad of [
      "Q0",
      "Q01",
      "q1",
      "Q",
      "Q 1",
      "P31",
      "Jerónimos",
      "",
      "Q1;DROP",
    ]) {
      expect(isValidQid(bad), bad).toBe(false);
    }
  });
});

describe("the Wikipedia tag", () => {
  it("splits a well-formed tag", () => {
    expect(parseWikipediaTag("pt:Mosteiro dos Jerónimos")).toEqual({
      lang: "pt",
      title: "Mosteiro dos Jerónimos",
    });
  });

  it("accepts a hyphenated language code", () => {
    expect(parseWikipediaTag("zh-min-nan:Lisboa")?.lang).toBe("zh-min-nan");
  });

  /**
   * An uppercase language code is normalised, not refused.
   *
   * OSM tags are hand-entered and `PT:Título` does appear. The language is a case-insensitive identifier, so folding it is
   * reading the tag as intended rather than being lenient — where refusing would lose a perfectly good article over
   * somebody's caps lock.
   */
  it("lower-cases the language code", () => {
    expect(parseWikipediaTag("PT:Título")).toEqual({
      lang: "pt",
      title: "Título",
    });
  });

  /**
   * A bare title is refused rather than assumed English.
   *
   * There are hundreds of Wikipedias. Defaulting to one would silently mis-resolve most of the world.
   */
  it("refuses a tag with no language prefix", () => {
    for (const bad of [
      "Mosteiro dos Jerónimos",
      ":Title",
      "123:Title",
      "pt:",
    ]) {
      expect(parseWikipediaTag(bad), bad).toBeNull();
    }
  });

  it("bounds the title", () => {
    expect(parseWikipediaTag(`pt:${"a".repeat(251)}`)).toBeNull();
  });
});

describe("the evidence ladder", () => {
  /** Rung 1: two independent sources naming one entity. No coordinate check needed. */
  it("uses an OSM wikidata tag first, as a shared external id", () => {
    const plan = planWikidataLookup({ ...MUSEUM, wikidataId: "Q1476040" });

    expect(plan.kind).toBe("entity");
    if (plan.kind !== "entity") throw new Error("unreachable");
    expect(plan.qid).toBe("Q1476040");
    expect(plan.method).toBe("shared-external-id");
    expect(plan.evidence).toContain("Q1476040");
  });

  /** A malformed tag is not evidence. It falls through rather than reaching an endpoint. */
  it("ignores a malformed wikidata tag", () => {
    expect(
      planWikidataLookup({
        ...MUSEUM,
        wikidataId: "Q0" as TripPlace["wikidataId"],
      }).kind,
    ).not.toBe("entity");
  });

  /**
   * Rung 2: a title is a resolution *request*, never a match.
   *
   * "Ask the API what this title is" is a different action from "fetch this entity" — and the reason a title cannot be
   * treated as an id is that it gets renamed.
   */
  it("turns a wikipedia tag into a resolution request, not a match", () => {
    const plan = planWikidataLookup({
      ...MUSEUM,
      wikipediaTitle: "pt:Museu Nacional do Azulejo",
    });

    expect(plan.kind).toBe("resolve-wikipedia-title");
    if (plan.kind !== "resolve-wikipedia-title") throw new Error("unreachable");
    expect(plan.reference).toEqual({
      lang: "pt",
      title: "Museu Nacional do Azulejo",
    });
    expect(plan.evidence).toContain("resolved");
  });

  it("prefers the wikidata tag over the wikipedia tag", () => {
    expect(
      planWikidataLookup({
        ...MUSEUM,
        wikidataId: "Q1476040",
        wikipediaTitle: "pt:Something Else",
      }).kind,
    ).toBe("entity");
  });

  /** Rung 3: with no tags, a bounded geographic search that still has to corroborate the name. */
  it("falls back to a bounded nearby search", () => {
    const plan = planWikidataLookup(MUSEUM);

    expect(plan.kind).toBe("search-nearby");
    if (plan.kind !== "search-nearby") throw new Error("unreachable");
    expect(plan.radiusMeters).toBe(LANDMARK_POINT_TOLERANCE_METERS);
    expect(plan.name).toBe(MUSEUM.name);
  });

  it("widens the search radius for an area feature", () => {
    const plan = planWikidataLookup(placeOf("park", "Parque Eduardo VII"));

    if (plan.kind !== "search-nearby") throw new Error("unreachable");
    expect(plan.radiusMeters).toBe(LANDMARK_AREA_TOLERANCE_METERS);
  });
});

describe("coordinate tolerance", () => {
  it("is exported per category, and wider for an extent than a point", () => {
    expect(toleranceMetersFor("museum")).toBe(LANDMARK_POINT_TOLERANCE_METERS);
    expect(toleranceMetersFor("park")).toBe(LANDMARK_AREA_TOLERANCE_METERS);
    expect(LANDMARK_AREA_TOLERANCE_METERS).toBeGreaterThan(
      LANDMARK_POINT_TOLERANCE_METERS,
    );
  });

  it("accepts a same-named entity inside the tolerance", () => {
    expect(
      evaluateWikidataCandidate({
        place: MUSEUM,
        candidate: nearby(100),
        canonicalPlaceId: MUSEUM.placeId,
      }).status,
    ).toBe("matched");
  });

  /** The wrong-city case: names agree, distance does not. */
  it("rejects a distant same-name entity", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(5_000),
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("different place of the same name");
  });

  /**
   * A monastery matched against its own centroid.
   *
   * At 800 m a museum's entity is a different museum; a park's is very likely the same park seen from its middle. This is
   * the case a single tolerance would get wrong in one direction or the other.
   */
  it("accepts an area feature at a distance that would fail a point feature", () => {
    const park = placeOf("park", "Parque Eduardo VII");

    expect(
      evaluateWikidataCandidate({
        place: park,
        candidate: nearby(800, { label: "Parque Eduardo VII" }),
        canonicalPlaceId: park.placeId,
      }).status,
    ).toBe("matched");

    expect(
      evaluateWikidataCandidate({
        place: { ...park, category: "museum" },
        candidate: nearby(800, { label: "Parque Eduardo VII" }),
        canonicalPlaceId: park.placeId,
      }).status,
    ).toBe("rejected");
  });
});

describe("evidence that is not enough", () => {
  /** An entity with no coordinates cannot be tied to a place at all. */
  it("rejects an entity with no coordinates", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: { qid: "Q1476040", label: MUSEUM.name },
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("name alone");
  });

  it("rejects proximity with nothing else in common", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50, { label: "Something Entirely Different" }),
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("Proximity alone");
  });

  /**
   * Category corroborates and never decides.
   *
   * "A museum near a museum" is true of every museum quarter in Europe, so this is review rather than a match.
   */
  it("sends proximity-plus-category to review", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50, {
        label: "Museu do Something Else",
        instanceOfLabels: ["art museum"],
      }),
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(outcome.status).toBe("needs-review");
    if (outcome.status !== "needs-review") throw new Error("unreachable");
    expect(outcome.reason).toContain("museum quarter");
  });

  /** An alias is a name. "National Tile Museum" and "Museu Nacional do Azulejo" are one place. */
  it("accepts an alias as name evidence", () => {
    expect(
      evaluateWikidataCandidate({
        place: MUSEUM,
        candidate: nearby(50, {
          label: "National Tile Museum",
          aliases: ["Museu Nacional do Azulejo"],
        }),
        canonicalPlaceId: MUSEUM.placeId,
      }).status,
    ).toBe("matched");
  });

  /** Different formal and colloquial names, same street address. */
  it("accepts an address match when the names differ", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50, {
        label: "Convento da Madre de Deus",
        address: "R Me Deus, 4",
      }),
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") throw new Error("unreachable");
    expect(outcome.evidence).toContain("Addresses agree");
  });
});

describe("branch-like businesses", () => {
  it("recognises an outlet name", () => {
    for (const name of [
      "Fábrica Coffee (Baixa branch)",
      "Padaria Portuguesa — Filial",
      "Museum Shop No. 3",
      "Something Sucursal 2",
    ]) {
      expect(looksLikeBranch(name), name).toBe(true);
    }
  });

  it("does not mistake an ordinary landmark name for an outlet", () => {
    for (const name of [
      "Museu Nacional do Azulejo",
      "Mosteiro dos Jerónimos",
      "Parque Eduardo VII",
      "Sé de Lisboa",
    ]) {
      expect(looksLikeBranch(name), name).toBe(false);
    }
  });

  /**
   * An outlet is rejected outright, not sent to review.
   *
   * There is nothing for a person to decide: the chain's entity describes the chain, and the correct enrichment for one
   * branch is none. Attaching the article would show a photograph of a different building.
   */
  it("rejects a branch before any other evidence is weighed", () => {
    const branch = fixtureOsmPlace(
      "9501",
      "Fábrica Coffee (Baixa branch)",
      "museum",
      38.7248,
      -9.115,
    );

    const outcome = evaluateWikidataCandidate({
      place: branch,
      /* Perfect evidence otherwise: same name, zero metres away. */
      candidate: nearby(0, { label: "Fábrica Coffee (Baixa branch)" }),
      canonicalPlaceId: branch.placeId,
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("one outlet");
  });
});

describe("one entity, one place", () => {
  /**
   * An entity already attached elsewhere goes to review, never through.
   *
   * It *can* be legitimate — a park with two tagged entrances is one feature — but that is a judgement about the data, so
   * a person makes it.
   */
  it("refuses to attach an entity claimed by another place", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50),
      claimedQids: new Map([["Q1476040", "osm:node:9999"]]),
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(outcome.status).toBe("needs-review");
    if (outcome.status !== "needs-review") throw new Error("unreachable");
    expect(outcome.reason).toContain("same geographic feature");
  });

  it("allows re-attaching the entity a place already holds", () => {
    expect(
      evaluateWikidataCandidate({
        place: MUSEUM,
        candidate: nearby(50),
        claimedQids: new Map([["Q1476040", MUSEUM.placeId]]),
        canonicalPlaceId: MUSEUM.placeId,
      }).status,
    ).toBe("matched");
  });

  it("rejects a candidate whose QID is malformed", () => {
    expect(
      evaluateWikidataCandidate({
        place: MUSEUM,
        candidate: nearby(50, { qid: "not-a-qid" }),
        canonicalPlaceId: MUSEUM.placeId,
      }).status,
    ).toBe("rejected");
  });
});

describe("evidence is retained, and there is no score", () => {
  it("carries a sentence a human can audit on every non-rejection", () => {
    const matched = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50),
      canonicalPlaceId: MUSEUM.placeId,
    });

    if (matched.status === "rejected") throw new Error("unreachable");
    expect(matched.evidence.length).toBeGreaterThan(10);
  });

  /** No similarity number anywhere — a threshold would claim an error rate nobody measured. */
  it("exposes no numeric confidence", () => {
    const outcome = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50),
      canonicalPlaceId: MUSEUM.placeId,
    });

    for (const forbidden of [
      "score",
      "confidence",
      "probability",
      "similarity",
    ]) {
      expect(Object.keys(outcome)).not.toContain(forbidden);
    }
  });

  it("is deterministic", () => {
    const once = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50),
      canonicalPlaceId: MUSEUM.placeId,
    });
    const twice = evaluateWikidataCandidate({
      place: MUSEUM,
      candidate: nearby(50),
      canonicalPlaceId: MUSEUM.placeId,
    });

    expect(once).toEqual(twice);
  });
});
