import type { IsoTimestamp, ProviderId } from "./types";

/**
 * A provider's own name for a place Roamly already knows.
 *
 * ## The direction of the arrow is the whole design
 *
 * Roamly's canonical identity is OSM's — `osm:node:123`, reconstructible from `osmType` + `osmId`, and
 * asserted by pool validation. An external identity is a *pointer out*, never a pointer in. Nothing
 * here may become the primary key, and no place may enter the pool because a provider named it.
 *
 * That is not a stylistic preference. `assertItineraryUsesPool` is the invariant the whole application
 * rests on: every place in the itinerary traces back to one recorded search. A provider id promoted to
 * canonical would let a place into a trip whose evidence was a third-party lookup nobody stored — and
 * for Google specifically the place id is the *only* thing that may legally be persisted, so a
 * canonical identity built on it would be a trip whose places cannot be re-described at all.
 *
 * Foursquare's `Place Match` and `Place Resolve` endpoints exist for exactly this shape: hand them a
 * place you already have, get back their identifier for it. The architecture matches the API rather
 * than fighting it.
 *
 * ## Why the match is a record and not a boolean
 *
 * A match can be wrong. Two cafés on one street, a venue that moved, a chain with forty branches — the
 * failure mode is not "no match found", it is "matched to the wrong place", and that failure attaches a
 * stranger's opening hours to a stop the traveller is standing outside. So the match records *how* it
 * was made and *how sure* it is, and `merge.ts` refuses to attach facts across a weak one.
 */

/**
 * How the link between Roamly's place and the provider's was established.
 *
 * Ordered by how much it can be trusted, and the order matters — `MATCH_METHOD_RANK` turns it into the
 * gate `merge.ts` applies.
 *
 *  - `shared-external-id` — both records already carry the same third-party id, typically a `wikidata`
 *    tag present on the OSM place and on the provider's record. Not a guess at all: two sources
 *    independently pointing at one entity.
 *  - `provider-match-endpoint` — the provider was asked to resolve our place and answered. Trustworthy
 *    because they did the reconciliation with data we do not have.
 *  - `name-and-proximity` — we compared a name and a distance ourselves. A heuristic, and the one that
 *    produces the wrong-branch failure.
 *  - `manual` — a person decided. Trusted absolutely, and recorded so it is never silently recomputed.
 */
export type MatchMethod =
  | "shared-external-id"
  | "provider-match-endpoint"
  | "name-and-proximity"
  | "manual";

const MATCH_METHOD_RANK: Record<MatchMethod, number> = {
  manual: 3,
  "shared-external-id": 3,
  "provider-match-endpoint": 2,
  "name-and-proximity": 1,
};

/**
 * The minimum a match must reach before any fact may be attached across it.
 *
 * Set above `name-and-proximity` deliberately. A name-and-distance match is good enough to *offer* to a
 * person for confirmation and not good enough to silently import opening hours — and since the point of
 * enrichment is facts a traveller will act on, the bar sits where being wrong is merely unhelpful
 * rather than misleading.
 */
export const MINIMUM_TRUSTED_MATCH_RANK = 2;

export type ExternalIdentity = {
  provider: ProviderId;
  /** The provider's identifier, verbatim. Never parsed, never used as Roamly's own key. */
  externalId: string;
  /** Roamly's canonical id this points *out from*. The arrow's tail, recorded so it cannot invert. */
  canonicalPlaceId: string;
  method: MatchMethod;
  matchedAt: IsoTimestamp;
  /**
   * Why this match was believed, for a human reviewing a bad one.
   *
   * A sentence, not a score. When a traveller reports the wrong opening hours the useful question is
   * "how did these two get linked", and `0.87` does not answer it.
   */
  evidence?: string;
};

/** Whether facts may be attached across this match, or whether it needs confirming first. */
export function matchIsTrusted(identity: ExternalIdentity): boolean {
  return MATCH_METHOD_RANK[identity.method] >= MINIMUM_TRUSTED_MATCH_RANK;
}

/** The rank of a method, for callers that need to order candidates rather than gate one. */
export function matchMethodRank(method: MatchMethod): number {
  return MATCH_METHOD_RANK[method];
}
