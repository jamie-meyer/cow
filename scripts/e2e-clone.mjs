// End-to-end check of the copy-on-write workspace provider, and a timing
// check of the cloner. macOS with APFS only. Run outside any command sandbox:
// the cloner calls osascript, and the check spawns bb threads.
//
// The end-to-end check runs against a copy of cow under another id, never the
// installed cow. It makes a throwaway workspace folder and two throwaway git
// repositories under the system temp folder, starts one thread titled
// "cow test" on the cheapest model in a clone of them, checks the clone from
// the thread and from outside, archives the thread and ends its environment's
// grace window, checks the clone is gone and the originals untouched, then
// deletes the thread and removes the throwaway folders.
//
//   node scripts/copy-for-checks.mjs <empty folder> --id cow-clonecheck
//   bb plugin install <that folder> --yes
//   node scripts/e2e-clone.mjs --plugin cow-clonecheck --project <bb project id>
//   bb plugin remove cow-clonecheck
//
// Options:
//   --plugin <id>     the copy to check (default cow-check); cow is refused
//   --project <id>    the bb project to start the thread in (required)
//   --model <id>      the thread's model (default claude-haiku-5-5)
//   --grace           after archiving the thread, wait out the grace window
//                     (about five minutes) instead of ending it with
//                     `bb environment cleanup`
//   --keep            leave the thread and the throwaway folders
//
//   node scripts/e2e-clone.mjs workspace --plugin cow-clonecheck --project <bb project id>
//
// The workspace check makes a throwaway workspace folder with a
// cow.workspace.json and two throwaway git repositories, each with a bare
// repository as its remote, under the system temp folder. It checks that the
// file is not approved and sync refuses; approves it through the copy's
// signed path as the page would; checks sync pulls a new commit and skips a
// dirty repository; starts one thread from { "workspace": … } and checks
// setup ran; has the thread commit and run `bb <id> workspace back` (it
// shows the plan and runs nothing); runs it from outside any thread too
// (the same: nothing runs); brings the work back through the copy's signed
// `workspace_back`, as the page's B does, and checks the commit reached the
// source; and edits the file to a harmful-looking command and checks nothing
// new runs. Then it approves a teardown for api and checks: the first
// thread's clone, removed by bb, ran api's teardown (a marker file under the
// check's temp folder) and is gone; a second thread's clone with an
// uncommitted file in web (no teardown) is held, listed by `bb <id>
// workspace`, with its files intact at the held path; a third's, whose
// teardown fails, is held; unsigned removal is refused; the signed
// `workspace_held_remove` deletes both. Before the teardown part it also
// checks the checker's diff in a clone (see briefDiffInClone).
// The thread is archived at the end, also after a failure. The bb CLI is run
// without BB_THREAD_ID for the "outside any thread" calls, as a terminal would.
//
//   node scripts/e2e-clone.mjs timing [--entries 30000] [--chunk 5000]
//
// The timing check makes a tree of about that many entries under the system
// temp folder, clones it in chunks and then in one call while a second
// process renames a file over and over, and prints how long each took, the
// chunk count and the longest a rename waited. It removes everything after.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startHelper } from "../src/clone/helper.ts";
import { createSigner } from "./sign.mjs";
import { cloneTree } from "../src/clone/tree.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
}

const run = (cmd, argv, options = {}) =>
  new Promise((resolve) => {
    execFile(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "cow test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "cow test", GIT_COMMITTER_EMAIL: "test@example.com" };
async function git(cwd, ...argv) {
  const result = await run("git", argv, { cwd, env: GIT_ENV });
  if (result.code !== 0) throw new Error(`git ${argv.join(" ")} in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

// ---- timing -------------------------------------------------------------

/** A second process renaming one file back and forth; prints the longest wait when told to stop. */
const RENAMER = `
const fs = require("node:fs");
const [dir] = process.argv.slice(1);
const a = dir + "/a", b = dir + "/b";
fs.writeFileSync(a, "x");
let worst = 0, count = 0, stop = false;
process.stdin.on("data", () => { stop = true; });
(function loop() {
  for (let i = 0; i < 50 && !stop; i += 1) {
    const t = process.hrtime.bigint();
    fs.renameSync(count % 2 ? b : a, count % 2 ? a : b);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (ms > worst) worst = ms;
    count += 1;
  }
  if (stop) { console.log(JSON.stringify({ worst, count })); process.exit(0); }
  setImmediate(loop);
})();`;

async function timing() {
  const entries = Number(option("entries", "30000"));
  const chunk = Number(option("chunk", "5000"));
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cow-clone-timing-")));
  try {
    const source = join(base, "source");
    // Directories of 25 files, eight to a parent: a tree with some depth.
    let made = 0;
    for (let d = 0; made < entries; d += 1) {
      const dir = join(source, `p${Math.floor(d / 8)}`, `d${d}`);
      mkdirSync(dir, { recursive: true });
      made += 1 + (d % 8 === 0 ? 1 : 0);
      for (let f = 0; f < 25 && made < entries; f += 1, made += 1) writeFileSync(join(dir, `f${f}.txt`), `${d}.${f}`);
    }
    const helper = await startHelper();
    console.log(`tree of ${made} entries; helper ${helper.kind}; chunk ${chunk}`);
    const measure = async (label, chunkSize, destination) => {
      const renames = join(base, `renames-${label}`);
      mkdirSync(renames);
      const renamer = spawn(process.execPath, ["-e", RENAMER, renames], { stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      renamer.stdout.on("data", (d) => (out += d));
      await sleep(300);
      const result = await cloneTree(helper, source, destination, { chunk: chunkSize });
      await sleep(100);
      renamer.stdin.write("stop\n");
      await new Promise((r) => renamer.on("exit", r));
      const { worst, count } = JSON.parse(out);
      console.log(
        `${label}: ${result.entries} entries, ${result.chunks} chunk(s), ${result.files} single file(s), ${result.recreated} recreated dir(s), ` +
          `walk ${result.walkMs.toFixed(0)} ms, clone ${result.cloneMs.toFixed(0)} ms, total ${result.totalMs.toFixed(0)} ms; ` +
          `longest rename wait ${worst.toFixed(1)} ms over ${count} renames`,
      );
    };
    await measure("chunked", chunk, join(base, "clone-chunked"));
    await measure("one call", Number.MAX_SAFE_INTEGER, join(base, "clone-whole"));
    helper.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ---- end to end ---------------------------------------------------------

const BB = process.env.BB_CLI || "bb";
async function bb(...argv) {
  const result = await run(BB, [...argv, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}
  if (result.code !== 0 || parsed?.ok === false) throw new Error(`bb ${argv.join(" ")}: ${parsed?.error?.message ?? result.stderr ?? result.stdout}`);
  return parsed;
}

const PROMPT = (command) => `You are a test fixture for a bb plugin. Run this one shell command exactly as written, once, with your shell tool, then reply with exactly: done
${command}
Use no other tool and run nothing else.`;

/** What the thread runs, from its working directory: everything it sees goes into one file in the clone. */
const THREAD_COMMAND =
  "{ echo \"pwd=$(pwd -P)\"; echo \"top=$(git branch --show-current)\"; echo \"alpha=$(git -C alpha branch --show-current)\"; " +
  "echo \"beta=$(git -C beta branch --show-current)\"; if [ -e alpha/.env ]; then echo env=present; else echo env=absent; fi; " +
  "if ( echo edited >> notes/today.md ) 2>/dev/null; then echo notes=written; else echo notes=refused; fi; } > cow-e2e-report.txt 2>&1";

async function e2e() {
  const plugin = option("plugin", "cow-check");
  const project = option("project");
  const model = option("model", "claude-haiku-5-5");
  if (plugin === "cow") {
    console.error("refused: run this against a copy of cow (scripts/copy-for-checks.mjs), never the installed cow");
    process.exit(2);
  }
  if (!project) {
    console.error("--project <bb project id> is required");
    process.exit(2);
  }
  const providerId = `${plugin}-clone`;
  const providers = await bb("environment", "providers");
  const list = Array.isArray(providers) ? providers : (providers.providers ?? providers.data ?? []);
  check(`the provider ${providerId} is registered`, JSON.stringify(list).includes(`"${providerId}"`), JSON.stringify(list).slice(0, 300));

  const base = realpathSync(mkdtempSync(join(tmpdir(), "cow-e2e-clone-")));
  const workspace = join(base, "workspace");
  const alpha = join(base, "alpha");
  const beta = join(base, "beta");
  let threadId = null;
  try {
    mkdirSync(join(workspace, "notes"), { recursive: true });
    writeFileSync(join(workspace, "RULES.md"), "Rules for the test.\n");
    writeFileSync(join(workspace, "notes", "today.md"), "A note.\n");
    await git(workspace, "init", "-q", "-b", "main");
    await git(workspace, "add", ".");
    await git(workspace, "commit", "-q", "-m", "workspace");
    for (const [repo, file] of [[alpha, "a.txt"], [beta, "b.txt"]]) {
      mkdirSync(repo);
      writeFileSync(join(repo, file), "first\n");
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "first");
    }
    writeFileSync(join(alpha, "a.txt"), "first, changed\n");
    writeFileSync(join(alpha, ".env"), "SECRET=not-for-the-clone\n");
    const before = { alpha: await git(alpha, "rev-parse", "HEAD"), beta: await git(beta, "rev-parse", "HEAD"), alphaStatus: await git(alpha, "status", "--porcelain") };

    const inputs = { source: workspace, bring: [{ path: alpha, as: "alpha" }, { path: beta, as: "beta" }], readOnly: ["notes"] };
    const thread = await bb(
      "thread", "spawn",
      "--project", project,
      "--environment-provider", providerId,
      "--environment-inputs", JSON.stringify(inputs),
      "--provider", "claude-code",
      "--model", model,
      "--title", "cow test",
      "--parent-notifications", "off",
      "--prompt", PROMPT(THREAD_COMMAND),
    );
    threadId = thread.id;
    console.log(`thread ${threadId}`);

    // Wait for the thread's turn to finish.
    let shown = null;
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      shown = await bb("thread", "show", threadId);
      const t = shown.thread ?? shown;
      if (t.status === "error") throw new Error(`the thread failed: ${JSON.stringify(t).slice(0, 500)}`);
      if (t.environmentId && t.status === "idle" && t.runtime?.displayStatus === "idle") break;
      if (Date.now() > deadline) throw new Error(`the thread never finished: ${JSON.stringify(t).slice(0, 500)}`);
      await sleep(2000);
    }
    const t = shown.thread ?? shown;
    const environment = await bb("environment", "show", t.environmentId);
    const env = environment.environment ?? environment;
    const path = env.path;
    const clones = realpathSync(join(homedir(), ".bb", "plugins", plugin, "host-data", "clones"));
    check("the environment is a clone under the copy's clones folder", typeof path === "string" && path.startsWith(`${clones}/`), `path ${path}`);
    check("the environment was made by the provider", env.environmentProviderId === providerId, env.environmentProviderId);

    const report = Object.fromEntries(
      (existsSync(join(path, "cow-e2e-report.txt")) ? readFileSync(join(path, "cow-e2e-report.txt"), "utf8") : "")
        .split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    check("the thread ran and wrote its report in the clone", Object.keys(report).length >= 5, JSON.stringify(report));
    check("the thread's working directory is the clone", report.pwd === realpathSync(path), `${report.pwd} vs ${path}`);
    const branch = await git(path, "branch", "--show-current");
    check("the workspace folder's clone is on a branch of the thread's", branch !== "main" && branch.length > 0, branch);
    check("the thread sees both repositories on the thread's branch", report.top === branch && report.alpha === branch && report.beta === branch, JSON.stringify(report));
    check(".env did not come along", report.env === "absent" && !existsSync(join(path, "alpha", ".env")));
    check("the uncommitted change came along", readFileSync(join(path, "alpha", "a.txt"), "utf8") === "first, changed\n");
    check("the thread could not write the read-only notes", report.notes === "refused" && readFileSync(join(path, "notes", "today.md"), "utf8") === "A note.\n", report.notes);
    check("the notes have no write permission", (statSync(join(path, "notes")).mode & 0o222) === 0 && (statSync(join(path, "notes", "today.md")).mode & 0o222) === 0);

    await git(join(path, "alpha"), "commit", "-q", "-am", "work from the clone");
    const commit = await git(join(path, "alpha"), "rev-parse", "HEAD");
    check("a commit in the clone does not move the original", (await git(alpha, "rev-parse", "HEAD")) === before.alpha && (await git(alpha, "branch", "--list", branch)) === "");
    await git(alpha, "fetch", "-q", join(path, "alpha"), branch);
    check("git fetch from the original brings the commit back", (await git(alpha, "rev-parse", "FETCH_HEAD")) === commit);

    if (flag("keep")) {
      console.log(`kept: thread ${threadId}, folders ${base}`);
      return;
    }
    await bb("thread", "archive", threadId);
    if (flag("grace")) {
      console.log("archived; waiting out the grace window (about five minutes)");
    } else {
      // Deleting or archiving the thread leaves the environment retiring for the grace window; cleanup ends it now.
      await bb("environment", "cleanup", t.environmentId);
    }
    const goneBy = Date.now() + (flag("grace") ? 9 * 60_000 : 3 * 60_000);
    while (existsSync(path) && Date.now() < goneBy) await sleep(3000);
    check("the clone is gone after the thread", !existsSync(path), path);
    const trash = join(homedir(), ".bb", "plugins", plugin, "host-data", "trash");
    const trashBy = Date.now() + 60_000;
    while (existsSync(trash) && (await run("ls", ["-A", trash])).stdout.trim() !== "" && Date.now() < trashBy) await sleep(1000);
    check("the trash is emptied", !existsSync(trash) || (await run("ls", ["-A", trash])).stdout.trim() === "");
    check(
      "the originals are untouched",
      (await git(alpha, "rev-parse", "HEAD")) === before.alpha &&
        (await git(beta, "rev-parse", "HEAD")) === before.beta &&
        (await git(alpha, "status", "--porcelain")) === before.alphaStatus &&
        existsSync(join(alpha, ".env")) &&
        readFileSync(join(workspace, "notes", "today.md"), "utf8") === "A note.\n",
    );
    const done = join(homedir(), ".bb", "plugins", plugin, "host-data", "done");
    check("the clone's record is gone", !existsSync(join(done, `${threadId}.json`)) && (await run("ls", ["-A", done])).stdout.trim() === "");
    const after = await bb("environment", "show", t.environmentId);
    const lifecycle = (after.environment ?? after).lifecycle;
    check("bb records the environment as destroyed and removed", lifecycle?.phase === "destroyed" && lifecycle?.teardown?.status === "removed", JSON.stringify(lifecycle));
    await bb("thread", "delete", threadId, "--yes");
    threadId = null;
  } finally {
    if (threadId && !flag("keep")) await bb("thread", "delete", threadId, "--yes").catch((error) => console.error(`could not delete ${threadId}: ${error.message}`));
    if (!flag("keep")) rmSync(base, { recursive: true, force: true });
  }
}

// ---- the workspace file ---------------------------------------------------

/** The bb CLI as a terminal outside any thread runs it: no thread named in its environment. */
async function bbOutside(...argv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^BB_(THREAD|PROJECT|ENVIRONMENT)/.test(key)));
  return run(BB, argv, { env });
}

async function waitIdle(threadId) {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const shown = await bb("thread", "show", threadId);
    const t = shown.thread ?? shown;
    if (t.status === "error") throw new Error(`the thread failed: ${JSON.stringify(t).slice(0, 500)}`);
    if (t.environmentId && t.status === "idle" && t.runtime?.displayStatus === "idle") return t;
    if (Date.now() > deadline) throw new Error(`the thread never finished: ${JSON.stringify(t).slice(0, 500)}`);
    await sleep(2000);
  }
}

async function workspaceE2e() {
  const plugin = option("plugin", "cow-check");
  const project = option("project");
  const model = option("model", "claude-haiku-5-5");
  const bbUrl = option("bb", "http://127.0.0.1:38886");
  if (plugin === "cow") {
    console.error("refused: run this against a copy of cow (scripts/copy-for-checks.mjs), never the installed cow");
    process.exit(2);
  }
  if (!project) {
    console.error("--project <bb project id> is required");
    process.exit(2);
  }
  const rpc = async (method, input) => (await (await fetch(`${bbUrl}/api/v1/plugins/${plugin}/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).json());
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cow-e2e-workspace-")));
  const ws = join(base, "ws");
  const api = join(base, "api");
  const web = join(base, "web");
  const marker = join(base, "HARMFUL");
  let threadId = null;
  let environmentId = null;
  const extraThreads = [];
  try {
    mkdirSync(join(ws, "notes"), { recursive: true });
    writeFileSync(join(ws, "notes", "today.md"), "A note.\n");
    const heads = {};
    for (const [repo, name] of [[api, "api"], [web, "web"]]) {
      await git(base, "init", "-q", "--bare", "-b", "main", `${name}.git`);
      mkdirSync(repo);
      writeFileSync(join(repo, "a.txt"), "first\n");
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "first");
      await git(repo, "remote", "add", "origin", join(base, `${name}.git`));
      await git(repo, "push", "-q", "-u", "origin", "main");
      // Someone else pushes a new commit: sync has something to pull.
      await git(base, "clone", "-q", join(base, `${name}.git`), `${name}-pusher`);
      writeFileSync(join(base, `${name}-pusher`, "a.txt"), "second\n");
      await git(join(base, `${name}-pusher`), "commit", "-q", "-am", "second");
      await git(join(base, `${name}-pusher`), "push", "-q", "origin", "main");
      heads[name] = await git(join(base, `${name}-pusher`), "rev-parse", "HEAD");
    }
    const back = 'git -C "$COW_SOURCE" fetch -q "$COW_CLONE" "$COW_BRANCH:$COW_BRANCH"';
    const file = {
      bring: [
        { path: "../api", as: "api", sync: "git pull -q --ff-only", setup: 'printf "%s" "$COW_AS" > setup-ran', back },
        { path: "../web", as: "web", sync: "git pull -q --ff-only", back },
      ],
      readOnly: ["notes"],
    };
    const fileText = `${JSON.stringify(file, null, 2)}\n`;
    writeFileSync(join(ws, "cow.workspace.json"), fileText);

    const added = await bbOutside(plugin, "workspace", "add", ws, "--json");
    check("workspace add proposes the folder", added.code === 0 && JSON.parse(added.stdout).status === "new", added.stdout + added.stderr);
    const state0 = (await rpc("workspace_state", null)).result?.workspaces?.find((view) => view.folder === ws);
    check("the file waits for the person, with its commands listed as new", state0?.waiting === true && state0.fresh.length === 5, JSON.stringify(state0).slice(0, 300));
    const refusedSync = await bbOutside(plugin, "workspace", "sync", ws);
    check("sync refuses before the file is approved", refusedSync.code !== 0 && /never been approved/.test(refusedSync.stdout + refusedSync.stderr), refusedSync.stdout + refusedSync.stderr);
    check("nothing was pulled", (await git(api, "rev-parse", "HEAD")) !== heads.api);

    const signer = await createSigner(bbUrl, "the workspace check", plugin);
    const enrolled = await signer.enrol();
    check("the check's key is enrolled with the copy", enrolled === "enrolled-first" || enrolled === "enrolled", enrolled);
    const stale = await signer.call("workspace_approve", { folder: ws, hash: "0".repeat(64) });
    check("an approval of other content is refused", stale.ok === false && /changed after it was shown/.test(JSON.stringify(stale)), JSON.stringify(stale));
    await signer.must("workspace_approve", { folder: ws, hash: state0.currentHash });
    const state1 = (await rpc("workspace_state", null)).result.workspaces.find((view) => view.folder === ws);
    check("the file is approved", state1.status === "approved" && state1.waiting === false, state1.status);

    writeFileSync(join(web, "dirty.txt"), "uncommitted\n");
    const synced = await bbOutside(plugin, "workspace", "sync", ws, "--json");
    const results = JSON.parse(synced.stdout || "{}").synced?.[0]?.results ?? [];
    check("sync pulls the new commit", (await git(api, "rev-parse", "HEAD")) === heads.api, synced.stdout + synced.stderr);
    check("a dirty repository is skipped and untouched", results.find((r) => r.as === "web")?.status === "dirty" && (await git(web, "rev-parse", "HEAD")) !== heads.web && existsSync(join(web, "dirty.txt")), JSON.stringify(results));
    rmSync(join(web, "dirty.txt"));
    const listed = await bbOutside(plugin, "workspace", ws);
    check("bb <id> workspace shows each repository's last sync, and no command text", /api .*clean · last sync .*exit 0/.test(listed.stdout) && !listed.stdout.includes("git pull"), listed.stdout);

    // A thread from the workspace file: it commits in api, and tries back itself.
    const threadCommand =
      'cd api && echo work > work.txt && git add work.txt && git -c user.name=t -c user.email=t@example.com commit -qm "work from the thread"; cd ..; ' +
      `{ echo "setup=$(cat api/setup-ran 2>/dev/null)"; ${BB} ${plugin} workspace back "$BB_THREAD_ID" >back-out.txt 2>back-err.txt; echo "back=$?"; } > cow-e2e-report.txt 2>&1`;
    const thread = await bb(
      "thread", "spawn",
      "--project", project,
      "--environment-provider", `${plugin}-clone`,
      "--environment-inputs", JSON.stringify({ workspace: ws }),
      "--provider", "claude-code",
      "--model", model,
      "--title", "cow test: workspace",
      "--parent-notifications", "off",
      "--prompt", PROMPT(threadCommand),
    );
    threadId = thread.id;
    console.log(`thread ${threadId}`);
    const t = await waitIdle(threadId);
    environmentId = t.environmentId;
    const env = (await bb("environment", "show", environmentId)).environment ?? (await bb("environment", "show", environmentId));
    const path = env.path;
    check("the thread started from { workspace } in a clone with both repositories", existsSync(join(path, "api", "a.txt")) && existsSync(join(path, "web", "a.txt")), path);
    check("setup ran in the brought folder", readFileSync(join(path, "api", "setup-ran"), "utf8") === "api");
    const report = existsSync(join(path, "cow-e2e-report.txt")) ? readFileSync(join(path, "cow-e2e-report.txt"), "utf8") : "";
    const errText = existsSync(join(path, "back-err.txt")) ? readFileSync(join(path, "back-err.txt"), "utf8") : "";
    const outText = existsSync(join(path, "back-out.txt")) ? readFileSync(join(path, "back-out.txt"), "utf8") : "";
    const branch = await git(join(path, "api"), "branch", "--show-current");
    check("the thread committed in its clone", (await git(join(path, "api"), "log", "-1", "--format=%s")) === "work from the thread");
    check(
      "workspace back from the thread shows the plan and runs nothing",
      /back=0/.test(report) && /api +1 new commit · would run: git -C/.test(outText) && /Nothing was run\. The user brings it back with B/.test(outText),
      `${report} ${outText} ${errText}`,
    );
    check("the source has no such branch after it", (await git(api, "branch", "--list", branch)) === "");

    const preview = await bbOutside(plugin, "workspace", "back", threadId);
    const previewJson = await bbOutside(plugin, "workspace", "back", threadId, "--json");
    console.log(preview.stdout.trimEnd());
    const plan = JSON.parse(previewJson.stdout || "{}");
    check(
      "workspace back from outside any thread is the same plan, and runs nothing",
      plan.ran === false && plan.repos?.find((r) => r.as === "api")?.ahead === 1 && plan.repos?.find((r) => r.as === "web")?.ahead === 0 && /Nothing was run/.test(preview.stdout),
      previewJson.stdout + previewJson.stderr,
    );
    check("the source still has no such branch", (await git(api, "branch", "--list", branch)) === "");

    // Brought back as the page's B does: the signed workspace_back.
    const unsigned = await (await fetch(`${bbUrl}/api/v1/plugins/${plugin}/rpc/signed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "workspace_back", args: { threadId } }) })).json();
    check("an unsigned workspace_back is refused", unsigned.ok === false || unsigned.result?.ok === false, JSON.stringify(unsigned).slice(0, 300));
    check("and nothing came back", (await git(api, "branch", "--list", branch)) === "");
    const done = await signer.must("workspace_back", { threadId });
    const backResults = done.results ?? [];
    check("the signed workspace_back runs api's back command, and web has nothing new", backResults.find((r) => r.as === "api")?.status === "ran" && backResults.find((r) => r.as === "api")?.code === 0 && backResults.find((r) => r.as === "web")?.status === "nothing-new", JSON.stringify(done));
    check("the commit reached the source", (await git(api, "log", "-1", "--format=%s", branch)) === "work from the thread");

    // What a brief's checker is shown in such a clone: the workspace folder's own repository, which ignores app, and the brought repositories.
    await briefDiffInClone({ plugin, project, model, rpc, signer, base, extraThreads });

    // A harmful-looking change runs nothing until approved.
    const harmful = { ...file, bring: [{ ...file.bring[0], sync: `touch "${marker}"` }, file.bring[1]] };
    writeFileSync(join(ws, "cow.workspace.json"), `${JSON.stringify(harmful, null, 2)}\n`);
    const state2 = (await rpc("workspace_state", null)).result.workspaces.find((view) => view.folder === ws);
    check("the changed file waits, with the new command first in its review", state2.status === "changed" && state2.waiting && state2.review.indexOf("touch") < state2.review.indexOf("The change"), JSON.stringify(state2).slice(0, 300));
    await bbOutside(plugin, "workspace", "sync", ws);
    check("sync ran the approved command, not the changed one", !existsSync(marker));

    // Teardown, approved like the rest: api's appends to a marker under the check's temp folder unless the thread asked it to fail; web has none.
    const marks = join(base, "teardown-marks.txt");
    const withTeardown = { ...file, bring: [{ ...file.bring[0], teardown: `test ! -f fail-teardown && printf '%s\\n' "$COW_AS" >> "${marks}"` }, file.bring[1]] };
    writeFileSync(join(ws, "cow.workspace.json"), `${JSON.stringify(withTeardown, null, 2)}\n`);
    const state3 = (await rpc("workspace_state", null)).result.workspaces.find((view) => view.folder === ws);
    check("a teardown is a command that would newly run, in the review", state3.fresh.some((entry) => entry.as === "api" && entry.kind === "teardown") && /api: teardown/.test(state3.review), JSON.stringify(state3.fresh));
    await signer.must("workspace_approve", { folder: ws, hash: state3.currentHash });

    const heldDir = join(homedir(), ".bb", "plugins", plugin, "host-data", "held");
    const removeEnvironment = async (thread, env) => {
      await bb("thread", "archive", thread);
      await bb("environment", "cleanup", env);
      const by = Date.now() + 3 * 60_000;
      for (;;) {
        const shown = await bb("environment", "show", env);
        const lifecycle = (shown.environment ?? shown).lifecycle;
        if (lifecycle?.phase === "destroyed" || Date.now() > by) return lifecycle;
        await sleep(2000);
      }
    };

    // 1. The first thread's clone: api's teardown succeeds (its commit was brought back; web is clean), so it is removed.
    const firstThread = threadId;
    const lifecycle1 = await removeEnvironment(threadId, environmentId);
    threadId = null;
    check("bb settles the removal", lifecycle1?.phase === "destroyed" && lifecycle1?.teardown?.status === "removed", JSON.stringify(lifecycle1));
    check("a clean teardown ran while the clone existed, and the clone is removed", existsSync(marks) && readFileSync(marks, "utf8") === "api\n" && !existsSync(path), existsSync(marks) ? readFileSync(marks, "utf8") : "no marker");
    check("it is not held", !(await rpc("workspace_state", null)).result.held.some((entry) => entry.threadId === firstThread));

    // 2. and 3., side by side: a thread leaves an uncommitted file in web (no teardown); another asks api's teardown to fail.
    const spawnOne = async (title, command) =>
      (await bb("thread", "spawn", "--project", project, "--environment-provider", `${plugin}-clone`, "--environment-inputs", JSON.stringify({ workspace: ws }), "--provider", "claude-code", "--model", model, "--title", title, "--parent-notifications", "off", "--prompt", PROMPT(command))).id;
    const dirtyThread = await spawnOne("cow test: held, unsaved", "echo keep-me > web/unsaved.txt");
    const failThread = await spawnOne("cow test: held, teardown fails", "touch api/fail-teardown");
    extraThreads.push(dirtyThread, failThread);
    const [dirtyT, failT] = await Promise.all([waitIdle(dirtyThread), waitIdle(failThread)]);
    const dirtyPath = (await bb("environment", "show", dirtyT.environmentId)).environment?.path ?? (await bb("environment", "show", dirtyT.environmentId)).path;
    const [l2, l3] = await Promise.all([removeEnvironment(dirtyThread, dirtyT.environmentId), removeEnvironment(failThread, failT.environmentId)]);
    check("bb settles both removals, held or not", [l2, l3].every((l) => l?.phase === "destroyed" && l?.teardown?.status === "removed"), JSON.stringify([l2, l3]));
    const state4 = (await rpc("workspace_state", null)).result;
    const heldDirty = state4.held.find((entry) => entry.threadId === dirtyThread);
    const heldFail = state4.held.find((entry) => entry.threadId === failThread);
    check("the clone with an uncommitted file and no teardown is held, with why", heldDirty?.reasons?.some((r) => r.as === "web" && r.kind === "uncommitted") && heldDirty.title === "cow test: held, unsaved", JSON.stringify(state4.held).slice(0, 600));
    check("its files are intact at the held path, and gone from where bb had it", heldDirty && readFileSync(join(heldDirty.path, "web", "unsaved.txt"), "utf8") === "keep-me\n" && heldDirty.path.startsWith(heldDir) && !existsSync(dirtyPath), heldDirty?.path);
    check("the clone whose teardown failed is held, with its exit code", heldFail?.reasons?.length === 1 && heldFail.reasons[0].kind === "teardown-failed" && heldFail.reasons[0].code === 1 && existsSync(heldFail.path), JSON.stringify(heldFail?.reasons));
    check("the held clones carry no output", !JSON.stringify(state4.held).includes("tail"));
    const listedHeld = await bbOutside(plugin, "workspace");
    check(
      "bb <id> workspace lists the held clones, with why and where",
      heldDirty && heldFail && listedHeld.stdout.includes(heldDirty.path) && listedHeld.stdout.includes(heldFail.path) && /web: 1 uncommitted or untracked change, and no teardown/.test(listedHeld.stdout) && /api: teardown exited 1/.test(listedHeld.stdout),
      listedHeld.stdout,
    );

    // Nothing unsigned removes one; signed, it is removed.
    for (const action of ["workspace_held_remove", "workspace_held_teardown"]) {
      const refusedHeld = await (await fetch(`${bbUrl}/api/v1/plugins/${plugin}/rpc/signed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, args: { id: heldDirty?.id } }) })).json();
      check(`an unsigned ${action} is refused`, refusedHeld.ok === false || refusedHeld.result?.ok === false, JSON.stringify(refusedHeld).slice(0, 300));
    }
    check("and the held clone is still there", heldDirty && existsSync(heldDirty.path));
    for (const entry of [heldDirty, heldFail].filter(Boolean)) await signer.must("workspace_held_remove", { id: entry.id });
    const state5 = (await rpc("workspace_state", null)).result;
    check("the signed removal deletes them", state5.held.length === 0 && [heldDirty, heldFail].every((entry) => entry && !existsSync(entry.path)), JSON.stringify(state5.held).slice(0, 300));
  } finally {
    for (const extra of extraThreads) await bb("thread", "archive", extra).catch(() => {});
    if (threadId && !flag("keep")) {
      await bb("thread", "archive", threadId).catch((error) => console.error(`could not archive ${threadId}: ${error.message}`));
      if (environmentId) await bb("environment", "cleanup", environmentId).catch((error) => console.error(`could not clean up ${environmentId}: ${error.message}`));
    }
    if (!flag("keep")) rmSync(base, { recursive: true, force: true });
    else console.log(`kept: thread ${threadId}, folders ${base}`);
  }
}

/**
 * The checker's diff in a copy-on-write workspace: a folder that is a small
 * repository of its own, ignoring app, and two brought repositories. The
 * thread commits a new file in app, changes an existing test in lib, and
 * drops lib from the workspace file in its clone; it submits a brief about
 * the new file. The record lists both repositories' files under their
 * folders, each with its base; the existing test is flagged; and the
 * checker's prompt holds app's diff.
 */
async function briefDiffInClone({ plugin, project, model, rpc, signer, base, extraThreads }) {
  const ex = join(base, "ex");
  const app = join(base, "ex-app");
  const lib = join(base, "ex-lib");
  mkdirSync(ex);
  writeFileSync(join(ex, ".gitignore"), "/app/\n");
  await git(ex, "init", "-q", "-b", "main");
  await git(ex, "add", ".");
  await git(ex, "commit", "-q", "-m", "folder");
  mkdirSync(app);
  await git(app, "init", "-q", "-b", "main");
  await git(app, "commit", "-q", "--allow-empty", "-m", "one");
  mkdirSync(join(lib, "test"), { recursive: true });
  writeFileSync(join(lib, "test", "a.test.js"), "test('one', () => {});\n");
  await git(lib, "init", "-q", "-b", "main");
  await git(lib, "add", ".");
  await git(lib, "commit", "-q", "-m", "lib");
  const heads = { ex: await git(ex, "rev-parse", "HEAD"), app: await git(app, "rev-parse", "HEAD"), lib: await git(lib, "rev-parse", "HEAD") };
  writeFileSync(join(ex, "cow.workspace.json"), `${JSON.stringify({ bring: [{ path: "../ex-app", as: "app" }, { path: "../ex-lib", as: "lib" }] })}\n`);
  const added = await bbOutside(plugin, "workspace", "add", ex, "--json");
  check("the example's workspace file is proposed", added.code === 0, added.stdout + added.stderr);
  const state = (await rpc("workspace_state", null)).result?.workspaces?.find((view) => view.folder === ex);
  await signer.must("workspace_approve", { folder: ex, hash: state.currentHash });

  const config = JSON.parse((await run(BB, ["plugin", "config", plugin, "--json"])).stdout || "{}").values ?? {};
  const set = (key, value) => run(BB, ["plugin", "config", plugin, ...(value === "" || value === undefined ? ["unset", key] : ["set", key, String(value)])]);
  await set("checkerModel", model);
  await set("checkerProvider", "claude-code");
  try {
    const command =
      'echo change > app/file.txt && git -C app add file.txt && git -C app -c user.name=t -c user.email=t@example.com commit -qm "a change" && ' +
      "echo \"test('two', () => {});\" >> lib/test/a.test.js && printf '{ \"bring\": [{ \"path\": \"../ex-app\", \"as\": \"app\" }] }\\n' > cow.workspace.json";
    const id = (
      await bb("thread", "spawn", "--project", project, "--environment-provider", `${plugin}-clone`, "--environment-inputs", JSON.stringify({ workspace: ex }), "--provider", "claude-code", "--model", model, "--title", "cow test: the checker's diff in a clone", "--parent-notifications", "off", "--prompt", PROMPT(command))
    ).id;
    extraThreads.push(id);
    const t = await waitIdle(id);
    const env = (await bb("environment", "show", t.environmentId)).environment ?? (await bb("environment", "show", t.environmentId));
    check("the example's thread committed in app and dropped lib from the file in its clone", (await git(join(env.path, "app"), "log", "-1", "--format=%s")) === "a change" && !readFileSync(join(env.path, "cow.workspace.json"), "utf8").includes("lib"), env.path);

    const brief = {
      summary: "Added app/file.txt.",
      claims: [{ id: "file", text: "A new file app/file.txt was committed in the app repository, holding the single line \"change\".", label: "inferred" }],
    };
    const briefFile = join(base, "brief.json");
    writeFileSync(briefFile, JSON.stringify(brief));
    const submitted = await run(BB, [plugin, "brief", "submit", briefFile, "--wait", "--json"], { env: { ...process.env, BB_THREAD_ID: id } });
    check("the example's brief is submitted and checked", submitted.code === 0, submitted.stdout + submitted.stderr);
    const record = (await rpc("brief_get", { threadId: id })).result?.record;
    const diff = record?.shown?.diff;
    console.log(`the example's record: ${JSON.stringify(record?.shown)}`);
    const files = diff?.state === "collected" ? Object.fromEntries(diff.files.map((f) => [f.path, `${f.status}${f.untracked ? " untracked" : ""}`])) : {};
    check("the record lists app/file.txt as added and lib's changed test under lib/", files["app/file.txt"] === "added" && files["lib/test/a.test.js"] === "modified", JSON.stringify(files));
    check(
      "the record names each repository with its base: the commit it was on when the clone was made",
      JSON.stringify(diff?.repos?.map((r) => [r.as, r.base])) === JSON.stringify([[null, heads.ex], ["app", heads.app], ["lib", heads.lib]]) && diff.repos.every((r) => r.baseText === "the commit it was on when cow made the clone"),
      JSON.stringify(diff?.repos),
    );
    check("the changed existing test in a brought repository is flagged with its folder", JSON.stringify(record?.shown?.flagged) === '["lib/test/a.test.js"]', JSON.stringify(record?.shown?.flagged));
    const checkerThread = record?.check?.runs?.[0]?.threadId;
    // The checker's one prompt is its first message: in its event log.
    const history = checkerThread ? await run(BB, ["thread", "log", checkerThread, "--json", "--limit", "20"]) : { stdout: "" };
    const strings = [];
    const walk = (value) => (typeof value === "string" ? strings.push(value) : value && typeof value === "object" ? Object.values(value).forEach(walk) : undefined);
    try {
      walk(JSON.parse(history.stdout));
    } catch {
      strings.push(history.stdout);
    }
    const what = /WHAT CHANGED[\s\S]*?THE CLAIMS/.exec(strings.find((text) => text.includes("WHAT CHANGED")) ?? "")?.[0] ?? "";
    console.log(`the example's WHAT CHANGED:\n${what}`);
    if (what === "") console.log(`the checker's log, as bb gave it: ${history.stdout.slice(0, 2000)} ${history.stderr ?? ""}`);
    check("the checker's prompt holds app/file.txt's diff and names each repository's base", what.includes("+++ b/app/file.txt") && what.includes("+change") && what.includes(`"app" (its files under app/): against ${heads.app.slice(0, 12)}`), what.slice(0, 400));
    const done = record?.check?.runs?.find((r) => r.status === "done");
    check("the checker found the claim about app/file.txt supported", done?.verdicts?.find((v) => v.id === "file")?.verdict === "supported", JSON.stringify(record?.check?.runs));
    await bb("thread", "archive", id).catch(() => {});
    await bb("environment", "cleanup", t.environmentId).catch((error) => console.error(`could not clean up ${t.environmentId}: ${error.message}`));
  } finally {
    await set("checkerModel", config.checkerModel);
    await set("checkerProvider", config.checkerProvider);
  }
}

if (process.platform !== "darwin") {
  console.error("copy-on-write clones need macOS and APFS");
  process.exit(2);
}
await (args[0] === "timing" ? timing() : args[0] === "workspace" ? workspaceE2e() : e2e());
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
