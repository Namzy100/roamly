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
 * Hence separate branches with separate sets of variables, and no way for one to satisfy another:
 *
 *  - **Node, unit test** — `NODE_ENV === "test"` plus the private `ROAMLY_WIKIMEDIA_FIXTURE_*` pair. Unreachable from a
 *    browser because `window` decides which branch runs.
 *  - **Node, browser harness** — `NODE_ENV === "development"` plus `ROAMLY_BROWSER_FIXTURE_RUN`, and every Wikimedia
 *    endpoint redirected onto the fixture, and no deployment marker anywhere. This one exists because enrichment fetches
 *    and licence-checks media *server-side* under `next dev`, which the unit-test branch refuses; see
 *    `browserHarnessFixtureOrigin` for why the two alternatives were worse.
 *  - **Browser** — the public `NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_*` pair, *and* the page itself must be served from
 *    loopback.
 *
 * The public pair is irrelevant to both Node branches, and the private variables are invisible to the browser one. That
 * is not a convention to be respected by callers; it is what `typeof window` selecting the branch actually enforces.
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
 * The Node-side unit-test allowance: a test process that has explicitly asked.
 *
 * `NODE_ENV === "test"` is the part a build cannot forge — `next build` and `next dev` both set it themselves — and the
 * private flag is the part that stops every other unit test silently gaining the ability. Being under test is not
 * consent.
 */
function unitTestFixtureOrigin(): string | null {
  if (process.env.NODE_ENV !== "test") return null;
  if (process.env.ROAMLY_WIKIMEDIA_FIXTURE_MODE !== "1") return null;

  return parseFixtureOrigin(process.env.ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN);
}

/**
 * Every Wikimedia endpoint the adapter can reach, named as the variable that overrides it.
 *
 * The list exists so the harness allowance can require that *all* of them point at the fixture. An endpoint left unset
 * falls back to its official HTTPS default in `config.ts`, which means a run that believed it was isolated would in fact
 * reach volunteer infrastructure for that one call — and the allowance would have granted an HTTP exception to a run
 * that was talking to the real internet. Refusing unless every one is redirected makes "isolated" checkable rather than
 * assumed.
 *
 * Named here rather than imported from `config.ts` because `config.ts` imports *this* module, and because the values
 * there are resolved constants with the defaults already substituted — by then an unset variable is indistinguishable
 * from one deliberately set to the official URL.
 */
const WIKIMEDIA_ENDPOINT_KEYS = [
  "ROAMLY_WIKIDATA_ENTITY_BASE_URL",
  "ROAMLY_WIKIDATA_API_URL",
  "ROAMLY_WIKIDATA_SPARQL_URL",
  "ROAMLY_COMMONS_API_URL",
  "ROAMLY_WIKIPEDIA_API_URL_TEMPLATE",
] as const;

/**
 * Variables whose mere presence means "this is a deployment", not a developer's machine.
 *
 * Checked as absent-or-empty rather than compared against a value: the question is whether anything hosted is around
 * us, and a marker set to an unexpected string is still a marker. `VERCEL` and `VERCEL_ENV` are the two the deployment
 * target actually sets; the rest are here so the same rule holds if Roamly is ever hosted somewhere else, since the
 * failure mode being prevented — an HTTP allowance active in a serving environment — does not care which vendor it is.
 *
 * This is a belt to `NODE_ENV === "development"`'s braces. That check alone already excludes `next build` and
 * `next start`, which is the strong guarantee; this one catches a hosted process that somehow reports development.
 */
const DEPLOYMENT_MARKER_KEYS = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_EXECUTION_ENV",
  "NETLIFY",
  "CF_PAGES",
  "RENDER",
  "FLY_APP_NAME",
  "HEROKU_APP_NAME",
  "K_SERVICE",
] as const;

/**
 * Whether every Wikimedia endpoint has been redirected onto this exact origin.
 *
 * `{lang}` is substituted before parsing because the Wikipedia entry is a template rather than a URL; the substituted
 * language is irrelevant, since only the origin is compared and the template's origin does not vary by language.
 *
 * An unparseable value fails, as does one on a different origin. Both are configuration mistakes that would otherwise
 * present as a mysteriously refused thumbnail.
 */
function everyWikimediaEndpointIsFixture(origin: string): boolean {
  for (const key of WIKIMEDIA_ENDPOINT_KEYS) {
    const configured = process.env[key];
    if (!configured) return false;

    try {
      if (new URL(configured.replace("{lang}", "en")).origin !== origin) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * The Node-side browser-harness allowance: `next dev`, started by the browser suite, talking only to the fixture.
 *
 * ## Why a second Node branch was needed at all
 *
 * The sidecar's media is fetched and licence-checked *on the server*, during enrichment, before the client ever sees
 * it. So `mediaHostIsAllowed` runs in Node under `next dev` — where `NODE_ENV` is `development`, which the unit-test
 * branch above correctly refuses. The consequence was measured rather than guessed: the browser suite wired the public
 * pair, fixed the client half of the gate, and the thumbnail was still refused server-side, so no photograph could be
 * exercised end to end and the media checks were pinned to "no media" instead.
 *
 * The two alternatives were both worse. Making the Node branch trust the *public* pair would put a bundle-compiled
 * value in charge of a server decision, which is the one thing the public pair was designed never to do. Running the
 * harness with `NODE_ENV=test` would tell Next it was under test, changing bundling and error handling, so the suite
 * would no longer be exercising the application it claims to verify.
 *
 * ## Why this flag cannot leak
 *
 * `ROAMLY_BROWSER_FIXTURE_RUN` is private, so it does not exist in a client bundle and cannot be set by a page. It is
 * set by `test/browser/run.mjs` immediately before it spawns `next dev`, and by nothing else — not by `npm run build`,
 * not by `npm start`, and not by the production smoke test.
 *
 * Every condition below has to hold at once, and each closes a different way this could have been the wrong answer:
 * the explicit flag (nobody gets it by accident), fixture mode (the same second opt-in the unit-test branch requires),
 * `development` (`next build` and `next start` report `production`, so a real serving process is excluded by the
 * runtime itself rather than by a list), no deployment marker, a well-formed loopback origin with an explicit port, and
 * every endpoint redirected onto it.
 */
function browserHarnessFixtureOrigin(): string | null {
  if (process.env.ROAMLY_BROWSER_FIXTURE_RUN !== "1") return null;
  if (process.env.ROAMLY_WIKIMEDIA_FIXTURE_MODE !== "1") return null;

  /* `next build` and `next start` both report `production`. A served application cannot reach past this line. */
  if (process.env.NODE_ENV !== "development") return null;

  for (const key of DEPLOYMENT_MARKER_KEYS) {
    if ((process.env[key] ?? "") !== "") return null;
  }

  const origin = parseFixtureOrigin(process.env.ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN);
  if (!origin) return null;

  /* Isolation is a precondition of the allowance, not a separate hope. */
  if (!everyWikimediaEndpointIsFixture(origin)) return null;

  return origin;
}

/**
 * The Node-side allowance: either a unit-test process or the browser harness.
 *
 * Two disjoint modes rather than one relaxed one. They cannot be collapsed into a single set of conditions because they
 * disagree about `NODE_ENV` — `test` against `development` — which is precisely the distinction that keeps each of them
 * narrow.
 */
function serverFixtureOrigin(): string | null {
  return unitTestFixtureOrigin() ?? browserHarnessFixtureOrigin();
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
 * The upper bound on a fixture-shortened enrichment budget.
 *
 * Thirty seconds is far below the real 90 s and far above anything a fixture needs, so the override can only ever make
 * the server *stricter* than production. A value above this is a configuration mistake rather than an intention, and
 * silently clamping one would hide it — so it is refused and the real budget stands.
 */
const MAX_FIXTURE_BUDGET_MS = 30_000;

/**
 * A shortened enrichment budget, when the isolated fixture policy is in force. `null` everywhere else.
 *
 * ## Why the harness needs this at all
 *
 * `runEnrichmentWorkflow` continues on exactly one signal: a response carrying `abandoned.code === "budget_exhausted"`.
 * That code has a single producer — the enrichment run's own deadline — so the *only* honest way to exercise a
 * continuation end to end is to let the server genuinely run out of time. With the real 90 s budget that is
 * unreachable: the route declares `maxDuration = 120`, so a first call long enough to exhaust it cannot complete.
 *
 * The alternative was to fake the continuation in the hook or in the page, which would leave the branch that actually
 * ships untested — a continuation that works in the harness and not in production is worse than no test.
 *
 * ## Why it cannot lower the real budget
 *
 * It reuses `serverFixtureOrigin()` unchanged, so every condition that guards an HTTP media URL guards this too: a
 * unit-test process that opted in, or `next dev` started by the browser suite with `ROAMLY_BROWSER_FIXTURE_RUN`,
 * `NODE_ENV === "development"`, no deployment marker, and every Wikimedia endpoint redirected onto one loopback origin.
 * A served application fails at `NODE_ENV` before reaching the variable, and the variable is private, so no bundle and
 * no page can set it.
 *
 * Deliberately not a boolean plus a separate read: a caller holding "am I in fixture mode?" would be a second copy of
 * this policy, and the copy that drifts is the one that stops checking a condition.
 */
export function fixtureEnrichmentBudgetMs(): number | null {
  if (serverFixtureOrigin() === null) return null;

  const configured = process.env.ROAMLY_ENRICHMENT_BUDGET_MS;
  if (!configured) return null;

  /*
   * A strict integer. `Number()` would accept `"1e3"`, `" 500 "` and `""`, and a budget arriving from a typo as `NaN`
   * or `0` would abandon the run before its first place — which reads as a broken feature rather than a bad value.
   */
  if (!/^[1-9][0-9]*$/.test(configured)) return null;

  const value = Number(configured);
  return value <= MAX_FIXTURE_BUDGET_MS ? value : null;
}

/**
 * Whether the adapter's cache should be bypassed, because the isolated fixture policy is in force and has asked.
 *
 * ## Why a harness needs this
 *
 * The cache is keyed by entity, title and coordinates, so a *second* lookup of the same trip is answered entirely from
 * memory and makes no request at all. That is exactly right in production — and it makes a cancelled refresh
 * unobservable, because there is no in-flight request to cancel. A scenario that clicked Cancel anyway would be
 * asserting against a run that had already finished, which is the kind of test that passes for the wrong reason.
 *
 * Bypassing reads rather than writes, so the run still behaves normally in every other respect.
 *
 * ## Why it is safe
 *
 * The same `serverFixtureOrigin()` gate as the budget override and the media allowance: a unit-test process that opted
 * in, or `next dev` under the browser harness with every Wikimedia endpoint redirected at one loopback origin and no
 * deployment marker present. A served application fails on `NODE_ENV` before the variable is read, and the variable is
 * private, so nothing compiled into a bundle can set it. The worst a mistake here could do is make a fixture run
 * slower.
 */
export function fixtureCacheIsDisabled(): boolean {
  if (serverFixtureOrigin() === null) return false;
  return process.env.ROAMLY_WIKIMEDIA_CACHE_DISABLED === "1";
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
