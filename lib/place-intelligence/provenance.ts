import { isFixtureLoopbackUrl } from "./fixture-origin";
import type { IsoTimestamp, LicenceId, Permission, ProviderId } from "./types";

/**
 * Where a fact came from, travelling with the fact and never beside it.
 *
 * ## Why provenance is required rather than optional
 *
 * Every rule in `docs/PROVIDER_RESEARCH.md` is conditional on the source. Google's place ids may be stored
 * indefinitely while its ratings may not be stored at all; a Commons photo may be copied to our own server only
 * if its own licence says so; Wikidata may be persisted without attribution while Open-Meteo may not. None of
 * those questions can be answered from the *value* — `4.6` is a rating whoever said it. They can only be
 * answered from the source.
 *
 * So a fact without provenance is not an under-documented fact, it is an unusable one, and this type is
 * non-optional on every fact in this directory.
 *
 * ## `retrievedAt` is when we asked, not when it was true
 *
 * Freshness — "should we ask again" — is about when we last asked. Validity — "does this describe now" — is about
 * the fact's own subject moment, which `facts.ts` carries separately. Collapsing them would make a six-month-old
 * forecast look fresh because we fetched it recently.
 *
 * ## Why the policy is recorded and not only looked up
 *
 * `policy` is the permission set **as understood when the fact was retrieved**, plus the date the provider's terms
 * were read. It is not the authority — `persistence-policy.ts` is, and `validate.ts` refuses a fact whose recorded
 * policy is more generous than the current table.
 *
 * It exists because terms change and stored data does not. A fact fetched under a permission that has since been
 * withdrawn is exactly the case that needs finding, and it is undiscoverable if the only record of the permission
 * is today's lookup table. Recording it makes tightening a rule a *detectable* event rather than a silent
 * retroactive breach.
 */

/**
 * The longest URL that may be stored.
 *
 * A bound rather than a guess at what URLs look like: these strings arrive from a public API, are written to
 * `localStorage` and end up in `href` attributes, so an unbounded one is a storage-quota and a render problem
 * before it is anything else.
 */
export const MAX_URL_LENGTH = 2048;

/**
 * The only scheme a stored URL may use.
 *
 * `https:` alone. Not a style preference — `javascript:`, `data:` and `vbscript:` in an `href` are the classic
 * stored-XSS vector, `file:` reaches the reader's own disk, and plain `http:` would let a licence link be tampered
 * with in transit, which defeats the point of citing it. A provider that only offers `http:` gets its URL refused,
 * and a refused URL means a refused fact rather than a downgraded one.
 */
const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(["https:"]);

/**
 * Whether a URL may be stored, linked to, or rendered as an image source.
 *
 * The bound and the scheme, in that order, and one deliberate exception.
 *
 * ## The exception
 *
 * A browser-verification fixture cannot serve HTTPS without a local certificate authority, so a *displayed* Commons
 * photograph — its licence, its creator, its file page, on a real card — was unverifiable end to end. The allowance is
 * `isFixtureLoopbackUrl`, and every condition it requires lives in that one module: a test process, an explicit opt-in,
 * a configured origin, an exact loopback hostname and an exact port.
 *
 * It is checked *after* the length bound and *only* when the scheme check has already failed, so the ordinary path is
 * unchanged and a production process never evaluates it at all. Nothing else in the codebase reads those environment
 * values, which is what keeps this a single decision rather than a policy assembled from four scattered flags.
 */
export function urlIsSafe(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    if (SAFE_URL_SCHEMES.has(new URL(value).protocol)) return true;
  } catch {
    return false;
  }
  return isFixtureLoopbackUrl(value);
}

/**
 * What was permitted when this fact was fetched, and when the terms behind it were read.
 *
 * `termsReadOn` is a plain `YYYY-MM-DD` date rather than a timestamp: provider terms are dated documents, not
 * moments, and millisecond precision would imply a precision the citation does not have.
 */
export type PolicySnapshot = {
  persistence: Permission;
  display: Permission;
  export: Permission;
  /** `YYYY-MM-DD`, the date the provider's terms were read. */
  termsReadOn: string;
};

export type FactProvenance = {
  provider: ProviderId;
  /** When Roamly asked. Not when the fact became true, and not when it was last verified upstream. */
  retrievedAt: IsoTimestamp;
  /**
   * The licence governing *this* fact.
   *
   * Per-fact rather than per-provider, because Wikimedia Commons is per-*file*: two photos from one API call can
   * carry CC0 and CC BY-SA. A provider-level licence table would be right for six of the eight researched
   * providers and silently wrong for the one where it matters most.
   */
  licence: LicenceId;
  /** Required for display when the licence demands it. Absent is a refusal, not a default. */
  licenceUrl?: string;
  /**
   * The exact credit line to render, when one is required.
   *
   * Stored rather than composed at render time: a CC BY-SA credit names the *creator*, which is a fact about the
   * file we were told once and cannot re-derive. A UI composing it from the provider name would credit Wikimedia
   * for a photograph Wikimedia did not take.
   */
  attributionText?: string;
  /** Where a human can check this — the licence's "link to the source" obligation. */
  sourceUrl?: string;
  /** The provider's own identifier for what this came from. Never Roamly's canonical id. */
  externalId?: string;
  /** The permissions as understood at retrieval. Checked against the current table by `validate.ts`. */
  policy: PolicySnapshot;
};

/**
 * The licence each accepted provider's data arrives under, where it is provider-wide.
 *
 * Commons is deliberately absent: its licence is per file, so a default here would be a licence claim about a
 * photograph nobody checked.
 */
export const PROVIDER_LICENCE: Partial<Record<ProviderId, LicenceId>> = {
  openstreetmap: "ODbL-1.0",
  wikidata: "CC0-1.0",
  "open-meteo": "CC-BY-4.0",
  foursquare: "proprietary",
  "google-places": "proprietary",
  yelp: "proprietary",
  besttime: "proprietary",
  ticketmaster: "proprietary",
};

/** Licences that oblige a visible credit. CC0 and public domain do not; everything else here does. */
const ATTRIBUTION_REQUIRED: ReadonlySet<LicenceId> = new Set<LicenceId>([
  /*
   * Every Creative Commons BY and BY-SA version, not only 4.0.
   *
   * Attribution is the defining condition of the whole family, in every version since 1.0. Listing only 4.0 would make
   * the *older* licences the ones that display without a credit — precisely inverted, since a 2005 photograph is more
   * likely to have a creator who cannot be re-contacted, not less.
   */
  "CC-BY-2.0",
  "CC-BY-2.5",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC-BY-SA-2.0",
  "CC-BY-SA-2.5",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
  "ODbL-1.0",
  "proprietary",
  /**
   * `unknown` requires attribution it cannot supply, which is the point.
   *
   * Treating an undetermined licence as attribution-free would make the unlicensed case the easiest one to ship.
   */
  "unknown",
]);

export function attributionIsRequired(licence: LicenceId): boolean {
  return ATTRIBUTION_REQUIRED.has(licence);
}

/**
 * Licences that require the licence itself to be linked, not merely named.
 *
 * Every CC BY and BY-SA version, for the same reason they all require a credit: each one obliges a reuser to include
 * the licence's URI or a link to it, so naming "CC BY-SA 3.0" in a caption without pointing anywhere does not discharge
 * the condition. A set rather than the two `===` comparisons this replaced — with eight members, a chain of
 * comparisons is a place to forget one.
 */
const LICENCE_LINK_REQUIRED: ReadonlySet<LicenceId> = new Set<LicenceId>([
  "CC-BY-2.0",
  "CC-BY-2.5",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC-BY-SA-2.0",
  "CC-BY-SA-2.5",
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
]);

export function licenceLinkIsRequired(licence: LicenceId): boolean {
  return LICENCE_LINK_REQUIRED.has(licence);
}

/**
 * Whether this provenance can discharge its own obligations.
 *
 * A licence demanding a credit, on a record carrying no credit text, is a licence breach waiting for a renderer —
 * so it is caught here, where it is a data question, rather than in a component, where it would be a missing
 * string nobody noticed. An unsafe or over-long URL fails for the same reason: a stored URL that cannot be
 * rendered safely is not a citation.
 */
export function provenanceIsComplete(provenance: FactProvenance): boolean {
  if (provenance.licence === "unknown") return false;

  if (provenance.licenceUrl !== undefined && !urlIsSafe(provenance.licenceUrl)) {
    return false;
  }
  if (provenance.sourceUrl !== undefined && !urlIsSafe(provenance.sourceUrl)) {
    return false;
  }
  if (licenceLinkIsRequired(provenance.licence) && !provenance.licenceUrl) {
    return false;
  }
  if (!attributionIsRequired(provenance.licence)) return true;

  return (
    typeof provenance.attributionText === "string" &&
    provenance.attributionText.trim().length > 0
  );
}
