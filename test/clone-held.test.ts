// When bb removes a clone: teardown, the unsaved-work check, the outcome
// table, and holding a clone back. Throwaway folders and repositories under
// the system temp folder; the clone is a plain copy, which is all the check
// needs.
import assert from "node:assert/strict";
import "./host-data.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { judge, lossText, reasonText } from "../src/clone/judge.ts";
import { listHeld, removeHeld, removeOrHold, teardownHeld, unsavedWork } from "../src/clone/held.ts";
import { donePath, layout } from "../src/clone/remove.ts";
import { sha256Hex } from "../src/signing/backend.ts";
import type { Approved } from "../src/workspace/ops.ts";
import { RepoLocks, RunStore } from "../src/workspace/run.ts";

let base: string;
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cow-held-test-")));
});
after(() => {
  if (base) {
    execFileSync("chmod", ["-R", "u+w", base]);
    rmSync(base, { recursive: true, force: true });
  }
});

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@example.com";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let n = 0;
function repo(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "a.txt"), `${name}\n`);
  writeFileSync(join(path, ".gitignore"), "*.log\n");
  git(path, "init", "-q", "-b", "main");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "one");
  return path;
}
/** A copy of a repository, as a clone is: the same objects, then a branch of its own. */
function copyOf(source: string, target: string, branch = "cow/t"): string {
  execFileSync("cp", ["-R", source, target]);
  git(target, "checkout", "-q", "-b", branch);
  return target;
}

test("unsaved work: dirty, untracked, ignored only, ahead of the source, brought back, not a repository", async () => {
  n += 1;
  const root = join(base, `u${n}`);
  mkdirSync(root);
  const source = repo(root, "src");
  const clean = copyOf(source, join(root, "clean"));
  assert.deepEqual(await unsavedWork(clean, source), { repo: true, uncommitted: 0, branches: [], error: null });

  const dirty = copyOf(source, join(root, "dirty"));
  writeFileSync(join(dirty, "a.txt"), "changed\n");
  assert.equal((await unsavedWork(dirty, source)).uncommitted, 1);

  const untracked = copyOf(source, join(root, "untracked"));
  writeFileSync(join(untracked, "new.txt"), "new\n");
  assert.equal((await unsavedWork(untracked, source)).uncommitted, 1);

  const ignored = copyOf(source, join(root, "ignored"));
  writeFileSync(join(ignored, "debug.log"), "noise\n");
  assert.deepEqual(await unsavedWork(ignored, source), { repo: true, uncommitted: 0, branches: [], error: null });

  const ahead = copyOf(source, join(root, "ahead"));
  writeFileSync(join(ahead, "b.txt"), "work\n");
  git(ahead, "add", "b.txt");
  git(ahead, "commit", "-q", "-m", "work");
  git(ahead, "branch", "-q", "side", "main");
  assert.deepEqual(await unsavedWork(ahead, source), { repo: true, uncommitted: 0, branches: ["cow/t"], error: null });

  // Brought back: the source fetched the branch, so it has the commits.
  git(source, "fetch", "-q", ahead, "cow/t:brought");
  assert.deepEqual((await unsavedWork(ahead, source)).branches, []);

  // A stash counts; a detached HEAD on a new commit counts.
  const stashed = copyOf(source, join(root, "stashed"));
  writeFileSync(join(stashed, "a.txt"), "stash me\n");
  git(stashed, "stash", "-q");
  assert.deepEqual((await unsavedWork(stashed, source)).branches, ["the stash"]);
  const detached = copyOf(source, join(root, "detached"));
  git(detached, "checkout", "-q", "--detach");
  git(detached, "commit", "-q", "--allow-empty", "-m", "loose");
  assert.deepEqual((await unsavedWork(detached, source)).branches, ["a detached HEAD"]);

  // Not a repository: it cannot be judged, and does not hold the clone.
  const plain = join(root, "plain");
  mkdirSync(plain);
  writeFileSync(join(plain, "x.txt"), "x\n");
  assert.deepEqual(await unsavedWork(plain, source), { repo: false, uncommitted: 0, branches: [], error: null });

  // The workspace folder's own check leaves out the repositories brought into it.
  const ws = copyOf(source, join(root, "ws"));
  repo(ws, "api");
  assert.equal((await unsavedWork(ws, source)).uncommitted, 1);
  assert.equal((await unsavedWork(ws, source, ["api"])).uncommitted, 0);
});

test("the outcome table", () => {
  const ok = { repo: true, uncommitted: 0, branches: [], error: null };
  const dirty = { ...ok, uncommitted: 2 };
  const ahead = { ...ok, branches: ["cow/t"] };
  const plain = { repo: false, uncommitted: 0, branches: [], error: null };
  // Every teardown exited 0: removed, whatever the repositories hold.
  assert.deepEqual(judge([{ as: "api", teardown: { code: 0, timedOut: false }, unsaved: dirty }, { as: null, teardown: { code: 0, timedOut: false }, unsaved: ahead }]), []);
  // No teardown and nothing unsaved: removed. Not a repository: removed.
  assert.deepEqual(judge([{ as: "api", teardown: null, unsaved: ok }, { as: null, teardown: null, unsaved: plain }]), []);
  // A teardown failed or timed out: held.
  assert.deepEqual(judge([{ as: "api", teardown: { code: 3, timedOut: false }, unsaved: ok }]), [{ as: "api", kind: "teardown-failed", code: 3, timedOut: false }]);
  assert.deepEqual(judge([{ as: "api", teardown: { code: null, timedOut: true }, unsaved: ok }]), [{ as: "api", kind: "teardown-failed", code: null, timedOut: true }]);
  // No teardown, and unsaved work: held, per repository; one with a clean teardown does not cover another.
  assert.deepEqual(
    judge([{ as: "api", teardown: { code: 0, timedOut: false }, unsaved: ok }, { as: "web", teardown: null, unsaved: { ...dirty, branches: ["wip"] } }]),
    [{ as: "web", kind: "uncommitted", count: 2 }, { as: "web", kind: "unsaved-commits", branches: ["wip"] }],
  );
  // Could not be told: held.
  assert.deepEqual(judge([{ as: null, teardown: null, unsaved: { ...ok, error: "git status failed" } }]), [{ as: null, kind: "cannot-check", why: "git status failed" }]);
  assert.equal(reasonText({ as: "api", kind: "teardown-failed", code: 3, timedOut: false }), "api: teardown exited 3");
  assert.equal(reasonText({ as: null, kind: "uncommitted", count: 1 }), "the workspace folder: 1 uncommitted or untracked change, and no teardown");
  assert.equal(lossText("web", { ...dirty, branches: ["wip"] }), "web: 2 uncommitted or untracked changes and commits neither its source nor a remote has on wip");
  assert.equal(lossText("web", ok), null);
});

/** A complete clone of cow's, as the host entry leaves one: `<clones>/<key>/ws/{api,web}` and its done record. */
function cloneWorld(file: object) {
  n += 1;
  const root = join(base, `c${n}`);
  mkdirSync(root);
  const ws = join(root, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "RULES.md"), "rules\n");
  const api = repo(root, "api");
  const web = repo(root, "web");
  const text = JSON.stringify(file);
  const approved: Approved = { folder: ws, text, hash: sha256Hex(text) };
  const paths = layout(join(root, "data"));
  const commands = { store: new RunStore(join(root, "data")), locks: new RepoLocks() };
  const make = (key: string) => {
    const clone = join(paths.clones, key, "ws");
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, "RULES.md"), "rules\n");
    copyOf(api, join(clone, "api"));
    copyOf(web, join(clone, "web"));
    const resource = { branch: "cow/t", source: { path: ws, head: null, branched: false }, bring: [{ path: api, as: "api", head: null, branched: true }, { path: web, as: "web", head: null, branched: true }], workspace: { folder: ws, hash: approved.hash } };
    writeFileSync(donePath(paths, key), JSON.stringify({ path: clone, resource }));
    return clone;
  };
  return { root, ws, api, web, approved, paths, commands, make };
}

const label = { threadId: "thr_t", title: "a thread" };

test("a clean teardown removes the clone; teardowns run while it exists, in reverse of setup's order, then the workspace folder's", async () => {
  const marks = join(base, "marks.txt");
  const w = cloneWorld({
    bring: [
      { path: "../api", as: "api", teardown: `printf 'api %s %s\\n' "$PWD" "$COW_BRANCH" >> ${JSON.stringify(marks)}` },
      { path: "../web", as: "web", teardown: `test -f a.txt && printf 'web\\n' >> ${JSON.stringify(marks)}` },
    ],
    teardown: `printf 'top %s\\n' "$COW_AS" >> ${JSON.stringify(marks)}`,
  });
  const clone = w.make("k1");
  // Unsaved work, but a clean teardown is taken as having saved what mattered.
  writeFileSync(join(clone, "api", "left.txt"), "left\n");
  const outcome = await removeOrHold(w.paths, w.commands, { pathKey: "k1", approved: w.approved, label });
  assert.equal(outcome.kind, "removed");
  if (outcome.kind === "removed") await outcome.removed.deleting;
  assert.equal(readFileSync(marks, "utf8"), `web\napi ${join(clone, "api")} cow/t\ntop .\n`);
  assert.equal(existsSync(join(w.paths.clones, "k1")), false);
  assert.equal(existsSync(donePath(w.paths, "k1")), false);
  assert.deepEqual(listHeld(w.paths), []);
  assert.equal(w.commands.store.get(w.api).teardown!.code, 0);
});

test("no teardown and an uncommitted file: held, intact, listed; the held clone is removed only by exact path", async () => {
  const w = cloneWorld({ bring: [{ path: "../api", as: "api" }, { path: "../web", as: "web" }] });
  const clone = w.make("thr_t-1");
  writeFileSync(join(clone, "web", "unsaved.txt"), "keep me\n");
  const outcome = await removeOrHold(w.paths, w.commands, { pathKey: "thr_t-1", approved: w.approved, label });
  assert.equal(outcome.kind, "held");
  assert.equal(existsSync(join(w.paths.clones, "thr_t-1")), false);
  const [held] = listHeld(w.paths);
  assert.ok(held);
  assert.equal(held.path, join(w.paths.held, "thr_t-1", "ws"));
  assert.equal(readFileSync(join(held.path, "web", "unsaved.txt"), "utf8"), "keep me\n");
  assert.deepEqual(held.reasons, [{ as: "web", kind: "uncommitted", count: 1 }]);
  assert.equal(held.title, "a thread");
  // Removing it: an id that is not one plain segment, or a symlink in its place, is refused.
  await assert.rejects(removeHeld(w.paths, "../clones"), /one plain path segment/);
  symlinkSync(w.root, join(w.paths.held, "evil"));
  await assert.rejects(removeHeld(w.paths, "evil"), /symlink/);
  assert.ok(existsSync(w.ws));
  rmSync(join(w.paths.held, "evil"));
  const removed = await removeHeld(w.paths, "thr_t-1");
  await removed.deleting;
  assert.equal(existsSync(join(w.paths.held, "thr_t-1")), false);
  assert.deepEqual(listHeld(w.paths), []);
  assert.deepEqual(readdirSync(w.paths.trash), []);
});

test("a failing teardown holds; teardown again, once it passes, removes it", async () => {
  const flag = join(base, "teardown-may-pass");
  const w = cloneWorld({ bring: [{ path: "../api", as: "api", teardown: `test -f ${JSON.stringify(flag)}` }, { path: "../web", as: "web" }] });
  w.make("k3");
  const outcome = await removeOrHold(w.paths, w.commands, { pathKey: "k3", approved: w.approved, label: { threadId: null, title: null } });
  assert.equal(outcome.kind, "held");
  const [held] = listHeld(w.paths);
  assert.deepEqual(held!.reasons, [{ as: "api", kind: "teardown-failed", code: 1, timedOut: false }]);
  assert.equal("tail" in held!.teardowns[0]!, false, "the list carries no output");
  const still = await teardownHeld(w.paths, w.commands, { id: "k3", approved: w.approved });
  assert.equal(still.removed, false);
  writeFileSync(flag, "");
  const passed = await teardownHeld(w.paths, w.commands, { id: "k3", approved: w.approved });
  assert.equal(passed.removed, true);
  assert.deepEqual(listHeld(w.paths), []);
});

test("a clone with nothing unsaved and no teardown is removed; a clone with explicit inputs runs no teardown", async () => {
  const w = cloneWorld({ bring: [{ path: "../api", as: "api", teardown: "exit 9" }] });
  const clone = w.make("k4");
  // Made with explicit inputs: no workspace in its record, so no teardown runs, and nothing unsaved means it goes.
  const record = JSON.parse(readFileSync(donePath(w.paths, "k4"), "utf8"));
  record.resource.workspace = null;
  writeFileSync(donePath(w.paths, "k4"), JSON.stringify(record));
  const outcome = await removeOrHold(w.paths, w.commands, { pathKey: "k4", approved: w.approved, label });
  assert.equal(outcome.kind, "removed");
  assert.deepEqual(outcome.teardowns, []);
  assert.equal(existsSync(clone), false);
});

test("unsaved work: a commit one of the clone's remote-tracking refs contains is saved; the rest is judged as before", async () => {
  n += 1;
  const root = join(base, `u${n}`);
  mkdirSync(root);
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const app = repo(root, "app");
  git(app, "remote", "add", "origin", origin);
  git(app, "push", "-q", "origin", "main");
  git(app, "fetch", "-q", "origin");

  // Pushed from the clone: origin has it, the source has not fetched it.
  const pushed = copyOf(app, join(root, "pushed"), "cow/t");
  git(pushed, "switch", "-q", "-c", "feature");
  git(pushed, "commit", "-q", "--allow-empty", "-m", "feature");
  assert.deepEqual((await unsavedWork(pushed, app)).branches, ["feature"]);
  git(pushed, "push", "-q", "origin", "feature");
  assert.deepEqual(await unsavedWork(pushed, app), { repo: true, uncommitted: 0, branches: [], error: null });
  // A later local commit on top of the pushed one is not on the remote.
  git(pushed, "commit", "-q", "--allow-empty", "-m", "after the push");
  assert.deepEqual((await unsavedWork(pushed, app)).branches, ["feature"]);

  // A newer main, fetched and pulled into the clone's main: saved on origin/main.
  const other = copyOf(app, join(root, "other"), "elsewhere");
  git(other, "commit", "-q", "--allow-empty", "-m", "newer main");
  git(other, "push", "-q", "origin", "elsewhere:main");
  const fetched = copyOf(app, join(root, "fetched"), "cow/t");
  git(fetched, "fetch", "-q", "origin");
  git(fetched, "branch", "-q", "-f", "main", "origin/main");
  assert.deepEqual(await unsavedWork(fetched, app), { repo: true, uncommitted: 0, branches: [], error: null });

  // Uncommitted changes, a stash and a detached HEAD no remote-tracking ref contains still count.
  const dirty = copyOf(app, join(root, "dirty"), "cow/t");
  writeFileSync(join(dirty, "a.txt"), "changed\n");
  assert.equal((await unsavedWork(dirty, app)).uncommitted, 1);
  git(dirty, "stash", "-q");
  assert.deepEqual((await unsavedWork(dirty, app)).branches, ["the stash"]);
  const detached = copyOf(app, join(root, "detached"), "cow/t");
  git(detached, "checkout", "-q", "--detach");
  git(detached, "commit", "-q", "--allow-empty", "-m", "loose");
  assert.deepEqual((await unsavedWork(detached, app)).branches, ["a detached HEAD"]);
  // A detached HEAD on a commit a remote-tracking ref contains is saved.
  git(detached, "checkout", "-q", "--detach", "origin/main");
  assert.deepEqual((await unsavedWork(detached, app)).branches, []);
});
