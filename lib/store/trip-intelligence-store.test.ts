import { beforeEach, describe, expect, it } from "vitest";

import {
  fact,
  identity,
  sidecar,
} from "@/lib/place-intelligence/test-fixtures";
import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";

import { createTripRecord } from "./trip-record";
import { useTripStore } from "./trip-store";

/**
 * The two guarded intelligence writes.
 *
 * Every arm of the result union is a different sentence in front of a traveller, and four of them must write nothing at
 * all. The properties worth pinning are the ones whose failure is invisible until somebody loses work: a stale revision
 * that overwrote another tab's change, a no-op refresh that consumed a revision, and — the one that would be discovered
 * weeks later — an enrichment write that quietly ate a step of the traveller's undo.
 */

const FETCHED_AT = "2026-07-28T12:00:00.000Z";

function seedTrip(): { tripId: string; revision: number } {
  const tripId = "trip-intelligence-1";
  const record = createTripRecord(
    fixtureSavedPlan(),
    "2026-07-27T10:00:00.000Z",
    FIXTURE_GENERATION,
  );

  useTripStore.setState({ records: { [tripId]: record }, lastRequest: null });
  return { tripId, revision: record.revision };
}

function scheduledPlaceId(): string {
  for (const day of fixtureSavedPlan().days) {
    for (const item of day.items) if (item.place) return item.place.placeId;
  }
  throw new Error("The fixture plan has no scheduled place.");
}

function entryFor(canonicalPlaceId: string) {
  return sidecar({
    canonicalPlaceId,
    identities: [identity({ canonicalPlaceId })],
    facts: [
      fact({
        kind: "official-description",
        value: "monastery in Lisbon, Portugal",
        provider: "wikidata",
      }),
    ],
  });
}

/** An identity and no facts — the shape a nearby match produces, which must not count as matched. */
function reviewEntryFor(canonicalPlaceId: string) {
  return sidecar({
    canonicalPlaceId,
    identities: [identity({ canonicalPlaceId, method: "name-and-proximity" })],
    facts: [],
  });
}

beforeEach(() => {
  useTripStore.setState({ records: {}, lastRequest: null });
});

describe("saveTripIntelligence", () => {
  it("writes once and reports what matched", () => {
    const { tripId, revision } = seedTrip();
    const placeId = scheduledPlaceId();

    const result = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [entryFor(placeId)],
      fetchedAt: FETCHED_AT,
    });

    expect(result).toEqual({
      status: "saved",
      revision: revision + 1,
      matched: 1,
    });

    const stored = useTripStore.getState().records[tripId];
    expect(stored.intelligence?.refreshedAt).toBe(FETCHED_AT);
    expect(stored.intelligence?.byCanonicalPlaceId[placeId]).toBeDefined();
  });

  it("counts an identity-only entry as stored but not matched", () => {
    /* A nearby match is worth keeping so a person can confirm it, and worth counting in nothing a traveller is shown. */
    const { tripId, revision } = seedTrip();
    const placeId = scheduledPlaceId();

    const result = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [reviewEntryFor(placeId)],
      fetchedAt: FETCHED_AT,
    });

    expect(result).toEqual({
      status: "saved",
      revision: revision + 1,
      matched: 0,
    });
    expect(
      useTripStore.getState().records[tripId].intelligence?.byCanonicalPlaceId[
        placeId
      ],
    ).toBeDefined();
  });

  it("consumes no step of the undo history", () => {
    const { tripId, revision } = seedTrip();

    useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [entryFor(scheduledPlaceId())],
      fetchedAt: FETCHED_AT,
    });

    const stored = useTripStore.getState().records[tripId];
    /* Enrichment adds facts and takes nothing away, so there is nothing to go back to. */
    expect(stored.history.past).toEqual([]);
    expect(stored.history.future).toEqual([]);
    expect(stored.plan).toEqual(fixtureSavedPlan());
  });

  it("reports unchanged, and consumes no revision, when nothing is new", () => {
    const { tripId, revision } = seedTrip();
    const placeId = scheduledPlaceId();
    const entries = [entryFor(placeId)];

    useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries,
      fetchedAt: FETCHED_AT,
    });

    const afterFirst = useTripStore.getState().records[tripId].revision;

    const second = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: afterFirst,
      entries,
      /* A later timestamp, which must not by itself count as a change. */
      fetchedAt: "2026-07-28T18:00:00.000Z",
    });

    expect(second).toEqual({ status: "unchanged", revision: afterFirst });
    expect(useTripStore.getState().records[tripId].revision).toBe(afterFirst);
  });

  it("writes nothing when the revision moved", () => {
    const { tripId, revision } = seedTrip();

    const result = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision + 5,
      entries: [entryFor(scheduledPlaceId())],
      fetchedAt: FETCHED_AT,
    });

    expect(result).toEqual({ status: "conflict", actualRevision: revision });
    expect(useTripStore.getState().records[tripId].intelligence).toBeNull();
  });

  it("reports a missing trip rather than creating one", () => {
    const result = useTripStore.getState().saveTripIntelligence({
      tripId: "no-such-trip",
      expectedRevision: 1,
      entries: [entryFor(scheduledPlaceId())],
      fetchedAt: FETCHED_AT,
    });

    expect(result).toEqual({ status: "missing-trip" });
    expect(useTripStore.getState().records["no-such-trip"]).toBeUndefined();
  });

  it("refuses the whole write when one entry does not validate", () => {
    const { tripId, revision } = seedTrip();
    const placeId = scheduledPlaceId();

    const result = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [
        entryFor(placeId),
        /* An identity pointing at a different place than the one holding it. */
        sidecar({
          canonicalPlaceId: placeId,
          identities: [identity({ canonicalPlaceId: "osm:node:999999" })],
          facts: [],
        }),
      ],
      fetchedAt: FETCHED_AT,
    });

    expect(result.status).toBe("invalid");
    /* Nothing at all was stored — not even the good entry. */
    expect(useTripStore.getState().records[tripId].intelligence).toBeNull();
  });

  it("refuses an unusable timestamp", () => {
    const { tripId, revision } = seedTrip();

    const result = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [entryFor(scheduledPlaceId())],
      fetchedAt: "not a date",
    });

    expect(result.status).toBe("invalid");
    expect(useTripStore.getState().records[tripId].intelligence).toBeNull();
  });

  it("drops an entry for a place the trip does not own", () => {
    /* Reconciliation runs on the way in too: the plan can change while a ninety-second run is in flight. */
    const { tripId, revision } = seedTrip();

    const result = useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [entryFor("osm:node:999999")],
      fetchedAt: FETCHED_AT,
    });

    expect(result).toEqual({ status: "unchanged", revision });
    expect(useTripStore.getState().records[tripId].intelligence).toBeNull();
  });
});

describe("clearTripIntelligence", () => {
  it("removes the sidecar and keeps the plan and history", () => {
    const { tripId, revision } = seedTrip();

    useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [entryFor(scheduledPlaceId())],
      fetchedAt: FETCHED_AT,
    });

    const afterSave = useTripStore.getState().records[tripId].revision;

    const cleared = useTripStore
      .getState()
      .clearTripIntelligence({ tripId, expectedRevision: afterSave });

    expect(cleared).toEqual({
      status: "saved",
      revision: afterSave + 1,
      matched: 0,
    });

    const stored = useTripStore.getState().records[tripId];
    expect(stored.intelligence).toBeNull();
    expect(stored.plan).toEqual(fixtureSavedPlan());
    expect(stored.history.past).toEqual([]);
  });

  it("reports unchanged when there is nothing to clear", () => {
    const { tripId, revision } = seedTrip();

    const result = useTripStore
      .getState()
      .clearTripIntelligence({ tripId, expectedRevision: revision });

    expect(result).toEqual({ status: "unchanged", revision });
    expect(useTripStore.getState().records[tripId].revision).toBe(revision);
  });

  it("writes nothing when the revision moved", () => {
    const { tripId, revision } = seedTrip();

    useTripStore.getState().saveTripIntelligence({
      tripId,
      expectedRevision: revision,
      entries: [entryFor(scheduledPlaceId())],
      fetchedAt: FETCHED_AT,
    });

    const result = useTripStore
      .getState()
      .clearTripIntelligence({ tripId, expectedRevision: revision });

    expect(result.status).toBe("conflict");
    expect(useTripStore.getState().records[tripId].intelligence).not.toBeNull();
  });
});
