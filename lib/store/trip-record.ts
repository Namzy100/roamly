import { nanoid } from "nanoid";
import { z } from "zod";

import {
  TripGenerationContextSchema,
  TripPlanSchema,
  type TripGenerationContext,
  type TripPlan,
} from "@/lib/schemas";

import {
  EMPTY_HISTORY,
  TripHistorySchema,
  kindChangesContext,
  pushHistory,
  type TripHistory,
  type TripHistoryEntry,
  type TripHistoryKind,
} from "./history";
import {
  TripPlaceIntelligenceSidecarSchema,
  type TripPlaceIntelligenceSidecar,
} from "./trip-intelligence";

/**
 * The stored envelope around a plan.
 *
 * ## Why a revision counter exists in a localStorage app
 *
 * Routing a trip is a multi-second operation involving many provider calls. In
 * that window the same trip can change underneath us — a second tab, a browser
 * restoring a session, the traveller pressing the button twice from two places.
 * Writing the enriched plan unconditionally at the end would silently discard
 * whatever happened in between.
 *
 * So the write is guarded: read the current revision, do the work in memory,
 * and refuse the save if the revision moved. One integer is enough, and it is
 * the same optimistic-concurrency mechanism a database would use — this is not
 * a database substitute, it is the identical idea at a smaller scale.
 *
 * ## Why the counter lives here and not on items
 *
 * A revision is a property of *the saved record*, not of the trip. Putting it
 * inside `TripPlan` would make it part of the domain — two plans with identical
 * itineraries would compare unequal, and it would leak into every fixture and
 * every API payload. The envelope keeps storage concerns in storage.
 *
 * ## Why the generation context lives here too (Phase 5B)
 *
 * The same argument. Which model produced a plan, and the exact place pool it was
 * assembled from, are facts about a *generation run* rather than about a trip. They
 * are also facts that must not be lost: the pool is the evidence behind the
 * no-invention claim, and re-deriving it later from the plan's own contents would be
 * the plan vouching for itself.
 *
 * Putting it in the envelope gets both properties for free. It is written in the
 * same `set` call as the plan, so there is no state in which a trip exists without
 * its pool, and the single `revision` covers the pair — a guarded write replaces
 * both or neither.
 */

export const TripRecordSchema = z.object({
  /** Starts at 1 on creation, increments once per accepted write. */
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  plan: TripPlanSchema,
  /**
   * Present for generated trips; null for the sample trip and for anything saved
   * before Phase 5B.
   *
   * `.nullable().default(null)` rather than a `STORE_VERSION` bump: a v2 record
   * parses unchanged and reports "no generation context", which is true. Discarding
   * everyone's saved trips to add a field would be a cost with no compatibility
   * benefit — the same reasoning `TripPlan.routing` was added under.
   */
  generation: TripGenerationContextSchema.nullable().default(null),
  /**
   * Bounded undo and redo (Phase 8, Checkpoint 3) — replacing Phase 6A's single snapshot.
   *
   * ## Why one level stopped being enough
   *
   * One snapshot was the right answer while the only reversible action was an AI refinement: those
   * are rare, deliberate and large, and "put it back" answers them completely. Phase 8 made the
   * itinerary directly editable, so a traveller now performs a *sequence* of small edits — nudge a
   * time, reorder two stops, change a length — and a single slot means the second edit destroys the
   * way back from the first. That is the point at which one level stops being a simplification and
   * starts being a trap.
   *
   * ## What kept it from being a history before, and what changed
   *
   * The Phase 6A note here said a history "grows without bound inside `localStorage`", which was
   * correct and is exactly what `./history.ts` now bounds — by count *and* by measured bytes,
   * against numbers taken from this project's own fixtures rather than guessed. The other objection,
   * that it invites a version-browser UI, is answered by not building one: the interface offers a
   * step back and a step forward and reports how many of each it actually has.
   *
   * ## Still not everything is undoable
   *
   * Routing remains outside it, for the Phase 6A reason, which has not changed: a route calculation
   * adds provider facts and takes nothing away, so undoing one would discard real measurements in
   * exchange for nothing.
   */
  history: TripHistorySchema,
  /**
   * Landmark enrichment from Wikidata and Wikimedia Commons (Phase 8, Checkpoint 5B).
   *
   * ## Why it is in the envelope
   *
   * The same argument the generation context is here for. Enrichment is a fact about a *run* rather than about the
   * trip, and it must not become a field on `TripPlace` — `assertItineraryUsesPool` compares those field by field, so
   * an enrichment refreshing on its own schedule would read as tampering. Keyed by `canonicalPlaceId` in a sidecar, it
   * refreshes independently and the verified places stay byte-stable.
   *
   * Putting it in the envelope also means the single `revision` covers the pair: a guarded write replaces the plan and
   * its enrichment together, or neither.
   *
   * ## Nullable and defaulted, not a version bump
   *
   * `.nullable().default(null)`, exactly as `generation` was added. A record saved before this checkpoint parses
   * unchanged and reports "no enrichment", which is true. Discarding everyone's saved trips to add an optional
   * sidecar would be a cost with no compatibility benefit.
   *
   * The sidecar carries its **own** `schemaVersion`, so a change to what enrichment means can invalidate the sidecar
   * without invalidating the trip — see `trip-intelligence.ts`. Dropping enrichment leaves a working, licence-clean
   * trip, which is what makes that safe.
   */
  intelligence: TripPlaceIntelligenceSidecarSchema.nullable().default(null),
});
export type StoredTripRecord = z.infer<typeof TripRecordSchema>;
export type { TripPlaceIntelligenceSidecar };

/**
 * The Phase 6A shape, kept only so its saved records can be read once and converted.
 *
 * Not exported. Nothing should be able to construct one — the only legitimate source is a browser
 * that has not been opened since the schema changed, and `parseStoredRecord` is the one door.
 */
const LegacyV2RecordSchema = z.object({
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  plan: TripPlanSchema,
  generation: TripGenerationContextSchema.nullable().default(null),
  previousSnapshot: z
    .object({
      plan: TripPlanSchema,
      generation: TripGenerationContextSchema.nullable(),
      revision: z.number().int().positive(),
      createdAt: z.string().min(1),
      action: z.string().min(1),
    })
    .nullable()
    .default(null),
});

/**
 * A stored record in whatever shape the browser happens to hold, as a v3 record.
 *
 * ## Why this is a function rather than three `safeParse` calls at each call site
 *
 * There are three of them — the persist migration, the rehydration merge, and an import — and each
 * one reading storage in its own way is how a v2 record would end up losing its undo on one path
 * and keeping it on another. One door.
 *
 * ## Why v2 is detected by shape rather than by the version number
 *
 * `history` has a default, so a v2 record parses cleanly as a v3 one and quietly arrives with an
 * empty history — losing the snapshot with no error to notice. Checking for the old field first is
 * what makes the conversion happen; relying on the persist `version` would miss every record that
 * reaches here by another route, an imported file among them.
 *
 * Returns `null` for anything unreadable, so a single corrupt record cannot take the rest down.
 */
export function parseStoredRecord(candidate: unknown): StoredTripRecord | null {
  if (looksLegacy(candidate)) {
    const legacy = LegacyV2RecordSchema.safeParse(candidate);
    if (legacy.success) return fromLegacy(legacy.data);
    // Falls through: a v2 record whose snapshot is corrupt is still worth keeping without it.
  }

  const current = TripRecordSchema.safeParse(candidate);
  if (current.success) return current.data;

  /** A v1 entry: a bare plan with no envelope at all. */
  const plan = TripPlanSchema.safeParse(candidate);
  if (plan.success) return createTripRecord(plan.data, plan.data.createdAt);

  return null;
}

function looksLegacy(candidate: unknown): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "previousSnapshot" in candidate &&
    !("history" in candidate)
  );
}

/**
 * A v2 record's single snapshot, as the one past entry it always was.
 *
 * The traveller keeps their undo across the upgrade, which is the whole reason for converting
 * rather than defaulting to empty. `kind` is `"refinement"` because that is the only thing Phase 6A
 * ever snapshotted, and the context travels with it because a refinement could replace the pool.
 */
function fromLegacy(
  legacy: z.infer<typeof LegacyV2RecordSchema>,
): StoredTripRecord {
  const snapshot = legacy.previousSnapshot;

  return {
    revision: legacy.revision,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    plan: legacy.plan,
    generation: legacy.generation,
    history: snapshot
      ? {
          past: [
            {
              id: `migrated:${snapshot.revision}`,
              label: snapshot.action,
              createdAt: snapshot.createdAt,
              beforeRevision: snapshot.revision,
              afterRevision: legacy.revision,
              kind: "refinement",
              plan: snapshot.plan,
              generationContext: snapshot.generation,
            },
          ],
          future: [],
        }
      : EMPTY_HISTORY,
    /* A v2 record predates enrichment entirely, so there is nothing to carry across. */
    intelligence: null,
  };
}

export function createTripRecord(
  plan: TripPlan,
  now: string,
  generation: TripGenerationContext | null = null,
): StoredTripRecord {
  return {
    revision: 1,
    createdAt: now,
    updatedAt: now,
    plan,
    generation,
    // A brand-new trip has nothing to go back to.
    history: EMPTY_HISTORY,
    /* Enrichment is a later, separate, serial pass. A trip is complete without it. */
    intelligence: null,
  };
}

/**
 * The next revision of a record.
 *
 * Immutable replacement, like everything else in this phase: the caller gets a
 * new record and the old one is untouched, so a rejected write leaves no trace.
 */
export function nextRevision(
  record: StoredTripRecord,
  plan: TripPlan,
  now: string,
  /**
   * Omitted for a routing write, which must not touch the generation context —
   * routing does not change how the trip was generated. Supplied for a
   * regeneration, which replaces the pool along with the plan.
   */
  generation?: TripGenerationContext | null,
  /**
   * What to record in the history.
   *
   * `"keep"` (the default) adds nothing — a routing write must not consume a step of the
   * traveller's undo, for the reason given on the `history` field. Anything else captures the
   * record's *current* state as a past entry, which is what every reversible action does.
   *
   * The `kind` is what decides whether the generation context travels with the entry, so it is
   * asked for rather than inferred from the label: two actions can share a label and differ in
   * whether they touched the pool.
   */
  entry: "keep" | { label: string; kind: TripHistoryKind } = "keep",
): StoredTripRecord {
  return {
    revision: record.revision + 1,
    createdAt: record.createdAt,
    updatedAt: now,
    plan,
    generation: generation === undefined ? record.generation : generation,
    history:
      entry === "keep"
        ? record.history
        : pushHistory(record.history, {
            id: nanoid(10),
            label: entry.label,
            createdAt: now,
            beforeRevision: record.revision,
            afterRevision: record.revision + 1,
            kind: entry.kind,
            // The state being replaced, captured before the new plan lands.
            plan: record.plan,
            ...(kindChangesContext(entry.kind)
              ? { generationContext: record.generation }
              : {}),
          }),
    /*
     * Enrichment is carried forward, never revised here.
     *
     * The same treatment routing gets, for the same reason: enrichment adds provider facts and takes nothing away, so
     * an edit to the itinerary has nothing to say about a monastery's founding date. A write that genuinely replaces
     * enrichment goes through `putIntelligence` and then this function, which is a visible two-step rather than a
     * silent side effect of every save.
     *
     * A stop removed by an edit leaves its entry behind until `reconcileTripIntelligence` is called — bounded by the
     * sidecar's own twelve-entry cap in the meantime.
     */
    intelligence: record.intelligence,
  };
}

/**
 * A record moved to a state its history already held.
 *
 * ## The revision still goes forward
 *
 * Going back is a new fact about the record, not a retraction of an old one. Decrementing would
 * make two different states share a revision number, which is precisely what the guard exists to
 * tell apart — an in-flight save captured before the undo would then be accepted after it.
 *
 * ## The history is supplied rather than derived
 *
 * `stepBack` and `stepForward` already computed both halves — which entry to restore, and what the
 * stacks look like afterwards — and recomputing either here would be a second opinion about the
 * same question.
 */
export function withRestoredState(
  record: StoredTripRecord,
  restored: { plan: TripPlan; generation: TripGenerationContext | null },
  history: TripHistory,
  now: string,
): StoredTripRecord {
  return {
    revision: record.revision + 1,
    createdAt: record.createdAt,
    updatedAt: now,
    plan: restored.plan,
    generation: restored.generation,
    history,
    /*
     * Undo does not revert enrichment.
     *
     * Routing is outside the history for the Phase 6A reason — undoing a route calculation would discard real
     * measurements in exchange for nothing — and enrichment is the same shape. A traveller stepping back a reorder is
     * not asking to forget which Wikidata entity a museum is.
     */
    intelligence: record.intelligence,
  };
}

/** A record with its history discarded, for the storage panel's recovery action. */
export function withoutHistory(record: StoredTripRecord): StoredTripRecord {
  return { ...record, history: EMPTY_HISTORY };
}

export type { TripHistory, TripHistoryEntry };

/** Why a guarded write was refused. */
export type SaveConflict = {
  reason: "missing" | "revision_mismatch";
  expectedRevision: number;
  actualRevision: number | null;
};

/**
 * The guard itself.
 *
 * Returns the conflict rather than throwing, because a conflict is a normal
 * outcome the UI has to render — "this trip changed in another tab, reload" is
 * information, not an exception.
 */
export function checkRevision(
  current: StoredTripRecord | undefined,
  expectedRevision: number,
): SaveConflict | null {
  if (!current) {
    return { reason: "missing", expectedRevision, actualRevision: null };
  }
  if (current.revision !== expectedRevision) {
    return {
      reason: "revision_mismatch",
      expectedRevision,
      actualRevision: current.revision,
    };
  }
  return null;
}
