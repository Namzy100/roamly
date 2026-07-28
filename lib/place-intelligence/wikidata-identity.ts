import { haversineMeters } from "@/lib/routing";
import type { PlaceCategory, TripPlace } from "@/lib/schemas";

import type { MatchMethod } from "./external-identity";

/**
 * Deciding which Wikidata entity a landmark is, from evidence rather than from search.
 *
 * ## Enrichment only. The arrow never inverts.
 *
 * OSM's `placeId` stays canonical. Everything here produces a *pointer out* — a QID Roamly may then ask about — and
 * nothing here can put a place into the pool. That is the rule `external-identity.ts` states, restated because this is
 * the module most tempted to break it: a Wikidata entity has coordinates, a name and a category, so it *looks* like
 * something that could be promoted to a place. It cannot.
 *
 * ## The evidence ladder, in the order the checkpoint specifies
 *
 * 1. **OSM `wikidata` tag** — two independent sources naming one entity. Accepted after format validation, with no
 *    coordinate check at all, because the mapper who added the tag was standing there.
 * 2. **OSM `wikipedia` tag** — an identifier only after the official API resolves it. This module produces a
 *    *resolution request*, never a match: a title is a label, it gets renamed, and two languages disagree about what a
 *    place is called.
 * 3. **Geographic search** near the canonical coordinates, then
 * 4. **coordinates plus a normalized name**, then
 * 5. **coordinates plus category or address evidence**.
 *
 * Rungs 3–5 all require coordinates. A name alone is never enough, at any rung.
 *
 * ## Why the tolerance is wider here than for a business, and varies by category
 *
 * `match.ts` uses 120 m for a café, which is right: two same-named cafés 200 m apart are two branches.
 *
 * A landmark is not a point. Wikidata's coordinate for a park is often a centroid while OSM's is a gate; for a monastery
 * it may be the church while OSM tagged the cloister. Applying 120 m here would reject Jerónimos against itself. So the
 * tolerance is per category, and the split is between things that *have* a centre and things that have an extent —
 * a fact about the kind of feature, not a tuning knob.
 *
 * ## No model, no search engine
 *
 * No language model is consulted, and nothing here forms a general web query. The only external calls this module's
 * output can justify are the documented Wikimedia endpoints in `docs/PROVIDER_RESEARCH.md`. This module makes none of
 * them: it is pure, and it decides what a caller is *permitted* to ask.
 */

/**
 * How far a Wikidata coordinate may sit from OSM's for a point-like feature.
 *
 * 250 m. Wider than the 120 m `match.ts` uses for a business, because the two records describe one building from two
 * surveys rather than two shops on one street — an entrance versus a centroid is routinely more than a hundred metres
 * for anything cathedral-sized.
 */
export const LANDMARK_POINT_TOLERANCE_METERS = 250;

/**
 * The same, for a feature with an extent rather than a centre.
 *
 * 1200 m. A city park's centroid and its named entrance are commonly a kilometre apart, and a historic site can span
 * more. This is the number that stops a large feature being rejected against itself; it is not a licence to match
 * loosely, because at this range a *name* is still required and category-only evidence is refused — see
 * `evaluateWikidataCandidate`.
 */
export const LANDMARK_AREA_TOLERANCE_METERS = 1_200;

/** Categories whose coordinate describes an extent rather than a point. */
const AREA_CATEGORIES: ReadonlySet<PlaceCategory> = new Set<PlaceCategory>([
  "park",
  "garden",
  "beach",
  "historic_site",
  "attraction",
]);

export function toleranceMetersFor(category: PlaceCategory): number {
  return AREA_CATEGORIES.has(category)
    ? LANDMARK_AREA_TOLERANCE_METERS
    : LANDMARK_POINT_TOLERANCE_METERS;
}

/* -------------------------------------------------------------------------- */
/* Tag validation                                                             */
/* -------------------------------------------------------------------------- */

const QID_PATTERN = /^Q[1-9]\d*$/;

/**
 * Whether a string is a syntactically valid QID.
 *
 * Exported because it guards a URL. The normalizer already refuses a malformed tag at ingest, and this refuses one again
 * at use — belt and braces on the one field that becomes part of a request path, where `Q0`, `Q 12` or `Jerónimos` would
 * each produce a differently confusing failure.
 */
export function isValidQid(value: string): boolean {
  return QID_PATTERN.test(value);
}

export type WikipediaReference = { lang: string; title: string };

/**
 * OSM's `wikipedia` tag, split into the pieces a resolution request needs.
 *
 * `lang:Title`. Returns `null` for anything else rather than guessing — a bare title with no language prefix could be
 * resolved against any of three hundred Wikipedias, and defaulting to English would silently mis-resolve most of the
 * world.
 *
 * The language is checked against a shape (lower-case letters with optional hyphenated parts, as in `pt`,
 * `zh-min-nan`) rather than against a list of Wikipedias, because that list changes and this module must not hold a
 * stale copy of it. A language that does not exist produces a request that fails, which is the correct outcome and
 * costs one call.
 */
export function parseWikipediaTag(value: string): WikipediaReference | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;

  const lang = value.slice(0, separator).trim().toLowerCase();
  const title = value.slice(separator + 1).trim();

  if (!/^[a-z]{2,12}(-[a-z0-9]{2,12})*$/.test(lang)) return null;
  if (title.length === 0 || title.length > 250) return null;

  return { lang, title };
}

/* -------------------------------------------------------------------------- */
/* What a caller may do next                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The next step for one place, decided from what OSM already carries.
 *
 * Three arms rather than a QID-or-null, because "ask the API to resolve this title" is a genuinely different action from
 * "fetch this entity" and from "search near here" — different endpoint, different cost, different failure.
 *
 * `evidence` is retained on every arm. When a traveller reports a wrong photograph, the useful question is "how did
 * these two get linked", and a boolean cannot answer it.
 */
export type WikidataLookupPlan =
  | {
      kind: "entity";
      qid: string;
      method: Extract<MatchMethod, "shared-external-id">;
      evidence: string;
    }
  | {
      kind: "resolve-wikipedia-title";
      reference: WikipediaReference;
      evidence: string;
    }
  | {
      kind: "search-nearby";
      coordinates: { lat: number; lng: number };
      radiusMeters: number;
      /** The name a candidate must corroborate. Never sent as a search term on its own. */
      name: string;
      evidence: string;
    };

/**
 * What Roamly may ask about this place, from its OSM record alone.
 *
 * Walks the ladder and stops at the first rung that holds. Deliberately returns the *plan* rather than performing it:
 * eligibility, planning and fetching are three decisions, and only the last needs a network.
 *
 * Assumes the place is already eligible — `selectLandmarkCandidates` is the gate for that, and duplicating the check
 * here would give two answers to "may we ask".
 */
export function planWikidataLookup(place: TripPlace): WikidataLookupPlan {
  if (place.wikidataId && isValidQid(place.wikidataId)) {
    return {
      kind: "entity",
      qid: place.wikidataId,
      method: "shared-external-id",
      evidence: `OpenStreetMap tags this place ${place.wikidataId}.`,
    };
  }

  if (place.wikipediaTitle) {
    const reference = parseWikipediaTag(place.wikipediaTitle);
    if (reference) {
      return {
        kind: "resolve-wikipedia-title",
        reference,
        evidence: `OpenStreetMap tags this place with the ${reference.lang} Wikipedia article “${reference.title}”, which must be resolved to an entity before use.`,
      };
    }
  }

  const radiusMeters = toleranceMetersFor(place.category);

  return {
    kind: "search-nearby",
    coordinates: place.coordinates,
    radiusMeters,
    name: place.name,
    evidence: `No Wikidata or Wikipedia tag, so candidates are sought within ${radiusMeters} m and must corroborate the name.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Judging a candidate                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A Wikidata entity offered as a match, reduced to what a decision needs.
 *
 * Projected by the adapter rather than passed whole, which keeps this module independent of Wikidata's response shape and
 * out of the business of parsing SPARQL bindings.
 */
export type WikidataCandidate = {
  qid: string;
  label: string;
  /** Also-known-as labels. Compared, because "Jerónimos Monastery" and "Mosteiro dos Jerónimos" are one place. */
  aliases?: string[];
  coordinates?: { lat: number; lng: number };
  /** The entity's `instance of` labels, for category corroboration. Never used alone. */
  instanceOfLabels?: string[];
  /** Wikidata's own street address, where it has one. */
  address?: string;
};

export type WikidataMatchOutcome =
  | { status: "matched"; qid: string; method: MatchMethod; evidence: string }
  | {
      status: "needs-review";
      qid: string;
      method: MatchMethod;
      evidence: string;
      reason: string;
    }
  | { status: "rejected"; reason: string };

/** Case- and accent-insensitive, and nothing fuzzier. The rule `match.ts` sets out. */
function namesAgree(a: string, b: string): boolean {
  return a.trim().localeCompare(b.trim(), "en", { sensitivity: "base" }) === 0;
}

function anyNameAgrees(place: TripPlace, candidate: WikidataCandidate): boolean {
  if (namesAgree(place.name, candidate.label)) return true;
  return (candidate.aliases ?? []).some((alias) =>
    namesAgree(place.name, alias),
  );
}

function addressesAgree(a: string, b: string): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return normalise(a) === normalise(b) && normalise(a).length > 0;
}

/**
 * Branch-like names, which must never be matched to a single encyclopaedic entity.
 *
 * A place called "… (Baixa branch)" or "… No. 3" is one outlet of something, and Wikidata's entity is the *something*.
 * Attaching the chain's article and photograph to one outlet would show a picture of a different building.
 *
 * Read from the place's own name rather than from the candidate, because it is Roamly's record that tells us this is an
 * outlet. Deliberately narrow: an explicit branch word, or a numbered suffix.
 */
const BRANCH_MARKERS = [
  /\((?:[^)]*\b(?:branch|filial|sucursal|store|loja)\b[^)]*)\)/i,
  /\b(?:branch|filial|sucursal)\s*\d*$/i,
  /\s[—–-]\s*(?:branch|filial|sucursal)\b/i,
  /\bno\.?\s*\d+$/i,
];

export function looksLikeBranch(name: string): boolean {
  return BRANCH_MARKERS.some((pattern) => pattern.test(name.trim()));
}

/**
 * Whether this entity may be attached to this place.
 *
 * `claimedQids` maps a QID to the canonical place already holding it. A candidate claimed by a *different* place goes to
 * review, never through — with one documented nuance, which is why the map holds a place id rather than a boolean: a
 * Wikidata entity legitimately *can* describe two OSM records when both are part of one geographic feature (a park with
 * two tagged entrances). That is a judgement about the data, so it is a person's to make, and review is where it lands.
 *
 * Pure, and total: every candidate reaches exactly one arm.
 */
export function evaluateWikidataCandidate(input: {
  place: TripPlace;
  candidate: WikidataCandidate;
  claimedQids?: ReadonlyMap<string, string>;
  canonicalPlaceId: string;
}): WikidataMatchOutcome {
  const { place, candidate } = input;

  if (!isValidQid(candidate.qid)) {
    return { status: "rejected", reason: `“${candidate.qid}” is not a QID.` };
  }

  /*
   * An outlet is refused before anything else is considered.
   *
   * Not sent to review: there is nothing for a person to decide. The chain's entity is simply not this building, and the
   * correct enrichment for a branch is none.
   */
  if (looksLikeBranch(place.name)) {
    return {
      status: "rejected",
      reason: `“${place.name}” reads as one outlet of a larger business, and an encyclopaedic entity describes the business rather than this building.`,
    };
  }

  const holder = input.claimedQids?.get(candidate.qid);
  if (holder !== undefined && holder !== input.canonicalPlaceId) {
    return {
      status: "needs-review",
      qid: candidate.qid,
      method: "name-and-proximity",
      evidence: `${candidate.qid} is already attached to ${holder}.`,
      reason:
        "One entity can describe two places only when both are part of the same geographic feature, which is a judgement about the data rather than something to infer.",
    };
  }

  /* -- coordinates are mandatory for every non-tag route ------------------- */

  if (!candidate.coordinates) {
    return {
      status: "rejected",
      reason:
        "The entity has no coordinates, so nothing ties it to this place. A name alone is not evidence of identity.",
    };
  }

  const tolerance = toleranceMetersFor(place.category);
  const distance = haversineMeters(
    { latitude: place.coordinates.lat, longitude: place.coordinates.lng },
    {
      latitude: candidate.coordinates.lat,
      longitude: candidate.coordinates.lng,
    },
  );

  if (distance > tolerance) {
    return {
      status: "rejected",
      reason: anyNameAgrees(place, candidate)
        ? `The names agree but the entity is ${Math.round(distance)} m away, beyond the ${tolerance} m tolerance for a ${place.category}. Probably a different place of the same name.`
        : `The entity is ${Math.round(distance)} m away, beyond the ${tolerance} m tolerance for a ${place.category}.`,
    };
  }

  /* -- rung 4: coordinates plus a name ------------------------------------- */

  if (anyNameAgrees(place, candidate)) {
    return {
      status: "matched",
      qid: candidate.qid,
      method: "name-and-proximity",
      evidence: `Name agrees and the entity is ${Math.round(distance)} m away, within the ${tolerance} m tolerance for a ${place.category}.`,
    };
  }

  /* -- rung 5: coordinates plus address, or plus category ------------------ */

  if (
    place.address &&
    candidate.address &&
    addressesAgree(place.address, candidate.address)
  ) {
    return {
      status: "matched",
      qid: candidate.qid,
      method: "name-and-proximity",
      evidence: `Addresses agree and the entity is ${Math.round(distance)} m away, though the names differ — common where one source uses a formal name and the other a colloquial one.`,
    };
  }

  /*
   * Category evidence corroborates but never decides.
   *
   * "A museum near a museum" is true of every museum quarter in Europe. So this is the review arm rather than a match:
   * the evidence is real, it is just not sufficient, and a person looking at two names can settle it in a second.
   */
  const instanceOf = candidate.instanceOfLabels ?? [];
  if (instanceOf.length > 0) {
    return {
      status: "needs-review",
      qid: candidate.qid,
      method: "name-and-proximity",
      evidence: `The entity is ${Math.round(distance)} m away and is a ${instanceOf[0]}, but the names do not agree.`,
      reason:
        "Proximity and category together are not identity — a museum near a museum is true of any museum quarter.",
    };
  }

  return {
    status: "rejected",
    reason: `The entity is ${Math.round(distance)} m away but nothing else agrees — no name, alias or address in common. Proximity alone is not identity.`,
  };
}
