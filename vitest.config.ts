import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests run in plain Node against pure functions and mocked `fetch`.
 *
 * No test in this suite touches a public provider endpoint — Nominatim and Overpass
 * are volunteer-run services, and a test suite that hits them on every save is
 * exactly the abuse the rate limiter exists to prevent. Live checks are opt-in via
 * `npm run test:integration:osm`.
 *
 * `server-only` is stubbed: outside a React Server Component bundle its package
 * exports resolve to a module that throws by design, which would make every
 * provider module unimportable here. Stubbing it preserves the build-time guard in
 * the app while letting the logic be tested.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./test/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    /**
     * `app/` is included for the route handlers.
     *
     * A route is the boundary where a request becomes a response, and the properties
     * worth asserting there — the body ceiling, the day cap, and above all that no
     * raw model output or provider payload crosses back — cannot be checked anywhere
     * else. The handlers are plain functions taking a `Request`, so they need no
     * server: `POST(new Request(...))` is the whole harness.
     */
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
});
