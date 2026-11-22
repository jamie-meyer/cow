// Assembling a workspace and removing it, on temporary directories and
// throwaway git repositories. Needs macOS and APFS.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type CloneCall, startHelper } from "../src/clone/helper.ts";
import { type Layout, layout, removeClone, sweepTrash } from "../src/clone/remove.ts";
import { createClone } from "../src/clone/workspace.ts";
import { sha256Hex } from "../src/signing/backend.ts";
import { type Approved, KEPT_WHY, approvedFile, backCandidates, backFromClone } from "../src/workspace/ops.ts";
import { RepoLocks, RunStore } from "../src/workspace/run.ts";

const mac = process.platform === "darwin";
let helper: CloneCall;
let base: string;

before(async () => {
  if (!mac) return;
  helper = await startHelper({ prefer: ["perl"] });
  base = realpathSync(mkdtempSync(join(tmpdir(), "cow-workspace-test-")));
});
after(() => {
  helper?.close();
  if (!base) return;
  // Give back write permission so the temporary folder can go.
  execFileSync("chmod", ["-R", "u+w", base]);
  rmSync(base, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();

let n = 0;
interface World {
  root: string;
  paths: Layout;
  workspace: string;
  alpha: string;
  beta: string;
}

/** A workspace folder (a git repository with notes), and two repositories beside it. */
function world(): World {
  n += 1;
  const root = join(base, `w${n}`);
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "notes"), { recursive: true });
  writeFileSync(join(workspace, "RULES.md"), "be kind\n");
  writeFileSync(join(workspace, "notes", "today.md"), "notes\n");
  run(workspace, "init", "-q", "-b", "main");
  run(workspace, "add", ".");
  run(workspace, "commit", "-q", "-m", "rules");
  const alpha = join(root, "alpha");
  mkdirSync(alpha, { recursive: true });
  writeFileSync(join(alpha, "a.txt"), "one\n");
  run(alpha, "init", "-q", "-b", "main");
  run(alpha, "add", ".");
  run(alpha, "commit", "-q", "-m", "one");
  writeFileSync(join(alpha, "a.txt"), "one, changed\n");
  writeFileSync(join(alpha, "untracked.txt"), "new\n");
  writeFileSync(join(alpha, ".env"), "SECRET=1\n");
  writeFileSync(join(alpha, ".git", "index.lock"), "");
  mkdirSync(join(alpha, ".git", "worktrees", "old"), { recursive: true });
  const beta = join(root, "beta");
  mkdirSync(beta, { recursive: true });
  writeFileSync(join(beta, "b.txt"), "two\n");
  run(beta, "init", "-q", "-b", "trunk");
  run(beta, "add", ".");
  run(beta, "commit", "-q", "-m", "two");
  return { root, paths: layout(join(root, "data")), workspace, alpha, beta };
}

const inputs = (w: World, extra: Record<string, unknown> = {}) => ({
  source: w.workspace,
  bring: [{ path: w.alpha, as: "alpha" }, { path: w.beta, as: "beta" }],
  readOnly: ["notes"],
  ...extra,
});

test("a workspace is assembled: clones in place, on the thread's branch, secrets out, notes read-only", { skip: !mac }, async () => {
  const w = world();
  const alphaHead = run(w.alpha, "rev-parse", "HEAD");
  const made = await createClone({ paths: w.paths, pathKey: "key1", branch: "cow/thread-1", inputs: inputs(w), helper });
  assert.equal(made.path, join(w.paths.clones, "key1", "workspace"));
  const clone = made.path;
  for (const repo of [clone, join(clone, "alpha"), join(clone, "beta")]) assert.equal(run(repo, "branch", "--show-current"), "cow/thread-1");
  assert.equal(readFileSync(join(clone, "alpha", "a.txt"), "utf8"), "one, changed\n", "uncommitted change came along");
  assert.ok(existsSync(join(clone, "alpha", "untracked.txt")), "untracked file came along");
  assert.ok(!existsSync(join(clone, "alpha", ".env")), ".env left out");
  assert.ok(!existsSync(join(clone, "alpha", ".git", "index.lock")), "lock removed");
  assert.ok(!existsSync(join(clone, "alpha", ".git", "worktrees")), "worktree list removed");
  assert.throws(() => writeFileSync(join(clone, "notes", "today.md"), "edited"), /EACCES/);
  assert.throws(() => writeFileSync(join(clone, "notes", "new.md"), "new"), /EACCES/);
  writeFileSync(join(clone, "RULES.md"), "still writable\n");
  // The resource records what was cloned.
  assert.equal(made.resource.branch, "cow/thread-1");
  assert.equal(made.resource.bring[0]!.head, alphaHead);
  assert.equal(made.resource.bring[0]!.dirty, true);
  assert.equal(made.resource.bring[1]!.dirty, false);
  assert.equal(made.resource.source.branched, true);
  assert.ok(made.resource.counts.total.excluded >= 1);
  assert.ok(JSON.stringify(made.resource).length < 16 * 1024);
  // A commit in the clone moves nothing in the original, and fetch brings it back.
  run(join(clone, "alpha"), "commit", "-q", "-am", "from the clone");
  const commit = run(join(clone, "alpha"), "rev-parse", "HEAD");
  assert.equal(run(w.alpha, "rev-parse", "HEAD"), alphaHead);
  assert.equal(run(w.alpha, "branch", "--list", "cow/thread-1"), "");
  run(w.alpha, "fetch", "-q", join(clone, "alpha"), "cow/thread-1");
  assert.equal(run(w.alpha, "rev-parse", "FETCH_HEAD"), commit);
  // Asked again for the same key, the same clone comes back.
  const again = await createClone({ paths: w.paths, pathKey: "key1", branch: "cow/thread-1", inputs: inputs(w), helper });
  assert.equal(again.reused, true);
  assert.equal(again.path, clone);
  // Removing it takes the read-only notes too, and leaves the originals.
  const removed = await removeClone(w.paths, "key1");
  await removed.deleting;
  assert.equal(removed.removed, true);
  assert.ok(!existsSync(join(w.paths.clones, "key1")));
  assert.deepEqual(readdirSync(w.paths.trash), []);
  assert.equal(readFileSync(join(w.alpha, "a.txt"), "utf8"), "one, changed\n");
  assert.ok(existsSync(join(w.alpha, ".env")));
});

const nothingMade = (w: World, key: string) => assert.ok(!existsSync(join(w.paths.clones, key)), `${key} folder was left behind`);

test("a linked worktree (its .git is a file) is refused before anything is cloned", { skip: !mac }, async () => {
  const w = world();
  const linked = join(w.root, "alpha-linked");
  run(w.alpha, "worktree", "add", "-q", linked);
  await assert.rejects(
    createClone({ paths: w.paths, pathKey: "k", branch: "b", inputs: inputs(w, { bring: [{ path: linked, as: "alpha" }] }), helper }),
    /check the inputs: .*linked git worktree.*move the original's branch/s,
  );
  nothingMade(w, "k");
});

test("a repository borrowing objects (alternates) is refused", { skip: !mac }, async () => {
  const w = world();
  const shared = join(w.root, "shared");
  run(w.root, "clone", "-q", "--shared", w.beta, shared);
  await assert.rejects(createClone({ paths: w.paths, pathKey: "k", branch: "b", inputs: inputs(w, { bring: [{ path: shared, as: "shared" }] }), helper }), /alternates/);
  nothingMade(w, "k");
});

test("a bad `as` is refused before anything is cloned", { skip: !mac }, async () => {
  const w = world();
  for (const as of ["..", ".", "a/b", "", "notes", "x\ny"]) {
    await assert.rejects(createClone({ paths: w.paths, pathKey: "k", branch: "b", inputs: inputs(w, { bring: [{ path: w.alpha, as }] }), helper }), /inputs|already has an entry/, `as=${JSON.stringify(as)}`);
    nothingMade(w, "k");
  }
  await assert.rejects(
    createClone({ paths: w.paths, pathKey: "k", branch: "b", inputs: inputs(w, { bring: [{ path: w.alpha, as: "x" }, { path: w.beta, as: "X" }] }), helper }),
    /used twice/,
  );
});

test("all or nothing: a failure late in the work removes what was made and names the step", { skip: !mac }, async () => {
  const w = world();
  await assert.rejects(createClone({ paths: w.paths, pathKey: "k", branch: "b", inputs: inputs(w, { readOnly: ["missing"] }), helper }), /^Error: make missing read-only: missing is not in the clone/);
  nothingMade(w, "k");
  // A helper that fails part way through the second repository.
  let calls = 0;
  const flaky: CloneCall = { kind: "test", clone: (a, b) => (b.includes("/alpha/") && ++calls === 3 ? Promise.resolve(28) : helper.clone(a, b)), close() {} };
  await assert.rejects(createClone({ paths: w.paths, pathKey: "k2", branch: "b", inputs: inputs(w), helper: flaky, chunk: 2 }), /clone .* as alpha: clonefile .* ENOSPC/);
  nothingMade(w, "k2");
  assert.deepEqual(readdirSync(w.paths.trash), []);
});

test("warnings: a virtualenv, an absolute symlink into the source, a hard link", { skip: !mac }, async () => {
  const w = world();
  mkdirSync(join(w.beta, ".venv", "bin"), { recursive: true });
  writeFileSync(join(w.beta, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  symlinkSync(join(w.beta, "b.txt"), join(w.beta, "abs-link"));
  linkSync(join(w.beta, "b.txt"), join(w.beta, "hard.txt"));
  const made = await createClone({ paths: w.paths, pathKey: "k", branch: "b", inputs: inputs(w, { readOnly: [] }), helper });
  const text = made.resource.warnings.join("\n");
  assert.match(text, /virtualenv at beta\/.venv/);
  assert.match(text, /absolute symlink.*beta\/abs-link/);
  assert.match(text, /hard-linked.*beta\/(b|hard)\.txt/);
  (await removeClone(w.paths, "k")).deleting;
});

test("remove refuses a symlink pointing out of the clones folder, and leaves its target", { skip: !mac }, async () => {
  const w = world();
  const outside = join(w.root, "precious");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  symlinkSync(outside, join(w.paths.clones, "evil"));
  await assert.rejects(removeClone(w.paths, "evil"), /symlink/);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
});

test("remove refuses `..` and other path tricks in the key", { skip: !mac }, async () => {
  const w = world();
  for (const key of ["..", ".", "../precious", "a/b", "/tmp", "", "-x/..", "a\nb"]) {
    await assert.rejects(removeClone(w.paths, key), /path key/, JSON.stringify(key));
  }
});

test("remove deletes only the key's folder; a symlink inside pointing out is unlinked, not followed", { skip: !mac }, async () => {
  const w = world();
  const outside = join(w.root, "precious");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  for (const key of ["one", "two"]) {
    mkdirSync(join(w.paths.clones, key, "ws", "locked"), { recursive: true });
    writeFileSync(join(w.paths.clones, key, "ws", "locked", "f"), "x");
    symlinkSync(outside, join(w.paths.clones, key, "ws", "out"));
    chmodSync(join(w.paths.clones, key, "ws", "locked"), 0o555);
  }
  const removed = await removeClone(w.paths, "one");
  await removed.deleting;
  assert.ok(!existsSync(join(w.paths.clones, "one")));
  assert.ok(existsSync(join(w.paths.clones, "two", "ws", "locked", "f")));
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
  const none = await removeClone(w.paths, "never-made");
  assert.equal(none.removed, false);
});

test("remove kills a process working inside the clone", { skip: !mac }, async () => {
  const w = world();
  const folder = join(w.paths.clones, "busy", "ws");
  mkdirSync(folder, { recursive: true });
  const child = spawn("/bin/sleep", ["30"], { cwd: folder, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
  await new Promise((r) => setTimeout(r, 200));
  const removed = await removeClone(w.paths, "busy");
  assert.ok(removed.killed.includes(child.pid!), `killed ${removed.killed}, sleep was ${child.pid}`);
  assert.equal(await exited, "SIGTERM");
  await removed.deleting;
});

test("the sweep empties leftover trash", { skip: !mac }, async () => {
  const w = world();
  mkdirSync(join(w.paths.trash, "left-1", "deep"), { recursive: true });
  chmodSync(join(w.paths.trash, "left-1", "deep"), 0o555);
  writeFileSync(join(w.paths.trash, "left-2"), "x");
  assert.equal(await sweepTrash(w.paths), 2);
  assert.deepEqual(readdirSync(w.paths.trash), []);
  assert.ok(lstatSync(w.paths.clones).isDirectory());
});

test('"branch": "keep": that repository stays on what it was copied on, the others and the workspace folder get the thread\'s branch; back skips it with the reason', { skip: !mac }, async () => {
  const w = world();
  const text = JSON.stringify({ bring: [{ path: w.alpha, as: "alpha", branch: "keep", back: "true" }, { path: w.beta, as: "beta", branch: "thread", back: "true" }] });
  const approved: Approved = { folder: w.workspace, text, hash: sha256Hex(text) };
  const commands = { store: new RunStore(join(w.root, "data")), locks: new RepoLocks() };
  const made = await createClone({ paths: w.paths, pathKey: "keep1", branch: "cow/thread-k", inputs: null, workspace: { approved, pick: null }, commands, helper });
  const clone = made.path;
  assert.equal(run(clone, "branch", "--show-current"), "cow/thread-k");
  assert.equal(run(join(clone, "beta"), "branch", "--show-current"), "cow/thread-k");
  assert.equal(run(join(clone, "alpha"), "branch", "--show-current"), "main");
  assert.equal(run(join(clone, "alpha"), "branch", "--list", "cow/thread-k"), "");
  assert.ok(!existsSync(join(clone, "alpha", ".git", "index.lock")), "still made independent: lock removed");
  assert.ok(!existsSync(join(clone, "alpha", ".git", "worktrees")), "still made independent: worktree list removed");
  assert.deepEqual(made.resource.bring.map((item) => [item.as, item.branched]), [["alpha", false], ["beta", true]]);
  // A commit in each: back runs for beta and skips alpha, saying why.
  for (const repo of ["alpha", "beta"]) run(join(clone, repo), "commit", "-q", "--allow-empty", "-m", "work");
  const plan = await backCandidates(w.paths, clone, approvedFile(approved));
  assert.deepEqual(plan.repos.map((repo) => [repo.as, repo.ahead, repo.why]), [[null, 0, null], ["alpha", null, KEPT_WHY], ["beta", 1, null]]);
  const results = await backFromClone(commands, w.paths, clone, approved);
  assert.deepEqual(results.map((result) => [result.as, result.status]), [[null, "nothing-new"], ["alpha", "skipped"], ["beta", "ran"]]);
});
