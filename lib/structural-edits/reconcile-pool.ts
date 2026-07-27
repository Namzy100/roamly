import type {
  ItineraryDay,
  ItineraryItem,
  TripGenerationContext,
  TripPlace,
  TripPlan,
  VerifiedPlacePool,
} from "@/lib/schemas";
import { MAX_RETAINED_PLACES } from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { categoriesNowEmpty } from "./pool-diff";
import type {
  PlacePoolChangeSummary,
  StructuralEditInput,
  StructuralEditResult,
  StructuralEditWarning,
} from "./types";

/**
 * Fitting a refreshed place search to a trip that already exists.
 *
 * ## The problem, stated plainly
 *
 * A refreshed search can lose a place the itinerary is built on. That says almost nothing
 * about the place — a mapper retagged it, the radius moved, the category query changed, one
 * Overpass batch timed out. The museum is still there.
 *
 * So there is no honest way to *automatically* resolve it, and neither policy tries. What
 * they do is make the situation visible and keep the plan valid:
 *
 *  - **keep-valid-and-flag-missing** — the itinerary is untouched and the missing place moves
 *    into the retained collection: out of the pool, explicitly recorded, excluded from every
 *    future candidate list, and flagged in the interface
 *  - **replace-missing-with-unavailable** — the stop becomes an open slot with the reason
 *    attached, exactly as generation does for a slot it could not fill
 *
 * Neither picks a replacement place. That is a choice, and it is the traveller's.
 *
 * ## Canonical facts are refreshed for places that survived
 *
 * A place still in the pool has its attached record replaced with the new canonical one, so a
 * corrected name or a newly-tagged `opening_hours` reaches the itinerary. That is the *point*
 * of refreshing, and `assertItineraryUsesPool` would reject the plan otherwise — it requires
 * the attached copy to be faithful to the pool's.
 *
 * ## Pure
 *
 * No network, no clock read (timestamps are arguments), no model. The same pool and the same
 * plan always reconcile the same way, which is what makes the preview the interface shows
 * identical to what the commit does.
 */

export type ReconciliationPolicy =
  | "keep-valid-and-flag-missing"
  | "replace-missing-with-unavailable";

/**
 * What a policy would do, without doing it.
 *
 * Counts and ids only — no plan. A preview that carried a plan would invite a caller to save
 * it without the commit path's validation, which is the one thing the two-step flow exists to
 * prevent.
 */
export type ReconciliationPreview = {
  policy: ReconciliationPolicy;
  /** Stops whose place survived and whose attached record is refreshed. */
  refreshedItemIds: string[];
  /** Stops the plan keeps, whose place is no longer in the search. */
  retainedItemIds: string[];
  /** Stops that would become open slots. */
  unavailableItemIds: string[];
  /** Backups that would be dropped. */
  removedBackupIds: string[];
  accommodationMissing: boolean;
  retainedPlaceCount: number;
  /** Ids whose stored travel time would be cleared. */
  invalidatedLegIds: string[];
  warnings: StructuralEditWarning[];
};

export type ReconcileInput = StructuralEditInput & {
  nextPool: VerifiedPlacePool;
  changes: PlacePoolChangeSummary;
  policy: ReconciliationPolicy;
  /** ISO timestamp for `retainedAt`. Supplied, never read from the clock. */
  now: string;
  /** Carried from the refresh response so the context records what the search did. */
  discoverySummary?: TripGenerationContext["discoverySummary"];
};

export function applyPoolRefresh(input: ReconcileInput): StructuralEditResult {
  const { plan, nextPool, changes, policy } = input;

  const nextById = new Map(nextPool.places.map((place) => [place.placeId, place]));
  const missing = new Set(changes.missingUsedPlaceIds);

  const warnings: StructuralEditWarning[] = [];
  const retainedPlaces: NonNullable<TripGenerationContext["retainedPlaces"]> = [];
  const removedBackupIds: string[] = [];
  const affectedDays = new Set<number>();

  /* -- the itinerary ------------------------------------------------------- */

  const days: ItineraryDay[] = plan.days.map((day) => {
    let touched = false;

    const items = day.items.map((item) => {
      if (!item.place) return item;

      const canonical = nextById.get(item.place.placeId);

      if (canonical) {
        // Same place, possibly a better record. Replaced only when it differs, so an
        // unchanged stop comes back as the same object.
        if (recordsMatch(item.place, canonical)) return item;
        touched = true;
        affectedDays.add(day.dayNumber);
        return { ...item, place: canonical };
      }

      if (!missing.has(item.place.placeId)) return item;

      touched = true;
      affectedDays.add(day.dayNumber);

      if (policy === "keep-valid-and-flag-missing") {
        retain(retainedPlaces, item.place, input.now);
        warnings.push({
          code: "place_missing_after_refresh",
          message: `“${item.place.name}” was not found by the latest place search. Your stop is unchanged, but it can no longer be offered as an alternative anywhere else in the trip.`,
          dayNumber: day.dayNumber,
          itemId: item.id,
          placeId: item.place.placeId,
        });
        return item;
      }

      warnings.push({
        code: "place_missing_after_refresh",
        message: `“${item.place.name}” was not found by the latest place search, so this slot is now open.`,
        dayNumber: day.dayNumber,
        itemId: item.id,
        placeId: item.place.placeId,
      });
      return toUnavailable(item);
    });

    /**
     * A backup whose place has gone is **removed**, under either policy.
     *
     * Retaining it would be keeping a fallback that cannot be promoted — the promotion path
     * refuses a retained place, because promoting is a new selection. An unavailable backup
     * would be an offer to swap in nothing.
     */
    const backups = day.backups.filter((backup) => {
      const canonical = nextById.get(backup.place.placeId);
      if (canonical) return true;

      touched = true;
      affectedDays.add(day.dayNumber);
      removedBackupIds.push(backup.id);
      warnings.push({
        code: "backup_missing_after_refresh",
        message: `The backup “${backup.title}” was not found by the latest place search and has been removed.`,
        dayNumber: day.dayNumber,
      });
      return false;
    });

    const refreshedBackups = backups.map((backup) => {
      const canonical = nextById.get(backup.place.placeId);
      if (!canonical || recordsMatch(backup.place, canonical)) return backup;
      touched = true;
      return { ...backup, place: canonical };
    });

    if (!touched) return day;
    return { ...day, items, backups: refreshedBackups };
  });

  /* -- the accommodation ---------------------------------------------------- */

  let accommodation = plan.accommodation;

  if (accommodation) {
    const canonical = nextById.get(accommodation.place.placeId);

    if (canonical) {
      if (!recordsMatch(accommodation.place, canonical)) {
        accommodation = { ...accommodation, place: canonical };
      }
    } else if (policy === "keep-valid-and-flag-missing") {
      retain(retainedPlaces, accommodation.place, input.now);
      warnings.push({
        code: "accommodation_missing_after_refresh",
        message: `“${accommodation.place.name}” was not found by the latest place search. Your recommended stay is unchanged, but it can no longer be offered elsewhere.`,
        placeId: accommodation.place.placeId,
      });
    } else {
      warnings.push({
        code: "accommodation_missing_after_refresh",
        message: `“${accommodation.place.name}” was not found by the latest place search, so this trip no longer has a recommended place to stay.`,
        placeId: accommodation.place.placeId,
      });
      accommodation = null;
    }
  }

  /* -- what else is worth saying ------------------------------------------- */

  for (const category of categoriesNowEmpty(changes)) {
    warnings.push({
      code: "category_now_empty",
      message: `The latest search found no ${category.replace(/_/g, " ")} nearby, so there are no alternatives of that kind any more.`,
    });
  }

  if (nextPool.places.length < Math.floor(changes.previousCount / 2)) {
    warnings.push({
      code: "pool_sparse",
      message: `The latest search returned ${nextPool.places.length} places where the previous one found ${changes.previousCount}. That usually means a query did not complete rather than that places have gone.`,
    });
  }

  if (retainedPlaces.length > MAX_RETAINED_PLACES) {
    return {
      status: "failed",
      errors: [
        {
          code: "pool_invalid",
          message: `This refresh would retain ${retainedPlaces.length} places the search no longer finds, which is more than a trip can reference.`,
        },
      ],
    };
  }

  const generationContext: TripGenerationContext = {
    ...input.generation,
    placePool: nextPool,
    ...(input.discoverySummary
      ? { discoverySummary: input.discoverySummary }
      : {}),
    ...(retainedPlaces.length > 0 ? { retainedPlaces } : {}),
  };

  /**
   * The old retained collection is **not** carried forward.
   *
   * A place retained by a previous refresh either turned up again — in which case it is a
   * pool member and needs no special case — or it did not, in which case this pass has
   * already retained it from the plan. Merging the two lists would accumulate entries no
   * plan references, which is precisely the hard failure `validateRetainedPlaces` reports.
   */
  if (retainedPlaces.length === 0) {
    delete (generationContext as { retainedPlaces?: unknown }).retainedPlaces;
  }

  return commitStructuralEdit({
    action: "refresh-place-pool",
    before: plan,
    generation: input.generation,
    generationOverride: generationContext,
    days,
    ...(accommodation === plan.accommodation
      ? {}
      : { accommodationOverride: accommodation }),
    revisionBefore: input.revisionBefore,
    affectedDays: [...affectedDays].sort((a, b) => a - b),
    removedBackupIds,
    /**
     * No day-level schedule re-validation.
     *
     * A refresh does not move anything: times, order and days are untouched, and the only
     * itinerary change is a place record or a stop becoming an open slot. Re-running the
     * pace cap here could *fail* a reconciliation because the trip was already at its cap,
     * which would leave the traveller unable to accept a refresh for a reason that has
     * nothing to do with it.
     */
    validateDays: [],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    warnings,
    retainedPlaces,
  });
}

/**
 * What a policy would do, computed without building a plan.
 *
 * Both policies are previewed from one pass so the interface can show the choice without a
 * second Overpass request — there are only two, and the diff is already in hand.
 */
export function previewReconciliation(input: {
  plan: TripPlan;
  generation: TripGenerationContext;
  nextPool: VerifiedPlacePool;
  changes: PlacePoolChangeSummary;
  policy: ReconciliationPolicy;
}): ReconciliationPreview {
  const nextById = new Map(
    input.nextPool.places.map((place) => [place.placeId, place]),
  );
  const missing = new Set(input.changes.missingUsedPlaceIds);

  const refreshedItemIds: string[] = [];
  const retainedItemIds: string[] = [];
  const unavailableItemIds: string[] = [];
  const removedBackupIds: string[] = [];
  const invalidatedLegIds: string[] = [];
  const retainedPlaceIds = new Set<string>();
  const warnings: StructuralEditWarning[] = [];

  for (const day of input.plan.days) {
    for (const item of day.items) {
      if (!item.place) continue;
      const canonical = nextById.get(item.place.placeId);

      if (canonical) {
        if (!recordsMatch(item.place, canonical)) refreshedItemIds.push(item.id);
        continue;
      }
      if (!missing.has(item.place.placeId)) continue;

      if (input.policy === "keep-valid-and-flag-missing") {
        retainedItemIds.push(item.id);
        retainedPlaceIds.add(item.place.placeId);
      } else {
        unavailableItemIds.push(item.id);
        /**
         * A stop becoming an open slot loses its legs in both directions: the one it carries
         * and the one that arrives at it. The incoming one hangs off the previous item.
         */
        if (item.travelToNext) invalidatedLegIds.push(item.travelToNext.id);
        const previous = previousItemOf(day, item.id);
        if (previous?.travelToNext) invalidatedLegIds.push(previous.travelToNext.id);
      }
    }

    for (const backup of day.backups) {
      if (!nextById.has(backup.place.placeId)) removedBackupIds.push(backup.id);
    }
  }

  const accommodation = input.plan.accommodation;
  const accommodationMissing =
    accommodation !== null &&
    accommodation !== undefined &&
    !nextById.has(accommodation.place.placeId);

  if (accommodationMissing && accommodation) {
    if (input.policy === "keep-valid-and-flag-missing") {
      retainedPlaceIds.add(accommodation.place.placeId);
    }
    warnings.push({
      code: "accommodation_missing_after_refresh",
      message:
        input.policy === "keep-valid-and-flag-missing"
          ? `“${accommodation.place.name}” is kept, flagged as not found by the latest search.`
          : `“${accommodation.place.name}” would be removed as this trip's recommended stay.`,
      placeId: accommodation.place.placeId,
    });
  }

  for (const category of categoriesNowEmpty(input.changes)) {
    warnings.push({
      code: "category_now_empty",
      message: `No ${category.replace(/_/g, " ")} in the latest search.`,
    });
  }

  return {
    policy: input.policy,
    refreshedItemIds: refreshedItemIds.sort(),
    retainedItemIds: retainedItemIds.sort(),
    unavailableItemIds: unavailableItemIds.sort(),
    removedBackupIds: removedBackupIds.sort(),
    accommodationMissing,
    retainedPlaceCount: retainedPlaceIds.size,
    invalidatedLegIds: [...new Set(invalidatedLegIds)].sort(),
    warnings,
  };
}

/**
 * Whether two records describe the same place identically.
 *
 * Exact on every field `assertItineraryUsesPool` checks, because the point of this comparison
 * is to decide whether the attached copy still satisfies that gate. A looser comparison here
 * would leave a stale copy in place and fail validation two steps later.
 */
function recordsMatch(attached: TripPlace, canonical: TripPlace): boolean {
  return (
    attached.name === canonical.name &&
    attached.category === canonical.category &&
    attached.coordinates.lat === canonical.coordinates.lat &&
    attached.coordinates.lng === canonical.coordinates.lng &&
    (attached.address ?? null) === (canonical.address ?? null) &&
    (attached.website ?? null) === (canonical.website ?? null) &&
    (attached.phone ?? null) === (canonical.phone ?? null) &&
    (attached.openingHours ?? null) === (canonical.openingHours ?? null)
  );
}

function retain(
  into: NonNullable<TripGenerationContext["retainedPlaces"]>,
  place: TripPlace,
  now: string,
): void {
  if (into.some((entry) => entry.place.placeId === place.placeId)) return;
  into.push({ place, retainedAt: now, reason: "missing-after-refresh" });
}

/**
 * A stop with no place, keeping its slot.
 *
 * The same shape generation produces for a slot it could not fill, so the card, the map
 * exclusion and the totals all behave identically — there is one kind of open slot, not two.
 */
function toUnavailable(item: ItineraryItem): ItineraryItem {
  const gap: ItineraryItem = {
    ...item,
    status: "unavailable",
    place: null,
    title: `${item.title} — place no longer found`,
    rationale: `The latest OpenStreetMap search did not return “${item.place?.name ?? "this place"}”, so this slot is open. That may mean it was retagged rather than closed.`,
    estimatedCost: 0,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
  };
  delete (gap as { costEstimate?: unknown }).costEstimate;
  return gap;
}

function previousItemOf(day: ItineraryDay, itemId: string): ItineraryItem | null {
  const index = day.items.findIndex((item) => item.id === itemId);
  return index > 0 ? day.items[index - 1] : null;
}
