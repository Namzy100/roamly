import { z } from "zod";

import {
  intelligenceIsEmpty,
  mayPersistFact,
  mayPersistMedia,
  stripAllForExport,
  validateIntelligence,
  MAX_LANDMARK_CANDIDATES_PER_TRIP,
  PlaceIntelligenceSchema,
  type PlaceIntelligence,
} from "@/lib/place-intelligence";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";

/**
 * The enrichment sidecar, as it is stored beside a trip.
 *
 * ## One schema, at the storage boundary
 *
 * `PlaceIntelligenceSchema` is the parse boundary for a place's enrichment, and this module reuses it rather than
 * describing the same record a second time. `CanonicalPlaceIntelligence` below is an alias and nothing more — it names
 * the role the type plays here without giving it separate fields or separate validation, because two schemas for one
 * record is how a fact that fails one gate arrives through the other.
 *
 * ## Why it is a sidecar and not fields on `TripPlace`
 *
 * `canonical.ts` states the reason, and it is worth restating at the point where it becomes concrete: `TripPlace` is
 * compared **field by field** against the saved pool by `assertItineraryUsesPool`. Any field added to it becomes part
 * of that tampering check, so an enrichment refreshing on its own schedule would read as tampering, and a fact that
 * may not be persisted could not be stripped without failing the comparison.
 *
 * Keyed by `canonicalPlaceId`, the verified record stays byte-stable and this can refresh, expire and be filtered on
 * its own schedule. Dropping the whole sidecar leaves a working, licence-clean trip — which is what makes the
 * keyless fallback free.
 *
 * ## `schemaVersion` is separate from the record's own version, on purpose
 *
 * `parseStoredRecord` migrates the envelope by shape, and the envelope's shape has changed twice. Enrichment will
 * change on a different clock — a new fact kind, a new provider, a licence table correction — and versioning it inside
 * the envelope means such a change can invalidate *the sidecar* without invalidating the trip. A single version number
 * for both would make adding a fact kind a reason to discard everybody's saved plans.
 *
 * The field is a `z.literal(1)` rather than a number, so a version this build does not know fails the parse and the
 * sidecar is dropped. Dropping it is safe by construction; keeping a record whose meaning has changed is not.
 *
 * ## Only what may be persisted gets in
 *
 * `putIntelligence` filters through `mayPersistFact` and `mayPersistMedia` on the way in, then validates each entry in
 * `persist` mode. That is stricter than the in-memory record the orchestrator produced, and deliberately: a weather
 * forecast is legitimate in memory and a lie with a timestamp in `localStorage`, and the strictness has to be applied
 * where the write happens rather than where the data was fetched.
 */

/** The one shape this build understands. Bumped when a stored sidecar's meaning changes, not when a field is added. */
export const TRIP_INTELLIGENCE_SCHEMA_VERSION = 1;

/**
 * The storage boundary's name for a place's enrichment.
 *
 * An alias, not a type of its own. It exists so a reader of `byCanonicalPlaceId` sees what the values are without
 * following an import — and it must stay an alias, because a distinct type here would need a distinct schema, and a
 * distinct schema is a second answer to "is this record valid".
 */
export type CanonicalPlaceIntelligence = PlaceIntelligence;

/**
 * The most places one sidecar may describe.
 *
 * The same twelve `MAX_LANDMARK_CANDIDATES_PER_TRIP` allows a trip to *ask* about, because a sidecar holding more than
 * that was not produced by an enrichment run — and an unbounded record in `localStorage` is a quota failure that
 * presents as a save bug, which is the failure `history.ts` was bounded against.
 */
export const MAX_SIDECAR_ENTRIES = MAX_LANDMARK_CANDIDATES_PER_TRIP;

/** Keys that must never name an entry. `JSON.parse` creates `__proto__` as an ordinary own property. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const PlaceIdKeySchema = z
  .string()
  .min(1)
  .max(256)
  .refine((key) => !PROTOTYPE_KEYS.has(key), {
    message: "Refused a prototype-pollution key",
  });

const IsoTimestampSchema = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "Not a parseable ISO 8601 timestamp",
  });

export const TripPlaceIntelligenceSidecarSchema = z
  .object({
    schemaVersion: z.literal(TRIP_INTELLIGENCE_SCHEMA_VERSION),
    byCanonicalPlaceId: z
      .record(PlaceIdKeySchema, PlaceIntelligenceSchema)
      .refine((record) => Object.keys(record).length <= MAX_SIDECAR_ENTRIES, {
        message: `A sidecar may describe at most ${MAX_SIDECAR_ENTRIES} places`,
      })
      /*
       * The key and the record's own id must agree.
       *
       * Without this, a sidecar could file one place's facts under another's key and every per-entry check would still
       * pass — the entry is internally coherent, it is simply about somewhere else. That is the failure
       * `PlaceIntelligenceSchema`'s own identity refinement guards inside an entry, applied one level up.
       */
      .refine(
        (record) =>
          Object.entries(record).every(
            ([key, entry]) => entry.canonicalPlaceId === key,
          ),
        {
          message: "An entry is filed under a different place than it describes",
        },
      ),
    /** When the enrichment run that produced this finished. Not when any one fact became true. */
    refreshedAt: IsoTimestampSchema,
  })
  .strict();

export type TripPlaceIntelligenceSidecar = z.infer<
  typeof TripPlaceIntelligenceSidecarSchema
>;

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One place's enrichment, or `null`.
 *
 * Accepts a `null` sidecar so every call site is one expression rather than a guard plus a lookup. A trip with no
 * enrichment and a trip whose enrichment does not cover this place are the same answer to a renderer, and both must
 * produce no panel — `intelligenceIsEmpty` is the check for the third case, where an entry exists and holds nothing.
 */
export function intelligenceFor(
  sidecar: TripPlaceIntelligenceSidecar | null | undefined,
  canonicalPlaceId: string,
): CanonicalPlaceIntelligence | null {
  if (!sidecar) return null;
  return sidecar.byCanonicalPlaceId[canonicalPlaceId] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The sidecar an enrichment run produces, filtered to what may actually be stored.
 *
 * ## Merged rather than replaced
 *
 * A run enriches the places it was given, and a trip can be enriched twice — once when it is generated, once after a
 * traveller adds a stop. Replacing the whole sidecar would discard the first run's work to record the second's, so
 * entries are merged by key and the incoming entry wins for the keys it covers.
 *
 * ## Stripped, not refused
 *
 * An entry carrying something unpersistable is written **without** it rather than dropped, which is the direction
 * `stripIntelligenceForExport` established: the traveller asked for their trip, and a trip is storable even when some
 * enrichment is not. An entry left empty by the stripping is dropped rather than stored hollow.
 *
 * The one thing that *is* refused outright is an entry `validateIntelligence` rejects in `persist` mode. That means
 * the record is internally incoherent — a duplicate id, a confidence nothing derived, a policy claiming more than
 * today's table grants — and writing it would put the failure in whichever component read it back.
 */
export function putIntelligence(
  sidecar: TripPlaceIntelligenceSidecar | null | undefined,
  entries: readonly CanonicalPlaceIntelligence[],
  now: string,
): TripPlaceIntelligenceSidecar {
  const merged: Record<string, CanonicalPlaceIntelligence> = {
    ...(sidecar?.byCanonicalPlaceId ?? {}),
  };

  for (const entry of entries) {
    const persistable = stripForPersistence(entry);

    if (intelligenceIsEmpty(persistable)) {
      /* Nothing survived the filter. An empty entry would render an empty panel, so it is not stored. */
      delete merged[entry.canonicalPlaceId];
      continue;
    }

    if (validateIntelligence(persistable, "persist").length > 0) continue;

    merged[entry.canonicalPlaceId] = persistable;
  }

  return {
    schemaVersion: TRIP_INTELLIGENCE_SCHEMA_VERSION,
    byCanonicalPlaceId: capEntries(merged),
    refreshedAt: now,
  };
}

/**
 * Everything in one entry that may be written to the trip record.
 *
 * Identities are kept unconditionally. An identity is a pointer out with no licence obligation of its own — for
 * Google's place ids it is the *only* thing that may legally be persisted — and keeping it is what makes a review
 * queue survive a reload: a person confirming a nearby match needs the link to still be there.
 */
function stripForPersistence(
  entry: CanonicalPlaceIntelligence,
): CanonicalPlaceIntelligence {
  return {
    ...entry,
    facts: entry.facts.filter((fact) => mayPersistFact(fact) === "granted"),
    media: entry.media.filter((media) => mayPersistMedia(media) === "granted"),
  };
}

export type ReconcileTripIntelligenceInput = {
  intelligence: TripPlaceIntelligenceSidecar | null;
  plan: TripPlan;
  generationContext: TripGenerationContext | null;
};

/**
 * The sidecar, reconciled against the trip as it now stands.
 *
 * ## One helper, because two would disagree
 *
 * An earlier `pruneIntelligence` took a bare list of place ids, which pushed the real question — *which* ids count as
 * still part of this trip — onto every caller. Three callers would have given three answers, and the one that forgot the
 * pool would have quietly discarded enrichment for every backup option. So this takes the plan and the context and
 * derives the set itself. It is the only door.
 *
 * ## What counts as still part of the trip
 *
 * Four sources, and all four belong:
 *
 *  - **scheduled places** — the itinerary as it stands
 *  - **backup options** — a traveller may promote one at any moment, and enrichment already fetched is the difference
 *    between a fallback that has a photograph and one that does not
 *  - **the accommodation** — a plan holds exactly one, and it is a `TripPlace` like any other. Easy to miss, because it
 *    hangs off the plan rather than off a day, and missing it would prune a hotel's enrichment on the first
 *    reconciliation after it was fetched
 *  - **the recorded pool, plus any retained places** — `selectLandmarkCandidates` draws from it, so an entry for a pool
 *    place is enrichment already paid for against a volunteer service
 *
 * ## A refreshed pool does not invalidate enrichment
 *
 * The judgement call worth stating. When `refresh-pool` replaces a trip's universe of allowed places, an entry whose
 * place is in none of the three sources is dropped — but an entry whose place survived the refresh is **kept**, not
 * re-fetched.
 *
 * The alternative would be to void the whole sidecar on any pool change, and it is wrong twice over: a QID a mapper
 * recorded does not stop being that place's QID because Roamly re-ran a search, and discarding the sidecar would send
 * twelve fresh serial requests to Wikimedia to re-learn facts that had not changed — which is the traffic the etiquette
 * page objects to. `generationContext` is read to *widen* what survives, never to condemn it.
 *
 * ## Every surviving entry is re-validated
 *
 * `persist` mode, on the way through. A stored sidecar can predate a tightening of the policy table — a licence that was
 * granted when a fact was fetched and is not today — and `validateIntelligence` is what notices. So reconciliation is
 * also the moment a record that has *become* unstorable is dropped, which is the only place that check would otherwise
 * never run.
 *
 * Returns `null` when nothing survives, so a caller stores `null` rather than an empty object. An empty sidecar and no
 * sidecar mean the same thing to every reader, and one representation is fewer than two.
 */
export function reconcileTripIntelligence(
  input: ReconcileTripIntelligenceInput,
): TripPlaceIntelligenceSidecar | null {
  const sidecar = input.intelligence;
  if (!sidecar) return null;

  const referenced = referencedPlaceIds(input);
  const remaining: Record<string, CanonicalPlaceIntelligence> = {};

  for (const [key, entry] of Object.entries(sidecar.byCanonicalPlaceId)) {
    if (!referenced.has(key)) continue;

    /* Belt and braces: an entry filed under the wrong key would describe a place this one is not. */
    if (entry.canonicalPlaceId !== key) continue;

    const persistable = stripForPersistence(entry);
    if (intelligenceIsEmpty(persistable)) continue;
    if (validateIntelligence(persistable, "persist").length > 0) continue;

    remaining[key] = persistable;
  }

  if (Object.keys(remaining).length === 0) return null;

  return { ...sidecar, byCanonicalPlaceId: capEntries(remaining) };
}

/**
 * Every canonical place id this trip may legitimately hold enrichment for.
 *
 * Reads the plan and the context and nothing else — no eligibility check and no category filter. Eligibility decided
 * whether Roamly could *ask*; this decides whether an answer already in hand is still about this trip, and re-applying
 * eligibility would silently discard enrichment for a place whose category had since been reclassified.
 */
function referencedPlaceIds(input: ReconcileTripIntelligenceInput): Set<string> {
  const ids = new Set<string>();

  for (const day of input.plan.days) {
    for (const item of day.items) {
      if (item.place) ids.add(item.place.placeId);
    }
    for (const backup of day.backups) {
      ids.add(backup.place.placeId);
    }
  }

  /* One per plan, hanging off the plan rather than off a day — and nullable before one is chosen. */
  if (input.plan.accommodation) {
    ids.add(input.plan.accommodation.place.placeId);
  }

  for (const place of input.generationContext?.placePool.places ?? []) {
    ids.add(place.placeId);
  }
  /*
   * Retained places are included deliberately.
   *
   * A place retained after a pool refresh is one the itinerary still references and the current pool no longer holds —
   * exactly the case where dropping its enrichment would be visible to a traveller as a stop that lost its photograph
   * for no reason they could see.
   */
  for (const retained of input.generationContext?.retainedPlaces ?? []) {
    ids.add(retained.place.placeId);
  }

  return ids;
}

/**
 * The sidecar as it may appear in an exported file, or `null` when nothing may leave.
 *
 * `stripAllForExport` is the authority — export is strictly stronger than persistence, because an exported file is
 * outside any deletion mechanism Roamly controls. `refreshedAt` is carried unchanged: the export describes the run
 * that produced the data, not the moment somebody exported it.
 */
export function sidecarForExport(
  sidecar: TripPlaceIntelligenceSidecar | null | undefined,
): TripPlaceIntelligenceSidecar | null {
  if (!sidecar) return null;

  const exportable = stripAllForExport(
    Object.values(sidecar.byCanonicalPlaceId),
  );
  if (exportable.length === 0) return null;

  const byCanonicalPlaceId: Record<string, CanonicalPlaceIntelligence> = {};
  for (const entry of exportable) {
    byCanonicalPlaceId[entry.canonicalPlaceId] = entry;
  }

  return { ...sidecar, byCanonicalPlaceId };
}

/* -------------------------------------------------------------------------- */
/* The guarded store write                                                    */
/* -------------------------------------------------------------------------- */

export type SaveTripIntelligenceInput = {
  tripId: string;
  expectedRevision: number;
  entries: CanonicalPlaceIntelligence[];
  /** When the enrichment run that produced these finished. Becomes the sidecar's `refreshedAt`. */
  fetchedAt: string;
};

/**
 * How a guarded intelligence write ended.
 *
 * Six arms rather than a boolean, because five of them need different words in front of a traveller and the sixth needs
 * none at all. `unchanged` is the one worth naming explicitly: re-running enrichment that produced exactly what is
 * already stored must not bump the revision, or every refresh would invalidate an in-flight save elsewhere and the
 * traveller would be told their trip changed when nothing did.
 */
export type SaveTripIntelligenceResult =
  | {
      status: "saved";
      revision: number;
      /** Entries written carrying at least one fact — the number a traveller is told. */
      matched: number;
    }
  | { status: "unchanged"; revision: number }
  | { status: "conflict"; actualRevision: number }
  | { status: "missing-trip" }
  | { status: "invalid"; reason: string }
  | { status: "storage-refused"; reason: string };

/**
 * Whether two sidecars hold the same enrichment.
 *
 * `refreshedAt` is **excluded**, deliberately. It changes on every run by definition, so including it would make every
 * re-enrichment look like a change and defeat the `unchanged` arm entirely — which is the arm that keeps a no-op refresh
 * from consuming a revision.
 *
 * Compared through a canonical serialisation rather than `JSON.stringify` directly: two objects with the same fields in
 * a different key order are the same sidecar, and a comparison that said otherwise would bump a revision for nothing.
 */
export function sameIntelligenceContent(
  a: TripPlaceIntelligenceSidecar | null | undefined,
  b: TripPlaceIntelligenceSidecar | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.schemaVersion !== b.schemaVersion) return false;

  return canonical(a.byCanonicalPlaceId) === canonical(b.byCanonicalPlaceId);
}

/** Keys sorted at every level, so key order cannot masquerade as a change. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/**
 * Entries carrying at least one fact.
 *
 * The honest reading of "matched". An identity-only entry is a place awaiting a person's confirmation — real, worth
 * storing, and not something to count in "8 places enriched", because nothing about it is displayed yet.
 */
export function countMatchedEntries(
  sidecar: TripPlaceIntelligenceSidecar | null,
): number {
  if (!sidecar) return 0;

  return Object.values(sidecar.byCanonicalPlaceId).filter(
    (entry) => entry.facts.length > 0,
  ).length;
}

/**
 * The first `MAX_SIDECAR_ENTRIES` entries, in key order.
 *
 * Key order rather than insertion order, so the cap is deterministic: the same merge always keeps the same twelve.
 * Insertion order would make which entries survived depend on the order two runs happened to complete in, which is a
 * difference nobody could explain from the stored record.
 */
function capEntries(
  entries: Record<string, CanonicalPlaceIntelligence>,
): Record<string, CanonicalPlaceIntelligence> {
  const keys = Object.keys(entries).sort();
  if (keys.length <= MAX_SIDECAR_ENTRIES) return entries;

  const capped: Record<string, CanonicalPlaceIntelligence> = {};
  for (const key of keys.slice(0, MAX_SIDECAR_ENTRIES)) {
    capped[key] = entries[key];
  }
  return capped;
}
