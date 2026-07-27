import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A minimal Chrome DevTools Protocol client.
 *
 * No dependency, because Node 22+ ships a global `WebSocket` and the protocol surface
 * this suite needs is small: evaluate an expression, wait for a condition, read the
 * console. Adding Puppeteer would pull a second browser download and a large
 * dependency tree to replace roughly a hundred lines.
 *
 * Console messages and page errors are collected from the moment the target is
 * attached, so "no console errors" and "no hydration warnings" are properties of the
 * whole run rather than of whenever the assertion happened to execute.
 */

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/**
 * Keys this suite can press, spelled the way the protocol expects.
 *
 * An allowlist rather than a translation function: `Input.dispatchKeyEvent` silently does nothing
 * useful when `windowsVirtualKeyCode` and `key` disagree, so a typo would produce a passing test
 * that pressed nothing. An unmapped name throws instead.
 */
const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  /**
   * The arrows, for the keyboard half of reordering.
   *
   * No `text`, deliberately: an arrow inserts nothing, and giving it one makes Chrome deliver a
   * `keypress` carrying a character — which a field under test would receive as typing.
   */
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
};

export async function launchChrome({ port = 9455 } = {}) {
  const binary = CHROME_PATHS.find((path) => existsSync(path));
  if (!binary) throw new Error("No Chrome or Chromium binary found");

  const profile = await mkdtemp(join(tmpdir(), "roamly-cdp-"));

  const chrome = spawn(
    binary,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      /**
       * A system proxy or PAC file turns every localhost request into
       * `ERR_CONNECTION_REFUSED`, which is indistinguishable from a dead server and
       * is a common state on a managed machine. The fixture servers and the dev
       * server are all loopback, so a proxy has nothing to contribute.
       */
      "--no-proxy-server",
      "--proxy-bypass-list=<-loopback>",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`).catch(
      () => null,
    );
    return response?.ok ? await response.json() : null;
  }, "Chrome debugging endpoint");

  return {
    port,
    version,
    async close() {
      chrome.kill("SIGTERM");
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Opens a page and attaches to it. */
export async function openPage(port, url) {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  if (!created.ok) throw new Error(`Could not open a page: ${created.status}`);
  const target = await created.json();

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleMessages = [];
  const pageErrors = [];
  /**
   * The main frame's execution context.
   *
   * `Runtime.evaluate` without one targets whatever context the browser considers
   * current, and Next's dev client creates and destroys contexts as it boots — which
   * showed up as `document.getElementById` returning an element on one call and `null`
   * on the next. Pinning the default context of the main frame makes every evaluation
   * run against the page the traveller is actually looking at.
   */
  let contextId = null;
  /** Every network request the page issued, so request counts can be asserted. */
  const requests = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }

    if (message.method === "Runtime.executionContextCreated") {
      if (message.params.context.auxData?.isDefault) {
        contextId = message.params.context.id;
      }
    }
    if (message.method === "Runtime.executionContextDestroyed") {
      if (message.params.executionContextId === contextId) contextId = null;
    }
    if (message.method === "Runtime.executionContextsCleared") {
      contextId = null;
    }

    if (message.method === "Runtime.consoleAPICalled") {
      consoleMessages.push({
        type: message.params.type,
        text: (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" "),
      });
    }
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(
        message.params.exceptionDetails?.exception?.description ??
          message.params.exceptionDetails?.text ??
          "unknown page error",
      );
    }
    if (message.method === "Network.requestWillBeSent") {
      requests.push({
        url: message.params.request.url,
        method: message.params.request.method,
        body: message.params.request.postData ?? null,
      });
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");

  const page = {
    targetId: target.id,
    consoleMessages,
    pageErrors,
    requests,
    send,

    async goto(destination) {
      requests.length = 0;
      contextId = null;
      await send("Page.navigate", { url: destination });
      // The context id arrives asynchronously, after navigation commits.
      await waitFor(() => contextId !== null, `an execution context for ${destination}`, {
        timeoutMs: 30_000,
      });
      await page.waitFor("document.readyState === 'complete'");
      // One extra tick, so React has committed its first client render.
      await page.sleep(600);
    },

    /** Evaluates an expression and returns its value, awaiting a promise if given one. */
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        // An **async** IIFE: several checks need to `await fetch(...)` inside the
        // page, and `awaitPromise` below resolves the returned promise. Non-async
        // bodies are unaffected.
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId === null ? {} : { contextId }),
      });
      if (result.exceptionDetails) {
        throw new Error(
          `evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },

    /** Evaluates a boolean expression, no wrapping. */
    async check(expression) {
      return page.evaluate(`return Boolean(${expression});`);
    },

    async waitFor(expression, { timeoutMs = 20_000, label } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await page
          .evaluate(`return Boolean(${expression});`)
          .catch(() => false);
        if (value) return true;
        await page.sleep(120);
      }
      throw new Error(`Timed out waiting for ${label ?? expression}`);
    },

    async click(selector) {
      await page.evaluate(
        `const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) throw new Error("no element for " + ${JSON.stringify(selector)});
         el.click();
         return true;`,
      );
    },

    /**
     * Moves real focus to an element.
     *
     * `el.focus()` rather than a synthetic event, because focus is one of the few things the DOM
     * method does exactly as the browser would — including running React's `onFocus`.
     */
    async focus(selector) {
      return page.evaluate(
        `const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) throw new Error("no element for " + ${JSON.stringify(selector)});
         el.focus();
         return document.activeElement === el;`,
      );
    },

    /**
     * A genuine key press, delivered through the browser's own input pipeline.
     *
     * Deliberately not a dispatched `KeyboardEvent`: a synthetic Enter on a `<button>` does not
     * activate it, because activation is browser behaviour rather than an event listener. A test
     * built on synthetic events would pass against a `<div role="button">` that no keyboard user
     * can operate — the exact regression this suite exists to catch.
     */
    async press(key) {
      const descriptor = KEYS[key];
      if (!descriptor) throw new Error(`unmapped key: ${key}`);

      await send("Input.dispatchKeyEvent", { type: "keyDown", ...descriptor });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...descriptor });
    },

    async setViewport(width, height) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 700,
      });
    },

    /**
     * A PNG of the current viewport, written to disk.
     *
     * `deviceScaleFactor: 1` and a fixed viewport keep the output byte-stable between runs, which is
     * what lets a screenshot be committed and reviewed in a diff rather than regenerated blind.
     * `captureBeyondViewport: false` on purpose — a full-page capture of a workspace with a sticky
     * header produces a tall image with the header repeated, which is not what a reader wants to see.
     */
    async screenshot(filePath) {
      const { data } = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      await writeFile(filePath, Buffer.from(data, "base64"));
      return filePath;
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    async close() {
      socket.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
  };

  return page;
}

export async function waitFor(probe, label, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
