import { addDays, format, parseISO } from "date-fns";

import type {
  AssemblyBackup,
  AssemblyItem,
  GeneratedTripAssembly,
  TripStrategy,
} from "@/lib/ai";
import {
  FLIGHT_ESTIMATE_BASIS,
  buildCostEstimate,
  clampPartyCost,
  costClassFor,
  flightBandFor,
  withDerivedBudget,
  withDerivedDayTotals,
} from "@/lib/plan";
import {
  PLACE_CATEGORY_LABELS,
  TRIP_PLAN_SCHEMA_VERSION,
  TripPlanSchema,
  assertItineraryUsesPool,
  tripNightCount,
  type BackupOption,
  type Currency,
  type GeocodedDestinationRecord,
  type GenerationWarning,
  type ItemKind,
  type ItineraryDay,
  type ItineraryItem,
  type MealType,
  type PlaceCategory,
  type TripPlace,
  type TripPlan,
  type TripRequest,
  type VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * Canonical attachment: model output → a real `TripPlan`.
 *
 * ## The one rule
 *
 * A `placeId` is looked up in the pool and **the pool's record is attached,
 * unchanged**. The model's text never touches a provider fact. Its description
 * becomes `rationale`, which is editorial and is meant to be its own; the name,
 * coordinates, category, address and source identity come from the record that came
 * out of Overpass, and there is no code path here that writes any of them.
 *
 * That is also why the lookup throws on a miss instead of skipping the item. By this
 * point `validateAssembly` has already confirmed every id is in the pool, so a miss
 * means the pool and the assembly have been paired wrongly by the orchestrator — a
 * bug, and one that would otherwise manifest as a silently shorter itinerary.
 * `assertItineraryUsesPool` then runs on the finished plan as the independent check,
 * because a builder that validates only its inputs proves nothing about its output.
 *
 * ## Money
 *
 * The model proposes; the bands decide. Each amount is clamped into
 * `lib/plan/cost-bands.ts` for its category and party size, and every clamp is
 * recorded as a warning rather than applied silently. Totals are then recomputed
 * from the items by `withDerivedBudget` — the model's arithmetic is never trusted,
 * and there is nowhere for it to be stored even if it were.
 *
 * ## Immutability
 *
 * The pool, the strategy and the assembly are read and never written. Every object
 * returned is freshly constructed, which is what lets the orchestrator build a whole
 * plan, validate it, and *then* decide whether it may be saved.
 */

export type AssemblePlanInput = {
  tripId: string;
  request: TripRequest;
  destination: GeocodedDestinationRecord;
  strategy: TripStrategy;
  assembly: GeneratedTripAssembly;
  pool: VerifiedPlacePool;
  /** `"generated"` for a model, `"mock"` for the demo planner. See `TripPlan.source`. */
  source: TripPlan["source"];
  createdAt: string;
};

export type AssembledPlan = {
  plan: TripPlan;
  warnings: GenerationWarning[];
};

export class PlanAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanAssemblyError";
  }
}

export function assembleTripPlan(input: AssemblePlanInput): AssembledPlan {
  const warnings: GenerationWarning[] = [];
  const { request, pool } = input;
  const currency = request.currency;

  const poolById = new Map(pool.places.map((place) => [place.placeId, place]));
  const slotById = indexSlots(input.strategy);
  const dayDates = buildDayDates(request);

  /**
   * Days are rebuilt in trip order from *our* date list, not from the model's
   * ordering. A model that returned day 3 before day 1 cannot produce an itinerary
   * whose dates run backwards, and no day can fall outside the requested range —
   * the dates are never read from the model at all.
   */
  const days: ItineraryDay[] = dayDates.map(({ dayNumber, date }) => {
    const assemblyDay = input.assembly.days.find(
      (day) => day.dayNumber === dayNumber,
    );
    if (!assemblyDay) {
      throw new PlanAssemblyError(
        `Assembly is missing day ${dayNumber}, which validation should have caught`,
      );
    }

    const strategyDay = input.strategy.days.find(
      (day) => day.dayNumber === dayNumber,
    );

    const items = buildDayItems({
      dayNumber,
      assemblyItems: assemblyDay.items,
      poolById,
      slotById,
      currency,
      travelers: request.travelers,
      budget: request.budget,
      warnings,
    });

    const backups = buildBackups({
      dayNumber,
      backups: assemblyDay.backups,
      poolById,
      slotById,
      currency,
      travelers: request.travelers,
      warnings,
    });

    return withDerivedDayTotals({
      dayNumber,
      date,
      theme: strategyDay?.theme ?? assemblyDay.title,
      summary: assemblyDay.summary,
      items,
      backups,
      // Recomputed immediately below by `withDerivedDayTotals`; these are the
      // placeholders it overwrites.
      dayTotal: 0,
      totalTravelMinutes: 0,
    });
  });

  const accommodation = buildAccommodation({
    request,
    pool,
    strategy: input.strategy,
    assembly: input.assembly,
    warnings,
  });

  const flights = buildFlightEstimate({ request, strategy: input.strategy });

  const budget = withDerivedBudget(
    {
      currency,
      requestedBudget: request.budget,
      flights: flights.total,
      accommodation: accommodation?.total ?? 0,
      food: sumItems(days, (item) => item.kind === "meal"),
      activities: sumItems(
        days,
        (item) =>
          item.kind !== "meal" &&
          item.kind !== "transport" &&
          item.kind !== "logistics",
      ),
      transport: buildTransportEstimate({
        request,
        strategy: input.strategy,
        itemTransport: sumItems(
          days,
          (item) => item.kind === "transport" || item.kind === "logistics",
        ),
      }),
      // Derived below, from the categories above. Placeholders.
      total: 0,
      remaining: 0,
      perTraveler: 0,
      byDay: [],
    },
    days,
    request.travelers,
  );

  const candidate = {
    id: input.tripId,
    schemaVersion: TRIP_PLAN_SCHEMA_VERSION,
    createdAt: input.createdAt,
    source: input.source,
    request,
    destination: buildDestinationSummary(input),
    flights,
    accommodation,
    budget,
    days,
    practicalNotes: input.assembly.practicalNotes.map(
      (note) => `${note.title} — ${note.body}`,
    ),
    /**
     * Null, always, and it is not an oversight.
     *
     * Generation does not route. The traveller asks for real routes separately,
     * through the Phase 5A orchestration unchanged — which is what keeps a
     * generation from making 20 requests to a donated Valhalla server that nobody
     * asked for. Every travel figure is therefore absent rather than estimated,
     * and the workspace says so.
     */
    routing: null,
  };

  const parsed = TripPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PlanAssemblyError(
      `Generated plan failed schema validation: ${parsed.error.issues[0]?.path.join(".")} — ${parsed.error.issues[0]?.message}`,
    );
  }

  /**
   * The independent gate, on the finished plan.
   *
   * Not a repeat of `validateAssembly`: that checked what the *model said*, this
   * checks what was *built*. It catches an attachment bug — a record edited in
   * flight, a name or a coordinate altered — which no amount of model-output
   * validation could see.
   */
  assertItineraryUsesPool(collectAttached(parsed.data), pool);

  return { plan: parsed.data, warnings };
}

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

type SlotIndex = Map<
  string,
  { category: PlaceCategory; mealType: MealType | null; required: boolean }
>;

function indexSlots(strategy: TripStrategy): SlotIndex {
  const index: SlotIndex = new Map();
  for (const day of strategy.days) {
    for (const slot of day.searchRequirements) {
      index.set(slot.slotId, {
        category: slot.category,
        mealType: slot.mealType,
        required: slot.required,
      });
    }
  }
  return index;
}

function buildDayItems(context: {
  dayNumber: number;
  assemblyItems: AssemblyItem[];
  poolById: Map<string, TripPlace>;
  slotById: SlotIndex;
  currency: Currency;
  travelers: number;
  budget: number;
  warnings: GenerationWarning[];
}): ItineraryItem[] {
  const { dayNumber, poolById, slotById, currency, travelers, warnings } = context;

  /**
   * Chronological order, imposed here rather than trusted.
   *
   * `order` drives the map's numbered markers and the leg derivation, so an
   * itinerary listed out of sequence would produce a route that doubles back for no
   * reason. Items with no time — an unfilled slot the model left unscheduled — sort
   * last, because a gap with no time has no position in the day.
   */
  const ordered = [...context.assemblyItems].sort((a, b) => {
    const aTime = a.startTime ?? null;
    const bTime = b.startTime ?? null;
    if (aTime === null && bTime === null) return 0;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return aTime.localeCompare(bTime);
  });

  let lastEnd = "09:00";

  return ordered.map((item, index) => {
    const base = { id: item.itemId, order: index, travelToNext: null };

    if (item.kind === "place") {
      const canonical = poolById.get(item.placeId);
      if (!canonical) {
        throw new PlanAssemblyError(
          `Item ${item.itemId} references ${item.placeId}, which is not in the pool`,
        );
      }

      const slot = slotById.get(item.slotId);
      const mealType = item.mealType ?? slot?.mealType ?? null;
      const cost = clampPartyCost({
        proposed: item.estimatedCost.amount,
        currency,
        costClass: costClassFor(canonical.category, mealType),
        travelers,
      });

      if (cost.clamped) {
        warnings.push({
          code: "cost_clamped",
          message: `The estimate for “${canonical.name}” was adjusted to the typical range for a ${PLACE_CATEGORY_LABELS[canonical.category].toLowerCase()}.`,
          dayNumber,
          placeId: canonical.placeId,
        });
      }

      lastEnd = item.endTime;

      return {
        ...base,
        kind: kindForCategory(canonical.category, mealType),
        mealType,
        title: item.title,
        rationale: item.description,
        status: "confirmed" as const,
        // The canonical record, attached whole. Nothing above or below this line
        // writes to a field of it.
        place: canonical,
        startTime: item.startTime,
        endTime: item.endTime,
        estimatedCost: cost.amount,
        costNote: costNote(item.estimatedCost.confidence),
        costEstimate: buildCostEstimate({
          amount: cost.amount,
          currency,
          confidence: item.estimatedCost.confidence,
        }),
        bookingRequired: item.reservationRecommended,
        tip: item.notes ?? null,
        locked: false,
      } satisfies ItineraryItem;
    }

    if (item.kind === "non-place") {
      const amount = nonPlaceCost({
        category: item.category,
        proposed: item.estimatedCost.amount,
        budget: context.budget,
      });
      lastEnd = item.endTime;

      return {
        ...base,
        kind: NON_PLACE_KIND[item.category],
        mealType: null,
        title: item.title,
        rationale: item.description,
        status: "confirmed" as const,
        place: null,
        startTime: item.startTime,
        endTime: item.endTime,
        estimatedCost: amount,
        costNote: amount === 0 ? null : costNote("low"),
        costEstimate: buildCostEstimate({ amount, currency, confidence: "low" }),
        bookingRequired: false,
        tip: item.notes ?? null,
        locked: false,
      } satisfies ItineraryItem;
    }

    /**
     * An unfilled slot, kept in the itinerary.
     *
     * It stays visible so the traveller can see there is a gap, and it carries no
     * place, no cost and no marker. Times are synthesised when the model left them
     * out — the schema requires them, and an hour after the previous stop is a
     * truthful placeholder for "this would have gone about here", which is more
     * useful than dropping the gap entirely.
     */
    const slot = slotById.get(item.slotId);
    const startTime = item.startTime ?? lastEnd;
    const endTime = item.endTime ?? addHour(startTime);
    lastEnd = endTime;

    return {
      ...base,
      kind: slot ? kindForCategory(slot.category, slot.mealType) : "rest",
      mealType: slot?.mealType ?? null,
      title: slot
        ? `${PLACE_CATEGORY_LABELS[slot.category]} — none found`
        : "Slot left open",
      rationale: item.reason,
      status: "unavailable" as const,
      place: null,
      startTime,
      endTime,
      estimatedCost: 0,
      costNote: null,
      bookingRequired: false,
      tip: null,
      locked: false,
    } satisfies ItineraryItem;
  });
}

/**
 * Place category → itinerary kind.
 *
 * `mealType` wins: a market at lunchtime scheduled as a meal is a meal, and the
 * budget's food/activities split follows this mapping, so getting it wrong would
 * quietly move money between categories.
 */
export function kindForCategory(
  category: PlaceCategory,
  mealType: MealType | null,
): ItemKind {
  if (mealType !== null) return "meal";

  switch (category) {
    case "restaurant":
    case "cafe":
    case "bar":
    case "fast_food":
    case "winery":
      return "meal";
    case "viewpoint":
      return "viewpoint";
    case "hotel":
    case "hostel":
    case "guest_house":
      return "logistics";
    case "museum":
    case "gallery":
    case "attraction":
    case "monument":
    case "historic_site":
    case "place_of_worship":
    case "theatre":
      return "attraction";
    case "park":
    case "garden":
    case "beach":
      return "experience";
    case "market":
    case "shopping":
    case "music_venue":
      return "experience";
  }
}

const NON_PLACE_KIND: Record<
  "transport" | "free-time" | "airport" | "accommodation",
  ItemKind
> = {
  transport: "transport",
  airport: "transport",
  "free-time": "rest",
  accommodation: "logistics",
};

/**
 * Costs for blocks that are not places.
 *
 * Free time is free. An accommodation block is **zero** rather than a nightly rate:
 * the stay is already a budget line of its own, and pricing the check-in item too
 * would double-count it in every total derived from the day. Transport is capped at
 * a tenth of the budget, which is generous for a taxi and low enough that a
 * misplaced decimal cannot swallow the trip.
 */
function nonPlaceCost(input: {
  category: "transport" | "free-time" | "airport" | "accommodation";
  proposed: number;
  budget: number;
}): number {
  if (input.category === "free-time" || input.category === "accommodation") {
    return 0;
  }
  const ceiling = Math.round(input.budget * 0.1);
  const proposed = Number.isFinite(input.proposed)
    ? Math.max(0, input.proposed)
    : 0;
  return Math.min(ceiling, Math.round(proposed * 100) / 100);
}

function costNote(confidence: "low" | "medium" | "high"): string {
  return `Estimate for the whole party · ${confidence} confidence`;
}

function addHour(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const total = Math.min(23 * 60 + 59, hours * 60 + minutes + 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Backups                                                                     */
/* -------------------------------------------------------------------------- */

function buildBackups(context: {
  dayNumber: number;
  backups: AssemblyBackup[];
  poolById: Map<string, TripPlace>;
  slotById: SlotIndex;
  currency: Currency;
  travelers: number;
  warnings: GenerationWarning[];
}): BackupOption[] {
  const options: BackupOption[] = [];

  for (const backup of context.backups) {
    /**
     * A backup with no place is dropped from the plan and recorded as a warning.
     *
     * `BackupOption` requires a `TripPlace` — a backup is by definition somewhere
     * else to go, and "nowhere else to go" is not a swap-in. The information is not
     * lost: it becomes a visible warning, which is where "the search found no
     * alternative" honestly belongs.
     */
    if (!backup.placeId) {
      context.warnings.push({
        code: "backup_unavailable",
        message:
          backup.unavailableReason ??
          "No alternative was found for one of the day's stops.",
        dayNumber: context.dayNumber,
        slotId: backup.slotId,
      });
      continue;
    }

    const canonical = context.poolById.get(backup.placeId);
    if (!canonical) {
      throw new PlanAssemblyError(
        `Backup ${backup.backupId} references ${backup.placeId}, which is not in the pool`,
      );
    }

    const slot = context.slotById.get(backup.slotId);
    const cost = clampPartyCost({
      proposed: backup.estimatedCost?.amount ?? null,
      currency: context.currency,
      costClass: costClassFor(canonical.category, slot?.mealType ?? null),
      travelers: context.travelers,
    });

    options.push({
      id: backup.backupId,
      // The canonical name, not a model-authored title. A backup card shows where
      // you would go instead, and that is a provider fact.
      title: canonical.name,
      kind: kindForCategory(canonical.category, slot?.mealType ?? null),
      reason: backup.reason,
      place: canonical,
      estimatedCost: cost.amount,
    });
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Destination, accommodation, flights                                         */
/* -------------------------------------------------------------------------- */

function buildDestinationSummary(input: AssemblePlanInput) {
  return {
    // From the geocoder, never from the model. The model was told the resolved
    // name; it does not get to change it.
    city: input.destination.name,
    country: countryFrom(input.destination),
    overview: input.assembly.destinationOverview,
    recommendedNeighborhood: {
      name: input.assembly.recommendedNeighborhood.name,
      why: input.assembly.recommendedNeighborhood.why,
    },
    // The traveller's own interests, echoed back. Nothing to invent.
    bestFor: input.request.interests,
    languageNote: input.strategy.languageNote,
    currencyNote: input.strategy.currencyNote,
    weatherNote: input.strategy.seasonalNote,
    // Nominatim's centre, verbatim. The single most important coordinate in the
    // plan and the one a model has least business supplying.
    center: {
      lat: input.destination.latitude,
      lng: input.destination.longitude,
    },
  };
}

/**
 * The country, from the geocoder's own data.
 *
 * `displayName`'s last comma-separated segment is Nominatim's country, which is why
 * it is preferred over the ISO code — it is already in the right language and needs
 * no lookup table. The code is the fallback, and "Unknown" is the honest last
 * resort: the schema requires a country and we would rather say we do not know than
 * guess one from coordinates.
 */
export function countryFrom(destination: GeocodedDestinationRecord): string {
  const segments = destination.displayName
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const last = segments.at(-1);
  if (last && last.length > 1 && segments.length > 1) return last;
  if (destination.countryCode) return destination.countryCode.toUpperCase();
  return "Unknown";
}

/** Accommodation categories, in the order this request prefers them. */
const STAY_PREFERENCE: Record<TripRequest["accommodation"], PlaceCategory[]> = {
  boutique: ["hotel", "guest_house", "hostel"],
  hotel: ["hotel", "guest_house", "hostel"],
  luxury: ["hotel", "guest_house", "hostel"],
  apartment: ["guest_house", "hotel", "hostel"],
  hostel: ["hostel", "guest_house", "hotel"],
};

function buildAccommodation(context: {
  request: TripRequest;
  pool: VerifiedPlacePool;
  strategy: TripStrategy;
  assembly: GeneratedTripAssembly;
  warnings: GenerationWarning[];
}): TripPlan["accommodation"] {
  const { request, pool } = context;
  const nights = tripNightCount(request);

  const place = pickStay(pool, request.accommodation);
  if (!place) {
    context.warnings.push({
      code: "accommodation_unavailable",
      message:
        "No hotel, hostel or guest house is mapped in OpenStreetMap near this destination, so no place to stay is recommended.",
    });
    return null;
  }

  /**
   * The nightly rate comes from the traveller's own budget share, clamped into the
   * band for a room. The model allocated the share; it did not price the room, and
   * this is the difference in practice.
   */
  const share = context.strategy.budgetAllocation.accommodation * request.budget;
  const perNight = clampPartyCost({
    proposed: nights > 0 ? share / nights : share,
    currency: request.currency,
    costClass: "night",
    travelers: request.travelers,
  });

  return {
    place,
    style: request.accommodation,
    neighborhood: context.assembly.recommendedNeighborhood.name,
    nightlyRate: perNight.amount,
    nights,
    total: Math.round(perNight.amount * nights * 100) / 100,
    /**
     * Honest about how this was chosen.
     *
     * The demo planner and the model both select a stay by *category and
     * proximity* — nothing in the pool says whether a hotel is any good, so any
     * sentence implying otherwise would be invented. Saying so plainly is better
     * copy than a fabricated compliment.
     */
    whyItFits: `A ${PLACE_CATEGORY_LABELS[place.category].toLowerCase()} found in OpenStreetMap near the centre of ${context.assembly.recommendedNeighborhood.name}, matching your ${request.accommodation} preference by kind. OpenStreetMap carries no ratings or rates, so this is a starting point to check rather than a recommendation — and the nightly figure below is estimated from your budget, not quoted.`,
    // Only what OSM actually recorded. No invented breakfast, pool or wifi.
    amenities: stayAmenities(place),
    isEstimate: true,
  };
}

/**
 * The first matching stay in pool order.
 *
 * Pool order is category-then-name, so this is deterministic and arbitrary — and
 * arbitrary is the honest answer. Choosing "the best" would need a quality signal,
 * OpenStreetMap has none, and a made-up ranking is worse than an admitted
 * alphabetical one.
 */
export function pickStay(
  pool: VerifiedPlacePool,
  style: TripRequest["accommodation"],
): TripPlace | null {
  for (const category of STAY_PREFERENCE[style]) {
    const match = pool.places.find((place) => place.category === category);
    if (match) return match;
  }
  return null;
}

function stayAmenities(place: TripPlace): string[] {
  const amenities: string[] = [];
  if (place.wheelchair === "yes" || place.wheelchair === "designated") {
    amenities.push("Step-free access recorded in OpenStreetMap");
  }
  if (place.website) amenities.push("Has a website on record");
  if (place.phone) amenities.push("Has a phone number on record");
  if (place.address) amenities.push(place.address);
  return amenities;
}

function buildFlightEstimate(context: {
  request: TripRequest;
  strategy: TripStrategy;
}): TripPlan["flights"] {
  const { request } = context;
  const band = flightBandFor(request.currency);

  const share = context.strategy.budgetAllocation.flights * request.budget;
  const perTraveler = Math.min(
    band.max,
    Math.max(band.min, Math.round(share / Math.max(1, request.travelers))),
  );

  return {
    isEstimate: true,
    departureCity: request.departureCity,
    destinationCity: request.destination,
    perTraveler,
    total: Math.round(perTraveler * request.travelers * 100) / 100,
    cabin: "Economy",
    /**
     * Deliberately non-committal.
     *
     * A duration and a stop count are route facts, and we have no flight data of any
     * kind — no schedules, no carriers, no distances. The schema requires both
     * fields, so they say what is true: we do not know. Filling them with a
     * plausible "8 hr 45 min" would be the most easily believed fabrication in the
     * whole plan.
     */
    typicalDuration: "Not known — check the search link",
    typicalStops: "Not known — check the search link",
    // A search deep link, not a booking endpoint and not an API call.
    searchUrl: flightSearchUrl(request),
    basis: FLIGHT_ESTIMATE_BASIS,
  };
}

function flightSearchUrl(request: TripRequest): string {
  const query = `flights from ${request.departureCity} to ${request.destination}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

/**
 * Local transport.
 *
 * The floor is whatever the itinerary's own transport blocks already cost, so the
 * category can never report less than the items it contains. The ceiling is a
 * quarter of the budget.
 */
function buildTransportEstimate(context: {
  request: TripRequest;
  strategy: TripStrategy;
  itemTransport: number;
}): number {
  const share =
    context.strategy.budgetAllocation.localTransport * context.request.budget;
  const ceiling = context.request.budget * 0.25;
  return (
    Math.round(
      Math.min(ceiling, Math.max(context.itemTransport, share)) * 100,
    ) / 100
  );
}

/* -------------------------------------------------------------------------- */

function buildDayDates(
  request: TripRequest,
): { dayNumber: number; date: string }[] {
  const start = parseISO(request.startDate);
  const dayCount = tripNightCount(request) + 1;
  return Array.from({ length: dayCount }, (_, index) => ({
    dayNumber: index + 1,
    date: format(addDays(start, index), "yyyy-MM-dd"),
  }));
}

function sumItems(
  days: ItineraryDay[],
  predicate: (item: ItineraryItem) => boolean,
): number {
  const total = days
    .flatMap((day) => day.items)
    .filter(predicate)
    .reduce((sum, item) => sum + item.estimatedCost, 0);
  return Math.round(total * 100) / 100;
}

/**
 * Every attached place, including backups.
 *
 * Backups are included deliberately — they are shown to the traveller as real
 * alternatives with real names, so a fabricated backup would be exactly as
 * dishonest as a fabricated stop, and `derivePlanPlacePool` does not collect them.
 */
function collectAttached(plan: TripPlan): TripPlace[] {
  const places = plan.days.flatMap((day) => [
    ...day.items.flatMap((item) => (item.place ? [item.place] : [])),
    ...day.backups.map((backup) => backup.place),
  ]);
  const stay = plan.accommodation?.place;
  return stay ? [...places, stay] : places;
}
