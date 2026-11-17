// End-to-end check of the cow page against a running bb.
//
// It drives a separate headless Chrome (never your own bb window) and makes
// its own fixture threads, titled "cow test", on the cheapest model. It writes
// only to those threads, and it answers, stops and archives only those. It
// archives them all when it finishes. The permission requests it grants are
// for `echo` and for writing one small file under /tmp, which it removes.
// It also runs `bb cow` against the same fixtures, and leaves and removes
// notes of what is next on them.
//
// For asks and briefs it uses three more fixtures under a Main of their own,
// and cow starts two hidden checker threads, titled "cow check", the first
// time: the briefs they audit are kept and used again. While it runs it sets
// cow's checker model and provider, and puts both back as they were.
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
//   --only-raised       only the asks and briefs checks
//   --only-reader       only the reader, projects, asks answered in chat and
//                       chat scrolling: four fixtures, and --environment must
//                       be a checkout of cow, whose files the fixture links to

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
/** Run `bb cow …` as the person; a refusal is an answer here, not an error. */
const cow = (...argv) => cowAs(null, ...argv);
/** Run `bb cow …` as the thread `sender` would, or with null as the person. */
async function cowAs(sender, ...argv) {
  const env = { ...process.env };
  if (sender === null) delete env.BB_THREAD_ID;
  else env.BB_THREAD_ID = sender;
  try {
    const { stdout, stderr } = await run("bb", ["cow", ...argv], { env });
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

const ASKER = `You are a test fixture for a bb plugin. Reply to this first message with exactly: ok
From then on:
- when you receive the message "ask", run this shell command once, exactly as written, and reply with exactly the first line it printed:
  bb cow ask --question "Which colour?" --option red --option "blue::the colder one"
- when you receive a message that starts with "Answer to your question", reply with exactly: GOT <the last line of that message>
- reply to anything else with exactly: ok
Never run anything else, and never ask again by yourself.`;

const FIXTURES = ["main", "quiet", "asks", "fails", "leaf", "runs", "perms", "amain", "asker", "briefer", "pmain", "phead", "pkid", "reader"];
/** The fixtures of the asks and briefs checks: a Main of their own, so they never show under the other one. */
const RAISED = ["amain", "asker", "briefer"];

/**
 * Seven threads on three levels under Main: a quiet child, which heads a
 * group; under it a grandchild that fails, which heads a group of its own;
 * under that a quiet leaf. Then a child that asks a question, a child that
 * can be made to run, and a child that asks for permission. Apart from
 * those, a second Main with two children, for asks and briefs.
 * With --state, fixtures made by an earlier run are used again.
 */
async function fixtures() {
  const ids = STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  const wanted = flag("only-reader") ? READING : FIXTURES;
  const missing = wanted.filter((name) => !ids[name]);
  if (missing.length > 0 && (!PROJECT || !ENVIRONMENT)) throw new Error("--project and --environment are required");
  const make = async (name, options) => {
    if (ids[name] || !wanted.includes(name)) return;
    ids[name] = await spawn(options);
    if (STATE) writeFileSync(STATE, JSON.stringify(ids));
  };
  await make("main", { prompt: QUIET });
  await make("quiet", { prompt: QUIET, parent: ids.main });
  await make("asks", { prompt: ASKS, parent: ids.main });
  // A model that does not exist fails its first turn at once, for free.
  await make("fails", { prompt: QUIET, parent: ids.quiet, model: "cow-test-no-such-model" });
  await make("leaf", { prompt: QUIET, parent: ids.fails });
  await make("runs", { prompt: RUNS, parent: ids.main });
  await make("perms", { prompt: PERMS, parent: ids.main, permissionMode: "accept-edits" });
  await make("amain", { prompt: QUIET });
  await make("asker", { prompt: ASKER, parent: ids.amain });
  await make("briefer", { prompt: QUIET, parent: ids.amain });
  await make("pmain", { prompt: QUIET });
  await make("phead", { prompt: QUIET, parent: ids.pmain });
  await make("pkid", { prompt: QUIET, parent: ids.phead });
  await make("reader", { prompt: READER, parent: ids.pmain, permissionMode: "accept-edits" });
  // Only the fixtures this run uses are acted on.
  return Object.fromEntries(Object.entries(ids).filter(([name]) => wanted.includes(name)));
}

/** Bring fixtures from an earlier run back to where a run starts. */
async function reset(ids) {
  for (const id of Object.values(ids)) {
    const [thread] = await api(`/threads?threadIds=${id}&limit=1`);
    if (thread.archivedAt) await bb("thread", "unarchive", id);
    await rpc("park_set", { threadId: id, park: null });
    await rpc("archive_note_set", { threadId: id, note: null });
    await rpc("dismissal_set", { threadId: id, dismissal: null });
    await rpc("seen_set", { threadId: id, seen: null });
    await cow("next", id, "--clear");
    while ((await cow("todo", "rm", id, "1")).code === 0);
  }
  if (flag("only-reader")) return;
  for (const interaction of await api(`/threads/${ids.perms}/interactions`)) {
    if (interaction.status === "pending") await bb("thread", "interactions", "deny", interaction.id, ids.perms);
  }
  // A fixture that has just been made is still on its way to its first question.
  const asks = await waitForThread(ids.asks, (t) => t.hasPendingInteraction || t.status === "idle", "settled");
  // Told as Main would, so its answer is not a reply addressed to the user.
  if (!asks.hasPendingInteraction) await tellAs(ids.main, ids.asks, "again");
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

// ---- asks and briefs ----------------------------------------------------

/** Puts cow's checker settings back as they were before this run. */
let restoreSettings = async () => undefined;
const plain = async (...argv) => (await run("bb", argv, { env: (({ BB_THREAD_ID: _own, ...rest }) => rest)(process.env) })).stdout;
/** Call cow's RPC; a refusal is an answer here, not an error. */
async function rpcSoft(method, input) {
  const response = await fetch(`${BB}/api/v1/plugins/cow/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.json();
}
const openAsksOf = async (id) => (await rpc("asks_list", { threadId: id })).asks;
const briefOf = async (id) => (await rpc("brief_get", { threadId: id })).record;

const DISPUTED_BRIEF = {
  summary: "Raised the request timeout and ran the test suite.",
  claims: [
    { id: "timeout", text: "The config sets the request timeout to 30 seconds.", label: "checked", evidence: [{ description: "the config file after the change", path: "config.txt" }] },
    {
      id: "tests",
      text: "All 12 tests pass.",
      label: "checked",
      evidence: [{ description: "the last lines of the test run", text: "Ran 12 tests in 3.1s\n11 passed, 1 failed\nFAIL test_login_redirect: expected 302, got 500" }],
    },
  ],
  judgementCalls: [{ text: "Is 30 seconds acceptable for the slowest endpoint?" }],
  notDone: ["The change was not tried against production traffic."],
};
const CLEAN_BRIEF = {
  summary: "Set the retry count.",
  claims: [{ id: "retries", text: "The config sets retries to 2.", label: "checked", evidence: [{ description: "the config file after the change", text: "# service config\nrequest_timeout_seconds = 30\nretries = 2" }] }],
};

/**
 * Bring the three fixtures to where these checks start: no ask open; a brief
 * on `briefer` that a checker disputed and one on `asker` that it did not,
 * both made once and kept; and on the Main a new brief whose check failed,
 * with a judgement call that is open as an ask. A check on a provider that
 * does not exist fails at once and starts no thread.
 */
async function prepareRaised(ids) {
  const dataDir = /Data dir:\s*(\S+)/.exec(await plain("status"))?.[1];
  if (!dataDir) throw new Error("could not find bb's data directory in `bb status`");
  const before = JSON.parse(await plain("plugin", "config", "cow", "--json")).values ?? {};
  const set = async (key, value) => plain("plugin", "config", "cow", ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)]));
  restoreSettings = async () => {
    await set("checkerModel", before.checkerModel);
    await set("checkerProvider", before.checkerProvider);
  };
  await set("checkerModel", MODEL);
  await set("checkerProvider", "claude-code");

  for (const name of RAISED) {
    await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
    for (const ask of await openAsksOf(ids[name])) await cow("ask", "withdraw", ask.id);
  }
  const storage = (id) => {
    const dir = join(dataDir, "thread-storage", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const submit = async (id, brief) => {
    const file = join(storage(id), "brief.json");
    writeFileSync(file, JSON.stringify(brief, null, 2));
    const done = await cowAs(id, "brief", "submit", file, "--wait", "--json");
    if (done.code !== 0) throw new Error(`could not submit a brief for ${id}: ${done.stderr}`);
    return JSON.parse(done.stdout);
  };
  writeFileSync(join(storage(ids.briefer), "config.txt"), "# service config\nrequest_timeout_seconds = 30\nretries = 2\n");
  writeFileSync(join(storage(ids.asker), "proof.txt"), "the plan: ship tonight, roll back by redeploying the previous build\n");
  const checkers = [];
  for (const [id, brief] of [[ids.briefer, DISPUTED_BRIEF], [ids.asker, CLEAN_BRIEF]]) {
    const stored = await briefOf(id);
    if (stored?.check?.runs.some((entry) => entry.status === "done")) continue;
    await submit(id, brief);
    checkers.push(...(await briefOf(id)).check.runs.map((entry) => entry.threadId));
  }
  // Every run starts with both unread.
  for (const id of [ids.briefer, ids.asker]) await rpc("brief_read", { threadId: id, version: (await briefOf(id)).version, read: false });

  const call = JSON.parse((await cowAs(ids.amain, "ask", "--question", "Keep the old endpoint for a week?", "--option", "keep it", "--option", "remove it now", "--json")).stdout).ask;
  await set("checkerProvider", "cow-test-no-such-provider");
  await submit(ids.amain, { summary: "Moved the endpoint.", claims: [{ id: "moved", text: "The endpoint answers at its new path.", label: "inferred" }], judgementCalls: [{ text: "Keep the old endpoint for a week?", askId: call.id }] });
  await set("checkerProvider", "claude-code");
  if (checkers.length > 0) console.log(`checker threads started for the briefs: ${checkers.join(", ")}`);
  return { call };
}

async function raisedChecks(page, ids, shot, chooseMain) {
  const { call } = await prepareRaised(ids);
  const mainLine = `document.querySelector(".cow-mainline")`;
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const doing = (id) =>
    `(() => { const cell = ${lineEl(id)}?.querySelector(".cow-wh")?.cloneNode(true); cell?.querySelector(".cow-nx2")?.remove(); return cell?.textContent ?? ""; })()`;
  const briefMark = (id) => `(${lineEl(id)}?.querySelector("[data-cow-brief]")?.dataset.cowBrief ?? null)`;
  const queued = (id) => `(document.querySelector('[data-cow-queue="${id}"] p')?.textContent ?? null)`;
  const message = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const card = `document.querySelector("[data-cow-ask-card]")`;
  const cardAsk = `(${card}?.dataset.cowAsk ?? null)`;
  const stage = `(${card}?.dataset.cowAskStage ?? null)`;
  const note = `(document.querySelector("[data-cow-answer-note]")?.textContent ?? "").trim()`;
  const chosen = `JSON.stringify([...document.querySelectorAll("[data-cow-ask-card] [data-cow-chosen]")].map((o) => o.dataset.cowAnswerOption))`;
  const sheet = `document.querySelector("[data-cow-sheet]")`;
  const sheetCursor = `(${sheet}?.querySelector(".cow-bf-item.cow-cur")?.dataset.cowBriefItem ?? null)`;
  const select = async (id) => {
    await page.key("g");
    await page.key("g");
    for (let i = 0; i < 20 && !(await page.eval(isCursor(id))); i += 1) await page.key("j");
    if (!(await page.eval(isCursor(id)))) throw new Error(`could not select ${id}`);
  };
  const said = async (id) => (await api(`/threads/${id}/output`)).output ?? "";
  /** What the fixture said last, once it contains `text` (or after two minutes, whatever it is). */
  const got = async (id, text) => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const out = await said(id);
      if (out.includes(text) || Date.now() > deadline) return out;
      await sleep(1000);
    }
  };

  // -- an ask raised by the fixture itself, and two more on the same thread --
  await tellAs(ids.amain, ids.asker, "ask");
  const deadline = Date.now() + 120_000;
  let first = null;
  while (first === null && Date.now() < deadline) {
    [first = null] = await openAsksOf(ids.asker);
    if (first === null) await sleep(1000);
  }
  if (first === null) throw new Error("the fixture never asked");
  await waitForThread(ids.asker, (t) => t.status === "idle", "idle after asking");
  const raise = async (...argv) => JSON.parse((await cowAs(ids.asker, "ask", ...argv, "--json")).stdout).ask;
  const medium = await raise("--question", "Ship it tonight?", "--option", "yes::the launch is unblocked", "--option", "no::it slips a day", "--risk", "medium", "--context", "The migration cannot be rolled back.", "--proof", "proof.txt");
  const high = await raise("--question", "Delete the old table?", "--risk", "high");

  await chooseMain(page, ids.amain);
  await page.waitFor(`!!${lineEl(ids.asker)} && !!${lineEl(ids.briefer)}`, { label: "the asking fixtures' lines" });
  await page.waitFor(`${lineEl(ids.asker)}?.dataset.cowAsks === "3"`, { label: "the three asks on one line" });
  check(
    "a thread with open asks reads as asking you: the oldest question and how many more",
    (await page.eval(lineState(ids.asker))) === "wants" && (await page.eval(doing(ids.asker))) === "asks you: Which colour? (and 2 more)",
    await page.eval(doing(ids.asker)),
  );
  check("an ask raised by a fixture is in the queue", (await page.eval(queued(ids.asker))) === "asks you: Which colour? (and 2 more)", String(await page.eval(queued(ids.asker))));
  check(
    "an ask outranks the brief on the same line, which keeps its mark: the checker disputed nothing",
    (await page.eval(briefMark(ids.asker))) === "clean",
    String(await page.eval(briefMark(ids.asker))),
  );

  // -- briefs on the lines --
  check(
    "a brief with a contradicted claim shows as disputed on its line, with the count",
    (await page.eval(briefMark(ids.briefer))) === "disputed" && (await page.eval(`${lineEl(ids.briefer)}.querySelector("[data-cow-brief]").dataset.cowBriefCount`)) === "1",
    String(await page.eval(briefMark(ids.briefer))),
  );
  check(
    "a finished thread whose brief has a dispute wants you, and is in the queue",
    (await page.eval(lineState(ids.briefer))) === "wants" && (await page.eval(queued(ids.briefer))) === "brief: 1 disputed, 1 judgement call",
    `${await page.eval(lineState(ids.briefer))} / ${await page.eval(queued(ids.briefer))}`,
  );
  check(
    "a failed check shows as failed on the heading, never as clean",
    (await page.eval(`${mainLine}.querySelector("[data-cow-brief]")?.dataset.cowBrief ?? null`)) === "failed",
  );
  await shot("raised-overview");

  // -- answering: the first ask, sent on Enter --
  await select(ids.asker);
  check("the verb bar offers a and b on a line with an ask and a brief", await page.eval(`!document.querySelector('[data-cow-verb="answer"]').classList.contains("cow-off") && !document.querySelector('[data-cow-verb="brief"]').classList.contains("cow-off")`));
  await page.key("a");
  await page.waitFor(`${cardAsk} === "${first.id}"`, { label: "the ask card" });
  const cardText = await page.eval(`${card}.textContent`);
  check(
    "a opens the oldest ask under its line: the question, its options with their detail, and the others listed",
    (await page.eval(`${lineEl(ids.asker)}.nextElementSibling === ${card}`)) &&
      cardText.includes("Which colour?") &&
      cardText.includes("the colder one") &&
      (await page.eval(`${card}.dataset.cowAskCount`)) === "3" &&
      (await page.eval(`${card}.querySelector("[data-cow-ask-others]")?.dataset.cowAskOthers`)) === "2" &&
      cardText.includes("Ship it tonight?"),
    cardText.slice(0, 200),
  );
  check("the ask card is its own mode", (await page.eval(mode)) === "ask");
  await page.key("2");
  check("a digit only marks an option", (await page.eval(chosen)) === '["2"]' && (await openAsksOf(ids.asker)).length === 3);
  await shot("ask-card");
  await page.key("Enter");
  const afterFirst = await got(ids.asker, "GOT");
  check("Enter sends a low-risk answer; the idle fixture receives it and continues", /GOT\s+blue \(option 2\)/.test(afterFirst), JSON.stringify(afterFirst));
  await page.waitFor(`${cardAsk} === "${medium.id}"`, { label: "the next ask in the card" });
  const sentLine = await page.eval(`${card}.querySelector("[data-cow-ask-sent]")?.textContent ?? ""`);
  check(
    "after answering, the card says what was sent, to which thread, and that it cannot be undone; then moves to the next ask",
    sentLine.includes("sent to “cow test”: blue (option 2)") && sentLine.includes("cannot be undone"),
    sentLine,
  );

  // -- the medium-risk ask: restated, then a second Enter --
  const mediumText = await page.eval(`${card}.textContent`);
  const proofHref = await page.eval(`${card}.querySelector('[data-cow-ask-proof="proof.txt"]')?.dataset.cowFile ?? null`);
  check(
    "the card shows the ask's context, its risk, and its proof file as a link",
    mediumText.includes("The migration cannot be rolled back.") && (await page.eval(`${card}.querySelector("[data-cow-ask-risk]")?.dataset.cowAskRisk`)) === "medium" && typeof proofHref === "string" && proofHref.length > 0,
    String(proofHref),
  );
  await page.key("f");
  const proofHint = await page.eval(`[...document.querySelectorAll("[data-cow-hint-label]")].some((tag) => (tag.dataset.cowHintFor ?? "").startsWith("button:proof.txt") && tag.dataset.cowHintIn === "page")`);
  await page.key("Escape");
  check("f puts a hint on the proof link", proofHint);
  await page.key("1");
  await page.key("Enter");
  check(
    "medium risk: the first Enter sends nothing and restates what will be sent, and to whom",
    (await page.eval(stage)) === "restate" &&
      (await page.eval(`${card}.querySelector("[data-cow-ask-said]")?.textContent`)) === "yes (option 1)" &&
      (await page.eval(`${card}.querySelector("[data-cow-ask-restate]")?.textContent ?? ""`)).includes("cow test") &&
      (await openAsksOf(ids.asker)).some((ask) => ask.id === medium.id),
  );
  await shot("ask-restate");
  await page.key("2");
  check("while it is restated, a digit changes nothing", (await page.eval(chosen)) === '["1"]');
  await page.key("Escape");
  check("Escape goes back to the choices, and still sends nothing", (await page.eval(stage)) === "choose" && (await page.eval(chosen)) === '["1"]' && (await openAsksOf(ids.asker)).length === 2);
  await page.key("Enter");
  await page.key("Enter");
  check("the second Enter sends it", /GOT\s+yes \(option 1\)/.test(await got(ids.asker, "GOT yes")), JSON.stringify(await said(ids.asker)));

  // -- the high-risk ask: a word typed --
  await page.waitFor(`${cardAsk} === "${high.id}"`, { label: "the high-risk ask in the card" });
  await page.waitFor(`document.activeElement?.dataset.cowInput === "ask-answer"`, { label: "the caret in the answer field" });
  check("an ask with no options puts the caret in its answer field", true);
  await page.key("Enter");
  check("an empty answer is not sent", (await page.eval(note)).includes("type your answer first"), await page.eval(note));
  await page.type("keep it one more week");
  await page.key("Enter");
  await page.waitFor(`${stage} === "word" && document.activeElement?.dataset.cowInput === "ask-word"`, { label: "the field for the word" });
  await page.key("Enter");
  check("high risk: Enter without the word sends nothing", (await page.eval(note)).includes("type the word send") && (await openAsksOf(ids.asker)).length === 1, await page.eval(note));
  await page.type("send");
  await shot("ask-word");
  await page.key("Enter");
  check("with the word typed, it is sent", /GOT\s+keep it one more week/.test(await got(ids.asker, "GOT keep")), JSON.stringify(await said(ids.asker)));
  await page.waitFor(`!${card}`, { label: "the card closing after the last ask" });
  check(
    "after the last ask the card closes and the page says what was sent",
    (await page.eval(message)).includes("sent to “cow test”: keep it one more week") && (await page.eval(mode)) === "normal",
    await page.eval(message),
  );
  const asked = (await api(`/threads/${ids.asker}/timeline`)).rows.filter((row) => row.kind === "conversation" && row.role === "user").at(-1);
  check("the answer went as a message from the user that quotes the question", asked?.initiator === "user" && asked.text.includes("> Delete the old table?") && asked.text.includes(`(${high.id})`), JSON.stringify(asked?.text));
  await page.waitFor(`${lineEl(ids.asker)}?.dataset.cowAsks === undefined`, { label: "the asks leaving the line" });

  // -- a withdrawn ask disappears live --
  const passing = await raise("--question", "Never mind this one?");
  await page.waitFor(`${doing(ids.asker)} === "asks you: Never mind this one?"`, { label: "a new ask on the line" });
  await select(ids.asker);
  await page.key("a");
  await page.waitFor(`${cardAsk} === "${passing.id}"`, { label: "the card for the passing ask" });
  await cowAs(ids.asker, "ask", "withdraw", passing.id);
  await page.waitFor(`!${card} && ${lineEl(ids.asker)}?.dataset.cowAsks === undefined`, { label: "the withdrawn ask leaving the page" });
  check("a withdrawn ask leaves the line, the queue and its open card at once", (await page.eval(message)).includes("no longer open") && !(await page.eval(doing(ids.asker))).startsWith("asks you"), await page.eval(message));

  // -- a clean brief does not enter the queue --
  await page.waitFor(`${lineEl(ids.asker)}?.dataset.cowReply === ""`, { label: "the fixture's reply on its line", timeout: 60_000 });
  await select(ids.asker);
  await page.key(" ");
  await page.waitFor(`${lineState(ids.asker)} === "done"`, { label: "the asker at rest" });
  check(
    "a thread whose brief checked clean is done, with the mark, and not in the queue",
    (await page.eval(briefMark(ids.asker))) === "clean" && (await page.eval(queued(ids.asker))) === null,
    `${await page.eval(briefMark(ids.asker))} / ${await page.eval(queued(ids.asker))}`,
  );

  // -- the brief, as a sheet --
  await select(ids.briefer);
  const checkedAt = (await briefOf(ids.briefer)).check.startedAt;
  await page.key("b");
  await page.waitFor(`${sheet}?.querySelectorAll("[data-cow-brief-item]").length === 3`, { label: "the brief sheet" });
  const laid = JSON.parse(
    await page.eval(`JSON.stringify({
      covers: ${sheet}.getBoundingClientRect().height >= ${ROOT}.clientHeight - 1 && ${sheet}.getBoundingClientRect().width >= ${ROOT}.clientWidth - 1,
      items: [...${sheet}.querySelectorAll("[data-cow-brief-item]")].map((item) => item.dataset.cowBriefKind + ":" + item.dataset.cowBriefItem),
      sections: [...${sheet}.querySelectorAll("[data-cow-brief-section]")].map((head) => head.dataset.cowBriefSection),
      cursor: ${sheetCursor},
      first: ${sheet}.querySelector("[data-cow-brief-item]").textContent,
      tag: ${sheet}.querySelector("[data-cow-brief-tag]")?.textContent,
      label: ${sheet}.querySelector("[data-cow-brief-item] [data-cow-brief-label]")?.dataset.cowBriefLabel,
      check: ${sheet}.querySelector("[data-cow-brief-check]").dataset.cowBriefCheck,
      checkText: ${sheet}.querySelector("[data-cow-brief-check]").textContent,
      inPanel: !!document.querySelector("[data-cow-pane]"),
    })`),
  );
  check("b opens the brief as a sheet over the whole page, not in a side panel", laid.covers && !laid.inPanel && (await page.eval(mode)) === "brief", JSON.stringify({ covers: laid.covers }));
  check(
    "the sheet is in order: the dispute first, then judgement calls, the other claims, what was left undone, the summary",
    JSON.stringify(laid.items) === '["dispute:claim:tests","call:call:0","claim:claim:timeout"]' && JSON.stringify(laid.sections) === '["disputes","calls","claims","not-done","summary"]' && laid.cursor === "claim:tests",
    JSON.stringify(laid.items),
  );
  check(
    "a dispute shows the claim, the agent's own label as the agent's words, what the evidence shows, and the checker's verdict",
    laid.tag === "contradicted" && laid.label === "checked" && laid.first.includes("the agent says“checked”") && laid.first.includes("its own word, not a check") && laid.first.includes("the evidence shows") && laid.first.includes("not supported"),
    laid.first.slice(0, 260),
  );
  check("the sheet says what the check was: how many runs, of which model, on what", laid.check === "checked" && laid.checkText.startsWith(`Audited by 1 run of ${MODEL}.`), laid.checkText);
  await shot("brief-sheet");
  await page.key("l");
  const evidence = await page.eval(`${sheet}.querySelector('[data-cow-brief-item="claim:tests"] [data-cow-brief-evidence]')?.textContent ?? ""`);
  check("l opens a claim's evidence in place", evidence.includes("11 passed, 1 failed") && evidence.includes("an excerpt chosen by the agent"), evidence.slice(0, 120));
  await page.key("h");
  check("h closes it", !(await page.eval(`!!${sheet}.querySelector("[data-cow-brief-evidence]")`)));
  await page.key("j");
  check("j moves to the judgement call, which says it was not raised as an ask", (await page.eval(sheetCursor)) === "call:0" && (await page.eval(`${sheet}.querySelector(".cow-cur").textContent`)).includes("not raised as an ask"));
  await page.key("G");
  await page.key("Enter");
  const supported = await page.eval(`${sheet}.querySelector('[data-cow-brief-item="claim:timeout"]').textContent`);
  const fileHref = await page.eval(`${sheet}.querySelector('[data-cow-brief-file="config.txt"]')?.dataset.cowFile ?? null`);
  check(
    "a claim the checker supported says only that, and its file evidence is shown as submitted with a link to the file",
    (await page.eval(sheetCursor)) === "claim:timeout" && supported.includes("found it supported") && !/verified/i.test(supported) && supported.includes("request_timeout_seconds = 30") && typeof fileHref === "string" && fileHref.length > 0,
    supported.slice(0, 200),
  );
  await page.key("g");
  await page.key("g");
  check("gg goes back to the first stop", (await page.eval(sheetCursor)) === "claim:tests");
  await page.key("f");
  const hints = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll("[data-cow-hint-label]")].map((tag) => tag.dataset.cowHintFor))`));
  check("f labels what is in the sheet, and nothing under it", hints.length >= 3 && !hints.includes(ids.briefer) && !hints.includes(ids.asker), JSON.stringify(hints));
  await page.key("Escape");
  await page.key("c");
  const asksFirst = await page.eval(`${sheet}.querySelector("[data-cow-sheet-confirm]")?.textContent ?? ""`);
  check("c asks before checking again, and says it costs a model run", asksFirst.includes("costs a model run") && (await briefOf(ids.briefer)).check.startedAt === checkedAt, asksFirst);
  await page.key("n");
  check(
    "any key but y cancels it: no check was started",
    (await page.eval(`${sheet}.querySelector("[data-cow-sheet-note]")?.textContent`)) === "not checked again" && (await briefOf(ids.briefer)).check.startedAt === checkedAt,
  );
  await page.colorScheme("dark");
  await shot("brief-sheet-dark");
  await page.colorScheme("light");
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closing" });
  check("q closes the sheet and the cursor is back on its line", (await page.eval(isCursor(ids.briefer))) && (await page.eval(mode)) === "normal");
  await page.waitFor(`${queued(ids.briefer)} === null`, { label: "the read brief leaving the queue" });
  check(
    "read, the brief stops waiting on you and keeps its disputed mark",
    (await page.eval(lineState(ids.briefer))) === "done" && (await page.eval(briefMark(ids.briefer))) === "disputed" && (await briefOf(ids.briefer)).readAt !== null,
    await page.eval(lineState(ids.briefer)),
  );

  // -- a failed check, and a judgement call answered in place --
  await page.key("g");
  await page.key("g");
  check("the heading asks you too", (await page.eval(`${mainLine}.querySelector(".cow-maindoing")?.textContent ?? ""`)).includes("asks you: Keep the old endpoint for a week?"));
  await page.key("b");
  await page.waitFor(`${sheet}?.dataset.cowSheet === "${ids.amain}" && !!${sheet}.querySelector("[data-cow-brief-check]")`, { label: "the Main's brief" });
  const failedSheet = JSON.parse(
    await page.eval(`JSON.stringify({
      check: ${sheet}.querySelector("[data-cow-brief-check]").dataset.cowBriefCheck,
      text: ${sheet}.querySelector("[data-cow-brief-check]").textContent,
      failure: ${sheet}.querySelector("[data-cow-brief-failure]")?.textContent ?? "",
      verdicts: [...${sheet}.querySelectorAll("[data-cow-brief-item][data-cow-brief-verdict]")].map((item) => item.dataset.cowBriefVerdict),
      disputes: ${sheet}.querySelector('[data-cow-brief-section="disputes"]').nextElementSibling.textContent,
    })`),
  );
  check(
    "a failed check is shown as failed, with the reason, and no claim carries a verdict",
    failedSheet.check === "failed" && failedSheet.text.startsWith("Check failed") && failedSheet.failure.includes("could not be started") && failedSheet.verdicts.every((verdict) => verdict === "none") && failedSheet.disputes.startsWith("Unknown"),
    JSON.stringify(failedSheet),
  );
  await shot("brief-failed");
  check("its judgement call is the first stop, and says it is open as an ask", (await page.eval(sheetCursor)) === "call:0" && (await page.eval(`${sheet}.querySelector(".cow-cur").dataset.cowBriefAsk`)) === call.id);
  await page.key("a");
  await page.waitFor(`${sheet}.querySelector('[data-cow-brief-item="call:0"] [data-cow-ask-card]')?.dataset.cowAsk === "${call.id}"`, { label: "the ask card inside the sheet" });
  check("a answers a judgement call in place: its ask opens inside the brief", true);
  await page.key("1");
  await page.key("Enter");
  await page.waitFor(`!${card}`, { label: "the in-place card closing" });
  const answeredCall = (await rpc("asks_list", { threadId: ids.amain, all: true })).asks.find((ask) => ask.id === call.id);
  await page.waitFor(`(${sheet}.querySelector('[data-cow-brief-item="call:0"]')?.textContent ?? "").includes("answered or withdrawn")`, { label: "the call showing as answered" });
  check("the answer is sent, and the brief shows the call as answered while it stays open", answeredCall?.status === "answered" && answeredCall.answer.option === 1 && (await page.eval(`!!${sheet}`)));
  await waitForThread(ids.amain, (t) => t.status === "idle", "the Main at rest after the answer", 60_000);

  // -- a narrow window --
  await page.resize(700, 800);
  await sleep(1500);
  const narrowOpen = await page.eval(`!!${sheet}`);
  if (!narrowOpen) {
    // bb remounts the page when its layout changes; the brief is opened again.
    await page.waitFor(`${screen} === "overview"`, { label: "the page back in a narrow window" });
    await page.key("g");
    await page.key("g");
    await page.key("b");
    await page.waitFor(`!!${sheet}?.querySelector("[data-cow-brief-check]")`, { label: "the brief in a narrow window" });
  }
  check("in a narrow window the sheet fits without scrolling sideways", await page.eval(`${sheet}.scrollWidth <= ${sheet}.clientWidth + 1 && ${ROOT}.scrollWidth <= ${ROOT}.clientWidth`));
  await shot("brief-narrow");
  await page.key("Escape");
  await page.waitFor(`!${sheet}`, { label: "Escape closing the sheet" });
  check("Escape closes the sheet too", true);
  await page.resize(1440, 900);
  await sleep(1500);
  await page.waitFor(`${screen} === "overview"`, { label: "the page at full width again" });
  await page.key("?");
  const legend = await page.eval(`document.querySelector("[data-cow-help]")?.textContent ?? ""`);
  await page.key("Escape");
  check("the legend explains the brief marks and lists b", legend.includes("a brief.") && legend.includes("disputed.") && legend.includes("open the line's brief"), legend.slice(0, 80));
}

// ---- the reader, projects, asks answered in chat, scrolling the chat -------

const READER = `You are a test fixture for a bb plugin. Reply to this first message with exactly: ok
From then on:
- when you receive the message "files", do these three things in order:
  1. run this shell command once, exactly as written:
     mkdir -p "$BB_THREAD_STORAGE" && printf 'storage proof\\nsecond line\\nthird line\\n' > "$BB_THREAD_STORAGE/proof.txt" && echo "S=$BB_THREAD_STORAGE" && echo "W=$PWD"
  2. use your file-writing tool once to create the file .cow-e2e/sample.txt inside your working directory, containing exactly the three lines alpha, beta and gamma;
  3. reply with exactly these four lines of Markdown, where W is the directory printed after W= and S is the directory printed after S=:
     - [the readme](W/README.md#L40-L44)
     - [the proof](S/proof.txt)
     - [the keys](W/src/keys.ts:62)
     - [the sample](W/.cow-e2e/sample.txt)
- when you receive the message "edit", use your file-editing tool once to change the line beta to delta in .cow-e2e/sample.txt, then reply with exactly: edited
- reply to anything else with exactly: ok
Never do anything else.`;

/** The fixtures of the reader and project checks: a Main of their own, a group head with one member, and a thread with files. */
const READING = ["pmain", "phead", "pkid", "reader"];
const PROOF_TEXT = "storage proof\nsecond line\nthird line\n";

/** Puts back what the reader checks changed outside bb's threads. */
let restoreReading = async () => undefined;

async function prepareReading(ids) {
  const dataDir = /Data dir:\s*(\S+)/.exec(await plain("status"))?.[1];
  if (!dataDir) throw new Error("could not find bb's data directory in `bb status`");
  for (const name of READING) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  const storage = join(dataDir, "thread-storage", ids.reader);
  mkdirSync(storage, { recursive: true });
  const [thread] = await api(`/threads?threadIds=${ids.reader}&limit=1`);
  const workspace = (await api(`/environments/${thread.environmentId}`)).path;
  if (!existsSync(join(workspace, "README.md")) || !existsSync(join(workspace, "src", "keys.ts"))) {
    throw new Error("the reader checks need --environment to be a checkout of cow: its fixture links to README.md and src/keys.ts");
  }
  // The fixture makes its files and links once; a later run finds them in its chat.
  const said = (await api(`/threads/${ids.reader}/output`)).output ?? "";
  const rows = JSON.stringify((await api(`/threads/${ids.reader}/timeline`)).rows ?? []);
  if (!rows.includes("the readme") || !rows.includes(":file-change:")) {
    await tellAs(null, ids.reader, "files");
    await sleep(3000);
    await waitForThread(ids.reader, (t) => t.status === "idle", "the reader's files made");
  } else if (!said) await sleep(0);
  writeFileSync(join(storage, "proof.txt"), PROOF_TEXT);
  writeFileSync(join(storage, "notes.md"), "# Notes\n\nSee [the proof](proof.txt) beside this file, and [where keys are read](" + join(workspace, "src/keys.ts") + ":62).\n\n- one\n- two\n");
  // Every run starts with nothing marked, nothing asked, and every reply seen.
  for (const name of READING) {
    const id = ids[name];
    await cow("project", id, "--clear");
    for (const ask of await openAsksOf(id)) await cow("ask", "withdraw", ask.id);
    const end = (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
    if (end !== undefined) await rpc("seen_set", { threadId: id, seen: { seq: end, at: Date.now() } });
  }
  // A brief is submitted without a check: only its evidence link is used here.
  const before = JSON.parse(await plain("plugin", "config", "cow", "--json")).values ?? {};
  const set = async (key, value) => plain("plugin", "config", "cow", ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)]));
  restoreReading = async () => {
    await set("checkOnSubmit", before.checkOnSubmit);
    writeFileSync(join(storage, "proof.txt"), PROOF_TEXT);
  };
  if ((await briefOf(ids.reader)) === null) {
    await set("checkOnSubmit", false);
    const file = join(storage, "brief.json");
    writeFileSync(file, JSON.stringify({ summary: "Wrote the proof file.", claims: [{ id: "proof", text: "The proof file has three lines.", label: "checked", evidence: [{ description: "the proof file", path: "proof.txt" }] }] }));
    const done = await cowAs(ids.reader, "brief", "submit", file, "--json");
    await set("checkOnSubmit", before.checkOnSubmit);
    if (done.code !== 0) throw new Error(`could not submit the reader's brief: ${done.stderr}`);
  }
  return { storage, workspace };
}

async function readingChecks(page, ids, shot, chooseMain) {
  const { storage, workspace } = await prepareReading(ids);
  await chooseMain(page, ids.pmain);
  await page.send("Page.bringToFront");
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const stateOf = (id) => `(${lineEl(id)}?.dataset.cowState ?? null)`;
  const inTree = (id) => `(${lineEl(id)}?.dataset.cowDepth !== undefined)`;
  const projectOf = (id) => `(${lineEl(id)}?.dataset.cowProject ?? null)`;
  const doing = (id) => `(() => { const cell = ${lineEl(id)}?.querySelector(".cow-wh")?.cloneNode(true); cell?.querySelector(".cow-nx2")?.remove(); return cell?.textContent ?? ""; })()`;
  const message = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const select = async (id) => {
    await page.eval(`${lineEl(id)}.click(); true`);
    await sleep(200);
    if (!(await page.eval(isCursor(id)))) throw new Error(`could not select ${id}`);
  };
  /** Everything a line's state has been since `watch(id)`, in order. */
  const watch = (id) =>
    page.eval(`(() => { window.__cowStates ??= {}; const seen = (window.__cowStates["${id}"] = []); let last = null; const tick = () => { const el = ${lineEl(id)}; const now = el ? el.dataset.cowState + (el.dataset.cowDepth === undefined ? ":flat" : "") : "gone"; if (now !== last) seen.push((last = now)); if (window.__cowStates["${id}"] === seen) requestAnimationFrame(tick); }; tick(); return true; })()`);
  const watched = (id) => page.eval(`JSON.stringify(window.__cowStates["${id}"] ?? [])`).then(JSON.parse);

  // -- projects: never done ------------------------------------------------
  await page.waitFor(`${stateOf(ids.reader)} === "done" && ${stateOf(ids.phead)} === "idle"`, { label: "the fixtures at rest" });
  check("a quiet thread with nothing under it and no mark is done, in the Done section", !(await page.eval(inTree(ids.reader))) && (await page.eval(projectOf(ids.reader))) === null);
  check(
    "a group head is a project without being marked: at rest it is idle, in the tree, with its member under it",
    (await page.eval(stateOf(ids.phead))) === "idle" && (await page.eval(inTree(ids.phead))) && (await page.eval(projectOf(ids.phead))) === "head" && (await page.eval(`${lineEl(ids.pkid)}?.dataset.cowDepth`)) === "1",
    JSON.stringify([await page.eval(stateOf(ids.phead)), await page.eval(projectOf(ids.phead))]),
  );
  // bb keeps the unread reply of a Main with no parent itself; opening its chat reads it.
  await page.key("m");
  await page.waitFor(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState === "idle"`, { label: "Main's reply read" });
  await page.key("Escape");
  await page.waitFor(`!document.querySelector("[data-cow-pane]")`, { label: "Main's chat closed" });
  check("Main is a project: at rest its heading reads idle", (await page.eval(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState`)) === "idle");
  await select(ids.reader);
  await page.key("P");
  await page.waitFor(`${stateOf(ids.reader)} === "idle"`, { label: "the line marked as a project" });
  check(
    "P marks the line as a project: it is idle, back in the tree, and carries the project mark",
    (await page.eval(inTree(ids.reader))) && (await page.eval(projectOf(ids.reader))) === "marked" && (await page.eval(`!!${lineEl(ids.reader)}.querySelector(".cow-projectmark")`)) && (await page.eval(message)).startsWith("marked as a project"),
    await page.eval(message),
  );
  check("the mark is one of cow's notes on the thread", (await rpc("notes_list", { threadIds: [ids.reader] })).projects[ids.reader] !== undefined);
  await shot("project-marked");
  await page.key("u");
  check("u offers to take the mark back", (await page.eval(`document.querySelector("[data-cow-confirm] label")?.textContent ?? ""`)).includes("as a project"));
  await page.key("y");
  await page.waitFor(`${stateOf(ids.reader)} === "done" && !${inTree(ids.reader)}`, { label: "the mark undone" });
  check("undone, it is done again and has no mark", (await rpc("notes_list", { threadIds: [ids.reader] })).projects[ids.reader] === undefined);
  const refusedMark = await cowAs(ids.pkid, "project", ids.reader);
  check("bb cow project refuses a thread that is neither the target nor above it", refusedMark.code !== 0 && /only for itself and for the threads under it/.test(refusedMark.stderr + refusedMark.stdout), refusedMark.stderr);
  const marked = await cowAs(ids.pmain, "project", ids.reader);
  await page.waitFor(`${stateOf(ids.reader)} === "idle" && ${inTree(ids.reader)}`, { label: "the CLI's mark on the page" });
  check("bb cow project marks a thread under the caller, and the page shows it without a reload", marked.code === 0 && /is marked as a project/.test(marked.stdout), marked.stdout);
  const cleared = await cowAs(ids.pmain, "project", ids.reader, "--clear");
  await page.waitFor(`${stateOf(ids.reader)} === "done"`, { label: "the CLI's mark cleared" });
  check("bb cow project --clear takes the mark off", cleared.code === 0 && /no longer marked/.test(cleared.stdout), cleared.stdout);
  await cowAs(ids.pmain, "project", ids.reader);
  await page.waitFor(`${stateOf(ids.reader)} === "idle"`, { label: "marked again" });
  const status = (await cow("status", "--main", ids.pmain)).stdout;
  const statusLine = (id) => status.split("\n").find((line) => line.includes(`(${id})`) && /^[ \d]{4}\w/.test(line)) ?? "";
  check(
    "bb cow status gives idle as a state and marks the projects",
    /^Main: .* · idle /.test(status) && /^\s+idle\s.*\[project\]/.test(statusLine(ids.reader)) && /^\s+idle\s.*\[project\]/.test(statusLine(ids.phead)) && /^\s+done\s/.test(statusLine(ids.pkid)) && !statusLine(ids.pkid).includes("[project]"),
    JSON.stringify([statusLine(ids.reader), statusLine(ids.phead), statusLine(ids.pkid)]),
  );

  // A marked project finishes a turn: replied to you, then idle; never done, never under Done.
  await watch(ids.reader);
  await tellAs(null, ids.reader, "hello");
  await page.waitFor(`${stateOf(ids.reader)} === "running"`, { label: "the project running", timeout: 60_000 });
  await page.waitFor(`${stateOf(ids.reader)} === "wants" && ${lineEl(ids.reader)}.dataset.cowReply === ""`, { label: "the project's reply", timeout: 120_000 });
  check("a marked project that finishes a turn reads replied to you, though you did not start its first prompt", (await page.eval(doing(ids.reader))).startsWith("replied to you: ok"), await page.eval(doing(ids.reader)));
  await sleep(1500);
  const turnStates = await watched(ids.reader);
  check(
    "between running and replied to you the line never reads done or idle, and never leaves the tree",
    JSON.stringify(turnStates) === JSON.stringify(["idle", "running", "wants"]),
    JSON.stringify(turnStates),
  );
  await select(ids.reader);
  await page.key(" ");
  await page.waitFor(`${stateOf(ids.reader)} === "idle"`, { label: "the reply seen" });
  const idleDoing = await page.eval(doing(ids.reader));
  check("once its reply is seen it is idle, in its place, saying what it last said", (await page.eval(inTree(ids.reader))) && idleDoing.startsWith("ok"), idleDoing);
  check("an idle project is not in the queue", !(await page.eval(`!!document.querySelector('[data-cow-queue="${ids.reader}"]')`)));

  // A group head likewise, with a turn another thread started.
  await watch(ids.phead);
  await tellAs(ids.pmain, ids.phead, "hello");
  await page.waitFor(`${stateOf(ids.phead)} === "wants" && ${lineEl(ids.phead)}.dataset.cowReply === ""`, { label: "the head's reply", timeout: 120_000 });
  await select(ids.phead);
  await page.key(" ");
  await page.waitFor(`${stateOf(ids.phead)} === "idle"`, { label: "the head idle again" });
  await sleep(500);
  const headStates = await watched(ids.phead);
  check(
    "a group head that finishes a turn reads replied to you, then idle: never done, never under Done",
    headStates[0] === "idle" && headStates[headStates.length - 1] === "idle" && headStates.includes("wants") && !headStates.some((state) => state.startsWith("done") || state.endsWith(":flat") || state === "gone"),
    JSON.stringify(headStates),
  );
  await page.key("?");
  const legend = await page.eval(`document.querySelector("[data-cow-help]")?.textContent ?? ""`);
  await page.key("Escape");
  const sideLegend = await page.eval(`[...document.querySelectorAll(".cow-legend .cow-lg b")].map((b) => b.textContent).join(" ")`);
  check("the legend has idle with a glyph of its own, the project mark, P, the reader and the chat's scroll keys", legend.includes("idle.") && legend.includes("a project.") && legend.includes("mark a line as a project") && legend.includes("scroll the open chat") && legend.includes("a file opens over the page") && sideLegend.includes("idle"), sideLegend);

  // -- the reader ----------------------------------------------------------
  const reader = `document.querySelector("[data-cow-reader]")`;
  const rd = (name) => `(${reader}?.dataset.cowReader${name} ?? null)`;
  const rdPath = `(${reader}?.dataset.cowReader ?? null)`;
  const rdLine = `Number(${reader}?.dataset.cowReaderLine ?? 0)`;
  const rdScroll = `Math.round(${reader}?.querySelector("[data-cow-reader-scroll]")?.scrollTop ?? -1)`;
  const cursorShown = `(() => { const sc = ${reader}?.querySelector("[data-cow-reader-scroll]")?.getBoundingClientRect(); const cur = ${reader}?.querySelector(".cow-rd-cursor")?.getBoundingClientRect(); return !!sc && !!cur && cur.top >= sc.top - 1 && cur.bottom <= sc.bottom + 1; })()`;
  const rootWidth = `Math.round(${ROOT}.getBoundingClientRect().width)`;
  // Scrolled into view only when it is not: bb's chat pulls itself back to its newest message, which would move the target under the mouse.
  const centre = (expression) =>
    page.eval(`(() => { const el = ${expression}; if (!el) return null; const at = () => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }; const hit = (p) => { const top = document.elementFromPoint(p[0], p[1]); return !!top && (top === el || el.contains(top)); }; if (!hit(at())) el.scrollIntoView({ block: "center" }); return at(); })()`);
  const inView = (expression) => page.eval(`(() => { const el = ${expression}; if (!el) return false; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && (top === el || el.contains(top)); })()`);
  /** Bring something in the open chat into view with cow's own keys: up from the newest message until it shows. */
  const reveal = async (expression, label) => {
    for (let i = 0; i < 80 && !(await inView(expression)); i += 1) {
      await page.key(i === 0 ? "\\" : '"');
      await sleep(350);
    }
    if (!(await inView(expression))) throw new Error(`could not scroll the chat to ${label}`);
  };
  /** A click of the mouse on the middle of an element, once it has stopped moving: the chat scrolls as it loads. */
  const clickOn = async (expression, label) => {
    if (expression.includes("[data-cow-chat]") && !expression.includes("work-summary")) await reveal(expression, label);
    let at = await centre(expression);
    for (let i = 0; i < 30; i += 1) {
      await sleep(200);
      const now = await centre(expression);
      if (at && now && Math.abs(now[0] - at[0]) < 1 && Math.abs(now[1] - at[1]) < 1) break;
      at = now;
    }
    if (!at) throw new Error(`nothing to click: ${label}`);
    await sleep(150);
    await page.click(...at);
  };
  const chatLink = (name) => `[...document.querySelectorAll('[data-cow-chat] a[href^="file:"]')].filter((a) => a.textContent.trim() === ${JSON.stringify(name)}).pop()`;
  /** Press f and type the hint whose target is described by `test`, a JS predicate over (for, in). */
  const hintTo = async (test, label) => {
    await page.key("f");
    await page.waitFor(`document.querySelectorAll("[data-cow-hint-label]").length > 0`, { label: `hints for ${label}` });
    const found = await page.eval(`(() => { const tags = [...document.querySelectorAll("[data-cow-hint-label]")].filter((tag) => (${test})(tag.dataset.cowHintFor ?? "", tag.dataset.cowHintIn)); return tags.length ? tags[tags.length - 1].dataset.cowHintLabel : null; })()`);
    if (!found) {
      await page.key("Escape");
      throw new Error(`no hint for ${label}`);
    }
    for (const letter of found) await page.key(letter);
  };
  const opened = (path, more = "true") => page.waitFor(`${rdPath} === ${JSON.stringify(path)} && Number(${rd("Lines")}) > 0 && ${rd("Kind")} !== "loading" && (${more})`, { label: `the reader on ${path}`, timeout: 20_000 });
  const closed = () => page.waitFor(`!${reader}`, { label: "the reader closed" });

  await select(ids.reader);
  await page.key("Enter");
  // The links are in an early message: bb draws it once the chat is scrolled up to it, which the clicks below do with cow's keys.
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.reader}" && !!document.querySelector("[data-cow-chat] [data-timeline-row-id]")`, { label: "the fixture's chat", timeout: 30_000 });
  await sleep(2500);
  const widthBefore = await page.eval(rootWidth);

  // A workspace link with a line, by a click of the mouse.
  await clickOn(chatLink("the keys"), "the keys link");
  await opened("src/keys.ts", `${rdLine} === 62`);
  check(
    "a click on a workspace link with a line opens the reader on that file, in its workspace, with the line marked and the cursor on it",
    (await page.eval(rd("Root"))) === "workspace" && (await page.eval(rd("Kind"))) === "source" && (await page.eval(rd("Marked"))) === "62-62" && (await page.eval(`${reader}.querySelectorAll(".cow-rd-marked").length`)) === 1 && (await page.eval(cursorShown)),
    JSON.stringify(await page.eval(`JSON.stringify(${reader}.dataset)`)),
  );
  check("bb's side panel did not open: the page is as wide as it was", (await page.eval(rootWidth)) === widthBefore, `${widthBefore} / ${await page.eval(rootWidth)}`);
  const heading = await page.eval(`${reader}.querySelector(".cow-rd-head").textContent`);
  check("its heading gives the path under its root, the root, the thread and the size", heading.includes("src/keys.ts") && heading.includes("workspace") && heading.includes(`of ${TITLE}`) && /\d+ KB/.test(heading) && /\d+ lines/.test(heading), heading);
  await page.waitFor(`!!${reader}.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-line="62"] span[style]') && !!${reader}.querySelector("diffs-container").shadowRoot.querySelector("[data-gutter] [data-line-number-content]")`, { label: "bb's viewer colouring the file" });
  check("the file is drawn by bb's own viewer, with highlighting and line numbers", true);
  check("the reader's mode shows on the page", (await page.eval(mode)) === "read");
  await shot("reader-source");

  // The page's verbs do not fire while it is open.
  for (const key of ["p", "e", "x", "a", "b", "I", "m", "M", "?", "P"]) await page.key(key);
  check(
    "no key of the page does anything while the reader is open",
    (await page.eval(mode)) === "read" && (await page.eval(rdLine)) === 62 && !(await page.eval(`!!document.querySelector("[data-cow-confirm], [data-cow-help], [data-cow-say], [data-cow-sheet]")`)) && (await page.eval(screen)) === "overview" && (await page.eval(stateOf(ids.reader))) === "idle",
    await page.eval(mode),
  );

  // Movement.
  await page.key("j");
  check("j moves down a line", (await page.eval(rdLine)) === 63);
  await page.key("5");
  await page.key("k");
  check("a count goes before a motion: 5k moves up five", (await page.eval(rdLine)) === 58);
  await page.key("g");
  await page.key("g");
  check("gg goes to the first line", (await page.eval(rdLine)) === 1 && (await page.eval(rdScroll)) === 0);
  await page.key("d", { ctrl: true });
  const afterHalf = await page.eval(rdLine);
  const halfScroll = await page.eval(rdScroll);
  check("Ctrl+d moves half a page, and the window with it", afterHalf > 10 && halfScroll > 100 && (await page.eval(cursorShown)), `${afterHalf} @ ${halfScroll}`);
  await page.key("u", { ctrl: true });
  check("Ctrl+u moves back", (await page.eval(rdLine)) === 1 && (await page.eval(rdScroll)) === 0);
  await page.key("f", { ctrl: true });
  const afterPage = await page.eval(rdLine);
  check("Ctrl+f moves a page", afterPage > afterHalf && (await page.eval(cursorShown)), String(afterPage));
  await page.key("b", { ctrl: true });
  check("Ctrl+b moves back a page", (await page.eval(rdLine)) === 1);
  await page.key("G");
  const lastLine = await page.eval(rdLine);
  check("G goes to the last line", lastLine === Number(await page.eval(rd("Lines"))) && lastLine > 300 && (await page.eval(cursorShown)), String(lastLine));
  for (const key of "120G") await page.key(key);
  check("120G goes to line 120", (await page.eval(rdLine)) === 120 && (await page.eval(cursorShown)));
  const keysText = readFileSync(join(workspace, "src", "keys.ts"), "utf8").split("\n");
  await page.key("}");
  const down = await page.eval(rdLine);
  check("} goes to the blank line that ends the block", down > 120 && keysText[down - 1].trim() === "" && keysText.slice(120, down - 1).every((line) => line.trim() !== ""), String(down));
  await page.key("{");
  const up = await page.eval(rdLine);
  check("{ goes to the blank line above it", up < down && keysText[up - 1].trim() === "" && keysText.slice(up, down - 1).every((line) => line.trim() !== ""), String(up));
  const position = await page.eval(`${reader}.querySelector("[data-cow-reader-position]").textContent`);
  check("the status line says where the cursor is", position.includes(`line ${up} of ${lastLine}`), position);

  // Search.
  await page.key("/");
  await page.waitFor(`document.activeElement?.dataset.cowReaderSearch === ""`, { label: "the search field" });
  await page.type("jkGq");
  check(
    "typing in the search field moves nothing and closes nothing: j, k, G and q are text there",
    (await page.eval(rdLine)) === up && (await page.eval(`document.activeElement.value`)) === "jkGq" && (await page.eval(mode)) === "search",
    await page.eval(`document.activeElement.value`),
  );
  await page.key("Escape");
  check("Escape cancels the search and leaves the file open", (await page.eval(mode)) === "read" && (await page.eval(rd("Query"))) === null && (await page.eval(rdLine)) === up);
  await page.key("/");
  await page.waitFor(`document.activeElement?.dataset.cowReaderSearch === ""`, { label: "the search field again" });
  await page.type("hint");
  await sleep(400);
  const typedMarks = await page.eval(`${reader}.querySelectorAll(".cow-rd-match").length`);
  await page.key("Enter");
  const expected = keysText.map((line, index) => (line.toLowerCase().includes("hint") ? index + 1 : 0)).filter(Boolean);
  const total = keysText.reduce((sum, line) => sum + (line.toLowerCase().split("hint").length - 1), 0);
  const firstAt = await page.eval(rdLine);
  check(
    "/ searches forward from the cursor: every match is counted and marked, and Enter goes to the first at or after the cursor",
    Number(await page.eval(rd("Matches"))) === total && typedMarks > 0 && firstAt === expected.find((line) => line >= up) && (await page.eval(`${reader}.querySelectorAll(".cow-rd-current").length`)) >= 1 && (await page.eval(cursorShown)),
    JSON.stringify([await page.eval(rd("Matches")), total, firstAt, typedMarks]),
  );
  const markOnLine = await page.eval(`(() => { const cur = ${reader}.querySelector(".cow-rd-cursor").getBoundingClientRect(); const mark = ${reader}.querySelector(".cow-rd-current").getBoundingClientRect(); return mark.top >= cur.top - 1 && mark.bottom <= cur.bottom + 1; })()`);
  check("the match the cursor is on is drawn on the cursor's line", markOnLine);
  const matchBefore = Number(await page.eval(rd("Match")));
  await page.key("n");
  const nextAt = await page.eval(rdLine);
  check("n goes to the next match", Number(await page.eval(rd("Match"))) === matchBefore + 1 && nextAt >= firstAt && (await page.eval(cursorShown)), String(nextAt));
  await page.key("N");
  check("N goes back to the one before", Number(await page.eval(rd("Match"))) === matchBefore && (await page.eval(rdLine)) === firstAt);
  check("the status line shows the search and where it is among the matches", (await page.eval(`${reader}.querySelector("[data-cow-reader-search-state]")?.textContent ?? ""`)).includes(`/hint · ${matchBefore} of ${total}`));
  await shot("reader-search");

  // Copying.
  await page.key("y");
  check("y copies the file's path", (await page.eval(rd("Copied"))) === "src/keys.ts");
  await page.key("Y");
  check("Y copies the path with the cursor's line", (await page.eval(rd("Copied"))) === `src/keys.ts:${firstAt}`);

  await page.key("q");
  await closed();
  check(
    "q closes the reader: the page is as it was, the chat still open and the cursor on its line",
    (await page.eval(mode)) === "normal" && (await page.eval(`document.querySelector("[data-cow-pane]")?.dataset.cowPane`)) === ids.reader && (await page.eval(isCursor(ids.reader))) && (await page.eval(`document.activeElement === ${ROOT}`)),
  );

  // The same kind of link, by a hint; a Markdown file with lines opens raw.
  await reveal(chatLink("the readme"), "the readme link");
  await hintTo(`(target, where) => where === "chat" && target.includes("README.md")`, "the readme link");
  await opened("README.md", `${rdLine} === 40`);
  check(
    "a hint on a file link opens the reader too: a Markdown file linked by lines opens raw, with the lines marked",
    (await page.eval(rd("Kind"))) === "raw" && (await page.eval(rd("Marked"))) === "40-44" && (await page.eval(`${reader}.querySelectorAll(".cow-rd-marked").length`)) === 5 && (await page.eval(cursorShown)),
    JSON.stringify(await page.eval(`JSON.stringify(${reader}.dataset)`)),
  );
  await page.key("r");
  await page.waitFor(`${rd("Kind")} === "rendered" && !!${reader}.querySelector("[data-markdown-preview] h1")`, { label: "the Markdown rendered" });
  check("r shows the Markdown rendered", (await page.eval(`${reader}.querySelector("[data-markdown-preview] h1").textContent`)).includes("cow"));
  await page.key("j");
  await page.key("j");
  check("the cursor moves over what is drawn, block by block", (await page.eval(rdLine)) === 3 && (await page.eval(`!!${reader}.querySelector(".cow-rd-cursor")`)));
  await shot("reader-markdown");
  await page.key("r");
  await page.waitFor(`${rd("Kind")} === "raw"`, { label: "the Markdown raw again" });
  check("r again shows it raw", Number(await page.eval(rd("Lines"))) === readFileSync(join(workspace, "README.md"), "utf8").replace(/\n$/, "").split("\n").length);
  await page.key("Escape");
  await closed();
  check("Escape closes the reader as q does", (await page.eval(mode)) === "normal");

  // A file in the thread's storage, and the file changing on disk.
  await clickOn(chatLink("the proof"), "the proof link");
  await opened("proof.txt", `Number(${rd("Lines")}) === 3`);
  check("a link to a file in the thread's storage opens it there", (await page.eval(rd("Root"))) === "storage" && (await page.eval(`${reader}.querySelector("[data-cow-reader-rootname]").textContent`)) === "thread storage");
  await page.key("j");
  writeFileSync(join(storage, "proof.txt"), `${PROOF_TEXT}a fourth line\n`);
  await page.waitFor(`${rd("Changed")} === "true" && Number(${rd("Lines")}) === 4`, { label: "the file's change on disk", timeout: 20_000 });
  check("a file that changes on disk is shown as it is now, marked changed, with the cursor where it was", (await page.eval(rdLine)) === 2 && (await page.eval(`${reader}.querySelector(".cow-rd-changed")?.textContent`)) === "changed");
  writeFileSync(join(storage, "proof.txt"), PROOF_TEXT);
  await page.key("q");
  await closed();

  // A file change in the chat's timeline: a diff.
  const rowButton = `[...document.querySelectorAll('[data-cow-chat] [data-timeline-row-id*=":file-change:"] button[aria-expanded]')].filter((b) => !b.closest("[data-timeline-file-diff]")).pop()`;
  if (!(await page.eval(`!!${rowButton}`))) {
    // bb folds a turn's work into one line; its heading is the first toggle of that turn's row.
    await clickOn(`[...document.querySelectorAll('[data-cow-chat] [data-timeline-row-id*=":work-summary:"] button[aria-expanded="false"]')].pop()`, "the turn's work");
    await page.waitFor(`!!${rowButton}`, { label: "the file row in the timeline" });
  }
  await clickOn(rowButton, "the file row");
  await opened(".cow-e2e/sample.txt", `${rd("Kind")} === "diff"`);
  const sides = await page.eval(`${reader}.querySelector("[data-cow-reader-sides]").textContent`);
  check(
    "a click on a file row in the timeline opens its change in the reader as a diff, with the two sides in the heading",
    sides.includes("/dev/null → .cow-e2e/sample.txt") && sides.includes("+3") && (await page.eval(rd("View"))) === "unified" && (await page.eval(`!!${reader}.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-line-type="change-addition"]')`)),
    sides,
  );
  check("bb did not unfold the row in the chat under the reader", (await page.eval(`${rowButton}?.getAttribute("aria-expanded")`)) === "false");
  await page.key("j");
  check("the cursor moves over the diff's lines", (await page.eval(rdLine)) === 2);
  await page.key("u");
  await page.waitFor(`${rd("View")} === "split"`, { label: "the split diff" });
  check("u shows the diff split", await page.eval(`!!${reader}.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-diff-type="split"]')`));
  await shot("reader-diff");
  await page.key("u");
  await page.waitFor(`${rd("View")} === "unified"`, { label: "the unified diff" });
  await page.key("q");
  await closed();
  await reveal(rowButton, "the file row");
  await hintTo(`(target, where) => where === "chat" && target.startsWith("button:") && target.includes("sample.txt") && !target.includes("Copy")`, "the file row");
  await opened(".cow-e2e/sample.txt", `${rd("Kind")} === "diff"`);
  check("a hint on the file row opens the same diff", true);
  await page.key("q");
  await closed();

  // o hands the file to bb's own panel; q then closes that.
  await clickOn(chatLink("the proof"), "the proof link");
  await opened("proof.txt");
  await page.key("o");
  await page.waitFor(`!${reader} && ${rootWidth} < ${widthBefore} - 50`, { label: "bb's panel beside the page" });
  check("o opens the same file in bb's own panel, beside the page, and the reader steps aside", (await page.eval(mode)) === "normal");
  await sleep(1000);
  check("a file tab cow asked for is left open", (await page.eval(rootWidth)) < widthBefore - 50);
  await page.key("q");
  await page.waitFor(`${rootWidth} === ${widthBefore}`, { label: "bb's panel closed" });
  check("q on the page closes the file tab bb was showing", (await page.eval(`document.querySelectorAll('[role="tab"]').length`)) === 0 && (await page.eval(`document.querySelector("[data-cow-pane]")?.dataset.cowPane`)) === ids.reader);

  // -- scrolling the chat from the overview ----------------------------------
  const scroller = `(() => { let best = null; for (const el of document.querySelectorAll("[data-cow-chat] *")) { if (el.scrollHeight <= el.clientHeight + 1 || el.clientHeight === 0) continue; const o = getComputedStyle(el).overflowY; if (o !== "auto" && o !== "scroll") continue; if (!best || el.clientHeight > best.clientHeight) best = el; } return best; })()`;
  const chatTop = `Math.round(${scroller}?.scrollTop ?? -1)`;
  const settle = async () => {
    let last = -2;
    for (let i = 0; i < 40; i += 1) {
      const now = await page.eval(chatTop);
      if (now === last) return now;
      last = now;
      await sleep(120);
    }
    return last;
  };
  await page.key("\\");
  const bottom = await settle();
  const chatMax = await page.eval(`Math.round(${scroller}.scrollHeight - ${scroller}.clientHeight)`);
  check("\\ scrolls the open chat to its newest message", bottom > 0 && Math.abs(bottom - chatMax) <= 2, `${bottom} of ${chatMax}`);
  await page.key("'");
  const upOnce = await settle();
  check("' scrolls the chat up a few lines", bottom - upOnce > 30 && bottom - upOnce < 120, String(bottom - upOnce));
  await page.key(";");
  check("; scrolls it down again", (await settle()) === bottom);
  await page.key('"');
  const upHalf = await settle();
  const chatHeight = await page.eval(`${scroller}.clientHeight`);
  check('" scrolls up half a page', Math.abs(bottom - upHalf - Math.min(bottom, Math.round(chatHeight / 2))) <= 3, `${bottom - upHalf} of ${chatHeight}`);
  await page.key(":");
  check(": scrolls down half a page", (await settle()) === bottom);
  for (let i = 0; i < 6; i += 1) await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "'", code: "Quote", windowsVirtualKeyCode: 222, autoRepeat: i > 0 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "'", code: "Quote", windowsVirtualKeyCode: 222 });
  const held = await settle();
  check("a held key keeps scrolling", bottom - held > 250 || held === 0, String(bottom - held));
  check(
    "the cursor stays where it was and the chat does not take the keyboard",
    (await page.eval(isCursor(ids.reader))) && (await page.eval(mode)) === "normal" && !(await page.eval(`!!document.activeElement?.closest("[data-cow-chat]")`)),
  );
  await page.key("\\");
  await settle();

  // Scrolling up while text arrives. bb pins the chat to its newest message again each time
  // it grows, so a scroll in small steps, a trackpad's, never got away. The fixture's provider
  // delivers a message at a time, so text arriving a little at a time is stood in for here:
  // the last row grows many times a second, which is what bb's chat sees while an agent writes.
  const fromEnd = `Math.round(${scroller}.scrollHeight - ${scroller}.clientHeight - ${scroller}.scrollTop)`;
  await page.eval(`(() => { const rows = ${scroller}.querySelectorAll("[data-timeline-row-id]"); const pad = document.createElement("div"); pad.dataset.cowTestGrowth = ""; rows[rows.length - 1].append(pad); let grown = 0; window.__cowGrowth = setInterval(() => { grown += 3; pad.style.height = grown + "px"; }, 16); return true; })()`);
  await sleep(700);
  check("while text arrives the chat follows its newest message", (await page.eval(fromEnd)) <= 12, String(await page.eval(fromEnd)));
  const middle = await page.eval(`(() => { const r = ${scroller}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (let i = 0; i < 150; i += 1) {
    await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: middle[0], y: middle[1], deltaX: 0, deltaY: -2 });
    await sleep(8);
  }
  const wheeled = await page.eval(fromEnd);
  check("scrolling up in small steps, as a trackpad does, leaves the newest message while text arrives", wheeled > 200, String(wheeled));
  await sleep(600);
  const putAt = await page.eval(`Math.round(${scroller}.scrollTop)`);
  await sleep(600);
  check("and the chat stays where it was put while more arrives", Math.abs((await page.eval(`Math.round(${scroller}.scrollTop)`)) - putAt) <= 2 && (await page.eval(fromEnd)) > wheeled);
  await page.waitFor(`!!document.querySelector("[data-cow-chat-below]")`, { label: "the mark for new output below" });
  check("the pane says there is new output below, with the key that goes to it", (await page.eval(`document.querySelector("[data-cow-chat-below]").textContent`)).includes("new output below"));
  await page.key("\\");
  await page.waitFor(`${fromEnd} <= 12 && !document.querySelector("[data-cow-chat-below]")`, { label: "back at the newest message" });
  check("\\ goes back to the newest message, follows it again, and the mark goes", true);
  for (let i = 0; i < 5; i += 1) await page.key("'");
  await sleep(500);
  const keyed = await page.eval(fromEnd);
  check("' scrolls up while text arrives, and is not pulled back", keyed > 300, String(keyed));
  await page.eval(`clearInterval(window.__cowGrowth); document.querySelector("[data-cow-test-growth]")?.remove(); true`);
  await sleep(300);
  await page.key("\\");
  await settle();

  await page.key("/");
  await page.waitFor(`document.activeElement?.dataset.cowFilter === ""`, { label: "the filter" });
  await page.type(";':\"\\");
  const beforeTyping = await page.eval(chatTop);
  check("in the filter the same keys are ordinary characters", (await page.eval(`document.activeElement.value`)) === ";':\"\\");
  check("and typing them there scrolls nothing", (await page.eval(chatTop)) === beforeTyping);
  await page.key("Escape");
  await page.key("Escape");
  await page.waitFor(`!document.querySelector("[data-cow-pane]")`, { label: "the pane closed" });
  for (const key of [";", "'", ":", '"', "\\"]) await page.key(key);
  check("with no chat open they do nothing", (await page.eval(mode)) === "normal" && (await page.eval(isCursor(ids.reader))) && (await page.eval(message)) === "");

  // -- the brief's evidence opens the reader, and returns to the sheet ------------
  const sheet = `document.querySelector("[data-cow-sheet]")`;
  await select(ids.reader);
  await page.key("b");
  await page.waitFor(`!!${sheet}?.querySelector("[data-cow-brief-item]")`, { label: "the fixture's brief" });
  await page.key("l");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-brief-file="proof.txt"]')`, { label: "the claim's evidence" });
  await hintTo(`(target, where) => where === "page" && target.startsWith("button:proof.txt")`, "the evidence file");
  await opened("proof.txt");
  check("a hint on a brief's evidence file opens it in the reader, over the sheet", (await page.eval(rd("Root"))) === "storage" && (await page.eval(`!!${sheet}`)) && (await page.eval(mode)) === "read");
  await page.key("j");
  check("in the reader over a brief, j is the reader's: the sheet's cursor does not move", (await page.eval(rdLine)) === 2 && (await page.eval(`${sheet}.querySelector(".cow-bf-item.cow-cur")?.dataset.cowBriefItem`)) === "claim:proof");
  await page.key("q");
  await closed();
  check("q returns to the brief, still open with its evidence showing", (await page.eval(mode)) === "brief" && (await page.eval(`!!${sheet}.querySelector('[data-cow-brief-file="proof.txt"]')`)));
  await clickOn(`${sheet}.querySelector('[data-cow-brief-file="proof.txt"]')`, "the evidence file");
  await opened("proof.txt");
  check("a click on it opens the reader too", true);
  await page.key("q");
  await closed();
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the brief closed" });

  // -- an ask's proof, and files opened one from another -----------------------
  const withProof = JSON.parse((await cowAs(ids.reader, "ask", "--question", "Are the notes right?", "--option", "yes", "--option", "no", "--proof", "notes.md", "--json")).stdout).ask;
  const second = JSON.parse((await cowAs(ids.reader, "ask", "--question", "Ship it on Friday?", "--json")).stdout).ask;
  await page.waitFor(`${stateOf(ids.reader)} === "wants" && ${lineEl(ids.reader)}.dataset.cowAsks === "2"`, { label: "the fixture's asks" });
  const card = `document.querySelector("[data-cow-ask-card]")`;
  await select(ids.reader);
  await page.key("a");
  await page.waitFor(`${card}?.dataset.cowAsk === "${withProof.id}"`, { label: "the ask's card" });
  check("an ask the person has not written about since does not offer to be closed", !(await page.eval(`!!${card}.querySelector("[data-cow-ask-chat]")`)));
  await hintTo(`(target, where) => where === "page" && target.startsWith("button:notes.md")`, "the proof file");
  await opened("notes.md", `${rd("Kind")} === "rendered"`);
  check("a hint on an ask's proof file opens it in the reader, rendered", (await page.eval(rd("Depth"))) === "1" && (await page.eval(rd("Root"))) === "storage");
  await page.key("j");
  await page.key("j");
  const notesLine = await page.eval(rdLine);
  await hintTo(`(target, where) => where === "page" && target.startsWith("a:proof.txt")`, "the link inside the file");
  await opened("proof.txt", `${rd("Depth")} === "2"`);
  check("a link inside the file opens the file it names, over the first", (await page.eval(`${reader}.querySelector(".cow-rd-head").textContent`)).includes("2 files open"));
  await page.key("q");
  await opened("notes.md", `${rd("Depth")} === "1"`);
  check("q goes back to the file before, with the cursor where it was left", (await page.eval(rdLine)) === notesLine && (await page.eval(rd("Kind"))) === "rendered", `${await page.eval(rdLine)} / ${notesLine}`);
  await clickOn(`[...${reader}.querySelectorAll("a[href]")].find((a) => a.textContent.includes("where keys are read"))`, "the link to a line");
  await opened("src/keys.ts", `${rd("Depth")} === "2" && ${rdLine} === 62`);
  check("a link with a line, clicked inside a file, lands on its line in the file it names", (await page.eval(rd("Root"))) === "workspace" && (await page.eval(rd("Marked"))) === "62-62");
  await page.key("q");
  await opened("notes.md", `${rd("Depth")} === "1"`);
  await page.key("q");
  await closed();
  check("q from the first file returns to the ask's card, still open", (await page.eval(mode)) === "ask" && (await page.eval(`${card}?.dataset.cowAsk`)) === withProof.id);
  await page.key("Escape");
  await page.waitFor(`!${card}`, { label: "the card closed" });

  // -- an ask answered in chat ---------------------------------------------------
  await sleep(1200);
  await tellAs(null, ids.reader, "the notes are right, and yes, ship it on Friday");
  await page.waitFor(`${doing(ids.reader)}.includes("you have messaged this thread since it asked")`, { label: "the line saying the person wrote since", timeout: 120_000 });
  await waitForThread(ids.reader, (t) => t.status === "idle", "the reader at rest");
  check("a line whose thread the person has messaged since it asked says so, and still asks", (await page.eval(stateOf(ids.reader))) === "wants" && (await page.eval(`${lineEl(ids.reader)}.dataset.cowAsks`)) === "2" && (await openAsksOf(ids.reader)).length === 2);
  const queueText = await page.eval(`document.querySelector('[data-cow-queue="${ids.reader}"] p')?.textContent ?? ""`);
  check("so does its entry in the queue", queueText.includes("you have messaged this thread since it asked"), queueText);
  await select(ids.reader);
  await page.key("a");
  await page.waitFor(`${card}?.dataset.cowAsk === "${withProof.id}" && !!${card}.querySelector("[data-cow-ask-chat]")`, { label: "the card with the choice to close" });
  const cardText = await page.eval(`${card}.textContent`);
  check("the card says so plainly and offers one more choice: already answered in chat", cardText.includes("You have messaged this thread since it asked") && cardText.includes("already answered in chat"));
  await page.key("4");
  check("its digit, the one after the options and the field for words, only marks it: nothing is closed yet", (await page.eval(`${card}.querySelector("[data-cow-ask-chat]").dataset.cowChosen`)) === "true" && (await openAsksOf(ids.reader)).length === 2);
  await shot("ask-answered-in-chat");
  const sentBefore = (await api(`/threads/${ids.reader}/events?types=client/turn/requested&limit=1&order=desc`))[0]?.seq;
  await page.key("Enter");
  await page.waitFor(`${card}?.dataset.cowAsk === "${second.id}"`, { label: "the next ask in the card" });
  const closedAsk = (await rpc("asks_list", { threadId: ids.reader, all: true })).asks.find((ask) => ask.id === withProof.id);
  check(
    "Enter closes it as answered in chat, by the person: not an answer, not a withdrawal, and nothing is sent to the thread",
    closedAsk.status === "closed" && closedAsk.closed.by === "person" && closedAsk.answer === null && closedAsk.withdrawnAt === null && (await api(`/threads/${ids.reader}/events?types=client/turn/requested&limit=1&order=desc`))[0]?.seq === sentBefore,
    JSON.stringify(closedAsk.closed),
  );
  check("the card says what happened and moves to the next ask", (await page.eval(`${card}.querySelector("[data-cow-ask-sent]")?.textContent ?? ""`)).includes("closed as answered in chat: nothing was sent"));
  check(
    "the next ask has no options: its field does not take the caret while the choice is offered, and each has a digit",
    (await page.eval(`${card}.querySelector("[data-cow-ask-chat] kbd").textContent`)) === "2" && (await page.eval(`${card}.querySelector(".cow-ans-text kbd")?.textContent`)) === "1" && (await page.eval(`document.activeElement?.dataset.cowInput ?? null`)) === null,
  );
  await page.key("Escape");
  await page.waitFor(`!${card}`, { label: "the card closed" });
  const notTheirs = await cowAs(ids.pkid, "ask", "close", second.id, "--answered", "yes");
  check("bb cow ask close is refused for a thread that is neither the asking thread nor above it", notTheirs.code !== 0, notTheirs.stderr);
  const noAnswer = await cowAs(ids.reader, "ask", "close", second.id, "--answered", " ");
  check("it needs the answer the person gave", noAnswer.code !== 0 && /--answered is empty/.test(noAnswer.stderr + noAnswer.stdout), noAnswer.stderr);
  const byThread = await cowAs(ids.reader, "ask", "close", second.id, "--answered", "yes, ship it on Friday");
  await page.waitFor(`${lineEl(ids.reader)}?.dataset.cowAsks === undefined && ${stateOf(ids.reader)} === "wants"`, { label: "the line without its asks" });
  check(
    "bb cow ask close, run by the asking thread, closes it with the answer as quoted, and it leaves the page at once",
    byThread.code === 0 && /closed ask_\w+ as answered in chat/.test(byThread.stdout) && !(await page.eval(doing(ids.reader))).includes("asks you") && (await openAsksOf(ids.reader)).length === 0,
    byThread.stdout + byThread.stderr,
  );
  const listed = (await cow("asks", "--thread", ids.reader, "--all")).stdout;
  check(
    "bb cow asks --all lists both, each labelled by who closed it",
    listed.includes("closed by the user on cow's page: answered in chat") && listed.includes("closed by the thread: answered in chat: yes, ship it on Friday"),
    listed.slice(-400),
  );

  // -- archiving a project is the person saying it is finished -----------------
  await page.waitFor(`${lineEl(ids.reader)}.dataset.cowReply === ""`, { label: "the reply to the person's message" });
  await select(ids.reader);
  await page.key(" ");
  await page.waitFor(`${stateOf(ids.reader)} === "idle"`, { label: "the project idle again" });
  await page.key("e");
  await page.waitFor(`!!document.querySelector('[data-cow-input="archive-reason"]')`, { label: "the archive prompt" });
  check("e offers to archive an idle project", true);
  await page.type("finished for good");
  await page.key("Enter");
  await page.waitFor(`${stateOf(ids.reader)} === "done" && !${inTree(ids.reader)}`, { label: "the project under Done" });
  check("archived, a project leaves the tree and is listed under Done with its reason", (await page.eval(`${lineEl(ids.reader)}.querySelector("[data-cow-archive-reason]")?.textContent ?? ""`)).includes("finished for good") && (await page.eval(projectOf(ids.reader))) === null);
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${stateOf(ids.reader)} === "idle" && ${inTree(ids.reader)}`, { label: "the archive undone" });
  check("undone, it is a project again, idle in the tree", (await page.eval(projectOf(ids.reader))) === "marked");
  await rpc("archive_note_set", { threadId: ids.reader, note: null });

  // -- both themes, and a narrow window --------------------------------------
  await select(ids.reader);
  await page.key("Enter");
  // Its links are further up by now, perhaps not drawn yet: the click scrolls to them with cow's keys.
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.reader}" && !!document.querySelector("[data-cow-chat] [data-timeline-row-id]")`, { label: "the chat again", timeout: 30_000 });
  await sleep(2500);
  await page.colorScheme("dark");
  await clickOn(chatLink("the keys"), "the keys link");
  await opened("src/keys.ts", `${rdLine} === 62`);
  const colours = await page.eval(`(() => { const s = getComputedStyle(${reader}); return [s.backgroundColor, s.color, getComputedStyle(${ROOT}).backgroundColor].join("|"); })()`);
  const [paper, ink, pagePaper] = colours.split("|");
  check("the reader draws with bb's theme: its paper is the page's, and its ink differs from it", paper === pagePaper && paper !== ink, colours);
  await shot("reader-dark");
  await page.colorScheme("light");
  await page.resize(700, 800);
  await sleep(1500);
  if (!(await page.eval(`!!${reader}`))) {
    // bb remounts the page when its layout changes; the file is opened again.
    await page.waitFor(`${screen} === "overview"`, { label: "the page in a narrow window" });
    await select(ids.reader);
    await page.key("Enter");
    await page.waitFor(`!!document.querySelector("[data-cow-chat] [data-timeline-row-id]")`, { label: "the chat in a narrow window", timeout: 30_000 });
    await sleep(2500);
    await clickOn(chatLink("the keys"), "the keys link");
    await opened("src/keys.ts", `${rdLine} === 62`);
  }
  check("in a narrow window the reader fits without scrolling sideways, and the cursor's line is in view", (await page.eval(`${reader}.scrollWidth <= ${reader}.clientWidth + 1 && ${reader}.querySelector("[data-cow-reader-scroll]").scrollWidth <= ${reader}.querySelector("[data-cow-reader-scroll]").clientWidth + 1`)) && (await page.eval(cursorShown)));
  await shot("reader-narrow");
  await page.key("q");
  await closed();
  await page.resize(1440, 900);
  await sleep(1500);
  await page.waitFor(`${screen} === "overview"`, { label: "the page at full width again" });
  if (await page.eval(`!!document.querySelector("[data-cow-pane]")`)) await page.key("Escape");

  // -- put back --
  await cow("project", ids.reader, "--clear");
  await restoreReading();
  if (!flag("keep")) rmSync(join(workspace, ".cow-e2e"), { recursive: true, force: true });
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
  // A page left open by an earlier run would go on acting on the fixtures:
  // a chat open in its pane marks that thread's reply seen as it arrives.
  // This Chrome is the check's own, so every tab but one is closed too.
  const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((tab) => tab.type === "page");
  for (const tab of tabs.slice(1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => undefined);
  const stale = await connect(PORT, "");
  await stale.goto("about:blank");
  stale.close();
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

  if (flag("only-reader")) {
    const page = await connect(PORT, "");
    const shot = async (name) => {
      if (SHOTS) await page.shot(join(SHOTS, `${name}.png`));
    };
    await page.goto(`${BB}/plugins/cow/main`);
    await page.eval(`sessionStorage.removeItem("cow:main"); sessionStorage.removeItem("cow:test-clock-offset-ms"); true`);
    await page.resize(1440, 900);
    await page.colorScheme("light");
    await page.goto(`${BB}/plugins/cow/main`);
    await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page", timeout: 60_000 });
    const chooseMain = async (tab, id) => {
      if ((await tab.eval(screen)) === "overview") await tab.key("M");
      await tab.waitFor(`${screen} === "picker"`, { label: "the picker" });
      await tab.eval(`document.querySelector('[data-cow-line="${id}"]').click(); true`);
      await tab.waitFor(`${screen} === "overview" && document.querySelector(".cow-mainline")?.dataset.cowLine === "${id}"`, { label: "the overview" });
      await restoreStored();
    };
    await readingChecks(page, ids, shot, chooseMain);
    return finish(page);
  }

  await waitForThread(ids.main, (t) => t.status === "idle", "idle");
  await waitForThread(ids.quiet, (t) => t.status === "idle", "idle");
  await waitForThread(ids.asks, (t) => t.hasPendingInteraction, "asking");
  await waitForThread(ids.fails, (t) => t.status === "error", "failed");
  await waitForThread(ids.leaf, (t) => t.status === "idle", "idle");
  await waitForThread(ids.runs, (t) => t.status === "idle", "idle");
  await waitForThread(ids.perms, (t) => t.status === "idle" && !t.hasPendingInteraction, "idle");
  // The reset message was sent as the user, so its reply is addressed to them.
  // The run starts with that one seen; the page's own ways of seeing a reply
  // are checked on the group head.
  const resetEnd = (await api(`/threads/${ids.perms}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
  if (resetEnd !== undefined) await rpc("seen_set", { threadId: ids.perms, seen: { seq: resetEnd, at: Date.now() } });

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
  if (flag("only-raised")) {
    await raisedChecks(page, ids, shot, chooseMain);
    return finish(page);
  }

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
  // A tab in the background runs no animations, and bb's menus close with one.
  await page.send("Page.bringToFront");

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
    "lines follow the tree: child, its child, that one's child, next child; then the two done ones",
    JSON.stringify(listedOrder.slice(0, 4)) === JSON.stringify([ids.quiet, ids.fails, ids.leaf, ids.asks]) &&
      JSON.stringify(listedOrder.slice(4).sort()) === JSON.stringify([ids.runs, ids.perms].sort()),
    order,
  );

  // -- groups: three levels, drawn as nested groups --
  const lineData = (id, name) => `(document.querySelector('.cow-main [data-cow-line="${id}"]')?.dataset.${name} ?? null)`;
  const rollupOf = (id) =>
    `(document.querySelector('.cow-main [data-cow-line="${id}"] [data-cow-rollup]')?.dataset.cowRollup ?? null)`;
  const shape = JSON.parse(
    await page.eval(`JSON.stringify(Object.fromEntries(["${ids.quiet}", "${ids.fails}", "${ids.leaf}", "${ids.asks}"].map((id) => {
      const el = document.querySelector('.cow-main [data-cow-line="' + id + '"]');
      const rails = [...el.querySelectorAll(".cow-rail")];
      return [id, {
        depth: el.dataset.cowDepth,
        fold: el.dataset.cowFold ?? null,
        rails: rails.length,
        railHeights: rails.map((rail) => rail.getBoundingClientRect().height),
        height: el.getBoundingClientRect().height,
        titleLeft: el.querySelector(".cow-title").getBoundingClientRect().left,
      }];
    })))`),
  );
  check(
    "a thread with threads under it heads a group, and groups nest",
    shape[ids.quiet].fold === "open" && shape[ids.fails].fold === "open" && shape[ids.leaf].fold === null && shape[ids.asks].fold === null &&
      [shape[ids.quiet].depth, shape[ids.fails].depth, shape[ids.leaf].depth, shape[ids.asks].depth].join() === "0,1,2,0",
    JSON.stringify(shape),
  );
  check(
    "each member is tied to its groups by one rule per level, unbroken down the row",
    shape[ids.quiet].rails === 0 && shape[ids.fails].rails === 1 && shape[ids.leaf].rails === 2 &&
      shape[ids.leaf].railHeights.every((height) => height === shape[ids.leaf].height),
    JSON.stringify(shape[ids.leaf]),
  );
  check(
    "a grandchild is indented under its parent",
    shape[ids.leaf].titleLeft > shape[ids.fails].titleLeft && shape[ids.fails].titleLeft > shape[ids.quiet].titleLeft,
    [shape[ids.quiet].titleLeft, shape[ids.fails].titleLeft, shape[ids.leaf].titleLeft].join(" < "),
  );
  await page.waitFor(`${rollupOf(ids.quiet)} === "failed:1 done:1"`, { label: "the outer group's rollup" });
  check(
    "a head's line counts everything under it by state, at every level",
    (await page.eval(rollupOf(ids.fails))) === "done:1" && (await page.eval(rollupOf(ids.leaf))) === null,
    `${await page.eval(rollupOf(ids.quiet))} / ${await page.eval(rollupOf(ids.fails))}`,
  );
  check(
    "a finished member stays inside its group, not under Done",
    (await page.eval(lineState(ids.leaf))) === "done" &&
      (await page.eval(`document.querySelector('.cow-main [data-cow-line="${ids.leaf}"]').dataset.cowDepth`)) === "2",
  );

  // -- attention: whose a finished turn's reply is --
  const whText = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"] .cow-wh')?.textContent ?? "")`;
  const isReply = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"]')?.dataset.cowReply === "")`;
  const queueText = (id) => `(document.querySelector('[data-cow-queue="${id}"] p')?.textContent ?? "")`;
  const pageMessage = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const seenOf = async (id) => (await rpc("notes_list", { threadIds: [id] })).seen[id] ?? null;
  const lastTurnEnd = async (id) =>
    (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq ?? null;
  // Whatever it said last: a fixture from an earlier run may not have said "ok".
  const quietSaid = (await api(`/threads/${ids.quiet}/output`)).output.trim();
  await page.waitFor(`${lineState(ids.quiet)} === "wants" && ${isReply(ids.quiet)}`, { label: "the group head's reply" });
  check(
    "a group head that finished a turn replied to you, whoever started the turn",
    (await page.eval(whText(ids.quiet))).startsWith(`replied to you: ${quietSaid}`),
    await page.eval(whText(ids.quiet)),
  );
  check(
    "its reply is in the queue, with its first line",
    (await page.eval(queueText(ids.quiet))) === `replied to you: ${quietSaid}`,
    await page.eval(queueText(ids.quiet)),
  );
  check(
    "a leaf that finished a turn its parent started is done, and not in the queue",
    (await page.eval(lineState(ids.leaf))) === "done" &&
      !(await page.eval(`!!document.querySelector('[data-cow-queue="${ids.leaf}"]')`)) &&
      (await page.eval(lineState(ids.runs))) === "done" &&
      !(await page.eval(isReply(ids.leaf))),
  );
  check(
    "the leaf's line still says what it reported",
    (await page.eval(whText(ids.leaf))) === (await api(`/threads/${ids.leaf}/output`)).output.trim(),
    await page.eval(whText(ids.leaf)),
  );
  await shot("groups-light");
  // Space marks it seen; u takes that back; opening its chat marks it seen too.
  await page.key("g");
  await page.key("g");
  await page.key("j");
  check("the cursor is on the group head", await page.eval(isCursor(ids.quiet)));
  check("the verb bar offers to mark its reply seen", await page.eval(`!!document.querySelector('[data-cow-verb="seen"]')`));
  await page.key(" ");
  await page.waitFor(`${lineState(ids.quiet)} === "idle"`, { label: "the reply marked seen" });
  const quietEnd = await lastTurnEnd(ids.quiet);
  check(
    "Space marks the reply seen: the line is done, out of the queue, and cow recorded the turn",
    !(await page.eval(`!!document.querySelector('[data-cow-queue="${ids.quiet}"]')`)) &&
      (await seenOf(ids.quiet))?.seq === quietEnd &&
      (await page.eval(pageMessage)).startsWith("marked as seen"),
    JSON.stringify([await seenOf(ids.quiet), quietEnd]),
  );
  check("the record is cow's own, not a note on the thread", !JSON.stringify(
    (await api(`/threads?threadIds=${ids.quiet}&limit=1`))[0]).includes('"seen"'));
  await page.key("u");
  check(
    "u offers to take the mark back",
    (await page.eval(`document.querySelector("[data-cow-confirm] label")?.textContent ?? ""`)).includes("as seen"),
  );
  await page.key("y");
  await page.waitFor(`${lineState(ids.quiet)} === "wants" && ${isReply(ids.quiet)}`, { label: "the mark undone" });
  check("undone, the reply waits on you again", (await seenOf(ids.quiet)) === null);
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.quiet}"`, {
    label: "the head's chat",
  });
  await page.waitFor(`${lineState(ids.quiet)} === "idle"`, { label: "seen by opening its chat" });
  check("opening its chat from the page marks the reply seen", (await seenOf(ids.quiet))?.seq === quietEnd);
  await page.key("Escape");
  await page.key(" ");
  check(
    "Space on a line with no reply waiting says so and records nothing new",
    (await page.eval(pageMessage)) === "it has no reply waiting on you" && (await seenOf(ids.quiet))?.seq === quietEnd,
    await page.eval(pageMessage),
  );
  const numbered = JSON.parse(
    await page.eval(`JSON.stringify(Object.fromEntries([...${ROOT}.querySelectorAll("[data-cow-line]")]
      .map((el) => [el.dataset.cowLine, el.querySelector(".cow-qn")?.textContent ?? ""])))`),
  );
  const queueSize = await page.eval(`document.querySelectorAll("[data-cow-queue]").length`);
  check(
    "the queue numbers the question and the failure, not the finished leaf or the head that was seen",
    numbered[ids.asks] !== "" && numbered[ids.fails] !== "" && numbered[ids.quiet] === "" && numbered[ids.leaf] === "",
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
  const paneOf = `(document.querySelector("[data-cow-pane]")?.dataset.cowPane ?? null)`;
  const openMarks = `JSON.stringify([...${ROOT}.querySelectorAll("[data-cow-open]")].map((el) => el.dataset.cowLine))`;
  const inChatNow = `!!document.activeElement?.closest("[data-cow-chat]")`;
  await page.key("g");
  await page.key("g");
  check("g g lands on the heading: Main is a cursor stop", await page.eval(isCursor(ids.main)));
  await page.key("k");
  check("k at the heading stays there", await page.eval(isCursor(ids.main)));
  await page.key("j");
  check("j from the heading goes to the first line", await page.eval(isCursor(ids.quiet)));
  await page.key("k");
  check("k from the first line goes to the heading", await page.eval(isCursor(ids.main)));
  await page.key("I");
  check(
    "I on the heading says to Main",
    (await page.eval(`document.querySelector(".cow-prompt label")?.textContent`)) === `to Main · ${TITLE}`,
  );
  await page.key("Escape");
  await page.key("Enter");
  await page.waitFor(`${paneOf} === "${ids.main}"`, { label: "Main's chat from the heading" });
  check("Enter on the heading opens Main's chat", true);
  check(
    "the pane names the thread whose chat it shows",
    (await page.eval(`document.querySelector("[data-cow-pane-title]")?.textContent`)) === `Main · ${TITLE}`,
  );
  await page.key("Enter");
  await sleep(800);
  check(
    "Enter again on the same line does nothing: the pane stays and the keyboard stays here",
    (await page.eval(paneOf)) === ids.main && !(await page.eval(inChatNow)) && (await page.eval(isCursor(ids.main))),
  );
  await page.key("j");
  await page.key("j");
  check(
    "the thread whose chat is open is marked, apart from the cursor",
    (await page.eval(openMarks)) === JSON.stringify([ids.main]) && (await page.eval(isCursor(ids.fails))),
    await page.eval(openMarks),
  );
  await sleep(2600);
  await page.key("i");
  await page.waitFor(inChatNow, { label: "the caret in the open chat", timeout: 5000 });
  await page.type("ii9");
  await sleep(300);
  check(
    "i types into the chat that is open, wherever the cursor is",
    (await page.eval(paneOf)) === ids.main &&
      (await page.eval(`document.querySelector("[data-cow-chat]").textContent.includes("ii9")`)) &&
      (await page.eval(`!document.querySelector("[data-cow-say]")`)),
  );
  for (let i = 0; i < 3; i += 1) await page.key("Backspace");
  await page.key("Escape");
  check(
    "Escape from the composer returns to the overview with the cursor where it was",
    !(await page.eval(inChatNow)) && (await page.eval(isCursor(ids.fails))) && (await page.eval(mode)) === "normal",
  );
  await page.key("Enter");
  await page.waitFor(`${paneOf} === "${ids.fails}"`, { label: "the pane switching" });
  check(
    "Enter on a line whose chat is not the open one switches the pane to it, and the mark moves",
    (await page.eval(openMarks)) === JSON.stringify([ids.fails]),
    await page.eval(openMarks),
  );
  await page.key("Escape");
  check("with the pane closed nothing is marked open", (await page.eval(openMarks)) === "[]" && (await page.eval(paneOf)) === null);
  await page.key("i");
  check(
    "with no chat open, i is the one-line say to Main",
    (await page.eval(`document.querySelector(".cow-prompt label")?.textContent`)) === `to Main · ${TITLE}`,
  );
  await page.key("Escape");
  await page.key("g");
  await page.key("g");
  await page.key("j");
  await page.key("j");
  check("j moves down", await page.eval(isCursor(ids.fails)));
  await page.key("k");
  check("k moves up", await page.eval(isCursor(ids.quiet)));
  await page.key("ArrowDown");
  await page.key("ArrowDown");
  check("arrows move too", await page.eval(isCursor(ids.leaf)));
  await page.key("ArrowUp");
  check("arrow up moves up", await page.eval(isCursor(ids.fails)));
  await page.key("G");
  check("G goes to the bottom", await page.eval(isCursor(listedOrder[listedOrder.length - 1])));

  // -- folding a group --
  const inTree = (id) => `!!document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const goTo = async (id) => {
    await page.key("g");
    await page.key("g");
    for (let i = 0; i < 40 && !(await page.eval(isCursor(id))); i += 1) await page.key("j");
    if (!(await page.eval(isCursor(id)))) throw new Error(`could not select ${id}`);
  };
  await goTo(ids.fails);
  await page.key("h");
  check(
    "h folds a group: its members leave the page, and the head says how many",
    (await page.eval(lineData(ids.fails, "cowFold"))) === "folded" &&
      !(await page.eval(inTree(ids.leaf))) &&
      (await page.eval(`document.querySelector('[data-cow-line="${ids.fails}"] [data-cow-folded]')?.dataset.cowFolded`)) === "1" &&
      (await page.eval(isCursor(ids.fails))),
  );
  check("a folded group still shows its rollup", (await page.eval(rollupOf(ids.fails))) === "done:1");
  await page.key("j");
  check("j skips a folded group's members", await page.eval(isCursor(ids.asks)));
  await page.key("k");
  check("k comes back onto the folded head", await page.eval(isCursor(ids.fails)));
  await page.key("l");
  check(
    "l unfolds it",
    (await page.eval(lineData(ids.fails, "cowFold"))) === "open" && (await page.eval(inTree(ids.leaf))) && (await page.eval(isCursor(ids.fails))),
  );
  await page.key("l");
  check("l on an unfolded head steps onto its first member", await page.eval(isCursor(ids.leaf)));
  await page.key("h");
  check("h on a member jumps to its group's head", await page.eval(isCursor(ids.fails)));
  await page.key("h");
  await page.key("h");
  check("h on a folded head that is itself a member goes up a level", await page.eval(isCursor(ids.quiet)));
  await page.key("h");
  check(
    "folding the outer group hides both levels, and says something inside waits on you",
    !(await page.eval(inTree(ids.fails))) && !(await page.eval(inTree(ids.leaf))) &&
      (await page.eval(`document.querySelector('[data-cow-line="${ids.quiet}"] [data-cow-inside]')?.dataset.cowInside`)) === "1" &&
      (await page.eval(rollupOf(ids.quiet))) === "failed:1 done:1",
  );
  await shot("folded");
  await page.key("j");
  check("j goes from the folded group to the next line outside it", await page.eval(isCursor(ids.asks)));
  await page.goto(`${BB}/plugins/cow/main`);
  await page.waitFor(`${screen} === "overview" && ${inTree(ids.quiet)}`, { label: "the page reloaded" });
  check(
    "the fold is this window's, and survives a reload",
    (await page.eval(lineData(ids.quiet, "cowFold"))) === "folded" && !(await page.eval(inTree(ids.fails))),
  );
  const failsNumber = await page.waitFor(
    `document.querySelector('[data-cow-queue="${ids.fails}"] .cow-qn')?.textContent`,
    { label: "the failure in the queue" },
  );
  await page.key(failsNumber);
  check(
    "jumping to a queue entry inside a folded group unfolds what hides it, and no more",
    (await page.eval(isCursor(ids.fails))) &&
      (await page.eval(lineData(ids.quiet, "cowFold"))) === "open" &&
      (await page.eval(lineData(ids.fails, "cowFold"))) === "folded",
  );
  await page.key("l");
  check("everything is unfolded again", await page.eval(inTree(ids.leaf)));

  // -- filtering the lines --
  const treeIds = `JSON.stringify([...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine))`;
  const contextIds = `JSON.stringify([...document.querySelectorAll(".cow-main [data-cow-context]")].map((el) => el.dataset.cowLine))`;
  const matchCount = `Number(document.querySelector("[data-cow-filter-count]")?.dataset.cowFilterCount ?? -1)`;
  const allLines = JSON.parse(await page.eval(treeIds));
  await goTo(ids.quiet);
  await page.key("h");
  check("a group is folded before filtering", !(await page.eval(inTree(ids.fails))));
  await page.key("/");
  check(
    "/ opens the filter, and the caret is in it",
    (await page.eval(mode)) === "filter" && (await page.eval(`document.activeElement?.hasAttribute("data-cow-filter")`)),
  );
  await page.type("no-such-model");
  await page.waitFor(`${matchCount} === 1`, { label: "one match" });
  check(
    "typing narrows the page to the lines that match, here by what the line says",
    (await page.eval(treeIds)) === JSON.stringify([ids.quiet, ids.fails]) && (await page.eval(isCursor(ids.fails))),
    await page.eval(treeIds),
  );
  check(
    "a match inside a folded group shows, with its group's head kept for context",
    (await page.eval(contextIds)) === JSON.stringify([ids.quiet]) && (await page.eval(lineData(ids.quiet, "cowFold"))) === "open",
    await page.eval(contextIds),
  );
  await shot("filter");
  await page.key("Escape");
  check(
    "Escape cancels: the whole list, the cursor and the folds are as they were",
    (await page.eval(mode)) === "normal" &&
      (await page.eval(isCursor(ids.quiet))) &&
      (await page.eval(lineData(ids.quiet, "cowFold"))) === "folded" &&
      !(await page.eval(inTree(ids.fails))),
  );
  await page.key("/");
  await page.type("Which COL");
  await page.waitFor(`${matchCount} === 1`, { label: "the question matching" });
  check("matching ignores case", (await page.eval(treeIds)) === JSON.stringify([ids.asks]), await page.eval(treeIds));
  await page.key("Enter");
  check(
    "Enter closes the filter with the cursor on the chosen line, and the full list is back",
    (await page.eval(mode)) === "normal" &&
      (await page.eval(isCursor(ids.asks))) &&
      (await page.eval(inTree(ids.quiet))) &&
      (await page.eval(lineData(ids.quiet, "cowFold"))) === "folded",
  );
  await goTo(ids.quiet);
  await page.key("/");
  await page.type("cwtst");
  await page.waitFor(`${matchCount} === ${allLines.length}`, { label: "every line matching loosely" });
  check(
    "a name matches loosely, letters in order; parked and done lines are searched too",
    (await page.eval(treeIds)) === JSON.stringify(allLines) && (await page.eval(isCursor(ids.quiet))),
    `${await page.eval(matchCount)} of ${allLines.length}`,
  );
  await page.key("n", { ctrl: true });
  check("Ctrl+n moves to the next match", await page.eval(isCursor(ids.fails)));
  await page.key("ArrowDown");
  await page.key("p", { ctrl: true });
  check("the arrows and Ctrl+p move too", await page.eval(isCursor(ids.fails)));
  check(
    "letters typed in the filter are text, not keys",
    (await page.eval(`document.querySelector("[data-cow-filter]")?.value`)) === "cwtst",
  );
  await page.key("Enter");
  check(
    "keeping a match inside a folded group unfolds what hides it",
    (await page.eval(isCursor(ids.fails))) && (await page.eval(lineData(ids.quiet, "cowFold"))) === "open",
  );
  await page.key("/");
  await page.type("zzzz");
  await page.waitFor(`${matchCount} === 0`, { label: "no match" });
  await page.key("Enter");
  check(
    "with no match, Enter leaves the cursor where it was",
    (await page.eval(isCursor(ids.fails))) && (await page.eval(mode)) === "normal",
  );

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
    "every line and usable action in view has a hint, each its own",
    hints.labels.length >= hints.targets && new Set(hints.labels).size === hints.labels.length,
    `${hints.labels.length} hints for ${hints.targets} of cow's own targets`,
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
  await sleep(800);
  check(
    "m again does not put the caret in the chat",
    (await page.eval(`!document.activeElement?.closest("[data-cow-chat]")`)) &&
      (await page.eval(`document.querySelector("[data-cow-pane]")?.dataset.cowPane`)) === ids.main,
  );
  await page.key("i");
  await page.waitFor(`!!document.activeElement?.closest("[data-cow-chat]")`, {
    label: "focus inside the chat",
    timeout: 5000,
  });
  check("i is the key that puts the caret in the open chat", true);
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
  await goTo(ids.quiet);
  await page.key("I");
  const toLine = await page.eval(`document.querySelector(".cow-prompt label")?.textContent`);
  check("I addresses the selected thread, and says so", toLine === `to thread · ${TITLE}`, toLine);
  await page.key("Escape");
  check("Escape cancels say", (await page.eval(mode)) === "normal");

  // -- a line changing state live, and a reply after the one that was seen --
  await page.key("I");
  await page.type("reply with exactly: ok");
  await page.key("Enter");
  await page.waitFor(`${lineState(ids.quiet)} === "running"`, { label: "the line running", timeout: 30_000 });
  check("a state change shows live: a line starts running", true);
  await page.waitFor(`${lineState(ids.quiet)} === "wants" && ${isReply(ids.quiet)}`, {
    label: "the line finishing",
    timeout: 120_000,
  });
  check("a state change shows live: it finishes, and a reply after the seen one waits on you again", true);
  check("the line kept its place and the cursor", await page.eval(isCursor(ids.quiet)));
  check(
    "the new reply is in the queue",
    (await page.eval(queueText(ids.quiet))).startsWith("replied to you: "),
    await page.eval(queueText(ids.quiet)),
  );
  // Answering it from the page is having read it.
  const secondEnd = await lastTurnEnd(ids.quiet);
  await page.key("I");
  await page.type("reply with exactly: ok");
  await page.key("Enter");
  await page.waitFor(`${lineState(ids.quiet)} === "running"`, { label: "the line running again", timeout: 30_000 });
  check(
    "sending it a message from the page marks the reply it answers as seen",
    secondEnd > quietEnd && (await seenOf(ids.quiet))?.seq === secondEnd,
    JSON.stringify([quietEnd, secondEnd, await seenOf(ids.quiet)]),
  );
  await page.waitFor(`${lineState(ids.quiet)} === "wants" && ${isReply(ids.quiet)}`, {
    label: "its next reply",
    timeout: 120_000,
  });
  await page.key(" ");
  await page.waitFor(`${lineState(ids.quiet)} === "idle"`, { label: "that reply marked seen" });
  // A leaf told by another thread reports to that thread: it is done.
  await tellAs(ids.main, ids.perms, "hello");
  await page.waitFor(`${lineState(ids.perms)} === "running"`, { label: "the leaf running", timeout: 30_000 });
  await page.waitFor(`${lineState(ids.perms)} === "done"`, { label: "the leaf finishing", timeout: 120_000 });
  check(
    "a leaf that finishes a turn another thread started is done, not waiting on you",
    !(await page.eval(isReply(ids.perms))) &&
      !(await page.eval(`!!document.querySelector('[data-cow-queue="${ids.perms}"]')`)),
  );

  const cursorBefore = await page.eval(cursorId);
  const LINK = "https://example.com/cow-test";
  const note = `jk12 note ${Date.now()} ${LINK}`;
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
  await page.waitFor(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState === "idle"`, {
    label: "Main read",
    timeout: 30_000,
  });
  check("opening Main's chat reads the reply, and it leaves the queue", await page.eval(`!document.querySelector('[data-cow-queue="${ids.main}"]')`));

  // -- hints reach everything clickable, inside the chat too --
  const hintList = async () =>
    JSON.parse(
      await page.eval(`JSON.stringify([...document.querySelectorAll("[data-cow-hint-label]")].map((el) => ({
        label: el.dataset.cowHintLabel, in: el.dataset.cowHintIn, for: el.dataset.cowHintFor })))`),
    );
  const typeHint = async (label) => {
    for (const letter of label) await page.key(letter);
  };
  await page.waitFor(`!!document.querySelector('[data-cow-chat] a[href^="${LINK}"]')`, { label: "the link in the chat" });
  await page.eval(`window.__cowClicks = [];
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) return;
      // Recorded, and stopped from leaving the page: the check is that the click arrives.
      window.__cowClicks.push(link.getAttribute("href"));
      event.preventDefault();
    }, true); true`);
  await page.key("f");
  const inChat = await hintList();
  await shot("hints-chat");
  const ownLines = inChat.filter((hint) => hint.for.startsWith("thr_"));
  check(
    "with the chat open, cow's own lines still come first, one letter each",
    ownLines.length >= 5 && ownLines.every((hint, index) => hint.label.length === 1 && inChat[index] === hint),
    ownLines.map((hint) => hint.label).join(" "),
  );
  const linkHint = inChat.find((hint) => hint.in === "chat" && hint.for.startsWith(`a:${LINK}`));
  const composerHint = inChat.find((hint) => hint.in === "chat" && /^(div|textarea):Ask/.test(hint.for));
  const toggleHint = inChat.find((hint) => hint.in === "chat" && /^button:Collapse/.test(hint.for));
  check(
    "hints label what the chat draws: a link, a button, the composer",
    !!linkHint && !!composerHint && !!toggleHint && new Set(inChat.map((hint) => hint.label)).size === inChat.length,
    JSON.stringify(inChat.filter((hint) => hint.in === "chat")),
  );
  await typeHint(linkHint?.label ?? "");
  check(
    "a hint activates a link inside the chat with a click",
    (await page.eval(`JSON.stringify(window.__cowClicks)`)) === JSON.stringify([LINK]) && (await page.eval(mode)) === "normal",
    await page.eval(`JSON.stringify(window.__cowClicks)`),
  );
  const childThreads = `document.querySelector('[data-cow-chat] button[aria-label*="active child thread"]')?.getAttribute("aria-expanded")`;
  const expandedBefore = await page.eval(childThreads);
  await page.key("f");
  check("the same things get the same hints the next time", JSON.stringify(await hintList()) === JSON.stringify(inChat));
  await typeHint(toggleHint?.label ?? "");
  await page.waitFor(`${childThreads} === "false"`, { label: "the chat's disclosure toggling", timeout: 5000 });
  check("a hint activates a button inside the chat: its list of child threads folds", expandedBefore === "true");
  check("the keyboard stays with the overview afterwards", await page.eval(`!document.activeElement?.closest("[data-cow-chat]")`));
  // A button the chat draws only under the mouse takes a hint too, and the
  // menu it opens outside the pane is reached by pressing f again.
  const openMenus = `[...document.querySelectorAll('[role="menu"]')].filter((el) => !el.closest("[data-cow-root]") && el.dataset.state !== "closed").length`;
  await page.key("f");
  const withHover = await hintList();
  const actionsHint = withHover.find((hint) => hint.in === "chat" && hint.for === "button:Message actions");
  check(
    "copy buttons and message menus in the chat take hints",
    !!actionsHint && withHover.some((hint) => hint.in === "chat" && hint.for === "button:Copy message"),
    JSON.stringify(withHover.filter((hint) => hint.in === "chat").map((hint) => hint.for)),
  );
  await typeHint(actionsHint?.label ?? "");
  await page.waitFor(`${openMenus} === 1`, { label: "bb's message menu", timeout: 5000 });
  check("a hint opens a menu of bb's, as a click would", true);
  await page.key("f");
  // No screenshot here: taken with bb's menu open, it leaves the menu
  // half-closed in headless Chrome for the rest of the run.
  const inBbMenu = await hintList();
  check(
    "f again labels the entries of the menu that opened outside the pane, and only those",
    inBbMenu.length > 0 && inBbMenu.every((hint) => hint.in === "popup"),
    JSON.stringify(inBbMenu),
  );
  await page.key("Escape");
  check("Escape leaves hint mode with the menu still open", (await page.eval(openMenus)) === 1 && (await hintList()).length === 0);
  await page.key("Escape");
  await page.waitFor(`${openMenus} === 0`, { label: "bb closing its menu", timeout: 5000 });
  check("the next Escape is the menu's own, and closes it", true);
  // bb holds the page still until its menu has finished closing.
  await page.waitFor(`getComputedStyle(document.body).pointerEvents !== "none"`, { label: "the menu gone" });
  await sleep(1500);
  await page.key("f");
  const composerAgain = (await hintList()).filter((hint) => hint.in === "chat" && /^(div|textarea):/.test(hint.for));
  await typeHint(composerAgain.find((hint) => /^(div|textarea):Ask/.test(hint.for))?.label ?? "");
  await page.waitFor(`!!document.activeElement?.closest("[data-cow-chat]")`, { label: "the caret in the composer", timeout: 5000 });
  await page.type("hint1");
  await sleep(300);
  check(
    "a hint on the composer puts the caret in it, and typing works",
    await page.eval(`document.querySelector("[data-cow-chat]").textContent.includes("hint1")`),
  );
  for (let i = 0; i < 5; i += 1) await page.key("Backspace");
  await page.key("Escape");
  // A menu of bb's opens outside the page. This one is a stand-in made by the
  // check, since the compact chat offers none: f labels what it offers and
  // nothing else, and the hint clicks it.
  await page.eval(`(() => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.dataset.state = "open";
    menu.dataset.cowTestMenu = "";
    menu.style.cssText = "position:fixed;left:400px;top:200px;z-index:50;background:#fff;padding:8px";
    for (const name of ["First", "Second"]) {
      const item = document.createElement("div");
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.textContent = name;
      item.addEventListener("click", () => { window.__cowMenu = name; });
      menu.append(item);
    }
    document.body.append(menu);
    menu.firstChild.focus();
  })(); true`);
  await page.key("j");
  check("while a menu of bb's is open, other keys are the menu's", (await page.eval(mode)) === "normal");
  await page.key("f");
  const inMenu = await hintList();
  check(
    "f with a menu open outside the page labels what the menu offers, and nothing else",
    inMenu.length === 2 && inMenu.every((hint) => hint.in === "popup") && inMenu[1].for === "div:Second",
    JSON.stringify(inMenu),
  );
  await typeHint(inMenu[1]?.label ?? "");
  check("a hint clicks the menu's entry", (await page.eval(`window.__cowMenu`)) === "Second");
  await page.eval(`document.querySelector("[data-cow-test-menu]").remove(); ${ROOT}.focus(); true`);
  check(
    "hints draw nothing in bb's page but their own overlay, and remove it",
    await page.eval(`!document.querySelector("[data-cow-hints]")`),
  );
  await page.key("Escape");
  await page.key("j");
  check("j leaves the heading for the first line", await page.eval(isCursor(ids.quiet)));

  // -- verbs: select a line, then press the verb --
  // What can be undone lasts as long as the page: a reload starts with nothing.
  await page.goto(`${BB}/plugins/cow/main`);
  await page.waitFor(`${screen} === "overview" && !!document.querySelector('.cow-main [data-cow-line="${ids.quiet}"]')`, {
    label: "the page reloaded before the verbs",
  });
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
    // Twice at most: a line that has just finished changes section once, when
    // what it said has been read, and can do so behind the cursor.
    for (let attempt = 0; attempt < 2 && !(await page.eval(isCursor(id))); attempt += 1) {
      await page.key("g");
      await page.key("g");
      for (let i = 0; i < 40 && !(await page.eval(isCursor(id))); i += 1) await page.key("j");
    }
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
  // What the line says it is doing. A turn started from the page ends in a
  // reply addressed to the user, which the line says first; these checks are
  // about what the thread said.
  const lineText = (id) =>
    `(() => {
      const cell = document.querySelector('.cow-main [data-cow-line="${id}"] .cow-wh')?.cloneNode(true);
      // In a narrow window the next move is folded into this cell.
      cell?.querySelector(".cow-nx2")?.remove();
      return (cell?.textContent ?? "").replace(/^replied to you: /, "");
    })()`;
  /** See the fixture's reply, as the user would, so that the line is at rest. */
  const seeReply = async (id) => {
    const seq = await lastTurnEnd(id);
    if (seq !== null) await rpc("seen_set", { threadId: id, seen: { seq, at: Date.now() } });
  };
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
  await page.waitFor(`${lineState(ids.perms)} === "wants" && ${isReply(ids.perms)}`, { label: "the leaf's reply to the user" });
  check(
    "a leaf that finishes a turn you started replied to you",
    (await page.eval(queueText(ids.perms))).startsWith("replied to you: "),
    await page.eval(queueText(ids.perms)),
  );

  // A refused command: dismiss it, take that back, then ask again as the user.
  await tellAs(ids.main, ids.perms, "ask: echo blocked cow");
  await page.waitFor(`${lineText(ids.perms)}.startsWith("bb refused to run: echo blocked cow")`, {
    label: "the refused command on its line",
    timeout: 120_000,
  });
  await waitForThread(ids.perms, (t) => t.status === "idle", "at rest after the second refusal", 60_000);
  check(
    "a refused permission outranks the reply that is still unseen",
    (await page.eval(lineText(ids.perms))).startsWith("bb refused") && !(await page.eval(isReply(ids.perms))),
  );
  await seeReply(ids.perms);
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
  // The fixture's wording of its reply varies; what matters is that the command ran and the turn ended.
  await waitForThread(ids.perms, (t) => t.status === "idle" && !t.hasPendingInteraction, "the retried command running", 120_000);
  await page.waitFor(`!${lineText(ids.perms)}.startsWith("permission")`, { label: "the request leaving its line", timeout: 30_000 });
  const ranRow = (await api(`/threads/${ids.perms}/timeline`)).rows.findLast((row) => row.command === "echo blocked cow");
  check(
    "granted, the command that bb had refused runs",
    ranRow?.status === "completed" && ranRow.output.trim() === "blocked cow" && (await lastDecision(ids.perms))?.decision === "allow_once",
    JSON.stringify({ status: ranRow?.status, output: ranRow?.output }),
  );
  await page.waitFor(`${lineState(ids.perms)} === "wants" && ${isReply(ids.perms)}`, { label: "its reply to the user" });
  check(
    "the turn was yours, so the line now waits on you with its reply, not with a request",
    (await page.eval(lineState(ids.perms))) === "wants" && (await page.eval(queueText(ids.perms))) ?.startsWith("replied to you: ") === true,
    await page.eval(queueText(ids.perms)),
  );
  await seeReply(ids.perms);
  await page.waitFor(`${lineState(ids.perms)} === "done" && !${inQueue(ids.perms)}`, { label: "the reply seen" });
  check("seen, the line is done and out of the queue", true);
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
  check(
    "the card closed and the request left the queue",
    !(await page.eval(cardOpen)) && !(await page.eval(queueText(ids.perms))).startsWith("permission"),
  );

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
      .find((id) => id !== "${ids.quiet}" && id !== "${ids.fails}" && id !== "${ids.leaf}") ?? null`,
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
    shelf.under === "2" && !(await page.eval(onPage(ids.fails))) && !(await page.eval(inQueue(ids.fails))),
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
      (await page.eval(promptLabel)).includes("the 2 threads under it") &&
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
    "x, a reason and Enter drop it: archived in bb, with the threads under it",
    !busy(await facts(ids.quiet)) && !!(await facts(ids.fails)).archivedAt,
  );
  check("the reason for dropping is kept on the thread", (await archiveNote(ids.quiet))?.reason === dropReason);
  await page.waitFor(`!${inQueue(ids.quiet)}`, { label: "the dropped line leaving the queue" });
  await page.key("u");
  check(
    "u offers to bring both back",
    (await page.eval(confirmLabel)).includes("undo dropping") &&
      (await page.eval(confirmLabel)).includes("the 2 threads under it"),
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
  await page.waitFor(`${lineState(ids.quiet)} === "idle"`, { label: "the resumed line" });
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
  await page.waitFor(`${lineState(ids.quiet)} === "idle"`, { label: "the line resumed again" });

  // -- archive, and undo --
  await select(ids.fails);
  const afterFails = await page.eval(
    `(() => { const all = [...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine);
      // Its member leaves with it.
      const stay = all.filter((id) => id !== "${ids.leaf}");
      return stay[stay.indexOf("${ids.fails}") + 1] ?? stay[stay.indexOf("${ids.fails}") - 1]; })()`,
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
    status.stdout.split("\n").find((line) => line.includes(`(${id})`) && /^[ \d]{4}(wants|blocked|running|stuck|parked|failed|idle|done) /.test(line)) ?? "";
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
  // bb archived the thread under it with it, and brings back only the one asked for.
  await bb("thread", "unarchive", ids.leaf).catch(() => undefined);
  await rpc("archive_note_set", { threadId: ids.fails, note: null });
  await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the line back after the CLI checks" });

  // -- what is next: a thread's own note, and what it has not started --
  const noteOf = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"] .cow-nx [data-cow-note]')?.textContent ?? null)`;
  const todoTitles = (id) =>
    `JSON.stringify([...document.querySelectorAll('.cow-main [data-cow-todo-of="${id}"] .cow-title')].map((el) => el.textContent))`;
  const cliTodos = async (id) => JSON.parse((await cow("todo", "list", id, "--json")).stdout).todo.map((item) => item.title);
  const stranger = await cowAs(ids.asks, "next", ids.quiet, "not mine to say");
  const upward = await cowAs(ids.leaf, "todo", "add", ids.quiet, "not mine to list");
  check(
    "a thread may not write what is next for a thread that is not under it",
    stranger.code !== 0 && /only for itself and for the threads under it/.test(stranger.stderr) &&
      upward.code !== 0 && (await page.eval(noteOf(ids.quiet))) === null && (await cliTodos(ids.quiet)).length === 0,
    stranger.stderr.trim(),
  );
  const own = await cowAs(ids.quiet, "next", ids.quiet, "cut the second   half on Monday");
  await page.waitFor(`${noteOf(ids.quiet)} === "“cut the second half on Monday”"`, { label: "the note on its line" });
  check(
    "bb cow next: a thread's own note shows live in its next-move column, marked as its words",
    own.code === 0 && /cut the second half on Monday/.test(own.stdout),
    own.stdout.trim(),
  );
  const fromAbove = await cowAs(ids.main, "next", ids.leaf, "nothing more planned");
  await page.waitFor(`${noteOf(ids.leaf)} === "“nothing more planned”"`, { label: "a note set from above" });
  check("a thread may set it for a thread under it, at any depth", fromAbove.code === 0);
  await cowAs(ids.quiet, "todo", "add", ids.quiet, "write the changelog");
  await cowAs(ids.quiet, "todo", "add", ids.quiet, "tag the release");
  const third = await cowAs(ids.main, "todo", "add", ids.quiet, "announce it");
  await page.waitFor(`${todoTitles(ids.quiet)} === '["write the changelog","tag the release","announce it"]'`, {
    label: "the not-started items on the page",
  });
  check("bb cow todo add: items show live, in order", third.code === 0 && /as item 3/.test(third.stdout), third.stdout.trim());
  const placed = JSON.parse(
    await page.eval(`JSON.stringify((() => {
      const rows = [...document.querySelectorAll(".cow-main [data-cow-line], .cow-main [data-cow-todo]")];
      const at = (selector) => rows.indexOf(document.querySelector(".cow-main " + selector));
      const todos = [...document.querySelectorAll('.cow-main [data-cow-todo-of="${ids.quiet}"]')];
      return {
        afterMembers: at('[data-cow-todo-of="${ids.quiet}"]') === at('[data-cow-line="${ids.leaf}"]') + 1,
        together: at('[data-cow-todo-of="${ids.quiet}"]') + 2 === rows.indexOf(todos[2]),
        depth: todos.map((el) => el.dataset.cowDepth).join(),
        rails: todos.map((el) => el.querySelectorAll(".cow-rail").length).join(),
        states: todos.map((el) => el.dataset.cowState ?? "none").join(),
      };
    })())`),
  );
  check(
    "they are rows inside the thread's group, after its members, tied to it by its rule",
    placed.afterMembers && placed.together && placed.depth === "1,1,1" && placed.rails === "1,1,1" && placed.states === "none,none,none",
    JSON.stringify(placed),
  );
  const statusPlans = (await cow("status", "--main", ids.main)).stdout;
  check(
    "bb cow status shows the note, the items, and what is under a group",
    /next, in its words: cut the second half on Monday/.test(statusPlans) &&
      /not started 1: write the changelog\n.*not started 2: tag the release/.test(statusPlans) &&
      /\[under it: .*1 failed.*\]/.test(statusPlans),
    statusPlans.split("\n").filter((line) => /not started|in its words/.test(line)).join(" | "),
  );
  await shot("plans");
  const todoCursor = `(document.querySelector(".cow-main .cow-cur")?.dataset.cowTodo ?? null)`;
  await select(ids.leaf);
  await page.key("j");
  check("the cursor lands on a not-started item", (await page.eval(todoCursor))?.startsWith(`todo:${ids.quiet}:`));
  await page.key("a");
  check(
    "no verb for threads acts on it",
    (await page.eval(message)).includes("not a thread") && (await page.eval(mode)) === "normal",
    await page.eval(message),
  );
  await page.key("J");
  await page.waitFor(`${todoTitles(ids.quiet)} === '["tag the release","write the changelog","announce it"]'`, {
    label: "the item moved down",
  });
  check(
    "J moves it down its list, and the cursor goes with it",
    (await cliTodos(ids.quiet)).join() === "tag the release,write the changelog,announce it" &&
      (await page.eval(`document.querySelector(".cow-main .cow-cur .cow-title")?.textContent`)) === "write the changelog",
  );
  await page.key("K");
  await page.waitFor(`${todoTitles(ids.quiet)} === '["write the changelog","tag the release","announce it"]'`, {
    label: "the item moved back up",
  });
  check("K moves it back up", true);
  await page.key("x");
  check(
    "x asks before removing it",
    (await page.eval(confirmLabel)).includes("remove “write the changelog”"),
    await page.eval(confirmLabel),
  );
  await page.key("n");
  check("any key but y keeps it", (await page.eval(message)) === "not removed" && (await cliTodos(ids.quiet)).length === 3);
  await page.key("x");
  await page.key("y");
  await page.waitFor(`${todoTitles(ids.quiet)} === '["tag the release","announce it"]'`, { label: "the item removed" });
  check(
    "x then y removes it from the thread's list, and the cursor takes the next row",
    (await cliTodos(ids.quiet)).join() === "tag the release,announce it" &&
      (await page.eval(`document.querySelector(".cow-main .cow-cur .cow-title")?.textContent`)) === "tag the release",
  );
  const started = await cowAs(ids.quiet, "todo", "done", ids.quiet, "1");
  await page.waitFor(`${todoTitles(ids.quiet)} === '["announce it"]'`, { label: "an item taken off by the CLI" });
  check("bb cow todo done takes an item off, and the page follows", started.code === 0 && /1 left/.test(started.stdout));
  const noSuch = await cowAs(ids.quiet, "todo", "rm", ids.quiet, "5");
  check("an item number that is not on the list is refused", noSuch.code !== 0 && /there is no item 5/.test(noSuch.stderr), noSuch.stderr.trim());
  await cowAs(ids.quiet, "todo", "rm", ids.quiet, "1");
  await cowAs(ids.quiet, "next", ids.quiet, "--clear");
  await cowAs(ids.main, "next", ids.leaf, "--clear");
  await page.waitFor(
    `${todoTitles(ids.quiet)} === "[]" && ${noteOf(ids.quiet)} === null && ${noteOf(ids.leaf)} === null`,
    { label: "the notes cleared" },
  );
  check("bb cow todo rm and next --clear remove them from the page", true);

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
    // Light and dark differ only when bb follows the system's appearance; a
    // bb pinned to one draws the same both times. The cow theme below is
    // previewed in both, whatever bb is set to.
    matches(active.light) && matches(active.dark),
    `${active.light.pageBackground === active.dark.pageBackground ? "bb is pinned to one appearance here; " : ""}${JSON.stringify(active)}`,
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
  check(
    "a narrow window folds the next move into the line and puts the queue on top",
    narrow.next === "none" && narrow.overflow && narrow.queueAbove && narrow.shelf && narrow.verbs,
    JSON.stringify(narrow),
  );
  // bb remounts the page when its layout changes, and again around a
  // screenshot at this size, which puts the cursor back at the top.
  await shot("narrow");
  await sleep(1500);
  await page.waitFor(`${screen} === "overview" && !!document.querySelector('.cow-main [data-cow-line="${ids.fails}"]')`, {
    label: "the page back in a narrow window",
  });
  await select(ids.fails);
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

  await raisedChecks(page, ids, shot, chooseMain);
  await readingChecks(page, ids, shot, chooseMain);

  // -- changing Main --
  await page.key("M");
  await page.waitFor(`${screen} === "picker"`, { label: "the picker again" });
  check("M reopens the picker", true);
  await page.key("Escape");
  check("Escape keeps the current Main", (await page.eval(screen)) === "overview");

  return finish(page);

  async function finish(page) {
  check("no console errors", page.consoleErrors.length === 0, page.consoleErrors.join(" | "));
  // bb polls services of its own that may be down; only cow's requests count.
  const failedRequests = page.networkErrors.filter((entry) => entry.includes("/plugins/cow"));
  check("no failed requests to cow", failedRequests.length === 0, failedRequests.join(" | "));
  if (page.networkErrors.length > failedRequests.length) {
    console.log(`note: ${page.networkErrors.length - failedRequests.length} failed requests of bb's own, e.g. ${page.networkErrors[0]}`);
  }
  page.close();

  // -- put things back --
  await restoreSettings();
  await restoreReading();
  for (const name of [...RAISED, ...READING]) {
    if (ids[name]) for (const ask of await openAsksOf(ids[name])) await cow("ask", "withdraw", ask.id);
  }
  await restoreStored();
  const after = await rpc("main_state", null);
  check("what the run changed in the stored Mains is still as it was", ours(after) === ours(before), JSON.stringify(after));
  if (!flag("keep")) {
    for (const id of Object.values(ids)) {
      await rpc("park_set", { threadId: id, park: null });
      await rpc("archive_note_set", { threadId: id, note: null });
      await rpc("dismissal_set", { threadId: id, dismissal: null });
      await rpc("seen_set", { threadId: id, seen: null });
      await cow("project", id, "--clear");
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
}

main().catch(async (error) => {
  console.error(error);
  // Whatever went wrong, the next cow window must start where it did before.
  await restoreStored().catch((cause) => console.error("could not restore the stored Mains", cause));
  await restoreSettings().catch((cause) => console.error("could not restore cow's checker settings", cause));
  await restoreReading().catch((cause) => console.error("could not put back what the reader checks changed", cause));
  process.exit(1);
});
