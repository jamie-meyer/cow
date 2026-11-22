// End-to-end check of the cow page against a running bb.
//
// It drives a separate headless Chrome (never your own bb window) and makes
// its own fixture threads, titled "cow test", on the cheapest model. It writes
// only to those threads, and it answers, stops and archives only those. It
// archives them all when it finishes, and when it fails part-way (unless
// --keep is given). The permission requests it grants are
// for `echo` and for writing one small file under /tmp, which it removes.
// It also runs `bb cow` against the same fixtures, and leaves and removes
// notes of what is next on them.
//
// For capabilities it uses three more fixtures under a Main of their own. It
// makes capabilities that apply only to those fixtures, for `echo` commands
// and for a scratch directory it creates under /tmp and removes, and deletes
// them when it finishes. What it did stays in cow's capability log, which
// nothing clears. One fixture is told to call cow's interface from inside
// its sandbox, to check that whatever that achieves is logged and shown, and
// that it cannot do what only the person may: the capability and key actions,
// and marking a reply as seen, dismissing a refusal or marking a brief read.
//
// For asks and briefs it uses four more fixtures under a Main of their own,
// and cow starts three hidden checker threads, titled "cow check", the first
// time: the briefs they audit are kept and used again. Three of them run in
// a throwaway folder that is not a git checkout, and the fourth in a
// throwaway git repository with a branch, a commit and uncommitted changes,
// whose diff cow shows the checker; both folders, and the environments bb
// makes for them, are removed after. While it runs it sets cow's checker
// model and provider, and puts both back as they were.
//
// What only the person may do on the page is signed with a key the page
// holds. The check resets cow's enrollment with the reset file when it starts
// and when it finishes, enrols a key of its own for the calls it makes
// itself, and approves its browser's key with it. Whoever uses this bb has
// their own page enrolled again, by first use, when they next open cow.
//
// Choosing a Main records it on the server as where a new cow window starts,
// by a signed call. The check puts that record back at once, each time, for the fixtures'
// project only, and no window that is already open is moved by it. A Main
// you choose in another project while it runs is left alone.
//
//   1. Start Chrome with a throwaway profile:
//        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//          --headless=new --remote-debugging-port=9344 \
//          --user-data-dir="$(mktemp -d)" --window-size=1440,900 about:blank
//   2. node scripts/copy-for-checks.mjs <empty folder> && bb plugin install <that folder> --yes
//   3. npm run e2e -- --project <bb project id> --environment <environment id>
//   4. bb plugin remove cow-check
//
// Options:
//   --bb <url>          bb's address (default http://127.0.0.1:38886)
//   --plugin <id>       the plugin to check (default cow-check, the copy made
//                       with scripts/copy-for-checks.mjs). The checks reset the
//                       enrollment of that plugin and say so before they start.
//   --reset-the-installed-cow
//                       needed, with --plugin cow, to run against the installed
//                       cow: without it the checks refuse
//   --port <n>          Chrome's debugging port (default 9344)
//   --state <file>      remember the fixtures here and reuse them next run
//   --keep              leave the fixtures unarchived (use with --state)
//   --shots <dir>       save screenshots here (never commit them)
//   --model <id>        fixture model (default claude-haiku-5-5)
//   --from <part>       start the default run at this part, leaving out those
//                       before it: for fixtures kept with --state and --keep.
//                       The default run is made of named parts (PART_NAMES);
//                       each starts from a known page, and one that stops on
//                       an error or a timeout is recorded as failed and the
//                       run goes on. The summary lists what became of each
//                       part
//   --only-raised       only the asks and briefs checks
//   --only-caps         only the capability checks: three fixtures
//   --only-workspace    only the workspace file on the page: one fixture, and a
//                       throwaway workspace folder under the system temp folder
//                       with two throwaway git repositories; then a second
//                       fixture started in a copy-on-write clone of it, which
//                       commits once, so B can bring that commit back to the
//                       throwaway source; then its clone, left with an
//                       uncommitted file, is held when bb removes it, the
//                       queue and W say so, and W removes it after y. It is
//                       archived, and its clone
//                       removed, when the section ends, also after a failure
//   --only-reader       only the reader, projects, asks answered in chat and
//                       chat scrolling: four fixtures, and --environment must
//                       be a checkout of cow, whose files the fixture links to
//   --only-waiting      only waiting on someone else, links to threads in the
//                       chat, and seen lines staying in place: four fixtures
//   --only-settle       only To settle, which replies enter the queue (a
//                       project's and Main's included), and keeping a thread:
//                       three fixtures
//   --only-ledger       only the ledger: what a finished worker came to,
//                       from the page (e, then o) and from bb cow archive,
//                       outcome and ledger, the L sheet, and a project not
//                       asked: four fixtures, a stand-in Main, two workers
//                       under it and a project under it. Then the usage
//                       line and its notices, on the copy's own settings
//                       (its notifications turned off), put back after.
//                       Then caps and stuck checks: three more fixtures, one
//                       that runs the same command three times, and a worker
//                       with a thread of its own. Last, it deletes one of
//                       its own two workers, to check that its usage is
//                       still counted and that forgetting it on purpose
//                       takes it out
//   --only-history      only bb's back and forward between chats, a reload
//                       with a chat open, and an address naming an unknown
//                       or archived thread: four fixtures. Back and forward
//                       are driven with history.back() and history.forward(),
//                       not with the keys
//   --only-outside      only Outside Main and bringing a thread under Main:
//                       four fixtures, one a stand-in Main. It moves only
//                       those, and puts each back
//   --only-automations  only the Automations section: one fixture, a stand-in
//                       Main, and three automations of its own in --project,
//                       titled "cow test automation": a script that prints a
//                       line and fails, and two agent ones on the fixture
//                       model, one that asks a question. Each is run once,
//                       and deleted when the run finishes or fails; their two
//                       run threads are archived with the fixtures. A fourth,
//                       never run, is deleted through the page with e. It
//                       never changes, runs or deletes any other automation
//   --only-traces       only what an agent takes out of the queue (parking
//                       what waits on the person, withdrawing an ask,
//                       closing one as answered) and asks under a parked
//                       thread: six fixtures, a stand-in Main and five
//                       threads, one under another. It sends one fixture a
//                       message as the user, and acknowledges every notice
//                       about its fixtures when it finishes
//   --only-card         only the context card: four fixtures, a stand-in
//                       Main, two threads under it, and a thread under no
//                       Main in a new folder that is not a git checkout
//                       (the folder and the environment bb makes for it are
//                       removed after), and the throwaway plugin
//                       cow-check-badge, which answers cow_card for "cow
//                       test" threads under another thread
//   --only-plugins      only other plugins' badges and actions: two fixtures,
//                       a stand-in Main and a thread under it, and a throwaway
//                       plugin, cow-check-badge (scripts/cow-check-badge),
//                       installed for the run and removed when it finishes or
//                       fails. It shows a badge, a badge that always throws,
//                       and three actions only on "cow test" threads; the
//                       actions write to its own metadata on the fixture,
//                       which the run clears
//   --only-open         only the command that opens cow's page from anywhere:
//                       one fixture, a stand-in Main. The shortcut is pressed
//                       from the fixture's chat in bb, from bb's settings and
//                       from cow's page with a chat open, and the command is
//                       run once from bb's command palette. The copy's
//                       default shortcut is Ctrl+Option+Shift+C (cow's own,
//                       without Shift, would clash with an installed cow)

import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { connect, newContextTab, newTab, sleep } from "./cdp.mjs";
import { COPY_ID, createSigner, guardPlugin } from "./sign.mjs";

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
/** The plugin the checks run against: the copy made by scripts/copy-for-checks.mjs, unless another is named. The installed cow needs a second flag: see guardPlugin. */
const PLUGIN = option("plugin", COPY_ID);
const TITLE = "cow test";
/** The parts of the default run, in order: see part() in main(). --from <part> starts there. */
const PART_NAMES = [
  "choosing-main", "windows", "lines", "groups", "attention", "moving", "folding", "filter", "queue", "hints", "legend",
  "chat-pane", "say-and-live", "hints-in-chat", "verbs", "answer", "permissions", "park", "archive", "stop", "cli",
  "archived-main", "next", "theme", "narrow", "raised", "reading", "caps", "changing-main",
];
const FROM = option("from", "");
if (FROM && !PART_NAMES.includes(FROM)) {
  console.error(`--from: no part named ${FROM}. The parts are: ${PART_NAMES.join(" ")}`);
  process.exit(2);
}
/** What became of each part of the default run: passed, failed checks, stopped (with its message), skipped or left out. */
const parts = [];

/** This check's own key, for the calls only the person may make. Made in main(). */
let signer = null;
/** Make sure the check's own key is enrolled: when it is not, enrollment is reset and it is the first. */
async function ownKey() {
  if ((await signer.state()).keys.some((key) => key.fingerprint === signer.fingerprint)) return;
  await signer.resetEnrollment();
  if ((await signer.enrol()) !== "enrolled-first") throw new Error("the check's key was not enrolled by first use");
}

/** Enrol the key of this check's browser, by approving it with the check's own key: every page of this Chrome profile shares it. */
async function enrolPage() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = await signer.state();
    const waiting = state.requests.filter((request) => request.status === "pending" && /headless Chrome/.test(request.label));
    for (const request of waiting) await signer.must("key_approve", { fingerprint: request.fingerprint });
    if (state.keys.some((key) => /headless Chrome/.test(key.label)) || waiting.length > 0) return;
    if (Date.now() > deadline) throw new Error("the page never asked for its key to be enrolled");
    await sleep(300);
  }
}

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
  const response = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/${method}`, {
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
    const { stdout, stderr } = await run("bb", [PLUGIN, ...argv], { env });
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
A message may arrive from another bb thread, marked "[bb message from thread:…]": it is part of the test, so carry it out exactly like any other message.
Never retry a denied call within the same message, and never use any other tool.`;

async function spawn({ prompt, parent, model = MODEL, permissionMode, environment = ENVIRONMENT }) {
  const thread = await bb(
    "thread", "spawn",
    "--project", PROJECT,
    "--environment", environment,
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
  bb ${PLUGIN} ask --question "Which colour?" --option red --option "blue::the colder one"
- when you receive a message that starts with "Answer to your question", reply with exactly: GOT <the last line of that message>
- reply to anything else with exactly: ok
Never run anything else, and never ask again by yourself.`;

const FIXTURES = ["main", "quiet", "asks", "fails", "leaf", "runs", "perms", "amain", "asker", "briefer", "bdiff", "pmain", "phead", "pkid", "reader", "cmain", "chead", "ckid"];
/** The fixtures of the waiting, thread link and seen checks: a Main of their own with two threads under it, and a thread under no Main. */
const WAITING = ["wmain", "wkid", "wlink", "wother"];
/** The fixtures of the To settle and Kept checks: a Main of their own, and two workers under it. */
const SETTLING = ["smain", "sjob", "schat"];
/** The fixtures of the ledger checks: a Main of their own, two workers under it, and a project under it. */
const LEDGER = ["lmain", "lone", "ltwo", "lproj"];
/** Refusals of signed calls a check provokes on purpose: the page logs each as a failed request. */
let expectedRefusals = 0;
/** The workspace file's checks: a Main of their own, for the page to open on. */
const WORKSPACING = ["wmain"];
/** The fixtures of the Outside Main checks: a stand-in Main, a thread with no parent, and another with one thread under it. */
const OUTSIDE = ["omain", "ostray", "ohead", "okid"];
const AUTOMATING = ["umain"];
/** The fixtures of the back and forward checks: a Main of their own, and three threads under it, the second of which links to the third. */
const HISTORY = ["hmain", "ha", "hb", "hc"];
/** The fixtures of the other plugins' checks: a Main of their own, and a thread under it. */
const PLUGGED = ["bmain", "bkid"];
/** The fixtures of the traces checks: a Main of their own; under it one to park with an ask, one idle, one that asks, and a head with a thread under it. */
const TRACING = ["tmain", "tpark", "tidle", "task", "thead", "tkid"];
/** The fixtures of the context card checks: a Main of their own, two threads under it, and a thread under no Main in a folder that is not a git checkout, which has nothing to show. */
const CARDED = ["kmain", "kone", "ktwo", "knone"];
/** The fixture of the checks of the command that opens the page: a Main of its own. */
const OPENING = ["xmain"];
/** That folder, made for the run and removed after it. */
let cardFolder = null;
/** The commit the diff fixture's branch starts from. */
let diffBase = null;
/** The automations this run made, by id: deleted when it finishes, and when it fails part-way. */
const madeAutomations = [];
const LINKER = `You are a test fixture for a bb plugin. Use no tools. Reply to this first message with exactly: ok
From then on, when you receive a message of the form "links A B C", where A, B and C are thread ids, reply with exactly these three lines, putting each id in its place:
- first: @thread:A
- second: @thread:B
- third: @thread:C
Reply to anything else with exactly: ok`;
/** The fixtures of the asks and briefs checks: a Main of their own, so they never show under the other one. */
const RAISED = ["amain", "asker", "briefer", "bdiff"];
/** The folders the asks and briefs fixtures run in, made for the run and removed after it: one that is not a git checkout, and a git repository with changes. */
let raisedFolder = null;
let diffFolder = null;
/** A fixture whose first message sets three checks, in a repository it changed. */
const DIFFER = `${"You are a test fixture for a bb plugin. Use no tools. Reply to every message with exactly: ok"}

## Done means

- src/limit.js sets the limit to 5 requests a minute.
- src/reset.js exports a function named reset.
- The README says what the limit is.

## Notes

- nothing here is a check`;

/** A git repository on a branch off main: one file modified, one added in a commit, one untracked, and an existing test changed. */
function makeDiffRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cow-e2e-brief-diff-")));
  const git = (...argv) => execFileSync("git", ["-c", "user.name=cow test", "-c", "user.email=cow-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...argv], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "README.md"), "# limiter\n\nA rate limiter.\n");
  writeFileSync(join(dir, "src", "limit.js"), "export const LIMIT_PER_MINUTE = 10;\n");
  writeFileSync(join(dir, "test", "limit.test.js"), 'import { LIMIT_PER_MINUTE } from "../src/limit.js";\nif (LIMIT_PER_MINUTE !== 10) throw new Error("limit");\n');
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "work");
  writeFileSync(join(dir, "src", "reset.js"), "export function reset(counter) {\n  counter.clear();\n}\n");
  git("add", "src/reset.js");
  git("commit", "-q", "-m", "reset");
  writeFileSync(join(dir, "src", "limit.js"), "export const LIMIT_PER_MINUTE = 5;\n");
  writeFileSync(join(dir, "test", "limit.test.js"), 'import { LIMIT_PER_MINUTE } from "../src/limit.js";\nif (LIMIT_PER_MINUTE > 100) throw new Error("limit");\n');
  writeFileSync(join(dir, "notes.txt"), "remember to tell ops\n");
  return { dir, base: git("rev-parse", "main").trim() };
}

/** The fixtures this run acts on, by name, as they become known: what a run that fails part-way archives. */
const inUse = {};

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
  const wanted = flag("only-open") ? OPENING : flag("only-card") ? CARDED : flag("only-traces") ? TRACING : flag("only-history") ? HISTORY : flag("only-plugins") ? PLUGGED : flag("only-automations") ? AUTOMATING : flag("only-outside") ? OUTSIDE : flag("only-ledger") ? LEDGER : flag("only-workspace") ? WORKSPACING : flag("only-settle") ? SETTLING : flag("only-waiting") ? WAITING : flag("only-reader") ? READING : flag("only-caps") ? CAPPED : FIXTURES;
  const missing = wanted.filter((name) => !ids[name]);
  if (missing.length > 0 && (!PROJECT || !ENVIRONMENT)) throw new Error("--project and --environment are required");
  const make = async (name, options) => {
    if (ids[name] || !wanted.includes(name)) return;
    // A fixture kept from an earlier run may be archived, and bb starts nothing under an archived thread.
    if (options.parent && (await api(`/threads?threadIds=${options.parent}&limit=1`))[0]?.archivedAt) await bb("thread", "unarchive", options.parent);
    ids[name] = await spawn(options);
    inUse[name] = ids[name];
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
  if (wanted.includes("amain") && !ids.amain) raisedFolder = realpathSync(mkdtempSync(join(tmpdir(), "cow-e2e-raised-")));
  await make("amain", { prompt: QUIET, environment: raisedFolder ?? ENVIRONMENT });
  await make("asker", { prompt: ASKER, parent: ids.amain, environment: raisedFolder ?? ENVIRONMENT });
  await make("briefer", { prompt: QUIET, parent: ids.amain, environment: raisedFolder ?? ENVIRONMENT });
  if (wanted.includes("bdiff") && !ids.bdiff) {
    const made = makeDiffRepo();
    diffFolder = made.dir;
    diffBase = made.base;
  }
  await make("bdiff", { prompt: DIFFER, parent: ids.amain, environment: diffFolder ?? ENVIRONMENT });
  await make("pmain", { prompt: QUIET });
  await make("phead", { prompt: QUIET, parent: ids.pmain });
  await make("pkid", { prompt: QUIET, parent: ids.phead });
  await make("reader", { prompt: READER, parent: ids.pmain, permissionMode: "accept-edits" });
  await make("cmain", { prompt: QUIET });
  await make("chead", { prompt: CAPS, parent: ids.cmain, permissionMode: "accept-edits" });
  await make("ckid", { prompt: CAPS, parent: ids.chead, permissionMode: "accept-edits" });
  await make("wmain", { prompt: QUIET });
  await make("wkid", { prompt: QUIET, parent: ids.wmain });
  await make("wlink", { prompt: LINKER, parent: ids.wmain });
  await make("wother", { prompt: QUIET });
  await make("smain", { prompt: QUIET });
  await make("sjob", { prompt: QUIET, parent: ids.smain });
  await make("schat", { prompt: QUIET, parent: ids.smain });
  await make("wmain", { prompt: QUIET });
  await make("lmain", { prompt: QUIET });
  await make("lone", { prompt: QUIET, parent: ids.lmain });
  await make("ltwo", { prompt: QUIET, parent: ids.lmain });
  await make("lproj", { prompt: QUIET, parent: ids.lmain });
  await make("omain", { prompt: QUIET });
  await make("ostray", { prompt: QUIET });
  await make("ohead", { prompt: QUIET });
  await make("okid", { prompt: QUIET, parent: ids.ohead });
  await make("umain", { prompt: QUIET });
  await make("bmain", { prompt: QUIET });
  await make("bkid", { prompt: QUIET, parent: ids.bmain });
  await make("hmain", { prompt: QUIET });
  await make("ha", { prompt: QUIET, parent: ids.hmain });
  await make("hb", { prompt: LINKER, parent: ids.hmain });
  await make("hc", { prompt: QUIET, parent: ids.hmain });
  await make("xmain", { prompt: QUIET });
  await make("tmain", { prompt: QUIET });
  await make("tpark", { prompt: QUIET, parent: ids.tmain });
  await make("tidle", { prompt: QUIET, parent: ids.tmain });
  await make("task", { prompt: QUIET, parent: ids.tmain });
  await make("thead", { prompt: QUIET, parent: ids.tmain });
  await make("tkid", { prompt: QUIET, parent: ids.thead });
  if (wanted.includes("kmain")) {
    await make("kmain", { prompt: QUIET });
    await make("kone", { prompt: QUIET, parent: ids.kmain });
    await make("ktwo", { prompt: QUIET, parent: ids.kmain });
    if (!ids.knone) cardFolder = mkdtempSync(join(tmpdir(), "cow-card-none-"));
    await make("knone", { prompt: QUIET, environment: cardFolder ?? ENVIRONMENT });
  }
  // Only the fixtures this run uses are acted on.
  return Object.fromEntries(Object.entries(ids).filter(([name]) => wanted.includes(name)));
}

/** Bring fixtures from an earlier run back to where a run starts. */
async function reset(ids) {
  for (const id of Object.values(ids)) {
    const [thread] = await api(`/threads?threadIds=${id}&limit=1`);
    if (thread.archivedAt) await bb("thread", "unarchive", id);
    await rpc("park_set", { threadId: id, park: null });
    await rpc("keep_set", { threadId: id, keep: null });
    await rpc("archive_note_set", { threadId: id, note: null });
    await signer.must("dismissal_set", { threadId: id, dismissal: null });
    await signer.must("seen_set", { threadId: id, seen: null });
    await cow("next", id, "--clear");
    await cow("wait", id, "--clear");
    while ((await cow("todo", "rm", id, "1")).code === 0);
  }
  if (flag("only-reader") || flag("only-workspace") || flag("only-caps") || flag("only-waiting") || flag("only-settle") || flag("only-ledger") || flag("only-outside") || flag("only-automations") || flag("only-plugins") || flag("only-history") || flag("only-traces") || flag("only-card") || flag("only-open")) return;
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
  // A request denied above was decided outside cow, which flags it: every run starts with nothing flagged on a fixture.
  await clearCaps(ids);
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
  const response = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/${method}`, {
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
const DIFF_BRIEF = {
  summary: "Lowered the limit to 5 a minute, added reset, and everything is verified.",
  claims: [
    { id: "limit", text: "src/limit.js now sets the limit to 5 requests a minute.", label: "checked", evidence: [{ description: "the changed line", text: "export const LIMIT_PER_MINUTE = 5;" }] },
    { id: "reset", text: "src/reset.js exports reset(counter), which clears the counter.", label: "inferred" },
  ],
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
  const before = JSON.parse(await plain("plugin", "config", PLUGIN, "--json")).values ?? {};
  const set = async (key, value) => plain("plugin", "config", PLUGIN, ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)]));
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
  for (const [id, brief] of [[ids.briefer, DISPUTED_BRIEF], [ids.asker, CLEAN_BRIEF], [ids.bdiff, DIFF_BRIEF]]) {
    const stored = await briefOf(id);
    if (stored?.check?.runs.some((entry) => entry.status === "done")) continue;
    await submit(id, brief);
    checkers.push(...(await briefOf(id)).check.runs.map((entry) => entry.threadId));
  }
  // Every run starts with both unread.
  for (const id of [ids.briefer, ids.asker, ids.bdiff]) await signer.must("brief_read", { threadId: id, version: (await briefOf(id)).version, read: false });

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
      shown: ${sheet}.querySelector("[data-cow-brief-shown]")?.textContent ?? "",
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
    "the sheet is in order: the dispute first, then judgement calls, the other claims, what was left undone, what the checker was shown, the summary",
    JSON.stringify(laid.items) === '["dispute:claim:tests","call:call:0","claim:claim:timeout"]' && JSON.stringify(laid.sections) === '["disputes","calls","claims","not-done","shown","summary"]' && laid.cursor === "claim:tests",
    JSON.stringify(laid.items),
  );
  check(
    "a dispute shows the claim, the agent's own label as the agent's words, what the evidence shows, and the checker's verdict",
    laid.tag === "contradicted" && laid.label === "checked" && laid.first.includes("the agent says“checked”") && laid.first.includes("its own word, not a check") && laid.first.includes("the evidence shows") && laid.first.includes("not supported") &&
      laid.first.indexOf("the checker") < laid.first.indexOf("the evidence shows") && laid.first.indexOf("the evidence shows") < laid.first.indexOf("the agent says"),
    laid.first.slice(0, 260),
  );
  check(
    "the sheet says what the check was: how many runs, of which model, on what, and what it read",
    laid.check === "checked" && /^Audited by 1 run of [^,.]+, model /.test(laid.checkText) && laid.checkText.includes(`model ${MODEL}`) && laid.checkText.endsWith("It read the claims and their evidence and the task; not the agent's summary or labels. It ran nothing."),
    laid.checkText,
  );
  check(
    "a thread whose folder is not a git checkout still gets a verdict, and the sheet says there was no diff",
    laid.check === "checked" && laid.shown.includes("diff: none (the agent's thread's folder is not a git checkout)") && laid.shown.includes("no \"Done means\" section"),
    laid.shown,
  );
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
  const readMark = await markBy("brief-read", ids.briefer);
  check("opening the brief signed that: the log holds it as read, under this page's key", readMark?.event.read === true && readMark.by !== null && readMark.by === (await pageKeyNow()), JSON.stringify(readMark));

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

  // -- a brief checked against its task and its diff, by a real checker --
  const diffed = await briefOf(ids.bdiff);
  const files = diffed.shown?.diff.state === "collected" ? Object.fromEntries(diffed.shown.diff.files.map((f) => [f.path, `${f.status}${f.untracked ? " untracked" : ""}`])) : {};
  console.log(`the diff fixture's check: ${JSON.stringify({ shown: diffed.shown, runs: diffed.check?.runs.map((r) => ({ status: r.status, error: r.error, verdicts: r.verdicts, tasks: r.tasks, unaccounted: r.unaccounted })) })}`);
  check("cow read the fixture's first message: three checks from its Done means section", diffed.shown?.task.state === "read" && diffed.shown.task.checks.length === 3 && diffed.shown.task.checks[1] === "src/reset.js exports a function named reset.", JSON.stringify(diffed.shown?.task));
  check(
    "cow collected the diff in the fixture's git checkout: the base is main's commit, and a modified, an added and an untracked file are listed with their status",
    diffed.shown?.diff.state === "collected" && diffed.shown.diff.base === diffBase && files["src/limit.js"] === "modified" && files["src/reset.js"] === "added" && files["notes.txt"] === "added untracked" && files["test/limit.test.js"] === "modified",
    JSON.stringify(files),
  );
  const answered = diffed.check?.runs.find((r) => r.status === "done");
  check(
    "a real checker answered for each of the task's checks and each claim",
    !!answered && JSON.stringify(answered.tasks.map((t) => t.id)) === '["t1","t2","t3"]' && answered.verdicts.length === 2,
    JSON.stringify(diffed.check?.runs.map((r) => r.status === "done" ? { tasks: r.tasks.map((t) => `${t.id}:${t.verdict}`), claims: r.verdicts.map((v) => `${v.id}:${v.verdict}`) } : r.error)),
  );
  check("the changed existing test is flagged with no model", JSON.stringify(diffed.shown?.flagged) === '["test/limit.test.js"]', JSON.stringify(diffed.shown?.flagged));
  await page.waitFor(`(${queued(ids.bdiff)} ?? "").startsWith("brief: changed what decides whether its checks pass")`, { label: "the diff fixture's brief in the queue", timeout: 60_000 }).catch(() => undefined);
  check("the flagged brief waits on you, and its line says why", ((await page.eval(queued(ids.bdiff))) ?? "").startsWith("brief: changed what decides whether its checks pass"), String(await page.eval(queued(ids.bdiff))));
  await select(ids.bdiff);
  await page.key("b");
  await page.waitFor(`${sheet}?.dataset.cowSheet === "${ids.bdiff}" && !!${sheet}.querySelector("[data-cow-brief-check]")`, { label: "the diff fixture's brief" });
  const diffSheet = JSON.parse(
    await page.eval(`JSON.stringify({
      items: [...${sheet}.querySelectorAll("[data-cow-brief-item]")].map((item) => item.dataset.cowBriefKind + ":" + item.dataset.cowBriefItem),
      flagged: ${sheet}.querySelector("[data-cow-brief-flagged]")?.textContent ?? "",
      shown: ${sheet}.querySelector("[data-cow-brief-shown]")?.textContent ?? "",
      check: ${sheet}.querySelector("[data-cow-brief-check]").textContent,
    })`),
  );
  check(
    "the sheet puts the flag first, shows each task check, and says what the checker was shown",
    diffSheet.items[0] === "flag:flag" && diffSheet.items.filter((item) => item.startsWith("task:")).length === 3 && diffSheet.flagged.includes("test/limit.test.js") && diffSheet.shown.includes("3 checks") && diffSheet.shown.includes(`against ${diffBase.slice(0, 12)}`) && diffSheet.check.includes("the task with its 3 checks and the diff"),
    JSON.stringify(diffSheet),
  );
  await shot("brief-diff");
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the diff fixture's sheet closing" });
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
  // A picture and a file that is neither text nor a picture, for what the reader does with each.
  writeFileSync(join(storage, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSAMyCP8GywMNNAAAAAElFTkSuQmCC", "base64"));
  writeFileSync(join(storage, "blob.bin"), Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 37 + (i % 7 === 0 ? 0 : 255 - i)) % 256)));
  writeFileSync(join(storage, "notes.md"), "# Notes\n\nSee [the proof](proof.txt) beside this file, and [where keys are read](" + join(workspace, "src/keys.ts") + ":62).\n\n- one\n- two\n");
  // Every run starts with nothing marked, nothing asked, and every reply seen.
  for (const name of READING) {
    const id = ids[name];
    await cow("project", id, "--clear");
    for (const ask of await openAsksOf(id)) await cow("ask", "withdraw", ask.id);
    const end = (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
    if (end !== undefined) await signer.must("seen_set", { threadId: id, seen: { seq: end, at: Date.now() } });
  }
  // A brief is submitted without a check: only its evidence link is used here.
  const before = JSON.parse(await plain("plugin", "config", PLUGIN, "--json")).values ?? {};
  const set = async (key, value) => plain("plugin", "config", PLUGIN, ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)]));
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
  // bb keeps the unread reply of a Main with no parent itself; opening its chat reads it.
  await page.key("m");
  await page.waitFor(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState === "idle"`, { label: "Main's reply read" });
  await page.key("Escape");
  await page.waitFor(`!document.querySelector("[data-cow-pane]")`, { label: "Main's chat closed" });
  // bb may draw the page afresh after the window changed size just before; the lines are waited for again.
  await page.waitFor(`${stateOf(ids.phead)} === "idle" && ${stateOf(ids.reader)} === "done"`, { label: "the lines drawn again" });
  check("Main is a project: at rest its heading reads idle", (await page.eval(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState`)) === "idle");
  check(
    "a group head is a project without being marked: at rest it is idle, in the tree, with its member under it",
    (await page.eval(stateOf(ids.phead))) === "idle" && (await page.eval(inTree(ids.phead))) && (await page.eval(projectOf(ids.phead))) === "head" && (await page.eval(`${lineEl(ids.pkid)}?.dataset.cowDepth`)) === "1",
    JSON.stringify([await page.eval(stateOf(ids.phead)), await page.eval(projectOf(ids.phead))]),
  );
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

  // A group head, with a turn another thread started: that reply is not the
  // person's, so it gives the line the unread mark and stays out of the queue.
  const headUnread = `!!${lineEl(ids.phead)}?.querySelector("[data-cow-unseen]")`;
  await watch(ids.phead);
  await tellAs(ids.pmain, ids.phead, "hello");
  await page.waitFor(`${stateOf(ids.phead)} === "running"`, { label: "the head running", timeout: 60_000 });
  await page.waitFor(`${stateOf(ids.phead)} === "idle" && ${headUnread}`, { label: "the head's reply, unread", timeout: 120_000 });
  check(
    "a group head's reply to a turn another thread started gives it the unread mark, not the queue",
    (await page.eval(`${lineEl(ids.phead)}.dataset.cowReply !== ""`)) && !(await page.eval(`!!document.querySelector('[data-cow-queue="${ids.phead}"]')`)),
  );
  await select(ids.phead);
  await page.key(" ");
  await page.waitFor(`${stateOf(ids.phead)} === "idle" && !${headUnread}`, { label: "the head's reply seen" });
  await sleep(500);
  const headStates = await watched(ids.phead);
  check(
    "a group head that finishes such a turn reads running, then idle: never replied to you, never done, never under Done",
    headStates[0] === "idle" && headStates[headStates.length - 1] === "idle" && headStates.includes("running") && !headStates.some((state) => state === "wants" || state.startsWith("done") || state.endsWith(":flat") || state === "gone"),
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
  const withProof = JSON.parse((await cowAs(ids.reader, "ask", "--question", "Are the notes right?", "--option", "yes", "--option", "no", "--proof", "notes.md", "--proof", "pixel.png", "--proof", "blob.bin", "--json")).stdout).ask;
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
  await clickOn(`${card}.querySelector('[data-cow-ask-proof="pixel.png"]')`, "the picture");
  await page.waitFor(`${rdPath} === "pixel.png" && ${rd("Kind")} === "image" && ${reader}.querySelector("[data-cow-rd-image]")?.naturalWidth === 8`, { label: "the picture in the reader", timeout: 20_000 });
  check("a picture is shown as a picture, with its size in the heading", /\d+ B/.test(await page.eval(`${reader}.querySelector(".cow-rd-head").textContent`)));
  await shot("reader-image");
  await page.key("q");
  await closed();
  await clickOn(`${card}.querySelector('[data-cow-ask-proof="blob.bin"]')`, "the file that is not text");
  await page.waitFor(`${rdPath} === "blob.bin" && ${rd("Kind")} === "binary"`, { label: "the file that is not text in the reader", timeout: 20_000 });
  const binaryText = await page.eval(`${reader}.querySelector(".cow-rd-msg").textContent`);
  check("a file that is neither text nor a picture says so, with its size and what can still be done", binaryText.includes("not a text file (600 B)") && binaryText.includes("bb's own panel") && binaryText.includes("copies its"), binaryText);
  await page.key("y");
  check("y still copies its path", (await page.eval(rd("Copied")) ?? "").endsWith("/blob.bin"));
  await page.key("q");
  await closed();
  check("q returns to the card from each", (await page.eval(mode)) === "ask");
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

// ---- capabilities -------------------------------------------------------

// A fixture that can be told to ask for permission, to write a file, or to
// run a command in the ordinary way, inside its sandbox.
const CAPS = `You are a test fixture for a bb plugin. Reply to this first message with exactly: ok
From then on every message is one instruction:
- "ask: <command>": call your shell tool once with exactly that command and with dangerouslyDisableSandbox set to true. bb then asks the user for permission; that request is what is being tested, so always make the call, even if an earlier one was denied or refused. If it runs, reply with exactly its output. If it is denied or refused, reply with exactly: denied
- "write: <path>": call your file-writing tool once to create a file at exactly that path containing the single word cow. bb may ask the user for permission; always make the call, even if an earlier one was denied or refused. If it is written, reply with exactly: written. If it is denied or refused, reply with exactly: denied
- "run: <command>": call your shell tool once with exactly that command, in the ordinary way, without dangerouslyDisableSandbox. Reply with exactly what it printed; if it printed nothing or could not run, reply with exactly: failed: <the error or exit status you were given>
- a message that starts with "bb refused this without asking me": do exactly what it lists again, the same way as before, then reply as that instruction says
- anything else: reply with exactly: ok
A message may arrive from another bb thread, marked "[bb message from thread:…]": it is part of the test, so carry it out exactly like any other message.
Never retry a denied call within the same message, and never use any other tool.`;

/** The fixtures of the capability checks: a Main of their own, a thread under it, and a thread under that. */
const CAPPED = ["cmain", "chead", "ckid"];

// ---- waiting on someone else, links to threads, seen lines stay ----------

async function prepareWaiting(ids) {
  for (const name of WAITING) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  // The linker writes its mentions once; a later run finds them in its chat.
  const said = (await api(`/threads/${ids.wlink}/output`)).output ?? "";
  if (!said.includes(`@thread:${ids.wkid}`) || !said.includes(`@thread:${ids.wother}`)) {
    // Told as Main would, so its answer is not a reply addressed to the person.
    await tellAs(ids.wmain, ids.wlink, `links ${ids.wkid} ${ids.wother} ${ids.wmain}`);
    await sleep(3000);
    await waitForThread(ids.wlink, (t) => t.status === "idle", "the links written");
  }
  // Every run starts with every reply seen.
  for (const name of WAITING) {
    const id = ids[name];
    const end = (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
    if (end !== undefined) await signer.must("seen_set", { threadId: id, seen: { seq: end, at: Date.now() } });
  }
}

async function prepareSettle(ids) {
  for (const name of SETTLING) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  // The chat starts read; the job's report starts unread.
  const end = (await api(`/threads/${ids.schat}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
  if (end !== undefined) await signer.must("seen_set", { threadId: ids.schat, seen: { seq: end, at: Date.now() } });
  await signer.must("seen_set", { threadId: ids.sjob, seen: null });
}


// ---- The ledger ------------------------------------------------------------------

/** What finished workers came to: from the page and the CLI, who may overwrite whom, the rows, the sheet, and a project not asked. */
/**
 * The workspace file on the page: its notice when it is new or changed, the
 * review in the reader with the new commands first, a approving exactly what
 * was shown, an approval refused when the file changed after it was shown,
 * and W's sheet. The folder is a throwaway one under the system temp folder;
 * its commands are `true` and `echo`, written here, and none is run.
 */
async function workspaceChecks(page, ids, shot, chooseMain) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cow-e2e-wsfile-")));
  let cloneThread = null;
  let cloneEnvironment = null;
  try {
    const ws = join(base, "ws");
    const api = join(base, "api");
    const docs = join(base, "docs");
    const git = async (cwd, ...argv) => (await run("git", ["-C", cwd, ...argv])).stdout.trim();
    mkdirSync(ws, { recursive: true });
    for (const repo of [api, docs]) {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "a.txt"), "first\n");
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "add", ".");
      await git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");
    }
    const write = (file) => writeFileSync(join(ws, "cow.workspace.json"), `${JSON.stringify(file, null, 2)}\n`);
    const first = { bring: [{ path: "../api", as: "api", sync: "true" }, { path: "../docs", as: "docs" }], sync: "echo first" };
    write(first);
    const added = JSON.parse((await run("bb", [PLUGIN, "workspace", "add", ws, "--json"])).stdout);
    const folder = added.folder;
    check("bb <id> workspace add proposes the folder, approving nothing", added.status === "new", JSON.stringify(added));
    await waitForThread(ids.wmain, (t) => t.status === "idle", "wmain idle");
    await chooseMain(page, ids.wmain);
    await page.send("Page.bringToFront");
    const notice = `document.querySelector('[data-cow-workspace-notice="${folder}"]')`;
    const readerText = `(document.querySelector("[data-cow-reader]")?.textContent ?? "")`;
    const view = async () => (await rpc("workspace_state", null)).workspaces.find((entry) => entry.folder === folder);
    await page.waitFor(`!!${notice}`, { label: "the workspace notice", timeout: 30_000 });
    check("the notice says the file is waiting", /is new and is waiting for you/.test(await page.eval(`${notice}.textContent`)));
    await page.eval(`${notice}.click(); true`);
    await page.waitFor(`${readerText}.includes("Commands that would newly run")`, { label: "the review in the reader" });
    const firstText = await page.eval(readerText);
    check("the reader lists the commands first, then the whole file", firstText.indexOf("echo first") < firstText.indexOf("The file:") && firstText.includes("api: sync"), firstText.slice(0, 300));
    await shot("workspace-review");
    await page.key("a");
    await page.waitFor(`!document.querySelector("[data-cow-reader]") && !${notice}`, { label: "approved: the reader and the notice gone" });
    const approved = await view();
    check("a approves exactly the content shown", approved.status === "approved" && approved.approvedHash === approved.currentHash);

    // A change: the notice comes back, the review shows the diff with the new command first.
    write({ ...first, bring: [{ ...first.bring[0], setup: "echo second" }] });
    await page.waitFor(`!!${notice}`, { label: "the notice for the changed file", timeout: 30_000 });
    check("the changed file's notice counts its new command", /changed and is waiting for you: 1 command would newly run/.test(await page.eval(`${notice}.textContent`)));
    await page.eval(`${notice}.click(); true`);
    await page.waitFor(`${readerText}.includes("The change")`, { label: "the diff in the reader" });
    const diffText = await page.eval(readerText);
    check("the reader shows the new command first, then the diff of approved against current", diffText.indexOf("api: setup") < diffText.indexOf("The change") && /\+\s+"setup": "echo second"/.test(diffText), diffText.slice(0, 400));
    // The file changes again while the review is open: approving what was shown is refused.
    write({ ...first, sync: "echo third" });
    expectedRefusals += 1;
    await page.key("a");
    await page.waitFor(`/changed after it was shown/.test(document.querySelector("[data-cow-reader-note]")?.textContent ?? "")`, { label: "the stale approval refused" });
    const stale = await view();
    check("a stale approval is refused, and the approved content is unchanged", stale.status === "changed" && stale.approvedHash === approved.approvedHash);
    await page.key("q");
    await page.waitFor(`!document.querySelector("[data-cow-reader]")`, { label: "the reader closed" });

    // The sheet lists the repositories.
    await page.key("W");
    await page.waitFor(`${mode} === "workspaces" && !!document.querySelector('[data-cow-workspace="${folder}"] [data-cow-workspace-repo="api"]')`, { label: "the workspaces sheet" });
    const sheet = await page.eval(`document.querySelector('[data-cow-workspace="${folder}"]').textContent`);
    check("W lists the workspace's repositories, their state and which commands they have, not their text", /api/.test(sheet) && /never synced/.test(sheet) && /commands: sync/.test(sheet) && !sheet.includes("echo"), sheet);
    await shot("workspace-sheet");

    // The file changed and is not approved (above): Enter still shows output, and r opens the change.
    check("the sheet's workspace is still waiting on a change, for what follows", (await view()).status === "changed");
    // Enter on a repository that never ran says so, through the signed call.
    const selectedRepo = `(document.querySelector('[data-cow-workspace="${folder}"] [data-cow-selected]')?.dataset.cowWorkspaceRepo ?? null)`;
    const selectRepo = async (as, key) => {
      for (let i = 0; i < 10 && (await page.eval(selectedRepo)) !== as; i += 1) await page.key(key);
      check(`${key} selects ${as} in the sheet`, (await page.eval(selectedRepo)) === as);
    };
    await selectRepo("docs", "j");
    await page.key("Enter");
    await page.waitFor(`!!document.querySelector("[data-cow-reader]")`, { label: "the reader, for a repository that never ran" });
    check("Enter on a repository that never ran says so in the reader", /never synced: there is no output to show/.test(await page.eval(readerText)), (await page.eval(readerText)).slice(0, 200));
    await page.key("q");
    await page.waitFor(`!document.querySelector("[data-cow-reader]")`, { label: "the reader closed" });

    // s runs api's approved sync; Enter then shows its last output, read with a signed call.
    await page.key("W");
    await page.waitFor(`${mode} === "workspaces"`, { label: "the sheet again" });
    await selectRepo("api", "k");
    await page.key("s");
    await page.waitFor(`/synced 1 repository/.test(document.querySelector("[data-cow-workspaces-note]")?.textContent ?? "")`, { label: "api synced", timeout: 60_000 });
    await page.waitFor(`/synced .* ago, exit 0/.test(document.querySelector('[data-cow-workspace="${folder}"] [data-cow-workspace-repo="api"]')?.textContent ?? "")`, { label: "the sheet shows api's sync" });
    await page.key("Enter");
    await page.waitFor(`!!document.querySelector("[data-cow-reader]")`, { label: "the reader, with api's last output" });
    const output = await page.eval(readerText);
    check("Enter on a repository that ran shows its last output in the reader: where, when, its exit code", output.includes(`last sync of api in ${api}`) && /exit 0/.test(output), output.slice(0, 300));
    const unsignedOutput = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/workspace_output`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder, as: "api", kind: "sync" }) }).then((r) => r.json());
    const forgedOutput = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/signed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "workspace_output", args: { folder, as: "api", kind: "sync" } }) }).then((r) => r.json());
    check("the output is read only through the signed call: there is no unsigned one, and an unsigned envelope is refused", unsignedOutput.ok === false && forgedOutput.ok === false, JSON.stringify([unsignedOutput, forgedOutput]).slice(0, 300));
    await page.key("q");
    await page.waitFor(`!document.querySelector("[data-cow-reader]") && ${mode} === "normal"`, { label: "the reader closed" });
    await page.key("W");
    await page.waitFor(`${mode} === "workspaces"`, { label: "the sheet, for r" });
    await page.key("r");
    await page.waitFor(`${readerText}.includes("The change")`, { label: "r: the file's change in the reader" });
    check("r in the sheet opens the workspace file's change", /"sync": "echo third"/.test(await page.eval(readerText)));
    await page.key("q");
    await page.waitFor(`!document.querySelector("[data-cow-reader]") && ${mode} === "normal"`, { label: "the reader closed" });

    // B: a thread in a clone of the workspace commits once; B brings it back.
    const backCommand = 'git -C "$COW_SOURCE" fetch -q "$COW_CLONE" "$COW_BRANCH:$COW_BRANCH"';
    // docs is left on its own branch ("branch": "keep"): no thread branch is made in it, and B does not look there.
    write({ bring: [{ path: "../api", as: "api", sync: "true", back: backCommand }, { path: "../docs", as: "docs", back: backCommand, branch: "keep" }] });
    let withBack = await view();
    for (let i = 0; i < 20 && withBack.currentHash === withBack.approvedHash; i += 1) withBack = await view();
    await signer.must("workspace_approve", { folder, hash: withBack.currentHash });
    check("the file with back commands is approved", (await view()).status === "approved");
    const commit = 'cd api && echo work > work.txt && git add work.txt && git -c user.name=t -c user.email=t@example.com commit -qm "work from the thread"';
    const spawned = await bb(
      "thread", "spawn",
      "--project", PROJECT,
      "--environment-provider", `${PLUGIN}-clone`,
      "--environment-inputs", JSON.stringify({ workspace: folder }),
      "--provider", "claude-code",
      "--model", MODEL,
      "--title", TITLE,
      "--parent-notifications", "off",
      "--parent-thread", ids.wmain,
      "--prompt", `You are a test fixture for a bb plugin. Run this one shell command exactly as written, once, with your shell tool, then reply with exactly: done\n${commit}\nUse no other tool and run nothing else.`,
    );
    cloneThread = spawned.id;
    console.log(`clone fixture ${cloneThread}`);
    const finished = await waitForThread(cloneThread, (t) => t.status === "idle" && !!t.environmentId, "the clone fixture idle", 5 * 60_000);
    cloneEnvironment = finished.environmentId;
    const environment = await bb("environment", "show", cloneEnvironment);
    const clonePath = (environment.environment ?? environment).path;
    const branch = await git(join(clonePath, "api"), "branch", "--show-current");
    check("the clone fixture committed in its clone", (await git(join(clonePath, "api"), "log", "-1", "--format=%s")) === "work from the thread", clonePath);
    check("the source has no such branch yet", (await git(api, "branch", "--list", branch)) === "");
    check(
      'docs, with "branch": "keep", stays on its own branch, with no thread branch; api is on the thread\'s',
      (await git(join(clonePath, "docs"), "branch", "--show-current")) === "main" && (await git(join(clonePath, "docs"), "branch", "--list", branch)) === "" && branch !== "main",
      `${branch} / docs on ${await git(join(clonePath, "docs"), "branch", "--show-current")}`,
    );

    const cloneLine = `document.querySelector('.cow-main [data-cow-line="${cloneThread}"]')`;
    await page.waitFor(`!!${cloneLine}`, { label: "the clone fixture's line", timeout: 60_000 });
    const confirmText = `(document.querySelector("[data-cow-confirm]")?.textContent ?? "")`;
    const message = () => page.eval(`document.querySelector("[data-cow-message]")?.textContent ?? ""`);
    const pressB = async () => {
      await page.eval(`${cloneLine}.click(); true`);
      await sleep(200);
      await page.key("B");
      await page.waitFor(`!!document.querySelector("[data-cow-confirm]")`, { label: "B's confirmation", timeout: 30_000 });
    };
    await pressB();
    const asked = await page.eval(confirmText);
    check("B names each repository with new commits and the command it would run, and only those; docs keeps its own branch, so B does not look there", asked.includes("api (1 commit): runs git -C \"$COW_SOURCE\" fetch") && !asked.includes("docs (") && asked.includes("docs keeps its own branch, so B does not look there"), asked);
    await shot("workspace-back-confirm");
    await page.key("n");
    await page.waitFor(`!document.querySelector("[data-cow-confirm]")`, { label: "cancelled" });
    check("any other key cancels, and nothing runs", /not brought back/.test(await message()) && (await git(api, "branch", "--list", branch)) === "", await message());
    const logged = async () => JSON.stringify((await rpc("caps_log", { limit: 20 })).entries ?? []);
    check("the cancel is not in the log as a back", !(await logged()).includes(cloneThread));
    await pressB();
    await page.key("y");
    await page.waitFor(`/brought back/.test(document.querySelector("[data-cow-message]")?.textContent ?? "")`, { label: "brought back", timeout: 120_000 });
    check("y runs it through the signed action, and the result is shown", /brought back: api exit 0/.test(await message()), await message());
    check("the source repository has the commit afterwards", (await git(api, "log", "-1", "--format=%s", branch)) === "work from the thread");
    check("docs had nothing new: no branch there", (await git(docs, "branch", "--list", branch)) === "");
    check("the back is in the log, signed", /workspace-back/.test(await logged()) && (await logged()).includes(cloneThread));
    await shot("workspace-back-done");

    // Held: an uncommitted file in docs (no teardown), then bb removes the clone. It is held, the queue says so, and W removes it after y.
    writeFileSync(join(clonePath, "docs", "unsaved.txt"), "keep me\n");
    await bb("thread", "archive", cloneThread);
    await bb("environment", "cleanup", cloneEnvironment);
    let heldEntry;
    for (let i = 0; i < 60 && !heldEntry; i += 1) {
      heldEntry = (await rpc("workspace_state", null)).held.find((entry) => entry.threadId === cloneThread);
      if (!heldEntry) await sleep(2000);
    }
    cloneThread = null;
    const heldNotice = `document.querySelector('[data-cow-held-notice="${heldEntry?.id}"]')`;
    await page.waitFor(`!!${heldNotice}`, { label: "the held notice", timeout: 60_000 });
    const noticeText = await page.eval(`${heldNotice}.textContent`);
    check("the queue says the clone was held, not deleted, and why", heldEntry && noticeText.includes(`the clone of ${TITLE} was held, not deleted: docs: 1 uncommitted or untracked change, and no teardown`) && noticeText.includes(heldEntry.path), noticeText);
    check("its files are intact at the held path", heldEntry && readFileSync(join(heldEntry.path, "docs", "unsaved.txt"), "utf8") === "keep me\n", heldEntry?.path);
    await shot("workspace-held-notice");
    await page.eval(`${heldNotice}.click(); true`);
    const heldRow = `document.querySelector('[data-cow-held="${heldEntry?.id}"]')`;
    await page.waitFor(`${mode} === "workspaces" && !!${heldRow}`, { label: "W opened on the held clone" });
    const rowText = await page.eval(`${heldRow}.textContent`);
    check("W's held part lists it with its thread's title, when, why and its path, selected", rowText.includes(TITLE) && /held .* ago/.test(rowText) && rowText.includes("docs: 1 uncommitted") && rowText.includes(heldEntry.path) && (await page.eval(`${heldRow}.dataset.cowSelected === "true"`)), rowText);
    await shot("workspace-held-sheet");
    const repoRow = (as) => page.eval(`document.querySelector('[data-cow-workspace="${folder}"] [data-cow-workspace-repo="${as}"]')?.textContent ?? ""`);
    check('W says docs keeps its own branch ("branch": "keep"), and not api', /keeps its own branch/.test(await repoRow("docs")) && !/keeps its own branch/.test(await repoRow("api")), `${await repoRow("docs")} / ${await repoRow("api")}`);
    const sheetNote = `(document.querySelector("[data-cow-workspaces-note]")?.textContent ?? "")`;
    await page.key("d");
    await page.waitFor(`!!document.querySelector("[data-cow-held-confirm]")`, { label: "d's confirmation" });
    check("d names what would be lost before anything is removed", /remove the held clone of .* for good\? Lost with it: docs: 1 uncommitted or untracked change, and everything else in /.test(await page.eval(sheetNote)), await page.eval(sheetNote));
    await shot("workspace-held-confirm");
    await page.key("n");
    await page.waitFor(`/kept: the held clone is not removed/.test(${sheetNote})`, { label: "n keeps it" });
    check("any other key keeps it", existsSync(heldEntry.path));
    await page.key("d");
    await page.waitFor(`!!document.querySelector("[data-cow-held-confirm]")`, { label: "d's confirmation again" });
    await page.key("y");
    await page.waitFor(`/removed the held clone/.test(${sheetNote})`, { label: "removed", timeout: 60_000 });
    check("y removes it for good, through the signed action", !existsSync(heldEntry.path) && (await rpc("workspace_state", null)).held.every((entry) => entry.id !== heldEntry.id));
    await page.key("q");
    await page.waitFor(`${mode} === "normal" && !${heldNotice}`, { label: "the held notice gone" });
    check("the removal is in the log, signed", /removed the held clone/.test(JSON.stringify((await rpc("caps_log", { limit: 20 })).entries ?? [])) || /workspace-held/.test(await logged()));
  } finally {
    for (const entry of (await rpc("workspace_state", null).catch(() => ({ held: [] }))).held ?? []) {
      if (entry.path.startsWith(base) || entry.title === TITLE) await signer.call("workspace_held_remove", { id: entry.id }).catch(() => {});
    }
    if (cloneThread) {
      await bb("thread", "archive", cloneThread).catch((cause) => console.error(`could not archive ${cloneThread}`, cause));
      if (cloneEnvironment) await bb("environment", "cleanup", cloneEnvironment).catch((cause) => console.error(`could not clean up ${cloneEnvironment}`, cause));
    }
    rmSync(base, { recursive: true, force: true });
  }
}

async function ledgerChecks(page, ids, shot, chooseMain) {
  const { lmain, lone, ltwo, lproj } = ids;
  for (const name of LEDGER) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  // The project is marked by the Main that started it, before the page reads it.
  check("bb cow project marks the stand-in project", (await cowAs(lmain, "project", lproj)).code === 0);
  await page.eval(`sessionStorage.removeItem("cow:folds"); true`);
  await chooseMain(page, lmain);
  await page.send("Page.bringToFront");
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const settled = (id) => `(${lineEl(id)}?.dataset.cowSettle === "")`;
  const archivedLine = (id) => `(!!${lineEl(id)} && !!document.querySelector("[data-cow-archived]") && !!(document.querySelector("[data-cow-archived]").compareDocumentPosition(${lineEl(id)}) & Node.DOCUMENT_POSITION_FOLLOWING))`;
  const select = async (id) => {
    await page.eval(`${lineEl(id)}.click(); true`);
    await sleep(200);
  };
  const ledger = async () => rpc("ledger_read", { days: 14 });
  const rowOf = async (id) => (await ledger()).rows.find((row) => row.threadId === id) ?? null;
  const message = () => page.eval(`document.querySelector("[data-cow-message]")?.textContent ?? ""`);
  const ALLOWED = ["threadId", "projectId", "dispatchedBy", "model", "effort", "firstTurnAt", "firstReportAt", "toFirstReportMs", "steersByPerson", "steersByThreads", "turns", "outcome", "judgedBy", "judgedAt", "outcomeChanges", "archivedAt", "archivedBy", "label", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "toolCalls", "workingMinutes"].sort();

  // -- a project is not asked --
  await page.waitFor(`!!${lineEl(lproj)} && !!${lineEl(lone)} && !!${lineEl(ltwo)}`, { label: "the three lines" });
  await select(lproj);
  await page.key("e");
  await page.waitFor(`${mode} === "archive"`, { label: "the archive prompt" });
  await page.waitFor(`document.activeElement?.dataset.cowInput === "archive-reason"`, { label: "the reason, focused" });
  check("e on a project goes straight to the reason: no outcome is asked", !(await page.eval(`!!document.querySelector("[data-cow-outcome-prompt]")`)));
  await page.key("Escape");
  await page.waitFor(`${mode} === "normal"`, { label: "cancelled" });
  const projectRefused = await cowAs(lmain, "outcome", lproj, "done");
  check("bb cow outcome refuses a project", projectRefused.code !== 0 && /project/.test(projectRefused.stdout + projectRefused.stderr), (projectRefused.stdout + projectRefused.stderr).trim());

  // -- archived from the page, with an outcome and a reason --
  await page.waitFor(settled(lone), { label: "the worker to settle" });
  await select(lone);
  await page.key("e");
  await page.waitFor(`!!document.querySelector('[data-cow-outcome-prompt="archive"]')`, { label: "the outcome prompt" });
  const choices = await page.eval(`[...document.querySelectorAll("[data-cow-outcome-choice]")].map((el) => el.textContent.trim()).join(" | ")`);
  check("e on a finished worker first asks what it came to, each outcome with its meaning", /1\s*done: the work was used as it came back/.test(choices) && /2\s*partial: some of it was used/.test(choices) && /3\s*redone/.test(choices) && /4\s*dropped/.test(choices), choices);
  await shot("ledger-outcome-prompt");
  await page.key("2");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "archive-reason"`, { label: "then the reason" });
  check("a digit chooses, then the reason is asked as before", (await page.eval(`document.querySelector(".cow-prompt")?.textContent ?? ""`)).includes("came to: partial"));
  await page.type("used half of it");
  await page.key("Enter");
  await page.waitFor(archivedLine(lone), { label: "archived", timeout: 30_000 });
  await page.waitFor(`!!${lineEl(lone)}?.querySelector('[data-cow-outcome="partial"]')`, { label: "came to: partial", timeout: 20_000 });
  check("the message says it is archived and what it came to", (await message()).includes("came to: partial"), await message());
  const one = await rowOf(lone);
  check("its ledger row: the outcome, judged and archived by the person, dispatched by its Main, on the fixture model", one?.outcome === "partial" && one?.judgedBy === "person" && one?.archivedBy === "person" && one?.dispatchedBy === lmain && one?.model === MODEL && one?.turns >= 1 && one?.toFirstReportMs >= 0, JSON.stringify(one));
  check("the row's keys are exactly the allowed set, and it holds no title", JSON.stringify(Object.keys(one ?? {}).sort()) === JSON.stringify(ALLOWED) && !JSON.stringify(one).includes(TITLE));
  console.log(`note: effort recorded for the fixture: ${JSON.stringify(one?.effort ?? null)}`);
  const logged = JSON.stringify((await rpc("caps_log", { limit: 20 })).entries ?? []);
  check("the page's outcome is in cow's log, under the key that signed it", logged.includes("outcome-set") && logged.includes(lone));

  // -- archived by its dispatcher, with an outcome --
  const badLabel = await cowAs(lmain, "label", ltwo, "two words");
  check("bb cow label refuses anything but one short word, with the rule", badLabel.code !== 0 && /lower-case letters, digits and hyphens/.test(badLabel.stdout + badLabel.stderr), (badLabel.stdout + badLabel.stderr).trim());
  const early = await cowAs(lmain, "label", ltwo, "Draft");
  check("its dispatcher labels a worker before it is archived, lower-cased", early.code === 0 && early.stdout.includes(": draft") && JSON.parse((await cowAs(lmain, "label", ltwo, "--json")).stdout).label === "draft", (early.stdout + early.stderr).trim());
  const byCli = await cowAs(lmain, "archive", ltwo, "--reason", "merged", "--outcome", "done", "--label", "code-change");
  check("bb cow archive --outcome, run by the thread that dispatched it", byCli.code === 0 && byCli.stdout.includes("came to: done"), (byCli.stdout + byCli.stderr).trim());
  const two = await rowOf(ltwo);
  check("its row says the dispatcher judged and archived it", two?.outcome === "done" && two?.judgedBy === lmain && two?.archivedBy === lmain && two?.outcomeChanges === 0, JSON.stringify(two));
  check("archive --label is in the row", two?.label === "code-change", JSON.stringify(two?.label));
  check("the row archived from the page before it had a label says none", (await rowOf(lone))?.label === null, JSON.stringify((await rowOf(lone))?.label));
  const personLabel = await cow("label", lone, "lookup");
  check("a label set after archiving updates the row; outside any thread it is the person's", personLabel.code === 0 && (await rowOf(lone))?.label === "lookup", (personLabel.stdout + personLabel.stderr).trim());
  const labelOverwrite = await cowAs(lmain, "label", lone, "draft");
  const labelClear = await cowAs(lmain, "label", lone, "--clear");
  check("a thread cannot overwrite or clear the person's label, and is told so", labelOverwrite.code !== 0 && labelClear.code !== 0 && /the person labelled it “lookup”/.test(labelOverwrite.stdout + labelOverwrite.stderr) && (await rowOf(lone))?.label === "lookup", (labelOverwrite.stdout + labelOverwrite.stderr).trim());

  // -- changed later, from each side --
  const threadChange = await cowAs(lmain, "outcome", ltwo, "redone");
  check("the dispatcher changes its own outcome later with bb cow outcome", threadChange.code === 0 && (await rowOf(ltwo))?.outcome === "redone" && (await rowOf(ltwo))?.outcomeChanges === 1, (threadChange.stdout + threadChange.stderr).trim());
  const overwrite = await cowAs(lmain, "outcome", lone, "done");
  check("a thread cannot overwrite the person's outcome, and is told so", overwrite.code !== 0 && /the person judged it “partial”/.test(overwrite.stdout + overwrite.stderr) && (await rowOf(lone))?.outcome === "partial", (overwrite.stdout + overwrite.stderr).trim());
  await page.waitFor(archivedLine(ltwo), { label: "the second worker under Archived", timeout: 30_000 });
  await select(ltwo);
  await page.key("o");
  await page.waitFor(`!!document.querySelector('[data-cow-outcome-prompt="change"]')`, { label: "o's prompt" });
  check("o on an archived line asks, and says what it came to now", (await page.eval(`document.querySelector('[data-cow-outcome-prompt]')?.textContent ?? ""`)).includes(`now: redone, judged by ${lmain}`));
  await page.key("4");
  await page.waitFor(`!!${lineEl(ltwo)}?.querySelector('[data-cow-outcome="dropped"]')`, { label: "came to: dropped", timeout: 20_000 });
  const changed = await rowOf(ltwo);
  check("the person changes it on the page: the row shows the latest, judged by the person, changed twice", changed?.outcome === "dropped" && changed?.judgedBy === "person" && changed?.outcomeChanges === 2, JSON.stringify(changed));
  const again = await cowAs(lmain, "outcome", ltwo, "done");
  check("after that the thread is refused there too", again.code !== 0 && (await rowOf(ltwo))?.outcome === "dropped");
  const fromTerminal = await cow("outcome", lone, "redone");
  check("bb cow outcome outside any thread is the person's", fromTerminal.code === 0 && (await rowOf(lone))?.judgedBy === "person" && (await rowOf(lone))?.outcome === "redone", (fromTerminal.stdout + fromTerminal.stderr).trim());
  const unsigned = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/outcome_set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: lone, outcome: "done" }) }).then((r) => r.json());
  const forged = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/signed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "outcome_set", args: { threadId: lone, outcome: "done" }, at: Date.now(), nonce: "x".repeat(20), key: "0000-0000-0000-0000", sig: "AAAA" }) }).then((r) => r.json());
  check("there is no unsigned way to set it as the person from the page's interface, and a forged one is refused", unsigned.ok === false && forged.ok === false && (await rowOf(lone))?.outcome === "redone");

  // -- reading it --
  const status = (await cow("status", "--main", lmain)).stdout;
  check("bb cow status shows the outcome beside an archived line", status.includes(`(${ltwo})`) && status.includes("[outcome: dropped, judged by the person]"), status.split("\n").filter((l) => l.includes(ltwo)).join(" / "));
  const text = (await cow("ledger")).stdout;
  check("bb cow ledger summarises by model and by dispatcher, and calls a group of two too small to compare", text.includes("By model") && text.includes("By dispatching thread") && text.includes(`${lmain}:`) && /too small to compare/.test(text) && text.includes(lone) && text.includes(ltwo) && !text.includes(TITLE), text.split("\n").slice(0, 8).join(" / "));
  const byLabelText = (await cow("ledger", "--by", "label")).stdout;
  console.log(`note: bb ${PLUGIN} ledger --by label:\n${byLabelText}`);
  check(
    "bb cow ledger --by label groups by label, then by model within it, and shows no other grouping",
    byLabelText.includes("By label, then by model") && !byLabelText.includes("By model\n") && /\n  code-change: 1 worker[^\n]*\n    [^\n]+: 1 worker/.test(byLabelText) && /\n  lookup: 1 worker/.test(byLabelText),
    byLabelText.split("\n").slice(0, 8).join(" / "),
  );
  const json = JSON.parse((await cow("ledger", "--days", "1", "--json")).stdout);
  check("--json has the summary by label, each with its models", json.summary.byLabel?.some((group) => group.key === "code-change" && group.outcomes.dropped === 1 && group.byModel.length === 1) && json.summary.byLabel.some((group) => group.key === "lookup"), JSON.stringify(json.summary.byLabel?.map((group) => [group.key, group.workers])));
  const dispatcher = json.summary.byDispatcher.find((group) => group.key === lmain);
  // -- tokens and list-price dollars --
  const TOKEN_KEYS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"];
  const withUsage = json.rows.find((row) => row.threadId === lone);
  check("the row of an archived worker holds the four token counts bb recorded", TOKEN_KEYS.every((key) => typeof withUsage?.[key] === "number") && TOKEN_KEYS.some((key) => withUsage[key] > 0), JSON.stringify(TOKEN_KEYS.map((key) => withUsage?.[key])));
  const labelled = json.summary.byLabel?.find((group) => group.key === "lookup");
  check("--json carries each group's tokens, list-price dollars and dollars per done, and says they are list price and an estimate", json.listPrice === true && json.estimate === true && typeof labelled?.tokens?.input === "number" && typeof labelled?.dollars === "number" && "dollarsPerDone" in labelled && typeof withUsage?.listPriceUsd === "number", JSON.stringify(labelled && { tokens: labelled.tokens, dollars: labelled.dollars, perDone: labelled.dollarsPerDone }));
  check("bb cow ledger --by label gives each label its tokens and list-price dollars", /\n  lookup: 1 worker[^\n]* tokens · \$[0-9.]+ at list price/.test(byLabelText) && byLabelText.includes("estimate at the providers' list prices"), byLabelText.split("\n").filter((line) => line.includes("lookup")).join(" / "));
  const pricesBefore = JSON.parse(await plain("plugin", "config", PLUGIN, "--json")).values?.listPrices ?? "";
  const setPrices = (value) => plain("plugin", "config", PLUGIN, ...(value === "" ? ["unset", "listPrices"] : ["set", "listPrices", value]));
  try {
    await setPrices(JSON.stringify({ [MODEL]: null }));
    const unpriced = (await cow("ledger", "--by", "label")).stdout;
    console.log(`note: bb ${PLUGIN} ledger --by label, with ${MODEL} taken out of the prices:\n${unpriced}`);
    const lookupLine = unpriced.split("\n").find((line) => line.startsWith("  lookup:")) ?? "";
    check("a model with no price shows its tokens and no dollar figure, not $0", / tokens · no list price/.test(lookupLine) && !/\$/.test(lookupLine), lookupLine);
    await setPrices(JSON.stringify({ [MODEL]: { input: 1000, cacheRead: 1000, cacheWrite: 1000, output: 1000 } }));
    const dear = JSON.parse((await cow("ledger", "--days", "1", "--json")).stdout).summary.byLabel.find((group) => group.key === "lookup");
    check("a price changed in the setting changes the dollars shown for rows already written", typeof dear?.dollars === "number" && dear.dollars > (labelled?.dollars ?? 0) * 10, `${labelled?.dollars} then ${dear?.dollars}`);
  } finally {
    await setPrices(pricesBefore);
  }
  const spendText = (await cow("spend", "--main", lmain)).stdout;
  console.log(`note: bb ${PLUGIN} spend --main ${lmain}:\n${spendText}`);
  const spent = JSON.parse((await cow("spend", "--main", lmain, "--json")).stdout);
  check(
    "bb cow spend lists workers, project threads, Main and checker runs apart, with a total, and says how many had no usage recorded",
    ["Workers:", "Project threads:", "Main:", "cow's checker runs:", "Total:"].every((part) => spendText.includes(part)) && /with no usage recorded|Every thread had usage recorded/.test(spendText) && spendText.includes("estimate at the providers' list prices"),
    spendText.split("\n").slice(0, 9).join(" / "),
  );
  check(
    "bb cow spend counts threads that are not archived: Main and its project, beside the archived workers",
    spent.ok === true && spent.parts.main.threads === 1 && spent.parts.projects.threads >= 1 && spent.parts.workers.threads >= 2 && spent.total.threads >= spent.parts.main.threads + spent.parts.projects.threads + spent.parts.workers.threads && typeof spent.total.noUsage === "number",
    JSON.stringify({ main: spent.parts?.main?.threads, projects: spent.parts?.projects?.threads, workers: spent.parts?.workers?.threads, total: spent.total?.threads, noUsage: spent.total?.noUsage }),
  );
  check(
    "bb cow spend with no option covers the last 30 days and says so; --json carries the period",
    /^Spend in the last 30 days \(\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\) under Main/.test(spendText) && spent.period?.kind === "last30Days" && spent.period.month === null && spent.period.last === localDay(Date.now()) && spent.period.first === localDay(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 29).getTime()),
    JSON.stringify(spent.period),
  );
  const october = await cow("spend", "--main", lmain, "--month", "2026-10");
  const octoberJson = JSON.parse((await cow("spend", "--main", lmain, "--month", "2026-10", "--json")).stdout);
  check("bb cow spend --month 2026-10 still gives October", october.stdout.startsWith("Spend in 2026-10 under Main") && octoberJson.period?.kind === "month" && octoberJson.period.first === "2026-10-01" && octoberJson.period.last === "2026-10-31", october.stdout.split("\n")[0]);
  check("--json gives the last 30 days' tokens and list-price dollars", spent.listPrice === true && spent.estimate === true && typeof spent.total.tokens.output === "number" && spent.total.tokens.output > 0 && typeof spent.total.dollars === "number");
  check("--json gives the rows and the summary; the small group has counts and no percentages", json.ok === true && json.rows.some((row) => row.threadId === lone) && dispatcher?.workers === 2 && dispatcher?.small === true && dispatcher?.shares === null && dispatcher?.outcomes.redone === 1 && dispatcher?.outcomes.dropped === 1, JSON.stringify(dispatcher));
  await page.key("L");
  await page.waitFor(`${mode} === "ledger" && !!document.querySelector('[data-cow-ledger-row="${lone}"]')`, { label: "the ledger sheet", timeout: 20_000 });
  check("L opens the ledger sheet with the latest rows and their outcomes", (await page.eval(`document.querySelector('[data-cow-ledger-row="${ltwo}"]')?.dataset.cowLedgerOutcome`)) === "dropped" && (await page.eval(`document.querySelector('[data-cow-ledger-row="${lone}"]')?.dataset.cowLedgerOutcome`)) === "redone");
  check("the sheet's groups say a small one is too small to compare", await page.eval(`!!document.querySelector('[data-cow-ledger-group="${lmain}"][data-cow-ledger-small]')`));
  const groupCost = await page.eval(`document.querySelector('[data-cow-ledger-group="${lmain}"] [data-cow-ledger-cost]')?.textContent ?? ""`);
  check("the sheet gives each group its tokens and list-price dollars", / tokens · \$[0-9.]+ at list price/.test(groupCost), groupCost);
  check("the sheet gives each row its tokens", (await page.eval(`document.querySelector('[data-cow-ledger-row="${lone}"] [data-cow-ledger-usage]')?.dataset.cowLedgerUsage`)) === "known");
  await page.waitFor(`!!document.querySelector('[data-cow-spend-part="total"]')`, { label: "the last 30 days in the sheet", timeout: 30_000 });
  const parts = await page.eval(`[...document.querySelectorAll("[data-cow-spend-part]")].map((el) => el.dataset.cowSpendPart + ":" + el.dataset.cowSpendThreads).join(" ")`);
  check("the sheet shows the last 30 days under Main: workers, project threads, Main, checker runs and the total, and how many had no usage recorded", /workers:\d+ projects:\d+ main:1 checkers:\d+ total:\d+/.test(parts) && (await page.eval(`document.querySelector("[data-cow-spend-unknown]") !== null`)), parts);
  await shot("ledger-sheet");
  for (const key of ["b", "b", "b"]) await page.key(key);
  await page.waitFor(`document.querySelector("[data-cow-ledger]")?.dataset.cowLedgerBy === "label"`, { label: "the sheet by label" });
  check(
    "b steps the sheet to its grouping by label, with each label's models under it, and no other grouping",
    (await page.eval(`!!document.querySelector('[data-cow-ledger-label="code-change"] [data-cow-ledger-model-in="code-change"]')`)) && (await page.eval(`!!document.querySelector('[data-cow-ledger-label="lookup"]')`)) && !(await page.eval(`!!document.querySelector('[data-cow-ledger-group="${lmain}"]')`)),
  );
  await shot("ledger-sheet-by-label");
  await page.key("b");
  await page.waitFor(`document.querySelector("[data-cow-ledger]")?.dataset.cowLedgerBy === "all"`, { label: "every grouping again" });
  await page.key("q");
  await page.waitFor(`${mode} === "normal" && !document.querySelector("[data-cow-ledger]")`, { label: "closed with q" });
  await page.key("L");
  await page.waitFor(`${mode} === "ledger"`, { label: "opened again" });
  await page.key("Escape");
  await page.waitFor(`${mode} === "normal"`, { label: "closed with Escape" });
  check("q and Escape close it", true);
  await watchChecks(page, ids, shot);
  await usageChecks(page, shot);
  await deletedChecks(lmain, ltwo);
}

/** A deleted worker's usage is still counted under its Main until it is forgotten on purpose. Deletes one of this run's own fixtures. */
async function deletedChecks(lmain, gone) {
  const sum = (t) => t.input + t.cacheRead + t.cacheWrite + t.output;
  const spendJson = async () => JSON.parse((await cow("spend", "--main", lmain, "--json")).stdout);
  const before = await spendJson();
  await run("bb", ["thread", "delete", gone, "--yes", "--json"]);
  await sleep(1500);
  const after = await spendJson();
  const text = (await cow("spend", "--main", lmain)).stdout;
  console.log(`note: bb ${PLUGIN} spend --main ${lmain}, after deleting ${gone}:\n${text}`);
  check(
    "a deleted worker's tokens stay in the spend under its Main, and the spend says a deleted thread is counted",
    sum(after.total.tokens) === sum(before.total.tokens) && after.total.deleted >= 1 && after.parts.workers.deleted >= 1 && /\d+ deleted threads? (is|are) still counted/.test(text),
    JSON.stringify({ before: sum(before.total.tokens), after: sum(after.total.tokens), deleted: after.total.deleted }),
  );
  const listed = await cow("spend", "forget", "--deleted");
  console.log(`note: bb ${PLUGIN} spend forget --deleted:\n${listed.stdout}`);
  const kept = JSON.parse((await cow("spend", "forget", "--deleted", "--json")).stdout);
  const mine = kept.threads?.find((t) => t.threadId === gone);
  check("bb cow spend forget --deleted lists it and removes nothing without --yes", listed.code === 0 && /^Would remove/.test(listed.stdout) && listed.stdout.includes(gone) && kept.removed === false && mine !== undefined && sum((await spendJson()).total.tokens) === sum(before.total.tokens), listed.stdout.split("\n")[0]);
  const removed = await cow("spend", "forget", "--deleted", "--yes");
  const dropped = await spendJson();
  check(
    "with --yes it removes them, and the spend drops by exactly that thread's tokens",
    removed.code === 0 && /^Removed/.test(removed.stdout) && sum(before.total.tokens) - sum(dropped.total.tokens) === (mine?.last30Days ?? -1) && dropped.total.deleted === 0,
    JSON.stringify({ before: sum(before.total.tokens), after: sum(dropped.total.tokens), its: mine?.last30Days }),
  );
}

/**
 * Caps and stuck checks, shown and never enforced, on the copy's default
 * settings (no caps; the stuck checks on): a fixture under the stand-in Main
 * runs the same command three times while its turn runs, and gets the mark on
 * its line and exactly one notice, which an unsigned call cannot acknowledge
 * and a click (signed) does, after which it does not come back. Then a worker
 * whose own thread is archived gets an outcome and a ledger row with its tool
 * calls and working minutes, refused while that thread was live. Three more
 * fixtures; nothing is stopped or sent to any of them.
 */
async function watchChecks(page, ids, shot) {
  // The copy's worker notifications are turned off first: the checks send the person none. Put back after.
  const before = JSON.parse(await plain("plugin", "config", PLUGIN, "--json")).values ?? {};
  const set = async (key, value) => plain("plugin", "config", PLUGIN, ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)]));
  await set("watchNotify", false);
  try {
    await watchChecksIn(page, ids, shot);
    await liveChecks(page, ids, shot, set);
  } finally {
    for (const key of ["watchNotify", "liveUsage", "caps"]) await set(key, before[key]).catch(() => undefined);
  }
}

async function watchChecksIn(page, ids, shot) {
  const { lmain, lproj } = ids;
  // The repeated command is the long one: the mark holds from its third start until the turn ends, while bb cow status is read.
  const SLOW = "python3 -c 'import time; time.sleep(30)'";
  const REPEAT = `You are a test fixture for a bb plugin. Run this shell command three times, one at a time, each as its own separate tool call, waiting for each to finish before the next: ${SLOW}. Run nothing else, and nothing in the background. Then reply with exactly: ok`;
  const lrep = (inUse.lrep = ids.lrep = await spawn({ prompt: REPEAT, parent: lmain, permissionMode: "full" }));
  const lsub = (inUse.lsub = ids.lsub = await spawn({ prompt: QUIET, parent: lmain }));
  const lkid = (inUse.lkid = ids.lkid = await spawn({ prompt: QUIET, parent: lsub }));
  const rowOf = async (id) => (await rpc("ledger_read", { days: 14 })).rows.find((row) => row.threadId === id) ?? null;
  const notices = (id, reason) => `document.querySelectorAll('[data-cow-watch-thread="${id}"]${reason ? `[data-cow-watch-reason="${reason}"]` : ""}')`;
  await page.waitFor(`${notices(lrep, "repeat")}.length > 0`, { label: "the repeat notice", timeout: 180_000 });
  await page.waitFor(`!!document.querySelector('.cow-main [data-cow-line="${lrep}"] [data-cow-watch]')`, { label: "the mark on its line", timeout: 20_000 });
  const mark = await page.eval(`document.querySelector('.cow-main [data-cow-line="${lrep}"] [data-cow-watch]')?.textContent ?? ""`);
  check("a worker that runs the same command three times while its turn runs gets the mark on its line", /the same command [34] times/.test(mark), mark);
  await shot("watch-mark");
  // Read while its turn still runs: the stuck checks are only for a running turn.
  const [statusText, statusJson] = await Promise.all([cow("status", "--main", lmain).then((r) => r.stdout), cow("status", "--main", lmain, "--json").then((r) => JSON.parse(r.stdout))]);
  const statusLine = statusText.split("\n").find((l) => l.includes(`(${lrep})`)) ?? "";
  const line = [...statusJson.threads, ...statusJson.queue].find((l) => l.id === lrep);
  check(
    "bb cow status shows the same mark beside the line, and --json its facts",
    /\[the same command [34] times/.test(statusLine) && line?.watch?.some((w) => w.reason === "repeat" && w.facts.times >= 3 && w.facts.call === SLOW),
    `${statusLine.trim()} | ${JSON.stringify(line?.watch)}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const raised = await page.eval(`[...${notices(lrep)}].map((el) => [el.dataset.cowWatchReason, el.dataset.cowWatchNotice, el.querySelector("p")?.textContent ?? ""])`);
  check("exactly one notice for it, with the facts cow collected", raised.length === 1 && raised[0][2].startsWith(`“${TITLE}” ran the same command 3 times in a row: ${SLOW}. `) && raised[0][2].includes("cow does not stop it."), JSON.stringify(raised));
  check("Main and a project get no mark or notice", (await page.eval(`${notices(lmain)}.length + ${notices(lproj)}.length`)) === 0 && !(await page.eval(`!!document.querySelector('[data-cow-line="${lmain}"] [data-cow-watch], [data-cow-line="${lproj}"] [data-cow-watch]')`)));
  const id = raised[0]?.[1];
  const unsigned = await rpcSoft("signed", { action: "watch_ack", args: { noticeId: id } });
  const forged = await rpcSoft("signed", { action: "watch_ack", args: { noticeId: id }, at: Date.now(), nonce: "x".repeat(20), key: "0000-0000-0000-0000", sig: "AAAA" });
  check("an unsigned or forged acknowledgement is refused, and the notice stays", unsigned.ok === false && forged.ok === false && (await page.eval(`${notices(lrep)}.length`)) === 1, JSON.stringify([unsigned, forged]).slice(0, 200));
  await page.eval(`document.querySelector('[data-cow-watch-notice="${id}"]').click(); true`);
  await page.waitFor(`${notices(lrep)}.length === 0`, { label: "acknowledged", timeout: 20_000 });
  // bb cow status checks every worker again; the same reason is not raised twice.
  await cow("status", "--main", lmain);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  check("acknowledged on the page (signed), it is gone and does not come back for that worker", (await page.eval(`${notices(lrep)}.length`)) === 0 && !(await rpc("watch_read", null)).notices.some((n) => n.threadId === lrep));

  // -- a worker that had a thread of its own, on the page: e and o as for any worker once its threads are archived --
  await waitForThread(lsub, (t) => t.status === "idle", "lsub idle");
  await waitForThread(lkid, (t) => t.status === "idle", "lkid idle");
  const live = await cowAs(lmain, "outcome", lsub, "done");
  check("a worker with a live thread under it is refused an outcome, as a project", live.code !== 0 && /project/.test(live.stdout + live.stderr), (live.stdout + live.stderr).trim());
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const select = async (id) => {
    await page.eval(`${lineEl(id)}.click(); true`);
    await sleep(200);
  };
  const message = () => page.eval(`document.querySelector("[data-cow-message]")?.textContent ?? ""`);
  await page.waitFor(`!!${lineEl(lsub)}`, { label: "the worker with a thread of its own" });
  await select(lsub);
  await page.key("e");
  await page.waitFor(`${mode} === "archive"`, { label: "the archive prompt" });
  check("e on a thread with a live thread under it goes straight to the reason: no outcome is asked", !(await page.eval(`!!document.querySelector("[data-cow-outcome-prompt]")`)));
  await page.key("Escape");
  await page.waitFor(`${mode} === "normal"`, { label: "cancelled" });
  await select(lproj);
  await page.key("e");
  await page.waitFor(`${mode} === "archive"`, { label: "the archive prompt" });
  check("e on a marked project still asks no outcome", !(await page.eval(`!!document.querySelector("[data-cow-outcome-prompt]")`)));
  await page.key("Escape");
  await page.waitFor(`${mode} === "normal"`, { label: "cancelled" });
  check("its thread is archived", (await cowAs(lmain, "archive", lkid, "--reason", "test thread done")).code === 0);
  await sleep(2000);
  await select(lsub);
  await page.key("e");
  await page.waitFor(`!!document.querySelector('[data-cow-outcome-prompt="archive"]')`, { label: "the outcome prompt for a worker whose own thread is archived", timeout: 20_000 });
  check("with every thread under it archived, e on the page asks what it came to, as for any worker", true);
  await page.key("1");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "archive-reason"`, { label: "then the reason" });
  await page.type("merged");
  await page.key("Enter");
  await page.waitFor(`!!${lineEl(lsub)}?.querySelector('[data-cow-outcome="done"]')`, { label: "came to: done", timeout: 30_000 });
  const subRow = await rowOf(lsub);
  check("it is a worker: its outcome from the page, and a ledger row with tool calls and working minutes", subRow?.outcome === "done" && subRow?.judgedBy === "person" && subRow?.toolCalls === 0 && typeof subRow?.workingMinutes === "number", JSON.stringify(subRow && { outcome: subRow.outcome, judgedBy: subRow.judgedBy, toolCalls: subRow.toolCalls, workingMinutes: subRow.workingMinutes }));
  await select(lsub);
  await page.key("o");
  await page.waitFor(`!!document.querySelector('[data-cow-outcome-prompt="change"]')`, { label: "o's prompt on it", timeout: 20_000 });
  check("o on it, under Archived, asks too", true);
  await page.key("Escape");
  await page.waitFor(`${mode} === "normal"`, { label: "cancelled" });
  await select(lproj);
  await page.key("o");
  await sleep(300);
  check("o on a marked project is refused", !(await page.eval(`!!document.querySelector("[data-cow-outcome-prompt]")`)) && (await message()).length > 0, await message());
  await page.key("Escape");
  await waitForThread(lrep, (t) => t.status === "idle", "lrep idle", 240_000);
  check("bb cow archive with an outcome archives the repeating worker", (await cowAs(lmain, "archive", lrep, "--reason", "checked", "--outcome", "done")).code === 0);
  const repRow = await rowOf(lrep);
  check("its row counts its three commands and its minutes", repRow?.toolCalls >= 3 && repRow?.workingMinutes > 0, JSON.stringify(repRow && { toolCalls: repRow.toolCalls, workingMinutes: repRow.workingMinutes }));
}

/** A local day, YYYY-MM-DD, as cow names it. */
const localDay = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Tokens during a turn (0.2.23), on the copy's own settings (put back after):
 * with liveUsage on and a dollars cap of a tenth of a cent for the label of
 * one fixture (and no other worker), a worker whose
 * turn runs four slow commands has its tokens so far rise while the turn
 * runs, the mark (saying the figure is read from Claude Code's transcript)
 * and exactly one notice come while it still runs, and its line shows the
 * running dollars. Once the turn ends, the reading is gone, and the tokens
 * cow keeps for it are bb's figure, not that plus the reading. The copy reads
 * only transcripts of environments in the checks' own folder
 * (copy-for-checks.mjs --live-only-under). One more fixture.
 */
async function liveChecks(page, ids, shot, set) {
  const { lmain } = ids;
  const SLOW = "python3 -c 'import time; time.sleep(15)'";
  const LONG = `You are a test fixture for a bb plugin. Run this shell command four times, one at a time, each as its own separate tool call, waiting for each to finish before the next: ${SLOW}. Run nothing else, and nothing in the background. Then reply with exactly: ok`;
  // The cap is for the fixture's own label only: no other worker on this bb is marked or told, in the copy's queue or anywhere.
  const LABEL = "cow-live-check";
  try {
    const llive = (inUse.llive = ids.llive = await spawn({ prompt: LONG, parent: lmain, permissionMode: "full" }));
    check("its dispatcher labels the fixture", (await cowAs(lmain, "label", llive, LABEL)).code === 0);
    await set("caps", JSON.stringify({ [LABEL]: { dollars: 0.001 } }));
    await set("liveUsage", true);
    const reading = async () => (await rpc("watch_read", null)).live?.[llive] ?? null;
    const statusOf = async () => JSON.parse(await plain("thread", "show", llive, "--json")).status;
    let first = null;
    for (let n = 0; n < 120 && !first?.tokens; n += 1) {
      first = await reading();
      if (!first?.tokens) await sleep(1500);
    }
    check("with liveUsage on, a running worker on Claude Code has tokens so far, read during its turn", first?.tokens > 0 && (await statusOf()) !== "idle", JSON.stringify(first));
    let later = first;
    for (let n = 0; n < 80 && !(later?.tokens > first?.tokens); n += 1) {
      await sleep(1500);
      later = await reading();
    }
    const stillRunning = (await statusOf()) !== "idle";
    check("its tokens so far rise while the turn still runs", later?.tokens > first?.tokens && stillRunning, `${first?.tokens} then ${later?.tokens}, running: ${stillRunning}`);
    await page.waitFor(`!!document.querySelector('.cow-main [data-cow-line="${llive}"] [data-cow-watch~="cap-dollars"]')`, { label: "the dollars mark", timeout: 60_000 });
    const mark = await page.eval(`document.querySelector('.cow-main [data-cow-line="${llive}"] [data-cow-watch]')?.textContent ?? ""`);
    const shown = await page.eval(`document.querySelector('.cow-main [data-cow-line="${llive}"] [data-cow-live-dollars]')?.textContent ?? ""`);
    const notes = await page.eval(`[...document.querySelectorAll('[data-cow-watch-thread="${llive}"][data-cow-watch-reason="cap-dollars"]')].map((el) => el.querySelector("p")?.textContent ?? "")`);
    const runningNow = (await statusOf()) !== "idle";
    check(
      "a dollars cap of $0.001 raises the mark, saying it is read from the transcript, and one notice while the turn still runs; the line shows the running dollars",
      /over cap: \$[0-9.]+ of \$0\.001 \(list price, the running turn read from Claude Code's transcript\)/.test(mark) && notes.length === 1 && /so far/.test(shown) && runningNow,
      `${mark} | ${shown} | ${JSON.stringify(notes)} | running: ${runningNow}`,
    );
    await shot("live-dollars");
    await waitForThread(llive, (t) => t.status === "idle", "llive idle", 300_000);
    await sleep(4000);
    await rpc("watch_read", null);
    const events = JSON.parse(await plain("thread", "log", llive, "--json", "--all"));
    const usage = events.filter((e) => e.type === "thread/tokenUsage/updated").at(-1)?.data?.tokenUsage?.total;
    const bbTotal = usage ? usage.inputTokens + usage.cacheReadInputTokens + usage.cacheWriteInputTokens + usage.outputTokens : null;
    const after = await rpc("watch_read", null);
    const finding = after.marks[llive]?.find((f) => f.reason === "cap-dollars");
    check("once the turn has ended there is no reading, and the dollars are bb's", after.live?.[llive] === undefined && finding?.facts?.source === "bb", JSON.stringify({ live: after.live?.[llive], facts: finding?.facts }));
    await set("liveUsage", false);
    check("bb cow archive with an outcome archives it", (await cowAs(lmain, "archive", llive, "--reason", "checked", "--outcome", "done")).code === 0);
    const row = (await rpc("ledger_read", { days: 14 })).rows.find((r) => r.threadId === llive);
    const kept = row ? row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens : null;
    check("the tokens cow keeps for it equal bb's figure, not bb's figure plus the reading", bbTotal !== null && kept === bbTotal, `kept ${kept}, bb ${bbTotal}, last reading ${later?.tokens}`);
    console.log(`note: live reading ${first?.tokens} then ${later?.tokens} tokens; bb's figure for the turn ${bbTotal}`);
  } finally {
    await set("liveUsage", false).catch(() => undefined);
    await set("caps", "").catch(() => undefined);
  }
}

/**
 * The usage line and the usage notices, on the copy's own settings (put back
 * after): every window bb reports for this machine's signed-in providers, the
 * last 30 days, and a notice raised once by lowering the copy's window percent and
 * budget. Notifications are turned off on the copy first, so the check sends
 * the person none.
 */
async function usageChecks(page, shot) {
  const before = JSON.parse(await plain("plugin", "config", PLUGIN, "--json")).values ?? {};
  const set = async (key, value) => plain("plugin", "config", PLUGIN, ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)]));
  const notices = () => page.eval(`[...document.querySelectorAll("[data-cow-limit-notice]")].map((el) => el.dataset.cowLimitRule + ":" + el.dataset.cowLimitNotice).join(" ")`);
  try {
    await set("usageNotify", false);
    await set("monthlyBudget", "");
    await set("budget30Days", "");
    await set("usageWindowPercent", 100);
    const text = (await cow("usage")).stdout;
    // The account bb signs in with is never in it: cow does not read it.
    console.log(`note: bb ${PLUGIN} usage:\n${text}`);
    const json = JSON.parse((await cow("usage", "--json")).stdout);
    const providers = JSON.parse(await plain("settings", "usage", "--json"));
    const signedIn = Object.entries(providers).filter(([, entry]) => entry.status === "ok" && (entry.windows ?? []).length > 0).map(([id]) => id);
    const left = Object.entries(providers).filter(([, entry]) => entry.status !== "ok").map(([id]) => id);
    const expected = Object.entries(providers).flatMap(([id, entry]) => (entry.status === "ok" ? (entry.windows ?? []).map((w) => `${id}:${w.label}:${w.usedPercent}`) : []));
    check(
      "bb cow usage --json gives every window of every signed-in provider, with percent and reset time, and none of a provider not signed in",
      json.ok === true && JSON.stringify(json.windows.map((w) => `${w.provider}:${w.label}:${w.usedPercent}`)) === JSON.stringify(expected) && json.windows.every((w) => w.resetsAt === null || !Number.isNaN(Date.parse(w.resetsAt))) && json.windows.every((w) => !left.includes(w.provider)),
      `${json.windows?.length} windows of ${signedIn.join(", ") || "none"}; left out: ${left.join(", ")}`,
    );
    const firstLine = text.split("\n")[0] ?? "";
    check(
      "bb cow usage's line gives each window as its label, percent and reset, then the last 30 days' list-price dollars, and nothing of a budget, a pace or a month with none set",
      json.windows.every((w) => firstLine.includes(`${w.label} ${Math.round(w.usedPercent)}%`)) && /last 30 days \$[0-9.,]+ at list price$/.test(firstLine) && !/budget|pace|so far/i.test(firstLine) && !/pace/i.test(text) && !/@/.test(text),
      firstLine,
    );
    await page.waitFor(`document.querySelector("[data-cow-usage]")?.dataset.cowUsage === "read"`, { label: "the usage line", timeout: 180_000 });
    const pageLine = await page.eval(`document.querySelector("[data-cow-usage]").textContent`);
    // Read a moment apart: the minutes to a reset and the cents of the total can move between the two.
    const unreset = (line) => line.replace(/resets in [^)]*\)/g, "resets").replace(/\$[0-9.,]+/g, "$");
    check("the page's line reads as bb cow usage's first line", unreset(pageLine) === unreset(firstLine), `${pageLine} | ${firstLine}`);
    console.log(`note: the page's usage line: ${pageLine}`);
    const pageWindows = await page.eval(`document.querySelectorAll("[data-cow-usage-window]").length`);
    check(
      "the page's usage line shows the same windows, and the last 30 days with no budget",
      pageWindows === json.windows.length && json.windows.every((w) => pageLine.includes(`${w.label} ${Math.round(w.usedPercent)}%`)) && (await page.eval(`document.querySelector("[data-cow-usage-total]")?.dataset.cowUsageBudget`)) === "" && !/budget|pace|so far/.test(pageLine),
      pageLine,
    );
    const ack = async (id) => page.eval(`document.querySelector('[data-cow-limit-notice="${id}"]').click(); true`);
    if (json.windows.length > 0) {
      // A percent every window has reached: one notice per window, raised by the server's check when the setting changes.
      const lowest = Math.max(1, Math.floor(Math.min(...json.windows.map((w) => w.usedPercent))));
      await set("usageWindowPercent", lowest);
      await page.waitFor(`document.querySelectorAll('[data-cow-limit-rule="window"]').length > 0`, { label: "a usage notice", timeout: 180_000 });
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const raised = (await notices()).split(" ").filter(Boolean);
      const live = json.windows.filter((w) => w.resetsAt === null || Date.parse(w.resetsAt) > Date.now()).length;
      check("a window at its percent puts exactly one notice per window in the queue", raised.length === live, raised.join(" "));
      await shot("usage-notice");
      const id = raised[0].split(":")[1];
      const unsigned = await rpcSoft("signed", { action: "limit_ack", args: { noticeId: id } });
      const forged = await rpcSoft("signed", { action: "limit_ack", args: { noticeId: id }, at: Date.now(), nonce: "x".repeat(20), key: "0000-0000-0000-0000", sig: "AAAA" });
      check("an unsigned or forged acknowledgement is refused, and the notice stays", unsigned.ok === false && forged.ok === false && (await notices()).includes(id), JSON.stringify([unsigned, forged]).slice(0, 200));
      for (const entry of raised) await ack(entry.split(":")[1]);
      await page.waitFor(`document.querySelectorAll("[data-cow-limit-notice]").length === 0`, { label: "acknowledged", timeout: 20_000 });
      // The setting changed again: the server checks again, and the same period raises nothing.
      await set("usageWindowPercent", lowest === 1 ? 2 : lowest - 1);
      await new Promise((resolve) => setTimeout(resolve, 8000));
      const after = JSON.parse((await cow("usage", "--json")).stdout);
      check("acknowledged on the page (signed), the notices are gone and the same period raises none again", (await notices()) === "" && after.notices.length === 0, await notices());
    } else check("no signed-in provider reports a window here: the window notice is not checked", true);
    // A budget the last 30 days are already over: both marks, 80% and the budget, once each.
    await set("usageWindowPercent", 100);
    await set("budget30Days", "0.01");
    await page.waitFor(`document.querySelectorAll('[data-cow-limit-rule="budget"]').length === 1`, { label: "the budget notices", timeout: 180_000 });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const budgetNotices = (await notices()).split(" ").filter((entry) => !entry.startsWith("window:")).filter(Boolean);
    const withBudget = await page.eval(`document.querySelector("[data-cow-usage-total]").textContent`);
    const budgetText = (await cow("usage")).stdout;
    console.log(`note: bb ${PLUGIN} usage with a budget:\n${budgetText}`);
    check(
      "with budget30Days set the line shows it beside the last 30 days, no pace, and the 80% and budget marks raise one notice each",
      /last 30 days \$[0-9.,]+ at list price of \$0\.010? budget$/.test(withBudget) && !/pace|so far/.test(withBudget) && budgetNotices.map((entry) => entry.split(":")[0]).sort().join(" ") === "budget spent" && !/pace|so far/i.test(budgetText.split("\n")[0]),
      `${withBudget} · ${budgetNotices.join(" ")}`,
    );
    for (const entry of budgetNotices) await ack(entry.split(":")[1]);
    // The renamed setting alone is read as the budget; budget30Days wins when both are set.
    await set("budget30Days", "");
    await set("monthlyBudget", "0.02");
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const alone = JSON.parse((await cow("usage", "--json")).stdout);
    await set("budget30Days", "0.03");
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const both = JSON.parse((await cow("usage", "--json")).stdout);
    check("monthlyBudget alone is read as the budget for 30 days; with both set, budget30Days counts", alone.total?.budget === 0.02 && both.total?.budget === 0.03, `${alone.total?.budget} ${both.total?.budget}`);
    check("the budget marks do not raise again while the total stays above them", (await notices()) === "", await notices());
  } finally {
    for (const key of ["usageNotify", "monthlyBudget", "budget30Days", "usageWindowPercent"]) await set(key, before[key]);
  }
}

// ---- The context card ------------------------------------------------------------

/** The card for a thread: above the legend, its sections from bb, the test plugin's `cow_card`, and none for a thread with nothing. */
async function cardChecks(page, ids, shot, chooseMain) {
  const { kmain, kone, ktwo, knone } = ids;
  for (const name of CARDED) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  // The test plugin's badge that always throws is meant to: bb logs it.
  EXPECTED_ERRORS.push(/always throws/, /The above error occurred/);
  await installBadgePlugin();
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.eval(`sessionStorage.removeItem("cow:card-hidden"); sessionStorage.removeItem("cow:folds"); true`);
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page", timeout: 60_000 });
  await chooseMain(page, kmain);
  await page.send("Page.bringToFront");
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const card = `document.querySelector(".cow-side [data-cow-ctx]")`;
  const ours = `${card}?.querySelector('[data-cow-ctx-source="${BADGE_PLUGIN}"]')`;
  const section = (title) => `${ours}?.querySelector('[data-cow-ctx-section="${title}"]')`;
  const tail = (id) => id.slice(-4);

  // -- the card of a fixture's line, above the legend --
  await page.eval(`${lineEl(kone)}.click(); true`);
  await page.waitFor(`${card}?.dataset.cowCtx === "${kone}" && !!${ours}`, { label: "the card of the fixture's line", timeout: 20_000 });
  await shot("card-side");
  check("the selected line's card shows at the bottom of the right column, just above the legend", await page.eval(`${card}.nextElementSibling?.classList.contains("cow-legend") === true`));
  check(
    "the test plugin's stack: three rows, the middle one this thread's, marked current",
    await page.eval(`(() => {
      const rows = [...${section("Check stack")}.querySelectorAll("[data-cow-ctx-row]")];
      const current = rows.filter((row) => row.hasAttribute("data-cow-ctx-current"));
      return rows.length === 3 && current.length === 1 && current[0] === rows[1] && current[0].textContent.includes("${tail(kone)}");
    })()`),
  );
  check(
    "each stack row has its two badges, in the theme's state colours",
    await page.eval(`(() => {
      const rows = [...${section("Check stack")}.querySelectorAll("[data-cow-ctx-row]")];
      const tones = rows.map((row) => [...row.querySelectorAll("[data-cow-ctx-badge]")].map((badge) => badge.dataset.cowCtxBadge).join(","));
      const colours = new Set([...${section("Check stack")}.querySelectorAll("[data-cow-ctx-badge]")].map((badge) => getComputedStyle(badge).color));
      return tones.join(" ") === "ok,ok info,warn muted,bad" && colours.size >= 4;
    })()`),
  );
  check("the current row stands out", await page.eval(`(() => { const row = ${section("Check stack")}.querySelector("[data-cow-ctx-current]"); const other = ${section("Check stack")}.querySelector("[data-cow-ctx-row]:not([data-cow-ctx-current])"); return getComputedStyle(row).backgroundColor !== getComputedStyle(other).backgroundColor; })()`));
  check("sections are shown under the plugin's name", await page.eval(`${section("Check stack")}.querySelector(".cow-ctx-from")?.textContent.length > 0`));
  check("the row with a link keeps its https link and takes a hint", await page.eval(`(() => { const row = ${section("Check extras")}.querySelector('[data-cow-ctx-url="https://example.com/cow-check"]'); return !!row && row.hasAttribute("data-cow-hint"); })()`));
  check(
    "the oversized row is cut: its text, its detail and its badges are capped",
    await page.eval(`(() => {
      const row = [...${section("Check extras")}.querySelectorAll("[data-cow-ctx-row]")].find((el) => el.dataset.cowCtxRow.startsWith("check oversized"));
      return !!row && [...row.dataset.cowCtxRow].length <= 160 && row.dataset.cowCtxRow.endsWith("…") && row.querySelectorAll("[data-cow-ctx-badge]").length === 4;
    })()`),
  );
  check("the malformed row is dropped, and its javascript: link with it", await page.eval(`${section("Check extras")}.querySelectorAll("[data-cow-ctx-row]").length === 2 && !document.querySelector('[data-cow-ctx-url^="javascript"]')`));
  check(
    "every row is one line, cut with an ellipsis, never wrapping",
    await page.eval(`[...${card}.querySelectorAll("[data-cow-ctx-row]")].every((row) => getComputedStyle(row).whiteSpace === "nowrap" && row.getBoundingClientRect().height <= 22)`),
  );
  check("the card's height is bounded, and it scrolls inside itself", await page.eval(`(() => { const style = getComputedStyle(${card}); return style.overflowY === "auto" && style.maxHeight !== "none"; })()`));
  await page.key("f");
  await page.waitFor(`!!document.querySelector("[data-cow-hints]")`, { label: "hints" });
  check("f hints the card's link", await page.eval(`[...document.querySelectorAll("[data-cow-hints] [data-cow-hint-label]")].length >= ${card}.querySelectorAll("[data-cow-hint]").length && ${card}.querySelectorAll("[data-cow-hint]").length >= 1`));
  await page.key("Escape");
  await sleep(200);

  // -- moving the cursor: never another thread's card --
  const seen = [];
  await page.key("j");
  for (let n = 0; n < 15; n += 1) {
    seen.push(await page.eval(`(${card}?.dataset.cowCtx ?? "") + "|" + (document.querySelector(".cow-main .cow-cur")?.dataset.cowLine ?? "")`));
    await sleep(60);
  }
  await page.waitFor(`${card}?.dataset.cowCtx === "${ktwo}"`, { label: "the next line's card", timeout: 20_000 });
  check("j moves to the next line, past the card: the card is not a stop", await page.eval(`${lineEl(ktwo)}.classList.contains("cow-cur")`));
  check("moving the cursor changes the card to that line's", await page.eval(`${section("Check stack")}?.querySelector("[data-cow-ctx-current]")?.textContent.includes("${tail(ktwo)}") === true`));
  check("while it loads, no line shows another thread's card", seen.every((entry) => { const [shown, cur] = entry.split("|"); return shown === "" || shown === cur; }), seen.filter((entry) => { const [shown, cur] = entry.split("|"); return shown !== "" && shown !== cur; }).join(" "));
  await page.key("k");
  await page.waitFor(`${card}?.dataset.cowCtx === "${kone}"`, { label: "the card again", timeout: 5000 });
  check("going back shows the card kept for that line at once", true);

  // -- a thread with nothing has no card --
  await page.eval(`document.querySelector('[data-cow-section="section:outside"]').click(); true`);
  await page.key("l");
  await page.waitFor(`!!document.querySelector('[data-cow-outside-line="${knone}"]')`, { label: "the line outside Main", timeout: 10_000 });
  await page.eval(`document.querySelector('[data-cow-outside-line="${knone}"]').click(); true`);
  await sleep(3000);
  check("a thread whose card would be empty shows no card: no box, no heading", !(await page.eval(`!!document.querySelector("[data-cow-ctx]")`)) && (await page.eval(`document.querySelector('[data-cow-outside-line="${knone}"]').classList.contains("cow-cur")`)));

  // -- the chat pane --
  await page.eval(`${lineEl(kone)}.click(); true`);
  await page.key("Enter");
  const paneCard = `document.querySelector('[data-cow-pane] [data-cow-ctx]')`;
  await page.waitFor(`${paneCard}?.dataset.cowCtx === "${kone}"`, { label: "the card in the pane", timeout: 20_000 });
  await shot("card-pane");
  check("with the chat open, the same card shows in the pane, above the conversation", await page.eval(`${paneCard}.nextElementSibling?.hasAttribute("data-cow-chat") === true`));
  check("it is folded there to its section titles", await page.eval(`${paneCard}.querySelectorAll('[data-cow-ctx-section][data-cow-ctx-folded]').length >= 2 && ${paneCard}.querySelectorAll("[data-cow-ctx-row]").length === 0`));
  await page.eval(`${paneCard}.querySelector('[data-cow-ctx-section="Check stack"] h4').click(); true`);
  await sleep(200);
  check("a click on a title unfolds that section", await page.eval(`${paneCard}.querySelectorAll('[data-cow-ctx-section="Check stack"] [data-cow-ctx-row]').length === 3`));
  await page.key("Escape");
  await page.waitFor(`!document.querySelector("[data-cow-pane]")`, { label: "the pane closed" });

  // -- v hides it, and the window remembers --
  await page.waitFor(`${card}?.dataset.cowCtx === "${kone}"`, { label: "the card after the pane", timeout: 5000 });
  await page.key("v");
  await sleep(300);
  check("v hides the card", !(await page.eval(`!!document.querySelector("[data-cow-ctx]")`)));
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`${screen} === "overview" && !!${lineEl(kone)}`, { label: "the page after a reload", timeout: 60_000 });
  await page.send("Page.bringToFront");
  await page.eval(`${lineEl(kone)}.click(); true`);
  await sleep(2000);
  check("after a reload the window still hides it", !(await page.eval(`!!document.querySelector("[data-cow-ctx]")`)));
  await page.key("v");
  await page.waitFor(`${card}?.dataset.cowCtx === "${kone}"`, { label: "the card shown again", timeout: 20_000 });
  check("v shows it again", true);

  // -- without the test plugin --
  await removeBadgePlugin();
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`${screen} === "overview" && !!${lineEl(kone)}`, { label: "the page without the test plugin", timeout: 60_000 });
  await page.send("Page.bringToFront");
  await page.eval(`${lineEl(kone)}.click(); true`);
  await sleep(4000);
  check(
    "with the test plugin removed, only bb's own sections remain, or nothing",
    await page.eval(`[...document.querySelectorAll("[data-cow-ctx-source]")].every((el) => el.dataset.cowCtxSource === "bb")`),
    await page.eval(`[...document.querySelectorAll("[data-cow-ctx-source]")].map((el) => el.dataset.cowCtxSource).join(",") || "no card"`),
  );
  await page.eval(`sessionStorage.removeItem("cow:card-hidden"); true`);
}

/** The folder the thread with nothing was made in, and the environment bb made for it; and the folders of the asks and briefs fixtures and theirs. */
async function removeCardFolder(ids) {
  const environments = new Set();
  for (const name of ["knone", ...(raisedFolder || diffFolder ? ["amain", "asker", "briefer", "bdiff"] : [])]) {
    if (!ids?.[name]) continue;
    const [thread] = await api(`/threads?threadIds=${ids[name]}&limit=1`).catch(() => []);
    if (thread?.environmentId) environments.add(thread.environmentId);
  }
  for (const id of environments) await bb("environment", "delete", id).catch((cause) => console.error(`could not delete the environment ${id}`, cause.stderr ?? cause));
  for (const folder of [cardFolder, raisedFolder, diffFolder]) if (folder) rmSync(folder, { recursive: true, force: true });
  cardFolder = null;
  raisedFolder = null;
  diffFolder = null;
}

// ---- Other plugins' badges and actions ---------------------------------------

const BADGE_PLUGIN = "cow-check-badge";
/** Console errors a check means to cause. */
const EXPECTED_ERRORS = [];
/** The fixtures the test plugin wrote to: their metadata is cleared when it goes. */
const badgeWrote = new Set();
let badgeInstalled = false;
/** The folder the test plugin was installed from. */
let badgeCopy = null;

async function badgeMetadata(id) {
  return api(`/threads/${id}/plugin-metadata?pluginId=${BADGE_PLUGIN}`);
}
async function clearBadgeMetadata(id) {
  const keys = Object.keys(await badgeMetadata(id));
  if (keys.length === 0) return;
  const response = await fetch(`${BB}/api/v1/threads/${id}/plugin-metadata?pluginId=${BADGE_PLUGIN}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pluginId: BADGE_PLUGIN, remove: keys }),
  });
  if (!response.ok) throw new Error(`clearing ${BADGE_PLUGIN}'s metadata on ${id}: HTTP ${response.status}`);
}
async function installBadgePlugin() {
  // Installed from a copy, so nothing bb builds lands in this checkout.
  badgeCopy = mkdtempSync(join(tmpdir(), `${BADGE_PLUGIN}-`));
  cpSync(join(dirname(new URL(import.meta.url).pathname), BADGE_PLUGIN), badgeCopy, { recursive: true });
  badgeInstalled = true;
  await run("bb", ["plugin", "install", badgeCopy, "--yes"]);
}
/** Remove the test plugin and what it wrote. Safe to call when it is not installed. */
async function removeBadgePlugin() {
  for (const id of badgeWrote) await clearBadgeMetadata(id).catch((cause) => console.error(`could not clear ${BADGE_PLUGIN}'s metadata on ${id}`, cause));
  badgeWrote.clear();
  if (!badgeInstalled) return;
  badgeInstalled = false;
  await run("bb", ["plugin", "remove", BADGE_PLUGIN]);
  if (badgeCopy) rmSync(badgeCopy, { recursive: true, force: true });
  badgeCopy = null;
  console.log(`removed the test plugin ${BADGE_PLUGIN}`);
}

/** Badges at the end of a line, `.` and its menu, and the page with the test plugin gone. */
async function pluginChecks(page, ids, shot, chooseMain) {
  const { bmain, bkid } = ids;
  for (const name of PLUGGED) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  badgeWrote.add(bkid);
  badgeWrote.add(bmain);
  for (const id of badgeWrote) await clearBadgeMetadata(id);
  EXPECTED_ERRORS.push(/always throws/, /The above error occurred/);
  await installBadgePlugin();
  // The page loads the plugins bb runs when it opens: open it again with the test plugin in.
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page", timeout: 60_000 });
  await chooseMain(page, bmain);
  await page.send("Page.bringToFront");
  const lineEl = `document.querySelector('.cow-main [data-cow-line="${bkid}"]')`;
  const message = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const menu = `document.querySelector("[data-cow-more]")`;
  const row = (key) => `document.querySelector('[data-cow-more-action="${BADGE_PLUGIN}/${key}"]')`;
  const pickOf = async (key) => page.eval(`${row(key)}?.querySelector("kbd")?.textContent ?? ""`);
  const rowHeight = await page.eval(`parseFloat(getComputedStyle(${ROOT}).getPropertyValue("--cow-rh")) || 17`);

  // -- the badge --
  await page.waitFor(`!!${lineEl}?.querySelector("[data-cow-check-badge]")`, { label: "the test badge on the fixture's line", timeout: 30_000 });
  check("another plugin's badge shows at the end of the fixture's line", await page.eval(`${lineEl}.querySelector(".cow-nx [data-cow-badges] [data-cow-check-badge]")?.textContent.includes("check badge") ?? false`));
  const fits = async () =>
    page.eval(`(() => {
      const line = ${lineEl}.getBoundingClientRect();
      const column = ${lineEl}.querySelector(".cow-nx").getBoundingClientRect();
      return Math.round(line.height) === ${rowHeight} && column.right <= line.right + 0.5 && getComputedStyle(${lineEl}.querySelector(".cow-nx")).whiteSpace === "nowrap";
    })()`);
  check("the line with a badge is still one line, the badge inside its last column", await fits());
  const columnsBefore = await page.eval(`[...${lineEl}.children].map((child) => Math.round(child.getBoundingClientRect().width)).join(",")`);
  await page.resize(1000, 900);
  await sleep(400);
  check("narrower, the line is still one line", await fits());
  await page.resize(1440, 900);
  await sleep(400);
  check(
    "a badge takes the plugin's other badge's place only: the one that throws is gone, the line and the page stay",
    (await page.eval(`${lineEl}.querySelectorAll('[data-bb-plugin="${BADGE_PLUGIN}"]').length`)) === 1 && (await page.eval(screen)) === "overview",
  );
  check("a badge is not a hint target: it is not a link", !(await page.eval(`!!${lineEl}.querySelector("[data-cow-badges] a[href], [data-cow-badges] [role=link]")`)));
  const stateBefore = await page.eval(`${lineEl}.dataset.cowState`);
  await shot("plugins-badge");

  // -- . and its menu --
  await page.eval(`${lineEl}.click(); true`);
  await page.waitFor(`!!document.querySelector('[data-cow-verb="more"]')`, { label: "the verb bar's . more" });
  check("the verb bar shows . more on a line with other plugins' actions", true);
  await page.key(".");
  await page.waitFor(`!!${menu}`, { label: "the menu" });
  await shot("plugins-menu");
  check("pressing . opens the menu under the line", await page.eval(`${menu}.dataset.cowMore === "${bkid}" && ${lineEl}.nextElementSibling === ${menu}`));
  const keys = await page.eval(`[...${menu}.querySelectorAll("[data-cow-more-action]")].map((el) => el.dataset.cowMoreAction).filter((key) => key.startsWith("${BADGE_PLUGIN}/")).join(" ")`);
  check("it lists the test plugin's actions in its order", keys === `${BADGE_PLUGIN}/plain ${BADGE_PLUGIN}/disabled ${BADGE_PLUGIN}/choose`, keys);
  check("bb's own actions are not in it", !(await page.eval(`[...${menu}.querySelectorAll("[data-cow-more-action]")].some((el) => el.dataset.cowMoreAction.startsWith("bb--core/"))`)));
  check("each row has a key, a label and its detail", (await pickOf("plain")) !== "" && (await page.eval(`${row("plain")}.textContent.includes("Check: mark") && ${row("plain")}.textContent.includes("writes the check's metadata")`)));
  check("the disabled action is dimmed and takes no hint", await page.eval(`${row("disabled")}.classList.contains("cow-off") && !${row("disabled")}.hasAttribute("data-cow-hint")`));
  check("the line is in the state it was: a badge or a menu changes nothing", (await page.eval(`${lineEl}.dataset.cowState`)) === stateBefore);

  // f hints the menu's rows, and nothing else.
  await page.key("f");
  await page.waitFor(`!!document.querySelector("[data-cow-hints]")`, { label: "hints" });
  const enabled = await page.eval(`${menu}.querySelectorAll("[data-cow-hint]").length`);
  const labels = await page.eval(`document.querySelectorAll("[data-cow-hints] [data-cow-hint-label]").length`);
  check("f hints the menu's rows while it is open, and only them", labels === enabled && enabled >= 2, `${labels} hints, ${enabled} rows`);
  await page.key("Escape");
  await sleep(200);

  await page.key(await pickOf("disabled"));
  await sleep(1500);
  check("the disabled action cannot be picked: the menu stays, the message says why", (await page.eval(`!!${menu}`)) && (await page.eval(message)).includes("not available"));
  check("and its plugin's code did not run", (await badgeMetadata(bkid)).disabledRan === undefined);

  await page.key(await pickOf("choose"));
  await page.waitFor(`!!${menu}?.querySelector("[data-cow-more-choice]")`, { label: "the choices" });
  check("an action with choices shows them as a second step", (await page.eval(`[...${menu}.querySelectorAll("[data-cow-more-choice]")].map((el) => el.dataset.cowMoreChoice).join(" ")`)) === "red blue grey");
  check("a disabled choice is dimmed", await page.eval(`${menu}.querySelector('[data-cow-more-choice="grey"]').classList.contains("cow-off")`));
  await page.key("Escape");
  await sleep(200);
  check("Esc on the choices goes back to the list", await page.eval(`!!${row("plain")}`));
  await page.key(await pickOf("choose"));
  await page.waitFor(`!!${menu}?.querySelector("[data-cow-more-choice]")`, { label: "the choices again" });
  await page.key("2");
  await waitUntil(async () => (await badgeMetadata(bkid)).chose === "blue", "the choice to run");
  check("picking a choice runs the action in its plugin with that choice", true);
  await page.waitFor(`${message}.includes("ran")`, { label: "the message" });
  check("the message line says the plugin ran it", (await page.eval(message)).includes(`${BADGE_PLUGIN} ran “Check: choose”: blue`), await page.eval(message));

  await page.key(".");
  await page.waitFor(`!!${menu}`, { label: "the menu again" });
  await page.key(await pickOf("plain"));
  await waitUntil(async () => typeof (await badgeMetadata(bkid)).marked === "number", "the plain action to run");
  check("picking the plain action runs it in its plugin: it wrote its own metadata", true);
  check("and the menu closes", !(await page.eval(`!!${menu}`)));
  await page.key(".");
  await page.waitFor(`!!${menu}`, { label: "the menu once more" });
  await page.key("Escape");
  await sleep(200);
  check("Esc closes the menu", !(await page.eval(`!!${menu}`)) && (await page.eval(`${ROOT}.dataset.cowMode`)) === "normal");
  await page.eval(`document.querySelector('[data-cow-section="settle"], [data-cow-section]')?.click(); true`);
  await sleep(200);
  await page.key(".");
  await sleep(200);
  check(". on a line that is not a thread opens nothing and says so", !(await page.eval(`!!${menu}`)) && (await page.eval(message)).includes("select a thread"));

  // -- without the test plugin --
  await removeBadgePlugin();
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`${screen} === "overview" && !!${lineEl}`, { label: "the page again", timeout: 60_000 });
  await sleep(2000);
  check("with the test plugin removed, no badge of its shows", !(await page.eval(`!!document.querySelector("[data-cow-check-badge]")`)));
  check(
    "and no line draws an empty badge space",
    await page.eval(`[...document.querySelectorAll(".cow-main [data-cow-badges]")].every((el) => getComputedStyle(el).display === "none")`),
  );
  check(
    "and the fixture's line has the columns it had",
    (await page.eval(`[...${lineEl}.children].map((child) => Math.round(child.getBoundingClientRect().width)).join(",")`)) === columnsBefore,
  );
  await page.eval(`${lineEl}.click(); true`);
  await sleep(500);
  await page.key(".");
  await sleep(300);
  check("and . lists none of its actions", !(await page.eval(`!!document.querySelector('[data-cow-more-action^="${BADGE_PLUGIN}/"]')`)));
  await page.key("Escape");
  await shot("plugins-gone");
}

async function waitUntil(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---- Outside Main, and bringing a thread under Main ------------------------

/** The fixtures as a run starts: the two outside threads with no parent, the kid under its head. Only these are moved. */
async function prepareOutside(ids) {
  for (const name of OUTSIDE) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  for (const name of ["ostray", "ohead"]) {
    const [thread] = await api(`/threads?threadIds=${ids[name]}&limit=1`);
    // A run that stopped half way may have left one archived.
    if (thread.archivedAt) await bb("thread", "unarchive", ids[name]);
    if (thread.parentThreadId !== null) await bb("thread", "update", ids[name], "--clear-parent-thread");
  }
  const [kid] = await api(`/threads?threadIds=${ids.okid}&limit=1`);
  if (kid.archivedAt) await bb("thread", "unarchive", ids.okid);
  if (kid.parentThreadId !== ids.ohead) await bb("thread", "update", ids.okid, "--parent-thread", ids.ohead);
  await signer.must("seen_set", { threadId: ids.ostray, seen: null });
}

/** Outside Main: the section, its fold, the filter, A and u, a refusal, and bb cow status. */
/** Delete the automations this run made, and only those. */
async function removeAutomations() {
  let deleted = 0;
  const made = madeAutomations.splice(0);
  for (const id of made) {
    try {
      await bb("automation", "delete", id, "--project", PROJECT, "--yes");
      deleted += 1;
    } catch (cause) {
      console.error(`could not delete the automation ${id}`, cause);
    }
  }
  if (made.length > 0) console.log(`deleted ${deleted} of ${made.length} automations this run made`);
}

async function automationChecks(page, ids, shot, chooseMain) {
  const { umain } = ids;
  const NAME = "cow test automation";
  const make = async (name, args) => {
    const made = await bb("automation", "create", "--project", PROJECT, "--name", `${NAME}: ${name}`, "--cron", "0 3 * * *", "--timezone", "UTC", ...args);
    const id = made?.automation?.id ?? made?.id;
    if (typeof id !== "string") throw new Error(`bb made an automation but did not say its id: ${JSON.stringify(made).slice(0, 300)}`);
    madeAutomations.push(id);
    return id;
  };
  let script, quiet, asks;
  try {
    script = await make("script", ["--script", "echo cow test automation ran; exit 3", "--interpreter", "sh"]);
    quiet = await make("agent", ["--prompt", QUIET, "--provider", "claude-code", "--model", MODEL]);
    asks = await make("asks", ["--prompt", ASKS, "--provider", "claude-code", "--model", MODEL]);
  } catch (cause) {
    check("bb lets the check make an automation of its own", false, String(cause).slice(0, 300));
    return;
  }
  check("bb lets the check make an automation of its own", true);
  for (const id of [script, quiet, asks]) await bb("automation", "run", id, "--project", PROJECT);
  /** The newest run of an automation, once `ready` holds for it. */
  const runOf = async (id, ready, label) => {
    const deadline = Date.now() + 180_000;
    for (;;) {
      const answer = await bb("automation", "runs", id, "--project", PROJECT, "--limit", "5");
      const runs = answer?.runs ?? answer ?? [];
      const latest = runs[0];
      if (latest && ready(latest)) return latest;
      if (Date.now() > deadline) throw new Error(`the automation ${id} never ran: ${label}`);
      await sleep(1000);
    }
  };
  await runOf(script, (r) => r.status === "failed" || r.status === "succeeded", "the script finished");
  const quietRun = (await runOf(quiet, (r) => typeof r.threadId === "string", "a run thread")).threadId;
  const askRun = (await runOf(asks, (r) => typeof r.threadId === "string", "a run thread")).threadId;
  // The run threads are fixtures too: archived when the run finishes, or fails.
  ids.urunQuiet = inUse.urunQuiet = quietRun;
  ids.urunAsks = inUse.urunAsks = askRun;
  await waitForThread(quietRun, (t) => t.status === "idle", "idle");
  await waitForThread(askRun, (t) => t.hasPendingInteraction, "asking");
  check("an agent automation's run is a thread bb says the automations plugin started", (await api(`/threads?threadIds=${quietRun}&limit=1`))[0]?.originPluginId === "automations");

  await page.eval(`sessionStorage.removeItem("cow:folds"); true`);
  await chooseMain(page, umain);
  await page.send("Page.bringToFront");
  const heading = `document.querySelector('[data-cow-section="section:automations"]')`;
  const row = (id) => `document.querySelector('[data-cow-automation="${id}"]')`;
  const runLine = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const isCur = (expr) => `(${expr}?.classList.contains("cow-cur") === true)`;

  // -- the section: after Archived and before Outside Main, folded, counted, plain --
  await page.waitFor(`!!${heading} && Number(${heading}.querySelector("[data-cow-section-count]").dataset.cowSectionCount) >= 3`, { label: "the Automations heading, counting ours", timeout: 30_000 });
  check(
    "Automations is a section before Outside Main, folded by default, with its count, and its heading is plain",
    (await page.eval(`${heading}.dataset.cowSectionFolded === ""`)) &&
      !(await page.eval(`!!${row(script)}`)) &&
      (await page.eval(`!${heading}.querySelector("[data-cow-heat]")`)) &&
      (await page.eval(`(() => { const outside = document.querySelector('[data-cow-section="section:outside"]'); return !!(${heading}.compareDocumentPosition(outside) & Node.DOCUMENT_POSITION_FOLLOWING); })()`)),
  );
  // -- a run that asks is in the queue like any thread --
  await page.waitFor(`!!document.querySelector('[data-cow-queue="${askRun}"]')`, { label: "the asking run in the queue", timeout: 30_000 });
  check("a run that asks the person is in the queue", true);
  check("a run that finished is not in the queue, nor under To settle", !(await page.eval(`!!document.querySelector('[data-cow-queue="${quietRun}"], [data-cow-settle][data-cow-line="${quietRun}"]')`)));

  // -- / finds them while folded --
  await page.key("/");
  await page.waitFor(`document.activeElement?.dataset.cowFilter === ""`, { label: "the filter" });
  await page.type(NAME);
  await page.waitFor(`!!${row(script)} && !!${row(quiet)}`, { label: "automations found while folded", timeout: 10_000 });
  check("/ finds automations while the section is folded", true);
  await page.key("Escape");
  await page.waitFor(`!${row(script)}`, { label: "the filter closed" });

  // -- unfolded: one row per automation --
  await page.eval(`${heading}.click(); true`);
  await sleep(200);
  await page.key("l");
  await page.waitFor(`!!${row(script)}`, { label: "unfolded", timeout: 10_000 });
  const scriptResult = await page.eval(`${row(script)}.querySelector("[data-cow-last-result]").textContent`);
  check(
    "a script automation's row: its next run in words, and its failed last run in the failed colour on the result only",
    (await page.eval(`${row(script)}.dataset.cowLast`)) === "failed" &&
      /^failed /.test(scriptResult) &&
      (await page.eval(`${row(script)}.querySelector("[data-cow-last-result]").classList.contains("cow-s-failed")`)) &&
      /^(in \d+[mh]|today \d\d:\d\d|tomorrow \d\d:\d\d)$/.test(await page.eval(`${row(script)}.querySelector("[data-cow-next-run]").textContent`)),
    scriptResult,
  );
  check("an agent automation's row says its last run is done", (await page.eval(`${row(quiet)}.dataset.cowLast`)) === "done", await page.eval(`${row(quiet)}.querySelector("[data-cow-last-result]").textContent`));
  await shot("automations");

  // -- Enter on a script's row shows what it printed --
  await page.eval(`${row(script)}.click(); true`);
  await sleep(200);
  check("an automation's row takes the cursor", await page.eval(isCur(row(script))));
  await page.key("Enter");
  await page.waitFor(`(document.querySelector("[data-cow-reader]")?.textContent ?? "").includes("cow test automation ran")`, { label: "the script's output in the reader", timeout: 10_000 });
  check("Enter on a script automation shows its last run's output in the reader", true);
  await page.key("q");
  await page.waitFor(`!document.querySelector("[data-cow-reader]")`, { label: "the reader closed" });

  // -- the runs fold under their automation --
  await page.eval(`${row(quiet)}.click(); true`);
  await sleep(200);
  check("an automation's runs are folded under it", !(await page.eval(`!!${runLine(quietRun)}`)));
  await page.key("l");
  await page.waitFor(`!!${runLine(quietRun)}`, { label: "its run", timeout: 10_000 });
  check(
    "l shows its run thread as a cow line, plain",
    (await page.eval(`${runLine(quietRun)}.dataset.cowRun`)) === `automation:${quiet}` && (await page.eval(`${runLine(quietRun)}.classList.contains("cow-run")`)),
  );
  await page.key("l");
  await sleep(200);
  check("l again steps onto the newest run", await page.eval(isCur(runLine(quietRun))));
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${quietRun}"`, { label: "its chat" });
  check("Enter on a run opens its chat in the pane", true);
  for (let i = 0; i < 3 && (await page.eval(`!!document.querySelector("[data-cow-pane]")`)); i += 1) {
    await page.key("Escape");
    await sleep(200);
  }
  await page.key("p");
  await sleep(300);
  check("a run is not parked", !(await page.eval(`${runLine(quietRun)}?.dataset.cowState === "parked"`)));

  // -- bb cow status --
  const status = JSON.parse((await cow("status", "--main", umain, "--json")).stdout);
  const ours = (status.automations ?? []).filter((entry) => [script, quiet, asks].includes(entry.id));
  check(
    "bb cow status --json lists the automations with their runs, and leaves their runs out of Outside Main",
    ours.length === 3 &&
      ours.find((entry) => entry.id === script)?.lastKind === "failed" &&
      ours.find((entry) => entry.id === asks)?.runs?.[0]?.queue !== null &&
      !status.outside.some((line) => line.id === quietRun || line.id === askRun),
  );
  check("bb cow status has an Automations heading", (await cow("status", "--main", umain)).stdout.includes("Automations: bb's scheduled runs"));

  // -- e archives a run, as any line --
  await page.eval(`${runLine(quietRun)}.click(); true`);
  await sleep(200);
  await page.key("e");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "archive-reason"`, { label: "the archive prompt" });
  await page.key("Enter");
  await waitForThread(quietRun, (t) => t.archivedAt !== null, "archived", 20_000);
  // Archived, a run with no parent is listed under Archived (since 0.2.9): it is the section's run line that goes.
  await page.waitFor(`!document.querySelector('.cow-main [data-cow-line="${quietRun}"][data-cow-run]')`, { label: "the archived run gone from the section", timeout: 10_000 });
  check("e archives a run, and it leaves the section", true);

  // -- e on an automation's row deletes it, after a confirmation, as a signed call --
  let doomed;
  try {
    doomed = await make("to delete", ["--prompt", QUIET, "--provider", "claude-code", "--model", MODEL]);
  } catch (cause) {
    check("bb lets the check make an automation to delete", false, String(cause).slice(0, 300));
    return;
  }
  const exists = async (id) => {
    const answer = await bb("automation", "list", "--project", PROJECT);
    const list = answer?.automations ?? answer ?? [];
    return list.some((entry) => entry.id === id);
  };
  // The page reads automations as their threads change, or once a minute: a reload reads them now.
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`${screen} === "overview" && !!${heading}`, { label: "the page again", timeout: 60_000 });
  await page.send("Page.bringToFront");
  if (!(await page.eval(`!!${row(doomed)}`))) {
    await page.eval(`${heading}.click(); true`);
    await sleep(200);
    await page.key("l");
  }
  await page.waitFor(`!!${row(doomed)}`, { label: "the automation to delete", timeout: 20_000 });
  await page.eval(`${row(doomed)}.click(); true`);
  await sleep(200);
  check("the verb bar shows e delete on an automation's row", await page.eval(`(document.querySelector('[data-cow-verb="delete"]')?.textContent ?? "").replace(/\\s+/g, " ").includes("delete")`));
  const confirmText = `(document.querySelector("[data-cow-confirm]")?.textContent ?? "")`;
  await page.key("e");
  await page.waitFor(`${confirmText}.length > 0`, { label: "the confirmation" });
  const asked = await page.eval(confirmText);
  check(
    "e asks first: it names the automation, says it is enabled and when it would next run, that its past runs stay, and that it cannot be undone",
    asked.includes(`“${NAME}: to delete”`) && /enabled and would next run (in \d+[mh]|today|tomorrow)/.test(asked) && asked.includes("past run threads are not deleted") && asked.includes("cannot be undone"),
    asked,
  );
  await page.key("n");
  await sleep(1500);
  check("any other key than y cancels, and it is still there", (await page.eval(`!document.querySelector("[data-cow-confirm]")`)) && (await exists(doomed)) && (await page.eval(`!!${row(doomed)}`)));
  await page.key("e");
  await page.waitFor(`${confirmText}.length > 0`, { label: "the confirmation again" });
  await page.key("y");
  await waitUntil(async () => !(await exists(doomed)), "the automation to be deleted");
  check("y deletes it, through the automations plugin", true);
  madeAutomations.splice(madeAutomations.indexOf(doomed), 1);
  await page.waitFor(`!${row(doomed)}`, { label: "its row gone", timeout: 20_000 });
  check("its row leaves the section", true);
  const message = await page.eval(`document.querySelector("[data-cow-message]")?.textContent ?? ""`);
  check("the message line says it is deleted and that u cannot bring it back", message.includes("deleted the automation") && message.includes("u cannot bring it back"), message);
  const logged = await rpc("caps_log", { limit: 20 });
  const entries = logged?.entries ?? logged ?? [];
  check("the delete is in cow's log, under the key that signed it", JSON.stringify(entries).includes(doomed) && JSON.stringify(entries).includes("automation-deleted"));
  const unsigned = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/automation_delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: PROJECT, automationId: quiet, name: "x" }) }).then((r) => r.json());
  check("there is no unsigned method for it", unsigned.ok === false && (await exists(quiet)));
  const forged = await fetch(`${BB}/api/v1/plugins/${PLUGIN}/rpc/signed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "automation_delete", args: { projectId: PROJECT, automationId: quiet, name: "x" }, at: Date.now(), nonce: "x".repeat(20), key: "0000-0000-0000-0000", sig: "AAAA" }) }).then((r) => r.json());
  check("an unsigned call to delete one is refused, and nothing is deleted", forged.ok === false && (await exists(quiet)));
}

async function outsideChecks(page, ids, shot, chooseMain) {
  const { omain, ostray, ohead, okid } = ids;
  await prepareOutside(ids);
  const facts = async (id) => (await api(`/threads?threadIds=${id}&limit=1`))[0];
  const before = await facts(ostray);
  // Folds belong to the window: this one starts as a new window does, Outside Main folded.
  await page.eval(`sessionStorage.removeItem("cow:folds"); true`);
  await chooseMain(page, omain);
  await page.send("Page.bringToFront");
  const heading = `document.querySelector('[data-cow-section="section:outside"]')`;
  const count = `Number(${heading}?.querySelector("[data-cow-section-count]")?.dataset.cowSectionCount ?? -1)`;
  const outLine = (id) => `document.querySelector('[data-cow-outside-line="${id}"]')`;
  const treeLine = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const isCur = (id) => `(${outLine(id)}?.classList.contains("cow-cur") === true || ${treeLine(id)}?.classList.contains("cow-cur") === true)`;
  const message = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const confirm = `(document.querySelector("[data-cow-confirm]")?.textContent ?? "")`;

  // -- the section: last, folded, counted --
  await page.waitFor(`!!${heading}`, { label: "the Outside Main heading" });
  check(
    "Outside Main comes after every other section but Archived, folded by default, showing its count",
    (await page.eval(`${heading}.dataset.cowSectionFolded === ""`)) &&
      (await page.eval(count)) >= 2 &&
      !(await page.eval(`!!${outLine(ostray)}`)) &&
      (await page.eval(`(() => { const all = [...document.querySelectorAll(".cow-main [data-cow-section], .cow-main [data-cow-shelf]")]; const archived = document.querySelector(".cow-main [data-cow-archived]"); return all[all.length - 1] === ${heading} && (!archived || !!(${heading}.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING)); })()`)),
  );
  // -- / finds its lines while folded --
  await page.key("/");
  await page.waitFor(`document.activeElement?.dataset.cowFilter === ""`, { label: "the filter" });
  await page.type("cow test");
  await page.waitFor(`!!${outLine(ostray)}`, { label: "a match outside Main", timeout: 10_000 });
  check("/ finds a line outside Main while the section is folded", await page.eval(`!!${outLine(ohead)}`));
  await page.key("Escape");
  await page.waitFor(`!${outLine(ostray)}`, { label: "the filter closed" });

  // -- unfolded: the lines, plain, with what is under them --
  await page.eval(`${heading}.click(); true`);
  await sleep(200);
  await page.key("l");
  await page.waitFor(`!!${outLine(ostray)}`, { label: "unfolded" });
  check(
    "l unfolds it: a thread with no parent is a line at rest; one with a thread under it is one line, counting it",
    (await page.eval(`${outLine(ostray)}.dataset.cowOutsideState`)) === "resting" &&
      (await page.eval(`${outLine(ohead)}.querySelector("[data-cow-under]")?.dataset.cowUnder`)) === "1" &&
      !(await page.eval(`!!${outLine(okid)}`)) &&
      !(await page.eval(`!!${outLine(omain)}`)),
  );
  check("nothing in it is in the queue", !(await page.eval(`!!document.querySelector('[data-cow-queue="${ostray}"], [data-cow-queue="${ohead}"]')`)));
  await shot("outside");

  // -- Enter opens its chat, which says it is not under this Main --
  await page.eval(`${outLine(ostray)}.click(); true`);
  await sleep(200);
  check("a line outside Main takes the cursor, and the bar offers A", (await page.eval(isCur(ostray))) && (await page.eval(`!!document.querySelector('[data-cow-verb="bring"]')`)));
  await page.key("Enter");
  await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ostray}"`, { label: "its chat" });
  check("Enter opens its chat in the pane, marked not under this Main", await page.eval(`!!document.querySelector("[data-cow-pane-outside]")`));
  for (let i = 0; i < 3 && (await page.eval(`!!document.querySelector("[data-cow-pane]")`)); i += 1) {
    await page.key("Escape");
    await sleep(300);
  }

  // -- A asks first, and says what will happen; any other key cancels --
  // Only ever on this run's own fixture: the cursor is checked before the key.
  if (!(await page.eval(isCur(ostray)))) throw new Error("the cursor is not on the fixture; nothing is moved");
  await page.key("A");
  await page.waitFor(`${confirm}.includes("under Main")`, { label: "the confirmation" });
  const asked = await page.eval(confirm);
  check("A asks first: Main gets bb's notice and starts a turn, and the thread tells Main only when stuck", asked.includes("Main starts a turn") && asked.includes("“stuck”") && asked.includes("u takes it back"), asked);
  await page.key("n");
  await sleep(300);
  check("any other key cancels, and nothing moves", (await page.eval(message)).includes("not moved") && (await facts(ostray)).parentThreadId === null);

  // -- y moves it under Main, telling Main only when stuck; the cursor follows --
  if (!(await page.eval(isCur(ostray)))) throw new Error("the cursor is not on the fixture; nothing is moved");
  await page.key("A");
  await page.waitFor(`${confirm}.includes("under Main")`, { label: "the confirmation again" });
  await page.key("y");
  const moved = await waitForThread(ostray, (t) => t.parentThreadId === omain, "under Main", 20_000);
  check("y moves it under Main, its notifications to Main set to stuck", moved.parentNotifications === "stuck");
  await page.waitFor(`!!${treeLine(ostray)} && !${outLine(ostray)}`, { label: "its line under Main", timeout: 20_000 });
  check("afterwards it is a line under Main like any other, and the cursor followed it", await page.eval(isCur(ostray)));
  await shot("outside-moved");

  // -- Main gets bb's notice, and starts a turn --
  let notice = null;
  for (let i = 0; i < 20 && !notice; i += 1) {
    const prompts = await api(`/threads/${omain}/events?types=client/turn/requested&limit=5&order=desc`);
    notice = prompts.find((event) => typeof event.data?.systemMessageKind === "string" && event.data.systemMessageKind.startsWith("ownership")) ?? null;
    if (!notice) await sleep(500);
  }
  check("Main got bb's notice that a thread is now under it", notice !== null, notice ? `${notice.data.systemMessageKind}, initiator ${notice.data.initiator}, target ${notice.data.target?.kind}` : "none");
  await waitForThread(omain, (t) => t.status === "idle", "Main's turn over", 120_000);

  // -- a worker handed a thread does not read "replied to you" --
  await bb("thread", "update", okid, "--parent-thread", ostray);
  await sleep(3000);
  await waitForThread(ostray, (t) => t.status === "idle", "its turn on bb's notice", 120_000);
  const handed = (await api(`/threads/${ostray}/events?types=client/turn/requested&limit=3&order=desc`)).find((event) => String(event.data?.systemMessageKind ?? "").startsWith("ownership"));
  await page.waitFor(`["idle", "done"].includes(${treeLine(ostray)}?.dataset.cowState) || ["idle", "done"].includes(document.querySelector('[data-cow-line="${ostray}"]')?.dataset.cowState)`, { label: "its state", timeout: 20_000 }).catch(() => undefined);
  const handedState = await page.eval(`document.querySelector('[data-cow-line="${ostray}"]')?.dataset.cowState ?? null`);
  check("a worker that bb told a thread was moved under it does not read replied to you", handedState !== "wants" && !(await page.eval(`!!document.querySelector('[data-cow-queue="${ostray}"]')`)), `${handedState}; notice ${handed ? `${handed.data.systemMessageKind}, initiator ${handed.data.initiator}` : "not found"}`);
  await bb("thread", "update", okid, "--parent-thread", ohead);

  // -- u takes it back exactly --
  await page.key("u");
  await page.waitFor(`${confirm}.includes("undo bringing")`, { label: "undo's confirmation" });
  await page.key("y");
  const back = await waitForThread(ostray, (t) => t.parentThreadId === null, "outside again", 20_000);
  await sleep(1500);
  const after = await facts(ostray);
  check(
    "u puts back its parent, its sidebar section and its notification setting, exactly",
    back.parentThreadId === null && after.sectionId === before.sectionId && after.parentNotifications === before.parentNotifications,
    `section ${before.sectionId} → ${after.sectionId}; notifications ${before.parentNotifications} → ${after.parentNotifications}`,
  );
  await page.waitFor(`!!${outLine(ostray)}`, { label: "back outside Main", timeout: 20_000 });
  check("its line is back in Outside Main, with the cursor on it", await page.eval(isCur(ostray)));

  // -- a refusal of bb's is said plainly --
  await bb("thread", "archive", okid);
  let refused = "";
  try {
    await bb("thread", "update", ostray, "--parent-thread", okid);
  } catch (error) {
    refused = `${error.stderr ?? ""} ${error.stdout ?? ""}`.trim();
  }
  const { moveRefusal } = await import("../src/outside.ts");
  const plain = moveRefusal(new Error(refused));
  check("bb refuses a parent that is archived, and cow says so in plain words", refused !== "" && plain === "bb refused: Main cannot take a thread under it, as it is archived or deleted" && (await facts(ostray)).parentThreadId === null, refused.slice(0, 200));
  await bb("thread", "unarchive", okid);

  // -- archiving a thread outside Main, with a reason --
  const { OUTSIDE_REFUSAL } = await import("../src/outside.ts");
  const archivedLine = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const reasonOf = (id) => `(${archivedLine(id)}?.querySelector("[data-cow-archive-reason]")?.textContent ?? "")`;
  // The command resolves Main from what is recorded for the caller's project: the fixtures' Main, for this part only.
  await signer.must("main_choose", { projectId: (await facts(omain)).projectId, threadId: omain });
  const byOther = await cowAs(okid, "archive", ostray, "--reason", "cow test: not mine");
  check(
    "another thread is refused archiving a thread outside Main, and told who does it",
    byOther.code !== 0 && `${byOther.stderr}${byOther.stdout}`.includes(OUTSIDE_REFUSAL) && /the thread that is Main runs `bb cow archive/.test(byOther.stderr + byOther.stdout) && (await facts(ostray)).archivedAt == null,
    (byOther.stderr + byOther.stdout).slice(0, 300),
  );
  const ownMain = await cowAs(omain, "archive", omain, "--reason", "cow test: never");
  check("the chosen Main is refused as Main, by name", ownMain.code !== 0 && `${ownMain.stderr}${ownMain.stdout}`.includes(`(${omain}): Main cannot be archived from here`) && (await facts(omain)).archivedAt == null, (ownMain.stderr + ownMain.stdout).slice(0, 300));
  const byMain = await cowAs(omain, "archive", ostray, "--reason", "cow test: old work");
  check(
    "the thread that is Main archives a thread outside Main with a reason, and is not taken for Main",
    byMain.code === 0 && byMain.stdout.includes("cow test: old work") && byMain.stdout.includes("it was outside Main") && (await facts(ostray)).archivedAt != null,
    (byMain.stderr + byMain.stdout).slice(0, 300),
  );
  await page.waitFor(`${reasonOf(ostray)}.includes("cow test: old work") && !${outLine(ostray)}`, { label: "under Archived with its reason", timeout: 20_000 });
  check("archived, it leaves Outside Main and is listed under Archived with its reason", await page.eval(`!!document.querySelector("[data-cow-archived]")`));
  const statusArchived = (await cow("status", "--main", omain)).stdout;
  check("bb cow status lists it under Archived too", new RegExp(`\\(${ostray}\\)[^\\n]*cow test: old work`).test(statusArchived), statusArchived.split("\n").filter((l) => l.includes(ostray)).join(" / "));
  check(
    "Archived is the last section, after Outside Main, on the page and in bb cow status",
    (await page.eval(`(() => { const archived = document.querySelector(".cow-main [data-cow-archived]"); const all = [...document.querySelectorAll(".cow-main [data-cow-section], .cow-main [data-cow-shelf], .cow-main [data-cow-archived]")]; return all[all.length - 1] === archived && !!(${heading}.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING); })()`)) &&
      statusArchived.indexOf("\nOutside Main:") >= 0 &&
      statusArchived.indexOf("\nOutside Main:") < statusArchived.indexOf("\nArchived in the last 2 days"),
  );
  await restoreStored();
  await bb("thread", "unarchive", ostray);
  await page.waitFor(`!!${outLine(ostray)}`, { label: "back outside Main, unarchived", timeout: 20_000 });

  // -- on the page: e asks for a reason, as on any line; u takes it back --
  await page.eval(`${outLine(ostray)}.click(); true`);
  await sleep(200);
  if (!(await page.eval(isCur(ostray)))) throw new Error("the cursor is not on the fixture; nothing is archived");
  check("the bar offers e on a line outside Main", await page.eval(`document.querySelector('[data-cow-verb="archive"]')?.classList.contains("cow-off") === false`));
  await page.key("e");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "archive-reason"`, { label: "the archive prompt on a line outside Main" });
  // An open thread outside Main has no notes read for it, so a reason given before is not offered again here.
  check("e asks for a reason, as on any line", await page.eval(`!!document.querySelector('[data-cow-input="archive-reason"]')`));
  await page.eval(`(() => { const input = document.activeElement; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await page.type("cow test: from the page");
  await page.key("Enter");
  await waitForThread(ostray, (t) => t.archivedAt != null, "archived from the page", 20_000);
  await page.waitFor(`${reasonOf(ostray)}.includes("cow test: from the page")`, { label: "under Archived, from the page", timeout: 20_000 });
  check("Enter archives it, and it is listed under Archived with that reason", (await page.eval(message)).includes("archived: cow test: from the page"), await page.eval(message));
  await page.key("u");
  await page.waitFor(`${confirm}.length > 0`, { label: "undo's confirmation" });
  await page.key("y");
  await waitForThread(ostray, (t) => t.archivedAt == null, "unarchived by u", 20_000);
  await page.waitFor(`!!${outLine(ostray)}`, { label: "back outside Main after u", timeout: 20_000 });
  check("u takes it back: it is open again, outside Main", (await facts(ostray)).parentThreadId === null);

  // -- bb cow status --
  const status = (await cow("status", "--main", omain)).stdout;
  check("bb cow status has an Outside Main heading with the same lines", /\nOutside Main: open, with no parent, not under Main \(\d+/.test(status) && status.includes(`(${ostray})`) && new RegExp(`\\(${ohead}\\)\\s+\\[1 under it\\]`).test(status), status.split("\n").filter((l) => l.includes(ostray) || l.includes(ohead) || l.startsWith("Outside")).join(" / "));
  const json = JSON.parse((await cow("status", "--main", omain, "--json")).stdout);
  const listedJson = (json.outside ?? json.result?.outside ?? []).find((line) => line.id === ostray);
  check("bb cow status --json has it under outside", listedJson?.state === "resting" && typeof listedJson.since === "string", JSON.stringify(listedJson));
}

/** To settle, which replies enter the queue, and keeping a thread. */
async function settleChecks(page, ids, shot, chooseMain) {
  await prepareSettle(ids);
  // Folds belong to the window: this one starts as a new window does, Kept folded and To settle open.
  await page.eval(`sessionStorage.removeItem("cow:folds"); true`);
  await chooseMain(page, ids.smain);
  await page.send("Page.bringToFront");
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const stateOf = (id) => `(${lineEl(id)}?.dataset.cowState ?? null)`;
  const settled = (id) => `(${lineEl(id)}?.dataset.cowSettle === "")`;
  const unreadOf = (id) => `(${lineEl(id)}?.dataset.cowUnread === "")`;
  const inQueue = (id) => `!!document.querySelector('[data-cow-queue="${id}"]')`;
  const heading = (id) => `document.querySelector('[data-cow-section="${id}"]')`;
  const countOf = (id) => `Number(${heading(id)}?.querySelector("[data-cow-section-count]")?.dataset.cowSectionCount ?? -1)`;
  const keeps = async (id) => (await rpc("notes_list", { threadIds: [id] })).keeps[id] ?? null;
  const select = async (id) => {
    await page.eval(`${lineEl(id)}.click(); true`);
    await sleep(200);
  };
  const selectHeading = async (id) => {
    await page.eval(`${heading(id)}.click(); true`);
    await sleep(200);
  };
  const offset = async (ms) =>
    page.eval(`${ms === 0 ? `sessionStorage.removeItem("cow:test-clock-offset-ms")` : `sessionStorage.setItem("cow:test-clock-offset-ms", "${ms}")`};
      window.dispatchEvent(new Event("cow:test-clock")); true`);
  const DAY = 86_400_000;
  const { sjob, schat } = ids;

  // -- a job's report is to settle, not in the queue --
  await page.waitFor(`${settled(sjob)} && ${settled(schat)}`, { label: "both lines to settle" });
  check("a worker's report on its first turn is under To settle, not in the queue", (await page.eval(stateOf(sjob))) === "done" && !(await page.eval(inQueue(sjob))));
  check("its reply not seen, it is marked unread and listed before a read one", (await page.eval(unreadOf(sjob))) && !(await page.eval(unreadOf(schat))) && (await page.eval(`${lineEl(sjob)}.compareDocumentPosition(${lineEl(schat)}) === Node.DOCUMENT_POSITION_FOLLOWING`)));
  check("the line says what archiving it would leave behind", (await page.eval(`${lineEl(sjob)}?.querySelector("[data-cow-behind]")?.dataset.cowBehind ?? ""`)) === "a reply you have not seen");
  check("the heading counts them", (await page.eval(countOf("section:settle"))) === 2);
  check("no line to settle has the stuck or wants state", !(await page.eval(`[...document.querySelectorAll(".cow-main [data-cow-settle]")].some((el) => el.dataset.cowState !== "done")`)));
  await shot("settle");

  // -- the age: plain, warm, then red; never in the queue --
  const heat = (id) => `(${lineEl(id)}?.querySelector("[data-cow-heat]")?.dataset.cowHeat ?? null)`;
  const headHeat = `(${heading("section:settle")}?.querySelector("[data-cow-section-count]")?.dataset.cowHeat ?? null)`;
  check("a line that finished minutes ago reads plain", (await page.eval(heat(sjob))) === "plain" && (await page.eval(headHeat)) === "plain");
  await offset(4 * DAY);
  await page.waitFor(`${heat(sjob)} === "warm"`, { label: "warm" });
  check("after 3 days its age, and the heading's count, read warm", (await page.eval(headHeat)) === "warm");
  await offset(8 * DAY);
  await page.waitFor(`${heat(sjob)} === "old"`, { label: "red" });
  check("after 7 days they read red, and nothing entered the queue", (await page.eval(headHeat)) === "old" && !(await page.eval(inQueue(sjob))) && !(await page.eval(inQueue(schat))));
  await shot("settle-old");
  await offset(0);

  // -- a turn another agent started ends out of the queue; one the person started enters it --
  await tellAs(ids.smain, schat, "again");
  await sleep(3000);
  await waitForThread(schat, (t) => t.status === "idle", "its report");
  await page.waitFor(`${settled(schat)} && ${unreadOf(schat)}`, { label: "an agent's turn ended", timeout: 30_000 });
  check("a turn another thread started ends to settle, unread, not in the queue", !(await page.eval(inQueue(schat))));
  await tellAs(null, schat, "hello");
  await sleep(3000);
  await waitForThread(schat, (t) => t.status === "idle", "its reply");
  await page.waitFor(`${stateOf(schat)} === "wants" && ${inQueue(schat)}`, { label: "the person's reply in the queue", timeout: 30_000 });
  check("a turn the person started ends in the queue, as before", (await page.eval(`document.querySelector('[data-cow-queue="${schat}"]')?.textContent ?? ""`)).includes("replied to you"));
  await select(schat);
  await page.key(" ");
  await page.waitFor(`${stateOf(schat)} === "done" && !${inQueue(schat)}`, { label: "seen" });
  check("Space marks it seen: out of the queue, staying where it is until reload", await page.eval(`${lineEl(schat)}?.dataset.cowStays === ""`));

  // -- the section folds, and the window remembers --
  await selectHeading("section:settle");
  await page.key("h");
  await page.waitFor(`${heading("section:settle")}?.dataset.cowSectionFolded === ""`, { label: "folded" });
  check("h on the heading folds To settle: its lines are gone, its count stays", !(await page.eval(`!!${lineEl(sjob)}`)) && (await page.eval(countOf("section:settle"))) >= 1);
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`${screen} === "overview" && !!${heading("section:settle")}`, { label: "the page reloaded" });
  check("the fold outlives a reload", (await page.eval(`${heading("section:settle")}?.dataset.cowSectionFolded === ""`)) && !(await page.eval(`!!${lineEl(sjob)}`)));
  check("after the reload the seen line is to settle, read", !(await page.eval(`!!${lineEl(schat)}`)) || (await page.eval(`!${unreadOf(schat)}`)));
  await selectHeading("section:settle");
  await page.key("l");
  await page.waitFor(`!!${lineEl(sjob)}`, { label: "unfolded" });
  check("l unfolds it", (await page.eval(settled(sjob))) && (await page.eval(settled(schat))) && !(await page.eval(unreadOf(schat))));

  // -- keep: z, with a few words --
  await select(sjob);
  await page.key("z");
  await page.waitFor(`${mode} === "keep"`, { label: "the keep prompt" });
  await page.waitFor(`document.activeElement?.dataset.cowInput === "keep-words"`, { label: "the keep prompt: focused" });
  await page.type("an idea to come back to");
  await page.key("Enter");
  await page.waitFor(`!${lineEl(sjob)} && ${countOf("section:kept")} === 1`, { label: "kept" });
  const note = await keeps(sjob);
  check("z keeps it with the words typed: it leaves To settle for Kept, folded by default, showing only its count", note?.words === "an idea to come back to" && (await page.eval(`${heading("section:kept")}?.dataset.cowSectionFolded === ""`)), JSON.stringify(note));
  check("a kept line is not in the queue, and Kept's count is never coloured", !(await page.eval(inQueue(sjob))) && (await page.eval(`${heading("section:kept")}?.querySelector("[data-cow-section-count]")?.dataset.cowHeat === undefined`)));
  const status = (await cow("status", "--main", ids.smain)).stdout;
  check("bb cow status lists it under Kept", /Kept: around on purpose, asking for nothing \(1\)\n\s+kept\s+\S+\s+cow test \(thr_\w+\)\s+an idea to come back to/.test(status), status.split("\n").filter((l) => /Kept|kept/.test(l)).join(" / "));
  await page.key("/");
  await page.waitFor(`${mode} === "filter"`, { label: "the filter" });
  await page.type("come back");
  await page.waitFor(`!!${lineEl(sjob)}`, { label: "the kept line found" });
  check("/ finds a kept line while its section is folded", (await page.eval(`${lineEl(sjob)}?.dataset.cowKept === ""`)));
  await page.key("Escape");
  await page.waitFor(`${mode} === "normal" && !${lineEl(sjob)}`, { label: "the filter closed" });
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${settled(sjob)}`, { label: "keep undone" });
  check("u takes the keep back: it is to settle again", (await keeps(sjob)) === null);

  // -- unkeep with z, keep again without words, and open the section --
  await select(sjob);
  await page.key("z");
  await page.waitFor(`${mode} === "keep"`, { label: "the keep prompt again" });
  await page.waitFor(`document.activeElement?.dataset.cowInput === "keep-words"`, { label: "the keep prompt again: focused" });
  await page.key("Enter");
  await page.waitFor(`!${lineEl(sjob)}`, { label: "kept without words" });
  check("nothing need be typed to keep it", (await keeps(sjob))?.words === null);
  await selectHeading("section:kept");
  await page.key("l");
  await page.waitFor(`${stateOf(sjob)} === "kept"`, { label: "Kept open" });
  check("l on Kept's heading opens it: the line, marked kept, with how long it has been kept", await page.eval(`!!${lineEl(sjob)}?.querySelector("svg.cow-s-kept")`));
  await shot("kept");
  await select(sjob);
  await page.key("z");
  await page.waitFor(`${settled(sjob)}`, { label: "off Kept" });
  check("z on a kept line takes it off Kept", (await keeps(sjob)) === null);
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${stateOf(sjob)} === "kept"`, { label: "kept again" });
  check("u takes that back too", (await keeps(sjob)) !== null);

  // -- a new turn takes it off by itself --
  await tellAs(null, sjob, "hello");
  await sleep(3000);
  await waitForThread(sjob, (t) => t.status === "idle", "its reply");
  await page.waitFor(`${stateOf(sjob)} === "wants" && ${inQueue(sjob)}`, { label: "off the shelf by itself", timeout: 30_000 });
  check("typing to a kept thread takes it off the shelf: it reads as any other line", (await page.eval(countOf("section:kept"))) === 0);

  // -- archiving a kept line clears its note --
  await select(sjob);
  await page.key(" ");
  await page.waitFor(`${stateOf(sjob)} === "done"`, { label: "seen" });
  await page.key("z");
  await page.waitFor(`${mode} === "keep"`, { label: "keep before archiving" });
  await page.waitFor(`document.activeElement?.dataset.cowInput === "keep-words"`, { label: "keep before archiving: focused" });
  await page.key("Enter");
  await page.waitFor(`${stateOf(sjob)} === "kept"`, { label: "kept, the section open" });
  await select(sjob);
  await page.key("e");
  await page.waitFor(`${mode} === "archive"`, { label: "the archive prompt" });
  // A kept worker is asked what it came to first; Enter leaves it unsaid.
  await page.waitFor(`!!document.querySelector('[data-cow-outcome-prompt="archive"]')`, { label: "the outcome, asked first" });
  await page.key("Enter");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "archive-reason"`, { label: "the archive prompt: focused" });
  await page.type("thought through");
  await page.key("Enter");
  await page.waitFor(`(${lineEl(sjob)}?.querySelector("[data-cow-archive-reason]")?.textContent ?? "").includes("thought through")`, { label: "under Archived" });
  check("e archives a kept line; it is listed under Archived with its reason, and its keep note is gone", (await keeps(sjob)) === null && (await page.eval(`!!document.querySelector("[data-cow-archived]")`)));
  const unsaid = (await rpc("ledger_read", { days: 14 })).rows.find((row) => row.threadId === sjob);
  check("Enter at the outcome leaves it unsaid: the ledger row is written with none", unsaid !== undefined && unsaid.outcome === null && unsaid.judgedBy === null, JSON.stringify(unsaid));
  check(
    "Archived is listed below Kept and Outside Main, and its line comes last for the cursor",
    await page.eval(`(() => { const archived = document.querySelector(".cow-main [data-cow-archived]"); const kept = document.querySelector('[data-cow-section="section:kept"]'); const outside = document.querySelector('[data-cow-section="section:outside"]'); const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); return follows(kept, archived) && follows(outside, archived) && follows(archived, ${lineEl(sjob)}); })()`),
  );
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${settled(sjob)}`, { label: "unarchived" });
  check("u unarchives it, and it is to settle, not kept", (await keeps(sjob)) === null);

  // -- a project's reply to a turn the person did not start stays out of the queue --
  const dot = (id) => `!!${lineEl(id)}?.querySelector("[data-cow-unseen]")`;
  const mainDot = `!!document.querySelector(".cow-mainline [data-cow-unseen]")`;
  const seenOf = async (id) => (await rpc("notes_list", { threadIds: [id] })).seen[id]?.seq ?? null;
  const marked = await cowAs(ids.smain, "project", schat);
  check("bb cow project: Main marks a thread under it as a project", marked.code === 0, marked.stderr.trim());
  await page.waitFor(`${stateOf(schat)} === "idle"`, { label: "the project idle" });
  // A thread under it reports back, as an agent: that turn is not the person's.
  await tellAs(sjob, schat, "report: the job is finished");
  await sleep(3000);
  await waitForThread(schat, (t) => t.status === "idle", "its reply to the report");
  await page.waitFor(`${stateOf(schat)} === "idle" && ${dot(schat)}`, { label: "the project marked unread", timeout: 30_000 });
  check(
    "a project whose worker reports back reads idle, with the unread mark, and is not in the queue",
    !(await page.eval(inQueue(schat))) && (await page.eval(`${lineEl(schat)}?.querySelector("[data-cow-unseen]")?.getAttribute("aria-label") === "unread"`)),
  );
  const projectStatus = (await cow("status", "--main", ids.smain)).stdout;
  check("bb cow status says unread on that line", new RegExp(`idle\\s+\\S+\\s+cow test \\(${schat}\\) \\[project\\] \\[unread\\]`).test(projectStatus), projectStatus.split("\n").filter((l) => l.includes(schat)).join(" / "));
  await select(schat);
  await page.key(" ");
  await page.waitFor(`!${dot(schat)}`, { label: "the mark cleared" });
  check("Space clears the mark: it stays idle, out of the queue", (await page.eval(stateOf(schat))) === "idle" && !(await page.eval(inQueue(schat))) && (await seenOf(schat)) !== null);
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${dot(schat)}`, { label: "the mark back" });
  check("u brings the mark back", (await page.eval(stateOf(schat))) === "idle");
  await page.key(" ");
  await page.waitFor(`!${dot(schat)}`, { label: "the mark cleared again" });
  await tellAs(null, schat, "hello");
  await sleep(3000);
  await waitForThread(schat, (t) => t.status === "idle", "its reply to the person");
  await page.waitFor(`${stateOf(schat)} === "wants" && ${inQueue(schat)}`, { label: "the project's reply in the queue", timeout: 30_000 });
  check("the same project, after the person tells it something, is in the queue: replied to you", (await page.eval(`document.querySelector('[data-cow-queue="${schat}"]')?.textContent ?? ""`)).includes("replied to you"));
  await select(schat);
  await page.key(" ");
  await page.waitFor(`!${inQueue(schat)}`, { label: "seen" });
  const asked = await cowAs(schat, "ask", "--question", "Ship it?", "--option", "yes", "--option", "no");
  await page.waitFor(`${inQueue(schat)} && ${stateOf(schat)} === "wants"`, { label: "the project's ask in the queue", timeout: 30_000 });
  check("an ask from the project is in the queue", asked.code === 0 && (await page.eval(`document.querySelector('[data-cow-queue="${schat}"]')?.textContent ?? ""`)).includes("Ship it?"), asked.stderr.trim());
  for (const ask of await openAsksOf(schat)) await cowAs(schat, "ask", "withdraw", ask.id);
  await page.waitFor(`!${inQueue(schat)}`, { label: "the ask withdrawn", timeout: 30_000 });
  // Main is read by the same rule: a report to it marks its heading, and it is not in the queue.
  await tellAs(sjob, ids.smain, "report: the job is finished");
  await sleep(3000);
  await waitForThread(ids.smain, (t) => t.status === "idle", "Main's reply to the report");
  await page.waitFor(`${mainDot}`, { label: "Main's heading marked unread", timeout: 30_000 });
  check("Main's reply to a report is marked on its heading, and Main is not in the queue", !(await page.eval(inQueue(ids.smain))) && (await page.eval(`document.querySelector("[data-cow-main-state]")?.dataset.cowMainState`)) === "idle");
  await shot("project-unread");
  await page.eval(`document.querySelector(".cow-mainline").click(); true`);
  await sleep(200);
  await page.key(" ");
  await page.waitFor(`!${mainDot}`, { label: "Main's mark cleared" });
  check("Space clears Main's mark", (await seenOf(ids.smain)) !== null);
  await cowAs(ids.smain, "project", schat, "--clear");
  // The project's withdrawn ask left a trace in the queue of every page: acknowledged, so no later run starts with a notice.
  await clearTraces(ids);
}

async function prepareHistory(ids) {
  for (const name of HISTORY) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  // The linker writes its mention of the third thread once; a later run finds it in its chat.
  const said = (await api(`/threads/${ids.hb}/output`)).output ?? "";
  if (!said.includes(`@thread:${ids.hc}`)) {
    await tellAs(ids.hmain, ids.hb, `links ${ids.hc} ${ids.ha} ${ids.hmain}`);
    await sleep(3000);
    await waitForThread(ids.hb, (t) => t.status === "idle", "the links written");
  }
  // The first thread has a reply addressed to the person, not yet seen.
  await tellAs(null, ids.ha, "hello");
  await sleep(3000);
  await waitForThread(ids.ha, (t) => t.status === "idle", "its reply");
  await signer.must("seen_set", { threadId: ids.ha, seen: null });
}

async function historyChecks(page, ids, shot, chooseMain) {
  await prepareHistory(ids);
  await chooseMain(page, ids.hmain);
  await page.send("Page.bringToFront");
  const { ha, hb, hc } = ids;
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const pane = `(document.querySelector("[data-cow-pane]")?.dataset.cowPane ?? null)`;
  const inQueue = (id) => `!!document.querySelector('[data-cow-queue="${id}"]')`;
  const message = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const path = `location.pathname`;
  const seenOf = async (id) => (await rpc("notes_list", { threadIds: [id] })).seen[id]?.seq ?? null;
  const select = async (id) => {
    await page.eval(`${lineEl(id)}.click(); true`);
    await sleep(200);
  };
  const at = async (id, label) => {
    await page.waitFor(`${pane} === ${id === null ? "null" : `"${id}"`}`, { label, timeout: 20_000 });
    return page.eval(path);
  };
  await page.waitFor(`${inQueue(ha)}`, { label: "the first thread's reply in the queue", timeout: 30_000 });

  // -- open A, open B, follow a link to C --
  await select(ha);
  await page.key("Enter");
  const pathA = await at(ha, "A open");
  check("opening a chat names it in the page's address", pathA.includes(ha), pathA);
  await page.waitFor(`!${inQueue(ha)}`, { label: "A's reply seen by opening it" });
  // Take that mark back while the chat is open, as u does after Space: the check clears the record itself.
  await signer.must("seen_set", { threadId: ha, seen: null });
  // Marked on this page, the line stays where it is, out of the queue, until a reload; its reply is what shows it unseen.
  await page.waitFor(`${lineEl(ha)}?.dataset.cowReply === ""`, { label: "A's reply unseen again" });
  await sleep(2000);
  check("with its mark taken back, the open chat does not mark A's reply again", (await seenOf(ha)) === null);
  await select(hb);
  await page.key("Enter");
  await at(hb, "B open");
  const mention = `[...document.querySelectorAll('[data-cow-chat] a[data-prompt-mention-resource]')].filter((a) => (a.getAttribute("data-prompt-mention-resource") ?? "").includes('"${hc}"')).pop()`;
  await page.waitFor(`!!${mention}`, { label: "B's mention of C", timeout: 30_000 });
  await clickSettled(page, mention, "the mention of C");
  const pathC = await at(hc, "C open by its link");
  check("following a link names the linked chat in the address", pathC.includes(hc), pathC);

  // -- back, back, back and forward, driven with history.back() and history.forward() --
  await page.eval(`history.back(); true`);
  await at(hb, "back to B");
  check("history.back() from C brings B's chat, and the cursor follows it", await page.eval(isCursor(hb)));
  await page.eval(`history.back(); true`);
  await at(ha, "back to A");
  check("history.back() again brings A's chat, and the cursor follows it", await page.eval(isCursor(ha)));
  await sleep(2000);
  check("a chat brought back by history marks nothing seen", (await seenOf(ha)) === null && (await page.eval(`${lineEl(ha)}?.dataset.cowReply === ""`)));
  await page.eval(`history.back(); true`);
  const closed = await at(null, "back to the page with no chat");
  check("history.back() a third time closes the pane: the address names no chat", !closed.includes(ha) && !closed.includes(hb), closed);
  await page.eval(`history.forward(); true`);
  await at(ha, "forward to A");
  check("history.forward() brings A's chat again, with the cursor on its line", await page.eval(isCursor(ha)));

  // -- a reload with a chat open --
  await page.eval(`location.reload(); true`);
  await page.waitFor(`${screen} === "overview" && ${pane} === "${ha}"`, { label: "the page reloaded with A open", timeout: 60_000 });
  await sleep(3000);
  check("a reload reopens the chat the address names", true);
  const afterReload = { seen: await seenOf(ha), queued: await page.eval(`(${lineEl(ha)}?.querySelector(".cow-qn")?.textContent ?? "") !== ""`), state: await page.eval(`${lineEl(ha)}?.dataset.cowState ?? null`) };
  check("the reload marks nothing seen: A's reply, un-marked, still waits in the queue", afterReload.seen === null && afterReload.queued, JSON.stringify(afterReload));
  await select(ha);
  await page.key("Enter");
  await page.waitFor(`!${inQueue(ha)}`, { label: "A seen by Enter" });
  await sleep(1000);
  check("Enter on the reopened chat's line marks its reply seen: the person opened it", (await seenOf(ha)) !== null);
  await shot("history-reload");

  // -- an address that names no thread this page knows --
  const base = pathA.slice(0, pathA.indexOf(ha));
  const unknown = "thr_cowtestnosuchthread";
  const length = await page.eval(`history.length`);
  await page.goto(`${BB}${base}${unknown}`);
  await page.waitFor(`${screen} === "overview" && ${message}.includes("not a thread this page knows")`, { label: "the unknown id said", timeout: 60_000 });
  check(
    "an unknown id in the address opens no chat, says so, and leaves no entry naming it",
    (await page.eval(pane)) === null && !(await page.eval(path)).includes(unknown) && (await page.eval(`history.length`)) <= length + 1 && (await page.eval(screen)) === "overview",
    await page.eval(message),
  );

  // -- an archived thread's id --
  await bb("thread", "archive", hc);
  await page.waitFor(`!${lineEl(hc)} || ${lineEl(hc)}?.dataset.cowState === "done"`, { label: "C archived", timeout: 30_000 });
  await page.goto(`${BB}${base}${hc}`);
  await page.waitFor(`${screen} === "overview" && ${pane} === "${hc}"`, { label: "the archived thread's chat", timeout: 60_000 });
  check("an archived thread's id opens its chat, as Enter on its line would", !(await page.eval(message)).includes("not a thread"));
}

// ---- opening the page from anywhere ------------------------------------------

/**
 * The copy's shortcut, Ctrl+Option+Shift+C, pressed as macOS sends it: with
 * Option held the key is a symbol ("Ç"), so bb matches it by the physical key.
 */
async function pressOpen(page) {
  const base = { key: "Ç", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 1 | 2 | 8 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(250);
}

async function openChecks(page, ids, shot, chooseMain) {
  const { xmain } = ids;
  await waitForThread(xmain, (t) => t.status === "idle", "idle");
  await chooseMain(page, xmain);
  const pageAt = `/plugins/${PLUGIN}/main`;
  const onPage = `location.pathname === "${pageAt}" && ${screen} === "overview" && document.querySelector(".cow-mainline")?.dataset.cowLine === "${xmain}"`;
  const pane = `(document.querySelector("[data-cow-pane]")?.dataset.cowPane ?? null)`;
  const project = PROJECT_OF.xmain ?? PROJECT;

  // -- from a thread's chat in bb, outside cow --
  await page.goto(`${BB}/projects/${project}/threads/${xmain}`);
  await page.waitFor(`location.pathname.includes("/threads/${xmain}") && !${ROOT}`, { label: "the fixture's chat in bb", timeout: 30_000 });
  await sleep(1500);
  await page.eval("window.cowOpenMark = true; true");
  await pressOpen(page);
  await page.waitFor(onPage, { label: "cow's page from a chat", timeout: 20_000 });
  check("the shortcut, from a thread's chat in bb, opens cow's page with its list", true);
  check("it gets there without a reload: the window keeps what it held", (await page.eval("window.cowOpenMark === true")) === true);
  await page.eval("history.back(); true");
  await page.waitFor(`location.pathname.includes("/threads/${xmain}")`, { label: "back to the chat" });
  check("bb's back from there returns to the chat", true);

  // -- from a bb screen with no thread --
  await page.goto(`${BB}/settings`);
  await page.waitFor(`location.pathname.startsWith("/settings") && !${ROOT}`, { label: "bb's settings", timeout: 30_000 });
  await sleep(1500);
  await pressOpen(page);
  await page.waitFor(onPage, { label: "cow's page from settings", timeout: 20_000 });
  check("the shortcut, from bb's settings, opens cow's page with its list", true);

  // -- the palette lists it, and running it from there works too --
  await page.goto(`${BB}/settings`);
  await page.waitFor(`location.pathname.startsWith("/settings") && !${ROOT}`, { label: "bb's settings again", timeout: 30_000 });
  await sleep(1500);
  const palette = { key: "P", code: "KeyP", windowsVirtualKeyCode: 80, modifiers: 4 | 8 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...palette });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...palette });
  await sleep(500);
  await page.type(`${PLUGIN}: open its page`);
  const row = `[...document.querySelectorAll('[role="option"]')].find((el) => el.textContent.includes("${PLUGIN}: open its page"))`;
  await page.waitFor(`!!${row}`, { label: "the command in the palette" });
  check("bb's command palette lists the command", true);
  await page.key("Enter");
  await page.waitFor(onPage, { label: "cow's page from the palette", timeout: 20_000 });
  check("run from the palette, it opens cow's page", true);

  // -- on cow's page with a chat open, it changes nothing --
  await page.key("m");
  await page.waitFor(`${pane} === "${xmain}"`, { label: "Main's chat open", timeout: 20_000 });
  const cursor = `(document.querySelector(".cow-cur")?.dataset.cowLine ?? null)`;
  const was = { path: await page.eval("location.pathname"), pane: await page.eval(pane), cursor: await page.eval(cursor), length: await page.eval("history.length") };
  await pressOpen(page);
  await sleep(1500);
  const now = { path: await page.eval("location.pathname"), pane: await page.eval(pane), cursor: await page.eval(cursor), length: await page.eval("history.length") };
  check("on cow's page with a chat open, the shortcut leaves the page, the chat and the selection as they were", JSON.stringify(now) === JSON.stringify(was) && now.pane === xmain, `${JSON.stringify(was)} → ${JSON.stringify(now)}`);
  await shot("open-unchanged");
}

// ---- what an agent takes out of the queue -------------------------------------

/** Acknowledge every trace about a fixture, and withdraw (as the person, leaving none) every ask a fixture still has open. */
async function clearTraces(ids) {
  const ours = new Set(Object.values(ids));
  for (const id of ours) for (const ask of await openAsksOf(id)) await cow("ask", "withdraw", ask.id);
  for (const notice of (await capState()).notices) {
    if (notice.kind === "trace" && (ours.has(notice.threadId) || ours.has(notice.trace?.actorThreadId))) await signer.must("cap_ack", { noticeId: notice.id });
  }
}

async function prepareTraces(ids) {
  for (const name of TRACING) await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle`);
  await clearTraces(ids);
  // Every run starts with every reply seen.
  for (const name of TRACING) {
    const id = ids[name];
    const end = (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
    if (end !== undefined) await signer.must("seen_set", { threadId: id, seen: { seq: end, at: Date.now() } });
  }
}

async function traceChecks(page, ids, shot, chooseMain) {
  await prepareTraces(ids);
  await chooseMain(page, ids.tmain);
  await page.send("Page.bringToFront");
  const { tmain, tpark, tidle, task, thead, tkid } = ids;
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const traces = async () => (await capState()).notices.filter((notice) => notice.kind === "trace" && Object.values(ids).includes(notice.threadId));
  const noticeEl = (id) => `document.querySelector('[data-cow-notice="${id}"]')`;
  const sheet = `document.querySelector('[data-cow-sheet="capabilities"]')`;
  const paneOf = `(document.querySelector("[data-cow-pane]")?.dataset.cowPane ?? null)`;
  const askAs = async (sender, thread, question) =>
    JSON.parse((await cowAs(sender, "ask", "--question", question, "--option", "red", "--option", "blue", ...(thread ? ["--thread", thread] : []), "--json")).stdout).ask;
  /** A new trace, once the server has it, and its notice on the page. */
  const newTrace = async (before, label) => {
    let found = null;
    await waitUntil(async () => {
      found = (await traces()).find((notice) => !before.includes(notice.id)) ?? null;
      return found !== null;
    }, label);
    await page.waitFor(`!!${noticeEl(found.id)}`, { label: `${label}: on the page` });
    return found;
  };
  const closePane = async () => {
    for (let i = 0; i < 3 && (await page.eval(`!!document.querySelector("[data-cow-pane]")`)); i += 1) {
      await page.key("Escape");
      await sleep(300);
    }
  };

  // -- an agent parks a thread with an open ask: a notice, until acknowledged --
  const parkedAsk = await askAs(tmain, tpark, "Which colour for the park?");
  await page.waitFor(`${lineEl(tpark)}?.dataset.cowState === "wants"`, { label: "the ask on its line" });
  const none = (await traces()).map((notice) => notice.id);
  const parked = await cowAs(tmain, "park", tpark, "--reason", "not needed this week");
  check("an agent may park a thread that waits on the person", parked.code === 0 && parked.stdout.includes("they are shown that you parked it"), parked.stdout + parked.stderr);
  const parkNotice = await newTrace(none, "the park's notice");
  const parkText = await page.eval(`${noticeEl(parkNotice.id)}.textContent`);
  check(
    "the notice says who parked what, what it waited on, the reason and when, among the queue's notices",
    parkNotice.threadId === tpark && parkNotice.trace?.action === "parked" && parkNotice.trace?.actorThreadId === tmain &&
      parkText.includes("“cow test” parked “cow test”, which was waiting on you for an open ask · its reason: not needed this week") &&
      (await page.eval(`${noticeEl(parkNotice.id)}.closest(".cow-notices") !== null && ${noticeEl(parkNotice.id)}.dataset.cowNoticeTrace === "parked"`)),
    parkText,
  );
  check("the thread is parked all the same, and its own ask stays in the queue", (await rpc("notes_list", { threadIds: [tpark] })).parks[tpark] !== undefined && (await page.eval(`!!document.querySelector('[data-cow-queue="${tpark}"]')`)));
  const logged = (await capLog(20)).find((entry) => entry.event.kind === "trace" && entry.event.threadId === tpark);
  check("the park is in the log, done by no key", logged?.event.action === "parked" && logged.event.actorThreadId === tmain && logged.by === null);
  const status = await cowAs(tmain, "status", "--main", tmain);
  check("bb cow status lists it under a heading of its own", /Taken out of the user's queue by an agent, not yet acknowledged by the user \(1\)/.test(status.stdout) && status.stdout.includes(parkNotice.id), status.stdout.slice(0, 600));
  await shot("trace-notice");

  // -- Enter on it opens the thread's chat; Space acknowledges it --
  await page.eval(`${noticeEl(parkNotice.id)}.click(); true`);
  await page.waitFor(`!!${sheet}?.querySelector('[data-cow-cap-trace="${parkNotice.id}"].cow-cur')`, { label: "the sheet, on the notice" });
  check("clicking the notice opens the capabilities sheet on it", true);
  await shot("trace-sheet");
  await page.key("Enter");
  await page.waitFor(`${paneOf} === "${tpark}" && !${sheet}`, { label: "the parked thread's chat" });
  check("Enter on it opens that thread's chat, and the notice stays", (await traces()).some((notice) => notice.id === parkNotice.id));
  await closePane();
  await page.eval(`${noticeEl(parkNotice.id)}.click(); true`);
  await page.waitFor(`!!${sheet}?.querySelector('[data-cow-cap-trace="${parkNotice.id}"].cow-cur')`, { label: "the sheet again" });
  await page.key(" ");
  await waitUntil(async () => !(await traces()).some((notice) => notice.id === parkNotice.id), "acknowledged");
  const ack = (await capLog(20)).find((entry) => entry.event.kind === "acknowledged" && entry.event.noticeId === parkNotice.id);
  check("Space acknowledges it, signed by the page's key, and it is logged", ack !== undefined && ack.by === (await pageKeyNow()));
  await page.key("q");
  await page.waitFor(`!${sheet} && !${noticeEl(parkNotice.id)}`, { label: "the notice gone" });
  await page.key("u");
  await sleep(300);
  await page.key("y");
  await sleep(1500);
  check("u does not bring it back", !(await traces()).some((notice) => notice.id === parkNotice.id) && !(await page.eval(`!!${noticeEl(parkNotice.id)}`)));

  // -- an agent parks a thread that waited on nothing: no notice --
  const beforeIdle = (await traces()).map((notice) => notice.id);
  const idle = await cowAs(tmain, "park", tidle, "--reason", "later");
  await sleep(2000);
  check("parking a thread that waited on nothing leaves no notice", idle.code === 0 && !idle.stdout.includes("shown") && (await traces()).length === beforeIdle.length, idle.stdout + idle.stderr);

  // -- withdrawing an ask --
  const withdrawn = await askAs(task, null, "Withdraw me?");
  const beforeWithdraw = (await traces()).map((notice) => notice.id);
  await cowAs(task, "ask", "withdraw", withdrawn.id);
  const withdrawNotice = await newTrace(beforeWithdraw, "the withdrawal's notice");
  check("withdrawing an ask leaves a notice with its question", withdrawNotice.trace?.action === "withdrew" && withdrawNotice.trace?.askId === withdrawn.id && withdrawNotice.text === "“cow test” withdrew its ask: Withdraw me?", withdrawNotice.text);

  // -- closing as answered when the person has not written since --
  const quiet = await askAs(task, null, "Close me quietly?");
  const beforeClose = (await traces()).map((notice) => notice.id);
  await cowAs(task, "ask", "close", quiet.id, "--answered", "blue, they said");
  const closeNotice = await newTrace(beforeClose, "the close's notice");
  check(
    "closing an ask as answered when the person has not written since leaves a notice with the answer it claims",
    closeNotice.trace?.action === "closed" && closeNotice.text.includes("though you have not written to it since it asked: Close me quietly? · the answer it says you gave: blue, they said"),
    closeNotice.text,
  );

  // -- closing after the person did write: quiet --
  const answered = await askAs(task, null, "Answered in chat?");
  await sleep(1500);
  await tellAs(null, task, "red");
  await sleep(3000);
  await waitForThread(task, (t) => t.status === "idle", "its reply to the person");
  const beforeAnswered = (await traces()).map((notice) => notice.id);
  const closed = await cowAs(task, "ask", "close", answered.id, "--answered", "red");
  await sleep(2000);
  check("closing an ask the person answered in a message since leaves no notice", closed.code === 0 && (await traces()).length === beforeAnswered.length, closed.stdout + closed.stderr);

  // -- an ask under a parked thread: in the queue, saying what it is under; answering it resumes nothing --
  await rpc("park_set", { threadId: thead, park: { at: Date.now(), reason: "on hold", pickUp: { kind: "none" }, checkedAt: Date.now() } });
  const beforeKid = (await traces()).length;
  const under = await askAs(tkid, null, "Under the shelf?");
  const queued = `(document.querySelector('[data-cow-queue="${tkid}"] p')?.textContent ?? null)`;
  await page.waitFor(`${queued} !== null`, { label: "the ask under a parked thread in the queue" });
  check("an ask of a thread under a parked thread is in the queue, and says what it is under", (await page.eval(queued)).includes("asks you: Under the shelf? · under parked “cow test”"), await page.eval(queued));
  check(
    "its line is listed after the shelf, saying what it is under; the parked thread stays on the shelf",
    (await page.eval(`${lineEl(tkid)}?.querySelector("[data-cow-aside]")?.dataset.cowAside ?? null`)) === thead && (await page.eval(`${lineEl(thead)}?.dataset.cowState`)) === "parked",
  );
  check("parking by the page leaves no notice", (await traces()).length === beforeKid);
  await shot("trace-aside-ask");
  await page.eval(`${lineEl(tkid)}.click(); true`);
  await sleep(300);
  await page.key("a");
  await page.waitFor(`document.querySelector("[data-cow-ask-card]")?.dataset.cowAsk === "${under.id}"`, { label: "its ask card" });
  await page.key("1");
  await page.key("Enter");
  await waitUntil(async () => !(await openAsksOf(tkid)).some((ask) => ask.id === under.id), "the answer recorded");
  const all = (await rpc("asks_list", { threadId: tkid, all: true })).asks;
  check(
    "it is answered as any ask, and the thread above it stays parked",
    all.find((ask) => ask.id === under.id)?.status === "answered" && (await rpc("notes_list", { threadIds: [thead] })).parks[thead] !== undefined,
  );
  await page.waitFor(`!document.querySelector('[data-cow-queue="${tkid}"]')`, { label: "out of the queue" });
  check("answered, it leaves the queue", true);

  await clearTraces(ids);
  check("every notice about the fixtures is acknowledged at the end", (await traces()).length === 0);
}

async function waitingChecks(page, ids, shot, chooseMain) {
  await prepareWaiting(ids);
  await chooseMain(page, ids.wmain);
  await page.send("Page.bringToFront");
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const stateOf = (id) => `(${lineEl(id)}?.dataset.cowState ?? null)`;
  const waitOf = (id) => `(${lineEl(id)}?.dataset.cowWait ?? null)`;
  const inTree = (id) => `(${lineEl(id)}?.dataset.cowDepth !== undefined)`;
  const inQueue = (id) => `!!document.querySelector('[data-cow-queue="${id}"]')`;
  const doing = (id) => `(() => { const cell = ${lineEl(id)}?.querySelector(".cow-wh")?.cloneNode(true); cell?.querySelector(".cow-nx2")?.remove(); return cell?.textContent ?? ""; })()`;
  const pane = `(document.querySelector("[data-cow-pane]")?.dataset.cowPane ?? null)`;
  const select = async (id) => {
    await page.eval(`${lineEl(id)}.click(); true`);
    await sleep(200);
  };
  const waits = async () => (await rpc("notes_list", { threadIds: [ids.wkid] })).waits[ids.wkid] ?? null;
  const offset = async (ms) =>
    page.eval(`${ms === 0 ? `sessionStorage.removeItem("cow:test-clock-offset-ms")` : `sessionStorage.setItem("cow:test-clock-offset-ms", "${ms}")`};
      window.dispatchEvent(new Event("cow:test-clock")); true`);
  const DAY = 86_400_000;
  const kid = ids.wkid;

  // -- set by an agent --
  const stranger = await cowAs(ids.wother, "wait", kid, "--on", "the reviewer");
  check("bb cow wait: a thread may not set it on a thread that is not under it", stranger.code !== 0 && /only for itself/.test(stranger.stderr), stranger.stderr.trim());
  const vague = await cowAs(ids.wmain, "wait", kid, "--on", "CI", "--remind", "when CI is green");
  check("bb cow wait: a reminder in words is refused", vague.code !== 0 && /a reminder is a day/.test(vague.stderr), vague.stderr.trim());
  const set = await cowAs(ids.wmain, "wait", kid, "--on", "the reviewer", "--for", "an approving review");
  check("bb cow wait: the thread above it sets it", set.code === 0, set.stderr.trim());
  await page.waitFor(`${stateOf(kid)} === "waiting"`, { label: "the line waiting" });
  check(
    "a waiting line keeps its place in the tree, says on whom and for how long, and is not in the queue",
    (await page.eval(inTree(kid))) && /waiting on the reviewer: an approving review · \d+[mhdw]/.test(await page.eval(doing(kid))) && !(await page.eval(inQueue(kid))),
    await page.eval(doing(kid)),
  );
  check("it has the waiting mark", await page.eval(`!!${lineEl(kid)}?.querySelector("svg.cow-s-waiting")`));
  const status = (await cow("status", "--main", ids.wmain)).stdout;
  check("bb cow status shows it waiting", status.includes(`(${kid})`) && /waiting\s+\S+\s+cow test \(thr_\w+\)\s+waiting on the reviewer/.test(status));
  await shot("waiting");

  // -- a new turn clears it; waiting outranks a reply --
  await tellAs(null, kid, "hello");
  await sleep(3000);
  await waitForThread(kid, (t) => t.status === "idle", "its reply");
  await page.waitFor(`${stateOf(kid)} === "wants" && ${inQueue(kid)}`, { label: "its reply waiting on the person", timeout: 30_000 });
  check("a new turn clears the wait, and its reply waits on the person", (await page.eval(waitOf(kid))) === null);
  await cowAs(ids.wmain, "wait", kid, "--on", "CI");
  await page.waitFor(`${stateOf(kid)} === "waiting" && !${inQueue(kid)}`, { label: "waiting again" });
  check("set again, waiting outranks the reply addressed to the person: it leaves the queue", true);

  // -- w clears it, u puts it back --
  await select(kid);
  await page.key("w");
  await page.waitFor(`${mode} === "wait"`, { label: "the clear prompt" });
  await page.key("y");
  await page.waitFor(`${stateOf(kid)} === "wants" && ${inQueue(kid)}`, { label: "cleared" });
  check("w on a waiting line clears it, after y: its reply is back in the queue", (await waits()) === null);
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${stateOf(kid)} === "waiting"`, { label: "the wait back" });
  check("u puts the wait back", (await waits())?.on === "CI");

  // -- w sets it from the page, with a reminder; the reminder comes --
  await cow("wait", kid, "--clear");
  await page.waitFor(`${stateOf(kid)} === "wants"`, { label: "cleared from the CLI" });
  await select(kid);
  await page.key("w");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "wait-on"`, { label: "who it waits on" });
  await page.type("the reviewer");
  await page.key("Enter");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "wait-remind"`, { label: "the reminder" });
  await page.type("+3d");
  await page.key("Enter");
  await page.waitFor(`${stateOf(kid)} === "waiting" && ${waitOf(kid)} === ""`, { label: "waiting with a reminder" });
  const stored = await waits();
  check("w asks who or what, then a reminder; the note is stored with the day", stored?.on === "the reviewer" && Math.abs((stored?.remindAt ?? 0) - (Date.now() + 3 * DAY)) < DAY && !(await page.eval(inQueue(kid))), JSON.stringify(stored));
  await offset(4 * DAY);
  await page.waitFor(`${inQueue(kid)} && ${waitOf(kid)} === "due"`, { label: "the reminder in the queue" });
  const queued = await page.eval(`document.querySelector('[data-cow-queue="${kid}"]')?.textContent ?? ""`);
  check("when the reminder comes the line enters the queue: still waiting on whom, after how long", /still waiting on the reviewer after 4 days/.test(queued), queued);
  await shot("waiting-due");
  await select(kid);
  await page.key("a");
  await page.waitFor(`!!document.querySelector("[data-cow-wait-due]")`, { label: "keep or take back" });
  await page.key("2");
  await page.waitFor(`${stateOf(kid)} === "wants" && ${waitOf(kid)} === null`, { label: "back with the person" });
  check("a on it, then 2: it is back with the person, and the note is gone", (await waits()) === null);
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${waitOf(kid)} === "due"`, { label: "the reminder back" });
  check("u takes that back", true);
  await page.key("a");
  await page.waitFor(`!!document.querySelector("[data-cow-wait-due]")`, { label: "keep or take back again" });
  await page.key("1");
  await page.waitFor(`document.activeElement?.dataset.cowInput === "wait-remind"`, { label: "a new reminder" });
  await page.type("+2w");
  await page.key("Enter");
  await page.waitFor(`${waitOf(kid)} === "" && !${inQueue(kid)}`, { label: "kept waiting" });
  check("a, then 1 and a new reminder: it keeps waiting, out of the queue", (await waits())?.on === "the reviewer");
  await offset(0);

  // -- a line marked seen stays where it is --
  await cow("wait", kid, "--clear");
  await page.waitFor(`${stateOf(kid)} === "wants" && ${inQueue(kid)}`, { label: "the reply waiting" });
  await select(kid);
  await page.key(" ");
  await page.waitFor(`${stateOf(kid)} === "done"`, { label: "seen" });
  check(
    "Space: the line is done and out of the queue, but stays in the tree, kept and dimmed, with the cursor on it",
    (await page.eval(inTree(kid))) && (await page.eval(`${lineEl(kid)}?.dataset.cowStays === ""`)) && (await page.eval(isCursor(kid))) && !(await page.eval(inQueue(kid))),
  );
  await shot("seen-stays");
  await page.key("u");
  await page.key("y");
  await page.waitFor(`${stateOf(kid)} === "wants"`, { label: "seen taken back" });
  check("u takes the mark back, in place", await page.eval(inTree(kid)));
  await page.key(" ");
  await page.waitFor(`${stateOf(kid)} === "done"`, { label: "seen again" });
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`${screen} === "overview" && !!document.querySelector('[data-cow-line="${kid}"]')`, { label: "the page reloaded" });
  check("after a reload it is where its state puts it: under To settle", !(await page.eval(inTree(kid))) && (await page.eval(`${lineEl(kid)}?.dataset.cowSettle === ""`)));

  // -- a link to a thread in the chat --
  await select(ids.wlink);
  await page.key("Enter");
  const mention = (id) => `[...document.querySelectorAll('[data-cow-chat] a[data-prompt-mention-resource]')].filter((a) => (a.getAttribute("data-prompt-mention-resource") ?? "").includes('"${id}"')).pop()`;
  await page.waitFor(`${pane} === "${ids.wlink}" && !!${mention(kid)} && !!${mention(ids.wother)}`, { label: "the linker's chat with its mentions", timeout: 30_000 });
  await clickSettled(page, mention(kid), "the mention of the waiting thread");
  await page.waitFor(`${pane} === "${kid}"`, { label: "the pane on the linked thread" });
  check(
    "a click on a thread mention switches the pane to that thread, and its line takes the cursor",
    (await page.eval(isCursor(kid))) && (await page.eval(`location.pathname`)).includes(`/plugins/${PLUGIN}/`) && (await page.eval(`!document.querySelector("[data-cow-pane-outside]")`)),
  );
  await page.key("Escape");
  await page.waitFor(`${pane} === "${ids.wlink}"`, { label: "back to the linker" });
  check("Escape goes back to the chat the link was followed from", true);
  await page.waitFor(`!!${mention(ids.wother)}`, { label: "the mentions again", timeout: 30_000 });
  await page.key("f");
  await page.waitFor(`document.querySelectorAll("[data-cow-hint-label]").length > 0`, { label: "hints" });
  const label = await page.eval(`[...document.querySelectorAll("[data-cow-hint-label]")].filter((tag) => tag.dataset.cowHintIn === "chat" && (tag.dataset.cowHintFor ?? "").endsWith("/threads/${ids.wother}")).pop()?.dataset.cowHintLabel ?? null`);
  if (label) for (const letter of label) await page.key(letter);
  else await page.key("Escape");
  await page.waitFor(`${pane} === "${ids.wother}"`, { label: "the pane on a thread not under Main" }).catch(() => undefined);
  check("a hint on a mention of a thread not under this Main opens it in the pane, and its header says so", (await page.eval(pane)) === ids.wother && (await page.eval(`!!document.querySelector("[data-cow-pane-outside]")`)), String(label));
  await shot("link-outside");
  await page.key("Escape");
  await page.waitFor(`${pane} === "${ids.wlink}"`, { label: "back again" });
  await page.key("Escape");
  await page.waitFor(`${pane} === null`, { label: "the pane closed" });
  check("then Escape closes the pane", true);
  // A click with a modifier is bb's: cow does not take it. The listener on the link keeps bb from acting on it here.
  await select(ids.wlink);
  await page.key("Enter");
  await page.waitFor(`${pane} === "${ids.wlink}" && !!${mention(kid)}`, { label: "the linker's chat again", timeout: 30_000 });
  const leftToBb = await page.eval(`(() => {
    const a = ${mention(kid)};
    let reached = null;
    a.addEventListener("click", (event) => { reached = !event.defaultPrevented; event.preventDefault(); event.stopPropagation(); }, { once: true });
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    return reached;
  })()`);
  await sleep(500);
  check("a click with Shift on a thread mention is left to bb", leftToBb === true && (await page.eval(pane)) === ids.wlink);
  await page.key("Escape");
}

/**
 * A click of the mouse on the middle of an element, once it has stopped
 * moving and is the thing at that point. Scrolled into view, the chat goes on
 * settling for a moment as rows above it are measured, and a point measured
 * too soon lands beside the element, on nothing.
 */
async function clickSettled(page, expression, label) {
  const centre = `(() => { const e = ${expression}; if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.eval(`${expression}?.scrollIntoView({ block: "center" }); true`);
    let at = await page.eval(centre);
    for (let i = 0; i < 30; i += 1) {
      await sleep(150);
      const now = await page.eval(centre);
      if (at && now && Math.abs(now[0] - at[0]) < 1 && Math.abs(now[1] - at[1]) < 1) break;
      at = now;
    }
    if (!at) throw new Error(`nothing to click: ${label}`);
    const hit = await page.eval(`(() => { const e = ${expression}; const there = document.elementFromPoint(${at[0]}, ${at[1]}); return !!e && !!there && e.contains(there); })()`);
    if (hit) return page.click(...at);
  }
  throw new Error(`${label} is not what is under its own middle`);
}

/** Removes what the capability checks made outside bb's threads. */
let restoreCaps = async () => undefined;

const capState = () => rpc("caps_state", null);
/** The log, newest first, with everything in it. */
const fullLog = async (limit = 60) => (await rpc("caps_log", { limit })).entries;
/** What the page signs when a line is only marked: a reply seen, a refusal dismissed, a brief read, a Main chosen. */
const MARK_KINDS = ["seen", "refusals-dismissed", "brief-read", "main-chosen"];
/** The log without those marks, so that "the newest entry" means the newest thing done about a capability, a request, an ask or a key. */
const capLog = async (limit = 60) => (await fullLog(500)).filter((entry) => !MARK_KINDS.includes(entry.event.kind)).slice(0, limit);
/** The key of this check's browser, and the newest mark of one kind it signed for a thread. */
const pageKeyNow = async () => (await signer.state()).keys.find((key) => /headless Chrome/.test(key.label))?.fingerprint ?? null;
const markBy = async (kind, threadId) => (await fullLog(200)).find((entry) => entry.event.kind === kind && entry.event.threadId === threadId) ?? null;
const lastApproval = async (id) => {
  const events = await api(`/threads/${id}/events?types=system/interaction/lifecycle&limit=20&order=desc`);
  return events.map((event) => event.data?.interaction).find((interaction) => interaction?.resolution) ?? null;
};
const pendingOf = async (id) => (await api(`/threads/${id}/interactions`)).filter((interaction) => interaction.status === "pending");

/** Every capability that applies to a fixture is deleted, and every notice about a fixture acknowledged: nothing else is touched. */
async function clearCaps(ids) {
  if (signer === null) return;
  await ownKey();
  const ours = new Set(Object.values(ids));
  const state = await capState();
  const mine = state.capabilities.filter((capability) => ours.has(capability.scope.threadId));
  for (const capability of mine) if (capability.deletedAt === null) await signer.must("cap_delete", { id: capability.id });
  const gone = new Set(mine.map((capability) => capability.id));
  for (const notice of (await capState()).notices) {
    if ((notice.capabilityId && gone.has(notice.capabilityId)) || (notice.threadId && ours.has(notice.threadId))) await signer.must("cap_ack", { noticeId: notice.id });
  }
}

async function prepareCaps(ids) {
  for (const name of CAPPED) await waitForThread(ids[name], (t) => t.status === "idle" || t.hasPendingInteraction, `${name} at rest`);
  for (const name of ["chead", "ckid"]) {
    for (const interaction of await pendingOf(ids[name])) await bb("thread", "interactions", "deny", interaction.id, ids[name]);
    for (const ask of await openAsksOf(ids[name])) await cow("ask", "withdraw", ask.id);
    await waitForThread(ids[name], (t) => t.status === "idle" && !t.hasPendingInteraction, `${name} idle`);
    // A message from the user clears whatever bb refused this fixture in an earlier run.
    await tellAs(null, ids[name], "reset");
  }
  await sleep(2500);
  for (const name of CAPPED) {
    await waitForThread(ids[name], (t) => t.status === "idle", `${name} idle after the reset`);
    const end = (await api(`/threads/${ids[name]}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
    if (end !== undefined) await signer.must("seen_set", { threadId: ids[name], seen: { seq: end, at: Date.now() } });
  }
  // The denials above were made outside cow, which flags them a moment later.
  await sleep(1500);
  await clearCaps(ids);
  const scratch = `/tmp/cow-caps-${Date.now()}`;
  const other = `/tmp/cow-caps-other-${Date.now()}`;
  mkdirSync(scratch, { recursive: true });
  restoreCaps = async () => {
    await clearCaps(ids);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  };
  return { scratch, other, home: (await capState()).places.home };
}

async function capsChecks(page, ids, shot, chooseMain) {
  const { scratch, other, home } = await prepareCaps(ids);
  await chooseMain(page, ids.cmain);
  await page.send("Page.bringToFront");
  const { chead, ckid } = ids;
  const lineEl = (id) => `document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const stateOf = (id) => `(${lineEl(id)}?.dataset.cowState ?? null)`;
  const doing = (id) => `(() => { const cell = ${lineEl(id)}?.querySelector(".cow-wh")?.cloneNode(true); cell?.querySelector(".cow-nx2")?.remove(); return cell?.textContent ?? ""; })()`;
  const nextOf = (id) => `(${lineEl(id)}?.querySelector(".cow-nx")?.textContent ?? "")`;
  const message = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const steps = `document.querySelector("[data-cow-capsteps]")`;
  const stage = `(${steps}?.dataset.cowCapstepsStage ?? null)`;
  const stepError = `(document.querySelector("[data-cow-capsteps-error]")?.textContent ?? "").trim()`;
  const field = (name) => `document.querySelector('[data-cow-input="${name}"]')`;
  const sheet = `document.querySelector('[data-cow-sheet="capabilities"]')`;
  const sheetNote = `(${sheet}?.querySelector("[data-cow-sheet-note]")?.textContent ?? "")`;
  const sheetCursor = `(${sheet}?.querySelector(".cow-cap-row.cow-cur")?.dataset.cowCap ?? ${sheet}?.querySelector(".cow-cap-row.cow-cur")?.dataset.cowKey ?? null)`;
  const capMark = (id) => `(${lineEl(id)}?.querySelector("[data-cow-capmark]")?.dataset ?? null)`;
  const mark = async (id) => JSON.parse(await page.eval(`JSON.stringify(${capMark(id)} ? { held: ${capMark(id)}.cowCapmark, fresh: ${capMark(id)}.cowCapmarkNew ?? null, count: ${capMark(id)}.cowAllowedCount } : null)`));
  const select = async (id) => {
    // Main is the page's heading, not a line in the list.
    await page.eval(`${id === ids.cmain ? `document.querySelector(".cow-mainline")` : lineEl(id)}.click(); true`);
    await sleep(200);
    if (!(await page.eval(isCursor(id)))) throw new Error(`could not select ${id}`);
  };
  /** Replace what a field of the steps holds. */
  const fill = async (name, text) => {
    await page.waitFor(`document.activeElement === ${field(name)}`, { label: `the ${name} field focused` });
    await page.eval(`${field(name)}.select(); true`);
    if (text === "") await page.key("Backspace");
    else await page.type(text);
  };
  const sayTo = async (id, text) => {
    await select(id);
    await page.key("I");
    await page.type(text);
    await page.key("Enter");
    await page.waitFor(`${message}.startsWith("said to")`, { label: "the message sent" });
  };
  /** The fixture at rest, and its reply seen, as the user would see it. */
  const settle = async (id) => {
    await sleep(1500);
    await waitForThread(id, (t) => t.status === "idle" && !t.hasPendingInteraction, "at rest", 120_000);
    const end = (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
    if (end !== undefined) await signer.must("seen_set", { threadId: id, seen: { seq: end, at: Date.now() } });
    await page.waitFor(`${lineEl(id)}?.dataset.cowReply === undefined && !${stateOf(id)}?.startsWith("run")`, { label: "its reply seen", timeout: 30_000 }).catch(() => undefined);
  };
  const said = async (id) => ((await api(`/threads/${id}/output`)).output ?? "").trim();
  const waitFile = async (path, timeout = 120_000) => {
    const deadline = Date.now() + timeout;
    while (!existsSync(path) && Date.now() < deadline) await sleep(500);
    return existsSync(path);
  };
  const byName = async (name) => (await capState()).capabilities.find((capability) => capability.name === name && capability.deletedAt === null) ?? null;
  const openCard = async (id, what) => {
    await select(id);
    await page.key("a");
    await page.waitFor(what, { label: "the card" });
  };

  await page.waitFor(`!!${lineEl(chead)} && !!${lineEl(ckid)}`, { label: "the capability fixtures on the page", timeout: 30_000 });
  check("with no capability, no line carries the mark and the queue holds no notice", (await mark(chead)) === null && (await mark(ckid)) === null && !(await page.eval(`!!document.querySelector("[data-cow-notice]")`)));

  // -- the page's key: enrolled by first use ------------------------------------
  const banner = `document.querySelector("[data-cow-key-status]")`;
  const bannerOf = async (tab) => JSON.parse(await tab.eval(`JSON.stringify(${banner} ? { status: ${banner}.dataset.cowKeyStatus, key: ${banner}.dataset.cowKeyFingerprint, text: ${banner}.textContent } : null)`));
  const keyKinds = async (count) => (await capLog(count)).map((entry) => [entry.event.kind, entry.by]);
  const userRows = async (id) => (await api(`/threads/${id}/timeline`)).rows.filter((entry) => entry.kind === "conversation" && entry.role === "user");
  /** Put the cursor on a line of the sheet, as a click does. */
  const sheetRow = async (tab, selector) => {
    await tab.waitFor(`!!${sheet}?.querySelector('${selector}')`, { label: `the sheet's line ${selector}` });
    await tab.eval(`${sheet}.querySelector('${selector}').click(); true`);
    await sleep(200);
  };
  const pageKey = (await signer.state()).keys.find((key) => /headless Chrome/.test(key.label))?.fingerprint;
  const resetPath = await signer.resetEnrollment();
  await page.waitFor(`${banner}?.dataset.cowKeyStatus === "first"`, { label: "the page enrolled by first use", timeout: 20_000 });
  const firstUse = await bannerOf(page);
  let keyState = await signer.state();
  check(
    "with no key enrolled, the first page to open cow enrols its key, says so plainly, and shows the key's fingerprint",
    firstUse.key === pageKey && firstUse.text.includes(`This page's key ${pageKey} is now enrolled, by first use.`) && keyState.keys.length === 1 && keyState.keys[0].fingerprint === pageKey && keyState.keys[0].how === "first",
    firstUse.text.slice(0, 160),
  );
  check("the reset and the enrollment are both in the log", JSON.stringify(await keyKinds(2)) === JSON.stringify([["key-enrolled", null], ["enrollment-reset", null]]), JSON.stringify(await keyKinds(2)));
  await shot("keys-first-use");
  // -- a notice above the list never takes the list's room ----------------------
  /** The height of the page, of the notice above the list, and of the list (with the queue beside or above it), in two window sizes. */
  const roomAt = async (tab) => {
    const seen = {};
    for (const [width, height] of [[1280, 800], [700, 800]]) {
      await tab.resize(width, height);
      await sleep(1200);
      seen[width] = JSON.parse(await tab.eval(`(() => { const app = document.querySelector(".cow-app"), body = document.querySelector(".cow-app > .cow-body"), note = ${banner}; return JSON.stringify({ app: app?.clientHeight ?? 0, list: Math.round(body?.getBoundingClientRect().height ?? 0), notice: Math.round(note?.getBoundingClientRect().height ?? 0), parts: [...(app?.children ?? [])].map((el) => el.className.split(" ")[0] + ":" + Math.round(el.getBoundingClientRect().height)).join(" "), verbRows: [...document.querySelectorAll(".cow-foot .cow-verbs")].map((el) => Math.round(el.getBoundingClientRect().top)).join(","), sentences: (note?.textContent ?? "").split(/[.:] /).length }); })()`));
    }
    await tab.resize(1440, 900);
    await sleep(1200);
    return seen;
  };
  const roomy = (seen) => Object.values(seen).every((at) => at.notice > 0 && at.app > 500 && at.list >= at.app * 0.7);
  const firstRoom = await roomAt(page);
  check("with the first-use notice showing, the list keeps most of the page's height, at 1280x800 and at 700 wide", roomy(firstRoom), JSON.stringify(firstRoom));
  check("the first-use notice is short: the fingerprint, two sentences, and where to look later", firstUse.text.length < 330 && firstUse.text.includes("C lists the keys") && firstUse.text.includes("?"), `${firstUse.text.length} characters`);
  await page.eval(`document.querySelector("[data-cow-key-dismiss]").click(); true`);
  await page.waitFor(`!${banner}`, { label: "the notice put away" });

  // -- another key asks, and is approved from the enrolled page -----------------
  const asked = await signer.enrol();
  const meanwhile = await signer.call("cap_ack", { noticeId: "note_none" });
  check("a key that is not enrolled can ask to be, and can do nothing until it is", asked === "pending" && meanwhile.ok === false && /is not enrolled with cow/.test(meanwhile.error?.message ?? ""), `${asked} ${meanwhile.error?.message}`);
  await page.waitFor(`!!document.querySelector('[data-cow-key-waiting="${signer.fingerprint}"]')`, { label: "the request in the queue" });
  check("the enrolled page shows the request in its queue, with the key that asks", (await page.eval(`document.querySelector('[data-cow-key-waiting="${signer.fingerprint}"] p').textContent`)).includes(`a page asks to act as you: key ${signer.fingerprint}`));
  await shot("keys-request-queue");
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet, for its keys" });
  await sheetRow(page, `[data-cow-key-request="${signer.fingerprint}"]`);
  await page.key("Enter");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-sheet-confirm="approve"]')`, { label: "the approval, to confirm" });
  const approveText = await page.eval(`${sheet}.querySelector("[data-cow-sheet-confirm]").textContent`);
  await shot("keys-approve");
  await page.key("n");
  check("approving asks first, naming the key; any key but y leaves it waiting", approveText.includes(`Enrol the key ${signer.fingerprint}?`) && (await signer.state()).requests.some((request) => request.fingerprint === signer.fingerprint && request.status === "pending"));
  await page.key("Enter");
  await page.key("y");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-key="${signer.fingerprint}"]')`, { label: "the key enrolled" });
  keyState = await signer.state();
  const approved = keyState.keys.find((key) => key.fingerprint === signer.fingerprint);
  const works = await signer.call("key_remove", { fingerprint: "0000-0000-0000-0000" });
  check(
    "approved from the enrolled page by a signed call, the key is enrolled, the log names the key that approved it, and its calls are now accepted",
    approved?.how === "approved" && approved.approvedBy === pageKey && JSON.stringify((await keyKinds(1))[0]) === JSON.stringify(["key-enrolled", pageKey]) && works.ok === false && /there is no key 0000/.test(works.error?.message ?? ""),
    JSON.stringify([approved?.how, approved?.approvedBy, works.error?.message]),
  );
  check("the sheet lists the enrolled keys, and marks this page's own", (await page.eval(`${sheet}.querySelectorAll("[data-cow-key]").length`)) === 2 && (await page.eval(`${sheet}.querySelector("[data-cow-key-mine]")?.dataset.cowKey`)) === pageKey && (await page.eval(`${sheet}.querySelector("[data-cow-key-own]").textContent`)).includes(`This page's key is ${pageKey}, and it is enrolled.`));
  await shot("keys-sheet");
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });

  // -- a second browser: it waits, explains itself, is approved, and then works ---
  const openOther = async () => {
    const tab = await newContextTab(PORT);
    await tab.resize(1440, 900);
    await tab.goto(`${BB}/plugins/${PLUGIN}/main`);
    await tab.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page in another browser", timeout: 60_000 });
    await chooseMain(tab, ids.cmain);
    await tab.waitFor(`!!${banner}`, { label: "its key's standing", timeout: 20_000 });
    return tab;
  };
  const sayFrom = async (tab, text) => {
    await tab.key("i");
    await tab.type(text);
    await tab.key("Enter");
    await sleep(1200);
    return tab.eval(message);
  };
  const otherTab = await openOther();
  const waitingPage = await bannerOf(otherTab);
  const mainRows = (await userRows(ids.cmain)).length;
  check(
    "a page whose key is not enrolled says so loudly: the person's actions are held by a key that is not this page's, with its own key and how to reset",
    waitingPage.status === "pending" && waitingPage.key !== pageKey && /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(waitingPage.key) && waitingPage.text.includes("cow's person-only actions are held by a key that is not this page's.") && waitingPage.text.includes(`touch ${resetPath}`),
    waitingPage.text.slice(0, 200),
  );
  await shot("keys-unenrolled", otherTab);
  const waitingRoom = await roomAt(otherTab);
  check("with the not-enrolled notice showing, the list keeps most of the page's height, at 1280x800 and at 700 wide", roomy(waitingRoom), JSON.stringify(waitingRoom));
  // What takes a line out of the queue is signed too: on this page Space marks nothing, and says why.
  const headEnd = (await api(`/threads/${chead}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq;
  await signer.must("seen_set", { threadId: chead, seen: null });
  let notSeen = "";
  try {
    await otherTab.waitFor(`${lineEl(chead)}?.dataset.cowReply === ""`, { label: "a reply waiting, on the page that is not enrolled", timeout: 20_000 });
    await otherTab.eval(`${lineEl(chead)}.click(); true`);
    await sleep(200);
    await otherTab.key(" ");
    await otherTab.waitFor(`(document.querySelector("[data-cow-message]")?.textContent ?? "").startsWith("not marked as seen")`, { label: "why it was not marked", timeout: 10_000 });
    notSeen = await otherTab.eval(`document.querySelector("[data-cow-message]")?.textContent ?? ""`);
  } catch (cause) {
    notSeen = `(${cause instanceof Error ? cause.message : String(cause)})`;
  }
  check(
    "on a page that is not enrolled, Space on a reply marks nothing and says why: this page can only read",
    /not marked as seen: this page's key .* is not enrolled, so this page can only read/.test(notSeen) && ((await rpc("notes_list", { threadIds: [chead] })).seen[chead] ?? null) === null,
    notSeen.slice(0, 160),
  );
  if (headEnd !== undefined) await signer.must("seen_set", { threadId: chead, seen: { seq: headEnd, at: Date.now() } });
  const refusedSay = await sayFrom(otherTab, "this must not be sent");
  await otherTab.key("Escape");
  check("its verbs explain themselves instead of acting: saying something to Main is not sent, and says why and how to get enrolled", /^not sent: this page's key .* is not enrolled, so this page can only read\. Approve it from a page that is enrolled/.test(refusedSay) && (await userRows(ids.cmain)).length === mainRows, refusedSay);
  await otherTab.key("C");
  await otherTab.waitFor(`!!${sheet}`, { label: "the sheet in the other browser" });
  check("it can still read everything: the sheet opens, and says the same about its key", (await otherTab.eval(`${sheet}.querySelector("[data-cow-key-own]")?.dataset.cowKeyOwnStatus`)) === "pending" && (await otherTab.eval(`${sheet}.querySelectorAll("[data-cow-key]").length`)) === 2);
  await otherTab.key("n");
  await otherTab.waitFor(`${stage} === "kind"`, { label: "the steps in the other browser" });
  await otherTab.key("2");
  await otherTab.key("Enter");
  await otherTab.type("echo not enrolled");
  await otherTab.key("Enter");
  await otherTab.key("Enter");
  await otherTab.key("Enter");
  await otherTab.key("1");
  await otherTab.key("Enter");
  await otherTab.key("Enter");
  await otherTab.waitFor(`${stepError}.startsWith("not saved")`, { label: "the refusal to save" });
  check("making a capability from it is refused the same way, and nothing is made", /not saved: this page's key .* is not enrolled/.test(await otherTab.eval(stepError)) && (await capState()).capabilities.every((capability) => capability.deletedAt !== null || capability.rule.text !== "echo not enrolled"), await otherTab.eval(stepError));
  await otherTab.key("Escape");
  await otherTab.key("Escape");
  await otherTab.key("Escape");
  await otherTab.key("Escape");
  await otherTab.key("Escape");
  await otherTab.key("Escape");
  await otherTab.key("q");
  await page.waitFor(`!!document.querySelector('[data-cow-key-waiting="${waitingPage.key}"]')`, { label: "the second browser's request" });
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet, to approve it" });
  await sheetRow(page, `[data-cow-key-request="${waitingPage.key}"]`);
  await page.key("Enter");
  await page.key("y");
  await otherTab.waitFor(`!${banner}`, { label: "the second browser enrolled", timeout: 20_000 });
  await page.key("q");
  const saidFrom = await sayFrom(otherTab, "said from the second browser");
  const lastRow = (await userRows(ids.cmain)).at(-1);
  check(
    "approved, the second browser's page works: what it says to Main is sent as the person, and the log names its key",
    saidFrom.startsWith("said to") && lastRow?.text === "said from the second browser" && lastRow.initiator === "user" && JSON.stringify((await keyKinds(1))[0]) === JSON.stringify(["sent", waitingPage.key]),
    `${saidFrom} ${JSON.stringify(await keyKinds(1))}`,
  );
  await settle(ids.cmain);

  // -- a third: refused -------------------------------------------------------------
  const thirdTab = await openOther();
  const thirdKey = (await bannerOf(thirdTab)).key;
  await page.waitFor(`!!document.querySelector('[data-cow-key-waiting="${thirdKey}"]')`, { label: "the third browser's request" });
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet, to refuse it" });
  await sheetRow(page, `[data-cow-key-request="${thirdKey}"]`);
  await page.key("x");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-sheet-confirm="refuse"]')`, { label: "the refusal, to confirm" });
  await page.key("y");
  await thirdTab.waitFor(`${banner}?.dataset.cowKeyStatus === "refused"`, { label: "the third browser refused", timeout: 20_000 });
  const refusedPage = await sayFrom(thirdTab, "this must not be sent either");
  check(
    "refused, the page says so, still cannot act, and is out of the queue; the refusal is logged with the key that refused",
    /was refused, so this page can only read/.test(refusedPage) && (await userRows(ids.cmain)).at(-1)?.text === "said from the second browser" && !(await page.eval(`!!document.querySelector('[data-cow-key-waiting="${thirdKey}"]')`)) && JSON.stringify((await keyKinds(1))[0]) === JSON.stringify(["key-refused", pageKey]),
    refusedPage,
  );
  await thirdTab.close();
  // The second browser's key is removed again: a removed key can do nothing at once.
  await sheetRow(page, `[data-cow-key="${waitingPage.key}"]`);
  await page.key("x");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-sheet-confirm="remove"]')`, { label: "the removal, to confirm" });
  await page.key("y");
  await otherTab.waitFor(`!!${banner}`, { label: "the second browser, no longer enrolled", timeout: 20_000 });
  check("x removes an enrolled key after y, and the page that held it can only read again", !(await signer.state()).keys.some((key) => key.fingerprint === waitingPage.key) && /not sent/.test(await sayFrom(otherTab, "nor this")));
  await otherTab.close();
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });
  for (const request of (await signer.state()).requests) await signer.must("key_remove", { fingerprint: request.fingerprint });

  // -- from a permission card: allow once, and save as a capability ---------
  const first = `${scratch}/one/a.txt`;
  await sayTo(chead, `write: ${first}`);
  await waitForThread(chead, (t) => t.hasPendingInteraction, "asking to write", 120_000);
  await page.waitFor(`${doing(chead)}.includes("permission to change a file")`, { label: "the request on its line" });
  await openCard(chead, `!!document.querySelector("[data-cow-permission-diff]")`);
  const saveDigit = await page.eval(`document.querySelector("[data-cow-permission-save]")?.dataset.cowPermissionSave ?? null`);
  check("the permission card offers, after bb's own choices, to allow once and save as a capability", saveDigit === "5" && (await page.eval(`document.querySelectorAll("[data-cow-permission-action]").length`)) === 4, String(saveDigit));
  await page.key(saveDigit);
  check("its digit only marks it: nothing is decided or saved", (await page.eval(`document.querySelector("[data-cow-permission-save]").dataset.cowChosen`)) === "true" && (await pendingOf(chead)).length === 1 && (await capState()).capabilities.filter((c) => c.scope.threadId === chead && c.deletedAt === null).length === 0);
  await shot("caps-card-save");
  await page.key("Enter");
  await page.waitFor(`${stage} === "rule"`, { label: "the steps" });
  check("Enter opens the steps under the line, proposing the directory of the file", (await page.eval(`${field("cap-rule")}?.value`)) === `${scratch}/one` && (await page.eval(mode)) === "cap", await page.eval(`${field("cap-rule")}?.value`));

  // A refused directory, three ways, each with its reason.
  await fill("cap-rule", "/");
  await page.key("Enter");
  const rootRefusal = await page.eval(stepError);
  await fill("cap-rule", "scratch/one");
  await page.key("Enter");
  const relativeRefusal = await page.eval(stepError);
  await fill("cap-rule", `${home}/.ssh`);
  await page.key("Enter");
  const sshRefusal = await page.eval(stepError);
  await fill("cap-rule", `${scratch}/one/../..`);
  await page.key("Enter");
  const dotsRefusal = await page.eval(stepError);
  check(
    "a directory that is the root, relative, a credentials directory, or has .. in it is refused with the reason, and the steps stay on the rule",
    /root of the filesystem/.test(rootRefusal) && /relative/.test(relativeRefusal) && /SSH keys/.test(sshRefusal) && /\.\./.test(dotsRefusal) && (await page.eval(stage)) === "rule",
    [rootRefusal, relativeRefusal, sshRefusal, dotsRefusal].join(" | "),
  );
  await shot("caps-steps-refused");
  // Widened to the parent: everything under the scratch directory.
  await fill("cap-rule", `${scratch}/`);
  await page.key("Enter");
  await page.waitFor(`${stage} === "name"`, { label: "the name step" });
  check("the rule is shown as it will be stored, and a name is proposed", (await page.eval(`document.querySelector('[data-cow-capsteps-done="rule"] code')?.textContent`)) === scratch && (await page.eval(`${field("cap-name")}?.value`)).startsWith("write cow-caps-"));
  await fill("cap-name", "");
  await page.key("Enter");
  check("a capability needs a name", /needs a name/.test(await page.eval(stepError)) && (await page.eval(stage)) === "name");
  await fill("cap-name", "cow test scratch");
  await page.key("Enter");
  await page.waitFor(`${stage} === "note"`, { label: "the note step" });
  await page.type("for the end-to-end check");
  await page.key("Enter");
  await page.waitFor(`${stage} === "scope"`, { label: "who it applies to" });
  const scopes = await page.eval(`JSON.stringify([...document.querySelectorAll("[data-cow-cap-scope]")].map((o) => o.dataset.cowCapScope))`);
  await page.key("Enter");
  check("who it applies to is one of three, and has to be chosen", scopes === '["thread","subtree","main"]' && (await page.eval(stage)) === "scope" && /choose who/.test(await page.eval(stepError)), scopes);
  await page.key("2");
  await page.key("Enter");
  await page.waitFor(`${stage} === "restate"`, { label: "the sentence" });
  const sentence = await page.eval(`document.querySelector("[data-cow-capsteps-restate] b")?.textContent ?? ""`);
  check(
    "the last step says in one sentence exactly what will be allowed for whom, and nothing is saved or decided yet",
    sentence === `The thread “${TITLE}” and every thread under it, now and later, may create and change files anywhere under ${scratch}, each time bb asks, without asking you.` &&
      (await byName("cow test scratch")) === null &&
      (await pendingOf(chead)).length === 1 &&
      !existsSync(first),
    sentence,
  );
  await shot("caps-steps-restate");
  await page.key("Escape");
  check("Escape goes back a step, keeping what was chosen", (await page.eval(stage)) === "scope" && (await page.eval(`document.querySelector('[data-cow-cap-scope="subtree"]').dataset.cowChosen`)) === "true");
  await page.key("Enter");
  await page.waitFor(`${stage} === "restate"`, { label: "the sentence again" });
  await page.key("Enter");
  await page.waitFor(`!${steps} && ${message}.startsWith("saved")`, { label: "saved" });
  const madeScratch = await byName("cow test scratch");
  check(
    "the second Enter saves it: the rule, the name, the note, who it applies to and how it was made",
    madeScratch?.rule.dir === scratch && madeScratch.scope.kind === "subtree" && madeScratch.scope.threadId === chead && madeScratch.note === "for the end-to-end check" && madeScratch.via === "card" && madeScratch.sourceThreadId === chead,
    JSON.stringify(madeScratch),
  );
  check("the request it was made from was answered allow once, and nothing wider", (await waitFile(first)) && (await lastApproval(chead))?.resolution?.decision === "allow_once", JSON.stringify((await lastApproval(chead))?.resolution));
  let log = await capLog();
  check(
    "making it and deciding the request are both in the log",
    log.some((entry) => entry.event.kind === "created" && entry.event.capabilityId === madeScratch?.id && entry.event.summary === `capability added: cow test scratch: ${scratch} for “${TITLE}” and every thread under it, now and later`) &&
      log.some((entry) => entry.event.kind === "decided" && entry.event.threadId === chead && entry.event.decision === "allow_once"),
    JSON.stringify(log.slice(0, 3).map((entry) => entry.event)),
  );
  await page.waitFor(`!!document.querySelector("[data-cow-notice]")`, { label: "the notice in the queue" });
  const noticeText = await page.eval(`document.querySelector("[data-cow-notice] p")?.textContent ?? ""`);
  check("a new capability raises a notice in the queue, even one you just made, and it counts as waiting on you", noticeText === `capability added: cow test scratch: ${scratch} for “${TITLE}” and every thread under it, now and later` && (await page.eval(`document.querySelector(".cow-sum")?.textContent.includes((document.querySelectorAll("[data-cow-queue]").length + document.querySelectorAll(".cow-q-notice").length) + " waiting")`)), noticeText);
  await settle(chead);
  const headMark = await mark(chead);
  const kidMark = await mark(ckid);
  check("the line of every thread that holds it carries the mark, marked new until it is acknowledged", headMark?.held === "1" && headMark.fresh === "true" && kidMark?.held === "1" && kidMark.fresh === "true", JSON.stringify([headMark, kidMark]));
  await shot("caps-line-new");

  // -- the next matching request is allowed without the person --------------
  // What capabilities allowed on a fixture in earlier runs is still counted on it.
  const countBefore = Number((await mark(chead))?.count ?? 0);
  const second = `${scratch}/one/b.txt`;
  await sayTo(chead, `write: ${second}`);
  check("the same thread's next matching request is allowed without anyone answering it", await waitFile(second));
  await page.waitFor(`!!${lineEl(chead)}?.querySelector("[data-cow-allowed]")`, { label: "allowed by, on the line", timeout: 30_000 });
  log = await capLog();
  const allowed = log.find((entry) => entry.event.kind === "auto-allowed");
  check(
    "it was answered allow once, with a log entry that names the thread, what was allowed, and which capability",
    (await lastApproval(chead))?.resolution?.decision === "allow_once" && allowed?.event.threadId === chead && allowed.event.capabilityId === madeScratch?.id && allowed.event.what === `change ${second}` && allowed.event.links === "followed",
    JSON.stringify(allowed?.event),
  );
  check(
    "the line says which capability allowed it, and counts it",
    (await page.eval(`${lineEl(chead)}.querySelector("[data-cow-allowed]").textContent`)).startsWith("allowed by cow test scratch") && Number((await mark(chead))?.count) === countBefore + 1,
    await page.eval(doing(chead)),
  );
  check("a request cow allowed is not flagged as decided outside cow", (await capState()).notices.every((notice) => notice.kind !== "outside"));
  await shot("caps-line-allowed");
  await settle(chead);

  // -- a request that is not covered shows the normal card ------------------
  await sayTo(chead, `write: ${other}/x.txt`);
  await waitForThread(chead, (t) => t.hasPendingInteraction, "asking to write elsewhere", 120_000);
  await sleep(2500);
  check("a request outside the directory is not allowed: it waits on you, as before", (await pendingOf(chead)).length === 1 && !existsSync(`${other}/x.txt`));
  await page.waitFor(`${doing(chead)}.includes("permission to change a file")`, { label: "the request on its line" });
  await openCard(chead, `!!document.querySelector("[data-cow-permission-diff]")`);
  check("its ordinary permission card opens", (await page.eval(`document.querySelector("[data-cow-permission-file]")?.dataset.cowPermissionFile`)) === `${other}/x.txt`);
  await page.key("3");
  await page.key("Enter");
  await waitForThread(chead, (t) => !t.hasPendingInteraction, "denied", 30_000);
  check("denied on the page, it is cow's own decision: logged, and not flagged", (await capLog()).some((entry) => entry.event.kind === "decided" && entry.event.decision === "deny") && !existsSync(`${other}/x.txt`));
  await settle(chead);

  // -- a subtree capability covers a thread under it ------------------------
  const third = `${scratch}/kid/c.txt`;
  await sayTo(ckid, `write: ${third}`);
  check("a capability for a thread and everything under it covers the thread under it", await waitFile(third));
  log = await capLog();
  check("the log names the thread it was allowed on", log.find((entry) => entry.event.kind === "auto-allowed")?.event.threadId === ckid);
  await settle(ckid);

  // -- a symbolic link inside the directory that leads out of it ----------------
  mkdirSync(other, { recursive: true });
  symlinkSync(other, `${scratch}/out`);
  await sayTo(ckid, `write: ${scratch}/out/x.txt`);
  await waitForThread(ckid, (t) => t.hasPendingInteraction, "asking to write through the link", 120_000);
  await sleep(3000);
  check(
    "a file under the directory as written, which a symbolic link takes out of it, is not allowed: the request waits on you",
    (await pendingOf(ckid)).length === 1 && !existsSync(`${other}/x.txt`) && !(await capLog()).some((entry) => entry.event.kind === "auto-allowed" && entry.event.what.includes("/out/x.txt")) && (await capLog()).find((entry) => entry.event.kind === "auto-allowed")?.event.what === `change ${third}`,
    `the newest allowance in the log is still: ${JSON.stringify((await capLog()).find((entry) => entry.event.kind === "auto-allowed")?.event)}`,
  );
  await openCard(ckid, `!!document.querySelector('[data-cow-answer="${ckid}"] [data-cow-permission="file_change"]')`);
  await page.key("3");
  await page.key("Enter");
  await waitForThread(ckid, (t) => !t.hasPendingInteraction, "denied", 30_000);
  rmSync(`${scratch}/out`, { force: true });
  await settle(ckid);

  // -- c on a line ------------------------------------------------------------
  await select(ckid);
  await page.key("c");
  await page.waitFor(`!!document.querySelector('[data-cow-capsfor="${ckid}"]')`, { label: "what the line holds" });
  const kidHolds = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll("[data-cow-capsfor-item]")].map((o) => [o.dataset.cowCapsforItem, o.dataset.cowCapsforFrom, o.textContent]))`));
  check("c shows which capabilities apply to the thread and where each comes from", kidHolds.length === 1 && kidHolds[0][0] === madeScratch?.id && kidHolds[0][1] === "ancestor" && kidHolds[0][2].includes(`from “${TITLE}”, above it`), JSON.stringify(kidHolds));
  await shot("caps-c-line");
  await page.key("c");
  check("c again closes it", !(await page.eval(`!!document.querySelector("[data-cow-capsfor]")`)));
  const statusHolds = await cow("status", "--main", ids.cmain);
  const holdRows = statusHolds.stdout.split("\n").filter((entry) => entry.includes("[holds: cow test scratch]"));
  check("bb cow status names, on each thread's line, the capabilities it holds", statusHolds.code === 0 && holdRows.length === 2 && holdRows.some((entry) => entry.includes(`(${chead})`)) && holdRows.some((entry) => entry.includes(`(${ckid})`)), holdRows.join(" / ").slice(0, 300));
  await select(chead);
  await page.key("c");
  await page.waitFor(`!!document.querySelector('[data-cow-capsfor="${chead}"]')`, { label: "what the head holds" });
  check("on the thread it names, it is its own", (await page.eval(`document.querySelector("[data-cow-capsfor-item]")?.dataset.cowCapsforFrom`)) === "itself" && (await page.eval(`document.querySelector("[data-cow-capsfor-use]")?.dataset.cowCapsforUse`)) === String(countBefore + 1));
  await page.key("Escape");
  await select(ids.cmain);
  await page.key("c");
  await page.waitFor(`!!document.querySelector('[data-cow-capsfor="${ids.cmain}"]')`, { label: "what Main holds" });
  check("a thread it does not apply to holds none, and says so", (await page.eval(`document.querySelector("[data-cow-capsfor]").dataset.cowCapsforCount`)) === "0");
  await page.key("Escape");

  // -- the sheet: the notice and its acknowledgement --------------------------
  await select(chead);
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the capabilities sheet" });
  const row = JSON.parse(await page.eval(`JSON.stringify((() => { const el = ${sheet}.querySelector("[data-cow-cap]"); return { id: el?.dataset.cowCap, fresh: el?.dataset.cowCapNew ?? null, text: el?.querySelector(".cow-cap-line")?.textContent ?? "", uses: el?.querySelector("[data-cow-cap-uses]")?.dataset.cowCapUses, height: ${sheet}.getBoundingClientRect().height / ${ROOT}.getBoundingClientRect().height }; })())`));
  check(
    "C opens a full-height sheet with every capability as one line: name, kind, rule, who it applies to, how often it was used, when it was made",
    row.id === madeScratch?.id && row.height > 0.95 && row.text.includes("cow test scratch") && row.text.includes("write a directory") && row.text.includes(scratch) && row.text.includes(`for “${TITLE}” and every thread under it`) && row.uses === "2" && /used 2×/.test(row.text) && /made \d+m ago from a permission request/.test(row.text) && (await page.eval(mode)) === "caps",
    JSON.stringify(row),
  );
  check("it is marked new there too", row.fresh === "true");
  await shot("caps-sheet");
  await page.key(" ");
  await page.waitFor(`${sheet}.querySelector("[data-cow-cap]")?.dataset.cowCapNew === undefined`, { label: "acknowledged" });
  check(
    "Space acknowledges it: the notice is gone, and the acknowledgement is logged",
    (await capState()).notices.length === 0 && (await capLog())[0].event.kind === "acknowledged" && /acknowledged/.test(await page.eval(sheetNote)),
    JSON.stringify((await capLog())[0].event),
  );

  // -- the sheet: a new one from scratch, and a refused command rule ----------
  await page.key("n");
  await page.waitFor(`${stage} === "kind" && ${steps}.dataset.cowCapstepsWhere === "sheet"`, { label: "the steps in the sheet" });
  await page.key("2");
  await page.key("Enter");
  await page.waitFor(`${stage} === "rule"`, { label: "the rule" });
  await fill("cap-rule", "echo caps; cat /etc/passwd");
  await page.key("Enter");
  const operatorRefusal = await page.eval(stepError);
  await fill("cap-rule", "echo $(id)");
  await page.key("Enter");
  const expansionRefusal = await page.eval(stepError);
  await fill("cap-rule", "X=1 echo caps");
  await page.key("Enter");
  const assignmentRefusal = await page.eval(stepError);
  await fill("cap-rule", "echo");
  await page.key("Tab");
  const prefixMarked = await page.eval(`document.querySelector('[data-cow-cap-mode="prefix"]')?.dataset.cowChosen`);
  await page.key("Enter");
  const shortRefusal = await page.eval(stepError);
  await fill("cap-rule", "bash -c");
  await page.key("Enter");
  const runnerRefusal = await page.eval(stepError);
  check(
    "a command rule with an operator, an expansion or a leading assignment is refused; a prefix needs two words and may not start with a shell",
    /“;”/.test(operatorRefusal) && /“\$”/.test(expansionRefusal) && /variable assignment/.test(assignmentRefusal) && prefixMarked === "true" && /at least two words/.test(shortRefusal) && /may not start with bash/.test(runnerRefusal) && (await page.eval(stage)) === "rule",
    [operatorRefusal, expansionRefusal, assignmentRefusal, shortRefusal, runnerRefusal].join(" | "),
  );
  await shot("caps-sheet-refused");
  await fill("cap-rule", "echo   cow   caps");
  await page.key("Enter");
  await page.waitFor(`${stage} === "name"`, { label: "the name" });
  await fill("cap-name", "cow test echo");
  await page.key("Enter");
  await page.key("Enter");
  await page.waitFor(`${stage} === "scope"`, { label: "who" });
  await page.key("1");
  await page.key("Enter");
  await page.waitFor(`${stage} === "restate"`, { label: "the sentence" });
  const echoSentence = await page.eval(`document.querySelector("[data-cow-capsteps-restate] b")?.textContent ?? ""`);
  await page.key("Enter");
  await page.waitFor(`!${steps} && ${sheet}.querySelectorAll("[data-cow-cap]").length === 2`, { label: "the second capability" });
  const madeEcho = await byName("cow test echo");
  check(
    "n makes one from scratch through the same steps, for the line the cursor was on",
    echoSentence === `The thread “${TITLE}”, and no other, may run any command line that begins with the words “echo cow caps”, whatever follows them, each time bb asks, without asking you.` &&
      madeEcho?.rule.mode === "prefix" && JSON.stringify(madeEcho.rule.words) === '["echo","cow","caps"]' && madeEcho.scope.kind === "thread" && madeEcho.scope.threadId === chead && madeEcho.via === "sheet",
    `${echoSentence} ${JSON.stringify(madeEcho)}`,
  );

  // -- the sheet's keys -------------------------------------------------------
  await page.key("g");
  await page.key("g");
  const top = await page.eval(sheetCursor);
  await page.key("j");
  const down = await page.eval(sheetCursor);
  await page.key("k");
  const up = await page.eval(sheetCursor);
  await page.key("G");
  const bottom = await page.eval(sheetCursor);
  check("j, k, gg and G move between the lines: the capabilities, then the keys", top === madeScratch?.id && down === madeEcho?.id && up === top && /^[0-9a-f]{4}-/.test(bottom ?? ""), JSON.stringify([top, down, up, bottom]));
  await page.key("g");
  await page.key("g");
  await page.key("Enter");
  await page.waitFor(`Number(${sheet}.querySelector("[data-cow-cap-history]")?.dataset.cowCapHistory) >= 4`, { label: "its history" });
  const history = JSON.parse(await page.eval(`JSON.stringify([...${sheet}.querySelectorAll("[data-cow-cap-history] [data-cow-caplog]")].map((o) => o.dataset.cowCaplogKind))`));
  check("Enter shows a capability's history: made, used twice, acknowledged, newest first", JSON.stringify(history) === '["acknowledged","auto-allowed","auto-allowed","created"]', JSON.stringify(history));
  await shot("caps-sheet-history");
  await page.key("Enter");
  check("Enter again closes it", !(await page.eval(`!!${sheet}.querySelector("[data-cow-cap-history]")`)));
  await page.key("f");
  await page.waitFor(`document.querySelectorAll("[data-cow-hint-label]").length >= 2`, { label: "hints in the sheet" });
  const hintsIn = await page.eval(`[...document.querySelectorAll("[data-cow-hint-label]")].every((tag) => { const r = tag.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 20, r.top + 6); return !!el?.closest("[data-cow-sheet]"); })`);
  check("f puts hints on what is in the sheet, and on nothing behind it", hintsIn);
  await page.key("Escape");
  await page.key("Tab");
  await page.waitFor(`${sheet}.dataset.cowCapsheetView === "log" && !!${sheet}.querySelector("[data-cow-caplog-check]")`, { label: "the log" });
  const logView = JSON.parse(await page.eval(`JSON.stringify({ check: ${sheet}.querySelector("[data-cow-caplog-check]").dataset.cowCaplogCheck, kinds: [...${sheet}.querySelectorAll(".cow-sheet-body > [data-cow-caplog]")].slice(0, 3).map((o) => o.dataset.cowCaplogKind), seqs: [...${sheet}.querySelectorAll(".cow-sheet-body > [data-cow-caplog]")].slice(0, 3).map((o) => Number(o.dataset.cowCaplog)), first: ${sheet}.querySelector("[data-cow-caplog]")?.textContent ?? "" })`));
  check(
    "Tab shows the log, newest first, and says its numbering has no gap",
    logView.check === "intact" && logView.kinds[0] === "created" && logView.seqs[0] > logView.seqs[1] && logView.seqs[1] > logView.seqs[2] && logView.first.includes("capability added: cow test echo"),
    JSON.stringify(logView),
  );
  await page.key("x");
  await page.key("n");
  await sleep(300);
  check("nothing in the log can be deleted or made from: x and n do nothing there", !(await page.eval(`!!${sheet}.querySelector("[data-cow-sheet-confirm]")`)) && !(await page.eval(`!!${steps}`)));
  await shot("caps-sheet-log");
  const shownBefore = JSON.parse(await page.eval(`JSON.stringify({ shown: Number(${sheet}.querySelector("[data-cow-caplog-shown]").dataset.cowCaplogShown), rows: ${sheet}.querySelectorAll(".cow-sheet-body > [data-cow-caplog]").length, all: ${sheet}.querySelector("[data-cow-caplog-shown]").dataset.cowCaplogAll ?? null, signed: ${sheet}.querySelector('[data-cow-caplog-kind="created"]')?.dataset.cowCaplogBy ?? null, text: ${sheet}.querySelector('[data-cow-caplog-kind="created"]')?.textContent ?? "" })`));
  await page.key("a");
  await page.waitFor(`${sheet}.querySelector("[data-cow-caplog-shown]")?.dataset.cowCaplogAll === "true"`, { label: "every entry" });
  const shownAll = Number(await page.eval(`${sheet}.querySelector("[data-cow-caplog-shown]").dataset.cowCaplogShown`));
  check(
    "the log shows the entries of this Main's threads, and those about no thread, until a asks for all; an entry for something only the person may do names the key that signed it",
    shownBefore.all === null && shownBefore.shown === shownBefore.rows && shownAll >= shownBefore.shown && shownAll === Number(await page.eval(`${sheet}.querySelectorAll(".cow-sheet-body > [data-cow-caplog]").length`)) && /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(shownBefore.signed ?? "") && shownBefore.text.includes(`signed by ${shownBefore.signed}`),
    JSON.stringify({ ...shownBefore, shownAll }),
  );
  await page.key("a");
  await page.key("Tab");
  await page.waitFor(`${sheet}.dataset.cowCapsheetView === "list"`, { label: "back to the capabilities" });
  await sheetRow(page, `[data-cow-cap="${madeEcho?.id}"]`);
  await page.key(" ");
  await page.waitFor(`${sheet}.querySelectorAll("[data-cow-cap-new]").length === 0`, { label: "the second one acknowledged" });
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });
  check("q closes the sheet, and the page is as it was", (await page.eval(mode)) === "normal" && (await page.eval(isCursor(chead))));
  check("acknowledged, the marks no longer say new", (await mark(chead))?.held === "2" && (await mark(chead))?.fresh === null && (await mark(ckid))?.fresh === null, JSON.stringify(await mark(chead)));

  // -- a command, by prefix; and an operator after a matching prefix ----------
  await sayTo(chead, "ask: echo cow caps one");
  await sleep(1500);
  await waitForThread(chead, (t) => t.status === "idle" && !t.hasPendingInteraction, "the covered command run", 120_000);
  log = await capLog();
  check(
    "a command that begins with a prefix rule's words is allowed without the person, and runs",
    (await said(chead)) === "cow caps one" && log[0].event.kind === "auto-allowed" && log[0].event.capabilityId === madeEcho?.id && log[0].event.what === "run: echo cow caps one",
    `${await said(chead)} ${JSON.stringify(log[0].event)}`,
  );
  await settle(chead);
  await sayTo(chead, "ask: echo cow caps one; echo two");
  await waitForThread(chead, (t) => t.hasPendingInteraction, "asking, for the command with an operator", 120_000);
  await sleep(2500);
  check("the same words followed by a shell operator are not covered: the request waits on you", (await pendingOf(chead)).length === 1);
  await openCard(chead, `!!document.querySelector('[data-cow-answer="${chead}"] [data-cow-permission="command"]')`);
  check("and its ordinary card shows the whole command", (await page.eval(`document.querySelector("[data-cow-permission-command]")?.textContent.trim()`)) === "echo cow caps one; echo two");
  await page.key("2");
  await page.key("Enter");
  await waitForThread(chead, (t) => !t.hasPendingInteraction, "denied", 30_000);
  await settle(chead);

  // -- a refusal bb made by itself, covered by a capability -------------------
  const fourth = `${scratch}/one/d.txt`;
  await tellAs(ids.cmain, chead, `write: ${fourth}`);
  await page.waitFor(`${stateOf(chead)} === "blocked"`, { label: "the blocked line", timeout: 120_000 });
  await waitForThread(chead, (t) => t.status === "idle", "at rest after the refusal", 60_000);
  check("on a turn another thread started, bb refuses by itself and a capability cannot help: nothing was written", !existsSync(fourth) && (await pendingOf(chead)).length === 0);
  await page.waitFor(`!!${lineEl(chead)}?.querySelector("[data-cow-covered]")`, { label: "covered, on the line" });
  check(
    "the line says the refusal is covered by a capability, and that asking again is two keys",
    (await page.eval(`${lineEl(chead)}.querySelector("[data-cow-covered]").textContent`)).startsWith("covered by cow test scratch") && (await page.eval(nextOf(chead))) === "ask again: a, then Enter",
    `${await page.eval(doing(chead))} / ${await page.eval(nextOf(chead))}`,
  );
  await shot("caps-blocked-covered-line");
  const rowsBefore = (await userRows(chead)).length;
  await select(chead);
  await page.key("a");
  await page.waitFor(`!!document.querySelector('[data-cow-blocked="${chead}"]')`, { label: "the blocked card" });
  const blockedChosen = `JSON.stringify([...document.querySelectorAll("[data-cow-blocked-action]")].map((o) => o.dataset.cowChosen === "true"))`;
  check(
    "its card says which capability covers it, and opens with ask again as me marked; nothing is sent yet",
    (await page.eval(`document.querySelector("[data-cow-refusal-covered]")?.dataset.cowRefusalCovered`)) === "cow test scratch" && (await page.eval(blockedChosen)) === "[true,false,false]" && (await userRows(chead)).length === rowsBefore,
    await page.eval(blockedChosen),
  );
  await shot("caps-blocked-covered-card");
  await page.key("Enter");
  check("Enter asks again as you, and the request bb then raises is allowed by the capability", (await waitFile(fourth)) && (await userRows(chead)).at(-1)?.initiator === "user");
  log = await capLog();
  check("that allowance is in the log like any other", log[0].event.kind === "auto-allowed" && log[0].event.what === `change ${fourth}`, JSON.stringify(log[0].event));
  await settle(chead);

  // -- from a blocked card: save a capability for it --------------------------
  await tellAs(ids.cmain, ckid, "ask: echo cow blocked caps");
  await page.waitFor(`${stateOf(ckid)} === "blocked"`, { label: "the thread under it, blocked", timeout: 120_000 });
  await waitForThread(ckid, (t) => t.status === "idle", "at rest after its refusal", 60_000);
  check("a refusal no capability covers reads as before", !(await page.eval(`!!${lineEl(ckid)}?.querySelector("[data-cow-covered]")`)) && (await page.eval(nextOf(ckid))) === "ask again: press a");
  await select(ckid);
  await page.key("a");
  await page.waitFor(`!!document.querySelector('[data-cow-blocked="${ckid}"]')`, { label: "its blocked card" });
  check("the blocked card offers to save a capability, after its three choices, and opens with nothing marked", (await page.eval(`document.querySelector("[data-cow-blocked-save]")?.dataset.cowBlockedSave`)) === "4" && (await page.eval(blockedChosen)) === "[false,false,false]");
  await page.key("4");
  await page.key("Enter");
  await page.waitFor(`${stage} === "rule"`, { label: "the steps, from the refusal" });
  check("it proposes the exact command that was refused", (await page.eval(`${field("cap-rule")}?.value`)) === "echo cow blocked caps" && (await page.eval(`document.querySelector('[data-cow-cap-mode="exact"]')?.dataset.cowChosen`)) === "true");
  await page.key("Enter");
  await fill("cap-name", "cow test blocked echo");
  await page.key("Enter");
  await page.key("Enter");
  await page.waitFor(`${stage} === "scope"`, { label: "who" });
  await page.key("1");
  await page.key("Enter");
  await page.waitFor(`${stage} === "restate"`, { label: "the sentence" });
  await page.key("Enter");
  await page.waitFor(`!${steps} && ${message}.startsWith("saved")`, { label: "saved from the refusal" });
  const madeBlocked = await byName("cow test blocked echo");
  check("saved from the refusal, for that thread alone; the thread was told nothing", madeBlocked?.via === "blocked" && madeBlocked.rule.mode === "exact" && madeBlocked.rule.text === "echo cow blocked caps" && madeBlocked.scope.threadId === ckid && (await page.eval(stateOf(ckid))) === "blocked" && /press a, then Enter/.test(await page.eval(message)), JSON.stringify(madeBlocked));
  await page.waitFor(`!!${lineEl(ckid)}?.querySelector("[data-cow-covered]")`, { label: "now covered" });
  await page.key("a");
  await page.waitFor(`!!document.querySelector('[data-cow-blocked="${ckid}"]')`, { label: "the card again" });
  check("the refusal is now covered, and ask again as me is marked", (await page.eval(blockedChosen)) === "[true,false,false]");
  await page.key("Enter");
  await sleep(2000);
  await waitForThread(ckid, (t) => t.status === "idle" && !t.hasPendingInteraction, "the refused command run", 120_000);
  check("asked again as you, the command runs without another answer", (await said(ckid)) === "cow blocked caps" && (await capLog())[0].event.capabilityId === madeBlocked?.id, await said(ckid));
  await settle(ckid);
  await page.eval(`document.querySelector("[data-cow-notice]").click(); true`);
  await page.waitFor(`!!${sheet}`, { label: "the sheet, from its notice in the queue" });
  check("a notice in the queue opens the sheet", (await page.eval(`${sheet}.querySelectorAll("[data-cow-cap-new]").length`)) === 1);
  await sheetRow(page, "[data-cow-cap-new]");
  await page.key(" ");
  await page.waitFor(`${sheet}.querySelectorAll("[data-cow-cap-new]").length === 0`, { label: "the one from the refusal acknowledged" });
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });

  // -- deleting takes effect at once; undo puts it back -------------------------
  await select(chead);
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet" });
  await page.key("g");
  await page.key("g");
  await page.key("x");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-sheet-confirm="delete"]')`, { label: "the confirmation" });
  const confirmDelete = await page.eval(`${sheet}.querySelector("[data-cow-sheet-confirm]").textContent`);
  check("x asks first, naming the threads that lose it", confirmDelete.includes("Delete “cow test scratch”?") && confirmDelete.includes(`these 2 threads lose it: “${TITLE}”, “${TITLE}”`), confirmDelete);
  await shot("caps-sheet-delete");
  await page.key("j");
  check("any key but y cancels", (await byName("cow test scratch")) !== null && /not deleted/.test(await page.eval(sheetNote)));
  await page.key("x");
  await page.key("y");
  await page.waitFor(`!${sheet}.querySelector('[data-cow-cap="${madeScratch?.id}"]')`, { label: "deleted" });
  check("y deletes it: it leaves the sheet, and the deletion is logged", (await byName("cow test scratch")) === null && (await capLog())[0].event.kind === "deleted");
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });
  check("the thread under it no longer carries its mark for that capability", (await mark(ckid))?.held === "1", JSON.stringify(await mark(ckid)));
  const fifth = `${scratch}/one/e.txt`;
  await sayTo(chead, `write: ${fifth}`);
  await waitForThread(chead, (t) => t.hasPendingInteraction, "asking, now that it is deleted", 120_000);
  await sleep(2500);
  check("deleted, the next request needs you again", (await pendingOf(chead)).length === 1 && !existsSync(fifth));
  await openCard(chead, `!!document.querySelector("[data-cow-permission-diff]")`);
  await page.key("3");
  await page.key("Enter");
  await waitForThread(chead, (t) => !t.hasPendingInteraction, "denied", 30_000);
  await settle(chead);
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet, to undo" });
  await page.key("u");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-sheet-confirm="restore"]')`, { label: "the undo confirmation" });
  await page.key("y");
  await page.waitFor(`${sheet}.querySelector('[data-cow-cap="${madeScratch?.id}"]')?.dataset.cowCapNew === "true"`, { label: "restored" });
  check(
    "u puts the deleted one back, after y; it is logged, and it is new again until acknowledged",
    (await byName("cow test scratch"))?.id === madeScratch?.id && (await capLog())[0].event.kind === "restored" && (await capState()).notices.some((notice) => notice.text.startsWith("capability restored: cow test scratch")),
  );
  await page.key(" ");
  await page.waitFor(`${sheet}.querySelector('[data-cow-cap="${madeScratch?.id}"]')?.dataset.cowCapNew === undefined`, { label: "acknowledged again" });
  await page.key("Escape");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });
  await sayTo(chead, `write: ${fifth}`);
  check("restored, it allows again", await waitFile(fifth));
  await settle(chead);

  // -- an approval made outside cow ---------------------------------------------
  await sayTo(ckid, "ask: echo outside cow");
  await waitForThread(ckid, (t) => t.hasPendingInteraction, "asking, to be approved elsewhere", 120_000);
  await page.waitFor(`${doing(ckid)}.includes("permission to run: echo outside cow")`, { label: "the request on its line" });
  const [waitingRequest] = await pendingOf(ckid);
  // As another thread, or bb's own chat, would: a bare bb command, not cow's page.
  await plain("thread", "interactions", "approve", waitingRequest.id, ckid);
  // The text too: with fixtures kept from a run that stopped before acknowledging, the line can carry the flag already.
  await page.waitFor(`${lineEl(ckid)}?.dataset.cowOutside === "1" && ${doing(ckid)}.includes("approved outside cow")`, { label: "flagged on the line", timeout: 30_000 });
  const flagged = await page.eval(doing(ckid));
  check(
    "a request approved with a bare bb command is flagged on the line: approved outside cow, what, and where it may have been done",
    flagged.includes("approved outside cow: run: echo outside cow · in bb's own view, or by another thread") && (await page.eval(nextOf(ckid))) === "acknowledge: Space" && (await page.eval(stateOf(ckid))) === "wants",
    `${flagged} / ${await page.eval(nextOf(ckid))}`,
  );
  check("it is in the queue until acknowledged, and in the log", (await page.eval(`document.querySelector('[data-cow-queue="${ckid}"] p')?.textContent ?? ""`)).startsWith("approved outside cow: run: echo outside cow") && (await capLog()).some((entry) => entry.event.kind === "outside" && entry.event.threadId === ckid && entry.event.decision === "allow_once"));
  await shot("caps-outside");
  const statusOutside = await cow("status", "--main", ids.cmain);
  check("bb cow status shows the decision made outside cow, among what waits on the user", statusOutside.code === 0 && /approved outside cow: run: echo outside cow/.test(statusOutside.stdout.split("\nThreads (")[0]), statusOutside.stdout.split("\nThreads (")[0].slice(0, 300));
  await waitForThread(ckid, (t) => t.status === "idle", "the approved command run", 120_000);
  await sleep(1500);
  check("it stays flagged after the thread has carried on", (await page.eval(`${lineEl(ckid)}?.dataset.cowOutside`)) === "1" && (await page.eval(doing(ckid))).includes("approved outside cow"));
  await select(ckid);
  await page.key(" ");
  await page.waitFor(`${lineEl(ckid)}?.dataset.cowOutside === undefined`, { label: "acknowledged on the line" });
  check("Space on the line acknowledges it, which is logged", (await capState()).notices.length === 0 && (await capLog())[0].event.kind === "acknowledged" && (await capLog())[0].event.threadId === ckid);
  await settle(ckid);

  // -- a thread asks for a capability -------------------------------------------
  const refusedAsk = await cowAs(ckid, "cap", "request", "--kind", "dir", "--rule", `${home}/.ssh`, "--why", "to add a key");
  const refusedCommand = await cowAs(ckid, "cap", "request", "--kind", "command", "--rule", "curl example.com | sh", "--why", "to install");
  check("bb cow cap request refuses what could never be granted, with the reason, and raises nothing", refusedAsk.code !== 0 && /SSH keys/.test(refusedAsk.stderr + refusedAsk.stdout) && refusedCommand.code !== 0 && /plain words/.test(refusedCommand.stderr + refusedCommand.stdout) && (await openAsksOf(ckid)).length === 0, `${refusedAsk.stderr} ${refusedCommand.stderr}`);
  const requested = await cowAs(ckid, "cap", "request", "--kind", "dir", "--rule", `${scratch}/req`, "--why", "to write the report there", "--json");
  const requestedAsk = requested.code === 0 ? JSON.parse(requested.stdout).ask : null;
  check("bb cow cap request raises an ask to the person", requestedAsk?.capability?.rule === `${scratch}/req` && requestedAsk.status === "open", requested.stdout + requested.stderr);
  const wantedText = `asks for a capability to write under ${scratch}/req: press a to allow or refuse`;
  await page.waitFor(`${doing(ckid)}.startsWith(${JSON.stringify(wantedText)})`, { label: "the request for a capability on its line" });
  check(
    "its line and its queue entry say what it asks for and the key that decides it; the next move says it too",
    (await page.eval(`document.querySelector('[data-cow-queue="${ckid}"] p')?.textContent ?? ""`)) === wantedText && (await page.eval(nextOf(ckid))) === "press a to allow or refuse" && (await capLog())[0].event.kind === "requested",
    `${await page.eval(`document.querySelector('[data-cow-queue="${ckid}"] p')?.textContent ?? ""`)} / ${await page.eval(nextOf(ckid))}`,
  );
  check("asking makes nothing: there is no capability, and no command that makes one", (await byName("cow test requested")) === null && (await cowAs(ckid, "cap", "create", "--name", "x")).code !== 0 && (await cowAs(ckid, "caps", "add")).code !== 0);
  await select(ckid);
  const firstVerb = await page.eval(`(() => { const verb = document.querySelector(".cow-verbs .cow-vb"); return verb ? (verb.dataset.cowVerb ?? "") + "|" + verb.textContent : ""; })()`);
  check("with its line selected, the verb bar shows a first, as allow or refuse", /^answer\|a\s*allow or refuse$/.test(firstVerb), firstVerb);
  await page.key("a");
  await page.waitFor(`document.querySelector("[data-cow-ask-card]")?.dataset.cowAsk === "${requestedAsk?.id}"`, { label: "its ask card" });
  await shot("caps-ask-card");
  const card = await page.eval(`(() => { const card = document.querySelector("[data-cow-ask-card]"); return { kind: card.querySelector(".cow-perm-kind")?.textContent ?? "", q: card.querySelector("[data-cow-answer-prompt]")?.textContent ?? "", why: card.querySelector("[data-cow-ask-context]")?.textContent ?? "", allow: card.querySelector('[data-cow-capability-choice="allow"]')?.textContent ?? "", refuse: card.querySelector('[data-cow-capability-choice="refuse"]')?.textContent ?? "", keys: card.querySelector(".cow-ans-keys")?.textContent ?? "" }; })()`);
  check(
    "its card says what is asked, for which thread and why, shows allowing and refusing at once with their keys, and what happens next",
    card.kind.startsWith("Capability request · for ") &&
      /^“.+” asks for a capability to write under /.test(card.q) && card.q.endsWith(` ${scratch}/req`) &&
      card.why === "Why, in its words: to write the report there" &&
      card.allow.startsWith("1○allow it") && /confirm the one sentence/.test(card.allow) && /lasts until you delete it/.test(card.allow) &&
      card.refuse.startsWith("2○refuse it") && /it is told no/.test(card.refuse) &&
      /1 allow: the steps open, and you confirm at the end · 2 then ⏎ refuse/.test(card.keys),
    JSON.stringify(card),
  );
  // One key opens the steps: they end in a confirmation of their own.
  await page.key("1");
  await page.waitFor(`${stage} === "rule"`, { label: "the steps, from the ask" });
  check("1 on the card opens the same steps at once, starting from what was asked for; nothing is granted yet", (await page.eval(`${field("cap-rule")}?.value`)) === `${scratch}/req` && (await openAsksOf(ckid)).length === 1);
  await page.key("Enter");
  await fill("cap-name", "cow test requested");
  await page.key("Enter");
  await page.key("Enter");
  await page.waitFor(`${stage} === "scope"`, { label: "who" });
  await page.key("1");
  await page.key("Enter");
  await page.waitFor(`${stage} === "restate"`, { label: "the sentence" });
  await page.key("Enter");
  await page.waitFor(`!${steps} && ${message}.startsWith("saved")`, { label: "granted" });
  const madeRequested = await byName("cow test requested");
  const answeredAsk = (await rpc("asks_list", { threadId: ckid, all: true })).asks.find((ask) => ask.id === requestedAsk?.id);
  check(
    "granted: the capability exists for that thread, and the ask is answered with what was granted",
    madeRequested?.via === "ask" && madeRequested.askId === requestedAsk?.id && madeRequested.rule.dir === `${scratch}/req` && answeredAsk?.status === "answered" && answeredAsk.answer?.text.includes("granted as the capability “cow test requested”"),
    JSON.stringify(answeredAsk?.answer),
  );
  await settle(ckid);
  const held = await cowAs(ckid, "caps");
  const heldJson = JSON.parse((await cowAs(ckid, "caps", "--json")).stdout).capabilities.map((capability) => [capability.name, capability.source.from]);
  check(
    "bb cow caps shows a thread what it holds and where each comes from",
    held.code === 0 && JSON.stringify(heldJson) === '[["cow test scratch","ancestor"],["cow test blocked echo","itself"],["cow test requested","itself"]]' && held.stdout.includes(`from “${TITLE}”, above it`),
    held.stdout,
  );
  const logText = await cowAs(ckid, "caps", "log", "--limit", "5");
  check("bb cow caps log prints the log, newest first", logText.code === 0 && /entries, numbered without a gap/.test(logText.stdout) && logText.stdout.includes("capability added: cow test requested"), logText.stdout.split("\n").slice(0, 3).join(" / "));

  // -- what a sandboxed agent can do against the person's actions ------------------
  // One fixture runs every route in one script, inside its command sandbox, in the
  // ordinary way. Each of the person's actions must fail; bb's own approve command
  // still works, because it is bb's, and must be flagged.
  const [probeThread] = await api(`/threads?threadIds=${ckid}&limit=1`);
  const workspace = (await api(`/environments/${probeThread.environmentId}`)).path;
  const probeDir = join(workspace, ".cow-e2e-probe");
  rmSync(probeDir, { recursive: true, force: true });
  mkdirSync(probeDir, { recursive: true });
  const probeCap = await signer.must("cap_create", { name: "cow test probe", note: null, rule: { kind: "command", mode: "exact", text: "echo cow probe" }, scope: { kind: "thread", threadId: ckid }, via: "sheet", sourceThreadId: null, askId: null });
  const probeNotice = (await capState()).notices.find((notice) => notice.capabilityId === probeCap.id);
  const probeAsk = JSON.parse((await cowAs(ckid, "ask", "--question", "May the probe answer this itself?", "--option", "yes", "--option", "no", "--json")).stdout).ask;
  await sayTo(chead, "ask: echo cow probe pending");
  await waitForThread(chead, (t) => t.hasPendingInteraction, "a request for the probe to try", 120_000);
  const [probeRequest] = await pendingOf(chead);
  const agentKey = await createSigner(BB, "made by a fixture", PLUGIN);
  const planted = { name: "cow test planted", note: null, rule: { kind: "command", mode: "exact", text: "echo cow planted" }, scope: { kind: "thread", threadId: ckid }, via: "sheet", sourceThreadId: null, askId: null };
  const enrolledPage = (await signer.state()).keys.find((key) => /headless Chrome/.test(key.label)).fingerprint;
  const allow = { threadId: chead, interactionId: probeRequest.id, resolution: { decision: "allow_once", grantedPermissions: null } };
  const answer = { id: probeAsk.id, option: 1, text: null };
  const unsigned = (action, args) => ({ action, args });
  const bodies = {
    "old-create": planted,
    "unsigned-create": unsigned("cap_create", planted),
    // Signed by nobody, naming the enrolled page's key.
    "forged-create": { action: "cap_create", args: planted, at: Date.now(), nonce: "0123456789abcdef0123456789abcdef", key: enrolledPage, sig: "A".repeat(86) },
    "unsigned-ack": unsigned("cap_ack", { noticeId: probeNotice.id }),
    "unsigned-delete": unsigned("cap_delete", { id: probeCap.id }),
    "unsigned-decide": unsigned("permission_decide", allow),
    "old-decide": allow,
    "unsigned-answer": unsigned("ask_answer", answer),
    "old-answer": answer,
    "enrol-key": { key: agentKey.key, label: "made by a fixture" },
    "unsigned-approve": unsigned("key_approve", { fingerprint: agentKey.fingerprint }),
  };
  // The three light things that take a line out of the person's queue: a reply marked as seen, a
  // refusal dismissed, a brief marked as read. Each is tried as the method it used to be, by HTTP
  // and by bb plugin rpc call, then through the signed method with no signature and a made-up one.
  const briefTarget = ids.briefer ?? ckid;
  const briefVersion = (await briefOf(briefTarget))?.version ?? null;
  // The brief is unread when the fixture tries, so that marking it read would show.
  if (briefVersion !== null) await signer.must("brief_read", { threadId: briefTarget, version: briefVersion, read: false });
  const light = {
    seen: ["seen_set", { threadId: chead, seen: { seq: 999999999, at: Date.now() } }],
    dismiss: ["dismissal_set", { threadId: chead, dismissal: { throughSeq: 999999999, at: Date.now() } }],
    read: ["brief_read", { threadId: briefTarget, version: briefVersion ?? 1, read: true }],
  };
  for (const [name, [action, tried]] of Object.entries(light)) {
    bodies[`old-${name}`] = tried;
    bodies[`unsigned-${name}`] = unsigned(action, tried);
    bodies[`forged-${name}`] = { action, args: tried, at: Date.now(), nonce: "0123456789abcdef0123456789abcdef", key: enrolledPage, sig: "A".repeat(86) };
  }
  const lightState = async () => {
    const notes = await rpc("notes_list", { threadIds: [chead] });
    return JSON.stringify([notes.seen[chead] ?? null, notes.dismissals[chead] ?? null, (await briefOf(briefTarget))?.readAt ?? null]);
  };
  const lightBefore = await lightState();
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(probeDir, `${name}.json`), JSON.stringify(body));
  const rpcUrl = `${BB}/api/v1/plugins/${PLUGIN}/rpc`;
  const post = (name, method) => `curl -s -m 8 -X POST ${rpcUrl}/${method} -H content-type:application/json -d @${probeDir}/${name}.json`;
  const routes = [
    ["old-create", post("old-create", "cap_create")],
    ["bb-rpc-create", `bb plugin rpc call ${PLUGIN} cap_create --input-file ${probeDir}/old-create.json --json`],
    ["bb-rpc-signed-create", `bb plugin rpc call ${PLUGIN} signed --input-file ${probeDir}/unsigned-create.json --json`],
    ["unsigned-create", post("unsigned-create", "signed")],
    ["forged-create", post("forged-create", "signed")],
    ["unsigned-ack", post("unsigned-ack", "signed")],
    ["old-ack", post("unsigned-ack", "cap_ack")],
    ["unsigned-delete", post("unsigned-delete", "signed")],
    ["unsigned-decide", post("unsigned-decide", "signed")],
    ["old-decide", post("old-decide", "permission_decide")],
    ["unsigned-answer", post("unsigned-answer", "signed")],
    ["old-answer", post("old-answer", "ask_answer")],
    ["enrol-key", post("enrol-key", "key_enrol")],
    ["unsigned-approve", post("unsigned-approve", "signed")],
    ["reset-file", `sh -c 'mkdir -p "${dirname(resetPath)}" && touch "${resetPath}" && echo CREATED-THE-RESET-FILE'`],
    ["bb-approve", `bb thread interactions approve ${probeRequest.id} ${chead}`],
  ];
  // The light actions: tried in the same script, after the others.
  const lightRoutes = Object.entries(light).flatMap(([name, [action]]) => [
    [`old-${name}`, post(`old-${name}`, action)],
    [`bb-rpc-${name}`, `bb plugin rpc call ${PLUGIN} ${action} --input-file ${probeDir}/old-${name}.json --json`],
    [`unsigned-${name}`, post(`unsigned-${name}`, "signed")],
    [`bb-rpc-signed-${name}`, `bb plugin rpc call ${PLUGIN} signed --input-file ${probeDir}/unsigned-${name}.json --json`],
    [`forged-${name}`, post(`forged-${name}`, "signed")],
  ]);
  // One script, run in one turn, writing what each route gave to a file the check reads. Two turns were
  // not dependable: having seen the first script's output, a fixture model may read the second and refuse
  // to run it. And bb keeps only the start and the end of a long output, so the routes are not read from it.
  const outFile = join(probeDir, "out.txt");
  writeFileSync(join(probeDir, "run.sh"), `${[...routes, ...lightRoutes].map(([name, command]) => `{ printf 'ROUTE ${name}: '; ${command} 2>&1 | tr '\\n' ' ' | cut -c1-240; echo; } >> ${outFile}`).join("\n")}\necho probe finished\n`);
  const keysBefore = (await signer.state()).keys.map((key) => key.fingerprint).sort().join(" ");
  /**
   * Have the fixture run the probe script, and read what each route wrote. A turn
   * may wait for a free slot before it starts, so "idle" a moment after the
   * message is not "done": this waits for a turn that ended after the
   * message was sent. A fixture that ends its turn without running the
   * script is asked again, twice at most; one that ran it is not asked again. What a route gave is null when the
   * probe never printed it: the checks then fail as "probe did not run",
   * never on missing output.
   */
  const lastTurn = async () => (await api(`/threads/${ckid}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq ?? 0;
  const runProbe = async (script, names, label) => {
    let rows = [];
    let output = "";
    rmSync(outFile, { force: true });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const before = await lastTurn();
      await sayTo(ckid, `run: sh ${probeDir}/${script}`);
      await waitUntil(async () => (await lastTurn()) > before, `${label}: a turn that ends after it was asked`, 300_000);
      await waitForThread(ckid, (t) => t.status === "idle" && !t.hasPendingInteraction, `${label} done`, 180_000);
      rows = (await api(`/threads/${ckid}/timeline`)).rows.filter((entry) => entry.workKind === "command" && String(entry.command).includes(`.cow-e2e-probe/${script}`));
      output = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
      // Run once, it is not run again: a route such as bb's approve must not be tried twice. Routes it did not write fail below.
      if (rows.length > 0 || output !== "") break;
      console.log(`note: the fixture ended its turn without running ${label} (attempt ${attempt} of 3)`);
    }
    const said = Object.fromEntries(names.map((name) => [name, new RegExp(`ROUTE ${name}: (.*)`).exec(output)?.[1]?.trim() ?? null]));
    return { rows, output, said };
  };
  const probe = await runProbe("run.sh", [...routes, ...lightRoutes].map(([name]) => name), "the probe");
  const probeRows = probe.rows;
  const probeOutput = probe.output;
  const lightRows = probe.rows;
  const lightOutput = probe.output.slice(probe.output.indexOf(`ROUTE ${lightRoutes[0][0]}:`));
  const got = probe.said;
  console.log("what each route gave a sandboxed fixture:");
  for (const [name] of [...routes, ...lightRoutes]) console.log(`  ${name.padEnd(22)} ${got[name] === null ? "PROBE DID NOT RUN" : got[name].slice(0, 200)}`);
  /** A check on what the probe saw: when a route it needs printed nothing, it fails as such. */
  const probeCheck = (name, needs, ok, detail) => {
    const missing = needs.filter((route) => got[route] === null);
    if (missing.length > 0) return check(name, false, `probe did not run: no output for ${missing.join(", ")}`);
    return check(name, ok(), detail());
  };
  rmSync(probeDir, { recursive: true, force: true });
  await sleep(2500);
  const afterProbe = await capState();
  const keysAfter = await signer.state();
  const only = /only the person may do/;
  check("the probe ran, inside the fixture's sandbox", probeRows.length >= 1 && routes.every(([name]) => got[name] !== null), probeRows.length === 0 ? "probe did not run: the fixture never ran it" : `no output for ${routes.filter(([name]) => got[name] === null).map(([name]) => name).join(", ") || "none"} · ${probeOutput.slice(0, 160)}`);
  const plantedAfter = await byName("cow test planted");
  const asksAfterProbe = await openAsksOf(ckid);
  const decidedAfterProbe = (await capLog(40)).some((entry) => entry.event.kind === "decided" && entry.event.interactionId === probeRequest.id);
  probeCheck(
    "a sandboxed agent can no longer make a capability: the old method is gone, by HTTP and by bb plugin rpc call, and an unsigned or forged signed call is refused",
    ["old-create", "bb-rpc-create", "bb-rpc-signed-create", "unsigned-create", "forged-create"],
    () => plantedAfter === null && !/"ok":true/.test(got["old-create"]) && !/cap_[0-9a-f]{6}/.test(got["bb-rpc-create"]) && only.test(got["bb-rpc-signed-create"]) && only.test(got["unsigned-create"]) && /signature does not match/.test(got["forged-create"]),
    () => [got["old-create"], got["bb-rpc-create"], got["unsigned-create"], got["forged-create"]].map((line) => line.slice(0, 90)).join(" | "),
  );
  probeCheck(
    "nor acknowledge a notice or delete a capability: the notice still waits and the capability is still in force",
    ["unsigned-ack", "old-ack", "unsigned-delete"],
    () => only.test(got["unsigned-ack"]) && !/"ok":true/.test(got["old-ack"]) && only.test(got["unsigned-delete"]) && afterProbe.notices.some((notice) => notice.id === probeNotice.id) && afterProbe.capabilities.some((capability) => capability.id === probeCap.id && capability.deletedAt === null),
    () => [got["unsigned-ack"], got["old-ack"], got["unsigned-delete"]].map((line) => line.slice(0, 90)).join(" | "),
  );
  probeCheck(
    "nor decide a permission request through cow, nor answer an ask as the person: the ask is still open",
    ["unsigned-decide", "old-decide", "unsigned-answer", "old-answer"],
    () => only.test(got["unsigned-decide"]) && !/"ok":true/.test(got["old-decide"]) && only.test(got["unsigned-answer"]) && !/"ok":true/.test(got["old-answer"]) && asksAfterProbe.some((ask) => ask.id === probeAsk.id) && !decidedAfterProbe,
    () => [got["unsigned-decide"], got["old-decide"], got["unsigned-answer"], got["old-answer"]].map((line) => line.slice(0, 90)).join(" | "),
  );
  probeCheck(
    "it can ask for a key to be enrolled, which only puts a request in front of the person; it cannot approve it, and the enrolled keys are as they were",
    ["enrol-key", "unsigned-approve"],
    () => /pending/.test(got["enrol-key"]) && only.test(got["unsigned-approve"]) && keysAfter.keys.map((key) => key.fingerprint).sort().join(" ") === keysBefore && keysAfter.requests.some((request) => request.fingerprint === agentKey.fingerprint && request.status === "pending"),
    () => `${got["enrol-key"].slice(0, 80)} | ${got["unsigned-approve"].slice(0, 90)}`,
  );
  const lightAfter = await lightState();
  const lightLogged = (await fullLog(300)).filter((entry) => (entry.event.kind === "seen" && entry.event.seq === 999999999) || (entry.event.kind === "refusals-dismissed" && entry.event.throughSeq === 999999999));
  for (const [name, what] of [["seen", "mark a reply as seen"], ["dismiss", "dismiss what bb refused a thread"], ["read", "mark a brief as read"]]) {
    probeCheck(
      `nor ${what}: the method is gone, by HTTP and by bb plugin rpc call, and through the signed method an unsigned or forged call is refused`,
      [`old-${name}`, `bb-rpc-${name}`, `unsigned-${name}`, `bb-rpc-signed-${name}`, `forged-${name}`],
      () => !/"ok":true/.test(got[`old-${name}`]) && /error|unknown|not found/i.test(got[`bb-rpc-${name}`]) && only.test(got[`unsigned-${name}`]) && only.test(got[`bb-rpc-signed-${name}`]) && /signature does not match/.test(got[`forged-${name}`]),
      () => [got[`old-${name}`], got[`bb-rpc-${name}`], got[`unsigned-${name}`], got[`forged-${name}`]].map((line) => line.slice(0, 80)).join(" | "),
    );
  }
  check("the routes of the second set ran too, inside the fixture's sandbox", lightRows.length >= 1 && lightRoutes.every(([name]) => got[name] !== null), lightRows.length === 0 ? "probe did not run: the fixture never ran it" : `no output for ${lightRoutes.filter(([name]) => got[name] === null).map(([name]) => name).join(", ") || "none"} · ${lightOutput.slice(0, 160)}`);
  check("nothing it tried took a line out of the queue: what is seen, dismissed and read is as it was, and nothing was logged", lightAfter === lightBefore && lightLogged.length === 0, `${lightBefore} -> ${lightAfter}`);
  await page.waitFor(`!!document.querySelector('[data-cow-key-waiting="${agentKey.fingerprint}"]')`, { label: "the fixture's request in the queue" });
  check("that request is in the person's queue, under the name the fixture gave it", (await page.eval(`document.querySelector('[data-cow-key-waiting="${agentKey.fingerprint}"] p').textContent`)).includes("made by a fixture"));
  await shot("keys-agent-request");
  probeCheck(
    "it cannot create the reset file: the sandbox stops it, and enrollment stands",
    ["reset-file"],
    () => !got["reset-file"].includes("CREATED-THE-RESET-FILE") && /not permitted|denied|read-only/i.test(got["reset-file"]) && !existsSync(resetPath) && keysAfter.keys.length > 0,
    () => got["reset-file"].slice(0, 160),
  );
  if (got["bb-approve"] !== null) await page.waitFor(`${lineEl(chead)}?.dataset.cowOutside === "1"`, { label: "bb's own approve, flagged", timeout: 40_000 });
  const doingAfter = await page.eval(doing(chead));
  const outsideLogged = (await capLog(40)).some((entry) => entry.event.kind === "outside" && entry.event.interactionId === probeRequest.id && entry.by === null);
  probeCheck(
    "bb's own approve command still works for it, because that is bb's: and the approval is flagged on the line as made outside cow",
    ["bb-approve"],
    () => /approved/.test(got["bb-approve"]) && doingAfter.includes("approved outside cow: run: echo cow probe pending") && outsideLogged,
    () => got["bb-approve"].slice(0, 120),
  );
  await shot("keys-probe-outside");
  // Put away what the probe was given to try.
  await signer.must("key_refuse", { fingerprint: agentKey.fingerprint });
  await signer.must("key_remove", { fingerprint: agentKey.fingerprint });
  await cow("ask", "withdraw", probeAsk.id);
  await select(chead);
  await page.key(" ");
  await page.waitFor(`${lineEl(chead)}?.dataset.cowOutside === undefined`, { label: "acknowledged" });
  const signedEntries = (await fullLog(300)).filter((entry) => ["created", "deleted", "restored", "acknowledged", "decided", "sent", "ask-answered", "ask-closed", "seen", "refusals-dismissed", "brief-read", "main-chosen", "key-refused", "key-removed"].includes(entry.event.kind));
  const enrolledNow = new Set((await signer.state()).keys.map((key) => key.fingerprint));
  check(
    "every log entry for one of the person's actions names the key that signed it",
    signedEntries.length > 10 && signedEntries.every((entry) => /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(entry.by ?? "")) && signedEntries.slice(0, 3).every((entry) => enrolledNow.has(entry.by)),
    JSON.stringify(signedEntries.find((entry) => !entry.by) ?? signedEntries.length),
  );
  await waitForThread(chead, (t) => t.status === "idle", "the approved command run", 120_000);
  await settle(chead);
  await settle(ckid);

  // -- both themes, and a narrow window -----------------------------------------
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet, for its looks" });
  // The sheet is drawn on the page's own paper, in its ink, whichever of bb's appearances is on.
  const looks = `JSON.stringify({ paper: getComputedStyle(${sheet}).backgroundColor, page: getComputedStyle(${ROOT}).backgroundColor, ink: getComputedStyle(${sheet}.querySelector(".cow-cap-name")).color, pageInk: getComputedStyle(${ROOT}).color })`;
  const seen = {};
  for (const scheme of ["dark", "light"]) {
    await page.colorScheme(scheme);
    seen[scheme] = JSON.parse(await page.eval(looks));
    await shot(`caps-sheet-${scheme}`);
  }
  check(
    "the sheet draws with bb's theme, light and dark: the page's paper and ink",
    ["dark", "light"].every((scheme) => seen[scheme].paper === seen[scheme].page && seen[scheme].ink === seen[scheme].pageInk && seen[scheme].ink !== seen[scheme].paper),
    JSON.stringify(seen),
  );
  await page.resize(700, 800);
  await sleep(1500);
  await page.waitFor(`${screen} === "overview"`, { label: "the page in a narrow window" });
  if (!(await page.eval(`!!${sheet}`))) {
    await page.key("C");
    await page.waitFor(`!!${sheet}`, { label: "the sheet in a narrow window" });
  }
  const narrow = JSON.parse(await page.eval(`JSON.stringify({ fits: ${sheet}.scrollWidth <= ${sheet}.clientWidth + 1, body: ${sheet}.querySelector(".cow-sheet-body").scrollWidth <= ${sheet}.querySelector(".cow-sheet-body").clientWidth + 1, rows: ${sheet}.querySelectorAll("[data-cow-cap]").length })`));
  check("in a narrow window the sheet's lines wrap instead of running off the side", narrow.fits && narrow.body && narrow.rows >= 3, JSON.stringify(narrow));
  await shot("caps-sheet-narrow");
  await page.key("q");
  await page.resize(1440, 900);
  await sleep(1500);
  await page.waitFor(`${screen} === "overview" && !!${lineEl(chead)}`, { label: "the page back at full width" });

  // -- the cursor keeps its place when its line leaves -------------------------------
  const placed = [];
  for (const letter of ["a", "b", "c", "d"]) {
    placed.push(await signer.must("cap_create", { name: `cow test place ${letter}`, note: null, rule: { kind: "command", mode: "exact", text: `echo cow place ${letter}` }, scope: { kind: "thread", threadId: ckid }, via: "sheet", sourceThreadId: null, askId: null }));
  }
  for (const notice of (await capState()).notices) if (placed.some((capability) => capability.id === notice.capabilityId)) await signer.must("cap_ack", { noticeId: notice.id });
  await page.key("C");
  await page.waitFor(`!!${sheet}`, { label: "the sheet, for its cursor" });
  await sheetRow(page, `[data-cow-cap="${placed[1].id}"]`);
  await page.key("x");
  await page.waitFor(`!!${sheet}.querySelector('[data-cow-sheet-confirm="delete"]')`, { label: "the middle one's deletion, to confirm" });
  await page.key("y");
  await page.waitFor(`!${sheet}.querySelector('[data-cow-cap="${placed[1].id}"]')`, { label: "the middle one gone", timeout: 20_000 });
  await sleep(300);
  const afterSheet = await page.eval(sheetCursor);
  check("with the cursor on a middle line, deleting it leaves the cursor on the line that followed", afterSheet === placed[2].id, String(afterSheet));
  await signer.must("cap_delete", { id: placed[2].id });
  await page.waitFor(`!${sheet}.querySelector('[data-cow-cap="${placed[2].id}"]')`, { label: "deleted from elsewhere", timeout: 20_000 });
  await sleep(300);
  const afterElsewhere = await page.eval(sheetCursor);
  check("and when its line is removed from elsewhere while the sheet is open, the same", afterElsewhere === placed[3].id, String(afterElsewhere));
  await page.key("q");
  await page.waitFor(`!${sheet}`, { label: "the sheet closed" });

  // -- put away ---------------------------------------------------------------------
  await restoreCaps();
  await page.waitFor(`!document.querySelector("[data-cow-notice]") && !${lineEl(chead)}?.dataset.cowCaps`, { label: "the capabilities gone from the page", timeout: 20_000 });
  check("with every capability deleted, no line carries the mark", (await mark(ckid)) === null && (await mark(chead)) === null && (await capState()).capabilities.every((capability) => capability.deletedAt !== null || !Object.values(ids).includes(capability.scope.threadId)));
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
  await guardPlugin(BB, PLUGIN, args);
  const ids = await fixtures();
  await assertOurs(ids);
  Object.assign(inUse, ids);

  // A page left open by an earlier run would go on acting on the fixtures:
  // a chat open in its pane marks that thread's reply seen as it arrives.
  // This Chrome is the check's own, so every tab but one is closed too.
  const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((tab) => tab.type === "page");
  for (const tab of tabs.slice(1)) await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => undefined);
  const stale = await connect(PORT, "");
  await stale.goto("about:blank");
  stale.close();
  // The check's own key is the first enrolled; its browser's is approved with it when the page opens.
  signer = await createSigner(BB, "the end-to-end check", PLUGIN);
  await ownKey();
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
        now = await signer.must("main_choose", { projectId: project, threadId: before.mains[project] ?? null });
      }
    }
    const current = before.currentProjectId;
    const movedByUs = now.currentProjectId === null || ourProjects.includes(now.currentProjectId);
    if (current && now.currentProjectId !== current && movedByUs && now.mains[current]) {
      await signer.must("main_choose", { projectId: current, threadId: now.mains[current] });
    }
  };

  if (flag("only-reader") || flag("only-workspace") || flag("only-caps") || flag("only-waiting") || flag("only-settle") || flag("only-ledger") || flag("only-outside") || flag("only-automations") || flag("only-plugins") || flag("only-history") || flag("only-traces") || flag("only-card") || flag("only-open")) {
    const page = await connect(PORT, "");
    const shot = async (name, from = page) => {
      if (SHOTS) await from.shot(join(SHOTS, `${name}.png`));
    };
    await page.goto(`${BB}/plugins/${PLUGIN}/main`);
    await page.eval(`sessionStorage.removeItem("cow:main"); sessionStorage.removeItem("cow:test-clock-offset-ms"); true`);
    await page.resize(1440, 900);
    await page.colorScheme("light");
    await page.goto(`${BB}/plugins/${PLUGIN}/main`);
    await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page", timeout: 60_000 });
    await enrolPage();
    const chooseMain = async (tab, id) => {
      if ((await tab.eval(screen)) === "overview") await tab.key("M");
      await tab.waitFor(`${screen} === "picker"`, { label: "the picker" });
      await tab.eval(`document.querySelector('[data-cow-line="${id}"]').click(); true`);
      await tab.waitFor(`${screen} === "overview" && document.querySelector(".cow-mainline")?.dataset.cowLine === "${id}"`, { label: "the overview" });
      await restoreStored();
    };
    if (flag("only-caps")) await capsChecks(page, ids, shot, chooseMain);
    else if (flag("only-workspace")) await workspaceChecks(page, ids, shot, chooseMain);
    else if (flag("only-waiting")) await waitingChecks(page, ids, shot, chooseMain);
    else if (flag("only-settle")) await settleChecks(page, ids, shot, chooseMain);
    else if (flag("only-ledger")) await ledgerChecks(page, ids, shot, chooseMain);
    else if (flag("only-outside")) await outsideChecks(page, ids, shot, chooseMain);
    else if (flag("only-automations")) await automationChecks(page, ids, shot, chooseMain);
    else if (flag("only-plugins")) await pluginChecks(page, ids, shot, chooseMain);
    else if (flag("only-history")) await historyChecks(page, ids, shot, chooseMain);
    else if (flag("only-traces")) await traceChecks(page, ids, shot, chooseMain);
    else if (flag("only-card")) await cardChecks(page, ids, shot, chooseMain);
    else if (flag("only-open")) await openChecks(page, ids, shot, chooseMain);
    else await readingChecks(page, ids, shot, chooseMain);
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
  if (resetEnd !== undefined) await signer.must("seen_set", { threadId: ids.perms, seen: { seq: resetEnd, at: Date.now() } });

  const page = await connect(PORT, "");
  const shot = async (name, from = page) => {
    if (SHOTS) await from.shot(join(SHOTS, `${name}.png`));
  };
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `sessionStorage.removeItem("cow:test-clock-offset-ms");`,
  });
  // A window that has never shown a Main, as a new one is.
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  // Folds belong to the window: a run that stopped part-way may have left some.
  await page.eval(`sessionStorage.removeItem("cow:main"); sessionStorage.removeItem("cow:folds"); true`);
  await page.resize(1440, 900);
  await page.colorScheme("light");
  await page.goto(`${BB}/plugins/${PLUGIN}/main`);
  await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page" });
  await enrolPage();

  // What the parts below share: ways to read the page, and what one part finds that a later one uses.
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
  const lineData = (id, name) => `(document.querySelector('.cow-main [data-cow-line="${id}"]')?.dataset.${name} ?? null)`;
  const rollupOf = (id) =>
    `(document.querySelector('.cow-main [data-cow-line="${id}"] [data-cow-rollup]')?.dataset.cowRollup ?? null)`;
  const whText = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"] .cow-wh')?.textContent ?? "")`;
  const isReply = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"]')?.dataset.cowReply === "")`;
  const queueText = (id) => `(document.querySelector('[data-cow-queue="${id}"] p')?.textContent ?? "")`;
  const pageMessage = `(document.querySelector("[data-cow-message]")?.textContent ?? "")`;
  const seenOf = async (id) => (await rpc("notes_list", { threadIds: [id] })).seen[id] ?? null;
  const lastTurnEnd = async (id) =>
    (await api(`/threads/${id}/events?types=turn/completed&limit=1&order=desc`))[0]?.seq ?? null;
  const unseenDot = (id) => `!!document.querySelector('.cow-main [data-cow-line="${id}"] [data-cow-unseen]')`;
  const paneOf = `(document.querySelector("[data-cow-pane]")?.dataset.cowPane ?? null)`;
  const openMarks = `JSON.stringify([...${ROOT}.querySelectorAll("[data-cow-open]")].map((el) => el.dataset.cowLine))`;
  const inChatNow = `!!document.activeElement?.closest("[data-cow-chat]")`;
  const inTree = (id) => `!!document.querySelector('.cow-main [data-cow-line="${id}"]')`;
  const goTo = async (id) => {
    await page.key("g");
    await page.key("g");
    for (let i = 0; i < 40 && !(await page.eval(isCursor(id))); i += 1) await page.key("j");
    if (!(await page.eval(isCursor(id)))) throw new Error(`could not select ${id}`);
  };
  const treeIds = `JSON.stringify([...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine))`;
  const contextIds = `JSON.stringify([...document.querySelectorAll(".cow-main [data-cow-context]")].map((el) => el.dataset.cowLine))`;
  const matchCount = `Number(document.querySelector("[data-cow-filter-count]")?.dataset.cowFilterCount ?? -1)`;
  const outsideDrawn = `document.querySelectorAll(".cow-main [data-cow-outside-line]").length`;
  const LINK = "https://example.com/cow-test";
  const note = `jk12 note ${Date.now()} ${LINK}`;
  const hintList = async () =>
    JSON.parse(
      await page.eval(`JSON.stringify([...document.querySelectorAll("[data-cow-hint-label]")].map((el) => ({
        label: el.dataset.cowHintLabel, in: el.dataset.cowHintIn, for: el.dataset.cowHintFor })))`),
    );
  const typeHint = async (label) => {
    for (const letter of label) await page.key(letter);
  };
  const childThreads = `document.querySelector('[data-cow-chat] button[aria-label*="active child thread"]')?.getAttribute("aria-expanded")`;
  const shown = (list) => new Set(list.map((hint) => `${hint.label}=${hint.for}`));
  /** What the open chat looks like now: where it is scrolled, how tall, how many things in it can be clicked, how much it says. */
  const chatLook = async () =>
    JSON.parse(
      await page.eval(`JSON.stringify((() => {
        const chat = document.querySelector("[data-cow-chat]");
        if (!chat) return null;
        const scroller = [chat, ...chat.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY)).sort((x, y) => y.scrollHeight - x.scrollHeight)[0];
        return {
          top: Math.round(scroller?.scrollTop ?? -1),
          height: scroller?.scrollHeight ?? -1,
          clickable: chat.querySelectorAll("a[href], button, [role=button], textarea, [contenteditable=true]").length,
          text: chat.textContent.length,
        };
      })())`),
    );
  /** Wait until the open chat has looked the same for a second and a half. */
  const chatAtRest = async (timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    let last = null;
    let same = 0;
    while (same < 3) {
      if (Date.now() > deadline) throw new Error(`the chat never came to rest: ${JSON.stringify(last)}`);
      await sleep(500);
      const now = JSON.stringify(await chatLook());
      same = now === last ? same + 1 : 0;
      last = now;
    }
  };
  const openMenus = `[...document.querySelectorAll('[role="menu"]')].filter((el) => !el.closest("[data-cow-root]") && el.dataset.state !== "closed").length`;
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
  const chosen = `JSON.stringify([...document.querySelectorAll("[data-cow-answer-option]")].map((o) => o.dataset.cowChosen === "true"))`;
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
    if (seq !== null) await signer.must("seen_set", { threadId: id, seen: { seq, at: Date.now() } });
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
  const blockedCard = `document.querySelector('[data-cow-blocked="${ids.perms}"]')`;
  const blockedMessage = `(document.querySelector('[data-cow-input="blocked-message"]')?.value ?? null)`;
  const blockedChosen = `JSON.stringify([...document.querySelectorAll("[data-cow-blocked-action]")].map((o) => o.dataset.cowChosen === "true"))`;
  const dismissal = async (id) => (await rpc("notes_list", { threadIds: [id] })).dismissals[id] ?? null;
  const userRows = async (id) =>
    (await api(`/threads/${id}/timeline`)).rows.filter((row) => row.kind === "conversation" && row.role === "user");
  const blockedPath = `/tmp/cow-test-blocked-${Date.now()}/cow.txt`;
  const why = `not now 12 jx ${Date.now()}`;
  const scratch = `/tmp/cow-test-${Date.now()}`;
  const confirmBox = `(document.querySelector("[data-cow-permission-confirm]")?.textContent ?? "")`;
  const reason = "waiting on jkxpaeu 12";
  const promptLabel = `(document.querySelector(".cow-prompt label")?.textContent ?? "")`;
  const promptHelp = `(document.querySelector(".cow-prompt small")?.textContent ?? "")`;
  const dropReason = "no longer wanted 12";
  const archiveReason = (id) =>
    `(document.querySelector('.cow-main [data-cow-line="${id}"] [data-cow-archive-reason]')?.textContent ?? "")`;
  const reasonValue = `${promptInput("archive-reason")}?.value`;
  const reasonGiven = "superseded by jkxy 12";
  // A thread's own line starts with its place in the queue, or a gap, and then its state.
  const statusLine = (id) =>
    status.stdout.split("\n").find((line) => line.includes(`(${id})`) && /^[ \d]{4}(wants|blocked|running|stuck|parked|failed|idle|done) /.test(line)) ?? "";
  const asideTexts = async () => JSON.parse(await fresh.eval(`JSON.stringify(Object.fromEntries([...document.querySelectorAll("[data-cow-aside]")].map((el) => [el.dataset.cowAside, el.textContent])))`));
  const noteOf = (id) => `(document.querySelector('.cow-main [data-cow-line="${id}"] .cow-nx [data-cow-note]')?.textContent ?? null)`;
  const todoTitles = (id) =>
    `JSON.stringify([...document.querySelectorAll('.cow-main [data-cow-todo-of="${id}"] .cow-title')].map((el) => el.textContent))`;
  const cliTodos = async (id) => JSON.parse((await cow("todo", "list", id, "--json")).stdout).todo.map((item) => item.title);
  const todoCursor = `(document.querySelector(".cow-main .cow-cur")?.dataset.cowTodo ?? null)`;
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
  const active = {};
  let first, second, stored, other, restored, order, listedOrder, shape, quietFirst, quietSaid, quietEnd, seenMarks, numbered, queueSize, bottom, failsNumber, allLines, keptOpen, queue, hints, stillAsking, toLine, secondEnd, cursorBefore, toMain, timeline, mainNumber, inChat, ownLines, linkHint, composerHint, toggleHint, expandedBefore, inChatAgain, hintsBefore, hintsAfter, withHover, actionsHint, inBbMenu, composerAgain, inMenu, card, fileRefusal, rowsBefore, carryOn, rowsBeforeDismiss, dismissMarks, askAgain, asked, ranRow, permCard, deniedRows, moo, fileCard, granted, afterQuiet, parkedAt, parked, shelf, kept, longAge, afterFails, help, status, statusJson, resumed, noReason, badDate, cliParkedAt, cliParked, cliNote, again, notParked, missing, openUnder, asJson, archived, twice, namedArchived, storedArchived, fresh, intro, lede, asides, afterDismiss, stranger, upward, own, fromAbove, third, placed, statusPlans, started, noSuch, themes, cowTheme, themeBefore, narrow, paneWidth;

  // -- the parts --
  // The default run is made of the parts below, in this order. Each starts
  // from a known page: anything a part before it left open (a menu of bb's,
  // a sheet, a card, a prompt, the filter, hint mode, the chat, another tab)
  // is closed by reloading the page, folds are cleared, the window is back
  // at its size and on Main, and the cursor is on the heading, or on the line
  // the part names. A part that throws, or times out waiting, is recorded as
  // failed with its message, and the run goes on with the next part. A part
  // that needs what an earlier part found, or the state it left the fixtures
  // in, says so: it is skipped, not failed, when that part stopped part-way
  // or (for what it found) did not run.
  const { targetId: ownTarget } = (await page.send("Target.getTargetInfo")).targetInfo;
  let reached = !FROM;
  const startAfresh = async (start) => {
    const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((tab) => tab.type === "page" && tab.id !== ownTarget);
    for (const tab of tabs) await fetch(`http://127.0.0.1:${PORT}/json/close/${tab.id}`).catch(() => undefined);
    await page.send("Page.bringToFront");
    await page.resize(1440, 900);
    await page.colorScheme("light");
    await page.eval(`sessionStorage.removeItem("cow:folds"); true`);
    await page.goto(`${BB}/plugins/${PLUGIN}/main`);
    await page.waitFor(`["picker", "overview"].includes(${screen})`, { label: "the page, at the start of a part", timeout: 60_000 });
    if ((await page.eval(screen)) !== "overview" || (await page.eval(heading)) !== ids.main) {
      await chooseMain(page, ids.main);
      await restoreStored();
    }
    await page.waitFor(`${screen} === "overview" && !!document.querySelector(".cow-main [data-cow-line]")`, { label: "the lines, at the start of a part" });
    await page.key("g");
    await page.key("g");
    if (start) await select(start);
  };
  /**
   * Run one part. `start` is the line to select first. `needs` names parts whose
   * findings this one uses: it runs only when they ran to the end in this run.
   * `after` names parts whose effect on the fixtures this one builds on: it is
   * skipped when they stopped part-way, and runs when they were left out with --from.
   */
  const part = async (name, { start = null, needs = [], after = [], asItIs = false }, body) => {
    if (!PART_NAMES.includes(name)) throw new Error(`part ${name} is not in PART_NAMES`);
    if (name === FROM) reached = true;
    if (!reached) {
      parts.push({ name, status: "left out" });
      return;
    }
    const statusOf = (other) => parts.find((entry) => entry.name === other)?.status ?? "not run";
    const missing = [...needs.filter((other) => statusOf(other) !== "passed" && statusOf(other) !== "failed checks"), ...after.filter((other) => statusOf(other) === "stopped")];
    if (missing.length) {
      parts.push({ name, status: "skipped", message: missing.map((other) => `${other} ${statusOf(other)}`).join(", ") });
      console.log(`SKIP part ${name}: it needs ${missing.map((other) => `${other}, which ${statusOf(other) === "not run" || statusOf(other) === "left out" ? "did not run" : "stopped part-way"}`).join("; ")}`);
      return;
    }
    console.log(`\n== part ${name}`);
    const checksBefore = results.length;
    try {
      if (!asItIs) await startAfresh(start);
    } catch (error) {
      parts.push({ name, status: "stopped", message: `could not start from a known page: ${error.message}` });
      check(`part ${name} starts from a known page`, false, error.message);
      return;
    }
    try {
      await body();
      const failedChecks = results.slice(checksBefore).filter((result) => !result.ok).length;
      parts.push({ name, status: failedChecks ? "failed checks" : "passed", message: failedChecks ? `${failedChecks} checks failed` : "" });
    } catch (error) {
      parts.push({ name, status: "stopped", message: error.message });
      check(`part ${name} runs to its end`, false, error.message);
      if (error.stack) console.log(error.stack.split("\n").slice(1, 4).join("\n"));
    }
  };

  await part("choosing-main", { asItIs: true }, async () => {
    // -- choosing Main --
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
    first = await page.eval(cursorId);
    await page.key("j");
    second = await page.eval(cursorId);
    await page.key("k");
    check("picker: j and k move the cursor", first !== second && (await page.eval(cursorId)) === first);
    await chooseMain(page, ids.main);
    stored = await rpc("main_state", null);
    check(
      "picker: Enter makes the selected thread Main, and the choice is stored for its project",
      stored.mains[PROJECT_OF.main] === ids.main && stored.currentProjectId === PROJECT_OF.main,
    );
    check(
      "Main is the page heading",
      (await page.eval(`document.querySelector(".cow-crumbs b")?.textContent`)) === TITLE,
    );
  });
  if (flag("only-raised")) {
    await raisedChecks(page, ids, shot, chooseMain);
    return finish(page);
  }

  await part("windows", {}, async () => {
    // -- each window keeps its own Main --
    other = await newTab(PORT);
    await other.resize(1200, 800);
    await other.goto(`${BB}/plugins/${PLUGIN}/main`);
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
    await page.goto(`${BB}/plugins/${PLUGIN}/main`);
    await other.goto(`${BB}/plugins/${PLUGIN}/main`);
    await page.waitFor(`${screen} === "overview"`, { label: "the first window reloaded" });
    await other.waitFor(`${screen} === "overview"`, { label: "the second window reloaded" });
    check(
      "each window keeps its own Main through a reload, whatever is stored",
      (await page.eval(heading)) === ids.main && (await other.eval(heading)) === ids.runs,
      `${await page.eval(heading)} / ${await other.eval(heading)}`,
    );
    restored = await rpc("main_state", null);
    check(
      "what the run changed in the stored Mains is back as it was",
      ours(restored) === ours(before),
      JSON.stringify(restored),
    );
    check("the second window has no console errors", other.consoleErrors.length === 0, other.consoleErrors.join(" | "));
    await other.close();
    // A tab in the background runs no animations, and bb's menus close with one.
    await page.send("Page.bringToFront");
  });

  await part("lines", {}, async () => {
    // -- lines and states --
    await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the failed line" });
    check("a thread with a pending question wants you", (await page.eval(lineState(ids.asks))) === "wants");
    await page.waitFor(
      `document.querySelector('[data-cow-line="${ids.asks}"] .cow-wh')?.textContent.startsWith("Which colour?")`,
      { label: "the question on its line" },
    );
    check("its line shows the question it asked", true);
    check("a thread whose last turn failed is failed", true);
    order = await page.eval(
      `JSON.stringify([...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine))`,
    );
    listedOrder = JSON.parse(order);
    check(
      "lines follow the tree: child, its child, that one's child, next child; then the two done ones",
      JSON.stringify(listedOrder.slice(0, 4)) === JSON.stringify([ids.quiet, ids.fails, ids.leaf, ids.asks]) &&
        JSON.stringify(listedOrder.slice(4).sort()) === JSON.stringify([ids.runs, ids.perms].sort()),
      order,
    );
  });

  await part("groups", {}, async () => {
    // -- groups: three levels, drawn as nested groups --
    shape = JSON.parse(
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
  });

  await part("attention", {}, async () => {
    // -- attention: whose a finished turn's reply is --
    // The group head's newest turn is one the person did not start: its first,
    // spawned. A fixture kept from an earlier run last replied to the person,
    // below; Main tells it something first, as a run that starts afresh would find it.
    await page.waitFor(`(${lineState(ids.quiet)} === "wants" && ${isReply(ids.quiet)}) || (${lineState(ids.quiet)} === "idle" && ${unseenDot(ids.quiet)})`, {
      label: "the group head's reply",
    });
    if ((await page.eval(lineState(ids.quiet))) === "wants") {
      await tellAs(ids.main, ids.quiet, "again");
      await sleep(3000);
      await waitForThread(ids.quiet, (t) => t.status === "idle", "its reply to Main");
    }
    await page.waitFor(`${lineState(ids.quiet)} === "idle" && ${unseenDot(ids.quiet)}`, { label: "the group head marked unread", timeout: 30_000 });
    // Whatever it said last: a fixture from an earlier run may not have said "ok".
    quietFirst = (await api(`/threads/${ids.quiet}/output`)).output.trim();
    check(
      "a group head whose newest turn you did not start reads idle, says what it said, with the unread dot, and is not in the queue",
      (await page.eval(whText(ids.quiet))) === quietFirst &&
        !(await page.eval(isReply(ids.quiet))) &&
        !(await page.eval(`!!document.querySelector('[data-cow-queue="${ids.quiet}"]')`)),
      await page.eval(whText(ids.quiet)),
    );
    // Told something by the person, the same head's reply is theirs.
    await tellAs(null, ids.quiet, "hello");
    await sleep(3000);
    await waitForThread(ids.quiet, (t) => t.status === "idle", "its reply to the person");
    quietSaid = (await api(`/threads/${ids.quiet}/output`)).output.trim();
    await page.waitFor(`${lineState(ids.quiet)} === "wants" && ${isReply(ids.quiet)}`, { label: "the group head's reply to the person", timeout: 30_000 });
    check(
      "the same head, told something by you, replied to you",
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
    quietEnd = await lastTurnEnd(ids.quiet);
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
    seenMarks = (await fullLog(200)).filter((entry) => entry.event.kind === "seen" && entry.event.threadId === ids.quiet).slice(0, 2);
    check(
      "the mark and its undo were both signed by this page's key, and are in the log",
      seenMarks.length === 2 && seenMarks[0].event.seq === null && seenMarks[1].event.seq === quietEnd && seenMarks.every((entry) => entry.by !== null) && seenMarks[0].by === (await pageKeyNow()),
      JSON.stringify(seenMarks.map((entry) => [entry.event, entry.by])),
    );
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
    numbered = JSON.parse(
      await page.eval(`JSON.stringify(Object.fromEntries([...${ROOT}.querySelectorAll("[data-cow-line]")]
        .map((el) => [el.dataset.cowLine, el.querySelector(".cow-qn")?.textContent ?? ""])))`),
    );
    queueSize = await page.eval(`document.querySelectorAll("[data-cow-queue]").length`);
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
  });

  await part("moving", { needs: ["lines"] }, async () => {
    // -- moving --
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
    // Below the tree come the sections, in the page's order; a heading with
    // nothing under it is no stop. Outside Main holds the other fixtures' Mains.
    await page.key("G");
    bottom = JSON.parse(
      await page.eval(`JSON.stringify((() => {
        const stops = [...document.querySelectorAll(".cow-main [data-cow-line], .cow-main [data-cow-outside-line], .cow-main [data-cow-section]")]
          .filter((el) => el.querySelector("[data-cow-section-count]")?.dataset.cowSectionCount !== "0");
        const cur = document.querySelector(".cow-main .cow-cur");
        const lastLine = document.querySelector('.cow-main [data-cow-line="${listedOrder[listedOrder.length - 1]}"]');
        return {
          last: stops.at(-1) === cur,
          belowTheLines: !!cur && !!lastLine && (lastLine === cur || !!(lastLine.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING)),
          on: cur?.dataset.cowLine ?? cur?.dataset.cowSection ?? cur?.dataset.cowOutsideLine ?? null,
        };
      })())`),
    );
    check("G goes to the last stop on the page, below every line", bottom.last && bottom.belowTheLines, bottom.on);
  });

  await part("folding", {}, async () => {
    // -- folding a group --
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
    await page.goto(`${BB}/plugins/${PLUGIN}/main`);
    await page.waitFor(`${screen} === "overview" && ${inTree(ids.quiet)}`, { label: "the page reloaded" });
    check(
      "the fold is this window's, and survives a reload",
      (await page.eval(lineData(ids.quiet, "cowFold"))) === "folded" && !(await page.eval(inTree(ids.fails))),
    );
    failsNumber = await page.waitFor(
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
  });

  await part("filter", {}, async () => {
    // -- filtering the lines --
    allLines = JSON.parse(await page.eval(treeIds));
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
    // Every fixture is a "cow test": the lines on the page match, and so do the
    // other fixtures' Mains, under Outside Main, folded: drawn while they match.
    await page.waitFor(`${matchCount} === ${allLines.length} + ${outsideDrawn} && ${outsideDrawn} > 0`, { label: "every line matching loosely" });
    check(
      "a name matches loosely, letters in order; done lines, and lines in a folded section, are searched too",
      (await page.eval(treeIds)) === JSON.stringify(allLines) && (await page.eval(isCursor(ids.quiet))),
      `${await page.eval(matchCount)} of ${allLines.length} + ${await page.eval(outsideDrawn)}`,
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
    // A folded head kept with Enter is unfolded too, so j goes on to its first subthread.
    await goTo(ids.quiet);
    await page.key("h");
    await page.waitFor(`${lineData(ids.quiet, "cowFold")} === "folded"`, { label: "the head folded" });
    await page.key("/");
    await page.type(TITLE);
    await page.waitFor(`${matchCount} === ${allLines.length} + ${outsideDrawn}`, { label: "its name matching" });
    await page.key("Enter");
    await page.waitFor(`${mode} === "normal"`, { label: "the filter closed" });
    keptOpen = await page.eval(lineData(ids.quiet, "cowFold"));
    await page.key("j");
    check("Enter unfolds the folded line it keeps: j then goes to its first subthread", keptOpen === "open" && (await page.eval(isCursor(ids.fails))), String(keptOpen));
    await page.key("/");
    await page.type("zzzz");
    await page.waitFor(`${matchCount} === 0`, { label: "no match" });
    await page.key("Enter");
    check(
      "with no match, Enter leaves the cursor where it was",
      (await page.eval(isCursor(ids.fails))) && (await page.eval(mode)) === "normal",
    );
  });

  await part("queue", {}, async () => {
    // -- the queue --
    queue = JSON.parse(
      await page.eval(
        `JSON.stringify([...document.querySelectorAll("[data-cow-queue]")].map((el) => el.dataset.cowQueue))`,
      ),
    );
    // Start on a line that is not in the queue: from one in it, Tab goes on to the one after.
    // Main can be in it, when the fixtures were kept with an unread reply of Main's.
    const notQueued = await page.eval(
      `[...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine).find((id) => !${JSON.stringify(queue)}.includes(id)) ?? null`,
    );
    await select(notQueued);
    await page.key("Tab");
    check("Tab jumps to the first ask", await page.eval(isCursor(queue[0])));
    await page.key("Tab");
    check("Tab again jumps to the next ask, wrapping", await page.eval(isCursor(queue[1 % queue.length])));
    await page.key("Tab", { shift: true });
    check("Shift+Tab jumps back", await page.eval(isCursor(queue[0])));
    await page.key("G");
    await page.key(String(queue.length));
    check("a digit jumps to that ask", await page.eval(isCursor(queue[queue.length - 1])));
  });

  await part("hints", {}, async () => {
    // -- hints --
    await page.key("g");
    await page.key("g");
    await page.key("f");
    check("f enters hint mode", (await page.eval(mode)) === "hint");
    await shot("hints");
    hints = JSON.parse(
      await page.eval(`JSON.stringify((() => {
        const tags = [...document.querySelectorAll("[data-cow-hint-label]")];
        const labels = tags.map((el) => el.dataset.cowHintLabel);
        const targets = [...${ROOT}.querySelectorAll("[data-cow-hint]")];
        const off = [...${ROOT}.querySelectorAll(".cow-vb.cow-off")];
        // Each label says what it is for: a line's id, for a line.
        const lineIds = new Set([...${ROOT}.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine));
        return {
          labels,
          targets: targets.length,
          asksLabel: tags.find((el) => el.dataset.cowHintFor === "${ids.asks}")?.dataset.cowHintLabel ?? "",
          lineLabels: tags.filter((el) => lineIds.has(el.dataset.cowHintFor)).map((el) => el.dataset.cowHintLabel),
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
    for (const letter of hints.asksLabel) await page.key(letter);
    check(
      "typing a hint activates it, with one key",
      hints.asksLabel.length === 1 &&
        (await page.eval(isCursor(ids.asks))) &&
        (await page.eval(mode)) === "normal",
      hints.asksLabel,
    );
    await page.key("f");
    await page.key("Escape");
    check(
      "Escape cancels hint mode",
      (await page.eval(mode)) === "normal" && (await page.eval(isCursor(ids.asks))),
    );
  });

  await part("legend", { start: ids.asks }, async () => {
    // -- legend --
    await page.key("?");
    check("? shows the legend and key map", await page.eval(`!!document.querySelector("[data-cow-help]")`));
    await shot("legend");
    await page.key("j");
    check("keys do nothing behind the legend", await page.eval(isCursor(ids.asks)));
    await page.key("Escape");
    check("Escape closes the legend", await page.eval(`!document.querySelector("[data-cow-help]")`));
  });

  await part("chat-pane", { start: ids.asks }, async () => {
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
    stillAsking = (await api(`/threads?threadIds=${ids.asks}&limit=1`))[0].hasPendingInteraction;
    check("digits and letters in the overview do not answer the chat's question", stillAsking);
    // The digits above jump to queue entries, and Main's heading can be one: the cursor is looked for on the whole page.
    const anyCursor = `${ROOT}?.querySelector(".cow-cur[data-cow-line]")?.dataset.cowLine ?? null`;
    const cursorInPane = await page.eval(anyCursor);
    await page.key("Escape");
    await page.waitFor(`!document.querySelector("[data-cow-pane]")`, { label: "the pane closing", timeout: 5000 }).catch(() => undefined);
    check(
      "Escape closes the pane and the cursor is where it was",
      (await page.eval(`!document.querySelector("[data-cow-pane]")`)) &&
        cursorInPane !== null && (await page.eval(anyCursor)) === cursorInPane,
      JSON.stringify({ pane: await page.eval(paneOf), before: cursorInPane, cursor: await page.eval(anyCursor), mode: await page.eval(mode), focus: await page.eval(`document.activeElement?.tagName ?? null`), inChat: await page.eval(inChatNow) }),
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
  });

  await part("say-and-live", { needs: ["attention"] }, async () => {
    // -- say, and a state change arriving live --
    await goTo(ids.quiet);
    await page.key("I");
    toLine = await page.eval(`document.querySelector(".cow-prompt label")?.textContent`);
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
    secondEnd = await lastTurnEnd(ids.quiet);
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

    cursorBefore = await page.eval(cursorId);
    await page.key("i");
    toMain = await page.eval(`document.querySelector(".cow-prompt label")?.textContent`);
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
    timeline = JSON.stringify(await api(`/threads/${ids.main}/timeline`));
    check("the say message arrived in Main", timeline.includes(note));

    // -- Main's unread reply is in the queue, and reading it clears it --
    mainNumber = await page.eval(
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
  });

  // The link it looks for in Main's chat is in the note say-and-live sent, or one an earlier run sent to the same fixtures.
  // Straight after say-and-live it goes on from where that left the page, with Main's chat just opened.
  const lastPart = parts.at(-1);
  await part("hints-in-chat", { after: ["say-and-live"], asItIs: lastPart?.name === "say-and-live" && lastPart.status === "passed" }, async () => {
    // -- hints reach everything clickable, inside the chat too --
    if ((await page.eval(paneOf)) !== ids.main) {
      await page.key("m");
      await page.waitFor(`document.querySelector("[data-cow-pane]")?.dataset.cowPane === "${ids.main}"`, { label: "Main's chat" });
    }
    await page.waitFor(`!!document.querySelector('[data-cow-chat] a[href^="${LINK}"]')`, { label: "the link in the chat" });
    // The chat draws itself for a while after it opens, and scrolls to its newest message: hints are counted once it is still.
    await chatAtRest();
    await page.eval(`window.__cowClicks = [];
    document.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link) return;
      // Recorded, and stopped from leaving the page: the check is that the click arrives.
      window.__cowClicks.push(link.getAttribute("href"));
      event.preventDefault();
    }, true); true`);
    const lookFirst = await chatLook();
    await page.key("f");
    inChat = await hintList();
    await shot("hints-chat");
    ownLines = inChat.filter((hint) => hint.for.startsWith("thr_"));
    check(
      "with the chat open, cow's own lines still come first, one letter each",
      ownLines.length >= 5 && ownLines.every((hint, index) => hint.label.length === 1 && inChat[index] === hint),
      ownLines.map((hint) => hint.label).join(" "),
    );
    linkHint = inChat.find((hint) => hint.in === "chat" && hint.for.startsWith(`a:${LINK}`));
    composerHint = inChat.find((hint) => hint.in === "chat" && /^(div|textarea):Ask/.test(hint.for));
    toggleHint = inChat.find((hint) => hint.in === "chat" && /^button:Collapse/.test(hint.for));
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
    expandedBefore = await page.eval(childThreads);
    const lookAgain = await chatLook();
    await page.key("f");
    inChatAgain = await hintList();
    [hintsBefore, hintsAfter] = [shown(inChat), shown(inChatAgain)];
    check(
      "the same things get the same hints the next time",
      JSON.stringify(inChatAgain) === JSON.stringify(inChat),
      JSON.stringify({ gone: [...hintsBefore].filter((hint) => !hintsAfter.has(hint)), new: [...hintsAfter].filter((hint) => !hintsBefore.has(hint)), chat: [lookFirst, lookAgain] }),
    );
    await typeHint(toggleHint?.label ?? "");
    await page.waitFor(`${childThreads} === "false"`, { label: "the chat's disclosure toggling", timeout: 5000 });
    check("a hint activates a button inside the chat: its list of child threads folds", expandedBefore === "true");
    // bb may focus what was pressed, then or a moment later; cow hands the keyboard back within a quarter of a second.
    await page.waitFor(`!document.activeElement?.closest("[data-cow-chat]")`, { label: "the keyboard back with the overview", timeout: 1000 }).catch(() => undefined);
    check(
      "the keyboard stays with the overview afterwards",
      await page.eval(`!document.activeElement?.closest("[data-cow-chat]")`),
      await page.eval(`(() => { const el = document.activeElement; return el ? el.tagName + " " + (el.getAttribute("aria-label") ?? el.textContent.slice(0, 40)) : "nothing"; })()`),
    );
    // A button the chat draws only under the mouse takes a hint too, and the
    // menu it opens outside the pane is reached by pressing f again.
    await page.key("f");
    withHover = await hintList();
    actionsHint = withHover.find((hint) => hint.in === "chat" && hint.for === "button:Message actions");
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
    inBbMenu = await hintList();
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
    composerAgain = (await hintList()).filter((hint) => hint.in === "chat" && /^(div|textarea):/.test(hint.for));
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
    inMenu = await hintList();
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
  });

  await part("verbs", {}, async () => {
    // -- verbs: select a line, then press the verb --
    // What can be undone lasts as long as the page: a reload starts with nothing.
    await page.goto(`${BB}/plugins/${PLUGIN}/main`);
    await page.waitFor(`${screen} === "overview" && !!document.querySelector('.cow-main [data-cow-line="${ids.quiet}"]')`, {
      label: "the page reloaded before the verbs",
    });

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
  });

  await part("answer", {}, async () => {
    // -- answer --
    await select(ids.asks);
    check("verb bar: a line with a question can be answered", (await page.eval(verbOff("answer"))) === false);
    await page.key("a");
    await page.waitFor(
      `document.querySelector('[data-cow-answer="${ids.asks}"] [data-cow-answer-prompt]')?.textContent.includes("Which colour?")`,
      { label: "the question card" },
    );
    card = JSON.parse(
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
    // Told to reply with exactly the answer, the cheap fixture model sometimes wraps it in a sentence: the answer is what counts.
    await page.waitFor(
      `/\\bblue\\b/i.test(document.querySelector('.cow-main [data-cow-line="${ids.asks}"] .cow-wh')?.textContent ?? "")`,
      { label: "the fixture repeating the answer", timeout: 120_000 },
    );
    check(
      "the fixture thread received the answer and replied with it",
      /\bblue\b/i.test((await api(`/threads/${ids.asks}/output`)).output),
      await page.eval(`document.querySelector('.cow-main [data-cow-line="${ids.asks}"] .cow-wh')?.textContent ?? ""`),
    );
    check("answering kept the cursor on the line", await page.eval(isCursor(ids.asks)));
  });

  await part("permissions", {}, async () => {
    // -- permission requests, and blocked on a permission: bb refused without asking --
    // Told by Main, as under cow, so no person started the turn and bb refuses by itself.
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
    fileRefusal = JSON.parse(
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
    rowsBefore = (await userRows(ids.perms)).length;
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
    carryOn = (await userRows(ids.perms)).at(-1);
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
    rowsBeforeDismiss = (await userRows(ids.perms)).length;
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
    dismissMarks = (await fullLog(200)).filter((entry) => entry.event.kind === "refusals-dismissed" && entry.event.threadId === ids.perms).slice(0, 2);
    check(
      "the dismissal and its undo were both signed by this page's key, and are in the log",
      dismissMarks.length === 2 && dismissMarks[0].event.throughSeq === null && typeof dismissMarks[1].event.throughSeq === "number" && dismissMarks[0].by !== null && dismissMarks[0].by === (await pageKeyNow()),
      JSON.stringify(dismissMarks.map((entry) => [entry.event, entry.by])),
    );

    await select(ids.perms);
    await page.key("a");
    await page.waitFor(`!!${blockedCard}`, { label: "the card, to ask again" });
    await page.key("1");
    await sleep(500);
    askAgain = await page.eval(blockedMessage);
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
    asked = (await userRows(ids.perms)).at(-1);
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
    ranRow = (await api(`/threads/${ids.perms}/timeline`)).rows.findLast((row) => row.command === "echo blocked cow");
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
    permCard = JSON.parse(
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
    deniedRows = (await api(`/threads/${ids.perms}/timeline`)).rows;
    moo = deniedRows.filter((row) => row.workKind === "command" && row.command === "echo moo").pop();
    check(
      "the command did not run, and the message reached the thread",
      moo?.approvalStatus === "denied" && !moo.output && deniedRows.some((row) => row.role === "user" && row.text === why),
      JSON.stringify(moo),
    );

    // A file change, and a grant wider than the one request.
    await sayTo(ids.perms, `write: ${scratch}/cow.txt`);
    await waitForThread(ids.perms, (t) => t.hasPendingInteraction, "asking to write", 60_000);
    await page.waitFor(`${lineText(ids.perms)}.startsWith("permission to change a file in ${scratch}")`, {
      label: "the file request on its line",
    });
    await page.key("a");
    await page.waitFor(`!!document.querySelector("[data-cow-permission-diff]")`, { label: "the diff on the card" });
    fileCard = JSON.parse(
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
    granted = await lastDecision(ids.perms);
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
  });

  await part("park", {}, async () => {
    // -- park --
    await select(ids.quiet);
    afterQuiet = await page.eval(
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
    parkedAt = Date.now();
    await page.key("Enter");
    await page.waitFor(`${lineState(ids.quiet)} === "parked"`, { label: "the parked line" });
    parked = await parkNote(ids.quiet);
    check(
      "parking keeps a note on the thread: the reason and a date three days on",
      parked?.reason === reason &&
        parked.pickUp.kind === "date" &&
        Math.abs(parked.pickUp.at - parkedAt - 3 * DAY) < 60_000,
      JSON.stringify(parked),
    );
    shelf = JSON.parse(
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
    kept = await parkNote(ids.quiet);
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
    longAge = JSON.parse(
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
  });

  await part("archive", {}, async () => {
    // -- archive, and undo --
    await select(ids.fails);
    afterFails = await page.eval(
      `(() => { const all = [...document.querySelectorAll(".cow-main [data-cow-line]")].map((el) => el.dataset.cowLine);
        // Its member leaves with it.
        const stay = all.filter((id) => id !== "${ids.leaf}");
        return stay[stay.indexOf("${ids.fails}") + 1] ?? stay[stay.indexOf("${ids.fails}") - 1]; })()`,
    );
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
  });

  await part("stop", { start: ids.runs }, async () => {
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
  });

  await part("cli", { after: ["stop", "archive"] }, async () => {
    // -- the CLI: the same verbs for an agent, and the page following along --
    help = await cow("help");
    check(
      "bb cow help lists the commands",
      help.code === 0 && ["status", "archive", "park", "resume"].every((name) => help.stdout.includes(`bb ${PLUGIN} ${name}`)),
      help.stdout,
    );
    status = await cow("status", "--main", ids.main);
    check(
      "bb cow status gives one line per thread with its state, and the parked shelf",
      status.code === 0 &&
        status.stdout.startsWith(`Main: ${TITLE} (${ids.main})`) &&
        /^ *\d+  failed /.test(statusLine(ids.fails)) &&
        /^ +parked .*long job/.test(statusLine(ids.runs)) &&
        status.stdout.includes("Parked (1)"),
      status.stdout,
    );
    statusJson = JSON.parse((await cow("status", "--main", ids.main, "--json")).stdout);
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

    resumed = await cow("resume", ids.runs);
    await page.waitFor(`${lineState(ids.runs)} !== "parked"`, { label: "the page following a CLI resume" });
    check(
      "bb cow resume removes the note, and the page shows it without a reload",
      resumed.code === 0 && (await parkNote(ids.runs)) === null,
      resumed.stderr,
    );
    noReason = await cow("park", ids.runs);
    badDate = await cow("park", ids.runs, "--reason", "set aside by the cli", "--pickup", "31 Feb");
    check(
      "bb cow park needs a reason, and rejects a date that does not exist, as the page does",
      noReason.code !== 0 && /--reason/.test(noReason.stderr) && badDate.code !== 0 && /there is no 31 Feb/.test(badDate.stderr) &&
        (await parkNote(ids.runs)) === null,
      `${noReason.stderr} / ${badDate.stderr}`,
    );
    cliParkedAt = Date.now();
    cliParked = await cow("park", ids.runs, "--reason", "set aside by the cli", "--pickup", "+3d");
    await page.waitFor(
      `${lineState(ids.runs)} === "parked" && ${lineText(ids.runs)}.includes("set aside by the cli")`,
      { label: "the page following a CLI park" },
    );
    cliNote = await parkNote(ids.runs);
    check(
      "bb cow park records the reason and pick-up, and the line moves to the shelf without a reload",
      cliParked.code === 0 &&
        cliNote?.reason === "set aside by the cli" &&
        cliNote.pickUp.kind === "date" &&
        Math.abs(cliNote.pickUp.at - (cliParkedAt + 3 * DAY)) < 60_000,
      `${cliParked.stderr} ${JSON.stringify(cliNote)}`,
    );
    await shot("cli-parked");
    again = await cow("park", ids.runs, "--reason", "twice");
    notParked = await cow("resume", ids.quiet);
    missing = await cow("resume", "thr_cow_test_no_such_thread");
    check(
      "the page's rules hold: no parking twice, no resuming what is not parked, no unknown thread",
      again.code !== 0 && /already parked/.test(again.stderr) &&
        notParked.code !== 0 && /it is not parked/.test(notParked.stderr) &&
        missing.code !== 0 && /there is no thread/.test(missing.stderr),
      `${again.stderr} / ${notParked.stderr} / ${missing.stderr}`,
    );
    openUnder = await cow("archive", ids.quiet, "--reason", "should be refused");
    check(
      "bb cow archive refuses a line with open threads under it, and exits non-zero",
      openUnder.code !== 0 && /threads under it are still open/.test(openUnder.stderr) && !(await facts(ids.quiet)).archivedAt,
      openUnder.stderr,
    );
    asJson = await cow("archive", ids.quiet, "--json");
    check(
      "with --json a refusal is an error object",
      asJson.code !== 0 && JSON.parse(asJson.stdout).error?.code === "cannot_archive",
      asJson.stdout,
    );
    archived = await cow("archive", ids.fails, "--reason", "cleaned up by the cli");
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
    twice = await cow("archive", ids.fails);
    check("archiving it twice is refused", twice.code !== 0 && /already archived/.test(twice.stderr), twice.stderr);
  });

  await part("archived-main", { after: ["cli"] }, async () => {
    // -- a Main that is archived: the CLI says so, and a new window starts over --
    namedArchived = await cow("status", "--main", ids.fails);
    await signer.must("main_choose", { projectId: PROJECT_OF.main, threadId: ids.fails });
    storedArchived = await cow("status");
    check(
      "bb cow status on an archived Main, named or stored, gives no overview: it says the Main is archived and what to do",
      namedArchived.code !== 0 && /is archived, so it cannot be read as Main/.test(namedArchived.stderr) && storedArchived.code !== 0 && /The Main chosen|the Main chosen/.test(storedArchived.stderr) && /is archived/.test(storedArchived.stderr) && /choose another Main|Choose another Main/.test(storedArchived.stderr) && storedArchived.stderr.includes(`bb thread unarchive ${ids.fails}`) && !/Waiting on the user/.test(storedArchived.stdout + namedArchived.stdout),
      `${namedArchived.stderr.trim()} | ${storedArchived.stderr.trim()}`,
    );
    // A new window starts from the stored Main; with that one archived it has none, as on a first run.
    fresh = await newTab(PORT);
    // In this window alone: bb reports another version and another theme, so both asides have something to say.
    await fresh.send("Page.enable");
    await fresh.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
      const real = window.fetch;
      window.fetch = async (...args) => {
        const response = await real(...args);
        const url = String(args[0]?.url ?? args[0]);
        const swap = url.includes("/api/v1/system/version") ? (text) => text.replace(/"currentVersion":"[^"]*"/, '"currentVersion":"0.51.2"') : url.includes("/api/v1/system/config") ? (text) => text.replace(/"themeId":"[^"]*"/g, '"themeId":"default"') : null;
        if (!swap || !response.ok) return response;
        return new Response(swap(await response.text()), { status: response.status, headers: response.headers });
      };
    })()`,
    });
    await fresh.resize(1440, 900);
    await fresh.goto(`${BB}/plugins/${PLUGIN}/main`);
    await fresh.eval(`localStorage.removeItem("cow:dismissed"); true`);
    await fresh.goto(`${BB}/plugins/${PLUGIN}/main`);
    await fresh.waitFor(`${screen} === "picker"`, { label: "the picker in a window whose stored Main is archived", timeout: 60_000 });
    intro = await fresh.eval(`document.querySelector("[data-cow-intro]")?.textContent ?? ""`);
    lede = await fresh.eval(`document.querySelector(".cow-lede")?.textContent ?? ""`);
    check(
      "with no Main, the page says what cow is, what a Main is and what to do now, before the list to choose from",
      intro.includes("cow shows all the work you have handed to agents on one page") && intro.includes("A Main is the one long-lived thread you talk to") && intro.includes("Now: choose the thread that is your Main") && lede.includes("The thread that was Main has been archived or deleted.") &&
        (await fresh.eval(`(() => { const intro = document.querySelector("[data-cow-intro]"), first = document.querySelector("[data-cow-screen='picker'] [data-cow-line]"); return !!intro && !!first && intro.getBoundingClientRect().bottom <= first.getBoundingClientRect().top; })()`)),
      intro.slice(0, 90),
    );
    await fresh.waitFor(`document.querySelectorAll("[data-cow-aside]").length === 2`, { label: "the two asides", timeout: 20_000 }).catch(() => undefined);
    asides = await asideTexts();
    check(
      "on a bb outside the tested range the page says so, quietly, naming both versions; with another theme active it mentions cow's own and how to turn it on",
      /This is bb 0\.51\.2\. cow was tested on bb 0\.49/.test(asides["bb:0.51.2"] ?? "") && (asides.theme ?? "").includes(`bb theme set plugin:${PLUGIN}:cow`) && (asides.theme ?? "").includes("bb theme reset"),
      JSON.stringify(asides).slice(0, 300),
    );
    await fresh.eval(`document.querySelectorAll("[data-cow-aside-dismiss]").forEach((button) => button.click()); true`);
    await sleep(400);
    afterDismiss = Object.keys(await asideTexts()).length;
    await fresh.goto(`${BB}/plugins/${PLUGIN}/main`);
    await fresh.waitFor(`${screen} === "picker"`, { label: "the picker again", timeout: 60_000 });
    await sleep(2500);
    check("each is said once: dismissed, it is gone, and stays gone after a reload", afterDismiss === 0 && Object.keys(await asideTexts()).length === 0);
    await fresh.eval(`localStorage.removeItem("cow:dismissed"); true`);
    await fresh.close();
    // The first window was told nothing: what it says follows the bb it runs on, which may itself be outside the tested range.
    const realVersion = (await api("/system/version")).currentVersion;
    const testedMinor = /tested on bb (\d+\.\d+)/.exec(asides["bb:0.51.2"] ?? "")?.[1] ?? null;
    const realOutside = testedMinor !== null && realVersion.split(".").slice(0, 2).join(".") !== testedMinor;
    const firstAsides = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll("[data-cow-aside]")].map((el) => el.dataset.cowAside))`));
    check(
      "the first window, not told otherwise, has no aside for the other window's version, and one for bb's own only when that is outside the tested range",
      testedMinor !== null && !firstAsides.includes("bb:0.51.2") && firstAsides.includes(`bb:${realVersion}`) === realOutside,
      `bb ${realVersion}, tested on ${testedMinor}: ${JSON.stringify(firstAsides)}`,
    );
    await signer.must("main_choose", { projectId: PROJECT_OF.main, threadId: ids.main });
    await restoreStored();
    // Back to where the page's own checks left things.
    await bb("thread", "unarchive", ids.fails);
    // bb archived the thread under it with it, and brings back only the one asked for.
    await bb("thread", "unarchive", ids.leaf).catch(() => undefined);
    await rpc("archive_note_set", { threadId: ids.fails, note: null });
    await page.waitFor(`${lineState(ids.fails)} === "failed"`, { label: "the line back after the CLI checks" });
  });

  await part("next", {}, async () => {
    // -- what is next: a thread's own note, and what it has not started --
    stranger = await cowAs(ids.asks, "next", ids.quiet, "not mine to say");
    upward = await cowAs(ids.leaf, "todo", "add", ids.quiet, "not mine to list");
    check(
      "a thread may not write what is next for a thread that is not under it",
      stranger.code !== 0 && /only for itself and for the threads under it/.test(stranger.stderr) &&
        upward.code !== 0 && (await page.eval(noteOf(ids.quiet))) === null && (await cliTodos(ids.quiet)).length === 0,
      stranger.stderr.trim(),
    );
    own = await cowAs(ids.quiet, "next", ids.quiet, "cut the second   half on Monday");
    await page.waitFor(`${noteOf(ids.quiet)} === "“cut the second half on Monday”"`, { label: "the note on its line" });
    check(
      "bb cow next: a thread's own note shows live in its next-move column, marked as its words",
      own.code === 0 && /cut the second half on Monday/.test(own.stdout),
      own.stdout.trim(),
    );
    fromAbove = await cowAs(ids.main, "next", ids.leaf, "nothing more planned");
    await page.waitFor(`${noteOf(ids.leaf)} === "“nothing more planned”"`, { label: "a note set from above" });
    check("a thread may set it for a thread under it, at any depth", fromAbove.code === 0);
    await cowAs(ids.quiet, "todo", "add", ids.quiet, "write the changelog");
    await cowAs(ids.quiet, "todo", "add", ids.quiet, "tag the release");
    third = await cowAs(ids.main, "todo", "add", ids.quiet, "announce it");
    await page.waitFor(`${todoTitles(ids.quiet)} === '["write the changelog","tag the release","announce it"]'`, {
      label: "the not-started items on the page",
    });
    check("bb cow todo add: items show live, in order", third.code === 0 && /as item 3/.test(third.stdout), third.stdout.trim());
    placed = JSON.parse(
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
    statusPlans = (await cow("status", "--main", ids.main)).stdout;
    check(
      "bb cow status shows the note, the items, and what is under a group",
      /next, in its words: cut the second half on Monday/.test(statusPlans) &&
        /not started 1: write the changelog\n.*not started 2: tag the release/.test(statusPlans) &&
        /\[under it: .*1 failed.*\]/.test(statusPlans),
      statusPlans.split("\n").filter((line) => /not started|in its words/.test(line)).join(" | "),
    );
    await shot("plans");
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
    started = await cowAs(ids.quiet, "todo", "done", ids.quiet, "1");
    await page.waitFor(`${todoTitles(ids.quiet)} === '["announce it"]'`, { label: "an item taken off by the CLI" });
    check("bb cow todo done takes an item off, and the page follows", started.code === 0 && /1 left/.test(started.stdout));
    noSuch = await cowAs(ids.quiet, "todo", "rm", ids.quiet, "5");
    check("an item number that is not on the list is refused", noSuch.code !== 0 && /there is no item 5/.test(noSuch.stderr), noSuch.stderr.trim());
    await cowAs(ids.quiet, "todo", "rm", ids.quiet, "1");
    await cowAs(ids.quiet, "next", ids.quiet, "--clear");
    await cowAs(ids.main, "next", ids.leaf, "--clear");
    await page.waitFor(
      `${todoTitles(ids.quiet)} === "[]" && ${noteOf(ids.quiet)} === null && ${noteOf(ids.leaf)} === null`,
      { label: "the notes cleared" },
    );
    check("bb cow todo rm and next --clear remove them from the page", true);
  });

  await part("theme", {}, async () => {
    // -- one theme for the page and the chat beside it --
    await page.key("m");
    await page.waitFor(`document.querySelector("[data-cow-chat]")?.textContent.includes("ok")`, { label: "Main's chat" });
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
    themes = await bb("theme", "list");
    check(
      "cow's own look is offered as a bb theme",
      JSON.stringify(themes).includes(`plugin:${PLUGIN}:cow`),
    );
    // Switching bb's theme would change every open window, so the cow theme is
    // tried in this window alone, the way bb's settings preview a theme.
    cowTheme = readFileSync(new URL("../themes/cow.css", import.meta.url), "utf8");
    themeBefore = await page.eval(`document.getElementById("bb-app-theme")?.textContent ?? null`);
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
  });

  await part("narrow", { after: ["cli"] }, async () => {
    // -- a narrow window --
    await page.colorScheme("light");
    await page.resize(700, 800);
    narrow = JSON.parse(
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
    paneWidth = await page.eval(
      `document.querySelector("[data-cow-pane]").getBoundingClientRect().width / ${ROOT}.clientWidth`,
    );
    await shot("narrow-pane");
    check("in a narrow window the chat takes the page", paneWidth > 0.9, paneWidth.toFixed(2));
    await page.key("Escape");
    check("Escape closes it there too", await page.eval(`!document.querySelector("[data-cow-pane]")`));
    await page.resize(1440, 900);
  });

  await part("raised", {}, async () => {
    await raisedChecks(page, ids, shot, chooseMain);
  });

  await part("reading", {}, async () => {
    await readingChecks(page, ids, shot, chooseMain);
  });

  await part("caps", {}, async () => {
    await capsChecks(page, ids, shot, chooseMain);
  });

  await part("changing-main", {}, async () => {
    // -- changing Main --
    await page.key("M");
    await page.waitFor(`${screen} === "picker"`, { label: "the picker again" });
    check("M reopens the picker", true);
    await page.key("Escape");
    check("Escape keeps the current Main", (await page.eval(screen)) === "overview");
  });

  return finish(page);

  async function finish(page) {
  // The test plugin's badge that always throws is meant to: bb logs it, and only it.
  const consoleErrors = page.consoleErrors.filter((entry) => !EXPECTED_ERRORS.some((pattern) => pattern.test(entry)));
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  // bb polls services of its own that may be down; only cow's requests count.
  // A refusal a check provoked on purpose (a stale approval, say) is counted, and only that many are let through.
  let provoked = expectedRefusals;
  const failedRequests = page.networkErrors.filter((entry) => entry.includes(`/plugins/${PLUGIN}`)).filter((entry) => !(/409 \(Conflict\).*\/rpc\/signed/.test(entry) && provoked-- > 0));
  check("no failed requests to cow", failedRequests.length === 0, failedRequests.join(" | "));
  if (page.networkErrors.length > failedRequests.length) {
    console.log(`note: ${page.networkErrors.length - failedRequests.length} failed requests of bb's own, e.g. ${page.networkErrors[0]}`);
  }
  // The tab stays open after this, and a cow page in it would enrol its key again by first use once enrollment is reset below.
  await page.goto("about:blank").catch(() => undefined);
  page.close();

  // -- put things back --
  await removeAutomations();
  await removeBadgePlugin();
  await restoreSettings();
  await restoreReading();
  await restoreCaps();
  // What only a signed call takes back is taken back while this check's key is still enrolled:
  // the stored Mains, and what was marked as seen or dismissed.
  await ownKey();
  await restoreStored();
  const after = await rpc("main_state", null);
  check("what the run changed in the stored Mains is still as it was", ours(after) === ours(before), JSON.stringify(after));
  if (!flag("keep")) {
    for (const id of Object.values(ids)) {
      await signer.must("dismissal_set", { threadId: id, dismissal: null });
      await signer.must("seen_set", { threadId: id, seen: null });
    }
  }
  // No key of this check stays enrolled: the next page to open cow is enrolled by first use.
  await signer.resetEnrollment();
  check("the check leaves no key enrolled", (await signer.state()).keys.length === 0);
  for (const name of [...RAISED, ...READING, ...CAPPED]) {
    if (ids[name]) for (const ask of await openAsksOf(ids[name])) await cow("ask", "withdraw", ask.id);
  }
  if (!flag("keep")) {
    await archiveFixtures(Object.values(ids));
    await removeCardFolder(ids);
  }

  const failed = results.filter((result) => !result.ok);
  if (parts.length) {
    console.log("\nparts:");
    for (const entry of parts) console.log(`  ${entry.status.padEnd(13)} ${entry.name}${entry.message ? `  (${entry.message})` : ""}`);
    const notPassed = parts.filter((entry) => entry.status === "stopped" || entry.status === "failed checks");
    if (notPassed.length) console.log(`failed parts: ${notPassed.map((entry) => entry.name).join(", ")}`);
    const skipped = parts.filter((entry) => entry.status === "skipped");
    if (skipped.length) console.log(`skipped parts: ${skipped.map((entry) => entry.name).join(", ")}`);
  }
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
  }
}

/** Clear cow's notes on the fixtures and archive them. Each step is tried even when one before it failed. */
async function archiveFixtures(threadIds) {
  let archived = 0;
  for (const id of threadIds) {
    const steps = [
      () => rpc("park_set", { threadId: id, park: null }),
      () => rpc("keep_set", { threadId: id, keep: null }),
      () => rpc("archive_note_set", { threadId: id, note: null }),
      () => cow("project", id, "--clear"),
      () => cow("wait", id, "--clear"),
    ];
    for (const step of steps) await step().catch((cause) => console.error(`could not clear a note on ${id}`, cause));
    try {
      await bb("thread", "archive", id);
      archived += 1;
    } catch (cause) {
      console.error(`could not archive ${id}`, cause);
    }
    // Archiving leaves a thread that is waiting on its question running.
    await fetch(`${BB}/api/v1/threads/${id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  }
  console.log(`archived ${archived} of ${threadIds.length} fixture threads`);
}

main().catch(async (error) => {
  console.error(error);
  // Whatever went wrong, the next cow window must start where it did before. Recording that is signed.
  await ownKey().catch(() => undefined);
  await restoreStored().catch((cause) => console.error("could not restore the stored Mains", cause));
  await removeAutomations().catch((cause) => console.error("could not delete the automations this run made", cause));
  await removeBadgePlugin().catch((cause) => console.error("could not remove the test plugin cow-check-badge", cause));
  await restoreSettings().catch((cause) => console.error("could not restore cow's checker settings", cause));
  await restoreReading().catch((cause) => console.error("could not put back what the reader checks changed", cause));
  await restoreCaps().catch((cause) => console.error("could not put back what the capability checks made", cause));
  // The fixtures go too, unless asked to be kept: a failed run otherwise leaves them in the list, running or waiting.
  if (!flag("keep")) {
    for (const id of Object.values(inUse)) {
      await signer?.must("dismissal_set", { threadId: id, dismissal: null }).catch(() => undefined);
      await signer?.must("seen_set", { threadId: id, seen: null }).catch(() => undefined);
    }
    await archiveFixtures(Object.values(inUse));
    await removeCardFolder(inUse);
  }
  await signer?.resetEnrollment().catch((cause) => console.error("could not reset cow's enrollment", cause));
  process.exit(1);
});
