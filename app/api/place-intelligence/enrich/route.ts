import {
  ENRICH_MAX_BODY_BYTES,
  EnrichTripPlacesRequestSchema,
  EnrichTripPlacesResponseSchema,
  type EnrichOutcome,
  type EnrichTripPlacesResponse,
} from "@/lib/api/place-intelligence-contract";
import {
  jsonError,
  readJsonBody,
  toErrorResponse,
} from "@/lib/api/route-helpers";
import {
  isLandmarkEligible,
  landmarkEligibility,
  MAX_LANDMARK_CANDIDATES_PER_TRIP,
} from "@/lib/place-intelligence";
import { fixtureEnrichmentBudgetMs } from "@/lib/place-intelligence/fixture-origin";
import { logOperation } from "@/lib/providers/log";
import {
  enrichPlaces,
  ENRICHMENT_BUDGET_MS,
} from "@/lib/providers/place-intelligence/enrich";
import { wikimediaClientIsUsable } from "@/lib/providers/place-intelligence/wikimedia";
import type { TripPlace } from "@/lib/schemas";

/**
 * `POST /api/place-intelligence/enrich` — look up a trip's landmarks on Wikimedia.
 *
 * ## A provider boundary, and nothing else
 *
 * It normalizes what comes in, talks to Wikidata and Commons, and returns per-place outcomes. It persists nothing,
 * mutates nothing, and returns no trip. The traveller's record lives in their browser, so the browser folds the
 * outcomes in through `putIntelligence`, reconciles, and saves under the revision it read before starting — the shape
 * `refresh-pool` established for the same reason.
 *
 * The consequence worth stating: a traveller who closes the tab mid-request loses nothing except the request. Enrichment
 * is optional, and the endpoint is safe to call again — the places already done are in the adapter's cache.
 *
 * ## No `tripId`, and `expectedRevision` is not authority
 *
 * The request carries no trip id, because the server could neither verify nor use one. `expectedRevision` is echoed
 * untouched and never checked: there is nothing here to check it against, and it exists so the *client's* guarded save
 * can compare it. Treating either as authorisation would be inventing a permission out of a string a client chose.
 *
 * ## Where the bounds are applied, and why twice
 *
 * The schema caps the list at twelve. This route then de-duplicates by canonical id and drops ineligible places
 * *before* the orchestrator sees them.
 *
 * Both are needed and they protect different things. The schema protects the server from an oversized body. The
 * eligibility filter protects **Wikimedia**: `enrichPlaces` throws on an ineligible place, deliberately, because being
 * handed one means a caller stopped applying `selectLandmarkCandidates` — and a route that let that become a 500 would
 * turn a client bug into an outage. So the filter happens here, an ineligible place is reported `unmatched` with the
 * reason the policy gives, and no request is made for it.
 *
 * ## Duration
 *
 * `maxDuration = 120`, against the 90 s `ENRICHMENT_BUDGET_MS`. The ratio generation uses, and here it matters more than
 * usual: enrichment is **serial** by etiquette, so twelve places at up to two requests each cannot be assumed to fit.
 * The budget means the run stops itself and reports `abandoned`, returning eight enriched places rather than being killed
 * at the ceiling and returning none.
 */

export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, EnrichTripPlacesRequestSchema, {
    maxBytes: ENRICH_MAX_BODY_BYTES,
  });
  if (!body.ok) return body.response;

  const { expectedRevision, places, requestId } = body.data;

  /*
   * A misconfigured deployment is a server fault, and it answers 503 rather than 200.
   *
   * `enrichPlaces` would report it as `abandoned: wikimedia_misconfigured` inside a well-formed 200, which is tidy and
   * wrong: a 200 says "the provider was asked and this is what happened", and here the provider was never asked because
   * Roamly's own `User-Agent` would have been refused. Dressing an operator's problem as a provider outcome is how it
   * survives to production — Wikimedia answers 403 to a request without a descriptive `User-Agent` and may block a
   * client without notice, so this is the failure that most needs to be loud.
   *
   * The message names the variable to set and nothing else. No value, no host, no header, no `process.env` — a
   * misconfiguration response that quoted its own configuration would be a way to read the environment.
   */
  if (!wikimediaClientIsUsable()) {
    logOperation({
      operation: "place-intelligence.enrich",
      provider: "place-intelligence",
      result: "refused",
      durationMs: 0,
      requestId,
      errorCode: "wikimedia_misconfigured",
    });
    return jsonError(
      503,
      "provider_misconfigured",
      "Landmark enrichment is not configured on this deployment. Set ROAMLY_CONTACT_URL and try again.",
    );
  }

  const { eligible, refused } = partition(places);

  if (eligible.length === 0) {
    /*
     * Every place was ineligible, which is a legitimate answer rather than an error — a trip of cafés has no landmarks
     * to enrich. Reported as outcomes with reasons, so the client can say why nothing happened.
     */
    return respond({
      expectedRevision,
      requestId,
      outcomes: refused,
      abandoned: null,
    });
  }

  try {
    const run = await enrichPlaces({
      places: eligible,
      requestId,
      signal: request.signal,
      /*
       * The real budget, unless the isolated fixture policy is in force.
       *
       * `fixtureEnrichmentBudgetMs` returns `null` for every served process — it fails on `NODE_ENV` long before it
       * looks at a variable — so this reads as `ENRICHMENT_BUDGET_MS` in production by construction rather than by
       * configuration. It exists because a continuation is only reachable when the server genuinely runs out of time,
       * and 90 s against a 120 s route ceiling leaves no room to demonstrate one.
       */
      budgetMs: fixtureEnrichmentBudgetMs() ?? ENRICHMENT_BUDGET_MS,
    });

    return respond({
      expectedRevision,
      requestId,
      /* Refusals first: they cost nothing and they are the places a reader is most likely to be looking for. */
      outcomes: [...refused, ...run.outcomes],
      abandoned: run.abandoned,
    });
  } catch (error) {
    /*
     * Only a programming fault reaches here.
     *
     * Every provider failure is already an outcome or an `abandoned` code — `enrichPlaces` catches `WikimediaError`
     * itself, because one place failing must not cost the other eleven. So this is the assertion path, and
     * `toErrorResponse` is what keeps a stack trace and a provider host out of the browser.
     */
    return toErrorResponse(error, "place-intelligence.enrich");
  }
}

/**
 * Eligible places, de-duplicated, and an `unmatched` outcome for each one refused.
 *
 * De-duplication matters more than it looks: the same place twice would spend two of a bounded twelve on one answer, and
 * `selectLandmarkCandidates` already guarantees uniqueness — so a duplicate arriving here means the client assembled the
 * list some other way, and honouring it would waste a volunteer service's time.
 */
function partition(places: readonly TripPlace[]): {
  eligible: TripPlace[];
  refused: EnrichOutcome[];
} {
  const eligible: TripPlace[] = [];
  const refused: EnrichOutcome[] = [];
  const seen = new Set<string>();

  for (const place of places) {
    if (seen.has(place.placeId)) continue;
    seen.add(place.placeId);

    if (isLandmarkEligible(place)) {
      eligible.push(place);
      continue;
    }

    const verdict = landmarkEligibility(place);
    refused.push({
      status: "unmatched",
      canonicalPlaceId: place.placeId,
      /* The policy's own sentence. Written for a person, and it explains rather than apologises. */
      reason: verdict.eligible
        ? "This place is not eligible for landmark enrichment."
        : verdict.reason,
    });
  }

  return {
    eligible: eligible.slice(0, MAX_LANDMARK_CANDIDATES_PER_TRIP),
    refused,
  };
}

/**
 * Validates our own response before sending it.
 *
 * The same posture `exportTrip` takes on the way out: a record corrupted in memory must not become a payload that looks
 * valid. It also means the contract is exercised on every request rather than only by whichever test remembered — and a
 * response that fails it is a bug here, reported as a 500 rather than shipped to a browser that would fail to parse it.
 */
function respond(payload: EnrichTripPlacesResponse): Response {
  const parsed = EnrichTripPlacesResponseSchema.safeParse(payload);

  if (!parsed.success) {
    logOperation({
      operation: "place-intelligence.enrich",
      provider: "place-intelligence",
      result: "invalid",
      durationMs: 0,
      requestId: payload.requestId,
      errorCode: "response_failed_contract",
    });
    return jsonError(
      500,
      "response_failed_contract",
      "Enrichment produced a result Roamly could not return. Nothing was changed.",
    );
  }

  return Response.json(parsed.data);
}
