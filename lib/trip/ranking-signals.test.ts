import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A guard against mock-only ranking signals returning to the product interface.
 *
 * ## Why this is a source scan and not a rendered assertion
 *
 * The repository has no jsdom and no React Testing Library — `lib/trip/item-card.ts` says so in its own header, which is why
 * the card's accessible name was extracted into a pure function to be testable at all. So a "does this component render a
 * star" test cannot be written the usual way.
 *
 * What *can* be checked is whether the component reads the field, and for this rule that is the better check anyway: the
 * failure mode is somebody adding `place.rating` back to a card, and that is visible in the source whether or not a
 * particular fixture happens to populate it. The same reasoning `lib/ai/prohibited.ts` uses — scan for the key, because a key
 * named `rating` is unambiguous.
 *
 * ## What the rule is
 *
 * `rating`, `userRatingCount`, `priceLevel` and `editorialSummary` exist on `TripPlace` and are populated **only** by the mock
 * sample. OpenStreetMap supplies none of them, and `docs/PROVIDER_RESEARCH.md` established that no accepted provider ever
 * will: Google forbids caching Places content, Yelp caps storage at 24 hours and forbids blending its ratings with another
 * source, and BestTime was rejected on cost.
 *
 * So a product surface reading one of these fields renders it for the demo trip and nothing for every real trip — an
 * interface making a claim it can only sometimes support, with no way for the traveller to tell which case they are in.
 *
 * `components/dev/` is deliberately exempt. The dev explorer prints "not provided" for exactly these fields in order to
 * *demonstrate* that nothing is fabricated; that is the explicit gating this rule asks for, not a violation of it.
 */

const PRODUCT_COMPONENT_DIRS = [
  "components/trip",
  "components/map",
  "components/marketing",
  "components/form",
  "components/shell",
  "components/states",
];

/** The fields that exist only on the mock fixture. Names, because a name is unambiguous. */
const MOCK_ONLY_FIELDS = [
  "rating",
  "userRatingCount",
  "priceLevel",
  "editorialSummary",
] as const;

/**
 * Reads of those fields, as they would actually appear in a component.
 *
 * Property access and destructuring both, because `place.rating` and `const { rating } = place` are the same mistake. Built
 * per field rather than as one regex, so a failure names which field came back.
 */
function readPatternsFor(field: string): RegExp[] {
  return [
    new RegExp(`\\.${field}\\b`),
    new RegExp(`\\[["']${field}["']\\]`),
    new RegExp(`\\b${field}\\s*[,}]`),
  ];
}

function sourceFiles(): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];

  for (const dir of PRODUCT_COMPONENT_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      /* A directory that does not exist is not a failure — the list is a superset on purpose. */
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".tsx")) continue;
      files.push({
        path: join(dir, entry),
        source: readFileSync(join(dir, entry), "utf8"),
      });
    }
  }

  return files;
}

/**
 * Comments removed, so the explanation of *why* a field is absent does not read as a use of it.
 *
 * Without this the guard would fail on the note in `itinerary-item-card.tsx` that names the three fields it no longer
 * renders — which would make honest documentation of the rule a violation of the rule.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("mock-only ranking signals stay out of the product interface", () => {
  it("finds product components to check", () => {
    /* A guard that silently checked nothing would pass forever. */
    expect(sourceFiles().length).toBeGreaterThan(10);
  });

  it("reads no mock-only field in any product component", () => {
    const offences: string[] = [];

    for (const file of sourceFiles()) {
      const code = withoutComments(file.source);

      for (const field of MOCK_ONLY_FIELDS) {
        for (const pattern of readPatternsFor(field)) {
          if (pattern.test(code)) {
            offences.push(`${file.path} reads “${field}”`);
            break;
          }
        }
      }
    }

    expect(
      offences,
      `Mock-only fields are populated only by the sample trip, so a product surface reading one shows it on the demo and nothing on a real trip. See docs/PROVIDER_RESEARCH.md.\n${offences.join(
        "\n",
      )}`,
    ).toEqual([]);
  });

  /**
   * The dev explorer is exempt, and the exemption is asserted rather than assumed.
   *
   * If somebody moves that surface into `components/trip/` the scan above starts failing, which is the correct outcome — but
   * this makes the intent explicit, so the exemption is not mistaken for an oversight.
   */
  it("leaves the dev explorer's explicit absence display alone", () => {
    const source = readFileSync(
      "components/dev/dev-places-explorer.tsx",
      "utf8",
    );

    expect(source).toContain("not provided");
    expect(source).toContain("no-fabrication");
  });
});
