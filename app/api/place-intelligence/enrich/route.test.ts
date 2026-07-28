import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichTripPlacesResponseSchema } from "@/lib/api/place-intelligence-contract";
import { FIXTURE_PLACES } from "@/lib/generate/test-fixtures";
import {
  fact,
  identity,
  sidecar,
} from "@/lib/place-intelligence/test-fixtures";

import { POST, maxDuration } from "./route";

/**
 * The enrichment route boundary.
 *
 * The orchestrator is mocked, because what is under test is the *boundary*: the body ceiling, the eligibility filter, the
 * de-duplication, the echoed revision — and the two properties that cannot be asserted anywhere else, that no provider
 * request is made for a place that was never eligible, and that nothing about a trip crosses back.
 */

const enrichPlaces = vi.hoisted(() => vi.fn());
const wikimediaClientIsUsable = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers/place-intelligence/enrich", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/providers/place-intelligence/enrich")
  >("@/lib/providers/place-intelligence/enrich");
  return { ...actual, enrichPlaces };
});

vi.mock("@/lib/providers/place-intelligence/wikimedia", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/providers/place-intelligence/wikimedia")
  >("@/lib/providers/place-intelligence/wikimedia");
  return { ...actual, wikimediaClientIsUsable };
});

const MUSEUM = FIXTURE_PLACES.museumOne;
const OTHER_MUSEUM = FIXTURE_PLACES.museumTwo;
const CAFE = FIXTURE_PLACES.cafeOne;

function matched(canonicalPlaceId: string) {
  return {
    status: "matched" as const,
    canonicalPlaceId,
    intelligence: sidecar({
      canonicalPlaceId,
      identities: [identity({ canonicalPlaceId })],
      facts: [
        fact({ kind: "inception-year", value: 1509, provider: "wikidata" }),
      ],
    }),
    summary: null,
    partial: false,
    notes: [],
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://roamly.test/api/place-intelligence/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision: 7,
    places: [MUSEUM],
    requestId: "req-enrich-0001",
    ...overrides,
  };
}

beforeEach(() => {
  wikimediaClientIsUsable.mockReset();
  wikimediaClientIsUsable.mockReturnValue(true);
  enrichPlaces.mockReset();
  enrichPlaces.mockResolvedValue({
    outcomes: [matched(MUSEUM.placeId)],
    abandoned: null,
  });
});

describe("the request boundary", () => {
  it("allows more than the internal budget before the platform ceiling", () => {
    /* 120 against a 90 s budget: the run must end itself and report, not be killed mid-request. */
    expect(maxDuration).toBe(120);
  });

  it("refuses an empty place list", async () => {
    const response = await post(requestBody({ places: [] }));

    expect(response.status).toBe(400);
    expect(enrichPlaces).not.toHaveBeenCalled();
  });

  it("refuses more places than a trip may ask about", async () => {
    const response = await post(
      requestBody({
        places: Array.from({ length: 13 }, (_, index) => ({
          ...MUSEUM,
          placeId: `osm:node:${9000 + index}`,
        })),
      }),
    );

    expect(response.status).toBe(400);
    expect(enrichPlaces).not.toHaveBeenCalled();
  });
});

describe("what the route returns", () => {
  it("parses against its own contract", async () => {
    const response = await post(requestBody());
    const parsed = EnrichTripPlacesResponseSchema.safeParse(
      await response.json(),
    );

    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
  });

  it("echoes expectedRevision untouched", async () => {
    /* A token for the client's guarded save, never an authorisation — the server has nothing to check it against. */
    const response = await post(requestBody({ expectedRevision: 42 }));
    const payload = await response.json();

    expect(payload.expectedRevision).toBe(42);
  });

  it("returns no trip, no record and no trip id", async () => {
    const response = await post(requestBody());
    const payload = await response.json();

    expect(Object.keys(payload).sort()).toEqual([
      "abandoned",
      "expectedRevision",
      "outcomes",
      "requestId",
    ]);
  });

  it("passes an abandoned run through rather than failing", async () => {
    enrichPlaces.mockResolvedValue({
      outcomes: [matched(MUSEUM.placeId)],
      abandoned: { code: "budget_exhausted", attempted: 1 },
    });

    const response = await post(requestBody());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.abandoned).toEqual({
      code: "budget_exhausted",
      attempted: 1,
    });
    expect(payload.outcomes).toHaveLength(1);
  });
});

describe("a misconfigured deployment is not a provider outcome", () => {
  it("answers 503 and names only the variable to set", async () => {
    wikimediaClientIsUsable.mockReturnValue(false);

    const response = await post(requestBody());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("provider_misconfigured");
    expect(payload.error.message).toContain("ROAMLY_CONTACT_URL");
    /* The provider was never asked, so there is no outcome to report. */
    expect(enrichPlaces).not.toHaveBeenCalled();
    expect(payload.outcomes).toBeUndefined();
  });

  it("leaks no environment detail", async () => {
    wikimediaClientIsUsable.mockReturnValue(false);

    const payload = await (await post(requestBody())).json();
    const serialised = JSON.stringify(payload);

    for (const leak of [
      "User-Agent",
      "Roamly/0.1",
      "wikidata.org",
      "commons.wikimedia.org",
      "process.env",
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });
});

describe("eligibility is applied before any provider request", () => {
  it("reports an ineligible place unmatched, and never asks about it", async () => {
    const response = await post(requestBody({ places: [MUSEUM, CAFE] }));
    const payload = await response.json();

    const cafe = payload.outcomes.find(
      (outcome: { canonicalPlaceId: string }) =>
        outcome.canonicalPlaceId === CAFE.placeId,
    );
    expect(cafe.status).toBe("unmatched");
    expect(cafe.reason).toContain("commercial premises");

    /* The orchestrator saw the museum and only the museum. */
    const passed = enrichPlaces.mock.calls[0][0].places;
    expect(passed.map((place: { placeId: string }) => place.placeId)).toEqual([
      MUSEUM.placeId,
    ]);
  });

  it("makes no provider call at all when nothing is eligible", async () => {
    const response = await post(requestBody({ places: [CAFE] }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(enrichPlaces).not.toHaveBeenCalled();
    expect(payload.outcomes).toHaveLength(1);
    expect(payload.outcomes[0].status).toBe("unmatched");
    expect(payload.abandoned).toBeNull();
  });

  it("collapses a duplicated place rather than spending two of twelve on it", async () => {
    await post(requestBody({ places: [MUSEUM, MUSEUM, OTHER_MUSEUM] }));

    const passed = enrichPlaces.mock.calls[0][0].places;
    expect(passed.map((place: { placeId: string }) => place.placeId)).toEqual([
      MUSEUM.placeId,
      OTHER_MUSEUM.placeId,
    ]);
  });
});
