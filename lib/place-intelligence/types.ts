/**
 * The vocabulary of external place intelligence, before any provider exists.
 *
 * ## Why this domain is separate from `lib/schemas/place.ts`
 *
 * `TripPlace` is what Roamly *verified* — a place returned by an OSM-backed provider, normalised by
 * our own server, and a member of the exact pool the itinerary was assembled from. Everything on it
 * is either OSM's own tag or absent, and `assertItineraryUsesPool` treats it as evidence.
 *
 * An external fact is a different kind of thing. It arrives from somewhere with its own licence, its
 * own freshness, and its own rules about whether it may be stored at all — and those rules differ
 * per provider, per fact, and sometimes per *file*. Folding that into `TripPlace` would put a field
 * on the verified record whose legality depends on where it came from, which is precisely how a
 * cached rating ends up in an exported JSON file that the licence forbids.
 *
 * So: `TripPlace` stays the canonical, licence-clean record. External facts live alongside it,
 * always carrying their provenance, and pass through `persistence-policy` and `display-policy`
 * before they may be stored or shown.
 *
 * ## Nothing here is implemented against a provider
 *
 * Checkpoint 5A is the research gate. These types encode the conclusions in
 * `docs/PROVIDER_RESEARCH.md` so that adding a provider later means writing an adapter *into* an
 * existing contract rather than inventing a permission. Deliberately no client, no fetch, no key.
 */

/**
 * Every source Roamly may name, decided or not.
 *
 * A closed enum because an unknown provider has no licence, and a fact with no licence has no
 * permissions — so a bare string here would let one arrive unpoliced. Rejected providers are kept in
 * the vocabulary on purpose: the policy tables have to be able to say "no" about them by name, and a
 * provider absent from the enum could not be refused, only forgotten.
 */
export type ProviderId =
  /* -- in use today ------------------------------------------------------- */
  | "openstreetmap"
  /** The deterministic sample data. Carries no licence obligations of its own. */
  | "mock"
  /* -- accepted by Checkpoint 5A, not yet implemented --------------------- */
  | "wikidata"
  | "wikimedia-commons"
  | "open-meteo"
  /** Recommended conditionally; blocked on the caching window. */
  | "foursquare"
  /* -- researched and rejected. Named so they can be refused, not omitted -- */
  | "google-places"
  | "yelp"
  | "besttime"
  | "ticketmaster";

/**
 * What kind of thing an external fact is, which is what decides how long it stays true.
 *
 * Not a taxonomy for its own sake — `freshness.ts` dispatches on this, and the three arms are the
 * three genuinely different answers to "when does this stop being true":
 *
 *  - `durable` — a phone number, a category, a wheelchair tag. Changes rarely and without warning,
 *    so it goes stale silently and needs a re-check interval rather than an expiry.
 *  - `perishable` — a weather forecast, a live busyness reading. Has a moment it describes and is
 *    worthless outside it. Must never be persisted into an exported trip.
 *  - `scheduled` — an event, a temporary closure. Carries its own hard end, so its expiry is a
 *    property of the fact rather than of the fetch. Ticketmaster's shape, kept so that events are a
 *    new fact kind later rather than a new architecture.
 */
export type FactVolatility = "durable" | "perishable" | "scheduled";

/**
 * How much weight a fact may carry, and never a number.
 *
 * Deliberately three words rather than a score. A 0–1 confidence invites arithmetic — averaging two
 * providers, thresholding at 0.7 — and every such operation produces a figure nobody can defend to a
 * traveller. `reported` is the honest default: the provider said so, and we are repeating it.
 */
export type FactConfidence =
  /** The provider asserts it; we have no way to check. Most external facts. */
  | "reported"
  /** Two independent sources agree. `merge.ts` is the only thing that may set this. */
  | "corroborated"
  /** Sources disagree and the conflict is unresolved. Must not be displayed as fact. */
  | "disputed";

/** ISO 8601 UTC, e.g. `2026-07-28T09:15:00.000Z`. A string, because it is stored and compared. */
export type IsoTimestamp = string;

/**
 * An SPDX-style licence identifier, or the two non-SPDX states that matter.
 *
 * `unknown` is not a licence and is load-bearing: a Commons file whose licence cannot be determined
 * must be refusable, and the only way to refuse it is to be able to represent the state.
 * `proprietary` covers a provider whose terms grant a *use* without granting a public licence —
 * Foursquare, if it is ever enabled.
 */
export type LicenceId =
  | "CC0-1.0"
  | "CC-BY-4.0"
  | "CC-BY-SA-4.0"
  | "ODbL-1.0"
  | "public-domain"
  | "proprietary"
  | "unknown";

/**
 * A three-state answer, because two states would force a guess.
 *
 * `unresolved` is the whole point of this type and of the checkpoint that produced it: where a
 * provider's documentation does not answer a question, the answer is not "probably fine". Every
 * policy in this directory treats `unresolved` exactly as it treats `denied`, and says so out loud
 * rather than defaulting.
 */
export type Permission = "granted" | "denied" | "unresolved";

/** True only for an explicit grant. The one place `unresolved` collapses — and it collapses to no. */
export function isPermitted(permission: Permission): boolean {
  return permission === "granted";
}
