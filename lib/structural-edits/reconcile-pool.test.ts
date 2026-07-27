import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { TripPlanSchema } from "@/lib/schemas";
import type { TripPlace, TripPlan, VerifiedPlacePool } from "@/lib/schemas";

import { diffPlacePools } from "./pool-diff";
import { applyPoolRefresh, previewReconciliation } from "./reconcile-pool";
import type { ReconciliationPolicy } from "./reconcile-pool";
import { validateRetainedPlaces } from "./validate";
import type { StructuralEditResult } from "./types";

const NOW = "2026-08-20T09:00:00.000Z";
const TIMEZONE = "Europe/Lisbon";
const PLAN = fixtureSavedPlan();
const PREVIOUS = FIXTURE_GENERATION.placePool;

function poolWithout(...placeIds: string[]): VerifiedPlacePool {
  return {
    ...PREVIOUS,
    createdAt: NOW,
    places: PREVIOUS.places.filter((place) => !placeIds.includes(place.placeId)),
  };
}

function poolWith(mapper: (place: TripPlace) => TripPlace): VerifiedPlacePool {
  return { ...PREVIOUS, createdAt: NOW, places: PREVIOUS.places.map(mapper) };
}

function refresh(
  nextPool: VerifiedPlacePool,
  policy: ReconciliationPolicy,
  plan: TripPlan = PLAN,
): StructuralEditResult {
  const changes = diffPlacePools({ previous: PREVIOUS, next: nextPool, plan });

  return applyPoolRefresh({
    plan,
    generation: FIXTURE_GENERATION,
    revisionBefore: 5,
    timezone: TIMEZONE,
    nextPool,
    changes,
    policy,
    now: NOW,
  });
}

function preview(
  nextPool: VerifiedPlacePool,
  policy: ReconciliationPolicy,
  plan: TripPlan = PLAN,
) {
  return previewReconciliation({
    plan,
    generation: FIXTURE_GENERATION,
    nextPool,
    changes: diffPlacePools({ previous: PREVIOUS, next: nextPool, plan }),
    policy,
  });
}

const MUSEUM = FIXTURE_PLACES.museumOne.placeId;
const HOTEL = FIXTURE_PLACES.hotel.placeId;

describe("applyPoolRefresh — nothing missing", () => {
  it("swaps the pool in and leaves the itinerary alone", () => {
    const result = refresh(poolWithout(), "keep-valid-and-flag-missing");

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.generationContext.placePool.createdAt).toBe(NOW);
    expect(result.generationContext.retainedPlaces).toBeUndefined();
    expect(result.plan.days).toEqual(PLAN.days);
    expect(result.summary.action).toBe("refresh-place-pool");
  });

  /**
   * The point of refreshing: a corrected record reaches the itinerary. It also *has* to, because
   * `assertItineraryUsesPool` requires the attached copy to be faithful to the pool's.
   */
  it("refreshes the attached record of a place whose facts changed", () => {
    const next = poolWith((place) =>
      place.placeId === MUSEUM
        ? { ...place, openingHours: "Tu-Su 10:00-18:00" }
        : place,
    );

    const result = refresh(next, "keep-valid-and-flag-missing");
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const stop = result.plan.days
      .flatMap((day) => day.items)
      .find((item) => item.place?.placeId === MUSEUM);
    expect(stop?.place?.openingHours).toBe("Tu-Su 10:00-18:00");
    expect(result.summary.changedItemIds).not.toContain(stop?.id);
  });

  it("refreshes a backup's attached record too", () => {
    const backupPlaceId = PLAN.days[0].backups[0].place.placeId;
    const next = poolWith((place) =>
      place.placeId === backupPlaceId ? { ...place, name: "MAAT Lisbon" } : place,
    );

    const result = refresh(next, "keep-valid-and-flag-missing");
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.plan.days[0].backups[0].place.name).toBe("MAAT Lisbon");
  });
});

describe("applyPoolRefresh — keep-valid-and-flag-missing", () => {
  it("keeps the stop and records the place as retained", () => {
    const result = refresh(poolWithout(MUSEUM), "keep-valid-and-flag-missing");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;

    const stop = result.plan.days
      .flatMap((day) => day.items)
      .find((item) => item.place?.placeId === MUSEUM);
    expect(stop).toBeDefined();
    expect(stop?.status).toBe("confirmed");

    expect(result.generationContext.retainedPlaces).toEqual([
      {
        place: FIXTURE_PLACES.museumOne,
        retainedAt: NOW,
        reason: "missing-after-refresh",
      },
    ]);
  });

  it("warns, and says the stop is unchanged", () => {
    const result = refresh(poolWithout(MUSEUM), "keep-valid-and-flag-missing");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    const warning = result.warnings.find(
      (entry) => entry.code === "place_missing_after_refresh",
    );
    expect(warning?.message).toContain("Your stop is unchanged");
  });

  it("keeps the stop's cost and travel intact", () => {
    const result = refresh(poolWithout(MUSEUM), "keep-valid-and-flag-missing");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.plan.budget.total).toBeCloseTo(PLAN.budget.total, 2);
    expect(result.summary.invalidatedLegIds).toEqual([]);
  });

  it("produces a pair the membership validator accepts", () => {
    const result = refresh(poolWithout(MUSEUM), "keep-valid-and-flag-missing");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(
      validateRetainedPlaces({
        plan: result.plan,
        generation: result.generationContext,
      }),
    ).toEqual([]);
  });

  it("keeps a missing accommodation and flags it", () => {
    const result = refresh(poolWithout(HOTEL), "keep-valid-and-flag-missing");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.plan.accommodation?.place.placeId).toBe(HOTEL);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "accommodation_missing_after_refresh",
    );
    expect(
      result.generationContext.retainedPlaces?.some(
        (entry) => entry.place.placeId === HOTEL,
      ),
    ).toBe(true);
  });
});

describe("applyPoolRefresh — replace-missing-with-unavailable", () => {
  it("turns the stop into an open slot with the reason attached", () => {
    const result = refresh(poolWithout(MUSEUM), "replace-missing-with-unavailable");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;

    const slot = result.plan.days
      .flatMap((day) => day.items)
      .find((item) => item.id === "museum-one");
    expect(slot?.status).toBe("unavailable");
    expect(slot?.place).toBeNull();
    expect(slot?.estimatedCost).toBe(0);
    expect(slot?.costEstimate).toBeUndefined();
    expect(slot?.rationale).toContain("retagged rather than closed");
  });

  it("records nothing as retained", () => {
    const result = refresh(poolWithout(MUSEUM), "replace-missing-with-unavailable");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.generationContext.retainedPlaces).toBeUndefined();
  });

  it("lowers the day total and the budget", () => {
    const cost = PLAN.days
      .flatMap((day) => day.items)
      .find((item) => item.place?.placeId === MUSEUM)!.estimatedCost;
    expect(cost).toBeGreaterThan(0);

    const result = refresh(poolWithout(MUSEUM), "replace-missing-with-unavailable");
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;

    expect(result.plan.budget.total).toBeCloseTo(PLAN.budget.total - cost, 2);
  });

  it("removes a missing accommodation and says so", () => {
    const result = refresh(poolWithout(HOTEL), "replace-missing-with-unavailable");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.plan.accommodation).toBeNull();
    expect(
      result.warnings.find(
        (warning) => warning.code === "accommodation_missing_after_refresh",
      )?.message,
    ).toContain("no longer has a recommended place to stay");
  });

  it("still produces a schema-valid plan", () => {
    const result = refresh(poolWithout(MUSEUM, HOTEL), "replace-missing-with-unavailable");

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(TripPlanSchema.safeParse(result.plan).success).toBe(true);
  });
});

describe("applyPoolRefresh — backups and categories", () => {
  /**
   * Removed under either policy. Retaining it would keep a fallback that cannot be promoted —
   * promotion refuses a retained place, because promoting is a new selection.
   */
  it("removes a backup whose place is gone, under both policies", () => {
    const backupPlaceId = PLAN.days[0].backups[0].place.placeId;

    for (const policy of [
      "keep-valid-and-flag-missing",
      "replace-missing-with-unavailable",
    ] as const) {
      const result = refresh(poolWithout(backupPlaceId), policy);
      expect(result.status, policy).toBe("partial");
      if (result.status !== "partial") continue;

      expect(result.plan.days[0].backups, policy).toEqual([]);
      expect(result.summary.removedBackupIds, policy).toContain(
        PLAN.days[0].backups[0].id,
      );
    }
  });

  it("names a category the refreshed search no longer has", () => {
    const next: VerifiedPlacePool = {
      ...PREVIOUS,
      createdAt: NOW,
      places: PREVIOUS.places.filter((place) => place.category !== "museum"),
    };

    const result = refresh(next, "keep-valid-and-flag-missing");
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(
      result.warnings.find((warning) => warning.code === "category_now_empty")
        ?.message,
    ).toContain("museum");
  });

  /**
   * A pool that halved is far more likely a failed query than a destination that lost half its
   * mapped places, and saying so is the difference between a useful warning and a scare.
   */
  it("warns when the refreshed pool is suspiciously sparse", () => {
    const next: VerifiedPlacePool = {
      ...PREVIOUS,
      createdAt: NOW,
      places: PREVIOUS.places.slice(0, 2),
    };

    const result = refresh(next, "keep-valid-and-flag-missing");
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(
      result.warnings.find((warning) => warning.code === "pool_sparse")?.message,
    ).toContain("did not complete");
  });
});

describe("previewReconciliation", () => {
  it("previews the keep policy without building a plan", () => {
    const result = preview(poolWithout(MUSEUM), "keep-valid-and-flag-missing");

    expect(result.retainedItemIds).toEqual(["museum-one"]);
    expect(result.unavailableItemIds).toEqual([]);
    expect(result.retainedPlaceCount).toBe(1);
    expect(result.invalidatedLegIds).toEqual([]);
    expect("plan" in result).toBe(false);
  });

  it("previews the replace policy, including the routes it clears", () => {
    const result = preview(poolWithout(MUSEUM), "replace-missing-with-unavailable");

    expect(result.unavailableItemIds).toEqual(["museum-one"]);
    expect(result.retainedItemIds).toEqual([]);
    expect(result.retainedPlaceCount).toBe(0);
  });

  it("previews refreshed records separately from missing ones", () => {
    const result = preview(
      poolWith((place) =>
        place.placeId === MUSEUM ? { ...place, name: "Azulejo" } : place,
      ),
      "keep-valid-and-flag-missing",
    );

    expect(result.refreshedItemIds).toEqual(["museum-one"]);
    expect(result.retainedItemIds).toEqual([]);
  });

  it("previews a missing accommodation under both policies", () => {
    expect(
      preview(poolWithout(HOTEL), "keep-valid-and-flag-missing")
        .accommodationMissing,
    ).toBe(true);
    expect(
      preview(poolWithout(HOTEL), "replace-missing-with-unavailable")
        .accommodationMissing,
    ).toBe(true);
  });

  /**
   * The preview and the commit must agree, or the dialog is lying. Same inputs, same functions,
   * same answer.
   */
  it("agrees with what the commit actually does", () => {
    for (const policy of [
      "keep-valid-and-flag-missing",
      "replace-missing-with-unavailable",
    ] as const) {
      const next = poolWithout(MUSEUM);
      const previewed = preview(next, policy);
      const applied = refresh(next, policy);

      expect(applied.status, policy).toBe("partial");
      if (applied.status !== "partial") continue;

      const unavailable = applied.plan.days
        .flatMap((day) => day.items)
        .filter((item) => item.status === "unavailable")
        .map((item) => item.id);

      expect(unavailable, policy).toEqual(previewed.unavailableItemIds);
      expect(
        applied.generationContext.retainedPlaces?.length ?? 0,
        policy,
      ).toBe(previewed.retainedPlaceCount);
      expect(applied.summary.removedBackupIds, policy).toEqual(
        previewed.removedBackupIds,
      );
    }
  });

  it("is deterministic", () => {
    const next = poolWithout(MUSEUM);
    expect(
      JSON.stringify(preview(next, "keep-valid-and-flag-missing")),
    ).toBe(JSON.stringify(preview(next, "keep-valid-and-flag-missing")));
  });
});

describe("applyPoolRefresh — purity", () => {
  it("leaves the plan and the context it was given untouched", () => {
    const planSnapshot = JSON.stringify(PLAN);
    const contextSnapshot = JSON.stringify(FIXTURE_GENERATION);

    refresh(poolWithout(MUSEUM), "replace-missing-with-unavailable");

    expect(JSON.stringify(PLAN)).toBe(planSnapshot);
    expect(JSON.stringify(FIXTURE_GENERATION)).toBe(contextSnapshot);
  });

  it("is deterministic", () => {
    const next = poolWithout(MUSEUM);
    expect(
      JSON.stringify(refresh(next, "keep-valid-and-flag-missing")),
    ).toBe(JSON.stringify(refresh(next, "keep-valid-and-flag-missing")));
  });
});
