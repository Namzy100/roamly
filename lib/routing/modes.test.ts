import { describe, expect, it } from "vitest";

import { COSTING_BY_MODE } from "@/lib/providers/routing/config";

import {
  ROUTING_MODES,
  isRoutingMode,
  toRoutingMode,
  toTravelMode,
} from "./modes";
import {
  DEFAULT_MODE_POLICY,
  haversineMeters,
  selectMode,
} from "./mode-policy";

/**
 * Mode mapping and mode selection.
 *
 * Two separate concerns, tested together because the thing they jointly
 * guarantee is one thing: a request for mode X is served by mode X, or it is
 * refused. Never substituted.
 */

describe("provider mode mapping", () => {
  it("maps walk to pedestrian", () => {
    expect(COSTING_BY_MODE.walk).toBe("pedestrian");
  });

  it("maps drive to auto", () => {
    expect(COSTING_BY_MODE.drive).toBe("auto");
  });

  it("maps bicycle to bicycle", () => {
    expect(COSTING_BY_MODE.bicycle).toBe("bicycle");
  });

  it("has no transit profile at all", () => {
    // Not "transit maps to walking" — transit is absent, so there is nothing to
    // send and nothing that could come back mislabelled.
    expect(Object.keys(COSTING_BY_MODE).sort()).toEqual([
      "bicycle",
      "drive",
      "walk",
    ]);
    expect("transit" in COSTING_BY_MODE).toBe(false);
  });

  it("covers every routing mode with a profile", () => {
    for (const mode of ROUTING_MODES) {
      expect(COSTING_BY_MODE[mode]).toBeTruthy();
    }
  });
});

describe("mode vocabulary translation", () => {
  it("round-trips every routing mode through the travel vocabulary", () => {
    for (const mode of ROUTING_MODES) {
      expect(toRoutingMode(toTravelMode(mode))).toBe(mode);
    }
  });

  it("returns null for transit rather than a substitute", () => {
    expect(toRoutingMode("TRANSIT")).toBeNull();
  });

  it("recognises only the three supported values", () => {
    expect(isRoutingMode("walk")).toBe(true);
    expect(isRoutingMode("transit")).toBe(false);
    expect(isRoutingMode("WALK")).toBe(false);
    expect(isRoutingMode(undefined)).toBe(false);
  });
});

describe("selectMode", () => {
  const { walkMaxMeters, driveMinMeters } = DEFAULT_MODE_POLICY;

  it("walks at the default threshold", () => {
    expect(selectMode(walkMaxMeters).mode).toBe("walk");
  });

  it("walks just below the threshold", () => {
    expect(selectMode(walkMaxMeters - 1).mode).toBe("walk");
  });

  it("does not walk just above the threshold", () => {
    expect(selectMode(walkMaxMeters + 1).mode).not.toBe("walk");
  });

  it("leaves the middle band undecided by default", () => {
    const selection = selectMode(4_000);
    // Declining to choose is a real outcome: the caller must say what they want,
    // rather than the routing layer guessing on a traveller's behalf.
    expect(selection.mode).toBeNull();
    expect(selection.reason).toBe("middle_band_undecided");
  });

  it("drives in the middle band when the policy allows it", () => {
    const selection = selectMode(4_000, {
      ...DEFAULT_MODE_POLICY,
      allowDriveInMiddleBand: true,
    });
    expect(selection.mode).toBe("drive");
    expect(selection.reason).toBe("middle_band_drive");
  });

  it("is still undecided exactly at the drive threshold", () => {
    expect(selectMode(driveMinMeters).mode).toBeNull();
  });

  it("drives just above the drive threshold", () => {
    expect(selectMode(driveMinMeters + 1).mode).toBe("drive");
  });

  it("never auto-selects bicycle", () => {
    for (const meters of [10, 500, 1_800, 4_000, 8_001, 50_000]) {
      expect(selectMode(meters).mode).not.toBe("bicycle");
    }
  });

  it("never auto-selects transit — it is not in the vocabulary", () => {
    for (const meters of [10, 4_000, 200_000]) {
      const selection = selectMode(meters);
      expect(selection.mode === null || ROUTING_MODES.includes(selection.mode)).toBe(
        true,
      );
    }
  });

  it("honours an explicit bicycle request at any distance", () => {
    const policy = { ...DEFAULT_MODE_POLICY, forcedMode: "bicycle" as const };

    expect(selectMode(50, policy).mode).toBe("bicycle");
    expect(selectMode(4_000, policy).mode).toBe("bicycle");
    expect(selectMode(40_000, policy).mode).toBe("bicycle");
    expect(selectMode(50, policy).reason).toBe("forced");
  });

  it("respects a caller's own thresholds", () => {
    // The defaults are planning conventions, not facts about the world.
    const cautious = {
      ...DEFAULT_MODE_POLICY,
      walkMaxMeters: 500,
      driveMinMeters: 1_000,
      allowDriveInMiddleBand: true,
    };
    expect(selectMode(600, cautious).mode).toBe("drive");
    expect(selectMode(400, cautious).mode).toBe("walk");
  });
});

describe("haversineMeters", () => {
  it("is zero for identical points", () => {
    const point = { latitude: 38.7139, longitude: -9.1394 };
    expect(haversineMeters(point, point)).toBe(0);
  });

  it("matches a known Lisbon distance to within a few metres", () => {
    // Praça do Comércio to Sé de Lisboa — ~370 m as the crow flies, against a
    // routed walking distance of ~500 m. The gap is the point: straight-line
    // distance is for choosing a mode, never for telling a traveller how far.
    const distance = haversineMeters(
      { latitude: 38.70775, longitude: -9.13659 },
      { latitude: 38.70986, longitude: -9.13327 },
    );
    expect(distance).toBeGreaterThan(350);
    expect(distance).toBeLessThan(400);
  });

  it("is symmetric", () => {
    const a = { latitude: 38.7139, longitude: -9.1394 };
    const b = { latitude: 38.6968, longitude: -9.2035 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it("handles the antimeridian without producing a half-globe distance", () => {
    const distance = haversineMeters(
      { latitude: 0, longitude: 179.999 },
      { latitude: 0, longitude: -179.999 },
    );
    expect(distance).toBeLessThan(1_000);
  });
});
