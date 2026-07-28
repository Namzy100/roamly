import type { PlaceIntelligence } from "./canonical";
import { FACT_VOLATILITY, factKindIsRefused, type PlaceFact } from "./facts";
import type { PlaceMedia } from "./media";
import { provenanceIsComplete } from "./provenance";
import type { Permission, ProviderId } from "./types";

/**
 * What may be written down, and what may leave the machine.
 *
 * ## This file is `docs/PROVIDER_RESEARCH.md`, executable
 *
 * The research document ends in a table of which external facts Roamly may fetch, persist, export and display. A table in
 * Markdown is a description; a reviewer has to remember it. These functions are the same table as a decision, so a
 * provider adapter written a year from now cannot widen the permission by forgetting to read the docs — it has to change
 * this file, in a diff, with a citation.
 *
 * ## Three separate questions, because the answers differ
 *
 * **Cache** — may this sit in a server-side memory cache for the length of a request or two? The weakest permission, and
 * the one most providers grant.
 *
 * **Persist** — may this go into the trip record in the traveller's `localStorage`, indefinitely? This is where Google and
 * Yelp fail: Google forbids storing Places content at all beyond place ids, Yelp caps any storage at 24 hours, and
 * Roamly's records have no expiry.
 *
 * **Export** — may this be written into a portable JSON file the traveller keeps and could publish? Strictly stronger than
 * persist, because an exported file is outside any deletion mechanism we control — which is exactly the obligation
 * Foursquare's terms impose, and the reason its facts stay refused for export even once the caching window is resolved.
 *
 * A single `mayStore` would collapse the three and would have to answer with the weakest, which would throw away the
 * caching Foursquare does grant.
 */

/** Providers whose data may enter a server-side cache at all. */
const CACHEABLE: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "openstreetmap",
  "mock",
  "wikidata",
  "wikimedia-commons",
  "open-meteo",
]);

/**
 * Providers whose normalised facts may be written into the trip record.
 *
 * Note who is absent. **Foursquare is not here**, and will not be until its caching window is retrieved from the Usage
 * Guidelines — the licence agreement grants caching "applicable to your Account-type" and defers the duration to a
 * document that 404'd. An unresolved duration is not a long one.
 */
const PERSISTABLE: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "openstreetmap",
  "mock",
  "wikidata",
  "wikimedia-commons",
]);

/**
 * Providers whose data may be written into an exported file.
 *
 * Only licences surviving redistribution to a third party: ODbL with attribution, CC0 without, and Commons per file.
 * Everything proprietary is excluded — an export is redistribution, and every commercial agreement researched forbids
 * making the data available in bulk to third parties.
 */
const EXPORTABLE: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "openstreetmap",
  "mock",
  "wikidata",
  "wikimedia-commons",
]);

/** Why a provider cannot be persisted, for a message that says something useful. */
const PERSIST_REFUSALS: Partial<Record<ProviderId, string>> = {
  "google-places":
    "Google forbids pre-fetching, caching or storing Places content; only place ids may be stored, and an id alone adds nothing to an OSM place.",
  yelp: "Yelp caps storage of any of its data at 24 hours, and Roamly's trip records have no expiry.",
  foursquare:
    "Caching is permitted but the duration is unresolved — the Usage Guidelines the licence defers to could not be retrieved. Unresolved is treated as denied.",
  besttime:
    "Not adopted: rejected on cost, and its data cannot support the claim it would imply.",
  ticketmaster:
    "Not adopted: attribution and caching terms are unresolved in the API documentation.",
  "open-meteo":
    "A forecast is perishable. Stored in a trip record it becomes a confident statement about weather that has already happened.",
};

export function mayCache(provider: ProviderId): Permission {
  return CACHEABLE.has(provider) ? "granted" : "denied";
}

/**
 * Whether one fact may be written into the trip record.
 *
 * Five gates, in the order that makes the refusal most informative:
 *
 *  1. the fact kind is refused outright — a rating is refused whoever supplies it
 *  2. the fact is perishable — a forecast in a saved trip is a lie with a timestamp
 *  3. the provider is not on the persistable list
 *  4. the provenance cannot discharge its own attribution obligation
 *  5. the *recorded* policy claims a permission the current table no longer grants
 *
 * Gate 4 matters more than it looks: a CC BY-SA photo persisted without its credit line produces a licence breach at
 * *display* time, in a component, long after the decision that caused it.
 *
 * Gate 5 exists because terms change. A fact fetched when a permission was granted, and stored, is exactly the record that
 * becomes a breach when the permission is withdrawn — and it is undiscoverable if the only record of the permission is
 * today's lookup. The current table always wins.
 */
export function mayPersistFact(fact: PlaceFact): Permission {
  if (factKindIsRefused(fact.kind)) return "denied";
  if (FACT_VOLATILITY[fact.kind] === "perishable") return "denied";
  if (!PERSISTABLE.has(fact.provenance.provider)) return "denied";
  if (!provenanceIsComplete(fact.provenance)) return "denied";
  if (fact.provenance.policy.persistence !== "granted") return "denied";
  return "granted";
}

/** Whether one fact may be written into an exported file. Strictly stronger than persistence. */
export function mayExportFact(fact: PlaceFact): Permission {
  if (mayPersistFact(fact) !== "granted") return "denied";
  if (!EXPORTABLE.has(fact.provenance.provider)) return "denied";
  return fact.provenance.policy.export === "granted" ? "granted" : "denied";
}

/**
 * Whether an image may be persisted, and whether the bytes may be copied to our own server.
 *
 * Commons explicitly permits downloading to your own server, which is what makes it the accepted media source — but only
 * per file, and only once the file's own licence is known. An `unknown` licence is refused for both, which is
 * `provenanceIsComplete`'s job.
 */
export function mayPersistMedia(media: PlaceMedia): Permission {
  if (!PERSISTABLE.has(media.provenance.provider)) return "denied";
  if (!provenanceIsComplete(media.provenance)) return "denied";
  return media.provenance.policy.persistence === "granted"
    ? "granted"
    : "denied";
}

export function mayExportMedia(media: PlaceMedia): Permission {
  if (mayPersistMedia(media) !== "granted") return "denied";
  if (!EXPORTABLE.has(media.provenance.provider)) return "denied";
  return media.provenance.policy.export === "granted" ? "granted" : "denied";
}

export function mayCopyMediaBytes(media: PlaceMedia): Permission {
  if (media.provenance.provider !== "wikimedia-commons") return "denied";
  return provenanceIsComplete(media.provenance) ? "granted" : "denied";
}

/**
 * The sentence explaining a refusal.
 *
 * Written for a developer reading a log or a test failure, not for a traveller: a persistence refusal is never something a
 * traveller did, so it never reaches the interface.
 */
export function persistenceRefusalReason(fact: PlaceFact): string | null {
  if (mayPersistFact(fact) === "granted") return null;

  if (factKindIsRefused(fact.kind)) {
    return `The fact kind “${fact.kind}” is refused by Checkpoint 5A regardless of provider.`;
  }
  if (FACT_VOLATILITY[fact.kind] === "perishable") {
    return `“${fact.kind}” is perishable and must be fetched for display, never stored.`;
  }
  const byProvider = PERSIST_REFUSALS[fact.provenance.provider];
  if (byProvider) return byProvider;
  if (!provenanceIsComplete(fact.provenance)) {
    return `The provenance is incomplete: licence “${fact.provenance.licence}” requires a credit this record does not carry.`;
  }
  if (fact.provenance.policy.persistence !== "granted") {
    return `The recorded policy for this fact was “${fact.provenance.policy.persistence}” when it was fetched on ${fact.provenance.policy.termsReadOn}.`;
  }
  return `Provider “${fact.provenance.provider}” is not approved for persistence.`;
}

/* -------------------------------------------------------------------------- */
/* The export and import boundary                                             */
/* -------------------------------------------------------------------------- */

/**
 * A sidecar with everything unexportable removed.
 *
 * **Strip, not refuse.** An export must not fail because a forecast happened to be in memory — the traveller asked for
 * their trip, and the trip is exportable even when some enrichment is not. So the file gets the subset that may leave, and
 * the rest simply is not written.
 *
 * That is the opposite of the import rule below, and deliberately so: on the way out we control what is written and can
 * make it correct; on the way in the file already exists, and containing something unexportable means it was produced by
 * something that ignored this policy — which is a fact about the file worth refusing over.
 */
export function stripIntelligenceForExport(
  intelligence: PlaceIntelligence,
): PlaceIntelligence {
  return {
    ...intelligence,
    facts: intelligence.facts.filter(
      (fact) => mayExportFact(fact) === "granted",
    ),
    media: intelligence.media.filter(
      (media) => mayExportMedia(media) === "granted",
    ),
  };
}

/** The same, for a whole trip's worth of sidecars. Empty sidecars are dropped rather than exported hollow. */
export function stripAllForExport(
  entries: PlaceIntelligence[],
): PlaceIntelligence[] {
  return entries
    .map(stripIntelligenceForExport)
    .filter(
      (entry) =>
        entry.facts.length > 0 ||
        entry.media.length > 0 ||
        entry.identities.length > 0,
    );
}

export type ImportRejection = {
  canonicalPlaceId: string;
  reason: string;
};

/**
 * Why an imported sidecar may not be accepted, or an empty list.
 *
 * Refuses rather than strips, for the reason above: a file containing an unexportable fact was written by something that
 * did not apply this policy, and quietly cleaning it would hide that. The traveller is told the file was rejected and why
 * — which is also the only way a bug in an exporter ever gets noticed.
 */
export function importRejections(
  entries: PlaceIntelligence[],
): ImportRejection[] {
  const rejections: ImportRejection[] = [];

  for (const entry of entries) {
    for (const fact of entry.facts) {
      if (mayExportFact(fact) === "granted") continue;
      rejections.push({
        canonicalPlaceId: entry.canonicalPlaceId,
        reason:
          persistenceRefusalReason(fact) ??
          `“${fact.kind}” from ${fact.provenance.provider} may not be redistributed in a file.`,
      });
    }
    for (const media of entry.media) {
      if (mayExportMedia(media) === "granted") continue;
      rejections.push({
        canonicalPlaceId: entry.canonicalPlaceId,
        reason: `An image from ${media.provenance.provider} may not be redistributed in a file.`,
      });
    }
  }

  return rejections;
}
