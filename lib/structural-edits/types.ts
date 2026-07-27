import type { PlaceCategory, TripGenerationContext, TripPlan } from "@/lib/schemas";

/**
 * The structural-edit boundary's vocabulary.
 *
 * Kept separate from `lib/refinement/types.ts` because the two answer different questions.
 * A refinement summary is about *stops and money*; a structural summary is about **shape** —
 * which day something is on, which backups exist, which legs came into being. Folding them
 * together would give the UI one type with half its fields always empty.
 */

export type StructuralEditAction =
  | "promote-backup"
  | "move-item"
  | "refresh-place-pool"
  /* -- Phase 8: the editable workspace ---------------------------------- */
  | "set-item-time"
  | "set-item-duration"
  | "insert-free-time"
  | "remove-item"
  | "lock-item"
  | "unlock-item"
  | "select-alternative";

export type StructuralEditErrorCode =
  /* -- locating things -------------------------------------------------- */
  | "day_not_found"
  | "item_not_found"
  | "backup_not_found"
  | "target_item_not_found"
  /** A place-less stop — downtime, or an unfilled slot — has no place to swap. */
  | "item_has_no_place"
  /* -- what may not be done --------------------------------------------- */
  /** The traveller's own pin. Clearable by `unlock-item`. */
  | "item_locked"
  /**
   * Fixed by the trip's dates — an arrival transfer, a departure, a hotel check-in.
   *
   * Distinct from `item_locked` because the advice differs: one says "unlock it first", the
   * other has to say "this cannot be changed at all". See `./locks.ts`.
   */
  | "item_structurally_locked"
  | "already_locked"
  | "not_locked"
  | "day_would_be_empty"
  | "same_position"
  /** The edit would leave the itinerary exactly as it is, so there is nothing to save. */
  | "no_change"
  | "duplicate_item_id"
  | "place_already_used"
  | "place_outside_pool"
  | "place_is_retained"
  /* -- scheduling ------------------------------------------------------- */
  | "invalid_times"
  | "no_slot_available"
  | "schedule_invalid"
  /* -- the result did not hold up --------------------------------------- */
  | "plan_invalid"
  | "pool_violation"
  | "generation_context_missing"
  /* -- pool refresh ----------------------------------------------------- */
  | "destination_unavailable"
  | "pool_invalid"
  | "retained_not_referenced"
  | "unsupported_command";

export type StructuralEditError = {
  code: StructuralEditErrorCode;
  message: string;
  dayNumber?: number;
  itemId?: string;
  placeId?: string;
};

export type StructuralEditWarning = {
  code:
    | "hours_conflict_after_edit"
    | "hours_unknown_after_edit"
    | "routes_invalidated"
    | "day_total_changed"
    | "place_missing_after_refresh"
    | "accommodation_missing_after_refresh"
    | "backup_missing_after_refresh"
    | "category_now_empty"
    | "partial_discovery"
    | "pool_sparse";
  message: string;
  dayNumber?: number;
  itemId?: string;
  placeId?: string;
};

/** What a refreshed search changed, deterministically. */
export type PlacePoolChangeSummary = {
  previousCount: number;
  newCount: number;
  addedPlaceIds: string[];
  removedPlaceIds: string[];
  retainedPlaceIds: string[];
  changedCanonicalRecords: {
    placeId: string;
    changedFields: (
      | "name"
      | "coordinates"
      | "category"
      | "address"
      | "website"
      | "phone"
      | "openingHours"
    )[];
  }[];
  /** Places the itinerary uses that the refreshed search no longer contains. */
  missingUsedPlaceIds: string[];
  categoryChanges: {
    category: PlaceCategory;
    previousCount: number;
    newCount: number;
  }[];
};

export type StructuralEditSummary = {
  action: StructuralEditAction;
  affectedDays: number[];
  changedItemIds: string[];
  addedItemIds: string[];
  removedItemIds: string[];
  /** Legs whose stored measurement no longer describes a real adjacency. */
  invalidatedLegIds: string[];
  /** Adjacencies that now exist and have never been routed. */
  addedLegIds: string[];
  removedBackupIds: string[];
  poolChanges?: PlacePoolChangeSummary;
  revisionBefore: number;
  /** Filled in by the client after a successful guarded save. */
  revisionAfter?: number;
};

export type StructuralEditResult =
  | {
      status: "success";
      plan: TripPlan;
      generationContext: TripGenerationContext;
      summary: StructuralEditSummary;
    }
  | {
      status: "partial";
      plan: TripPlan;
      generationContext: TripGenerationContext;
      summary: StructuralEditSummary;
      warnings: StructuralEditWarning[];
    }
  /** No plan. There is nothing to roll back, because nothing was built. */
  | { status: "failed"; errors: StructuralEditError[] };

export type StructuralEditInput = {
  plan: TripPlan;
  generation: TripGenerationContext;
  revisionBefore: number;
  /** From the generation context. Absent is a real state, not a bug. */
  timezone?: string | null;
};
