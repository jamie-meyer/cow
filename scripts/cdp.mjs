// A small Chrome DevTools Protocol driver for the end-to-end check.
// Needs Node 22 or newer and no dependencies.
import { writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NAMED_KEYS = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  ArrowDown: 40,
  ArrowUp: 38,
};

function keyCode(key) {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === "?") return "Slash";
  if (key.length === 1) return `Key${key.toUpperCase()}`;
  return key;
}

/** Connect to the first page target whose URL contains `match`. */
export async function connect(port, match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.type === "page" && t.url.includes(match));
  if (!target) throw new Error(`no page target matching ${match}`);
  return attach(target);
}

/** Open a new tab, which is a window of its own as far as the page can tell, and connect to it. */
export async function newTab(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await response.json();
  const page = await attach(target);
  const close = page.close;
  page.close = async () => {
    close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined);
  };
  return page;
}

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  /** Requests that failed to load; reported apart, since bb makes its own. */
  const networkErrors = [];
  ws.onmessage = (message) => {
    const msg = JSON.parse(message.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(`exception: ${d.exception?.description ?? d.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(
        `console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`,
      );
    } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      const { text, url = "", source } = msg.params.entry;
      (source === "network" ? networkErrors : consoleErrors).push(`log: ${text} ${url}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++nextId, { resolve, reject });
      ws.send(JSON.stringify({ id: nextId, method, params }));
    });

  const page = {
    consoleErrors,
    networkErrors,
    send,
    close: () => ws.close(),
    async eval(expression) {
      const r = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
      }
      return r.result.value;
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(2500);
    },
    /** Poll a JS expression until it is truthy; returns its value. */
    async waitFor(expression, { timeout = 15000, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await page.eval(expression).catch(() => null);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
        await sleep(200);
      }
    },
    /** A trusted key press, e.g. "j", "G", "Escape", "Tab", "?", "1". */
    async key(key, { shift = false } = {}) {
      const isChar = key.length === 1;
      const upper = isChar && /[A-Z?]/.test(key);
      const base = {
        key,
        code: keyCode(key),
        windowsVirtualKeyCode:
          NAMED_KEYS[key] ?? (key === "?" ? 191 : key.toUpperCase().charCodeAt(0)),
        modifiers: shift || upper ? 8 : 0,
      };
      const text = isChar ? key : key === "Enter" ? "\r" : undefined;
      await send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        ...base,
        ...(text ? { text } : {}),
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(250);
    },
    async type(text) {
      await send("Input.insertText", { text });
      await sleep(150);
    },
    async click(x, y) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await sleep(250);
    },
    async resize(width, height) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(600);
    },
    async colorScheme(scheme) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
      await sleep(600);
    },
    async shot(file) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(file, Buffer.from(r.data, "base64"));
      return file;
    },
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  return page;
}
