import type { PlaceIntelligence } from "./canonical";
import type { ExternalIdentity, MatchMethod } from "./external-identity";
import { factId, type PlaceFact, type PlaceFactKind } from "./facts";
import { mediaId, type PlaceMedia } from "./media";
import type { FactProvenance, PolicySnapshot } from "./provenance";
import type { LicenceId, ProviderId } from "./types";

/**
 * Builders for place-intelligence tests.
 *
 * ## Why the defaults are the *valid* case
 *
 * Every builder returns something that passes every gate, and each test breaks exactly one thing. That is what makes a
 * failure readable: `fact({ provenance: provenance({ licence: "unknown" }) })` says what is under test in the call, where a
 * literal spelling out fourteen fields would bury it.
 *
 * It also means a new required field breaks the builders once rather than sixty test cases — the reason
 * `lib/refinement/test-fixtures.ts` builds its plan by running the real assembler.
 *
 * ## The policy snapshots mirror the research document
 *
 * `POLICY_BY_PROVIDER` is the permission set each provider's data would legitimately carry under
 * `docs/PROVIDER_RESEARCH.md`. Tests pinning the policy matrix use these, so "Google may not persist" is asserted against a
 * snapshot Google's terms would actually produce rather than against a strawman.
 */

/** `2026-07-28`, the date the provider terms in `docs/PROVIDER_RESEARCH.md` were read. */
export const TERMS_READ_ON = "2026-07-28";

export const NOW = "2026-07-28T12:00:00.000Z";

/**
 * The permissions each provider's data carries, per the research document.
 *
 * Foursquare's `unresolved` persistence is the load-bearing entry: the licence grants caching but defers the duration to a
 * document that could not be retrieved, and unresolved is treated exactly as denied.
 */
export const POLICY_BY_PROVIDER: Record<ProviderId, PolicySnapshot> = {
  openstreetmap: {
    persistence: "granted",
    display: "granted",
    export: "granted",
    termsReadOn: TERMS_READ_ON,
  },
  mock: {
    persistence: "granted",
    display: "granted",
    export: "granted",
    termsReadOn: TERMS_READ_ON,
  },
  wikidata: {
    persistence: "granted",
    display: "granted",
    export: "granted",
    termsReadOn: TERMS_READ_ON,
  },
  "wikimedia-commons": {
    persistence: "granted",
    display: "granted",
    export: "granted",
    termsReadOn: TERMS_READ_ON,
  },
  "open-meteo": {
    persistence: "denied",
    display: "granted",
    export: "denied",
    termsReadOn: TERMS_READ_ON,
  },
  foursquare: {
    persistence: "unresolved",
    display: "granted",
    export: "denied",
    termsReadOn: TERMS_READ_ON,
  },
  "google-places": {
    persistence: "denied",
    display: "granted",
    export: "denied",
    termsReadOn: TERMS_READ_ON,
  },
  yelp: {
    persistence: "denied",
    display: "granted",
    export: "denied",
    termsReadOn: TERMS_READ_ON,
  },
  besttime: {
    persistence: "denied",
    display: "denied",
    export: "denied",
    termsReadOn: TERMS_READ_ON,
  },
  ticketmaster: {
    persistence: "denied",
    display: "denied",
    export: "denied",
    termsReadOn: TERMS_READ_ON,
  },
};

const LICENCE_BY_PROVIDER: Record<ProviderId, LicenceId> = {
  openstreetmap: "ODbL-1.0",
  mock: "CC0-1.0",
  wikidata: "CC0-1.0",
  "wikimedia-commons": "CC-BY-SA-4.0",
  "open-meteo": "CC-BY-4.0",
  foursquare: "proprietary",
  "google-places": "proprietary",
  yelp: "proprietary",
  besttime: "proprietary",
  ticketmaster: "proprietary",
};

/** A credit line for every licence that demands one, so the default fixture is always complete. */
const ATTRIBUTION_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  openstreetmap: "© OpenStreetMap contributors (ODbL)",
  "wikimedia-commons": "Photo by A. Photographer, CC BY-SA 4.0",
  "open-meteo": "Weather data by Open-Meteo (CC BY 4.0)",
  foursquare: "Powered by Foursquare",
  "google-places": "Google Maps",
  yelp: "Yelp",
  besttime: "BestTime.app",
  ticketmaster: "Ticketmaster",
};

export function provenance(
  overrides: Partial<FactProvenance> & { provider?: ProviderId } = {},
): FactProvenance {
  const provider = overrides.provider ?? "wikidata";
  const licence = overrides.licence ?? LICENCE_BY_PROVIDER[provider];
  const attribution = ATTRIBUTION_BY_PROVIDER[provider];

  const base: FactProvenance = {
    provider,
    retrievedAt: NOW,
    licence,
    policy: POLICY_BY_PROVIDER[provider],
    ...(attribution ? { attributionText: attribution } : {}),
    ...(licence === "CC-BY-4.0" || licence === "CC-BY-SA-4.0"
      ? { licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" }
      : {}),
  };

  return { ...base, ...overrides };
}

/**
 * `provider` is a *shorthand* for building the provenance, not a field on the record.
 *
 * It is destructured out before the spread on purpose. Leaving it in would put a stray `provider` key on the fact itself,
 * which `.strict()` rejects — and the failure would surface as "a merged fact does not parse" several modules away from the
 * fixture that caused it. (It did, once. Hence this note.)
 */
export function fact(
  overrides: Partial<PlaceFact> & {
    kind?: PlaceFactKind;
    provider?: ProviderId;
  } = {},
): PlaceFact {
  const { provider, ...rest } = overrides;
  const kind = rest.kind ?? "phone";
  const source =
    rest.provenance ?? provenance(provider ? { provider } : {});

  return {
    id: factId({
      provider: source.provider,
      kind,
      ...(rest.subjectAt ? { subjectAt: rest.subjectAt } : {}),
    }),
    kind,
    value: "+351 21 123 4567",
    confidence: "reported",
    provenance: source,
    ...rest,
  };
}

export function media(
  overrides: Partial<PlaceMedia> & { provider?: ProviderId } = {},
): PlaceMedia {
  const { provider, ...rest } = overrides;
  const source =
    rest.provenance ?? provenance({ provider: provider ?? "wikimedia-commons" });

  return {
    id: mediaId({
      provider: source.provider,
      fileIdentifier: "File:Example.jpg",
    }),
    kind: "photo",
    url: "https://upload.wikimedia.org/example.jpg",
    creator: "A. Photographer",
    altText: "The tiled façade of the museum, seen from the street.",
    transformationPermitted: true,
    provenance: source,
    ...rest,
  };
}

export function identity(
  overrides: Partial<ExternalIdentity> & {
    provider?: ProviderId;
    method?: MatchMethod;
  } = {},
): ExternalIdentity {
  return {
    provider: overrides.provider ?? "wikidata",
    externalId: "Q12345",
    canonicalPlaceId: "osm:node:1001",
    method: overrides.method ?? "shared-external-id",
    matchedAt: NOW,
    evidence: "Both records carry the external id Q12345.",
    ...overrides,
  };
}

export function sidecar(
  overrides: Partial<PlaceIntelligence> = {},
): PlaceIntelligence {
  return {
    canonicalPlaceId: "osm:node:1001",
    identities: [],
    facts: [],
    media: [],
    ...overrides,
  };
}
