import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import {
  exportTrip,
  parseImportedTrip,
  serialiseTrip,
} from "@/lib/store/portable-trip";

import { detectConflicts, officialSourceRuleFor } from "./conflicts";
import { mayDisplayFact } from "./display-policy";
import { factIsExpired, factIsStale, factIsUsable } from "./freshness";
import { mergeIntelligence } from "./merge";
import {
  importRejections,
  mayCache,
  mayCopyMediaBytes,
  mayExportFact,
  mayExportMedia,
  mayPersistFact,
  mayPersistMedia,
  persistenceRefusalReason,
  stripAllForExport,
} from "./persistence-policy";
import { PlaceIntelligenceSchema } from "./schemas";
import { fact, identity, media, provenance, sidecar, NOW } from "./test-fixtures";
import type { ProviderId } from "./types";
import { validateIntelligence } from "./validate";

/**
 * The policy matrix, pinned.
 *
 * This is the file that would fail if somebody widened a permission without reading `docs/PROVIDER_RESEARCH.md`. Each
 * assertion corresponds to a documented finding, and the comment says which — so a future change to one of these lines has to
 * argue with a citation rather than with a preference.
 */

describe("conflicts", () => {
  it("records conflicting opening hours without picking a winner", () => {
    const conflicts = detectConflicts("osm:node:1001", [
      fact({
        kind: "opening-hours",
        value: "Mo-Su 08:00-19:00",
        provider: "openstreetmap",
      }),
      fact({
        kind: "opening-hours",
        value: "Mo-Su 08:30-18:00",
        provider: "foursquare",
      }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].claims).toHaveLength(2);
    expect(conflicts[0].resolution).toBe("unresolved");
    expect(conflicts[0].message).toContain("Check before relying on it");
  });

  it("records conflicting business status", () => {
    const conflicts = detectConflicts("osm:node:1001", [
      fact({
        kind: "business-status",
        value: "open",
        provider: "openstreetmap",
      }),
      fact({
        kind: "business-status",
        value: "permanently-closed",
        provider: "foursquare",
      }),
    ]);

    expect(conflicts.map((entry) => entry.kind)).toEqual(["business-status"]);
  });

  /**
   * Two ratings are two measurements, not a contradiction.
   *
   * They surveyed different people by different methods, so calling it a conflict would invite a resolution — and every
   * resolution for a rating is either a fabricated average or an arbitrary winner.
   */
  it("does not treat separate ratings as an operational conflict", () => {
    const conflicts = detectConflicts("osm:node:1001", [
      fact({ kind: "rating", value: 4.6, provider: "foursquare" }),
      fact({ kind: "rating", value: 4.1, provider: "yelp" }),
      fact({ kind: "review-count", value: 812, provider: "foursquare" }),
      fact({ kind: "review-count", value: 1_204, provider: "yelp" }),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("reports nothing when two sources agree, modulo case and spacing", () => {
    const conflicts = detectConflicts("osm:node:1001", [
      fact({
        kind: "website",
        value: "https://Example.com",
        provider: "openstreetmap",
      }),
      fact({
        kind: "website",
        value: " https://example.com ",
        provider: "foursquare",
      }),
    ]);

    expect(conflicts).toEqual([]);
  });

  /**
   * An authority requires a written rule, not a default.
   *
   * Silent precedence — "prefer OSM whenever OSM is present" — is how a stale opening time beats a fresh one forever.
   */
  it("names an authority only where an explicit rule exists", () => {
    expect(officialSourceRuleFor("category")?.authority).toBe("openstreetmap");
    expect(officialSourceRuleFor("wikidata-id")?.authority).toBe("wikidata");

    /* No rule for the fields most likely to be stale in OSM. */
    expect(officialSourceRuleFor("opening-hours")).toBeNull();
    expect(officialSourceRuleFor("phone")).toBeNull();
    expect(officialSourceRuleFor("business-status")).toBeNull();
  });

  it("resolves by the rule, and carries the rule that did it", () => {
    const conflicts = detectConflicts("osm:node:1001", [
      fact({ kind: "category", value: "cafe", provider: "openstreetmap" }),
      fact({ kind: "category", value: "bar", provider: "foursquare" }),
    ]);

    expect(conflicts[0].resolution).toBe("official-source");
    expect(conflicts[0].rule?.reason).toContain("by construction");
  });

  /**
   * No midpoint, no average, no newest-wins.
   *
   * The later-fetched value gets no advantage, and no third value is invented.
   */
  it("neither averages values nor prefers the newer fetch", () => {
    const older = fact({
      kind: "inception-year",
      value: 1893,
      provenance: provenance({
        provider: "openstreetmap",
        retrievedAt: "2020-01-01T00:00:00.000Z",
      }),
    });
    const newer = fact({
      kind: "inception-year",
      value: 1901,
      provenance: provenance({
        provider: "foursquare",
        retrievedAt: "2026-07-28T00:00:00.000Z",
      }),
    });

    const conflicts = detectConflicts("osm:node:1001", [older, newer]);

    expect(conflicts[0].resolution).toBe("unresolved");
    expect(conflicts[0].claims.map((claim) => claim.value)).toEqual([1893, 1901]);
    /* 1897 is the midpoint; it must appear nowhere. */
    expect(conflicts[0].claims.map((claim) => claim.value)).not.toContain(1897);
  });
});

describe("freshness", () => {
  const LATER = "2026-09-01T12:00:00.000Z";

  it("detects a stale durable fact", () => {
    const old = fact({
      kind: "phone",
      provenance: provenance({ retrievedAt: "2026-01-01T00:00:00.000Z" }),
    });

    expect(factIsStale(old, NOW)).toBe(true);
    expect(factIsStale(fact(), NOW)).toBe(false);
  });

  /** A forecast for a moment that has passed is worthless however recently it was fetched. */
  it("expires a perishable fact whose moment has passed", () => {
    const forecast = fact({
      kind: "weather-forecast",
      value: "18°C",
      provider: "open-meteo",
      subjectAt: NOW,
    });

    expect(factIsExpired(forecast, NOW)).toBe(false);
    expect(factIsExpired(forecast, LATER)).toBe(true);
  });

  /** A perishable fact that cannot say which moment it describes must not describe this one. */
  it("expires a perishable fact with no subject moment", () => {
    const forecast = fact({
      kind: "weather-forecast",
      value: "18°C",
      provider: "open-meteo",
    });

    expect(factIsExpired(forecast, NOW)).toBe(true);
  });

  it("expires a scheduled fact past its own end", () => {
    const event = fact({
      kind: "event",
      value: "Fado night",
      subjectAt: "2026-08-01T20:00:00.000Z",
      validUntil: "2026-08-01T23:00:00.000Z",
    });

    expect(factIsExpired(event, "2026-08-01T21:00:00.000Z")).toBe(false);
    expect(factIsExpired(event, LATER)).toBe(true);
  });

  it("treats an unreadable timestamp as stale rather than fresh", () => {
    expect(factIsStale(fact(), "not a date")).toBe(true);
  });

  /**
   * An expired display-only fact is omitted from display.
   *
   * Freshness is a display gate rather than a refresh hint: a stale phone number shown as current is the same failure as a
   * stale forecast — the interface asserting something it cannot support.
   */
  it("omits an expired fact from display", () => {
    const forecast = fact({
      kind: "weather-forecast",
      value: "18°C",
      provider: "open-meteo",
      subjectAt: NOW,
    });

    expect(mayDisplayFact(forecast, { surface: "in-app", now: NOW })).toBe(
      "granted",
    );
    expect(mayDisplayFact(forecast, { surface: "in-app", now: LATER })).toBe(
      "denied",
    );
    expect(factIsUsable(forecast, LATER)).toBe(false);
  });

  it("omits a disputed fact from display", () => {
    const contested = fact({
      kind: "opening-hours",
      value: "Mo-Su 08:00-19:00",
      confidence: "disputed",
    });

    expect(mayDisplayFact(contested, { surface: "in-app", now: NOW })).toBe(
      "denied",
    );
  });
});

describe("the persistence and export matrix", () => {
  /**
   * An unknown provider is unrepresentable, which is stronger than refused.
   *
   * `ProviderId` is a closed union, so there is no way to construct a fact from a provider the policy has never heard of —
   * and the schema refuses one at the boundary. The providers below stand in for "not on any allow-list".
   */
  it("refuses cache, persistence and export for providers on no allow-list", () => {
    for (const provider of ["besttime", "ticketmaster"] as ProviderId[]) {
      expect(mayCache(provider), provider).toBe("denied");

      const entry = fact({ kind: "phone", provider });
      expect(mayPersistFact(entry), provider).toBe("denied");
      expect(mayExportFact(entry), provider).toBe("denied");
    }
  });

  /**
   * Foursquare: caching is granted, the *duration* is unresolved, and unresolved is treated as denied.
   *
   * The licence agreement defers the window to Usage Guidelines that could not be retrieved. Nothing persists until that is
   * answered.
   */
  it("keeps Foursquare restrictive while its caching window is unresolved", () => {
    const entry = fact({ kind: "opening-hours", provider: "foursquare" });

    expect(mayPersistFact(entry)).toBe("denied");
    expect(mayExportFact(entry)).toBe("denied");
    expect(persistenceRefusalReason(entry)).toContain("unresolved");
  });

  /** Google forbids pre-fetching, caching or storing Places content beyond place ids. */
  it("refuses Google Places content for persistence and export", () => {
    const entry = fact({ kind: "opening-hours", provider: "google-places" });

    expect(mayCache("google-places")).toBe("denied");
    expect(mayPersistFact(entry)).toBe("denied");
    expect(mayExportFact(entry)).toBe("denied");
    expect(persistenceRefusalReason(entry)).toContain("only place ids");
  });

  /** Yelp caps storage of any of its data at 24 hours; Roamly's records have no expiry. */
  it("refuses Yelp facts for long-term persistence and export", () => {
    const entry = fact({ kind: "opening-hours", provider: "yelp" });

    expect(mayPersistFact(entry)).toBe("denied");
    expect(mayExportFact(entry)).toBe("denied");
    expect(persistenceRefusalReason(entry)).toContain("24 hours");
  });

  /** CC0 with no attribution obligation, storable and redistributable without qualification. */
  it("permits Wikidata facts to persist and export", () => {
    const entry = fact({
      kind: "inception-year",
      value: 1893,
      provider: "wikidata",
    });

    expect(mayCache("wikidata")).toBe("granted");
    expect(mayPersistFact(entry)).toBe("granted");
    expect(mayExportFact(entry)).toBe("granted");
    expect(persistenceRefusalReason(entry)).toBeNull();
  });

  /** Commons permits copying to your own server — but only once the file's own licence is known. */
  it("permits Wikimedia media only with a licence and a credit", () => {
    const complete = media();
    expect(mayPersistMedia(complete)).toBe("granted");
    expect(mayExportMedia(complete)).toBe("granted");
    expect(mayCopyMediaBytes(complete)).toBe("granted");

    const noCredit = media({
      provenance: provenance({
        provider: "wikimedia-commons",
        attributionText: undefined,
      }),
    });
    expect(mayPersistMedia(noCredit)).toBe("denied");
    expect(mayCopyMediaBytes(noCredit)).toBe("denied");

    const unknownLicence = media({
      provenance: provenance({
        provider: "wikimedia-commons",
        licence: "unknown",
      }),
    });
    expect(mayPersistMedia(unknownLicence)).toBe("denied");
  });

  /**
   * Open-Meteo: cacheable and displayable, never persisted, never exported.
   *
   * Two independent reasons — the data is perishable, and the free tier is non-commercial only.
   */
  it("keeps Open-Meteo forecasts to display only", () => {
    const forecast = fact({
      kind: "weather-forecast",
      value: "18°C",
      provider: "open-meteo",
      subjectAt: NOW,
    });

    expect(mayCache("open-meteo")).toBe("granted");
    expect(mayDisplayFact(forecast, { surface: "in-app", now: NOW })).toBe(
      "granted",
    );
    expect(mayPersistFact(forecast)).toBe("denied");
    expect(mayExportFact(forecast)).toBe("denied");
    expect(persistenceRefusalReason(forecast)).toContain("perishable");
  });

  /** An exported document has no live attribution surface and no way to withdraw the data later. */
  it("refuses proprietary and unlicensed facts in an exported document", () => {
    const proprietary = fact({ kind: "opening-hours", provider: "foursquare" });

    expect(
      mayDisplayFact(proprietary, { surface: "exported-document", now: NOW }),
    ).toBe("denied");
  });

  /** Google's own policy requires Places results to display on a Google Map. Roamly renders OpenFreeMap. */
  it("refuses Google content on Roamly's map", () => {
    expect(
      mayDisplayFact(fact({ kind: "address", provider: "google-places" }), {
        surface: "map",
        now: NOW,
      }),
    ).toBe("denied");

    expect(
      mayDisplayFact(fact({ kind: "address", provider: "openstreetmap" }), {
        surface: "map",
        now: NOW,
      }),
    ).toBe("granted");
  });
});

describe("the export and import boundary", () => {
  const exportable = fact({
    kind: "inception-year",
    value: 1893,
    provider: "wikidata",
  });
  const forecast = fact({
    kind: "weather-forecast",
    value: "18°C",
    provider: "open-meteo",
    subjectAt: NOW,
  });

  /** Stripped, not refused: the traveller asked for their trip, and the trip is exportable. */
  it("strips prohibited enrichment from an export", () => {
    const stripped = stripAllForExport([
      sidecar({
        identities: [identity()],
        facts: [exportable, forecast],
        media: [media()],
      }),
    ]);

    expect(stripped).toHaveLength(1);
    expect(stripped[0].facts.map((entry) => entry.kind)).toEqual([
      "inception-year",
    ]);
    expect(stripped[0].media).toHaveLength(1);
  });

  it("drops a sidecar that has nothing exportable left", () => {
    expect(stripAllForExport([sidecar({ facts: [forecast] })])).toEqual([]);
  });

  /**
   * Refused on import, not cleaned.
   *
   * A file containing an unexportable fact was written by something that did not apply this policy, and quietly cleaning it
   * would hide that — which is also the only way an exporter bug ever gets noticed.
   */
  it("rejects prohibited enrichment on import", () => {
    const rejections = importRejections([
      sidecar({ facts: [exportable, forecast] }),
    ]);

    expect(rejections).toHaveLength(1);
    expect(rejections[0].canonicalPlaceId).toBe("osm:node:1001");
    expect(rejections[0].reason).toContain("perishable");
  });

  it("accepts an import that carries only exportable enrichment", () => {
    expect(importRejections([sidecar({ facts: [exportable] })])).toEqual([]);
  });
});

describe("end to end: a sidecar built, validated and exported", () => {
  /**
   * The whole path in one test, because the per-function assertions above can all pass while the composition is wrong.
   *
   * Merge a mixed bundle → validate at each strictness → strip for export → confirm what survived.
   */
  it("carries an honest subset from merge to export", () => {
    const merged = mergeIntelligence({
      existing: sidecar(),
      identity: identity({ method: "shared-external-id" }),
      facts: [
        fact({ kind: "inception-year", value: 1893, provider: "wikidata" }),
        fact({
          kind: "weather-forecast",
          value: "18°C",
          provider: "open-meteo",
          subjectAt: NOW,
        }),
        /* Refused outright, whoever supplies it. */
        fact({ kind: "rating", value: 4.6, provider: "foursquare" }),
      ],
      media: [media()],
    });

    /* The rating never entered. */
    expect(merged.intelligence.facts.map((entry) => entry.kind).sort()).toEqual([
      "inception-year",
      "weather-forecast",
    ]);

    /* The bundle is internally coherent, and parses. */
    expect(validateIntelligence(merged.intelligence, "structural")).toEqual([]);
    expect(PlaceIntelligenceSchema.safeParse(merged.intelligence).success).toBe(
      true,
    );

    /* Held in memory it is fine; written to the record the forecast is not. */
    const persistIssues = validateIntelligence(merged.intelligence, "persist");
    expect(persistIssues.map((issue) => issue.factKind)).toEqual([
      "weather-forecast",
    ]);
    expect(persistIssues[0].code).toBe("not_persistable");

    /* Stripped for export, only the CC0 fact and the credited photo survive. */
    const [forExport] = stripAllForExport([merged.intelligence]);
    expect(forExport.facts.map((entry) => entry.kind)).toEqual([
      "inception-year",
    ]);
    expect(forExport.media).toHaveLength(1);

    /* And what survived passes the strictest gate, which is the point of stripping. */
    expect(validateIntelligence(forExport, "export")).toEqual([]);
    expect(importRejections([forExport])).toEqual([]);
  });

  it("reports a sidecar whose confidence was asserted rather than derived", () => {
    const handAsserted = sidecar({
      facts: [
        fact({
          kind: "inception-year",
          value: 1893,
          provider: "wikidata",
          confidence: "corroborated",
        }),
      ],
    });

    expect(
      validateIntelligence(handAsserted, "structural").map(
        (issue) => issue.code,
      ),
    ).toContain("confidence_not_derived");
  });

  /**
   * A permission withdrawn after the fact was stored.
   *
   * The recorded policy says persistence was granted; the current table refuses it. That is the case that has to be found
   * rather than trusted, and it is undiscoverable without the snapshot.
   */
  it("reports a fact whose recorded policy exceeds the current one", () => {
    const grandfathered = sidecar({
      facts: [
        fact({
          kind: "opening-hours",
          provenance: provenance({
            provider: "foursquare",
            policy: {
              persistence: "granted",
              display: "granted",
              export: "granted",
              termsReadOn: "2025-01-01",
            },
          }),
        }),
      ],
    });

    expect(
      validateIntelligence(grandfathered, "structural").map(
        (issue) => issue.code,
      ),
    ).toContain("policy_exceeds_current");
  });
});

describe("the existing OSM-only portable trip is unaffected", () => {
  /**
   * The regression that matters most.
   *
   * Checkpoint 5A adds no field to `TripPlace` and no field to the portable wrapper, so a trip exported today must round-trip
   * byte-identically. If this fails, the sidecar has leaked into the canonical record.
   */
  it("round-trips unchanged", () => {
    const record = {
      revision: 3,
      createdAt: "2026-07-27T10:00:00.000Z",
      updatedAt: "2026-07-27T11:00:00.000Z",
      plan: fixtureSavedPlan(),
      generation: FIXTURE_GENERATION,
      history: { past: [], future: [] },
      /* No enrichment, which is the whole point of this case: the sidecar must not touch the canonical record. */
      intelligence: null,
    };

    const exported = exportTrip(record, "2026-07-28T12:00:00.000Z");
    const text = serialiseTrip(exported);
    const parsed = parseImportedTrip(text);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);

    expect(serialiseTrip(parsed.trip)).toBe(text);
    expect(parsed.trip.record.plan).toEqual(exported.record.plan);
  });

  /** No place in the pool carries enrichment, because enrichment does not live on a place. */
  it("carries no enrichment field on any exported place", () => {
    const plan = fixtureSavedPlan();

    for (const day of plan.days) {
      for (const item of day.items) {
        if (!item.place) continue;
        const keys = Object.keys(item.place);
        expect(keys).not.toContain("intelligence");
        expect(keys).not.toContain("facts");
        expect(keys).not.toContain("externalIdentities");
      }
    }
  });
});
