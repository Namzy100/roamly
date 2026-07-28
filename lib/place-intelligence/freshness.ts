import { FACT_VOLATILITY, type PlaceFact } from "./facts";
import type { FactVolatility, IsoTimestamp } from "./types";

/**
 * When an external fact stops being worth showing.
 *
 * ## Two different questions, deliberately not merged
 *
 * **Staleness** — "should we ask again?" — is about `provenance.retrievedAt` and a per-volatility
 * interval. A phone number fetched a year ago is probably still right and is certainly worth re-checking.
 *
 * **Expiry** — "does this still describe anything?" — is about the fact's own `subjectAt` / `validUntil`.
 * Thursday's forecast is worthless on Friday however recently it was fetched.
 *
 * A single `isFresh` would collapse them, and the collapse fails in the direction that misleads: a
 * forecast re-fetched hourly for a date six months past would read as maximally fresh. So there are two
 * functions, and callers must answer both.
 *
 * ## Why a perishable fact is never persisted
 *
 * `persistence-policy.ts` refuses it, and this is the reasoning. A trip record is exported to a file the
 * traveller keeps and may reopen next year, and there is no moment at which a stored forecast in that file
 * is more useful than an empty space — but there are many at which it is actively misleading. The honest
 * design fetches weather while the workspace is open and keeps none of it.
 */

/**
 * How long a fact of each volatility stays worth trusting without a re-check.
 *
 * Numbers chosen to be defensible rather than tuned. `durable` at 30 days is the order OSM's own data
 * realistically changes over, and the same order as the pool-age warning Roamly already shows.
 * `perishable` at one hour bounds how long a "now" reading describes now. `scheduled` has no interval at
 * all — its `validUntil` is the answer, and inventing a second one would let a concert that ended last
 * night pass a staleness check because it was fetched this morning.
 */
export const STALENESS_LIMIT_MS: Record<FactVolatility, number | null> = {
  durable: 30 * 24 * 60 * 60 * 1_000,
  perishable: 60 * 60 * 1_000,
  scheduled: null,
};

/**
 * Whether the fact should be re-fetched, given a clock.
 *
 * `now` is a required parameter rather than a `Date.now()` call, for the reason every other derivation in
 * this codebase takes its clock as input: a function that reads the clock cannot be tested against a
 * boundary, and every interesting case here *is* a boundary.
 *
 * An unparseable `retrievedAt` counts as stale. A timestamp we cannot read is not evidence of freshness,
 * and treating it as fresh would make a corrupt record the longest-lived one.
 */
export function factIsStale(fact: PlaceFact, now: IsoTimestamp): boolean {
  const limit = STALENESS_LIMIT_MS[FACT_VOLATILITY[fact.kind]];
  if (limit === null) return false;

  const retrieved = Date.parse(fact.provenance.retrievedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(retrieved) || !Number.isFinite(current)) return true;

  return current - retrieved > limit;
}

/**
 * Whether the fact still describes something, given a clock.
 *
 * Three arms, in the order they can fail:
 *
 *  - a `validUntil` in the past — the fact has a hard end and it has passed
 *  - a perishable fact whose `subjectAt` is outside its own window — a "now" reading about a different now
 *  - a perishable fact with no `subjectAt` at all — **expired**, because a perishable fact that cannot say
 *    which moment it describes cannot be shown as describing this one
 *
 * That last arm is worth being explicit about. Treating a missing `subjectAt` as "assume now" would make
 * the least-documented forecast the most trusted one.
 */
export function factIsExpired(fact: PlaceFact, now: IsoTimestamp): boolean {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return true;

  if (fact.validUntil !== undefined) {
    const until = Date.parse(fact.validUntil);
    if (!Number.isFinite(until)) return true;
    if (current > until) return true;
  }

  if (FACT_VOLATILITY[fact.kind] !== "perishable") return false;

  if (fact.subjectAt === undefined) return true;

  const subject = Date.parse(fact.subjectAt);
  if (!Number.isFinite(subject)) return true;

  const window = STALENESS_LIMIT_MS.perishable ?? 0;
  return Math.abs(current - subject) > window;
}

/** Both questions, answered together. The gate a display surface should actually ask. */
export function factIsUsable(fact: PlaceFact, now: IsoTimestamp): boolean {
  return !factIsExpired(fact, now) && !factIsStale(fact, now);
}

/* -------------------------------------------------------------------------- */
/* Landmark enrichment TTLs (Checkpoint 5B, section 11)                        */
/* -------------------------------------------------------------------------- */

/**
 * How long each part of a landmark lookup stays trustworthy, and what happens when it stops.
 *
 * ## Why these are not `STALENESS_LIMIT_MS` entries
 *
 * That table is keyed by *volatility*, which answers "when does a value stop being true". Three of the four things
 * below are not fact values at all — an identity is a *link*, media metadata is a *licence claim*, and a thumbnail URL
 * is a *rendered artefact*. They go stale for unrelated reasons, on unrelated schedules, and with different
 * consequences. Folding them into a volatility table would mean giving a URL a volatility, which is a category error
 * that only surfaces when a photograph disappears for the wrong reason.
 *
 * ## The four, and why each number is what it is
 *
 * Each carries a stated **consequence**, because "how long is it good for" is only half the question:
 *
 *  - **`externalIdentity` — 365 days, never gates display.** A QID is a permanent identifier; Wikidata merges and
 *    redirects entities but does not silently repoint one at a different place. An old identity is worth re-checking
 *    and is not grounds for hiding anything: an identity that has gone wrong is a *wrong match*, which is what
 *    `matchIsTrusted` and human review are for, not something a clock can detect.
 *  - **`officialDescription` — 30 days, shows with a label.** Matches the existing `durable` interval, because a
 *    Wikidata description changes on the scale of a rebuild or a change of use. Past it the sentence is still almost
 *    certainly true, so refusing it would remove correct information; the honest treatment is to show it and say it
 *    has not been checked lately. This is the one place in the directory where staleness is a *label* rather than a
 *    refusal, and `mayDisplayFact` requires an explicit opt-in to behave that way.
 *  - **`mediaMetadata` — 180 days, never gates display.** A licence grant does not lapse. A CC BY-SA 3.0 file
 *    licensed in 2011 is still licensed under it today, and hiding a photograph because the paperwork was last checked
 *    seven months ago would refuse a permission that is still in force. Long, therefore, and advisory: what it buys is
 *    picking up a corrected credit on the next explicit refresh.
 *  - **`thumbnailUrl` — 30 days, omits the image.** The one hard expiry. A Commons thumbnail URL points at a *derived
 *    rendering*, not at the file: Wikimedia regenerates thumbnails, and a stored URL that once worked can return 404.
 *    A broken image is worse than no image, so past this the photograph is omitted while the description and facts
 *    beside it are untouched.
 *
 * ## No polling, at any of these intervals
 *
 * None of these is a timer. Nothing schedules a refresh, nothing refreshes on trip open, and nothing refreshes in the
 * background — an interval here would turn a volunteer-funded service into a subscription nobody asked permission for.
 * They are read at *render* time to decide what to show, and at *refresh* time to decide what an explicit user action
 * should ask about again. An elapsed TTL changes what a card looks like; it never causes a request.
 */
export const LANDMARK_TTL_MS = {
  externalIdentity: 365 * 24 * 60 * 60 * 1_000,
  officialDescription: 30 * 24 * 60 * 60 * 1_000,
  mediaMetadata: 180 * 24 * 60 * 60 * 1_000,
  thumbnailUrl: 30 * 24 * 60 * 60 * 1_000,
} as const satisfies Record<string, number>;

/**
 * Whether a recorded moment is older than one of the TTLs above.
 *
 * An unparseable timestamp counts as elapsed, for the reason `factIsStale` treats one as stale: a moment we cannot
 * read is not evidence of freshness, and treating it as fresh would make a corrupt record the longest-lived one.
 */
export function ttlElapsed(input: {
  since: IsoTimestamp;
  now: IsoTimestamp;
  ttlMs: number;
}): boolean {
  const since = Date.parse(input.since);
  const now = Date.parse(input.now);
  if (!Number.isFinite(since) || !Number.isFinite(now)) return true;
  return now - since > input.ttlMs;
}
