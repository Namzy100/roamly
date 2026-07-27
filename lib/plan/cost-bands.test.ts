import { describe, expect, it } from "vitest";

import type { Currency, PlaceCategory } from "@/lib/schemas";

import {
  COST_ESTIMATE_DISCLAIMER,
  bandFor,
  buildCostEstimate,
  clampPartyCost,
  costClassFor,
  flightBandFor,
} from "./cost-bands";

const CURRENCIES: Currency[] = ["EUR", "USD", "GBP", "AED"];

describe("costClassFor", () => {
  it("refines a restaurant by which meal it is serving", () => {
    expect(costClassFor("restaurant", "breakfast")).toBe("snack");
    expect(costClassFor("restaurant", "lunch")).toBe("casual-meal");
    expect(costClassFor("restaurant", "dinner")).toBe("sit-down-meal");
  });

  it("treats a snack slot as a snack whatever the place is", () => {
    expect(costClassFor("market", "snack")).toBe("snack");
  });

  /**
   * A traveller may well spend money at a market, and a note can say so. The *entry*
   * cost of a market is zero, and a non-zero default would put invented spending in
   * the budget.
   */
  it("charges nothing to be at a place that is free to enter", () => {
    for (const category of [
      "park",
      "garden",
      "beach",
      "viewpoint",
      "monument",
      "market",
      "place_of_worship",
      "shopping",
    ] as PlaceCategory[]) {
      expect(costClassFor(category, null), category).toBe("free");
    }
  });

  it("classifies every allowlisted category", () => {
    for (const category of [
      "restaurant", "cafe", "bar", "fast_food", "hotel", "hostel", "guest_house",
      "museum", "gallery", "attraction", "monument", "viewpoint", "park", "garden",
      "beach", "market", "place_of_worship", "theatre", "music_venue", "shopping",
      "winery", "historic_site",
    ] as PlaceCategory[]) {
      expect(costClassFor(category, null), category).toBeTruthy();
    }
  });
});

describe("bands", () => {
  it("covers every supported currency with an ordered band", () => {
    for (const currency of CURRENCIES) {
      for (const costClass of [
        "snack",
        "casual-meal",
        "sit-down-meal",
        "premium-meal",
        "ticket",
        "night",
      ] as const) {
        const band = bandFor(currency, costClass);
        expect(band.min, `${currency} ${costClass}`).toBeLessThanOrEqual(band.typical);
        expect(band.typical, `${currency} ${costClass}`).toBeLessThanOrEqual(band.max);
      }
    }
  });

  /**
   * The tables are independent by design. If any pair were a fixed multiple of
   * another, someone would have derived one from the other with an invented exchange
   * rate — a live financial fact we have no feed for.
   */
  it("is not a currency conversion of one base table", () => {
    const ratios = (["snack", "ticket", "night"] as const).map(
      (costClass) =>
        bandFor("USD", costClass).typical / bandFor("EUR", costClass).typical,
    );

    expect(new Set(ratios.map((ratio) => ratio.toFixed(4))).size).toBeGreaterThan(1);
  });

  it("keeps free free in every currency", () => {
    for (const currency of CURRENCIES) {
      expect(bandFor(currency, "free")).toEqual({ min: 0, typical: 0, max: 0 });
    }
  });

  it("gives flights a deliberately wide band", () => {
    for (const currency of CURRENCIES) {
      const band = flightBandFor(currency);
      // Wide, because the input that would narrow it — the actual route — is not
      // something we price. A confident narrow band would be more dishonest.
      expect(band.max / band.min).toBeGreaterThan(10);
    }
  });
});

describe("clampPartyCost", () => {
  it("uses the typical figure when nothing was proposed", () => {
    const result = clampPartyCost({
      proposed: null,
      currency: "EUR",
      costClass: "ticket",
      travelers: 2,
    });

    expect(result.amount).toBe(bandFor("EUR", "ticket").typical * 2);
    expect(result.clamped).toBe(false);
  });

  it("leaves a figure inside its band alone", () => {
    const result = clampPartyCost({
      proposed: 24,
      currency: "EUR",
      costClass: "ticket",
      travelers: 2,
    });

    expect(result).toEqual({ amount: 24, clamped: false });
  });

  it("pulls an absurd figure down and reports the clamp", () => {
    const result = clampPartyCost({
      proposed: 9_000,
      currency: "EUR",
      costClass: "snack",
      travelers: 2,
    });

    expect(result.amount).toBe(bandFor("EUR", "snack").max * 2);
    // Reported rather than applied silently: a model whose figures are routinely
    // clamped is worth knowing about.
    expect(result.clamped).toBe(true);
  });

  it("raises a figure below the floor", () => {
    const result = clampPartyCost({
      proposed: 1,
      currency: "EUR",
      costClass: "sit-down-meal",
      travelers: 2,
    });

    expect(result.amount).toBe(bandFor("EUR", "sit-down-meal").min * 2);
    expect(result.clamped).toBe(true);
  });

  it("scales with the party for everything except a room", () => {
    const meal = clampPartyCost({
      proposed: null,
      currency: "EUR",
      costClass: "sit-down-meal",
      travelers: 4,
    });
    expect(meal.amount).toBe(bandFor("EUR", "sit-down-meal").typical * 4);

    // A double room is not two singles: four travellers are two rooms.
    const room = clampPartyCost({
      proposed: null,
      currency: "EUR",
      costClass: "night",
      travelers: 4,
    });
    expect(room.amount).toBe(bandFor("EUR", "night").typical * 2);
  });

  it("rounds a single traveller's room up to one room", () => {
    const room = clampPartyCost({
      proposed: null,
      currency: "EUR",
      costClass: "night",
      travelers: 1,
    });

    expect(room.amount).toBe(bandFor("EUR", "night").typical);
  });

  it("keeps free at zero and never clamps it upwards", () => {
    const result = clampPartyCost({
      proposed: 40,
      currency: "EUR",
      costClass: "free",
      travelers: 2,
    });

    expect(result.amount).toBe(0);
    expect(result.clamped).toBe(true);
  });

  it("treats a negative or non-finite proposal as unusable rather than propagating it", () => {
    expect(
      clampPartyCost({
        proposed: -50,
        currency: "EUR",
        costClass: "ticket",
        travelers: 2,
      }).amount,
    ).toBeGreaterThanOrEqual(0);

    expect(
      clampPartyCost({
        proposed: Number.NaN,
        currency: "EUR",
        costClass: "ticket",
        travelers: 2,
      }).amount,
    ).toBe(bandFor("EUR", "ticket").typical * 2);
  });

  it("returns money rounded to two places", () => {
    const result = clampPartyCost({
      proposed: 12.3456,
      currency: "EUR",
      costClass: "ticket",
      travelers: 2,
    });

    expect(result.amount).toBe(12.35);
  });
});

describe("buildCostEstimate", () => {
  it("is the only honest way to construct one — basis and disclaimer are not optional", () => {
    const estimate = buildCostEstimate({
      amount: 32.5,
      currency: "EUR",
      confidence: "low",
    });

    expect(estimate).toEqual({
      amount: 32.5,
      currency: "EUR",
      // The only basis a generated figure may claim.
      basis: "category-estimate",
      confidence: "low",
      disclaimer: COST_ESTIMATE_DISCLAIMER,
    });
  });

  it("says it is not a live price, a quote, or checked", () => {
    // Centralised wording, asserted rather than left to a reviewer to remember.
    expect(COST_ESTIMATE_DISCLAIMER).toMatch(/not a live price/i);
    expect(COST_ESTIMATE_DISCLAIMER).toMatch(/not a quote/i);
    expect(COST_ESTIMATE_DISCLAIMER).toMatch(/whole party/i);
  });
});
