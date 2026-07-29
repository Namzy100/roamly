import { describe, expect, it } from "vitest";

import type {
  LandmarkCardIntelligence,
  LandmarkCardPhoto,
} from "@/lib/place-intelligence";

import {
  LANDMARK_CONTEXT_LABEL,
  LANDMARK_STALE_NOTE,
  PROVIDER_DISPLAY_NAMES,
  describeLandmarkContext,
  externalHref,
} from "./landmark-context";

/**
 * What a card puts on screen, and what it may not.
 *
 * The derivation is tested next to itself in `lib/place-intelligence/landmark-card.test.ts` — which facts survive
 * the gates, which photograph is chosen, whether a stale description is labelled. What is tested here is the layer
 * above: whether the credit rows a licence obliges actually exist, whether a licence identifier survives being
 * rendered, and whether a region with nothing in it renders nothing at all rather than an empty shell.
 */

const PHOTO: LandmarkCardPhoto = {
  url: "https://upload.wikimedia.org/example.jpg",
  altText: "The tiled façade of the museum, seen from the street.",
  creator: "A. Photographer",
  /* Deliberately 3.0: a 2007 photograph is not under the licence Commons offers today. */
  licence: "CC-BY-SA-3.0",
  licenceUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
  credit: "Photo by A. Photographer, CC BY-SA 3.0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
  transformationPermitted: true,
};

function card(
  overrides: Partial<LandmarkCardIntelligence> = {},
): LandmarkCardIntelligence {
  const base: LandmarkCardIntelligence = {
    hasContext: true,
    description: {
      text: "tile museum in Lisbon, Portugal",
      provider: "wikidata",
      stale: false,
    },
    photo: PHOTO,
    facts: [
      {
        kind: "inception-year",
        label: "Dates from",
        value: "1509",
        provider: "wikidata",
        confidence: "reported",
      },
    ],
    attributions: ["Photo by A. Photographer, CC BY-SA 3.0"],
  };

  return { ...base, ...overrides };
}

describe("whether the region renders at all", () => {
  /** The one condition, read from the field that exists for it. */
  it("renders nothing when the card has no context", () => {
    const view = describeLandmarkContext({
      hasContext: false,
      description: null,
      photo: null,
      facts: [],
      attributions: [],
    });

    expect(view).toBeNull();
  });

  it("renders the region under its fixed label when there is something to show", () => {
    const view = describeLandmarkContext(card());

    expect(view?.label).toBe(LANDMARK_CONTEXT_LABEL);
    expect(LANDMARK_CONTEXT_LABEL).toBe("Factual context");
  });

  /**
   * No empty media shell.
   *
   * A card with a description and no photograph must produce `photo: null`, so the component has nothing to build a
   * fixed-ratio box around. A reserved empty frame reads as an image that failed to load.
   */
  it("carries no photograph when none was permitted", () => {
    const view = describeLandmarkContext(card({ photo: null }));

    expect(view?.photo).toBeNull();
    expect(view?.disclosure).toEqual([]);
  });

  it("renders a photograph-only card without a description row", () => {
    const view = describeLandmarkContext(card({ description: null, facts: [] }));

    expect(view?.description).toBeNull();
    expect(view?.facts).toEqual([]);
    expect(view?.photo).not.toBeNull();
  });
});

describe("the description", () => {
  it("shows a fresh description with no caveat beside it", () => {
    const view = describeLandmarkContext(card());

    expect(view?.description).toEqual({
      text: "tile museum in Lisbon, Portugal",
      staleNote: null,
    });
  });

  it("labels a stale description without casting doubt on the source", () => {
    const view = describeLandmarkContext(
      card({
        description: {
          text: "tile museum in Lisbon, Portugal",
          provider: "wikidata",
          stale: true,
        },
      }),
    );

    expect(view?.description?.staleNote).toBe(LANDMARK_STALE_NOTE);
    /* The note is about when Roamly last asked, not about whether Wikidata is right. */
    const note = LANDMARK_STALE_NOTE.toLowerCase();
    expect(note).not.toContain("wrong");
    expect(note).not.toContain("out of date");
    expect(note).not.toContain("unverified");
  });

  it("passes the stored sentence through without rewriting it", () => {
    const text = "Baroque palace commissioned in 1747 for the royal household";
    const view = describeLandmarkContext(
      card({ description: { text, provider: "wikidata", stale: false } }),
    );

    expect(view?.description?.text).toBe(text);
  });
});

describe("the facts", () => {
  it("renders Dates from when the derivation supplied it", () => {
    const view = describeLandmarkContext(card());

    expect(view?.facts).toEqual([{ label: "Dates from", value: "1509" }]);
  });

  /**
   * A contested date never arrives here — `mayDisplayFact` refuses it — so the region simply has no row. This pins
   * that the composition adds nothing of its own when the list is empty.
   */
  it("renders no date row when the date was refused upstream", () => {
    const view = describeLandmarkContext(card({ facts: [] }));

    expect(view?.facts).toEqual([]);
  });

  it("carries no empty rows", () => {
    const view = describeLandmarkContext(
      card({
        facts: [
          {
            kind: "heritage-status",
            label: "Heritage status",
            value: "National Monument",
            provider: "wikidata",
            confidence: "corroborated",
          },
        ],
      }),
    );

    for (const fact of view?.facts ?? []) {
      expect(fact.label.length).toBeGreaterThan(0);
      expect(fact.value.length).toBeGreaterThan(0);
    }
  });

  /** The gate inputs stay out of the view: a traveller reads a label and a value, not a confidence. */
  it("exposes only what is read, not how it was judged", () => {
    const view = describeLandmarkContext(card());

    expect(Object.keys(view?.facts[0] ?? {}).sort()).toEqual(["label", "value"]);
  });
});

describe("the visible source line", () => {
  it("names both projects and the photograph's exact licence", () => {
    const view = describeLandmarkContext(card());

    expect(view?.sourceLine).toBe(
      "Wikidata · Wikimedia Commons · CC-BY-SA-3.0",
    );
    expect(view?.sources).toEqual(["Wikidata", "Wikimedia Commons"]);
  });

  /** The version is the part that says what a reuser may do, so it is never softened to "Creative Commons". */
  it("preserves the historical licence identifier verbatim", () => {
    const view = describeLandmarkContext(card());

    expect(view?.sourceLine).toContain("CC-BY-SA-3.0");
    expect(view?.sourceLine).not.toContain("Creative Commons");
    expect(view?.sourceLine).not.toContain("CC-BY-SA-4.0");
  });

  /** Naming Commons for a photograph that was refused claims a use that did not happen. */
  it("does not name Wikimedia Commons when no photograph rendered", () => {
    const view = describeLandmarkContext(card({ photo: null }));

    expect(view?.sourceLine).toBe("Wikidata");
    expect(view?.sources).toEqual(["Wikidata"]);
  });

  it("names Wikidata from the facts when there is no description", () => {
    const view = describeLandmarkContext(
      card({ description: null, photo: null }),
    );

    expect(view?.sources).toEqual(["Wikidata"]);
  });

  it("names each project once, however many items came from it", () => {
    const view = describeLandmarkContext(
      card({
        facts: [
          {
            kind: "inception-year",
            label: "Dates from",
            value: "1509",
            provider: "wikidata",
            confidence: "reported",
          },
          {
            kind: "heritage-status",
            label: "Heritage status",
            value: "National Monument",
            provider: "wikidata",
            confidence: "reported",
          },
        ],
      }),
    );

    expect(view?.sources).toEqual(["Wikidata", "Wikimedia Commons"]);
  });

  /**
   * A provider must never reach a card as its own identifier.
   *
   * Compared against the id rather than screened for punctuation: "Open-Meteo" is the project's own spelling, so a
   * blanket ban on hyphens would fail an honest name. What matters is that no label *is* the enum key.
   */
  it("gives every provider in the enum a name of its own", () => {
    for (const [id, name] of Object.entries(PROVIDER_DISPLAY_NAMES)) {
      expect(name.length, id).toBeGreaterThan(2);
      expect(name, id).not.toBe(id);
      expect(name, id).not.toContain("_");
    }
  });
});

describe("the attribution disclosure", () => {
  it("credits the creator, the exact licence, the file page and the source", () => {
    const view = describeLandmarkContext(card());

    expect(view?.disclosure).toEqual([
      { label: "Creator", value: "A. Photographer", href: null },
      {
        label: "Licence",
        value: "CC-BY-SA-3.0",
        href: "https://creativecommons.org/licenses/by-sa/3.0/",
      },
      {
        label: "File",
        value: "Wikimedia Commons file page",
        href: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      },
      {
        label: "Credit",
        value: "Photo by A. Photographer, CC BY-SA 3.0",
        href: null,
      },
      { label: "Source", value: "Wikimedia Commons", href: null },
    ]);
  });

  /** Rows are omitted rather than blanked: "Creator: —" is a claim that nobody is credited. */
  it("omits a row Commons did not supply", () => {
    const view = describeLandmarkContext(
      card({
        photo: { ...PHOTO, creator: null, credit: null, sourceUrl: null },
      }),
    );

    expect(view?.disclosure.map((row) => row.label)).toEqual([
      "Licence",
      "Source",
    ]);
    for (const row of view?.disclosure ?? []) {
      expect(row.value.trim().length).toBeGreaterThan(0);
    }
  });

  /**
   * The licence row survives a missing URL.
   *
   * `CC-BY-SA-3.0` is still the terms even when the link to them is absent, and dropping the row to avoid an
   * unlinked value would drop the obligation with it.
   */
  it("keeps the licence row when its URL is absent", () => {
    const view = describeLandmarkContext(
      card({ photo: { ...PHOTO, licenceUrl: null } }),
    );

    const licence = view?.disclosure.find((row) => row.label === "Licence");
    expect(licence).toEqual({
      label: "Licence",
      value: "CC-BY-SA-3.0",
      href: null,
    });
  });

  it("passes the credit line through exactly as the file asks", () => {
    const credit = "Foto: J. Müller / Wikimedia Commons / CC BY-SA 3.0 DE";
    const view = describeLandmarkContext(card({ photo: { ...PHOTO, credit } }));

    expect(view?.disclosure.find((row) => row.label === "Credit")?.value).toBe(
      credit,
    );
  });

  it("carries the derivation's own attribution list unchanged", () => {
    const view = describeLandmarkContext(card());

    expect(view?.attributions).toEqual([
      "Photo by A. Photographer, CC BY-SA 3.0",
    ]);
  });

  it("attributes nothing when nothing rendered", () => {
    const view = describeLandmarkContext(
      card({ photo: null, attributions: [] }),
    );

    expect(view?.attributions).toEqual([]);
  });
});

describe("links fit to be rendered", () => {
  it("accepts an ordinary https URL", () => {
    expect(externalHref("https://commons.wikimedia.org/wiki/File:A.jpg")).toBe(
      "https://commons.wikimedia.org/wiki/File:A.jpg",
    );
  });

  it("accepts http, because some licence deeds are still served over it", () => {
    expect(externalHref("http://creativecommons.org/licenses/by-sa/2.0/")).toBe(
      "http://creativecommons.org/licenses/by-sa/2.0/",
    );
  });

  /** The one that matters: a stored string becoming an `href` is where a scheme would be executed. */
  it("refuses every scheme that is not http or https", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(externalHref(hostile), hostile).toBeNull();
    }
  });

  it("refuses anything that is not a URL at all", () => {
    for (const value of [
      "",
      "   ",
      "not a url",
      "/relative/path",
      "//host/path",
      null,
      undefined,
    ]) {
      expect(externalHref(value), String(value)).toBeNull();
    }
  });

  it("keeps a hostile licence URL out of the disclosure without losing the licence", () => {
    const view = describeLandmarkContext(
      card({ photo: { ...PHOTO, licenceUrl: "javascript:alert(1)" } }),
    );

    const licence = view?.disclosure.find((row) => row.label === "Licence");
    expect(licence?.value).toBe("CC-BY-SA-3.0");
    expect(licence?.href).toBeNull();
  });

  it("drops a file-page row whose URL cannot be trusted", () => {
    const view = describeLandmarkContext(
      card({ photo: { ...PHOTO, sourceUrl: "javascript:alert(1)" } }),
    );

    expect(view?.disclosure.map((row) => row.label)).not.toContain("File");
  });

  it("links only to values it was given", () => {
    const view = describeLandmarkContext(card());

    for (const row of view?.disclosure ?? []) {
      if (row.href === null) continue;
      expect(row.href).toMatch(/^https?:\/\//);
    }
  });
});

describe("what a card never shows", () => {
  /**
   * The exclusions this checkpoint is emphatic about. None of these exist on `LandmarkCardIntelligence`, so the
   * assertion is really about the composition not inventing them — a "popularity" line derived from a fact count,
   * for instance, would be a ranking signal assembled out of nothing.
   */
  it("produces no rating, review count, popularity or recommendation", () => {
    const view = describeLandmarkContext(card());
    const text = JSON.stringify(view).toLowerCase();

    for (const forbidden of [
      "rating",
      "review",
      "popular",
      "crowd",
      "price level",
      "booking",
      "must-see",
      "must see",
      "hidden gem",
      "recommend",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("adds no prose of its own around the stored text", () => {
    const view = describeLandmarkContext(card());

    /* The description is the stored sentence and nothing else — no lead-in, no flourish. */
    expect(view?.description?.text).toBe("tile museum in Lisbon, Portugal");
  });
});
