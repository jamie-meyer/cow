// End-to-end check of the cow page against a running bb.
//
// It drives a separate headless Chrome (never your own bb window) and makes
// its own fixture threads, titled "cow test", on the cheapest model. It writes
// only to those threads, and it answers, stops and archives only those. It
// archives them all when it finishes.
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
const RUNS =
  "You are a test fixture for a bb plugin. Reply to this first message with exactly: ok. From then " +
  "on, every time you receive a message, run the shell command `sleep 100` with your shell tool and " +
  "then reply with exactly: done";

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

/** Main; a quiet child; a child that asks a question; a grandchild that fails; a child that can be made to run. */
async function fixtures() {
  if (STATE && existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8"));
  if (!PROJECT || !ENVIRONMENT) throw new Error("--project and --environment are required");
  const main = await spawn({ prompt: QUIET });
  const quiet = await spawn({ prompt: QUIET, parent: main });
  const asks = await spawn({ prompt: ASKS, parent: main });
  // A model that does not exist fails its first turn at once, for free.
  const fails = await spawn({ prompt: QUIET, parent: quiet, model: "cow-test-no-such-model" });
  const runs = await spawn({ prompt: RUNS, parent: main });
  const ids = { main, quiet, asks, fails, runs };
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
  const restoreCurrentProject = async () => {
    const current = before.currentProjectId;
    if (!current || current === PROJECT || !before.mains[current]) return;
    await rpc("main_choose", { projectId: current, threadId: before.mains[current] });
  };

  await waitForThread(ids.main, (t) => t.status === "idle", "idle");
  await waitForThread(ids.quiet, (t) => t.status === "idle", "idle");
  await waitForThread(ids.asks, (t) => t.hasPendingInteraction, "asking");
  await waitForThread(ids.fails, (t) => t.status === "error", "failed");
  await waitForThread(ids.runs, (t) => t.status === "idle", "idle");

  const page = await connect(PORT, "");
  const shot = async (name) => {
    if (SHOTS) await page.shot(join(SHOTS, `${name}.png`));
  };
  // Keep this tab on the fixture project, so the run neither follows nor
  // depends on whichever project is current in other cow windows.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `sessionStorage.setItem("cow:test-project", ${JSON.stringify(PROJECT)});
      sessionStorage.removeItem("cow:test-clock-offset-ms");`,
  });
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
  if ((await page.eval(screen)) !== "picker" || !(await page.eval(isCursor(ids.main)))) {
    throw new Error("the fixture Main is not in the picker; nothing was chosen");
  }
  await page.key("Enter");
  await page.waitFor(`${screen} === "overview"`, { label: "the overview" });
  // Choosing a Main makes its project the current one for every cow window;
  // hand that back at once.
  await restoreCurrentProject();
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
    "lines follow the tree: child, its child, next child; then the done one",
    order === JSON.stringify([ids.quiet, ids.fails, ids.asks, ids.runs]),
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
  check("G goes to the bottom", await page.eval(isCursor(ids.runs)));

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
    hints.lineLabels.length >= 4 && hints.lineLabels.every((label) => label.length === 1),
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
  const parkNote = async (id) => (await rpc("park_list", { threadIds: [id] })).parks[id] ?? null;
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
  await page.key("x");
  check(
    "x on returned work asks before dropping, and counts what goes with it",
    (await page.eval(confirmLabel)).includes("drop it") &&
      (await page.eval(confirmLabel)).includes("the thread under it"),
    await page.eval(confirmLabel),
  );
  await page.key("n");
  check(
    "any key but y cancels the drop",
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
  await page.key("x");
  await page.key("y");
  await waitForThread(ids.quiet, (t) => t.archivedAt, "dropped", 15_000);
  check(
    "x then y drops it: archived in bb, with the thread under it",
    !busy(await facts(ids.quiet)) && !!(await facts(ids.fails)).archivedAt,
  );
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
  await page.key("e");
  check("e asks before archiving", (await page.eval(confirmLabel)).includes("archive it"));
  await page.key("n");
  check("any key but y cancels", (await page.eval(message)) === "not archived" && !(await facts(ids.fails)).archivedAt);
  await page.key("e");
  await page.key("y");
  await waitForThread(ids.fails, (t) => t.archivedAt, "archived", 15_000);
  check("e then y archives the thread in bb", true);
  await page.waitFor(`${lineState(ids.fails)} === "done"`, { label: "the archived line under Done" });
  check(
    "the cursor went to the next line down",
    (await page.eval(cursorId)) === afterFails,
    `${await page.eval(cursorId)} / ${afterFails}`,
  );
  await page.key("u");
  check("u offers to unarchive it", (await page.eval(confirmLabel)).includes("undo archiving"));
  await page.key("y");
  await waitForThread(ids.fails, (t) => !t.archivedAt, "unarchived", 15_000);
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the unarchived line" });
  check("undoing an archive unarchives the thread, under the cursor", await page.eval(isCursor(ids.fails)));

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

  // -- themes and a narrow window --
  const paper = `getComputedStyle(${ROOT}).backgroundColor`;
  const light = await page.eval(paper);
  await page.colorScheme("dark");
  const dark = await page.eval(paper);
  await shot("overview-dark");
  await select(ids.fails);
  await page.key("p");
  await shot("park-dark");
  await page.key("Escape");
  check("light and dark themes differ", light === "rgb(245, 241, 232)" && dark === "rgb(24, 23, 20)", `${light} / ${dark}`);
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
  await page.eval(`sessionStorage.removeItem("cow:test-project"); true`);
  page.close();

  // -- put things back --
  await rpc("main_choose", { projectId: PROJECT, threadId: before.mains[PROJECT] ?? null });
  await restoreCurrentProject();
  if (!flag("keep")) {
    for (const id of Object.values(ids)) {
      await rpc("park_set", { threadId: id, park: null });
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
