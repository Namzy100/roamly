import { describe, expect, it } from "vitest";

import {
  FIXTURE_PLACES,
  fixtureOsmPlace,
  fixturePool,
} from "@/lib/generate/test-fixtures";
import {
  FIXTURE_GENERATION,
  fixtureRoutedPlan,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { TripGenerationContext, TripPlace } from "@/lib/schemas";

import {
  ALTERNATIVE_FACT_LABELS,
  estimateFact,
  matchedDietaryNeeds,
  stopAlternatives,
  type AlternativeRelationFactKind,
  type StopAlternative,
} from "./stop-alternatives";

/**
 * What a comparison card is allowed to say, and in what order.
 *
 * Three properties matter more than the rest, and each has a test that would fail if it broke:
 *
 *  1. **Nothing here ranks.** The labels are a closed vocabulary and none may contain a claim this
 *     application cannot evidence. Asserted against the words themselves rather than a rendering,
 *     because the words are the thing that would be wrong.
 *  2. **Every option can be chosen.** A card is derived by running the real applier, so an option
 *     previewing as `invalid` is one the save would refuse — the derivation and the picker must
 *     never disagree about which those are.
 *  3. **The order is total.** The same plan and pool always produce the same list in the same
 *     sequence, with no dependence on pool insertion order or float noise.
 */

const TIMEZONE = "Europe/Lisbon";

/** The fixture pool plus places a test needs. Categories are re-derived by `fixturePool`. */
function generationWith(extra: TripPlace[]): TripGenerationContext {
  return {
    ...FIXTURE_GENERATION,
    placePool: fixturePool([...Object.values(FIXTURE_PLACES), ...extra]),
  };
}

function alternativesFor(
  itemId: string,
  generation: TripGenerationContext,
): StopAlternative[] {
  return stopAlternatives({
    plan: fixtureSavedPlan(),
    generation,
    dayNumber: 1,
    itemId,
    timezone: TIMEZONE,
    revisionBefore: 3,
  });
}

function kinds(alternative: StopAlternative): AlternativeRelationFactKind[] {
  return alternative.relationFacts.map((fact) => fact.kind);
}

/* -- fixture places, positioned to make each property visible ------------- */

/** ~500 m from the café being replaced. No published hours. */
const NEAR_CAFE = fixtureOsmPlace("9001", "Near Café", "cafe", 38.7135, -9.1451);

/** Far away, but the hours say it is open during the 09:00–10:00 slot. */
const FAR_OPEN_CAFE = fixtureOsmPlace(
  "9002",
  "Far Open Café",
  "cafe",
  38.69,
  -9.2,
  { openingHours: "Mo-Su 08:00-19:00" },
);

/** Almost next door, and the hours say it is shut during that slot. */
const NEAR_CLOSED_CAFE = fixtureOsmPlace(
  "9003",
  "Near Closed Café",
  "cafe",
  38.717,
  -9.141,
  { openingHours: "Mo-Su 20:00-23:00" },
);

/** A restaurant much closer to the museum than `restaurantOne` is. */
const CLOSER_RESTAURANT = fixtureOsmPlace(
  "9101",
  "Closer Restaurant",
  "restaurant",
  38.72,
  -9.12,
);

/** A restaurant much further from the museum than `restaurantOne` is. */
const FURTHER_RESTAURANT = fixtureOsmPlace(
  "9102",
  "Further Restaurant",
  "restaurant",
  38.7,
  -9.15,
);

/* -------------------------------------------------------------------------- */
/* The wording                                                                */
/* -------------------------------------------------------------------------- */

describe("the fact vocabulary", () => {
  /**
   * The claims Roamly has no basis for, in the wording a card would most plausibly reach for.
   *
   * OpenStreetMap supplies this application no rating, no review count, no popularity signal, no
   * crowding and no weather, so every one of these would be an opinion presented as data. Checked
   * against the labels rather than a rendered card, because a component can only display what the
   * vocabulary allows.
   */
  const UNSUPPORTED = [
    "best",
    "top-rated",
    "top rated",
    "highly rated",
    "better",
    "more popular",
    "popular",
    "hidden gem",
    "safer",
    "less crowded",
    "quieter",
    "more scenic",
    "scenic",
    "better reviews",
    "reviews",
    "local favourite",
    "local favorite",
    "recommended",
    "must-see",
  ];

  it("never makes a claim we cannot evidence", () => {
    for (const label of Object.values(ALTERNATIVE_FACT_LABELS)) {
      for (const claim of UNSUPPORTED) {
        expect(
          label.toLowerCase().includes(claim),
          `“${label}” contains the unsupported claim “${claim}”`,
        ).toBe(false);
      }
    }
  });

  /** A fact with no label would render as an empty chip. */
  it("gives every fact kind a non-empty label", () => {
    for (const [kind, label] of Object.entries(ALTERNATIVE_FACT_LABELS)) {
      expect(label.trim().length, `${kind} has no label`).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The facts                                                                  */
/* -------------------------------------------------------------------------- */

describe("relation facts", () => {
  it("states the category and the indoor kind once per option, flagged as shared", () => {
    const [alternative] = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE]),
    );

    const shared = alternative.relationFacts
      .filter((fact) => fact.universal)
      .map((fact) => fact.kind)
      .sort();

    expect(shared).toEqual(["indoor-option", "same-category"]);
  });

  it("says an option fits the current window when the published hours say so", () => {
    const open = alternativesFor(
      "cafe-one",
      generationWith([FAR_OPEN_CAFE]),
    ).find((entry) => entry.placeId === FAR_OPEN_CAFE.placeId);

    expect(open).toBeDefined();
    expect(kinds(open as StopAlternative)).toContain("fits-current-time-window");
    expect(open?.schedulePreview.openingHoursStatus.status).toBe(
      "confirmed_open",
    );
  });

  /**
   * A closed option is listed, cautioned, and still selectable.
   *
   * `alternativesForItem` orders a closure last rather than hiding it — the traveller may intend to
   * move the stop afterwards — so the card carries the caution instead.
   */
  it("cautions an option the published hours say is shut, without refusing it", () => {
    const closed = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CLOSED_CAFE]),
    ).find((entry) => entry.placeId === NEAR_CLOSED_CAFE.placeId);

    expect(closed).toBeDefined();
    expect(kinds(closed as StopAlternative)).toContain(
      "closed-in-current-time-window",
    );
    expect(closed?.schedulePreview.status).toBe("warning");
    expect(
      closed?.relationFacts.find(
        (fact) => fact.kind === "closed-in-current-time-window",
      )?.tone,
    ).toBe("caution");
  });

  /** No published hours is an unknown, and an unknown is never a caution. */
  it("reports missing hours as unknown rather than as a problem", () => {
    const [unknown] = alternativesFor("cafe-one", generationWith([NEAR_CAFE]));

    expect(kinds(unknown)).toContain("opening-hours-unknown");
    expect(
      unknown.relationFacts.find(
        (fact) => fact.kind === "opening-hours-unknown",
      )?.tone,
    ).toBe("neutral");
    expect(unknown.schedulePreview.status).toBe("valid");
  });

  /**
   * The distance fact is measured against the stop *before* this one, and names its basis.
   *
   * "1.1 km closer" without that qualifier would be read as a walking distance, and nothing here
   * has been routed.
   */
  it("compares distance to the previous stop, and names the basis", () => {
    const alternatives = alternativesFor(
      "dinner-one",
      generationWith([CLOSER_RESTAURANT, FURTHER_RESTAURANT]),
    );

    const closer = alternatives.find(
      (entry) => entry.placeId === CLOSER_RESTAURANT.placeId,
    );
    const further = alternatives.find(
      (entry) => entry.placeId === FURTHER_RESTAURANT.placeId,
    );

    expect(kinds(closer as StopAlternative)).toContain(
      "closer-to-previous-stop",
    );
    expect(kinds(further as StopAlternative)).toContain(
      "further-from-previous-stop",
    );

    for (const entry of [closer, further]) {
      const fact = entry?.relationFacts.find((candidate) =>
        candidate.kind.endsWith("-previous-stop"),
      );
      expect(fact?.detail).toContain("straight line");
    }
  });

  /** The first stop of a day has nothing before it, so there is no comparison to make. */
  it("makes no distance claim for the first stop of a day", () => {
    for (const entry of alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE]),
    )) {
      expect(kinds(entry)).not.toContain("closer-to-previous-stop");
      expect(kinds(entry)).not.toContain("further-from-previous-stop");
    }
  });

  it("reports a provider's outdoor-seating tag verbatim, and only when tagged", () => {
    const tagged = fixtureOsmPlace("9301", "Esplanada", "cafe", 38.714, -9.145, {
      outdoorSeating: true,
    });

    const alternatives = alternativesFor(
      "cafe-one",
      generationWith([tagged, NEAR_CAFE]),
    );

    expect(
      kinds(
        alternatives.find(
          (entry) => entry.placeId === tagged.placeId,
        ) as StopAlternative,
      ),
    ).toContain("has-outdoor-seating");

    expect(
      kinds(
        alternatives.find(
          (entry) => entry.placeId === NEAR_CAFE.placeId,
        ) as StopAlternative,
      ),
    ).not.toContain("has-outdoor-seating");
  });
});

/* -------------------------------------------------------------------------- */
/* The planning estimate                                                      */
/* -------------------------------------------------------------------------- */

describe("the planning-estimate fact", () => {
  /**
   * All three arms, tested directly.
   *
   * A same-category swap keeps the cost class, so `clampPartyCost` returns the same figure and only
   * `same-planning-estimate` can currently be produced through a fixture. The comparison is still a
   * comparison, and these assert it reports what it measures rather than what the current rule
   * happens to make inevitable.
   */
  it("reports lower, same and higher from the measurement", () => {
    expect(estimateFact(20, 12, "EUR").kind).toBe("lower-planning-estimate");
    expect(estimateFact(20, 20, "EUR").kind).toBe("same-planning-estimate");
    expect(estimateFact(20, 31.5, "EUR").kind).toBe("higher-planning-estimate");
  });

  it("names what the difference is measured against", () => {
    expect(estimateFact(20, 12, "EUR").detail).toBe(
      "EUR 8.00 against this stop's current estimate",
    );
  });

  it("adds no detail when there is no difference to state", () => {
    expect(estimateFact(20, 20, "EUR").detail).toBeUndefined();
  });

  /**
   * The honest consequence of the current cost model, pinned down.
   *
   * Bands are per cost class, a class comes from the category and the meal type, and an alternative
   * shares both — so no same-category swap changes the figure. This test exists so that if the
   * estimate model ever gains a per-place input, somebody has to come here and decide deliberately
   * whether the cards should start claiming a saving.
   */
  it("finds no same-category swap that changes the figure", () => {
    const alternatives = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE, FAR_OPEN_CAFE]),
    );

    expect(alternatives.length).toBeGreaterThan(0);

    for (const entry of alternatives) {
      expect(kinds(entry)).toContain("same-planning-estimate");
    }
  });

  it("carries the currency and the amount the save would store", () => {
    const [alternative] = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE]),
    );

    expect(alternative.estimatedCost.currency).toBe("EUR");
    expect(alternative.estimatedCost.amount).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Dietary needs                                                              */
/* -------------------------------------------------------------------------- */

describe("matchedDietaryNeeds", () => {
  const vegan = fixtureOsmPlace("9401", "Verde", "restaurant", 38.71, -9.14, {
    cuisine: ["vegan"],
  });

  it("matches a need the place's own cuisine tag names", () => {
    expect(matchedDietaryNeeds(["vegan"], vegan)).toEqual(["Vegan"]);
  });

  /** A vegan kitchen satisfies a vegetarian need. The reverse does not hold. */
  it("treats vegan as evidence for vegetarian, and not the other way round", () => {
    const vegetarian = fixtureOsmPlace(
      "9402",
      "Horta",
      "restaurant",
      38.71,
      -9.14,
      { cuisine: ["vegetarian"] },
    );

    expect(matchedDietaryNeeds(["vegetarian"], vegan)).toEqual(["Vegetarian"]);
    expect(matchedDietaryNeeds(["vegan"], vegetarian)).toEqual([]);
  });

  /**
   * The needs no field in `TripPlace` speaks to, which must therefore never be claimed.
   *
   * The normalizer captures `cuisine` and no `diet:*` tag, so nothing could evidence gluten-free,
   * no-pork or no-shellfish. Claiming one would be the most consequential fabrication this feature
   * could make.
   */
  it("never claims a need no field can evidence", () => {
    for (const need of ["gluten-free", "no-pork", "no-shellfish"] as const) {
      expect(matchedDietaryNeeds([need], vegan)).toEqual([]);
    }
  });

  /** Absence of a tag is a gap in OpenStreetMap, never a verdict about the kitchen. */
  it("stays silent about a place with no cuisine tag", () => {
    expect(
      matchedDietaryNeeds(
        ["vegan"],
        fixtureOsmPlace("9403", "Tasca", "restaurant", 38.71, -9.14),
      ),
    ).toEqual([]);
  });

  it("treats `none` as no need at all", () => {
    expect(matchedDietaryNeeds(["none"], vegan)).toEqual([]);
  });

  /** A cuisine tag on a museum does not describe a menu. */
  it("only reads a cuisine tag where it describes a menu", () => {
    const museum = fixtureOsmPlace("9404", "Museu", "museum", 38.71, -9.14, {
      cuisine: ["vegan"],
    });
    expect(matchedDietaryNeeds(["vegan"], museum)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The order                                                                  */
/* -------------------------------------------------------------------------- */

describe("ordering", () => {
  /**
   * The hours group comes first, and it beats distance.
   *
   * The far café is open and the near one is shut, so an order driven by distance alone would put
   * them the other way round. Open first is the only group we can say anything definite about.
   */
  it("puts an open option above a closed one however far away it is", () => {
    const positions = alternativesFor(
      "cafe-one",
      generationWith([FAR_OPEN_CAFE, NEAR_CLOSED_CAFE]),
    ).map((entry) => entry.placeId);

    expect(positions.indexOf(FAR_OPEN_CAFE.placeId)).toBeLessThan(
      positions.indexOf(NEAR_CLOSED_CAFE.placeId),
    );
  });

  /** Within a group, nearest to the place being replaced comes first. */
  it("orders equally-known options by distance from the place being replaced", () => {
    const far = fixtureOsmPlace("9501", "Distant Café", "cafe", 38.66, -9.25);

    expect(
      alternativesFor("cafe-one", generationWith([far, NEAR_CAFE])).map(
        (entry) => entry.placeId,
      ),
    ).toEqual([NEAR_CAFE.placeId, far.placeId]);
  });

  /**
   * The order does not depend on how the pool happened to be built.
   *
   * A list that reordered itself when a place was added elsewhere in the pool would make the same
   * trip look different on two machines, and "deterministic" would be untestable folklore.
   */
  it("is stable under a reordered pool", () => {
    const extras = [FAR_OPEN_CAFE, NEAR_CLOSED_CAFE, NEAR_CAFE];

    const forward = alternativesFor("cafe-one", generationWith(extras)).map(
      (entry) => entry.placeId,
    );
    const reversed = alternativesFor(
      "cafe-one",
      generationWith([...extras].reverse()),
    ).map((entry) => entry.placeId);

    expect(forward).toEqual(reversed);
    expect(forward).toHaveLength(3);
  });

  /** Five, matching `alternativesForItem`. A comparison list longer than that is a browse. */
  it("offers at most five", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      fixtureOsmPlace(
        `96${index}`,
        `Café ${index}`,
        "cafe",
        38.71 + index / 1_000,
        -9.14,
      ),
    );

    expect(alternativesFor("cafe-one", generationWith(many))).toHaveLength(5);
  });
});

/* -------------------------------------------------------------------------- */
/* The contract with the applier                                              */
/* -------------------------------------------------------------------------- */

describe("the schedule preview", () => {
  /**
   * The property that makes a comparison card trustworthy.
   *
   * Every option is derived by running the real edit, so an option previewing as `invalid` is one
   * the picker offers and the save refuses. This is the test that fails if the derivation and
   * `alternativeIsSelectable` drift apart.
   */
  it("offers nothing the applier would refuse", () => {
    const alternatives = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE, FAR_OPEN_CAFE, NEAR_CLOSED_CAFE]),
    );

    expect(alternatives.length).toBeGreaterThan(0);

    for (const entry of alternatives) {
      expect(
        entry.schedulePreview.status,
        `${entry.placeId} previewed as refused`,
      ).not.toBe("invalid");
      expect(entry.schedulePreview.refusalCode).toBeUndefined();
    }
  });

  /** A swap keeps the slot. The times are read from the prepared plan, not assumed. */
  it("reports the window the stop would actually occupy", () => {
    const [alternative] = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE]),
    );

    expect(alternative.schedulePreview.resultingStartTime).toBe("09:00");
    expect(alternative.schedulePreview.resultingEndTime).toBe("10:00");
  });

  /**
   * The legs around a swapped stop stop describing a real adjacency.
   *
   * Measured by the commit from before-and-after rather than claimed by the applier, so this is the
   * set the save would clear. Reported as a count on the card, never as a warning — where routes
   * exist every option has one, so it cannot distinguish two of them.
   *
   * Run against `fixtureRoutedPlan`, because the count is about *stored measurements* and an
   * unrouted trip has none to lose. Leg identity is built from item ids and a swap keeps the item
   * id, so there is no new leg either — what changes is that a segment measured to a different
   * place no longer describes this journey.
   */
  it("names the routes the swap would affect once the trip has been routed", () => {
    const [alternative] = stopAlternatives({
      plan: fixtureRoutedPlan(),
      generation: generationWith([NEAR_CAFE]),
      dayNumber: 1,
      itemId: "cafe-one",
      timezone: TIMEZONE,
      revisionBefore: 3,
    });

    expect(
      alternative.schedulePreview.affectedRouteLegIds.length,
    ).toBeGreaterThan(0);
  });

  /**
   * An unrouted trip reports zero rather than a leg it has not measured.
   *
   * The honest answer, and the reason the card renders this line only when there is a number to
   * put in it: "0 travel times would need recalculating" is noise on a trip that has never had one.
   */
  it("reports no affected routes on a trip whose routes were never calculated", () => {
    const [alternative] = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE]),
    );

    expect(alternative.schedulePreview.affectedRouteLegIds).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Boundaries                                                                 */
/* -------------------------------------------------------------------------- */

describe("boundaries", () => {
  it("offers nothing for a trip with no generation context", () => {
    expect(
      stopAlternatives({
        plan: fixtureSavedPlan(),
        generation: null,
        dayNumber: 1,
        itemId: "cafe-one",
        revisionBefore: 3,
      }),
    ).toEqual([]);
  });

  it("offers nothing for a stop that is not on the day", () => {
    expect(alternativesFor("no-such-item", generationWith([NEAR_CAFE]))).toEqual(
      [],
    );
  });

  /**
   * Deriving a comparison must not change the trip.
   *
   * `prepareStructuralCommand` is pure and writes nothing, and this is the assertion that keeps it
   * so now that something calls it five times to render a list.
   */
  it("leaves the plan it was given untouched", () => {
    const plan = fixtureSavedPlan();
    const snapshot = JSON.stringify(plan);

    stopAlternatives({
      plan,
      generation: generationWith([NEAR_CAFE, FAR_OPEN_CAFE]),
      dayNumber: 1,
      itemId: "cafe-one",
      timezone: TIMEZONE,
      revisionBefore: 3,
    });

    expect(JSON.stringify(plan)).toBe(snapshot);
  });

  /** The pool's record is attached unchanged — a card recognises a place, it does not edit one. */
  it("carries the pool's own record", () => {
    const [alternative] = alternativesFor(
      "cafe-one",
      generationWith([NEAR_CAFE]),
    );

    expect(alternative.canonicalPlace).toEqual(NEAR_CAFE);
    expect(alternative.placeId).toBe(NEAR_CAFE.placeId);
  });
});
