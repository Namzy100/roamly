import type { PlaceIntelligence } from "./canonical";
import { detectConflicts, disputedKinds } from "./conflicts";
import { matchIsTrusted, type ExternalIdentity } from "./external-identity";
import {
  factKindIsCorroboratable,
  factKindIsRefused,
  type PlaceFact,
} from "./facts";
import type { PlaceMedia } from "./media";

/**
 * Folding new facts into what a place already has.
 *
 * ## Additive, never destructive
 *
 * Nothing here overwrites a *different* fact. A new fact of a kind that already exists is **added**, and the
 * disagreement is then a conflict `conflicts.ts` reports rather than an update one source won. That is the opposite of
 * what an ordinary cache does, and the reason is the one `conflicts.ts` sets out: the value Roamly's itinerary was
 * validated against lives in `TripPlace`, and a merge that replaced it would make the trip fail
 * `assertItineraryUsesPool`.
 *
 * The one thing that *is* replaced is a fact with the **same `id`** — same provider, same kind, same subject moment. That
 * is not a competing claim, it is the same claim re-fetched, and keeping both would grow the sidecar without bound on
 * every refresh. First write wins, so a refresh never silently changes a value out from under a displayed conflict; a
 * genuine correction is a deletion followed by a merge, which is visible.
 *
 * ## Nothing canonical is touched
 *
 * This function's input and output are both `PlaceIntelligence`. It has no access to a `TripPlace`, so it cannot replace
 * a canonical name, coordinate or category even by accident — a provider's `category` fact is recorded *alongside* OSM's,
 * and `conflicts.ts` names OSM the authority for that field. The type signature is the enforcement.
 *
 * ## Corroboration is the only confidence upgrade
 *
 * Two independent providers agreeing is the one piece of evidence justifying more than `reported`, and it is evidence
 * rather than judgement — so this is the only place `corroborated` may be set. Nothing may set `disputed` directly
 * either: that follows from `detectConflicts`, which means a fact cannot be marked disputed by an adapter that happened
 * to feel unsure, nor corroborated by one that felt confident.
 *
 * ## An untrusted match imports nothing
 *
 * `matchIsTrusted` gates the whole fold. A name-and-proximity guess produces an identity worth showing a person for
 * confirmation and worth zero facts until they confirm — because the failure it produces is the wrong branch of a chain,
 * and that failure is invisible until somebody is standing outside the wrong door.
 *
 * Pure. No clock, no store, no network: refusals are returned rather than logged.
 */

export type MergeRefusalCode =
  | "untrusted_match"
  | "refused_fact_kind"
  | "wrong_canonical_place"
  | "duplicate_identity"
  | "duplicate_fact"
  | "duplicate_media";

export type MergeRefusal = {
  code: MergeRefusalCode;
  message: string;
  factKind?: PlaceFact["kind"];
  id?: string;
};

export type MergeResult = {
  intelligence: PlaceIntelligence;
  /** What was not folded in, and why. Returned so a caller can log or surface it. */
  refusals: MergeRefusal[];
};

/**
 * One provider's contribution, folded into a place's sidecar.
 *
 * The identity is required rather than optional: a fact with no established link to this place is a fact about some other
 * place, and accepting one "just this once" is how a sidecar acquires a stranger's opening hours.
 */
export function mergeIntelligence(input: {
  existing: PlaceIntelligence;
  identity: ExternalIdentity;
  facts?: PlaceFact[];
  media?: PlaceMedia[];
}): MergeResult {
  const refusals: MergeRefusal[] = [];

  if (input.identity.canonicalPlaceId !== input.existing.canonicalPlaceId) {
    return {
      intelligence: input.existing,
      refusals: [
        {
          code: "wrong_canonical_place",
          message: `The identity points at ${input.identity.canonicalPlaceId}, not ${input.existing.canonicalPlaceId}. Nothing was merged.`,
        },
      ],
    };
  }

  const conflictingId = hasOtherIdFor(input.existing, input.identity);

  if (!matchIsTrusted(input.identity)) {
    /*
     * The identity is still recorded, so a confirmation flow has something to offer.
     *
     * Recording the link while refusing its facts is the useful middle: the traveller can be asked "is this the same
     * café?", and answering yes upgrades the method to `manual` and lets the facts in on the next fold. Discarding the
     * identity would make them establish it again from nothing.
     */
    return {
      intelligence: withIdentity(input.existing, input.identity),
      refusals: [
        {
          code: "untrusted_match",
          message: `The match was made by ${input.identity.method} and needs confirming before any fact is attached.`,
        },
      ],
    };
  }

  if (conflictingId) {
    refusals.push({
      code: "duplicate_identity",
      message: `This place already has a different ${input.identity.provider} id. The existing one was kept.`,
    });
  }

  const withNewIdentity = withIdentity(input.existing, input.identity);

  /* -- facts: refuse the forbidden, deduplicate the rest -------------------- */

  const seenFactIds = new Set(withNewIdentity.facts.map((fact) => fact.id));
  const accepted: PlaceFact[] = [];

  for (const fact of input.facts ?? []) {
    if (factKindIsRefused(fact.kind)) {
      refusals.push({
        code: "refused_fact_kind",
        message: `“${fact.kind}” is refused regardless of provider.`,
        factKind: fact.kind,
        id: fact.id,
      });
      continue;
    }

    if (seenFactIds.has(fact.id)) {
      refusals.push({
        code: "duplicate_fact",
        message: `A fact with id “${fact.id}” is already held. The existing one was kept.`,
        factKind: fact.kind,
        id: fact.id,
      });
      continue;
    }

    seenFactIds.add(fact.id);
    accepted.push(fact);
  }

  /* -- media: same deduplication, no kind refusals to apply ---------------- */

  const seenMediaIds = new Set(withNewIdentity.media.map((entry) => entry.id));
  const acceptedMedia: PlaceMedia[] = [];

  for (const entry of input.media ?? []) {
    if (seenMediaIds.has(entry.id)) {
      refusals.push({
        code: "duplicate_media",
        message: `Media with id “${entry.id}” is already held. The existing one was kept.`,
        id: entry.id,
      });
      continue;
    }
    seenMediaIds.add(entry.id);
    acceptedMedia.push(entry);
  }

  return {
    intelligence: {
      ...withNewIdentity,
      facts: markConfidence([...withNewIdentity.facts, ...accepted]),
      media: [...withNewIdentity.media, ...acceptedMedia],
    },
    refusals,
  };
}

/**
 * The identity, added unless one for this provider is already present.
 *
 * First write wins. Deliberately not last: an established link that a later, weaker lookup would replace is the more
 * valuable of the two, and silently re-pointing a place at a different venue is precisely the failure this module is
 * built around.
 */
function withIdentity(
  intelligence: PlaceIntelligence,
  identity: ExternalIdentity,
): PlaceIntelligence {
  const existing = intelligence.identities.find(
    (entry) => entry.provider === identity.provider,
  );
  if (existing) return intelligence;

  return {
    ...intelligence,
    identities: [...intelligence.identities, identity],
  };
}

function hasOtherIdFor(
  intelligence: PlaceIntelligence,
  identity: ExternalIdentity,
): boolean {
  return intelligence.identities.some(
    (entry) =>
      entry.provider === identity.provider &&
      entry.externalId !== identity.externalId,
  );
}

/**
 * Re-derive every fact's confidence from the evidence now present.
 *
 * Recomputed over the whole set rather than adjusted incrementally, because both answers depend on what else is there: a
 * fact that was `corroborated` by a second source becomes `disputed` when a third disagrees, and an incremental update
 * would leave the first claiming corroboration it no longer has.
 *
 * This is also what makes a hand-asserted confidence unenforceable. An adapter can put `corroborated` on a lone fact; the
 * value is discarded here and recomputed from the sources actually present, so the assertion never survives a merge.
 * `reported` is the floor, and nothing invents agreement from a single source.
 */
function markConfidence(facts: PlaceFact[]): PlaceFact[] {
  const disputed = disputedKinds(detectConflicts("", facts));

  const providersByKind = new Map<PlaceFact["kind"], Set<string>>();
  for (const fact of facts) {
    const set = providersByKind.get(fact.kind) ?? new Set<string>();
    set.add(fact.provenance.provider);
    providersByKind.set(fact.kind, set);
  }

  return facts.map((fact) => {
    if (disputed.has(fact.kind)) {
      return { ...fact, confidence: "disputed" as const };
    }

    /*
     * Two sources are evidence for most kinds, and not for all of them.
     *
     * `factKindIsCorroboratable` names the exceptions. A description is the one today: two providers wording one
     * differently is not disagreement, and two wording it identically usually means one copied the other, so neither
     * case supports an upgrade. Without this check, such a kind would get corroboration without ever being subject to
     * conflict detection — the promotion with none of the contest.
     */
    const independent = providersByKind.get(fact.kind)?.size ?? 1;
    const corroborated =
      independent >= 2 && factKindIsCorroboratable(fact.kind);

    return {
      ...fact,
      confidence: corroborated
        ? ("corroborated" as const)
        : ("reported" as const),
    };
  });
}
