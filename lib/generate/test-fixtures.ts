import type {
  GeneratedTripAssembly,
  StructuredGenerationResult,
  StructuredGenerator,
  TripStrategy,
} from "@/lib/ai";
import {
  buildVerifiedPlacePool,
  type GeocodedDestinationRecord,
  type PlaceCategory,
  type TripPlace,
  type TripRequest,
  type VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * Fixtures for the generation tests.
 *
 * ## Deliberately small, and deliberately valid
 *
 * Two days, six places, one of each thing that matters. The Lisbon mock is five
 * full days, which is the wrong instrument for asserting "a category mismatch is
 * rejected" — a failure in a forty-stop fixture points at the fixture.
 *
 * The baseline strategy and assembly are **valid**, and every negative test
 * derives from them by breaking exactly one thing. That is the property that makes
 * the suite trustworthy: when `assembly with an unknown placeId` fails validation,
 * the unknown placeId is provably the only difference from a case that passes.
 *
 * Coordinates are real Lisbon points a few hundred metres apart, so leg derivation
 * resolves them to walking legs without special casing.
 */

export const FIXTURE_DESTINATION: GeocodedDestinationRecord = {
  canonicalId: "osm:relation:5400890",
  name: "Lisbon",
  displayName: "Lisbon, Portugal",
  latitude: 38.7223,
  longitude: -9.1393,
  countryCode: "pt",
  source: {
    provider: "openstreetmap",
    osmType: "relation",
    osmId: "5400890",
    fetchedAt: "2026-07-27T09:00:00.000Z",
  },
};

export const FIXTURE_REQUEST: TripRequest = {
  departureCity: "Dubai",
  destination: "Lisbon",
  startDate: "2026-09-12",
  endDate: "2026-09-13",
  budget: 2_000,
  currency: "EUR",
  travelers: 2,
  vibes: ["culture", "food"],
  pace: "balanced",
  accommodation: "boutique",
  dietary: ["no-pork"],
  interests: ["museums", "coffee"],
  notes: "First time in Portugal.",
};

/** One OSM-sourced place, with a genuine canonical identity. */
export function fixtureOsmPlace(
  id: string,
  name: string,
  category: PlaceCategory,
  lat: number,
  lng: number,
  extra: Partial<TripPlace> = {},
): TripPlace {
  const placeId = `osm:node:${id}`;
  return {
    placeId,
    name,
    category,
    coordinates: { lat, lng },
    source: {
      provider: "openstreetmap",
      canonicalId: placeId,
      osmType: "node",
      osmId: id,
      fetchedAt: "2026-07-27T09:00:00.000Z",
      attribution: "© OpenStreetMap contributors (ODbL)",
    },
    ...extra,
  };
}

export const FIXTURE_PLACES = {
  /**
   * The only fixture place with published hours, and they span the whole week on purpose.
   *
   * The fixture trip runs 2026-09-12 to 09-13 — a Saturday and a Sunday — so weekday-only
   * hours would make every happy-path generation carry a schedule conflict, and the tests
   * asserting a clean pipeline would be asserting something else. Conflicts are exercised
   * deliberately instead, by overriding these hours in the tests that want one.
   */
  cafeOne: fixtureOsmPlace("1001", "Fábrica Coffee", "cafe", 38.7169, -9.1409, {
    address: "R. das Portas de Santo Antão 136",
    openingHours: "Mo-Su 08:00-19:00",
  }),
  cafeTwo: fixtureOsmPlace("1002", "Manteigaria", "cafe", 38.7099, -9.1435),
  museumOne: fixtureOsmPlace("2001", "Museu do Azulejo", "museum", 38.7248, -9.115, {
    address: "R. Me. Deus 4",
  }),
  museumTwo: fixtureOsmPlace("2002", "MAAT", "museum", 38.6957, -9.1936),
  restaurantOne: fixtureOsmPlace(
    "3001",
    "Ti-Natércia",
    "restaurant",
    38.7128,
    -9.1279,
    { cuisine: ["portuguese"] },
  ),
  restaurantTwo: fixtureOsmPlace(
    "3002",
    "Zé dos Cornos",
    "restaurant",
    38.7126,
    -9.1354,
  ),
  hotel: fixtureOsmPlace("4001", "Santiago de Alfama", "hotel", 38.7113, -9.1305),
} as const;

export function fixturePool(
  places: TripPlace[] = Object.values(FIXTURE_PLACES),
): VerifiedPlacePool {
  const categories = [
    ...new Set(places.map((place) => place.category)),
  ] as PlaceCategory[];

  return buildVerifiedPlacePool(places, {
    poolId: "discovery:osm:relation:5400890:4000:cafe+hotel+museum+restaurant",
    createdAt: "2026-07-27T09:00:00.000Z",
    categories,
    attribution: "© OpenStreetMap contributors (ODbL)",
    destination: {
      canonicalId: FIXTURE_DESTINATION.canonicalId,
      name: FIXTURE_DESTINATION.name,
      latitude: FIXTURE_DESTINATION.latitude,
      longitude: FIXTURE_DESTINATION.longitude,
    },
  });
}

/**
 * A valid two-day strategy: three slots a day, positional ids, shares summing to 1.
 */
export function fixtureStrategy(
  overrides: Partial<TripStrategy> = {},
): TripStrategy {
  return {
    destinationSummary:
      "A compact riverside capital where almost everything worth seeing sits in a two-kilometre band, which makes two days generous rather than tight.",
    recommendedBaseArea: "Alfama",
    languageNote:
      "Portuguese, with confident English throughout hospitality. A greeting in Portuguese goes a long way.",
    currencyNote:
      "Euro. Cards are near-universal, though older tascas still prefer cash.",
    seasonalNote:
      "Mid-September averages 26 °C by day, with an Atlantic breeze picking up after dark.",
    recommendedRadiusMeters: 4_000,
    budgetAllocation: {
      flights: 0.3,
      accommodation: 0.27,
      food: 0.23,
      activities: 0.12,
      localTransport: 0.05,
      buffer: 0.03,
    },
    days: [
      {
        dayNumber: 1,
        theme: "Alfama, slowly",
        pace: "balanced",
        searchRequirements: [
          slot("d1-s1", "cafe", "breakfast", true),
          slot("d1-s2", "museum", null, true),
          slot("d1-s3", "restaurant", "dinner", true),
        ],
      },
      {
        dayNumber: 2,
        theme: "The river",
        pace: "balanced",
        searchRequirements: [
          slot("d2-s1", "cafe", "breakfast", true),
          slot("d2-s2", "museum", null, false),
          slot("d2-s3", "restaurant", "dinner", true),
        ],
      },
    ],
    practicalConsiderations: [
      "Buy a rechargeable transport card at any metro station rather than single tickets.",
    ],
    ...overrides,
  };
}

function slot(
  slotId: string,
  category: PlaceCategory,
  mealType: "breakfast" | "lunch" | "dinner" | "snack" | null,
  required: boolean,
) {
  return {
    slotId,
    category,
    purpose: "A stop matched to the traveller's stated interests.",
    mealType,
    required,
    candidateLimit: 6,
  };
}

/** A valid assembly against `fixturePool()` and `fixtureStrategy()`. */
export function fixtureAssembly(
  overrides: Partial<GeneratedTripAssembly> = {},
): GeneratedTripAssembly {
  return {
    title: "Two days in Lisbon, tiles and coffee",
    destinationOverview:
      "Two days is enough to do Alfama and the river properly, which is a better trade than trying to see everything and sitting down nowhere.",
    recommendedNeighborhood: {
      name: "Alfama",
      why: "The district the 1755 earthquake left standing, so the streets still run medieval and everything on day one is within a short walk.",
    },
    days: [
      {
        dayNumber: 1,
        title: "Alfama, slowly",
        summary:
          "A deliberately short first day, staying inside a ten-minute radius so the jet lag has somewhere to go.",
        items: [
          placeItem("d1-s1", "cafe-one", FIXTURE_PLACES.cafeOne.placeId, "cafe", {
            mealType: "breakfast",
            startTime: "09:00",
            endTime: "10:00",
            amount: 14,
          }),
          placeItem(
            "d1-s2",
            "museum-one",
            FIXTURE_PLACES.museumOne.placeId,
            "museum",
            { startTime: "10:30", endTime: "12:30", amount: 20 },
          ),
          placeItem(
            "d1-s3",
            "dinner-one",
            FIXTURE_PLACES.restaurantOne.placeId,
            "restaurant",
            {
              mealType: "dinner",
              startTime: "19:30",
              endTime: "21:00",
              amount: 60,
            },
          ),
        ],
        backups: [
          {
            backupId: "bk-d1-s2",
            slotId: "d1-s2",
            placeId: FIXTURE_PLACES.museumTwo.placeId,
            reason:
              "A second museum from the same search, in case the first is closed for an exhibition change.",
          },
        ],
      },
      {
        dayNumber: 2,
        title: "The river",
        summary:
          "West along the water, with the afternoon left open so the day does not become a march between ticket desks.",
        items: [
          placeItem("d2-s1", "cafe-two", FIXTURE_PLACES.cafeTwo.placeId, "cafe", {
            mealType: "breakfast",
            startTime: "09:00",
            endTime: "09:45",
            amount: 12,
          }),
          placeItem(
            "d2-s2",
            "museum-two",
            FIXTURE_PLACES.museumTwo.placeId,
            "museum",
            { startTime: "10:30", endTime: "12:30", amount: 22 },
          ),
          {
            kind: "non-place" as const,
            itemId: "afternoon-open",
            category: "free-time" as const,
            startTime: "13:00",
            endTime: "16:00",
            title: "Unscheduled afternoon",
            description:
              "Left deliberately open. The walk between two stops in an unfamiliar city takes longer than a schedule suggests.",
            estimatedCost: cost(0),
          },
          placeItem(
            "d2-s3",
            "dinner-two",
            FIXTURE_PLACES.restaurantTwo.placeId,
            "restaurant",
            {
              mealType: "dinner",
              startTime: "19:30",
              endTime: "21:00",
              amount: 40,
            },
          ),
        ],
        backups: [],
      },
    ],
    practicalNotes: [
      {
        title: "Transport",
        body: "Buy a rechargeable card at any metro station; single paper tickets cost roughly double per journey.",
      },
    ],
    ...overrides,
  };
}

function placeItem(
  slotId: string,
  itemId: string,
  placeId: string,
  category: PlaceCategory,
  options: {
    mealType?: "breakfast" | "lunch" | "dinner" | "snack";
    startTime: string;
    endTime: string;
    amount: number;
  },
) {
  return {
    kind: "place" as const,
    itemId,
    slotId,
    placeId,
    category,
    mealType: options.mealType ?? null,
    startTime: options.startTime,
    endTime: options.endTime,
    title: `A stop at ${category}`,
    description:
      "Chosen because it sits within a short walk of the day's other stops and matches the interests on the request.",
    estimatedCost: cost(options.amount),
    reservationRecommended: options.mealType === "dinner",
  };
}

/**
 * A narrowed handle on one place item, for tests that need to break exactly one field.
 *
 * `AssemblyItem` is a discriminated union, so `items[0].estimatedCost` does not
 * type-check — and a cast would be worse than a guard, because a fixture that quietly
 * changed shape would then break a test somewhere far away rather than here.
 */
export function placeItemAt(
  assembly: GeneratedTripAssembly,
  dayIndex: number,
  itemIndex: number,
): Extract<GeneratedTripAssembly["days"][number]["items"][number], { kind: "place" }> {
  const item = assembly.days[dayIndex]?.items[itemIndex];
  if (!item || item.kind !== "place") {
    throw new Error(
      `fixture changed shape: day ${dayIndex} item ${itemIndex} is not a place item`,
    );
  }
  return item;
}

export function cost(amount: number) {
  return {
    amount,
    currency: "EUR",
    basis: "category-estimate" as const,
    confidence: "low" as const,
  };
}

/**
 * A generator driven by a script.
 *
 * One entry per call, consumed in order, so a test can say exactly what the model
 * "returns" at each stage — including a refusal on the first call and a valid answer
 * on the repair. `calls` records every request, which is how the suite asserts the
 * things that matter most about the pipeline: that at most one repair happens, and
 * that a repair is given the same candidate list rather than a new search.
 */
export function scriptedGenerator(
  script: StructuredGenerationResult<unknown>[],
  options: { id?: "gemini" | "ollama" | "deterministic"; model?: string } = {},
): StructuredGenerator & {
  calls: { operation: string; input: unknown }[];
} {
  const calls: { operation: string; input: unknown }[] = [];
  let index = 0;

  return {
    id: options.id ?? "gemini",
    model: options.model ?? "test-model",
    calls,
    generate: (request) => {
      calls.push({ operation: request.operation, input: request.input });
      const result = script[index];
      index += 1;
      if (!result) {
        throw new Error(
          `scriptedGenerator ran out of scripted results after ${index - 1} call(s)`,
        );
      }
      return Promise.resolve(result);
    },
  };
}

export function successResult(value: unknown): StructuredGenerationResult<unknown> {
  return {
    status: "success",
    value,
    provider: "gemini",
    model: "test-model",
  };
}
