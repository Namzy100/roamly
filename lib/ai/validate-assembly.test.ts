import { describe, expect, it } from "vitest";

import {
  FIXTURE_PLACES,
  cost,
  fixtureAssembly,
  fixturePool,
  fixtureStrategy,
  placeItemAt,
} from "@/lib/generate/test-fixtures";

import { minutesOfDay, validateAssembly } from "./validate-assembly";

function validate(raw: unknown, currency: "EUR" | "USD" = "EUR") {
  return validateAssembly({
    raw,
    pool: fixturePool(),
    strategy: fixtureStrategy(),
    currency,
  });
}

function codes(result: ReturnType<typeof validate>): string[] {
  return result.violations.map((violation) => violation.code);
}

describe("validateAssembly", () => {
  it("accepts the baseline assembly", () => {
    const result = validate(fixtureAssembly());

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  describe("identity — the checks that fail the whole generation", () => {
    it("rejects a placeId that is not in the pool", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[0].items[0];
      if (item.kind !== "place") throw new Error("fixture changed shape");
      item.placeId = "osm:node:999999";

      const result = validate(assembly);
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("place_outside_pool");
    });

    it("rejects a plausible-looking id that was never discovered", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[0].items[1];
      if (item.kind !== "place") throw new Error("fixture changed shape");
      // Same shape as a real canonical id — only membership distinguishes it.
      item.placeId = "osm:way:2001";

      expect(codes(validate(assembly))).toContain("place_outside_pool");
    });

    it("rejects a backup outside the pool", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].backups[0].placeId = "osm:node:424242";

      expect(codes(validate(assembly))).toContain("backup_outside_pool");
    });

    it("rejects an attached provider fact beside the placeId", () => {
      const assembly = JSON.parse(
        JSON.stringify(fixtureAssembly()),
      ) as Record<string, unknown>;
      const days = assembly.days as { items: Record<string, unknown>[] }[];
      days[0].items[0].rating = 4.6;
      days[0].items[0].address = "R. das Portas de Santo Antão 136";

      const result = validate(assembly);
      expect(result.ok).toBe(false);
      // Reported before anything else, and nothing else is reported.
      expect(new Set(codes(result))).toEqual(new Set(["prohibited_field"]));
    });

    it("rejects a model-authored route duration", () => {
      const assembly = JSON.parse(
        JSON.stringify(fixtureAssembly()),
      ) as Record<string, unknown>;
      const days = assembly.days as { items: Record<string, unknown>[] }[];
      days[0].items[0].durationMinutes = 14;

      expect(codes(validate(assembly))).toEqual(["prohibited_field"]);
    });

    it("rejects model-authored route geometry", () => {
      const assembly = JSON.parse(
        JSON.stringify(fixtureAssembly()),
      ) as Record<string, unknown>;
      const days = assembly.days as { items: Record<string, unknown>[] }[];
      days[0].items[0].geometry = { type: "LineString", coordinates: [] };

      expect(codes(validate(assembly))).toEqual(["prohibited_field"]);
    });

    it("rejects a category that disagrees with the canonical record", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[0].items[0];
      if (item.kind !== "place") throw new Error("fixture changed shape");
      // A real museum id declared as a café.
      item.placeId = FIXTURE_PLACES.museumOne.placeId;

      const result = validate(assembly);
      expect(codes(result)).toContain("assembly_category_mismatch");
    });
  });

  describe("structure", () => {
    it("rejects a duplicated item id", () => {
      const assembly = fixtureAssembly();
      assembly.days[1].items[0].itemId = assembly.days[0].items[0].itemId;

      expect(codes(validate(assembly))).toContain("assembly_duplicate_item_id");
    });

    it("rejects one slot filled twice", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[1].items[0];
      if (item.kind !== "place") throw new Error("fixture changed shape");
      item.slotId = "d1-s1";

      const result = validate(assembly);
      expect(codes(result)).toContain("assembly_duplicate_slot_fulfilment");
    });

    it("rejects a slot the strategy never asked for", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[0].items[0];
      if (item.kind !== "place") throw new Error("fixture changed shape");
      item.slotId = "d1-s9";

      expect(codes(validate(assembly))).toContain("assembly_unknown_slot");
    });

    it("rejects a slot used on the wrong day", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[1].items[1];
      if (item.kind !== "place") throw new Error("fixture changed shape");
      item.slotId = "d1-s2";
      item.placeId = FIXTURE_PLACES.museumTwo.placeId;

      expect(codes(validate(assembly))).toContain("assembly_slot_wrong_day");
    });

    it("rejects a required slot that is neither filled nor marked unavailable", () => {
      const assembly = fixtureAssembly();
      // Drop the required dinner slot entirely.
      assembly.days[0].items = assembly.days[0].items.slice(0, 2);

      const result = validate(assembly);
      expect(codes(result)).toContain("assembly_required_slot_omitted");
    });

    it("accepts a required slot represented as unavailable", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].items[2] = {
        kind: "unavailable",
        itemId: "dinner-gap",
        slotId: "d1-s3",
        reason:
          "No restaurant was found within a workable distance of the day's other stops.",
        startTime: "19:30",
        endTime: "21:00",
      };

      expect(validate(assembly).ok).toBe(true);
    });

    it("does not require an optional slot", () => {
      const assembly = fixtureAssembly();
      // d2-s2 is `required: false` in the fixture strategy.
      assembly.days[1].items = assembly.days[1].items.filter(
        (item) => item.kind !== "place" || item.slotId !== "d2-s2",
      );
      assembly.days[1].backups = [];

      expect(validate(assembly).ok).toBe(true);
    });

    it("rejects a day the strategy did not plan", () => {
      const assembly = fixtureAssembly();
      assembly.days[1].dayNumber = 4;

      const result = validate(assembly);
      expect(codes(result)).toContain("assembly_unknown_day");
      expect(codes(result)).toContain("assembly_missing_day");
    });

    it("rejects the same place visited twice on one day", () => {
      const assembly = fixtureAssembly();
      const first = assembly.days[0].items[0];
      const second = assembly.days[0].items[1];
      if (first.kind !== "place" || second.kind !== "place") {
        throw new Error("fixture changed shape");
      }
      second.placeId = first.placeId;
      second.category = "cafe";

      expect(codes(validate(assembly))).toContain(
        "assembly_duplicate_place_in_day",
      );
    });

    it("rejects a backup with neither a place nor a reason it has none", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].backups[0] = {
        backupId: "bk-empty",
        slotId: "d1-s2",
        reason: "Something else could have gone here instead.",
      };

      expect(codes(validate(assembly))).toContain(
        "assembly_backup_without_reason",
      );
    });

    it("accepts a backup that honestly reports no alternative", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].backups[0] = {
        backupId: "bk-none",
        slotId: "d1-s2",
        reason: "A second museum would have been the natural alternative.",
        unavailableReason:
          "The search returned no other museum within the radius, so there is no backup to offer.",
      };

      expect(validate(assembly).ok).toBe(true);
    });
  });

  describe("time", () => {
    it("rejects an end time before its start", () => {
      const assembly = fixtureAssembly();
      const item = assembly.days[0].items[0];
      item.startTime = "12:00";
      item.endTime = "09:00";

      expect(codes(validate(assembly))).toContain("assembly_invalid_interval");
    });

    it("rejects a zero-length stop", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].items[0].endTime = assembly.days[0].items[0].startTime;

      expect(codes(validate(assembly))).toContain("assembly_invalid_interval");
    });

    it("rejects overlapping stops and names both", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].items[1].startTime = "09:30";

      const result = validate(assembly);
      expect(codes(result)).toContain("assembly_overlapping_items");
      expect(result.violations[0].message).toContain("cafe-one");
    });

    it("rejects a malformed time at the schema layer", () => {
      const assembly = JSON.parse(
        JSON.stringify(fixtureAssembly()),
      ) as Record<string, unknown>;
      const days = assembly.days as { items: Record<string, unknown>[] }[];
      days[0].items[0].startTime = "9am";

      expect(codes(validate(assembly))).toContain("assembly_schema");
    });

    it("rejects an unavailable slot with only one of its two times", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].items[2] = {
        kind: "unavailable",
        itemId: "dinner-gap",
        slotId: "d1-s3",
        reason: "No restaurant was found within a workable distance.",
        startTime: "19:30",
      };

      expect(codes(validate(assembly))).toContain("assembly_partial_time");
    });

    it("accepts an unavailable slot with no times at all", () => {
      const assembly = fixtureAssembly();
      assembly.days[0].items[2] = {
        kind: "unavailable",
        itemId: "dinner-gap",
        slotId: "d1-s3",
        reason: "No restaurant was found within a workable distance.",
      };

      expect(validate(assembly).ok).toBe(true);
    });
  });

  describe("money", () => {
    it("rejects a basis that claims the price came from somewhere", () => {
      const assembly = fixtureAssembly();
      placeItemAt(assembly, 0, 0).estimatedCost = {
        ...cost(14),
        basis: "provider-tag",
      };

      expect(codes(validate(assembly))).toContain("assembly_cost_basis");
    });

    it("rejects a cost in a currency the traveller did not choose", () => {
      const assembly = fixtureAssembly();

      const result = validate(assembly, "USD");
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("assembly_cost_currency");
    });

    it("accepts an out-of-band amount, because clamping is attachment's job", () => {
      const assembly = fixtureAssembly();
      placeItemAt(assembly, 0, 0).estimatedCost = cost(4_000);

      expect(validate(assembly).ok).toBe(true);
    });
  });

  it("does not mutate the payload it was handed", () => {
    const assembly = fixtureAssembly();
    const snapshot = JSON.stringify(assembly);

    validate(assembly);
    expect(JSON.stringify(assembly)).toBe(snapshot);
  });
});

describe("minutesOfDay", () => {
  it("converts a 24-hour time to minutes since midnight", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("09:30")).toBe(570);
    expect(minutesOfDay("23:59")).toBe(1_439);
  });
});
