import "server-only";

import {
  emptyIntelligence,
  isLandmarkEligible,
  mergeIntelligence,
  parseWikipediaTag,
  planWikidataLookup,
  validateIntelligence,
  MAX_LANDMARK_CANDIDATES_PER_TRIP,
  PlaceIntelligenceSchema,
  type ExternalIdentity,
  type IsoTimestamp,
  type MatchMethod,
  type PlaceIntelligence,
  type PlaceMedia,
} from "@/lib/place-intelligence";
import { logOperation } from "@/lib/providers/log";
import type { TripPlace } from "@/lib/schemas";

import {
  buildLandmarkFacts,
  buildLandmarkSummary,
  fetchEntity,
  fetchLandmarkMedia,
  isWikimediaError,
  resolveWikipediaTitle,
  searchNearby,
  wikimediaClientIsUsable,
  DEFAULT_ENTITY_LANGUAGE,
  type LandmarkSummary,
  type NormalizedEntity,
} from "./wikimedia";

/**
 * Enriching a trip's landmarks, one at a time.
 *
 * ## Why this file is not in `lib/place-intelligence/`
 *
 * That directory's own header commits to it: "There is no client, no key, no fetch and no adapter anywhere in it." It
 * is the contract — a fact vocabulary, a provenance record, a trust ranking, two policy modules — and it is valuable
 * precisely because it can be reasoned about without a network. An orchestrator issuing HTTP requests would end that,
 * and the first symptom would be a unit test needing a fetch mock to check a licence rule.
 *
 * So the contract lives there and the execution lives here, and the dependency points one way.
 *
 * ## Serial, and the reason is not performance
 *
 * One place at a time, `await` in a `for` loop, no `Promise.all` anywhere. `docs/PROVIDER_RESEARCH.md` records that
 * Wikimedia publishes **no numeric rate limit** for the read path and that etiquette asks for serial rather than
 * parallel requests — a concurrency rule, not an interval. `WIKIMEDIA_LIMITS.maxConcurrent` is `1`, and this loop is
 * where that number is actually enforced: `client.ts` has no limiter, because inventing an interval would be a budget
 * dressed up as a limit.
 *
 * The honest consequence is that enrichment for twelve landmarks is twelve to twenty-four serial requests and takes
 * seconds, not milliseconds. That is why nothing here runs on a page load.
 *
 * ## Three rungs, and only one of them falls through
 *
 * `planWikidataLookup` decides which rung a place starts on, and the arms are not fallbacks for each other in the way
 * they look:
 *
 *  - **A resolved QID is terminal.** `fetchEntity` returning `found` ends the place's lookup, and a `missing` QID ends
 *    it too — falling through to a geographic search would swap a rank-3 identity for a rank-1 guess, which is a
 *    downgrade dressed as a retry.
 *  - **An unusable `wikipedia` tag does fall through.** A missing article, a disambiguation page or an article with no
 *    entity means the tag told us nothing, and the geographic rung is still available and still bounded. This is the
 *    one fall-through, and it is a fall-through from *no evidence* rather than from evidence we disliked.
 *  - **A nearby match never produces facts.** See below.
 *
 * ## Why a nearby match reports `review`
 *
 * `evaluateWikidataCandidate` labels every geographic match `name-and-proximity`, which ranks 1 — below
 * `MINIMUM_TRUSTED_MATCH_RANK`. `mergeIntelligence` records such an identity and refuses every fact across it. So a
 * nearby hit produces a sidecar holding an identity and nothing else, and this module reports it as `review` with a
 * reason distinguishing "name and coordinates agreed, by a heuristic" from "only category and proximity agreed".
 *
 * That is why no entity fetch and no media lookup happen on that path: the facts would be discarded by the merge and
 * the photograph refused by `fetchLandmarkMedia`'s own trust gate, so the requests would be two calls to a volunteer
 * service for results nobody may use.
 *
 * ## What never comes out of here
 *
 * No provider payload, no candidate list, no rejected-candidate list, no QID that failed a check. An outcome carries a
 * `PlaceIntelligence`, a summary, and sentences a person can read. The canonical `TripPlace` is read and never
 * written — this module has no way to return one, which is the enforcement.
 *
 * And nothing in the refused set: no rating, no review, no popularity, no crowding, no weather, no price, no booking.
 * `factKindIsRefused` would reject them at the merge; there is also simply no code here that could produce one.
 */

/**
 * What happened to one place.
 *
 * Four arms because four things genuinely happen, and collapsing any two would lose the distinction that matters to a
 * different reader: a traveller sees `matched`, a reviewer works the `review` queue, a developer reads `failed` in a
 * log, and `unmatched` is nobody's problem — it is the ordinary answer for a place an encyclopaedia does not cover.
 */
export type EnrichmentOutcome =
  | {
      status: "matched";
      canonicalPlaceId: string;
      /** Identity, facts and — where one survived every gate — a photograph. */
      intelligence: PlaceIntelligence;
      /** The display sentence. Not persisted; see `summary.ts`. */
      summary: LandmarkSummary | null;
      /**
       * True when something was asked for and not obtained — most often a photograph.
       *
       * Explicit rather than inferred from an empty `media` array, because "no image was offered" and "an image was
       * offered and refused" are different facts and only the second is worth a log line.
       */
      partial: boolean;
      notes: string[];
    }
  | {
      status: "review";
      canonicalPlaceId: string;
      /** The identity, and no facts. That is the whole point of this arm. */
      intelligence: PlaceIntelligence;
      reason: string;
      notes: string[];
    }
  | { status: "unmatched"; canonicalPlaceId: string; reason: string }
  | {
      status: "failed";
      canonicalPlaceId: string;
      /** Our own code, never a provider message. Matches `WikimediaError.logCode` where one was thrown. */
      code: string;
    };

/**
 * How long one enrichment run may take before it stops and reports what it has.
 *
 * 90 s, against the route's `maxDuration = 120` — the ratio `generate-trip-plan.ts` uses, for the same reason: a budget
 * below the platform ceiling means the run ends *itself* and returns a partial answer, where a run that hit the ceiling
 * would be killed mid-request and return nothing at all, discarding work already paid for against Wikimedia.
 *
 * And a full trip may genuinely not fit. Twelve places, serial, at up to two requests each against an 8 s timeout is
 * about 190 s worst case. That is not a number to engineer away — the serial requirement is the etiquette, and the
 * honest consequence is that a slow run comes back with eight places enriched and `abandoned` set. The client asks
 * again for the rest, which costs Wikimedia nothing extra: the eight are cached.
 */
export const ENRICHMENT_BUDGET_MS = 90_000;

export type EnrichmentRun = {
  outcomes: EnrichmentOutcome[];
  /**
   * Set when the run stopped before every place was attempted.
   *
   * A run that abandoned after four of twelve places must not look like a run that found nothing for the other eight.
   * `retryAfterMs` is carried when Wikimedia said one — and it is used to decide *not to ask again now*, rather than
   * to schedule a retry: honouring `Retry-After` by asking less is honouring it.
   */
  abandoned: {
    code: string;
    retryAfterMs?: number;
    /** How many places were attempted before the run stopped. */
    attempted: number;
  } | null;
};

export async function enrichPlaces(input: {
  /**
   * Places already validated, already eligible, already ordered, already capped.
   *
   * `selectLandmarkCandidates` produces exactly this: eligible places in itinerary-first order, cut to twelve. The
   * two assertions below check the caller rather than re-deciding the policy — a second eligibility answer here would
   * be a second place to change when the category list moves.
   */
  places: readonly TripPlace[];
  requestId: string;
  signal?: AbortSignal;
  /** Defaults to `ENRICHMENT_BUDGET_MS`. Lowered by tests; raised by nothing. */
  budgetMs?: number;
  /** Injected so a test can pin a timestamp. Production passes nothing. */
  now?: () => IsoTimestamp;
}): Promise<EnrichmentRun> {
  const now = input.now ?? (() => new Date().toISOString());
  const started = Date.now();

  if (input.places.length > MAX_LANDMARK_CANDIDATES_PER_TRIP) {
    throw new Error(
      `Enrichment was handed ${input.places.length} places, over the ${MAX_LANDMARK_CANDIDATES_PER_TRIP} a trip may ask about. The cap belongs to selectLandmarkCandidates.`,
    );
  }
  for (const place of input.places) {
    if (!isLandmarkEligible(place)) {
      throw new Error(
        `Enrichment was handed an ineligible place (${place.category}). Eligibility is selectLandmarkCandidates' decision, not this module's.`,
      );
    }
  }

  const outcomes: EnrichmentOutcome[] = [];

  /*
   * The whole run is skipped when the deployment cannot legally make a request.
   *
   * Wikimedia answers 403 to a request without a descriptive `User-Agent` and may block a client without notice, so
   * twelve requests to learn one configuration fault is the worst possible way to discover it.
   */
  if (!wikimediaClientIsUsable()) {
    logOperation({
      operation: "place-intelligence.enrich",
      provider: "place-intelligence",
      result: "refused",
      durationMs: Date.now() - started,
      requestId: input.requestId,
      errorCode: "wikimedia_misconfigured",
    });
    return {
      outcomes: [],
      abandoned: { code: "wikimedia_misconfigured", attempted: 0 },
    };
  }

  /*
   * QIDs already attached, mapped to the place holding each.
   *
   * Accumulated across the run so that "one entity cannot auto-attach to two places" holds for the whole trip.
   * `evaluateWikidataCandidate` sends a collision to review rather than refusing it, because one entity legitimately
   * can describe two OSM records — a park with two tagged entrances — and that is a judgement about the data.
   */
  const claimedQids = new Map<string, string>();

  /*
   * One deadline for the whole run, checked between places.
   *
   * Between rather than within: a place already mid-lookup is allowed to finish, because abandoning a Wikimedia request
   * we have already made saves nobody anything — the cost was paid when it was sent. The check sits at the top of the
   * loop, which is the only point where stopping is free.
   */
  const deadline = withDeadline(
    input.signal,
    input.budgetMs ?? ENRICHMENT_BUDGET_MS,
  );

  let abandoned: EnrichmentRun["abandoned"] = null;
  let attempted = 0;

  try {
    for (const place of input.places) {
      if (deadline.signal.aborted) {
        abandoned = { code: stopCode(deadline), attempted };
        break;
      }

      attempted += 1;

      try {
        const outcome = await enrichOne({
          place,
          claimedQids,
          requestId: input.requestId,
          signal: deadline.signal,
          retrievedAt: now(),
        });
        outcomes.push(outcome);
      } catch (error) {
        /*
         * One failure does not poison the rest — unless it is a failure about the run.
         *
         * A malformed payload for one entity says nothing about the next, so the place is reported `failed` and the loop
         * continues. `misconfigured`, `forbidden` and `rate_limited` are properties of the deployment or of Wikimedia's
         * patience with us, so the next eleven places would fail identically and issuing those requests would be eleven
         * requests to learn one thing.
         */
        if (isWikimediaError(error)) {
          if (error.abandonsRun) {
            abandoned = {
              code: error.logCode,
              ...(error.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: error.retryAfterMs }),
              attempted,
            };
            break;
          }
          if (error.kind === "aborted") {
            abandoned = { code: stopCode(deadline), attempted };
            break;
          }
          outcomes.push({
            status: "failed",
            canonicalPlaceId: place.placeId,
            code: error.logCode,
          });
          continue;
        }

        /* Not a provider failure: a bug here, or a record this module built wrongly. Named, never quoted. */
        outcomes.push({
          status: "failed",
          canonicalPlaceId: place.placeId,
          code: "enrichment_failed",
        });
      }
    }
  } finally {
    deadline.dispose();
  }

  logOperation({
    operation: "place-intelligence.enrich",
    provider: "place-intelligence",
    result: runResult(outcomes, abandoned),
    durationMs: Date.now() - started,
    requestId: input.requestId,
    partial: abandoned !== null || outcomes.some(isPartial),
    ...(abandoned ? { errorCode: abandoned.code } : {}),
  });

  return { outcomes, abandoned };
}

/* -------------------------------------------------------------------------- */
/* One place                                                                  */
/* -------------------------------------------------------------------------- */

async function enrichOne(input: {
  place: TripPlace;
  claimedQids: Map<string, string>;
  requestId: string;
  signal?: AbortSignal;
  retrievedAt: IsoTimestamp;
}): Promise<EnrichmentOutcome> {
  const { place, retrievedAt } = input;
  const canonicalPlaceId = place.placeId;
  const language = languageFor(place);
  const notes: string[] = [];

  const plan = planWikidataLookup(place);
  const options = { signal: input.signal, requestId: input.requestId };

  /* -- rung 1: the OSM `wikidata` tag ------------------------------------- */

  if (plan.kind === "entity") {
    const lookup = await fetchEntity(plan.qid, { language, ...options });

    if (lookup.status === "missing") {
      /*
       * Terminal, and deliberately so. OSM names an entity Wikidata does not hold — a deleted or merged item — and
       * the right answer is "no enrichment", not "look for something else nearby". The tag is evidence about *this*
       * entity, and its absence is not evidence about another.
       */
      return {
        status: "unmatched",
        canonicalPlaceId,
        reason: `OpenStreetMap tags this place ${plan.qid}, which Wikidata no longer holds.`,
      };
    }

    return attach({
      place,
      entity: lookup.entity,
      method: plan.method,
      evidence: plan.evidence,
      claimedQids: input.claimedQids,
      retrievedAt,
      notes,
      options,
    });
  }

  /* -- rung 2: the OSM `wikipedia` tag, resolved officially --------------- */

  if (plan.kind === "resolve-wikipedia-title") {
    const resolution = await resolveWikipediaTitle(plan.reference, options);

    if (resolution.status === "resolved") {
      const lookup = await fetchEntity(resolution.qid, {
        language: resolution.language,
        ...options,
      });

      if (lookup.status === "missing") {
        return {
          status: "unmatched",
          canonicalPlaceId,
          reason: `The ${resolution.language} Wikipedia article “${resolution.title}” names ${resolution.qid}, which Wikidata no longer holds.`,
        };
      }

      /*
       * `shared-external-id`, the same rank as a `wikidata` tag.
       *
       * The OSM `wikipedia` tag *is* a shared third-party identifier — a mapper standing at the place recorded which
       * article describes it — and what the resolution added was a dereference by the official API rather than a
       * judgement of ours. `planWikidataLookup` already types the entity arm's method this way for the same reason.
       */
      const redirectNote = resolution.redirectedFrom
        ? ` The article had been renamed from “${resolution.redirectedFrom}”.`
        : "";

      return attach({
        place,
        entity: lookup.entity,
        method: "shared-external-id",
        evidence: `The ${resolution.language} Wikipedia article “${resolution.title}”, which OpenStreetMap tags this place with, resolves to ${resolution.qid}.${redirectNote}`,
        claimedQids: input.claimedQids,
        retrievedAt,
        notes,
        options,
      });
    }

    /*
     * The one fall-through in the whole flow.
     *
     * A missing article, a disambiguation page or an article with no entity all mean the same thing: the tag told us
     * nothing. So the geographic rung is still available — it is bounded, it is one request, and it is the rung this
     * place would have started on had the tag been absent. Falling through from *no* evidence is not the same as
     * falling through from evidence we disliked.
     */
    notes.push(resolution.reason);
  }

  /* -- rung 3: bounded geographic search --------------------------------- */

  const nearby = await searchNearby({
    place,
    canonicalPlaceId,
    claimedQids: input.claimedQids,
    language,
    ...options,
  });

  if (nearby.status === "rejected") {
    return { status: "unmatched", canonicalPlaceId, reason: nearby.reason };
  }

  const identity = buildIdentity({
    canonicalPlaceId,
    qid: nearby.qid,
    method: nearby.method,
    evidence: nearby.evidence,
    matchedAt: retrievedAt,
  });

  /*
   * The identity is recorded and no fact is fetched.
   *
   * `mergeIntelligence` refuses every fact across a rank-1 match, so an entity fetch here would be a request to a
   * volunteer service for a result this module would then discard. Recording the link is still worth doing: a person
   * confirming it upgrades the method to `manual`, and the facts arrive on the next fold.
   */
  const merged = mergeIntelligence({
    existing: emptyIntelligence(canonicalPlaceId),
    identity,
  });

  input.claimedQids.set(nearby.qid, canonicalPlaceId);

  const validated = validate(merged.intelligence);
  if (validated === null) {
    return { status: "failed", canonicalPlaceId, code: "invalid_intelligence" };
  }

  return {
    status: "review",
    canonicalPlaceId,
    intelligence: validated,
    reason:
      nearby.status === "review"
        ? nearby.reason
        : "The name and the coordinates agreed, but by a heuristic rather than a shared identifier — which is enough to offer for confirmation and not enough to attach a fact.",
    notes: [...notes, nearby.evidence],
  };
}

/* -------------------------------------------------------------------------- */
/* Attaching a trusted entity                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Facts, then a photograph, then validation.
 *
 * The media lookup is last and its failure is never the place's failure: a refused photograph leaves a matched place
 * with a founding date, and reporting the whole place `failed` because one image had an unrecognised licence would
 * throw away four good facts over a fifth thing.
 */
async function attach(input: {
  place: TripPlace;
  entity: NormalizedEntity;
  method: MatchMethod;
  evidence: string;
  claimedQids: Map<string, string>;
  retrievedAt: IsoTimestamp;
  notes: string[];
  options: { signal?: AbortSignal; requestId?: string };
}): Promise<EnrichmentOutcome> {
  const canonicalPlaceId = input.place.placeId;
  const notes = [...input.notes];

  /*
   * A collision is reported rather than attached, even on the tag path.
   *
   * Two OSM places carrying the same `wikidata` tag is a real tagging pattern and sometimes correct — but "sometimes"
   * is not a basis for attaching one entity's photograph to two cards, so it goes to review with the holder named.
   */
  const holder = input.claimedQids.get(input.entity.qid);
  if (holder !== undefined && holder !== canonicalPlaceId) {
    const identity = buildIdentity({
      canonicalPlaceId,
      qid: input.entity.qid,
      /*
       * Recorded as the heuristic rank on purpose. The identifier is shared, and so is the *other* place's — which is
       * exactly the situation a person has to settle, so it must not carry a rank that would let facts through.
       */
      method: "name-and-proximity",
      evidence: `${input.evidence} ${input.entity.qid} is already attached to ${holder}.`,
      matchedAt: input.retrievedAt,
    });

    const merged = mergeIntelligence({
      existing: emptyIntelligence(canonicalPlaceId),
      identity,
    });
    const validated = validate(merged.intelligence);
    if (validated === null) {
      return {
        status: "failed",
        canonicalPlaceId,
        code: "invalid_intelligence",
      };
    }

    return {
      status: "review",
      canonicalPlaceId,
      intelligence: validated,
      reason:
        "One entity can describe two places only when both are part of the same geographic feature, which is a judgement about the data rather than something to infer.",
      notes,
    };
  }

  const identity = buildIdentity({
    canonicalPlaceId,
    qid: input.entity.qid,
    method: input.method,
    evidence: input.evidence,
    matchedAt: input.retrievedAt,
  });

  const facts = buildLandmarkFacts({
    entity: input.entity,
    retrievedAt: input.retrievedAt,
  });

  let partial = false;
  const media: PlaceMedia[] = [];

  if (input.entity.commonsFileTitle) {
    const outcome = await fetchLandmarkMedia({
      fileTitle: input.entity.commonsFileTitle,
      identity,
      place: input.place,
      entityLabel: input.entity.label?.value ?? null,
      retrievedAt: input.retrievedAt,
      ...input.options,
    });

    if (outcome.status === "accepted") {
      media.push(outcome.media);
    } else {
      partial = true;
      notes.push(outcome.reason);
    }
  }

  const merged = mergeIntelligence({
    existing: emptyIntelligence(canonicalPlaceId),
    identity,
    facts,
    media,
  });

  if (merged.refusals.length > 0) {
    partial = true;
    for (const refusal of merged.refusals) notes.push(refusal.message);
  }

  input.claimedQids.set(input.entity.qid, canonicalPlaceId);

  const validated = validate(merged.intelligence);
  if (validated === null) {
    return { status: "failed", canonicalPlaceId, code: "invalid_intelligence" };
  }

  return {
    status: "matched",
    canonicalPlaceId,
    intelligence: validated,
    summary: buildLandmarkSummary({
      entity: input.entity,
      place: input.place,
      retrievedAt: input.retrievedAt,
    }),
    partial,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function buildIdentity(input: {
  canonicalPlaceId: string;
  qid: string;
  method: MatchMethod;
  evidence: string;
  matchedAt: IsoTimestamp;
}): ExternalIdentity {
  return {
    provider: "wikidata",
    externalId: input.qid,
    canonicalPlaceId: input.canonicalPlaceId,
    method: input.method,
    matchedAt: input.matchedAt,
    /* Bounded to the schema's own limit, so a long evidence sentence cannot fail the parse it is about to face. */
    evidence: input.evidence.slice(0, 512),
  };
}

/**
 * The final gate: the strict parse boundary, then the validator.
 *
 * Both, because they answer for different moments. `PlaceIntelligenceSchema` refuses the *record* — an unknown key, an
 * unparseable timestamp, an unsafe URL — and `validateIntelligence` reports what is wrong with a record already in
 * hand, including the checks a schema cannot make, such as a confidence nothing derived.
 *
 * `structural` rather than `persist`: this output is held in memory, and the persistence question belongs to whoever
 * writes it into a trip record. Checking `persist` here would refuse data Roamly is entitled to display.
 *
 * Returns `null` on any violation, which the caller turns into `failed`. Emitting something that fails Roamly's own
 * validator would be worse than emitting nothing — it would put the failure in whichever component read it next.
 */
function validate(intelligence: PlaceIntelligence): PlaceIntelligence | null {
  const parsed = PlaceIntelligenceSchema.safeParse(intelligence);
  if (!parsed.success) return null;

  const violations = validateIntelligence(intelligence, "structural");
  if (violations.length > 0) return null;

  return intelligence;
}

/** The language to describe a place in: its `wikipedia` tag's, where it has one. */
function languageFor(place: TripPlace): string {
  if (!place.wikipediaTitle) return DEFAULT_ENTITY_LANGUAGE;
  return (
    parseWikipediaTag(place.wikipediaTitle)?.lang ?? DEFAULT_ENTITY_LANGUAGE
  );
}

function isPartial(outcome: EnrichmentOutcome): boolean {
  return outcome.status === "matched" ? outcome.partial : false;
}

type Deadline = { signal: AbortSignal; timedOut: boolean; dispose: () => void };

/**
 * Why the run stopped, and the two answers are not the same.
 *
 * `budget_exhausted` is us running out of time; `aborted` is the traveller changing their mind. `generate-trip-plan.ts`
 * separates them for the same reason: the first is worth a log line somebody should act on, and the second is the
 * ordinary consequence of navigating away from an optional background pass.
 */
function stopCode(deadline: Deadline): string {
  return deadline.timedOut ? "budget_exhausted" : "aborted";
}

/**
 * One signal that fires on either the caller's abort or the budget.
 *
 * Copied in shape from `generate-trip-plan.ts` rather than shared, because that one is private there and lifting it
 * would mean a new module for nine lines. The important property is the same: one signal, so an exhausted budget stops
 * *all* remaining work rather than only the step that happened to notice.
 */
function withDeadline(
  callerSignal: AbortSignal | undefined,
  budgetMs: number,
): Deadline {
  const controller = new AbortController();
  const state: Deadline = {
    signal: controller.signal,
    timedOut: false,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };

  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(
      new DOMException("Enrichment budget exhausted", "TimeoutError"),
    );
  }, budgetMs);

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  return state;
}

/**
 * The run's own result category.
 *
 * `empty` when nothing matched at all, which is a legitimate answer for a trip of small parish churches, and `partial`
 * when the run stopped early or any place came back thinner than asked for. Never `ok` for an abandoned run: a run
 * that stopped after four of twelve places is not a successful run with eight quiet failures.
 */
function runResult(
  outcomes: EnrichmentOutcome[],
  abandoned: EnrichmentRun["abandoned"],
): "ok" | "partial" | "empty" | "aborted" | "timeout" {
  if (abandoned?.code === "aborted") return "aborted";
  /* Out of time, with real results in hand. `timeout` rather than `partial`, so a slow Wikimedia is visible in a log. */
  if (abandoned?.code === "budget_exhausted") return "timeout";
  if (abandoned) return "partial";
  if (outcomes.length === 0) return "empty";
  if (outcomes.some(isPartial)) return "partial";
  if (outcomes.every((outcome) => outcome.status === "unmatched")) {
    return "empty";
  }
  return "ok";
}
