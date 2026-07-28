import "server-only";

import {
  factId,
  urlIsSafe,
  type FactProvenance,
  type IsoTimestamp,
  type PlaceFact,
} from "@/lib/place-intelligence";
import type { PlaceCategory, TripPlace } from "@/lib/schemas";

import {
  wikidataPolicy,
  TEXT_BOUNDS,
  type NormalizedEntity,
} from "./normalize";

/**
 * The sentence a traveller reads, and the facts behind it.
 *
 * ## A template, not a rewrite
 *
 * No language model is involved and none may be. The text is assembled by string concatenation from fields Wikidata
 * supplied, and the assembly is visible in `compose` below — every character a traveller sees either came from a
 * Wikidata field verbatim or is punctuation this module inserted.
 *
 * That rules out the obvious improvement. "Mosteiro dos Jerónimos — monastery in Lisbon, Portugal." reads awkwardly
 * next to "The Jerónimos Monastery is a late Gothic monastery in Lisbon", and a model could produce the second in a
 * moment. It would also be producing a *claim*, from a source Roamly cannot cite, about a building it has never seen
 * — and the failure mode is not awkward prose, it is a confidently wrong sentence with a CC0 licence attached.
 *
 * The em dash is doing real work here. Wikidata descriptions are lower-case noun phrases with no article
 * ("monastery in Lisbon, Portugal"), so joining them with "is a" would require inventing an article and would be a
 * grammar decision about a language this code does not know it is reading. A dash joins two fields without asserting
 * a relationship between them.
 *
 * ## The description is a fact; the assembled sentence is not
 *
 * Two different things, and only one is stored.
 *
 * Wikidata's one-line gloss is a **fact**, carried as `official-description`. It is a value a source stated, it is
 * CC0, and it survives a save — so a trip reopened next month still says what a place is without re-asking a volunteer
 * service. `facts.ts` documents why it is its own kind rather than `editorial-summary`: that kind is refused outright,
 * and reusing it would have meant weakening the refusal for every provider at once, Google included.
 *
 * The **sentence** `buildLandmarkSummary` returns is not stored, and should not be. It is a rendering — a name, a dash,
 * a description, a clause — assembled from facts that are each persisted individually. Storing the assembled string
 * would be storing a derived value that could disagree with the facts it came from the moment either changed.
 *
 * ## The category comes from OpenStreetMap
 *
 * `conflicts.ts` names OSM the authority for a place's category, so the broad landmark category in a sentence is
 * OSM's own word rather than a Wikidata `instance of`. Two reasons beyond the authority rule: `instance of` values
 * are entities, so rendering one needs a *label* and a second request per place; and Roamly already knows the place
 * is a museum, because that is why it was eligible to ask.
 */

/** The hard character cap on the whole summary. Two short sentences, and nothing that fills a panel. */
export const MAX_SUMMARY_LENGTH = 280;

/** The most sentences a summary may hold. */
export const MAX_SUMMARY_SENTENCES = 2;

/** Which of the allowed fields a summary drew on. Recorded so a reviewer can see what produced a sentence. */
export type SummaryField =
  | "label"
  | "description"
  | "category"
  | "inception"
  | "heritage";

export type LandmarkSummary = {
  /** Plain text, at most two sentences, at most `MAX_SUMMARY_LENGTH` characters. */
  text: string;
  /** The language the label and description are actually in — not the one that was asked for. */
  language: string;
  fields: SummaryField[];
  /** The Wikipedia article, where one exists. A link, never quoted content. */
  articleUrl: string | null;
  provenance: FactProvenance;
};

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Phrasings a summary may not contain, whatever the source.
 *
 * ## Why this exists when the text is a template
 *
 * The template cannot invent "a must-see hidden gem". Wikidata's description field can, because it is edited by
 * people and occasionally holds promotional or operational text a Wikidata editor would themselves remove. So the
 * check is not about what this module writes — it is about the one field it copies.
 *
 * When a pattern matches, the **description is dropped and the summary rebuilt** rather than the whole summary
 * refused. A landmark whose gloss reads badly still has a name, a founding year and a heritage designation, and
 * discarding those would let one bad field cost four good ones.
 *
 * `lib/ai/prohibited.ts` is the equivalent for model output and is not reusable here: it inspects field *keys* in a
 * JSON object, where this inspects prose.
 */
const PROHIBITED_PATTERNS: readonly RegExp[] = [
  /* Recommendation and subjective judgement. */
  /\bmust[-\s]?see\b/i,
  /\bmust[-\s]?visit\b/i,
  /\bhidden gem\b/i,
  /\bworth (?:a |the )?visit\b/i,
  /\bwhy visit\b/i,
  /\bunmissable\b/i,
  /\bstunning\b/i,
  /\bbreathtaking\b/i,
  /\bspectacular\b/i,
  /\bcharming\b/i,
  /\bidyllic\b/i,
  /\biconic\b/i,
  /\brecommend(?:ed|s|ation)?\b/i,
  /\bdon'?t miss\b/i,
  /* Operational claims a durable fact may not make. */
  /\bopening hours\b/i,
  /\bopen (?:daily|from|until|between)\b/i,
  /\bclosed (?:on|daily|mondays?)\b/i,
  /\btickets?\b/i,
  /\badmission\b/i,
  /\bentry fee\b/i,
  /\bbook(?:ing|ings)? (?:online|ahead|in advance)\b/i,
  /* Ratings and prices. */
  /\brated\b/i,
  /\b\d(?:\.\d)?\s*(?:\/\s*5|stars?)\b/i,
  /\breviews?\b/i,
  /[€$£¥]\s?\d/,
];

/** Characters that would mean the text is not plain: markup, markdown emphasis, a code fence. */
const NON_PLAIN_TEXT = /[<>`*_[\]{}|\\]/;

/**
 * Why this summary text is unusable, or `null`.
 *
 * Exported so `fixtures.ts` and any future test can assert the rules against a literal, rather than only against
 * whatever `compose` happens to produce today.
 */
export function summaryProblem(text: string): string | null {
  const value = text.trim();

  if (value.length === 0) return "The summary is empty.";
  if (value.length > MAX_SUMMARY_LENGTH) {
    return `The summary is longer than ${MAX_SUMMARY_LENGTH} characters.`;
  }
  if (NON_PLAIN_TEXT.test(value)) {
    return "The summary contains markup or markdown characters.";
  }
  if (sentenceCount(value) > MAX_SUMMARY_SENTENCES) {
    return `The summary holds more than ${MAX_SUMMARY_SENTENCES} sentences.`;
  }

  if (hasProhibitedPhrase(value)) {
    return "The summary contains a subjective, operational or promotional phrase.";
  }

  return null;
}

/**
 * Why this description may not be stored as a fact, or `null`.
 *
 * The same content rules as a summary, minus the sentence cap — a Wikidata description is a noun phrase, and counting
 * sentences in "tower in Paris, France" answers nothing. Separate from `summaryProblem` because the two guard different
 * moments: that one decides whether a *rendering* may be shown, this one whether a *value* may be persisted, and a
 * persisted value outlives every sentence built from it.
 */
export function descriptionProblem(text: string): string | null {
  const value = text.trim();

  if (value.length === 0) return "The description is empty.";
  if (value.length > TEXT_BOUNDS.maxDescriptionLength) {
    return `The description is longer than ${TEXT_BOUNDS.maxDescriptionLength} characters.`;
  }
  if (NON_PLAIN_TEXT.test(value)) {
    return "The description contains markup or markdown characters.";
  }
  if (hasProhibitedPhrase(value)) {
    return "The description contains a subjective, operational or promotional phrase.";
  }

  return null;
}

function hasProhibitedPhrase(value: string): boolean {
  return PROHIBITED_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Sentences, counted by terminator.
 *
 * Crude on purpose. "St. Peter's" would count as two by this rule, which over-counts rather than under-counts — and
 * over-counting fails the check, which is the safe direction for a cap. The composed text uses at most two
 * terminators anyway, so the only thing this can reject is a Wikidata description carrying prose.
 */
function sentenceCount(text: string): number {
  const matches = text.match(/[.!?](?:\s|$)/g);
  return matches ? matches.length : 1;
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a Wikidata fact came from.
 *
 * `sourceUrl` is the **Wikidata item**, not the Wikipedia article: the claim is Wikidata's, and a reader checking a
 * founding date needs the statement rather than an article that may or may not repeat it. The URL is built from a QID
 * this adapter has validated three times, so it is a construction rather than provider text.
 *
 * No `attributionText`. Wikidata is CC0, `attributionIsRequired` answers false for it, and
 * `REQUIRED_ATTRIBUTION.wikidata` is deliberately the empty string — a recorded decision with a licence behind it.
 */
function wikidataProvenance(
  qid: string,
  retrievedAt: IsoTimestamp,
): FactProvenance {
  const sourceUrl = `https://www.wikidata.org/wiki/${qid}`;

  return {
    provider: "wikidata",
    retrievedAt,
    licence: "CC0-1.0",
    ...(urlIsSafe(sourceUrl) ? { sourceUrl } : {}),
    externalId: qid,
    policy: wikidataPolicy(),
  };
}

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The facts one entity yields.
 *
 * Five kinds from the closed vocabulary: `wikidata-id`, `official-description`, `inception-year`, `heritage-status` and
 * `website`. Deliberately **no `category` fact** — OSM is the authority for a place's category, so a Wikidata one
 * would create a conflict `conflicts.ts` would have to report and nobody would benefit from resolving. And no name:
 * the canonical name is OSM's, and a Wikidata label competing with it would be a second answer to what a place is
 * called.
 *
 * Every id is deterministic through `factId`, so re-fetching the same entity replaces rather than accumulates. The
 * confidence is `reported` on all five: `merge.ts` recomputes it from the sources actually present, and a value
 * asserted here would be discarded there.
 */
export function buildLandmarkFacts(input: {
  entity: NormalizedEntity;
  retrievedAt: IsoTimestamp;
}): PlaceFact[] {
  const { entity, retrievedAt } = input;
  const provenance = wikidataProvenance(entity.qid, retrievedAt);
  const facts: PlaceFact[] = [];

  facts.push({
    id: factId({ provider: "wikidata", kind: "wikidata-id" }),
    kind: "wikidata-id",
    value: entity.qid,
    confidence: "reported",
    provenance,
  });

  /*
   * Wikidata's own description, verbatim, and only if it passes the prohibited-phrase check.
   *
   * The check is the same one the summary sentence faces, applied to the field on its own — because this value is
   * persisted and then rendered without the sentence around it, so a gloss reading "a must-see hidden gem" must not
   * survive as a stored fact just because the composed sentence happened to be rebuilt without it.
   *
   * Nothing is rewritten. `normalize.ts` has already stripped markup and bounded the length; this copies what Wikidata
   * says or emits nothing.
   */
  if (
    entity.description &&
    descriptionProblem(entity.description.value) === null
  ) {
    facts.push({
      id: factId({ provider: "wikidata", kind: "official-description" }),
      kind: "official-description",
      value: entity.description.value,
      confidence: "reported",
      provenance,
    });
  }

  if (entity.inceptionYear !== null) {
    facts.push({
      id: factId({ provider: "wikidata", kind: "inception-year" }),
      kind: "inception-year",
      value: entity.inceptionYear,
      confidence: "reported",
      provenance,
    });
  }

  /*
   * One heritage fact, not one per designation.
   *
   * `factId` keys on provider and kind, so two designations would collide on the same id and `mergeIntelligence`
   * would refuse the second as a duplicate. Joining them into one value is the honest shape: the fact is "what this
   * place is designated as", and a place with two designations has one answer with two parts.
   */
  if (entity.heritageDesignations.length > 0) {
    facts.push({
      id: factId({ provider: "wikidata", kind: "heritage-status" }),
      kind: "heritage-status",
      value: entity.heritageDesignations.join("; "),
      confidence: "reported",
      provenance,
    });
  }

  if (entity.officialWebsite) {
    facts.push({
      id: factId({ provider: "wikidata", kind: "website" }),
      kind: "website",
      value: entity.officialWebsite,
      confidence: "reported",
      provenance,
    });
  }

  return facts;
}

/* -------------------------------------------------------------------------- */
/* The sentence                                                               */
/* -------------------------------------------------------------------------- */

/**
 * OSM's categories as words a traveller reads.
 *
 * Only the eleven categories `landmark-eligibility.ts` deems eligible appear, because those are the only places that
 * ever reach here. A category outside the map yields no category clause rather than a fallback word — "attraction" is
 * not a safe default for something we did not expect.
 */
const CATEGORY_NOUNS: Partial<Record<PlaceCategory, string>> = {
  museum: "museum",
  gallery: "gallery",
  monument: "monument",
  historic_site: "historic site",
  attraction: "landmark",
  viewpoint: "viewpoint",
  park: "park",
  garden: "garden",
  beach: "beach",
  place_of_worship: "place of worship",
  theatre: "theatre",
};

/**
 * The summary for one matched place, or `null` when there is nothing to say.
 *
 * `null` rather than an empty string, and rather than a sentence made only of the place's own name: a panel reading
 * "Mosteiro dos Jerónimos." tells a traveller nothing they cannot see on the card above it, and rendering it would be
 * the empty-panel failure `intelligenceIsEmpty` exists to prevent.
 */
export function buildLandmarkSummary(input: {
  entity: NormalizedEntity;
  place: TripPlace;
  retrievedAt: IsoTimestamp;
}): LandmarkSummary | null {
  const { entity, place, retrievedAt } = input;

  const first = compose(entity, place, true);
  const attempt = first && summaryProblem(first.text) === null ? first : null;

  /*
   * One retry without the description, when the description is what failed.
   *
   * Not a loop and not a general repair: exactly one field can carry prose, so exactly one field is worth dropping.
   * If the text still fails without it, the failure is in this module's own template and returning `null` is the
   * correct outcome — a summary that cannot pass its own check must not be shown.
   */
  const fallback = attempt ? null : compose(entity, place, false);
  const summary =
    attempt ??
    (fallback && summaryProblem(fallback.text) === null ? fallback : null);

  if (!summary) return null;

  return {
    text: summary.text,
    language: summary.language,
    fields: summary.fields,
    articleUrl: entity.article?.url ?? null,
    provenance: wikidataProvenance(entity.qid, retrievedAt),
  };
}

/**
 * Assembles the text.
 *
 * Sentence one names the place and says what it is. Sentence two carries the dated facts. Two sentences is the cap,
 * so there is no third — an official website is a fact and a link rather than a clause, and a place with four
 * designations gets them joined rather than listed.
 */
function compose(
  entity: NormalizedEntity,
  place: TripPlace,
  withDescription: boolean,
): { text: string; language: string; fields: SummaryField[] } | null {
  const fields: SummaryField[] = [];

  /*
   * OSM's name is preferred over Wikidata's label.
   *
   * They usually agree, and where they differ the traveller is looking at a card that already says OSM's name —
   * a summary opening with a different name would read as a summary of a different place.
   */
  const name = place.name.trim();
  if (name.length === 0) return null;
  fields.push("label");

  const description = withDescription ? entity.description : null;
  const categoryNoun = CATEGORY_NOUNS[place.category];

  let opening: string;
  if (description) {
    opening = `${name} — ${description.value}`;
    fields.push("description");
  } else if (categoryNoun) {
    opening = `${name} — ${categoryNoun}`;
    fields.push("category");
  } else {
    /* Nothing to say beyond the name, which the card already says. */
    return null;
  }

  const clauses: string[] = [];
  if (entity.inceptionYear !== null) {
    clauses.push(yearClause(entity.inceptionYear, entity.inceptionSource));
    fields.push("inception");
  }
  if (entity.heritageDesignations.length > 0) {
    clauses.push(entity.heritageDesignations.join("; "));
    fields.push("heritage");
  }

  const text =
    clauses.length > 0
      ? `${finish(opening)} ${finish(clauses.join("; "))}`
      : finish(opening);

  return {
    text,
    /* The language of the text a reader actually sees — Wikidata's own, or OSM's where no description was used. */
    language: description?.language ?? entity.label?.language ?? "und",
    fields,
  };
}

/**
 * The year clause, naming which property it came from.
 *
 * "Founded" for an inception date and "opened" for a date of official opening, because they are different claims: a
 * museum founded in 1884 and opened in 1891 are both true, and rendering the second as the first would be reporting
 * a fact Wikidata did not state. A negative year becomes "BC" rather than a minus sign.
 */
function yearClause(
  year: number,
  source: NormalizedEntity["inceptionSource"],
): string {
  const rendered = year < 0 ? `${Math.abs(year)} BC` : String(year);
  return source === "official-opening"
    ? `Opened ${rendered}`
    : `Founded ${rendered}`;
}

/** Adds a full stop unless the clause already ends in a terminator. */
function finish(clause: string): string {
  return /[.!?]$/.test(clause) ? clause : `${clause}.`;
}
