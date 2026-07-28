import { z } from "zod";

import {
  FactProvenanceSchema,
  MAX_LANDMARK_CANDIDATES_PER_TRIP,
  MAX_URL_LENGTH,
  PlaceIntelligenceSchema,
} from "@/lib/place-intelligence";
/**
 * Type-only, and that is what keeps this module client-safe.
 *
 * `import type` is erased before the bundler sees it, so the `server-only` guard behind that barrel is never tripped.
 * It buys the one thing worth having here: the `satisfies` check below fails the build if `SummaryField` gains an arm
 * this contract does not list, which is the drift a hand-copied enum would otherwise hide until a response failed to
 * parse in somebody's browser.
 */
import type { SummaryField } from "@/lib/providers/place-intelligence/wikimedia";
import { TripPlaceSchema } from "@/lib/schemas";

/**
 * The contract for `POST /api/place-intelligence/enrich`.
 *
 * ## An enrichment endpoint, not a write endpoint
 *
 * It returns per-place outcomes and persists nothing. The shape `refresh-pool` established, and for the same reason:
 * the trip lives in the traveller's browser, the server has no storage, and it has no business deciding what a set of
 * Wikidata facts means for somebody's saved record. The browser folds the outcomes in through `putIntelligence`,
 * reconciles, and saves under the revision it read before starting.
 *
 * ## `tripId` is deliberately absent, and `expectedRevision` is not authority
 *
 * There is no `tripId` field. The server cannot read the traveller's `localStorage`, so an id would be a string it could
 * neither verify nor use — and a route that accepted one would invite a future reader to treat it as identity.
 *
 * `expectedRevision` is present and **echoed untouched**. The server does not check it; there is nothing to check it
 * against. It is a token the guarded client-side save compares, exactly as in `refresh-pool-contract.ts`.
 *
 * ## What never crosses back
 *
 * No provider payload, no candidate list, no rejected QID, no host, no HTTP status, no query string. An outcome carries
 * a `PlaceIntelligence`, a summary sentence, and reasons written for a person to read.
 */

/**
 * Twelve places at roughly 2 KB each, with generous headroom.
 *
 * Much smaller than `refresh-pool`'s 512 KB, because the request carries a bounded list of places rather than a whole
 * plan and its pool.
 */
export const ENRICH_MAX_BODY_BYTES = 64 * 1024;

export const EnrichTripPlacesRequestSchema = z.object({
  /**
   * The revision the client read before starting. Echoed back untouched.
   *
   * Not an authorisation and not verified — see the module note.
   */
  expectedRevision: z.number().int().positive(),
  /**
   * The places to enrich, already selected by `selectLandmarkCandidates`.
   *
   * Bounded here at the same twelve that function caps a trip at, so an oversized request is refused at the parse
   * boundary rather than by an assertion inside the orchestrator. The route filters and de-duplicates regardless:
   * a bound in a schema protects the server, and eligibility protects Wikimedia.
   */
  places: z
    .array(TripPlaceSchema)
    .min(1)
    .max(MAX_LANDMARK_CANDIDATES_PER_TRIP),
  requestId: z.string().min(8).max(64),
});
export type EnrichTripPlacesRequest = z.infer<
  typeof EnrichTripPlacesRequestSchema
>;

/**
 * The fields a summary drew on.
 *
 * Mirrors `SummaryField`, with `satisfies` making the mirror checked rather than hoped for. The adapter's type cannot be
 * imported at runtime — it lives behind a `server-only` barrel — so a compile-time assertion is the strongest link
 * available between the two.
 */
const SUMMARY_FIELDS = [
  "label",
  "description",
  "category",
  "inception",
  "heritage",
] as const satisfies readonly SummaryField[];

const LandmarkSummarySchema = z
  .object({
    text: z.string().min(1).max(512),
    /** The language the text is actually in, which need not be the one requested. */
    language: z.string().min(1).max(32),
    fields: z.array(z.enum(SUMMARY_FIELDS)).max(8),
    articleUrl: z.string().min(1).max(MAX_URL_LENGTH).nullable(),
    provenance: FactProvenanceSchema,
  })
  .strict();

/** A sentence a person may read, never a code. Bounded because it is rendered. */
const NoteSchema = z.string().min(1).max(512);

/**
 * What happened to one place.
 *
 * Four arms, discriminated on `status`, mirroring `EnrichmentOutcome`. The two that carry a sidecar carry it through
 * `PlaceIntelligenceSchema` rather than a looser shape, so a malformed response fails in the client's parse rather than
 * in whichever component rendered it.
 */
export const EnrichOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("matched"),
      canonicalPlaceId: z.string().min(1).max(256),
      intelligence: PlaceIntelligenceSchema,
      summary: LandmarkSummarySchema.nullable(),
      /** True when something was asked for and not obtained — most often a photograph. */
      partial: z.boolean(),
      notes: z.array(NoteSchema).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("review"),
      canonicalPlaceId: z.string().min(1).max(256),
      /** An identity and no facts. A nearby match is offered for confirmation, never displayed as fact. */
      intelligence: PlaceIntelligenceSchema,
      reason: NoteSchema,
      notes: z.array(NoteSchema).max(16),
    })
    .strict(),
  z
    .object({
      status: z.literal("unmatched"),
      canonicalPlaceId: z.string().min(1).max(256),
      reason: NoteSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      canonicalPlaceId: z.string().min(1).max(256),
      /** Our own code, never a provider message. */
      code: z.string().min(1).max(64),
    })
    .strict(),
]);
export type EnrichOutcome = z.infer<typeof EnrichOutcomeSchema>;

export const EnrichTripPlacesResponseSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    requestId: z.string().min(8).max(64),
    outcomes: z
      .array(EnrichOutcomeSchema)
      .max(MAX_LANDMARK_CANDIDATES_PER_TRIP),
    /**
     * Set when the run stopped before every place was attempted.
     *
     * A run that stopped after four of twelve must not read as a run that found nothing for the other eight. The client
     * shows what it has and may ask again for the remainder — the places already done are cached server-side, so the
     * second request costs Wikimedia almost nothing.
     */
    abandoned: z
      .object({
        code: z.string().min(1).max(64),
        retryAfterMs: z.number().int().nonnegative().optional(),
        attempted: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type EnrichTripPlacesResponse = z.infer<
  typeof EnrichTripPlacesResponseSchema
>;
