import { WikimediaError, type WikimediaEndpoint } from "./errors";

/**
 * Deterministic fixtures for the Wikimedia adapter.
 *
 * ## Why raw payloads and not only normalized records
 *
 * Section 4's list includes a malformed payload, a 403 and an oversized response — none of which can be expressed as a
 * normalized record, because the whole point of them is that normalization never happens. So this module supplies
 * three kinds of fixture:
 *
 *  - **raw payloads**, shaped as the five endpoints actually answer, so a test can exercise the parse boundary
 *  - **normalized records**, so a test about the orchestrator's routing does not have to go through a parse it is not
 *    testing
 *  - **error factories**, for the HTTP conditions the client classifies
 *
 * ## One landmark, used everywhere
 *
 * `Q243` and the Eiffel Tower, across every fixture that needs a subject. A single subject means a test asserting
 * "the direct path and the title path reach the same entity" is asserting something real rather than comparing two
 * unrelated constants — and it keeps the media subject check meaningful, since the file title shares a word with the
 * place name exactly as a real Commons file does.
 *
 * ## Factories, not shared instances
 *
 * The errors are functions rather than module-level constants. A `WikimediaError` carries a `cause` and a stack, and a
 * single shared instance asserted against in twelve tests is a value one of them can mutate for the others.
 */

/* -------------------------------------------------------------------------- */
/* The subject                                                                */
/* -------------------------------------------------------------------------- */

export const FIXTURE_QID = "Q243";
export const FIXTURE_LABEL_EN = "Eiffel Tower";
export const FIXTURE_LABEL_FR = "tour Eiffel";
export const FIXTURE_ARTICLE_EN = "Eiffel Tower";
export const FIXTURE_ARTICLE_FR = "Tour Eiffel";
export const FIXTURE_FILE_TITLE = "File:Tour Eiffel Wikimedia Commons.jpg";
export const FIXTURE_COORDINATES = { lat: 48.85837, lng: 2.294481 };

/** Wikidata's item for Earth, which `normalize.ts` requires a coordinate to be on. */
const EARTH_GLOBE = "http://www.wikidata.org/entity/Q2";

const GREGORIAN = "http://www.wikidata.org/entity/Q1985727";

/** One statement, in the shape `Special:EntityData` and `wbgetentities` both use. */
function statement(
  property: string,
  type: string,
  value: unknown,
  rank = "normal",
): Record<string, unknown> {
  return {
    mainsnak: {
      snaktype: "value",
      property,
      datatype: type,
      datavalue: { value, type },
    },
    type: "statement",
    rank,
  };
}

/* -------------------------------------------------------------------------- */
/* Direct QID success                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A complete `Special:EntityData/Q243.json` body, trimmed to the properties Roamly reads.
 *
 * Carries one statement Roamly deliberately ignores — `P2048`, a quantity — so a test can assert that an unmodelled
 * `datavalue.type` is dropped rather than failing the entity.
 */
export const ENTITY_DATA_RESPONSE: Record<string, unknown> = {
  entities: {
    [FIXTURE_QID]: {
      type: "item",
      id: FIXTURE_QID,
      labels: {
        en: { language: "en", value: FIXTURE_LABEL_EN },
        fr: { language: "fr", value: FIXTURE_LABEL_FR },
      },
      descriptions: {
        en: { language: "en", value: "tower in Paris, France" },
        fr: { language: "fr", value: "tour à Paris, France" },
      },
      aliases: {
        en: [{ language: "en", value: "La Tour Eiffel" }],
      },
      claims: {
        P31: [
          statement("P31", "wikibase-entityid", {
            "entity-type": "item",
            "numeric-id": 1440300,
            id: "Q1440300",
          }),
        ],
        P625: [
          statement("P625", "globecoordinate", {
            latitude: FIXTURE_COORDINATES.lat,
            longitude: FIXTURE_COORDINATES.lng,
            precision: 0.0001,
            globe: EARTH_GLOBE,
          }),
        ],
        P571: [
          statement("P571", "time", {
            time: "+1887-01-28T00:00:00Z",
            precision: 11,
            calendarmodel: GREGORIAN,
          }),
        ],
        P856: [statement("P856", "string", "https://www.toureiffel.paris/en")],
        P18: [statement("P18", "string", "Tour Eiffel Wikimedia Commons.jpg")],
        /* Height in metres. A `quantity`, which `normalize.ts` models no reader for and must silently ignore. */
        P2048: [
          statement("P2048", "quantity", {
            amount: "+330",
            unit: "http://www.wikidata.org/entity/Q11573",
          }),
        ],
      },
      sitelinks: {
        enwiki: { site: "enwiki", title: FIXTURE_ARTICLE_EN },
        frwiki: { site: "frwiki", title: FIXTURE_ARTICLE_FR },
      },
    },
  },
};

/**
 * An entity whose only date is a century.
 *
 * `precision: 7` is real Wikidata data and must produce no year at all: "built in the 1800s" cannot be shown as
 * "Founded 1800", and a coarse precision rendered as a year is a fabricated fact.
 */
export const ENTITY_WITH_COARSE_DATE: Record<string, unknown> = {
  entities: {
    Q1000000: {
      type: "item",
      id: "Q1000000",
      labels: { en: { language: "en", value: "Old Bridge" } },
      claims: {
        P571: [
          statement("P571", "time", {
            time: "+1800-00-00T00:00:00Z",
            precision: 7,
            calendarmodel: GREGORIAN,
          }),
        ],
      },
    },
  },
};

/**
 * An entity whose coordinate is not on Earth.
 *
 * Wikidata holds coordinates for lunar craters, and the globe is the only field that distinguishes one — a lunar
 * latitude and longitude are in range and would pass a distance check against nothing.
 */
export const ENTITY_WITH_LUNAR_COORDINATE: Record<string, unknown> = {
  entities: {
    Q1000001: {
      type: "item",
      id: "Q1000001",
      labels: { en: { language: "en", value: "Tycho" } },
      claims: {
        P625: [
          statement("P625", "globecoordinate", {
            latitude: -43.31,
            longitude: -11.36,
            precision: 0.01,
            globe: "http://www.wikidata.org/entity/Q405",
          }),
        ],
      },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Missing entity, and partial success                                        */
/* -------------------------------------------------------------------------- */

/** `wbgetentities` reporting an entity it does not hold. A real answer, inside a 200. */
export const ENTITY_MISSING_RESPONSE: Record<string, unknown> = {
  entities: {
    Q99999999: { id: "Q99999999", missing: "" },
  },
  success: 1,
};

/**
 * A batch where one entity is usable and one is malformed.
 *
 * The partial-success case: `Q243` parses, the second entity's `id` is a number rather than a QID, and the bundle must
 * report one entity and one malformed key rather than failing the whole batch.
 */
export const BATCH_PARTIAL_RESPONSE: Record<string, unknown> = {
  entities: {
    [FIXTURE_QID]: (ENTITY_DATA_RESPONSE.entities as Record<string, unknown>)[
      FIXTURE_QID
    ],
    Q1000002: { id: 1000002, labels: { en: { language: "en", value: "x" } } },
  },
  success: 1,
};

/* -------------------------------------------------------------------------- */
/* Wikipedia title resolution                                                 */
/* -------------------------------------------------------------------------- */

/** `Tour Eiffel` on the French Wikipedia, resolving to `Q243`. */
export const PAGEPROPS_RESOLVED_RESPONSE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 12,
        ns: 0,
        title: FIXTURE_ARTICLE_FR,
        pageprops: { wikibase_item: FIXTURE_QID },
      },
    ],
  },
};

/** The same, reached through a rename MediaWiki followed and reported. */
export const PAGEPROPS_REDIRECTED_RESPONSE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    redirects: [{ from: "La Tour Eiffel", to: FIXTURE_ARTICLE_FR }],
    pages: [
      {
        pageid: 12,
        ns: 0,
        title: FIXTURE_ARTICLE_FR,
        pageprops: { wikibase_item: FIXTURE_QID },
      },
    ],
  },
};

/**
 * A disambiguation page.
 *
 * The dangerous case rather than the empty one: it carries a perfectly good `wikibase_item`, and accepting it would
 * attach the facts and photograph of a list of same-named places to one real building.
 */
export const PAGEPROPS_DISAMBIGUATION_RESPONSE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 99,
        ns: 0,
        title: "Springfield",
        pageprops: { wikibase_item: "Q1000003", disambiguation: "" },
      },
    ],
  },
};

/** No such article. */
export const PAGEPROPS_MISSING_RESPONSE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [{ ns: 0, title: "Nonexistent Article", missing: true }],
  },
};

/** An article that exists and points at nothing. */
export const PAGEPROPS_NO_ENTITY_RESPONSE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [{ pageid: 77, ns: 0, title: "A Stub Article" }],
  },
};

/* -------------------------------------------------------------------------- */
/* Nearby fallback                                                            */
/* -------------------------------------------------------------------------- */

function binding(
  qid: string,
  label: string,
  lat: number,
  lng: number,
  instanceOfLabel?: string,
): Record<string, unknown> {
  return {
    item: { type: "uri", value: `http://www.wikidata.org/entity/${qid}` },
    itemLabel: { type: "literal", value: label, "xml:lang": "en" },
    /* `Point(lng lat)` — longitude first, which is the opposite of every other coordinate in this codebase. */
    coord: {
      datatype: "http://www.opengis.net/ont/geosparql#wktLiteral",
      type: "literal",
      value: `Point(${lng} ${lat})`,
    },
    ...(instanceOfLabel
      ? {
          instanceOfLabel: {
            type: "literal",
            value: instanceOfLabel,
            "xml:lang": "en",
          },
        }
      : {}),
  };
}

/**
 * A nearby answer with three rows: the subject, a same-category neighbour, and a row with no coordinate.
 *
 * Enough to exercise all three arms of the matcher from one payload — the name agrees on the first, only the category
 * agrees on the second, and the third must be dropped by `normalizeNearbyCandidate` before any judgement.
 */
export const NEARBY_RESPONSE: Record<string, unknown> = {
  head: {
    vars: ["item", "itemLabel", "itemDescription", "coord", "instanceOfLabel"],
  },
  results: {
    bindings: [
      binding(
        FIXTURE_QID,
        FIXTURE_LABEL_EN,
        FIXTURE_COORDINATES.lat,
        FIXTURE_COORDINATES.lng,
        "tower",
      ),
      binding(
        "Q1000004",
        "Champ de Mars",
        FIXTURE_COORDINATES.lat + 0.001,
        FIXTURE_COORDINATES.lng + 0.001,
        "public park",
      ),
      {
        item: { type: "uri", value: "http://www.wikidata.org/entity/Q1000005" },
        itemLabel: { type: "literal", value: "Something", "xml:lang": "en" },
      },
    ],
  },
};

/** No entity within the radius. A real answer, and the one most likely to change as coverage grows. */
export const NEARBY_EMPTY_RESPONSE: Record<string, unknown> = {
  head: { vars: ["item"] },
  results: { bindings: [] },
};

/**
 * A row whose item URI names a host other than Wikidata's.
 *
 * `qidFromEntityUri` must refuse it: an answer naming another host is an answer that did not come from the endpoint we
 * queried, and taking the last path segment would accept it.
 */
export const NEARBY_FOREIGN_HOST_RESPONSE: Record<string, unknown> = {
  head: { vars: ["item"] },
  results: {
    bindings: [
      {
        item: { type: "uri", value: "https://evil.example/entity/Q243" },
        coord: {
          type: "literal",
          value: `Point(${FIXTURE_COORDINATES.lng} ${FIXTURE_COORDINATES.lat})`,
        },
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Commons media                                                              */
/* -------------------------------------------------------------------------- */

function extField(value: string | boolean): Record<string, unknown> {
  return { value, source: "commons-desc-page" };
}

/** A licensed raster: CC BY-SA 4.0, a named author, a licence URL, and real dimensions. */
export const IMAGEINFO_LICENSED_RASTER: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 100,
        ns: 6,
        title: FIXTURE_FILE_TITLE,
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg",
            descriptionurl:
              "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg",
            thumburl:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/800px-Tour_Eiffel_Wikimedia_Commons.jpg",
            thumbwidth: 800,
            thumbheight: 1201,
            width: 2832,
            height: 4256,
            mime: "image/jpeg",
            extmetadata: {
              /* Real Commons values are HTML, which `plainText` has to strip before this is a credit. */
              Artist: extField(
                '<a href="//commons.wikimedia.org/wiki/User:Benh" title="User:Benh">Benh LIEU SONG</a>',
              ),
              LicenseShortName: extField("CC BY-SA 4.0"),
              License: extField("cc-by-sa-4.0"),
              LicenseUrl: extField(
                "https://creativecommons.org/licenses/by-sa/4.0",
              ),
              AttributionRequired: extField("true"),
              ObjectName: extField("Tour Eiffel Wikimedia Commons"),
              ImageDescription: extField(
                "The Eiffel Tower seen from the Champ de Mars.",
              ),
            },
          },
        ],
      },
    ],
  },
};

/** A file with no licence field at all. Refused rather than assumed. */
export const IMAGEINFO_MISSING_LICENCE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 101,
        ns: 6,
        title: FIXTURE_FILE_TITLE,
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg",
            descriptionurl:
              "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg",
            thumburl:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel_Wikimedia_Commons.jpg/800px-Tour_Eiffel_Wikimedia_Commons.jpg",
            thumbwidth: 800,
            thumbheight: 1201,
            mime: "image/jpeg",
            extmetadata: {
              Artist: extField("Somebody"),
              ObjectName: extField("Tour Eiffel Wikimedia Commons"),
            },
          },
        ],
      },
    ],
  },
};

/**
 * An SVG.
 *
 * Refused even though Commons offers a PNG thumbnail for it: an SVG is a document that can carry script and external
 * references, and the record should describe the file it links to.
 */
export const IMAGEINFO_SVG: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 102,
        ns: 6,
        title: "File:Tour Eiffel diagram.svg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/1/12/Tour_Eiffel_diagram.svg",
            descriptionurl:
              "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_diagram.svg",
            thumburl:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Tour_Eiffel_diagram.svg/800px-Tour_Eiffel_diagram.svg.png",
            thumbwidth: 800,
            thumbheight: 1200,
            mime: "image/svg+xml",
            extmetadata: {
              LicenseShortName: extField("CC0"),
              ObjectName: extField("Tour Eiffel diagram"),
            },
          },
        ],
      },
    ],
  },
};

/**
 * A thumbnail on a host the allowlist does not permit.
 *
 * The host that ends with the allowed string, which a suffix test would accept — and which would become an `<img src>`
 * in a traveller's browser.
 */
export const IMAGEINFO_UNSAFE_HOST: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 103,
        ns: 6,
        title: FIXTURE_FILE_TITLE,
        imageinfo: [
          {
            descriptionurl:
              "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg",
            thumburl:
              "https://upload.wikimedia.org.evil.example/800px-Tour_Eiffel.jpg",
            thumbwidth: 800,
            thumbheight: 1201,
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: extField("CC0"),
              ObjectName: extField("Tour Eiffel Wikimedia Commons"),
            },
          },
        ],
      },
    ],
  },
};

/** A generic destination image standing in for a specific building. Refused on its title. */
export const IMAGEINFO_GENERIC_IMAGE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [
      {
        pageid: 104,
        ns: 6,
        title: "File:Location map of Paris.png",
        imageinfo: [
          {
            descriptionurl:
              "https://commons.wikimedia.org/wiki/File:Location_map_of_Paris.png",
            thumburl:
              "https://upload.wikimedia.org/wikipedia/commons/thumb/0/00/Location_map_of_Paris.png/800px-Location_map_of_Paris.png",
            thumbwidth: 800,
            thumbheight: 600,
            mime: "image/png",
            extmetadata: {
              LicenseShortName: extField("CC0"),
              ObjectName: extField("Location map of Paris"),
            },
          },
        ],
      },
    ],
  },
};

/** Commons holds no such file. */
export const IMAGEINFO_MISSING_FILE: Record<string, unknown> = {
  batchcomplete: true,
  query: {
    pages: [{ ns: 6, title: "File:Nothing here.jpg", missing: true }],
  },
};

/* -------------------------------------------------------------------------- */
/* Malformed and oversized                                                    */
/* -------------------------------------------------------------------------- */

/** The right JSON, the wrong shape. The outer envelope is refused rather than partially read. */
export const MALFORMED_ENTITY_ENVELOPE: Record<string, unknown> = {
  somethingElse: true,
};

/** A record key that would assign through to a prototype under `JSON.parse`. */
export const PROTOTYPE_POLLUTION_ENVELOPE: Record<string, unknown> = JSON.parse(
  '{"entities":{"__proto__":{"id":"Q243"}}}',
) as Record<string, unknown>;

/**
 * A payload nested past the structural depth bound.
 *
 * Small on the wire and expensive to walk, which is why the bound exists at all — the byte cap in `config.ts` would
 * not catch this one.
 */
export function deeplyNestedPayload(depth = 40): Record<string, unknown> {
  let node: Record<string, unknown> = { end: true };
  for (let level = 0; level < depth; level += 1) {
    node = { nested: node };
  }
  return { entities: { [FIXTURE_QID]: node } };
}

/* -------------------------------------------------------------------------- */
/* HTTP conditions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 403 — the documented answer to a missing or unacceptable `User-Agent`, and also what a blocked client receives.
 *
 * `abandonsRun` is true for it: asking eleven more times is how a soft block becomes a hard one.
 */
export function forbiddenError(
  endpoint: WikimediaEndpoint = "wikidata-entity",
): WikimediaError {
  return new WikimediaError(
    "forbidden",
    endpoint,
    "Wikimedia refused the request. The User-Agent may be unacceptable, or this client may be blocked.",
    { status: 403 },
  );
}

/** 429 — never retried, and it abandons the run. `retryAfterMs` is used to ask *less*, not to schedule a retry. */
export function rateLimitedError(
  endpoint: WikimediaEndpoint = "wikidata-api",
  retryAfterMs = 30_000,
): WikimediaError {
  return new WikimediaError(
    "rate_limited",
    endpoint,
    "Wikimedia rate limited this client.",
    { status: 429, retryAfterMs },
  );
}

/** A transient 5xx — the only kind `retryable` permits a second attempt for. */
export function unavailableError(
  endpoint: WikimediaEndpoint = "wikidata-sparql",
  status = 503,
): WikimediaError {
  return new WikimediaError(
    "unavailable",
    endpoint,
    `Wikimedia responded ${status}`,
    { status },
  );
}

/**
 * A body over the byte cap.
 *
 * The condition `entity.ts` answers by asking a *narrower* question rather than by retrying — the same QID through
 * `wbgetentities`, which honours a property filter and returns a fraction of the bytes.
 */
export function responseTooLargeError(
  endpoint: WikimediaEndpoint = "wikidata-entity",
): WikimediaError {
  return new WikimediaError(
    "response_too_large",
    endpoint,
    "Response exceeded the byte cap and was abandoned.",
    { status: 200 },
  );
}

/** A body that parsed as JSON and failed its schema. Not retryable: the next attempt would be identical. */
export function invalidResponseError(
  endpoint: WikimediaEndpoint = "wikidata-entity",
): WikimediaError {
  return new WikimediaError(
    "invalid_response",
    endpoint,
    "The Wikimedia response was not a Wikidata entity response.",
  );
}

/** An HTML body served under a 200 by a service under load. Classified `unavailable`, so worth the one retry. */
export const BUSY_HTML_BODY =
  "<!DOCTYPE html><html><head><title>Service Temporarily Unavailable</title></head>" +
  "<body><h1>Our servers are too busy right now. Please try again later.</h1></body></html>";
