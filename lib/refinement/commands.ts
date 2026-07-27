import { z } from "zod";

import { PlaceCategorySchema } from "@/lib/schemas";

// The file rather than a barrel: the duration bounds below are the same floor the schedule
// validator enforces, and two copies of `minItemMinutes` is how a command would eventually
// accept a stop the validator then rejects.
import { SCHEDULE_LIMITS } from "./schedule";

/**
 * What a traveller may ask for, as a closed vocabulary.
 *
 * ## Why constrained actions rather than free text
 *
 * "Make day 3 cheaper but keep the museum" is a lovely thing to be able to type
 * and a terrible thing to accept. Free text is an instruction channel: it can ask
 * for a place that was never discovered, a different destination, a currency
 * conversion, or a route duration — and every one of those is something the
 * architecture exists to make impossible. A prompt-shaped field would move the
 * enforcement boundary from the schema into the prompt, which is precisely the
 * wrong direction.
 *
 * So the commands are a union of eight typed shapes. Each one is small enough
 * that its effect on the plan is fully knowable before the model is asked
 * anything, which is what lets the *result* be validated against the action's own
 * promise: a "cheaper" day whose total went up is rejected, mechanically, rather
 * than trusted.
 *
 * ## What is deliberately absent
 *
 * No prompt text. No coordinates. No place names as identity — a place is a
 * `placeId` and nothing else. No durations, distances or geometry: those are
 * provider facts and a refinement cannot express one. No mutation instructions
 * ("set item 3 startTime to 10:00") — the model proposes a shape and the server
 * builds it.
 */

/** Bounded, so a `preserve` list cannot become an unbounded prompt payload. */
const MAX_PRESERVED = 24;

const DayNumberSchema = z
  .number()
  .int()
  .min(1)
  .max(7, "A trip spans at most seven days");

/**
 * Ids are matched against the plan, so their format only has to be plausible —
 * but a length cap stops a caller sending a megabyte of ids and a charset check
 * keeps them printable in an error message.
 */
const IdSchema = z.string().min(1).max(120).regex(/^[\w:@.-]+$/);

export const RegenerateTripCommandSchema = z.object({
  type: z.literal("regenerate-trip"),
  /**
   * Things the traveller liked and wants kept.
   *
   * Passed to the model *and* checked afterwards: a preserve constraint that is
   * merely requested is a preference, and one that is verified is a guarantee.
   */
  preserve: z
    .object({
      placeIds: z.array(IdSchema).max(MAX_PRESERVED).optional(),
      itemIds: z.array(IdSchema).max(MAX_PRESERVED).optional(),
    })
    .optional(),
});

export const ReplaceItemCommandSchema = z.object({
  type: z.literal("replace-item"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
  /**
   * Preferences, not instructions.
   *
   * Each one narrows the *candidate subset* the server derives — they are filter
   * inputs applied before the model sees anything, so an unsatisfiable preference
   * produces "nothing eligible" rather than a model straining to comply.
   *
   * `category` is the only one that changes what kind of place may fill the slot,
   * and it is validated against the allowlist like every other category in the
   * codebase.
   */
  preferences: z
    .object({
      cheaper: z.boolean().optional(),
      quieter: z.boolean().optional(),
      indoor: z.boolean().optional(),
      outdoor: z.boolean().optional(),
      category: PlaceCategorySchema.optional(),
    })
    .optional(),
});

export const ReplaceBackupCommandSchema = z.object({
  type: z.literal("replace-backup"),
  dayNumber: DayNumberSchema,
  backupId: IdSchema,
});

export const AdjustDayCommandSchema = z.object({
  type: z.literal("adjust-day"),
  dayNumber: DayNumberSchema,
  adjustment: z.enum(["cheaper", "more-relaxed", "more-packed"]),
});

export const RetryRoutesCommandSchema = z.object({
  type: z.literal("retry-routes"),
  /**
   * `unavailable-only` retries legs that failed or were never attempted;
   * `all` re-requests every eligible leg, including ones that already succeeded.
   * The distinction matters because a cached success costs nothing while a forced
   * refresh does.
   */
  scope: z.enum(["unavailable-only", "all"]),
  /** Absent means the whole trip. */
  dayNumber: DayNumberSchema.optional(),
  /**
   * Exactly these legs, by stable leg id — the "retry this one route" action.
   *
   * Validated against the plan's *currently expected* leg set, so an id that no
   * longer describes an adjacency is rejected rather than routed.
   */
  legIds: z.array(IdSchema).max(24).optional(),
});

/** `HH:MM`, 24-hour, two digits each. The same shape the plan schema stores. */
const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * Moving one stop's clock, and nothing else (Phase 6B, resemantified in Phase 8).
 *
 * The times are the traveller's, so this command *does* carry values rather than
 * preferences — which is exactly why it is separate from the eight that came before.
 * It is safe to accept them because they are arithmetic on the plan's own schedule: no
 * place changes, no day changes, no provider is asked anything, and the result goes
 * through the same schedule validator as everything else. There is nothing here a model
 * could be persuaded to assert.
 *
 * ## Why this replaced `move-item-time`
 *
 * The Phase 6B applier honoured any times that produced a structurally valid day and then
 * **re-sorted the day by start time**. That is defensible for an automatic repair and wrong for
 * a typed time: a traveller who moves their 11:00 museum to 15:00 gets the whole afternoon
 * silently resequenced around it, having asked for one stop to move.
 *
 * So the Phase 8 applier validates against the *free window at the stop's current position* and
 * **refuses** when the times do not fit there, naming the window. Sequence and clock therefore
 * stay in agreement without anything being reordered on the traveller's behalf.
 * `applyHoursAdjustTime` keeps the resequencing behaviour, correctly — it is searching for an
 * open slot rather than honouring a choice.
 */
export const SetItemTimeCommandSchema = z.object({
  type: z.literal("set-item-time"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
  startTime: TimeOfDaySchema,
  endTime: TimeOfDaySchema,
});

/* -------------------------------------------------------------------------- */
/* Phase 8 — the editable workspace                                            */
/* -------------------------------------------------------------------------- */

/**
 * The ceiling on a single stop's length.
 *
 * Twelve hours: longer than any real visit, generous enough for a full-day excursion, and low
 * enough that a mistyped `9999` is refused by the schema rather than reaching arithmetic. The
 * floor is `SCHEDULE_LIMITS.minItemMinutes`, below which a stop is not a visit.
 */
export const MAX_ITEM_DURATION_MINUTES = 12 * 60;

/**
 * Resizing a stop, holding one end still (Phase 8).
 *
 * `anchor` is what makes this a different command rather than sugar over `set-item-time`. "Give
 * me another half hour at the castle" and "I need to get there half an hour earlier" are both
 * duration changes and they move opposite ends; a traveller dragging a card's bottom edge has
 * already expressed which. Inferring the anchor from which number changed would be guessing at
 * intent the interface knows for certain.
 */
export const SetItemDurationCommandSchema = z.object({
  type: z.literal("set-item-duration"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
  durationMinutes: z
    .number()
    .int()
    .min(SCHEDULE_LIMITS.minItemMinutes)
    .max(MAX_ITEM_DURATION_MINUTES),
  /** Which end stays put. `start` extends forwards; `end` extends backwards. */
  anchor: z.enum(["start", "end"]),
});

/** How long a traveller's own label for downtime may be. */
export const MAX_FREE_TIME_TITLE = 80;

/**
 * Deliberate downtime, added by the traveller (Phase 8).
 *
 * ## Why this needs no new item kind
 *
 * It produces an ordinary `ItineraryItem` with `kind: "rest"`, `place: null` and a zero cost — a
 * shape the plan already has, that `isMappableItem` already excludes from the map, that
 * `validateSchedule` already exempts from the transition floor, and that the pace caps already
 * ignore because it is not a stop. Inventing a `free-time` kind would mean teaching six modules
 * about a case that behaves identically to one they already handle.
 *
 * ## The one free-text field in the vocabulary, and why it is safe
 *
 * `title` is the traveller's own label — "nap", "swim", "call home" — and there is no closed list
 * that could offer it. It is accepted because it is *data about their trip*, never an
 * instruction: it is rendered as text, it is never interpolated into a prompt as an instruction,
 * and it is length-capped so it cannot become a payload. Item titles and rationales in this
 * schema are already free text authored by a model, so this adds a new author rather than a new
 * class of content.
 *
 * Control characters are rejected rather than stripped: silently rewriting what somebody typed
 * is worse than telling them it will not do.
 */
export const InsertFreeTimeCommandSchema = z.object({
  type: z.literal("insert-free-time"),
  dayNumber: DayNumberSchema,
  startTime: TimeOfDaySchema,
  endTime: TimeOfDaySchema,
  title: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FREE_TIME_TITLE)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
      message: "A label cannot contain control characters",
    })
    .optional(),
});

/**
 * Dropping an optional stop (Phase 8).
 *
 * Refused when it would empty the day, because `ItineraryDaySchema` requires at least one item
 * and the alternative is a plan that fails its own schema. Refused on a locked stop, and on a
 * structurally locked one — removing the airport transfer would leave a trip claiming not to
 * involve arriving.
 *
 * The stop's place rejoins the pool's *unused* set by simply no longer being referenced, and
 * nothing is added anywhere, which is why a removal cannot violate the pool invariant.
 */
export const RemoveItemCommandSchema = z.object({
  type: z.literal("remove-item"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
});

/**
 * The traveller's pin, set and cleared (Phase 8).
 *
 * Two commands rather than one toggle carrying a boolean, so a stale interface cannot flip a
 * lock it believed was off: the request states the intended outcome, and locking something
 * already locked is a refusal rather than a silent no-op that reads as success.
 *
 * `unlock-item` refuses on a structurally locked stop. See `lib/structural-edits/locks.ts` —
 * these are two different locks, and the trip's dates are not the traveller's to release.
 */
export const LockItemCommandSchema = z.object({
  type: z.literal("lock-item"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
});

export const UnlockItemCommandSchema = z.object({
  type: z.literal("unlock-item"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
});

/**
 * Swapping a stop's place for one of its alternatives (Phase 8).
 *
 * A `placeId` and nothing else — no name, no coordinates, no rating, no reason. The alternative
 * must belong to the trip's **active pool**; a retained place is never selectable, which is the
 * narrow half of the widened invariant and the reason this cannot resurrect a place the latest
 * search stopped returning.
 *
 * Deliberately no model. The alternatives a traveller chooses from are derived from the pool
 * they already have, so there is nothing for a planner to decide — and routing it through one
 * would make a swap fail on a trip with no model configured.
 */
export const SelectAlternativeCommandSchema = z.object({
  type: z.literal("select-alternative"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
  alternativePlaceId: IdSchema,
});

/**
 * Repairing a stop the published hours say is shut (Phase 6B).
 *
 * Three resolutions, and the traveller picks. None of them needs a model:
 *
 *  - `adjust-time` — move the stop into an interval the hours say is open, using the
 *    same slot-finder the automatic generation pass uses
 *  - `replace-place` — put a different place from the trip's *own saved pool* in the
 *    slot. The `placeId` comes from the traveller's choice among candidates the server
 *    already vouched for; nothing new is searched
 *  - `mark-unavailable` — keep the slot, drop the place, say why. The honest option when
 *    neither of the others is right
 *
 * Deliberately not offered: promoting a backup (that is `replace-backup`, and it means
 * something different), moving the stop to another day, and asking a model to decide.
 */
export const ResolveHoursConflictCommandSchema = z.object({
  type: z.literal("resolve-hours-conflict"),
  dayNumber: DayNumberSchema,
  itemId: IdSchema,
  resolution: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("adjust-time") }),
    z.object({ kind: z.literal("replace-place"), placeId: IdSchema }),
    z.object({ kind: z.literal("mark-unavailable") }),
  ]),
});

/**
 * Recomputing every cost estimate against the current profile (Phase 6B).
 *
 * No arguments, because there is nothing to choose. It reads the request's budget, the
 * destination's profile and the plan's own places, and rewrites only the money — never a
 * place, a time, a date or an order. No AI, no OpenStreetMap, no routing.
 */
export const RecalculateEstimatesCommandSchema = z.object({
  type: z.literal("recalculate-estimates"),
});

/**
 * Where a structural edit puts an item (Phase 6C).
 *
 * A *position*, not an index. An index is a number about an array, and an array that
 * changed between the render and the click makes the number mean something else — which
 * is the classic way a "move to third" lands somewhere nobody asked for. Naming the
 * neighbouring item makes the request describe the itinerary rather than its storage, and
 * an id that no longer exists is a clean refusal instead of a silent misplacement.
 */
export const TargetPositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("before"), itemId: IdSchema }),
  z.object({ kind: z.literal("after"), itemId: IdSchema }),
  z.object({ kind: z.literal("end") }),
]);
export type TargetPosition = z.infer<typeof TargetPositionSchema>;

/**
 * Promoting a backup into the itinerary (Phase 6C).
 *
 * The traveller supplies the day and the position, so nothing needs to decide where it
 * goes. Times are optional: given, they are validated; absent, a slot is derived
 * deterministically from the neighbours at that position, and the edit fails rather than
 * inventing an impossible one.
 */
export const PromoteBackupCommandSchema = z.object({
  type: z.literal("promote-backup"),
  sourceDayNumber: DayNumberSchema,
  backupId: IdSchema,
  targetDayNumber: DayNumberSchema,
  targetPosition: TargetPositionSchema,
  startTime: TimeOfDaySchema.optional(),
  endTime: TimeOfDaySchema.optional(),
});

/**
 * Moving one stop to another day (Phase 6C).
 *
 * The item id is stable across the move — it is the same stop, and a new id would
 * needlessly invalidate the routes either side of where it lands.
 */
export const MoveItemCommandSchema = z.object({
  type: z.literal("move-item"),
  sourceDayNumber: DayNumberSchema,
  targetDayNumber: DayNumberSchema,
  itemId: IdSchema,
  targetPosition: TargetPositionSchema,
  startTime: TimeOfDaySchema.optional(),
  endTime: TimeOfDaySchema.optional(),
});

/**
 * Re-running the place search for a saved trip (Phase 6C).
 *
 * Structurally different from every other command here, and treated as such: it changes
 * the *universe of places the trip may draw on*, not the itinerary. It needs a provider
 * (never a model), it needs the traveller's explicit confirmation, and it goes to its own
 * endpoint — `POST /api/trips/refresh-pool` — because bundling it into the refinement
 * route would make that route issue Overpass requests.
 *
 * `reconciliation` says what to do about places the new search no longer contains. The
 * vocabulary is closed and neither option ever picks a replacement.
 */
export const RefreshPlacePoolCommandSchema = z.object({
  type: z.literal("refresh-place-pool"),
  /** Absent means "the categories the original search covered". */
  categories: z.array(PlaceCategorySchema).min(1).max(8).optional(),
  /** Absent means "the radius the original search used". Clamped server-side. */
  radiusMeters: z.number().int().min(1_000).max(12_000).optional(),
  reconciliation: z.enum([
    "keep-valid-and-flag-missing",
    "replace-missing-with-unavailable",
  ]),
});

/**
 * The structural edits that are pure arithmetic over the plan and its pool.
 *
 * Two in Phase 6C, nine in Phase 8. Every one of them is computed in the browser and saved under
 * the revision guard — no endpoint, no model, no network — which is what makes the workspace feel
 * immediate and what keeps it working offline.
 */
export const StructuralEditCommandSchema = z.discriminatedUnion("type", [
  PromoteBackupCommandSchema,
  MoveItemCommandSchema,
  SetItemTimeCommandSchema,
  SetItemDurationCommandSchema,
  InsertFreeTimeCommandSchema,
  RemoveItemCommandSchema,
  LockItemCommandSchema,
  UnlockItemCommandSchema,
  SelectAlternativeCommandSchema,
]);
export type StructuralEditCommand = z.infer<typeof StructuralEditCommandSchema>;

export const TripRefinementCommandSchema = z.discriminatedUnion("type", [
  RegenerateTripCommandSchema,
  ReplaceItemCommandSchema,
  ReplaceBackupCommandSchema,
  AdjustDayCommandSchema,
  RetryRoutesCommandSchema,
  ResolveHoursConflictCommandSchema,
  RecalculateEstimatesCommandSchema,
  PromoteBackupCommandSchema,
  MoveItemCommandSchema,
  RefreshPlacePoolCommandSchema,
  // Phase 8.
  SetItemTimeCommandSchema,
  SetItemDurationCommandSchema,
  InsertFreeTimeCommandSchema,
  RemoveItemCommandSchema,
  LockItemCommandSchema,
  UnlockItemCommandSchema,
  SelectAlternativeCommandSchema,
]);
export type TripRefinementCommand = z.infer<typeof TripRefinementCommandSchema>;

/**
 * The four commands that need a planner, and the only ones `POST /api/trips/refine`
 * accepts.
 *
 * `retry-routes` is deliberately not here. It needs the routing provider, the
 * routing route's duration budget and the routing cache, all of which already
 * exist in `POST /api/trips/route` — and sending it to the refinement endpoint
 * would mean that endpoint makes routing calls, which §16 of the brief forbids and
 * which would blur a boundary worth keeping sharp. The client dispatches it to the
 * routing route instead.
 */
export const AiRefinementCommandSchema = z.discriminatedUnion("type", [
  RegenerateTripCommandSchema,
  ReplaceItemCommandSchema,
  ReplaceBackupCommandSchema,
  AdjustDayCommandSchema,
]);
export type AiRefinementCommand = z.infer<typeof AiRefinementCommandSchema>;

export type RefinementActionType = TripRefinementCommand["type"];

/**
 * The commands that need no provider of any kind.
 *
 * Each is pure arithmetic over the plan the browser already holds, so the client applies
 * it directly and saves it under the revision guard — no API route, no model, no network.
 * Creating an endpoint for them would be architectural symmetry with nothing behind it,
 * and it would put a plan through a serialisation round trip for no reason.
 */
const DETERMINISTIC_ACTIONS = new Set<RefinementActionType>([
  "resolve-hours-conflict",
  "recalculate-estimates",
  // Phase 6C. `refresh-place-pool` is deliberately absent: it needs a provider.
  "promote-backup",
  "move-item",
  /**
   * Phase 8. All seven, which is the point of the editable workspace: every direct edit a
   * traveller makes to their own itinerary is arithmetic over data the browser already holds, so
   * none of it waits on a network and none of it stops working offline.
   */
  "set-item-time",
  "set-item-duration",
  "insert-free-time",
  "remove-item",
  "lock-item",
  "unlock-item",
  "select-alternative",
]);

export function isDeterministic(command: TripRefinementCommand): boolean {
  return DETERMINISTIC_ACTIONS.has(command.type);
}

/**
 * The commands that require a language model.
 *
 * A positive list rather than "everything except the ones I can think of". The exclusions grew
 * from one (`retry-routes`) to six across two phases, and an exclusion list gets a new command
 * wrong by *default* — silently routing it to the planner endpoint.
 */
const AI_ACTIONS = new Set<RefinementActionType>([
  "regenerate-trip",
  "replace-item",
  "replace-backup",
  "adjust-day",
]);

export function requiresPlanner(
  command: TripRefinementCommand,
): command is AiRefinementCommand {
  return AI_ACTIONS.has(command.type);
}

/**
 * Actions worth a confirmation step.
 *
 * Regeneration replaces the whole itinerary, so a misclick costs the traveller
 * every choice they had made. A single replacement is cheap to undo and asking
 * about it would be nagging.
 */
export function needsConfirmation(command: TripRefinementCommand): boolean {
  /**
   * `refresh-place-pool` joins regeneration for a different reason.
   *
   * Regeneration is expensive to misclick because it discards every choice the traveller
   * made. A pool refresh is expensive to misclick because it changes what places the trip
   * may draw on at all, and can leave stops pointing at records the latest search no
   * longer contains. Both are consequences worth naming before they happen.
   */
  return command.type === "regenerate-trip" || command.type === "refresh-place-pool";
}

/** Human-readable labels, so the UI and the summary cannot disagree. */
export const REFINEMENT_ACTION_LABELS: Record<RefinementActionType, string> = {
  "regenerate-trip": "Regenerate trip",
  "replace-item": "Replace stop",
  "replace-backup": "Replace backup",
  "adjust-day": "Adjust day",
  "retry-routes": "Retry routes",
  "resolve-hours-conflict": "Fix opening-hours clash",
  "recalculate-estimates": "Recalculate cost estimates",
  "promote-backup": "Add backup to itinerary",
  "move-item": "Move stop to another day",
  "refresh-place-pool": "Refresh available places",
  /**
   * Phase 8. These double as undo labels, so they are phrased as things that happened —
   * "Change time", not "Changing the time" — and read correctly after "Undo".
   */
  "set-item-time": "Change time",
  "set-item-duration": "Change duration",
  "insert-free-time": "Add free time",
  "remove-item": "Remove stop",
  "lock-item": "Lock stop",
  "unlock-item": "Unlock stop",
  "select-alternative": "Swap in an alternative",
};
