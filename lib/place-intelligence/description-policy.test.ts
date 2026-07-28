import { describe, expect, it } from "vitest";

import { detectConflicts } from "./conflicts";
import { selectDescription, DESCRIPTION_SOURCE_ORDER } from "./display-policy";
import { factKindIsCorroboratable, factKindIsOperational } from "./facts";
import { mergeIntelligence } from "./merge";
import { fact, identity, sidecar, NOW } from "./test-fixtures";

/**
 * The description policy, which is the one fact kind that behaves unlike every other.
 *
 * Two sources describing a place differently are **both right**. That single property breaks the two mechanisms every
 * other kind relies on, and each break has to be closed separately:
 *
 *  - **conflict detection** would raise a "sources disagree, check before relying on it" banner over wording, warning a
 *    traveller about nothing — so descriptions are not operational
 *  - **confidence derivation** would then promote them to `corroborated`, because `merge.ts` counts providers per kind
 *    and only *operational* kinds are subject to the contest — so descriptions are not corroboratable either
 *
 * Closing only the first is worse than closing neither: it hands out the promotion while removing the check. These tests
 * pin both, and pin that the operational kinds a traveller actually acts on were not caught in the change.
 */

const TRUSTED = identity({ method: "shared-external-id" });

const WIKIDATA_DESCRIPTION = fact({
  kind: "official-description",
  value: "tower in Paris, France",
  provider: "wikidata",
});

/** A second source, worded differently and equally true. `mock` stands in for any future description provider. */
const OTHER_DESCRIPTION = fact({
  kind: "official-description",
  value: "iron lattice tower on the Champ de Mars",
  provider: "mock",
});

describe("two descriptions neither corroborate nor conflict", () => {
  it("keeps both at reported when the wording differs", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [WIKIDATA_DESCRIPTION, OTHER_DESCRIPTION],
    });

    expect(result.intelligence.facts).toHaveLength(2);
    for (const entry of result.intelligence.facts) {
      expect(entry.confidence).toBe("reported");
    }
  });

  it("keeps both at reported even when the wording is identical", () => {
    /*
     * Identical text is weaker evidence than it looks: Wikidata's descriptions are widely mirrored, so two sources
     * matching usually means one copied the other rather than that two independently agreed.
     */
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [
        WIKIDATA_DESCRIPTION,
        fact({
          kind: "official-description",
          value: "tower in Paris, France",
          provider: "mock",
        }),
      ],
    });

    expect(result.intelligence.facts).toHaveLength(2);
    for (const entry of result.intelligence.facts) {
      expect(entry.confidence).toBe("reported");
    }
  });

  it("raises no conflict banner for differing wording", () => {
    const conflicts = detectConflicts("osm:node:1001", [
      WIKIDATA_DESCRIPTION,
      OTHER_DESCRIPTION,
    ]);

    expect(conflicts).toEqual([]);
  });

  it("never merges, averages or concatenates the two values", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [WIKIDATA_DESCRIPTION, OTHER_DESCRIPTION],
    });

    const values = result.intelligence.facts.map((entry) => entry.value);
    expect(values).toContain("tower in Paris, France");
    expect(values).toContain("iron lattice tower on the Champ de Mars");
    /* Two separate facts, each verbatim from its source. No third, composite value exists. */
    expect(values).toHaveLength(2);
  });

  it("records the two as separate facts with distinct ids", () => {
    const result = mergeIntelligence({
      existing: sidecar(),
      identity: TRUSTED,
      facts: [WIKIDATA_DESCRIPTION, OTHER_DESCRIPTION],
    });

    const ids = result.intelligence.facts.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the operational kinds a traveller acts on still conflict", () => {
  /**
   * The regression guard for the change that removed descriptions from the operational set.
   *
   * If a future edit widens that removal, this fails: contested opening hours are the case the banner exists for, and
   * somebody standing at a door needs it.
   */
  it.each([
    ["opening-hours", "Mo-Su 08:00-19:00", "Mo-Su 08:30-18:00"],
    ["business-status", "operational", "closed_temporarily"],
    ["phone", "+351 21 324 0100", "+351 21 324 0199"],
    ["address", "Praça do Império", "Praca do Imperio 12"],
    ["website", "https://example.org/a", "https://example.org/b"],
  ] as const)("reports a conflict for %s", (kind, left, right) => {
    expect(factKindIsOperational(kind)).toBe(true);

    const conflicts = detectConflicts("osm:node:1001", [
      fact({ kind, value: left, provider: "openstreetmap" }),
      fact({ kind, value: right, provider: "wikidata" }),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe(kind);
  });

  it("still corroborates an operational kind two sources agree on", () => {
    /* The other half of the guard: the corroboration exclusion must not have leaked past descriptions. */
    expect(factKindIsCorroboratable("phone")).toBe(true);
    expect(factKindIsCorroboratable("official-description")).toBe(false);

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
          provider: "wikidata",
        }),
      ],
    });

    for (const entry of result.intelligence.facts) {
      expect(entry.confidence).toBe("corroborated");
    }
  });
});

describe("display selection uses an explicit source rule", () => {
  const shown = { surface: "in-app" as const, now: NOW };

  it("selects the Wikidata description", () => {
    const selected = selectDescription([WIKIDATA_DESCRIPTION], shown);
    expect(selected?.value).toBe("tower in Paris, France");
    expect(selected?.provenance.provider).toBe("wikidata");
  });

  it("selects nothing from a source outside the order", () => {
    /* `mock` is not on the list, so its description is never chosen — the list is the whole rule. */
    expect(DESCRIPTION_SOURCE_ORDER).toEqual(["wikidata"]);
    expect(selectDescription([OTHER_DESCRIPTION], shown)).toBeNull();
  });

  it("returns one fact, not a composition, when two are present", () => {
    const selected = selectDescription(
      [OTHER_DESCRIPTION, WIKIDATA_DESCRIPTION],
      shown,
    );

    expect(selected).toBe(WIKIDATA_DESCRIPTION);
  });

  it("selects nothing when the description is stale", () => {
    /* `mayDisplayFact` answers the freshness question; this asserts the selector defers to it. */
    const stale = fact({
      kind: "official-description",
      value: "tower in Paris, France",
      provider: "wikidata",
      provenance: {
        ...WIKIDATA_DESCRIPTION.provenance,
        retrievedAt: "2019-01-01T00:00:00.000Z",
      },
    });

    expect(selectDescription([stale], shown)).toBeNull();
  });

  it("selects nothing when there is no description at all", () => {
    expect(
      selectDescription(
        [fact({ kind: "phone", value: "+351 21 324 0100" })],
        shown,
      ),
    ).toBeNull();
  });
});
