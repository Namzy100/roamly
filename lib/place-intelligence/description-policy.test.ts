import { describe, expect, it } from "vitest";

import { detectConflicts } from "./conflicts";
import {
  mayDisplayFact,
  selectDescription,
  staleLabelIsRequired,
  DESCRIPTION_SOURCE_ORDER,
  STALE_LABELLABLE_FACT_KINDS,
} from "./display-policy";
import {
  factKindIsCorroboratable,
  factKindIsOperational,
  FACT_VOLATILITY,
} from "./facts";
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

/** Years past its check, and still almost certainly true — which is the whole reason the label mode exists. */
const STALE_DESCRIPTION = fact({
  kind: "official-description",
  value: "tower in Paris, France",
  provider: "wikidata",
  provenance: {
    ...WIKIDATA_DESCRIPTION.provenance,
    retrievedAt: "2019-01-01T00:00:00.000Z",
  },
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

  it("selects nothing when the description is stale and no mode was asked for", () => {
    /*
     * The default, pinned deliberately. `"refuse"` is what a caller gets by omission, so a new surface is strict until it
     * says otherwise — the permissive path has to be visible at the call site.
     */
    expect(selectDescription([STALE_DESCRIPTION], shown)).toBeNull();
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

/**
 * Staleness as a label rather than a refusal — the one exception in the directory.
 *
 * A description 40 days past its check is almost certainly still true, so refusing it removes correct information in
 * exchange for nothing. Every test below guards one edge of the exception, because an opt-in that leaks is worse than no
 * opt-in: it would make the permissive path the accidental default for kinds that must never take it.
 */
describe("a stale description may be labelled instead of refused", () => {
  const labelled = {
    surface: "in-app" as const,
    now: NOW,
    staleness: "label" as const,
  };

  it("selects the stale description and reports that a label is required", () => {
    expect(selectDescription([STALE_DESCRIPTION], labelled)).toBe(
      STALE_DESCRIPTION,
    );
    expect(staleLabelIsRequired(STALE_DESCRIPTION, labelled)).toBe(true);
  });

  it("requires no label for a description that is not stale", () => {
    expect(selectDescription([WIKIDATA_DESCRIPTION], labelled)).toBe(
      WIKIDATA_DESCRIPTION,
    );
    expect(staleLabelIsRequired(WIKIDATA_DESCRIPTION, labelled)).toBe(false);
  });

  it("requires no label under the default mode, because nothing stale was shown", () => {
    /* `false` here is not "it is fresh" — it is "a stale fact never reached a screen to be labelled". */
    expect(staleLabelIsRequired(STALE_DESCRIPTION, { now: NOW })).toBe(false);
  });

  it("still refuses a stale fact of any other kind under the same mode", () => {
    /*
     * The reason the mode is applied per *kind* inside the module rather than per call site: a surface opting in for its
     * description passes the same option to every fact it renders, and a stale phone number shown as current sends
     * somebody to a disconnected line.
     */
    const stalePhone = fact({
      kind: "phone",
      value: "+351 21 810 0340",
      provider: "wikidata",
      provenance: {
        ...WIKIDATA_DESCRIPTION.provenance,
        retrievedAt: "2019-01-01T00:00:00.000Z",
      },
    });

    expect(STALE_LABELLABLE_FACT_KINDS.has("phone")).toBe(false);
    expect(mayDisplayFact(stalePhone, labelled)).toBe("denied");
    expect(staleLabelIsRequired(stalePhone, labelled)).toBe(false);
  });

  it("only ever admits durable kinds, so no mode can label a perishable one", () => {
    /*
     * Membership is asserted rather than assumed. Labelling a forecast "not checked recently" still presents it as
     * describing now, and `factIsExpired` — which no mode softens — is what actually governs it.
     */
    for (const kind of STALE_LABELLABLE_FACT_KINDS) {
      expect(FACT_VOLATILITY[kind], kind).toBe("durable");
    }
  });

  it("does not let the label mode resurrect an expired description", () => {
    /*
     * Expiry and staleness are separate questions and only one has an exception. A `validUntil` in the past is a hard
     * end: there is no caveat that makes a sentence about a demolished building useful.
     */
    const expired = fact({
      kind: "official-description",
      value: "tower in Paris, France",
      provider: "wikidata",
      validUntil: "2026-01-01T00:00:00.000Z",
    });

    expect(mayDisplayFact(expired, labelled)).toBe("denied");
    expect(selectDescription([expired], labelled)).toBeNull();
  });
});
