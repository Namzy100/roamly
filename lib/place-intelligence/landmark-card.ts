import type { TripPlace } from "@/lib/schemas";

import { externalIdentityFor, type PlaceIntelligence } from "./canonical";
import { detectConflicts } from "./conflicts";
import {
  mayDisplayFact,
  mayDisplayMedia,
  requiredAttributions,
  selectDescription,
  type DisplaySurface,
} from "./display-policy";
import { matchIsTrusted } from "./external-identity";
import type { PlaceFact, PlaceFactKind } from "./facts";
import { isLandmarkEligible } from "./landmark-eligibility";
import type { PlaceMedia } from "./media";
import type {
  FactConfidence,
  IsoTimestamp,
  LicenceId,
  ProviderId,
} from "./types";

/**
 * What a landmark card may show, derived from the stored sidecar alone (Checkpoint 5B, section 10A).
 *
 * ## Why this exists at all, given the adapter already composes a summary
 *
 * `buildLandmarkSummary` produces a two-sentence landmark summary — and that summary is **never stored**. It travels
 * on the enrich *response* (`EnrichOutcomeSchema.summary`) and stops there, because `PlaceIntelligence` holds
 * identities, facts and media and nothing else. Persisting assembled prose would put a sentence no source wrote into
 * the trip record, and it would go stale against the facts underneath it with no way to tell.
 *
 * So a card rendered from a *saved* trip has the facts and no summary, and reconstructing what to show from those
 * facts is this module's whole job. A component reading `intelligence.facts` directly would have to re-implement the
 * display gates, and the one it would forget is the one that matters — an unlicensed photograph is the easiest thing
 * to render by accident.
 *
 * ## Pure, and total
 *
 * No fetch, no clock, no store. `now` is a parameter because freshness is a display gate and a module that read the
 * clock itself could not be tested against a stale fact. Every input produces a value — a place with no sidecar
 * returns the same empty result as a place whose every fact was refused, because a card has nothing to render in
 * either case and does not need to know which.
 *
 * ## The gates, and why they are all here rather than spread over a component
 *
 * Five refusals, in order, each closing a way a card could show something it may not:
 *
 *  1. **no sidecar** — the ordinary case, and the reason the return is an empty record rather than `null`
 *  2. **a sidecar for a different place** — `canonicalPlaceId` must equal `place.placeId`. A mismatch means the
 *     lookup that produced it was keyed wrongly, and rendering it would attach one landmark's history to another
 *  3. **an ineligible place** — a café carrying landmark intelligence was never asked about, so whatever is attached
 *     did not arrive by a path this checkpoint permits
 *  4. **an untrusted or absent identity** — see below
 *  5. **the ordinary display gates** — `mayDisplayFact` and `mayDisplayMedia`, per item
 *
 * ## The identity gate covers the photograph too, and that is the point
 *
 * Every part of a landmark card — description, dates, designation, photograph — was obtained by resolving *one*
 * Wikidata entity. The photograph carries `wikimedia-commons` provenance and there is no Commons identity in the
 * sidecar, because Commons was never matched against the place: the file was found *through* the entity. So the trust
 * question is asked once, about the Wikidata match, and its answer governs the whole card.
 *
 * Gating each provider separately would have looked more thorough and been wrong in both directions — it would refuse
 * every photograph for want of an identity that is not supposed to exist, while letting a photograph found through a
 * bad entity match through under its own clean licence.
 *
 * `matchIsTrusted` is the same gate `merge.ts` applies, so a `name-and-proximity` match displays nothing. That is
 * already true of the stored data — a nearby match is saved as `review`, with an identity and no facts — and the gate
 * is repeated here because "the pipeline does not write those facts" is a property of one code path, where this is a
 * property of the display.
 */

/**
 * The surface a landmark card renders on.
 *
 * Fixed rather than a parameter. A landmark card is in-app by construction: the map has its own marker treatment and
 * refuses photographs outright, and an export runs through `stripIntelligenceForExport` before anything renders. A
 * `surface` argument here would invite passing `"map"` and getting a plausible-looking answer for a surface that does
 * not render cards.
 */
const CARD_SURFACE: DisplaySurface = "in-app";

/**
 * The fact kinds a landmark card shows, in the order it shows them.
 *
 * Two, and the exclusions are the interesting part:
 *
 *  - **`website`** — the adapter stores one, and the card already renders `TripPlace.website` from OSM's own tag.
 *    Showing both would put two links to the same place on one card, and where they differ a traveller has no way to
 *    tell which is current. OSM's is the one the pool was verified against, so OSM's is the one that renders.
 *  - **`wikidata-id`** — a join key. It is what let the facts be found, not something a traveller reads.
 *  - **`official-description`** — shown, but through `selectDescription` rather than as a row here, because choosing
 *    between two sources' wording is a decision that module already owns.
 *
 * Order is display order and is stated rather than derived: a date before a designation reads as a sentence about the
 * place, and the reverse reads as a list.
 */
export const LANDMARK_CARD_FACT_KINDS: readonly PlaceFactKind[] = [
  "inception-year",
  "heritage-status",
];

/**
 * The label each card fact renders under.
 *
 * "Dates from" rather than "Founded" or "Built", and the reason is fidelity. Wikidata distinguishes an *inception*
 * from an *official opening* — a museum founded in 1884 and opened in 1891 are two true facts — and
 * `buildLandmarkFacts` stores a single `inception-year` number without recording which property it came from. The
 * adapter's own prose can say "Founded" or "Opened" because it still holds the entity; a card reading the stored fact
 * does not, so it uses the one phrasing that is true of both.
 *
 * "Built" would be worse than either: it is a claim about construction, which is a third thing again.
 */
export const LANDMARK_CARD_FACT_LABELS: Partial<Record<PlaceFactKind, string>> =
  {
    "inception-year": "Dates from",
    "heritage-status": "Heritage status",
  };

export type LandmarkCardFact = {
  kind: PlaceFactKind;
  /** From `LANDMARK_CARD_FACT_LABELS`. Held here so a component renders rather than looks up. */
  label: string;
  /** The stored value, rendered. Never rewritten — see `renderFactValue`. */
  value: string;
  /**
   * Carried through so a card can mark a corroborated fact as such.
   *
   * `disputed` never reaches here: `mayDisplayFact` refuses it. Present anyway, because the difference between
   * "Wikidata says" and "two sources agree" is one a card may legitimately show, and re-deriving it would mean
   * exposing the fact list the rest of this type exists to avoid exposing.
   */
  confidence: FactConfidence;
};

/**
 * One photograph, with everything its licence obliges.
 *
 * Flattened out of `PlaceMedia.provenance` deliberately. A component handed the whole record would be one property
 * access away from rendering a file `mediaIsDisplayable` refused, and the nesting hides which fields are obligations
 * rather than decoration. Every field below is either the image or a credit that must appear with it.
 */
export type LandmarkCardPhoto = {
  url: string;
  /** Never empty: `mediaIsDisplayable` refuses a photograph without one, so a card cannot render an unlabelled image. */
  altText: string;
  creator: string | null;
  licence: LicenceId;
  /** Required by some licences and absent for others. `mediaIsDisplayable` has already refused the mismatches. */
  licenceUrl: string | null;
  /** The exact credit line the file carries, which names a creator Roamly cannot re-derive. */
  credit: string | null;
  /** Whether a card may resize or crop it. Unknown means no, per `mediaMayBeTransformed`. */
  transformationPermitted: boolean;
};

export type LandmarkCardIntelligence = {
  /**
   * Whether to render an enrichment region at all.
   *
   * A field rather than a check a component assembles, so that "an empty sidecar must produce no empty panel" is one
   * condition in one place. A card testing `description || photo || facts.length` would be re-deriving this, and the
   * version that drifts is the one that renders a heading over nothing.
   */
  hasContext: boolean;
  /** The one description to show, with the source that wrote it. Selection, never composition. */
  description: { text: string; provider: ProviderId } | null;
  photo: LandmarkCardPhoto | null;
  /** In `LANDMARK_CARD_FACT_KINDS` order, and only the kinds that survived every gate. */
  facts: LandmarkCardFact[];
  /**
   * Every credit line the *displayed* items oblige, deduplicated and stable.
   *
   * Computed over what actually renders rather than over the whole sidecar, which matters in both directions: a credit
   * for a photograph that was refused claims Roamly is showing somebody's work when it is not, and a missing credit
   * for one that rendered is the licence breach itself.
   */
  attributions: string[];
};

/** Nothing to show. Returned for every refusal, because a card renders identically in all of them. */
const NO_CONTEXT: LandmarkCardIntelligence = {
  hasContext: false,
  description: null,
  photo: null,
  facts: [],
  attributions: [],
};

export function deriveLandmarkCardIntelligence(input: {
  place: TripPlace;
  intelligence?: PlaceIntelligence | null;
  now: IsoTimestamp;
}): LandmarkCardIntelligence {
  const { place, intelligence, now } = input;

  if (!intelligence) return NO_CONTEXT;
  if (intelligence.canonicalPlaceId !== place.placeId) return NO_CONTEXT;
  if (!isLandmarkEligible(place)) return NO_CONTEXT;

  const wikidata = externalIdentityFor(intelligence, "wikidata");
  if (!wikidata || !matchIsTrusted(wikidata)) return NO_CONTEXT;

  /*
   * Conflicts are detected here rather than stored, because they are a function of the facts present *now* — a refresh
   * that drops one source resolves the disagreement, and a stored conflict would outlive it.
   *
   * Passed into `mayDisplayFact` as a gate and never rendered. For opening hours a card is expected to show the
   * disagreement, which is what `display-policy` describes; for the two kinds this card carries, it is not. A
   * traveller warned that two sources date a monument differently has been told nothing they can act on, where the
   * same banner over contested opening hours is exactly what somebody standing at a door needs. So a contested date is
   * simply absent.
   */
  const conflicts = detectConflicts(place.placeId, intelligence.facts);
  const gate = { surface: CARD_SURFACE, now, conflicts } as const;

  const descriptionFact = selectDescription(intelligence.facts, gate);

  const factRows: LandmarkCardFact[] = [];
  const displayedFacts: PlaceFact[] = [];
  if (descriptionFact) displayedFacts.push(descriptionFact);

  for (const kind of LANDMARK_CARD_FACT_KINDS) {
    const chosen = firstPermitted(
      intelligence.facts.filter((candidate) => candidate.kind === kind),
      (candidate) => mayDisplayFact(candidate, gate) === "granted",
    );
    if (!chosen) continue;

    displayedFacts.push(chosen);
    factRows.push({
      kind,
      label: LANDMARK_CARD_FACT_LABELS[kind] ?? kind,
      value: renderFactValue(chosen),
      confidence: chosen.confidence,
    });
  }

  /*
   * One photograph, not a gallery.
   *
   * A card has room for one image, and "how many photographs, in what order, with whose credit beside each" is a
   * gallery design nobody has specified. Taking the first permitted one by `id` keeps it deterministic — the same
   * saved trip renders the same picture every time, which a `find` over an unsorted array would not guarantee once a
   * refresh reorders the list.
   */
  const photoMedia = firstPermitted(
    intelligence.media.filter((candidate) => candidate.kind === "photo"),
    (candidate) =>
      mayDisplayMedia(candidate, { surface: CARD_SURFACE }) === "granted",
  );

  const attributions = requiredAttributions({
    facts: displayedFacts,
    media: photoMedia ? [photoMedia] : [],
  });

  const description = descriptionFact
    ? {
        text: String(descriptionFact.value),
        provider: descriptionFact.provenance.provider,
      }
    : null;

  const photo = photoMedia ? toCardPhoto(photoMedia) : null;

  return {
    hasContext: description !== null || photo !== null || factRows.length > 0,
    description,
    photo,
    facts: factRows,
    attributions,
  };
}

/**
 * The lowest-`id` item that passes the gate.
 *
 * Sorted before the search rather than after, so the choice does not depend on the order the sidecar happens to hold —
 * `mergeIntelligence` is free to reorder, and a card that changed its photograph on a refresh which added nothing
 * would read as a bug.
 */
function firstPermitted<T extends { id: string }>(
  items: T[],
  permitted: (item: T) => boolean,
): T | null {
  const ranked = [...items].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return ranked.find(permitted) ?? null;
}

/**
 * A stored value, as text.
 *
 * The only transformation is on a negative year, which becomes `525 BC` rather than `-525`. Deliberately the same
 * rendering the adapter's own prose uses, and deliberately *not* imported from it: `lib/place-intelligence` is the
 * contract every provider compiles against, so a dependency on `lib/providers` would invert the direction the whole
 * directory is built on. Two duplicated lines is the cheaper of the two costs, and this comment is the link between
 * them.
 *
 * Everything else passes through untouched. A `heritage-status` value arrives already joined by `; `, and re-splitting
 * it here to render a list would be this module deciding how the adapter's joining should be undone.
 */
function renderFactValue(fact: PlaceFact): string {
  if (fact.kind === "inception-year" && typeof fact.value === "number") {
    return fact.value < 0 ? `${Math.abs(fact.value)} BC` : String(fact.value);
  }
  return String(fact.value);
}

function toCardPhoto(media: PlaceMedia): LandmarkCardPhoto {
  return {
    url: media.url,
    /* Non-empty by `mediaIsDisplayable`; the fallback satisfies the type rather than papering over a gap. */
    altText: media.altText ?? "",
    creator: media.creator ?? null,
    licence: media.provenance.licence,
    licenceUrl: media.provenance.licenceUrl ?? null,
    credit: media.provenance.attributionText ?? null,
    transformationPermitted: media.transformationPermitted === true,
  };
}
