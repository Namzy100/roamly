import "server-only";

import { isValidQid } from "@/lib/place-intelligence";

import { readCache, writeCache, writeEmptyCache } from "./cache";
import { fetchWikimedia } from "./client";
import { WIKIMEDIA_LIMITS } from "./config";
import { WikimediaError, isWikimediaError } from "./errors";
import { normalizeEntity, type NormalizedEntity } from "./normalize";
import {
  parseBatchEntitiesResponse,
  parseEntityDataResponse,
  type RawEntity,
  type RawEntityBundle,
} from "./schemas";

/**
 * Fetching Wikidata entities Roamly already knows the identifier for.
 *
 * ## This module is the *end* of the identity ladder, not a step on it
 *
 * Everything here begins with a QID in hand — from an OSM `wikidata` tag, or from a Wikipedia title the official
 * pageprops endpoint resolved. That is why nothing here searches, and why `fetchEntity` returning `found` is
 * terminal: the checkpoint's rule is that a direct success must never fall through to a geographic search, and the
 * cleanest way to guarantee it is a function that cannot search at all. The orchestrator reads the arm it got and
 * stops.
 *
 * The distinction matters because falling through would be *worse* than failing. A QID that resolved to a real
 * entity is two sources agreeing; replacing it with a nearby guess would swap a rank-3 identity for a rank-1 one and
 * silently downgrade the trust the whole enrichment rests on.
 *
 * ## `Special:EntityData` first, `wbgetentities` as the size fallback
 *
 * `docs/PROVIDER_RESEARCH.md` records `Special:EntityData/{QID}.json` as the documented recommendation for a known
 * entity, so that is the direct path. It has one practical problem: it honours no property filter, so a
 * comprehensively edited landmark — labels in three hundred languages, sitelinks to as many wikis — can exceed the
 * 512 KB response cap, and it would be exactly the famous places a traveller most wants enriched that failed.
 *
 * So a `response_too_large` is retried **once, as a narrower request**: the same QID through `wbgetentities`, which
 * honours `props` and `sitefilter` and returns a fraction of the bytes. That is not the retry
 * `WikimediaError.retryable` forbids — it is not the same request again, it is a smaller question, and asking it
 * costs one call to rescue the entity rather than losing it.
 */

/**
 * The language a lookup uses when the caller has no better answer.
 *
 * English, and the reason is narrow: Wikidata's label fallback needs *a* language to start from, and English is the
 * one language every entity Roamly would ask about is overwhelmingly likely to have a label in. Where the OSM record
 * carries a `wikipedia` tag its language is a genuinely better answer — a Portuguese landmark should be described in
 * Portuguese — and the orchestrator passes it. This is the floor, not a preference.
 */
export const DEFAULT_ENTITY_LANGUAGE = "en";

export type EntityLookup =
  | { status: "found"; entity: NormalizedEntity; cacheHit: boolean }
  /** Wikidata does not hold this QID. A real answer, cached briefly, and not a failure of the request. */
  | { status: "missing"; cacheHit: boolean };

type LookupOptions = {
  language?: string;
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * One entity by QID.
 *
 * The QID is validated *before* a cache key is built, let alone a request. `isValidQid` has already run at the OSM
 * boundary and again in `client.ts`; this is the third check, and the duplication is deliberate for the reason that
 * module documents — a malformed value here becomes part of a URL path.
 */
export async function fetchEntity(
  qid: string,
  options: LookupOptions = {},
): Promise<EntityLookup> {
  const language = options.language ?? DEFAULT_ENTITY_LANGUAGE;

  if (!isValidQid(qid)) {
    throw new WikimediaError(
      "misconfigured",
      "wikidata-entity",
      "Refused an entity lookup for a value that is not a QID.",
    );
  }

  const key = { qid, language };

  const cached = readCache<EntityLookup>("wd-entity", key);
  if (cached) return { ...cached, cacheHit: true };

  const result = await fetchDirect(qid, language, options);
  const lookup = readBundle(
    result.bundle,
    qid,
    language,
    result.endpoint === "direct" ? "wikidata-entity" : "wikidata-api",
  );

  if (lookup.status === "missing") {
    /* An absence is cached under the short TTL: it is the answer most likely to change as Wikidata gains coverage. */
    writeEmptyCache("wd-entity", key, lookup);
  } else {
    writeCache("wd-entity", key, lookup);
  }

  return lookup;
}

/**
 * `Special:EntityData`, falling back to a narrower `wbgetentities` when the body is over the cap.
 *
 * Only `response_too_large` triggers the fallback. A 403, a 429 or a malformed payload would be answered identically
 * by the second endpoint, so re-asking would be one more request to learn the same thing — which is precisely what
 * `abandonsRun` exists to prevent.
 */
async function fetchDirect(
  qid: string,
  language: string,
  options: LookupOptions,
): Promise<{ bundle: RawEntityBundle; endpoint: "direct" | "batch" }> {
  try {
    const payload = await fetchWikimedia(
      { kind: "entity", qid, language },
      { signal: options.signal, requestId: options.requestId },
    );
    return { bundle: parseEntityDataResponse(payload), endpoint: "direct" };
  } catch (error) {
    if (!isWikimediaError(error) || error.kind !== "response_too_large") {
      throw error;
    }

    const payload = await fetchWikimedia(
      { kind: "batch-entities", qids: [qid], language },
      { signal: options.signal, requestId: options.requestId },
    );
    return { bundle: parseBatchEntitiesResponse(payload), endpoint: "batch" };
  }
}

/**
 * Up to the documented maximum of entities in one request.
 *
 * ## Why the batch exists at all
 *
 * Etiquette asks for batching over a sequence of single calls, and a trip can carry twelve landmarks. Twelve
 * `Special:EntityData` requests is twelve round trips against a service that offers to answer fifty at once.
 *
 * ## The two-level cache, and why both keys are needed
 *
 * The batch answer is cached under its own key — the sorted QID list plus the language — because that is the question
 * asked, and a batch of ten is not answerable from ten separate entries when one of them is absent.
 *
 * Every entity it returns *also* warms the per-QID cache. Without that, a batch followed by a direct lookup for one
 * of its members would re-ask Wikidata for something already in memory, which is the traffic the etiquette page
 * objects to. Two keys, one fetch.
 */
export async function fetchEntities(
  qids: readonly string[],
  options: LookupOptions = {},
): Promise<{
  entities: Map<string, NormalizedEntity>;
  missing: string[];
  cacheHit: boolean;
}> {
  const language = options.language ?? DEFAULT_ENTITY_LANGUAGE;

  /* Deduplicated and sorted, so the same set of places always produces one cache key and one request. */
  const unique = [...new Set(qids)].sort();

  for (const qid of unique) {
    if (!isValidQid(qid)) {
      throw new WikimediaError(
        "misconfigured",
        "wikidata-api",
        "Refused a batch containing a value that is not a QID.",
      );
    }
  }

  if (unique.length === 0) {
    return { entities: new Map(), missing: [], cacheHit: false };
  }
  if (unique.length > WIKIMEDIA_LIMITS.maxEntitiesPerRequest) {
    /*
     * Refused rather than chunked.
     *
     * Chunking would be easy and would hide the real problem: the caller has more places than the trip cap allows,
     * and `MAX_LANDMARK_CANDIDATES_PER_TRIP` is twelve. A batch over fifty means something upstream stopped applying
     * the cap, and silently issuing two requests would make that invisible.
     */
    throw new WikimediaError(
      "misconfigured",
      "wikidata-api",
      `A batch may hold at most ${WIKIMEDIA_LIMITS.maxEntitiesPerRequest} entities.`,
    );
  }

  const batchKey = { qids: unique, language };

  const cached = readCache<{
    entities: Array<[string, NormalizedEntity]>;
    missing: string[];
  }>("wd-entities", batchKey);
  if (cached) {
    return {
      entities: new Map(cached.entities),
      missing: cached.missing,
      cacheHit: true,
    };
  }

  const payload = await fetchWikimedia(
    { kind: "batch-entities", qids: unique, language },
    { signal: options.signal, requestId: options.requestId },
  );
  const bundle = parseBatchEntitiesResponse(payload);

  const entities = new Map<string, NormalizedEntity>();
  for (const [qid, raw] of bundle.entities) {
    const entity = normalizeEntity(raw, language);
    entities.set(qid, entity);
    /* Warms the direct cache, so a later single lookup is free. */
    writeCache<EntityLookup>(
      "wd-entity",
      { qid, language },
      { status: "found", entity, cacheHit: false },
    );
  }

  for (const qid of bundle.missing) {
    writeEmptyCache<EntityLookup>(
      "wd-entity",
      { qid, language },
      { status: "missing", cacheHit: false },
    );
  }

  /*
   * A `Map` does not survive the cache as itself in any future implementation backed by JSON, so the entries are
   * stored as a plain array. The in-memory cache would keep the `Map` intact today; relying on that would make
   * swapping in an external cache a silent data-shape change rather than a configuration one.
   */
  writeCache("wd-entities", batchKey, {
    entities: [...entities.entries()],
    missing: bundle.missing,
  });

  return { entities, missing: bundle.missing, cacheHit: false };
}

/**
 * The bundle for one requested QID, as a lookup.
 *
 * The requested id is checked against what came back. Wikidata answers a request for a *redirected* entity with the
 * target's data under the target's id, which is legitimate and is also the one case where believing the record key
 * would attach one entity's facts under another's identifier. So the entity that actually arrived is what gets
 * normalized, and its own `id` is the one recorded — reporting the id we asked for would store a pointer that
 * resolves to something else.
 */
function readBundle(
  bundle: RawEntityBundle,
  qid: string,
  language: string,
  endpoint: "wikidata-entity" | "wikidata-api",
): EntityLookup {
  if (bundle.missing.includes(qid)) {
    return { status: "missing", cacheHit: false };
  }

  const raw = bundle.entities.get(qid) ?? firstEntity(bundle);
  if (!raw) {
    if (bundle.malformed.length > 0) {
      throw new WikimediaError(
        "invalid_response",
        endpoint,
        "The requested entity failed its schema.",
      );
    }
    return { status: "missing", cacheHit: false };
  }

  return {
    status: "found",
    entity: normalizeEntity(raw, language),
    cacheHit: false,
  };
}

/** The single entity in a one-QID response, whatever it is keyed by. Only meaningful when exactly one came back. */
function firstEntity(bundle: RawEntityBundle): RawEntity | undefined {
  if (bundle.entities.size !== 1) return undefined;
  for (const entity of bundle.entities.values()) return entity;
  return undefined;
}
