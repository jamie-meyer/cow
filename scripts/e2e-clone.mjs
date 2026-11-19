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

if (process.platform !== "darwin") {
  console.error("copy-on-write clones need macOS and APFS");
  process.exit(2);
}
await (args[0] === "timing" ? timing() : e2e());
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
