import { describe, expect, it } from "vitest";

import { fixtureOsmPlace } from "@/lib/generate/test-fixtures";
import type { PlaceCategory, TripPlace } from "@/lib/schemas";

import type { PlaceIntelligence } from "./canonical";
import {
  deriveLandmarkCardIntelligence,
  LANDMARK_CARD_FACT_KINDS,
} from "./landmark-card";
import {
  fact,
  identity,
  media,
  provenance,
  sidecar,
  NOW,
} from "./test-fixtures";

/**
 * The card derivation, tested as a display gate rather than as a formatter.
 *
 * The failures worth pinning are all the same shape: something reaches the screen that may not be there. An unlicensed
 * photograph, a stale fact shown as current, a nearby match's facts presented as this place's history, one landmark's
 * dates under another's name. Each has its own case below, and each asserts *absence* — which is the assertion a
 * component-level test could not make, because the repository has no jsdom.
 *
 * The formatting assertions are deliberately few. There is one transformation in the module (a negative year) and one
 * decision that could silently drift (which photograph, when two are displayable), so those are pinned and everything
 * else passes through verbatim by construction.
 */

const MUSEUM = fixtureOsmPlace(
  "2001",
  "Museu do Azulejo",
  "museum",
  38.7248,
  -9.115,
);

/** The trusted Wikidata identity every displaying sidecar needs. */
const TRUSTED = identity({
  method: "shared-external-id",
  canonicalPlaceId: MUSEUM.placeId,
});

function landmarkSidecar(
  overrides: Partial<PlaceIntelligence> = {},
): PlaceIntelligence {
  return sidecar({
    canonicalPlaceId: MUSEUM.placeId,
    identities: [TRUSTED],
    ...overrides,
  });
}

const DESCRIPTION = fact({
  kind: "official-description",
  value: "tile museum in Lisbon, Portugal",
  provider: "wikidata",
});

const INCEPTION = fact({
  kind: "inception-year",
  value: 1509,
  provider: "wikidata",
});

const HERITAGE = fact({
  kind: "heritage-status",
  value: "National Monument; UNESCO tentative list",
  provider: "wikidata",
});

function derive(
  place: TripPlace,
  intelligence?: PlaceIntelligence | null,
  now: string = NOW,
) {
  return deriveLandmarkCardIntelligence({ place, intelligence, now });
}

describe("the ordinary case", () => {
  it("shows the description, both landmark facts and the photograph", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({
        facts: [DESCRIPTION, INCEPTION, HERITAGE],
        media: [media()],
      }),
    );

    expect(result.hasContext).toBe(true);
    expect(result.description).toEqual({
      text: "tile museum in Lisbon, Portugal",
      provider: "wikidata",
    });
    expect(result.facts.map((row) => row.kind)).toEqual([
      "inception-year",
      "heritage-status",
    ]);
    expect(result.facts.map((row) => row.value)).toEqual([
      "1509",
      "National Monument; UNESCO tentative list",
    ]);
    expect(result.photo?.url).toBe("https://upload.wikimedia.org/example.jpg");
  });

  it("renders the facts in the declared order, not the sidecar's", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [HERITAGE, INCEPTION] }),
    );

    expect(result.facts.map((row) => row.kind)).toEqual([
      ...LANDMARK_CARD_FACT_KINDS,
    ]);
  });

  it("labels a date without claiming more than the stored value supports", () => {
    const result = derive(MUSEUM, landmarkSidecar({ facts: [INCEPTION] }));

    /*
     * "Dates from", never "Founded", "Built" or "Opened". The stored fact is a bare year; which Wikidata property it
     * came from was not persisted, so a card cannot distinguish a founding from an opening and must not imply it can.
     */
    expect(result.facts[0].label).toBe("Dates from");
    expect(result.facts[0].label).not.toMatch(/founded|built|opened/i);
  });
});

describe("nothing to show", () => {
  it("returns no context when there is no sidecar", () => {
    expect(derive(MUSEUM, null).hasContext).toBe(false);
    expect(derive(MUSEUM, undefined).hasContext).toBe(false);
  });

  it("returns no context for an empty sidecar, so no panel renders over nothing", () => {
    const result = derive(MUSEUM, landmarkSidecar());

    expect(result.hasContext).toBe(false);
    expect(result.description).toBeNull();
    expect(result.photo).toBeNull();
    expect(result.facts).toEqual([]);
    expect(result.attributions).toEqual([]);
  });

  it("refuses a sidecar keyed to a different place", () => {
    const other = fixtureOsmPlace("2002", "MAAT", "museum", 38.6957, -9.1936);

    /*
     * The worst failure available to a card: one landmark's dates and photograph rendered under another landmark's
     * name, with every licence gate satisfied and nothing on screen to indicate it is wrong.
     */
    const result = derive(
      other,
      landmarkSidecar({ facts: [DESCRIPTION, INCEPTION] }),
    );

    expect(result.hasContext).toBe(false);
  });
});

describe("the identity gate", () => {
  it("shows nothing across a name-and-proximity match", () => {
    /*
     * The rank-2 trust gate, applied at the display surface as well as in the merge. A nearby match is stored as
     * `review` precisely so a person can confirm it; rendering its facts would treat an unconfirmed guess as this
     * place's history.
     */
    const result = derive(
      MUSEUM,
      landmarkSidecar({
        identities: [
          identity({
            method: "name-and-proximity",
            canonicalPlaceId: MUSEUM.placeId,
          }),
        ],
        facts: [DESCRIPTION, INCEPTION],
        media: [media()],
      }),
    );

    expect(result.hasContext).toBe(false);
  });

  it("shows nothing when no Wikidata identity is recorded", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({ identities: [], facts: [DESCRIPTION] }),
    );

    expect(result.hasContext).toBe(false);
  });

  it("admits a provider-match-endpoint match, which clears the same bar", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({
        identities: [
          identity({
            method: "provider-match-endpoint",
            canonicalPlaceId: MUSEUM.placeId,
          }),
        ],
        facts: [INCEPTION],
      }),
    );

    expect(result.hasContext).toBe(true);
  });

  it("returns no context for a review-only sidecar, which carries an identity and no facts", () => {
    const result = derive(MUSEUM, landmarkSidecar({ facts: [], media: [] }));

    expect(result.hasContext).toBe(false);
  });
});

describe("eligibility is re-checked at the display surface", () => {
  it("shows nothing for a commercial place, whatever is attached to it", () => {
    const cafe = fixtureOsmPlace(
      "1001",
      "Fábrica Coffee",
      "cafe",
      38.7169,
      -9.1409,
    );

    /*
     * A café was never an eligible candidate, so a sidecar attached to one did not arrive by a path this checkpoint
     * permits. Refusing here means the eligibility policy cannot be bypassed by writing to the store directly.
     */
    const result = derive(
      cafe,
      sidecar({
        canonicalPlaceId: cafe.placeId,
        identities: [identity({ canonicalPlaceId: cafe.placeId })],
        facts: [DESCRIPTION, INCEPTION],
      }),
    );

    expect(result.hasContext).toBe(false);
  });

  it("admits every category the landmark policy admits", () => {
    const eligible: PlaceCategory[] = [
      "museum",
      "gallery",
      "monument",
      "historic_site",
      "attraction",
      "viewpoint",
      "park",
      "garden",
      "beach",
      "place_of_worship",
      "theatre",
    ];

    for (const category of eligible) {
      const place = fixtureOsmPlace(
        "3001",
        "Somewhere Notable",
        category,
        38.7,
        -9.1,
      );
      const result = derive(
        place,
        sidecar({
          canonicalPlaceId: place.placeId,
          identities: [identity({ canonicalPlaceId: place.placeId })],
          facts: [INCEPTION],
        }),
      );

      expect(result.hasContext, category).toBe(true);
    }
  });
});

describe("the display gates each fact passes", () => {
  it("drops a fact whose recorded policy denied display", () => {
    const denied = fact({
      kind: "inception-year",
      value: 1509,
      provenance: provenance({
        provider: "wikidata",
        policy: {
          persistence: "granted",
          display: "denied",
          export: "granted",
          termsReadOn: "2026-07-28",
        },
      }),
    });

    const result = derive(MUSEUM, landmarkSidecar({ facts: [denied] }));

    expect(result.facts).toEqual([]);
    expect(result.hasContext).toBe(false);
  });

  it("drops a stale fact rather than presenting it as current", () => {
    /* A year past the retrieval date. `factIsUsable` is the gate; this asserts the card honours it. */
    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [DESCRIPTION, INCEPTION] }),
      "2027-07-28T12:00:00.000Z",
    );

    expect(result.facts).toEqual([]);
    expect(result.description).toBeNull();
    expect(result.hasContext).toBe(false);
  });

  it("omits a contested date rather than choosing between the sources", () => {
    const otherYear = fact({
      kind: "inception-year",
      value: 1512,
      provider: "mock",
    });

    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [INCEPTION, otherYear, HERITAGE] }),
    );

    /*
     * No winner, no average, and no "sources disagree" banner either. A traveller cannot act on a contested founding
     * date, so the honest card omits the row — where contested *opening hours* are exactly what a banner is for.
     */
    expect(result.facts.map((row) => row.kind)).toEqual(["heritage-status"]);
  });

  it("selects one description and never composes two", () => {
    const other = fact({
      kind: "official-description",
      value: "museum of azulejo tilework",
      provider: "mock",
    });

    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [DESCRIPTION, other] }),
    );

    /* `DESCRIPTION_SOURCE_ORDER` holds Wikidata alone, so the other source is never selected. */
    expect(result.description?.provider).toBe("wikidata");
    expect(result.description?.text).toBe("tile museum in Lisbon, Portugal");
  });
});

describe("the photograph", () => {
  it("refuses one with no alternative text", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [INCEPTION], media: [media({ altText: "" })] }),
    );

    expect(result.photo).toBeNull();
    /* The facts still render — one refused image does not suppress the rest of the card. */
    expect(result.hasContext).toBe(true);
  });

  it("refuses one whose licence cannot be established", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({
        media: [media({ provenance: provenance({ licence: "unknown" }) })],
      }),
    );

    expect(result.photo).toBeNull();
  });

  it("picks the same one every time when two are displayable", () => {
    const first = media({ id: "wikimedia-commons:File:A.jpg" });
    const second = media({ id: "wikimedia-commons:File:B.jpg" });

    const forwards = derive(
      MUSEUM,
      landmarkSidecar({ media: [first, second] }),
    );
    const backwards = derive(
      MUSEUM,
      landmarkSidecar({ media: [second, first] }),
    );

    expect(forwards.photo).toEqual(backwards.photo);
  });

  it("carries the credit fields the licence obliges", () => {
    const result = derive(MUSEUM, landmarkSidecar({ media: [media()] }));

    expect(result.photo).toEqual({
      url: "https://upload.wikimedia.org/example.jpg",
      altText: "The tiled façade of the museum, seen from the street.",
      creator: "A. Photographer",
      licence: "CC-BY-SA-4.0",
      licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      credit: "Photo by A. Photographer, CC BY-SA 4.0",
      transformationPermitted: true,
    });
  });
});

describe("attribution follows what actually rendered", () => {
  it("credits the photographer when the photograph is shown", () => {
    const result = derive(MUSEUM, landmarkSidecar({ media: [media()] }));

    expect(result.attributions).toContain(
      "Photo by A. Photographer, CC BY-SA 4.0",
    );
  });

  it("does not credit a photograph that was refused", () => {
    /*
     * The direction that is easy to get wrong. Crediting a file Roamly is not showing asserts a use that did not
     * happen, and it is invisible in a screenshot because the credit line itself looks correct.
     */
    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [INCEPTION], media: [media({ altText: "" })] }),
    );

    expect(result.photo).toBeNull();
    expect(result.attributions).toEqual([]);
  });

  it("requires nothing for Wikidata facts alone, because CC0 obliges nothing", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({ facts: [DESCRIPTION, INCEPTION, HERITAGE] }),
    );

    expect(result.hasContext).toBe(true);
    expect(result.attributions).toEqual([]);
  });
});

describe("value rendering", () => {
  it("renders an ancient date as BC rather than a minus sign", () => {
    const result = derive(
      MUSEUM,
      landmarkSidecar({
        facts: [
          fact({ kind: "inception-year", value: -525, provider: "wikidata" }),
        ],
      }),
    );

    expect(result.facts[0].value).toBe("525 BC");
  });

  it("passes a joined heritage value through without re-splitting it", () => {
    const result = derive(MUSEUM, landmarkSidecar({ facts: [HERITAGE] }));

    expect(result.facts[0].value).toBe(
      "National Monument; UNESCO tentative list",
    );
  });
});
