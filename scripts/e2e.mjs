// End-to-end check of the cow page against a running bb.
//
// It drives a separate headless Chrome (never your own bb window) and makes
// its own fixture threads, titled "cow test", on the cheapest model. It writes
// only to those threads and archives them when it finishes.
//
//   1. Start Chrome with a throwaway profile:
//        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//          --headless=new --remote-debugging-port=9344 \
//          --user-data-dir="$(mktemp -d)" --window-size=1440,900 about:blank
//   2. npm run e2e -- --project <bb project id> --environment <environment id>
//
// Options:
//   --bb <url>          bb's address (default http://127.0.0.1:38886)
//   --port <n>          Chrome's debugging port (default 9344)
//   --state <file>      remember the fixtures here and reuse them next run
//   --keep              leave the fixtures unarchived (use with --state)
//   --shots <dir>       save screenshots here (never commit them)
//   --model <id>        fixture model (default claude-haiku-5-5)

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { connect, sleep } from "./cdp.mjs";

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const BB = option("bb", "http://127.0.0.1:38886");
const PORT = option("port", "9344");
const PROJECT = option("project", "");
const ENVIRONMENT = option("environment", "");
const STATE = option("state", "");
const SHOTS = option("shots", "");
const MODEL = option("model", "claude-haiku-5-5");
const TITLE = "cow test";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function api(path) {
  const response = await fetch(`${BB}/api/v1${path}`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function rpc(method, input) {
  const response = await fetch(`${BB}/api/v1/plugins/cow/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`${method}: ${JSON.stringify(body)}`);
  return body.result;
}
async function bb(...argv) {
  const { stdout } = await run("bb", [...argv, "--json"]);
  return JSON.parse(stdout);
}
async function waitForThread(id, predicate, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const [thread] = await api(`/threads?threadIds=${id}&limit=1`);
    if (thread && predicate(thread)) return thread;
    if (Date.now() > deadline) throw new Error(`thread ${id} never became: ${label}`);
    await sleep(1000);
  }
}

// ---- fixtures ---------------------------------------------------------

const QUIET = "You are a test fixture for a bb plugin. Use no tools. Reply to every message with exactly: ok";
const ASKS =
  "You are a test fixture for a bb plugin. Ask the user one multiple-choice question with your " +
  'question tool: "Which colour?" with the options "red" and "blue". Use no other tools. When the ' +
  "answer arrives, reply with exactly the answer.";

async function spawn({ prompt, parent, model = MODEL }) {
  const thread = await bb(
    "thread", "spawn",
    "--project", PROJECT,
    "--environment", ENVIRONMENT,
    "--provider", "claude-code",
    "--model", model,
    "--title", TITLE,
    "--parent-notifications", "off",
    "--prompt", prompt,
    ...(parent ? ["--parent-thread", parent] : []),
  );
  return thread.id;
}

/** Main; a quiet child; a child that asks a question; a grandchild that fails. */
async function fixtures() {
  if (STATE && existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8"));
  if (!PROJECT || !ENVIRONMENT) throw new Error("--project and --environment are required");
  const main = await spawn({ prompt: QUIET });
  const quiet = await spawn({ prompt: QUIET, parent: main });
  const asks = await spawn({ prompt: ASKS, parent: main });
  // A model that does not exist fails its first turn at once, for free.
  const fails = await spawn({ prompt: QUIET, parent: quiet, model: "cow-test-no-such-model" });
  const ids = { main, quiet, asks, fails };
  if (STATE) writeFileSync(STATE, JSON.stringify(ids));
  return ids;
}

async function assertOurs(ids) {
  for (const id of Object.values(ids)) {
    const [thread] = await api(`/threads?threadIds=${id}&limit=1`);
    if (!thread || thread.title !== TITLE) throw new Error(`${id} is not a "${TITLE}" fixture`);
  }
}

// ---- the page ---------------------------------------------------------

const ROOT = `document.querySelector("[data-cow-root]")`;
const lineState = (id) => `document.querySelector('[data-cow-line="${id}"]')?.dataset.cowState`;
const isCursor = (id) =>
  `document.querySelector('[data-cow-line="${id}"]')?.classList.contains("cow-cur") === true`;
const cursorId = `document.querySelector(".cow-main .cow-cur")?.dataset.cowLine ?? null`;
const mode = `${ROOT}?.dataset.cowMode`;
const screen = `${ROOT}?.dataset.cowScreen`;

async function main() {
  const ids = await fixtures();
  await assertOurs(ids);
  const before = await rpc("main_state", null);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  await waitForThread(ids.main, (t) => t.status === "idle", "idle");
  await waitForThread(ids.quiet, (t) => t.status === "idle", "idle");
  await waitForThread(ids.asks, (t) => t.hasPendingInteraction, "asking");
  await waitForThread(ids.fails, (t) => t.status === "error", "failed");

  const page = await connect(PORT, "");
  const shot = async (name) => {
    if (SHOTS) await page.shot(join(SHOTS, `${name}.png`));
  };
  await page.resize(1440, 900);
  await page.colorScheme("light");
  await page.goto(`${BB}/plugins/cow/main`);
  await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page" });

  // -- choosing Main --
  if ((await page.eval(screen)) === "overview") await page.key("M");
  await page.waitFor(`${screen} === "picker"`, { label: "the picker" });
  check("with no Main chosen, the page shows the picker", true);
  await shot("picker");
  const first = await page.eval(cursorId);
  await page.key("j");
  const second = await page.eval(cursorId);
  await page.key("k");
  check("picker: j and k move the cursor", first !== second && (await page.eval(cursorId)) === first);
  await page.key("g");
  await page.key("g");
  for (let i = 0; i < 400 && !(await page.eval(isCursor(ids.main))); i += 1) await page.key("j");
  await page.key("Enter");
  await page.waitFor(`${screen} === "overview"`, { label: "the overview" });
  const stored = await rpc("main_state", null);
  check("picker: Enter makes the selected thread Main", stored.mains[PROJECT] === ids.main);
  check(
    "Main is the page heading",
    (await page.eval(`document.querySelector(".cow-crumbs b")?.textContent`)) === TITLE,
  );

  // -- lines and states --
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the failed line" });
  check("a thread with a pending question wants you", (await page.eval(lineState(ids.asks))) === "wants");
  await page.waitFor(
    `document.querySelector('[data-cow-line="${ids.asks}"] .cow-wh')?.textContent.startsWith("Which colour?")`,
    { label: "the question on its line" },
  );
  check("its line shows the question it asked", true);
  check("a thread whose last turn failed is failed", true);
  const order = await page.eval(
    `JSON.stringify([...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine))`,
  );
  check(
    "lines follow the tree: child, its child, next child",
    order === JSON.stringify([ids.quiet, ids.fails, ids.asks]),
    order,
  );
  const indent = await page.eval(
    `["${ids.quiet}", "${ids.fails}"].map((id) => parseFloat(getComputedStyle(document.querySelector('[data-cow-line="' + id + '"] .cow-nm')).paddingLeft))`,
  );
  check("a grandchild is indented under its parent", indent[1] > indent[0], indent.join(" < "));
  check("a finished child is done, though nobody opened it", (await page.eval(lineState(ids.quiet))) === "done");
  await page.waitFor(
    `document.querySelector('[data-cow-line="${ids.quiet}"] .cow-wh')?.textContent === "ok"`,
    { label: "what the finished child reported" },
  );
  check("its line still says what it reported", true);
  const numbered = JSON.parse(
    await page.eval(`JSON.stringify(Object.fromEntries([...${ROOT}.querySelectorAll("[data-cow-line]")]
      .map((el) => [el.dataset.cowLine, el.querySelector(".cow-qn")?.textContent ?? ""])))`),
  );
  const queueSize = await page.eval(`document.querySelectorAll("[data-cow-queue]").length`);
  check(
    "the queue numbers the question and the failure, not the finished child",
    numbered[ids.asks] !== "" && numbered[ids.fails] !== "" && numbered[ids.quiet] === "",
    JSON.stringify(numbered),
  );
  check(
    "every queue entry has a number on the page",
    Object.values(numbered).filter(Boolean).sort().join() ===
      Array.from({ length: queueSize }, (_, i) => String(i + 1)).join(),
  );
  await page.waitFor(
    `document.querySelector('[data-cow-line="${ids.fails}"] .cow-wh')?.textContent.includes("cow-test-no-such-model")`,
    { label: "what the failed line says" },
  );
  check("a line says what its thread last said", true);
  await shot("overview-light");

  // -- moving --
  await page.key("g");
  await page.key("g");
  check("g g goes to the top", await page.eval(isCursor(ids.quiet)));
  await page.key("j");
  check("j moves down", await page.eval(isCursor(ids.fails)));
  await page.key("k");
  check("k moves up", await page.eval(isCursor(ids.quiet)));
  await page.key("ArrowDown");
  await page.key("ArrowDown");
  check("arrows move too", await page.eval(isCursor(ids.asks)));
  await page.key("ArrowUp");
  check("arrow up moves up", await page.eval(isCursor(ids.fails)));
  await page.key("G");
  check("G goes to the bottom", await page.eval(isCursor(ids.asks)));

  // -- the queue --
  const queue = JSON.parse(
    await page.eval(
      `JSON.stringify([...document.querySelectorAll("[data-cow-queue]")].map((el) => el.dataset.cowQueue))`,
    ),
  );
  // Start on the finished child, which is not in the queue.
  await page.key("g");
  await page.key("g");
  await page.key("Tab");
  check("Tab jumps to the first ask", await page.eval(isCursor(queue[0])));
  await page.key("Tab");
  check("Tab again jumps to the next ask, wrapping", await page.eval(isCursor(queue[1 % queue.length])));
  await page.key("Tab", { shift: true });
  check("Shift+Tab jumps back", await page.eval(isCursor(queue[0])));
  await page.key("G");
  await page.key(String(queue.length));
  check("a digit jumps to that ask", await page.eval(isCursor(queue[queue.length - 1])));

  // -- hints --
  await page.key("g");
  await page.key("g");
  await page.key("f");
  check("f enters hint mode", (await page.eval(mode)) === "hint");
  await shot("hints");
  const hints = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const labels = [...document.querySelectorAll("[data-cow-hint-label]")].map((el) => el.dataset.cowHintLabel);
      const targets = [...${ROOT}.querySelectorAll("[data-cow-hint]")];
      return { labels, targets: targets.length, asks: targets.findIndex((el) => el.dataset.cowLine === "${ids.asks}") };
    })())`),
  );
  check(
    "every line and action in view has a hint",
    hints.labels.length === hints.targets && new Set(hints.labels).size === hints.targets,
    `${hints.labels.length} hints`,
  );
  for (const letter of hints.labels[hints.asks]) await page.key(letter);
  check(
    "typing a hint activates it",
    (await page.eval(isCursor(ids.asks))) && (await page.eval(mode)) === "normal",
  );
  await page.key("f");
  await page.key("Escape");
  check(
    "Escape cancels hint mode",
    (await page.eval(mode)) === "normal" && (await page.eval(isCursor(ids.asks))),
  );

  // -- legend --
  await page.key("?");
  check("? shows the legend and key map", await page.eval(`!!document.querySelector("[data-cow-help]")`));
  await shot("legend");
  await page.key("j");
  check("keys do nothing behind the legend", await page.eval(isCursor(ids.asks)));
  await page.key("Escape");
  check("Escape closes the legend", await page.eval(`!document.querySelector("[data-cow-help]")`));

  // -- the chat pane, and keys that must not leak into it --
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.asks}"`, {
    label: "the chat pane",
  });
  await page.waitFor(`document.querySelector("[data-cow-chat]")?.textContent.includes("Which colour?")`, {
    label: "the question in the embedded chat",
  });
  check("Enter opens the selected thread's real chat beside the overview", true);
  check(
    "opening the chat leaves the cursor in the overview",
    await page.eval(`!document.activeElement?.closest("[data-cow-chat]")`),
  );
  await shot("pane");
  for (const key of ["1", "2", "y", "x", "j", "k"]) await page.key(key);
  await sleep(1500);
  const stillAsking = (await api(`/threads?threadIds=${ids.asks}&limit=1`))[0].hasPendingInteraction;
  check("digits and letters in the overview do not answer the chat's question", stillAsking);
  await page.key("Escape");
  check(
    "Escape closes the pane and the cursor is where it was",
    (await page.eval(`!document.querySelector("[data-cow-pane]")`)) &&
      (await page.eval(`${cursorId} !== null`)),
  );

  await page.key("m");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.main}"`, {
    label: "Main's chat",
  });
  check("m opens Main's chat", true);
  await sleep(1500);
  check(
    "the chat does not take the keyboard by itself",
    await page.eval(`!document.activeElement?.closest("[data-cow-chat]")`),
  );
  await page.key("m");
  await page.waitFor(`!!document.activeElement?.closest("[data-cow-chat]")`, {
    label: "focus inside the chat",
    timeout: 5000,
  });
  check("m again puts the caret in the chat", true);
  await page.type("jk1");
  await sleep(300);
  check(
    "typing in the chat's own composer works normally",
    await page.eval(`document.querySelector("[data-cow-chat]").textContent.includes("jk1")`),
  );
  for (let i = 0; i < 3; i += 1) await page.key("Backspace");
  await page.key("Escape");
  check(
    "Escape leaves the chat but keeps the pane",
    (await page.eval(`!document.activeElement?.closest("[data-cow-chat]")`)) &&
      (await page.eval(`!!document.querySelector("[data-cow-pane]")`)),
  );
  await page.key("Escape");
  check("Escape again closes the pane", await page.eval(`!document.querySelector("[data-cow-pane]")`));

  // -- say, and a state change arriving live --
  await page.key("g");
  await page.key("g");
  await page.key("I");
  const toLine = await page.eval(`document.querySelector(".cow-prompt label")?.textContent`);
  check("I addresses the selected thread, and says so", toLine === `to thread · ${TITLE}`, toLine);
  await page.key("Escape");
  check("Escape cancels say", (await page.eval(mode)) === "normal");

  // -- a line changing state live, and reading a reply --
  await page.key("I");
  await page.type("ping");
  await page.key("Enter");
  await page.waitFor(`${lineState(ids.quiet)} === "running"`, { label: "the line running", timeout: 30_000 });
  check("a state change shows live: a line starts running", true);
  await page.waitFor(`${lineState(ids.quiet)} === "done"`, { label: "the line finishing", timeout: 120_000 });
  check("a state change shows live: it finishes and is done, not waiting on you", true);
  check("the line kept its place and the cursor", await page.eval(isCursor(ids.quiet)));
  check(
    "a finished child stays out of the queue",
    await page.eval(`!document.querySelector('[data-cow-queue="${ids.quiet}"]')`),
  );

  const cursorBefore = await page.eval(cursorId);
  const note = `cow e2e jk12 ${Date.now()}`;
  await page.key("i");
  const toMain = await page.eval(`document.querySelector(".cow-prompt label")?.textContent`);
  check("i addresses Main, and says so", toMain === `to Main · ${TITLE}`, toMain);
  await page.type(note);
  check(
    "typing in the say input works normally",
    (await page.eval(`document.querySelector("[data-cow-say]")?.value`)) === note,
  );
  await shot("say");
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-message]")?.textContent.startsWith("said to")`, {
    label: "the sent notice",
  });
  await page.waitFor(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState === "running"`, {
    label: "Main running",
    timeout: 30_000,
  });
  check("a state change shows live: Main starts running", true);
  await page.waitFor(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState === "wants"`, {
    label: "Main's unread reply",
    timeout: 120_000,
  });
  check("a state change shows live: Main's unread reply wants you", true);
  check("live updates keep the cursor", (await page.eval(cursorId)) === cursorBefore);
  const timeline = JSON.stringify(await api(`/threads/${ids.main}/timeline`));
  check("the say message arrived in Main", timeline.includes(note));

  // -- Main's unread reply is in the queue, and reading it clears it --
  const mainNumber = await page.eval(
    `document.querySelector('[data-cow-queue="${ids.main}"] .cow-qn')?.textContent ?? ""`,
  );
  check("Main's unread reply is in the queue", mainNumber !== "", mainNumber);
  await page.key(mainNumber);
  check("its queue number puts the cursor on the heading", await page.eval(isCursor(ids.main)));
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.main}"`, {
    label: "Main's chat from the heading",
  });
  await page.waitFor(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState === "done"`, {
    label: "Main read",
    timeout: 30_000,
  });
  check("opening Main's chat reads the reply, and it leaves the queue", await page.eval(`!document.querySelector('[data-cow-queue="${ids.main}"]')`));
  await page.key("Escape");
  await page.key("j");
  check("j leaves the heading for the first line", await page.eval(isCursor(ids.quiet)));

  // -- themes and a narrow window --
  const paper = `getComputedStyle(${ROOT}).backgroundColor`;
  const light = await page.eval(paper);
  await page.colorScheme("dark");
  const dark = await page.eval(paper);
  await shot("overview-dark");
  check("light and dark themes differ", light === "rgb(245, 241, 232)" && dark === "rgb(24, 23, 20)", `${light} / ${dark}`);
  await page.colorScheme("light");
  await page.resize(700, 800);
  const narrow = JSON.parse(
    await page.eval(`JSON.stringify({
      next: getComputedStyle(document.querySelector(".cow-ln .cow-nx")).display,
      overflow: ${ROOT}.scrollWidth <= ${ROOT}.clientWidth,
      queueAbove: document.querySelector(".cow-side").getBoundingClientRect().top < document.querySelector(".cow-main").getBoundingClientRect().top,
    })`),
  );
  await shot("narrow");
  check(
    "a narrow window folds the next move into the line and puts the queue on top",
    narrow.next === "none" && narrow.overflow && narrow.queueAbove,
    JSON.stringify(narrow),
  );
  // bb remounts the page when it changes layout, so start from the top.
  await page.key("j");
  check("keys still work in a narrow window", await page.eval(isCursor(ids.fails)));
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.fails}"`, {
    label: "the chat pane in a narrow window",
  });
  const paneWidth = await page.eval(
    `document.querySelector("[data-cow-pane]").getBoundingClientRect().width / ${ROOT}.clientWidth`,
  );
  await shot("narrow-pane");
  check("in a narrow window the chat takes the page", paneWidth > 0.9, paneWidth.toFixed(2));
  await page.key("Escape");
  check("Escape closes it there too", await page.eval(`!document.querySelector("[data-cow-pane]")`));
  await page.resize(1440, 900);

  // -- changing Main --
  await page.key("M");
  await page.waitFor(`${screen} === "picker"`, { label: "the picker again" });
  check("M reopens the picker", true);
  await page.key("Escape");
  check("Escape keeps the current Main", (await page.eval(screen)) === "overview");

  check("no console errors", page.consoleErrors.length === 0, page.consoleErrors.join(" | "));
  // bb polls services of its own that may be down; only cow's requests count.
  const failedRequests = page.networkErrors.filter((entry) => entry.includes("/plugins/cow"));
  check("no failed requests to cow", failedRequests.length === 0, failedRequests.join(" | "));
  if (page.networkErrors.length > failedRequests.length) {
    console.log(`note: ${page.networkErrors.length - failedRequests.length} failed requests of bb's own, e.g. ${page.networkErrors[0]}`);
  }
  page.close();

  // -- put things back --
  await rpc("main_choose", { projectId: PROJECT, threadId: before.mains[PROJECT] ?? null });
  if (before.currentProjectId && before.currentProjectId !== PROJECT) {
    await rpc("main_choose", {
      projectId: before.currentProjectId,
      threadId: before.mains[before.currentProjectId] ?? null,
    });
  }
  if (!flag("keep")) {
    for (const id of Object.values(ids)) {
      await bb("thread", "archive", id);
      // Archiving leaves a thread that is waiting on its question running.
      await fetch(`${BB}/api/v1/threads/${id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    }
    console.log(`archived ${Object.values(ids).length} fixture threads`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
