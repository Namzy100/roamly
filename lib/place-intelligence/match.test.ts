import { describe, expect, it } from "vitest";

import { matchIsTrusted } from "./external-identity";
import {
  identityFromProposal,
  proposeMatch,
  MATCH_RADIUS_METERS,
  SHARED_ID_REVIEW_RADIUS_METERS,
  type CanonicalSubject,
  type MatchCandidate,
} from "./match";
import { NOW } from "./test-fixtures";

/**
 * Matching, tested against the failure it exists to prevent.
 *
 * That failure is **not** "no match found" — an empty sidecar is harmless, the trip still works. It is "matched to the wrong
 * branch of a chain", which silently attaches a different building's opening hours to a stop the traveller is standing
 * outside. Every case below is either a route to a correct match, or a demonstration that a plausible-looking wrong one is
 * refused or sent to review.
 *
 * The evidence rule under test: **coordinates within the radius, plus at least one corroborating attribute** — with a shared
 * third-party id as the one exception, because that is two sources asserting the same entity rather than a guess.
 */

const SUBJECT: CanonicalSubject = {
  canonicalPlaceId: "osm:node:1001",
  name: "Fábrica Coffee",
  address: "R. das Portas de Santo Antão 136",
  phone: "+351 21 324 0100",
  websiteDomain: "fabricacoffeeroasters.com",
};

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    provider: "foursquare",
    externalId: "fsq-abc",
    name: "Fábrica Coffee",
    distanceMeters: 40,
    ...overrides,
  };
}

describe("evidence routes that accept", () => {
  it("accepts coordinates plus a normalized name", () => {
    const outcome = proposeMatch({
      subject: {
        canonicalPlaceId: SUBJECT.canonicalPlaceId,
        name: SUBJECT.name,
      },
      candidates: [candidate()],
    });

    expect(outcome.status).toBe("needs-review");
    if (outcome.status === "rejected") throw new Error(outcome.reason);
    expect(outcome.proposal.attributes).toEqual(["normalized-name"]);
  });

  it("accepts coordinates plus an address", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [
        candidate({ name: "Fabrica Coffee Roasters", address: SUBJECT.address }),
      ],
    });

    if (outcome.status === "rejected") throw new Error(outcome.reason);
    expect(outcome.proposal.attributes).toContain("address");
  });

  it("accepts coordinates plus a phone number", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [
        candidate({ name: "Something Else", phone: "00351213240100" }),
      ],
    });

    if (outcome.status === "rejected") throw new Error(outcome.reason);
    expect(outcome.proposal.attributes).toEqual(["phone"]);
  });

  it("accepts coordinates plus a website domain", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [
        candidate({
          name: "Something Else",
          websiteDomain: "www.fabricacoffeeroasters.com",
        }),
      ],
    });

    if (outcome.status === "rejected") throw new Error(outcome.reason);
    expect(outcome.proposal.attributes).toEqual(["website-domain"]);
  });

  /** Accent folding, because "Fábrica" and "Fabrica" are one café spelled two ways. */
  it("folds accents and case when comparing names", () => {
    const outcome = proposeMatch({
      subject: { canonicalPlaceId: "osm:node:1", name: "Fábrica Coffee" },
      candidates: [candidate({ name: "fabrica coffee" })],
    });

    expect(outcome.status).not.toBe("rejected");
  });

  /**
   * A shared third-party id is identity, and needs no coordinates at all.
   *
   * Two sources independently asserting the same Wikidata entity is stronger evidence than anything proximity provides.
   */
  it("accepts a shared external id without coordinates, and trusts it", () => {
    const outcome = proposeMatch({
      subject: { ...SUBJECT, sharedExternalId: "Q999" },
      candidates: [
        candidate({
          name: "Totally Different Name",
          distanceMeters: null,
          sharedExternalId: "Q999",
        }),
      ],
    });

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") throw new Error("unreachable");
    expect(outcome.proposal.method).toBe("shared-external-id");
    expect(outcome.proposal.trusted).toBe(true);
  });

  /** The provider did the reconciliation with data we do not have, so it clears the trust bar. */
  it("trusts the provider's own match endpoint", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate({ name: "Unrecognisable" })],
      providerAnsweredMatch: true,
    });

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") throw new Error("unreachable");
    expect(outcome.proposal.method).toBe("provider-match-endpoint");
    expect(outcome.proposal.trusted).toBe(true);
  });
});

describe("evidence routes that refuse", () => {
  /**
   * A name is not evidence of identity.
   *
   * "Café Central" names four hundred cafés. Without coordinates there is nothing tying this record to this place.
   */
  it("rejects a name-only match", () => {
    const outcome = proposeMatch({
      subject: { canonicalPlaceId: "osm:node:1", name: "Fábrica Coffee" },
      candidates: [candidate({ distanceMeters: null })],
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("name alone");
  });

  /**
   * A category adds nothing a name did not already have.
   *
   * There is deliberately no `category` field on a candidate: it cannot corroborate identity, so offering it as evidence
   * would be offering a way to build a match out of two things that are not evidence. An adapter passing one through finds
   * it ignored.
   */
  it("rejects category-plus-name by having no category evidence at all", () => {
    const outcome = proposeMatch({
      subject: { canonicalPlaceId: "osm:node:1", name: "Fábrica Coffee" },
      candidates: [
        { ...candidate({ distanceMeters: null }), category: "cafe" } as MatchCandidate,
      ],
    });

    expect(outcome.status).toBe("rejected");
  });

  it("rejects a distant same-name candidate", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate({ distanceMeters: 4_000 })],
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("different branch");
  });

  /** Being in the same doorway is not identity if nothing else agrees. */
  it("rejects proximity with no corroborating attribute", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate({ name: "A Completely Different Shop" })],
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("unreachable");
    expect(outcome.reason).toContain("Proximity alone");
  });

  it("rejects when there are no candidates at all", () => {
    expect(proposeMatch({ subject: SUBJECT, candidates: [] }).status).toBe(
      "rejected",
    );
  });
});

describe("the coordinate threshold", () => {
  /** Inclusive at the boundary, so the answer never depends on a rounding decision. */
  it("is deterministic and inclusive at exactly the radius", () => {
    const at = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate({ distanceMeters: MATCH_RADIUS_METERS })],
    });
    const beyond = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate({ distanceMeters: MATCH_RADIUS_METERS + 1 })],
    });

    expect(at.status).not.toBe("rejected");
    expect(beyond.status).toBe("rejected");
  });

  it("refuses a negative or non-finite distance", () => {
    for (const distanceMeters of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        proposeMatch({
          subject: SUBJECT,
          candidates: [candidate({ distanceMeters })],
        }).status,
      ).toBe("rejected");
    }
  });

  /** A shared id at an implausible distance is a data problem, not a match. */
  it("sends an implausibly distant shared-id match to review", () => {
    const outcome = proposeMatch({
      subject: { ...SUBJECT, sharedExternalId: "Q999" },
      candidates: [
        candidate({
          sharedExternalId: "Q999",
          distanceMeters: SHARED_ID_REVIEW_RADIUS_METERS + 1,
        }),
      ],
    });

    expect(outcome.status).toBe("needs-review");
  });
});

describe("ambiguity and contradiction go to review", () => {
  /**
   * Two branches of one chain, both agreeing on the name.
   *
   * The nearer one is not more likely to be right — it is just nearer. Resolving by distance here is exactly the silent wrong
   * answer this module exists to avoid.
   */
  it("sends same-name branch locations to review rather than picking one", () => {
    const outcome = proposeMatch({
      subject: { canonicalPlaceId: "osm:node:1", name: "Fábrica Coffee" },
      candidates: [
        candidate({ externalId: "fsq-a", distanceMeters: 30 }),
        candidate({ externalId: "fsq-b", distanceMeters: 90 }),
      ],
    });

    expect(outcome.status).toBe("needs-review");
    if (outcome.status !== "needs-review") throw new Error("unreachable");
    expect(outcome.reason).toContain("two branches");
  });

  it("sends a contradictory external identity to review", () => {
    const outcome = proposeMatch({
      subject: { ...SUBJECT, sharedExternalId: "Q111" },
      candidates: [candidate({ sharedExternalId: "Q222" })],
    });

    expect(outcome.status).toBe("needs-review");
    if (outcome.status !== "needs-review") throw new Error("unreachable");
    expect(outcome.reason).toContain("different external identities");
  });

  /**
   * One provider record cannot describe two places.
   *
   * If its id is already attached elsewhere, either that match or this one is wrong, and guessing which would corrupt
   * whichever it picked.
   */
  it("refuses to attach one external id to a second canonical place automatically", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate()],
      claimedExternalIds: new Map([["foursquare:fsq-abc", "osm:node:2002"]]),
    });

    expect(outcome.status).toBe("needs-review");
    if (outcome.status !== "needs-review") throw new Error("unreachable");
    expect(outcome.reason).toContain("cannot describe two places");
  });

  it("allows re-matching the same place to the id it already holds", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate()],
      claimedExternalIds: new Map([
        ["foursquare:fsq-abc", SUBJECT.canonicalPlaceId],
      ]),
      providerAnsweredMatch: true,
    });

    expect(outcome.status).toBe("matched");
  });
});

describe("determinism", () => {
  /** Two runs over the same candidates in a different order must agree, or "deterministic" is folklore. */
  it("does not depend on candidate input order", () => {
    const candidates = [
      candidate({ externalId: "fsq-far", distanceMeters: 100 }),
      candidate({ externalId: "fsq-near", distanceMeters: 20 }),
    ];

    const forward = proposeMatch({
      subject: SUBJECT,
      candidates,
      providerAnsweredMatch: true,
    });
    const reversed = proposeMatch({
      subject: SUBJECT,
      candidates: [...candidates].reverse(),
      providerAnsweredMatch: true,
    });

    expect(forward).toEqual(reversed);
    if (forward.status !== "matched") throw new Error("unreachable");
    expect(forward.proposal.candidate.externalId).toBe("fsq-near");
  });

  /** Evidence is reported in the fixed `MATCH_ATTRIBUTES` order, not in discovery order. */
  it("reports agreeing attributes in a fixed order", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [
        candidate({
          address: SUBJECT.address,
          phone: SUBJECT.phone,
          websiteDomain: SUBJECT.websiteDomain,
        }),
      ],
    });

    if (outcome.status === "rejected") throw new Error(outcome.reason);
    expect(outcome.proposal.attributes).toEqual([
      "normalized-name",
      "address",
      "phone",
      "website-domain",
    ]);
  });

  /**
   * No floating confidence score exists anywhere in the output.
   *
   * A similarity number invites a threshold, a threshold invites tuning, and a tuned threshold is a claim about how often we
   * are wrong that nobody measured. This asserts the shape rather than trusting the comment.
   */
  it("exposes no numeric confidence score", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate()],
    });

    if (outcome.status === "rejected") throw new Error(outcome.reason);

    const keys = Object.keys(outcome.proposal);
    for (const forbidden of [
      "score",
      "confidence",
      "probability",
      "similarity",
      "weight",
    ]) {
      expect(keys).not.toContain(forbidden);
    }

    /* `trusted` is a boolean, not a threshold on a hidden number. */
    expect(typeof outcome.proposal.trusted).toBe("boolean");
  });
});

describe("turning a proposal into a stored identity", () => {
  it("keeps the proposal's method when nobody confirmed", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate()],
    });
    if (outcome.status === "rejected") throw new Error(outcome.reason);

    const stored = identityFromProposal({
      proposal: outcome.proposal,
      canonicalPlaceId: SUBJECT.canonicalPlaceId,
      matchedAt: NOW,
    });

    expect(stored.method).toBe("name-and-proximity");
    expect(matchIsTrusted(stored)).toBe(false);
  });

  /** A person's decision is recorded as `manual`, so it is never silently recomputed. */
  it("upgrades a confirmed proposal to a trusted manual match", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate()],
    });
    if (outcome.status === "rejected") throw new Error(outcome.reason);

    const stored = identityFromProposal({
      proposal: outcome.proposal,
      canonicalPlaceId: SUBJECT.canonicalPlaceId,
      matchedAt: NOW,
      confirmedByPerson: true,
    });

    expect(stored.method).toBe("manual");
    expect(matchIsTrusted(stored)).toBe(true);
    expect(stored.evidence).toContain("Confirmed by the traveller");
  });

  it("records the canonical place the identity points out from", () => {
    const outcome = proposeMatch({
      subject: SUBJECT,
      candidates: [candidate()],
      providerAnsweredMatch: true,
    });
    if (outcome.status === "rejected") throw new Error(outcome.reason);

    expect(
      identityFromProposal({
        proposal: outcome.proposal,
        canonicalPlaceId: SUBJECT.canonicalPlaceId,
        matchedAt: NOW,
      }).canonicalPlaceId,
    ).toBe("osm:node:1001");
  });
});
