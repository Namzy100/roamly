import "server-only";

import {
  attributionIsRequired,
  licenceLinkIsRequired,
  matchIsTrusted,
  mediaId,
  mediaIsDisplayable,
  urlIsSafe,
  type ExternalIdentity,
  type IsoTimestamp,
  type LicenceId,
  type PlaceMedia,
} from "@/lib/place-intelligence";
import type { TripPlace } from "@/lib/schemas";

import { readCache, writeCache, writeEmptyCache } from "./cache";
import { fetchWikimedia } from "./client";
import {
  COMMONS_API_URL,
  WIKIMEDIA_LIMITS,
  mediaHostIsAllowed,
} from "./config";
import { WikimediaError } from "./errors";
import {
  commonsPolicy,
  normalizeFileMetadata,
  type NormalizedFileMetadata,
} from "./normalize";
import { parseImageInfoResponse } from "./schemas";

/**
 * One Commons photograph, or a documented refusal.
 *
 * ## Roamly never touches the bytes
 *
 * No image is fetched, copied, cached, resized or proxied here. What this module produces is a **URL on
 * `upload.wikimedia.org` and the credit that has to travel with it**, and the traveller's browser is what loads it.
 *
 * `mayCopyMediaBytes` grants copying to our own server, and Commons' reuse guide does permit it, so this is a choice
 * rather than a limitation. Two reasons: a copy is a redistribution and inherits every per-file obligation
 * independently of the record describing it, and an image pipeline transforms by default — resize, crop, re-encode —
 * which is the operation a licence is most likely to constrain. Hot-linking the canonical thumbnail keeps the file
 * exactly as Commons serves it, so there is nothing to get wrong.
 *
 * The consequence is that the `<img src>` is a licensing surface, which is why the host allowlist matters as much as
 * the licence table.
 *
 * ## Failing closed, and naming every way it fails
 *
 * `media.ts` in `lib/place-intelligence/` states the rule: an optional licence field makes the unlicensed photograph
 * the easiest one to ship. So every refusal below is a *named* code rather than a `null`, and the default for anything
 * unrecognised is refusal. A missing photograph is invisible to a traveller; a photograph of the wrong building, or
 * one Roamly had no right to show, is not.
 *
 * ## The closed licence table, and what it costs
 *
 * `LicenseShortName` is free text an uploader typed. It is mapped through `COMMONS_LICENCES` onto the existing
 * `LicenceId` union, and anything unrecognised becomes a refusal rather than `unknown` — which
 * `provenanceIsComplete` would refuse anyway, one step later and less clearly.
 *
 * The table names **exact versions**: 2.0, 2.5, 3.0 and 4.0 of both BY and BY-SA, alongside CC0 and public domain. That
 * covers the great majority of Commons, including the pre-2014 uploads a 4.0-only table refused. What it never does is
 * fold one version onto another — a 3.0 file labelled `CC-BY-SA-4.0` would be a false statement about a licence in a
 * record built to make licence statements checkable, so a version that cannot be established is refused instead.
 */

/** Why a file was refused. Named rather than boolean, so a log line says which gate closed. */
export type MediaRefusalCode =
  | "untrusted_match"
  | "no_file"
  | "missing_licence"
  | "unknown_licence"
  | "unsupported_media_type"
  | "unsafe_url"
  | "unsafe_host"
  | "malformed_source_page"
  | "malformed_dimensions"
  | "missing_credit"
  | "excessive_attribution"
  | "generic_image"
  | "subject_mismatch"
  | "not_displayable";

export type MediaOutcome =
  | { status: "accepted"; media: PlaceMedia; cacheHit: boolean }
  | {
      status: "refused";
      code: MediaRefusalCode;
      reason: string;
      cacheHit: boolean;
    };

/* -------------------------------------------------------------------------- */
/* The closed tables                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Commons licence names Roamly recognises, keyed by their normalized form.
 *
 * Every entry permits resizing and re-encoding, which is what makes a Commons *thumbnail* usable at all — the file
 * Roamly renders is already a derivative work Commons generated. That is a property of the table rather than of any
 * one entry, and it is why the table is closed: a licence forbidding derivatives could not be added here without
 * also changing what `transformationPermitted` means.
 *
 * Keys are the output of `licenceKey`, so `"CC BY-SA 4.0"`, `"cc-by-sa-4.0"` and `"CC BY SA 4.0"` all land on one
 * entry. A name not listed is refused.
 */
export const COMMONS_LICENCES: Readonly<Record<string, LicenceId>> = {
  cc0: "CC0-1.0",
  "cc0 1 0": "CC0-1.0",
  "cc zero": "CC0-1.0",
  "creative commons zero": "CC0-1.0",
  "public domain": "public-domain",
  pd: "public-domain",
  "pd old": "public-domain",
  "pd us": "public-domain",
  "no restrictions": "public-domain",
  /*
   * Exact versions, each mapping only to itself.
   *
   * The 2.x and 3.0 rows are what make the adapter useful: most Commons photographs predate 4.0, and a table holding
   * only 4.0 refused them. Every row names its own version — nothing is folded onto a neighbour, because the versions
   * differ in their attribution wording and in how a port relates to the unported text, and a false licence label is
   * worse than a missing photograph.
   *
   * Two absences are deliberate. There is no unversioned `"cc by sa"` key, because such a name does not say which
   * licence a reuser must comply with. And a **ported** name — `"CC BY-SA 3.0 DE"`, `"CC BY-SA 2.5 ES"` — normalizes to
   * a key that is not here and is therefore refused: a port is a separate licence document, and labelling one as the
   * unported text would be the remapping this table exists to avoid.
   */
  "cc by 2 0": "CC-BY-2.0",
  "cc by 2 5": "CC-BY-2.5",
  "cc by 3 0": "CC-BY-3.0",
  "cc by 4 0": "CC-BY-4.0",
  "cc by sa 2 0": "CC-BY-SA-2.0",
  "cc by sa 2 5": "CC-BY-SA-2.5",
  "cc by sa 3 0": "CC-BY-SA-3.0",
  "cc by sa 4 0": "CC-BY-SA-4.0",
  /* The long forms Commons writes into `UsageTerms`, which `LicenseShortName` sometimes carries instead. */
  "attribution 2 0 generic": "CC-BY-2.0",
  "attribution 2 5 generic": "CC-BY-2.5",
  "attribution 3 0 unported": "CC-BY-3.0",
  "attribution 4 0 international": "CC-BY-4.0",
  "attribution sharealike 2 0 generic": "CC-BY-SA-2.0",
  "attribution sharealike 2 5 generic": "CC-BY-SA-2.5",
  "attribution sharealike 3 0 unported": "CC-BY-SA-3.0",
  "attribution sharealike 4 0 international": "CC-BY-SA-4.0",
};

/**
 * The MIME types Roamly will render.
 *
 * Three raster formats, and the exclusions are the point:
 *
 *  - **SVG is refused** even though Commons serves a PNG thumbnail for one. An SVG is a document that can carry
 *    script and external references, and the file Roamly credits should be the file it links to. Accepting the PNG
 *    while the record names an SVG would also make the stored MIME a description of something else.
 *  - **HTML and anything scriptable** cannot be an image, and its presence in this field means the record is wrong.
 *  - **GIF is refused**, which is a narrowing rather than a safety claim: it is a raster format, it is also almost
 *    always an animation, and an animated photograph in an itinerary card is not what a landmark thumbnail is for.
 */
const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * File titles that are about a place without being a photograph of it.
 *
 * Every one of these is a real Commons naming convention, and every one would render as a plausible-looking image
 * that is not the building: a flag, a coat of arms, a locator map, a floor plan. They come back from `P18` rarely and
 * from a nearby search more often, and the failure is silent — a traveller sees a map where they expected a facade.
 */
const GENERIC_TITLE_PATTERNS: readonly RegExp[] = [
  /\bflag of\b/i,
  /\bbandeira\b/i,
  /\bdrapeau\b/i,
  /\bcoat of arms\b/i,
  /\bblason\b/i,
  /\bescudo de\b/i,
  /\bseal of\b/i,
  /\bmap of\b/i,
  /\blocation map\b/i,
  /\blocator\b/i,
  /\bstreet map\b/i,
  /\bplan of\b/i,
  /\bfloor ?plan\b/i,
  /\bplanta de\b/i,
  /\blogo\b/i,
  /\bwordmark\b/i,
  /\bqr code\b/i,
];

/** A composed credit longer than this is markup or a licence essay rather than a credit line. */
const MAX_ATTRIBUTION_LENGTH = 320;

/** Beyond this a "thumbnail" is the original file, and the width we asked for was ignored. */
const MAX_RENDERED_DIMENSION = 4_096;

/** The shortest token worth matching a file title against. Shorter words match everything. */
const MIN_SUBJECT_TOKEN_LENGTH = 4;

/* -------------------------------------------------------------------------- */
/* The lookup                                                                 */
/* -------------------------------------------------------------------------- */

export async function fetchLandmarkMedia(input: {
  /** A `File:`-prefixed Commons title, from the entity's own `P18`. */
  fileTitle: string;
  /** The identity the facts were attached across. A medium-confidence match gets no photograph. */
  identity: ExternalIdentity;
  place: TripPlace;
  /** Wikidata's label, checked alongside the place's name when deciding whether the file is on subject. */
  entityLabel?: string | null;
  retrievedAt: IsoTimestamp;
  signal?: AbortSignal;
  requestId?: string;
}): Promise<MediaOutcome> {
  /*
   * The trust gate runs before the request, not after it.
   *
   * A name-and-proximity match may be the wrong building, and a photograph is the one piece of enrichment a traveller
   * cannot sanity-check against their own expectations — a founding year that looks wrong invites a second look,
   * where a photograph of a different church simply looks like a church. `mergeIntelligence` would refuse the media
   * anyway; refusing here means the request is never made.
   */
  if (!matchIsTrusted(input.identity)) {
    return {
      status: "refused",
      code: "untrusted_match",
      reason: `The match was made by ${input.identity.method}, which is not trusted enough to attach a photograph.`,
      cacheHit: false,
    };
  }

  const fileTitle = input.fileTitle.trim();
  if (!fileTitle.startsWith("File:") || fileTitle.length > 240) {
    throw new WikimediaError(
      "misconfigured",
      "commons-api",
      "Refused a Commons lookup for a title outside the File: namespace.",
    );
  }

  const key = { fileTitle, width: WIKIMEDIA_LIMITS.thumbnailWidth };

  let metadata = readCache<NormalizedFileMetadata | null>("commons-media", key);
  const cacheHit = metadata !== undefined;

  if (metadata === undefined) {
    metadata = await fetchMetadata(fileTitle, input);
    if (metadata === null) {
      /* "Commons does not hold this file" is a real answer, cached briefly like any other absence. */
      writeEmptyCache("commons-media", key, null);
    } else {
      writeCache("commons-media", key, metadata);
    }
  }

  if (metadata === null) {
    return {
      status: "refused",
      code: "no_file",
      reason: "Commons holds no file under this title.",
      cacheHit,
    };
  }

  return evaluate({ ...input, fileTitle, metadata, cacheHit });
}

async function fetchMetadata(
  fileTitle: string,
  options: { signal?: AbortSignal; requestId?: string },
): Promise<NormalizedFileMetadata | null> {
  const payload = await fetchWikimedia(
    {
      kind: "imageinfo",
      fileTitles: [fileTitle],
      thumbnailWidth: WIKIMEDIA_LIMITS.thumbnailWidth,
    },
    { signal: options.signal, requestId: options.requestId },
  );

  const bundle = parseImageInfoResponse(payload);

  if (bundle.pages.length === 0) return null;
  return normalizeFileMetadata(bundle.pages[0]);
}

/* -------------------------------------------------------------------------- */
/* The gates                                                                  */
/* -------------------------------------------------------------------------- */

function evaluate(input: {
  fileTitle: string;
  identity: ExternalIdentity;
  place: TripPlace;
  entityLabel?: string | null;
  retrievedAt: IsoTimestamp;
  metadata: NormalizedFileMetadata;
  cacheHit: boolean;
}): MediaOutcome {
  const { metadata, cacheHit } = input;

  const refuse = (code: MediaRefusalCode, reason: string): MediaOutcome => ({
    status: "refused",
    code,
    reason,
    cacheHit,
  });

  /* -- what kind of file is it ------------------------------------------- */

  if (!metadata.mime) {
    return refuse(
      "unsupported_media_type",
      "The file reports no MIME type, so what it is cannot be established.",
    );
  }
  if (!ALLOWED_MIME_TYPES.has(metadata.mime)) {
    return refuse(
      "unsupported_media_type",
      `“${metadata.mime}” is not one of the raster image types Roamly renders.`,
    );
  }

  /* -- the URL the browser will load ------------------------------------- */

  const thumbnailUrl = metadata.thumbnailUrl;
  if (!thumbnailUrl) {
    return refuse(
      "unsafe_url",
      "The response carried no scaled URL, and the original is not a thumbnail.",
    );
  }
  if (!urlIsSafe(thumbnailUrl)) {
    return refuse(
      "unsafe_url",
      "The thumbnail URL is not a bounded https: URL.",
    );
  }
  if (!mediaHostIsAllowed(thumbnailUrl)) {
    /*
     * The host check is exact rather than a suffix test, in `config.ts`. `upload.wikimedia.org.evil.example` ends
     * with the allowed string, and this is the value that becomes an `<img src>` in a traveller's browser.
     */
    return refuse(
      "unsafe_host",
      "The thumbnail URL points at a host outside the media allowlist.",
    );
  }

  /* -- where a human can check it --------------------------------------- */

  const filePageUrl = metadata.filePageUrl;
  if (!filePageUrl || !urlIsSafe(filePageUrl) || !isCommonsPage(filePageUrl)) {
    /*
     * The file page is the licence's "link to the source" obligation, so a malformed one is not a cosmetic problem:
     * it is a credit nobody can verify. Refused rather than reconstructed from the title — a reconstructed URL would
     * be Roamly asserting where the file lives.
     */
    return refuse(
      "malformed_source_page",
      "The Commons file page URL is absent or does not point at Commons.",
    );
  }

  /* -- dimensions -------------------------------------------------------- */

  const width = metadata.thumbnailWidth;
  const height = metadata.thumbnailHeight;
  if (
    width === null ||
    height === null ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_RENDERED_DIMENSION ||
    height > MAX_RENDERED_DIMENSION
  ) {
    return refuse(
      "malformed_dimensions",
      "The thumbnail's dimensions are absent or outside the range a scaled image should have.",
    );
  }

  /* -- the licence, from the closed table -------------------------------- */

  if (!metadata.licenceShortName && !metadata.licenceCode) {
    return refuse(
      "missing_licence",
      "The file carries no licence name, so it is not established that Roamly may show it.",
    );
  }

  const licence = recogniseLicence(metadata);
  if (!licence) {
    return refuse(
      "unknown_licence",
      `The licence “${metadata.licenceShortName ?? metadata.licenceCode}” is not one Roamly recognises. Unrecognised is treated as unlicensed.`,
    );
  }

  /* -- the credit -------------------------------------------------------- */

  const creator = metadata.artist ?? metadata.credit ?? null;

  if (attributionIsRequired(licence) && !creator) {
    /*
     * The documented fallback, and it is a refusal rather than a substitute string.
     *
     * "Wikimedia Commons" would be a credit for a photograph Wikimedia did not take, which `provenance.ts` names
     * explicitly as the failure to avoid. Where the licence needs no credit — CC0, public domain — an absent creator
     * is fine and the record simply carries none.
     */
    return refuse(
      "missing_credit",
      `The licence ${licence} requires a credit and the file names neither an author nor a source.`,
    );
  }

  const attributionText = attributionIsRequired(licence)
    ? composeAttribution(creator, metadata)
    : undefined;

  if (attributionText && attributionText.length > MAX_ATTRIBUTION_LENGTH) {
    return refuse(
      "excessive_attribution",
      "The composed credit is longer than a credit line should be, which means the source fields hold markup rather than a name.",
    );
  }

  const licenceUrl =
    metadata.licenceUrl && urlIsSafe(metadata.licenceUrl)
      ? metadata.licenceUrl
      : undefined;

  if (licenceLinkIsRequired(licence) && !licenceUrl) {
    return refuse(
      "missing_licence",
      `The licence ${licence} requires a link to its text, and the file carries no usable licence URL.`,
    );
  }

  /* -- is it a photograph of *this* place -------------------------------- */

  const bareTitle = input.fileTitle.replace(/^File:/, "");

  for (const pattern of GENERIC_TITLE_PATTERNS) {
    if (pattern.test(bareTitle)) {
      return refuse(
        "generic_image",
        "The file's title names a flag, map, plan or emblem rather than a photograph of the place.",
      );
    }
  }

  if (!subjectAgrees(bareTitle, input.place.name, input.entityLabel)) {
    return refuse(
      "subject_mismatch",
      "Nothing in the file's title matches the place's name or the entity's label, so it cannot be established that the photograph is of this place.",
    );
  }

  /* -- assemble ---------------------------------------------------------- */

  const altText =
    metadata.objectName ?? metadata.description ?? input.place.name;

  const media: PlaceMedia = {
    id: mediaId({
      provider: "wikimedia-commons",
      fileIdentifier: input.fileTitle,
    }),
    kind: "photo",
    url: thumbnailUrl,
    ...(creator ? { creator } : {}),
    altText,
    /*
     * True for every licence in the closed table, which all permit derivative works. Stated here rather than derived
     * per entry because it is a property the table maintains: a no-derivatives licence could not be added without
     * also changing this line, which is the visible contradiction such an addition should produce.
     */
    transformationPermitted: true,
    provenance: {
      provider: "wikimedia-commons",
      retrievedAt: input.retrievedAt,
      licence,
      ...(licenceUrl ? { licenceUrl } : {}),
      ...(attributionText ? { attributionText } : {}),
      sourceUrl: filePageUrl,
      externalId: input.fileTitle,
      policy: commonsPolicy(),
    },
  };

  /*
   * The shared display gate, applied as a last check.
   *
   * Every clause it tests has been tested above, so it should never fire — and it is here because "should never" is
   * not "cannot", and it is the gate the renderer will actually use. A record that passed the local checks and fails
   * the shared one is a bug in this module, and this is where it surfaces.
   */
  if (!mediaIsDisplayable(media)) {
    return refuse(
      "not_displayable",
      "The assembled record failed the shared display gate.",
    );
  }

  return { status: "accepted", media, cacheHit };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The Commons origin, derived from the configured endpoint so a fixture host works without weakening the check. */
function isCommonsPage(url: string): boolean {
  try {
    return new URL(url).origin === new URL(COMMONS_API_URL).origin;
  } catch {
    return false;
  }
}

/** Free-text licence name to a comparable key: lower case, alphanumerics, single spaces. */
function licenceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The `LicenceId` for this file, or `null`.
 *
 * `LicenseShortName` is tried first because it is the field Commons renders to a human, then `License` — Commons' own
 * machine-ish code. Both are uploader-influenced, so agreement between them is not required and either recognised
 * name is accepted: the table is the authority, not the field it came from.
 */
function recogniseLicence(metadata: NormalizedFileMetadata): LicenceId | null {
  for (const candidate of [metadata.licenceShortName, metadata.licenceCode]) {
    if (!candidate) continue;
    const licence = COMMONS_LICENCES[licenceKey(candidate)];
    if (licence) return licence;
  }
  return null;
}

/**
 * The exact credit line to render.
 *
 * Stored rather than composed at render time, for the reason `provenance.ts` gives: the creator is a fact about the
 * file we were told once and cannot re-derive. The licence is named in the line because a CC BY-SA credit has to be,
 * and "via Wikimedia Commons" names where it was found without claiming Wikimedia made it.
 */
function composeAttribution(
  creator: string | null,
  metadata: NormalizedFileMetadata,
): string {
  const licenceName = metadata.licenceShortName ?? metadata.licenceCode ?? "";
  const who = creator ?? "Unknown author";

  return licenceName
    ? `${who} (${licenceName}), via Wikimedia Commons`
    : `${who}, via Wikimedia Commons`;
}

/**
 * Whether the file's title shares a significant word with the place's name or the entity's label.
 *
 * Deliberately conservative and deliberately crude. A file called `Mosteiro dos Jerónimos 2019.jpg` shares
 * "mosteiro" and "jeronimos" with the place; `Lisbon skyline at dusk.jpg` shares nothing and is refused even though
 * it is a fine photograph of the city — a generic destination image standing in for a specific building is the
 * failure this catches.
 *
 * Accents are folded, so `Jerónimos` matches `Jeronimos`. Tokens shorter than four characters are ignored because
 * "dos", "de" and "the" match almost any title.
 *
 * The check is **skipped** when neither name yields a token that long. A place called "Sé" has nothing to compare, and
 * refusing every photograph of it would be refusing on the basis of a check that could not run.
 */
function subjectAgrees(
  fileTitle: string,
  placeName: string,
  entityLabel: string | null | undefined,
): boolean {
  const haystack = fold(fileTitle);
  const tokens = new Set<string>();

  for (const source of [placeName, entityLabel ?? ""]) {
    for (const token of fold(source).split(" ")) {
      if (token.length >= MIN_SUBJECT_TOKEN_LENGTH) tokens.add(token);
    }
  }

  if (tokens.size === 0) return true;

  for (const token of tokens) {
    if (haystack.includes(token)) return true;
  }
  return false;
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
