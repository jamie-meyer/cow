// End-to-end check of the cow page against a running bb.
//
// It drives a separate headless Chrome (never your own bb window) and makes
// its own fixture threads, titled "cow test", on the cheapest model. It writes
// only to those threads, and it answers, stops and archives only those. It
// archives them all when it finishes. The permission requests it grants are
// for `echo` and for writing one small file under /tmp, which it removes.
// It also runs `bb cow` against the same fixtures.
//
// Choosing a Main records it on the server as where a new cow window starts.
// The check puts that record back at once, each time, for the fixtures'
// project only, and no window that is already open is moved by it. A Main
// you choose in another project while it runs is left alone.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { connect, newTab, sleep } from "./cdp.mjs";

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
/** Tell a fixture something as another thread would (Main, say), or as the user. */
async function tellAs(sender, id, text) {
  const env = { ...process.env };
  if (sender === null) delete env.BB_THREAD_ID;
  else env.BB_THREAD_ID = sender;
  await run("bb", ["thread", "tell", id, text, "--json"], { env });
}
/** Run `bb cow …`; a refusal is an answer here, not an error. */
async function cow(...argv) {
  try {
    const { stdout, stderr } = await run("bb", ["cow", ...argv]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
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
  "You are a test fixture for a bb plugin. Every time you receive a message, this one included, ask " +
  'the user one multiple-choice question with your question tool: "Which colour?" with the options ' +
  '"red" and "blue". Use no other tools. When the answer arrives, reply with exactly the answer.';
const RUNS =
  "You are a test fixture for a bb plugin. Reply to this first message with exactly: ok. From then " +
  "on, every time you receive a message, run the shell command `sleep 100` with your shell tool and " +
  "then reply with exactly: done";

// bb asks the user for permission only on a turn the user started, and its
// workspace sandbox runs ordinary commands without asking. So the fixture is
// told what to do from the page, and asks to leave the sandbox.
const PERMS = `You are a test fixture for a bb plugin. Reply to this first message with exactly: ok
From then on every message is one instruction:
- "ask: <command>": call your shell tool once with exactly that command and with dangerouslyDisableSandbox set to true. bb then asks the user for permission; that request is what is being tested, so always make the call, even if an earlier one was denied. If it runs, reply with exactly its output. If it is denied, reply with exactly: denied
- "write: <path>": call your file-writing tool once to create a file at exactly that path containing the single word cow. bb may ask the user for permission; always make the call. If it is written, reply with exactly: written. If it is denied, reply with exactly: denied
- anything else: reply with exactly: ok
Never retry a denied call within the same message, and never use any other tool.`;

async function spawn({ prompt, parent, model = MODEL, permissionMode }) {
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
    ...(permissionMode ? ["--permission-mode", permissionMode] : []),
  );
  return thread.id;
}

const FIXTURES = ["main", "quiet", "asks", "fails", "runs", "perms"];

/**
 * Main; a quiet child; a child that asks a question; a grandchild that
 * fails; a child that can be made to run; a child that asks for permission.
 * With --state, fixtures made by an earlier run are used again.
 */
async function fixtures() {
  const ids = STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const missing = FIXTURES.filter((name) => !ids[name]);
  if (missing.length > 0 && (!PROJECT || !ENVIRONMENT)) throw new Error("--project and --environment are required");
  const make = async (name, options) => {
    if (ids[name]) return;
    ids[name] = await spawn(options);
    if (STATE) writeFileSync(STATE, JSON.stringify(ids));
  };
  await make("main", { prompt: QUIET });
  await make("quiet", { prompt: QUIET, parent: ids.main });
  await make("asks", { prompt: ASKS, parent: ids.main });
  // A model that does not exist fails its first turn at once, for free.
  await make("fails", { prompt: QUIET, parent: ids.quiet, model: "cow-test-no-such-model" });
  await make("runs", { prompt: RUNS, parent: ids.main });
  await make("perms", { prompt: PERMS, parent: ids.main, permissionMode: "accept-edits" });
  return ids;
}

/** Bring fixtures from an earlier run back to where a run starts. */
async function reset(ids) {
  for (const id of Object.values(ids)) {
    const [thread] = await api(`/threads?threadIds=${id}&limit=1`);
    if (thread.archivedAt) await bb("thread", "unarchive", id);
    await rpc("park_set", { threadId: id, park: null });
    await rpc("archive_note_set", { threadId: id, note: null });
    await rpc("dismissal_set", { threadId: id, dismissal: null });
  }
  for (const interaction of await api(`/threads/${ids.perms}/interactions`)) {
    if (interaction.status === "pending") await bb("thread", "interactions", "deny", interaction.id, ids.perms);
  }
  // A fixture that has just been made is still on its way to its first question.
  const asks = await waitForThread(ids.asks, (t) => t.hasPendingInteraction || t.status === "idle", "settled");
  if (!asks.hasPendingInteraction) await bb("thread", "tell", ids.asks, "again");
  // A message from the user clears whatever bb refused this fixture in an earlier run.
  await waitForThread(ids.perms, (t) => t.status === "idle" && !t.hasPendingInteraction, "idle");
  await tellAs(null, ids.perms, "reset");
  await sleep(2000);
}

/** The project of each fixture, by name: where its Main is stored. */
const PROJECT_OF = {};

async function assertOurs(ids) {
  for (const [name, id] of Object.entries(ids)) {
    const [thread] = await api(`/threads?threadIds=${id}&limit=1`);
    if (!thread || thread.title !== TITLE) throw new Error(`${id} is not a "${TITLE}" fixture`);
    PROJECT_OF[name] = thread.projectId;
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

/** Puts the server's record of Mains back exactly as it was before this run. */
let restoreStored = async () => undefined;

async function main() {
  const ids = await fixtures();
  await assertOurs(ids);
  await reset(ids);
  const before = await rpc("main_state", null);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  // Only what this run can have changed is put back or compared: the Main of
  // the fixtures' project, and which project was chosen last. Any other
  // project's Main is somebody's own choice, perhaps made during the run.
  const ourProjects = [...new Set(Object.values(PROJECT_OF))];
  const ours = (state) =>
    JSON.stringify([ourProjects.map((project) => state.mains[project] ?? null), state.currentProjectId]);
  restoreStored = async () => {
    let now = await rpc("main_state", null);
    for (const project of ourProjects) {
      if (now.mains[project] !== before.mains[project]) {
        now = await rpc("main_choose", { projectId: project, threadId: before.mains[project] ?? null });
      }
    }
    const current = before.currentProjectId;
    const movedByUs = now.currentProjectId === null || ourProjects.includes(now.currentProjectId);
    if (current && now.currentProjectId !== current && movedByUs && now.mains[current]) {
      await rpc("main_choose", { projectId: current, threadId: now.mains[current] });
    }
  };

  await waitForThread(ids.main, (t) => t.status === "idle", "idle");
  await waitForThread(ids.quiet, (t) => t.status === "idle", "idle");
  await waitForThread(ids.asks, (t) => t.hasPendingInteraction, "asking");
  await waitForThread(ids.fails, (t) => t.status === "error", "failed");
  await waitForThread(ids.runs, (t) => t.status === "idle", "idle");
  await waitForThread(ids.perms, (t) => t.status === "idle" && !t.hasPendingInteraction, "idle");

  const page = await connect(PORT, "");
  const shot = async (name, from = page) => {
    if (SHOTS) await from.shot(join(SHOTS, `${name}.png`));
  };
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `sessionStorage.removeItem("cow:test-clock-offset-ms");`,
  });
  // A window that has never shown a Main, as a new one is.
  await page.goto(`${BB}/plugins/cow/main`);
  await page.eval(`sessionStorage.removeItem("cow:main"); true`);
  await page.resize(1440, 900);
  await page.colorScheme("light");
  await page.goto(`${BB}/plugins/cow/main`);
  await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page" });

  // -- choosing Main --
  const heading = `(document.querySelector(".cow-mainline")?.dataset.cowLine ?? null)`;
  const chooseMain = async (tab, id) => {
    if ((await tab.eval(screen)) === "overview") await tab.key("M");
    await tab.waitFor(`${screen} === "picker"`, { label: "the picker" });
    await tab.key("g");
    await tab.key("g");
    for (let i = 0; i < 400 && !(await tab.eval(isCursor(id))); i += 1) await tab.key("j");
    if ((await tab.eval(screen)) !== "picker" || !(await tab.eval(isCursor(id)))) {
      throw new Error("the fixture is not in the picker; nothing was chosen");
    }
    await tab.key("Enter");
    await tab.waitFor(`${screen} === "overview" && ${heading} === "${id}"`, { label: "the overview" });
  };
  if ((await page.eval(screen)) === "overview") {
    const startsOn = await page.eval(heading);
    check(
      "a new window starts from the Main chosen most recently",
      startsOn === before.mains[before.currentProjectId],
      String(startsOn),
    );
    await page.key("M");
  }
  await page.waitFor(`${screen} === "picker"`, { label: "the picker" });
  check("M, or having no Main, shows the picker", true);
  await shot("picker");
  const first = await page.eval(cursorId);
  await page.key("j");
  const second = await page.eval(cursorId);
  await page.key("k");
  check("picker: j and k move the cursor", first !== second && (await page.eval(cursorId)) === first);
  await chooseMain(page, ids.main);
  const stored = await rpc("main_state", null);
  check(
    "picker: Enter makes the selected thread Main, and the choice is stored for its project",
    stored.mains[PROJECT_OF.main] === ids.main && stored.currentProjectId === PROJECT_OF.main,
  );
  check(
    "Main is the page heading",
    (await page.eval(`document.querySelector(".cow-crumbs b")?.textContent`)) === TITLE,
  );

  // -- each window keeps its own Main --
  const other = await newTab(PORT);
  await other.resize(1200, 800);
  await other.goto(`${BB}/plugins/cow/main`);
  await other.waitFor(`${screen} === "overview"`, { label: "the second window" });
  check(
    "a second window starts from the Main chosen last, here the fixture",
    (await other.eval(heading)) === ids.main,
  );
  await restoreStored();
  await chooseMain(other, ids.runs);
  await restoreStored();
  await sleep(2000);
  check(
    "choosing another Main in the second window does not move the first",
    (await page.eval(heading)) === ids.main && (await other.eval(heading)) === ids.runs,
    `${await page.eval(heading)} / ${await other.eval(heading)}`,
  );
  await shot("second-window", other);
  await page.goto(`${BB}/plugins/cow/main`);
  await other.goto(`${BB}/plugins/cow/main`);
  await page.waitFor(`${screen} === "overview"`, { label: "the first window reloaded" });
  await other.waitFor(`${screen} === "overview"`, { label: "the second window reloaded" });
  check(
    "each window keeps its own Main through a reload, whatever is stored",
    (await page.eval(heading)) === ids.main && (await other.eval(heading)) === ids.runs,
    `${await page.eval(heading)} / ${await other.eval(heading)}`,
  );
  const restored = await rpc("main_state", null);
  check(
    "what the run changed in the stored Mains is back as it was",
    ours(restored) === ours(before),
    JSON.stringify(restored),
  );
  check("the second window has no console errors", other.consoleErrors.length === 0, other.consoleErrors.join(" | "));
  await other.close();

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
  const listedOrder = JSON.parse(order);
  check(
    "lines follow the tree: child, its child, next child; then the two done ones",
    JSON.stringify(listedOrder.slice(0, 3)) === JSON.stringify([ids.quiet, ids.fails, ids.asks]) &&
      JSON.stringify(listedOrder.slice(3).sort()) === JSON.stringify([ids.runs, ids.perms].sort()),
    order,
  );
  const indent = await page.eval(
    `["${ids.quiet}", "${ids.fails}"].map((id) => parseFloat(getComputedStyle(document.querySelector('[data-cow-line="' + id + '"] .cow-nm')).paddingLeft))`,
  );
  check("a grandchild is indented under its parent", indent[1] > indent[0], indent.join(" < "));
  check("a finished child is done, though nobody opened it", (await page.eval(lineState(ids.quiet))) === "done");
  await page.waitFor(
    `document.querySelector('[data-cow-line="${ids.quiet}"] .cow-wh')?.textContent === ${JSON.stringify(
      // Whatever it said last: a fixture from an earlier run may not have said "ok".
      (await api(`/threads/${ids.quiet}/output`)).output.trim(),
    )}`,
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
  check("G goes to the bottom", await page.eval(isCursor(listedOrder[listedOrder.length - 1])));

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
      const off = [...${ROOT}.querySelectorAll(".cow-vb.cow-off")];
      return {
        labels,
        targets: targets.length,
        asks: targets.findIndex((el) => el.dataset.cowLine === "${ids.asks}"),
        lineLabels: labels.slice(0, targets.filter((el) => el.dataset.cowLine !== undefined).length),
        offVerbs: off.length,
        offVerbsHinted: off.filter((el) => el.hasAttribute("data-cow-hint")).length,
      };
    })())`),
  );
  check(
    "every line and usable action in view has a hint",
    hints.labels.length === hints.targets && new Set(hints.labels).size === hints.targets,
    `${hints.labels.length} hints`,
  );
  check(
    "every line's hint is a single letter",
    hints.lineLabels.length >= 5 && hints.lineLabels.every((label) => label.length === 1),
    hints.lineLabels.join(" "),
  );
  check(
    "a greyed-out verb takes no hint",
    hints.offVerbs > 0 && hints.offVerbsHinted === 0,
    `${hints.offVerbs} greyed out`,
  );
  for (const letter of hints.labels[hints.asks]) await page.key(letter);
  check(
    "typing a hint activates it, with one key",
    hints.labels[hints.asks].length === 1 &&
      (await page.eval(isCursor(ids.asks))) &&
      (await page.eval(mode)) === "normal",
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
  await page.type("reply with exactly: ok");
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
  const note = `jk12 note ${Date.now()}`;
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

  // -- verbs: select a line, then press the verb --
  const DAY = 86_400_000;
  const verbOff = (name) =>
    `document.querySelector('[data-cow-verb="${name}"]')?.classList.contains("cow-off")`;
  const verbText = (name) => `document.querySelector('[data-cow-verb="${name}"]')?.textContent ?? ""`;
  const message = `document.querySelector("[data-cow-message]")?.textContent ?? ""`;
  const confirmLabel = `document.querySelector("[data-cow-confirm] label")?.textContent ?? ""`;
  const promptInput = (name) => `document.querySelector('[data-cow-input="${name}"]')`;
  const onPage = (id) => `!!document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const inQueue = (id) => `!!document.querySelector('[data-cow-queue="${id}"]')`;
  const select = async (id) => {
    await page.key("g");
    await page.key("g");
    for (let i = 0; i < 40 && !(await page.eval(isCursor(id))); i += 1) await page.key("j");
    if (!(await page.eval(isCursor(id)))) throw new Error(`could not select ${id}`);
  };
  const facts = async (id) => (await api(`/threads?threadIds=${id}&limit=1`))[0];
  const parkNote = async (id) => (await rpc("notes_list", { threadIds: [id] })).parks[id] ?? null;
  const archiveNote = async (id) => (await rpc("notes_list", { threadIds: [id] })).archives[id] ?? null;
  const busy = (t) => ["active", "starting", "stopping", "pending"].includes(t.status);
  const setClock = (offsetMs) =>
    page.eval(`sessionStorage.setItem("cow:test-clock-offset-ms", "${offsetMs}");
      window.dispatchEvent(new Event("cow:test-clock")); true`);
  const off = async (...names) => {
    const states = [];
    for (const name of names) states.push(await page.eval(verbOff(name)));
    return states;
  };
  const ALL = ["answer", "park", "resume", "stop", "archive", "undo"];

  await select(ids.quiet);
  check(
    "verb bar: a done line with an open thread under it can only be parked",
    JSON.stringify(await off(...ALL)) === JSON.stringify([true, false, true, true, true, true]),
    JSON.stringify(await off(...ALL)),
  );
  await select(ids.fails);
  check(
    "verb bar: a failed line can be parked or archived",
    JSON.stringify(await off(...ALL)) === JSON.stringify([true, false, true, true, false, true]),
    JSON.stringify(await off(...ALL)),
  );
  await page.key("a");
  check(
    "a verb that does not apply says why and does nothing",
    (await page.eval(message)).startsWith("cannot answer") && (await page.eval(mode)) === "normal",
    await page.eval(message),
  );
  await page.key("u");
  check("u with nothing to undo says so", (await page.eval(message)).startsWith("nothing to undo"));

  // -- answer --
  await select(ids.asks);
  check("verb bar: a line with a question can be answered", (await page.eval(verbOff("answer"))) === false);
  await page.key("a");
  await page.waitFor(
    `document.querySelector('[data-cow-answer="${ids.asks}"] [data-cow-answer-prompt]')?.textContent.includes("Which colour?")`,
    { label: "the question card" },
  );
  const card = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const el = document.querySelector("[data-cow-answer]");
      const line = document.querySelector('.cow-main [data-cow-line="${ids.asks}"]');
      return {
        options: [...el.querySelectorAll("[data-cow-answer-option]")].map((o) => o.textContent),
        underLine: line.nextElementSibling === el,
        text: !!el.querySelector('[data-cow-input="answer"]'),
      };
    })())`),
  );
  check(
    "a opens the question under its line, options numbered",
    card.underLine && card.options.length === 2 && card.options[0].includes("red") && card.options[1].includes("blue"),
    JSON.stringify(card),
  );
  check("the page is in answer mode", (await page.eval(mode)) === "answer");
  await shot("answer");
  const chosen = `JSON.stringify([...document.querySelectorAll("[data-cow-answer-option]")].map((o) => o.dataset.cowChosen === "true"))`;
  await page.key("1");
  check("a digit chooses an option", (await page.eval(chosen)) === "[true,false]", await page.eval(chosen));
  await sleep(1500);
  check("choosing does not send: the question is still pending", (await facts(ids.asks)).hasPendingInteraction);
  for (const key of ["j", "x", "p", "e", "u", "r"]) await page.key(key);
  check(
    "other keys do nothing while the question is open",
    (await page.eval(isCursor(ids.asks))) && (await page.eval(mode)) === "answer",
  );
  await page.key("2");
  check("another digit replaces the choice", (await page.eval(chosen)) === "[false,true]", await page.eval(chosen));
  if (card.text) {
    await page.key("3");
    await page.type("12 jx");
    check(
      "the free text field takes digits and letters as text",
      (await page.eval(`${promptInput("answer")}.value`)) === "12 jx" &&
        (await page.eval(chosen)) === "[false,false]",
    );
  }
  await page.key("Escape");
  await sleep(1000);
  check(
    "Escape cancels: the card closes and nothing was sent",
    (await page.eval(`!document.querySelector("[data-cow-answer]")`)) &&
      (await page.eval(mode)) === "normal" &&
      (await facts(ids.asks)).hasPendingInteraction,
  );
  await page.key("a");
  await page.waitFor(`document.querySelectorAll("[data-cow-answer-option]").length === 2`, {
    label: "the question card again",
  });
  await page.key("Enter");
  check(
    "Enter with nothing chosen sends nothing and says why",
    (await page.eval(`document.querySelector("[data-cow-answer-note]")?.textContent ?? ""`)).includes("choose an option"),
  );
  await page.key("2");
  await page.key("Enter");
  await waitForThread(ids.asks, (t) => !t.hasPendingInteraction, "answered", 30_000);
  check("Enter sends the chosen answer: bb reports the question resolved", true);
  await page.waitFor(`!${inQueue(ids.asks)}`, { label: "the line leaving the queue" });
  check("the answered line leaves the queue", true);
  await page.waitFor(
    `document.querySelector('.cow-main [data-cow-line="${ids.asks}"] .cow-wh')?.textContent === "blue"`,
    { label: "the fixture repeating the answer", timeout: 120_000 },
  );
  check("the fixture thread received the answer and replied with it", true);
  check("answering kept the cursor on the line", await page.eval(isCursor(ids.asks)));

  // -- permission requests --
  // Said from the page, so the turn is the user's and bb asks instead of refusing.
  const sayTo = async (id, text) => {
    await select(id);
    await page.key("I");
    await page.type(text);
    await page.key("Enter");
  };
  const lineText = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"] .cow-wh')?.textContent ?? "")`;
  const lineNext = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"] .cow-nx')?.textContent ?? "")`;
  const cardOpen = `!!document.querySelector("[data-cow-answer]")`;
  const actions = `JSON.stringify([...document.querySelectorAll("[data-cow-permission-action]")].map((o) => o.dataset.cowPermissionAction))`;
  const answerNote = `(document.querySelector("[data-cow-answer-note]")?.textContent ?? "")`;
  /** The newest decision bb recorded on the thread's requests. */
  const lastDecision = async (id) => {
    const events = await api(`/threads/${id}/events?types=system/interaction/lifecycle&limit=20&order=desc`);
    return events.map((event) => event.data?.interaction).find((interaction) => interaction?.resolution)?.resolution ?? null;
  };

  // -- blocked on a permission: bb refused without asking --
  // Told by Main, as under cow, so no person started the turn and bb refuses by itself.
  const blockedCard = `document.querySelector('[data-cow-blocked="${ids.perms}"]')`;
  const blockedMessage = `(document.querySelector('[data-cow-input="blocked-message"]')?.value ?? null)`;
  const blockedChosen = `JSON.stringify([...document.querySelectorAll("[data-cow-blocked-action]")].map((o) => o.dataset.cowChosen === "true"))`;
  const dismissal = async (id) => (await rpc("notes_list", { threadIds: [id] })).dismissals[id] ?? null;
  const userRows = async (id) =>
    (await api(`/threads/${id}/timeline`)).rows.filter((row) => row.kind === "conversation" && row.role === "user");
  const blockedPath = `/tmp/cow-test-blocked-${Date.now()}/cow.txt`;

  await tellAs(ids.main, ids.perms, `write: ${blockedPath}`);
  await page.waitFor(`${lineState(ids.perms)} === "blocked"`, { label: "the blocked line", timeout: 120_000 });
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest after the refusal", 60_000);
  check(
    "a file change bb refused on a turn Main started: no request was raised, and the file was not written",
    !(await facts(ids.perms)).hasPendingInteraction && !existsSync(blockedPath),
  );
  check(
    "the line is blocked on a permission and says what was refused and what to do",
    (await page.eval(lineText(ids.perms))).startsWith(`bb refused to change ${blockedPath}`) &&
      (await page.eval(lineNext(ids.perms))) === "ask again: press a",
    `${await page.eval(lineText(ids.perms))} / ${await page.eval(lineNext(ids.perms))}`,
  );
  check(
    "it is in the queue, with what was refused",
    (await page.eval(`document.querySelector('[data-cow-queue="${ids.perms}"] p')?.textContent ?? ""`)) ===
      `bb refused to change ${blockedPath}`,
  );
  await shot("blocked-line");
  await select(ids.perms);
  check("verb bar: a blocked line can be answered", (await page.eval(verbOff("answer"))) === false);
  await page.key("a");
  await page.waitFor(`!!${blockedCard}`, { label: "the blocked card" });
  const fileRefusal = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const el = ${blockedCard};
      const line = document.querySelector('.cow-main [data-cow-line="${ids.perms}"]');
      return {
        underLine: line.nextElementSibling === el,
        count: el.dataset.cowBlockedCount,
        path: el.querySelector("[data-cow-refusal-path]")?.textContent,
        added: el.querySelector(".cow-diff-add")?.textContent.trim(),
        actions: [...el.querySelectorAll("[data-cow-blocked-action]")].map((o) => o.dataset.cowBlockedAction),
        numbers: [...el.querySelectorAll("[data-cow-answer-option] kbd")].map((k) => k.textContent).join(""),
        text: el.textContent,
      };
    })())`),
  );
  check(
    "a opens the refusal under the line: the file, its diff, and why bb did not ask",
    fileRefusal.underLine &&
      fileRefusal.count === "1" &&
      fileRefusal.path === blockedPath &&
      fileRefusal.added === "+cow" &&
      fileRefusal.text.includes("only on a turn that a person started"),
    JSON.stringify(fileRefusal),
  );
  check(
    "it offers three choices, numbered: ask again as me, carry on without it, dismiss",
    JSON.stringify(fileRefusal.actions) === JSON.stringify(["ask_again", "carry_on", "dismiss"]) && fileRefusal.numbers === "123",
    JSON.stringify(fileRefusal.actions),
  );
  await shot("blocked-card");
  await page.key("Enter");
  check("Enter with nothing chosen does nothing and says why", (await page.eval(answerNote)).includes("choose an option"));
  const rowsBefore = (await userRows(ids.perms)).length;
  await page.key("2");
  await sleep(1500);
  check(
    "a digit only marks the choice and shows the message cow would send; nothing is sent",
    (await page.eval(blockedChosen)) === "[false,true,false]" &&
      (await page.eval(blockedMessage))?.includes("I will not grant it") &&
      (await page.eval(blockedMessage))?.endsWith(`change the file ${blockedPath}`) &&
      (await userRows(ids.perms)).length === rowsBefore,
    await page.eval(blockedMessage),
  );
  await shot("blocked-carry-on");
  await page.key("Escape");
  check(
    "Escape closes the card and sends nothing: the line stays blocked",
    !(await page.eval(`!!${blockedCard}`)) && (await page.eval(lineState(ids.perms))) === "blocked",
  );
  await page.key("a");
  await page.waitFor(`!!${blockedCard}`, { label: "the blocked card again" });
  await page.key("2");
  await page.key("Enter");
  await page.waitFor(`${lineState(ids.perms)} !== "blocked"`, { label: "the line no longer blocked", timeout: 60_000 });
  const carryOn = (await userRows(ids.perms)).at(-1);
  check(
    "carry on without it: the message goes to the thread as the user, and the line is no longer blocked",
    carryOn?.initiator === "user" && carryOn.text.includes("I will not grant it") && carryOn.text.endsWith(`change the file ${blockedPath}`),
    JSON.stringify(carryOn?.text),
  );
  check("nothing was granted: the file was not written", !existsSync(blockedPath));
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest after carrying on", 60_000);

  // A refused command: dismiss it, take that back, then ask again as the user.
  await tellAs(ids.main, ids.perms, "ask: echo blocked cow");
  await page.waitFor(`${lineText(ids.perms)}.startsWith("bb refused to run: echo blocked cow")`, {
    label: "the refused command on its line",
    timeout: 120_000,
  });
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest after the second refusal", 60_000);
  check(
    "a command bb refused the same way blocks the line again",
    (await page.eval(lineState(ids.perms))) === "blocked" && !(await facts(ids.perms)).hasPendingInteraction,
  );
  await select(ids.perms);
  await page.key("a");
  await page.waitFor(`!!${blockedCard}`, { label: "the card for the command" });
  check(
    "the card shows the exact command",
    (await page.eval(`${blockedCard}.querySelector("[data-cow-refusal-command]")?.textContent.trim()`)) === "echo blocked cow",
  );
  const rowsBeforeDismiss = (await userRows(ids.perms)).length;
  await page.key("3");
  await page.key("Enter");
  await page.waitFor(`${lineState(ids.perms)} === "done"`, { label: "the dismissed line" });
  check(
    "dismiss clears the blocked state and tells the thread nothing",
    (await dismissal(ids.perms)) !== null &&
      !(await page.eval(inQueue(ids.perms))) &&
      (await userRows(ids.perms)).length === rowsBeforeDismiss,
  );
  check("verb bar: the dismissal can be undone", (await page.eval(verbText("undo"))).includes("undo dismiss"));
  await page.key("u");
  check("u says what it will undo", (await page.eval(confirmLabel)).includes("undo dismissing"), await page.eval(confirmLabel));
  await page.key("y");
  await page.waitFor(`${lineState(ids.perms)} === "blocked"`, { label: "the dismissal undone" });
  check("undone, the line is blocked again", (await dismissal(ids.perms)) === null && (await page.eval(inQueue(ids.perms))));

  await select(ids.perms);
  await page.key("a");
  await page.waitFor(`!!${blockedCard}`, { label: "the card, to ask again" });
  await page.key("1");
  await sleep(500);
  const askAgain = await page.eval(blockedMessage);
  check(
    "ask again as me shows its message first: it names the command and says why",
    askAgain?.endsWith("echo blocked cow") && askAgain.includes("was not started by a person"),
    askAgain,
  );
  await page.key("e");
  await page.type(" ");
  check(
    "e puts the caret in the message, where keys type and choose nothing",
    (await page.eval(blockedMessage)) === `${askAgain} ` && (await page.eval(blockedChosen)) === "[true,false,false]",
  );
  await page.key("Backspace");
  await page.key("Escape");
  check(
    "Escape there goes back to the choices and keeps the card",
    (await page.eval(`!!${blockedCard}`)) && (await page.eval(`document.activeElement?.tagName`)) !== "TEXTAREA",
  );
  await shot("blocked-ask-again");
  await page.key("Enter");
  await waitForThread(ids.perms, (t) => t.hasPendingInteraction, "asking for permission after ask again", 120_000);
  const asked = (await userRows(ids.perms)).at(-1);
  check(
    "ask again as me: the message went as the user, and bb now raises a real permission request",
    asked?.initiator === "user" && asked.text === askAgain,
    JSON.stringify(asked?.text),
  );
  await page.waitFor(`${lineText(ids.perms)}.startsWith("permission to run: echo blocked cow")`, {
    label: "the request on its line",
  });
  check(
    "the line now wants you, with the request, and the blocked card has closed",
    (await page.eval(lineState(ids.perms))) === "wants" && !(await page.eval(`!!${blockedCard}`)),
  );
  await page.key("a");
  await page.waitFor(`!!document.querySelector('[data-cow-answer="${ids.perms}"] [data-cow-permission="command"]')`, {
    label: "the permission card for the retried command",
  });
  check(
    "a opens the ordinary permission card for exactly that command",
    (await page.eval(`document.querySelector("[data-cow-permission-command]")?.textContent.trim()`)) === "echo blocked cow",
  );
  await shot("blocked-request");
  await page.key("1");
  await page.key("Enter");
  await waitForThread(ids.perms, (t) => !t.hasPendingInteraction, "allowed after ask again", 30_000);
  await page.waitFor(`${lineText(ids.perms)} === "blocked cow"`, { label: "the retried command running", timeout: 120_000 });
  const ranRow = (await api(`/threads/${ids.perms}/timeline`)).rows.findLast((row) => row.command === "echo blocked cow");
  check(
    "granted, the command that bb had refused runs",
    ranRow?.status === "completed" && ranRow.output.trim() === "blocked cow" && (await lastDecision(ids.perms))?.decision === "allow_once",
    JSON.stringify({ status: ranRow?.status, output: ranRow?.output }),
  );
  check(
    "the line is done and out of the queue",
    (await page.eval(lineState(ids.perms))) === "done" && !(await page.eval(inQueue(ids.perms))),
  );
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest", 60_000);

  await sayTo(ids.perms, "ask: echo cow");
  await waitForThread(ids.perms, (t) => t.hasPendingInteraction, "asking for permission", 60_000);
  await page.waitFor(`${lineText(ids.perms)}.startsWith("permission to run: echo cow")`, {
    label: "the permission request on its line",
  });
  check(
    "a permission request is its own kind of ask: the line says what it is for and how to decide",
    (await page.eval(lineState(ids.perms))) === "wants" &&
      (await page.eval(lineNext(ids.perms))) === "grant or deny: press a",
    await page.eval(lineNext(ids.perms)),
  );
  check(
    "its queue entry says it is a permission request, and for what",
    (await page.eval(`document.querySelector('[data-cow-queue="${ids.perms}"] p')?.textContent ?? ""`)) ===
      "permission to run: echo cow",
  );
  await page.key("a");
  await page.waitFor(`!!document.querySelector('[data-cow-answer="${ids.perms}"] [data-cow-permission="command"]')`, {
    label: "the permission card",
  });
  const permCard = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const el = document.querySelector("[data-cow-answer]");
      const line = document.querySelector('.cow-main [data-cow-line="${ids.perms}"]');
      return {
        underLine: line.nextElementSibling === el,
        command: el.querySelector("[data-cow-permission-command]")?.textContent.trim(),
        reason: el.querySelector("[data-cow-permission-reason]")?.textContent ?? "",
        numbers: [...el.querySelectorAll("[data-cow-answer-option] kbd")].map((k) => k.textContent).join(""),
        text: el.textContent,
      };
    })())`),
  );
  check(
    "a opens it under the line with the exact command and why bb asks",
    permCard.underLine && permCard.command === "echo cow" && permCard.reason.includes("outside the sandbox"),
    JSON.stringify(permCard),
  );
  check(
    "it lists what bb offers, numbered: allow once, deny, deny with a message",
    (await page.eval(actions)) === JSON.stringify(["allow_once", "deny", "deny_with_message"]) &&
      permCard.numbers === "123",
    await page.eval(actions),
  );
  check("the card says a decision cannot be undone", permCard.text.includes("cannot be undone"));
  await shot("permission-command");
  await page.key("1");
  await sleep(2000);
  check(
    "one key never grants: a digit only marks the option",
    (await page.eval(chosen)) === "[true,false,false]" && (await facts(ids.perms)).hasPendingInteraction,
    await page.eval(chosen),
  );
  await page.key("Escape");
  await sleep(1000);
  check(
    "Escape closes the card and decides nothing",
    !(await page.eval(cardOpen)) && (await facts(ids.perms)).hasPendingInteraction,
  );
  await page.key("a");
  await page.waitFor(`document.querySelectorAll("[data-cow-permission-action]").length === 3`, {
    label: "the permission card again",
  });
  await page.key("Enter");
  check("Enter with nothing chosen sends nothing and says why", (await page.eval(answerNote)).includes("choose an option"));
  await page.key("1");
  await page.key("Enter");
  await waitForThread(ids.perms, (t) => !t.hasPendingInteraction, "allowed", 30_000);
  check(
    "a digit then Enter allows it once: bb records the decision",
    (await lastDecision(ids.perms))?.decision === "allow_once",
    JSON.stringify(await lastDecision(ids.perms)),
  );
  await page.waitFor(`${lineText(ids.perms)} === "cow"`, { label: "the fixture running the command", timeout: 120_000 });
  check("the thread carries on: the command ran and its line updates live", true);
  check("the card closed and the line left the queue", !(await page.eval(cardOpen)) && !(await page.eval(inQueue(ids.perms))));

  // Denied, with a message.
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest", 60_000);
  await sayTo(ids.perms, "ask: echo moo");
  await waitForThread(ids.perms, (t) => t.hasPendingInteraction, "asking again", 60_000);
  await page.waitFor(`${lineText(ids.perms)}.startsWith("permission to run: echo moo")`, { label: "the second request" });
  await page.key("a");
  await page.waitFor(`document.querySelectorAll("[data-cow-permission-action]").length === 3`, { label: "its card" });
  await page.key("3");
  check(
    "choosing to deny with a message puts the caret in its text field",
    await page.eval(`document.activeElement === ${promptInput("answer")}`),
  );
  await page.key("Enter");
  check("it needs the message first", (await page.eval(answerNote)).includes("type what to tell it"));
  const why = `not now 12 jx ${Date.now()}`;
  await page.type(why);
  check(
    "the message takes digits and letters as text",
    (await page.eval(`${promptInput("answer")}.value`)) === why && (await facts(ids.perms)).hasPendingInteraction,
  );
  await page.key("Enter");
  await waitForThread(ids.perms, (t) => !t.hasPendingInteraction, "denied", 30_000);
  check("Enter denies it: bb records the denial", (await lastDecision(ids.perms))?.decision === "deny");
  await page.waitFor(`document.querySelector("[data-cow-message]")?.textContent === "denied, and told why"`, {
    label: "the denial notice",
  });
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest after the denial", 120_000);
  const deniedRows = (await api(`/threads/${ids.perms}/timeline`)).rows;
  const moo = deniedRows.filter((row) => row.workKind === "command" && row.command === "echo moo").pop();
  check(
    "the command did not run, and the message reached the thread",
    moo?.approvalStatus === "denied" && !moo.output && deniedRows.some((row) => row.role === "user" && row.text === why),
    JSON.stringify(moo),
  );

  // A file change, and a grant wider than the one request.
  const scratch = `/tmp/cow-test-${Date.now()}`;
  await sayTo(ids.perms, `write: ${scratch}/cow.txt`);
  await waitForThread(ids.perms, (t) => t.hasPendingInteraction, "asking to write", 60_000);
  await page.waitFor(`${lineText(ids.perms)}.startsWith("permission to change a file in ${scratch}")`, {
    label: "the file request on its line",
  });
  await page.key("a");
  await page.waitFor(`!!document.querySelector("[data-cow-permission-diff]")`, { label: "the diff on the card" });
  const fileCard = JSON.parse(
    await page.eval(`JSON.stringify({
      file: document.querySelector("[data-cow-permission-file]")?.dataset.cowPermissionFile,
      diff: document.querySelector("[data-cow-permission-diff]")?.textContent ?? "",
      added: document.querySelector("[data-cow-permission-diff] .cow-diff-add")?.textContent.trim(),
    })`),
  );
  check(
    "a file change shows the file and its diff",
    fileCard.file === `${scratch}/cow.txt` && fileCard.added === "+cow",
    JSON.stringify(fileCard),
  );
  check(
    "it offers the wider grant too, as bb does",
    (await page.eval(actions)) === JSON.stringify(["allow_once", "allow_for_session", "deny", "deny_with_message"]),
    await page.eval(actions),
  );
  await shot("permission-file");
  const confirmBox = `(document.querySelector("[data-cow-permission-confirm]")?.textContent ?? "")`;
  await page.key("2");
  await page.key("Enter");
  await sleep(2000);
  check(
    "a grant wider than the request asks again, naming exactly what is granted",
    (await page.eval(confirmBox)).includes(`read and write anything under ${scratch}`) &&
      (await page.eval(confirmBox)).includes("more than this one request") &&
      (await facts(ids.perms)).hasPendingInteraction,
    await page.eval(confirmBox),
  );
  await shot("permission-wider");
  await page.key("Escape");
  await sleep(1000);
  check(
    "Escape backs out of the wider grant; the card stays and nothing was granted",
    (await page.eval(confirmBox)) === "" && (await page.eval(cardOpen)) && (await facts(ids.perms)).hasPendingInteraction,
  );
  await page.key("2");
  await page.key("Enter");
  await page.key("Enter");
  await waitForThread(ids.perms, (t) => !t.hasPendingInteraction, "granted for the session", 30_000);
  const granted = await lastDecision(ids.perms);
  check(
    "the second Enter grants it: bb records a session grant for exactly those directories",
    granted?.decision === "allow_for_session" && granted.grantedPermissions?.fileSystem?.write?.includes(scratch),
    JSON.stringify(granted),
  );
  await page.waitFor(`${lineText(ids.perms)} === "written"`, { label: "the fixture writing the file", timeout: 120_000 });
  check(
    "the thread carries on and the file is written",
    existsSync(`${scratch}/cow.txt`) && readFileSync(`${scratch}/cow.txt`, "utf8").trim() === "cow",
  );
  rmSync(scratch, { recursive: true, force: true });

  // -- park --
  await select(ids.quiet);
  const afterQuiet = await page.eval(
    `[...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine)
      .find((id) => id !== "${ids.quiet}" && id !== "${ids.fails}") ?? null`,
  );
  await page.key("p");
  check("p asks for a reason", (await page.eval(mode)) === "park" && (await page.eval(`!!${promptInput("park-reason")}`)));
  await page.key("Enter");
  check(
    "a reason is required",
    (await page.eval(`!!document.querySelector("[data-cow-prompt-error]")`)) &&
      (await page.eval(`!!${promptInput("park-reason")}`)),
  );
  const reason = "waiting on jkxpaeu 12";
  await page.type(reason);
  check(
    "typing in the prompt types: no verb or motion fires",
    (await page.eval(`${promptInput("park-reason")}.value`)) === reason &&
      (await page.eval(isCursor(ids.quiet))) &&
      (await page.eval(mode)) === "park",
  );
  await shot("park-reason");
  await page.key("Enter");
  check("then it asks for the pick-up", await page.eval(`!!${promptInput("park-pickup")}`));
  await page.type("+3x");
  await page.key("Enter");
  check(
    "a pick-up it cannot parse is rejected, not guessed",
    (await page.eval(`document.querySelector("[data-cow-prompt-error]")?.textContent ?? ""`)).includes("not a time") &&
      (await parkNote(ids.quiet)) === null,
  );
  await page.key("Backspace");
  await page.type("d");
  const parkedAt = Date.now();
  await page.key("Enter");
  await page.waitFor(`${lineState(ids.quiet)} === "parked"`, { label: "the parked line" });
  const parked = await parkNote(ids.quiet);
  check(
    "parking keeps a note on the thread: the reason and a date three days on",
    parked?.reason === reason &&
      parked.pickUp.kind === "date" &&
      Math.abs(parked.pickUp.at - parkedAt - 3 * DAY) < 60_000,
    JSON.stringify(parked),
  );
  const shelf = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const line = document.querySelector('.cow-main [data-cow-line="${ids.quiet}"]');
      const all = [...document.querySelectorAll(".cow-main [data-cow-line], .cow-main .cow-sec")];
      return {
        afterShelfHead: all[all.indexOf(line) - 1]?.hasAttribute("data-cow-shelf") === true,
        text: line.textContent,
        under: line.querySelector("[data-cow-under]")?.dataset.cowUnder ?? null,
      };
    })())`),
  );
  check(
    "the parked line is on the shelf with its reason and pick-up",
    shelf.afterShelfHead && shelf.text.includes(reason) && shelf.text.includes("pick up "),
    JSON.stringify(shelf),
  );
  check(
    "its descendant went with it and is counted on its line",
    shelf.under === "1" && !(await page.eval(onPage(ids.fails))) && !(await page.eval(inQueue(ids.fails))),
    JSON.stringify(shelf),
  );
  check("parking does not touch the agent", !(await facts(ids.quiet)).archivedAt);
  check(
    "the cursor went to the next line down that stayed",
    (await page.eval(cursorId)) === afterQuiet,
    `${await page.eval(cursorId)} / ${afterQuiet}`,
  );
  await select(ids.quiet);
  check(
    "verb bar: a parked line can only be resumed",
    JSON.stringify(await off(...ALL)) === JSON.stringify([true, true, false, true, true, false]),
    JSON.stringify(await off(...ALL)),
  );
  await shot("shelf");

  // -- parked work comes back --
  await setClock(3 * DAY - 3_600_000);
  await sleep(500);
  check("before its date, parked work stays out of the queue", !(await page.eval(inQueue(ids.quiet))));
  await setClock(4 * DAY);
  await page.waitFor(inQueue(ids.quiet), { label: "the parked line in the queue" });
  check(
    "when its date arrives it comes back as a queue entry",
    (await page.eval(`document.querySelector('[data-cow-queue="${ids.quiet}"]').textContent`)).includes("pick-up date arrived") &&
      (await page.eval(`document.querySelector('.cow-main [data-cow-line="${ids.quiet}"]').dataset.cowReturned`)) === "true",
  );
  check(
    "verb bar: returned work can be kept, resumed or dropped",
    JSON.stringify(await off("park", "resume", "stop")) === "[false,false,false]" &&
      (await page.eval(verbText("park"))).includes("keep parked") &&
      (await page.eval(verbText("stop"))).includes("drop"),
  );
  await shot("returned");
  const promptLabel = `(document.querySelector(".cow-prompt label")?.textContent ?? "")`;
  const promptHelp = `(document.querySelector(".cow-prompt small")?.textContent ?? "")`;
  await page.key("x");
  check(
    "x on returned work asks for a reason before dropping, and counts what goes with it",
    (await page.eval(`!!${promptInput("archive-reason")}`)) &&
      (await page.eval(promptLabel)).startsWith("drop") &&
      (await page.eval(promptLabel)).includes("the thread under it") &&
      (await page.eval(promptHelp)).includes("stop it for good"),
    `${await page.eval(promptLabel)} / ${await page.eval(promptHelp)}`,
  );
  await page.key("Escape");
  check(
    "Escape cancels the drop",
    (await page.eval(message)) === "not dropped" && !(await facts(ids.quiet)).archivedAt,
  );
  await page.key("p");
  check(
    "p on returned work asks only for a new pick-up",
    (await page.eval(`!!${promptInput("park-pickup")}`)) && (await page.eval(`!${promptInput("park-reason")}`)),
  );
  await page.key("Enter");
  await page.waitFor(`!${inQueue(ids.quiet)}`, { label: "the kept line leaving the queue" });
  const kept = await parkNote(ids.quiet);
  check(
    "keeping it parked keeps the reason and when it was parked",
    kept?.reason === reason && kept.at === parked.at && kept.pickUp.kind === "none",
    JSON.stringify(kept),
  );
  check("kept parked, the line stays on the shelf under the cursor", await page.eval(isCursor(ids.quiet)));
  await setClock(4 * DAY + 28 * DAY + 3_600_000);
  await page.waitFor(inQueue(ids.quiet), { label: "the four-week check" });
  check(
    "with no date it asks again after four weeks",
    (await page.eval(`document.querySelector('[data-cow-queue="${ids.quiet}"]').textContent`)).includes(
      "still parked for 4 weeks: keep, resume, or drop?",
    ),
  );
  const longAge = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const age = document.querySelector('.cow-main [data-cow-line="${ids.quiet}"] .cow-ag');
      return { heavy: age.classList.contains("cow-a3"), pips: age.querySelectorAll(".cow-pips i").length, weight: getComputedStyle(age.querySelector("b")).fontWeight };
    })())`),
  );
  check(
    "a long parked time reads as long: heavy, with one square per full week",
    longAge.heavy && longAge.pips === 4 && Number(longAge.weight) >= 700,
    JSON.stringify(longAge),
  );
  await shot("four-week-check");

  // -- dropping it, and undoing that --
  const dropReason = "no longer wanted 12";
  await page.key("x");
  await page.type(dropReason);
  await page.key("Enter");
  await waitForThread(ids.quiet, (t) => t.archivedAt, "dropped", 15_000);
  check(
    "x, a reason and Enter drop it: archived in bb, with the thread under it",
    !busy(await facts(ids.quiet)) && !!(await facts(ids.fails)).archivedAt,
  );
  check("the reason for dropping is kept on the thread", (await archiveNote(ids.quiet))?.reason === dropReason);
  await page.waitFor(`!${inQueue(ids.quiet)}`, { label: "the dropped line leaving the queue" });
  await page.key("u");
  check(
    "u offers to bring both back",
    (await page.eval(confirmLabel)).includes("undo dropping") &&
      (await page.eval(confirmLabel)).includes("the thread under it"),
    await page.eval(confirmLabel),
  );
  await page.key("y");
  await waitForThread(ids.quiet, (t) => !t.archivedAt, "brought back", 15_000);
  await waitForThread(ids.fails, (t) => !t.archivedAt, "brought back with it", 15_000);
  await page.waitFor(`${lineState(ids.quiet)} === "parked" && ${inQueue(ids.quiet)}`, {
    label: "the dropped line back on the shelf",
  });
  check(
    "undoing a drop restores the thread, the one under it, and its note",
    (await parkNote(ids.quiet))?.reason === reason && (await page.eval(isCursor(ids.quiet))),
  );

  // -- resume, and undo --
  await page.key("r");
  await page.waitFor(`${lineState(ids.quiet)} === "done"`, { label: "the resumed line" });
  check(
    "r resumes: the line and its descendant are back in the tree",
    (await parkNote(ids.quiet)) === null && (await page.eval(onPage(ids.fails))),
  );
  check("resuming sends the agent nothing", !busy(await facts(ids.quiet)));
  await setClock(0);
  check("verb bar: there is something to undo", (await page.eval(verbText("undo"))).includes("undo resume"));
  await page.key("u");
  check("u shows what it will undo", (await page.eval(confirmLabel)).includes("undo resuming"), await page.eval(confirmLabel));
  await page.key("y");
  await page.waitFor(`${lineState(ids.quiet)} === "parked"`, { label: "the resume undone" });
  check(
    "undoing a resume puts it back on the shelf with its note, under the cursor",
    (await parkNote(ids.quiet))?.reason === reason && (await page.eval(isCursor(ids.quiet))),
  );
  await page.key("u");
  check("u then offers the step before", (await page.eval(confirmLabel)).includes("undo keeping"), await page.eval(confirmLabel));
  await page.key("Escape");
  await page.key("r");
  await page.waitFor(`${lineState(ids.quiet)} === "done"`, { label: "the line resumed again" });

  // -- archive, and undo --
  await select(ids.fails);
  const afterFails = await page.eval(
    `(() => { const all = [...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine);
      return all[all.indexOf("${ids.fails}") + 1] ?? all[all.indexOf("${ids.fails}") - 1]; })()`,
  );
  const archiveReason = (id) =>
    `(document.querySelector('.cow-main [data-cow-line="${id}"] [data-cow-archive-reason]')?.textContent ?? "")`;
  const reasonValue = `${promptInput("archive-reason")}?.value`;
  await page.key("e");
  check(
    "e asks for a reason, in one step",
    (await page.eval(mode)) === "archive" &&
      (await page.eval(`!!${promptInput("archive-reason")}`)) &&
      (await page.eval(promptLabel)).startsWith("archive"),
    await page.eval(promptLabel),
  );
  await page.key("Escape");
  check("Escape cancels", (await page.eval(message)) === "not archived" && !(await facts(ids.fails)).archivedAt);
  const reasonGiven = "superseded by jkxy 12";
  await page.key("e");
  await page.type(reasonGiven);
  check(
    "typing the reason types: no verb or motion fires",
    (await page.eval(reasonValue)) === reasonGiven && (await page.eval(isCursor(ids.fails))),
  );
  await shot("archive-reason");
  await page.key("Enter");
  await waitForThread(ids.fails, (t) => t.archivedAt, "archived", 15_000);
  check("Enter archives the thread in bb", true);
  await page.waitFor(`${archiveReason(ids.fails)}.includes("${reasonGiven}")`, { label: "the reason on the Done line" });
  check(
    "the reason is stored in cow's note on the thread and shown on its line under Done",
    (await archiveNote(ids.fails))?.reason === reasonGiven && (await page.eval(lineState(ids.fails))) === "done",
  );
  await shot("archived-with-reason");
  check(
    "the cursor went to the next line down",
    (await page.eval(cursorId)) === afterFails,
    `${await page.eval(cursorId)} / ${afterFails}`,
  );
  await page.key("u");
  check(
    "u offers to unarchive it, and says the reason is kept",
    (await page.eval(confirmLabel)).includes("undo archiving") && (await page.eval(confirmLabel)).includes("its reason is kept"),
    await page.eval(confirmLabel),
  );
  await page.key("y");
  await waitForThread(ids.fails, (t) => !t.archivedAt, "unarchived", 15_000);
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the unarchived line" });
  check("undoing an archive unarchives the thread, under the cursor", await page.eval(isCursor(ids.fails)));
  check(
    "undone, the line no longer shows the reason, but the note is kept",
    (await page.eval(archiveReason(ids.fails))) === "" && (await archiveNote(ids.fails))?.reason === reasonGiven,
  );
  await page.key("e");
  check("archiving it again offers the kept reason", (await page.eval(reasonValue)) === reasonGiven);
  await page.key("Enter");
  await waitForThread(ids.fails, (t) => t.archivedAt, "archived again", 15_000);
  await page.waitFor(`${archiveReason(ids.fails)}.includes("${reasonGiven}")`, { label: "the reason shown again" });
  check("redone, the reason is on the line again", true);
  await page.key("u");
  await page.key("y");
  await waitForThread(ids.fails, (t) => !t.archivedAt, "unarchived again", 15_000);
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the line back again" });
  await page.key("e");
  for (let i = 0; i < reasonGiven.length; i += 1) await page.key("Backspace");
  check("the reason can be cleared", (await page.eval(reasonValue)) === "");
  await page.key("Enter");
  await waitForThread(ids.fails, (t) => t.archivedAt, "archived without a reason", 15_000);
  await page.waitFor(`${lineState(ids.fails)} === "done"`, { label: "the line under Done" });
  check(
    "Enter on an empty line archives without a reason",
    (await archiveNote(ids.fails)) === null && (await page.eval(archiveReason(ids.fails))) === "",
  );
  await page.key("u");
  await page.key("y");
  await waitForThread(ids.fails, (t) => !t.archivedAt, "unarchived a last time", 15_000);
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the line back a last time" });

  // -- stop, and parking a running thread --
  await select(ids.runs);
  check("verb bar: a line at rest cannot be stopped", (await page.eval(verbOff("stop"))) === true);
  await page.key("I");
  await page.type("go");
  await page.key("Enter");
  await waitForThread(ids.runs, busy, "running", 30_000);
  await page.waitFor(`${verbOff("stop")} === false`, { label: "stop becoming available" });
  check("verb bar: a running line can be stopped", true);
  await page.key("x");
  check(
    "x asks first, and says it cannot be undone",
    (await page.eval(confirmLabel)).includes("cannot be undone"),
    await page.eval(confirmLabel),
  );
  await page.key("j");
  await sleep(1000);
  check(
    "any key but y leaves it running, and the key does nothing else",
    busy(await facts(ids.runs)) && (await page.eval(isCursor(ids.runs))) && (await page.eval(message)) === "not stopped",
  );
  await page.key("p");
  await page.type("busy");
  await page.key("Enter");
  await page.type("+2w");
  await page.key("Enter");
  check(
    "parking a running thread asks whether to stop it",
    (await page.eval(confirmLabel)).includes("stop it and park?"),
    await page.eval(confirmLabel),
  );
  await page.key("n");
  check("declining leaves it running and not parked", busy(await facts(ids.runs)) && (await parkNote(ids.runs)) === null);
  await page.key("x");
  await page.key("y");
  await waitForThread(ids.runs, (t) => !busy(t), "stopped", 30_000);
  check("x then y stops the turn", true);
  await page.waitFor(`${verbOff("stop")} === true`, { label: "stop greying out again" });
  check("stopping kept the cursor on the line", await page.eval(isCursor(ids.runs)));
  await page.key("I");
  await page.type("go");
  await page.key("Enter");
  await waitForThread(ids.runs, busy, "running again", 30_000);
  await page.waitFor(`${verbOff("stop")} === false`, { label: "the line running again" });
  await page.key("p");
  await page.type("long job");
  await page.key("Enter");
  await page.type("+2w");
  await page.key("Enter");
  await page.key("y");
  await page.waitFor(`${lineState(ids.runs)} === "parked"`, { label: "the running line parked" });
  await waitForThread(ids.runs, (t) => !busy(t), "stopped by parking", 30_000);
  check("y stops it and parks it", (await parkNote(ids.runs))?.reason === "long job");

  // -- the CLI: the same verbs for an agent, and the page following along --
  const help = await cow("help");
  check(
    "bb cow help lists the commands",
    help.code === 0 && ["status", "archive", "park", "resume"].every((name) => help.stdout.includes(`bb cow ${name}`)),
    help.stdout,
  );
  const status = await cow("status", "--main", ids.main);
  // A thread's own line starts with its place in the queue, or a gap, and then its state.
  const statusLine = (id) =>
    status.stdout.split("\n").find((line) => line.includes(`(${id})`) && /^[ \d]{4}(wants|blocked|running|stuck|parked|failed|done) /.test(line)) ?? "";
  check(
    "bb cow status gives one line per thread with its state, and the parked shelf",
    status.code === 0 &&
      status.stdout.startsWith(`Main: ${TITLE} (${ids.main})`) &&
      /^ *\d+  failed /.test(statusLine(ids.fails)) &&
      /^ +parked .*long job/.test(statusLine(ids.runs)) &&
      status.stdout.includes("Parked (1)"),
    status.stdout,
  );
  const statusJson = JSON.parse((await cow("status", "--main", ids.main, "--json")).stdout);
  check(
    "with --json it is the same overview as data: lines, queue and shelf",
    statusJson.ok === true &&
      statusJson.main.id === ids.main &&
      statusJson.parked.map((line) => line.id).join() === ids.runs &&
      statusJson.queue.some((line) => line.id === ids.fails) &&
      statusJson.threads.find((line) => line.id === ids.fails)?.depth === 1,
    JSON.stringify(statusJson).slice(0, 400),
  );
  check("status output is bounded", status.stdout.length < 20_000, String(status.stdout.length));

  const resumed = await cow("resume", ids.runs);
  await page.waitFor(`${lineState(ids.runs)} !== "parked"`, { label: "the page following a CLI resume" });
  check(
    "bb cow resume removes the note, and the page shows it without a reload",
    resumed.code === 0 && (await parkNote(ids.runs)) === null,
    resumed.stderr,
  );
  const noReason = await cow("park", ids.runs);
  const badDate = await cow("park", ids.runs, "--reason", "set aside by the cli", "--pickup", "31 Feb");
  check(
    "bb cow park needs a reason, and rejects a date that does not exist, as the page does",
    noReason.code !== 0 && /--reason/.test(noReason.stderr) && badDate.code !== 0 && /there is no 31 Feb/.test(badDate.stderr) &&
      (await parkNote(ids.runs)) === null,
    `${noReason.stderr} / ${badDate.stderr}`,
  );
  const cliParkedAt = Date.now();
  const cliParked = await cow("park", ids.runs, "--reason", "set aside by the cli", "--pickup", "+3d");
  await page.waitFor(
    `${lineState(ids.runs)} === "parked" && ${lineText(ids.runs)}.includes("set aside by the cli")`,
    { label: "the page following a CLI park" },
  );
  const cliNote = await parkNote(ids.runs);
  check(
    "bb cow park records the reason and pick-up, and the line moves to the shelf without a reload",
    cliParked.code === 0 &&
      cliNote?.reason === "set aside by the cli" &&
      cliNote.pickUp.kind === "date" &&
      Math.abs(cliNote.pickUp.at - (cliParkedAt + 3 * DAY)) < 60_000,
    `${cliParked.stderr} ${JSON.stringify(cliNote)}`,
  );
  await shot("cli-parked");
  const again = await cow("park", ids.runs, "--reason", "twice");
  const notParked = await cow("resume", ids.quiet);
  const missing = await cow("resume", "thr_cow_test_no_such_thread");
  check(
    "the page's rules hold: no parking twice, no resuming what is not parked, no unknown thread",
    again.code !== 0 && /already parked/.test(again.stderr) &&
      notParked.code !== 0 && /it is not parked/.test(notParked.stderr) &&
      missing.code !== 0 && /there is no thread/.test(missing.stderr),
    `${again.stderr} / ${notParked.stderr} / ${missing.stderr}`,
  );
  const openUnder = await cow("archive", ids.quiet, "--reason", "should be refused");
  check(
    "bb cow archive refuses a line with open threads under it, and exits non-zero",
    openUnder.code !== 0 && /threads under it are still open/.test(openUnder.stderr) && !(await facts(ids.quiet)).archivedAt,
    openUnder.stderr,
  );
  const asJson = await cow("archive", ids.quiet, "--json");
  check(
    "with --json a refusal is an error object",
    asJson.code !== 0 && JSON.parse(asJson.stdout).error?.code === "cannot_archive",
    asJson.stdout,
  );
  const archived = await cow("archive", ids.fails, "--reason", "cleaned up by the cli");
  await waitForThread(ids.fails, (t) => t.archivedAt, "archived by the CLI", 15_000);
  await page.waitFor(`${archiveReason(ids.fails)}.includes("cleaned up by the cli")`, {
    label: "the page following a CLI archive",
  });
  check(
    "bb cow archive archives with the reason, and the line shows it under Done without a reload",
    archived.code === 0 &&
      (await archiveNote(ids.fails))?.reason === "cleaned up by the cli" &&
      (await page.eval(lineState(ids.fails))) === "done",
    archived.stderr,
  );
  await shot("cli-archived");
  const twice = await cow("archive", ids.fails);
  check("archiving it twice is refused", twice.code !== 0 && /already archived/.test(twice.stderr), twice.stderr);
  // Back to where the page's own checks left things.
  await bb("thread", "unarchive", ids.fails);
  await rpc("archive_note_set", { threadId: ids.fails, note: null });
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the line back after the CLI checks" });

  // -- one theme for the page and the chat beside it --
  // What the page and the chat each draw with, read where they are drawn.
  const look = `JSON.stringify((() => {
    const root = ${ROOT};
    const chat = document.querySelector("[data-cow-chat]");
    const probe = document.createElement("div");
    probe.style.cssText = "background: var(--background); color: var(--foreground); font-family: var(--font-sans)";
    document.body.append(probe);
    const token = getComputedStyle(probe);
    const said = [...chat.querySelectorAll("p, li, span")].find((el) => el.textContent.trim() === "ok") ?? chat;
    const out = {
      pageBackground: getComputedStyle(root).backgroundColor,
      themeBackground: token.backgroundColor,
      pageInk: getComputedStyle(root).color,
      themeInk: token.color,
      pageFont: getComputedStyle(root).fontFamily,
      chatFont: getComputedStyle(said).fontFamily,
      themeFont: token.fontFamily,
    };
    probe.remove();
    return out;
  })())`;
  const matches = (seen) =>
    seen.pageBackground === seen.themeBackground &&
    seen.pageInk === seen.themeInk &&
    seen.pageFont === seen.themeFont &&
    seen.chatFont === seen.themeFont;
  await page.key("m");
  await page.waitFor(`document.querySelector("[data-cow-chat]")?.textContent.includes("ok")`, { label: "Main's chat" });
  const active = {};
  for (const scheme of ["light", "dark"]) {
    await page.colorScheme(scheme);
    active[scheme] = JSON.parse(await page.eval(look));
    await shot(`theme-active-${scheme}`);
  }
  check(
    "the page draws with bb's theme, as the chat does: same paper, ink and type, light and dark",
    matches(active.light) && matches(active.dark) && active.light.pageBackground !== active.dark.pageBackground,
    JSON.stringify(active),
  );
  const themes = await bb("theme", "list");
  check(
    "cow's own look is offered as a bb theme",
    JSON.stringify(themes).includes("plugin:cow:cow"),
  );
  // Switching bb's theme would change every open window, so the cow theme is
  // tried in this window alone, the way bb's settings preview a theme.
  const cowTheme = readFileSync(new URL("../themes/cow.css", import.meta.url), "utf8");
  const themeBefore = await page.eval(`document.getElementById("bb-app-theme")?.textContent ?? null`);
  if (themeBefore === null) {
    check("the cow theme could be previewed in this window", false, "bb's theme stylesheet was not found");
  } else {
    await page.eval(`document.getElementById("bb-app-theme").textContent = ${JSON.stringify(cowTheme)}; true`);
    const cow = {};
    for (const scheme of ["light", "dark"]) {
      await page.colorScheme(scheme);
      cow[scheme] = JSON.parse(await page.eval(look));
      await shot(`theme-cow-${scheme}`);
    }
    check(
      "with the cow theme the page and the chat share paper, ink and a serif face, light and dark",
      matches(cow.light) &&
        matches(cow.dark) &&
        cow.light.chatFont.includes("Iowan Old Style") &&
        // It differs from the theme bb had, unless bb was already running the cow theme.
        (active.light.chatFont.includes("Iowan Old Style") ||
          cow.light.pageBackground !== active.light.pageBackground) &&
        cow.light.pageBackground !== cow.dark.pageBackground,
      JSON.stringify(cow),
    );
    await select(ids.fails);
    await page.key("p");
    await shot("park-dark");
    await page.key("Escape");
    await page.eval(`document.getElementById("bb-app-theme").textContent = ${JSON.stringify(themeBefore)}; true`);
  }
  await page.key("Escape");
  check("the pane closes after the theme checks", await page.eval(`!document.querySelector("[data-cow-pane]")`));

  // -- a narrow window --
  await page.colorScheme("light");
  await page.resize(700, 800);
  const narrow = JSON.parse(
    await page.eval(`JSON.stringify({
      next: getComputedStyle(document.querySelector(".cow-ln .cow-nx")).display,
      shelf: !!document.querySelector('.cow-main [data-cow-line="${ids.runs}"][data-cow-state="parked"]'),
      verbs: document.querySelector(".cow-foot").scrollWidth <= document.querySelector(".cow-foot").clientWidth,
      overflow: ${ROOT}.scrollWidth <= ${ROOT}.clientWidth,
      queueAbove: document.querySelector(".cow-side").getBoundingClientRect().top < document.querySelector(".cow-main").getBoundingClientRect().top,
    })`),
  );
  await shot("narrow");
  check(
    "a narrow window folds the next move into the line and puts the queue on top",
    narrow.next === "none" && narrow.overflow && narrow.queueAbove && narrow.shelf && narrow.verbs,
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
  await restoreStored();
  const after = await rpc("main_state", null);
  check("what the run changed in the stored Mains is still as it was", ours(after) === ours(before), JSON.stringify(after));
  if (!flag("keep")) {
    for (const id of Object.values(ids)) {
      await rpc("park_set", { threadId: id, park: null });
      await rpc("archive_note_set", { threadId: id, note: null });
      await rpc("dismissal_set", { threadId: id, dismissal: null });
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

main().catch(async (error) => {
  console.error(error);
  // Whatever went wrong, the next cow window must start where it did before.
  await restoreStored().catch((cause) => console.error("could not restore the stored Mains", cause));
  process.exit(1);
});
