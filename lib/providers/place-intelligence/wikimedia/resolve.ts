import "server-only";

import type { WikipediaReference } from "@/lib/place-intelligence";

import { readCache, writeCache, writeEmptyCache } from "./cache";
import { fetchWikimedia } from "./client";
import { WikimediaError, isWikimediaError } from "./errors";
import { normalizeLanguage, plainText } from "./normalize";
import { parsePagePropsResponse } from "./schemas";

/**
 * Turning an OSM `wikipedia` tag into a Wikidata QID, officially.
 *
 * ## Why a title is not an identifier until Wikipedia says so
 *
 * `wikidata-identity.ts` states the rule this module implements: an OSM `wikipedia` tag is *an identifier only after
 * the official API resolves it*. A title is a label. It gets renamed, it is disambiguated with a parenthetical that
 * changes, and two languages disagree about what a place is called. So `planWikidataLookup` returns a
 * *resolution request* rather than a match, and this is the only thing that may satisfy it.
 *
 * That is also why there is no name-only path anywhere here. A page that exists and carries no `wikibase_item` yields
 * `no-entity`, not a guess — the article is real and Roamly has nothing to point at.
 *
 * ## No article URL, ever
 *
 * The input is a `WikipediaReference` — a validated language and a bounded title — and never a URL. The host is
 * derived from the language by `wikipediaApiUrl` and the language has matched a shape pattern twice before it gets
 * there, so there is no argument through which `evil.example` can become the server we ask. A caller holding a URL
 * has to take it apart first, which is the point at which somebody notices they are holding a URL.
 *
 * ## Redirects, and the one kind that is allowed
 *
 * `redirects=1` asks MediaWiki to follow a rename and to *report* it. The rename comes back in the response body as a
 * `from` and a `to`, which is a fact Roamly can record on the identity's evidence line. An HTTP redirect is the other
 * kind, and `client.ts` refuses to chase it beyond one revalidated hop — a `Location` header is a string from the
 * network, and following it would be the arbitrary fetch this checkpoint forbids.
 *
 * ## Namespace is checked on the way *back*
 *
 * Refusing `File:` or `Special:` prefixes on the way out only works for the prefixes we can name, and every Wikipedia
 * localises them — `Especial:`, `Ficheiro:`, `Kategorie:`. Guessing three hundred languages' namespace names is a
 * list that would be wrong somewhere. So the authoritative check is MediaWiki's own `ns`, which must be `0`: the
 * response tells us what the page actually is, in the one vocabulary that is not a translation.
 */

/** Matches the bound `parseWikipediaTag` already applies, so a tag that passed there passes here. */
const MAX_TITLE_LENGTH = 250;

/** Control characters, which are never in a page title and are a header- or query-injection smell. */
const CONTROL_CHARACTERS = /[ --]/;

export type TitleResolution =
  | {
      status: "resolved";
      qid: string;
      /** The language actually queried, echoed so the caller records the right provenance. */
      language: string;
      /** The title MediaWiki settled on, after normalisation and any redirect. */
      title: string;
      /** The title Roamly asked for, when a rename was followed. `null` when none was. */
      redirectedFrom: string | null;
      cacheHit: boolean;
    }
  /** No such article. A real answer: the OSM tag is stale or was mistyped. */
  | { status: "missing"; title: string; reason: string; cacheHit: boolean }
  /**
   * A disambiguation page.
   *
   * Named separately from `no-entity` because it is the dangerous case rather than the empty one: a disambiguation
   * page *has* a Wikidata entity of its own, and accepting it would attach the facts and photograph of a list of
   * same-named places to one real building.
   */
  | {
      status: "disambiguation";
      title: string;
      reason: string;
      cacheHit: boolean;
    }
  /** The article exists and points at no entity, or is not a main-namespace article at all. */
  | { status: "no-entity"; title: string; reason: string; cacheHit: boolean };

/**
 * Why this title may not be sent, or `null`.
 *
 * Returns the reason rather than a boolean so a refusal can say what was wrong, and exported so a caller can check
 * without making a request. Deliberately about *shape* only: whether the page exists, and what kind of page it is,
 * are questions only MediaWiki can answer.
 */
export function articleTitleProblem(title: string): string | null {
  const value = title.trim();

  if (value.length === 0) return "The article title is empty.";
  if (value.length > MAX_TITLE_LENGTH) {
    return `The article title is longer than ${MAX_TITLE_LENGTH} characters.`;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return "The article title contains a control character.";
  }
  /*
   * `|` is refused because `titles=` is a pipe-separated list, so one title carrying a pipe would arrive as two.
   * MediaWiki forbids the character in a page title, so a title holding one did not come from MediaWiki.
   */
  if (value.includes("|")) {
    return "The article title contains a list separator.";
  }
  /*
   * A URL is refused as a title, not parsed into one.
   *
   * `https://pt.wikipedia.org/wiki/Mosteiro` is a plausible thing for an OSM tag to hold, and accepting it would be
   * accepting a caller-supplied URL through the one field that reaches a request — exactly what "no arbitrary
   * article URL input" rules out. The tag format is `lang:Title`, and anything else is a tagging error.
   */
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes("//")) {
    return "The article title looks like a URL rather than a title.";
  }
  if (value.includes("#")) {
    return "The article title carries a section fragment.";
  }

  return null;
}

/**
 * One article title, resolved to a QID or to the documented reason it was not.
 *
 * Serial and single-title by design. `pageprops` accepts fifty titles at once, and batching them would be the
 * etiquette-preferred shape — but a trip's titles arrive one place at a time through an orchestrator that must report
 * per-place outcomes, and a batch would have to be reassembled against those places by title, which is the matching
 * problem this module exists to avoid.
 */
export async function resolveWikipediaTitle(
  reference: WikipediaReference,
  options: { signal?: AbortSignal; requestId?: string } = {},
): Promise<TitleResolution> {
  const language = normalizeLanguage(reference.lang);
  if (!language) {
    throw new WikimediaError(
      "misconfigured",
      "wikipedia-api",
      "Refused a title resolution for a value that is not a language code.",
    );
  }

  const problem = articleTitleProblem(reference.title);
  if (problem !== null) {
    throw new WikimediaError("misconfigured", "wikipedia-api", problem);
  }

  const title = reference.title.trim();
  const key = { language, title };

  const cached = readCache<TitleResolution>("wp-title", key);
  if (cached) return { ...cached, cacheHit: true };

  const resolution = await lookup(language, title, options);

  if (resolution.status === "resolved") {
    writeCache("wp-title", key, resolution);
  } else {
    /*
     * Every non-resolution is cached briefly rather than not at all.
     *
     * A missing article and a disambiguation page are both stable over minutes and both change over months — an OSM
     * tag gets corrected, a disambiguation page gets split. The short TTL is what stops a page load re-asking the
     * same unanswerable question while still letting today's correction take effect today.
     */
    writeEmptyCache("wp-title", key, resolution);
  }

  return resolution;
}

async function lookup(
  language: string,
  title: string,
  options: { signal?: AbortSignal; requestId?: string },
): Promise<TitleResolution> {
  let payload: unknown;
  try {
    payload = await fetchWikimedia(
      { kind: "pageprops", lang: language, titles: [title] },
      { signal: options.signal, requestId: options.requestId },
    );
  } catch (error) {
    /*
     * A 404 from a Wikipedia that does not exist is a missing article, not a broken request.
     *
     * `parseWikipediaTag` validates a language's *shape* and deliberately not its existence, because the list of
     * Wikipedias changes and this codebase must not hold a stale copy of it. The documented consequence is that a
     * language that does not exist costs one call — and this is where that call lands honestly.
     */
    if (isWikimediaError(error) && error.kind === "not_found") {
      return {
        status: "missing",
        title,
        reason: `No ${language} Wikipedia answered for this title.`,
        cacheHit: false,
      };
    }
    throw error;
  }

  const bundle = parsePagePropsResponse(payload);

  if (bundle.pages.length === 0) {
    if (bundle.malformed > 0) {
      throw new WikimediaError(
        "invalid_response",
        "wikipedia-api",
        "The pageprops response held no page Roamly could read.",
      );
    }
    return {
      status: "missing",
      title,
      reason: "The response named no page for this title.",
      cacheHit: false,
    };
  }

  /*
   * One title in, so one page out.
   *
   * A response to a single-title query carrying several pages is a shape nobody documented, and picking among them
   * would be picking a place — so it is refused rather than resolved arbitrarily.
   */
  if (bundle.pages.length > 1) {
    throw new WikimediaError(
      "invalid_response",
      "wikipedia-api",
      "The pageprops response held more pages than titles were requested.",
    );
  }

  const page = bundle.pages[0];
  const finalTitle = plainText(page.title, MAX_TITLE_LENGTH) ?? title;

  /*
   * The rename MediaWiki followed for us, where it followed one.
   *
   * Only `redirects` is read. `normalized` is MediaWiki tidying the string we sent — case and underscores — and
   * reporting that as a rename would put a misleading sentence on the identity's evidence line.
   */
  const redirectedFrom =
    bundle.redirects.find((entry) => entry.to === page.title)?.from ?? null;

  if (page.missing !== undefined || page.invalid !== undefined) {
    return {
      status: "missing",
      title: finalTitle,
      reason:
        page.invalid !== undefined
          ? "MediaWiki rejected the title as invalid."
          : `The ${language} Wikipedia has no article with this title.`,
      cacheHit: false,
    };
  }

  if (page.ns !== undefined && page.ns !== 0) {
    return {
      status: "no-entity",
      title: finalTitle,
      reason:
        "The title names a page outside the article namespace, so there is no place for it to describe.",
      cacheHit: false,
    };
  }

  if (page.pageprops?.disambiguation !== undefined) {
    return {
      status: "disambiguation",
      title: finalTitle,
      reason:
        "The title resolves to a disambiguation page, whose own entity describes a list of same-named places rather than this one.",
      cacheHit: false,
    };
  }

  const qid = page.pageprops?.wikibase_item;
  if (!qid) {
    return {
      status: "no-entity",
      title: finalTitle,
      reason:
        "The article exists but points at no Wikidata entity, so there is nothing to attach.",
      cacheHit: false,
    };
  }

  return {
    status: "resolved",
    qid,
    language,
    title: finalTitle,
    redirectedFrom,
    cacheHit: false,
  };
}
