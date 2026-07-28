import "server-only";

import { z } from "zod";

import { MAX_URL_LENGTH } from "@/lib/place-intelligence";

import { WikimediaError, type WikimediaEndpoint } from "./errors";

/**
 * The parse boundary for the five Wikimedia responses Roamly reads.
 *
 * ## Nothing here leaves the adapter
 *
 * Every type in this file describes a *provider's* shape. None of it is exported from `index.ts`, and none of it is
 * assignable to anything in `lib/place-intelligence/` — that directory's types are Roamly's own vocabulary, and the
 * only bridge between the two is `normalize.ts`. The rule is the one `lib/providers/osm/schemas.ts` already follows:
 * a raw shape that escaped its adapter would make every downstream module a place where an unvalidated field could
 * surface, and the failure would present as `undefined` in an itinerary rather than as a rejected response.
 *
 * ## Not `.strict()`, and that is the opposite choice from `lib/place-intelligence/schemas.ts`
 *
 * That file rejects unknown keys, because an unexpected key in *Roamly's own* record means something wrote a field
 * nobody declared — a `rating` that would vanish silently under Zod's default stripping.
 *
 * A MediaWiki response is the other case. It legitimately carries `batchcomplete`, `warnings`, `continue`, `success`,
 * `curtimestamp` and more, none of which Roamly reads and any of which may appear without notice. Refusing them
 * would turn a routine upstream addition into an enrichment outage. So unknown keys are **stripped** at this
 * boundary and rejected at the next one: whatever `normalize.ts` builds is then re-parsed by
 * `PlaceIntelligenceSchema`, which *is* strict. Permissive where the shape is theirs, strict where it becomes ours.
 *
 * The outer envelope is still refused when it is the wrong shape — `results.bindings` missing from a SPARQL answer
 * is not an addition, it is not the response.
 *
 * ## Prototype keys, and why a record needs its own key schema
 *
 * Four of these five responses are keyed by data the provider chooses: `entities` by QID, `labels` by language,
 * `claims` by property, `extmetadata` by field name. `JSON.parse` creates `__proto__` as an ordinary own property,
 * so a payload carrying one would survive into an object Roamly then spreads and iterates. It has never been
 * observed from Wikimedia and it costs one refinement to make impossible, which is the right trade for a key that
 * turns a data field into a language feature.
 *
 * ## What is deliberately *not* validated here
 *
 * URLs are bounded and nothing more. A `thumburl` that parsed as a URL is still untrusted: it becomes an `<img src>`
 * in a traveller's browser, so scheme and host are checked by `mediaHostIsAllowed` in `media.ts`, at the moment the
 * decision to render is made. Blessing it here would leave a `SafeUrl`-shaped value that had never been near the
 * host allowlist.
 *
 * Licence names are the same. `LicenseShortName` is free text typed by a Commons uploader — "CC BY-SA 4.0",
 * "cc-by-sa-4.0", "Attribution-ShareAlike 4.0 International", or something invented. It arrives here as a bounded
 * string and stays untrusted until `media.ts` maps it through a closed table onto a `LicenceId`, where anything
 * unrecognised becomes `unknown` and is refused.
 */

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The size and shape limits every parse applies.
 *
 * Chosen against real payloads rather than tidiness. A famous landmark's Wikidata entity carries labels in several
 * hundred languages and sitelinks to as many wikis, so the term and sitelink caps are generous — they exist to
 * refuse a pathological structure, not to trim a legitimate one. The byte cap in `config.ts` is the real size
 * control; these are the structural backstop behind it.
 */
const BOUNDS = {
  /** Entities per response. `wbgetentities` is capped at 50 by the API; a little headroom above that. */
  maxEntities: 60,
  /** Languages in one `labels`, `descriptions` or `aliases` record. Wikidata really does reach the hundreds. */
  maxTermLanguages: 800,
  maxAliasesPerLanguage: 32,
  /** Distinct properties in one `claims` record. */
  maxClaimProperties: 256,
  /** Statements for one property. `instance of` reaching double figures is ordinary. */
  maxStatementsPerProperty: 64,
  /** Sitelinks on one entity. A well-covered subject has a few hundred. */
  maxSitelinks: 600,
  /** Pages in one `query.pages` array — bounded by the 50-title request cap. */
  maxPages: 64,
  /** Redirect and normalisation notices in one response. */
  maxTitleRewrites: 64,
  /** Rows in a SPARQL answer. The query's own `LIMIT` is 10; this is the backstop. */
  maxBindings: 64,
  /** `imageinfo` revisions per page. Roamly reads the first. */
  maxImageRevisions: 8,
  /** Fields in one `extmetadata` record. Filtered to ten by the request; unfiltered responses are larger. */
  maxExtMetadataFields: 64,

  maxLabelLength: 400,
  maxDescriptionLength: 512,
  maxTitleLength: 320,
  maxRecordKeyLength: 128,
  maxShortTokenLength: 128,
  /** One `extmetadata` value. `ImageDescription` is HTML and can be long; bounded well above any real caption. */
  maxExtMetadataValueLength: 65_536,
  /** A SPARQL binding value — a URI, a label, or a WKT point. */
  maxBindingValueLength: 1_024,

  /**
   * How deep a payload may nest, and how many nodes it may hold.
   *
   * A Wikidata statement is five levels deep at its worst; sixteen leaves room for a shape nobody anticipated. The
   * node count bounds the other axis: a 512 KB body of `[[[[…]]]]` is small on the wire and expensive to walk, and
   * refusing it costs one pass we are about to make anyway.
   */
  maxDepth: 16,
  maxNodes: 200_000,
} as const;

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Keys that must never name a field.
 *
 * `constructor` and `prototype` are included alongside `__proto__` even though only the first assigns through to a
 * prototype under `JSON.parse`. All three are property names whose presence in a data record means the payload is
 * describing the language rather than the subject, and a closed set of three is easier to defend than a rule about
 * which one is currently exploitable.
 */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const RecordKeySchema = z
  .string()
  .min(1)
  .max(BOUNDS.maxRecordKeyLength)
  .refine((key) => !PROTOTYPE_KEYS.has(key), {
    message: "Refused a prototype-pollution key",
  });

/**
 * A provider-keyed record, bounded in both key count and key shape.
 *
 * Wrapped in a helper rather than written out five times, because the bound that matters — "how many keys" — is the
 * one easiest to forget on the sixth record somebody adds.
 */
function boundedRecord<T extends z.ZodTypeAny>(value: T, maxKeys: number) {
  return z
    .record(RecordKeySchema, value)
    .refine((record) => Object.keys(record).length <= maxKeys, {
      message: `A record may hold at most ${maxKeys} keys`,
    });
}

/** A QID, validated to the same pattern `isValidQid` applies. Checked here because it becomes a join key. */
const QidSchema = z
  .string()
  .max(24)
  .regex(/^Q[1-9]\d*$/, "Not a Wikidata QID");

/** A URL, bounded and nothing more. Scheme and host are `media.ts`'s decision — see the module note. */
const BoundedUrlSchema = z.string().min(1).max(MAX_URL_LENGTH);

const BoundedTitleSchema = z.string().min(1).max(BOUNDS.maxTitleLength);

const ShortTokenSchema = z.string().max(BOUNDS.maxShortTokenLength);

const PositiveIntSchema = z.number().int().positive().max(1_000_000);

/* -------------------------------------------------------------------------- */
/* Structural bounds, before any schema runs                                  */
/* -------------------------------------------------------------------------- */

/**
 * Refuses a payload that is too deep or too large in node count.
 *
 * Iterative rather than recursive: a recursive walk over a hostile structure exhausts the stack, which is the
 * failure this is meant to prevent rather than a way to detect it. Runs before the Zod parse so a pathological
 * shape is refused before a schema walks it.
 */
function assertStructureBounded(
  endpoint: WikimediaEndpoint,
  payload: unknown,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: payload, depth: 0 },
  ];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;

    nodes += 1;
    if (nodes > BOUNDS.maxNodes) {
      throw new WikimediaError(
        "invalid_response",
        endpoint,
        `The response holds more than ${BOUNDS.maxNodes} values.`,
      );
    }

    const { value, depth } = current;
    if (value === null || typeof value !== "object") continue;

    if (depth >= BOUNDS.maxDepth) {
      throw new WikimediaError(
        "invalid_response",
        endpoint,
        `The response nests deeper than ${BOUNDS.maxDepth} levels.`,
      );
    }

    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }

    for (const key of Object.keys(value)) {
      /*
       * Prototype keys are refused here, not only by `RecordKeySchema`.
       *
       * Zod **silently ignores** a `__proto__` key rather than failing its key schema, so the refinement on
       * `RecordKeySchema` never fires and a payload carrying one parsed cleanly with the key dropped. Dropped is safe;
       * it is not *refused*, and the difference matters — a response containing one did not come from Wikimedia, and
       * that is worth reporting rather than quietly discarding.
       *
       * Checking it in the walk also covers every object in the payload rather than only the four keyed records, which
       * is the right scope for a key that turns a data field into a language feature.
       */
      if (PROTOTYPE_KEYS.has(key)) {
        throw new WikimediaError(
          "invalid_response",
          endpoint,
          "The response carried a prototype-pollution key.",
        );
      }

      stack.push({
        value: (value as Record<string, unknown>)[key],
        depth: depth + 1,
      });
    }
  }
}

/** Parses an outer envelope, or refuses the whole response. The one place a parse failure is fatal. */
function parseEnvelope<T>(
  endpoint: WikimediaEndpoint,
  schema: z.ZodType<T>,
  payload: unknown,
  what: string,
): T {
  assertStructureBounded(endpoint, payload);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    /*
     * The Zod issue list is deliberately not included. It quotes the offending values, and these messages are
     * logged — a schema error naming a field's contents is how a log becomes a copy of the payload.
     */
    throw new WikimediaError(
      "invalid_response",
      endpoint,
      `The Wikimedia response was not ${what}.`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Wikidata entities — Special:EntityData and wbgetentities                    */
/* -------------------------------------------------------------------------- */

/**
 * A statement's value, by `datavalue.type`.
 *
 * Five types, because five are what the seven properties Roamly reads can carry. Everything else Wikidata models —
 * quantities with units, tabular data, geoshapes, lexemes — is **dropped rather than coerced**, which is what
 * "unknown claim types dropped" means in practice: `normalize.ts` tries each of these against a statement and
 * ignores the statement when none fits, so an unrecognised type costs one absent fact instead of a parse failure
 * for the whole entity.
 */
export const GlobeCoordinateValueSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  precision: z.number().nullable().optional(),
  /** Checked in `normalize.ts`: Wikidata carries coordinates on the Moon and on Mars. */
  globe: z.string().max(256).optional(),
});

export const TimeValueSchema = z.object({
  /** Wikidata's own format, `+1501-00-00T00:00:00Z` — a leading sign and a possibly zero month and day. */
  time: z.string().max(64),
  /** 9 is a year, 10 a month, 11 a day. Anything coarser is not a date a traveller can be shown. */
  precision: z.number().int().min(0).max(14),
  calendarmodel: z.string().max(256).optional(),
});

export const EntityIdValueSchema = z.object({
  id: z.string().max(24),
  "entity-type": z.string().max(32).optional(),
});

export const MonolingualTextValueSchema = z.object({
  text: z.string().max(BOUNDS.maxLabelLength),
  language: ShortTokenSchema,
});

export const StringValueSchema = z.string().max(MAX_URL_LENGTH);

const RawTermSchema = z.object({
  language: ShortTokenSchema,
  value: z.string().max(BOUNDS.maxDescriptionLength),
});

/**
 * One statement, reduced to its main snak.
 *
 * Qualifiers and references are not modelled at all. Roamly reads seven properties and needs none of their
 * qualifiers, and `flavor=dump` already asks Wikidata not to send references — parsing what we discard would be
 * schema surface with no reader behind it.
 *
 * `datavalue` is optional because it genuinely is: a `somevalue` or `novalue` snak asserts that a property applies
 * without giving a value. Those are dropped downstream, which is the correct reading of "this entity has an
 * inception date and nobody knows it".
 */
const RawStatementSchema = z.object({
  mainsnak: z.object({
    snaktype: ShortTokenSchema,
    property: ShortTokenSchema,
    datatype: ShortTokenSchema.optional(),
    datavalue: z
      .object({ value: z.unknown(), type: ShortTokenSchema })
      .optional(),
  }),
  rank: ShortTokenSchema.optional(),
});

const RawSitelinkSchema = z.object({
  site: ShortTokenSchema,
  title: BoundedTitleSchema,
  url: BoundedUrlSchema.optional(),
});

const RawEntitySchema = z.object({
  id: QidSchema,
  labels: boundedRecord(RawTermSchema, BOUNDS.maxTermLanguages).optional(),
  descriptions: boundedRecord(
    RawTermSchema,
    BOUNDS.maxTermLanguages,
  ).optional(),
  aliases: boundedRecord(
    z.array(RawTermSchema).max(BOUNDS.maxAliasesPerLanguage),
    BOUNDS.maxTermLanguages,
  ).optional(),
  claims: boundedRecord(
    z.array(RawStatementSchema).max(BOUNDS.maxStatementsPerProperty),
    BOUNDS.maxClaimProperties,
  ).optional(),
  sitelinks: boundedRecord(RawSitelinkSchema, BOUNDS.maxSitelinks).optional(),
});

export type RawEntity = z.infer<typeof RawEntitySchema>;
export type RawStatement = z.infer<typeof RawStatementSchema>;
export type RawSitelink = z.infer<typeof RawSitelinkSchema>;

/**
 * The envelope both entity endpoints share.
 *
 * `Special:EntityData/{QID}.json` and `action=wbgetentities` return the *same* `{ entities: { QID: … } }` shape, so
 * one schema serves both rather than two that could drift apart. The differences are behavioural rather than
 * structural, and they are handled by the two wrappers below:
 *
 *  - a missing entity **404s** from `Special:EntityData`, and comes back as `{ id, missing: … }` inside a 200 from
 *    `wbgetentities`
 *  - `wbgetentities` honours `props`, so its entities are smaller; `Special:EntityData` sends everything
 */
const RawEntitiesEnvelopeSchema = z.object({
  entities: boundedRecord(z.unknown(), BOUNDS.maxEntities),
});

/**
 * What one entity response yielded, with the failures named rather than discarded.
 *
 * Three lists instead of one map, because the three mean different things to a caller: an entity that came back
 * malformed is a reason to log, an entity Wikidata reports missing is a legitimate answer worth caching, and a
 * successfully parsed entity is the only one that may produce a fact.
 */
export type RawEntityBundle = {
  entities: Map<string, RawEntity>;
  /** QIDs Wikidata reports it does not hold. A real answer: this place has no entity. */
  missing: string[];
  /** QIDs whose entity failed its schema. Discarded individually — one bad entity is not a bad batch. */
  malformed: string[];
};

function parseEntitiesEnvelope(
  endpoint: WikimediaEndpoint,
  payload: unknown,
): RawEntityBundle {
  const envelope = parseEnvelope(
    endpoint,
    RawEntitiesEnvelopeSchema,
    payload,
    "a Wikidata entity response",
  );

  const bundle: RawEntityBundle = {
    entities: new Map(),
    missing: [],
    malformed: [],
  };

  for (const [key, value] of Object.entries(envelope.entities)) {
    /*
     * `missing` is checked before the entity schema, not after it fails.
     *
     * A missing entity has no `labels`, `claims` or `sitelinks`, so `RawEntitySchema` would reject it and it would
     * be reported malformed — turning "Wikidata does not hold Q9999999" into "Wikidata sent us something broken".
     * Those need different responses: one is cacheable, the other is worth a log line.
     */
    if (
      value !== null &&
      typeof value === "object" &&
      "missing" in (value as Record<string, unknown>)
    ) {
      bundle.missing.push(key);
      continue;
    }

    const entity = RawEntitySchema.safeParse(value);
    if (!entity.success) {
      bundle.malformed.push(key);
      continue;
    }

    /*
     * Keyed by the entity's *own* id rather than by the record key.
     *
     * They agree in every response observed, and when they do not the entity's `id` is the authority — a caller
     * looking up `Q123` and receiving something whose `id` is `Q456` must not find it under `Q123`. `entity.ts`
     * checks the requested id against what came back for exactly this reason.
     */
    bundle.entities.set(entity.data.id, entity.data);
  }

  return bundle;
}

/** `Special:EntityData/{QID}.json`. A missing entity 404s, so `missing` is normally empty here. */
export function parseEntityDataResponse(payload: unknown): RawEntityBundle {
  return parseEntitiesEnvelope("wikidata-entity", payload);
}

/** `action=wbgetentities`. Reports each missing entity inside a 200, so `missing` is load-bearing. */
export function parseBatchEntitiesResponse(payload: unknown): RawEntityBundle {
  return parseEntitiesEnvelope("wikidata-api", payload);
}

/* -------------------------------------------------------------------------- */
/* Wikipedia pageprops                                                        */
/* -------------------------------------------------------------------------- */

const RawPageSchema = z.object({
  title: BoundedTitleSchema,
  ns: z.number().int().optional(),
  /** `true` under `formatversion=2`, an empty string under 1. Presence is the signal, not the value. */
  missing: z.unknown().optional(),
  invalid: z.unknown().optional(),
  pageprops: z
    .object({
      wikibase_item: QidSchema.optional(),
      /**
       * Present — as an empty string — on a disambiguation page.
       *
       * Requested explicitly alongside `wikibase_item`, because `ppprop` restricts the response to the properties
       * named. Without asking for it a disambiguation page would arrive looking like an ordinary article with an
       * entity, and Roamly would attach the *disambiguation entity's* facts to a real place.
       */
      disambiguation: z.unknown().optional(),
    })
    .optional(),
});

const RawTitleRewriteSchema = z.object({
  from: BoundedTitleSchema,
  to: BoundedTitleSchema,
});

const RawPagePropsResponseSchema = z.object({
  query: z.object({
    /** Case and underscore fixes MediaWiki applied to the title we sent. */
    normalized: z
      .array(RawTitleRewriteSchema)
      .max(BOUNDS.maxTitleRewrites)
      .optional(),
    /**
     * Renames MediaWiki followed for us.
     *
     * The only redirect handling the identity rules permit: a rename reported *in the response* is a fact we can
     * record, where an HTTP redirect chased by `fetch` would be an unverified hop to a host we did not check.
     */
    redirects: z
      .array(RawTitleRewriteSchema)
      .max(BOUNDS.maxTitleRewrites)
      .optional(),
    pages: z.array(z.unknown()).max(BOUNDS.maxPages),
  }),
});

export type RawPage = z.infer<typeof RawPageSchema>;
export type RawTitleRewrite = z.infer<typeof RawTitleRewriteSchema>;

export type RawPagePropsBundle = {
  pages: RawPage[];
  normalized: RawTitleRewrite[];
  redirects: RawTitleRewrite[];
  /** Pages whose own shape failed. Dropped individually, for the reason entities are. */
  malformed: number;
};

export function parsePagePropsResponse(payload: unknown): RawPagePropsBundle {
  const envelope = parseEnvelope(
    "wikipedia-api",
    RawPagePropsResponseSchema,
    payload,
    "a Wikipedia pageprops response",
  );

  const pages: RawPage[] = [];
  let malformed = 0;

  for (const candidate of envelope.query.pages) {
    const page = RawPageSchema.safeParse(candidate);
    if (page.success) pages.push(page.data);
    else malformed += 1;
  }

  return {
    pages,
    normalized: envelope.query.normalized ?? [],
    redirects: envelope.query.redirects ?? [],
    malformed,
  };
}

/* -------------------------------------------------------------------------- */
/* WDQS nearby search                                                         */
/* -------------------------------------------------------------------------- */

const SparqlValueSchema = z.object({
  type: ShortTokenSchema,
  value: z.string().max(BOUNDS.maxBindingValueLength),
  datatype: z.string().max(256).optional(),
  "xml:lang": ShortTokenSchema.optional(),
});

/**
 * One row of the fixed `wikibase:around` query.
 *
 * The variable names are the query's own, and the query is a private constant in `client.ts` — so this schema and
 * that template are two halves of one contract. Only `item` is required: `OPTIONAL { ?item wdt:P31 ?instanceOf }`
 * means a candidate with no `instance of` statement still returns a row, and the label service can leave
 * `itemLabel` absent for an entity with no label in either requested language.
 */
const RawBindingSchema = z.object({
  item: SparqlValueSchema,
  itemLabel: SparqlValueSchema.optional(),
  itemDescription: SparqlValueSchema.optional(),
  coord: SparqlValueSchema.optional(),
  instanceOfLabel: SparqlValueSchema.optional(),
});

const RawNearbyResponseSchema = z.object({
  results: z.object({
    bindings: z.array(z.unknown()).max(BOUNDS.maxBindings),
  }),
});

export type RawBinding = z.infer<typeof RawBindingSchema>;

export type RawNearbyBundle = {
  bindings: RawBinding[];
  malformed: number;
};

export function parseNearbyResponse(payload: unknown): RawNearbyBundle {
  const envelope = parseEnvelope(
    "wikidata-sparql",
    RawNearbyResponseSchema,
    payload,
    "a SPARQL results response",
  );

  const bindings: RawBinding[] = [];
  let malformed = 0;

  for (const candidate of envelope.results.bindings) {
    const binding = RawBindingSchema.safeParse(candidate);
    if (binding.success) bindings.push(binding.data);
    else malformed += 1;
  }

  return { bindings, malformed };
}

/* -------------------------------------------------------------------------- */
/* Commons imageinfo and extmetadata                                          */
/* -------------------------------------------------------------------------- */

/**
 * One `extmetadata` field.
 *
 * `value` is a union rather than a string because Commons sends numbers for some fields and the string `"true"` for
 * others — `AttributionRequired` in particular arrives as a string in most responses and a boolean in some. Coercion
 * happens in `normalize.ts`, where the field's own meaning is known.
 *
 * Nothing here is trusted. `LicenseShortName` is free text an uploader typed, and it stays free text until a closed
 * table in `media.ts` either recognises it or refuses the file.
 */
const RawExtMetadataFieldSchema = z.object({
  value: z
    .union([
      z.string().max(BOUNDS.maxExtMetadataValueLength),
      z.number(),
      z.boolean(),
    ])
    .optional(),
  source: ShortTokenSchema.optional(),
  hidden: z.unknown().optional(),
});

const RawImageInfoSchema = z.object({
  /** The full-size file. Bounded only — host and scheme are checked at render time. */
  url: BoundedUrlSchema.optional(),
  /** The Commons file page, which is the licence's "link to the source" obligation. */
  descriptionurl: BoundedUrlSchema.optional(),
  /** Present because `iiurlwidth` was sent. The URL Roamly actually renders. */
  thumburl: BoundedUrlSchema.optional(),
  thumbwidth: PositiveIntSchema.optional(),
  thumbheight: PositiveIntSchema.optional(),
  width: PositiveIntSchema.optional(),
  height: PositiveIntSchema.optional(),
  mime: ShortTokenSchema.optional(),
  extmetadata: boundedRecord(
    RawExtMetadataFieldSchema,
    BOUNDS.maxExtMetadataFields,
  ).optional(),
});

const RawFilePageSchema = z.object({
  title: BoundedTitleSchema,
  ns: z.number().int().optional(),
  missing: z.unknown().optional(),
  imageinfo: z
    .array(RawImageInfoSchema)
    .max(BOUNDS.maxImageRevisions)
    .optional(),
});

const RawImageInfoResponseSchema = z.object({
  query: z.object({
    pages: z.array(z.unknown()).max(BOUNDS.maxPages),
  }),
});

export type RawImageInfo = z.infer<typeof RawImageInfoSchema>;
export type RawFilePage = z.infer<typeof RawFilePageSchema>;
export type RawExtMetadataField = z.infer<typeof RawExtMetadataFieldSchema>;

export type RawImageInfoBundle = {
  pages: RawFilePage[];
  /** File titles Commons does not hold. A real answer, not a failure. */
  missing: string[];
  malformed: number;
};

export function parseImageInfoResponse(payload: unknown): RawImageInfoBundle {
  const envelope = parseEnvelope(
    "commons-api",
    RawImageInfoResponseSchema,
    payload,
    "a Commons imageinfo response",
  );

  const pages: RawFilePage[] = [];
  const missing: string[] = [];
  let malformed = 0;

  for (const candidate of envelope.query.pages) {
    const page = RawFilePageSchema.safeParse(candidate);
    if (!page.success) {
      malformed += 1;
      continue;
    }
    if (page.data.missing !== undefined) {
      missing.push(page.data.title);
      continue;
    }
    pages.push(page.data);
  }

  return { pages, missing, malformed };
}

/** Exported for the fixtures, which assert that a payload over the structural bounds is refused. */
export const STRUCTURE_BOUNDS = {
  maxDepth: BOUNDS.maxDepth,
  maxNodes: BOUNDS.maxNodes,
} as const;
