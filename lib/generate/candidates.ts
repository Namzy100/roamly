import type { ModelPlaceCandidate } from "@/lib/ai";
import {
  placeCategoryLabel,
  type PlaceCategory,
  type TripPlace,
  type VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * The pool, as the model is allowed to see it.
 *
 * ## Copy, never enrich
 *
 * Every field below is copied from the canonical record or omitted. Nothing is
 * computed, inferred, scored or defaulted. There is no `qualityScore`, no
 * `popularity`, no `distanceFromCentre`, no `isOpenNow` — and their absence is the
 * point rather than an oversight.
 *
 * The temptation is real: a relevance score would demonstrably improve the model's
 * choices. But any score we could compute from OSM tags would be *our* opinion
 * dressed as data, the model would reason about it as though it were a fact, and the
 * resulting itinerary would say "the best-rated café in the district" about a
 * ranking nobody measured. If a place has no rating, the model must choose without
 * one, and the plan must be honest that it did.
 *
 * ## `openingHours`, carried and disclaimed
 *
 * Included verbatim because it is genuinely useful — a model can see that a market
 * is tagged `Tu,Sa` and avoid scheduling it on a Monday. Labelled as uninterpreted
 * in `sourceFacts` and again in the prompt, because we run no `opening_hours`
 * parser and must not imply we do.
 *
 * ## Determinism
 *
 * Pool order is preserved exactly, and pool order is already deterministic
 * (category, then name, then id). The same pool always produces the same prompt,
 * which is what makes a generation reproducible and a regression bisectable.
 */

/**
 * The prompt-size ceiling.
 *
 * 120 candidates is roughly 12 000 tokens of JSON — comfortable inside Gemini's
 * window and inside the 32k context configured for Ollama, with room for a long
 * instruction and a long answer. Beyond this the marginal candidate does not change
 * the itinerary and does crowd the output.
 */
export const MAX_PROMPT_CANDIDATES = 120;

export type BuildCandidatesInput = {
  pool: VerifiedPlacePool;
  /** Per-category ceiling, from the strategy's largest `candidateLimit`. */
  limitPerCategory: number;
};

export type CandidateSet = {
  candidates: ModelPlaceCandidate[];
  countsByCategory: Record<string, number>;
  /** True when the per-category or total cap left something out of the prompt. */
  truncated: boolean;
};

export function buildModelCandidates(
  input: BuildCandidatesInput,
): CandidateSet {
  const counts = new Map<PlaceCategory, number>();
  const candidates: ModelPlaceCandidate[] = [];
  let truncated = false;

  for (const place of input.pool.places) {
    if (candidates.length >= MAX_PROMPT_CANDIDATES) {
      truncated = true;
      break;
    }
    const used = counts.get(place.category) ?? 0;
    if (used >= input.limitPerCategory) {
      truncated = true;
      continue;
    }
    counts.set(place.category, used + 1);
    candidates.push(toCandidate(place));
  }

  return {
    candidates,
    countsByCategory: Object.fromEntries(counts),
    truncated,
  };
}

/**
 * One canonical record → one candidate.
 *
 * Optional fields are omitted rather than set to null or an empty string: absent
 * means absent, and `"address": ""` in a prompt reads as an address the model might
 * try to complete.
 */
export function toCandidate(place: TripPlace): ModelPlaceCandidate {
  const candidate: ModelPlaceCandidate = {
    placeId: place.placeId,
    name: place.name,
    category: place.category,
    latitude: place.coordinates.lat,
    longitude: place.coordinates.lng,
    sourceFacts: sourceFacts(place),
  };

  const label = placeCategoryLabel(place);
  if (label !== place.category) candidate.categoryLabel = label;
  if (place.address) candidate.address = place.address;
  if (place.cuisine?.length) candidate.cuisine = place.cuisine.join(", ");
  if (place.openingHours) candidate.openingHours = place.openingHours;
  if (place.website) candidate.website = place.website;

  return candidate;
}

/**
 * Prose for the tags that are present, and only those.
 *
 * A free-text list rather than a field per tag: OSM has thousands of tags and
 * adding a schema field for each would be endless, while a model reads
 * "wheelchair access: designated" perfectly well. Each entry restates what the tag
 * literally says — none of them adds an interpretation.
 */
export function sourceFacts(place: TripPlace): string[] {
  const facts: string[] = [];

  if (place.openingHours) {
    facts.push(
      `OpenStreetMap opening_hours tag, raw and uninterpreted: "${place.openingHours}"`,
    );
  }
  if (place.wheelchair) {
    facts.push(`OpenStreetMap wheelchair tag: ${place.wheelchair}`);
  }
  if (place.outdoorSeating !== undefined) {
    facts.push(
      place.outdoorSeating
        ? "Tagged as having outdoor seating"
        : "Tagged as having no outdoor seating",
    );
  }
  if (place.takeaway !== undefined) {
    facts.push(
      place.takeaway ? "Tagged as offering takeaway" : "Tagged as no takeaway",
    );
  }
  if (place.phone) facts.push("A phone number is on record");
  if (!place.address) facts.push("No address recorded in OpenStreetMap");

  return facts;
}
