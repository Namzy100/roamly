import { disputedKinds, type FactConflict } from "./conflicts";
import { factKindIsRefused, type PlaceFact } from "./facts";
import { factIsUsable } from "./freshness";
import { mediaIsDisplayable, type PlaceMedia } from "./media";
import { attributionIsRequired, type FactProvenance } from "./provenance";
import type { IsoTimestamp, Permission, ProviderId } from "./types";

/**
 * What may be shown to a traveller, where, and with what credit.
 *
 * ## Display is a separate permission from persistence, in both directions
 *
 * A weather forecast may be **displayed** and must never be **persisted**. A Foursquare fact, once its caching
 * window is resolved, may be persisted for some period and may only be displayed with "Powered by Foursquare"
 * on the same screen. Neither is derivable from the other, so this module exists rather than a boolean on the
 * fact.
 *
 * ## The map is a licensing surface
 *
 * Roamly renders on OpenFreeMap. Google's policies require Places results to display on a Google Map, which is
 * the second of the two blockers that rejected it — so `surface: "map"` is a real question with a real answer
 * per provider, not a formality. Getting it wrong would not look like a bug; it would look like a working
 * feature that breaches an agreement.
 *
 * ## Nothing disputed is shown as fact
 *
 * `conflicts.ts` refuses to pick a winner when two sources disagree. This is where that refusal becomes
 * visible: a disputed fact fails `mayDisplayFact`, and the interface is expected to show the disagreement
 * instead. "08:00 or 08:30, sources disagree" is useful; a confident wrong time is not.
 */

/** Where a fact is being rendered, because the answer differs by surface. */
export type DisplaySurface =
  /** An itinerary card, a comparison card, a place panel. The ordinary case. */
  | "in-app"
  /** A marker or popup on the OpenFreeMap canvas. */
  | "map"
  /** A file or page that leaves the app — an export, a print, a share. */
  | "exported-document";

/**
 * Providers whose data may be drawn on Roamly's own map.
 *
 * Google is excluded by its own policy — Places results are required to display on a Google Map — and the
 * exclusion is recorded here rather than in a comment so that enabling it would take a deliberate edit.
 */
const MAP_DISPLAYABLE: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "openstreetmap",
  "mock",
  "wikidata",
  "wikimedia-commons",
]);

/** The credit line each provider requires, where one is required at all. */
export const REQUIRED_ATTRIBUTION: Partial<Record<ProviderId, string>> = {
  openstreetmap: "© OpenStreetMap contributors (ODbL)",
  "open-meteo": "Weather data by Open-Meteo (CC BY 4.0)",
  foursquare: "Powered by Foursquare",
  /*
   * Wikidata is CC0 and requires nothing. Present with an empty string rather than absent, so that "no
   * attribution needed" is a recorded decision with a licence behind it rather than an omission.
   */
  wikidata: "",
  /*
   * Commons is deliberately absent: it is per file, so the credit comes from `provenance.attributionText`,
   * which names the creator. A provider-level string here would credit Wikimedia for somebody else's
   * photograph.
   */
};

export function mayDisplayFact(
  fact: PlaceFact,
  input: {
    surface: DisplaySurface;
    now: IsoTimestamp;
    conflicts?: FactConflict[];
  },
): Permission {
  if (factKindIsRefused(fact.kind)) return "denied";
  if (fact.confidence === "disputed") return "denied";

  /*
   * The permission recorded at fetch time, honoured as a floor.
   *
   * A fact fetched under a policy that did not permit display must not become displayable because today's table is more
   * generous — the terms in force when it was retrieved are the ones it was retrieved under.
   */
  if (fact.provenance.policy.display !== "granted") return "denied";

  if (input.conflicts && disputedKinds(input.conflicts).has(fact.kind)) {
    return "denied";
  }

  /*
   * Freshness is a display gate, not merely a refresh hint.
   *
   * A stale phone number shown as current is the same failure as a stale forecast: the interface asserts
   * something it cannot support. `factIsUsable` answers both the expiry and the staleness question.
   */
  if (!factIsUsable(fact, input.now)) return "denied";

  if (
    input.surface === "map" &&
    !MAP_DISPLAYABLE.has(fact.provenance.provider)
  ) {
    return "denied";
  }

  /*
   * An exported document carries no live attribution surface and no way to withdraw the data later, so it is
   * held to the export standard rather than the display one. Proprietary and unlicensed facts fail here even
   * when both would be fine on screen.
   */
  if (input.surface === "exported-document") {
    const licence = fact.provenance.licence;
    if (licence === "proprietary" || licence === "unknown") return "denied";
  }

  return "granted";
}

/**
 * An image, held to the media rules as well as the surface rules.
 *
 * Refused on the map unconditionally — not for a licensing reason but an honest product one: a photograph in a
 * map popup is a thumbnail too small to recognise a place from and too small to carry its own credit legibly,
 * and a credit nobody can read is not a credit.
 */
export function mayDisplayMedia(
  media: PlaceMedia,
  input: { surface: DisplaySurface },
): Permission {
  if (!mediaIsDisplayable(media)) return "denied";
  if (media.provenance.policy.display !== "granted") return "denied";
  if (input.surface === "map") return "denied";
  return "granted";
}

/**
 * Every credit line a set of facts and media obliges, deduplicated, in stable order.
 *
 * Returned as a list rather than a joined string, so a component decides the separator and the markup. Order is
 * insertion order over a provider-sorted pass, which makes an attribution footer stable across renders — a
 * credit line that reshuffled on every state change would read as a bug.
 *
 * The per-file credit from `provenance.attributionText` takes precedence over the provider-level one, because
 * for Commons the file's own credit is the only correct answer.
 */
export function requiredAttributions(input: {
  facts: PlaceFact[];
  media: PlaceMedia[];
}): string[] {
  const lines = new Set<string>();

  const consider = (provenance: FactProvenance): void => {
    if (!attributionIsRequired(provenance.licence)) return;

    const specific = provenance.attributionText?.trim();
    if (specific) {
      lines.add(specific);
      return;
    }

    const generic = REQUIRED_ATTRIBUTION[provenance.provider];
    if (generic) lines.add(generic);
  };

  for (const fact of [...input.facts].sort((a, b) =>
    a.provenance.provider.localeCompare(b.provenance.provider, "en"),
  )) {
    consider(fact.provenance);
  }
  for (const media of input.media) consider(media.provenance);

  return [...lines];
}
