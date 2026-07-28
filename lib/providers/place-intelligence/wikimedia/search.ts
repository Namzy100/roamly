import "server-only";

import {
  evaluateWikidataCandidate,
  toleranceMetersFor,
  type MatchMethod,
  type WikidataCandidate,
} from "@/lib/place-intelligence";
import { haversineMeters } from "@/lib/routing";
import type { TripPlace } from "@/lib/schemas";

import { readCache, writeCache, writeEmptyCache } from "./cache";
import { fetchWikimedia } from "./client";
import { WIKIMEDIA_LIMITS } from "./config";
import { DEFAULT_ENTITY_LANGUAGE } from "./entity";
import { normalizeLanguage, normalizeNearbyCandidate } from "./normalize";
import { parseNearbyResponse } from "./schemas";

/**
 * The last rung of the identity ladder: which Wikidata entities are near this place.
 *
 * ## Every input is derived from the canonical place
 *
 * There is no radius argument, no query argument and no coordinate argument. The coordinate is
 * `place.coordinates`, the radius is `toleranceMetersFor(place.category)`, the result cap is
 * `WIKIMEDIA_LIMITS.maxSearchResults`, and the query text is a private template in `client.ts` interpolated only with
 * numbers. So "no caller query fragments" and "no user-provided SPARQL" are not rules this module follows — they are
 * statements about its signature. A caller wanting a wider search would have to change a place's category, which is
 * OSM's data rather than a parameter.
 *
 * One place per call, for the same reason. A `wikibase:around` query over two centres would return a merged set with
 * no field saying which centre each row came from, and assigning them afterwards would be the matching problem this
 * whole directory exists to avoid.
 *
 * ## What "accepted" means here, and what it does not
 *
 * `evaluateWikidataCandidate` labels every geographic match `name-and-proximity`, which ranks **1** — below
 * `MINIMUM_TRUSTED_MATCH_RANK`. So an `accepted` outcome from this module is an accepted *identity*, and
 * `mergeIntelligence` will still refuse every fact across it until a person confirms the match. That is the agreed
 * design rather than an oversight: the failure a nearby match produces is the wrong building, and it is invisible
 * until somebody is standing outside it.
 *
 * The orchestrator reports such a place as `review`. This module keeps the matcher's own vocabulary — accepted,
 * review, rejected — because translating it here would hide which of the two reasons a place ended up in review.
 *
 * ## The ordering is ours, not the query's
 *
 * `ORDER BY ?distance ?item` already makes WDQS deterministic, and the candidates are re-sorted anyway by a distance
 * this module computes with `haversineMeters` and then by QID. Two reasons: the query does not *select* `?distance`,
 * so nothing in the response would let a reader verify the order; and a cached candidate list must sort identically
 * to a fresh one, which it cannot if the order came from a service under load.
 */

export type NearbyOutcome =
  | {
      /** Accepted as an identity. Not yet trusted enough for facts — see the module note. */
      status: "accepted";
      qid: string;
      method: MatchMethod;
      evidence: string;
      candidate: WikidataCandidate;
      cacheHit: boolean;
    }
  | {
      status: "review";
      qid: string;
      method: MatchMethod;
      evidence: string;
      reason: string;
      candidate: WikidataCandidate;
      cacheHit: boolean;
    }
  | { status: "rejected"; reason: string; cacheHit: boolean };

export async function searchNearby(input: {
  place: TripPlace;
  /** The canonical id this place is known by, so a shared-entity collision can name the holder. */
  canonicalPlaceId: string;
  /**
   * QIDs already attached to another place in this run, mapped to that place's id.
   *
   * Threaded through to `evaluateWikidataCandidate`, which sends a collision to review rather than refusing it: one
   * entity legitimately can describe two OSM records when both are part of one geographic feature, and that is a
   * judgement about the data rather than something to infer. The map is the orchestrator's, accumulated as it goes,
   * which is what makes "one entity cannot auto-attach to two places" hold across a whole trip rather than within a
   * single call.
   */
  claimedQids?: ReadonlyMap<string, string>;
  language?: string;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<NearbyOutcome> {
  const { place } = input;
  const language = normalizeLanguage(input.language) ?? DEFAULT_ENTITY_LANGUAGE;
  const radiusMeters = toleranceMetersFor(place.category);
  const limit = WIKIMEDIA_LIMITS.maxSearchResults;

  const key = {
    lat: place.coordinates.lat,
    lng: place.coordinates.lng,
    radiusMeters,
    limit,
    language,
  };

  const cached = readCache<WikidataCandidate[]>("wd-nearby", key);
  const candidates =
    cached ??
    (await fetchCandidates({
      place,
      radiusMeters,
      limit,
      language,
      key,
      signal: input.signal,
      requestId: input.requestId,
    }));

  const cacheHit = cached !== undefined;

  /*
   * Matching runs on every call, cache hit or not.
   *
   * This is what "the cache never bypasses matching" means concretely: what is stored is the candidate *list*, so a
   * second place at the same coordinates is judged against its own name, its own category tolerance and the current
   * `claimedQids` map. Caching the outcome would serve one place's match to another.
   */
  return match({ ...input, candidates, cacheHit });
}

async function fetchCandidates(input: {
  place: TripPlace;
  radiusMeters: number;
  limit: number;
  language: string;
  key: Record<string, unknown>;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<WikidataCandidate[]> {
  const payload = await fetchWikimedia(
    {
      kind: "nearby",
      lat: input.place.coordinates.lat,
      lng: input.place.coordinates.lng,
      radiusMeters: input.radiusMeters,
      limit: input.limit,
      language: input.language,
    },
    { signal: input.signal, requestId: input.requestId },
  );

  const bundle = parseNearbyResponse(payload);

  const candidates: WikidataCandidate[] = [];
  for (const binding of bundle.bindings) {
    const candidate = normalizeNearbyCandidate(binding);
    /* A row with no item URI or no coordinate is dropped individually — it could not be judged anyway. */
    if (candidate) candidates.push(candidate);
  }

  const ordered = orderByDistance(candidates, input.place);

  if (ordered.length === 0) {
    /* "Nothing within the tolerance" is a real answer, and the one most likely to change as coverage grows. */
    writeEmptyCache("wd-nearby", input.key, ordered);
  } else {
    writeCache("wd-nearby", input.key, ordered);
  }

  return ordered;
}

/**
 * Nearest first, ties broken by QID.
 *
 * Total, so the same response always produces the same order — the property that makes a cached list and a fresh one
 * interchangeable, and makes a test about "which candidate won" mean something. The tie-break is the one
 * `selectLandmarkCandidates` uses for the same reason.
 */
function orderByDistance(
  candidates: WikidataCandidate[],
  place: TripPlace,
): WikidataCandidate[] {
  const from = {
    latitude: place.coordinates.lat,
    longitude: place.coordinates.lng,
  };

  return [...candidates].sort((a, b) => {
    const distanceA = a.coordinates
      ? haversineMeters(from, {
          latitude: a.coordinates.lat,
          longitude: a.coordinates.lng,
        })
      : Number.POSITIVE_INFINITY;
    const distanceB = b.coordinates
      ? haversineMeters(from, {
          latitude: b.coordinates.lat,
          longitude: b.coordinates.lng,
        })
      : Number.POSITIVE_INFINITY;

    if (distanceA !== distanceB) return distanceA - distanceB;
    return a.qid < b.qid ? -1 : a.qid > b.qid ? 1 : 0;
  });
}

/**
 * The first candidate the matcher accepts, or the best refusal.
 *
 * Walks the ordered list and stops at the first `matched` — nearest wins, which is what the ordering is for. A
 * `needs-review` is remembered rather than returned immediately, because a match further down the list is strictly
 * better than a review nearer the top: the review arm exists for evidence that is real and insufficient, and
 * insufficient evidence should not pre-empt sufficient evidence.
 *
 * Branch rejection needs no code here. `evaluateWikidataCandidate` refuses an outlet from the *place's* own name
 * before it looks at any candidate, so a place called "… (Baixa branch)" is rejected identically by every candidate
 * and the first refusal reason says so.
 */
function match(input: {
  place: TripPlace;
  canonicalPlaceId: string;
  claimedQids?: ReadonlyMap<string, string>;
  candidates: WikidataCandidate[];
  cacheHit: boolean;
}): NearbyOutcome {
  const { cacheHit } = input;

  if (input.candidates.length === 0) {
    return {
      status: "rejected",
      reason: `No Wikidata entity within ${toleranceMetersFor(
        input.place.category,
      )} m carried a coordinate to compare.`,
      cacheHit,
    };
  }

  let review: NearbyOutcome | null = null;
  let firstRefusal: string | null = null;

  for (const candidate of input.candidates) {
    const outcome = evaluateWikidataCandidate({
      place: input.place,
      candidate,
      claimedQids: input.claimedQids,
      canonicalPlaceId: input.canonicalPlaceId,
    });

    if (outcome.status === "matched") {
      return {
        status: "accepted",
        qid: outcome.qid,
        method: outcome.method,
        evidence: outcome.evidence,
        candidate,
        cacheHit,
      };
    }

    if (outcome.status === "needs-review" && review === null) {
      review = {
        status: "review",
        qid: outcome.qid,
        method: outcome.method,
        evidence: outcome.evidence,
        reason: outcome.reason,
        candidate,
        cacheHit,
      };
      continue;
    }

    if (outcome.status === "rejected" && firstRefusal === null) {
      firstRefusal = outcome.reason;
    }
  }

  if (review) return review;

  return {
    status: "rejected",
    reason:
      firstRefusal ??
      "No candidate near this place agreed on a name, an alias or an address.",
    cacheHit,
  };
}
