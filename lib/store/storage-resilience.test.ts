import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { TripPlace, TripPlan } from "@/lib/schemas";

import { canPersist, persistedPayload } from "./capacity";
import {
  MAX_IMPORT_BYTES,
  PORTABLE_TRIP_FORMAT,
  asImportedCopy,
  exportFileName,
  exportTrip,
  parseImportedTrip,
  serialiseTrip,
} from "./portable-trip";
import {
  classifyStorageError,
  formatBytes,
  measureTripStorage,
  readBrowserEstimate,
} from "./storage-usage";
import { createTripRecord, nextRevision, type StoredTripRecord } from "./trip-record";

/**
 * Storage resilience, measured rather than assumed.
 *
 * ## No provider calls, no real browser
 *
 * Every record is built from the existing fixtures, and `localStorage` is a small fake with a
 * settable ceiling. Deliberate: the interesting cases are a *full* quota and an *unavailable* store,
 * and neither can be produced reliably in a real browser on demand.
 *
 * ## Sizes are reported, not pinned to magic numbers
 *
 * A record's serialised size depends on the fixture, and asserting a constant would make an unrelated
 * fixture edit fail this file. What *is* asserted is the shape of the growth — a snapshot roughly
 * doubles a record, twelve trips cost roughly twelve times one — and the figures are printed so a
 * human can read them.
 */

/* -------------------------------------------------------------------------- */
/* A localStorage with a ceiling we control                                    */
/* -------------------------------------------------------------------------- */

class FakeStorage {
  private data = new Map<string, string>();
  /** `Infinity` means "no ceiling". Set it to force a quota failure. */
  limitBytes = Number.POSITIVE_INFINITY;
  /** When true every access throws, as a locked-down private window does. */
  blocked = false;

  get length(): number {
    return this.data.size;
  }

  getItem(key: string): string | null {
    if (this.blocked) throw new DOMException("blocked", "SecurityError");
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.blocked) throw new DOMException("blocked", "SecurityError");

    const next = new Map(this.data);
    next.set(key, value);
    const total = [...next].reduce(
      (sum, [entryKey, entryValue]) => sum + entryKey.length + entryValue.length,
      0,
    );

    if (total > this.limitBytes) {
      // The shape browsers actually throw, so `classifyStorageError` is exercised for real.
      throw new DOMException("exceeded the quota", "QuotaExceededError");
    }
    this.data = next;
  }

  removeItem(key: string): void {
    if (this.blocked) throw new DOMException("blocked", "SecurityError");
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  usedBytes(): number {
    return [...this.data].reduce(
      (sum, [key, value]) => sum + key.length + value.length,
      0,
    );
  }

  keys(): string[] {
    return [...this.data.keys()];
  }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, "localStorage");
});

/* -------------------------------------------------------------------------- */
/* Records of realistic shape                                                  */
/* -------------------------------------------------------------------------- */

const NOW = "2026-08-20T09:00:00.000Z";

/** A saved trip with its pool: the ordinary case. */
function record(tripId: string): StoredTripRecord {
  const plan = fixtureSavedPlan();
  return createTripRecord({ ...plan, id: tripId }, NOW, FIXTURE_GENERATION);
}

/** The same trip carrying one history entry, which is the largest a record gets. */
function recordWithSnapshot(tripId: string): StoredTripRecord {
  const base = record(tripId);
  return nextRevision(base, base.plan, NOW, base.generation, {
    label: "Replace stop",
    kind: "refinement",
  });
}

/** A pool padded towards the persisted cap, for the largest legal context. */
function recordWithLargePool(tripId: string, poolSize: number): StoredTripRecord {
  const extra: TripPlace[] = Array.from({ length: poolSize }, (_, index) => ({
    ...FIXTURE_PLACES.cafeOne,
    placeId: `osm:node:${800_000 + index}`,
    source: {
      ...FIXTURE_PLACES.cafeOne.source,
      canonicalId: `osm:node:${800_000 + index}`,
      osmId: String(800_000 + index),
    },
    // Long but legal: the parser bounds `opening_hours` at 512 characters.
    openingHours: "Mo-Fr 09:00-12:00,13:00-17:00; Sa 10:00-14:00"
      .repeat(4)
      .slice(0, 500),
  }));

  const base = record(tripId);
  return {
    ...base,
    generation: {
      ...FIXTURE_GENERATION,
      placePool: {
        ...FIXTURE_GENERATION.placePool,
        places: [...FIXTURE_GENERATION.placePool.places, ...extra],
      },
    },
  };
}

function mapOf(records: StoredTripRecord[]): Record<string, StoredTripRecord> {
  return Object.fromEntries(records.map((entry) => [entry.plan.id, entry]));
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

describe("measureTripStorage — how big a trip actually is", () => {
  it("reports a size for one trip, in a plausible range", () => {
    const report = measureTripStorage(mapOf([record("t1")]));

    expect(report.tripCount).toBe(1);
    expect(report.appBytes).toBeGreaterThan(10_000);
    expect(report.appBytes).toBeLessThan(400_000);
    console.log(`  one trip: ${formatBytes(report.appBytes)}`);
  });

  /** The history is the biggest thing a traveller can choose to drop. */
  it("reports the undo history's share, and its depth, separately", () => {
    const plain = measureTripStorage(mapOf([record("t1")]));
    const withSnapshot = measureTripStorage(mapOf([recordWithSnapshot("t1")]));

    expect(withSnapshot.entries[0].historyBytes).toBeGreaterThan(0);
    expect(withSnapshot.entries[0].undoDepth).toBe(1);
    expect(withSnapshot.entries[0].redoDepth).toBe(0);
    expect(withSnapshot.appBytes).toBeGreaterThan(plain.appBytes * 1.5);
    console.log(
      `  with one history entry: ${formatBytes(withSnapshot.appBytes)} (history ${formatBytes(withSnapshot.entries[0].historyBytes)})`,
    );
  });

  /** A trip nobody has edited stores no history and is charged nothing for the ability. */
  it("charges nothing for history on an unedited trip", () => {
    const report = measureTripStorage(mapOf([record("t1")]));

    expect(report.entries[0].historyBytes).toBe(0);
    expect(report.entries[0].undoDepth).toBe(0);
  });

  it("scales linearly across 1, 5 and 12 trips", () => {
    const sizes = [1, 5, 12].map((count) => {
      const report = measureTripStorage(
        mapOf(
          Array.from({ length: count }, (_, index) =>
            recordWithSnapshot(`t${index}`),
          ),
        ),
      );
      console.log(`  ${count} trip(s): ${formatBytes(report.appBytes)}`);
      return report.appBytes;
    });

    expect(sizes[1]).toBeGreaterThan(sizes[0] * 4);
    expect(sizes[2]).toBeGreaterThan(sizes[1] * 2);
    // Twelve trips must stay well inside a conservative 5 MB origin budget.
    expect(sizes[2]).toBeLessThan(5 * 1024 * 1024);
  });

  it("reports a large pool honestly", () => {
    const report = measureTripStorage(mapOf([recordWithLargePool("t1", 120)]));

    console.log(`  large pool: ${formatBytes(report.appBytes)}`);
    expect(report.appBytes).toBeGreaterThan(
      measureTripStorage(mapOf([record("t1")])).appBytes,
    );
  });

  it("lists the largest trips first, for a recovery decision", () => {
    const report = measureTripStorage(
      mapOf([record("small"), recordWithLargePool("big", 100), record("small2")]),
    );

    expect(report.largest[0].tripId).toBe("big");
    expect(report.largest).toHaveLength(3);
  });

  it("orders the listing by when each trip was last touched", () => {
    const older = { ...record("older"), updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...record("newer"), updatedAt: "2026-09-01T00:00:00.000Z" };

    expect(
      measureTripStorage(mapOf([older, newer])).entries.map((entry) => entry.tripId),
    ).toEqual(["newer", "older"]);
  });

  it("reports nothing for no trips", () => {
    expect(measureTripStorage({})).toMatchObject({ tripCount: 0, appBytes: 0 });
  });
});

describe("formatBytes", () => {
  it("uses the unit a reader expects", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("readBrowserEstimate", () => {
  /**
   * The honest answer when the browser will not say. Inventing 5 MB here is what would make a
   * fabricated percentage possible downstream.
   */
  it("reports unavailable when the API is absent", async () => {
    expect(await readBrowserEstimate()).toEqual({ status: "unavailable" });
  });

  it("reports unavailable when the API rejects", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { estimate: () => Promise.reject(new Error("no")) } },
      configurable: true,
    });
    expect(await readBrowserEstimate()).toEqual({ status: "unavailable" });
    Reflect.deleteProperty(globalThis as object, "navigator");
  });

  it("passes the browser's figures through, and nulls what it omits", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { storage: { estimate: () => Promise.resolve({ usage: 1_000 }) } },
      configurable: true,
    });
    expect(await readBrowserEstimate()).toEqual({
      status: "estimated",
      usageBytes: 1_000,
      quotaBytes: null,
    });
    Reflect.deleteProperty(globalThis as object, "navigator");
  });
});

/* -------------------------------------------------------------------------- */
/* Quota classification and the pre-flight probe                               */
/* -------------------------------------------------------------------------- */

describe("classifyStorageError", () => {
  it("recognises quota failures in the shapes browsers use", () => {
    expect(classifyStorageError(new DOMException("x", "QuotaExceededError"))).toBe(
      "quota_exceeded",
    );
    expect(
      classifyStorageError(new DOMException("x", "NS_ERROR_DOM_QUOTA_REACHED")),
    ).toBe("quota_exceeded");
    expect(classifyStorageError(new Error("The quota has been exceeded"))).toBe(
      "quota_exceeded",
    );
  });

  it("recognises a store that is switched off", () => {
    expect(classifyStorageError(new DOMException("x", "SecurityError"))).toBe(
      "unavailable",
    );
  });

  it("does not guess at anything else", () => {
    expect(classifyStorageError(new Error("something else"))).toBe("unknown");
    expect(classifyStorageError(null)).toBe("unknown");
  });
});

describe("canPersist — the pre-flight probe", () => {
  it("accepts a write that fits", () => {
    expect(canPersist("k", "small")).toEqual({ ok: true });
  });

  it("reports a quota failure rather than throwing", () => {
    storage.limitBytes = 50;
    const result = canPersist("roamly:trips:v1", "x".repeat(500));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("quota_exceeded");
  });

  it("reports an unavailable store", () => {
    storage.blocked = true;
    const result = canPersist("k", "value");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe("unavailable");
  });

  /**
   * A refusal leaves the previous value untouched.
   *
   * `setItem` is atomic, so a failed write cannot half-replace the stored trips — which is what makes
   * probing on the real key safe rather than reckless.
   */
  it("leaves the existing value intact when it refuses", () => {
    storage.setItem("roamly:trips:v1", "the existing trips");
    storage.limitBytes = 40;

    const result = canPersist("roamly:trips:v1", "x".repeat(1_000));

    expect(result.ok).toBe(false);
    expect(storage.getItem("roamly:trips:v1")).toBe("the existing trips");
  });

  /**
   * A successful probe *is* the write, and that is deliberate.
   *
   * The first design used a sibling `:__probe` key, which meant the check needed `oldSize + newSize` of
   * headroom while the real write needs only `newSize` — refusing saves that would have fitted. Probing
   * the real key measures what actually happens, and `persist` writes the identical payload moments
   * later because the caller always commits when the probe succeeds.
   */
  it("writes to the real key rather than a sibling, and leaves no scratch key", () => {
    const payload = persistedPayload({ records: {}, lastRequest: null }, 2);

    expect(canPersist("roamly:trips:v1", payload)).toEqual({ ok: true });
    expect(storage.keys()).toEqual(["roamly:trips:v1"]);
    expect(storage.getItem("roamly:trips:v1")).toBe(payload);
  });

  /**
   * The case the sibling-key design got wrong, asserted directly.
   *
   * Ceiling of 120 bytes, 100 already stored, a 110-byte candidate. Replacing in place fits; holding
   * both at once does not.
   */
  it("accepts a replacement that fits even when old plus new would not", () => {
    const key = "roamly:trips:v1";
    storage.setItem(key, "o".repeat(100 - key.length));
    storage.limitBytes = 120;

    expect(canPersist(key, "n".repeat(110 - key.length)).ok).toBe(true);
  });

  it("is a no-op where there is no storage at all", () => {
    Reflect.deleteProperty(globalThis as object, "localStorage");
    expect(canPersist("k", "v")).toEqual({ ok: true });
  });

  it("probes with the same envelope the middleware writes", () => {
    expect(JSON.parse(persistedPayload({ records: {}, lastRequest: null }, 2))).toEqual(
      { state: { records: {}, lastRequest: null }, version: 2 },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

describe("exportTrip", () => {
  it("wraps the whole record, versions included", () => {
    const trip = exportTrip(recordWithSnapshot("t1"), NOW);

    expect(trip.format).toBe("roamly.trip");
    expect(trip.formatVersion).toBe(PORTABLE_TRIP_FORMAT);
    expect(trip.planSchemaVersion).toBe(3);
    expect(trip.record.revision).toBeGreaterThan(0);
    expect(trip.record.generation?.placePool.places.length).toBeGreaterThan(0);
    expect(trip.record.history.past).toHaveLength(1);
  });

  it("is byte-stable for the same record", () => {
    const source = record("t1");
    expect(serialiseTrip(exportTrip(source, NOW))).toBe(
      serialiseTrip(exportTrip(source, NOW)),
    );
  });

  it("is readable JSON, not a blob", () => {
    const text = serialiseTrip(exportTrip(record("t1"), NOW));
    expect(text.includes("\n  ")).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
  });

  /**
   * The export is a copy of what storage already holds, which is what makes it safe. These are the
   * things that must not have crept into the record in the first place.
   */
  it("carries no prompt, no raw provider payload and no key", () => {
    const text = serialiseTrip(exportTrip(recordWithSnapshot("t1"), NOW)).toLowerCase();

    for (const forbidden of [
      "api_key",
      "apikey",
      "gemini_api",
      "authorization",
      "systeminstruction",
      "you are a travel",
      "overpass",
      "nominatim",
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("names the file after the destination and the dates", () => {
    expect(exportFileName(record("t1"))).toBe("roamly-lisbon-2026-09-12.json");
  });
});

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

describe("parseImportedTrip — accepting a good file", () => {
  it("round-trips an exported trip", () => {
    const result = parseImportedTrip(
      serialiseTrip(exportTrip(recordWithSnapshot("t1"), NOW)),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trip.record.plan.id).toBe("t1");
    expect(result.trip.record.history.past).toHaveLength(1);
  });

  it("accepts a trip with no generation context", () => {
    const bare = createTripRecord(fixtureSavedPlan(), NOW);
    expect(parseImportedTrip(serialiseTrip(exportTrip(bare, NOW))).ok).toBe(true);
  });
});

describe("parseImportedTrip — rejecting a bad file", () => {
  it("rejects text that is not JSON", () => {
    expect(parseImportedTrip("not json at all")).toMatchObject({
      ok: false,
      code: "not_json",
    });
  });

  it("rejects JSON that is not a Roamly export", () => {
    expect(parseImportedTrip('{"hello":"world"}')).toMatchObject({
      ok: false,
      code: "not_a_roamly_trip",
    });
  });

  /** Equality, not "at least": a newer file may describe a shape this build cannot render. */
  it("rejects a format version it does not read", () => {
    const bumped = JSON.stringify({
      ...exportTrip(record("t1"), NOW),
      formatVersion: 99,
    });

    expect(parseImportedTrip(bumped)).toMatchObject({
      ok: false,
      code: "unsupported_version",
    });
  });

  it("rejects a plan schema version it does not read", () => {
    const bumped = JSON.stringify({
      ...exportTrip(record("t1"), NOW),
      planSchemaVersion: 99,
    });

    expect(parseImportedTrip(bumped)).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
  });

  it("rejects a malformed plan", () => {
    const trip = exportTrip(record("t1"), NOW);
    const broken = JSON.stringify({
      ...trip,
      record: { ...trip.record, plan: { ...trip.record.plan, days: [] } },
    });

    expect(parseImportedTrip(broken)).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
  });

  it("rejects a record with no revision envelope", () => {
    const trip = exportTrip(record("t1"), NOW);
    const broken = JSON.stringify({
      ...trip,
      record: { ...trip.record, revision: 0 },
    });

    expect(parseImportedTrip(broken)).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
  });

  /**
   * The gate that matters most. An edited file naming a place no search ever found must be refused by
   * the *same* assertion generation uses, or "import" becomes a way around the invariant.
   */
  it("rejects a plan whose place is not in its pool", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    tampered.record.generation.placePool.places =
      tampered.record.generation.placePool.places.filter(
        (place: TripPlace) => place.placeId !== FIXTURE_PLACES.museumOne.placeId,
      );

    const result = parseImportedTrip(JSON.stringify(tampered));
    expect(result).toMatchObject({ ok: false, code: "pool_violation" });
    if (result.ok) return;
    expect(result.message).toContain(FIXTURE_PLACES.museumOne.placeId);
  });

  it("rejects a plan whose attached place was edited", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    const item = tampered.record.plan.days[0].items.find(
      (entry: { place: TripPlace | null }) => entry.place !== null,
    );
    item.place.name = "Somewhere else entirely";

    expect(parseImportedTrip(JSON.stringify(tampered))).toMatchObject({
      ok: false,
      code: "pool_violation",
    });
  });

  it("rejects a retained place nothing references", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    tampered.record.generation.retainedPlaces = [
      {
        place: FIXTURE_PLACES.cafeTwo,
        retainedAt: NOW,
        reason: "missing-after-refresh",
      },
    ];

    expect(parseImportedTrip(JSON.stringify(tampered))).toMatchObject({
      ok: false,
      code: "pool_violation",
    });
  });

  it("rejects a retained reason it does not recognise", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    tampered.record.generation.retainedPlaces = [
      { place: FIXTURE_PLACES.cafeTwo, retainedAt: NOW, reason: "because" },
    ];

    expect(parseImportedTrip(JSON.stringify(tampered))).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
  });

  it("rejects invalid route geometry", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    tampered.record.plan.days[0].items[0].travelToNext = {
      id: "x",
      fromPlaceId: "a",
      toPlaceId: "b",
      note: null,
      status: "routed",
      provider: "valhalla",
      mode: "WALK",
      distanceMeters: 100,
      durationSeconds: 60,
      durationMinutes: 1,
      // One point is a decoding failure, not a very short journey.
      geometry: { type: "LineString", coordinates: [[0, 0]] },
      fetchedAt: NOW,
      attribution: "x",
    };

    expect(parseImportedTrip(JSON.stringify(tampered))).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
  });

  it("rejects a cost estimate claiming a basis it does not implement", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    tampered.record.plan.days[0].items[0].costEstimate = {
      amount: 10,
      currency: "EUR",
      basis: "checked-with-the-venue",
      confidence: "high",
    };

    expect(parseImportedTrip(JSON.stringify(tampered))).toMatchObject({
      ok: false,
      code: "invalid_record",
    });
  });

  /** Bounded before `JSON.parse` runs, so a hostile file is never parsed at all. */
  it("refuses a file far larger than any trip", () => {
    expect(parseImportedTrip("x".repeat(MAX_IMPORT_BYTES + 1))).toMatchObject({
      ok: false,
      code: "too_large",
    });
  });

  it("never executes anything in the file", () => {
    const tampered = JSON.parse(serialiseTrip(exportTrip(record("t1"), NOW)));
    // A script-shaped string in a free-text field stays a string — carried verbatim, never run.
    tampered.record.plan.days[0].items[0].tip = "<script>globalThis.__pwned = 1</script>";

    const result = parseImportedTrip(JSON.stringify(tampered));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trip.record.plan.days[0].items[0].tip).toBe(
      "<script>globalThis.__pwned = 1</script>",
    );
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("asImportedCopy", () => {
  it("gives the copy a new id and a fresh revision line", () => {
    const copy = asImportedCopy(
      exportTrip(recordWithSnapshot("original"), NOW),
      "copy-1",
      "2026-09-01T00:00:00.000Z",
    );

    expect(copy.plan.id).toBe("copy-1");
    expect(copy.revision).toBe(1);
    expect(copy.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(copy.updatedAt).toBe("2026-09-01T00:00:00.000Z");
  });

  /**
   * Dropped deliberately: an inherited history would let "undo" walk a copy back to a state the copy
   * never had, and it is the largest part of the record.
   */
  it("drops the inherited undo history", () => {
    expect(
      asImportedCopy(exportTrip(recordWithSnapshot("original"), NOW), "copy-1", NOW)
        .history,
    ).toEqual({ past: [], future: [] });
  });

  /** Provenance is a fact about what happened, and survives being copied. */
  it("preserves provider provenance and place attribution", () => {
    const copy = asImportedCopy(exportTrip(record("original"), NOW), "copy-1", NOW);

    expect(copy.generation?.provider).toBe(FIXTURE_GENERATION.provider);
    expect(copy.generation?.model).toBe(FIXTURE_GENERATION.model);
    expect(copy.generation?.generatedAt).toBe(FIXTURE_GENERATION.generatedAt);
    expect(copy.plan.source).toBe("generated");
    expect(copy.generation?.placePool.attribution).toContain("OpenStreetMap");
  });

  it("keeps the itinerary intact", () => {
    const source = record("original");
    const copy = asImportedCopy(exportTrip(source, NOW), "copy-1", NOW);

    const ids = (plan: TripPlan) =>
      plan.days.flatMap((day) => day.items.map((item) => item.id));
    expect(ids(copy.plan)).toEqual(ids(source.plan));
  });

  it("produces a record the importer accepts again", () => {
    const copy = asImportedCopy(exportTrip(record("original"), NOW), "copy-1", NOW);
    expect(parseImportedTrip(serialiseTrip(exportTrip(copy, NOW))).ok).toBe(true);
  });
});
