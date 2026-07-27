#!/usr/bin/env node
/**
 * A low-cost smoke test against a deployed (or locally-built) Roamly.
 *
 * ## What it is for
 *
 * Confirming a *deployment* is sound, not that the product works — the unit suite and the CDP browser
 * suite already do that against fixtures. What can only be checked against a real deployment is the
 * boundary: are the development routes gone, is the metadata absolute, does the status endpoint expose
 * only booleans, do the body caps hold, does an error carry a stack trace.
 *
 * ## Why it barely touches the providers
 *
 * Every check below is either a static fetch or a **deliberately invalid** request. Nothing asks for a
 * geocode, a discovery or a generation, because those cost somebody else's Overpass and Nominatim
 * capacity and the fair-use rules are not suspended for a smoke test. Invalid input exercises exactly
 * the boundary we care about and costs the provider nothing.
 *
 * Usage:
 *   PRODUCTION_BASE_URL=https://example.vercel.app node test/smoke/production.mjs
 *   PRODUCTION_BASE_URL=http://localhost:3000        node test/smoke/production.mjs
 */

const BASE = (process.env.PRODUCTION_BASE_URL ?? "").replace(/\/$/, "");

if (!BASE) {
  console.error(
    "PRODUCTION_BASE_URL is required.\n" +
      "  PRODUCTION_BASE_URL=https://example.vercel.app npm run test:smoke:production",
  );
  process.exit(2);
}

const results = [];

function check(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "  ✓" : "  ✗"} ${name}${passed || !detail ? "" : ` — ${detail}`}`);
}

async function expect(name, probe) {
  try {
    const value = await probe();
    check(name, value === true || value === undefined, String(value));
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** JSON POST helper. Returns status and parsed body without throwing on a 4xx. */
async function post(path, body, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  /**
   * The raw text is kept as well as the parsed body.
   *
   * The first version returned `json: null` on a parse failure, and the stack-trace check then scanned
   * `{}` and passed — for exactly the case it exists to catch, because a framework error page carrying
   * a real stack trace is not JSON. The text is what that check now reads.
   */
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Not JSON. The caller decides whether that is a finding. */
  }
  return { status: response.status, json, text };
}

console.log(`\nRoamly production smoke test\n  ${BASE}\n`);

/* -- the page itself -------------------------------------------------------- */

console.log("▸ Pages and assets");

let landingHtml = "";

await expect("the landing page returns 200", async () => {
  const response = await fetch(`${BASE}/`);
  landingHtml = await response.text();
  return response.status === 200;
});

await expect("the landing page renders the product, not an error", () =>
  landingHtml.includes("Roamly") && landingHtml.length > 2_000,
);

await expect("a trip page returns 200 for an unknown id", async () => {
  // Trips live in the browser, so the server cannot know whether one exists — it must render the
  // shell and let the client decide. A 404 here would break every saved-trip link.
  const response = await fetch(`${BASE}/trip/smoke-test-unknown`);
  return response.status === 200;
});

await expect("the social preview image exists and is a PNG", async () => {
  const response = await fetch(`${BASE}/opengraph-image`);
  return (
    response.status === 200 &&
    (response.headers.get("content-type") ?? "").includes("image/png")
  );
});

await expect("the favicon exists", async () => {
  const response = await fetch(`${BASE}/icon.svg`);
  return response.status === 200;
});

/* -- metadata --------------------------------------------------------------- */

console.log("\n▸ Metadata");

await expect("a title and description are present", () =>
  /<title>[^<]{10,}<\/title>/.test(landingHtml) &&
  /<meta name="description" content="[^"]{40,}"/.test(landingHtml),
);

await expect("Open Graph and Twitter cards are present", () =>
  landingHtml.includes('property="og:title"') &&
  landingHtml.includes('property="og:image"') &&
  landingHtml.includes('name="twitter:card"'),
);

await expect("the canonical URL is absolute and is not localhost", () => {
  const match = /<link rel="canonical" href="([^"]+)"/.exec(landingHtml);
  if (!match) return "no canonical link";
  const href = match[1];
  if (href.includes("localhost") || href.includes("127.0.0.1")) {
    return `canonical points at ${href}`;
  }
  return href.startsWith("http");
});

await expect("the Open Graph image URL is absolute", () => {
  const match = /property="og:image" content="([^"]+)"/.exec(landingHtml);
  return match ? match[1].startsWith("http") : "no og:image";
});

await expect("the description claims no live prices or booking", () => {
  const match = /<meta name="description" content="([^"]+)"/.exec(landingHtml);
  const text = (match?.[1] ?? "").toLowerCase();
  for (const forbidden of ["live price", "book now", "cheapest", "availability"]) {
    if (text.includes(forbidden)) return `description says "${forbidden}"`;
  }
  return true;
});

/* -- the production boundary ----------------------------------------------- */

console.log("\n▸ Production boundary");

for (const path of ["/dev/places", "/dev/routing"]) {
  await expect(`${path} is not available`, async () => {
    const response = await fetch(`${BASE}${path}`);
    return response.status === 404;
  });
}

await expect("no secret marker appears in the served HTML", () => {
  const lower = landingHtml.toLowerCase();
  for (const marker of [
    "gemini_api_key",
    "api_key",
    "x-goog-api-key",
    "authorization:",
    "overpass-api.de",
    "nominatim.openstreetmap.org",
    "__roamlytripstore",
  ]) {
    if (lower.includes(marker)) return `HTML contains "${marker}"`;
  }
  return true;
});

await expect("no secret marker appears in the JavaScript it loads", async () => {
  const scripts = [...landingHtml.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)]
    .map((match) => match[1])
    .slice(0, 12);

  if (scripts.length === 0) return "no scripts found to check";

  for (const src of scripts) {
    const text = (await (await fetch(`${BASE}${src}`)).text()).toLowerCase();
    for (const marker of [
      "gemini_api_key",
      "x-goog-api-key",
      "generativelanguage",
      "overpass-api.de",
      "systeminstruction",
    ]) {
      if (text.includes(marker)) return `${src} contains "${marker}"`;
    }
  }
  return true;
});

/* -- the AI status endpoint ------------------------------------------------- */

console.log("\n▸ AI status");

let status = null;

await expect("the status endpoint returns booleans only", async () => {
  const response = await fetch(`${BASE}/api/ai/status`);
  if (response.status !== 200) return `status ${response.status}`;
  status = await response.json();

  const serialised = JSON.stringify(status).toLowerCase();
  for (const marker of ["key", "token", "http", "://", "secret"]) {
    // `modelAvailable` and `geminiConfigured` are booleans; a URL or a key name here would be a leak.
    if (serialised.includes(marker)) return `status body contains "${marker}"`;
  }
  return true;
});

await expect("the Demo Planner is always available", () =>
  status !== null && status.deterministicAvailable !== false,
);

/* -- request validation ----------------------------------------------------- */

console.log("\n▸ Request validation");

await expect("geocoding rejects a malformed body", async () => {
  const { status: code } = await post("/api/places/geocode", { nonsense: true });
  return code === 400 ? true : `status ${code}`;
});

await expect("discovery rejects an out-of-range radius", async () => {
  const { status: code } = await post("/api/places/discover", {
    center: { latitude: 38.7, longitude: -9.1 },
    categories: ["cafe"],
    radiusMeters: 9_000_000,
  });
  return code === 400 ? true : `status ${code}`;
});

await expect("discovery rejects a category outside the allowlist", async () => {
  const { status: code } = await post("/api/places/discover", {
    center: { latitude: 38.7, longitude: -9.1 },
    categories: ["nightclub"],
    radiusMeters: 3_000,
  });
  return code === 400 ? true : `status ${code}`;
});

await expect("routing rejects a malformed body", async () => {
  const { status: code } = await post("/api/trips/route", { plan: null });
  return code === 400 ? true : `status ${code}`;
});

/** One oversized payload, reused: every write route must refuse it before parsing. */
const oversized = JSON.stringify({ padding: "x".repeat(600 * 1024) });

for (const path of [
  "/api/trips/generate",
  "/api/trips/refine",
  "/api/trips/refresh-pool",
  "/api/trips/route",
]) {
  await expect(`${path} enforces a body cap`, async () => {
    const { status: code } = await post(path, oversized);
    // 413 is the intended answer; 400 is acceptable if the body is rejected before the size check.
    return code === 413 || code === 400 ? true : `status ${code}`;
  });
}

await expect("a rejected request carries no stack trace", async () => {
  const { json, text } = await post("/api/places/geocode", { nonsense: true });

  // A non-JSON error body is itself the finding: it means the route crashed rather than refusing.
  if (json === null) {
    return `error body was not JSON (${text.slice(0, 80)})`;
  }

  // Scanned over the raw text, not the re-serialised object, so nothing is lost in the round trip.
  for (const marker of ["    at ", "node_modules", ".ts:", "ZodError"]) {
    if (text.includes(marker)) return `error body contains "${marker}"`;
  }
  return true;
});

await expect("responses are not cached by a shared cache", async () => {
  const response = await fetch(`${BASE}/api/ai/status`);
  const cacheControl = response.headers.get("cache-control") ?? "";
  return cacheControl.includes("no-store") || cacheControl.includes("private")
    ? true
    : `cache-control: ${cacheControl || "absent"}`;
});

await expect("CORS is not opened to any origin", async () => {
  const response = await fetch(`${BASE}/api/ai/status`, {
    headers: { Origin: "https://example.invalid" },
  });
  const allow = response.headers.get("access-control-allow-origin");
  return allow === null || allow === BASE ? true : `allows ${allow}`;
});

/* -- attribution ------------------------------------------------------------ */

console.log("\n▸ Attribution");

await expect("OpenStreetMap is credited on the page", () =>
  landingHtml.includes("OpenStreetMap"),
);

/* -- summary ---------------------------------------------------------------- */

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length > 0) {
  console.log("\nFailures:");
  for (const failure of failed) {
    console.log(`  ✗ ${failure.name} — ${failure.detail}`);
  }
  process.exit(1);
}
