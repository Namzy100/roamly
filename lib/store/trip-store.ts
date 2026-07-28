"use client";

import { nanoid } from "nanoid";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { buildMockPlanForRequest } from "@/lib/mock/lisbon-trip";
import {
  TripGenerationContextSchema,
  TripPlanSchema,
  type TripGenerationContext,
  type TripPlan,
  type TripRequest,
} from "@/lib/schemas";

import { canPersist, persistedPayload } from "./capacity";
import {
  contextAfterRestore,
  describeHistory,
  historyBytes,
  stepBack,
  stepForward,
  type HistoryDepth,
  type TripHistoryKind,
} from "./history";
import { asImportedCopy, type PortableTrip } from "./portable-trip";
import {
  STORAGE_FAILURE_MESSAGES,
  type StorageFailure,
} from "./storage-usage";
import {
  TripRecordSchema,
  checkRevision,
  createTripRecord,
  nextRevision,
  parseStoredRecord,
  withRestoredState,
  withoutHistory,
  type SaveConflict,
  type StoredTripRecord,
} from "./trip-record";
import {
  PlaceIntelligenceSchema,
  type PlaceIntelligence,
} from "@/lib/place-intelligence";

import {
  countMatchedEntries,
  putIntelligence,
  reconcileTripIntelligence,
  sameIntelligenceContent,
  type SaveTripIntelligenceInput,
  type SaveTripIntelligenceResult,
} from "./trip-intelligence";

/**
 * Persisted trip state.
 *
 * Each trip is stored as a `StoredTripRecord` — a plan plus a revision counter —
 * so a multi-second enrichment can be written back under an optimistic-
 * concurrency check rather than blindly. See `./trip-record.ts` for why that
 * matters even without a server.
 */

export const STORAGE_KEY = "roamly:trips:v1";

/**
 * v2 wrapped each plan in a revision envelope; v3 replaces the single undo snapshot with a bounded
 * history.
 *
 * Both migrations are **lossless**, by the same reasoning. A v1 entry is a bare `TripPlan`, so it is
 * re-validated and wrapped at revision 1. A v2 entry's one snapshot is folded into one past entry,
 * so upgrading keeps the undo the traveller already had rather than quietly emptying it. Discarding
 * saved trips to change an envelope would be a cost with no benefit — the plan shape itself did not
 * change, and `TRIP_PLAN_SCHEMA_VERSION` is still what governs that.
 *
 * `parseStoredRecord` knows all three shapes, so the version number here only decides whether
 * `migrate` runs; it is never what identifies a record.
 */
const STORE_VERSION = 3;

/**
 * Why a guarded write was refused by storage rather than by the revision guard.
 *
 * Distinct from `SaveConflict`: a conflict means someone else changed the trip, and the answer is to
 * reload. This means the browser has no room, and the answer is to free some. Conflating them would
 * tell a traveller to reload when reloading cannot help.
 */
export type StorageRefusal = { reason: StorageFailure; message: string };

/**
 * One sentence for a refused save, whichever way it was refused.
 *
 * Written once because the two refusals need *different* advice and every caller would otherwise
 * write its own version of both: a revision conflict means reload, a quota refusal means free some
 * room, and telling a traveller to reload when reloading cannot help is the failure worth avoiding.
 */
export function describeSaveFailure(
  result: { conflict: SaveConflict } | { storage: StorageRefusal },
): string {
  if ("storage" in result) return result.storage.message;

  return result.conflict.reason === "missing"
    ? "This trip is no longer saved in this browser, so the change was discarded."
    : "This trip changed in another tab, so nothing was saved. Reload and try again.";
}

export type GuardedSaveResult =
  | { ok: true; revision: number }
  | { ok: false; conflict: SaveConflict }
  | { ok: false; storage: StorageRefusal };

type TripStoreState = {
  records: Record<string, StoredTripRecord>;
  /** Prefills the builder if the visitor comes back to plan another trip. */
  lastRequest: TripRequest | null;
  /**
   * The fixed Lisbon sample, for visitors who want to look around first.
   *
   * Returns `null` when the browser has no room — the caller must not navigate to a trip that was
   * not saved.
   */
  createTrip: (request: TripRequest) => string | null;
  /**
   * A generated trip, saved once at revision 1.
   *
   * Plan and generation context in a single `set`, so there is no moment at which a
   * generated trip exists without the pool that proves its places were discovered
   * rather than invented.
   */
  saveGeneratedTrip: (input: {
    tripId: string;
    request: TripRequest;
    plan: TripPlan;
    generation: TripGenerationContext;
  }) =>
    | { ok: true; revision: number }
    | { ok: false; reason: "invalid" }
    | { ok: false; storage: StorageRefusal };
  /**
   * Replacing an existing trip with a fresh generation, under the same guard as a
   * routing write. Increments once; a stale expectation writes nothing.
   */
  replaceGeneratedTrip: (input: {
    tripId: string;
    expectedRevision: number;
    plan: TripPlan;
    generation: TripGenerationContext;
  }) => GuardedSaveResult;
  /**
   * A reversible change, saved once under the expected revision.
   *
   * Records the state being replaced as a history entry in the *same* write, so a trip can never
   * exist in a state where it was changed but the way back was lost.
   *
   * `kind` is asked for rather than guessed from `action`, because it decides whether the
   * generation context travels with the entry — the difference between a 10 KB entry and a 72 KB
   * one. See `./history.ts`.
   */
  applyRefinement: (input: {
    tripId: string;
    expectedRevision: number;
    plan: TripPlan;
    generation: TripGenerationContext;
    action: string;
    kind: TripHistoryKind;
  }) => GuardedSaveResult;
  /**
   * Steps back or forward through the history, forwards in revision terms.
   *
   * The revision **increments** either way: going back is a new fact about the record, not a
   * retraction of an old one, and decrementing would make two different states share a revision
   * number — which is exactly what the guard exists to distinguish.
   */
  undo: (input: { tripId: string; expectedRevision: number }) => HistoryMoveResult;
  redo: (input: { tripId: string; expectedRevision: number }) => HistoryMoveResult;
  /**
   * Guarded replacement. Returns the conflict when the record moved underneath
   * the caller, and writes nothing in that case.
   */
  saveEnrichedPlan: (input: {
    tripId: string;
    expectedRevision: number;
    plan: TripPlan;
  }) => GuardedSaveResult;
  /**
   * The landmark sidecar, written once at the end of a bounded enrichment workflow.
   *
   * Guarded and atomic like every other write here, and deliberately **not** part of the undo history: enrichment adds
   * provider facts and takes nothing away, so stepping back over it would discard real lookups in exchange for nothing —
   * the reasoning routing is outside the history for.
   *
   * Its own result type rather than `GuardedSaveResult`, because it has an answer the others do not: `unchanged`, for a
   * refresh that produced exactly what is already stored. Reporting that as a save would consume a revision and tell the
   * traveller their trip changed when it did not.
   */
  saveTripIntelligence: (
    input: SaveTripIntelligenceInput,
  ) => SaveTripIntelligenceResult;
  /** Drops the whole sidecar. Separate, guarded and atomic — forgetting enrichment is its own decision. */
  clearTripIntelligence: (input: {
    tripId: string;
    expectedRevision: number;
  }) => SaveTripIntelligenceResult;
  removeTrip: (tripId: string) => void;
  clearAll: () => void;
  /**
   * Drops a trip's undo history, freeing whatever it had accumulated.
   *
   * A recovery action, offered only from the storage panel and only with confirmation: it is the one
   * thing a traveller can delete that costs them an *ability* rather than a trip. The revision does
   * **not** move — nothing about the itinerary changed, and incrementing would invalidate an
   * in-flight save for no reason.
   */
  dropHistory: (tripId: string) => { ok: boolean; freedBytes: number };
  /**
   * Imports a validated file as a brand-new trip.
   *
   * Returns the new id so the caller can navigate to it. The record is re-validated here even though
   * `parseImportedTrip` already did: this is the last point before it becomes the saved truth, and
   * the two checks are cheap.
   */
  importTripAsCopy: (input: {
    trip: PortableTrip;
    tripId: string;
  }) =>
    | { ok: true; tripId: string; revision: number }
    | { ok: false; storage: StorageRefusal }
    | { ok: false; reason: "invalid" };
  /**
   * Replaces an existing trip with an imported one, under the usual revision guard.
   *
   * The plan being replaced becomes the undo snapshot in the same write, so an accidental
   * replacement is one press away from being reversed.
   */
  replaceTripFromImport: (input: {
    tripId: string;
    expectedRevision: number;
    trip: PortableTrip;
  }) => GuardedSaveResult;
};

type PersistedShape = Pick<TripStoreState, "records" | "lastRequest">;

/**
 * Validates each stored record independently and keeps the ones that still match
 * the current schema. A single stale entry cannot take the rest down with it,
 * and anything unparseable is dropped rather than rendered.
 *
 * Accepts both shapes: a v2 envelope, and a bare v1 plan wrapped on the way in.
 */
function reviveRecords(value: unknown): Record<string, StoredTripRecord> {
  if (typeof value !== "object" || value === null) return {};

  /**
   * `Object.create(null)`, not `{}`.
   *
   * The keys come from a JSON blob in `localStorage`, and `revived[id] = …` with `id === "__proto__"`
   * on an ordinary object literal repoints the map's prototype at the attacker's record. Reaching this
   * needs arbitrary storage write already — so it adds nothing to a real attack — but a prototype-less
   * map costs nothing and removes the class of bug entirely. Spread back into an object at the end so
   * callers get an ordinary record map.
   */
  const revived: Record<string, StoredTripRecord> = Object.create(null);
  for (const [id, candidate] of Object.entries(value as Record<string, unknown>)) {
    // Belt and braces: a key that would shadow a prototype member is dropped rather than stored.
    if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
    /**
     * One door for every stored shape.
     *
     * `parseStoredRecord` handles v3, v2 (folding its snapshot into a past entry) and a bare v1
     * plan. Doing the version sniffing here as well would give two answers to "what shape is this",
     * and the one that drifts is whichever is written second.
     */
    const record = parseStoredRecord(candidate);
    if (record) revived[id] = record;
  }
  return { ...revived };
}

/**
 * Pre-flight: will this candidate state actually persist?
 *
 * Called by every guarded save before `set`. Zustand's `persist` writes *after* the state update, so
 * without this a full quota shows the change applied and then loses it on reload — a failure that
 * looks like success. See `./capacity.ts`.
 */
type Reservation =
  | {
      ok: true;
      /** What to commit. Not necessarily what was passed in — see the shedding pass. */
      records: Record<string, StoredTripRecord>;
      /** True when the write only fitted after this trip's history was discarded. */
      shedHistory: boolean;
    }
  | { ok: false; storage: StorageRefusal };

function attempt(
  records: Record<string, StoredTripRecord>,
  lastRequest: TripRequest | null,
) {
  return canPersist(
    STORAGE_KEY,
    persistedPayload(
      { records, lastRequest } satisfies PersistedShape,
      STORE_VERSION,
    ),
  );
}

function reserve(
  records: Record<string, StoredTripRecord>,
  lastRequest: TripRequest | null,
  /**
   * The trip this write is about, when there is one.
   *
   * Only its history may be shed. See below for why no other trip's is touched.
   */
  tripId?: string,
): Reservation {
  const first = attempt(records, lastRequest);
  if (first.ok) return { ok: true, records, shedHistory: false };

  /**
   * One retry, with this trip's history discarded.
   *
   * ## Why shedding is right here and refusing was not
   *
   * The history exists to protect edits. Refusing the write to protect the history inverts that: it
   * discards the change the traveller just made in order to keep the ability to discard changes
   * they made earlier. Undo depth is the cheaper thing to lose, so it is what gives way.
   *
   * ## Why only this trip's
   *
   * Freeing space by quietly emptying *other* trips' histories would take something away from a
   * trip the traveller is not even looking at, with no moment at which they could have objected.
   * The history that just grew is this one's, so this one's is what pays. If that still does not
   * fit, the save is refused and the storage panel's message explains what to delete — which keeps
   * every other destructive choice theirs.
   */
  const shed =
    tripId !== undefined &&
    records[tripId] !== undefined &&
    historyBytes(records[tripId].history) > 0
      ? { ...records, [tripId]: withoutHistory(records[tripId]) }
      : null;

  if (shed) {
    const second = attempt(shed, lastRequest);
    if (second.ok) return { ok: true, records: shed, shedHistory: true };
  }

  if (process.env.NODE_ENV !== "production") {
    console.warn("[roamly] storage refused a write", first.failure);
  }

  return {
    ok: false,
    storage: {
      reason: first.failure,
      message: STORAGE_FAILURE_MESSAGES[first.failure],
    },
  };
}

export type HistoryMoveResult =
  | { ok: true; revision: number; label: string }
  | { ok: false; conflict: SaveConflict }
  | { ok: false; reason: "nothing_to_move" };

/**
 * One step through the history, in either direction.
 *
 * ## Why undo and redo share this
 *
 * They differ in one word. Both check the revision, take an entry off one stack, re-validate it,
 * put the state being left on the other stack, and write once. Two copies of that would be two
 * places to forget the re-validation — and the copy written second is always the one that forgets.
 *
 * ## Why the entry is re-validated
 *
 * It was valid when stored and has since been through a `localStorage` round trip. A corrupt entry
 * must not become the traveller's trip. Reported as "nothing to move" rather than as an error: the
 * current plan is fine, and there is nothing they can do about a damaged entry except carry on.
 *
 * ## No capacity pre-flight
 *
 * A step swaps one plan for another and moves an entry between two stacks, so the payload's size is
 * essentially unchanged — the one write in this store that cannot meaningfully grow. Probing would
 * cost a full serialise to answer a question whose answer is already known.
 */
function move(
  get: () => TripStoreState,
  set: (partial: Partial<TripStoreState>) => void,
  input: { tripId: string; expectedRevision: number; direction: "back" | "forward" },
): HistoryMoveResult {
  const current = get().records[input.tripId];

  const conflict = checkRevision(current, input.expectedRevision);
  if (conflict) return { ok: false, conflict };

  const step = (input.direction === "back" ? stepBack : stepForward)(
    current.history,
    {
      plan: current.plan,
      generation: current.generation,
      revision: current.revision,
    },
  );
  if (!step) return { ok: false, reason: "nothing_to_move" };

  const parsedPlan = TripPlanSchema.safeParse(step.entry.plan);
  if (!parsedPlan.success) return { ok: false, reason: "nothing_to_move" };

  const restoredContext = contextAfterRestore(step.entry, current.generation);
  const parsedGeneration =
    restoredContext === null
      ? { success: true as const, data: null }
      : TripGenerationContextSchema.safeParse(restoredContext);
  if (!parsedGeneration.success) return { ok: false, reason: "nothing_to_move" };

  const updated = withRestoredState(
    current,
    { plan: parsedPlan.data, generation: parsedGeneration.data },
    step.history,
    new Date().toISOString(),
  );

  set({ records: { ...get().records, [input.tripId]: updated } });
  return { ok: true, revision: updated.revision, label: step.entry.label };
}

export const useTripStore = create<TripStoreState>()(
  persist(
    (set, get) => ({
      records: {},
      lastRequest: null,

      createTrip: (request) => {
        const tripId = nanoid(10);
        // Called from an event handler, never during render, so reading the
        // clock here cannot cause a hydration mismatch.
        const now = new Date().toISOString();
        const plan = buildMockPlanForRequest(tripId, request, now);
        const records = { ...get().records, [tripId]: createTripRecord(plan, now) };

        /**
         * The sample trip pre-flights too.
         *
         * It was the one *adding* path that did not, which quietly defeated the whole guarantee: on a
         * full browser it would navigate to a workspace showing a trip that was never persisted. The
         * sample is reproducible, so nothing is lost — but "looks saved, is not" is the failure mode
         * this mechanism exists to remove, and an exception for the easiest path to reach is the worst
         * place to leave one.
         */
        const room = reserve(records, request, tripId);
        if (!room.ok) return null;

        set({ records: room.records, lastRequest: request });
        return tripId;
      },

      saveGeneratedTrip: ({ tripId, request, plan, generation }) => {
        /**
         * Both halves re-validated at the boundary.
         *
         * They crossed an API and a JSON round trip to get here, and this is the
         * last point before they become the saved truth. In particular the pool is
         * re-parsed: a generated trip whose pool did not survive serialisation
         * would be a trip whose provenance cannot be checked, and it must not be
         * stored looking valid.
         */
        const parsedPlan = TripPlanSchema.safeParse(plan);
        const parsedGeneration = TripGenerationContextSchema.safeParse(generation);
        if (!parsedPlan.success || !parsedGeneration.success) {
          return { ok: false, reason: "invalid" };
        }

        const now = new Date().toISOString();
        const records = {
          ...get().records,
          [tripId]: createTripRecord(parsedPlan.data, now, parsedGeneration.data),
        };

        // Refused *before* the state moves, so a full quota cannot show a saved trip that is not.
        const room = reserve(records, request, tripId);
        if (!room.ok) return { ok: false, storage: room.storage };

        // One atomic write. There is no state in which the plan is saved and the
        // pool is not.
        set({ records: room.records, lastRequest: request });

        return { ok: true, revision: 1 };
      },

      replaceGeneratedTrip: ({ tripId, expectedRevision, plan, generation }) => {
        const current = get().records[tripId];

        const conflict = checkRevision(current, expectedRevision);
        if (conflict) return { ok: false, conflict };

        const parsedPlan = TripPlanSchema.safeParse(plan);
        const parsedGeneration = TripGenerationContextSchema.safeParse(generation);
        if (!parsedPlan.success || !parsedGeneration.success) {
          // Reported as a conflict rather than a separate arm: from the caller's
          // point of view the outcome is identical — nothing was written, and the
          // old trip is untouched.
          return {
            ok: false,
            conflict: {
              reason: "revision_mismatch",
              expectedRevision,
              actualRevision: current.revision,
            },
          };
        }

        const updated = nextRevision(
          current,
          parsedPlan.data,
          new Date().toISOString(),
          parsedGeneration.data,
        );

        const records = { ...get().records, [tripId]: updated };
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) return { ok: false, storage: room.storage };

        set({ records: room.records });

        return { ok: true, revision: updated.revision };
      },

      applyRefinement: ({
        tripId,
        expectedRevision,
        plan,
        generation,
        action,
        kind,
      }) => {
        const current = get().records[tripId];

        const conflict = checkRevision(current, expectedRevision);
        if (conflict) return { ok: false, conflict };

        const parsedPlan = TripPlanSchema.safeParse(plan);
        const parsedGeneration = TripGenerationContextSchema.safeParse(generation);
        if (!parsedPlan.success || !parsedGeneration.success) {
          // Reported as a conflict: from the caller's point of view the outcome is
          // identical — nothing was written and the old trip stands.
          return {
            ok: false,
            conflict: {
              reason: "revision_mismatch",
              expectedRevision,
              actualRevision: current.revision,
            },
          };
        }

        const updated = nextRevision(
          current,
          parsedPlan.data,
          new Date().toISOString(),
          parsedGeneration.data,
          // The state being replaced becomes a history entry, in this same write.
          { label: action, kind },
        );

        const records = { ...get().records, [tripId]: updated };
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) return { ok: false, storage: room.storage };

        set({ records: room.records });
        return { ok: true, revision: updated.revision };
      },

      undo: ({ tripId, expectedRevision }) =>
        move(get, set, { tripId, expectedRevision, direction: "back" }),

      redo: ({ tripId, expectedRevision }) =>
        move(get, set, { tripId, expectedRevision, direction: "forward" }),

      saveEnrichedPlan: ({ tripId, expectedRevision, plan }) => {
        const current = get().records[tripId];

        const conflict = checkRevision(current, expectedRevision);
        if (conflict) return { ok: false, conflict };

        // Re-validate at the boundary. The plan crossed an API and a JSON
        // round-trip to get here, and this is the last point before it is the
        // saved truth.
        const parsed = TripPlanSchema.safeParse(plan);
        if (!parsed.success) {
          return {
            ok: false,
            conflict: {
              reason: "revision_mismatch",
              expectedRevision,
              actualRevision: current.revision,
            },
          };
        }

        /**
         * No `generation` argument and no snapshot change.
         *
         * Routing does not change how a trip was generated, so the retained pool and
         * provenance pass through untouched — and it deliberately does **not** consume
         * the undo slot. Undoing a route calculation would discard real measurements
         * for nothing, and it would cost the traveller the undo their last *refinement*
         * is entitled to.
         */
        const updated = nextRevision(
          current,
          parsed.data,
          new Date().toISOString(),
        );

        const records = { ...get().records, [tripId]: updated };
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) return { ok: false, storage: room.storage };

        // One atomic replacement. There is no intermediate state in which the
        // trip is half-routed.
        set({ records: room.records });

        return { ok: true, revision: updated.revision };
      },

      saveTripIntelligence: ({
        tripId,
        expectedRevision,
        entries,
        fetchedAt,
      }) => {
        const current = get().records[tripId];
        if (!current) return { status: "missing-trip" };

        const conflict = checkRevision(current, expectedRevision);
        if (conflict) {
          return { status: "conflict", actualRevision: current.revision };
        }

        if (!Number.isFinite(Date.parse(fetchedAt))) {
          return {
            status: "invalid",
            reason: "The enrichment timestamp is not a usable date.",
          };
        }

        /*
         * Re-validated at the boundary, entry by entry.
         *
         * These crossed an API and a JSON round trip to get here, and this is the last point before they become the
         * saved truth — the same reason `saveEnrichedPlan` re-parses its plan. One bad entry refuses the whole write
         * rather than being dropped: a caller handing over something unparseable has a bug, and silently storing the
         * rest would hide it behind a partially enriched trip.
         */
        const parsed: PlaceIntelligence[] = [];
        for (const entry of entries) {
          const result = PlaceIntelligenceSchema.safeParse(entry);
          if (!result.success) {
            return {
              status: "invalid",
              reason:
                "One of the enrichment records did not pass validation, so nothing was saved.",
            };
          }
          parsed.push(result.data);
        }

        /*
         * Merge, then reconcile against the trip as it stands.
         *
         * Reconciliation runs on the way *in* as well as after an edit, because the plan may have changed while the
         * enrichment requests were in flight — a traveller can remove a stop during a ninety-second run, and storing an
         * entry for a place the trip no longer owns would be storing something no reader could reach.
         */
        const merged = putIntelligence(current.intelligence, parsed, fetchedAt);
        const reconciled = reconcileTripIntelligence({
          intelligence: merged,
          plan: current.plan,
          generationContext: current.generation,
        });

        if (sameIntelligenceContent(current.intelligence, reconciled)) {
          /* Nothing new. No revision consumed, no write, and the caller is told so rather than told "saved". */
          return { status: "unchanged", revision: current.revision };
        }

        /*
         * `nextRevision` with the plan unchanged and no history entry.
         *
         * The default `"keep"` is what leaves the undo stack alone. The plan is passed through as-is because enrichment
         * cannot touch it — this action has no way to produce a plan, which is the enforcement rather than the intent.
         */
        const updated: StoredTripRecord = {
          ...nextRevision(current, current.plan, new Date().toISOString()),
          intelligence: reconciled,
        };

        const records = { ...get().records, [tripId]: updated };
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) {
          return { status: "storage-refused", reason: room.storage.message };
        }

        /* One atomic replacement. There is no state in which the trip is half-enriched. */
        set({ records: room.records });

        return {
          status: "saved",
          revision: updated.revision,
          matched: countMatchedEntries(reconciled),
        };
      },

      clearTripIntelligence: ({ tripId, expectedRevision }) => {
        const current = get().records[tripId];
        if (!current) return { status: "missing-trip" };

        const conflict = checkRevision(current, expectedRevision);
        if (conflict) {
          return { status: "conflict", actualRevision: current.revision };
        }

        if (!current.intelligence) {
          return { status: "unchanged", revision: current.revision };
        }

        const updated: StoredTripRecord = {
          ...nextRevision(current, current.plan, new Date().toISOString()),
          intelligence: null,
        };

        const records = { ...get().records, [tripId]: updated };
        /*
         * Reserved even though this only ever frees room.
         *
         * The check is cheap and the alternative is a special case: a write that skipped the reservation because it
         * "obviously fits" is a write nobody would think to revisit if the record ever grew for another reason.
         */
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) {
          return { status: "storage-refused", reason: room.storage.message };
        }

        set({ records: room.records });

        return { status: "saved", revision: updated.revision, matched: 0 };
      },

      removeTrip: (tripId) =>
        set((state) => {
          const next = { ...state.records };
          delete next[tripId];
          return { records: next };
        }),

      clearAll: () => set({ records: {}, lastRequest: null }),

      dropHistory: (tripId) => {
        const current = get().records[tripId];
        const freedBytes = current ? historyBytes(current.history) : 0;
        if (!current || current.history.past.length + current.history.future.length === 0) {
          return { ok: false, freedBytes: 0 };
        }

        /**
         * The revision deliberately does not move.
         *
         * Nothing about the itinerary changed — only the ability to step through it. Incrementing
         * would invalidate an in-flight guarded save for a reason that has nothing to do with it,
         * and shrinking a record can never fail for quota, so no pre-flight is needed either.
         */
        set((state) => ({
          records: { ...state.records, [tripId]: withoutHistory(current) },
        }));
        return { ok: true, freedBytes };
      },

      importTripAsCopy: ({ trip, tripId }) => {
        const now = new Date().toISOString();
        const candidate = asImportedCopy(trip, tripId, now);

        /**
         * Re-validated even though `parseImportedTrip` already did.
         *
         * That ran on the file; this runs on the record we are about to store, after the copy
         * rewrote the id and the timestamps. The two are cheap and the second is the one that
         * guards the store.
         */
        const parsed = TripRecordSchema.safeParse(candidate);
        if (!parsed.success) return { ok: false, reason: "invalid" };

        const records = { ...get().records, [tripId]: parsed.data };
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) return { ok: false, storage: room.storage };

        set({ records: room.records });
        return { ok: true, tripId, revision: 1 };
      },

      replaceTripFromImport: ({ tripId, expectedRevision, trip }) => {
        const current = get().records[tripId];

        const conflict = checkRevision(current, expectedRevision);
        if (conflict) return { ok: false, conflict };

        /**
         * The imported plan lands on the *existing* record's revision line, with the plan it
         * replaces captured as the undo snapshot in the same write. So an accidental replacement is
         * one press away from being reversed, and a stale expectation writes nothing.
         */
        const updated = nextRevision(
          current,
          trip.record.plan,
          new Date().toISOString(),
          trip.record.generation,
          { label: "Import over this trip", kind: "import-replacement" },
        );

        const parsed = TripRecordSchema.safeParse(updated);
        if (!parsed.success) {
          return {
            ok: false,
            conflict: {
              reason: "revision_mismatch",
              expectedRevision,
              actualRevision: current.revision,
            },
          };
        }

        const records = { ...get().records, [tripId]: parsed.data };
        const room = reserve(records, get().lastRequest, tripId);
        if (!room.ok) return { ok: false, storage: room.storage };

        set({ records: room.records });
        return { ok: true, revision: parsed.data.revision };
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      /**
       * Hydration is driven explicitly from `useTripStoreHydration` after mount.
       * Automatic hydration would touch `localStorage` while the module is first
       * evaluated — which on the server means a crash, and on the client means
       * the first render disagrees with the server's HTML.
       */
      skipHydration: true,
      partialize: (state): PersistedShape => ({
        records: state.records,
        lastRequest: state.lastRequest,
      }),
      /**
       * v1 → v2. The old shape keyed bare plans under `trips`; `reviveRecords`
       * accepts either, so the migration is just a rename.
       */
      migrate: (persisted, version) => {
        if (version >= STORE_VERSION) return persisted as PersistedShape;

        const legacy = (persisted ?? {}) as {
          trips?: unknown;
          lastRequest?: TripRequest | null;
        };
        return {
          records: reviveRecords(legacy.trips),
          lastRequest: legacy.lastRequest ?? null,
        } satisfies PersistedShape;
      },
      merge: (persisted, current) => {
        const incoming = (persisted ?? {}) as Partial<PersistedShape>;
        return {
          ...current,
          records: reviveRecords(incoming.records),
          lastRequest: incoming.lastRequest ?? null,
        };
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error && process.env.NODE_ENV !== "production") {
          console.warn("[roamly] could not read stored trips", error);
        }
      },
    },
  ),
);

/**
 * A development-only handle for the browser verification suite.
 *
 * The optimistic-concurrency guard can only be exercised by making a record move
 * *while* a request is in flight, which no user-facing affordance can do on
 * purpose. Rather than leave that path untested, the store is reachable from the
 * console in development — the same seam `map-panel.tsx` uses to force its
 * fallback renderer.
 *
 * Stripped in production by the `NODE_ENV` guard, which is a build-time constant
 * so the branch is eliminated entirely rather than merely skipped.
 */
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as unknown as { __roamlyTripStore?: typeof useTripStore })
    .__roamlyTripStore = useTripStore;
}

export function useTripRecord(tripId: string): StoredTripRecord | undefined {
  return useTripStore((state) => state.records[tripId]);
}

export function useTripPlan(tripId: string): TripPlan | undefined {
  return useTripStore((state) => state.records[tripId]?.plan);
}

/**
 * The retained generation context, or null.
 *
 * Null for the sample trip and for anything saved before Phase 5B. Callers must
 * treat that as "this trip has no discovery pool", not as "the pool is empty" — the
 * two lead to different fallbacks in `use-trip-routing`.
 */
export function useTripGeneration(
  tripId: string,
): TripGenerationContext | null {
  return useTripStore((state) => state.records[tripId]?.generation ?? null);
}

export function useTripCount(): number {
  return useTripStore((state) => Object.keys(state.records).length);
}

/**
 * How far this trip can actually be stepped back and forward, and what the next step is called.
 *
 * ## Actual depth, never the maximum
 *
 * The interface must not promise twenty. Both bounds are real — a long routed trip reaches the byte
 * budget at around fourteen entries, and a trip just created has none at all — so a control reading
 * "Undo (20)" would be wrong most of the time and wrong in the direction that erodes trust: it
 * would run out earlier than it said.
 *
 * ## Labels, not entries
 *
 * The panel needs to say "Undo change time"; it has no use for the plan behind it, and selecting
 * the entry would hand a component tens of kilobytes it would only ever read one string from.
 *
 * ## Why the whole object is derived here
 *
 * Zustand compares selector results by identity, so returning a fresh object every render would
 * re-render on every store change. The four fields are pulled out individually and reassembled,
 * which keeps each subscription on a primitive.
 */
export function useHistoryDepth(tripId: string): HistoryDepth {
  const undoDepth = useTripStore(
    (state) => state.records[tripId]?.history.past.length ?? 0,
  );
  const redoDepth = useTripStore(
    (state) => state.records[tripId]?.history.future.length ?? 0,
  );
  const nextUndo = useTripStore(
    (state) => state.records[tripId]?.history.past.at(-1)?.label ?? null,
  );
  const nextRedo = useTripStore(
    (state) => state.records[tripId]?.history.future[0]?.label ?? null,
  );
  /**
   * Measured lazily and only when something is stored.
   *
   * `historyBytes` serialises the whole history, which is far too expensive to run on every render
   * of a trip that has none — and an empty history is the common case.
   */
  const bytes = useTripStore((state) => {
    const history = state.records[tripId]?.history;
    if (!history || history.past.length + history.future.length === 0) return 0;
    return historyBytes(history);
  });

  return { undoDepth, redoDepth, nextUndo, nextRedo, bytes };
}

/** The whole history, for the storage panel's accounting. Not for rendering a plan. */
export function summariseHistory(record: StoredTripRecord): HistoryDepth {
  return describeHistory(record.history);
}
