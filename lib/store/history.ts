import { z } from "zod";

import {
  TripGenerationContextSchema,
  TripPlanSchema,
  type TripGenerationContext,
  type TripPlan,
} from "@/lib/schemas";

/**
 * Bounded undo and redo for one trip.
 *
 * ## Why the bound is two bounds
 *
 * A count alone does not bound bytes. Twenty entries is twenty plans, and a plan is 10 KB for a
 * two-day trip and forty for a seven-day one whose legs are routed — so "20" describes a footprint
 * that varies fourfold with nothing to stop it. A byte budget alone does not bound the count
 * either: it would happily keep two hundred entries of a small trip, which is a version browser
 * nobody asked for and a linear scan on every write.
 *
 * So both, whichever bites first. The count is the product decision — how far back is useful — and
 * the byte budget is the safety net that stops one large trip crowding out the other eleven.
 *
 * ## What an entry carries, and what it deliberately does not
 *
 * The plan, always. The generation context **only when the action changed it**.
 *
 * That asymmetry is the most important thing in this module, and it is measured rather than
 * assumed. Against the project's own fixtures a plan is 10.3 KB, while a generation context holding
 * a 127-place pool is 61.6 KB. Ordinary edits — a time change, a reorder, a lock — never touch the
 * pool, so carrying the context in every entry would store the same pool twenty times over and turn
 * a 206 KB history into a 1.2 MB one. Omitting it is a sevenfold saving on the entries that make up
 * almost all of a history.
 *
 * Absent therefore means "the context did not change here", and restoring such an entry leaves the
 * record's current context alone. That composes correctly with a pool refresh further back: undoing
 * the ordinary edits keeps the refreshed pool, and undoing the refresh restores the old one,
 * because that is the entry carrying it.
 *
 * ## Why whole plans rather than day-level deltas
 *
 * A delta would be smaller — 3.7 KB against 10.3 KB per entry, measured — and its size would not
 * grow with the trip, since an edit touches at most two days however long the trip is. It was the
 * tempting option and it was declined: restoring a delta means a patch that has to be the exact
 * inverse of every applier, now and after every applier written later. An entry that *is* the
 * previous plan cannot be a wrong inverse of anything.
 *
 * The byte budget is what makes that affordable. On a long routed trip the depth simply comes down,
 * and the interface reports the depth it has rather than the twenty it would like.
 */

/**
 * How far back and forward a trip remembers.
 *
 * Twenty is a product judgement rather than a measurement: far enough that somebody experimenting
 * with an afternoon can get back to where they started, short enough that the list is never
 * something to navigate rather than step through.
 */
export const MAX_HISTORY_ENTRIES = 20;

/**
 * The serialized ceiling for one trip's past and future together.
 *
 * 512 KB, chosen against measurements of the project's own fixtures rather than for looking round:
 *
 *  - twenty plan-sized entries of a two-day trip come to **206 KB**, so ordinary use never reaches
 *    this and the count bound is what governs
 *  - a seven-day trip with route geometry at realistic density (180 points a leg, giving a 27 KB
 *    plan) reaches the budget at roughly fourteen entries — the case this bound exists for
 *  - three trips each holding a full history is about **1.6 MB**, comfortably inside the ~5 MB a
 *    browser origin typically allows, leaving room for the records themselves and for the other
 *    trips somebody is likely to have
 *
 * Raising it to 1 MB would put three trips at 3 MB, over half a typical origin before the records
 * are counted. Lowering it to 256 KB would cost depth on exactly the routed trips where undo is
 * worth most. Neither was supported by the numbers.
 *
 * This is a budget for *our own* growth, not a claim about the browser's capacity — the app
 * deliberately has no global quota constant, for the reasons in `./storage-usage.ts`, and the
 * capacity probe remains the thing that decides whether a write actually fits.
 */
export const MAX_HISTORY_BYTES_PER_TRIP = 512 * 1024;

/**
 * What kind of action an entry can undo.
 *
 * A closed union rather than a free string, because the kind is what decides whether the generation
 * context has to travel with the entry.
 */
export const TripHistoryKindSchema = z.enum([
  "structural-edit",
  "routing",
  "pool-refresh",
  "refinement",
  "import-replacement",
  "generation-context-change",
]);
export type TripHistoryKind = z.infer<typeof TripHistoryKindSchema>;

/** The kinds that may alter the pool, and so must carry a context to be reversible. */
const CONTEXT_CHANGING: ReadonlySet<TripHistoryKind> = new Set([
  "pool-refresh",
  "import-replacement",
  "generation-context-change",
]);

export function kindChangesContext(kind: TripHistoryKind): boolean {
  return CONTEXT_CHANGING.has(kind);
}

export const TripHistoryEntrySchema = z.object({
  id: z.string().min(1),
  /** The action's own label, from `REFINEMENT_ACTION_LABELS`. Reads back as "Undo change time". */
  label: z.string().min(1),
  createdAt: z.string().min(1),
  /** The revision this entry restores to. */
  beforeRevision: z.number().int().positive(),
  /** The revision the action produced. Kept for diagnosis, never for guarding. */
  afterRevision: z.number().int().positive(),
  kind: TripHistoryKindSchema,
  /** The state to restore. An entry *is* the previous plan, not a description of one. */
  plan: TripPlanSchema,
  /**
   * Present only when this action changed the pool.
   *
   * `null` is meaningful and distinct from absent: it restores a record to having no generation
   * context at all, which is what undoing an import over a sample trip has to do.
   */
  generationContext: TripGenerationContextSchema.nullable().optional(),
});
export type TripHistoryEntry = z.infer<typeof TripHistoryEntrySchema>;

/**
 * The two stacks.
 *
 * `past` runs oldest to newest, so the next undo is its last element. `future` runs nearest to
 * furthest, so the next redo is its first. Each ordering is the one that makes its common operation
 * happen at the end a reader expects.
 */
export const TripHistorySchema = z
  .object({
    past: z.array(TripHistoryEntrySchema).default([]),
    future: z.array(TripHistoryEntrySchema).default([]),
  })
  .default({ past: [], future: [] });
export type TripHistory = z.infer<typeof TripHistorySchema>;

export const EMPTY_HISTORY: TripHistory = { past: [], future: [] };

/** What the interface reports. Actual depth, never the maximum. */
export type HistoryDepth = {
  undoDepth: number;
  redoDepth: number;
  /** The next undo's label, or null when there is nothing to undo. */
  nextUndo: string | null;
  nextRedo: string | null;
  bytes: number;
};

/**
 * Serialized size, measured rather than estimated.
 *
 * UTF-8, because that is what storage is charged in. `String.length` counts UTF-16 code units and
 * would undercount every accented place name in the pool — on a Lisbon trip, most of them.
 */
export function historyBytes(history: TripHistory): number {
  return new TextEncoder().encode(JSON.stringify(history)).length;
}

export function describeHistory(history: TripHistory): HistoryDepth {
  return {
    undoDepth: history.past.length,
    redoDepth: history.future.length,
    nextUndo: history.past.at(-1)?.label ?? null,
    nextRedo: history.future[0]?.label ?? null,
    bytes: historyBytes(history),
  };
}

/**
 * Both bounds applied: count first, bytes second.
 *
 * Count first because it is cheap and usually sufficient, which leaves the byte pass running over
 * at most forty entries. Deterministic throughout — no clock, no randomness, same history in and
 * same history out — which is what makes the trimming testable at all.
 *
 * ## Which end gives way
 *
 * The oldest **past** entry goes first: it is the one furthest from anything about to happen. Only
 * once the past is empty and the budget is still exceeded does the furthest **redo** go. The last
 * thing sacrificed is the step immediately in front of the traveller.
 *
 * A single entry larger than the whole budget survives. Trimming to nothing would leave a trip that
 * silently cannot be undone at all, which is worse than briefly exceeding a self-imposed ceiling —
 * and it is the capacity probe, not this budget, that decides whether a write fits.
 */
export function trimHistory(history: TripHistory): TripHistory {
  let past = history.past.slice(-MAX_HISTORY_ENTRIES);
  let future = history.future.slice(0, MAX_HISTORY_ENTRIES);

  while (
    past.length + future.length > 1 &&
    historyBytes({ past, future }) > MAX_HISTORY_BYTES_PER_TRIP
  ) {
    if (past.length > 0) past = past.slice(1);
    else future = future.slice(0, -1);
  }

  return { past, future };
}

/**
 * Records an action, and discards the redo stack.
 *
 * Discarding is not a simplification — it is what redo means. Once somebody has gone back and then
 * done something *different*, the steps they went back past describe a trip that no longer exists,
 * and offering to redo one would apply a plan built on an abandoned branch.
 */
export function pushHistory(
  history: TripHistory,
  entry: TripHistoryEntry,
): TripHistory {
  return trimHistory({ past: [...history.past, entry], future: [] });
}

/** The entry a step restores, and the history left behind after taking it. */
export type HistoryStep = {
  entry: TripHistoryEntry;
  history: TripHistory;
};

/**
 * Steps back one action.
 *
 * `current` is the state being left, and it becomes the redo entry — so the pair is symmetric and a
 * redo needs no separate bookkeeping. The label travels unchanged, which is what lets the interface
 * say "Undo change time" and then "Redo change time" about one action.
 *
 * The redo entry carries a context only when the entry being undone did. An action that did not
 * change the pool is not reversed by changing it, and storing the current context anyway would
 * reintroduce exactly the duplication the entry shape exists to avoid.
 */
export function stepBack(
  history: TripHistory,
  current: {
    plan: TripPlan;
    generation: TripGenerationContext | null;
    revision: number;
  },
): HistoryStep | null {
  const entry = history.past.at(-1);
  if (!entry) return null;

  return {
    entry,
    history: trimHistory({
      past: history.past.slice(0, -1),
      future: [mirror(entry, current), ...history.future],
    }),
  };
}

/** Steps forward one action. The mirror of `stepBack`, with the stacks swapped. */
export function stepForward(
  history: TripHistory,
  current: {
    plan: TripPlan;
    generation: TripGenerationContext | null;
    revision: number;
  },
): HistoryStep | null {
  const entry = history.future[0];
  if (!entry) return null;

  return {
    entry,
    history: trimHistory({
      past: [...history.past, mirror(entry, current)],
      future: history.future.slice(1),
    }),
  };
}

/**
 * The entry that would take you back to where you are now.
 *
 * Shared by both directions because undo and redo differ only in which stack they read — the entry
 * they leave behind is built the same way from the same two facts.
 */
function mirror(
  entry: TripHistoryEntry,
  current: {
    plan: TripPlan;
    generation: TripGenerationContext | null;
    revision: number;
  },
): TripHistoryEntry {
  return {
    id: `${entry.id}:r`,
    label: entry.label,
    createdAt: entry.createdAt,
    beforeRevision: current.revision,
    afterRevision: entry.afterRevision,
    kind: entry.kind,
    plan: current.plan,
    ...(kindChangesContext(entry.kind)
      ? { generationContext: current.generation }
      : {}),
  };
}

/**
 * The context a restored entry should leave the record with.
 *
 * Absent means the action did not change it, so the record keeps what it has. Present — including
 * explicitly `null` — means the action did, and the stored value is the one to restore.
 */
export function contextAfterRestore(
  entry: TripHistoryEntry,
  currentGeneration: TripGenerationContext | null,
): TripGenerationContext | null {
  return entry.generationContext === undefined
    ? currentGeneration
    : entry.generationContext;
}
