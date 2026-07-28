import { z } from "zod";

import { MAX_FACT_VALUE_LENGTH } from "./facts";
import {
  attributionIsRequired,
  licenceLinkIsRequired,
  MAX_URL_LENGTH,
  urlIsSafe,
} from "./provenance";

/**
 * The parse boundary for external place intelligence.
 *
 * ## Why schemas as well as types
 *
 * The types in this directory describe what the code expects. These schemas describe what may *arrive* — from a provider
 * adapter, or out of `localStorage` written by an older build — and the two need to be different artefacts for the reason
 * `lib/schemas/` already exists: a `type` is erased at runtime and cannot refuse anything.
 *
 * Two boundaries specifically:
 *
 *  - **an adapter's output**, the first moment a provider's data becomes Roamly's. Parsing here is what stops a raw response
 *    leaking through as a `PlaceFact` whose `value` is an object nobody expected.
 *  - **rehydration**, if a sidecar is ever persisted. A stored record written before a fact kind existed must fail closed
 *    rather than arrive as an unrecognised string.
 *
 * ## Strict, and deliberately so
 *
 * `.strict()` on every object. Zod's default strips unknown keys silently, which is the failure `lib/ai/prohibited.ts` was
 * written to catch in model output: a provider that helpfully adds `"rating": 4.6` — or a `"raw"` blob of its own response —
 * would have it vanish with nobody informed, and the next schema change might give it somewhere to land. A rejection is
 * louder and correct.
 *
 * That is what makes "no raw response field" and "no anonymous fact" enforced rather than hoped for: an unknown key is a
 * parse error, and `provenance` is required.
 *
 * ## The URL rules live in `provenance.ts`
 *
 * `urlIsSafe` is reused rather than reimplemented as a Zod regex. One definition of "a URL we may store" means the parse
 * boundary and the display gate cannot disagree — and a regex would have to encode scheme rules that are easier to read as
 * a `URL` construction and a set membership.
 */

export const ProviderIdSchema = z.enum([
  "openstreetmap",
  "mock",
  "wikidata",
  "wikimedia-commons",
  "open-meteo",
  "foursquare",
  "google-places",
  "yelp",
  "besttime",
  "ticketmaster",
]);

export const LicenceIdSchema = z.enum([
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "ODbL-1.0",
  "public-domain",
  "proprietary",
  "unknown",
]);

export const PermissionSchema = z.enum(["granted", "denied", "unresolved"]);

export const FactConfidenceSchema = z.enum([
  "reported",
  "corroborated",
  "disputed",
]);

export const PlaceFactKindSchema = z.enum([
  "phone",
  "website",
  "opening-hours",
  "address",
  "category",
  "business-status",
  "wheelchair-access",
  "outdoor-seating",
  "cuisine",
  "dietary-option",
  "reservable",
  "wikidata-id",
  "inception-year",
  "heritage-status",
  "weather-forecast",
  "live-busyness",
  "temporary-closure",
  "event",
  "rating",
  "review-count",
  "review-excerpt",
  "price-level",
  "popularity",
  "forecast-crowding",
  "editorial-summary",
  "live-price",
]);

export const MatchMethodSchema = z.enum([
  "shared-external-id",
  "provider-match-endpoint",
  "name-and-proximity",
  "manual",
]);

/**
 * An ISO 8601 timestamp that actually parses.
 *
 * Checked rather than accepted as any non-empty string, because `freshness.ts` treats an unparseable timestamp as stale —
 * the right behaviour at read time and the wrong place to discover the problem. Catching it here makes a bad timestamp a
 * rejected record rather than a fact that silently never displays.
 */
const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Not a parseable ISO 8601 timestamp",
  });

/** `YYYY-MM-DD`. A date, not a moment — provider terms are dated documents. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Not a YYYY-MM-DD date")
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Not a real calendar date",
  });

/** A URL Roamly may store: `https:`, bounded, and parseable. See `urlIsSafe`. */
const SafeUrlSchema = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .refine(urlIsSafe, {
    message: `Must be an https: URL no longer than ${MAX_URL_LENGTH} characters`,
  });

export const PolicySnapshotSchema = z
  .object({
    persistence: PermissionSchema,
    display: PermissionSchema,
    export: PermissionSchema,
    termsReadOn: IsoDateSchema,
  })
  .strict();

export const FactProvenanceSchema = z
  .object({
    provider: ProviderIdSchema,
    retrievedAt: IsoTimestampSchema,
    licence: LicenceIdSchema,
    licenceUrl: SafeUrlSchema.optional(),
    attributionText: z.string().min(1).max(512).optional(),
    sourceUrl: SafeUrlSchema.optional(),
    externalId: z.string().min(1).max(256).optional(),
    policy: PolicySnapshotSchema,
  })
  .strict()
  /*
   * A licence that demands a credit, on a record with none, is refused at the boundary.
   *
   * The same check `provenanceIsComplete` makes, applied one step earlier. Both exist because they answer for different
   * moments: this refuses the record, that refuses the use. Catching it here means a component never has to.
   */
  .refine(
    (value) =>
      !attributionIsRequired(value.licence) ||
      (value.attributionText?.trim().length ?? 0) > 0,
    { message: "This licence requires an attribution line" },
  )
  .refine(
    (value) =>
      !licenceLinkIsRequired(value.licence) || Boolean(value.licenceUrl),
    { message: "This licence requires a link to the licence text" },
  );

export const PlaceFactSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: PlaceFactKindSchema,
    /**
     * A scalar and nothing else.
     *
     * The most load-bearing line in this file: it is what makes "a provider's raw response cannot become a fact" a parse
     * failure rather than a code-review note. Strings are bounded; numbers must be finite, because `Infinity` and `NaN`
     * both survive a JSON round-trip as values no comparison behaves sensibly against.
     */
    value: z.union([
      z.string().min(1).max(MAX_FACT_VALUE_LENGTH),
      z.number().finite(),
      z.boolean(),
    ]),
    subjectAt: IsoTimestampSchema.optional(),
    validUntil: IsoTimestampSchema.optional(),
    confidence: FactConfidenceSchema,
    provenance: FactProvenanceSchema,
  })
  .strict()
  /*
   * An expiry before the moment it describes is not an expiry, it is a corrupt record.
   *
   * Refused here because `freshness.ts` would treat it as permanently expired — technically safe, but it would present as
   * "this fact never displays" rather than "this fact is malformed", and those need different fixes.
   */
  .refine(
    (value) =>
      value.validUntil === undefined ||
      value.subjectAt === undefined ||
      Date.parse(value.validUntil) >= Date.parse(value.subjectAt),
    { message: "`validUntil` is before the moment the fact describes" },
  );

export const PlaceMediaSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.literal("photo"),
    url: SafeUrlSchema,
    creator: z.string().min(1).max(256).optional(),
    altText: z.string().min(1).max(512).optional(),
    transformationPermitted: z.boolean().optional(),
    provenance: FactProvenanceSchema,
  })
  .strict()
  /*
   * Alternative text is required at the boundary, not merely at display.
   *
   * A stored image with no text alternative can never legitimately be shown, so accepting one only defers the failure to a
   * component — whose only options would be to render it inaccessibly or drop it silently.
   */
  .refine((value) => (value.altText?.trim().length ?? 0) > 0, {
    message: "An image needs alternative text before it may be stored",
  });

export const ExternalIdentitySchema = z
  .object({
    provider: ProviderIdSchema,
    externalId: z.string().min(1).max(256),
    canonicalPlaceId: z.string().min(1).max(256),
    method: MatchMethodSchema,
    matchedAt: IsoTimestampSchema,
    evidence: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * A place's whole sidecar.
 *
 * Four cross-field invariants, each of which makes every per-item check meaningless if violated:
 *
 *  - every identity points at the place holding it, or the facts are about somewhere else
 *  - no two identities share a provider, or "the Foursquare id" is ambiguous
 *  - no two facts share an id, and no two images share an id, or deduplication cannot tell them apart
 *
 * Checked here as well as in `validate.ts` on purpose. This refuses the *record*; that reports every problem in a record
 * already in hand. A parse boundary letting a duplicate id through would put the burden on whoever remembered to validate.
 */
export const PlaceIntelligenceSchema = z
  .object({
    canonicalPlaceId: z.string().min(1).max(256),
    identities: z.array(ExternalIdentitySchema).max(16),
    facts: z.array(PlaceFactSchema).max(256),
    media: z.array(PlaceMediaSchema).max(64),
  })
  .strict()
  .refine(
    (value) =>
      value.identities.every(
        (identity) => identity.canonicalPlaceId === value.canonicalPlaceId,
      ),
    {
      message: "An identity points at a different place than the one holding it",
    },
  )
  .refine(
    (value) =>
      new Set(value.identities.map((identity) => identity.provider)).size ===
      value.identities.length,
    { message: "Two identities share one provider" },
  )
  .refine(
    (value) =>
      new Set(value.facts.map((fact) => fact.id)).size === value.facts.length,
    { message: "Two facts share one id" },
  )
  .refine(
    (value) =>
      new Set(value.media.map((entry) => entry.id)).size === value.media.length,
    { message: "Two images share one id" },
  );

export type ParsedPlaceIntelligence = z.infer<typeof PlaceIntelligenceSchema>;
