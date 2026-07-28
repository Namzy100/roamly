import type { PlaceIntelligence } from "./canonical";
import { detectConflicts } from "./conflicts";
import {
  MAX_FACT_VALUE_LENGTH,
  factKindIsRefused,
  type PlaceFactKind,
} from "./facts";
import { mediaIsDisplayable } from "./media";
import {
  mayExportFact,
  mayExportMedia,
  mayPersistFact,
  mayPersistMedia,
} from "./persistence-policy";
import { provenanceIsComplete } from "./provenance";
import type { ProviderId } from "./types";

/**
 * The gate a sidecar clears before it is stored or exported.
 *
 * ## Why validation is separate from the policies it applies
 *
 * `persistence-policy` answers a question about **one** fact. Several of the things that can be wrong are properties of the
 * **whole** bundle and cannot be seen one fact at a time:
 *
 *  - two identities for one provider, or one provider id used twice — the match went wrong and nobody noticed
 *  - two facts or two images sharing an id, which makes deduplication ambiguous
 *  - a fact kind that is refused outright having arrived anyway, meaning an adapter bypassed `merge.ts`
 *  - a fact marked `corroborated` with only one source behind it, or a confident verdict on a contested field
 *  - a recorded policy claiming a permission the current table no longer grants
 *
 * The confidence checks are why this exists as a check rather than a comment. `merge.ts` is the only thing permitted to set
 * confidence, and the only way to enforce "only" is to notice when something else did.
 *
 * The shape follows `lib/structural-edits/validate.ts`: return findings rather than throw, so one pass reports every problem
 * instead of failing on the first.
 */

export type IntelligenceViolationCode =
  | "duplicate_provider_identity"
  | "duplicate_external_id"
  | "duplicate_fact_id"
  | "duplicate_media_id"
  | "fact_kind_refused"
  | "fact_value_too_long"
  | "incomplete_provenance"
  | "media_not_displayable"
  | "confidence_not_derived"
  | "policy_exceeds_current"
  | "not_persistable"
  | "not_exportable";

export type IntelligenceViolation = {
  code: IntelligenceViolationCode;
  message: string;
  canonicalPlaceId: string;
  factKind?: PlaceFactKind;
  provider?: ProviderId;
  id?: string;
};

export type ValidationMode = "structural" | "persist" | "export";

/**
 * Everything wrong with this sidecar, as a list.
 *
 * `mode` decides how strict the storage checks are, and the distinction is the one `persistence-policy` draws:
 *
 *  - `structural` — the bundle is internally coherent. Used on data held only in memory, where a perishable forecast is
 *    perfectly legitimate.
 *  - `persist` — additionally, everything in it may be written to the trip record.
 *  - `export` — additionally, everything in it may be redistributed in a file.
 *
 * Validating at the wrong strictness is the mistake worth designing against: checking `structural` before a write would let
 * a forecast into `localStorage`, and checking `export` on in-memory data would refuse a forecast Roamly is entitled to
 * display.
 */
export function validateIntelligence(
  intelligence: PlaceIntelligence,
  mode: ValidationMode = "structural",
): IntelligenceViolation[] {
  const violations: IntelligenceViolation[] = [];
  const place = intelligence.canonicalPlaceId;

  const at = (
    code: IntelligenceViolationCode,
    message: string,
    extra: { factKind?: PlaceFactKind; provider?: ProviderId; id?: string } = {},
  ): void => {
    violations.push({ code, message, canonicalPlaceId: place, ...extra });
  };

  /* -- identity uniqueness, in both directions ----------------------------- */

  const seenProviders = new Set<ProviderId>();
  const seenExternalIds = new Set<string>();

  for (const identity of intelligence.identities) {
    if (seenProviders.has(identity.provider)) {
      at(
        "duplicate_provider_identity",
        `Two ${identity.provider} identities for one place. The match is ambiguous, so no fact from it can be trusted.`,
        { provider: identity.provider },
      );
    }
    seenProviders.add(identity.provider);

    const key = `${identity.provider}:${identity.externalId}`;
    if (seenExternalIds.has(key)) {
      at(
        "duplicate_external_id",
        `The external id ${key} appears twice on one place.`,
        { provider: identity.provider, id: key },
      );
    }
    seenExternalIds.add(key);
  }

  /* -- what the evidence actually supports --------------------------------- */

  const inConflict = new Set(
    detectConflicts(place, intelligence.facts).map((conflict) => conflict.kind),
  );

  const providersByKind = new Map<PlaceFactKind, Set<ProviderId>>();
  for (const fact of intelligence.facts) {
    const set = providersByKind.get(fact.kind) ?? new Set<ProviderId>();
    set.add(fact.provenance.provider);
    providersByKind.set(fact.kind, set);
  }

  /* -- per-fact checks ----------------------------------------------------- */

  const seenFactIds = new Set<string>();

  for (const fact of intelligence.facts) {
    if (seenFactIds.has(fact.id)) {
      at(
        "duplicate_fact_id",
        `Two facts share the id “${fact.id}”, so deduplication cannot tell them apart.`,
        { factKind: fact.kind, provider: fact.provenance.provider, id: fact.id },
      );
    }
    seenFactIds.add(fact.id);

    if (factKindIsRefused(fact.kind)) {
      at(
        "fact_kind_refused",
        `“${fact.kind}” is refused regardless of provider, so its presence means an adapter bypassed the merge.`,
        { factKind: fact.kind, provider: fact.provenance.provider, id: fact.id },
      );
    }

    if (
      typeof fact.value === "string" &&
      fact.value.length > MAX_FACT_VALUE_LENGTH
    ) {
      at(
        "fact_value_too_long",
        `“${fact.kind}” carries a ${fact.value.length}-character value, over the ${MAX_FACT_VALUE_LENGTH} limit.`,
        { factKind: fact.kind, id: fact.id },
      );
    }

    if (!provenanceIsComplete(fact.provenance)) {
      at(
        "incomplete_provenance",
        `“${fact.kind}” carries licence “${fact.provenance.licence}” with no credit line, no licence link, or an unsafe URL.`,
        { factKind: fact.kind, provider: fact.provenance.provider, id: fact.id },
      );
    }

    /*
     * The recorded policy may be stricter than the current table, never more generous.
     *
     * Stricter is fine and expected — a fact fetched under a cautious reading stays cautious. More generous means the terms
     * were tightened after this fact was stored, which is the case that has to be found rather than trusted.
     *
     * Guarded on the checks above so the message points at the real cause: a refused kind or a broken provenance already
     * reports itself, and adding "policy exceeds current" beside it would be two findings for one problem.
     */
    if (
      fact.provenance.policy.persistence === "granted" &&
      mayPersistFact(fact) !== "granted" &&
      provenanceIsComplete(fact.provenance) &&
      !factKindIsRefused(fact.kind)
    ) {
      at(
        "policy_exceeds_current",
        `This fact was stored believing persistence was granted (terms read ${fact.provenance.policy.termsReadOn}), but the current policy refuses it.`,
        { factKind: fact.kind, provider: fact.provenance.provider, id: fact.id },
      );
    }

    if (inConflict.has(fact.kind) && fact.confidence !== "disputed") {
      at(
        "confidence_not_derived",
        `“${fact.kind}” is in conflict but claims confidence “${fact.confidence}”. Only the merge may set this.`,
        { factKind: fact.kind, id: fact.id },
      );
    }

    if (
      fact.confidence === "corroborated" &&
      (providersByKind.get(fact.kind)?.size ?? 1) < 2
    ) {
      at(
        "confidence_not_derived",
        `“${fact.kind}” claims corroboration with only one source behind it.`,
        { factKind: fact.kind, id: fact.id },
      );
    }

    if (mode !== "structural" && mayPersistFact(fact) !== "granted") {
      at(
        "not_persistable",
        `“${fact.kind}” from ${fact.provenance.provider} may not be written to the trip record.`,
        { factKind: fact.kind, provider: fact.provenance.provider, id: fact.id },
      );
    }

    if (mode === "export" && mayExportFact(fact) !== "granted") {
      at(
        "not_exportable",
        `“${fact.kind}” from ${fact.provenance.provider} may not be redistributed in an exported file.`,
        { factKind: fact.kind, provider: fact.provenance.provider, id: fact.id },
      );
    }
  }

  /* -- media --------------------------------------------------------------- */

  const seenMediaIds = new Set<string>();

  for (const media of intelligence.media) {
    if (seenMediaIds.has(media.id)) {
      at(
        "duplicate_media_id",
        `Two images share the id “${media.id}”, so deduplication cannot tell them apart.`,
        { provider: media.provenance.provider, id: media.id },
      );
    }
    seenMediaIds.add(media.id);

    if (!mediaIsDisplayable(media)) {
      at(
        "media_not_displayable",
        `An image from ${media.provenance.provider} lacks the licence, credit, safe URL or alternative text needed to show it. Storing it would guarantee a breach at render time.`,
        { provider: media.provenance.provider, id: media.id },
      );
    }

    if (mode !== "structural" && mayPersistMedia(media) !== "granted") {
      at(
        "not_persistable",
        `An image from ${media.provenance.provider} may not be written to the trip record.`,
        { provider: media.provenance.provider, id: media.id },
      );
    }

    if (mode === "export" && mayExportMedia(media) !== "granted") {
      at(
        "not_exportable",
        `An image from ${media.provenance.provider} may not be redistributed in an exported file.`,
        { provider: media.provenance.provider, id: media.id },
      );
    }
  }

  return violations;
}

/** The common case, phrased as a question. */
export function intelligenceIsValid(
  intelligence: PlaceIntelligence,
  mode: ValidationMode = "structural",
): boolean {
  return validateIntelligence(intelligence, mode).length === 0;
}
