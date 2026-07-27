import { describe, expect, it } from "vitest";

import { PoolValidationError, TripPlanSchema } from "@/lib/schemas";

import {
  PlanAssemblyError,
  assembleTripPlan,
  countryFrom,
  kindForCategory,
  pickStay,
  type AssemblePlanInput,
} from "./assemble-plan";
import {
  FIXTURE_DESTINATION,
  FIXTURE_PLACES,
  FIXTURE_REQUEST,
  cost,
  fixtureAssembly,
  fixtureOsmPlace,
  fixturePool,
  fixtureStrategy,
  placeItemAt,
} from "./test-fixtures";

function input(overrides: Partial<AssemblePlanInput> = {}): AssemblePlanInput {
  return {
    tripId: "trip-abc123",
    request: FIXTURE_REQUEST,
    destination: FIXTURE_DESTINATION,
    strategy: fixtureStrategy(),
    assembly: fixtureAssembly(),
    pool: fixturePool(),
    source: "generated",
    createdAt: "2026-07-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("assembleTripPlan — canonical attachment", () => {
  it("attaches the pool's record, not the model's idea of it", () => {
    const { plan } = assembleTripPlan(input());

    const item = plan.days[0].items.find(
      (entry) => entry.place?.placeId === FIXTURE_PLACES.cafeOne.placeId,
    );
    expect(item?.place).toEqual(FIXTURE_PLACES.cafeOne);
  });

  it("preserves coordinates exactly", () => {
    const { plan } = assembleTripPlan(input());

    for (const day of plan.days) {
      for (const entry of day.items) {
        if (!entry.place) continue;
        const canonical = fixturePool().places.find(
          (place) => place.placeId === entry.place!.placeId,
        );
        expect(entry.place.coordinates).toEqual(canonical!.coordinates);
      }
    }
  });

  /**
   * The model authors `title` and `description`, which are editorial and meant to be
   * its own. It authors nothing that a provider supplied — and there is no code path
   * that would let it.
   */
  it("keeps the canonical name even when the model titles the stop differently", () => {
    const assembly = fixtureAssembly();
    placeItemAt(assembly, 0, 0).title = "A café I have decided to rename";

    const { plan } = assembleTripPlan(input({ assembly }));

    const item = plan.days[0].items[0];
    expect(item.title).toBe("A café I have decided to rename");
    expect(item.place?.name).toBe(FIXTURE_PLACES.cafeOne.name);
  });

  it("preserves source identity and optional provider facts", () => {
    const { plan } = assembleTripPlan(input());

    const item = plan.days[0].items.find(
      (entry) => entry.place?.placeId === FIXTURE_PLACES.cafeOne.placeId,
    );
    expect(item?.place?.source).toEqual(FIXTURE_PLACES.cafeOne.source);
    expect(item?.place?.openingHours).toBe(FIXTURE_PLACES.cafeOne.openingHours);
    expect(item?.place?.address).toBe(FIXTURE_PLACES.cafeOne.address);
  });

  it("moves the model's description into `rationale`", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.days[0].items[0].rationale).toContain("short walk");
  });

  it("rejects a placeId that is not in the pool", () => {
    const assembly = fixtureAssembly();
    const item = assembly.days[0].items[0];
    if (item.kind !== "place") throw new Error("fixture changed shape");
    item.placeId = "osm:node:999999";

    // A miss here means the orchestrator paired a pool with the wrong assembly —
    // a bug, and one that would otherwise show up as a silently shorter itinerary.
    expect(() => assembleTripPlan(input({ assembly }))).toThrow(PlanAssemblyError);
  });

  it("rejects a backup that is not in the pool", () => {
    const assembly = fixtureAssembly();
    assembly.days[0].backups[0].placeId = "osm:node:999999";

    expect(() => assembleTripPlan(input({ assembly }))).toThrow(PlanAssemblyError);
  });

  it("runs the pool gate on its own output", () => {
    // A pool missing a place the assembly uses must fail, even though the assembly
    // itself is internally consistent.
    const thinPool = fixturePool([FIXTURE_PLACES.cafeOne]);

    expect(() => assembleTripPlan(input({ pool: thinPool }))).toThrow();
  });

  it("mutates neither the pool nor the assembly", () => {
    const pool = fixturePool();
    const assembly = fixtureAssembly();
    const poolSnapshot = JSON.stringify(pool);
    const assemblySnapshot = JSON.stringify(assembly);

    assembleTripPlan(input({ pool, assembly }));

    expect(JSON.stringify(pool)).toBe(poolSnapshot);
    expect(JSON.stringify(assembly)).toBe(assemblySnapshot);
  });

  it("includes backup places in the pool check", () => {
    // `derivePlanPlacePool` does not collect backups, so a fabricated backup would
    // slip through a plan-derived check. Backups are shown with real names, so they
    // are verified like any other place.
    const { plan } = assembleTripPlan(input());

    expect(plan.days[0].backups[0].place).toEqual(FIXTURE_PLACES.museumTwo);
    expect(plan.days[0].backups[0].title).toBe(FIXTURE_PLACES.museumTwo.name);
  });
});

describe("assembleTripPlan — structure", () => {
  it("produces a schema-valid plan", () => {
    const { plan } = assembleTripPlan(input());

    expect(TripPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("dates the days from the request, never from the model", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.days.map((day) => day.date)).toEqual(["2026-09-12", "2026-09-13"]);
  });

  it("keeps every day inside the requested range even if the model reorders", () => {
    const assembly = fixtureAssembly();
    assembly.days = [assembly.days[1], assembly.days[0]];

    const { plan } = assembleTripPlan(input({ assembly }));

    expect(plan.days.map((day) => day.dayNumber)).toEqual([1, 2]);
    expect(plan.days.map((day) => day.date)).toEqual(["2026-09-12", "2026-09-13"]);
  });

  it("orders items chronologically and numbers them from zero", () => {
    const assembly = fixtureAssembly();
    // Hand the builder a day listed out of sequence.
    assembly.days[0].items = [
      assembly.days[0].items[2],
      assembly.days[0].items[0],
      assembly.days[0].items[1],
    ];

    const { plan } = assembleTripPlan(input({ assembly }));

    expect(plan.days[0].items.map((entry) => entry.startTime)).toEqual([
      "09:00",
      "10:30",
      "19:30",
    ]);
    expect(plan.days[0].items.map((entry) => entry.order)).toEqual([0, 1, 2]);
  });

  it("marks an unfilled slot unavailable, with no place and no cost", () => {
    const assembly = fixtureAssembly();
    assembly.days[0].items[2] = {
      kind: "unavailable",
      itemId: "dinner-gap",
      slotId: "d1-s3",
      reason: "No restaurant was found within a workable distance of the other stops.",
      startTime: "19:30",
      endTime: "21:00",
    };

    const { plan } = assembleTripPlan(input({ assembly }));

    const gap = plan.days[0].items.find((entry) => entry.status === "unavailable");
    expect(gap?.place).toBeNull();
    expect(gap?.estimatedCost).toBe(0);
    expect(gap?.title).toContain("none found");
    expect(gap?.rationale).toContain("No restaurant");
  });

  it("synthesises times for an unscheduled gap rather than dropping it", () => {
    const assembly = fixtureAssembly();
    assembly.days[0].items[2] = {
      kind: "unavailable",
      itemId: "dinner-gap",
      slotId: "d1-s3",
      reason: "No restaurant was found within a workable distance.",
    };

    const { plan } = assembleTripPlan(input({ assembly }));

    const gap = plan.days[0].items.find((entry) => entry.status === "unavailable");
    // The schema requires both times; an hour after the previous stop is truthful.
    expect(gap?.startTime).toBe("12:30");
    expect(gap?.endTime).toBe("13:30");
  });

  it("gives non-place blocks no place and the right kind", () => {
    const { plan } = assembleTripPlan(input());

    const free = plan.days[1].items.find((entry) => entry.kind === "rest");
    expect(free?.place).toBeNull();
    expect(free?.estimatedCost).toBe(0);
  });

  it("leaves routing null — generation does not route", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.routing).toBeNull();
    for (const day of plan.days) {
      for (const entry of day.items) expect(entry.travelToNext).toBeNull();
      expect(day.totalTravelMinutes).toBe(0);
    }
  });

  it("records the source discriminant it was given", () => {
    expect(assembleTripPlan(input({ source: "generated" })).plan.source).toBe(
      "generated",
    );
    expect(assembleTripPlan(input({ source: "mock" })).plan.source).toBe("mock");
  });

  it("takes the destination centre from the geocoder", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.destination.center).toEqual({
      lat: FIXTURE_DESTINATION.latitude,
      lng: FIXTURE_DESTINATION.longitude,
    });
    expect(plan.destination.city).toBe("Lisbon");
    expect(plan.destination.country).toBe("Portugal");
  });

  it("flattens practical notes into the plan's own shape", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.practicalNotes[0]).toBe(
      "Transport — Buy a rechargeable card at any metro station; single paper tickets cost roughly double per journey.",
    );
  });
});

describe("assembleTripPlan — money", () => {
  it("clamps an absurd proposal into its band and warns", () => {
    const assembly = fixtureAssembly();
    placeItemAt(assembly, 0, 0).estimatedCost = cost(9_000);

    const { plan, warnings } = assembleTripPlan(input({ assembly }));

    // Two travellers × a café's ceiling — not 9,000.
    expect(plan.days[0].items[0].estimatedCost).toBeLessThan(100);
    expect(warnings.map((warning) => warning.code)).toContain("cost_clamped");
  });

  it("does not warn about a figure already inside its band", () => {
    const { warnings } = assembleTripPlan(input());

    expect(warnings.map((warning) => warning.code)).not.toContain("cost_clamped");
  });

  it("attaches a basis, a confidence and a disclaimer to every generated cost", () => {
    const { plan } = assembleTripPlan(input());

    for (const day of plan.days) {
      for (const entry of day.items) {
        if (entry.status === "unavailable") continue;
        expect(entry.costEstimate?.basis).toBe("category-estimate");
        expect(entry.costEstimate?.currency).toBe("EUR");
        expect(entry.costEstimate?.disclaimer).toBeTruthy();
        expect(entry.costEstimate?.amount).toBe(entry.estimatedCost);
      }
    }
  });

  it("recomputes every total from the items rather than trusting the model", () => {
    const { plan } = assembleTripPlan(input());

    for (const day of plan.days) {
      const summed =
        Math.round(
          day.items.reduce((total, entry) => total + entry.estimatedCost, 0) * 100,
        ) / 100;
      expect(day.dayTotal).toBe(summed);
    }

    const categories =
      plan.budget.flights +
      plan.budget.accommodation +
      plan.budget.food +
      plan.budget.activities +
      plan.budget.transport;
    expect(plan.budget.total).toBeCloseTo(Math.round(categories * 100) / 100, 2);
    expect(plan.budget.remaining).toBeCloseTo(
      FIXTURE_REQUEST.budget - plan.budget.total,
      2,
    );
    expect(plan.budget.byDay).toEqual(
      plan.days.map((day) => ({ dayNumber: day.dayNumber, amount: day.dayTotal })),
    );
  });

  it("splits food from activities by item kind", () => {
    const { plan } = assembleTripPlan(input());

    const meals = plan.days
      .flatMap((day) => day.items)
      .filter((entry) => entry.kind === "meal")
      .reduce((total, entry) => total + entry.estimatedCost, 0);

    expect(plan.budget.food).toBeCloseTo(Math.round(meals * 100) / 100, 2);
  });

  it("prices in the requested currency with no conversion", () => {
    const gbp = assembleTripPlan(
      input({ request: { ...FIXTURE_REQUEST, currency: "GBP" } }),
    );

    expect(gbp.plan.budget.currency).toBe("GBP");
    for (const day of gbp.plan.days) {
      for (const entry of day.items) {
        if (entry.costEstimate) expect(entry.costEstimate.currency).toBe("GBP");
      }
    }
  });

  it("labels flights an estimate and refuses to invent a duration", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.flights.isEstimate).toBe(true);
    // A duration and a stop count are route facts, and we have no flight data.
    expect(plan.flights.typicalDuration).toMatch(/not known/i);
    expect(plan.flights.typicalStops).toMatch(/not known/i);
    expect(plan.flights.basis).toMatch(/not a live quote/i);
  });

  it("keeps a non-place accommodation block at zero, so nothing double-counts", () => {
    const assembly = fixtureAssembly();
    assembly.days[0].items.push({
      kind: "non-place",
      itemId: "check-in",
      category: "accommodation",
      startTime: "15:00",
      endTime: "16:00",
      title: "Check in",
      description: "Drop bags and take twenty minutes before heading back out.",
      estimatedCost: cost(180),
    });

    const { plan } = assembleTripPlan(input({ assembly }));

    const checkIn = plan.days[0].items.find((entry) => entry.id === "check-in");
    expect(checkIn?.estimatedCost).toBe(0);
  });

  it("caps a transport block at a tenth of the budget", () => {
    const assembly = fixtureAssembly();
    assembly.days[0].items.push({
      kind: "non-place",
      itemId: "airport-run",
      category: "airport",
      startTime: "16:00",
      endTime: "17:00",
      title: "To the airport",
      description: "Allow an hour with bags, more if it is a weekday rush hour.",
      estimatedCost: cost(5_000),
    });

    const { plan } = assembleTripPlan(input({ assembly }));

    const run = plan.days[0].items.find((entry) => entry.id === "airport-run");
    expect(run?.estimatedCost).toBe(FIXTURE_REQUEST.budget * 0.1);
  });
});

describe("assembleTripPlan — accommodation", () => {
  it("recommends a stay from the pool, marked an estimate", () => {
    const { plan } = assembleTripPlan(input());

    expect(plan.accommodation?.place).toEqual(FIXTURE_PLACES.hotel);
    expect(plan.accommodation?.isEstimate).toBe(true);
    expect(plan.accommodation?.nights).toBe(1);
    expect(plan.accommodation?.whyItFits).toMatch(/no ratings or rates/i);
  });

  /**
   * The alternative — a plausible hotel nobody searched for — would be the easiest
   * fabrication in the app to slip past a reviewer.
   */
  it("returns null and warns when no stay was discovered", () => {
    const withoutStay = fixturePool(
      Object.values(FIXTURE_PLACES).filter(
        (place) => place.placeId !== FIXTURE_PLACES.hotel.placeId,
      ),
    );

    const { plan, warnings } = assembleTripPlan(input({ pool: withoutStay }));

    expect(plan.accommodation).toBeNull();
    expect(plan.budget.accommodation).toBe(0);
    expect(warnings.map((warning) => warning.code)).toContain(
      "accommodation_unavailable",
    );
  });

  it("lists only amenities OpenStreetMap actually recorded", () => {
    const hotel = fixtureOsmPlace("4002", "Somewhere", "hotel", 38.71, -9.13, {
      website: "https://example.test",
      wheelchair: "designated",
    });

    const { plan } = assembleTripPlan(
      input({ pool: fixturePool([...Object.values(FIXTURE_PLACES), hotel]) }),
    );

    const amenities = plan.accommodation?.amenities ?? [];
    // No invented breakfast, pool or wifi.
    expect(amenities.join(" ")).not.toMatch(/breakfast|pool|wifi/i);
  });
});

describe("pickStay", () => {
  it("prefers the category matching the requested style", () => {
    const pool = fixturePool([
      ...Object.values(FIXTURE_PLACES),
      fixtureOsmPlace("4100", "A hostel", "hostel", 38.71, -9.13),
    ]);

    expect(pickStay(pool, "hostel")?.category).toBe("hostel");
    expect(pickStay(pool, "boutique")?.category).toBe("hotel");
  });

  it("falls back through the preference order", () => {
    const pool = fixturePool([
      fixtureOsmPlace("4200", "A guest house", "guest_house", 38.71, -9.13),
    ]);

    expect(pickStay(pool, "boutique")?.category).toBe("guest_house");
  });

  it("returns null rather than anything else when there is nothing", () => {
    expect(pickStay(fixturePool([FIXTURE_PLACES.cafeOne]), "hotel")).toBeNull();
  });
});

describe("kindForCategory", () => {
  it("lets a meal slot win over the place's category", () => {
    expect(kindForCategory("market", "lunch")).toBe("meal");
    expect(kindForCategory("market", null)).toBe("experience");
  });

  it("maps every allowlisted category to something", () => {
    for (const category of [
      "restaurant",
      "cafe",
      "bar",
      "fast_food",
      "hotel",
      "hostel",
      "guest_house",
      "museum",
      "gallery",
      "attraction",
      "monument",
      "viewpoint",
      "park",
      "garden",
      "beach",
      "market",
      "place_of_worship",
      "theatre",
      "music_venue",
      "shopping",
      "winery",
      "historic_site",
    ] as const) {
      expect(kindForCategory(category, null), category).toBeTruthy();
    }
  });
});

describe("countryFrom", () => {
  it("takes the geocoder's own last segment", () => {
    expect(countryFrom(FIXTURE_DESTINATION)).toBe("Portugal");
  });

  it("falls back to the ISO code", () => {
    expect(
      countryFrom({ ...FIXTURE_DESTINATION, displayName: "Lisbon", countryCode: "pt" }),
    ).toBe("PT");
  });

  it("admits it does not know rather than guessing from coordinates", () => {
    const { countryCode: _dropped, ...withoutCode } = FIXTURE_DESTINATION;

    expect(countryFrom({ ...withoutCode, displayName: "Somewhere" })).toBe("Unknown");
  });
});

describe("assembleTripPlan — pool violations surface as themselves", () => {
  it("throws a PoolValidationError when a pool record is malformed", () => {
    // A mock-sourced place claiming OSM identity: the pool builder catches it, and
    // the error type is preserved so the orchestrator can report it as our bug.
    expect(() =>
      fixturePool([
        {
          ...FIXTURE_PLACES.cafeOne,
          source: { ...FIXTURE_PLACES.cafeOne.source, provider: "mock" },
        },
      ]),
    ).toThrow(PoolValidationError);
  });
});
