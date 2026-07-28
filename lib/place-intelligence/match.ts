import {
  matchMethodRank,
  MINIMUM_TRUSTED_MATCH_RANK,
  type ExternalIdentity,
  type MatchMethod,
} from "./external-identity";
import type { IsoTimestamp, ProviderId } from "./types";

/**
 * Deciding that a provider's record and Roamly's place are the same place.
 *
 * ## Pure, and no network
 *
 * This takes candidates somebody else fetched and decides among them. It calls nothing — the same split
 * `lib/generate/candidates.ts` uses, and for the same reason: the decision has a right answer a unit test can pin down,
 * and burying it in a client would make it testable only through a fixture server.
 *
 * ## There is no score, and that is load-bearing
 *
 * No number between 0 and 1 exists anywhere in this module's output. A similarity score invites a threshold, a threshold
 * invites tuning, and a tuned threshold is a claim about how often we are wrong that nobody measured.
 *
 * What decides a match is **which kinds of evidence agree**, which is a fact rather than a judgement. The rule:
 *
 *  > **Coordinates within `MATCH_RADIUS_METERS`, plus at least one corroborating attribute.**
 *
 * A name on its own is never enough — not with a category beside it, not with anything. "Café Central" is the name of
 * four hundred cafés, and the failure a name-only match produces is not "no match found" (harmless: the sidecar stays
 * empty and the trip works) but "matched to the wrong branch", which attaches a different building's opening hours to a
 * stop the traveller is standing outside.
 *
 * The one exception is a **shared third-party id** — typically a Wikidata QID present on both records. That is not a
 * guess at all: two independent sources asserting the same entity. It stands without the coordinate gate, though a
 * shared id at an implausible distance still goes to review rather than through.
 *
 * ## Ambiguity is review, not a coin flip
 *
 * Two candidates matching equally well is the branch-location case. Picking the nearer one would be exactly the silent
 * wrong answer this module exists to avoid, so it returns `needs-review` and the facts stay out until a person says
 * which. Every rule below fails towards the empty sidecar.
 */

/**
 * How close two records must be before a match may be proposed on attribute evidence.
 *
 * 120 m is chosen to be defensible rather than tuned: roughly a city block, which is the distance within which two
 * records of the same name are plausibly one place with imprecise coordinates, and beyond which they are plausibly two
 * branches. The boundary is inclusive — see `coordinatesAgree`.
 */
export const MATCH_RADIUS_METERS = 120;

/**
 * How far a shared-id match may be before it goes to review instead.
 *
 * Ten times the attribute radius. A shared QID at 1.2 km is more likely a Wikidata entity covering a whole district, or
 * a provider record pointing at a head office, than a coordinate error — and either way not something to import opening
 * hours across without a person looking.
 */
export const SHARED_ID_REVIEW_RADIUS_METERS = MATCH_RADIUS_METERS * 10;

/** The attributes that can corroborate a coordinate match, in the fixed order evidence is reported. */
export const MATCH_ATTRIBUTES = [
  "normalized-name",
  "address",
  "phone",
  "website-domain",
] as const;

export type MatchAttribute = (typeof MATCH_ATTRIBUTES)[number];

/**
 * Roamly's own place, reduced to what a decision needs.
 *
 * Projected from `TripPlace` by the caller rather than taken whole, which keeps this module independent of the
 * verified-place schema and makes every test case a three-line literal.
 */
export type CanonicalSubject = {
  canonicalPlaceId: string;
  name: string;
  address?: string;
  phone?: string;
  /** Host only, lower-cased — `example.com`, not `https://www.example.com/menu`. */
  websiteDomain?: string;
  /** A third-party id on Roamly's own place, typically an OSM `wikidata` tag. */
  sharedExternalId?: string;
};

/**
 * A provider record offered for matching.
 *
 * Deliberately not the provider's response shape. An adapter projects into this, which keeps the raw payload out of the
 * decision — and out of anything that could later be persisted.
 */
export type MatchCandidate = {
  provider: ProviderId;
  externalId: string;
  name: string;
  /**
   * Straight-line metres from Roamly's place, measured by the caller.
   *
   * `null` means the provider gave no usable coordinates. Explicitly nullable rather than optional, because "we did not
   * measure" and "we measured zero" must not be the same value — a missing distance defaulting to 0 would make every
   * uncoordinated record an exact positional match.
   */
  distanceMeters: number | null;
  address?: string;
  phone?: string;
  websiteDomain?: string;
  sharedExternalId?: string;
};

export type MatchProposal = {
  candidate: MatchCandidate;
  method: MatchMethod;
  /** Which attributes agreed, in `MATCH_ATTRIBUTES` order. Empty for a shared-id match. */
  attributes: MatchAttribute[];
  /** One sentence a human can audit a bad match with. Never a score. */
  evidence: string;
  /** False when the method is below the trust bar and a person must confirm. */
  trusted: boolean;
};

export type MatchOutcome =
  | { status: "matched"; proposal: MatchProposal }
  | { status: "needs-review"; proposal: MatchProposal; reason: string }
  | { status: "rejected"; reason: string };

/* -------------------------------------------------------------------------- */
/* Attribute comparison                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Case- and accent-insensitive name comparison, and nothing fuzzier.
 *
 * `localeCompare` with `sensitivity: "base"` folds accents, which matters for every European destination Roamly targets:
 * "Fábrica Coffee" and "Fabrica Coffee" are one café spelled two ways, and a byte comparison would call them different
 * and leave the sidecar empty for no reason.
 *
 * No edit distance and no token overlap. "Café Lisboa" and "Café Lisboa Centro" stay different places, because merging
 * them is the wrong-branch failure.
 */
function namesAgree(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), "en", { sensitivity: "base" }) === 0;
}

/** Digits only, so `+351 21 123 4567` and `00351211234567` compare equal on the part that identifies a line. */
function phonesAgree(a: string, b: string): boolean {
  const digits = (value: string) => value.replace(/\D/g, "");
  const left = digits(a);
  const right = digits(b);
  if (left.length < 6 || right.length < 6) return false;
  return left.endsWith(right) || right.endsWith(left);
}

/** Punctuation-insensitive, because `R. das Portas 136` and `R das Portas, 136` are one address. */
function addressesAgree(a: string, b: string): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return normalise(a) === normalise(b) && normalise(a).length > 0;
}

function domainsAgree(a: string, b: string): boolean {
  const strip = (value: string) =>
    value.trim().toLowerCase().replace(/^www\./, "");
  return strip(a) === strip(b) && strip(a).length > 0;
}

/** Inclusive at the boundary, so a candidate at exactly the radius is a match rather than a rounding decision. */
function coordinatesAgree(distanceMeters: number | null): boolean {
  if (distanceMeters === null || !Number.isFinite(distanceMeters)) return false;
  return distanceMeters >= 0 && distanceMeters <= MATCH_RADIUS_METERS;
}

/** Which attributes this candidate and this place agree on, in the fixed reporting order. */
export function agreeingAttributes(
  subject: CanonicalSubject,
  candidate: MatchCandidate,
): MatchAttribute[] {
  const agreed: MatchAttribute[] = [];

  if (namesAgree(subject.name, candidate.name)) agreed.push("normalized-name");
  if (
    subject.address !== undefined &&
    candidate.address !== undefined &&
    addressesAgree(subject.address, candidate.address)
  ) {
    agreed.push("address");
  }
  if (
    subject.phone !== undefined &&
    candidate.phone !== undefined &&
    phonesAgree(subject.phone, candidate.phone)
  ) {
    agreed.push("phone");
  }
  if (
    subject.websiteDomain !== undefined &&
    candidate.websiteDomain !== undefined &&
    domainsAgree(subject.websiteDomain, candidate.websiteDomain)
  ) {
    agreed.push("website-domain");
  }

  return agreed;
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The outcome for one place against one provider's candidates.
 *
 * `claimedExternalIds` maps `provider:externalId` to the canonical place already holding it. A candidate whose id is
 * claimed by a *different* place goes to review rather than through: one provider record cannot describe two places, so
 * either this match or the existing one is wrong, and guessing which would corrupt whichever it picked.
 *
 * `providerAnsweredMatch` says these candidates came from a reconciliation endpoint rather than a plain search. The
 * caller knows which endpoint it called; this module cannot tell from the data, and guessing would silently upgrade a
 * search hit to a reconciliation.
 */
export function proposeMatch(input: {
  subject: CanonicalSubject;
  candidates: MatchCandidate[];
  providerAnsweredMatch?: boolean;
  claimedExternalIds?: ReadonlyMap<string, string>;
}): MatchOutcome {
  const ordered = orderCandidates(input.candidates);

  /* -- a shared third-party id is identity, not a guess --------------------- */

  if (input.subject.sharedExternalId) {
    const shared = ordered.find(
      (candidate) =>
        candidate.sharedExternalId === input.subject.sharedExternalId,
    );

    if (shared) {
      const claim = claimConflict(shared, input);
      if (claim) return claim;

      const proposal = build(
        shared,
        "shared-external-id",
        [],
        `Both records carry the external id ${input.subject.sharedExternalId}.`,
      );

      if (
        shared.distanceMeters !== null &&
        shared.distanceMeters > SHARED_ID_REVIEW_RADIUS_METERS
      ) {
        return {
          status: "needs-review",
          proposal,
          reason: `The shared id agrees but the records are ${Math.round(shared.distanceMeters)} m apart, which is too far to accept without a person looking.`,
        };
      }

      return { status: "matched", proposal };
    }

    /*
     * A candidate asserting a *different* third-party id is a contradiction, not a weak match.
     *
     * Both records claim to be a named entity and they name different ones. That is worth a person's attention rather
     * than a rejection, because one of the two ids is probably wrong and finding out which is useful.
     */
    const contradicting = ordered.find(
      (candidate) =>
        candidate.sharedExternalId !== undefined &&
        candidate.sharedExternalId !== input.subject.sharedExternalId,
    );

    if (contradicting) {
      return {
        status: "needs-review",
        proposal: build(
          contradicting,
          "name-and-proximity",
          agreeingAttributes(input.subject, contradicting),
          `This place claims external id ${input.subject.sharedExternalId} and the candidate claims ${contradicting.sharedExternalId}. They cannot both be right.`,
        ),
        reason: "The two records assert different external identities.",
      };
    }
  }

  /* -- coordinates are mandatory for every other route --------------------- */

  const nearby = ordered.filter((candidate) =>
    coordinatesAgree(candidate.distanceMeters),
  );

  if (nearby.length === 0) {
    const namedButFar = ordered.find((candidate) =>
      namesAgree(input.subject.name, candidate.name),
    );

    if (namedButFar) {
      return {
        status: "rejected",
        reason:
          namedButFar.distanceMeters === null
            ? "A candidate shares the name but has no usable coordinates. A name alone is not evidence of identity."
            : `The closest same-name candidate is ${Math.round(namedButFar.distanceMeters)} m away, beyond the ${MATCH_RADIUS_METERS} m radius. Probably a different branch.`,
      };
    }

    return {
      status: "rejected",
      reason: `No candidate is within ${MATCH_RADIUS_METERS} m.`,
    };
  }

  /* -- the provider's own reconciliation ----------------------------------- */

  if (input.providerAnsweredMatch) {
    const answered = nearby[0];
    const claim = claimConflict(answered, input);
    if (claim) return claim;

    return {
      status: "matched",
      proposal: build(
        answered,
        "provider-match-endpoint",
        agreeingAttributes(input.subject, answered),
        `The provider's own match endpoint resolved this place to ${answered.externalId}, ${Math.round(answered.distanceMeters ?? 0)} m away.`,
      ),
    };
  }

  /* -- coordinates plus at least one corroborating attribute --------------- */

  const corroborated = nearby
    .map((candidate) => ({
      candidate,
      attributes: agreeingAttributes(input.subject, candidate),
    }))
    .filter((entry) => entry.attributes.length > 0);

  if (corroborated.length === 0) {
    return {
      status: "rejected",
      reason: `A candidate is within ${MATCH_RADIUS_METERS} m but nothing else agrees — no name, address, phone or website in common. Proximity alone is not identity.`,
    };
  }

  const best = corroborated[0];
  const proposal = build(
    best.candidate,
    "name-and-proximity",
    best.attributes,
    `${describeAttributes(best.attributes)} agree, within ${Math.round(best.candidate.distanceMeters ?? 0)} m in a straight line. Not confirmed.`,
  );

  const claim = claimConflict(best.candidate, input);
  if (claim) return claim;

  /*
   * Two candidates corroborating equally well is the branch-location case.
   *
   * Returned as review rather than resolved by distance: two branches of one chain a hundred metres apart both agree on
   * the name, and the nearer one is not more likely to be the right one — it is just nearer.
   */
  if (corroborated.length > 1) {
    return {
      status: "needs-review",
      proposal,
      reason: `${corroborated.length} candidates agree equally well. This is likely two branches of one business, so nothing is attached until a person chooses.`,
    };
  }

  return { status: "needs-review", proposal, reason: proposal.evidence };
}

/** Distance ascending, then `externalId`. Total and stable, so evidence order never depends on input order. */
function orderCandidates(candidates: MatchCandidate[]): MatchCandidate[] {
  return [...candidates].sort((a, b) => {
    const left = a.distanceMeters ?? Number.POSITIVE_INFINITY;
    const right = b.distanceMeters ?? Number.POSITIVE_INFINITY;

    if (Number.isFinite(left) && Number.isFinite(right)) {
      const byDistance = left - right;
      if (Math.round(byDistance) !== 0) return byDistance;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }

    return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
  });
}

function claimConflict(
  candidate: MatchCandidate,
  input: {
    subject: CanonicalSubject;
    claimedExternalIds?: ReadonlyMap<string, string>;
  },
): Extract<MatchOutcome, { status: "needs-review" }> | null {
  const holder = input.claimedExternalIds?.get(
    `${candidate.provider}:${candidate.externalId}`,
  );
  if (holder === undefined) return null;
  if (holder === input.subject.canonicalPlaceId) return null;

  return {
    status: "needs-review",
    proposal: build(
      candidate,
      "name-and-proximity",
      agreeingAttributes(input.subject, candidate),
      `${candidate.provider} id ${candidate.externalId} is already attached to ${holder}.`,
    ),
    reason:
      "One provider record cannot describe two places, so either this match or the existing one is wrong.",
  };
}

function build(
  candidate: MatchCandidate,
  method: MatchMethod,
  attributes: MatchAttribute[],
  evidence: string,
): MatchProposal {
  return {
    candidate,
    method,
    attributes,
    evidence,
    trusted: matchMethodRank(method) >= MINIMUM_TRUSTED_MATCH_RANK,
  };
}

function describeAttributes(attributes: MatchAttribute[]): string {
  const words: Record<MatchAttribute, string> = {
    "normalized-name": "Name",
    address: "address",
    phone: "phone",
    "website-domain": "website",
  };
  const listed = attributes.map((attribute) => words[attribute]);
  if (listed.length === 1) return listed[0];
  return `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}`;
}

/** A confirmed proposal, as the identity to store. The only way one should be constructed. */
export function identityFromProposal(input: {
  proposal: MatchProposal;
  canonicalPlaceId: string;
  matchedAt: IsoTimestamp;
  /** True when a person confirmed, which upgrades the method and the trust with it. */
  confirmedByPerson?: boolean;
}): ExternalIdentity {
  const method: MatchMethod = input.confirmedByPerson
    ? "manual"
    : input.proposal.method;

  return {
    provider: input.proposal.candidate.provider,
    externalId: input.proposal.candidate.externalId,
    canonicalPlaceId: input.canonicalPlaceId,
    method,
    matchedAt: input.matchedAt,
    evidence: input.confirmedByPerson
      ? `Confirmed by the traveller. ${input.proposal.evidence}`
      : input.proposal.evidence,
  };
}
