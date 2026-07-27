import { describe, expect, it } from "vitest";

import {
  OFFLINE_MESSAGE,
  PROVIDER_BACKED_ACTIONS,
  offlineReasonFor,
} from "./use-online-status";

/**
 * The offline vocabulary, checked for honesty rather than for wording.
 *
 * The hook itself is exercised in the browser suite, where a real `navigator.onLine` can be flipped.
 * What is worth asserting here is the *claims* the copy makes: an app with no service worker must not
 * imply offline support, and the list of provider-backed actions must stay in step with the surfaces
 * that disable themselves — a missing entry is how a traveller ends up pressing a button that spins.
 */

describe("OFFLINE_MESSAGE", () => {
  it("names what still works", () => {
    for (const capability of [
      "Saved trip",
      "opening-hours",
      "cost recalculation",
      "structural edits",
    ]) {
      expect(OFFLINE_MESSAGE, capability).toContain(capability);
    }
  });

  it("names what does not", () => {
    for (const blocked of ["Maps", "place searches", "route calculation", "AI planning"]) {
      expect(OFFLINE_MESSAGE, blocked).toContain(blocked);
    }
  });

  /**
   * There is no service worker and no cached shell, so a hard reload while offline loads nothing at
   * all. Claiming "works offline" would be a promise the app cannot keep.
   */
  it("never claims full offline support", () => {
    const lower = OFFLINE_MESSAGE.toLowerCase();
    expect(lower).not.toContain("works offline");
    expect(lower).not.toContain("offline mode");
    expect(lower).not.toContain("available offline");
  });
});

describe("offlineReasonFor", () => {
  it("gives every provider-backed action its own reason", () => {
    const reasons = PROVIDER_BACKED_ACTIONS.map((action) => offlineReasonFor(action));

    expect(new Set(reasons).size).toBe(PROVIDER_BACKED_ACTIONS.length);
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).toMatch(/needs a connection/);
    }
  });

  it("says which service each one needs", () => {
    expect(offlineReasonFor("generate")).toContain("OpenStreetMap");
    expect(offlineReasonFor("route")).toContain("routing");
    expect(offlineReasonFor("refresh-pool")).toContain("OpenStreetMap");
  });

  /** The five surfaces that disable themselves. A sixth added without a reason would fail this. */
  it("covers exactly the actions that cannot work offline", () => {
    expect([...PROVIDER_BACKED_ACTIONS]).toEqual([
      "generate",
      "geocode",
      "route",
      "refine",
      "refresh-pool",
    ]);
  });
});
