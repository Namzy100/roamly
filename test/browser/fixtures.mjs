import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This directory, resolved from this file rather than from `process.cwd()`.
 *
 * The suite is launched from the project root today, and a fixture that reads a path relative to the cwd is a fixture
 * that breaks the first time somebody runs it from anywhere else — with an error about a missing JSON file rather than
 * about the working directory.
 */
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * A 2x2 baseline JPEG, as bytes.
 *
 * Base64 rather than a checked-in binary: the image is smaller as a literal than as a file, and a fixture that reads an
 * asset from disk is one more thing that can be missing.
 *
 * ## Why this is not the 1x1 it used to be
 *
 * The previous literal was a widely copied "smallest JPEG" whose DQT segment declared length 67 — two length bytes, one
 * Pq/Tq byte and 64 coefficients — but carried only 63 coefficients. A decoder that trusts the declared length reads the
 * following `0xFF` as the missing 64th coefficient, so the marker chain desynchronises one byte early and the SOF0 that
 * holds the dimensions is never reached. Chrome answered 200, fired `error`, and reported `naturalWidth === 0`; nothing
 * in the network layer was wrong, which is what made it expensive to find. `sips` agreed: format `jpeg`, dimensions nil.
 *
 * This replacement came out of a real encoder with its APP1/APP13 metadata stripped, so every segment length matches its
 * payload and the chain walks cleanly from SOI to EOI. Two pixels rather than one because a 1x1 image has no interior,
 * so it cannot catch a decoder that mishandles an incomplete MCU.
 */
const MEDIA_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAEBAQEBAQGBAQGCQYGBgkMCQkJCQwPDAwMDAwPEg8PDw8PDxISEhISEhISFRUVFRUVGRkZGRkcHBwcHBwcHBwc/9sAQwEEBQUHBwcMBwcMHRQQFB0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0d/90ABAAB/9oADAMBAAIRAxEAPwDrtM/5Btp/1xj/APQRV6qOmf8AINtP+uMf/oIq9WwH/9k=",
  "base64",
);

/** The exact bytes above. Not a guess — measured from the encoder's output. */
const MEDIA_JPEG_SHA256 =
  "7427f1876c4865c4bed0cd731f7c221a235650532e9d56a6557c6c7813cea3bc";

/**
 * The image is a decodable JPEG, checked before any scenario can depend on it.
 *
 * A structurally broken image does not fail here, in the fixture — it fails in the browser as "the card shows no
 * photograph", one whole pipeline away from the cause, with a clean 200 in the network panel. This turns that into an
 * import-time error naming the bytes. A magic-byte check would not have caught the old literal: it began `FFD8FFE0` and
 * ended `FFD9`, and was undecodable in between.
 */
{
  const digest = createHash("sha256").update(MEDIA_JPEG).digest("hex");
  if (digest !== MEDIA_JPEG_SHA256) {
    throw new Error(
      `the fixture JPEG has changed: expected ${MEDIA_JPEG_SHA256}, got ${digest}`,
    );
  }

  if (MEDIA_JPEG.readUInt16BE(0) !== 0xffd8) {
    throw new Error("the fixture JPEG does not begin with SOI");
  }

  /* Every segment length agrees with its payload, from SOI to SOS — the property the old literal violated. */
  let cursor = 2;
  let dimensions = null;
  while (cursor < MEDIA_JPEG.length - 1) {
    if (MEDIA_JPEG[cursor] !== 0xff) {
      throw new Error(
        `the fixture JPEG's marker chain desynchronises at byte ${cursor}`,
      );
    }
    const marker = MEDIA_JPEG[cursor + 1];
    if (marker === 0xd9) break;
    /* SOF0 and SOF2 carry the dimensions a decoder needs; a chain that never reaches one decodes to 0x0. */
    if (marker === 0xc0 || marker === 0xc2) {
      dimensions = {
        height: MEDIA_JPEG.readUInt16BE(cursor + 5),
        width: MEDIA_JPEG.readUInt16BE(cursor + 7),
      };
    }
    /* Entropy-coded data follows SOS and is not length-prefixed, so the walk stops there. */
    if (marker === 0xda) break;
    cursor += 2 + MEDIA_JPEG.readUInt16BE(cursor + 2);
  }
  if (dimensions === null) {
    throw new Error("the fixture JPEG has no reachable frame header");
  }
  if (dimensions.width < 1 || dimensions.height < 1) {
    throw new Error(
      `the fixture JPEG declares ${dimensions.width}x${dimensions.height}`,
    );
  }
}

/**
 * Local stand-ins for every external service, so browser verification can run
 * repeatedly without touching anything real.
 *
 * ## Why this exists rather than stubbing `/api/*`
 *
 * Intercepting our own API routes from the browser would verify the React layer and
 * nothing else. Standing in for the *providers* instead means the whole server
 * pipeline genuinely runs — strategy, discovery, assembly, mechanical validation,
 * canonical attachment, the immutable builder, the pool gate — with nothing leaving
 * the machine. That is the same approach Phase 5A took with a fake Valhalla, for the
 * same reason.
 *
 * Every server counts its requests, which is what lets the suite assert the negative
 * properties that matter most: that a rapid double-click produces **one** generation,
 * and that generating a trip makes **zero** routing requests.
 *
 * ## The Gemini fixture is a planner, not a recording
 *
 * It reads the candidate list out of the prompt and fills the strategy's slots from
 * it. A recorded response would reference placeIds that the Overpass fixture might no
 * longer be returning, and the run would fail for a reason that has nothing to do
 * with the code. Reading the real input keeps the two in agreement, and it is what
 * makes the `fabricate` mode a genuine test — the same planner, with one id swapped
 * for one that was never discovered.
 */

/* -------------------------------------------------------------------------- */
/* Place data                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Real Lisbon coordinates, so mode selection and the map behave normally.
 *
 * ## The `opening_hours` strings are chosen, not incidental
 *
 * The browser run books 2026-09-12 to 09-13 — a Saturday and a Sunday — and the fixture
 * planner schedules breakfast at 09:00, the museum at 10:30 and dinner at 19:30. Each string
 * below therefore lands on a specific Phase 6B state, and the whole set covers all of them:
 *
 *  - 2002 opens at 11:00 → a conflict the generation repair *can* fix by moving the clock,
 *    after which the same stop reads `confirmed_open`
 *  - 3003 weekdays only → a conflict it cannot, so the interface must offer the repairs
 *  - 4001 a holiday clause → `unknown_unparsed`, shown verbatim rather than half-read
 *  - 3001 no tag, and unused by the itinerary → a replacement candidate, hours unknown
 *  - everything else no tag → `unknown_no_data`, the commonest real case
 *
 * The ids are the ones the fixture planner actually schedules on day one. Tagging a place it
 * happens not to choose would leave the states untested while looking covered.
 */
const ELEMENTS = [
  el(1001, 38.7169, -9.1409, {
    name: "Fábrica Coffee Roasters",
    amenity: "cafe",
    "addr:street": "R. das Portas de Santo Antão",
    "addr:housenumber": "136",
    opening_hours: "Mo-Su 08:00-19:00",
  }),
  el(1002, 38.7099, -9.1435, { name: "Manteigaria", amenity: "cafe" }),
  el(1003, 38.7126, -9.1354, { name: "Café Buenos Aires", amenity: "cafe" }),
  el(2001, 38.7248, -9.115, {
    name: "Museu Nacional do Azulejo",
    tourism: "museum",
    "addr:street": "R. Madre de Deus",
  }),
  el(2002, 38.6957, -9.1936, {
    name: "MAAT",
    tourism: "museum",
    // Scheduled at 10:45 and opening at 11:00: the deterministic repair can fix this by
    // moving the clock, and must say that it did.
    opening_hours: "Mo-Su 11:00-18:00",
  }),
  el(3001, 38.7128, -9.1279, {
    name: "Ti-Natércia",
    amenity: "restaurant",
    cuisine: "portuguese",
  }),
  el(3002, 38.7215, -9.1355, {
    name: "Cervejaria Ramiro",
    amenity: "restaurant",
    cuisine: "seafood",
  }),
  el(3003, 38.7097, -9.1444, {
    name: "Cantinho do Avillez",
    amenity: "restaurant",
    // Closed all weekend, and the trip is a weekend — the conflict the interface must
    // surface with repairs rather than silently rearrange.
    opening_hours: "Mo-Fr 19:00-23:00",
  }),
  el(4001, 38.7113, -9.1305, {
    name: "Santiago de Alfama",
    tourism: "hotel",
    website: "https://example.test",
    // A holiday clause. Must read as "hours not checked" with the string shown verbatim,
    // never as a confident reading of the half we do understand.
    opening_hours: "Mo-Fr 09:00-17:00; PH off",
  }),
  el(5001, 38.7122, -9.13, {
    name: "Miradouro das Portas do Sol",
    tourism: "viewpoint",
  }),
  el(6001, 38.7157, -9.1249, { name: "Feira da Ladra", amenity: "marketplace" }),
  el(7001, 38.728, -9.154, { name: "Estufa Fria", leisure: "garden" }),
];

function el(id, lat, lon, tags) {
  return { type: "node", id, lat, lon, tags };
}

/** Categories that describe where the traveller sleeps rather than a stop on the day. */
const ACCOMMODATION_CATEGORIES = new Set(["hotel", "hostel", "guest_house"]);

/** Which OSM tag pairs each allowlisted category is queried by. */
const CATEGORY_TAGS = {
  cafe: ["amenity=cafe"],
  restaurant: ["amenity=restaurant"],
  museum: ["tourism=museum"],
  hotel: ["tourism=hotel"],
  hostel: ["tourism=hostel"],
  guest_house: ["tourism=guest_house", "tourism=apartment"],
  viewpoint: ["tourism=viewpoint"],
  market: ["amenity=marketplace", "shop=greengrocer"],
  garden: ["leisure=garden"],
};

/* -------------------------------------------------------------------------- */
/* Servers                                                                     */
/* -------------------------------------------------------------------------- */

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Nominatim.
 *
 * Returns **two** candidates for anything containing "lisbon", so the ambiguous
 * destination path is the default rather than an exotic case — the interface must
 * make the traveller choose, and a fixture with one answer would never prove it.
 */
export async function startNominatim() {
  const state = { requests: 0 };

  const server = createServer((request, response) => {
    state.requests += 1;
    const url = new URL(request.url, "http://localhost");
    const query = (url.searchParams.get("q") ?? "").toLowerCase();

    const candidates = query.includes("lisbon")
      ? [
          {
            osm_type: "relation",
            osm_id: 5400890,
            name: "Lisbon",
            display_name: "Lisbon, Portugal",
            lat: 38.7223,
            lon: -9.1393,
            boundingbox: ["38.69", "38.80", "-9.23", "-9.09"],
            address: { country_code: "pt" },
          },
          {
            osm_type: "relation",
            osm_id: 182234,
            name: "Lisbon",
            display_name: "Lisbon, Columbiana County, Ohio, United States",
            lat: 40.7739,
            lon: -80.7684,
            boundingbox: ["40.76", "40.79", "-80.79", "-80.75"],
            address: { country_code: "us" },
          },
        ]
      : [];

    respondJson(response, candidates);
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Overpass.
 *
 * Reads the requested categories out of the query text and answers with matching
 * elements, so a category with nothing mapped genuinely comes back empty and the
 * pipeline's "unavailable slot" path is exercised for real.
 *
 * `omit` drops a category from the answer, which is how the partial-result scenario is
 * produced.
 */
/**
 * The Wikidata tag that turns one fixture museum into a direct-QID match.
 *
 * ## Why it is opt-in
 *
 * Adding a tag to the shared element list would change what every other scenario's generation receives. Twelve
 * scenarios assert against these places, and a fixture change that quietly altered one of them would surface as a
 * failure with nothing to do with the change. So `startOverpass({ landmark: true })` is the only way to see it.
 *
 * ## Why the scheduled museum is the one tagged, and why it is renamed
 *
 * Both facts were learned the hard way, and both are worth writing down.
 *
 * Tagging *two* museums produced an identity collision: two places cannot hold one Wikidata entity, so the second was
 * correctly downgraded to `name-and-proximity` — rank 1, untrusted, no facts. Correct behaviour, and a fixture that
 * exercises it by accident is a fixture that reads as broken. So exactly one place carries the tag, and it is the one
 * the fixture planner actually schedules: a tagged pool candidate that never reaches the itinerary has no card, and
 * every card check then fails for a reason unrelated to the code.
 *
 * The rename is what lets the *media* path run. `media.ts` checks that a Commons file is plausibly of the place, and
 * the adapter's fixture file is `File:Tour Eiffel Wikimedia Commons.jpg`. A file title sharing no word with the place
 * name is refused — correctly — so the subject has to agree with the fixture for the licence and attribution path to
 * be reachable at all. "Eiffel Tower" also sorts ahead of the other museum, which is what keeps it the scheduled one.
 *
 * The result is a Lisbon itinerary containing a stop called "Eiffel Tower". A fixture reading oddly is the price of a
 * media path that is genuinely covered; the alternative is a second Wikidata entity fixture to keep in step forever.
 */
const LANDMARK_TAGGED_ELEMENT_IDS = new Set([2002]);
const LANDMARK_TAGS = { name: "Eiffel Tower", wikidata: "Q243" };

export async function startOverpass({ omit = [], landmark = false } = {}) {
  /**
   * `exclude` and `rename` are how a *second* search can differ from the first.
   *
   * A refresh whose result is byte-identical to the original produces an empty diff, which
   * exercises nothing — and the only honest way to make the two differ is to change what the
   * provider returns between them. Setting `state.exclude` mid-run is the fixture equivalent of
   * a mapper retagging a node, and `state.rename` of one correcting a name.
   */
  const state = { requests: 0, exclude: new Set(), rename: new Map() };

  const server = createServer((request, response) => {
    state.requests += 1;

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const query = decodeURIComponent(body.replace(/^data=/, "").replace(/\+/g, " "));

      const wanted = new Set();
      for (const [category, pairs] of Object.entries(CATEGORY_TAGS)) {
        if (omit.includes(category)) continue;
        for (const pair of pairs) {
          const [key, value] = pair.split("=");
          if (query.includes(`["${key}"="${value}"]`)) wanted.add(pair);
        }
      }

      const elements = ELEMENTS.filter(
        (element) =>
          !state.exclude.has(element.id) &&
          Object.entries(element.tags).some((entry) =>
            wanted.has(`${entry[0]}=${entry[1]}`),
          ),
      )
        .map((element) =>
          state.rename.has(element.id)
            ? {
                ...element,
                tags: { ...element.tags, name: state.rename.get(element.id) },
              }
            : element,
        )
        .map((element) =>
          landmark && LANDMARK_TAGGED_ELEMENT_IDS.has(element.id)
            ? { ...element, tags: { ...element.tags, ...LANDMARK_TAGS } }
            : element,
        );

      respondJson(response, { version: 0.6, generator: "fixture", elements });
    });
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Valhalla.
 *
 * Present only so that "no routing request happens during generation" is a checkable
 * claim rather than an assumption, and so real routing still works afterwards.
 */
export async function startValhalla() {
  const state = { requests: 0 };

  const server = createServer((request, response) => {
    state.requests += 1;

    respondJson(response, {
      trip: {
        status: 0,
        status_message: "Found route between points",
        units: "kilometers",
        legs: [
          {
            summary: { length: 1.2, time: 900 },
            // A two-point encoded polyline through Alfama, at Valhalla's 1e6 precision.
            shape: "_grbcAvijxgD_pR_pR",
          },
        ],
        summary: { length: 1.2, time: 900 },
      },
    });
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * The response bodies, as the five Wikimedia endpoints actually answer.
 *
 * Generated from `lib/providers/place-intelligence/wikimedia/fixtures.ts` — the adapter's own fixtures — because this
 * file is plain ESM and cannot import TypeScript. `browser-bodies.test.ts` fails if the two drift, which is what makes
 * a generated file safe to depend on. Regenerate with:
 *
 *   `UPDATE_WIKIMEDIA_BODIES=1 npx vitest run lib/providers/place-intelligence/wikimedia/browser-bodies.test.ts`
 */
const BODIES = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "wikimedia-bodies.json"), "utf8"),
);

/** The entity document for a mode. `entityMalformed` is a body that parses as JSON and fails validation. */
function entityBodyFor(mode) {
  if (mode === "malformed") return BODIES.entityMalformed;
  if (mode === "empty") return BODIES.entityMissing;
  return BODIES.entityData;
}

/**
 * The Commons answer for a mode.
 *
 * Four of the five refusals the media policy exists for, each a real Commons response rather than an error: a file
 * with no licence, an SVG, a thumbnail on a host the allowlist does not name, and a title Commons does not hold. Those
 * four are how an *absent* media area is tested — a record the policy declined to display — and they are the only
 * honest way to test it. A malformed image served as `image/jpeg` would produce the same empty card for a completely
 * different reason and is never used for that purpose.
 *
 * `accepted` and `media-broken` are the two that may be displayed. They differ only in which thumbnail route the stored
 * URL names: `accepted` points at a valid JPEG and must render, `media-broken` points at a 404 and must degrade.
 */
function commonsBodyFor(mode, baseUrl) {
  switch (mode) {
    case "accepted":
      return withLocalFilePage(BODIES.imageinfoLicensedRaster, baseUrl);
    case "media-broken":
      return withLocalFilePage(BODIES.imageinfoLicensedRaster, baseUrl, {
        thumbnail: "broken.jpg",
      });
    case "media-unlicensed":
      return BODIES.imageinfoMissingLicence;
    case "media-svg":
      return BODIES.imageinfoSvg;
    case "media-unsafe-host":
      return BODIES.imageinfoUnsafeHost;
    default:
      return BODIES.imageinfoMissingFile;
  }
}

/**
 * The accepted file, with every Commons URL moved onto the fixture's own loopback origin.
 *
 * ## The file page
 *
 * `media.ts` requires a file page to be served by the same origin as the configured Commons API — a sound rule, since a
 * "source" link pointing somewhere other than the API that described the file is not a source. Overriding the API URL
 * for a fixture therefore invalidates the real `commons.wikimedia.org` page URL in the canned body, and the file is
 * refused for a reason that has nothing to do with what is under test.
 *
 * ## The image URLs, and why rewriting them is the honest choice
 *
 * `url` and `thumburl` are rewritten too, onto `/media/…` on this server. Leaving them on `upload.wikimedia.org` was
 * tried and abandoned: Chrome blocks that host for the whole run, so a record could be perfectly displayable and the
 * image could still never load — which left the suite unable to tell "the display policy refused this file" apart from
 * "the network refused it", and every media assertion written around a photograph expected to fail.
 *
 * The media allowlist is **not** broadened to achieve this. `isFixtureLoopbackUrl` in
 * `lib/place-intelligence/fixture-origin.ts` admits these URLs under the isolated browser-fixture policy alone, which
 * additionally requires the page's own hostname to be loopback — a condition no deployment can satisfy however its
 * environment is configured.
 *
 * ## `thumbnail` picks which route the record points at
 *
 * `thumb.jpg` serves a valid, decodable JPEG and is what the accepted path expects to render. `broken.jpg` answers 404,
 * which is how the image-failure path is driven. The *metadata* is identical either way — same licence, same credit,
 * same MIME, same declared dimensions — so the record is display-eligible in both, and the browser genuinely mounts the
 * image and attempts the request. That is the point: the failure under test is a dead URL, not a refused record.
 */
function withLocalFilePage(body, baseUrl, { thumbnail = "thumb.jpg" } = {}) {
  const pages = body.query.pages.map((page) => ({
    ...page,
    ...(page.imageinfo
      ? {
          imageinfo: page.imageinfo.map((info) => ({
            ...info,
            ...(info.descriptionurl
              ? { descriptionurl: `${baseUrl}/commons/wiki/file-page` }
              : {}),
            ...(info.url ? { url: `${baseUrl}/media/original.jpg` } : {}),
            ...(info.thumburl
              ? { thumburl: `${baseUrl}/media/${thumbnail}` }
              : {}),
          })),
        }
      : {}),
  }));

  return { ...body, query: { ...body.query, pages } };
}

/**
 * Wikidata, Wikipedia and Wikimedia Commons.
 *
 * ## Why it must exist at all
 *
 * Without it the *server* would query live Wikidata. Blocking the hosts in Chrome does nothing about that — the route
 * runs in Node — and a verification suite that queried volunteer infrastructure on every commit is one nobody could
 * run. `state.requests` and the per-endpoint counters let a scenario prove the fixture, rather than the internet, was
 * consulted, and that a second call asked about fewer places than the first.
 *
 * ## The modes
 *
 *  - `empty` — nothing found anywhere. The commonest real outcome, and the one whose copy has the most ways to be
 *    dishonest, so it is the default
 *  - `accepted` — a direct-QID entity with a description, a date, a designation and one displayable licensed raster,
 *    whose thumbnail is a valid JPEG this server serves and which the card is expected to decode and render
 *  - `media-broken` — the same accepted, display-eligible record with its thumbnail pointing at a route that answers
 *    404. The image mounts, the request is made, and it fails: the degradation path, driven by a dead URL rather than
 *    by corrupt bytes
 *  - `media-unlicensed`, `media-svg`, `media-unsafe-host` — the entity is accepted and the *file* is refused by policy,
 *    which must leave the description and the facts intact. These are how an absent media area is tested
 *  - `malformed` — a body that is valid JSON and invalid against the schema. Nothing is stored and nothing is claimed
 *
 * `delayMs` holds every answer back. A fixture that replies in two milliseconds makes an in-flight lookup
 * unobservable, so cancellation could not be verified at all — the behaviour under test only exists while a request
 * is outstanding.
 */
export async function startWikimedia({
  mode = "empty",
  delayMs = 0,
  allowFixtureUrls = true,
} = {}) {
  const state = { requests: 0, paths: [], entity: 0, commons: 0, sparql: 0 };

  /*
   * Assigned after `listen`, and read only inside a handler — which cannot run before then. The file-page rewrite needs
   * this server's own origin, and the port does not exist until the socket is bound.
   */
  let origin = "";

  const server = createServer((rawRequest, rawResponse) => {
    state.requests += 1;
    state.paths.push(rawRequest.url ?? "");

    const response = delayMs > 0 ? deferred(rawResponse, delayMs) : rawResponse;

    /* Bodies are drained even though nothing reads them: an unread POST body stalls the socket. */
    rawRequest.on("data", () => {});
    rawRequest.on("end", () => {
      const path = rawRequest.url ?? "";

      if (path.includes("/sparql")) {
        state.sparql += 1;
        /*
         * The nearby fallback. Empty in every mode: its matches are rank 1 and are never displayed, so a scenario
         * that wanted a *displayed* landmark would be testing the wrong rung of the ladder.
         */
        respondJson(response, BODIES.nearbyEmpty);
        return;
      }

      if (path.includes("EntityData") || path.includes("wbgetentities")) {
        state.entity += 1;
        respondJson(response, entityBodyFor(mode));
        return;
      }

      if (path.includes("/commons/")) {
        state.commons += 1;
        respondJson(response, commonsBodyFor(mode, origin));
        return;
      }

      if (path.startsWith("/media/")) {
        /*
         * Real bytes, so "one image renders" is a claim about a *decoded* image rather than about an element.
         *
         * `broken` answers 404, which is what the image-failure path uses: a genuine load failure delivered by the
         * transport, not a synthetic `error` event and not malformed bytes wearing an `image/jpeg` header. The
         * distinction matters — a 404 tests how the component degrades after a failed load, whereas corrupt bytes test
         * Chrome's JPEG parser, which is not Roamly's to verify.
         */
        if (path.includes("broken")) {
          rawResponse.writeHead(404, { "content-type": "text/plain" });
          rawResponse.end("not found");
          return;
        }
        /*
         * An explicit `content-length`, so the body is a single sized response rather than a chunked one.
         *
         * Node infers `transfer-encoding: chunked` when the length is unstated, which is legal and which Chrome handled
         * without complaint — but it costs the one header that would have shown a truncated body for what it was, and
         * `encodedDataLength` then reports framing overhead rather than the payload.
         */
        rawResponse.writeHead(200, {
          "content-type": "image/jpeg",
          "content-length": String(MEDIA_JPEG.length),
          "cache-control": "no-store",
        });
        rawResponse.end(MEDIA_JPEG);
        return;
      }

      /* A language Wikipedia's `api.php`, for the title path. */
      respondJson(
        response,
        mode === "empty" ? BODIES.pagepropsMissing : BODIES.pagepropsResolved,
      );
    });
  });

  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  origin = baseUrl;

  return {
    server,
    state,
    baseUrl,
    /**
     * The environment that points every Wikimedia endpoint at this server.
     *
     * Returned as one object so a scenario cannot wire three of the four and reach upstream for the fourth — the
     * failure that would look like a passing test until the day the network was down.
     */
    env: {
      ROAMLY_WIKIDATA_SPARQL_URL: `${baseUrl}/sparql`,
      ROAMLY_WIKIDATA_API_URL: `${baseUrl}/w/api.php`,
      ROAMLY_WIKIDATA_ENTITY_BASE_URL: `${baseUrl}/wiki/Special:EntityData`,
      ROAMLY_COMMONS_API_URL: `${baseUrl}/commons/w/api.php`,
      ROAMLY_WIKIPEDIA_API_URL_TEMPLATE: `${baseUrl}/{lang}/w/api.php`,
      /*
       * The private server-side allowance, in the same object as the endpoints it depends on.
       *
       * Media is fetched and licence-checked *during enrichment*, in Node, under `next dev` — so without this the
       * thumbnail is refused server-side and no photograph is ever stored, whatever the client bundle permits. That was
       * the exact cause of the media path being uncoverable: the public pair below fixed the browser half of the gate and
       * left this half untouched.
       *
       * `fixture-origin.ts` requires every one of the five endpoints above to be on this origin before it honours the
       * flag, which is why these live together: a scenario cannot acquire the HTTP allowance while one endpoint still
       * points at real Wikimedia. It also requires `NODE_ENV === "development"` and the absence of every deployment
       * marker, so `next build`, `next start` and any hosted process refuse regardless of this variable.
       *
       * `allowFixtureUrls: false` withholds the three, keeping the endpoints redirected. That is how a scenario proves
       * the same stored record is refused when the allowance is absent.
       */
      ...(allowFixtureUrls
        ? {
            ROAMLY_BROWSER_FIXTURE_RUN: "1",
            ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
            ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: baseUrl,
          }
        : {}),
    },
    /**
     * The build-time pair that lets a stored fixture URL survive validation in the browser.
     *
     * Separate from `env` because these are compiled into the client bundle rather than read at request time, so they
     * must be present before Next starts — and because a scenario that wants provider isolation without the URL
     * allowance should be able to have exactly that.
     */
    publicEnv: {
      NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
      NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: baseUrl,
    },
  };
}

/**
 * Gemini.
 *
 * `mode` selects the behaviour under test:
 *
 *  - `ok` — a valid strategy, then an assembly built from the supplied candidates
 *  - `fabricate` — the same, with one `placeId` that was never discovered
 *  - `fabricate-refinement` — generates cleanly, then fabricates when refining, so a
 *    refusal can be tested on a trip that exists
 *  - `refuse` — HTTP 200 with `promptFeedback.blockReason` and no candidates
 *  - `empty` — HTTP 200 with an empty candidate array
 *  - `rate-limit` — HTTP 429
 *
 * `delayMs` holds each answer back. A fixture that replies in 40 ms makes an in-flight
 * generation unobservable, so the cancel path could not be verified at all — the
 * traveller-facing behaviour under test only exists while a request is outstanding.
 */
export async function startGemini({ mode = "ok", delayMs = 0 } = {}) {
  const state = { requests: 0, operations: [] };

  const server = createServer((request, rawResponse) => {
    state.requests += 1;
    const response = delayMs > 0 ? deferred(rawResponse, delayMs) : rawResponse;

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (mode === "rate-limit") {
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "quota exceeded" } }));
        return;
      }
      if (mode === "refuse") {
        respondJson(response, { promptFeedback: { blockReason: "SAFETY" } });
        return;
      }
      if (mode === "empty") {
        respondJson(response, { candidates: [] });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        respondJson(response, { candidates: [] });
        return;
      }

      const userTurn = payload?.contents?.[0]?.parts?.[0]?.text ?? "";
      const input = extractInput(userTurn);

      /**
       * `action` first.
       *
       * A refinement input also carries `candidates`, so sniffing for that alone would
       * read a stop replacement as a whole-itinerary assembly and answer with the wrong
       * shape entirely.
       */
      const operation = input?.action
        ? input.action
        : Array.isArray(input?.candidates)
          ? "assembly"
          : "strategy";
      state.operations.push(operation);

      /**
       * `fabricate-refinement` generates cleanly and only fabricates on a refinement.
       * Without it the initial generation would be rejected and there would be no trip
       * to try refining.
       */
      const fabricate =
        mode === "fabricate" ||
        (mode === "fabricate-refinement" &&
          operation !== "strategy" &&
          operation !== "assembly");

      const answer = buildAnswer(operation, input, fabricate);

      respondJson(response, {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: JSON.stringify(answer) }] } },
        ],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 800 },
      });
    });
  });

  const port = await listen(server);
  return { server, state, baseUrl: `http://127.0.0.1:${port}` };
}

/* -------------------------------------------------------------------------- */
/* The fixture planner                                                         */
/* -------------------------------------------------------------------------- */

/** The `Input:` block of the user turn, which is where the pipeline puts its payload. */
function extractInput(text) {
  const start = text.indexOf("Input:");
  if (start === -1) return null;
  const brace = text.indexOf("{", start);
  if (brace === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = brace; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(brace, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Dispatches to the right builder for the operation the prompt is asking about. */
function buildAnswer(operation, input, fabricate) {
  switch (operation) {
    case "strategy":
      return buildStrategy(input);
    case "assembly":
      return buildAssembly(input, fabricate);
    case "replace-item":
      return buildReplaceItem(input, fabricate);
    case "replace-backup":
      return buildReplaceBackup(input, fabricate);
    case "adjust-day":
      return buildDayAdjustment(input);
    default:
      return buildStrategy(input);
  }
}

/**
 * A stop replacement: take the nearest eligible candidate.
 *
 * The candidates arrive already filtered and ordered by the server, so "the first one"
 * is a reasonable planner and needs no judgement the fixture does not have.
 */
function buildReplaceItem(input, fabricate) {
  const chosen = input.candidates?.[0];
  if (!chosen) {
    return {
      status: "unavailable",
      reason:
        "The search around this destination turned up no other place of this kind nearby.",
    };
  }

  return {
    status: "selected",
    // The `fabricate` mode names a place that was never offered, so the pool gate has
    // something real to catch.
    placeId: fabricate ? "osm:node:999999999" : chosen.placeId,
    description:
      "Chosen because it sits a short walk from the day's other stops and fills the same slot without moving the schedule.",
    estimatedCost: {
      amount: input.preferences?.cheaper ? 8 : 16,
      currency: input.currency ?? "EUR",
      basis: "category-estimate",
      confidence: "low",
    },
    reservationRecommended: false,
  };
}

function buildReplaceBackup(input, fabricate) {
  const chosen = input.candidates?.[0];
  if (!chosen) {
    return {
      status: "unavailable",
      reason: "The search returned nothing else of this kind to offer as a fallback.",
    };
  }

  return {
    status: "selected",
    placeId: fabricate ? "osm:node:999999999" : chosen.placeId,
    reason:
      "Another place of the same kind from the same search, close to the day's other stops.",
  };
}

/**
 * A day adjustment.
 *
 * Mirrors the deterministic planner's own moves — drop the priciest optional stop for
 * "cheaper", drop the last one for "more-relaxed", add one for "more-packed" — because
 * those are the changes the server's validators will accept, and a fixture that
 * proposed something invalid would be testing the rejection path by accident.
 */
function buildDayAdjustment(input) {
  const items = [...(input.items ?? [])].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
  /**
   * Somewhere to stay is not an optional stop.
   *
   * The check-in block is a place stop with no meal type, so a naive filter treats it as the
   * day's most droppable item — and because it is priced against the nightly band it is also the
   * most *expensive* one, which made "make this day cheaper" remove the hotel. Dropping it also
   * moves no budget category, since accommodation is canonical rather than derived from items,
   * so the day total fell while the trip total did not.
   */
  const optional = items.filter(
    (item) =>
      item.kind === "place" &&
      item.mealType === null &&
      !ACCOMMODATION_CATEGORIES.has(item.category),
  );

  let next = items;

  if (input.adjustment === "cheaper" || input.adjustment === "more-relaxed") {
    if (optional.length === 0) {
      return {
        status: "unavailable",
        reason:
          "This day is only meals and free time, so there is no optional stop to drop.",
      };
    }
    const target =
      input.adjustment === "cheaper"
        ? [...optional].sort(
            (a, b) =>
              b.estimatedCost - a.estimatedCost ||
              a.itemId.localeCompare(b.itemId),
          )[0]
        : optional[optional.length - 1];
    next = items.filter((item) => item.itemId !== target.itemId);
  } else {
    const candidate = input.candidates?.[0];
    const last = items[items.length - 1];
    if (!candidate || !last) {
      return {
        status: "unavailable",
        reason: "There is nothing left nearby to add to this day.",
      };
    }
    const start = addMinutes(last.endTime, 15);
    const end = addMinutes(start, 60);
    next = [
      ...items,
      {
        kind: "place",
        itemId: `added-${candidate.placeId.replace(/[^a-z0-9]+/gi, "").slice(-6).toLowerCase()}`,
        placeId: candidate.placeId,
        category: candidate.category,
        mealType: null,
        startTime: start,
        endTime: end,
        title: "One more stop",
        description:
          "Added into the day's remaining gap, with real time to get there from the previous stop.",
        estimatedCost: 18,
        reservationRecommended: false,
      },
    ];
  }

  return {
    status: "adjusted",
    dayNumber: input.dayNumber,
    summary: `Adjusted to be ${input.adjustment.replace(/-/g, " ")}, keeping both meals where they were and leaving real time between the stops that remain.`,
    items: next.map((item) => ({
      kind: item.kind,
      itemId: item.itemId,
      ...(item.kind === "place"
        ? {
            placeId: item.placeId,
            category: item.category,
            mealType: item.mealType,
            reservationRecommended: item.reservationRecommended ?? false,
          }
        : {}),
      ...(item.kind === "non-place"
        ? { category: item.nonPlaceCategory ?? "free-time" }
        : {}),
      ...(item.kind === "unavailable"
        ? { reason: item.description ?? "Nothing eligible was available." }
        : {}),
      startTime: item.startTime,
      endTime: item.endTime,
      ...(item.kind === "unavailable"
        ? {}
        : {
            title: item.title,
            description: item.description,
            estimatedCost: {
              amount: item.estimatedCost ?? 0,
              currency: input.currency ?? "EUR",
              basis: "category-estimate",
              confidence: "low",
            },
          }),
    })),
    backups: (input.backups ?? []).map((backup) => ({
      backupId: backup.backupId,
      placeId: backup.placeId,
      reason:
        "Carried over unchanged — this adjustment changed the day's stops, not its fallbacks.",
    })),
  };
}

function addMinutes(time, minutes) {
  const [hours, mins] = time.split(":").map(Number);
  const total = Math.min(23 * 60 + 30, hours * 60 + mins + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const MEALS = [
  { mealType: "breakfast", category: "cafe" },
  { mealType: "lunch", category: "restaurant" },
];

function buildStrategy(input) {
  const dayCount = input?.dayCount ?? 2;
  const anchors = ["museum", "viewpoint", "market", "garden"];

  return {
    destinationSummary:
      "A compact riverside capital where nearly everything worth seeing sits in a narrow band along the water, which makes a short trip generous rather than tight.",
    recommendedBaseArea: "Alfama",
    languageNote:
      "Portuguese, with confident English across hospitality. A greeting in Portuguese is noticed out of all proportion to the effort.",
    currencyNote:
      "Euro. Cards work nearly everywhere, though the older tascas still prefer cash, so carry some.",
    seasonalNote:
      "Mid-September is warm by day and cooler after dark once the Atlantic breeze picks up. Rain is unlikely but not impossible.",
    recommendedRadiusMeters: 4000,
    budgetAllocation: {
      flights: 0.3,
      accommodation: 0.27,
      food: 0.23,
      activities: 0.12,
      localTransport: 0.05,
      buffer: 0.03,
    },
    days: Array.from({ length: dayCount }, (_, index) => {
      const dayNumber = index + 1;
      const slots = [
        { category: MEALS[0].category, mealType: "breakfast", required: true },
        { category: anchors[index % anchors.length], mealType: null, required: true },
        { category: MEALS[1].category, mealType: "lunch", required: true },
      ];
      if (dayNumber === 1) {
        slots.push({ category: "hotel", mealType: null, required: false });
      }

      return {
        dayNumber,
        theme: dayNumber === 1 ? "Arrival, kept short" : `Day ${dayNumber} out`,
        pace: input?.pace ?? "balanced",
        searchRequirements: slots.map((slot, slotIndex) => ({
          slotId: `d${dayNumber}-s${slotIndex + 1}`,
          category: slot.category,
          purpose: "A stop matched to the interests on the request.",
          mealType: slot.mealType,
          required: slot.required,
          candidateLimit: 6,
        })),
      };
    }),
    practicalConsiderations: [
      "Buy a rechargeable transport card at any metro station rather than single paper tickets.",
    ],
  };
}

const WINDOWS = [
  ["09:00", "10:15"],
  ["10:45", "12:30"],
  ["13:00", "14:30"],
  ["15:00", "16:45"],
  ["17:15", "18:30"],
  ["19:30", "21:00"],
];

function buildAssembly(input, fabricate) {
  const used = new Set();
  const byCategory = new Map();
  for (const candidate of input.candidates ?? []) {
    const bucket = byCategory.get(candidate.category) ?? [];
    bucket.push(candidate);
    byCategory.set(candidate.category, bucket);
  }

  const take = (category) => {
    for (const candidate of byCategory.get(category) ?? []) {
      if (used.has(candidate.placeId)) continue;
      used.add(candidate.placeId);
      return candidate;
    }
    return null;
  };
  /**
   * A backup **reserves** its place, so a later day cannot schedule it.
   *
   * Without the reservation the planner offers a day-one fallback and then, two days later,
   * makes it a stop — leaving a backup that is already in the itinerary. Promoting one is then
   * correctly refused as a duplicate, which made the browser suite fail for a reason that had
   * nothing to do with promotion. A real planner should not do this either.
   */
  const reserve = (category) => {
    const candidate =
      (byCategory.get(category) ?? []).find((c) => !used.has(c.placeId)) ?? null;
    if (candidate) used.add(candidate.placeId);
    return candidate;
  };

  let swapped = false;

  const days = (input.strategy?.days ?? []).map((day) => {
    const items = [];
    const backups = [];

    day.searchRequirements.forEach((slot, index) => {
      const [startTime, endTime] = WINDOWS[index % WINDOWS.length];
      const itemId = `d${day.dayNumber}-s${index + 1}`;
      const chosen = take(slot.category);

      if (!chosen) {
        items.push({
          kind: "unavailable",
          itemId,
          slotId: slot.slotId,
          reason: `No ${slot.category.replace(/_/g, " ")} came back from the place search near this destination, so this slot is left open.`,
          startTime,
          endTime,
        });
        return;
      }

      // One fabricated id, to prove the pool gate rejects the whole generation.
      let placeId = chosen.placeId;
      if (fabricate && !swapped) {
        placeId = "osm:node:999999999";
        swapped = true;
      }

      items.push({
        kind: "place",
        itemId,
        slotId: slot.slotId,
        placeId,
        category: slot.category,
        mealType: slot.mealType,
        startTime,
        endTime,
        title: slot.mealType
          ? `${slot.mealType[0].toUpperCase()}${slot.mealType.slice(1)}`
          : `${slot.category.replace(/_/g, " ")} stop`,
        description:
          "Placed here because it sits within a short walk of the day's other stops and matches the interests on the request.",
        estimatedCost: {
          amount: slot.mealType ? 34 : 18,
          currency: input.currency ?? "EUR",
          basis: "category-estimate",
          confidence: "low",
        },
        reservationRecommended: slot.mealType === "dinner",
      });

      const alternative = reserve(slot.category);
      backups.push(
        alternative
          ? {
              backupId: `bk-${itemId}`,
              slotId: slot.slotId,
              placeId: alternative.placeId,
              reason:
                "Another option of the same kind from the same search, if the first is closed or full.",
            }
          : {
              backupId: `bk-${itemId}`,
              slotId: slot.slotId,
              reason: "An alternative of the same kind would have gone here.",
              unavailableReason:
                "The place search returned nothing else of this kind nearby, so there is no backup to offer.",
            },
      );
    });

    return {
      dayNumber: day.dayNumber,
      title: `Day ${day.dayNumber} — ${day.theme}`,
      summary:
        "A short day built around one anchor and two meals, with real walking distance left between the stops rather than a schedule that assumes teleportation.",
      items,
      backups: backups.slice(0, 4),
    };
  });

  return {
    title: `${days.length} days in ${input.destinationName ?? "this city"}`,
    destinationOverview:
      "Everything below sits within a short walk or a tram ride of the centre, so the plan trades breadth for actually sitting down in places rather than ticking them off.",
    recommendedNeighborhood: {
      name: input.strategy?.recommendedBaseArea ?? "Alfama",
      why: "Central enough that most of the itinerary is walkable from the front door, and characterful enough to be worth the evenings.",
    },
    days,
    practicalNotes: [
      {
        title: "Transport",
        body: "A rechargeable card at any metro station costs a fraction of single paper tickets per journey.",
      },
    ],
  };
}

function respondJson(response, body) {
  const payload = JSON.stringify(body);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * A response proxy that holds every write back by `delayMs`.
 *
 * Wrapping the response rather than the handler keeps the scripted-planner code
 * unchanged and unaware of timing.
 */
function deferred(response, delayMs) {
  const queue = [];
  let scheduled = false;
  const flush = () => {
    for (const run of queue.splice(0)) run();
  };
  const later = (run) => {
    queue.push(run);
    if (scheduled) return;
    scheduled = true;
    setTimeout(flush, delayMs);
  };

  return {
    writeHead: (...args) => later(() => response.writeHead(...args)),
    end: (...args) => later(() => response.end(...args)),
  };
}

export function closeAll(servers) {
  return Promise.all(
    servers.map(
      (entry) =>
        new Promise((resolve) => {
          entry.server.close(() => resolve());
        }),
    ),
  );
}
