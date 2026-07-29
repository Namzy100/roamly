import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BATCH_PARTIAL_RESPONSE,
  ENTITY_DATA_RESPONSE,
  ENTITY_MISSING_RESPONSE,
  FIXTURE_ARTICLE_EN,
  FIXTURE_COORDINATES,
  FIXTURE_FILE_TITLE,
  FIXTURE_LABEL_EN,
  FIXTURE_QID,
  IMAGEINFO_LICENSED_RASTER,
  IMAGEINFO_MISSING_FILE,
  IMAGEINFO_MISSING_LICENCE,
  IMAGEINFO_SVG,
  IMAGEINFO_UNSAFE_HOST,
  MALFORMED_ENTITY_ENVELOPE,
  NEARBY_EMPTY_RESPONSE,
  NEARBY_RESPONSE,
  PAGEPROPS_MISSING_RESPONSE,
  PAGEPROPS_RESOLVED_RESPONSE,
} from "./fixtures";

/**
 * The bridge between the adapter's fixtures and the browser suite (Checkpoint 5B, section 12).
 *
 * ## Why a JSON file exists at all
 *
 * `test/browser/run.mjs` and `test/browser/fixtures.mjs` are plain ESM run by `node`, with no TypeScript loader — so
 * they cannot import `lib/providers/place-intelligence/wikimedia/fixtures.ts`. The alternative is hand-writing
 * Wikidata and Commons response bodies a second time inside the fixture server, and a second copy of a response shape
 * is a copy that drifts: the browser suite would go on passing against last month's idea of what Commons returns.
 *
 * So the bodies are serialised once, and this test is what stops the copy rotting. It fails the moment the
 * TypeScript fixtures change without the JSON being regenerated, which is the only property that makes a generated
 * file safe to depend on.
 *
 * ## Regenerating
 *
 * `UPDATE_WIKIMEDIA_BODIES=1 npx vitest run test/browser/wikimedia-bodies.test.ts`
 *
 * Writing is opt-in rather than automatic on mismatch. A test that silently rewrote its own expectation would
 * report success for exactly the change it exists to catch.
 */

const BODIES_PATH = "test/browser/wikimedia-bodies.json";

/**
 * What the browser suite needs, and nothing else.
 *
 * Each entry is a whole response body as one of the five endpoints answers it. Deliberately *not* the normalized
 * records: the point of driving the real route is that the real adapter parses, validates and normalizes the same
 * payload it would in production, so the fixture has to be the payload rather than the conclusion.
 *
 * `PROTOTYPE_POLLUTION_ENVELOPE` is absent on purpose — it is built with `JSON.parse` so that `__proto__` is a real
 * own property, and a `JSON.stringify` round trip through this file would quietly turn it into an ordinary key,
 * leaving a fixture that no longer tests what it is named for. That one stays in the unit suite.
 */
function bodies(): Record<string, unknown> {
  return {
    constants: {
      qid: FIXTURE_QID,
      labelEn: FIXTURE_LABEL_EN,
      articleEn: FIXTURE_ARTICLE_EN,
      fileTitle: FIXTURE_FILE_TITLE,
      coordinates: FIXTURE_COORDINATES,
    },

    /* Direct QID: a trusted identity, one official description, one date, one heritage designation. */
    entityData: ENTITY_DATA_RESPONSE,
    entityMissing: ENTITY_MISSING_RESPONSE,
    entityBatchPartial: BATCH_PARTIAL_RESPONSE,
    entityMalformed: MALFORMED_ENTITY_ENVELOPE,

    /* The `wikipedia` tag path, which is an identifier only after the official API resolves it. */
    pagepropsResolved: PAGEPROPS_RESOLVED_RESPONSE,
    pagepropsMissing: PAGEPROPS_MISSING_RESPONSE,

    /* The nearby fallback, whose matches are rank 1 and therefore never displayed. */
    nearby: NEARBY_RESPONSE,
    nearbyEmpty: NEARBY_EMPTY_RESPONSE,

    /* Commons: the one file that may be shown, and the four that may not. */
    imageinfoLicensedRaster: IMAGEINFO_LICENSED_RASTER,
    imageinfoMissingLicence: IMAGEINFO_MISSING_LICENCE,
    imageinfoSvg: IMAGEINFO_SVG,
    imageinfoUnsafeHost: IMAGEINFO_UNSAFE_HOST,
    imageinfoMissingFile: IMAGEINFO_MISSING_FILE,
  };
}

describe("the browser suite's copy of the Wikimedia fixtures", () => {
  it("matches the adapter's own fixtures", () => {
    const expected = `${JSON.stringify(bodies(), null, 2)}\n`;

    if (process.env.UPDATE_WIKIMEDIA_BODIES === "1") {
      writeFileSync(BODIES_PATH, expected, "utf8");
    }

    const actual = readFileSync(BODIES_PATH, "utf8");

    expect(
      actual,
      `${BODIES_PATH} is out of date. Regenerate it with:\n  UPDATE_WIKIMEDIA_BODIES=1 npx vitest run test/browser/wikimedia-bodies.test.ts`,
    ).toBe(expected);
  });

  /**
   * The one fixture the whole enriched path depends on.
   *
   * A body that lost its description or its image claim would still be valid JSON and would still parse — it would
   * simply produce a place with no context, and every browser check downstream would pass while verifying nothing.
   * So the parts the suite relies on are named here rather than assumed.
   */
  it("carries the parts an accepted match needs", () => {
    const entities = (
      ENTITY_DATA_RESPONSE as { entities: Record<string, unknown> }
    ).entities;
    const entity = entities[FIXTURE_QID] as {
      descriptions?: Record<string, unknown>;
      claims?: Record<string, unknown>;
    };

    expect(entity, "the fixture entity").toBeDefined();
    expect(entity.descriptions?.en, "an English description").toBeDefined();
    expect(entity.claims, "claims").toBeDefined();
  });

  it("carries a displayable Commons file and its licence", () => {
    const pages = (
      IMAGEINFO_LICENSED_RASTER as {
        query: { pages: Record<string, unknown>[] };
      }
    ).query.pages;
    const info = (pages[0]?.imageinfo as Record<string, unknown>[])?.[0];

    expect(info, "one image revision").toBeDefined();
    expect(info.mime, "a MIME type").toBeDefined();
    expect(info.extmetadata, "licence metadata").toBeDefined();
  });
});
