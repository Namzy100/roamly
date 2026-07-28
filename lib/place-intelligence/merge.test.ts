import { describe, expect, it } from "vitest";

import { factId } from "./facts";
import { mergeIntelligence } from "./merge";
import { PlaceFactSchema } from "./schemas";
import {
  fact,
  identity,
  media,
  provenance,
  sidecar,
  NOW,
  TERMS_READ_ON,
} from "./test-fixtures";

/**
 * Merging, tested for the two properties that make it safe to run repeatedly.
 *
 * **It only ever grows.** There is no arm that loses information, which is what lets enrichment run on every refresh without a
 * revision guard. A competing claim is added beside the existing one and becomes a conflict; only a *re-fetch of the same
 * claim* — same provider, same kind, same subject moment, so the same `id` — is deduplicated.
 *
 * **Confidence is derived, never accepted.** An adapter can put any confidence it likes on a fact; the merge discards it and
 * recomputes from the sources actually present. That is the only way "only the matching logic may produce high confidence"
 * can be enforced rather than requested.
 */

const OSM_HOURS = fact({
  kind: "opening-hours",
  value: "Mo-Su 08:00-19:00",
  provider: "openstreetmap",
});

const WIKIDATA_INCEPTION = fact({
  kind: "inception-year",
  value: 1893,
  provider: "wikidata",
});

const TRUSTED = identity({ method: "shared-external-id" });

describe("additive merging", () => {
  it("adds a fact to an empty sidecar", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [WIKIDATA_INCEPTION],
    });

    expect(result.intelligence.facts).toHaveLength(1);
    expect(result.intelligence.identities).toHaveLength(1);
    expect(result.refusals).toEqual([]);
  });

  /** Nothing is ever dropped to make room for a newer claim. */
  it("keeps both values when a second source disagrees", () => {
    const first = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [OSM_HOURS],
    });

    const second = mergeIntelligence({
      existing: first.intelligence,
      identity: identity({ provider: "foursquare", externalId: "fsq-1" }),
      facts: [
        fact({
          kind: "opening-hours",
          value: "Mo-Su 08:30-18:00",
          provider: "foursquare",
        }),
      ],
    });

    expect(second.intelligence.facts).toHaveLength(2);
    expect(second.intelligence.facts.map((entry) => entry.value).sort()).toEqual(
      ["Mo-Su 08:00-19:00", "Mo-Su 08:30-18:00"],
    );
  });

  /**
   * The canonical record is unreachable from here, by type.
   *
   * A provider's `category` fact is recorded *beside* OSM's rather than over it — the function's input and output are both
   * sidecars, so it has no `TripPlace` to write to even by accident.
   */
  it("cannot replace the canonical name, coordinates or category", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [
        fact({ kind: "category", value: "bar", provider: "foursquare" }),
        fact({
          kind: "address",
          value: "Somewhere else",
          provider: "foursquare",
        }),
      ],
    });

    expect(Object.keys(result.intelligence).sort()).toEqual([
      "canonicalPlaceId",
      "facts",
      "identities",
      "media",
    ]);
    expect(result.intelligence.canonicalPlaceId).toBe("osm:node:1001");
  });

  it("refuses facts aimed at a different canonical place", () => {
    const result = mergeIntelligence({
      existing: sidecar({ canonicalPlaceId: "osm:node:1001" }),
      identity: identity({ canonicalPlaceId: "osm:node:9999" }),
      facts: [WIKIDATA_INCEPTION],
    });

    expect(result.intelligence.facts).toEqual([]);
    expect(result.refusals[0].code).toBe("wrong_canonical_place");
  });
});

describe("deduplication", () => {
  /** Same provider, same kind, same subject moment — the same claim re-fetched, not a competing one. */
  it("deduplicates a re-fetched fact deterministically", () => {
    const first = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [OSM_HOURS],
    });

    const again = mergeIntelligence({
      existing: first.intelligence,
      identity: TRUSTED,
      facts: [OSM_HOURS],
    });

    expect(again.intelligence.facts).toHaveLength(1);
    expect(again.refusals.map((refusal) => refusal.code)).toContain(
      "duplicate_fact",
    );
  });

  /** First write wins, so a refresh never changes a value out from under a displayed conflict. */
  it("keeps the existing value when the same id arrives with a new value", () => {
    const first = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [OSM_HOURS],
    });

    const again = mergeIntelligence({
      existing: first.intelligence,
      identity: TRUSTED,
      facts: [{ ...OSM_HOURS, value: "Mo-Su 09:00-17:00" }],
    });

    expect(again.intelligence.facts[0].value).toBe("Mo-Su 08:00-19:00");
  });

  /** Two forecasts for two hours are two facts, because the subject moment is part of the id. */
  it("treats two subject moments as two facts", () => {
    const morning = fact({
      kind: "weather-forecast",
      value: "18°C, clear",
      provider: "open-meteo",
      subjectAt: "2026-09-12T09:00:00.000Z",
    });
    const afternoon = fact({
      kind: "weather-forecast",
      value: "24°C, clear",
      provider: "open-meteo",
      subjectAt: "2026-09-12T15:00:00.000Z",
    });

    expect(morning.id).not.toBe(afternoon.id);

    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [morning, afternoon],
    });

    expect(result.intelligence.facts).toHaveLength(2);
  });

  it("deduplicates media by id", () => {
    const photo = media();

    const first = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      media: [photo],
    });
    const again = mergeIntelligence({
      existing: first.intelligence,
      identity: TRUSTED,
      media: [photo],
    });

    expect(again.intelligence.media).toHaveLength(1);
    expect(again.refusals.map((refusal) => refusal.code)).toContain(
      "duplicate_media",
    );
  });

  it("keeps the first external id when a second arrives for one provider", () => {
    const first = mergeIntelligence({
      existing: sidecar(),
      identity: identity({ provider: "wikidata", externalId: "Q1" }),
    });
    const again = mergeIntelligence({
      existing: first.intelligence,
      identity: identity({ provider: "wikidata", externalId: "Q2" }),
    });

    expect(again.intelligence.identities).toHaveLength(1);
    expect(again.intelligence.identities[0].externalId).toBe("Q1");
    expect(again.refusals.map((refusal) => refusal.code)).toContain(
      "duplicate_identity",
    );
  });
});

describe("refused facts never enter", () => {
  /**
   * Ratings and review counts are refused whoever supplies them, and refused *separately*.
   *
   * Two providers' ratings are two measurements of different populations. They are not combined, not averaged, and not
   * treated as a conflict — they simply never arrive.
   */
  it("refuses ratings and review counts, one refusal each", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [
        fact({ kind: "rating", value: 4.6, provider: "foursquare" }),
        fact({ kind: "rating", value: 4.1, provider: "yelp" }),
        fact({ kind: "review-count", value: 812, provider: "foursquare" }),
        fact({ kind: "review-count", value: 1_204, provider: "yelp" }),
      ],
    });

    expect(result.intelligence.facts).toEqual([]);
    expect(result.refusals).toHaveLength(4);
    for (const refusal of result.refusals) {
      expect(refusal.code).toBe("refused_fact_kind");
    }
  });

  it("refuses every other prohibited kind", () => {
    for (const kind of [
      "review-excerpt",
      "price-level",
      "popularity",
      "forecast-crowding",
      "editorial-summary",
      "live-price",
    ] as const) {
      const result = mergeIntelligence({
        existing: sidecar(),
        identity: TRUSTED,
        facts: [fact({ kind, value: "anything", provider: "foursquare" })],
      });

      expect(result.intelligence.facts, kind).toEqual([]);
    }
  });
});

describe("an untrusted match imports nothing", () => {
  it("records the identity and refuses the facts", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: identity({ method: "name-and-proximity" }),
      facts: [OSM_HOURS],
      media: [media()],
    });

    expect(result.intelligence.identities).toHaveLength(1);
    expect(result.intelligence.facts).toEqual([]);
    expect(result.intelligence.media).toEqual([]);
    expect(result.refusals[0].code).toBe("untrusted_match");
  });

  /** Confirming upgrades the method to `manual`, and the next fold lets the facts through. */
  it("accepts the facts once a person has confirmed", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: identity({ method: "manual" }),
      facts: [OSM_HOURS],
    });

    expect(result.intelligence.facts).toHaveLength(1);
  });
});

describe("confidence is derived, not accepted", () => {
  /** An adapter asserting corroboration with one source behind it has the assertion discarded. */
  it("discards a hand-asserted confidence", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [{ ...WIKIDATA_INCEPTION, confidence: "corroborated" as const }],
    });

    expect(result.intelligence.facts[0].confidence).toBe("reported");
  });

  it("promotes to corroborated only when two providers agree", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [
        fact({
          kind: "phone",
          value: "+351 21 324 0100",
          provider: "openstreetmap",
        }),
        fact({
          kind: "phone",
          value: "+351 21 324 0100",
          provider: "foursquare",
        }),
      ],
    });

    for (const entry of result.intelligence.facts) {
      expect(entry.confidence).toBe("corroborated");
    }
  });

  it("marks a contested kind disputed, whatever the adapter claimed", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [
        { ...OSM_HOURS, confidence: "corroborated" as const },
        fact({
          kind: "opening-hours",
          value: "Mo-Su 08:30-18:00",
          provider: "foursquare",
        }),
      ],
    });

    for (const entry of result.intelligence.facts) {
      expect(entry.confidence).toBe("disputed");
    }
  });

  /** A third source disagreeing must demote a previously corroborated fact, not leave it stale. */
  it("recomputes over the whole set rather than incrementally", () => {
    const agreed = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [
        fact({
          kind: "website",
          value: "https://example.com",
          provider: "openstreetmap",
        }),
        fact({
          kind: "website",
          value: "https://example.com",
          provider: "foursquare",
        }),
      ],
    });

    expect(agreed.intelligence.facts[0].confidence).toBe("corroborated");

    const contested = mergeIntelligence({
      existing: agreed.intelligence,
      identity: identity({ provider: "wikidata", externalId: "Q7" }),
      facts: [
        fact({
          kind: "website",
          value: "https://elsewhere.example",
          provider: "wikidata",
        }),
      ],
    });

    for (const entry of contested.intelligence.facts) {
      expect(entry.confidence).toBe("disputed");
    }
  });
});

describe("provenance survives the merge intact", () => {
  it("retains the provider, external id, fetch time and attribution", () => {
    const source = provenance({
      provider: "openstreetmap",
      externalId: "node/1001",
      sourceUrl: "https://www.openstreetmap.org/node/1001",
    });

    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [fact({ kind: "phone", provenance: source })],
    });

    const stored = result.intelligence.facts[0].provenance;
    expect(stored.provider).toBe("openstreetmap");
    expect(stored.externalId).toBe("node/1001");
    expect(stored.retrievedAt).toBe(NOW);
    expect(stored.attributionText).toBe("© OpenStreetMap contributors (ODbL)");
    expect(stored.sourceUrl).toBe("https://www.openstreetmap.org/node/1001");
  });

  /** The recorded policy is what makes a later tightening of terms detectable. */
  it("retains the persistence and display policy, and the date the terms were read", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [WIKIDATA_INCEPTION],
    });

    const policy = result.intelligence.facts[0].provenance.policy;
    expect(policy.persistence).toBe("granted");
    expect(policy.display).toBe("granted");
    expect(policy.export).toBe("granted");
    expect(policy.termsReadOn).toBe(TERMS_READ_ON);
  });

  /** Every merged fact still parses, which is what "no anonymous fact, no raw field" means in practice. */
  it("leaves every merged fact parseable", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [OSM_HOURS, WIKIDATA_INCEPTION],
    });

    for (const entry of result.intelligence.facts) {
      expect(PlaceFactSchema.safeParse(entry).success).toBe(true);
      expect(entry.provenance.provider).toBeDefined();
    }
  });

  /** An unsafe source URL never becomes a stored citation. */
  it("keeps a source URL only when it is one we may store", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({
          provenance: provenance({ sourceUrl: "http://example.com/insecure" }),
        }),
      ).success,
    ).toBe(false);
  });
});

describe("fact identity", () => {
  it("derives the same id for the same claim", () => {
    expect(factId({ provider: "wikidata", kind: "inception-year" })).toBe(
      factId({ provider: "wikidata", kind: "inception-year" }),
    );
  });

  /** The value is deliberately excluded, so a corrected phone number replaces rather than accumulates. */
  it("does not include the value", () => {
    const id = factId({ provider: "openstreetmap", kind: "phone" });
    expect(id).toBe("openstreetmap:phone");
    expect(id).not.toContain("351");
  });
});
