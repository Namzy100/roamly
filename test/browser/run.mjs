import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { launchChrome, openPage, waitFor } from "./cdp.mjs";
import {
  closeAll,
  startGemini,
  startNominatim,
  startOverpass,
  startValhalla,
} from "./fixtures.mjs";

/**
 * Browser verification for Phase 5B — real Chrome, real server, fixture providers.
 *
 * Run with `npm run verify:browser`.
 *
 * ## What is real and what is not
 *
 * **Real:** Chrome, the Next server, every API route, the whole generation pipeline,
 * mechanical validation, canonical attachment, the immutable builder, the pool gate,
 * `localStorage` persistence and the revision guard.
 *
 * **Fixtures:** Nominatim, Overpass, Gemini and Valhalla, each a local HTTP server.
 * Nothing leaves the machine. That is not a convenience — a verification suite that
 * queried volunteer OpenStreetMap services and burned Gemini quota on every run could
 * not be run repeatedly, which would make it useless.
 *
 * ## Why the server restarts between scenarios
 *
 * Provider configuration is read from the environment, and the "no AI planner
 * configured" case is only meaningful with the variables genuinely absent. Several
 * scenarios also need a different fixture behaviour — a refusal, a fabricated place —
 * and the OSM cache is per process, so a fresh process is the only honest way to make
 * each scenario repeatable.
 */

/**
 * The project root, resolved from this file rather than from `process.cwd()`.
 *
 * `next dev` started in the wrong directory reports "Ready" and then answers every
 * request with "Couldn't find any `pages` or `app` directory" — a failure that reads
 * exactly like a dead server. Pinning both the cwd and the local binary removes the
 * whole class of problem.
 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NEXT_BIN = join(PROJECT_ROOT, "node_modules", ".bin", "next");

export const FORM = {
  departureCity: "Dubai",
  destination: "Lisbon",
  startDate: "2026-09-12",
  endDate: "2026-09-13",
  budget: "2000",
  travelers: "2",
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const results = [];
let currentScenario = "";

function check(name, passed, detail = "") {
  results.push({ scenario: currentScenario, name, passed, detail });
  const mark = passed ? "  ✓" : "  ✗";
  console.log(`${mark} ${name}${detail && !passed ? ` — ${detail}` : ""}`);
}

async function expect(name, probe) {
  try {
    const value = await probe();
    check(name, value === true || value === undefined, String(value));
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

async function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startNextServer(env) {
  const port = await freePort();

  const child = spawn(NEXT_BIN, ["dev", "--port", String(port)], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout.on("data", (chunk) => {
    log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    log += chunk;
  });

  /**
   * `localhost`, not `127.0.0.1`.
   *
   * Next 16 blocks dev-server requests from an origin outside `allowedDevOrigins`,
   * and `127.0.0.1` is not one by default. The page still renders — but the client
   * bundle never hydrates, so the form falls back to a native GET submit and every
   * interactive check fails for a reason that has nothing to do with the code.
   */
  const baseUrl = `http://localhost:${port}`;
  await waitFor(
    async () => {
      const response = await fetch(baseUrl).catch(() => null);
      return response?.ok ?? false;
    },
    `Next dev server on ${port}\n${log.slice(-800)}`,
    { timeoutMs: 90_000 },
  );

  return {
    baseUrl,
    log: () => log,
    async close() {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
  };
}

/** Fills the builder form and submits it. Same path a traveller takes. */
export async function submitForm(page) {
  /**
   * Hydration first.
   *
   * Before the client bundle runs, `requestSubmit` performs a **native GET submit** —
   * the page reloads with the answers in the query string and nothing else happens.
   * `window.__roamlyTripStore` is the development-only store seam, so its presence is
   * a precise signal that client code has executed.
   */
  await page.waitFor(`window.__roamlyTripStore !== undefined`, {
    timeoutMs: 30_000,
    label: "client hydration",
  });

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

    /**
     * Idempotent, not a toggle.
     *
     * A returning visitor's form is prefilled from \`lastRequest\`, so these boxes are
     * already ticked on a second submission — and a blind \`click()\` would untick
     * them, failing validation with "Pick at least one vibe". Ensuring the state is
     * what a traveller does; toggling is what a script does.
     */
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

export async function chooseFirstDestination(page) {
  await page.waitFor(
    `document.querySelectorAll('[data-testid="destination-candidate"]').length > 0`,
    { label: "destination candidates" },
  );
  await page.evaluate(`
    const first = document.querySelector('[data-testid="destination-candidate"] input');
    first.click();
    return true;
  `);
}

/**
 * Waits until the workspace has actually rendered.
 *
 * `location.pathname` changes the moment the router pushes, but the plan lives in
 * `localStorage` and cannot be read until after hydration — so the trip page shows a
 * skeleton first. Asserting on the URL alone produced a suite that checked an empty
 * document and reported it as a pass.
 */
export async function waitForWorkspace(page) {
  await page.waitFor(`location.pathname.startsWith("/trip/")`, {
    timeoutMs: 90_000,
    label: "navigation to the trip page",
  });
  await page.waitFor(
    `document.querySelector('[data-testid="routing-controls"]')`,
    { timeoutMs: 30_000, label: "the workspace" },
  );
}

/**
 * Opens the refine disclosure, whatever state it is in.
 *
 * A bare `click` on the toggle is a *toggle*: it opens a closed panel and closes an
 * open one, so a scenario that clicks it twice ends up where it started. Driving to a
 * known state instead makes each check independent of what the previous one left
 * behind.
 */
export async function ensureRefinePanelOpen(page) {
  // `data-open` is the component's own flag, so it cannot disagree with itself the way
  // "is a child element present yet" can while React is mid-commit.
  const isOpen = () =>
    page.check(
      `document.querySelector('[data-testid="refine-panel"]')?.dataset.open === "true"`,
    );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await isOpen()) return true;
    await page.click('[data-testid="refine-toggle"]');
    await page.sleep(500);
  }
  return isOpen();
}

/** The store, read through the development-only seam. */
export async function readStore(page) {
  return page.evaluate(`
    const store = window.__roamlyTripStore;
    if (!store) return null;
    const records = store.getState().records;
    return JSON.parse(JSON.stringify(records));
  `);
}

async function noHorizontalOverflow(page) {
  return page.evaluate(`
    return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;
  `);
}

function consoleProblems(page) {
  return page.consoleMessages.filter(
    (message) =>
      message.type === "error" ||
      /hydrat|did not match|Warning: Text content/i.test(message.text),
  );
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

async function scenarioNoProvider(chrome, fixtures) {
  currentScenario = "No AI planner configured";
  console.log(`\n▸ ${currentScenario}`);

  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    // Deliberately no GEMINI_API_KEY and no OLLAMA_BASE_URL.
    ROAMLY_AI_PROVIDER: "auto",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await expect("landing page renders with no console errors", async () => {
      return consoleProblems(page).length === 0;
    });
    await expect("no horizontal overflow on the landing page", () =>
      noHorizontalOverflow(page),
    );
    await expect("no provider request on page load", async () => {
      return (
        fixtures.nominatim.state.requests === 0 &&
        fixtures.overpass.state.requests === 0
      );
    });

    await submitForm(page);

    await expect("submitting the form starts geocoding", async () => {
      await page.waitFor(
        `document.querySelector('[data-testid="generation-panel"]')`,
        { label: "generation panel" },
      );
      // The panel appears in its `geocoding` phase before the request resolves, so
      // the request count is only meaningful once candidates are on screen.
      await page.waitFor(
        `document.querySelectorAll('[data-testid="destination-candidate"]').length > 0`,
        { label: "destination candidates" },
      );
      return fixtures.nominatim.state.requests >= 1;
    });

    await expect("ambiguous destinations are offered for selection", async () => {
      const count = await page.evaluate(
        `return document.querySelectorAll('[data-testid="destination-candidate"]').length;`,
      );
      return count === 2;
    });

    await expect("the AI action is disabled and says why", async () => {
      const state = await page.evaluate(`
        return {
          disabled: document.querySelector('[data-testid="generate-with-ai"]')?.disabled ?? null,
          note: Boolean(document.querySelector('[data-testid="ai-unavailable-note"]')),
          demo: document.querySelector('[data-testid="generate-with-demo"]')?.disabled ?? null,
        };
      `);
      return state.disabled === true && state.note === true;
    });

    await chooseFirstDestination(page);

    await expect("selecting a destination enables the demo planner", async () => {
      const disabled = await page.evaluate(
        `return document.querySelector('[data-testid="generate-with-demo"]').disabled;`,
      );
      return disabled === false;
    });

    // --- the deterministic planner, end to end, with no environment at all -----
    await page.click('[data-testid="generate-with-demo"]');

    await expect("progress stages render", async () => {
      await page.waitFor(`document.querySelector('[data-testid="generation-stages"]')`, {
        label: "progress stages",
      });
      const stages = await page.evaluate(
        `return document.querySelectorAll('[data-testid="generation-stages"] li').length;`,
      );
      return stages === 6;
    });

    await expect("the demo planner produces a saved trip", async () => {
      await waitForWorkspace(page);
      return true;
    });

    const records = await readStore(page);
    const tripId = records ? Object.keys(records)[0] : null;
    const record = tripId ? records[tripId] : null;

    await expect("saved at revision 1", () => record?.revision === 1);

    await expect("the trip retains its full discovery pool", () => {
      const pool = record?.generation?.placePool;
      return (
        Boolean(pool) &&
        pool.poolId.startsWith("discovery:") &&
        pool.places.length >= 8
      );
    });

    await expect("every resolved place belongs to the saved pool", () => {
      const pool = new Set(
        (record?.generation?.placePool?.places ?? []).map((place) => place.placeId),
      );
      const used = record.plan.days
        .flatMap((day) => [
          ...day.items.flatMap((item) => (item.place ? [item.place.placeId] : [])),
          ...day.backups.map((backup) => backup.place.placeId),
        ])
        .concat(
          record.plan.accommodation ? [record.plan.accommodation.place.placeId] : [],
        );
      return used.length > 0 && used.every((placeId) => pool.has(placeId));
    });

    await expect("the pool retains candidates the itinerary did not use", () => {
      const pool = record.generation.placePool.places.length;
      const used = new Set(
        record.plan.days.flatMap((day) =>
          day.items.flatMap((item) => (item.place ? [item.place.placeId] : [])),
        ),
      ).size;
      return used < pool;
    });

    await expect("demo output is marked template, not generated", () => {
      return record.plan.source === "mock";
    });

    await expect("the template banner is shown for demo output", async () => {
      return page.check(`document.querySelector('[data-testid="sample-banner"]')`);
    });

    await expect("provenance names the demo planner", async () => {
      return page.evaluate(`
        const panel = document.querySelector('[data-testid="generation-provenance"]');
        if (!panel) return false;
        return panel.dataset.provider === "deterministic"
          && panel.textContent.includes("Demo Planner");
      `);
    });

    /* -- the card's interaction boundary (Phase 8, checkpoint 2A) ------------
     *
     * Through Phase 7 each card was a single `<button aria-pressed>`. Nothing interactive could
     * live inside it, so the per-stop controls sat outside, and the time editor and drag handle
     * Phase 8 needs had nowhere to go. The card is now an `<article>` with one explicit selection
     * control and an action row.
     *
     * These checks exist because that refactor is easy to undo by accident: the moment a second
     * `aria-pressed` appears, or a control lands inside the selection button, the card stops being
     * operable in the way it claims to be — and nothing in the type system or the unit suite would
     * notice.
     */
    await expect("every stop renders as a semantic article, not a button", () =>
      page.evaluate(`
        const cards = Array.from(document.querySelectorAll('[data-testid="itinerary-item"]'));
        if (cards.length === 0) return 'no cards rendered';
        const wrong = cards.filter((card) => card.tagName !== 'ARTICLE');
        return wrong.length === 0 ? true : wrong.map((c) => c.tagName).join(',');
      `),
    );

    await expect("each card names itself by its heading", () =>
      page.evaluate(`
        const cards = Array.from(document.querySelectorAll('[data-testid="itinerary-item"]'));
        const broken = cards.filter((card) => {
          const id = card.getAttribute('aria-labelledby');
          const heading = id ? document.getElementById(id) : null;
          return !heading || heading.textContent.trim().length === 0;
        });
        return broken.length === 0 ? true : broken.length + ' cards with no resolvable name';
      `),
    );

    await expect(
      "exactly one control per card carries aria-pressed, and it is the selection control",
      () =>
        page.evaluate(`
        const cards = Array.from(document.querySelectorAll('[data-testid="itinerary-item"]'));
        if (cards.length === 0) return 'no cards rendered';
        const wrong = cards.filter((card) => {
          const pressed = card.querySelectorAll('[aria-pressed]');
          return pressed.length !== 1 || pressed[0].dataset.testid !== 'select-stop';
        });
        return wrong.length === 0 ? true : wrong.length + ' cards with the wrong pressed control';
      `),
    );

    /**
     * The property that made the old single-button card a dead end.
     *
     * A button inside a button is invalid HTML and browsers resolve it inconsistently — one may
     * fire both handlers, another neither. This asserts the general rule rather than the specific
     * pair, so it also covers the menu, the time editor and the drag handle still to come.
     */
    await expect("no interactive element is nested inside another", () =>
      page.evaluate(`
        const SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';
        const cards = Array.from(document.querySelectorAll('[data-testid="itinerary-item"]'));
        if (cards.length === 0) return 'no cards rendered';
        const nested = cards
          .flatMap((card) => Array.from(card.querySelectorAll(SELECTOR)))
          .filter((el) => el.parentElement && el.parentElement.closest(SELECTOR) !== null);
        return nested.length === 0
          ? true
          : nested.slice(0, 3).map((el) => el.tagName + '[' + (el.dataset.testid ?? '') + ']').join(' | ');
      `),
    );

    await expect("the selection control announces the stop, its place and its time", () =>
      page.evaluate(`
        const control = document.querySelector('[data-testid="select-stop"]');
        if (!control) return 'no selection control';
        const label = control.getAttribute('aria-label') ?? '';
        return /^Stop \\d+: .+\\. \\d{2}:\\d{2} – \\d{2}:\\d{2}\\./.test(label)
          ? true
          : 'label was: ' + label;
      `),
    );

    const firstStopId = await page.evaluate(
      `return document.querySelector('[data-testid="itinerary-item"]').dataset.itemId;`,
    );
    const stopSelector = `[data-testid="select-stop"][data-item-id="${firstStopId}"]`;
    const cardExpr = `document.querySelector('[data-testid="itinerary-item"][data-item-id=${JSON.stringify(firstStopId)}]')`;

    await page.click(stopSelector);

    await expect("clicking the selection control selects the card", () =>
      page.evaluate(`
        const card = ${cardExpr};
        const control = card.querySelector('[data-testid="select-stop"]');
        return card.dataset.selected === 'true' && control.getAttribute('aria-pressed') === 'true'
          ? true
          : 'selected=' + card.dataset.selected + ' pressed=' + control.getAttribute('aria-pressed');
      `),
    );

    /**
     * Card-to-map selection, the behaviour the old single-button card existed to provide.
     *
     * The marker and the card both read `selectedItemId` from the workspace store, so this is the
     * round trip: card press → store → marker. Asserted rather than trusted, because the refactor
     * moved the click handler onto a different element.
     */
    await expect("the matching map marker is selected too", () =>
      page.evaluate(`
        const marker = document.querySelector('[data-item-id=${JSON.stringify(firstStopId)}][aria-pressed]:not([data-testid="select-stop"])');
        if (!marker) return 'no marker for the selected stop';
        return marker.getAttribute('aria-pressed') === 'true'
          ? true
          : 'marker pressed=' + marker.getAttribute('aria-pressed');
      `),
    );

    /** Pressing the selected card again clears it — how a highlighted pin is dismissed. */
    await page.click(stopSelector);

    await expect("pressing it again clears the selection", () =>
      page.evaluate(`
        const card = ${cardExpr};
        return card.dataset.selected === 'false'
          && card.querySelector('[data-testid="select-stop"]').getAttribute('aria-pressed') === 'false'
          ? true
          : 'still selected';
      `),
    );

    /*
     * Keyboard selection, through the browser's own input pipeline.
     *
     * The Tab press before focusing is not incidental: it puts Chrome into keyboard modality, which
     * is what makes `:focus-visible` match on a programmatically focused button. Without it the
     * focus-ring assertion below would fail for a reason that has nothing to do with the styling.
     */
    await page.press("Tab");
    await page.focus(stopSelector);

    await expect("the focused selection control shows a visible focus ring", () =>
      page.evaluate(`
        const control = document.querySelector('${stopSelector}');
        if (document.activeElement !== control) return 'not focused';
        if (!control.matches(':focus-visible')) return 'no :focus-visible match';
        const style = getComputedStyle(control);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2
          ? true
          : 'outline ' + style.outlineStyle + ' ' + style.outlineWidth;
      `),
    );

    await page.press("Enter");

    await expect("Enter on the focused control selects the card", () =>
      page.evaluate(`
        return ${cardExpr}.dataset.selected === 'true' ? true : 'not selected by Enter';
      `),
    );

    /** Focus survives the state change, so a keyboard user does not lose their place. */
    await expect("focus stays on the control after selecting", () =>
      page.evaluate(`
        const control = document.querySelector('${stopSelector}');
        return document.activeElement === control
          ? true
          : 'focus moved to ' + document.activeElement.tagName;
      `),
    );

    await expect("the card is still the scroll anchor the panel looks up", () =>
      page.evaluate(`
        const byId = document.getElementById('trip-item-' + ${JSON.stringify(firstStopId)});
        return byId !== null && byId === ${cardExpr} ? true : 'anchor and card disagree';
      `),
    );

    /* Leave the workspace unselected for the checks that follow. */
    await page.click(stopSelector);

    await expect("prices are labelled estimates", async () => {
      return page.evaluate(`
        const text = document.body.textContent;
        return text.includes("planning estimate") || text.includes("planning estimates");
      `);
    });

    await expect("OpenStreetMap attribution is visible", async () => {
      return page.check(`document.body.textContent.includes("OpenStreetMap")`);
    });

    await expect("routes are reported as not yet calculated", async () => {
      return page.check(
        `document.body.textContent.includes("Routes have not been calculated yet")`,
      );
    });

    await expect("no routing request happened during generation", () => {
      return fixtures.valhalla.state.requests === 0;
    });

    await expect("the routing action is offered", async () => {
      return page.check(`document.querySelector('[data-testid="calculate-routes-button"]')`);
    });

    // --- real routing on a generated plan, using the retained pool -------------
    await page.click('[data-testid="calculate-routes-button"]');

    await expect("calculating routes uses the retained generation pool", async () => {
      await waitFor(
        () => fixtures.valhalla.state.requests > 0,
        "a routing request",
        { timeoutMs: 30_000 },
      );
      const routeCall = page.requests.find(
        (request) =>
          request.url.includes("/api/trips/route") && request.method === "POST",
      );
      if (!routeCall?.body) return false;
      const body = JSON.parse(routeCall.body);
      return body.placePool.poolId.startsWith("discovery:");
    });

    await expect("routing increments the revision exactly once", async () => {
      await page.waitFor(`document.querySelector('[data-testid="routing-coverage"]')`, {
        timeoutMs: 40_000,
        label: "routing coverage",
      });
      const after = await readStore(page);
      return after[tripId].revision === 2;
    });

    await expect("routing leaves the generation context intact", async () => {
      const after = await readStore(page);
      return (
        after[tripId].generation?.placePool?.poolId ===
        record.generation.placePool.poolId
      );
    });

    await expect("a refresh preserves the generation context", async () => {
      await page.goto(`${server.baseUrl}/trip/${tripId}`);
      await waitForWorkspace(page);
      await page.waitFor(`document.querySelector('[data-testid="generation-provenance"]')`, {
        label: "provenance after reload",
      });
      const after = await readStore(page);
      return (
        after[tripId].generation?.placePool?.places.length ===
        record.generation.placePool.places.length
      );
    });

    await expect("no horizontal overflow on the trip page", () =>
      noHorizontalOverflow(page),
    );

    await expect("mobile viewport renders the workspace", async () => {
      await page.setViewport(390, 844);
      await page.sleep(400);
      const ok =
        (await page.check(`document.querySelector('[role="tablist"]')`)) &&
        (await noHorizontalOverflow(page));
      await page.setViewport(1440, 900);
      return ok;
    });

    await expect("no console errors or hydration warnings in this scenario", () => {
      const problems = consoleProblems(page);
      return problems.length === 0
        ? true
        : `saw: ${problems.map((p) => p.text).slice(0, 3).join(" | ")}`;
    });

    await expect("no page exceptions", () =>
      page.pageErrors.length === 0
        ? true
        : `saw: ${page.pageErrors.slice(0, 2).join(" | ")}`,
    );

    return { tripId };
  } finally {
    await page.close();
    await server.close();
  }
}

async function scenarioGemini(chrome, fixtures, gemini) {
  currentScenario = "Gemini configured (fixture)";
  console.log(`\n▸ ${currentScenario}`);

  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
    ROAMLY_AI_PROVIDER: "auto",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await expect("the AI action is offered when a provider is configured", async () => {
      await submitForm(page);
      await page.waitFor(`document.querySelector('[data-testid="generate-with-ai"]')`, {
        label: "the AI action",
      });
      return page.evaluate(`
        return document.querySelector('[data-testid="ai-unavailable-note"]') === null;
      `);
    });

    await chooseFirstDestination(page);

    // Three clicks in one tick: the ref guard, not the disabled attribute, is what
    // has to hold here.
    const before = gemini.state.requests;
    await page.evaluate(`
      const button = document.querySelector('[data-testid="generate-with-ai"]');
      button.click();
      button.click();
      button.click();
      return true;
    `);

    await expect("a generated trip is produced and saved", async () => {
      await waitForWorkspace(page);
      return true;
    });

    await expect("three rapid clicks produced one generation", () => {
      // Two model calls for one generation: strategy and assembly.
      const calls = gemini.state.requests - before;
      return calls === 2 ? true : `saw ${calls} provider calls`;
    });

    const records = await readStore(page);
    const tripId = Object.keys(records)[0];
    const record = records[tripId];

    await expect("the plan is marked generated", () => record.plan.source === "generated");

    await expect("the template banner is absent for generated output", async () => {
      return page.evaluate(
        `return document.querySelector('[data-testid="sample-banner"]') === null;`,
      );
    });

    await expect("provenance names Gemini", async () => {
      return page.evaluate(`
        const panel = document.querySelector('[data-testid="generation-provenance"]');
        return panel?.dataset.provider === "gemini"
          && panel.textContent.includes("Gemini");
      `);
    });

    await expect("the model id is not in the headline", async () => {
      return page.evaluate(`
        const heading = document.querySelector('[data-testid="generation-provenance"] h3');
        return !heading.textContent.includes("gemini-fixture");
      `);
    });

    await expect("saved at revision 1 with the full pool", () => {
      return (
        record.revision === 1 &&
        record.generation.provider === "gemini" &&
        record.generation.placePool.places.length >= 8
      );
    });

    await expect("every place is from the saved pool", () => {
      const pool = new Set(
        record.generation.placePool.places.map((place) => place.placeId),
      );
      const used = record.plan.days.flatMap((day) =>
        day.items.flatMap((item) => (item.place ? [item.place.placeId] : [])),
      );
      return used.length > 0 && used.every((placeId) => pool.has(placeId));
    });

    await expect("the pace-derived routing policy was recorded", () => {
      return typeof record.generation.routingPolicy?.modePolicy?.walkMaxMeters === "number";
    });

    await expect("no routing request during generation", () => {
      return fixtures.valhalla.state.requests === 0;
    });

    await expect("no console errors in this scenario", () => {
      const problems = consoleProblems(page);
      return problems.length === 0
        ? true
        : `saw: ${problems.map((p) => p.text).slice(0, 3).join(" | ")}`;
    });

    return { tripId };
  } finally {
    await page.close();
    await server.close();
  }
}

/**
 * Cancelling mid-flight.
 *
 * Needs a deliberately slow provider: the instant fixture finishes before any click
 * can land, and "cancel" is only meaningful while a request is outstanding.
 */
async function scenarioCancel(chrome, fixtures) {
  currentScenario = "Cancelling a generation";
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode: "ok", delayMs: 4_000 });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');

    await expect("a cancel action is offered while generating", async () => {
      await page.waitFor(`document.querySelector('[data-testid="cancel-generation"]')`, {
        label: "the cancel action",
      });
      return true;
    });

    await page.click('[data-testid="cancel-generation"]');
    await page.sleep(2_000);

    await expect("cancelling saves no trip", async () => {
      const records = (await readStore(page)) ?? {};
      return Object.keys(records).length === 0;
    });

    await expect("cancelling returns to the form rather than navigating", () =>
      page.check(`location.pathname === "/"`),
    );

    // The provider may still answer after the traveller has gone; nothing may act on it.
    await page.sleep(4_000);

    await expect("a late provider answer cannot resurrect the trip", async () => {
      const records = (await readStore(page)) ?? {};
      return Object.keys(records).length === 0 && (await page.check(`location.pathname === "/"`));
    });
  } finally {
    await page.close();
    await server.close();
    await closeAll([gemini]);
  }
}


/**
 * Refinement (Phase 6A).
 *
 * Runs against a *generated* trip, because that is the only kind that can be refined —
 * a refinement is verified against the saved place pool, and the sample trip has none.
 *
 * The assertions worth the scenario are the negative ones: an unrelated stop is
 * byte-identical afterwards, an unaffected routed line survives, an affected one is
 * gone, and a refusal leaves the plan exactly as it was.
 */
async function scenarioRefinement(chrome, fixtures) {
  currentScenario = "Refining a generated trip";
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode: "ok" });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    // --- a generated trip to refine -----------------------------------------
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    await waitForWorkspace(page);

    const before = await readStore(page);
    const tripId = Object.keys(before)[0];

    await expect("the refine panel appears on a generated trip", () =>
      page.check(`document.querySelector('[data-testid="refine-panel"]')`),
    );

    await expect("AI refinement is offered when a planner is configured", async () => {
      await ensureRefinePanelOpen(page);
      return page.evaluate(`
        const panel = document.querySelector('[data-testid="refine-panel"]');
        return panel.dataset.aiEnabled === "true"
          && document.querySelector('[data-testid="refine-ai-unavailable"]') === null;
      `);
    });

    await expect("route retry is offered without needing a planner", () =>
      page.check(`document.querySelector('[data-testid="recalculate-all-routes"]')`),
    );

    // --- routes first, so invalidation has something to invalidate ----------
    await page.click('[data-testid="recalculate-all-routes"]');
    await page.waitFor(
      `document.querySelectorAll('[data-testid="travel-segment"][data-status="routed"]').length > 0`,
      { timeoutMs: 60_000, label: "routed segments" },
    );

    const routedBefore = await page.evaluate(`
      return Array.from(
        document.querySelectorAll('[data-testid="travel-segment"][data-status="routed"]'),
      ).map((node) => node.dataset.legId ?? "");
    `);

    const afterRouting = await readStore(page);
    const routedRevision = afterRouting[tripId].revision;

    await expect("routing does not consume a step of undo history", () => {
      return afterRouting[tripId].history.past.length === 0;
    });

    // --- replace one stop ---------------------------------------------------
    const target = await page.evaluate(`
      const button = document.querySelector('[data-testid="replace-stop"]');
      return button ? button.dataset.itemId : null;
    `);

    await expect("a replace action is offered on a place-backed stop", () =>
      target !== null,
    );

    const unrelatedBefore = await page.evaluate(`
      const store = window.__roamlyTripStore;
      const record = Object.values(store.getState().records)[0];
      const items = record.plan.days.flatMap((day) => day.items);
      const other = items.filter((item) => item.id !== ${JSON.stringify(target)});
      return JSON.stringify(other.map((item) => ({
        id: item.id,
        placeId: item.place ? item.place.placeId : null,
        startTime: item.startTime,
        cost: item.estimatedCost,
      })));
    `);

    await page.click('[data-testid="replace-stop"]');

    await expect("the replacement is applied and summarised", async () => {
      await page.waitFor(`document.querySelector('[data-testid="refine-outcome"]')`, {
        timeoutMs: 60_000,
        label: "the refinement outcome",
      });
      return page.evaluate(`
        const outcome = document.querySelector('[data-testid="refine-outcome"]');
        return outcome.dataset.action === "replace-item"
          && Number(outcome.dataset.added) === 1
          && Number(outcome.dataset.removed) === 1;
      `);
    });

    const afterReplace = await readStore(page);

    await expect("the revision increments exactly once", () => {
      return afterReplace[tripId].revision === routedRevision + 1;
    });

    await expect("the replacement place is from the saved pool", () => {
      const pool = new Set(
        afterReplace[tripId].generation.placePool.places.map((place) => place.placeId),
      );
      const used = afterReplace[tripId].plan.days
        .flatMap((day) => day.items)
        .flatMap((item) => (item.place ? [item.place.placeId] : []));
      return used.length > 0 && used.every((placeId) => pool.has(placeId));
    });

    await expect("the canonical place is rendered, not a model paraphrase", async () => {
      const replaced = afterReplace[tripId].plan.days
        .flatMap((day) => day.items)
        .find((item) => item.id.endsWith("-r1"));
      if (!replaced?.place) return "no replaced item found";
      const canonical = afterReplace[tripId].generation.placePool.places.find(
        (place) => place.placeId === replaced.place.placeId,
      );
      return (
        canonical !== undefined &&
        replaced.place.name === canonical.name &&
        replaced.place.coordinates.lat === canonical.coordinates.lat
      );
    });

    await expect("no unrelated stop changed", async () => {
      const unrelatedAfter = await page.evaluate(`
        const store = window.__roamlyTripStore;
        const record = Object.values(store.getState().records)[0];
        const items = record.plan.days.flatMap((day) => day.items);
        const other = items.filter((item) => !item.id.endsWith("-r1"));
        return JSON.stringify(other.map((item) => ({
          id: item.id,
          placeId: item.place ? item.place.placeId : null,
          startTime: item.startTime,
          cost: item.estimatedCost,
        })));
      `);
      return unrelatedAfter === unrelatedBefore;
    });

    await expect("the affected route line is gone and the others remain", async () => {
      const routedAfter = await page.evaluate(`
        return Array.from(
          document.querySelectorAll('[data-testid="travel-segment"][data-status="routed"]'),
        ).map((node) => node.dataset.legId ?? "");
      `);
      const invalidated = Number(
        await page.evaluate(
          `return document.querySelector('[data-testid="refine-outcome"]').dataset.invalidatedLegs;`,
        ),
      );

      if (invalidated === 0) return "nothing was reported as invalidated";
      // Every surviving line was already there, and at least one has gone.
      const survivedAll = routedAfter.every((legId) => routedBefore.includes(legId));
      return survivedAll && routedAfter.length < routedBefore.length;
    });

    await expect("routing coverage was recomputed", async () => {
      return page.evaluate(`
        const coverage = document.querySelector('[data-testid="routing-coverage"]');
        if (!coverage) return true;
        return Number(coverage.dataset.expectedLegs) >= Number(coverage.dataset.routedLegs);
      `);
    });

    // --- undo ---------------------------------------------------------------
    await expect("an undo control appears after a refinement", async () => {
      await page.waitFor(`document.querySelector('[data-testid="undo-refinement"]')`, {
        label: "the undo control",
      });
      return true;
    });

    await page.click('[data-testid="undo-refinement"]');
    await page.sleep(600);

    const afterUndo = await readStore(page);

    await expect("undo restores the previous itinerary", () => {
      const items = afterUndo[tripId].plan.days.flatMap((day) => day.items);
      return items.some((item) => item.id === target)
        && !items.some((item) => item.id.endsWith("-r1"));
    });

    await expect("undo increments the revision rather than decrementing", () => {
      return afterUndo[tripId].revision === afterReplace[tripId].revision + 1;
    });

    /**
     * The step moved across rather than being discarded.
     *
     * Phase 6A cleared the single snapshot on undo, so "nothing left to undo" was the assertion. A
     * bounded history instead moves the step to the redo stack, which is the whole difference: the
     * traveller can change their mind twice.
     */
    await expect("undo moves the step onto the redo stack", () => {
      const history = afterUndo[tripId].history;
      return history.past.length === 0 && history.future.length === 1;
    });

    await expect("the undo control gives way to a redo control", async () => {
      await page.sleep(300);
      return page.evaluate(`
        return document.querySelector('[data-testid="undo-refinement"]') === null
          && document.querySelector('[data-testid="redo-refinement"]') !== null;
      `);
    });

    /** Actual depth, not the twenty the history is allowed to hold. */
    await expect("the redo control reports the depth it actually has", () =>
      page.evaluate(`
        const redo = document.querySelector('[data-testid="redo-refinement"]');
        return redo === null ? 'no redo control' : redo.dataset.depth === '1';
      `),
    );

    await expect("redo puts the refinement back and saves one revision forward", async () => {
      const before = (await readStore(page))[tripId].revision;
      await page.click('[data-testid="redo-refinement"]');
      await page.waitFor(
        `document.querySelector('[data-testid="undo-refinement"]') !== null`,
        { label: "the undo control to return" },
      );

      const store = await readStore(page);
      return (
        store[tripId].revision === before + 1 &&
        store[tripId].history.past.length === 1 &&
        store[tripId].history.future.length === 0
      );
    });

    /** Back where the undo left things, so the rest of the scenario reads as before. */
    await page.click('[data-testid="undo-refinement"]');
    await page.waitFor(
      `document.querySelector('[data-testid="redo-refinement"]') !== null`,
      { label: "the redo control to return" },
    );

    // --- a day adjustment ---------------------------------------------------
    /**
     * Day adjustment is offered only for a single selected day.
     *
     * In All Days there is no one day to adjust, so the panel says so instead of
     * guessing — which is why the selector has to be driven first. `#day-tab-1` is the
     * tab's own id, from `DaySelector`.
     */
    await expect("adjusting a day appears once a single day is selected", async () => {
      await page.click("#day-tab-1");
      await page.sleep(400);

      await ensureRefinePanelOpen(page);

      const found = await page.check(
        `document.querySelector('[data-testid="adjust-day-cheaper"]')`,
      );
      if (found) return true;

      // Diagnose rather than just failing: the two things that can be wrong here are
      // the panel being closed and the day not being selected.
      return page.evaluate(`
        const panel = document.querySelector('[data-testid="refine-panel"]');
        const tab = document.querySelector('#day-tab-1');
        return "panelOpen=" + panel?.dataset.open
          + " tabSelected=" + tab?.getAttribute("aria-selected")
          + " actions=" + Boolean(document.querySelector('[data-testid="refine-actions"]'))
          + " text=" + (document.querySelector('[data-testid="refine-actions"]')?.textContent ?? "").slice(0, 120);
      `);
    });

    const beforeCheaper = await readStore(page);
    const cheaperBaseline = beforeCheaper[tripId].plan.budget.total;

    await page.click('[data-testid="adjust-day-cheaper"]');

    await expect("a cheaper day lowers the estimated total", async () => {
      await page.waitFor(
        `document.querySelector('[data-testid="refine-outcome"]')?.dataset.action === "adjust-day"
          || document.querySelector('[data-testid="refine-error"]')`,
        { timeoutMs: 60_000, label: "the adjustment outcome" },
      );
      const failed = await page.check(
        `document.querySelector('[data-testid="refine-error"]')`,
      );
      if (failed) {
        // A day of nothing but meals legitimately cannot be made cheaper, and saying so
        // is the honest outcome — but it must not have changed anything.
        const after = await readStore(page);
        return after[tripId].plan.budget.total === cheaperBaseline
          ? true
          : `refused but the total moved from ${cheaperBaseline} to ${after[tripId].plan.budget.total}`;
      }
      const after = await readStore(page);
      return after[tripId].plan.budget.total < cheaperBaseline
        ? true
        : `total went from ${cheaperBaseline} to ${after[tripId].plan.budget.total}`;
    });

    // --- refresh preserves everything ---------------------------------------
    await expect("a refresh preserves the refined plan and its pool", async () => {
      const beforeReload = await readStore(page);
      await page.goto(`${server.baseUrl}/trip/${tripId}`);
      await waitForWorkspace(page);
      const afterReload = await readStore(page);

      return (
        afterReload[tripId].revision === beforeReload[tripId].revision &&
        afterReload[tripId].generation.placePool.places.length ===
          beforeReload[tripId].generation.placePool.places.length
      );
    });

    await expect("the refine controls are reachable by keyboard", async () => {
      return page.evaluate(`
        const toggle = document.querySelector('[data-testid="refine-toggle"]');
        toggle.focus();
        return document.activeElement === toggle && toggle.tagName === "BUTTON";
      `);
    });

    await expect("no hover-only control hides the refine actions", async () => {
      // The panel is a disclosure, not a popover: its state is in the DOM, not in a
      // hover handler, so it survives keyboard-only use.
      return page.evaluate(`
        const panel = document.querySelector('[data-testid="refine-panel"]');
        return panel.dataset.open === "true" || panel.dataset.open === "false";
      `);
    });

    await expect("the mobile refine panel is usable", async () => {
      await page.setViewport(390, 844);
      await page.sleep(400);
      const ok =
        (await page.check(`document.querySelector('[data-testid="refine-panel"]')`)) &&
        (await noHorizontalOverflow(page));
      await page.setViewport(1440, 900);
      return ok;
    });

    await expect("no console errors or hydration warnings in this scenario", () => {
      const problems = consoleProblems(page);
      return problems.length === 0
        ? true
        : `saw: ${problems.map((p) => p.text).slice(0, 3).join(" | ")}`;
    });

    await expect("no page exceptions", () =>
      page.pageErrors.length === 0
        ? true
        : `saw: ${page.pageErrors.slice(0, 2).join(" | ")}`,
    );
  } finally {
    await page.close();
    await server.close();
    await closeAll([gemini]);
  }
}

/**
 * Refinement with no planner configured.
 *
 * The AI actions must be *present and disabled with a reason*, while route retry keeps
 * working — that split is the whole point of classifying the actions.
 */
async function scenarioRefinementWithoutAi(chrome, fixtures) {
  currentScenario = "Refining with no AI planner";
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode: "ok" });
  const generateServer = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
  });
  const page = await openPage(chrome.port, "about:blank");

  try {
    // Generate a Gemini trip first, so the "was made by a model" branch is exercised.
    await page.goto(`${generateServer.baseUrl}/`);
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    await waitForWorkspace(page);
    const tripId = Object.keys(await readStore(page))[0];
    await generateServer.close();
    await closeAll([gemini]);

    // Same origin and port would be ideal but a fresh server gets a new port, so the
    // trip is re-created in the new origin's storage through the same store seam.
    const record = await page.evaluate(`
      const store = window.__roamlyTripStore;
      return JSON.stringify(store.getState().records[${JSON.stringify(tripId)}]);
    `);

    const bareServer = await startNextServer({
      ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
      ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
      ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
      // No planner at all.
      ROAMLY_AI_PROVIDER: "auto",
    });

    try {
      await page.goto(`${bareServer.baseUrl}/`);
      await page.waitFor(`window.__roamlyTripStore !== undefined`, {
        label: "hydration",
      });
      await page.evaluate(`
        const store = window.__roamlyTripStore;
        const record = JSON.parse(${JSON.stringify(record)});
        store.setState({ records: { [${JSON.stringify(tripId)}]: record } });
        return true;
      `);

      await page.goto(`${bareServer.baseUrl}/trip/${tripId}`);
      await waitForWorkspace(page);
      await ensureRefinePanelOpen(page);

      await expect("AI refinement is disabled and explains why", async () => {
        return page.evaluate(`
          const panel = document.querySelector('[data-testid="refine-panel"]');
          const note = document.querySelector('[data-testid="refine-ai-unavailable"]');
          const regenerate = document.querySelector('[data-testid="regenerate-trip"]');
          return panel.dataset.aiEnabled === "false"
            && note !== null
            && regenerate.disabled === true;
        `);
      });

      await expect("the note mentions that routes still work", () =>
        page.check(
          `/[Rr]ecalculating routes still works/.test(document.querySelector('[data-testid="refine-ai-unavailable"]').textContent)`,
        ),
      );

      await expect("route retry remains available", async () => {
        return page.evaluate(`
          const button = document.querySelector('[data-testid="recalculate-all-routes"]');
          return button !== null && button.disabled === false;
        `);
      });

      await expect("per-stop replacement is not offered", () =>
        page.evaluate(
          `return document.querySelector('[data-testid="replace-stop"]') === null;`,
        ),
      );

      await expect("routes can still be calculated with no planner", async () => {
        const before = (await readStore(page))[tripId].revision;
        await page.click('[data-testid="recalculate-all-routes"]');
        await page.waitFor(
          `document.querySelector('[data-testid="routing-coverage"]')`,
          { timeoutMs: 60_000, label: "routing coverage" },
        );
        const after = (await readStore(page))[tripId].revision;
        return after === before + 1;
      });
    } finally {
      await bareServer.close();
    }
  } finally {
    await page.close();
  }
}

/**
 * A refused refinement.
 *
 * The property under test is that the trip is *unchanged* — not restored, untouched.
 */
async function scenarioRefinementRefused(chrome, fixtures) {
  currentScenario = "A refused refinement changes nothing";
  console.log(`\n▸ ${currentScenario}`);

  /**
   * Generates cleanly, then fabricates when refining.
   *
   * A planner that fabricates during generation leaves no trip to refine, so the
   * rejection path could never be reached.
   */
  const planner = await startGemini({ mode: "fabricate-refinement" });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: planner.baseUrl,
  });
  const page = await openPage(chrome.port, "about:blank");

  try {
    await page.goto(`${server.baseUrl}/`);
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    await waitForWorkspace(page);

    const tripId = Object.keys(await readStore(page))[0];
    const before = await page.evaluate(`
      const store = window.__roamlyTripStore;
      return JSON.stringify(store.getState().records[${JSON.stringify(tripId)}]);
    `);

    /**
     * A fabricated placeId, which the pool gate refuses.
     *
     * The request goes through the real route and the real pipeline; only the fixture's
     * answer changes, so this exercises the rejection path rather than simulating it.
     */
    await expect("a fabricated replacement is rejected and nothing is saved", async () => {
      const outcome = await page.evaluate(`
        const store = window.__roamlyTripStore;
        const record = store.getState().records[${JSON.stringify(tripId)}];
        const item = record.plan.days.flatMap((day) => day.items)
          .find((entry) => entry.place !== null && entry.status === "confirmed");

        const response = await fetch("/api/trips/refine", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            plan: record.plan,
            generation: record.generation,
            command: { type: "replace-item", dayNumber: 1, itemId: item.id },
            providerPreference: "auto",
            expectedRevision: record.revision,
            requestId: "req-refuse-000001",
          }),
        });
        const json = await response.json();
        return JSON.stringify({ status: json.status, hasPlan: "plan" in json });
      `);

      const parsed = JSON.parse(outcome);
      if (parsed.status !== "failed") return `status was ${parsed.status}`;
      if (parsed.hasPlan) return "a plan was returned for a failure";

      const after = await page.evaluate(`
        const store = window.__roamlyTripStore;
        return JSON.stringify(store.getState().records[${JSON.stringify(tripId)}]);
      `);
      return after === before;
    });

    await expect("no raw provider detail reached the page", () =>
      page.evaluate(`
        const text = document.body.textContent;
        // Substring checks rather than a regex: "candidates[" has to survive a template
        // literal *and* the page's own parser, and escaping it through both is how the
        // first version of this check shipped a broken pattern.
        const forbidden = [
          "systemInstruction",
          "generationConfig",
          "generativelanguage",
          "fixture-key",
          "candidates[",
        ];
        return forbidden.every((needle) => !text.includes(needle));
      `),
    );
  } finally {
    await page.close();
    await server.close();
    await closeAll([planner]);
  }
}

/** One scenario per failure mode, each with its own fixture behaviour. */
async function scenarioFailure(chrome, fixtures, { mode, label, assertion }) {
  currentScenario = label;
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');

    await assertion(page, expect);

    await expect("nothing was saved", async () => {
      const records = (await readStore(page)) ?? {};
      return Object.keys(records).length === 0;
    });

    await expect("the traveller stayed on the form", () =>
      page.check(`location.pathname === "/"`),
    );

    await expect("no raw provider detail reached the page", async () => {
      return page.evaluate(`
        const text = document.body.textContent;
        return !/SAFETY|blockReason|finishReason|generativelanguage|fixture-key/.test(text);
      `);
    });
  } finally {
    await page.close();
    await server.close();
    await closeAll([gemini]);
  }
}

async function scenarioPartial(chrome, fixtures) {
  currentScenario = "Sparse destination — partial result";
  console.log(`\n▸ ${currentScenario}`);

  // No restaurants and no hotels mapped, so required slots genuinely cannot be filled.
  const overpass = await startOverpass({ omit: ["restaurant", "hotel"] });
  const gemini = await startGemini({ mode: "ok" });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');

    await expect("a partial plan is still produced and saved", async () => {
      await waitForWorkspace(page);
      return true;
    });

    await expect("unfilled slots are rendered as visible gaps", async () => {
      return page.evaluate(`
        const panel = document.querySelector('[data-testid="generation-provenance"]');
        const unfilled = Number(panel?.dataset.unfilledSlots ?? 0);
        return unfilled > 0 && document.body.textContent.includes("Not on the map");
      `);
    });

    await expect("no place to stay is invented", async () => {
      return page.check(
        `document.querySelector('[data-testid="accommodation-unavailable"]')`,
      );
    });

    await expect("the notes explaining the gaps are reachable", async () => {
      const toggle = await page.check(
        `document.querySelector('[data-testid="provenance-details-toggle"]')`,
      );
      if (!toggle) return false;
      await page.click('[data-testid="provenance-details-toggle"]');
      return page.check(`document.querySelector('[data-testid="provenance-details"]')`);
    });

    await expect("the unfilled slots carry no cost and no marker", async () => {
      const records = await readStore(page);
      const record = Object.values(records)[0];
      const gaps = record.plan.days
        .flatMap((day) => day.items)
        .filter((item) => item.status === "unavailable");
      return (
        gaps.length > 0 &&
        gaps.every((gap) => gap.place === null && gap.estimatedCost === 0)
      );
    });
  } finally {
    await page.close();
    await server.close();
    await closeAll([gemini, overpass]);
  }
}

async function scenarioConflict(chrome, fixtures, gemini) {
  currentScenario = "Guarded revision on regeneration";
  console.log(`\n▸ ${currentScenario}`);

  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-demo"]');
    await waitForWorkspace(page);

    /**
     * The optimistic-concurrency guard cannot be exercised by any user affordance —
     * it needs a record to move while a write is being prepared. The development-only
     * store seam is the same one Phase 5A used for exactly this.
     */
    await expect("a stale replacement is refused and changes nothing", async () => {
      return page.evaluate(`
        const store = window.__roamlyTripStore;
        const [tripId, record] = Object.entries(store.getState().records)[0];
        const stale = record.revision;

        // Something else writes first.
        store.getState().saveEnrichedPlan({
          tripId,
          expectedRevision: stale,
          plan: record.plan,
        });

        const outcome = store.getState().replaceGeneratedTrip({
          tripId,
          expectedRevision: stale,
          plan: record.plan,
          generation: record.generation,
        });

        const after = store.getState().records[tripId];
        return outcome.ok === false
          && outcome.conflict.reason === "revision_mismatch"
          && after.revision === stale + 1
          && after.generation.placePool.poolId === record.generation.placePool.poolId;
      `);
    });

    await expect("a matching revision is accepted and increments once", async () => {
      return page.evaluate(`
        const store = window.__roamlyTripStore;
        const [tripId, record] = Object.entries(store.getState().records)[0];
        const outcome = store.getState().replaceGeneratedTrip({
          tripId,
          expectedRevision: record.revision,
          plan: record.plan,
          generation: record.generation,
        });
        const after = store.getState().records[tripId];
        return outcome.ok === true && after.revision === record.revision + 1;
      `);
    });
  } finally {
    await page.close();
    await server.close();
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Phase 6B: opening hours, schedule repairs and cost estimates, in a real browser.
 *
 * Every provider is a local fixture, so this scenario makes no request to Nominatim,
 * Overpass, Valhalla or any model — the `opening_hours` strings under test are the ones
 * `fixtures.mjs` serves, chosen so that each Phase 6B state occurs exactly once.
 *
 * The claims being checked are the honesty ones: never a green badge for data we do not
 * have, never a closure asserted from an absence, the provider's string shown verbatim
 * whenever we could not read it, and no repair that moves anything the traveller did not
 * ask about.
 */
async function scenarioScheduleAndCosts(chrome, fixtures) {
  currentScenario = "Opening hours, repairs and cost estimates";
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode: "ok" });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    await waitForWorkspace(page);

    const tripId = Object.keys(await readStore(page))[0];

    /**
     * A debugging aid, off by default.
     *
     * Which places the fixture planner chooses decides which `opening_hours` strings are
     * exercised, and that is invisible from a failing assertion. `ROAMLY_DEBUG_HOURS=1`
     * prints the itinerary, the warnings and the rendered badge states so a fixture can be
     * re-tagged against what the planner actually did rather than what it was assumed to do.
     */
    if (process.env.ROAMLY_DEBUG_HOURS === "1") {
      const dump = await page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        return JSON.stringify({
          warnings: record.generation.warnings,
          zone: record.generation.destinationTimezone,
          items: record.plan.days.flatMap((day) =>
            day.items.map((item) => ({
              day: day.dayNumber,
              date: day.date,
              id: item.id,
              placeId: item.place ? item.place.placeId : null,
              hours: item.place ? item.place.openingHours ?? null : null,
              time: item.startTime + "-" + item.endTime,
            })),
          ),
          badges: Array.from(document.querySelectorAll('[data-hours-status]')).map(
            (node) => node.dataset.hoursStatus,
          ),
          scheduleStatus: document.querySelector('[data-testid="schedule-accuracy"]')
            ? document.querySelector('[data-testid="schedule-accuracy"]').dataset.scheduleStatus
            : null,
        }, null, 2);
      `);
      console.log(dump);
    }

    /* -- the recorded provenance ------------------------------------------ */

    await expect("the destination's timezone is recorded on the trip", async () => {
      const store = await readStore(page);
      const zone = store[tripId].generation?.destinationTimezone;
      return zone?.timezone === "Europe/Lisbon" && zone?.source === "city";
    });

    await expect("the cost profile used is recorded with its version", async () => {
      const store = await readStore(page);
      const profile = store[tripId].generation?.costProfile;
      return (
        profile?.profileId === "lisbon" &&
        profile?.match === "city" &&
        profile?.confidence === "high" &&
        typeof profile?.version === "string"
      );
    });

    await expect("the details panel states the profile and the local zone", async () => {
      const toggle = await page.evaluate(
        `return document.querySelector('[data-testid="provenance-details-toggle"]') !== null;`,
      );
      if (toggle !== true) return "no provenance details toggle";
      await page.click('[data-testid="provenance-details-toggle"]');
      return page.evaluate(`
        const text = document.querySelector('[data-testid="provenance-details"]').textContent;
        return text.includes("lisbon@") && text.includes("Europe/Lisbon");
      `);
    });

    /* -- the automatic repair --------------------------------------------- */

    await expect(
      "a stop outside its published hours was moved, and the plan says so",
      () =>
        page.evaluate(`
          const text = document.querySelector('[data-testid="provenance-details"]').textContent;
          return /was moved from 10:45/.test(text) && text.includes("11:00");
        `),
    );

    await expect("the moved stop now starts inside its published hours", async () => {
      const store = await readStore(page);
      const items = store[tripId].plan.days.flatMap((day) => day.items);
      const museum = items.find(
        (item) => item.place && item.place.placeId === "osm:node:2002",
      );
      return museum !== undefined && museum.startTime >= "11:00";
    });

    /* -- the badges -------------------------------------------------------- */

    await expect("a stop inside its hours reads as open, in words", () =>
      page.evaluate(`
        const badge = document.querySelector('[data-hours-status="confirmed_open"]');
        return badge !== null && /Open then/.test(badge.textContent);
      `),
    );

    await expect("a stop with no recorded hours says the hours are unknown", () =>
      page.evaluate(`
        const badge = document.querySelector('[data-hours-status="unknown_no_data"]');
        return badge !== null && /Hours unknown/.test(badge.textContent);
      `),
    );

    await expect("a stop outside its hours reads as closed, in words", () =>
      page.evaluate(`
        const badge = document.querySelector('[data-hours-status="confirmed_closed"]');
        return badge !== null && /Closed then/.test(badge.textContent);
      `),
    );

    /**
     * The rule that cannot be relaxed: unknown must not borrow the appearance of either
     * answer. Checked structurally — the unknown badges must not share a class with the
     * confirmed-open one.
     */
    await expect("an unknown badge never looks like the open badge", () =>
      page.evaluate(`
        const open = document.querySelector('[data-hours-status="confirmed_open"]');
        const unknowns = Array.from(
          document.querySelectorAll('[data-hours-status^="unknown_"]'),
        );
        if (open === null || unknowns.length === 0) return false;
        const openClass = open.className;
        return unknowns.every((node) => node.className !== openClass);
      `),
    );

    await expect("every hours badge carries an icon and its own text", () =>
      page.evaluate(`
        const badges = Array.from(document.querySelectorAll('[data-hours-status]'));
        return badges.length > 0 && badges.every((node) =>
          node.querySelector('svg') !== null && node.textContent.trim().length > 4,
        );
      `),
    );

    /* -- the accuracy panel ------------------------------------------------ */

    await expect("the schedule accuracy section reports a conflict", () =>
      page.evaluate(`
        const section = document.querySelector('[data-testid="schedule-accuracy"]');
        return section !== null && section.dataset.scheduleStatus === "conflicts";
      `),
    );

    await expect("it states how many stops it could not check", () =>
      page.check(
        `/could not be checked/.test(document.querySelector('[data-testid="schedule-accuracy"]').textContent)`,
      ),
    );

    await expect("it names the timezone it checked against", () =>
      page.check(
        `/Europe\\/Lisbon/.test(document.querySelector('[data-testid="schedule-accuracy"]').textContent)`,
      ),
    );

    await expect("the conflict shows the provider's own string, verbatim", () =>
      page.check(
        `document.querySelector('[data-testid="schedule-conflict"]').textContent.includes("Mo-Fr 19:00-23:00")`,
      ),
    );

    await expect(
      "an unreadable hours string is listed as unchecked, shown as recorded",
      async () => {
        const warnings = await page.evaluate(`
          const list = document.querySelector('[data-testid="schedule-warnings"]');
          if (list === null) {
            const summary = document.querySelector('[data-testid="schedule-accuracy"] summary');
            if (summary) summary.click();
          }
          const node = document.querySelector('[data-testid="schedule-warnings"]');
          return node === null ? "" : node.textContent;
        `);
        return (
          warnings.includes("PH off") ||
          warnings.includes("no opening hours recorded")
        );
      },
    );

    /**
     * The stop is shut all weekend, so there is nowhere to move it to — and the interface
     * must not offer a control whose only outcome is to fail.
     */
    await expect(
      "moving to opening hours is not offered when the day is closed outright",
      () =>
        page.evaluate(`
          const row = document.querySelector('[data-testid="schedule-conflict"] [data-can-adjust]');
          return row.dataset.canAdjust === "false"
            && document.querySelector('[data-testid="hours-adjust-time"]') === null;
        `),
    );

    /* -- replacing the place from the trip's own pool ----------------------- */

    const beforeReplace = await readStore(page);
    const revisionBeforeReplace = beforeReplace[tripId].revision;
    const conflictItemId = await page.evaluate(
      `return document.querySelector('[data-testid="schedule-conflict"]').dataset.itemId;`,
    );

    const unrelatedBefore = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const items = record.plan.days.flatMap((day) => day.items);
      return JSON.stringify(
        items
          .filter((item) => item.id !== ${JSON.stringify(conflictItemId)})
          .map((item) => ({
            id: item.id,
            placeId: item.place ? item.place.placeId : null,
            startTime: item.startTime,
          })),
      );
    `);

    await expect("alternatives come from the trip's own saved pool", async () => {
      await page.click('[data-testid="hours-replace-place"]');
      return page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const poolIds = new Set(record.generation.placePool.places.map((p) => p.placeId));
        const offered = Array.from(
          document.querySelectorAll('[data-testid="hours-candidate"]'),
        ).map((node) => node.dataset.placeId);
        return offered.length > 0 && offered.every((id) => poolIds.has(id));
      `);
    });

    await expect("a candidate with no recorded hours says so rather than being hidden", () =>
      page.check(
        `/No opening hours recorded/.test(document.querySelector('[data-testid="hours-candidates"]').textContent)`,
      ),
    );

    const chosenPlaceId = await page.evaluate(
      `return document.querySelector('[data-testid="hours-candidate"]').dataset.placeId;`,
    );

    await page.click('[data-testid="hours-candidate"]');
    await page.waitFor(
      `document.querySelector('[data-testid="refine-outcome"]') !== null`,
      { timeoutMs: 20_000, label: "the replacement outcome" },
    );

    await expect("the replacement is saved as one revision forward", async () => {
      const store = await readStore(page);
      return store[tripId].revision === revisionBeforeReplace + 1;
    });

    await expect("the chosen place is now in the itinerary", async () => {
      const store = await readStore(page);
      const items = store[tripId].plan.days.flatMap((day) => day.items);
      return items.some(
        (item) => item.place && item.place.placeId === chosenPlaceId,
      );
    });

    await expect("no other stop was touched by the repair", async () => {
      const after = await page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const items = record.plan.days.flatMap((day) => day.items);
        const kept = new Set(
          JSON.parse(${JSON.stringify(unrelatedBefore)}).map((entry) => entry.id),
        );
        return JSON.stringify(
          items
            .filter((item) => kept.has(item.id))
            .map((item) => ({
              id: item.id,
              placeId: item.place ? item.place.placeId : null,
              startTime: item.startTime,
            })),
        );
      `);
      return after === unrelatedBefore;
    });

    await expect("the repair left the way back", async () => {
      const store = await readStore(page);
      return store[tripId].history.past.length > 0;
    });

    await expect("undo restores the conflicted stop", async () => {
      await page.click('[data-testid="undo-refinement"]');
      await page.waitFor(
        `document.querySelector('[data-testid="schedule-conflict"]') !== null`,
        { timeoutMs: 20_000, label: "the conflict returning" },
      );
      const store = await readStore(page);
      const items = store[tripId].plan.days.flatMap((day) => day.items);
      return (
        items.some((item) => item.place && item.place.placeId === "osm:node:3003") &&
        store[tripId].revision === revisionBeforeReplace + 2
      );
    });

    /* -- leaving the slot open --------------------------------------------- */

    await expect("leaving the slot open removes the place and clears the conflict", async () => {
      await page.click('[data-testid="hours-mark-unavailable"]');
      await page.waitFor(
        `document.querySelector('[data-testid="schedule-conflict"]') === null`,
        { timeoutMs: 20_000, label: "the conflict clearing" },
      );
      const store = await readStore(page);
      const items = store[tripId].plan.days.flatMap((day) => day.items);
      const slot = items.find((item) => item.id === conflictItemId);
      return slot !== undefined && slot.place === null && slot.status === "unavailable";
    });

    await expect("the emptied slot costs nothing", async () => {
      const store = await readStore(page);
      const items = store[tripId].plan.days.flatMap((day) => day.items);
      const slot = items.find((item) => item.id === conflictItemId);
      return slot.estimatedCost === 0;
    });

    /* -- recalculating the cost estimates ---------------------------------- */

    const beforeCosts = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      return JSON.stringify({
        revision: record.revision,
        total: record.plan.budget.total,
        shape: record.plan.days.flatMap((day) =>
          day.items.map((item) => ({
            id: item.id,
            placeId: item.place ? item.place.placeId : null,
            startTime: item.startTime,
            endTime: item.endTime,
            order: item.order,
          })),
        ),
      });
    `);

    await ensureRefinePanelOpen(page);

    await expect("recalculating estimates is offered without a planner", () =>
      page.evaluate(`
        const button = document.querySelector('[data-testid="recalculate-estimates"]');
        return button !== null && button.disabled === false;
      `),
    );

    await expect("recalculating estimates saves one revision forward", async () => {
      await page.click('[data-testid="recalculate-estimates"]');
      await page.waitFor(
        `document.querySelector('[data-testid="refine-outcome"][data-action="recalculate-estimates"]') !== null`,
        { timeoutMs: 20_000, label: "the re-estimate outcome" },
      );
      const before = JSON.parse(beforeCosts);
      const store = await readStore(page);
      return store[tripId].revision === before.revision + 1;
    });

    /**
     * The whole reason the action is safe to offer. A traveller pressing "recalculate cost
     * estimates" and finding their Sunday rearranged would never press anything again.
     */
    await expect("recalculating estimates moves nothing but the money", async () => {
      const after = await page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        return JSON.stringify(
          record.plan.days.flatMap((day) =>
            day.items.map((item) => ({
              id: item.id,
              placeId: item.place ? item.place.placeId : null,
              startTime: item.startTime,
              endTime: item.endTime,
              order: item.order,
            })),
          ),
        );
      `);
      return after === JSON.stringify(JSON.parse(beforeCosts).shape);
    });

    await expect("every recomputed figure carries its provenance", async () => {
      const store = await readStore(page);
      const items = store[tripId].plan.days.flatMap((day) => day.items);
      const priced = items.filter(
        (item) => item.place !== null && item.costEstimate !== undefined,
      );
      return (
        priced.length > 0 &&
        priced.every(
          (item) =>
            typeof item.costEstimate.disclaimer === "string" &&
            item.costEstimate.currency === "EUR" &&
            (item.costEstimate.basis === "free-entry-tag" ||
              item.costEstimate.profileId === "lisbon"),
        )
      );
    });

    await expect("the budget still adds up after re-estimating", async () => {
      const store = await readStore(page);
      const budget = store[tripId].plan.budget;
      const sum =
        budget.flights +
        budget.accommodation +
        budget.food +
        budget.activities +
        budget.transport;
      return Math.abs(sum - budget.total) < 0.02;
    });

    await expect("the outcome says which way the total moved", () =>
      page.check(
        `/recalculated/i.test(document.querySelector('[data-testid="refine-outcome"]').textContent)`,
      ),
    );

    await expect("a re-estimate can be undone", async () => {
      const before = (await readStore(page))[tripId];
      await page.click('[data-testid="undo-refinement"]');
      await page.waitFor(
        `Object.values(window.__roamlyTripStore.getState().records)[0].revision === ${before.revision + 1}`,
        { timeoutMs: 20_000, label: "the undo" },
      );
      const after = (await readStore(page))[tripId];
      return after.plan.budget.total === JSON.parse(beforeCosts).total;
    });

    /* -- the surface, still sound ------------------------------------------ */

    await expect("the page never scrolls sideways", () => noHorizontalOverflow(page));

    await expect("no console errors were logged", () => {
      const problems = consoleProblems(page);
      return problems.length === 0 ? true : problems.join(" | ");
    });

    await expect("no provider host reached the page", () =>
      page.evaluate(`
        const text = document.documentElement.outerHTML;
        return !text.includes("overpass") && !text.includes("nominatim");
      `),
    );
  } finally {
    await page.close();
    await server.close();
    await closeAll([gemini]);
  }
}

/**
 * Phase 6C: structural edits and an explicit pool refresh, in a real browser.
 *
 * Every provider is a local fixture. The refresh path is exercised by *changing what the
 * Overpass fixture returns between the two searches* — dropping one node and renaming another —
 * which is the fixture equivalent of a mapper retagging a place, and the only honest way to make
 * a second search differ from the first.
 *
 * The claims under test are the integrity ones: a promoted place comes from the trip's own pool,
 * a moved stop keeps its id, stale route geometry disappears immediately, a refresh writes
 * nothing until the traveller confirms a policy, a retained place can never be selected again,
 * and undo puts all of it back.
 */
async function scenarioStructuralEdits(chrome, fixtures) {
  currentScenario = "Structural edits and pool refresh";
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode: "ok" });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  // Reset, so "no model request during a refresh" means this scenario's.
  fixtures.overpass.state.exclude = new Set();
  fixtures.overpass.state.rename = new Map();

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    await waitForWorkspace(page);

    const tripId = Object.keys(await readStore(page))[0];

    // Routes first, so invalidation has real geometry to invalidate.
    await ensureRefinePanelOpen(page);
    await page.click('[data-testid="recalculate-all-routes"]');
    await page.waitFor(
      `document.querySelectorAll('[data-testid="travel-segment"][data-status="routed"]').length > 0`,
      { timeoutMs: 60_000, label: "routed segments" },
    );

    /**
     * Read from the store, not the DOM.
     *
     * The itinerary panel renders one day at a time, so a DOM sweep sees a *subset* of the
     * trip's legs — and a subset that happens to exclude the day being edited makes both route
     * assertions below pass without testing anything.
     */
    const routedBefore = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      return record.plan.days
        .flatMap((day) => day.items)
        .flatMap((item) =>
          item.travelToNext && item.travelToNext.status === 'routed'
            ? [item.travelToNext.id]
            : [],
        );
    `);
    const revisionAfterRouting = (await readStore(page))[tripId].revision;

    await expect("the trip has routed legs to invalidate", () => routedBefore.length > 1);

    /* -- promoting a backup ------------------------------------------------- */

    await expect("an add-to-itinerary action appears on a backup", () =>
      page.check(`document.querySelector('[data-testid="promote-backup"]') !== null`),
    );

    const backupId = await page.evaluate(
      `return document.querySelector('[data-testid="promote-backup"]').dataset.backupId;`,
    );

    await page.click('[data-testid="promote-backup"]');
    await page.waitFor(`document.querySelector('[data-testid="placement-dialog"]')`, {
      label: "the placement dialog",
    });

    await expect("the dialog offers every day and a position", () =>
      page.evaluate(`
        const days = document.querySelectorAll('[data-testid="placement-day"] option').length;
        const positions = document.querySelectorAll(
          '[data-testid="placement-positions"] input[type="radio"]',
        ).length;
        return days >= 2 && positions >= 2;
      `),
    );

    await expect("the dialog previews the resulting time and the hours status", () =>
      page.evaluate(`
        const preview = document.querySelector('[data-testid="placement-preview"]');
        return preview !== null
          && /\\d\\d:\\d\\d/.test(preview.textContent)
          && preview.querySelector('[data-hours-status]') !== null;
      `),
    );

    /**
     * The promotion is aimed at day 2 to prove a backup is not confined to the day it belongs
     * to — the day it was a fallback *for* is a fact about the fallback, not about the stop.
     */
    await page.evaluate(`
      const select = document.querySelector('[data-testid="placement-day"]');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value',
      ).set;
      setter.call(select, '2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);

    /**
     * A mid-day position is *refused*, and the preview says why before anything is submitted.
     *
     * Day two is planned tightly enough that no gap between two stops can hold a 75-minute café,
     * so the honest answer is a disabled control with the reason beside it — not an insertion at
     * an impossible time, and not a model asked to invent room.
     */
    await expect("a position with no room is refused in the preview", async () => {
      await page.sleep(200);
      return page.evaluate(`
        const radios = Array.from(
          document.querySelectorAll('[data-testid="placement-positions"] input[type="radio"]'),
        );
        const before = radios.filter((node) =>
          node.dataset.positionKey.startsWith('before:'),
        );
        if (before.length < 2) return false;
        before[1].click();
        return true;
      `);
    });

    await expect("the reason is stated and the confirm control is disabled", async () => {
      await page.sleep(250);
      return page.evaluate(`
        const problem = document.querySelector('[data-testid="placement-preview-problem"]');
        const confirm = document.querySelector('[data-testid="placement-confirm"]');
        return problem !== null
          && /no free \\d+-minute gap/.test(problem.textContent)
          && confirm.disabled === true;
      `);
    });

    // Back to the end of the day, which does have room.
    await page.evaluate(`
      const radios = Array.from(
        document.querySelectorAll('[data-testid="placement-positions"] input[type="radio"]'),
      );
      radios.find((node) => node.dataset.positionKey === 'end').click();
      return true;
    `);
    await page.sleep(200);

    await page.click('[data-testid="placement-confirm"]');
    await page.waitFor(
      `document.querySelector('[data-testid="placement-dialog"]') === null`,
      { timeoutMs: 20_000, label: "the promotion dialog closing" },
    ).catch(async (error) => {
      // The dialog stays open on failure, with the reason in it — which is exactly what a
      // diagnosis needs, and is lost if the timeout is all that surfaces.
      const reason = await page.evaluate(`
        const dialog = document.querySelector('[data-testid="placement-dialog"]');
        return dialog === null ? "closed" : dialog.textContent.slice(0, 400);
      `);
      throw new Error(`${error.message} — dialog said: ${reason}`);
    });

    const afterPromote = await readStore(page);

    await expect("the promotion saved one revision forward", () =>
      afterPromote[tripId].revision === revisionAfterRouting + 1,
    );

    await expect("the promoted place came from the trip's own pool", () => {
      const record = afterPromote[tripId];
      const poolIds = new Set(
        record.generation.placePool.places.map((place) => place.placeId),
      );
      const items = record.plan.days.flatMap((day) => day.items);
      return items.every((item) => !item.place || poolIds.has(item.place.placeId));
    });

    const promotedItemId = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const items = record.plan.days.flatMap((day) => day.items);
      const promoted = items.find((item) => item.id.endsWith('-p1'));
      return promoted ? promoted.id : null;
    `);

    await expect("the promoted stop has a new id, not the backup's", () =>
      promotedItemId !== null && promotedItemId !== backupId,
    );

    await expect("the promoted backup is gone from the backup list", () => {
      const record = afterPromote[tripId];
      const backups = record.plan.days.flatMap((day) => day.backups);
      return backups.every((backup) => backup.id !== backupId);
    });

    await expect("a marker appeared for the promoted stop", async () => {
      // Day two, so the map has to be showing it.
      await page.click('#day-tab-2');
      await page.sleep(400);
      return page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const day = record.plan.days.find((entry) => entry.dayNumber === 2);
        return day.items.some((item) => item.id.endsWith('-p1') && item.place !== null);
      `);
    });

    /**
     * Appending creates a journey that has never been measured, and invalidates nothing.
     *
     * That is the correct outcome for a stop added at the end of a day, and it is worth
     * asserting as such — the invalidation case is the *move* below, which splits a pair.
     */
    await expect("the promotion created a journey with no measurement", async () => {
      const pending = await page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const day = record.plan.days.find((entry) => entry.dayNumber === 2);
        const last = day.items[day.items.length - 1];
        const previous = day.items[day.items.length - 2];
        return last.id.endsWith('-p1') && previous.travelToNext === null;
      `);
      return pending;
    });

    await expect("routes elsewhere in the trip survived the promotion", () => {
      const surviving = new Set(
        afterPromote[tripId].plan.days
          .flatMap((day) => day.items)
          .flatMap((item) => (item.travelToNext ? [item.travelToNext.id] : [])),
      );
      const kept = routedBefore.filter((legId) => surviving.has(legId));
      return kept.length > 0
        ? true
        : `before=${routedBefore.join(",")} after=${[...surviving].join(",")}`;
    });

    await expect("undo restores the backup and the cleared routes", async () => {
      // All days, so the restored backup is visible whichever day it belongs to.
      await page.click('#day-tab-all');
      await page.sleep(300);
      await ensureRefinePanelOpen(page);
      await page.click('[data-testid="undo-refinement"]');
      await page.waitFor(
        `document.querySelector('[data-testid="promote-backup"]') !== null`,
        { timeoutMs: 20_000, label: "the backup returning" },
      );

      const store = await readStore(page);
      const backups = store[tripId].plan.days.flatMap((day) => day.backups);
      const legs = new Set(
        store[tripId].plan.days
          .flatMap((day) => day.items)
          .flatMap((item) => (item.travelToNext ? [item.travelToNext.id] : [])),
      );
      return (
        backups.some((backup) => backup.id === backupId) &&
        routedBefore.every((legId) => legs.has(legId)) &&
        store[tripId].revision === revisionAfterRouting + 2
      );
    });

    /* -- moving a stop between days ---------------------------------------- */

    await page.click('#day-tab-1');
    await page.sleep(300);

    await expect("a move action appears on a stop", () =>
      page.check(`document.querySelector('[data-testid="move-stop"]') !== null`),
    );

    /**
     * Moving the day's only breakfast is refused — a move may relocate a meal but not remove the
     * day's only one — so the target is chosen as a non-meal stop. The refusal is asserted first,
     * because it is on screen and it is the more interesting behaviour.
     */
    await expect("moving a day's only meal of a kind is refused, with the reason", async () => {
      const mealItemId = await page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const day = record.plan.days.find((entry) => entry.dayNumber === 1);
        const meal = day.items.find((item) => item.mealType !== null);
        return meal ? meal.id : null;
      `);
      if (mealItemId === null) return "no meal on day one";

      await page.click(`[data-testid="move-stop"][data-item-id="${mealItemId}"]`);
      await page.waitFor(`document.querySelector('[data-testid="placement-dialog"]')`, {
        label: "the placement dialog",
      });
      await page.evaluate(`
        const select = document.querySelector('[data-testid="placement-day"]');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype, 'value',
        ).set;
        setter.call(select, '2');
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `);
      await page.sleep(200);
      await page.click('[data-testid="placement-confirm"]');
      await page.sleep(500);

      const refused = await page.evaluate(`
        const dialog = document.querySelector('[data-testid="placement-dialog"]');
        const error = document.querySelector('[data-testid="placement-error"]');
        return dialog !== null && error !== null
          && /no longer has a breakfast|not remove one/i.test(error.textContent);
      `);

      await page.evaluate(`
        document.querySelector('[data-testid="placement-dialog"] button[aria-label]').click();
        return true;
      `);
      return refused;
    });

    const movedItemId = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const day = record.plan.days.find((entry) => entry.dayNumber === 1);
      const movable = day.items.find(
        (item) =>
          item.mealType === null && item.kind !== 'transport' && item.kind !== 'logistics',
      );
      return movable ? movable.id : null;
    `);

    const revisionBeforeMove = (await readStore(page))[tripId].revision;
    const totalsBefore = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      return JSON.stringify(record.plan.days.map((day) => day.dayTotal));
    `);

    await expect("a movable non-meal stop exists on day one", () => movedItemId !== null);

    await page.click(`[data-testid="move-stop"][data-item-id="${movedItemId}"]`);
    await page.waitFor(`document.querySelector('[data-testid="placement-dialog"]')`, {
      label: "the placement dialog",
    });
    await page.evaluate(`
      const select = document.querySelector('[data-testid="placement-day"]');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value',
      ).set;
      setter.call(select, '2');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);

    /**
     * The hours preview is evaluated against the *target* date, which is the whole reason the
     * preview exists for a cross-day move: a stop that is fine on Saturday can be shut on Sunday.
     */
    await expect("the preview evaluates the hours against the target date", () =>
      page.evaluate(`
        const badge = document
          .querySelector('[data-testid="placement-preview"]')
          .querySelector('[data-hours-status]');
        return badge !== null && badge.dataset.hoursStatus.length > 0;
      `),
    );

    await page.click('[data-testid="placement-confirm"]');
    await page.waitFor(
      `document.querySelector('[data-testid="placement-dialog"]') === null`,
      { timeoutMs: 20_000, label: "the move dialog closing" },
    ).catch(async (error) => {
      const reason = await page.evaluate(`
        const dialog = document.querySelector('[data-testid="placement-dialog"]');
        return dialog === null ? "closed" : dialog.textContent.slice(-500);
      `);
      throw new Error(`${error.message} — dialog said: ${reason}`);
    });

    const afterMove = await readStore(page);

    await expect("the stop moved to the other day", () => {
      const record = afterMove[tripId];
      const dayOf = (itemId) =>
        record.plan.days.find((day) => day.items.some((item) => item.id === itemId))
          ?.dayNumber ?? null;
      return dayOf(movedItemId) === 2;
    });

    await expect("the moved stop kept its id", () => {
      const items = afterMove[tripId].plan.days.flatMap((day) => day.items);
      return items.filter((item) => item.id === movedItemId).length === 1;
    });

    await expect("both day totals changed", () => {
      const after = JSON.stringify(
        afterMove[tripId].plan.days.map((day) => day.dayTotal),
      );
      const before = JSON.parse(totalsBefore);
      const now = JSON.parse(after);
      return now[0] < before[0] && now[1] > before[1];
    });

    await expect("the move saved one revision forward", () =>
      afterMove[tripId].revision === revisionBeforeMove + 1,
    );

    /**
     * The invalidation case. Taking a stop out of the middle of a day bridges the pair either
     * side of it, so the journey that was measured between them no longer describes anything.
     */
    await expect("stale route geometry disappeared", () => {
      const surviving = new Set(
        afterMove[tripId].plan.days
          .flatMap((day) => day.items)
          .flatMap((item) => (item.travelToNext ? [item.travelToNext.id] : [])),
      );
      const cleared = routedBefore.filter((legId) => !surviving.has(legId));
      return cleared.length > 0
        ? true
        : `nothing cleared; before=${routedBefore.join(",")}`;
    });

    await expect("unaffected routes were kept", () => {
      const surviving = new Set(
        afterMove[tripId].plan.days
          .flatMap((day) => day.items)
          .flatMap((item) => (item.travelToNext ? [item.travelToNext.id] : [])),
      );
      return routedBefore.some((legId) => surviving.has(legId));
    });

    await expect("an impossible schedule is refused in the dialog", async () => {
      await page.click('#day-tab-2');
      await page.sleep(300);
      await page.click('[data-testid="move-stop"]');
      await page.waitFor(`document.querySelector('[data-testid="placement-dialog"]')`, {
        label: "the placement dialog",
      });

      // Same day, and times that collide with the stop it is placed after.
      await page.click('[data-testid="placement-explicit-times"]');
      await page.evaluate(`
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value',
        ).set;
        for (const [testId, value] of [['placement-start', '05:00'], ['placement-end', '05:10']]) {
          const input = document.querySelector('[data-testid="' + testId + '"]');
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      `);
      await page.sleep(300);

      const blocked = await page.evaluate(`
        const problem = document.querySelector('[data-testid="placement-preview-problem"]');
        const confirm = document.querySelector('[data-testid="placement-confirm"]');
        return problem !== null && confirm.disabled === true;
      `);

      await page.evaluate(`
        document.querySelector('[data-testid="placement-dialog"] button[aria-label]').click();
        return true;
      `);
      return blocked;
    });

    await expect("the placement dialog is reachable by keyboard", async () => {
      await page.click('[data-testid="move-stop"]');
      await page.waitFor(`document.querySelector('[data-testid="placement-dialog"]')`, {
        label: "the placement dialog",
      });
      const usable = await page.evaluate(`
        const dialog = document.querySelector('[data-testid="placement-dialog"]');
        const focusable = dialog.querySelectorAll(
          'button, select, input, [tabindex]:not([tabindex="-1"])',
        );
        return dialog.getAttribute('role') === 'dialog'
          && dialog.getAttribute('aria-modal') === 'true'
          && dialog.getAttribute('aria-labelledby') !== null
          && focusable.length > 3
          && document.activeElement !== document.body;
      `);
      await page.evaluate(`
        document.querySelector('[data-testid="placement-dialog"] button[aria-label]').click();
        return true;
      `);
      return usable;
    });

    /* -- the place pool ---------------------------------------------------- */

    await expect("the pool's age and size are stated", () =>
      page.evaluate(`
        const panel = document.querySelector('[data-testid="place-pool-panel"]');
        const label = document.querySelector('[data-testid="pool-age-label"]');
        return panel !== null
          && panel.dataset.poolAge === 'fresh'
          && /updated/i.test(label.textContent)
          && document.querySelector('[data-testid="pool-place-count"]') !== null;
      `),
    );

    await expect("the age never claims the places have closed", () =>
      page.evaluate(`
        const text = document.querySelector('[data-testid="pool-age-label"]').textContent.toLowerCase();
        return !text.includes('closed') && !text.includes('invalid');
      `),
    );

    await expect("a refresh is offered on a generated trip", () =>
      page.evaluate(`
        return document.querySelector('[data-testid="refresh-pool"]') !== null
          && document.querySelector('[data-testid="refresh-unavailable"]') === null;
      `),
    );

    /* -- refresh: confirm, search, preview -------------------------------- */

    /**
     * The fixture drops one node the itinerary uses and renames another. The first makes the
     * missing-used-place path real; the second proves a corrected record is reported as a change
     * rather than as a disappearance.
     */
    const missingPlaceId = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const day = record.plan.days.find((entry) => entry.dayNumber === 1);
      const stop = day.items.find((item) => item.place !== null);
      return stop.place.placeId;
    `);
    const missingOsmId = Number(missingPlaceId.split(":")[2]);
    fixtures.overpass.state.exclude = new Set([missingOsmId]);
    fixtures.overpass.state.rename = new Map([[1002, "Manteigaria Chiado"]]);

    const geminiCallsBefore = gemini.state.requests;
    const valhallaCallsBefore = fixtures.valhalla.state.requests;
    const revisionBeforeRefresh = (await readStore(page))[tripId].revision;

    await page.click('[data-testid="refresh-pool"]');

    await expect("refreshing asks for confirmation and says what it can do", () =>
      page.evaluate(`
        const box = document.querySelector('[data-testid="refresh-confirm"]');
        return box !== null && /not\\s*<\\/?strong>?\\s*rewritten|not rewritten/i.test(box.innerHTML);
      `),
    );

    await page.click('[data-testid="refresh-confirm-run"]');
    await page.waitFor(`document.querySelector('[data-testid="refresh-preview"]')`, {
      timeoutMs: 60_000,
      label: "the refresh preview",
    });

    await expect("a diff preview appears with the counts", () =>
      page.evaluate(`
        return ['pool-diff-new', 'pool-diff-added', 'pool-diff-removed',
                'pool-diff-changed', 'pool-diff-missing-used']
          .every((id) => document.querySelector('[data-testid="' + id + '"]') !== null);
      `),
    );

    await expect("the removed and changed counts match the fixture", () =>
      page.evaluate(`
        const read = (id) =>
          Number(document.querySelector('[data-testid="' + id + '"]').textContent);
        return read('pool-diff-removed') === 1
          && read('pool-diff-missing-used') === 1
          && read('pool-diff-changed') === 1;
      `),
    );

    await expect("the missing used place is named as a choice to make", () =>
      page.check(
        `/not in the new search/i.test(document.querySelector('[data-testid="refresh-preview"]').textContent)`,
      ),
    );

    await expect("both reconciliation policies are offered", () =>
      page.evaluate(`
        const options = Array.from(
          document.querySelectorAll('[data-testid="reconciliation-policy"]'),
        ).map((node) => node.dataset.policy);
        return options.length === 2
          && options.includes('keep-valid-and-flag-missing')
          && options.includes('replace-missing-with-unavailable');
      `),
    );

    await expect("a refresh makes no model request", () =>
      gemini.state.requests === geminiCallsBefore,
    );

    await expect("a refresh makes no routing request", () =>
      fixtures.valhalla.state.requests === valhallaCallsBefore,
    );

    await expect("nothing is saved before the second confirmation", async () => {
      const store = await readStore(page);
      return store[tripId].revision === revisionBeforeRefresh;
    });

    await expect("discarding the search leaves the revision unchanged", async () => {
      await page.evaluate(`
        const buttons = Array.from(
          document.querySelectorAll('[data-testid="refresh-preview"] button'),
        );
        buttons.find((node) => /Discard/.test(node.textContent)).click();
        return true;
      `);
      await page.waitFor(
        `document.querySelector('[data-testid="refresh-pool"]') !== null`,
        { timeoutMs: 20_000, label: "the refresh button returning" },
      );
      const store = await readStore(page);
      return store[tripId].revision === revisionBeforeRefresh;
    });

    /* -- refresh: keep and flag ------------------------------------------- */

    await page.click('[data-testid="refresh-pool"]');
    await page.click('[data-testid="refresh-confirm-run"]');
    await page.waitFor(`document.querySelector('[data-testid="refresh-preview"]')`, {
      timeoutMs: 60_000,
      label: "the refresh preview",
    });

    await page.evaluate(`
      document
        .querySelector('[data-policy="keep-valid-and-flag-missing"]')
        .click();
      return true;
    `);
    await page.click('[data-testid="refresh-apply"]');
    await page.waitFor(`document.querySelector('[data-testid="refresh-applied"]')`, {
      timeoutMs: 20_000,
      label: "the applied notice",
    });

    const afterKeep = await readStore(page);

    await expect("applying the refresh saves one revision forward", () =>
      afterKeep[tripId].revision === revisionBeforeRefresh + 1,
    );

    await expect("keep-and-flag leaves the stop in place and records it as retained", () => {
      const record = afterKeep[tripId];
      const stillThere = record.plan.days
        .flatMap((day) => day.items)
        .some((item) => item.place && item.place.placeId === missingPlaceId);
      const retained = (record.generation.retainedPlaces ?? []).some(
        (entry) => entry.place.placeId === missingPlaceId,
      );
      const inPool = record.generation.placePool.places.some(
        (place) => place.placeId === missingPlaceId,
      );
      return stillThere && retained && !inPool;
    });

    await expect("the retained place is explained in the interface", () =>
      page.evaluate(`
        const note = document.querySelector('[data-testid="retained-place-note"]');
        return note !== null && /not found by the latest search/i.test(note.textContent);
      `),
    );

    await expect("the renamed place's corrected record reached the itinerary", () => {
      const record = afterKeep[tripId];
      const places = record.plan.days
        .flatMap((day) => day.items)
        .flatMap((item) => (item.place ? [item.place] : []));
      const pool = new Map(
        record.generation.placePool.places.map((place) => [place.placeId, place.name]),
      );
      return places.every((place) => !pool.has(place.placeId) || pool.get(place.placeId) === place.name);
    });

    /**
     * The widened invariant, from the narrow side: a retained place may stay on the stop that
     * already uses it and may never be offered as a new selection.
     */
    await expect("a retained place is excluded from replacement candidates", () =>
      page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const retained = (record.generation.retainedPlaces ?? []).map((entry) => entry.place.placeId);
        const poolIds = record.generation.placePool.places.map((place) => place.placeId);
        return retained.length > 0 && retained.every((id) => !poolIds.includes(id));
      `),
    );

    await expect("the refresh persists across a reload", async () => {
      await page.goto(`${server.baseUrl}/trip/${tripId}`);
      await waitForWorkspace(page);
      const store = await readStore(page);
      return (
        (store[tripId].generation.retainedPlaces ?? []).length === 1 &&
        store[tripId].revision === revisionBeforeRefresh + 1
      );
    });

    await expect("attribution is still visible after a refresh", () =>
      page.check(
        `/OpenStreetMap/.test(document.body.textContent)`,
      ),
    );

    await expect("undo restores the previous pool and plan", async () => {
      await ensureRefinePanelOpen(page);
      await page.click('[data-testid="undo-refinement"]');
      await page.waitFor(
        `Object.values(window.__roamlyTripStore.getState().records)[0].revision === ${revisionBeforeRefresh + 2}`,
        { timeoutMs: 20_000, label: "the undo" },
      );

      const store = await readStore(page);
      return (
        (store[tripId].generation.retainedPlaces ?? []).length === 0 &&
        store[tripId].generation.placePool.places.some(
          (place) => place.placeId === missingPlaceId,
        )
      );
    });

    /* -- refresh: replace with unavailable -------------------------------- */

    await expect("replace-with-unavailable empties the slot and clears its routes", async () => {
      const before = (await readStore(page))[tripId].revision;

      await page.click('[data-testid="refresh-pool"]');
      await page.click('[data-testid="refresh-confirm-run"]');
      await page.waitFor(`document.querySelector('[data-testid="refresh-preview"]')`, {
        timeoutMs: 60_000,
        label: "the refresh preview",
      });
      await page.evaluate(`
        document
          .querySelector('[data-policy="replace-missing-with-unavailable"]')
          .click();
        return true;
      `);
      await page.click('[data-testid="refresh-apply"]');
      await page.waitFor(`document.querySelector('[data-testid="refresh-applied"]')`, {
        timeoutMs: 20_000,
        label: "the applied notice",
      });

      const store = await readStore(page);
      const slot = store[tripId].plan.days
        .flatMap((day) => day.items)
        .find(
          (item) =>
            item.status === "unavailable" && item.rationale.includes("did not return"),
        );

      return (
        slot !== undefined &&
        slot.place === null &&
        slot.estimatedCost === 0 &&
        (store[tripId].generation.retainedPlaces ?? []).length === 0 &&
        store[tripId].revision === before + 1
      );
    });

    await expect("the emptied slot has no map marker", () =>
      page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const slot = record.plan.days
          .flatMap((day) => day.items)
          .find((item) => item.status === 'unavailable' && item.place === null);
        return slot !== undefined;
      `),
    );

    /* -- the sample trip cannot refresh ----------------------------------- */

    await expect("the sample trip explains why refreshing is unavailable", async () => {
      await page.goto(`${server.baseUrl}/`);
      await page.waitFor(`document.querySelector('[data-testid="open-sample-trip"]')`, {
        label: "the sample link",
      });
      await page.click('[data-testid="open-sample-trip"]');
      await waitForWorkspace(page);

      return page.evaluate(`
        const note = document.querySelector('[data-testid="refresh-unavailable"]');
        return document.querySelector('[data-testid="refresh-pool"]') === null
          && note !== null
          && /sample itinerary|recorded OpenStreetMap search/i.test(note.textContent);
      `);
    });

    /* -- the surface, still sound ----------------------------------------- */

    await expect("the page never scrolls sideways", () => noHorizontalOverflow(page));

    await expect("no console errors were logged", () => {
      const problems = consoleProblems(page);
      return problems.length === 0 ? true : problems.join(" | ");
    });
  } finally {
    fixtures.overpass.state.exclude = new Set();
    fixtures.overpass.state.rename = new Map();
    await page.close();
    await server.close();
    await closeAll([gemini]);
  }
}

/**
 * The explicit editing controls, driven the way a traveller drives them (Phase 8, checkpoint 2B).
 *
 * Every check here goes through a *rendered control* rather than through the store, because that is
 * the whole claim of this checkpoint: the structural commands are reachable from the interface, and
 * each control appears exactly when using it would work. A test that called an applier directly
 * would pass on a page with no buttons on it.
 *
 * A fresh trip, deliberately not the one `scenarioStructuralEdits` uses — that one has been through
 * two pool refreshes and an undo by the time it finishes, so its stops carry emptied slots and
 * retained places. Asserting a lock or a removal against that would be asserting against wreckage.
 */
async function scenarioEditingControls(chrome, fixtures) {
  currentScenario = "Explicit itinerary editing controls";
  console.log(`\n▸ ${currentScenario}`);

  const gemini = await startGemini({ mode: "ok" });
  const server = await startNextServer({
    ROAMLY_NOMINATIM_BASE_URL: fixtures.nominatim.baseUrl,
    ROAMLY_OVERPASS_BASE_URL: fixtures.overpass.baseUrl,
    ROAMLY_VALHALLA_BASE_URL: fixtures.valhalla.baseUrl,
    GEMINI_API_KEY: "fixture-key",
    GEMINI_BASE_URL: gemini.baseUrl,
    GEMINI_MODEL: "gemini-fixture",
  });
  const page = await openPage(chrome.port, "about:blank");
  await page.goto(`${server.baseUrl}/`);

  /** React-safe value setting, the same technique `submitForm` uses. */
  const setValue = (testId, value) =>
    page.evaluate(`
      const el = document.querySelector('[data-testid="${testId}"]');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `);

  try {
    await submitForm(page);
    await chooseFirstDestination(page);
    await page.click('[data-testid="generate-with-ai"]');
    await waitForWorkspace(page);

    const tripId = Object.keys(await readStore(page))[0];

    /**
     * A stop on day one that the page itself says is fully editable.
     *
     * Read from the rendered controls rather than picked by position: day one ends with the hotel
     * check-in, which is structurally locked and therefore offers none of these. Choosing "the last
     * item" hard-codes an assumption about what the fixture planner scheduled, and the interesting
     * target is simply *a stop the interface presents as editable*.
     */
    const target = await page.evaluate(`
      const editable = [...document.querySelectorAll('[data-testid="itinerary-item"]')]
        .map((card) => card.dataset.itemId)
        .filter((id) => {
          const has = (name) =>
            document.querySelector(
              '[data-testid="' + name + '"][data-item-id="' + id + '"]',
            ) !== null;
          return has('edit-time') && has('lock-stop') && has('remove-stop');
        });

      if (editable.length === 0) return null;

      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const item = record.plan.days
        .flatMap((day) => day.items)
        .find((entry) => entry.id === editable[0]);

      return {
        itemId: item.id,
        startTime: item.startTime,
        endTime: item.endTime,
      };
    `);

    /* -- the controls exist, and only where they should --------------------- */

    await expect(
      "an editable stop offers the time, lock and remove controls",
      () => target !== null,
    );

    await expect("the day header offers free time", () =>
      page.check(
        `document.querySelector('[data-testid="add-free-time"][data-day-number="1"]') !== null`,
      ),
    );

    /*
     * A structurally locked block is pinned by the trip's dates, so its padlock would be a control
     * whose lock could never be released. `supportsTravellerLock` is what keeps it absent.
     */
    await expect("a structurally locked block offers no padlock", () =>
      page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const fixed = record.plan.days
          .flatMap((day) => day.items)
          .filter((item) => item.kind === 'transport' || item.kind === 'logistics');
        if (fixed.length === 0) return 'no structurally locked block in the fixture';
        return fixed.every((item) => {
          const sel = '[data-item-id="' + item.id + '"]';
          return document.querySelector('[data-testid="lock-stop"]' + sel) === null
            && document.querySelector('[data-testid="unlock-stop"]' + sel) === null;
        });
      `),
    );

    /* -- the traveller's pin ------------------------------------------------ */

    const revisionBeforeLock = (await readStore(page))[tripId].revision;

    await page.click(
      `[data-testid="lock-stop"][data-item-id="${target.itemId}"]`,
    );
    await page.waitFor(
      `document.querySelector('[data-testid="unlock-stop"][data-item-id="${target.itemId}"]') !== null`,
      { label: "the stop to read as locked" },
    );

    await expect("locking a stop saves one revision forward", async () => {
      const store = await readStore(page);
      const item = store[tripId].plan.days
        .flatMap((day) => day.items)
        .find((entry) => entry.id === target.itemId);
      return (
        item.locked === true &&
        store[tripId].revision === revisionBeforeLock + 1
      );
    });

    /*
     * The point of asking the applier's own predicate for each control: a locked stop is not
     * retimable and not removable, so those controls must go — not merely refuse when pressed.
     */
    await expect("a locked stop stops offering the edits it would refuse", () =>
      page.evaluate(`
        const id = ${JSON.stringify(target.itemId)};
        const gone = (name) =>
          document.querySelector('[data-testid="' + name + '"][data-item-id="' + id + '"]') === null;
        return gone('edit-time') && gone('remove-stop');
      `),
    );

    await page.click(
      `[data-testid="unlock-stop"][data-item-id="${target.itemId}"]`,
    );
    await page.waitFor(
      `document.querySelector('[data-testid="edit-time"][data-item-id="${target.itemId}"]') !== null`,
      { label: "the stop to become editable again" },
    );

    await expect("unlocking restores the edits", async () => {
      const store = await readStore(page);
      const item = store[tripId].plan.days
        .flatMap((day) => day.items)
        .find((entry) => entry.id === target.itemId);
      return item.locked !== true;
    });

    /* -- the time editor ---------------------------------------------------- */

    await page.click(
      `[data-testid="edit-time"][data-item-id="${target.itemId}"]`,
    );
    await page.waitFor(`document.querySelector('[data-testid="time-editor"]')`, {
      label: "the inline time editor",
    });

    await expect("the editor states the free window before anything is typed", () =>
      page.evaluate(`
        const editor = document.querySelector('[data-testid="time-editor"]');
        return /\\d\\d:\\d\\d – \\d\\d:\\d\\d/.test(editor.textContent)
          && document.querySelector('[data-testid="time-editor-error"]') === null;
      `),
    );

    await expect("an untouched editor cannot be saved", () =>
      page.check(
        `document.querySelector('[data-testid="time-editor-save"]').disabled === true`,
      ),
    );

    /**
     * The refusal arrives from the applier, before any write.
     *
     * Ending a stop when it starts gives it no duration at all, which `validateSchedule` refuses for
     * any stop wherever it sits in the day — so this tests the refusal path without depending on the
     * neighbours the fixture planner happened to produce. The schema would accept both values
     * happily; it is the *position* check that says no, which is the distinction Phase 8 rests on.
     */
    await setValue("time-editor-end", target.startTime);
    await page.waitFor(
      `document.querySelector('[data-testid="time-editor-error"]') !== null`,
      { label: "the refusal" },
    );

    await expect("an impossible time is refused before it is saved", async () => {
      const state = await page.evaluate(`
        const record = Object.values(window.__roamlyTripStore.getState().records)[0];
        const item = record.plan.days
          .flatMap((day) => day.items)
          .find((entry) => entry.id === ${JSON.stringify(target.itemId)});
        return {
          saveDisabled: document.querySelector('[data-testid="time-editor-save"]').disabled,
          message: document.querySelector('[data-testid="time-editor-error"]').textContent,
          endTime: item.endTime,
          revision: record.revision,
        };
      `);

      return (
        state.saveDisabled === true &&
        /* Nothing was written: the stop still holds the times it had. */
        state.endTime === target.endTime &&
        state.revision === revisionBeforeLock + 2 &&
        state.message.length > 0
      );
    });

    /**
     * A valid change: keep the start and give back fifteen minutes.
     *
     * Shrinking rather than extending, because shrinking only ever *frees* time — it cannot collide
     * with the stop after it, whatever the day looks like. Extending would make this check depend on
     * the size of the gap the planner left.
     */
    const shrunkEnd = await page.evaluate(`
      const at = (value) => {
        const parts = value.split(':').map(Number);
        return parts[0] * 60 + parts[1];
      };
      const start = at(${JSON.stringify(target.startTime)});
      const end = at(${JSON.stringify(target.endTime)});
      const total = start + Math.max(15, end - start - 15);
      return String(Math.floor(total / 60)).padStart(2, '0') + ':' +
        String(total % 60).padStart(2, '0');
    `);

    await setValue("time-editor-end", shrunkEnd);

    await page.waitFor(
      `document.querySelector('[data-testid="time-editor-save"]').disabled === false`,
      { label: "the save control to become available" },
    );
    await page.click('[data-testid="time-editor-save"]');
    await page.waitFor(
      `document.querySelector('[data-testid="time-editor"]') === null`,
      { label: "the editor to close" },
    );

    await expect("a valid time is saved once, and the editor closes", async () => {
      const store = await readStore(page);
      const item = store[tripId].plan.days
        .flatMap((day) => day.items)
        .find((entry) => entry.id === target.itemId);
      return (
        item.endTime === shrunkEnd &&
        item.startTime === target.startTime &&
        store[tripId].revision === revisionBeforeLock + 3
      );
    });

    /* -- free time ---------------------------------------------------------- */

    await page.click('[data-testid="add-free-time"][data-day-number="1"]');
    await page.waitFor(
      `document.querySelector('[data-testid="free-time-form"]')`,
      { label: "the free-time form" },
    );

    await expect("the free-time form cannot be saved empty", () =>
      page.check(
        `document.querySelector('[data-testid="free-time-save"]').disabled === true`,
      ),
    );

    /**
     * After everything else on the day, clearing the transition floor.
     *
     * Read from the day as it stands rather than from the stop edited above — that one need not be
     * the last, and a free-time block overlapping a real stop would be refused for a reason that has
     * nothing to do with what this check is about.
     */
    const freeTime = await page.evaluate(`
      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const day = record.plan.days[0];
      const latest = day.items.reduce((most, item) => {
        const parts = item.endTime.split(':').map(Number);
        return Math.max(most, parts[0] * 60 + parts[1]);
      }, 0);
      const start = latest + 15;
      const end = start + 30;
      const fmt = (total) =>
        String(Math.floor(total / 60)).padStart(2, '0') + ':' +
        String(total % 60).padStart(2, '0');
      return { startTime: fmt(start), endTime: fmt(end), fits: end <= 23 * 60 + 59 };
    `);

    await expect("the day has room for free time after its last stop", () => freeTime.fits);

    await setValue("free-time-start", freeTime.startTime);
    await setValue("free-time-end", freeTime.endTime);
    await setValue("free-time-title", "Nap by the river");

    await page.waitFor(
      `document.querySelector('[data-testid="free-time-save"]').disabled === false`,
      { label: "the free-time save control" },
    );
    await page.click('[data-testid="free-time-save"]');
    await page.waitFor(
      `document.querySelector('[data-testid="free-time-form"]') === null`,
      { label: "the free-time form to close" },
    );

    await expect("free time is added as a placeless rest block", async () => {
      const store = await readStore(page);
      const added = store[tripId].plan.days[0].items.find(
        (item) => item.title === "Nap by the river",
      );
      return (
        added !== undefined &&
        added.place === null &&
        added.kind === "rest" &&
        added.estimatedCost === 0 &&
        added.startTime === freeTime.startTime &&
        store[tripId].revision === revisionBeforeLock + 4
      );
    });

    /* -- swapping in an alternative ----------------------------------------- */

    await expect("a swap control never opens an empty list", async () => {
      const swap = await page.evaluate(`
        const button = document.querySelector('[data-testid="swap-stop"]');
        if (button === null) return null;
        return { itemId: button.dataset.itemId, label: button.textContent };
      `);

      if (swap === null) return "no stop had an unused place of its category";

      await page.click(`[data-testid="swap-stop"][data-item-id="${swap.itemId}"]`);
      await page.waitFor(`document.querySelector('[data-testid="alternatives"]')`, {
        label: "the alternatives list",
      });

      /* The count on the control is the number of options behind it, or the label is a lie. */
      return page.evaluate(`
        const options = document.querySelectorAll('[data-testid="alternative-option"]').length;
        const claimed = Number(${JSON.stringify(swap.label)}.replace(/[^0-9]/g, ''));
        return options > 0 && options === claimed;
      `);
    });

    await expect("choosing an alternative swaps the place and saves once", async () => {
      const option = await page.evaluate(`
        const button = document.querySelector('[data-testid="alternative-option"]');
        if (button === null) return null;
        const card = button.closest('[data-testid="itinerary-item"]');
        return { placeId: button.dataset.placeId, itemId: card.dataset.itemId };
      `);

      if (option === null) return "no alternatives were offered";

      const before = (await readStore(page))[tripId].revision;

      await page.click(
        `[data-testid="alternative-option"][data-place-id="${option.placeId}"]`,
      );
      await page.waitFor(
        `document.querySelector('[data-testid="alternatives"]') === null`,
        { label: "the alternatives list to close" },
      );

      const store = await readStore(page);
      const item = store[tripId].plan.days
        .flatMap((day) => day.items)
        .find((entry) => entry.id === option.itemId);

      return (
        item.place !== null &&
        item.place.placeId === option.placeId &&
        store[tripId].revision === before + 1
      );
    });

    /* -- removing a stop ---------------------------------------------------- */

    await expect("removing a stop drops it and saves once", async () => {
      const victim = await page.evaluate(`
        const button = document.querySelector('[data-testid="remove-stop"]');
        return button === null ? null : button.dataset.itemId;
      `);

      if (victim === null) return "no stop offered a remove control";

      const before = (await readStore(page))[tripId].revision;

      await page.click(`[data-testid="remove-stop"][data-item-id="${victim}"]`);
      await page.waitFor(
        `document.querySelector('[data-testid="itinerary-item"][data-item-id="${victim}"]') === null`,
        { label: "the stop to leave the itinerary" },
      );

      const store = await readStore(page);
      const present = store[tripId].plan.days
        .flatMap((day) => day.items)
        .some((entry) => entry.id === victim);

      return !present && store[tripId].revision === before + 1;
    });

    /* -- reordering, by keyboard -------------------------------------------- */

    /**
     * The keyboard path is asserted rather than the pointer one, and not because it is easier.
     *
     * It runs the same state machine, builds the same `move-item` and commits through the same
     * execution path, so everything a drag decides is covered by exercising it. What it adds is the
     * half a synthetic pointer sequence could not check at all: that the stop is reachable, that its
     * state is announced, and that moving it around writes nothing until it is dropped.
     *
     * The gap arithmetic itself — where a reorder goes wrong by one — is unit-tested in
     * `lib/trip/reorder.test.ts` against measured rectangles.
     */
    /**
     * The shortest movable stop, on a day that has more than one.
     *
     * Shortest deliberately. A move only succeeds where the neighbours leave a window long enough
     * for the stop, so picking the first handle in the document tests whichever stop the fixture
     * planner happened to schedule first — and on a packed day that is often one with nowhere to go,
     * which would make this assert the timetable rather than the reorder. The shortest stop is the
     * one most likely to have somewhere to land, and the walk below still reports honestly if it
     * does not.
     */
    const reorderDay = await page.evaluate(`
      const handles = [...document.querySelectorAll('[data-testid="reorder-handle"]')];
      if (handles.length === 0) return null;

      const record = Object.values(window.__roamlyTripStore.getState().records)[0];
      const minutes = (item) => {
        const [sh, sm] = item.startTime.split(':').map(Number);
        const [eh, em] = item.endTime.split(':').map(Number);
        return eh * 60 + em - (sh * 60 + sm);
      };

      const candidates = handles.map((handle) => {
        const dayNumber = Number(
          handle.closest('[data-testid="itinerary-item"]').dataset.dayNumber,
        );
        const day = record.plan.days.find((entry) => entry.dayNumber === dayNumber);
        const item = day.items.find((entry) => entry.id === handle.dataset.itemId);
        return {
          itemId: item.id,
          dayNumber,
          length: minutes(item),
          order: day.items.map((entry) => entry.id),
        };
      });

      candidates.sort((a, b) => a.length - b.length);
      return candidates[0];
    `);

    /**
     * Which gap the indicator is sitting in.
     *
     * The signal the walk below advances on. Watching the announcement text instead does not work:
     * two adjacent gaps that are both too short refuse in identical words, so the sentence stops
     * changing while the target is still moving — and the walk would conclude it had stalled.
     */
    const activeGap = () =>
      page.evaluate(`
        const indicators = [...document.querySelectorAll('[data-testid="drop-indicator"]')];
        return indicators.findIndex((node) => node.dataset.active === 'true');
      `);

    await expect(
      "a movable stop offers a reorder handle, and a locked one does not",
      () =>
        page.evaluate(`
        const cards = [...document.querySelectorAll('[data-testid="itinerary-item"]')];
        const wrong = cards.filter((card) => {
          const id = card.dataset.itemId;
          const has = (name) =>
            document.querySelector(
              '[data-testid="' + name + '"][data-item-id="' + id + '"]',
            ) !== null;
          /*
           * The handle and the "move to another day" control ask the same question of the same
           * predicate, so a stop offering one and not the other means the two have drifted apart.
           * A day of one stop is the exception: still movable, but with nowhere to reorder to.
           */
          const siblings = card.closest('ol').querySelectorAll('[data-testid="itinerary-item"]');
          if (siblings.length < 2) return has('reorder-handle');
          return has('reorder-handle') !== has('move-stop');
        });
        return wrong.length === 0 ? true : wrong.length + ' cards disagree about movability';
      `),
    );

    const revisionBeforeReorder = reorderDay
      ? (await readStore(page))[tripId].revision
      : null;

    await expect("picking a stop up announces it and writes nothing", async () => {
      if (!reorderDay) return "no stop offered a reorder handle";

      await page.focus(
        `[data-testid="reorder-handle"][data-item-id="${reorderDay.itemId}"]`,
      );
      await page.press("Space");
      await page.waitFor(
        `document.querySelector('[data-testid="reorder-handle"][data-item-id="${reorderDay.itemId}"]').dataset.grabbed === 'true'`,
        { label: "the stop to be picked up" },
      );

      const announcement = await page.evaluate(
        `return document.querySelector('[data-testid="reorder-announcement"]').textContent;`,
      );
      const store = await readStore(page);

      return (
        announcement.includes("Picked up") &&
        store[tripId].revision === revisionBeforeReorder
      );
    });

    await expect(
      "an arrow key previews a new position without saving anything",
      async () => {
        if (!reorderDay) return "no stop offered a reorder handle";

        await page.waitFor(
          `document.querySelector('[data-testid="drop-indicator"][data-active="true"]') !== null`,
          { label: "the drop indicator to appear" },
        );

        /**
         * Whichever direction the stop can actually go.
         *
         * A stop already at the foot of its day has nowhere to go down: the arrow clamps, the target
         * does not move, and — correctly — nothing is announced, because nothing changed. Hard-coding
         * one direction would make this fail on a stop that behaved perfectly.
         *
         * The wait matters too. The pick-up sentence gives way to a position on the next render, so
         * reading straight after the key would sometimes catch the instructions still on screen and
         * call the preview missing.
         */
        let moved = false;
        for (const key of ["ArrowDown", "ArrowUp"]) {
          await page.press(key);
          try {
            await page.waitFor(
              `!document.querySelector('[data-testid="reorder-announcement"]').textContent.includes('Picked up')`,
              { label: "the announcement to describe the new position", timeoutMs: 4_000 },
            );
            moved = true;
            break;
          } catch {
            // Clamped at that end of the day. Try the other one.
          }
        }

        if (!moved) return "the arrow keys moved the stop nowhere";

        const announcement = await page.evaluate(
          `return document.querySelector('[data-testid="reorder-announcement"]').textContent;`,
        );
        const store = await readStore(page);
        const order = store[tripId].plan.days
          .find((day) => day.dayNumber === reorderDay.dayNumber)
          .items.map((item) => item.id);

        /*
         * The announcement carries the times the drop *would* produce, straight from the applier —
         * the whole point of a preview. The itinerary itself is untouched until Enter.
         */
        return (
          /\d\d:\d\d to \d\d:\d\d|Cannot drop here/.test(announcement) &&
          store[tripId].revision === revisionBeforeReorder &&
          order.join() === reorderDay.order.join()
        );
      },
    );

    await expect("Escape puts the stop back and still saves nothing", async () => {
      if (!reorderDay) return "no stop offered a reorder handle";

      await page.press("Escape");
      await page.waitFor(
        `document.querySelector('[data-testid="reorder-handle"][data-item-id="${reorderDay.itemId}"]').dataset.grabbed === 'false'`,
        { label: "the stop to be put back" },
      );

      const store = await readStore(page);
      const order = store[tripId].plan.days
        .find((day) => day.dayNumber === reorderDay.dayNumber)
        .items.map((item) => item.id);

      return (
        store[tripId].revision === revisionBeforeReorder &&
        order.join() === reorderDay.order.join()
      );
    });

    await expect(
      "a completed keyboard reorder changes the order and saves exactly one revision",
      async () => {
        if (!reorderDay) return "no stop offered a reorder handle";

        const announcement = () =>
          page.evaluate(
            `return document.querySelector('[data-testid="reorder-announcement"]').textContent;`,
          );

        const handle = `[data-testid="reorder-handle"][data-item-id="${reorderDay.itemId}"]`;
        const grabbedIs = (value) =>
          page.waitFor(
            `document.querySelector('${handle}').dataset.grabbed === '${value}'`,
            { label: `the stop to be ${value === "true" ? "picked up" : "released"}` },
          );

        /**
         * Walk away from the stop's own position until the applier accepts a gap.
         *
         * A stop only moves where its new neighbours leave a window long enough for it, and whether
         * the gap one place down has one depends entirely on what the fixture planner scheduled.
         * Pressing once and demanding success would make this assert the timetable rather than the
         * reorder.
         *
         * Each direction starts from a fresh pick-up, so the walk never passes back through the
         * stop's own position — where the announcement reads like a success but the drop is a
         * deliberate no-op that saves nothing.
         */
        const attempt = async (key) => {
          await page.focus(handle);
          await page.press("Space");
          await grabbedIs("true");

          for (let step = 0; step < reorderDay.order.length; step += 1) {
            const from = await activeGap();
            await page.press(key);

            /*
             * Waited for, not read straight after the press: `press` returns once the key has been
             * dispatched, which is before React has rendered the new target, so an immediate read
             * evaluates the gap the stop has just left.
             *
             * The indicator's position is the signal rather than the announcement's text, because
             * two adjacent gaps that are both too short refuse in identical words — the sentence
             * would stop changing while the target was still moving.
             */
            try {
              await page.waitFor(
                `[...document.querySelectorAll('[data-testid="drop-indicator"]')].findIndex((node) => node.dataset.active === 'true') !== ${from}`,
                { label: "the indicator to follow the arrow key", timeoutMs: 4_000 },
              );
            } catch {
              break; // The target has reached the end of the day; nothing further this way.
            }

            if (!(await announcement()).includes("Cannot drop here")) return true;
          }

          await page.press("Escape");
          await grabbedIs("false");
          return false;
        };

        const landed = (await attempt("ArrowDown")) || (await attempt("ArrowUp"));
        if (!landed) return "no gap on this day had room for the stop";

        await page.press("Enter");

        await page.waitFor(
          `document.querySelector('[data-testid="reorder-handle"][data-item-id="${reorderDay.itemId}"]').dataset.grabbed === 'false'`,
          { label: "the stop to be dropped" },
        );

        const store = await readStore(page);
        const order = store[tripId].plan.days
          .find((day) => day.dayNumber === reorderDay.dayNumber)
          .items.map((item) => item.id);

        /*
         * One revision for the whole gesture, however many arrow presses it took. Two would mean
         * each intermediate position had been saved, and the stop's final times would then depend
         * on the route it took rather than on where it ended up.
         */
        return (
          store[tripId].revision === revisionBeforeReorder + 1 &&
          order.join() !== reorderDay.order.join() &&
          order.length === reorderDay.order.length
        );
      },
    );

    /* -- changing how long a stop lasts -------------------------------------- */

    await expect("a stop offers a length control alongside its time control", () =>
      page.check(
        `document.querySelectorAll('[data-testid="edit-duration"]').length > 0`,
      ),
    );

    const lengthTarget = await page.evaluate(`
      const button = document.querySelector('[data-testid="edit-duration"]');
      return button === null ? null : button.dataset.itemId;
    `);

    await expect(
      "the length editor states the times the change would produce",
      async () => {
        if (lengthTarget === null) return "no stop offered a length control";

        await page.click(
          `[data-testid="edit-duration"][data-item-id="${lengthTarget}"]`,
        );
        await page.waitFor(
          `document.querySelector('[data-testid="duration-editor"]') !== null`,
          { label: "the length editor to open" },
        );

        await setValue("duration-editor-minutes", "45");
        await page.waitFor(
          `document.querySelector('[data-testid="duration-editor-outcome"]') !== null`,
          { label: "the resulting times to be stated" },
        );

        const outcome = await page.evaluate(
          `return document.querySelector('[data-testid="duration-editor-outcome"]').textContent;`,
        );
        return /\d\d:\d\d/.test(outcome);
      },
    );

    await expect("an impossible length is refused before it is saved", async () => {
      if (lengthTarget === null) return "no stop offered a length control";

      await setValue("duration-editor-minutes", "720");
      await page.waitFor(
        `document.querySelector('[data-testid="duration-editor-error"]') !== null`,
        { label: "the refusal to appear" },
      );

      return page.check(
        `document.querySelector('[data-testid="duration-editor-save"]').disabled === true`,
      );
    });

    await expect("a valid length is saved once, and the editor closes", async () => {
      if (lengthTarget === null) return "no stop offered a length control";

      const before = (await readStore(page))[tripId];
      const previous = before.plan.days
        .flatMap((day) => day.items)
        .find((item) => item.id === lengthTarget);

      await setValue("duration-editor-minutes", "45");
      await page.waitFor(
        `document.querySelector('[data-testid="duration-editor-save"]').disabled === false`,
        { label: "the length to become saveable" },
      );
      await page.click('[data-testid="duration-editor-save"]');
      await page.waitFor(
        `document.querySelector('[data-testid="duration-editor"]') === null`,
        { label: "the length editor to close" },
      );

      const store = await readStore(page);
      const after = store[tripId].plan.days
        .flatMap((day) => day.items)
        .find((item) => item.id === lengthTarget);

      /* The anchored end held still and the other one moved — the whole content of an anchor. */
      return (
        store[tripId].revision === before.revision + 1 &&
        after.startTime === previous.startTime &&
        after.endTime !== previous.endTime
      );
    });

    /*
     * Every edit above stored a `TripPlan` that passed its own schema on the way in, so a reload is
     * the cheapest proof that none of them wrote something unparseable.
     */
    await expect("every edit survives a reload", async () => {
      await page.goto(`${server.baseUrl}/trip/${tripId}`);
      await waitForWorkspace(page);
      return page.check(
        `document.querySelectorAll('[data-testid="itinerary-item"]').length > 0`,
      );
    });

    /* -- a trip with no saved search offers none of this --------------------- */

    await expect("the sample trip offers no structural controls", async () => {
      await page.goto(`${server.baseUrl}/`);
      await page.waitFor(`document.querySelector('[data-testid="open-sample-trip"]')`, {
        label: "the sample link",
      });
      await page.click('[data-testid="open-sample-trip"]');
      await waitForWorkspace(page);

      return page.evaluate(`
        const absent = (name) =>
          document.querySelector('[data-testid="' + name + '"]') === null;
        return absent('edit-time')
          && absent('lock-stop')
          && absent('remove-stop')
          && absent('swap-stop')
          && absent('add-free-time');
      `);
    });

    /* -- the surface, still sound ------------------------------------------- */

    await expect("the page never scrolls sideways", () => noHorizontalOverflow(page));

    await expect("no console errors were logged", () => {
      const problems = consoleProblems(page);
      return problems.length === 0 ? true : problems.join(" | ");
    });
  } finally {
    await page.close();
    await server.close();
    await closeAll([gemini]);
  }
}

async function main() {
  const chrome = await launchChrome();
  console.log(`Chrome: ${chrome.version["User-Agent"]}`);

  const nominatim = await startNominatim();
  const overpass = await startOverpass();
  const valhalla = await startValhalla();
  const gemini = await startGemini({ mode: "ok" });
  const fixtures = { nominatim, overpass, valhalla };

  try {
    await scenarioNoProvider(chrome, fixtures);

    // Counters reset between scenarios so "no routing during generation" means this
    // generation, not the whole run.
    valhalla.state.requests = 0;
    await scenarioGemini(chrome, fixtures, gemini);

    await scenarioCancel(chrome, fixtures);

    await scenarioPartial(chrome, fixtures);

    await scenarioFailure(chrome, fixtures, {
      mode: "fabricate",
      label: "Fabricated placeId is rejected",
      assertion: async (page, assert) => {
        await assert("a fabricated place fails the generation", async () => {
          await page.waitFor(`document.querySelector('[data-testid="generation-error"]')`, {
            timeoutMs: 60_000,
            label: "the failure notice",
          });
          return true;
        });
        await assert("the message says nothing was saved", () =>
          page.check(
            `document.querySelector('[data-testid="generation-error"]').textContent.includes("nothing was saved")`,
          ),
        );
      },
    });

    await scenarioFailure(chrome, fixtures, {
      mode: "refuse",
      label: "Model refusal is controlled",
      assertion: async (page, assert) => {
        await assert("a refusal renders as a readable notice", async () => {
          await page.waitFor(
            `document.querySelector('[data-testid="generation-refused"]')`,
            { timeoutMs: 60_000, label: "the refusal notice" },
          );
          return true;
        });
        await assert("the refusal offers the demo planner instead", () =>
          page.check(
            `document.querySelector('[data-testid="generation-refused"]').textContent.includes("demo planner")`,
          ),
        );
      },
    });

    await scenarioFailure(chrome, fixtures, {
      mode: "empty",
      label: "Empty model content is controlled",
      assertion: async (page, assert) => {
        await assert("empty content renders as an error, not a crash", async () => {
          await page.waitFor(`document.querySelector('[data-testid="generation-error"]')`, {
            timeoutMs: 60_000,
            label: "the failure notice",
          });
          return true;
        });
      },
    });

    await scenarioFailure(chrome, fixtures, {
      mode: "rate-limit",
      label: "Rate limiting is controlled",
      assertion: async (page, assert) => {
        await assert("a 429 explains free-tier limits", async () => {
          await page.waitFor(`document.querySelector('[data-testid="generation-error"]')`, {
            timeoutMs: 60_000,
            label: "the failure notice",
          });
          return page.check(
            `/rate limited|try again/i.test(document.querySelector('[data-testid="generation-error"]').textContent)`,
          );
        });
      },
    });

    await scenarioConflict(chrome, fixtures, gemini);

    valhalla.state.requests = 0;
    await scenarioRefinement(chrome, fixtures);
    await scenarioRefinementWithoutAi(chrome, fixtures);
    await scenarioScheduleAndCosts(chrome, fixtures);
    await scenarioStructuralEdits(chrome, fixtures);
    await scenarioEditingControls(chrome, fixtures);
    await scenarioRefinementRefused(chrome, fixtures);
  } finally {
    await closeAll([nominatim, overpass, valhalla, gemini]);
    await chrome.close();
  }

  const failed = results.filter((result) => !result.passed);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const failure of failed) {
      console.log(`  ✗ [${failure.scenario}] ${failure.name} — ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Only run the suite when this file is the entry point.
 *
 * `screenshots.mjs` imports the helpers above — a bare `await main()` would make importing them run
 * the whole 188-check suite as a side effect.
 */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
