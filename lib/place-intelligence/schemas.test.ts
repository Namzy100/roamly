import { describe, expect, it } from "vitest";

import { MAX_FACT_VALUE_LENGTH } from "./facts";
import { MAX_URL_LENGTH, urlIsSafe } from "./provenance";
import {
  ExternalIdentitySchema,
  PlaceFactSchema,
  PlaceIntelligenceSchema,
  PlaceMediaSchema,
  ProviderIdSchema,
} from "./schemas";
import { fact, identity, media, provenance, sidecar } from "./test-fixtures";

/**
 * The parse boundary, tested as a boundary.
 *
 * These assertions are about **refusal**, not happy-path shapes. Each corresponds to a way a provider response — or a
 * `localStorage` blob written by an older build — could get something into the sidecar that must never be there, and the
 * schema is the only layer able to say no at runtime.
 *
 * The two most consequential are the strictness cases. Zod strips unknown keys by default, so without `.strict()` a provider
 * adding `rating`, or a `raw` copy of its own response, would silently vanish — with the next schema change potentially
 * giving it somewhere to land. That is the failure `lib/ai/prohibited.ts` exists to catch in model output; here the schema
 * catches it in provider output.
 */

describe("provider identity", () => {
  it("accepts exactly the known providers", () => {
    for (const provider of [
      "openstreetmap",
      "mock",
      "wikidata",
      "wikimedia-commons",
      "open-meteo",
      "foursquare",
      "google-places",
      "yelp",
      "besttime",
      "ticketmaster",
    ]) {
      expect(ProviderIdSchema.safeParse(provider).success).toBe(true);
    }
  });

  /**
   * An unknown provider has no licence, and a fact with no licence has no permissions.
   *
   * It cannot be allowed through as a free string — there would be nothing to look its rules up under, and every policy gate
   * would have to invent an answer.
   */
  it("rejects an unknown provider", () => {
    for (const provider of ["tripadvisor", "", "OpenStreetMap", "osm"]) {
      expect(ProviderIdSchema.safeParse(provider).success).toBe(false);
    }
  });
});

describe("fact parsing", () => {
  it("accepts a complete fact", () => {
    expect(PlaceFactSchema.safeParse(fact()).success).toBe(true);
  });

  /** Zod's default would strip this silently. The whole point of `.strict()` is that it does not. */
  it("rejects an unknown key rather than stripping it", () => {
    expect(PlaceFactSchema.safeParse({ ...fact(), rating: 4.6 }).success).toBe(
      false,
    );
  });

  /** A provider's own payload must never ride along inside a normalised record. */
  it("rejects a raw response field", () => {
    expect(
      PlaceFactSchema.safeParse({ ...fact(), raw: { some: "payload" } }).success,
    ).toBe(false);
  });

  /** A fact with no provenance has no licence, no freshness and no policy. It is unusable. */
  it("rejects an anonymous fact", () => {
    const { provenance: _dropped, ...anonymous } = fact();
    expect(PlaceFactSchema.safeParse(anonymous).success).toBe(false);
  });

  it("bounds a string value", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({ value: "x".repeat(MAX_FACT_VALUE_LENGTH) }),
      ).success,
    ).toBe(true);
    expect(
      PlaceFactSchema.safeParse(
        fact({ value: "x".repeat(MAX_FACT_VALUE_LENGTH + 1) }),
      ).success,
    ).toBe(false);
    expect(PlaceFactSchema.safeParse(fact({ value: "" })).success).toBe(false);
  });

  /**
   * `Infinity` and `NaN` survive a JSON round-trip as values nothing compares sensibly against.
   *
   * A structured value is refused for a related reason: it is how a raw response becomes a "fact".
   */
  it("rejects a non-finite or structured value", () => {
    expect(
      PlaceFactSchema.safeParse(fact({ value: Number.POSITIVE_INFINITY }))
        .success,
    ).toBe(false);
    expect(PlaceFactSchema.safeParse(fact({ value: Number.NaN })).success).toBe(
      false,
    );
    expect(
      PlaceFactSchema.safeParse({ ...fact(), value: { nested: "object" } })
        .success,
    ).toBe(false);
  });

  it("requires a parseable fetched timestamp", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({ provenance: provenance({ retrievedAt: "yesterday" }) }),
      ).success,
    ).toBe(false);

    expect(
      PlaceFactSchema.safeParse(
        fact({ provenance: provenance({ retrievedAt: "" }) }),
      ).success,
    ).toBe(false);
  });

  /**
   * An expiry before the moment it describes is corrupt, not merely expired.
   *
   * `freshness.ts` would treat it as permanently expired, which is safe but presents as "this never displays" rather than
   * "this record is malformed" — different problems with different fixes.
   */
  it("rejects an expiry that precedes the moment it describes", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({
          kind: "event",
          subjectAt: "2026-09-12T20:00:00.000Z",
          validUntil: "2026-09-12T18:00:00.000Z",
        }),
      ).success,
    ).toBe(false);

    expect(
      PlaceFactSchema.safeParse(
        fact({
          kind: "event",
          subjectAt: "2026-09-12T18:00:00.000Z",
          validUntil: "2026-09-12T20:00:00.000Z",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects an unparseable expiry", () => {
    expect(PlaceFactSchema.safeParse(fact({ validUntil: "soon" })).success).toBe(
      false,
    );
  });
});

describe("URL safety", () => {
  /**
   * `https:` only, and the reason is not tidiness.
   *
   * `javascript:` and `data:` in an `href` are the classic stored-XSS vector, `file:` reaches the reader's own disk, and
   * plain `http:` would let a licence link be tampered with in transit — which defeats the point of citing it.
   */
  it("accepts https and refuses every other scheme", () => {
    expect(urlIsSafe("https://example.com/licence")).toBe(true);

    for (const unsafe of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox",
      "not a url",
      "",
    ]) {
      expect(urlIsSafe(unsafe), `${unsafe} should be refused`).toBe(false);
    }
  });

  it("bounds the URL length", () => {
    expect(urlIsSafe(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`)).toBe(
      false,
    );
  });

  it("refuses a fact whose source URL is unsafe", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({ provenance: provenance({ sourceUrl: "javascript:alert(1)" }) }),
      ).success,
    ).toBe(false);
  });
});

describe("provenance obligations at the boundary", () => {
  /** A licence demanding a credit, on a record with none, is a breach waiting for a renderer. */
  it("requires an attribution line when the licence demands one", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({
          provenance: provenance({
            provider: "openstreetmap",
            attributionText: undefined,
          }),
        }),
      ).success,
    ).toBe(false);
  });

  it("requires a licence link for the Creative Commons attribution licences", () => {
    expect(
      PlaceFactSchema.safeParse(
        fact({
          provenance: provenance({
            provider: "open-meteo",
            licenceUrl: undefined,
          }),
        }),
      ).success,
    ).toBe(false);
  });

  /** CC0 obliges nothing, so a record with no credit and no link is complete. */
  it("requires nothing extra of a CC0 fact", () => {
    const cc0 = provenance({ provider: "wikidata" });
    expect(cc0.attributionText).toBeUndefined();
    expect(PlaceFactSchema.safeParse(fact({ provenance: cc0 })).success).toBe(
      true,
    );
  });

  it("requires the recorded policy, including the date the terms were read", () => {
    const { policy: _dropped, ...withoutPolicy } = provenance();
    expect(
      PlaceFactSchema.safeParse({ ...fact(), provenance: withoutPolicy })
        .success,
    ).toBe(false);

    expect(
      PlaceFactSchema.safeParse(
        fact({
          provenance: provenance({
            policy: {
              persistence: "granted",
              display: "granted",
              export: "granted",
              termsReadOn: "28 July 2026",
            },
          }),
        }),
      ).success,
    ).toBe(false);
  });
});

describe("media parsing", () => {
  it("accepts a complete image", () => {
    expect(PlaceMediaSchema.safeParse(media()).success).toBe(true);
  });

  /**
   * A stored image with no text alternative can never legitimately be shown.
   *
   * Refused at the boundary rather than at display, because a component's only options would be to render it inaccessibly or
   * drop it silently.
   */
  it("requires alternative text", () => {
    expect(
      PlaceMediaSchema.safeParse(media({ altText: undefined })).success,
    ).toBe(false);
    expect(PlaceMediaSchema.safeParse(media({ altText: "   " })).success).toBe(
      false,
    );
  });

  it("requires attribution for a CC BY-SA file", () => {
    expect(
      PlaceMediaSchema.safeParse(
        media({
          provenance: provenance({
            provider: "wikimedia-commons",
            attributionText: undefined,
          }),
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects a malformed image record", () => {
    expect(PlaceMediaSchema.safeParse(media({ url: "not-a-url" })).success).toBe(
      false,
    );
    expect(
      PlaceMediaSchema.safeParse({ ...media(), kind: "video" }).success,
    ).toBe(false);
    expect(PlaceMediaSchema.safeParse({ ...media(), extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("sidecar cross-field invariants", () => {
  it("accepts a coherent sidecar", () => {
    expect(
      PlaceIntelligenceSchema.safeParse(
        sidecar({
          identities: [identity()],
          facts: [fact({ kind: "wikidata-id", value: "Q12345" })],
          media: [media()],
        }),
      ).success,
    ).toBe(true);
  });

  /** Facts about the wrong place would each validate perfectly on their own. */
  it("rejects an identity pointing at a different place", () => {
    expect(
      PlaceIntelligenceSchema.safeParse(
        sidecar({
          identities: [identity({ canonicalPlaceId: "osm:node:9999" })],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects duplicate external identities for one provider", () => {
    expect(
      PlaceIntelligenceSchema.safeParse(
        sidecar({
          identities: [
            identity({ provider: "wikidata", externalId: "Q1" }),
            identity({ provider: "wikidata", externalId: "Q2" }),
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects duplicate fact ids", () => {
    const one = fact({ kind: "phone" });
    expect(
      PlaceIntelligenceSchema.safeParse(
        sidecar({ facts: [one, { ...one, value: "+351 000 000" }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects duplicate media ids", () => {
    const one = media();
    expect(
      PlaceIntelligenceSchema.safeParse(
        sidecar({
          media: [one, { ...one, url: "https://example.com/other.jpg" }],
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown keys on an identity", () => {
    expect(
      ExternalIdentitySchema.safeParse({ ...identity(), score: 0.9 }).success,
    ).toBe(false);
  });
});
