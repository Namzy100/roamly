# Security

Roamly is a portfolio prototype. It has no accounts, no server-side storage and no payment path, so its
attack surface is narrow — but it does accept data from public providers and from files a person chooses
to import, and those are treated as untrusted.

## Reporting a vulnerability

Open a GitHub issue describing the problem. Please do **not** include a working exploit against a
third-party service in a public issue.

There is no bounty, and no SLA — this is a personal project.

## What the app protects

**No secrets in the browser.** No API key, model prompt, provider hostname or server module reaches a
client bundle. Verified by grepping the built output in `npm run test:smoke:production`, not by review.

**Validated at both edges.** Zod schemas on every request and every response. Provider payloads are
normalised server-side; the browser never receives a raw one.

**Bounded by construction.** Body caps on every write route, an import size cap applied *before*
`JSON.parse`, a candidate cap, a pool cap, a route cap, a per-day stop cap, and an `opening_hours`
parser bounded in length and rule count with no nested quantifiers.

**No dynamic execution.** No `eval`, no constructed code paths, no HTML rendered from provider or
imported content. Imported JSON is parsed as data and validated against the same assertions a generated
plan passes — including membership of the trip's own verified place pool.

**Injection is structurally prevented.** Overpass queries are assembled from an allowlisted tag table,
never from user text.

**Errors reveal nothing useful.** Responses carry our own codes and sentences — never a stack trace, a
provider status line or a query string.

**Logs contain no travel data.** No destination, place name, itinerary, note, prompt or model output.
A field allowlist enforces it, asserted in `lib/providers/log.test.ts`.

**Development surfaces do not exist in production.** `/dev/*` returns 404, asserted by the smoke test.

## What it does not protect against

**Anything on the device.** Trips are in `localStorage`, readable by any script on the origin and by
anyone with the machine. Do not put anything sensitive in a trip note.

**A hostile file you choose to import.** Import validates structure, versions and place membership, and
cannot execute content — but a file you did not write can still contain text you did not expect, and
that text will be displayed.

**Denial of service.** There is no rate limiting on the app's own routes. Vercel's platform limits are
the only ceiling.

## Dependencies

`npm audit` reports 15 advisories; `npm audit --omit=dev` reports **3**. The difference is the point —
most are in the ESLint toolchain and never ship. Each remaining one was checked individually rather
than counted.

**Fixed during review.** `shadcn` was listed in `dependencies`. It is a code-generation CLI — bin-only,
no `main` field, zero runtime imports — so it was moved to `devDependencies`, which is the correct
classification and removed three advisories (`shadcn`, `@hono/node-server`,
`@modelcontextprotocol/sdk`) from the production tree.

**Accepted, with evidence.** The three that remain are `next`, `postcss` and `sharp`, and the only
remediation npm offers for all three is `next@9.3.3` — a downgrade across seven major versions that
would delete the application. Individually:

- **`sharp`** (libvips CVEs) is installed as Next's image optimiser. There is **no `next/image` usage
  anywhere in the codebase** — verified by grep across `app/` and `components/` — so the vulnerable
  decode path is never invoked. The social preview is rendered by `next/og`, which does not use sharp.
- **`postcss`** runs at build time over CSS this repository authors. The advisories concern
  attacker-supplied CSS; no untrusted stylesheet ever reaches it.
- **`next`** — the advisory range spans essentially every release from 9.3.4 to 16.3.0. There is no
  forward version to move to.

Re-check with `npm audit --omit=dev` before treating any advisory as production-relevant, and re-read
this section rather than trusting the count.
