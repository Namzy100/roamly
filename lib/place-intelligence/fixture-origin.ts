/**
 * The one place a non-HTTPS URL may ever be permitted, and only for a local test fixture.
 *
 * ## Why this exists
 *
 * `urlIsSafe` allows `https:` and nothing else, for good reasons set out beside it. Browser verification needs a
 * Wikimedia stand-in, and a local HTTP server cannot satisfy that rule — so a *displayed* Commons photograph, with its
 * licence, its creator and its file page on a real card, could not be exercised end to end at all. The alternative was
 * a local certificate authority: a trusted root on a developer's machine, which is a far larger and more dangerous
 * surface than the problem.
 *
 * ## Two runtimes, because the gate runs in both
 *
 * The sidecar is validated where it is *saved*, and it is saved by the client. So `urlIsSafe` executes in Node during
 * enrichment and again in the browser during the store write, and an allowance that existed only server-side would be
 * overruled a moment later by the same function running in a bundle. That was measured, not assumed: passing the
 * private variables to `next dev` changed nothing, because a variable without a `NEXT_PUBLIC_` prefix does not exist
 * in a client bundle at all.
 *
 * Hence two branches with two separate sets of variables, and no way for one to satisfy the other:
 *
 *  - **Node** — `NODE_ENV === "test"` plus the private `ROAMLY_WIKIMEDIA_FIXTURE_*` pair. Unchanged, and unreachable
 *    from a browser because `window` decides which branch runs.
 *  - **Browser** — the public `NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_*` pair, *and* the page itself must be served from
 *    loopback.
 *
 * ## The page-origin condition is what makes the public pair safe
 *
 * A `NEXT_PUBLIC_` value is compiled into the bundle, so unlike `NODE_ENV` it is not self-evidently absent from a
 * production build — someone could set it by mistake in a deployment environment. The second condition closes that:
 * the allowance also requires the page it is running on to be `localhost`, `127.0.0.1` or `[::1]`, read directly from
 * `window.location`. A deployment served from a real hostname therefore cannot activate it however its environment is
 * configured, and no caller can pass a page origin in — there is no parameter for one.
 *
 * ## What it exports
 *
 * One function, answering one question about one URL. No origin string and no boolean, deliberately: a caller holding
 * either would be a second copy of this policy, and the copy that drifts is the one that stops checking the fourth
 * condition.
 */

/**
 * The spellings of "this machine". Exact matches only.
 *
 * Both IPv6 forms, because `URL.hostname` **keeps** the brackets — `http://[::1]:1234` parses to `[::1]` — while other
 * sources may hand over the bare form. Written out rather than normalised: stripping brackets with a `replace` would
 * also accept any hostname that merely contained them, and this set is meant to read as the literal list.
 *
 * `0.0.0.0` is deliberately absent. It means *every interface*, so a service bound to it is reachable from the
 * network, which is the opposite of what loopback is being checked for. Private LAN ranges are absent for the same
 * reason.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/**
 * A configured fixture origin, if it is well formed enough to be one.
 *
 * Shared by both runtimes so the shape rules cannot diverge: `http:` only — `https:` needs no allowance, and any other
 * scheme here would be a way to smuggle `file:` or `data:` past `urlIsSafe` through a configuration value — an exact
 * loopback hostname, and an explicit port.
 *
 * The port requirement is not pedantry. Without one, `http://localhost` has origin `http://localhost` and would match
 * port 80 on the machine, which is a real service somebody may be running rather than the fixture a test meant.
 */
function parseFixtureOrigin(configured: string | undefined): string | null {
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:") return null;
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return null;
  if (parsed.port === "") return null;

  return parsed.origin;
}

/**
 * The Node-side allowance: a test process that has explicitly asked.
 *
 * `NODE_ENV === "test"` is the part a build cannot forge — `next build` and `next dev` both set it themselves — and the
 * private flag is the part that stops every other unit test silently gaining the ability. Being under test is not
 * consent.
 */
function serverFixtureOrigin(): string | null {
  if (process.env.NODE_ENV !== "test") return null;
  if (process.env.ROAMLY_WIKIMEDIA_FIXTURE_MODE !== "1") return null;

  return parseFixtureOrigin(process.env.ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN);
}

/**
 * The browser-side allowance: a compiled-in opt-in *and* a page served from this machine.
 *
 * Both halves are required, and the second is the one that matters. `NEXT_PUBLIC_` values are baked into the bundle, so
 * their absence in production is a matter of environment hygiene rather than of physics; a page origin is not. A build
 * that shipped with the flag set still refuses every fixture URL the moment it is served from a real hostname.
 *
 * `window.location.hostname` is read here and nowhere else, and it is not a parameter. A caller able to pass "the page
 * origin" could pass `localhost` from a deployed page, which is precisely the check being made.
 */
function browserFixtureOrigin(): string | null {
  if (process.env.NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE !== "1") return null;

  const origin = parseFixtureOrigin(
    process.env.NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN,
  );
  if (!origin) return null;

  /* The page itself, not the candidate URL. A non-loopback deployment can never satisfy this. */
  if (!LOOPBACK_HOSTNAMES.has(window.location.hostname)) return null;

  return origin;
}

/**
 * The single decision, for the runtime it is actually running in.
 *
 * `typeof window` rather than a build flag, because the question is genuinely "which of the two sets of variables is
 * real here". A browser cannot see the private pair and Node has no page to check, so neither branch can borrow the
 * other's permission.
 *
 * Recomputed on every call rather than cached at module load: a cached value would be captured before a test set its
 * environment, and the failure would look like flakiness rather than like a stale constant.
 */
function fixtureOrigin(): string | null {
  return typeof window === "undefined"
    ? serverFixtureOrigin()
    : browserFixtureOrigin();
}

/**
 * Whether this URL is the fixture's own, under a permission that is currently in force.
 *
 * An exact `URL.origin` comparison — scheme, host and port in one — which is why a lookalike hostname, a different
 * port and an upgraded scheme all fail without any of them being enumerated here. A URL that cannot be parsed is not
 * the fixture's.
 */
export function isFixtureLoopbackUrl(value: string): boolean {
  const origin = fixtureOrigin();
  if (!origin) return false;

  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}
