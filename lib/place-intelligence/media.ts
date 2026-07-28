import {
  licenceLinkIsRequired,
  provenanceIsComplete,
  urlIsSafe,
  type FactProvenance,
} from "./provenance";

/**
 * A photograph, and the credit that has to travel with it.
 *
 * ## Why media is not just another fact
 *
 * A `PlaceFact` value is a string or a number, and its licence obligation is a line of text at the bottom of a panel.
 * A photograph is a copyrighted work whose licence varies **per file**, names a creator we cannot re-derive, and may
 * forbid the exact transformations an image pipeline performs by default — resizing, cropping, re-encoding. Wikimedia
 * Commons is the accepted source precisely because it permits copying to our own server; it is also the source where
 * two images from one response can carry CC0 and CC BY-SA.
 *
 * So media gets its own type whose credit fields are not optional, and a display gate that fails closed. The
 * alternative — an optional `licence` on an image record — makes the unlicensed photograph the easiest one to ship.
 *
 * ## What is deliberately absent
 *
 * No `width`, no `height`, no blur hash, no CDN URL, no thumbnail set. Those are decisions for whoever implements
 * fetching, and inventing them here would be designing an image pipeline inside a licensing module. The one thing this
 * type must get right is whether the picture may be shown at all.
 */

export type MediaKind = "photo";

export type PlaceMedia = {
  /**
   * Stable identity, so re-fetching a provider's photo list replaces rather than accumulates.
   *
   * Derived by `mediaId` from the provider and its own file identifier, which is what makes the dedup deterministic —
   * the reasoning `factId` follows.
   */
  id: string;
  kind: MediaKind;
  /** The image itself. Must be `https:` and bounded, like every other stored URL. */
  url: string;
  /**
   * The creator, as the licence requires them to be credited.
   *
   * Separate from `provenance.attributionText` because they answer different questions: this is *who made it*, that is
   * *the exact string to render*. A CC BY-SA credit needs both, and deriving one from the other is how Wikimedia ends
   * up credited for a photograph it did not take.
   */
  creator?: string;
  /** Alternative text. Absent means the image is unusable — see `mediaIsDisplayable`. */
  altText?: string;
  /**
   * Whether the licence permits resizing, cropping or re-encoding.
   *
   * Explicit because an image pipeline transforms by default and a licence may not allow it. Unknown is treated as no:
   * serving the original untouched is always permitted, so failing closed costs bandwidth rather than legality.
   */
  transformationPermitted?: boolean;
  provenance: FactProvenance;
};

/** `provider:fileIdentifier`. Deterministic, for the same reason `factId` is. */
export function mediaId(input: {
  provider: FactProvenance["provider"];
  fileIdentifier: string;
}): string {
  return `${input.provider}:${input.fileIdentifier}`;
}

/**
 * Whether this image may be rendered at all.
 *
 * Fails closed on five counts, each of which has bitten a real product:
 *
 *  - an unknown or incomplete licence — the file may simply not be ours to show
 *  - a licence requiring a credit, with no credit text stored
 *  - a licence requiring a link, with no licence URL stored
 *  - an unsafe or over-long image URL — an `<img src>` is as much a sink as an `<a href>`
 *  - no alternative text — a photograph with no text alternative is inaccessible, and Roamly does not ship an image a
 *    screen-reader user cannot get past
 *
 * The accessibility check sits beside the licence checks on purpose. Both are obligations attached to *showing* the
 * file, and a gate enforcing one while leaving the other to a renderer would be enforcing the one easier to remember.
 */
export function mediaIsDisplayable(media: PlaceMedia): boolean {
  if (!provenanceIsComplete(media.provenance)) return false;
  if (!urlIsSafe(media.url)) return false;

  if (
    licenceLinkIsRequired(media.provenance.licence) &&
    !media.provenance.licenceUrl
  ) {
    return false;
  }

  return typeof media.altText === "string" && media.altText.trim().length > 0;
}

/** Whether the image may be resized, cropped or re-encoded. Unknown means no. */
export function mediaMayBeTransformed(media: PlaceMedia): boolean {
  return media.transformationPermitted === true;
}
