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
