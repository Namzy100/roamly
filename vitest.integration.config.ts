import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Opt-in live provider checks — `npm run test:integration:osm` and
 * `npm run test:integration:routing`.
 *
 * A separate config so `npm test` cannot pick these up by accident. They contact the
 * public Nominatim, Overpass and Valhalla services, all of which are volunteer- or
 * donation-run; running them on a watch loop or in CI on every push would be
 * inconsiderate at best.
 *
 * Each suite is selected by name from the command line, so `:osm` never wakes the
 * routing server and `:routing` never wakes Overpass.
 *
 * The timeout is generous because the real rate limiter paces requests and these
 * services are legitimately slow under load.
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
    include: ["test/integration/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential: these share the process-wide rate limiter, and parallel files
    // would queue behind each other in a way that reads as a hang.
    fileParallelism: false,
  },
});
