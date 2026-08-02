import { describe, expect, it } from "vitest";

import {
  attributionIsRequired,
  licenceLinkIsRequired,
} from "@/lib/place-intelligence";

import { COMMONS_LICENCES } from "./media";
import { buildLandmarkFacts, descriptionProblem } from "./summary";
import {
  ENTITY_DATA_RESPONSE,
  ENTITY_MISSING_RESPONSE,
  ENTITY_WITH_COARSE_DATE,
  ENTITY_WITH_LUNAR_COORDINATE,
  BATCH_PARTIAL_RESPONSE,
  FIXTURE_QID,
  IMAGEINFO_LICENSED_RASTER,
  IMAGEINFO_SVG,
  NEARBY_FOREIGN_HOST_RESPONSE,
  NEARBY_RESPONSE,
  PAGEPROPS_DISAMBIGUATION_RESPONSE,
  PAGEPROPS_RESOLVED_RESPONSE,
  MALFORMED_ENTITY_ENVELOPE,
  PROTOTYPE_POLLUTION_ENVELOPE,
  deeplyNestedPayload,
} from "./fixtures";
import {
  normalizeEntity,
  normalizeFileMetadata,
  normalizeNearbyCandidate,
} from "./normalize";
import { articleTitleProblem } from "./resolve";
import {
  parseBatchEntitiesResponse,
  parseEntityDataResponse,
  parseImageInfoResponse,
  parseNearbyResponse,
  parsePagePropsResponse,
} from "./schemas";

/**
 * That every fixture reaches the arm it was written for.
 *
 * Not a substitute for the behavioural suites Section 4 does not ask for — it is the check that the parse boundary and
 * the fixtures agree, which is the one thing a fixture module can be wrong about in a way nothing else would notice.
 */
describe("wikimedia fixtures", () => {
  it("parses and normalizes the direct entity", () => {
    const bundle = parseEntityDataResponse(ENTITY_DATA_RESPONSE);
    const raw = bundle.entities.get(FIXTURE_QID);
    expect(raw).toBeDefined();
    if (!raw) return;

    const entity = normalizeEntity(raw, "fr");
    expect(entity.qid).toBe(FIXTURE_QID);
    expect(entity.label?.value).toBe("tour Eiffel");
    expect(entity.label?.language).toBe("fr");
    expect(entity.coordinates).toEqual({ lat: 48.85837, lng: 2.294481 });
    expect(entity.inceptionYear).toBe(1887);
    expect(entity.inceptionSource).toBe("inception");
    expect(entity.officialWebsite).toBe("https://www.toureiffel.paris/en");
    expect(entity.commonsFileTitle).toBe(
      "File:Tour Eiffel Wikimedia Commons.jpg",
    );
    expect(entity.article?.url).toBe(
      "https://fr.wikipedia.org/wiki/Tour_Eiffel",
    );
    expect(entity.instanceOfQids).toEqual(["Q1440300"]);
  });

  it("drops a coarse date and a non-Earth coordinate", () => {
    const coarse = parseEntityDataResponse(ENTITY_WITH_COARSE_DATE);
    const coarseRaw = coarse.entities.get("Q1000000");
    expect(coarseRaw).toBeDefined();
    if (coarseRaw) {
      expect(normalizeEntity(coarseRaw, "en").inceptionYear).toBeNull();
    }

    const lunar = parseEntityDataResponse(ENTITY_WITH_LUNAR_COORDINATE);
    const lunarRaw = lunar.entities.get("Q1000001");
    expect(lunarRaw).toBeDefined();
    if (lunarRaw) {
      expect(normalizeEntity(lunarRaw, "en").coordinates).toBeNull();
    }
  });

  it("reports a missing entity and a partial batch", () => {
    expect(parseBatchEntitiesResponse(ENTITY_MISSING_RESPONSE).missing).toEqual([
      "Q99999999",
    ]);

    const partial = parseBatchEntitiesResponse(BATCH_PARTIAL_RESPONSE);
    expect(partial.entities.size).toBe(1);
    expect(partial.malformed).toEqual(["Q1000002"]);
  });

  it("reads pageprops", () => {
    const resolved = parsePagePropsResponse(PAGEPROPS_RESOLVED_RESPONSE);
    expect(resolved.pages[0].pageprops?.wikibase_item).toBe(FIXTURE_QID);

    const disambiguation = parsePagePropsResponse(
      PAGEPROPS_DISAMBIGUATION_RESPONSE,
    );
    expect(
      disambiguation.pages[0].pageprops?.disambiguation,
    ).not.toBeUndefined();
  });

  /**
   * The guard that decides whether an OSM `wikipedia` tag may be resolved at all.
   *
   * Regression coverage, and the regression was not a near miss. `CONTROL_CHARACTERS` had collapsed into a range from
   * space to hyphen, so *every* ordinary title — anything containing a space — was refused as holding a control
   * character, while a real control character passed. `articleTitleProblem` throws `misconfigured`, whose
   * `abandonsRun` is true, so one such place ended the whole trip's run and reported the deployment as unconfigured.
   *
   * Both directions are asserted, because repairing only the false positive would leave the guard doing nothing.
   */
  it("accepts an ordinary article title and refuses a control character", () => {
    /* Characters the broken range spanned: space, and the punctuation up to `-`. */
    expect(articleTitleProblem("Eiffel Tower")).toBeNull();
    expect(articleTitleProblem("Mosteiro dos Jerónimos")).toBeNull();
    expect(articleTitleProblem("Sant'Angelo (Rome)")).toBeNull();
    expect(articleTitleProblem("Saint-Germain-des-Prés")).toBeNull();

    /* And the characters it was meant to span, which it had stopped matching entirely. */
    for (const code of [0x00, 0x07, 0x1f, 0x7f]) {
      expect(articleTitleProblem(`Eiffel${String.fromCharCode(code)}Tower`)).toBe(
        "The article title contains a control character.",
      );
    }
  });

  it("normalizes nearby bindings and refuses a foreign host", () => {
    const bundle = parseNearbyResponse(NEARBY_RESPONSE);
    expect(bundle.bindings).toHaveLength(3);

    const candidates = bundle.bindings
      .map(normalizeNearbyCandidate)
      .filter((candidate) => candidate !== null);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.coordinates).toEqual({
      lat: 48.85837,
      lng: 2.294481,
    });

    const foreign = parseNearbyResponse(NEARBY_FOREIGN_HOST_RESPONSE);
    expect(normalizeNearbyCandidate(foreign.bindings[0])).toBeNull();
  });

  it("normalizes Commons metadata and strips HTML from the credit", () => {
    const bundle = parseImageInfoResponse(IMAGEINFO_LICENSED_RASTER);
    const metadata = normalizeFileMetadata(bundle.pages[0]);
    expect(metadata?.artist).toBe("Benh LIEU SONG");
    expect(metadata?.licenceShortName).toBe("CC BY-SA 4.0");
    expect(metadata?.mime).toBe("image/jpeg");
    expect(metadata?.thumbnailWidth).toBe(800);

    const svg = parseImageInfoResponse(IMAGEINFO_SVG);
    expect(normalizeFileMetadata(svg.pages[0])?.mime).toBe("image/svg+xml");
  });

  it("recognises each historical Creative Commons version as itself", () => {
    /* Never remapped: each name resolves to its own version, and every one obliges a credit and a licence link. */
    const expected: Array<[string, string]> = [
      ["CC BY 2.0", "CC-BY-2.0"],
      ["CC BY 2.5", "CC-BY-2.5"],
      ["CC BY 3.0", "CC-BY-3.0"],
      ["CC BY 4.0", "CC-BY-4.0"],
      ["CC BY-SA 2.0", "CC-BY-SA-2.0"],
      ["CC BY-SA 2.5", "CC-BY-SA-2.5"],
      ["CC BY-SA 3.0", "CC-BY-SA-3.0"],
      ["CC BY-SA 4.0", "CC-BY-SA-4.0"],
      ["cc-by-sa-3.0", "CC-BY-SA-3.0"],
      ["Attribution-ShareAlike 3.0 Unported", "CC-BY-SA-3.0"],
    ];

    for (const [name, licence] of expected) {
      const key = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      expect(COMMONS_LICENCES[key]).toBe(licence);
      expect(attributionIsRequired(licence as never)).toBe(true);
      expect(licenceLinkIsRequired(licence as never)).toBe(true);
    }
  });

  it("refuses an unversioned or ported licence name", () => {
    /* Neither says which licence document a reuser must comply with, so neither may be recognised. */
    expect(COMMONS_LICENCES["cc by sa"]).toBeUndefined();
    expect(COMMONS_LICENCES["cc by sa 3 0 de"]).toBeUndefined();
  });

  it("persists Wikidata's description as a fact, in its own language", () => {
    const bundle = parseEntityDataResponse(ENTITY_DATA_RESPONSE);
    const raw = bundle.entities.get(FIXTURE_QID);
    expect(raw).toBeDefined();
    if (!raw) return;

    const facts = buildLandmarkFacts({
      entity: normalizeEntity(raw, "fr"),
      retrievedAt: "2026-07-28T12:00:00.000Z",
    });

    const description = facts.find(
      (fact) => fact.kind === "official-description",
    );
    expect(description?.value).toBe("tour à Paris, France");
    expect(description?.provenance.provider).toBe("wikidata");
    expect(description?.provenance.licence).toBe("CC0-1.0");
    expect(description?.provenance.externalId).toBe(FIXTURE_QID);
    /* CC0 obliges no credit, so none is invented — and `editorial-summary` is nowhere near this. */
    expect(description?.provenance.attributionText).toBeUndefined();
    expect(facts.some((fact) => fact.kind === "editorial-summary")).toBe(false);
    /* The canonical name stays OpenStreetMap's: no fact here claims what the place is called. */
    expect(facts.some((fact) => fact.kind === "category")).toBe(false);
  });

  it("refuses a promotional description as a stored fact", () => {
    expect(descriptionProblem("tower in Paris, France")).toBeNull();
    expect(descriptionProblem("a must-see hidden gem")).not.toBeNull();
    expect(descriptionProblem("open daily, tickets from €25")).not.toBeNull();
  });

  it("refuses a malformed envelope, a prototype key and a deep payload", () => {
    expect(() => parseEntityDataResponse(MALFORMED_ENTITY_ENVELOPE)).toThrow();
    expect(() =>
      parseEntityDataResponse(PROTOTYPE_POLLUTION_ENVELOPE),
    ).toThrow();
    expect(() => parseEntityDataResponse(deeplyNestedPayload(40))).toThrow();
  });
});
