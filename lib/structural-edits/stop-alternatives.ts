import { formatDistance } from "@/lib/format";
import { evaluateItem } from "@/lib/plan";
import type { OpeningEvaluation } from "@/lib/opening-hours";
import { INDOOR_CATEGORIES } from "@/lib/refinement/candidates";
import { haversineMeters } from "@/lib/routing";
import {
  DIETARY_OPTIONS,
  type CostEstimate,
  type Currency,
  type Dietary,
  type ItineraryDay,
  type ItineraryItem,
  type PlaceCategory,
  type TripGenerationContext,
  type TripPlace,
  type TripPlan,
} from "@/lib/schemas";

import { alternativesForItem } from "./alternatives";
import { locateItem } from "./locate";
import { prepareStructuralCommand } from "./prepare";
import type { StructuralEditErrorCode } from "./types";

/**
 * A stop's alternatives, each with the reasons it differs and what choosing it would do.
 *
 * ## What this adds to `alternativesForItem`, and what it deliberately does not
 *
 * `alternativesForItem` answers *which places may be offered*. It is cheap, it runs for every
 * rendered card to decide whether the Swap control exists at all, and it stays exactly as it was.
 * This module answers the second question — *how does each one compare, and what happens if I pick
 * it* — and it is expensive enough (one full applier run per alternative) that it must only be
 * derived for the one stop whose picker is open.
 *
 * The membership is not re-decided here. This calls `alternativesForItem` and describes what it
 * returns, so the count on the Swap control and the cards in the list cannot come apart.
 *
 * ## Every claim is a fact we hold, or it is not made
 *
 * The vocabulary in `ALTERNATIVE_FACT_LABELS` is closed, and it is closed against a specific
 * failure: a comparison card is exactly the surface where "different" quietly becomes "better".
 * Roamly has no ratings from OpenStreetMap, no review counts, no crowding, no weather and no
 * quality signal of any kind, so there is nothing here that ranks — only geometry, published
 * hours, the planning-estimate bands, and provider tags read verbatim.
 *
 * The distances are **straight-line** and say so. Nothing has routed an alternative, and a routed
 * figure is the one number a traveller would plan around.
 *
 * ## The schedule preview runs the real edit
 *
 * `prepareStructuralCommand` applies the swap and stops short of writing, exactly as the drag
 * indicator and the length editor do. So the times, the invalidated legs, the resulting cost and
 * any refusal are the ones the save would produce — not a second derivation that could disagree
 * with it. That is why a refused alternative is shown disabled with its reason rather than hidden:
 * we know the reason, and hiding an option while claiming to list the alternatives is the dishonest
 * half of the two defensible choices.
 *
 * Pure: no clock beyond the day's own date, no network, no model, no store.
 */

/* -------------------------------------------------------------------------- */
/* The fact vocabulary                                                        */
/* -------------------------------------------------------------------------- */

export type AlternativeRelationFactKind =
  /* -- implied by the same-category rule, so true of every option ---------- */
  | "same-category"
  | "indoor-option"
  | "outdoor-option"
  /* -- geometry ------------------------------------------------------------ */
  | "closer-to-previous-stop"
  | "further-from-previous-stop"
  /* -- published hours, for the window this stop already occupies ---------- */
  | "fits-current-time-window"
  | "closed-in-current-time-window"
  | "opening-hours-unknown"
  /* -- the planning-estimate model, never a price -------------------------- */
  | "lower-planning-estimate"
  | "same-planning-estimate"
  | "higher-planning-estimate"
  /* -- provider tags, read verbatim ---------------------------------------- */
  | "has-outdoor-seating"
  | "matches-recorded-dietary-need";

/**
 * The only wording these facts may use.
 *
 * Centralised and asserted in tests, the same discipline `lib/routing/format.ts` applies to travel
 * time and `cost-bands.ts` to money. A reviewer should not have to remember that "best",
 * "top-rated", "more popular", "hidden gem", "safer", "less crowded", "more scenic", "better
 * reviews" and "local favourite" are all claims this application cannot evidence — the test says
 * so, and it fails.
 */
export const ALTERNATIVE_FACT_LABELS: Record<
  AlternativeRelationFactKind,
  string
> = {
  "same-category": "Same category",
  "indoor-option": "Indoor option",
  "outdoor-option": "Outdoor option",
  "closer-to-previous-stop": "Closer to the previous stop",
  "further-from-previous-stop": "Further from the previous stop",
  "fits-current-time-window": "Fits the current time window",
  "closed-in-current-time-window": "Closed during the current time window",
  "opening-hours-unknown": "Opening hours not published",
  "lower-planning-estimate": "Lower planning estimate",
  "same-planning-estimate": "Same planning estimate",
  "higher-planning-estimate": "Higher planning estimate",
  "has-outdoor-seating": "Has outdoor seating",
  "matches-recorded-dietary-need": "Matches the recorded dietary need",
};

export type AlternativeRelationFact = {
  kind: AlternativeRelationFactKind;
  /** From `ALTERNATIVE_FACT_LABELS`. Never composed at the call site. */
  label: string;
  /**
   * The measurement behind the label, when there is one — "180 m closer in a straight line".
   *
   * A qualifier, never a claim of its own: every detail here names its own basis, because
   * "180 m closer" without "in a straight line" would be read as a walking distance.
   */
  detail?: string;
  /**
   * True when the same-category rule guarantees this fact holds for *every* alternative.
   *
   * Such a fact is real but carries no comparative information, so the panel states it once for
   * the group rather than repeating it on each card. Flagged in the data rather than decided in
   * the component, so the rendering rule is testable without a renderer.
   */
  universal: boolean;
  /** `caution` is for a confirmed problem only. An unknown is not a warning. */
  tone: "neutral" | "caution";
};

/* -------------------------------------------------------------------------- */
/* The model                                                                  */
/* -------------------------------------------------------------------------- */

export type StopAlternativeSchedulePreview = {
  /**
   * `valid` does **not** mean the place is confirmed open — it means the edit holds and no
   * published rule says it is shut. Read `openingHoursStatus` for which kind of answer that is.
   */
  status: "valid" | "warning" | "invalid";
  resultingStartTime: string;
  resultingEndTime: string;
  openingHoursStatus: OpeningEvaluation;
  /**
   * Legs whose stored measurement would stop describing a real adjacency, plus any that would
   * newly exist. Measured by the commit from before-and-after, not claimed by the applier.
   */
  affectedRouteLegIds: string[];
  /** Present only on `invalid`. The applier's own code; its sentence is in `refusalMessage`. */
  refusalCode?: StructuralEditErrorCode;
  refusalMessage?: string;
};

export type StopAlternative = {
  placeId: string;
  /** The pool's record, unchanged. Identity travels as a `placeId`; this is for recognition. */
  canonicalPlace: TripPlace;
  relationFacts: AlternativeRelationFact[];
  schedulePreview: StopAlternativeSchedulePreview;
  /**
   * The figure this stop would carry after the swap, read out of the prepared plan.
   *
   * `provenance` is the stop's own `CostEstimate` when it has one — amount, currency, basis,
   * confidence and the disclaimer that keeps it from reading as a price. Absent when the stop
   * carries a bare number with no recorded provenance, which is a real state for older plans and
   * is not backfilled.
   */
  estimatedCost: {
    amount: number;
    currency: Currency;
    provenance?: CostEstimate;
  };
};

/**
 * How far apart two straight-line distances must be before it is worth saying so.
 *
 * Below this the difference is smaller than the error a straight line already carries against a
 * real walking route, and "12 m closer" would be precision we have not earned.
 */
const MINIMUM_NOTEWORTHY_METRES = 50;

/** Categories where a `cuisine` tag describes a menu rather than incidental catering. */
const MENU_CATEGORIES: ReadonlySet<PlaceCategory> = new Set([
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
]);

/**
 * Dietary needs an OSM `cuisine` tag can evidence, and the values that evidence them.
 *
 * The normalizer captures `cuisine` and nothing else — no `diet:*` tags — so this is the whole of
 * what can be claimed. `gluten-free`, `no-pork` and `no-shellfish` are deliberately absent: no
 * field in `TripPlace` speaks to them, and a card that stayed silent on three needs while
 * confirming four would be read as clearing all seven.
 *
 * Positive claims only. A place with no `cuisine` tag is unknown, never non-compliant — the same
 * rule the opening-hours domain holds to.
 */
const DIETARY_CUISINE_EVIDENCE: Partial<Record<Dietary, readonly string[]>> = {
  vegetarian: ["vegetarian", "vegan"],
  vegan: ["vegan"],
  halal: ["halal"],
  kosher: ["kosher"],
};

const DIETARY_LABELS = new Map(
  DIETARY_OPTIONS.map((option) => [option.value, option.label]),
);

/* -------------------------------------------------------------------------- */
/* The derivation                                                             */
/* -------------------------------------------------------------------------- */

export function stopAlternatives(input: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
  dayNumber: number;
  itemId: string;
  /** From the generation context. Absent means hours cannot be judged. */
  timezone?: string | null;
  /** Only reaches `summary.revisionBefore`, which nothing here renders. */
  revisionBefore: number;
  limit?: number;
}): StopAlternative[] {
  const generation = input.generation;
  if (!generation) return [];

  const located = locateItem(input.plan, input.dayNumber, input.itemId);
  if (!located.ok) return [];

  const { day, item } = located.value;
  const current = item.place;
  if (!current) return [];

  const places = alternativesForItem({
    plan: input.plan,
    generation,
    dayNumber: input.dayNumber,
    itemId: input.itemId,
    timezone: input.timezone ?? null,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });

  const previous = previousPlaceOnDay(day, item.id);

  const described = places.map((place) =>
    describeAlternative({
      plan: input.plan,
      generation,
      day,
      item,
      current,
      previous,
      place,
      timezone: input.timezone ?? null,
      revisionBefore: input.revisionBefore,
    }),
  );

  return orderAlternatives(described, current);
}

/**
 * Open first, then nearest to the place being replaced, then name, then id.
 *
 * ## Why the anchor is the current place and not the previous stop
 *
 * A swap disturbs two adjacencies — the leg coming in and the leg going out — and a place near the
 * one being replaced leaves both roughly as they were. Anchoring on the previous stop would rank
 * by the inbound leg alone and could put the day's furthest detour first because it happened to
 * sit close behind. It is also always defined, where a previous stop is not: the first stop of a
 * day has none.
 *
 * The previous stop still appears as a *fact*, because "closer to where you are coming from" is
 * the comparison a traveller actually reads. It just does not decide the order.
 *
 * Rounded to the metre before comparing, so float noise cannot make the order depend on which two
 * places happen to be a fraction of a millimetre apart. Total and stable: the same plan and pool
 * always produce the same list.
 */
function orderAlternatives(
  alternatives: StopAlternative[],
  current: TripPlace,
): StopAlternative[] {
  const rank = (entry: StopAlternative): number => {
    switch (entry.schedulePreview.openingHoursStatus.status) {
      case "confirmed_open":
        return 0;
      case "confirmed_closed":
        return 2;
      default:
        return 1;
    }
  };

  const distanceOf = new Map(
    alternatives.map((entry) => [
      entry.placeId,
      metresBetween(current, entry.canonicalPlace),
    ]),
  );

  return [...alternatives].sort((a, b) => {
    const byHours = rank(a) - rank(b);
    if (byHours !== 0) return byHours;

    const byDistance =
      (distanceOf.get(a.placeId) ?? 0) - (distanceOf.get(b.placeId) ?? 0);
    if (Math.round(byDistance) !== 0) return byDistance;

    const byName = a.canonicalPlace.name.localeCompare(
      b.canonicalPlace.name,
      "en",
    );
    if (byName !== 0) return byName;

    return a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : 0;
  });
}

function describeAlternative(input: {
  plan: TripPlan;
  generation: TripGenerationContext;
  day: ItineraryDay;
  item: ItineraryItem;
  current: TripPlace;
  previous: TripPlace | null;
  place: TripPlace;
  timezone: string | null;
  revisionBefore: number;
}): StopAlternative {
  const prepared = prepareStructuralCommand({
    plan: input.plan,
    generation: input.generation,
    revisionBefore: input.revisionBefore,
    timezone: input.timezone,
    command: {
      type: "select-alternative",
      dayNumber: input.day.dayNumber,
      itemId: input.item.id,
      alternativePlaceId: input.place.placeId,
    },
  });

  /**
   * The refused arm, which `alternativesForItem` should make unreachable and which is handled
   * anyway.
   *
   * The picker filters on `alternativeIsSelectable`, so every gate the applier checks up front has
   * already passed. What remains is the commit's own verdict — a schedule the swapped day no
   * longer satisfies, say — and that is a real possibility rather than a defensive nothing. The
   * card is rendered disabled with the applier's sentence, so the traveller sees the option and
   * the reason together instead of an option that fails under their finger.
   */
  if (prepared.status === "refused") {
    const openingHours = evaluateItem(
      { ...input.item, place: input.place },
      input.day.date,
      input.timezone ?? undefined,
    );

    return {
      placeId: input.place.placeId,
      canonicalPlace: input.place,
      relationFacts: relationFacts({
        plan: input.plan,
        current: input.current,
        previous: input.previous,
        place: input.place,
        openingHours,
        currentAmount: input.item.estimatedCost,
        alternativeAmount: input.item.estimatedCost,
      }),
      schedulePreview: {
        status: "invalid",
        resultingStartTime: input.item.startTime,
        resultingEndTime: input.item.endTime,
        openingHoursStatus: openingHours,
        affectedRouteLegIds: [],
        refusalCode: prepared.errors[0].code,
        refusalMessage: prepared.message,
      },
      estimatedCost: {
        amount: input.item.estimatedCost,
        currency: input.plan.request.currency,
        ...(input.item.costEstimate
          ? { provenance: input.item.costEstimate }
          : {}),
      },
    };
  }

  /**
   * Everything below is read out of the plan the applier built, not predicted.
   *
   * The same reasoning `describeEditedItem` rests on: re-deriving the resulting cost from
   * `clampPartyCost` here would agree with the applier until one of them changed, and the
   * disagreement would surface as a card promising a figure the save then stores differently.
   */
  const swapped = findItem(prepared.plan, input.item.id);
  const day = findDay(prepared.plan, input.day.dayNumber);

  const openingHours =
    swapped && day
      ? evaluateItem(swapped, day.date, input.timezone ?? undefined)
      : evaluateItem(
          { ...input.item, place: input.place },
          input.day.date,
          input.timezone ?? undefined,
        );

  const amount = swapped?.estimatedCost ?? input.item.estimatedCost;
  const provenance = swapped?.costEstimate ?? input.item.costEstimate;

  return {
    placeId: input.place.placeId,
    canonicalPlace: input.place,
    relationFacts: relationFacts({
      plan: input.plan,
      current: input.current,
      previous: input.previous,
      place: input.place,
      openingHours,
      currentAmount: input.item.estimatedCost,
      alternativeAmount: amount,
    }),
    schedulePreview: {
      /**
       * `warning` is reserved for a published rule that says the place is shut for this window.
       *
       * Route invalidation is deliberately not a warning: on a routed trip a swap clears the
       * measurements around the stop whichever place is chosen, so treating that as a caution
       * would mark every option and distinguish none. It is reported as a count instead.
       */
      status: openingHours.status === "confirmed_closed" ? "warning" : "valid",
      resultingStartTime: swapped?.startTime ?? input.item.startTime,
      resultingEndTime: swapped?.endTime ?? input.item.endTime,
      openingHoursStatus: openingHours,
      affectedRouteLegIds: [
        ...new Set([
          ...prepared.summary.invalidatedLegIds,
          ...prepared.summary.addedLegIds,
        ]),
      ].sort(),
    },
    estimatedCost: {
      amount,
      currency: input.plan.request.currency,
      ...(provenance ? { provenance } : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The facts                                                                  */
/* -------------------------------------------------------------------------- */

function relationFacts(input: {
  plan: TripPlan;
  current: TripPlace;
  previous: TripPlace | null;
  place: TripPlace;
  openingHours: OpeningEvaluation;
  currentAmount: number;
  alternativeAmount: number;
}): AlternativeRelationFact[] {
  const facts: AlternativeRelationFact[] = [];

  /*
   * The three the same-category rule guarantees.
   *
   * Emitted rather than omitted, because the model should describe an alternative completely — a
   * consumer reading one entry in isolation is owed the kind of place it is. Flagged `universal`
   * so the panel states them once for the group instead of five times down the list.
   */
  facts.push(fact("same-category", { universal: true }));
  facts.push(
    INDOOR_CATEGORIES.has(input.place.category)
      ? fact("indoor-option", { universal: true })
      : fact("outdoor-option", { universal: true }),
  );

  /* -- geometry, against the stop this one would follow -------------------- */

  if (input.previous) {
    const before = metresBetween(input.previous, input.current);
    const after = metresBetween(input.previous, input.place);
    const difference = Math.round(before - after);

    if (difference >= MINIMUM_NOTEWORTHY_METRES) {
      facts.push(
        fact("closer-to-previous-stop", {
          detail: `${formatDistance(difference)} closer in a straight line`,
        }),
      );
    } else if (-difference >= MINIMUM_NOTEWORTHY_METRES) {
      facts.push(
        fact("further-from-previous-stop", {
          detail: `${formatDistance(-difference)} further in a straight line`,
        }),
      );
    }
  }

  /* -- published hours, for the window the stop already occupies ----------- */

  if (input.openingHours.status === "confirmed_open") {
    facts.push(fact("fits-current-time-window"));
  } else if (input.openingHours.status === "confirmed_closed") {
    facts.push(
      fact("closed-in-current-time-window", {
        tone: "caution",
        ...(input.openingHours.nextKnownOpening
          ? { detail: `Opens at ${input.openingHours.nextKnownOpening}` }
          : {}),
      }),
    );
  } else if (input.openingHours.status !== "not_applicable") {
    facts.push(fact("opening-hours-unknown"));
  }

  /* -- the planning estimate ----------------------------------------------- */

  facts.push(
    estimateFact(
      input.currentAmount,
      input.alternativeAmount,
      input.plan.request.currency,
    ),
  );

  /* -- provider tags, read verbatim ---------------------------------------- */

  if (input.place.outdoorSeating === true) {
    facts.push(fact("has-outdoor-seating"));
  }

  const dietary = matchedDietaryNeeds(input.plan.request.dietary, input.place);
  if (dietary.length > 0) {
    facts.push(
      fact("matches-recorded-dietary-need", {
        detail: `${dietary.join(", ")}, from the place's own cuisine tag`,
      }),
    );
  }

  return facts;
}

/**
 * Cheaper, the same, or dearer — compared, never assumed.
 *
 * ## Why all three arms exist when only one can currently fire
 *
 * `costClassFor` derives the band from the category and the meal type, and an alternative always
 * shares both, so `clampPartyCost` returns an identical figure every time — `same-planning-estimate`
 * is the only outcome a same-category swap can currently produce. That is a fact about the estimate
 * model, and the honest way to express it is to *measure* and report what the measurement says.
 *
 * Hard-coding "same" would be the same answer today and a silent lie the first time the estimate
 * model gains a per-place input or the swap rule widens across categories. This comparison would
 * simply start telling the truth.
 *
 * Exported so all three arms can be tested directly rather than through a fixture that cannot
 * currently produce two of them.
 */
export function estimateFact(
  currentAmount: number,
  alternativeAmount: number,
  currency: Currency,
): AlternativeRelationFact {
  const difference = round(alternativeAmount - currentAmount);

  if (difference === 0) return fact("same-planning-estimate");

  const detail = `${currency} ${Math.abs(difference).toFixed(2)} against this stop's current estimate`;

  return difference < 0
    ? fact("lower-planning-estimate", { detail })
    : fact("higher-planning-estimate", { detail });
}

/**
 * Which recorded dietary needs this place's own `cuisine` tag evidences.
 *
 * `none` is not a need and matches nothing. A need with no tag that could evidence it produces no
 * fact at all — never a negative one, because the absence of a `cuisine` value is a fact about
 * OpenStreetMap's coverage and not about the kitchen.
 */
export function matchedDietaryNeeds(
  dietary: readonly Dietary[],
  place: TripPlace,
): string[] {
  if (!MENU_CATEGORIES.has(place.category)) return [];

  const tags = new Set(
    (place.cuisine ?? []).map((entry) => entry.trim().toLowerCase()),
  );
  if (tags.size === 0) return [];

  const matched: string[] = [];

  for (const need of dietary) {
    if (need === "none") continue;
    const evidence = DIETARY_CUISINE_EVIDENCE[need];
    if (!evidence) continue;
    if (!evidence.some((value) => tags.has(value))) continue;
    matched.push(DIETARY_LABELS.get(need) ?? need);
  }

  return matched;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function fact(
  kind: AlternativeRelationFactKind,
  options: {
    detail?: string;
    universal?: boolean;
    tone?: AlternativeRelationFact["tone"];
  } = {},
): AlternativeRelationFact {
  return {
    kind,
    label: ALTERNATIVE_FACT_LABELS[kind],
    ...(options.detail ? { detail: options.detail } : {}),
    universal: options.universal ?? false,
    tone: options.tone ?? "neutral",
  };
}

/** The nearest stop above this one on the day that has a place. Free time is skipped. */
function previousPlaceOnDay(
  day: ItineraryDay,
  itemId: string,
): TripPlace | null {
  const index = day.items.findIndex((entry) => entry.id === itemId);
  if (index <= 0) return null;

  for (let position = index - 1; position >= 0; position -= 1) {
    const place = day.items[position].place;
    if (place) return place;
  }
  return null;
}

function metresBetween(a: TripPlace, b: TripPlace): number {
  return haversineMeters(
    { latitude: a.coordinates.lat, longitude: a.coordinates.lng },
    { latitude: b.coordinates.lat, longitude: b.coordinates.lng },
  );
}

function findItem(plan: TripPlan, itemId: string): ItineraryItem | null {
  for (const day of plan.days) {
    const item = day.items.find((entry) => entry.id === itemId);
    if (item) return item;
  }
  return null;
}

function findDay(plan: TripPlan, dayNumber: number): ItineraryDay | null {
  return plan.days.find((day) => day.dayNumber === dayNumber) ?? null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
