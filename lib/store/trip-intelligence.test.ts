import { describe, expect, it } from "vitest";

import {
  fact,
  identity,
  sidecar,
} from "@/lib/place-intelligence/test-fixtures";
import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { TripPlan } from "@/lib/schemas";

import {
  intelligenceFor,
  putIntelligence,
  reconcileTripIntelligence,
  sidecarForExport,
  MAX_SIDECAR_ENTRIES,
} from "./trip-intelligence";

/**
 * The sidecar at the storage boundary.
 *
 * Two properties carry the weight. **Only what may be persisted gets in** — the filter is applied where the write
 * happens rather than where the data was fetched, because a forecast is legitimate in memory and a lie with a timestamp
 * in `localStorage`. And **reconciliation is one helper**, so "which places does this trip still hold enrichment for" has
 * a single answer rather than one per call site.
 */

const NOW = "2026-07-28T12:00:00.000Z";

function planPlaceIds(plan: TripPlan): string[] {
  const ids: string[] = [];
  for (const day of plan.days) {
    for (const item of day.items) if (item.place) ids.push(item.place.placeId);
  }
  return ids;
}

/** A sidecar entry for one place: a trusted identity, a description and a founding year. */
function entryFor(canonicalPlaceId: string) {
  return sidecar({
    canonicalPlaceId,
    identities: [identity({ canonicalPlaceId })],
    facts: [
      fact({
        kind: "official-description",
        value: "monastery in Lisbon, Portugal",
        provider: "wikidata",
      }),
      fact({ kind: "inception-year", value: 1501, provider: "wikidata" }),
    ],
  });
}

describe("writing into the sidecar", () => {
  it("stores an entry under its own place id", () => {
    const plan = fixtureSavedPlan();
    const [first] = planPlaceIds(plan);

    const stored = putIntelligence(null, [entryFor(first)], NOW);

    expect(stored.schemaVersion).toBe(1);
    expect(stored.refreshedAt).toBe(NOW);
    expect(intelligenceFor(stored, first)?.canonicalPlaceId).toBe(first);
  });

  it("merges a second run rather than replacing the first", () => {
    const plan = fixtureSavedPlan();
    const [first, second] = planPlaceIds(plan);

    const afterFirst = putIntelligence(null, [entryFor(first)], NOW);
    const afterSecond = putIntelligence(
      afterFirst,
      [entryFor(second)],
      "2026-07-28T13:00:00.000Z",
    );

    expect(intelligenceFor(afterSecond, first)).not.toBeNull();
    expect(intelligenceFor(afterSecond, second)).not.toBeNull();
    expect(afterSecond.refreshedAt).toBe("2026-07-28T13:00:00.000Z");
  });

  it("strips a fact that may not be persisted, and drops an entry left empty", () => {
    const plan = fixtureSavedPlan();
    const [first] = planPlaceIds(plan);

    /* A forecast is displayable and never storable — in a saved trip it becomes a confident claim about past weather. */
    const forecastOnly = sidecar({
      canonicalPlaceId: first,
      identities: [],
      facts: [
        fact({
          kind: "weather-forecast",
          value: "18 °C, light rain",
          provider: "open-meteo",
        }),
      ],
    });

    const stored = putIntelligence(null, [forecastOnly], NOW);
    expect(intelligenceFor(stored, first)).toBeNull();
  });

  it("keeps the identity when every fact was stripped", () => {
    const plan = fixtureSavedPlan();
    const [first] = planPlaceIds(plan);

    /*
     * An identity carries no licence obligation of its own, and keeping it is what makes a review queue survive a
     * reload — a person confirming a match needs the link to still be there.
     */
    const identityOnly = sidecar({
      canonicalPlaceId: first,
      identities: [identity({ canonicalPlaceId: first })],
      facts: [
        fact({
          kind: "weather-forecast",
          value: "18 °C",
          provider: "open-meteo",
        }),
      ],
    });

    const stored = putIntelligence(null, [identityOnly], NOW);
    expect(intelligenceFor(stored, first)?.identities).toHaveLength(1);
    expect(intelligenceFor(stored, first)?.facts).toEqual([]);
  });
});

describe("reconciliation against the trip as it stands", () => {
  it("keeps an entry for a scheduled place", () => {
    const plan = fixtureSavedPlan();
    const [first] = planPlaceIds(plan);

    const reconciled = reconcileTripIntelligence({
      intelligence: putIntelligence(null, [entryFor(first)], NOW),
      plan,
      generationContext: null,
    });

    expect(intelligenceFor(reconciled, first)).not.toBeNull();
  });

  it("drops an entry for a place the trip no longer references", () => {
    const plan = fixtureSavedPlan();

    const reconciled = reconcileTripIntelligence({
      intelligence: putIntelligence(null, [entryFor("osm:node:999999")], NOW),
      plan,
      generationContext: null,
    });

    /* Nothing survived, so `null` rather than an empty object: one representation of "no enrichment", not two. */
    expect(reconciled).toBeNull();
  });

  it("keeps an entry for a pool place the itinerary does not schedule", () => {
    /*
     * `selectLandmarkCandidates` draws from the pool, so an entry for a pool place is enrichment already paid for
     * against a volunteer service. Dropping it would mean re-fetching it the next time the traveller compares options.
     */
    const plan = fixtureSavedPlan();
    const scheduled = new Set(planPlaceIds(plan));
    const poolOnly = FIXTURE_GENERATION.placePool.places.find(
      (place) => !scheduled.has(place.placeId),
    );
    expect(poolOnly).toBeDefined();
    if (!poolOnly) return;

    const reconciled = reconcileTripIntelligence({
      intelligence: putIntelligence(null, [entryFor(poolOnly.placeId)], NOW),
      plan,
      generationContext: FIXTURE_GENERATION,
    });

    expect(intelligenceFor(reconciled, poolOnly.placeId)).not.toBeNull();
  });

  it("keeps enrichment for a place that survived a pool refresh", () => {
    /*
     * The judgement this pins: a refreshed pool does not void enrichment. A QID a mapper recorded does not stop being
     * that place's QID because Roamly re-ran a search, and discarding the sidecar would send a fresh round of serial
     * requests to re-learn facts that had not changed.
     */
    const plan = fixtureSavedPlan();
    const [first] = planPlaceIds(plan);
    const stored = putIntelligence(null, [entryFor(first)], NOW);

    const refreshed = {
      ...FIXTURE_GENERATION,
      placePool: {
        ...FIXTURE_GENERATION.placePool,
        places: FIXTURE_GENERATION.placePool.places.filter(
          (place) => place.placeId !== first,
        ),
      },
    };

    const reconciled = reconcileTripIntelligence({
      intelligence: stored,
      plan,
      generationContext: refreshed,
    });

    /* Still scheduled in the itinerary, so still referenced — the pool's absence is not a verdict on it. */
    expect(intelligenceFor(reconciled, first)?.facts).toHaveLength(2);
  });

  it("keeps an entry for the accommodation", () => {
    /*
     * The accommodation hangs off the plan rather than off a day, so it is the source easiest to miss — and missing it
     * would prune a hotel's enrichment on the first reconciliation after it was fetched.
     */
    const plan = fixtureSavedPlan();
    expect(plan.accommodation).not.toBeNull();
    if (!plan.accommodation) return;

    const hotelId = plan.accommodation.place.placeId;

    const reconciled = reconcileTripIntelligence({
      intelligence: putIntelligence(null, [entryFor(hotelId)], NOW),
      plan,
      generationContext: null,
    });

    expect(intelligenceFor(reconciled, hotelId)).not.toBeNull();
  });

  it("returns null for a null sidecar", () => {
    expect(
      reconcileTripIntelligence({
        intelligence: null,
        plan: fixtureSavedPlan(),
        generationContext: FIXTURE_GENERATION,
      }),
    ).toBeNull();
  });

  it("never exceeds the entry cap", () => {
    expect(MAX_SIDECAR_ENTRIES).toBe(12);
  });
});

describe("export", () => {
  it("keeps a CC0 Wikidata description, which is redistributable", () => {
    const plan = fixtureSavedPlan();
    const [first] = planPlaceIds(plan);

    const exported = sidecarForExport(
      putIntelligence(null, [entryFor(first)], NOW),
    );

    expect(intelligenceFor(exported, first)?.facts).toHaveLength(2);
  });

  it("returns null when nothing may leave", () => {
    expect(sidecarForExport(null)).toBeNull();
  });
});
