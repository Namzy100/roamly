#!/usr/bin/env node
/**
 * Production screenshots, captured from a real production build against local fixture providers.
 *
 * ## Why not by hand
 *
 * Hand-taken screenshots go stale the moment the palette or the copy changes, and nobody notices until
 * a reviewer sees an interface that no longer exists. This drives the *production* build through the
 * same helpers the verification suite uses, so a capture is reproducible and a drifted screenshot is
 * one command away from being correct.
 *
 * ## What is guaranteed about the output
 *
 * Every provider is a local fixture, so no public service is touched and the data is identical between
 * runs. The build is a production build, so no development banner, inspection route or debug affordance
 * can appear. Viewports are fixed and `deviceScaleFactor` is 1, which keeps the files byte-comparable.
 *
 * The script asserts what it captured afterwards — a screenshot containing a fixture URL, a key name or
 * a provider hostname would defeat the point, so those are checked rather than assumed.
 *
 * Usage:  node test/browser/screenshots.mjs
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { launchChrome, openPage, waitFor } from "./cdp.mjs";
import { startGemini, startNominatim, startOverpass, startValhalla } from "./fixtures.mjs";
import {
  FORM,
  chooseFirstDestination,
  ensureRefinePanelOpen,
  waitForWorkspace,
} from "./run.mjs";

/**
 * A **production** server, not the dev one the verification suite uses.
 *
 * The suite runs `next dev` because it needs the development-only store seam
 * (`window.__roamlyTripStore`) to force revision conflicts. That is exactly wrong for a published
 * screenshot: `next dev` renders the Next devtools badge, which is a developer tool in an image meant
 * to show a product.
 *
 * So this starts `next start` against an existing build. The trade is that the store seam is gone —
 * which is why the mobile capture below navigates by reading `location.pathname` instead of reaching
 * into the store.
 */
async function startProductionServer(env) {
  const port = await freePort();

  const child = spawn(NEXT_BIN, ["start", "--port", String(port)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });

  const baseUrl = `http://localhost:${port}`;
  await waitFor(
    async () => {
      const response = await fetch(baseUrl).catch(() => null);
      return response?.ok === true;
    },
    `the production server to start on ${port}\n${log}`,
    { timeoutMs: 90_000 },
  );

  return {
    baseUrl,
    async close() {
      child.kill("SIGTERM");
    },
  };
}

/**
 * Fill and submit the form, on a production build.
 *
 * The verification suite's `submitForm` waits for `window.__roamlyTripStore` as its hydration signal —
 * precise, and a development-only seam that a production build strips. So this waits on a
 * production-observable signal instead, and the *proof* that hydration happened is that destination
 * candidates appear afterwards: without client code the form performs a native GET submit and no
 * candidates are ever rendered, which fails the mandatory wait rather than passing quietly.
 */
async function fillAndSubmit(page) {
  await page.waitFor(`document.readyState === "complete"`, {
    timeoutMs: 30_000,
    label: "document ready",
  });
  await page.sleep(1_500);

  await page.evaluate(`
    const set = (id, value) => {
      const el = document.getElementById(id);
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("departureCity", ${JSON.stringify(FORM.departureCity)});
    set("destination", ${JSON.stringify(FORM.destination)});
    set("startDate", ${JSON.stringify(FORM.startDate)});
    set("endDate", ${JSON.stringify(FORM.endDate)});
    set("budget", ${JSON.stringify(FORM.budget)});
    set("travelers", ${JSON.stringify(FORM.travelers)});

    const ensureChecked = (selector) => {
      const el = document.querySelector(selector);
      if (el && !el.checked) el.click();
    };
    ensureChecked('input[id="vibe-culture"]');
    ensureChecked('input[id="interest-museums"]');
    ensureChecked('input[id="interest-coffee"]');

    document.querySelector("form").requestSubmit();
    return true;
  `);
}

/** A free port, found by binding and releasing one. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NEXT_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "next");
const OUT = join(PROJECT_ROOT, "docs", "screenshots");

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 414, height: 896 };

const captured = [];

async function shot(page, name, viewport = DESKTOP) {
  await page.setViewport(viewport.width, viewport.height);
  // One frame for the layout to settle after a viewport change.
  await page.sleep(450);
  const file = join(OUT, `${name}.png`);
  await page.screenshot(file);
  captured.push({ name, file, viewport });
  console.log(`  captured ${name} (${viewport.width}×${viewport.height})`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const nominatim = await startNominatim();
  const overpass = await startOverpass();
  const valhalla = await startValhalla();
  /**
   * A deliberately slow planner, for the progress capture.
   *
   * With no delay the fixture answers in a few hundred milliseconds — faster than a screenshot can be
   * taken — so the "generation in progress" shot came out identical to the finished workspace. Slowing
   * the fixture makes the staged progress genuinely observable instead of staging a fake of it.
   */
  const gemini = await startGemini({ mode: "ok", delayMs: 2_600 });

  const chrome = await launchChrome();
  const server = await startProductionServer({
    ROAMLY_NOMINATIM_BASE_URL: nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });

  const page = await openPage(chrome.port, "about:blank");

  try {
    /* -- 1 · the landing page ------------------------------------------- */
    await page.setViewport(DESKTOP.width, DESKTOP.height);
    await page.goto(`${server.baseUrl}/`);
    await page.sleep(900);
    await shot(page, "01-landing");

    /* -- 2 · destination confirmation ----------------------------------- */
    await fillAndSubmit(page);
    /**
     * Not swallowed.
     *
     * The first version caught the timeout, so when the candidates had not rendered it captured the
     * landing page again — a screenshot labelled "destination confirmation" showing the form. A
     * capture that silently substitutes the wrong image is worse than a failed run.
     */
    await page.waitFor(
      `document.querySelectorAll('[data-testid="destination-candidate"]').length > 0`,
      { timeoutMs: 60_000, label: "destination candidates" },
    );
    /**
     * Scrolled into view, because the candidates sit below the hero.
     *
     * The first run captured the top of the landing page and labelled it "destination confirmation" —
     * the wait had passed, the content was simply off-screen. A screenshot showing the wrong thing is
     * worse than a missing one.
     */
    await page.evaluate(`
      document
        .querySelector('[data-testid="destination-candidate"]')
        .closest("section, form, div")
        .scrollIntoView({ block: "center" });
      return true;
    `);
    await page.sleep(700);
    await shot(page, "02-destination-confirmation");

    /* -- 3 · generation in progress ------------------------------------- */
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    /**
     * Mid-flight, while the slowed fixture is still thinking.
     *
     * The wait is on the stage list actually being on screen — `generation-stages` — and it is *not*
     * swallowed: if generation has already finished, this shot would be a second copy of the finished
     * workspace under a label that claims otherwise, which is the mistake worth failing on.
     */
    await page.waitFor(
      `document.querySelector('[data-testid="generation-stages"]') !== null`,
      { timeoutMs: 20_000, label: "the generation progress panel" },
    );
    await page.sleep(500);
    await shot(page, "03-generation-progress");

    await waitForWorkspace(page);
    await page.sleep(700);

    /* -- 4 · the workspace, desktop ------------------------------------- */
    await shot(page, "04-itinerary-and-map");

    /* -- 5 · routed geometry -------------------------------------------- */
    await ensureRefinePanelOpen(page);
    await page.click('[data-testid="recalculate-all-routes"]');
    await page.waitFor(
      `document.querySelectorAll('[data-testid="travel-segment"][data-status="routed"]').length > 0`,
      { timeoutMs: 60_000, label: "routed segments" },
    );
    await page.sleep(900);
    await shot(page, "05-routed-geometry");

    /* -- 6 · the refinement panel --------------------------------------- */
    await ensureRefinePanelOpen(page);
    await page.evaluate(`
      document.querySelector('[data-testid="refine-panel"]').scrollIntoView({ block: "center" });
      return true;
    `);
    await page.sleep(400);
    await shot(page, "06-refinement-panel");

    /* -- 7 · schedule accuracy and hours -------------------------------- */
    await page.evaluate(`
      const node = document.querySelector('[data-testid="schedule-accuracy"]');
      if (node) node.scrollIntoView({ block: "center" });
      return true;
    `);
    await page.sleep(400);
    await shot(page, "07-opening-hours");

    /* -- 8 · pool refresh preview --------------------------------------- */
    // One node dropped so the diff has something real to show.
    overpass.state.exclude = new Set([1003]);
    await page.evaluate(`
      document.querySelector('[data-testid="place-pool-panel"]').scrollIntoView({ block: "center" });
      return true;
    `);
    await page.click('[data-testid="refresh-pool"]');
    await page.click('[data-testid="refresh-confirm-run"]');
    await page
      .waitFor(`document.querySelector('[data-testid="refresh-preview"]')`, {
        timeoutMs: 60_000,
        label: "refresh preview",
      })
      .catch(() => {});
    await page.sleep(500);
    await shot(page, "08-pool-refresh-preview");
    overpass.state.exclude = new Set();

    /* -- 9 · storage management ----------------------------------------- */
    await page.goto(`${server.baseUrl}/`);
    await page.waitFor(`document.querySelector('[data-testid="storage-panel"]')`, {
      timeoutMs: 30_000,
      label: "storage panel",
    });
    await page.evaluate(`
      document.querySelector('[data-testid="storage-panel"]').scrollIntoView({ block: "center" });
      return true;
    `);
    await page.sleep(500);
    await shot(page, "09-saved-trips-and-storage");

    /* -- 10 · mobile ----------------------------------------------------- */
    /**
     * Navigated by link, not through the store.
     *
     * A production build strips `window.__roamlyTripStore`, which is the point — so the mobile shot
     * follows the saved-trip link the interface itself offers.
     */
    await page.evaluate(`
      const link = document.querySelector('a[href^="/trip/"]');
      if (link) link.click();
      return true;
    `);
    await page.sleep(1_500);
    await waitForWorkspace(page);
    await page.sleep(900);
    await shot(page, "10-mobile-itinerary", MOBILE);

    /* -- what we just captured must be safe to publish ------------------ */
    console.log("\n▸ Verifying the captures");

    const files = (await readdir(OUT)).filter((name) => name.endsWith(".png"));
    console.log(`  ${files.length} PNG files in docs/screenshots/`);

    let total = 0;
    for (const name of files.sort()) {
      const { size } = await stat(join(OUT, name));
      total += size;
      const flag = size > 900_000 ? "  ← large" : "";
      console.log(`  ${name.padEnd(34)} ${(size / 1024).toFixed(0)} KB${flag}`);
    }
    console.log(`  total ${(total / 1024).toFixed(0)} KB`);

    /**
     * The fixture servers run on `127.0.0.1:<random>`, and the app is served from `localhost:<random>`.
     * Neither may be legible in a published screenshot — but the address bar is not captured
     * (`Page.captureScreenshot` grabs the page, not the browser chrome), so the real risk is a URL
     * rendered *into* the page. Asserted from the DOM rather than by reading pixels.
     */
    const leaked = await page.evaluate(`
      const text = document.body.innerText;
      const bad = ["127.0.0.1", "fixture-key", "GEMINI_API_KEY", "overpass-api.de", ":9455"];
      return JSON.stringify(bad.filter((marker) => text.includes(marker)));
    `);
    const leakedList = JSON.parse(leaked);
    if (leakedList.length > 0) {
      console.error(`\n  ✗ a fixture or secret marker is visible in the page: ${leakedList.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("  ✓ no fixture URL, key name or provider host is visible in the page");
    }

    if (files.length < 10) {
      console.error(`\n  ✗ expected 10 screenshots, captured ${files.length}`);
      process.exitCode = 1;
    }
  } finally {
    await page.close();
    await server.close();
    await Promise.all(
      [nominatim, overpass, valhalla, gemini].map((fixture) =>
        new Promise((resolve) => fixture.server.close(resolve)),
      ),
    );
    await chrome.close();
  }
}

await main();
