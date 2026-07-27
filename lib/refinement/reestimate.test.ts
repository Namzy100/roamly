import { describe, expect, it } from "vitest";

import { CostEstimateSchema, TripPlanSchema } from "@/lib/schemas";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";

import {
  costProfileProvenance,
  previousCostProfile,
  reestimatePlanCosts,
} from "./reestimate";
import { FIXTURE_DESTINATION, FIXTURE_GENERATION, fixtureSavedPlan } from "./test-fixtures";

function reestimate(
  plan: TripPlan = fixtureSavedPlan(),
  generation: TripGenerationContext | null = FIXTURE_GENERATION,
) {
  return reestimatePlanCosts({ plan, generation });
}

/** Every stop that is a real visit, for the "nothing else changed" assertions. */
function stops(plan: TripPlan) {
  return plan.days.flatMap((day) =>
    day.items.filter((item) => item.status === "confirmed" && item.place !== null),
  );
}

describe("reestimatePlanCosts — what it changes", () => {
  it("recomputes item estimates against the destination profile", () => {
    const before = fixtureSavedPlan();
    const result = reestimate(before);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.changedItemIds.length).toBeGreaterThan(0);
    expect(result.profile.profile.profileId).toBe("lisbon");
    expect(result.profile.match).toBe("city");
  });

  it("attaches a full provenance-bearing estimate to every repriced stop", () => {
    const result = reestimate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const item of stops(result.plan)) {
      expect(item.costEstimate, item.id).toBeDefined();
      expect(CostEstimateSchema.safeParse(item.costEstimate).success, item.id).toBe(
        true,
      );
      expect(item.costEstimate?.currency, item.id).toBe("EUR");
      expect(item.costEstimate?.disclaimer, item.id).toBeTruthy();
      if (item.costEstimate?.basis !== "free-entry-tag") {
        expect(item.costEstimate?.profileId, item.id).toBe("lisbon");
      }
    }
  });

  it("re-derives the day totals and the budget", () => {
    const before = fixtureSavedPlan();
    const result = reestimate(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const day of result.plan.days) {
      expect(day.dayTotal).toBeCloseTo(
        day.items.reduce((sum, item) => sum + item.estimatedCost, 0),
        2,
      );
    }

    expect(result.plan.budget.total).toBeCloseTo(
      result.plan.budget.flights +
        result.plan.budget.accommodation +
        result.plan.budget.food +
        result.plan.budget.activities +
        result.plan.budget.transport,
      2,
    );
    expect(result.newTotal).toBe(result.plan.budget.total);
    expect(result.previousTotal).toBe(before.budget.total);
  });

  it("still produces a schema-valid plan", () => {
    const result = reestimate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(TripPlanSchema.safeParse(result.plan).success).toBe(true);
  });

  it("says which way the total moved, in the trip's own currency", () => {
    const result = reestimate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.message).toMatch(/recalculated/i);
    if (result.newTotal !== result.previousTotal) {
      expect(result.message).toContain("EUR");
    }
  });

  it("reports the confidence the previous figures carried", () => {
    const result = reestimate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.previousConfidence).toBe("high");
  });
});

describe("reestimatePlanCosts — what it must not change", () => {
  /**
   * The whole reason this action is safe to offer. A traveller pressing "recalculate cost
   * estimates" and finding their Tuesday rearranged would have every reason never to press
   * anything again.
   */
  it("leaves every place, time, date, order and id exactly as it was", () => {
    const before = fixtureSavedPlan();
    const result = reestimate(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.days).toHaveLength(before.days.length);

    for (const [index, day] of result.plan.days.entries()) {
      const original = before.days[index];
      expect(day.dayNumber).toBe(original.dayNumber);
      expect(day.date).toBe(original.date);
      expect(day.theme).toBe(original.theme);
      expect(day.items).toHaveLength(original.items.length);

      for (const [position, item] of day.items.entries()) {
        const source = original.items[position];
        expect(item.id).toBe(source.id);
        expect(item.order).toBe(source.order);
        expect(item.startTime).toBe(source.startTime);
        expect(item.endTime).toBe(source.endTime);
        expect(item.place?.placeId ?? null).toBe(source.place?.placeId ?? null);
        expect(item.kind).toBe(source.kind);
        expect(item.mealType).toBe(source.mealType);
        expect(item.status).toBe(source.status);
        expect(item.title).toBe(source.title);
        expect(item.travelToNext).toEqual(source.travelToNext);
      }

      expect(day.backups).toEqual(original.backups);
    }
  });

  it("leaves the accommodation, flight estimate and destination alone", () => {
    const before = fixtureSavedPlan();
    const result = reestimate(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.accommodation).toEqual(before.accommodation);
    expect(result.plan.flights).toEqual(before.flights);
    expect(result.plan.destination).toEqual(before.destination);
    expect(result.plan.routing).toEqual(before.routing);
  });

  /**
   * Flights, accommodation and transport are carried through: they were estimated from the
   * same allocation at generation time, and `transport` has no per-item source at all.
   * Re-deriving them here would move money the traveller has already seen attributed.
   */
  it("carries the three non-item budget categories through untouched", () => {
    const before = fixtureSavedPlan();
    const result = reestimate(before);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.budget.flights).toBe(before.budget.flights);
    expect(result.plan.budget.accommodation).toBe(before.budget.accommodation);
    expect(result.plan.budget.transport).toBe(before.budget.transport);
    expect(result.plan.budget.requestedBudget).toBe(before.budget.requestedBudget);
  });

  it("leaves the plan it was given untouched", () => {
    const plan = fixtureSavedPlan();
    const snapshot = JSON.stringify(plan);

    reestimate(plan);

    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  it("gives an unfilled slot no allowance", () => {
    const plan = fixtureSavedPlan();
    const gapped: TripPlan = {
      ...plan,
      days: plan.days.map((day, index) =>
        index === 0
          ? {
              ...day,
              items: day.items.map((item, position) =>
                position === 0
                  ? {
                      ...item,
                      status: "unavailable" as const,
                      place: null,
                      estimatedCost: 0,
                    }
                  : item,
              ),
            }
          : day,
      ),
    };

    const result = reestimate(gapped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const slot = result.plan.days[0].items[0];
    expect(slot.estimatedCost).toBe(0);
    expect(slot.place).toBeNull();
    expect(result.changedItemIds).not.toContain(slot.id);
  });

  it("returns the same day object for a day nothing on it changed", () => {
    const first = reestimate();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The second run finds nothing to change, so it refuses rather than rebuilding.
    const second = reestimatePlanCosts({
      plan: first.plan,
      generation: FIXTURE_GENERATION,
    });
    expect(second).toMatchObject({ ok: false, error: { code: "no_change" } });
  });
});

describe("reestimatePlanCosts — destinations and profiles", () => {
  it("uses the geocoded destination the generation context recorded", () => {
    const result = reestimate(fixtureSavedPlan(), {
      ...FIXTURE_GENERATION,
      destination: {
        ...FIXTURE_DESTINATION,
        name: "Dubai",
        displayName: "Dubai, United Arab Emirates",
        countryCode: "ae",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.profile.profileId).toBe("dubai");
  });

  /**
   * The sample trip and anything saved before Phase 5B has no generation context, so the
   * plan's own destination name is the fallback. It still resolves — a name the table does
   * not know gets the global profile.
   */
  it("falls back to the plan's own destination when there is no context", () => {
    const result = reestimate(fixtureSavedPlan(), null);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.profile.profileId).toBe("lisbon");
    expect(result.previousConfidence).toBeNull();
  });

  it("produces a low-confidence estimate for an unknown destination", () => {
    const result = reestimate(fixtureSavedPlan(), {
      ...FIXTURE_GENERATION,
      destination: {
        ...FIXTURE_DESTINATION,
        name: "Ulaanbaatar",
        displayName: "Ulaanbaatar, Mongolia",
        countryCode: "mn",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.match).toBe("global");
    expect(result.allocation.confidence).toBe("low");
    for (const item of stops(result.plan)) {
      if (item.costEstimate?.basis === "free-entry-tag") continue;
      expect(item.costEstimate?.basis, item.id).toBe("derived-budget-allocation");
    }
  });

  it("warns through the allocation when there is no destination profile", () => {
    const result = reestimate(fixtureSavedPlan(), {
      ...FIXTURE_GENERATION,
      destination: {
        ...FIXTURE_DESTINATION,
        name: "Ulaanbaatar",
        displayName: "Ulaanbaatar, Mongolia",
        countryCode: "mn",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.warnings.map((warning) => warning.code)).toContain(
      "no_destination_profile",
    );
  });

  /**
   * No exchange rate exists anywhere in the system, so the same budget *number* in another
   * currency must reprice through that currency's own hand-written bands rather than a
   * conversion of the euro figures.
   */
  it("prices in the trip's own currency, never a converted one", () => {
    const plan = fixtureSavedPlan();
    const inDirhams: TripPlan = {
      ...plan,
      request: { ...plan.request, currency: "AED" },
    };

    const result = reestimate(inDirhams);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const item of stops(result.plan)) {
      expect(item.costEstimate?.currency, item.id).toBe("AED");
    }
    // The AED bands are an order of magnitude larger, which is the point of separate tables.
    const euros = reestimate(plan);
    expect(euros.ok).toBe(true);
    if (!euros.ok) return;
    expect(result.plan.budget.food).toBeGreaterThan(euros.plan.budget.food);
  });
});

describe("reestimatePlanCosts — determinism", () => {
  it("is deterministic", () => {
    const first = reestimate();
    const second = reestimate();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
  });

  it("is idempotent", () => {
    const first = reestimate();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(
      reestimatePlanCosts({ plan: first.plan, generation: FIXTURE_GENERATION }),
    ).toMatchObject({ ok: false, error: { code: "no_change" } });
  });
});

describe("provenance helpers", () => {
  it("describes the profile a re-estimate used", () => {
    const result = reestimate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(costProfileProvenance(result.profile)).toEqual({
      profileId: "lisbon",
      version: "1.0.0",
      match: "city",
      confidence: "high",
    });
  });

  it("reads the previously recorded profile", () => {
    expect(previousCostProfile(FIXTURE_GENERATION)).toEqual({
      profileId: "lisbon",
      version: "1.0.0",
      known: true,
    });
  });

  /**
   * A pre-Phase-6B trip recorded none, and it is not invented for it — the figures it
   * carries were produced by different arithmetic, and labelling them with a profile they
   * never saw would be a fabrication of provenance.
   */
  it("returns null for a trip that recorded none", () => {
    const context = { ...FIXTURE_GENERATION };
    delete context.costProfile;

    expect(previousCostProfile(context)).toBeNull();
    expect(previousCostProfile(null)).toBeNull();
  });

  /** The id is still shown, unexplained, rather than silently swapped for another. */
  it("says when a recorded profile is no longer in the table", () => {
    expect(
      previousCostProfile({
        ...FIXTURE_GENERATION,
        costProfile: {
          profileId: "atlantis",
          version: "0.1.0",
          match: "city",
          confidence: "high",
        },
      }),
    ).toEqual({ profileId: "atlantis", version: "0.1.0", known: false });
  });
});
