import { describe, expect, it } from "vitest";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";

import {
  TripRecordSchema,
  checkRevision,
  createTripRecord,
  nextRevision,
} from "./trip-record";

/**
 * The optimistic-concurrency envelope.
 *
 * The property being protected is narrow but load-bearing: routing takes
 * seconds, and a write at the end of it must not silently clobber whatever
 * happened in between.
 */

const NOW = "2026-07-27T10:00:00.000Z";
const LATER = "2026-07-27T10:00:12.000Z";

describe("createTripRecord", () => {
  it("starts at revision 1", () => {
    const record = createTripRecord(mockTripPlan, NOW);

    expect(record.revision).toBe(1);
    expect(record.createdAt).toBe(NOW);
    expect(record.updatedAt).toBe(NOW);
    expect(record.plan).toBe(mockTripPlan);
  });

  it("validates against the envelope schema", () => {
    expect(TripRecordSchema.safeParse(createTripRecord(mockTripPlan, NOW)).success).toBe(
      true,
    );
  });
});

describe("nextRevision", () => {
  it("increments by exactly one", () => {
    const first = createTripRecord(mockTripPlan, NOW);
    const second = nextRevision(first, mockTripPlan, LATER);

    expect(second.revision).toBe(2);
    expect(nextRevision(second, mockTripPlan, LATER).revision).toBe(3);
  });

  it("preserves createdAt and moves updatedAt", () => {
    const first = createTripRecord(mockTripPlan, NOW);
    const second = nextRevision(first, mockTripPlan, LATER);

    expect(second.createdAt).toBe(NOW);
    expect(second.updatedAt).toBe(LATER);
  });

  it("does not mutate the record it replaces", () => {
    const first = createTripRecord(mockTripPlan, NOW);
    nextRevision(first, mockTripPlan, LATER);

    // A rejected write must leave no trace, which requires the old record to be
    // untouched by the attempt to build a new one.
    expect(first.revision).toBe(1);
    expect(first.updatedAt).toBe(NOW);
  });
});

describe("checkRevision", () => {
  const record = createTripRecord(mockTripPlan, NOW);

  it("passes when the revision matches", () => {
    expect(checkRevision(record, 1)).toBeNull();
  });

  it("reports a mismatch when the record moved", () => {
    const moved = nextRevision(record, mockTripPlan, LATER);
    const conflict = checkRevision(moved, 1);

    expect(conflict).toEqual({
      reason: "revision_mismatch",
      expectedRevision: 1,
      actualRevision: 2,
    });
  });

  it("reports a missing record", () => {
    expect(checkRevision(undefined, 1)).toEqual({
      reason: "missing",
      expectedRevision: 1,
      actualRevision: null,
    });
  });

  it("returns the conflict rather than throwing", () => {
    // A conflict is a state the UI renders, not an exception it catches.
    expect(() => checkRevision(undefined, 1)).not.toThrow();
  });
});

describe("TripRecordSchema", () => {
  it("rejects a revision of zero", () => {
    expect(
      TripRecordSchema.safeParse({
        revision: 0,
        createdAt: NOW,
        updatedAt: NOW,
        plan: mockTripPlan,
      }).success,
    ).toBe(false);
  });

  it("rejects a corrupt envelope", () => {
    expect(TripRecordSchema.safeParse({ revision: 1 }).success).toBe(false);
    expect(TripRecordSchema.safeParse(null).success).toBe(false);
    expect(
      TripRecordSchema.safeParse({
        revision: 1,
        createdAt: NOW,
        updatedAt: NOW,
        plan: { id: "broken" },
      }).success,
    ).toBe(false);
  });

  it("does not carry a revision inside the plan", () => {
    // The counter is a property of the saved record, not of the trip. Two plans
    // with identical itineraries must compare equal.
    const record = createTripRecord(mockTripPlan, NOW);
    expect("revision" in record.plan).toBe(false);
  });
});
