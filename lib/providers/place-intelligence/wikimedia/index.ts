/**
 * The Wikimedia landmark-enrichment adapter (Checkpoint 5B, section 4).
 *
 * ## What crosses this boundary, and what cannot
 *
 * Four questions and their answers: fetch an entity by QID, resolve a Wikipedia title to a QID, find candidates near
 * a place, and turn a Commons file into a licensed `PlaceMedia`. Everything else is private.
 *
 * Three things are deliberately absent, and their absence is the point:
 *
 *  - **`fetchWikimedia`.** The transport is not part of the surface. A caller holding it could issue any of the five
 *    requests directly, skipping the QID validation in `entity.ts`, the title rules in `resolve.ts`, the trust gate in
 *    `media.ts` and every cache. The one legitimate reason to reach it is adding a sixth endpoint, which is a research
 *    question rather than an import.
 *  - **Every symbol from `schemas.ts`.** Those types describe a provider's response shape. Exporting one would make
 *    it assignable in a module that had never parsed anything, which is how a raw payload ends up in a domain record.
 *  - **`config.ts`'s endpoint constants.** A URL is not something a caller needs.
 *
 * ## `server-only`, all the way down
 *
 * Every module behind this barrel imports `server-only`, so importing this from a client component fails the build
 * rather than shipping a `User-Agent` a browser cannot set. That is not merely tidiness: Wikimedia's policy requires a
 * descriptive `User-Agent`, browsers do not permit setting one, and a client-side implementation would have to either
 * violate the policy or use a second header path.
 *
 * ## Reading order
 *
 * `config` → `errors` → `client` → `schemas` → `normalize` → `cache` → `entity` / `resolve` / `search` →
 * `summary` / `media`. Imports flow one way along that list.
 */

export {
  WikimediaError,
  isWikimediaError,
  toWikimediaError,
  type WikimediaEndpoint,
  type WikimediaErrorKind,
} from "./errors";

/**
 * The configuration gate, and nothing else from the client.
 *
 * `wikimediaClientIsUsable` is exported so the orchestrator can skip a whole run rather than fail twelve places one at
 * a time to learn the same thing, and `userAgentProblem` so a health check can say *what* is wrong.
 */
export { userAgentProblem, wikimediaClientIsUsable } from "./client";

export {
  DEFAULT_ENTITY_LANGUAGE,
  fetchEntities,
  fetchEntity,
  type EntityLookup,
} from "./entity";

export {
  articleTitleProblem,
  resolveWikipediaTitle,
  type TitleResolution,
} from "./resolve";

export { searchNearby, type NearbyOutcome } from "./search";

export {
  buildLandmarkFacts,
  buildLandmarkSummary,
  descriptionProblem,
  summaryProblem,
  MAX_SUMMARY_LENGTH,
  MAX_SUMMARY_SENTENCES,
  type LandmarkSummary,
  type SummaryField,
} from "./summary";

export {
  fetchLandmarkMedia,
  COMMONS_LICENCES,
  type MediaOutcome,
  type MediaRefusalCode,
} from "./media";

/**
 * The normalized entity, and the date the terms behind it were read.
 *
 * `NormalizedEntity` is Roamly's own flat record rather than a provider shape — the claim tree stops in
 * `normalize.ts` — so it may cross the boundary. The orchestrator needs it to build facts, a summary and a media
 * lookup from one fetch.
 */
export { WIKIMEDIA_TERMS_READ_ON, type NormalizedEntity } from "./normalize";

/** Diagnostics and tests. Not a way to read or write a cached value — `readCache` stays private. */
export { clearWikimediaCache, wikimediaCacheStats } from "./cache";
