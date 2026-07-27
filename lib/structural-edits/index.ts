/**
 * Structural itinerary editing (Phase 6C).
 *
 * Pure and client-safe: no `server-only`, no network, no model, no clock read. Every entry
 * point takes a plan and its generation context and returns a new pair, so the browser applies
 * these edits itself under the same revision guard a networked refinement uses.
 *
 * The one thing here that *does* need a provider is refreshing the place pool, and that is
 * split deliberately: `lib/generate/refresh-pool.ts` (server-only) obtains the new search,
 * `reconcile-pool.ts` (pure) decides what it means for the trip, and the traveller confirms in
 * between.
 */

export {
  applyMoveItem,
  itemIsMovable,
} from "./move-item";

export { applyPromoteBackup } from "./promote-backup";

/* -- Phase 8: the editable workspace ------------------------------------- */

export {
  STRUCTURALLY_LOCKED_KINDS,
  isEditLocked,
  isStructurallyLocked,
  isTravellerLocked,
  lockRefusalFor,
  supportsTravellerLock,
} from "./locks";

export {
  indexForStartTime,
  locateDay,
  locateItem,
  mintItemId,
  positionOfExistingItem,
  type Located,
  type LocatedDay,
  type LocatedItem,
} from "./locate";

export {
  applySetItemSchedule,
  freeWindowForItem,
  itemIsRetimable,
} from "./set-schedule";

export { applyInsertFreeTime } from "./insert-free-time";

export { applyRemoveItem, itemIsRemovable } from "./remove-item";

export { applySetItemLock } from "./set-lock";

export {
  alternativeIsSelectable,
  applySelectAlternative,
} from "./select-alternative";

/** The pool-wide derivation `alternativeIsSelectable` was written to be filtered by. */
export { alternativesForItem } from "./alternatives";

export {
  insertAt,
  removeById,
  renumber,
  resolvePosition,
  type ResolvedPosition,
} from "./position";

export {
  SCHEDULE_LIMITS,
  defaultDurationMinutes,
  durationOf,
  resolveInsertionTimes,
  windowFor,
  type TimeWindow,
} from "./schedule";

export {
  buildSummary,
  collectAttachedPlaces,
  commitStructuralEdit,
  type CommitInput,
} from "./commit";

/**
 * The single mutation path. Every entry point — card menu, drag, confirmed assistant proposal —
 * builds a command and calls one of these two, so none of them can acquire its own semantics.
 */
export {
  applyStructuralCommand,
  applyUnvalidatedStructuralCommand,
} from "./dispatch";

/**
 * Applied, verified, and not yet stored — the whole of what an edit *decides*.
 *
 * The client's entry point rather than the dispatcher itself: it adds the pair-level membership
 * check and the stored label, so the hook is left holding only React state and the store write.
 */
export {
  prepareStructuralCommand,
  verifyStructuralResult,
  type PreparedStructuralEdit,
} from "./prepare";

/**
 * A prepared edit, read for where it would put a stop.
 *
 * The honest way to preview a drag or a resize: run the real applier, stop short of writing, and
 * look at the plan it built — rather than re-deriving the slot in a component and hoping the two
 * agree about the grid, the transition floor and the day's bounds.
 */
export {
  announceEditedItem,
  describeEditedItem,
  type EditedItemPreview,
} from "./preview-item";

export {
  POOL_AGE_THRESHOLDS,
  canRefreshPool,
  describePoolAge,
  refreshUnavailableReason,
  type PoolAge,
  type PoolAgeState,
} from "./pool-age";

export {
  POOL_COORDINATE_TOLERANCE_METERS,
  categoriesNowEmpty,
  diffPlacePools,
} from "./pool-diff";

export {
  applyPoolRefresh,
  previewReconciliation,
  type ReconcileInput,
  type ReconciliationPolicy,
  type ReconciliationPreview,
} from "./reconcile-pool";

export {
  placeIsSelectable,
  retainedPlaceIds,
  validatePlanMembership,
  validateRetainedPlaces,
} from "./validate";

export type {
  PlacePoolChangeSummary,
  StructuralEditAction,
  StructuralEditError,
  StructuralEditErrorCode,
  StructuralEditInput,
  StructuralEditResult,
  StructuralEditSummary,
  StructuralEditWarning,
} from "./types";
