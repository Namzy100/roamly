import { isFixtureLoopbackUrl } from "@/lib/place-intelligence/fixture-origin";
import "server-only";

/**
 * Where the Wikimedia endpoints are, and the limits Roamly imposes on itself.
 *
 * ## `server-only`, and why it is not merely tidiness
 *
 * The `User-Agent` these requests must carry names Roamly and its contact URL. A browser cannot set `User-Agent` at all
 * — that is why Wikimedia offers `Api-User-Agent` for in-page JavaScript — so a client-side implementation would either
 * violate the policy or need a second header path. Keeping the boundary on the server means one code path that
 * satisfies the documented requirement, and it matches every other provider in this codebase.
 *
 * ## Every limit here is Roamly's, because Wikimedia publishes none
 *
 * `docs/PROVIDER_RESEARCH.md` records the finding: **no numeric rate limit is published** for the Action API read path
 * or for WDQS, and etiquette asks for serial rather than parallel requests. So there is no budget to spend up to. The
 * numbers below are self-imposed ceilings chosen to be obviously polite rather than tuned to a threshold nobody
 * documented — and the honest consequence is that enrichment is slow and bounded, not fast.
 */

/**
 * The base URLs, overridable so the browser suite can point at local fixtures.
 *
 * The pattern `lib/providers/osm/config.ts` uses. Overridable is what makes verification possible without querying
 * volunteer infrastructure on every run — not a convenience but a requirement, since a suite that hit Wikidata on every
 * commit is one nobody could run.
 */
export const WIKIDATA_ENTITY_BASE_URL =
  process.env.ROAMLY_WIKIDATA_ENTITY_BASE_URL ??
  "https://www.wikidata.org/wiki/Special:EntityData";

export const WIKIDATA_API_URL =
  process.env.ROAMLY_WIKIDATA_API_URL ?? "https://www.wikidata.org/w/api.php";

export const WIKIDATA_SPARQL_URL =
  process.env.ROAMLY_WIKIDATA_SPARQL_URL ?? "https://query.wikidata.org/sparql";

export const COMMONS_API_URL =
  process.env.ROAMLY_COMMONS_API_URL ??
  "https://commons.wikimedia.org/w/api.php";

/**
 * The Wikipedia API for one language, for resolving a `wikipedia` tag.
 *
 * Built from the language rather than configured per language, and the language is validated by `parseWikipediaTag`
 * before it reaches here — so this cannot be handed `evil.example` and turned into an arbitrary fetch. The override
 * collapses every language onto one fixture host for tests.
 */
export function wikipediaApiUrl(lang: string): string {
  const template = process.env.ROAMLY_WIKIPEDIA_API_URL_TEMPLATE;
  if (template) return template.replace("{lang}", lang);
  return `https://${lang}.wikipedia.org/w/api.php`;
}

/**
 * The hosts a media URL may point at.
 *
 * Commons returns absolute thumbnail URLs, and Roamly renders them in an `<img src>`. That makes the response a source
 * of URLs, and an unchecked one would let an unexpected payload put any host into the page — "no arbitrary external URL
 * fetching" applies to what the browser loads as much as to what the server requests.
 *
 * Checked as an exact host match rather than a suffix, because `upload.wikimedia.org.evil.example` ends with the string
 * a naive suffix test would accept.
 */
const ALLOWED_MEDIA_HOSTS: ReadonlySet<string> = new Set([
  "upload.wikimedia.org",
  ...(process.env.ROAMLY_WIKIMEDIA_MEDIA_HOST
    ? [process.env.ROAMLY_WIKIMEDIA_MEDIA_HOST]
    : []),
]);

/**
 * Whether a media URL points at a host Roamly may load an image from.
 *
 * HTTPS and an exact host match, plus the same single fixture exception `urlIsSafe` makes — routed through the same
 * module, so there is one set of conditions rather than two that could drift. Without it this gate would refuse the
 * fixture thumbnail after the storage gate had accepted it, and the browser suite would prove nothing about a
 * displayed photograph while appearing to.
 */
export function mediaHostIsAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return ALLOWED_MEDIA_HOSTS.has(parsed.host);
  } catch {
    return false;
  }
  return isFixtureLoopbackUrl(url);
}

/**
 * The `User-Agent` every request must carry.
 *
 * Not optional and not degradable: a request without a descriptive one receives **HTTP 403**, and the policy explicitly
 * prohibits copying a browser string or sending a generic default like `curl`. The shape is the one the policy
 * documents — name, version, contact.
 *
 * `ROAMLY_CONTACT_URL` is the value Nominatim and Overpass already send, so there is one place to change where Roamly
 * can be reached about its traffic.
 */
export const WIKIMEDIA_USER_AGENT = `Roamly/0.1 (${
  process.env.ROAMLY_CONTACT_URL ?? "https://github.com/roamly-demo"
})`;

/**
 * Self-imposed request limits.
 *
 * `maxConcurrent: 1` is the etiquette requirement expressed as a number rather than as a comment — serial means one,
 * and anything else would need a published budget to justify.
 */
export const WIKIMEDIA_LIMITS = {
  /** Serial. The documented expectation, and the only rate we can defend. */
  maxConcurrent: 1,
  /** Per request. Generous, because a slow answer is still an answer and a retry costs Wikimedia more. */
  timeoutMs: 8_000,
  /** WDQS is a shared volunteer service and the slowest path. Tighter, so a hung query is abandoned. */
  sparqlTimeoutMs: 10_000,
  /** One retry. A second failure is an answer: no enrichment. */
  maxRetries: 1,
  /** Base for exponential backoff, used when no `Retry-After` is given. */
  retryBaseMs: 1_000,
  /** The documented `wbgetentities` maximum. */
  maxEntitiesPerRequest: 50,
  /** How many nearby candidates the bounded SPARQL query may return. */
  maxSearchResults: 10,
  /** The width Commons is asked to scale to. One size, so the cache key is stable. */
  thumbnailWidth: 800,
  /** Responses larger than this are refused unread — untrusted input from a public API. */
  maxResponseBytes: 512 * 1024,
} as const;

/**
 * How long a cached answer stays usable.
 *
 * Long, and deliberately so: caching is *explicitly encouraged* by the etiquette, and the facts involved — when a
 * monastery was built, which photograph illustrates it — change on a scale of years. A short TTL here would generate
 * traffic to re-learn things that had not changed.
 *
 * Bounded rather than permanent because the cache is in-process and dies with the serverless instance anyway; this
 * number only decides whether a warm instance re-asks.
 */
export const WIKIMEDIA_CACHE_TTL_MS = {
  entity: 24 * 60 * 60 * 1_000,
  media: 24 * 60 * 60 * 1_000,
  /** Shorter: a nearby search is the answer most likely to improve as OSM and Wikidata gain coverage. */
  search: 6 * 60 * 60 * 1_000,
  /** A resolved title is effectively an identity, and titles are renamed rarely. */
  titleResolution: 24 * 60 * 60 * 1_000,
} as const;

export const WIKIMEDIA_CACHE_MAX_ENTRIES = 500;
