/**
 * External place intelligence — the provider-independent foundation (Checkpoint 5A).
 *
 * ## What this directory is, and what it is not
 *
 * It is the contract every future place-enrichment provider must fit into: a vocabulary of facts, a provenance
 * record that travels with each one, a freshness model, a conflict policy, and two policy modules that decide
 * what may be stored and what may be shown.
 *
 * It is **not** a provider. There is no client, no key, no fetch and no adapter anywhere in it — Checkpoint 5A is
 * the research gate, and `docs/PROVIDER_RESEARCH.md` is its output. Foursquare is recommended and not
 * implemented; Google Places and Yelp are rejected with citations; ratings, reviews, restaurant photos, crowding
 * and live prices are refused outright and refused *by name*, so enabling one would be a visible diff rather than
 * an omission nobody noticed.
 *
 * ## The one architectural decision worth reading before the rest
 *
 * Enrichment is a **sidecar** keyed by `canonicalPlaceId`, never extra fields on `TripPlace`. `TripPlace` is
 * compared field by field against the saved pool by `assertItineraryUsesPool`, so any field added to it becomes
 * part of that tampering check: an enrichment refreshing on its own schedule would read as tampering, and a fact
 * that may not be persisted could not be stripped without failing the comparison.
 *
 * A sidecar avoids both, and it buys the keyless fallback for free — drop the whole thing and a working,
 * licence-clean trip remains.
 *
 * ## Reading order
 *
 * `types` → `provenance` → `facts` / `media` → `external-identity` → `canonical` → `freshness` → `conflicts` →
 * `match` → `merge` → `persistence-policy` → `display-policy` → `validate` → `schemas`. Imports flow one way
 * along that list, so each module compiles against only its predecessors.
 */

export {
  isPermitted,
  type FactConfidence,
  type FactVolatility,
  type IsoTimestamp,
  type LicenceId,
  type Permission,
  type ProviderId,
} from "./types";

export {
  attributionIsRequired,
  licenceLinkIsRequired,
  provenanceIsComplete,
  urlIsSafe,
  MAX_URL_LENGTH,
  PROVIDER_LICENCE,
  type FactProvenance,
  type PolicySnapshot,
} from "./provenance";

export {
  factId,
  factKindIsCorroboratable,
  factKindIsOperational,
  factKindIsRefused,
  FACT_VOLATILITY,
  MAX_FACT_VALUE_LENGTH,
  OPERATIONAL_FACT_KINDS,
  REFUSED_FACT_REASONS,
  type PlaceFact,
  type PlaceFactKind,
} from "./facts";

export {
  mediaId,
  mediaIsDisplayable,
  mediaMayBeTransformed,
  type MediaKind,
  type PlaceMedia,
} from "./media";

export {
  matchIsTrusted,
  matchMethodRank,
  MINIMUM_TRUSTED_MATCH_RANK,
  type ExternalIdentity,
  type MatchMethod,
} from "./external-identity";

export {
  emptyIntelligence,
  externalIdentityFor,
  factsOfKind,
  intelligenceIsEmpty,
  type PlaceIntelligence,
} from "./canonical";

export {
  factIsExpired,
  factIsStale,
  factIsUsable,
  STALENESS_LIMIT_MS,
} from "./freshness";

export {
  detectConflicts,
  disputedKinds,
  officialSourceRuleFor,
  OFFICIAL_SOURCE_RULES,
  type ConflictResolution,
  type FactConflict,
  type OfficialSourceRule,
} from "./conflicts";

export {
  agreeingAttributes,
  identityFromProposal,
  proposeMatch,
  MATCH_ATTRIBUTES,
  MATCH_RADIUS_METERS,
  SHARED_ID_REVIEW_RADIUS_METERS,
  type CanonicalSubject,
  type MatchAttribute,
  type MatchCandidate,
  type MatchOutcome,
  type MatchProposal,
} from "./match";

export {
  mergeIntelligence,
  type MergeRefusal,
  type MergeRefusalCode,
  type MergeResult,
} from "./merge";

export {
  importRejections,
  mayCache,
  mayCopyMediaBytes,
  mayExportFact,
  mayExportMedia,
  mayPersistFact,
  mayPersistMedia,
  persistenceRefusalReason,
  stripAllForExport,
  stripIntelligenceForExport,
  type ImportRejection,
} from "./persistence-policy";

export {
  mayDisplayFact,
  mayDisplayMedia,
  requiredAttributions,
  selectDescription,
  DESCRIPTION_SOURCE_ORDER,
  REQUIRED_ATTRIBUTION,
  type DisplaySurface,
} from "./display-policy";

/**
 * Landmark enrichment scope and identity (Checkpoint 5B, sections 2 and 3).
 *
 * Both pure. Eligibility decides *whether Roamly may ask* about a place; the identity module decides *what it may ask*
 * and *whether an answer may be attached*. Neither fetches, which is what makes "no provider call on the landing page"
 * a property of the code rather than a rule somebody has to remember.
 */
export {
  isLandmarkEligible,
  landmarkEligibility,
  selectLandmarkCandidates,
  MAX_LANDMARK_CANDIDATES_PER_TRIP,
  type EligibilityRefusalCode,
  type LandmarkCandidate,
  type LandmarkEligibility,
} from "./landmark-eligibility";

export {
  evaluateWikidataCandidate,
  isValidQid,
  looksLikeBranch,
  parseWikipediaTag,
  planWikidataLookup,
  toleranceMetersFor,
  LANDMARK_AREA_TOLERANCE_METERS,
  LANDMARK_POINT_TOLERANCE_METERS,
  type WikidataCandidate,
  type WikidataLookupPlan,
  type WikidataMatchOutcome,
  type WikipediaReference,
} from "./wikidata-identity";

export {
  intelligenceIsValid,
  validateIntelligence,
  type IntelligenceViolation,
  type IntelligenceViolationCode,
  type ValidationMode,
} from "./validate";

export {
  ExternalIdentitySchema,
  FactConfidenceSchema,
  FactProvenanceSchema,
  LicenceIdSchema,
  MatchMethodSchema,
  PermissionSchema,
  PlaceFactKindSchema,
  PlaceFactSchema,
  PlaceIntelligenceSchema,
  PlaceMediaSchema,
  PolicySnapshotSchema,
  ProviderIdSchema,
  type ParsedPlaceIntelligence,
} from "./schemas";
