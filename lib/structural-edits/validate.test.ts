import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  FIXTURE_SPARE_CAFE,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { MAX_RETAINED_PLACES } from "@/lib/schemas";
import type { TripGenerationContext, TripPlace } from "@/lib/schemas";

import {
  placeIsSelectable,
  retainedPlaceIds,
  validatePlanMembership,
  validateRetainedPlaces,
} from "./validate";

const PLAN = fixtureSavedPlan();
const MUSEUM = FIXTURE_PLACES.museumOne;

/** The context with the museum moved out of the pool and into the retained collection. */
function withRetained(
  places: TripPlace[] = [MUSEUM],
  options: { keepInPool?: boolean } = {},
): TripGenerationContext {
  const retainedIds = new Set(places.map((place) => place.placeId));

  return {
    ...FIXTURE_GENERATION,
    placePool: {
      ...FIXTURE_GENERATION.placePool,
      places: options.keepInPool
        ? FIXTURE_GENERATION.placePool.places
        : FIXTURE_GENERATION.placePool.places.filter(
            (place) => !retainedIds.has(place.placeId),
          ),
    },
    retainedPlaces: places.map((place) => ({
      place,
      retainedAt: "2026-08-20T09:00:00.000Z",
      reason: "missing-after-refresh" as const,
    })),
  };
}

describe("validateRetainedPlaces", () => {
  it("accepts a context with none", () => {
    expect(
      validateRetainedPlaces({ plan: PLAN, generation: FIXTURE_GENERATION }),
    ).toEqual([]);
  });

  it("accepts a retained place the plan still uses", () => {
    expect(
      validateRetainedPlaces({ plan: PLAN, generation: withRetained() }),
    ).toEqual([]);
  });

  /**
   * The check that stops the collection becoming a second pool. An entry nothing references is
   * accumulation, and accumulation is how the invariant would quietly widen.
   */
  it("rejects a retained place nothing references", () => {
    const issues = validateRetainedPlaces({
      plan: PLAN,
      generation: withRetained([FIXTURE_SPARE_CAFE]),
    });

    expect(issues.map((issue) => issue.code)).toContain("retained_not_referenced");
  });

  /**
   * A place cannot be both current and retained: "did the latest search find this?" would have
   * two answers, and whichever the code read first would decide whether the traveller is warned.
   */
  it("rejects a place that is in the pool and retained at once", () => {
    const issues = validateRetainedPlaces({
      plan: PLAN,
      generation: withRetained([MUSEUM], { keepInPool: true }),
    });

    expect(issues.map((issue) => issue.code)).toContain("pool_invalid");
    expect(issues[0].message).toContain("ambiguous");
  });

  it("rejects a duplicate retained entry", () => {
    const context = withRetained([MUSEUM]);
    const issues = validateRetainedPlaces({
      plan: PLAN,
      generation: {
        ...context,
        retainedPlaces: [...context.retainedPlaces!, ...context.retainedPlaces!],
      },
    });

    expect(issues.map((issue) => issue.message)).toContain(
      `Place ${MUSEUM.placeId} is recorded as retained twice.`,
    );
  });

  it("rejects a collection over the cap", () => {
    const many = Array.from({ length: MAX_RETAINED_PLACES + 1 }, (_, index) => ({
      place: {
        ...MUSEUM,
        placeId: `osm:node:90000${index}`,
        source: {
          ...MUSEUM.source,
          canonicalId: `osm:node:90000${index}`,
          osmId: `90000${index}`,
        },
      },
      retainedAt: "2026-08-20T09:00:00.000Z",
      reason: "missing-after-refresh" as const,
    }));

    const issues = validateRetainedPlaces({
      plan: PLAN,
      generation: { ...FIXTURE_GENERATION, retainedPlaces: many },
    });

    expect(issues[0].code).toBe("pool_invalid");
    expect(issues[0].message).toContain(String(MAX_RETAINED_PLACES));
  });

  it("rejects a retained record that is not verifiable", () => {
    const broken: TripPlace = {
      ...MUSEUM,
      // A placeId that disagrees with its own source identity.
      placeId: "osm:node:111111",
    };

    const issues = validateRetainedPlaces({
      plan: PLAN,
      generation: {
        ...FIXTURE_GENERATION,
        retainedPlaces: [
          {
            place: broken,
            retainedAt: "2026-08-20T09:00:00.000Z",
            reason: "missing-after-refresh",
          },
        ],
      },
    });

    expect(issues.map((issue) => issue.code)).toContain("pool_invalid");
  });
});

describe("validatePlanMembership", () => {
  it("accepts a plan whose places are all in the pool", () => {
    expect(
      validatePlanMembership({ plan: PLAN, generation: FIXTURE_GENERATION }),
    ).toEqual([]);
  });

  /** The widening, from the permitted side: an existing reference may resolve to a retained record. */
  it("accepts a plan whose place is only retained", () => {
    expect(
      validatePlanMembership({ plan: PLAN, generation: withRetained() }),
    ).toEqual([]);
  });

  it("rejects a plan whose place is in neither", () => {
    const stripped: TripGenerationContext = {
      ...FIXTURE_GENERATION,
      placePool: {
        ...FIXTURE_GENERATION.placePool,
        places: FIXTURE_GENERATION.placePool.places.filter(
          (place) => place.placeId !== MUSEUM.placeId,
        ),
      },
    };

    const issues = validatePlanMembership({ plan: PLAN, generation: stripped });
    expect(issues[0].code).toBe("pool_violation");
    expect(issues[0].placeId).toBe(MUSEUM.placeId);
  });

  it("rejects an altered attached copy even when the id is in the pool", () => {
    const tampered = {
      ...PLAN,
      days: PLAN.days.map((day) => ({
        ...day,
        items: day.items.map((item) =>
          item.place?.placeId === MUSEUM.placeId
            ? { ...item, place: { ...item.place, name: "Somewhere else" } }
            : item,
        ),
      })),
    };

    expect(
      validatePlanMembership({ plan: tampered, generation: FIXTURE_GENERATION })[0]
        ?.code,
    ).toBe("pool_violation");
  });

  it("reports the retained problems before the membership ones", () => {
    const issues = validatePlanMembership({
      plan: PLAN,
      generation: withRetained([FIXTURE_SPARE_CAFE]),
    });

    // The unreferenced entry is the real fault; membership would also fail, confusingly.
    expect(issues[0].code).toBe("retained_not_referenced");
  });
});

describe("placeIsSelectable", () => {
  /**
   * The narrow half of the invariant: a new selection must come from the active pool. Every
   * candidate list already derives from the pool, so this is a predicate a future one can call
   * rather than the primary defence.
   */
  it("is true only for current pool members", () => {
    expect(placeIsSelectable(FIXTURE_GENERATION, MUSEUM.placeId)).toBe(true);
    expect(placeIsSelectable(withRetained(), MUSEUM.placeId)).toBe(false);
    expect(placeIsSelectable(FIXTURE_GENERATION, "osm:node:999999")).toBe(false);
  });
});

describe("retainedPlaceIds", () => {
  it("lists the places only the retained collection vouches for", () => {
    expect(retainedPlaceIds(withRetained())).toEqual(new Set([MUSEUM.placeId]));
    expect(retainedPlaceIds(FIXTURE_GENERATION)).toEqual(new Set());
    expect(retainedPlaceIds(null)).toEqual(new Set());
  });
});
