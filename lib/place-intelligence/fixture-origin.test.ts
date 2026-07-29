import { afterEach, describe, expect, it } from "vitest";

import { mediaHostIsAllowed } from "@/lib/providers/place-intelligence/wikimedia/config";

import { isFixtureLoopbackUrl } from "./fixture-origin";
import { urlIsSafe } from "./provenance";

/**
 * The test-only HTTP allowance, in both runtimes, and every way it must refuse.
 *
 * This is the one place in the codebase where the rule about URL schemes is deliberately relaxed, so the tests that
 * matter are the negative ones. Each case removes exactly one condition, because that is how the relaxation would
 * actually go wrong: a flag without a scheme check, an origin matched by suffix, a hostname list that forgot
 * `0.0.0.0` means "every interface", a port left unspecified — or, for the browser, a compiled-in flag with nothing
 * tying it to the machine the page came from.
 *
 * ## The `window` stub
 *
 * The browser branch reads `window.location.hostname` directly and takes no parameter, on purpose: a caller able to
 * pass "the page origin" could pass `localhost` from a deployed page, which is the check being made. Testing it
 * therefore means providing a `window`, which is a property of the environment rather than an argument — so it is
 * stubbed on `globalThis` and removed afterwards.
 */

const OFFICIAL_FILE_PAGE =
  "https://commons.wikimedia.org/wiki/File:Tour_Eiffel_Wikimedia_Commons.jpg";
const OFFICIAL_THUMBNAIL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a8/Tour_Eiffel.jpg/800px-Tour_Eiffel.jpg";

const FIXTURE_ORIGIN = "http://127.0.0.1:51234";
const FIXTURE_URL = `${FIXTURE_ORIGIN}/media/thumb.jpg`;

const KEYS = [
  "NODE_ENV",
  "ROAMLY_WIKIMEDIA_FIXTURE_MODE",
  "ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN",
  "NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE",
  "NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN",
] as const;

const ORIGINAL = new Map(KEYS.map((key) => [key, process.env[key]]));

function assign(key: string, value: string | undefined): void {
  const environment = process.env as Record<string, string | undefined>;
  if (value === undefined) delete environment[key];
  else environment[key] = value;
}

/** Every variable set at once, so no case can inherit another's leftovers. */
function configure(
  input: Partial<Record<(typeof KEYS)[number], string | undefined>>,
): void {
  for (const key of KEYS) assign(key, input[key]);
}

/** A page served from this machine, or from somewhere else. */
function onPage(hostname: string): void {
  (globalThis as { window?: unknown }).window = {
    location: { hostname, origin: `http://${hostname}` },
  };
}

function offPage(): void {
  delete (globalThis as { window?: unknown }).window;
}

/** The Node-side conditions, all satisfied. */
function serverPermitted(origin = FIXTURE_ORIGIN): void {
  configure({
    NODE_ENV: "test",
    ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
    ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: origin,
  });
}

/** The browser-side conditions, all satisfied, including a loopback page. */
function browserPermitted(origin = FIXTURE_ORIGIN, page = "localhost"): void {
  configure({
    NODE_ENV: "production",
    NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
    NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: origin,
  });
  onPage(page);
}

afterEach(() => {
  for (const key of KEYS) assign(key, ORIGINAL.get(key));
  offPage();
});

describe("official Wikimedia URLs, which need no allowance at all", () => {
  it("accepts an official HTTPS Commons file page", () => {
    configure({ NODE_ENV: "test" });
    expect(urlIsSafe(OFFICIAL_FILE_PAGE)).toBe(true);
  });

  it("accepts an official HTTPS thumbnail, as a URL and as a media host", () => {
    configure({ NODE_ENV: "test" });
    expect(urlIsSafe(OFFICIAL_THUMBNAIL)).toBe(true);
    expect(mediaHostIsAllowed(OFFICIAL_THUMBNAIL)).toBe(true);
  });

  it("still accepts them from a loopback page with fixture mode on", () => {
    browserPermitted();
    expect(urlIsSafe(OFFICIAL_FILE_PAGE)).toBe(true);
    expect(mediaHostIsAllowed(OFFICIAL_THUMBNAIL)).toBe(true);
  });

  /** The allowance widens nothing for HTTPS: an arbitrary HTTPS host is still not a media host. */
  it("still refuses an arbitrary HTTPS host as a media source", () => {
    serverPermitted();
    expect(mediaHostIsAllowed("https://evil.example/photo.jpg")).toBe(false);
  });
});

describe("the Node allowance", () => {
  it("accepts the fixture's own HTTP URL", () => {
    serverPermitted();

    expect(isFixtureLoopbackUrl(FIXTURE_URL)).toBe(true);
    expect(urlIsSafe(FIXTURE_URL)).toBe(true);
    expect(mediaHostIsAllowed(FIXTURE_URL)).toBe(true);
  });

  it("accepts each loopback spelling on an exact port", () => {
    for (const origin of [
      "http://localhost:51234",
      "http://127.0.0.1:51234",
      "http://[::1]:51234",
    ]) {
      serverPermitted(origin);
      expect(urlIsSafe(`${origin}/thumb.jpg`), origin).toBe(true);
    }
  });

  /** Being under test is not consent. */
  it("refuses without the private flag", () => {
    configure({
      NODE_ENV: "test",
      ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
    });
    expect(urlIsSafe(FIXTURE_URL)).toBe(false);
  });

  it("refuses a flag value that is not exactly “1”", () => {
    for (const mode of ["true", "yes", "0", ""]) {
      configure({
        NODE_ENV: "test",
        ROAMLY_WIKIMEDIA_FIXTURE_MODE: mode,
        ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
      });
      expect(urlIsSafe(FIXTURE_URL), mode).toBe(false);
    }
  });

  /** The property that matters most on the server: a build cannot forge `NODE_ENV`. */
  it("refuses in production and in development, flag and origin and all", () => {
    for (const nodeEnv of ["production", "development"]) {
      configure({
        NODE_ENV: nodeEnv,
        ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
        ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
      });
      expect(urlIsSafe(FIXTURE_URL), nodeEnv).toBe(false);
      expect(mediaHostIsAllowed(FIXTURE_URL), nodeEnv).toBe(false);
    }
  });

  it("refuses with no origin, an unparseable origin, or no port", () => {
    for (const origin of [undefined, "not a url", "http://localhost"]) {
      configure({
        NODE_ENV: "test",
        ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
        ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: origin,
      });
      expect(urlIsSafe(FIXTURE_URL), String(origin)).toBe(false);
    }
  });

  /**
   * A configuration value must not become a way to smuggle another scheme past the check.
   *
   * Probed through `isFixtureLoopbackUrl` rather than `urlIsSafe`, because the question is whether the *configured
   * origin granted anything* — and an `https:` candidate is safe on its own merits whatever this policy says. Asserting
   * `urlIsSafe` false there would be asserting that HTTPS stopped working.
   */
  it("grants nothing for a configured origin that is not http", () => {
    for (const origin of [
      "https://127.0.0.1:51234",
      "file://127.0.0.1",
      "ftp://localhost:51234",
    ]) {
      serverPermitted(origin);
      expect(isFixtureLoopbackUrl(`${origin}/thumb.jpg`), origin).toBe(false);
    }
  });

  /** The public pair is invisible to Node's branch, so it cannot grant anything there. */
  it("is not satisfied by the public variables", () => {
    configure({
      NODE_ENV: "test",
      NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
      NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
    });
    expect(urlIsSafe(FIXTURE_URL)).toBe(false);
  });
});

describe("the browser allowance", () => {
  it("accepts the fixture's own HTTP URL from a loopback page", () => {
    browserPermitted();

    expect(isFixtureLoopbackUrl(FIXTURE_URL)).toBe(true);
    expect(urlIsSafe(FIXTURE_URL)).toBe(true);
    expect(mediaHostIsAllowed(FIXTURE_URL)).toBe(true);
  });

  it("accepts each loopback page spelling", () => {
    for (const page of ["localhost", "127.0.0.1", "[::1]"]) {
      browserPermitted(FIXTURE_ORIGIN, page);
      expect(urlIsSafe(FIXTURE_URL), page).toBe(true);
    }
  });

  /**
   * The proof that a deployment cannot activate this.
   *
   * Every variable is set exactly as a misconfigured production environment would have them, and the only difference is
   * the hostname the page was served from. That is the condition a compiled-in flag cannot fake.
   */
  it("refuses from a non-loopback page however it is configured", () => {
    for (const page of [
      "roamly.example",
      "app.roamly.example",
      "localhost.evil.example",
      "notlocalhost",
      "127.0.0.1.evil.example",
      "192.168.1.10",
      "0.0.0.0",
    ]) {
      browserPermitted(FIXTURE_ORIGIN, page);
      expect(urlIsSafe(FIXTURE_URL), page).toBe(false);
      expect(mediaHostIsAllowed(FIXTURE_URL), page).toBe(false);
    }
  });

  it("refuses without the public flag", () => {
    configure({
      NODE_ENV: "production",
      NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
    });
    onPage("localhost");
    expect(urlIsSafe(FIXTURE_URL)).toBe(false);
  });

  it("refuses a public flag value that is not exactly “1”", () => {
    for (const mode of ["true", "yes", "0", ""]) {
      configure({
        NODE_ENV: "production",
        NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE: mode,
        NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
      });
      onPage("localhost");
      expect(urlIsSafe(FIXTURE_URL), mode).toBe(false);
    }
  });

  it("refuses a public origin with no port, no scheme match, or no value", () => {
    for (const origin of [
      undefined,
      "not a url",
      "http://localhost",
      "https://127.0.0.1:51234",
    ]) {
      configure({
        NODE_ENV: "production",
        NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
        NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: origin,
      });
      onPage("localhost");
      expect(urlIsSafe(FIXTURE_URL), String(origin)).toBe(false);
    }
  });

  it("refuses a public origin that is not loopback", () => {
    for (const origin of [
      "http://0.0.0.0:51234",
      "http://192.168.1.10:51234",
      "http://10.0.0.5:51234",
      "http://172.16.4.2:51234",
      "http://169.254.1.1:51234",
      "http://evil.example:51234",
    ]) {
      browserPermitted(origin);
      expect(urlIsSafe(`${origin}/thumb.jpg`), origin).toBe(false);
    }
  });

  /** The private pair is not visible in a bundle, and must not be honoured even when present. */
  it("is not satisfied by the private variables", () => {
    configure({
      NODE_ENV: "test",
      ROAMLY_WIKIMEDIA_FIXTURE_MODE: "1",
      ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN: FIXTURE_ORIGIN,
    });
    onPage("localhost");
    expect(urlIsSafe(FIXTURE_URL)).toBe(false);
  });
});

describe("candidate URLs that are not the fixture's", () => {
  it("refuses the right host on the wrong port, in either runtime", () => {
    for (const setUp of [serverPermitted, browserPermitted]) {
      setUp();
      for (const wrong of [
        "http://127.0.0.1:51235/thumb.jpg",
        "http://127.0.0.1/thumb.jpg",
        "http://127.0.0.1:80/thumb.jpg",
        "http://localhost:51234/thumb.jpg",
      ]) {
        expect(urlIsSafe(wrong), wrong).toBe(false);
      }
      offPage();
    }
  });

  it("refuses lookalike hostnames", () => {
    serverPermitted();

    for (const lookalike of [
      "http://localhost.evil.example:51234/thumb.jpg",
      "http://evil-localhost:51234/thumb.jpg",
      "http://127.0.0.1.evil.example:51234/thumb.jpg",
      "http://notlocalhost:51234/thumb.jpg",
    ]) {
      expect(urlIsSafe(lookalike), lookalike).toBe(false);
    }
  });

  it("refuses an arbitrary HTTP host", () => {
    serverPermitted();
    expect(urlIsSafe("http://evil.example/thumb.jpg")).toBe(false);
    expect(mediaHostIsAllowed("http://evil.example/thumb.jpg")).toBe(false);
  });

  /**
   * A redirect is only followed to a URL that is checked again, so "redirected away from the fixture" reduces to "is
   * this other URL permitted" — and it is not, whichever loopback origin it came from.
   */
  it("refuses a URL redirected away from the fixture origin", () => {
    serverPermitted();

    for (const destination of [
      "http://127.0.0.1:9999/elsewhere.jpg",
      "http://localhost:51234/elsewhere.jpg",
      "http://evil.example/elsewhere.jpg",
    ]) {
      expect(urlIsSafe(destination), destination).toBe(false);
    }
  });

  /** The relaxation is about the scheme and the origin, never about the other things that make a URL unsafe. */
  it("still refuses the schemes it was never about", () => {
    serverPermitted();

    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "",
    ]) {
      expect(urlIsSafe(hostile), hostile).toBe(false);
    }
  });
});
