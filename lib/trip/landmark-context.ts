import type {
  LandmarkCardIntelligence,
  LandmarkCardPhoto,
  ProviderId,
} from "@/lib/place-intelligence";

/**
 * The landmark region of an itinerary card, composed (Checkpoint 5B, section 10C).
 *
 * ## What this adds to `deriveLandmarkCardIntelligence`
 *
 * That module answers *may this be shown* — the trust gate, the freshness gate, the licence gate. It deliberately
 * stops there, because it lives in `lib/place-intelligence`, which every provider compiles against and which must
 * not know that a card exists.
 *
 * This answers *what the card puts on screen*: the source line, the credit rows, the stale label, and which of
 * those rows exist at all. All of it is a licence obligation or a caveat, which is exactly the kind of thing that
 * quietly disappears when it is assembled inside JSX — a `&&` that drops a credit renders a photograph nobody may
 * use, and it looks perfectly fine in a screenshot.
 *
 * ## Rows are omitted, never blanked
 *
 * Every row here is present only when it has a value. A "Creator: —" line is worse than no line: it reads as a
 * fact about the file (nobody is credited) when the truth is that Commons did not tell us.
 *
 * ## Links are re-checked here
 *
 * `mediaIsDisplayable` already refuses a file whose licence obliges a URL it does not carry, and the schema bounds
 * what a URL may look like. `externalHref` checks again anyway, at the last point before a value becomes an `href`:
 * a stored string reaching an anchor is the one place where a `javascript:` scheme would matter, and a guard at the
 * render boundary costs one function call.
 */

export type LandmarkDisclosureRow = {
  label: string;
  /** Plain text. Rendered as a text node — never as markup. */
  value: string;
  /** An absolute `http(s)` URL, or `null` for a text-only row. */
  href: string | null;
};

export type LandmarkContextView = {
  /** The region's own label. Fixed, and the same on every card. */
  label: string;
  description: {
    text: string;
    /** A short visible caveat when the sentence is past its recheck interval, `null` otherwise. */
    staleNote: string | null;
  } | null;
  facts: { label: string; value: string }[];
  photo: LandmarkCardPhoto | null;
  /**
   * The compact visible line: the projects consulted, and the photograph's exact licence when one renders.
   *
   * "Wikidata · Wikimedia Commons · CC-BY-SA-3.0". The licence identifier is spliced in verbatim — see
   * `LANDMARK_LICENCE_IS_VERBATIM`.
   */
  sourceLine: string;
  /** The same projects as separate strings, for a component that would rather render spans than split a line. */
  sources: string[];
  /** Creator, licence, licence URL, file page and provider — whichever the file actually carries. */
  disclosure: LandmarkDisclosureRow[];
  /** The credit lines the displayed items oblige, straight from the derivation. */
  attributions: string[];
};

/** The heading a landmark region renders under. */
export const LANDMARK_CONTEXT_LABEL = "Factual context";

/**
 * The stale caveat, worded as a statement about Roamly rather than about the source.
 *
 * "Not rechecked recently" says what is true: the sentence was fetched a while ago and has not been confirmed
 * since. "May be out of date" would be a hint that Wikidata is wrong, which is not what an elapsed recheck
 * interval means and is not something Roamly is in a position to say.
 */
export const LANDMARK_STALE_NOTE = "Not rechecked recently";

/**
 * How each project is named to a traveller.
 *
 * A total record rather than a lookup with a fallback, so a provider added to the enum cannot reach a card as its
 * own identifier — `open-meteo` in a source line is a leaked internal name, and it is the kind of thing that ships
 * because the fallback made it *look* handled.
 *
 * The names are the projects' own. "OpenStreetMap", not "OSM", and "Wikimedia Commons", not "Commons".
 */
export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  openstreetmap: "OpenStreetMap",
  mock: "Sample data",
  wikidata: "Wikidata",
  "wikimedia-commons": "Wikimedia Commons",
  "open-meteo": "Open-Meteo",
  foursquare: "Foursquare",
  "google-places": "Google Places",
  yelp: "Yelp",
  besttime: "BestTime",
  ticketmaster: "Ticketmaster",
};

/**
 * A licence identifier is rendered exactly as stored, and this constant exists to be asserted against.
 *
 * `CC-BY-SA-3.0` and `CC-BY-SA-4.0` are different licences with different terms, and a 2007 photograph is under the
 * one it was published under regardless of what Commons offers today. Substituting "Creative Commons" for either
 * one loses the version — which is the only part that says what a reuser may do.
 */
export const LANDMARK_LICENCE_IS_VERBATIM = true;

export function describeLandmarkContext(
  card: LandmarkCardIntelligence,
): LandmarkContextView | null {
  /* One check, from the field that exists for it. An empty region is the failure this prevents. */
  if (!card.hasContext) return null;

  const { description, photo, facts, attributions } = card;

  /*
   * Which projects to name.
   *
   * Taken from what actually rendered rather than from the sidecar: naming Wikimedia Commons on a card whose
   * photograph was refused claims a use that did not happen. Deduplicated in insertion order, so the line reads
   * "Wikidata · Wikimedia Commons" — the entity first, then the file found through it.
   */
  const providers: ProviderId[] = [];
  if (description) providers.push(description.provider);
  for (const fact of facts) {
    if (!providers.includes(fact.provider)) providers.push(fact.provider);
  }
  if (photo && !providers.includes("wikimedia-commons")) {
    providers.push("wikimedia-commons");
  }

  const sources = providers.map((provider) => PROVIDER_DISPLAY_NAMES[provider]);

  /* The licence joins the visible line only when a photograph renders — it is the photograph's licence. */
  const sourceLine = [...sources, ...(photo ? [photo.licence] : [])].join(" · ");

  return {
    label: LANDMARK_CONTEXT_LABEL,
    description: description
      ? {
          text: description.text,
          staleNote: description.stale ? LANDMARK_STALE_NOTE : null,
        }
      : null,
    /* Label and value only. `kind` and `confidence` are gates and provenance, not things a traveller reads. */
    facts: facts.map((fact) => ({ label: fact.label, value: fact.value })),
    photo,
    sourceLine,
    sources,
    disclosure: photo ? disclosureFor(photo) : [],
    attributions,
  };
}

/**
 * The same view with its photograph, and every credit that photograph obliged, removed.
 *
 * ## Why a browser-side failure has to reach the attribution
 *
 * `describeLandmarkContext` composes the source line and the credit rows from the *stored* record, which is the only
 * thing the server knows. But whether the file actually reached the traveller is decided in their browser, and a dead
 * URL — a deleted file, a network that dropped it — is discovered there and nowhere else.
 *
 * Without this, a card whose photograph failed to load went on naming Wikimedia Commons and printing a licence for an
 * image that was not on screen. That is the exact failure this module already refuses to commit in the other direction:
 * "naming Wikimedia Commons on a card whose photograph was refused claims a use that did not happen." A use that
 * *failed* did not happen either, and the credit has to travel with the image.
 *
 * ## What survives, and why Commons can be dropped by name
 *
 * The description and the facts are Wikidata's and are still on screen, so Wikidata stays named — under-crediting is as
 * wrong as over-crediting. Commons is removed outright, which is sound because `deriveLandmarkCardIntelligence` only
 * ever reaches Commons for a *file*: descriptions come from Wikidata or a language Wikipedia, and facts from Wikidata.
 * So the only thing that can have put Commons in this list is the photograph being removed here.
 *
 * The result is the view a card would have got had the display policy refused the file to begin with, which is the
 * point — the two states read identically to a traveller because they are the same state.
 */
export function landmarkContextWithoutPhoto(
  view: LandmarkContextView,
): LandmarkContextView {
  /* Nothing to remove. Returned unchanged so a caller can apply this unconditionally. */
  if (!view.photo) return view;

  const sources = view.sources.filter(
    (name) => name !== PROVIDER_DISPLAY_NAMES["wikimedia-commons"],
  );

  return {
    ...view,
    sources,
    /* Rebuilt from the survivors, so the photograph's licence leaves with it rather than being spliced out. */
    sourceLine: sources.join(" · "),
    /* Every row was `disclosureFor(photo)`. With no photograph there is nothing they could credit. */
    disclosure: [],
    attributions: view.attributions.filter(
      (line) => line !== view.photo?.credit,
    ),
    photo: null,
  };
}

/**
 * The credit rows for one photograph.
 *
 * Ordered as a credit is read: who made it, under what terms, where to check. Every row is conditional on its own
 * value, and the licence row is the only unconditional one — `mediaIsDisplayable` cannot admit a file without one.
 */
function disclosureFor(photo: LandmarkCardPhoto): LandmarkDisclosureRow[] {
  const rows: LandmarkDisclosureRow[] = [];

  if (photo.creator) {
    rows.push({ label: "Creator", value: photo.creator, href: null });
  }

  rows.push({
    label: "Licence",
    /* Verbatim. See `LANDMARK_LICENCE_IS_VERBATIM`. */
    value: photo.licence,
    href: externalHref(photo.licenceUrl),
  });

  const filePage = externalHref(photo.sourceUrl);
  if (filePage) {
    rows.push({
      label: "File",
      value: "Wikimedia Commons file page",
      href: filePage,
    });
  }

  if (photo.credit) {
    /*
     * The exact credit line, last.
     *
     * It usually repeats the creator and the licence, and it is kept anyway: it is the string the file *asks* to be
     * credited with, and a card that reassembles its own version from the parts has stopped honouring the request.
     */
    rows.push({ label: "Credit", value: photo.credit, href: null });
  }

  rows.push({
    label: "Source",
    value: PROVIDER_DISPLAY_NAMES["wikimedia-commons"],
    href: null,
  });

  return rows;
}

/**
 * A URL fit to be an `href`, or `null`.
 *
 * Only `http` and `https`. Everything else — `javascript:`, `data:`, a bare `//host`, a relative path — becomes
 * `null` and the row loses its link rather than its value, because the licence identifier is still true even when
 * the link to it is not usable.
 */
export function externalHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    /* Not a URL at all. A row without a link is the safe reading of an unparseable one. */
    return null;
  }
}
