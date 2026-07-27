import { createServer } from "node:http";

/**
 * Local stand-ins for every external service, so browser verification can run
 * repeatedly without touching anything real.
 *
 * ## Why this exists rather than stubbing `/api/*`
 *
 * Intercepting our own API routes from the browser would verify the React layer and
 * nothing else. Standing in for the *providers* instead means the whole server
 * pipeline genuinely runs — strategy, discovery, assembly, mechanical validation,
 * canonical attachment, the immutable builder, the pool gate — with nothing leaving
 * the machine. That is the same approach Phase 5A took with a fake Valhalla, for the
 * same reason.
 *
 * Every server counts its requests, which is what lets the suite assert the negative
 * properties that matter most: that a rapid double-click produces **one** generation,
 * and that generating a trip makes **zero** routing requests.
 *
 * ## The Gemini fixture is a planner, not a recording
 *
 * It reads the candidate list out of the prompt and fills the strategy's slots from
 * it. A recorded response would reference placeIds that the Overpass fixture might no
 * longer be returning, and the run would fail for a reason that has nothing to do
 * with the code. Reading the real input keeps the two in agreement, and it is what
 * makes the `fabricate` mode a genuine test — the same planner, with one id swapped
 * for one that was never discovered.
 */

/* -------------------------------------------------------------------------- */
/* Place data                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Real Lisbon coordinates, so mode selection and the map behave normally.
 *
 * ## The `opening_hours` strings are chosen, not incidental
 *
 * The browser run books 2026-09-12 to 09-13 — a Saturday and a Sunday — and the fixture
 * planner schedules breakfast at 09:00, the museum at 10:30 and dinner at 19:30. Each string
 * below therefore lands on a specific Phase 6B state, and the whole set covers all of them:
 *
 *  - 2002 opens at 11:00 → a conflict the generation repair *can* fix by moving the clock,
 *    after which the same stop reads `confirmed_open`
 *  - 3003 weekdays only → a conflict it cannot, so the interface must offer the repairs
 *  - 4001 a holiday clause → `unknown_unparsed`, shown verbatim rather than half-read
 *  - 3001 no tag, and unused by the itinerary → a replacement candidate, hours unknown
 *  - everything else no tag → `unknown_no_data`, the commonest real case
 *
 * The ids are the ones the fixture planner actually schedules on day one. Tagging a place it
 * happens not to choose would leave the states untested while looking covered.
 */
const ELEMENTS = [
  el(1001, 38.7169, -9.1409, {
    name: "Fábrica Coffee Roasters",
    amenity: "cafe",
    "addr:street": "R. das Portas de Santo Antão",
    "addr:housenumber": "136",
    opening_hours: "Mo-Su 08:00-19:00",
  }),
  el(1002, 38.7099, -9.1435, { name: "Manteigaria", amenity: "cafe" }),
  el(1003, 38.7126, -9.1354, { name: "Café Buenos Aires", amenity: "cafe" }),
  el(2001, 38.7248, -9.115, {
    name: "Museu Nacional do Azulejo",
    tourism: "museum",
    "addr:street": "R. Madre de Deus",
  }),
  el(2002, 38.6957, -9.1936, {
    name: "MAAT",
    tourism: "museum",
    // Scheduled at 10:45 and opening at 11:00: the deterministic repair can fix this by
    // moving the clock, and must say that it did.
    opening_hours: "Mo-Su 11:00-18:00",
  }),
  el(3001, 38.7128, -9.1279, {
    name: "Ti-Natércia",
    amenity: "restaurant",
    cuisine: "portuguese",
  }),
  el(3002, 38.7215, -9.1355, {
    name: "Cervejaria Ramiro",
    amenity: "restaurant",
    cuisine: "seafood",
  }),
  el(3003, 38.7097, -9.1444, {
    name: "Cantinho do Avillez",
    amenity: "restaurant",
    // Closed all weekend, and the trip is a weekend — the conflict the interface must
    // surface with repairs rather than silently rearrange.
    opening_hours: "Mo-Fr 19:00-23:00",
  }),
  el(4001, 38.7113, -9.1305, {
    name: "Santiago de Alfama",
    tourism: "hotel",
    website: "https://example.test",
    // A holiday clause. Must read as "hours not checked" with the string shown verbatim,
    // never as a confident reading of the half we do understand.
    opening_hours: "Mo-Fr 09:00-17:00; PH off",
  }),
  el(5001, 38.7122, -9.13, {
    name: "Miradouro das Portas do Sol",
    tourism: "viewpoint",
  }),
  el(6001, 38.7157, -9.1249, { name: "Feira da Ladra", amenity: "marketplace" }),
  el(7001, 38.728, -9.154, { name: "Estufa Fria", leisure: "garden" }),
];

function el(id, lat, lon, tags) {
  return { type: "node", id, lat, lon, tags };
}

/** Categories that describe where the traveller sleeps rather than a stop on the day. */
const ACCOMMODATION_CATEGORIES = new Set(["hotel", "hostel", "guest_house"]);

/** Which OSM tag pairs each allowlisted category is queried by. */
const CATEGORY_TAGS = {
  cafe: ["amenity=cafe"],
  restaurant: ["amenity=restaurant"],
  museum: ["tourism=museum"],
  hotel: ["tourism=hotel"],
  hostel: ["tourism=hostel"],
  guest_house: ["tourism=guest_house", "tourism=apartment"],
  viewpoint: ["tourism=viewpoint"],
  market: ["amenity=marketplace", "shop=greengrocer"],
  garden: ["leisure=garden"],
};

/* -------------------------------------------------------------------------- */
/* Servers                                                                     */
/* -------------------------------------------------------------------------- */

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Nominatim.
 *
 * Returns **two** candidates for anything containing "lisbon", so the ambiguous
 * destination path is the default rather than an exotic case — the interface must
 * make the traveller choose, and a fixture with one answer would never prove it.
 */
export async function startNominatim() {
  const state = { requests: 0 };

  const server = createServer((request, response) => {
    state.requests += 1;
    const url = new URL(request.url, "http://localhost");
    const query = (url.searchParams.get("q") ?? "").toLowerCase();

    const candidates = query.includes("lisbon")
      ? [
          {
            osm_type: "relation",
            osm_id: 5400890,
            name: "Lisbon",
            display_name: "Lisbon, Portugal",
            lat: 38.7223,
            lon: -9.1393,
            boundingbox: ["38.69", "38.80", "-9.23", "-9.09"],
            address: { country_code: "pt" },
          },
          {
            osm_type: "relation",
            osm_id: 182234,
            name: "Lisbon",
            display_name: "Lisbon, Columbiana County, Ohio, United States",
            lat: 40.7739,
            lon: -80.7684,
            boundingbox: ["40.76", "40.79", "-80.79", "-80.75"],
            address: { country_code: "us" },
          },
        ]
      : [];

    respondJson(response, candidates);
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Overpass.
 *
 * Reads the requested categories out of the query text and answers with matching
 * elements, so a category with nothing mapped genuinely comes back empty and the
 * pipeline's "unavailable slot" path is exercised for real.
 *
 * `omit` drops a category from the answer, which is how the partial-result scenario is
 * produced.
 */
export async function startOverpass({ omit = [] } = {}) {
  /**
   * `exclude` and `rename` are how a *second* search can differ from the first.
   *
   * A refresh whose result is byte-identical to the original produces an empty diff, which
   * exercises nothing — and the only honest way to make the two differ is to change what the
   * provider returns between them. Setting `state.exclude` mid-run is the fixture equivalent of
   * a mapper retagging a node, and `state.rename` of one correcting a name.
   */
  const state = { requests: 0, exclude: new Set(), rename: new Map() };

  const server = createServer((request, response) => {
    state.requests += 1;

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const query = decodeURIComponent(body.replace(/^data=/, "").replace(/\+/g, " "));

      const wanted = new Set();
      for (const [category, pairs] of Object.entries(CATEGORY_TAGS)) {
        if (omit.includes(category)) continue;
        for (const pair of pairs) {
          const [key, value] = pair.split("=");
          if (query.includes(`["${key}"="${value}"]`)) wanted.add(pair);
        }
      }

      const elements = ELEMENTS.filter(
        (element) =>
          !state.exclude.has(element.id) &&
          Object.entries(element.tags).some((entry) =>
            wanted.has(`${entry[0]}=${entry[1]}`),
          ),
      ).map((element) =>
        state.rename.has(element.id)
          ? { ...element, tags: { ...element.tags, name: state.rename.get(element.id) } }
          : element,
      );

      respondJson(response, { version: 0.6, generator: "fixture", elements });
    });
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Valhalla.
 *
 * Present only so that "no routing request happens during generation" is a checkable
 * claim rather than an assumption, and so real routing still works afterwards.
 */
export async function startValhalla() {
  const state = { requests: 0 };

  const server = createServer((request, response) => {
    state.requests += 1;

    respondJson(response, {
      trip: {
        status: 0,
        status_message: "Found route between points",
        units: "kilometers",
        legs: [
          {
            summary: { length: 1.2, time: 900 },
            // A two-point encoded polyline through Alfama, at Valhalla's 1e6 precision.
            shape: "_grbcAvijxgD_pR_pR",
          },
        ],
        summary: { length: 1.2, time: 900 },
      },
    });
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Gemini.
 *
 * `mode` selects the behaviour under test:
 *
 *  - `ok` — a valid strategy, then an assembly built from the supplied candidates
 *  - `fabricate` — the same, with one `placeId` that was never discovered
 *  - `fabricate-refinement` — generates cleanly, then fabricates when refining, so a
 *    refusal can be tested on a trip that exists
 *  - `refuse` — HTTP 200 with `promptFeedback.blockReason` and no candidates
 *  - `empty` — HTTP 200 with an empty candidate array
 *  - `rate-limit` — HTTP 429
 *
 * `delayMs` holds each answer back. A fixture that replies in 40 ms makes an in-flight
 * generation unobservable, so the cancel path could not be verified at all — the
 * traveller-facing behaviour under test only exists while a request is outstanding.
 */
export async function startGemini({ mode = "ok", delayMs = 0 } = {}) {
  const state = { requests: 0, operations: [] };

  const server = createServer((request, rawResponse) => {
    state.requests += 1;
    const response = delayMs > 0 ? deferred(rawResponse, delayMs) : rawResponse;

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (mode === "rate-limit") {
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "quota exceeded" } }));
        return;
      }
      if (mode === "refuse") {
        respondJson(response, { promptFeedback: { blockReason: "SAFETY" } });
        return;
      }
      if (mode === "empty") {
        respondJson(response, { candidates: [] });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        respondJson(response, { candidates: [] });
        return;
      }

      const userTurn = payload?.contents?.[0]?.parts?.[0]?.text ?? "";
      const input = extractInput(userTurn);

      /**
       * `action` first.
       *
       * A refinement input also carries `candidates`, so sniffing for that alone would
       * read a stop replacement as a whole-itinerary assembly and answer with the wrong
       * shape entirely.
       */
      const operation = input?.action
        ? input.action
        : Array.isArray(input?.candidates)
          ? "assembly"
          : "strategy";
      state.operations.push(operation);

      /**
       * `fabricate-refinement` generates cleanly and only fabricates on a refinement.
       * Without it the initial generation would be rejected and there would be no trip
       * to try refining.
       */
      const fabricate =
        mode === "fabricate" ||
        (mode === "fabricate-refinement" &&
          operation !== "strategy" &&
          operation !== "assembly");

      const answer = buildAnswer(operation, input, fabricate);

      respondJson(response, {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } },
        ],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 800 },
      });
    });
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/* -------------------------------------------------------------------------- */
/* The fixture planner                                                         */
/* -------------------------------------------------------------------------- */

/** The `Input:` block of the user turn, which is where the pipeline puts its payload. */
function extractInput(text) {
  const start = text.indexOf("Input:");
  if (start === -1) return null;
  const brace = text.indexOf("{", start);
  if (brace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = brace; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(brace, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Dispatches to the right builder for the operation the prompt is asking about. */
function buildAnswer(operation, input, fabricate) {
  switch (operation) {
    case "strategy":
      return buildStrategy(input);
    case "assembly":
      return buildAssembly(input, fabricate);
    case "replace-item":
      return buildReplaceItem(input, fabricate);
    case "replace-backup":
      return buildReplaceBackup(input, fabricate);
    case "adjust-day":
      return buildDayAdjustment(input);
    default:
      return buildStrategy(input);
  }
}

/**
 * A stop replacement: take the nearest eligible candidate.
 *
 * The candidates arrive already filtered and ordered by the server, so "the first one"
 * is a reasonable planner and needs no judgement the fixture does not have.
 */
function buildReplaceItem(input, fabricate) {
  const chosen = input.candidates?.[0];
  if (!chosen) {
    return {
      status: "unavailable",
      reason:
        "The search around this destination turned up no other place of this kind nearby.",
    };
  }

  return {
    status: "selected",
    // The `fabricate` mode names a place that was never offered, so the pool gate has
    // something real to catch.
    placeId: fabricate ? "osm:node:999999999" : chosen.placeId,
    description:
      "Chosen because it sits a short walk from the day's other stops and fills the same slot without moving the schedule.",
    estimatedCost: {
      amount: input.preferences?.cheaper ? 8 : 16,
      currency: input.currency ?? "EUR",
      basis: "category-estimate",
      confidence: "low",
    },
    reservationRecommended: false,
  };
}

function buildReplaceBackup(input, fabricate) {
  const chosen = input.candidates?.[0];
  if (!chosen) {
    return {
      status: "unavailable",
      reason: "The search returned nothing else of this kind to offer as a fallback.",
    };
  }

  return {
    status: "selected",
    placeId: fabricate ? "osm:node:999999999" : chosen.placeId,
    reason:
      "Another place of the same kind from the same search, close to the day's other stops.",
  };
}

/**
 * A day adjustment.
 *
 * Mirrors the deterministic planner's own moves — drop the priciest optional stop for
 * "cheaper", drop the last one for "more-relaxed", add one for "more-packed" — because
 * those are the changes the server's validators will accept, and a fixture that
 * proposed something invalid would be testing the rejection path by accident.
 */
function buildDayAdjustment(input) {
  const items = [...(input.items ?? [])].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
  /**
   * Somewhere to stay is not an optional stop.
   *
   * The check-in block is a place stop with no meal type, so a naive filter treats it as the
   * day's most droppable item — and because it is priced against the nightly band it is also the
   * most *expensive* one, which made "make this day cheaper" remove the hotel. Dropping it also
   * moves no budget category, since accommodation is canonical rather than derived from items,
   * so the day total fell while the trip total did not.
   */
  const optional = items.filter(
    (item) =>
      item.kind === "place" &&
      item.mealType === null &&
      !ACCOMMODATION_CATEGORIES.has(item.category),
  );

  let next = items;

  if (input.adjustment === "cheaper" || input.adjustment === "more-relaxed") {
    if (optional.length === 0) {
      return {
        status: "unavailable",
        reason:
          "This day is only meals and free time, so there is no optional stop to drop.",
      };
    }
    const target =
      input.adjustment === "cheaper"
        ? [...optional].sort(
            (a, b) =>
              b.estimatedCost - a.estimatedCost ||
              a.itemId.localeCompare(b.itemId),
          )[0]
        : optional[optional.length - 1];
    next = items.filter((item) => item.itemId !== target.itemId);
  } else {
    const candidate = input.candidates?.[0];
    const last = items[items.length - 1];
    if (!candidate || !last) {
      return {
        status: "unavailable",
        reason: "There is nothing left nearby to add to this day.",
      };
    }
    const start = addMinutes(last.endTime, 15);
    const end = addMinutes(start, 60);
    next = [
      ...items,
      {
        kind: "place",
        itemId: `added-${candidate.placeId.replace(/[^a-z0-9]+/gi, "").slice(-6).toLowerCase()}`,
        placeId: candidate.placeId,
        category: candidate.category,
        mealType: null,
        startTime: start,
        endTime: end,
        title: "One more stop",
        description:
          "Added into the day's remaining gap, with real time to get there from the previous stop.",
        estimatedCost: 18,
        reservationRecommended: false,
      },
    ];
  }

  return {
    status: "adjusted",
    dayNumber: input.dayNumber,
    summary: `Adjusted to be ${input.adjustment.replace(/-/g, " ")}, keeping both meals where they were and leaving real time between the stops that remain.`,
    items: next.map((item) => ({
      kind: item.kind,
      itemId: item.itemId,
      ...(item.kind === "place"
        ? {
            placeId: item.placeId,
            category: item.category,
            mealType: item.mealType,
            reservationRecommended: item.reservationRecommended ?? false,
          }
        : {}),
      ...(item.kind === "non-place"
        ? { category: item.nonPlaceCategory ?? "free-time" }
        : {}),
      ...(item.kind === "unavailable"
        ? { reason: item.description ?? "Nothing eligible was available." }
        : {}),
      startTime: item.startTime,
      endTime: item.endTime,
      ...(item.kind === "unavailable"
        ? {}
        : {
            title: item.title,
            description: item.description,
            estimatedCost: {
              amount: item.estimatedCost ?? 0,
              currency: input.currency ?? "EUR",
              basis: "category-estimate",
              confidence: "low",
            },
          }),
    })),
    backups: (input.backups ?? []).map((backup) => ({
      backupId: backup.backupId,
      placeId: backup.placeId,
      reason:
        "Carried over unchanged — this adjustment changed the day's stops, not its fallbacks.",
    })),
  };
}

function addMinutes(time, minutes) {
  const [hours, mins] = time.split(":").map(Number);
  const total = Math.min(23 * 60 + 30, hours * 60 + mins + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const MEALS = [
  { mealType: "breakfast", category: "cafe" },
  { mealType: "lunch", category: "restaurant" },
];

function buildStrategy(input) {
  const dayCount = input?.dayCount ?? 2;
  const anchors = ["museum", "viewpoint", "market", "garden"];

  return {
    destinationSummary:
      "A compact riverside capital where nearly everything worth seeing sits in a narrow band along the water, which makes a short trip generous rather than tight.",
    recommendedBaseArea: "Alfama",
    languageNote:
      "Portuguese, with confident English across hospitality. A greeting in Portuguese is noticed out of all proportion to the effort.",
    currencyNote:
      "Euro. Cards work nearly everywhere, though the older tascas still prefer cash, so carry some.",
    seasonalNote:
      "Mid-September is warm by day and cooler after dark once the Atlantic breeze picks up. Rain is unlikely but not impossible.",
    recommendedRadiusMeters: 4000,
    budgetAllocation: {
      flights: 0.3,
      accommodation: 0.27,
      food: 0.23,
      activities: 0.12,
      localTransport: 0.05,
      buffer: 0.03,
    },
    days: Array.from({ length: dayCount }, (_, index) => {
      const dayNumber = index + 1;
      const slots = [
        { category: MEALS[0].category, mealType: "breakfast", required: true },
        { category: anchors[index % anchors.length], mealType: null, required: true },
        { category: MEALS[1].category, mealType: "lunch", required: true },
      ];
      if (dayNumber === 1) {
        slots.push({ category: "hotel", mealType: null, required: false });
      }

      return {
        dayNumber,
        theme: dayNumber === 1 ? "Arrival, kept short" : `Day ${dayNumber} out`,
        pace: input?.pace ?? "balanced",
        searchRequirements: slots.map((slot, slotIndex) => ({
          slotId: `d${dayNumber}-s${slotIndex + 1}`,
          category: slot.category,
          purpose: "A stop matched to the interests on the request.",
          mealType: slot.mealType,
          required: slot.required,
          candidateLimit: 6,
        })),
      };
    }),
    practicalConsiderations: [
      "Buy a rechargeable transport card at any metro station rather than single paper tickets.",
    ],
  };
}

const WINDOWS = [
  ["09:00", "10:15"],
  ["10:45", "12:30"],
  ["13:00", "14:30"],
  ["15:00", "16:45"],
  ["17:15", "18:30"],
  ["19:30", "21:00"],
];

function buildAssembly(input, fabricate) {
  const used = new Set();
  const byCategory = new Map();
  for (const candidate of input.candidates ?? []) {
    const bucket = byCategory.get(candidate.category) ?? [];
    bucket.push(candidate);
    byCategory.set(candidate.category, bucket);
  }

  const take = (category) => {
    for (const candidate of byCategory.get(category) ?? []) {
      if (used.has(candidate.placeId)) continue;
      used.add(candidate.placeId);
      return candidate;
    }
    return null;
  };
  /**
   * A backup **reserves** its place, so a later day cannot schedule it.
   *
   * Without the reservation the planner offers a day-one fallback and then, two days later,
   * makes it a stop — leaving a backup that is already in the itinerary. Promoting one is then
   * correctly refused as a duplicate, which made the browser suite fail for a reason that had
   * nothing to do with promotion. A real planner should not do this either.
   */
  const reserve = (category) => {
    const candidate =
      (byCategory.get(category) ?? []).find((c) => !used.has(c.placeId)) ?? null;
    if (candidate) used.add(candidate.placeId);
    return candidate;
  };

  let swapped = false;

  const days = (input.strategy?.days ?? []).map((day) => {
    const items = [];
    const backups = [];

    day.searchRequirements.forEach((slot, index) => {
      const [startTime, endTime] = WINDOWS[index % WINDOWS.length];
      const itemId = `d${day.dayNumber}-s${index + 1}`;
      const chosen = take(slot.category);

      if (!chosen) {
        items.push({
          kind: "unavailable",
          itemId,
          slotId: slot.slotId,
          reason: `No ${slot.category.replace(/_/g, " ")} came back from the place search near this destination, so this slot is left open.`,
          startTime,
          endTime,
        });
        return;
      }

      // One fabricated id, to prove the pool gate rejects the whole generation.
      let placeId = chosen.placeId;
      if (fabricate && !swapped) {
        placeId = "osm:node:999999999";
        swapped = true;
      }

      items.push({
        kind: "place",
        itemId,
        slotId: slot.slotId,
        placeId,
        category: slot.category,
        mealType: slot.mealType,
        startTime,
        endTime,
        title: slot.mealType
          ? `${slot.mealType[0].toUpperCase()}${slot.mealType.slice(1)}`
          : `${slot.category.replace(/_/g, " ")} stop`,
        description:
          "Placed here because it sits within a short walk of the day's other stops and matches the interests on the request.",
        estimatedCost: {
          amount: slot.mealType ? 34 : 18,
          currency: input.currency ?? "EUR",
          basis: "category-estimate",
          confidence: "low",
        },
        reservationRecommended: slot.mealType === "dinner",
      });

      const alternative = reserve(slot.category);
      backups.push(
        alternative
          ? {
              backupId: `bk-${itemId}`,
              slotId: slot.slotId,
              placeId: alternative.placeId,
              reason:
                "Another option of the same kind from the same search, if the first is closed or full.",
            }
          : {
              backupId: `bk-${itemId}`,
              slotId: slot.slotId,
              reason: "An alternative of the same kind would have gone here.",
              unavailableReason:
                "The place search returned nothing else of this kind nearby, so there is no backup to offer.",
            },
      );
    });

    return {
      dayNumber: day.dayNumber,
      title: `Day ${day.dayNumber} — ${day.theme}`,
      summary:
        "A short day built around one anchor and two meals, with real walking distance left between the stops rather than a schedule that assumes teleportation.",
      items,
      backups: backups.slice(0, 4),
    };
  });

  return {
    title: `${days.length} days in ${input.destinationName ?? "this city"}`,
    destinationOverview:
      "Everything below sits within a short walk or a tram ride of the centre, so the plan trades breadth for actually sitting down in places rather than ticking them off.",
    recommendedNeighborhood: {
      name: input.strategy?.recommendedBaseArea ?? "Alfama",
      why: "Central enough that most of the itinerary is walkable from the front door, and characterful enough to be worth the evenings.",
    },
    days,
    practicalNotes: [
      {
        title: "Transport",
        body: "A rechargeable card at any metro station costs a fraction of single paper tickets per journey.",
      },
    ],
  };
}

function respondJson(response, body) {
  const payload = JSON.stringify(body);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * A response proxy that holds every write back by `delayMs`.
 *
 * Wrapping the response rather than the handler keeps the scripted-planner code
 * unchanged and unaware of timing.
 */
function deferred(response, delayMs) {
  const queue = [];
  let scheduled = false;
  const flush = () => {
    for (const run of queue.splice(0)) run();
  };
  const later = (run) => {
    queue.push(run);
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, delayMs);
  };

  return {
    writeHead: (...args) => later(() => response.writeHead(...args)),
    end: (...args) => later(() => response.end(...args)),
  };
}

export function closeAll(servers) {
  return Promise.all(
    servers.map(
      (entry) =>
        new Promise((resolve) => {
          entry.server.close(() => resolve());
        }),
    ),
  );
}
