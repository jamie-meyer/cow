// Running approved commands in the host entry: working directory, variables,
// time limit, the kept record, the dirty-source skip, setup failing a clone,
// back's choice of repositories, and the provider's workspace input.
// Throwaway folders and repositories under the system temp folder; needs macOS for the clones.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type CloneCall, startHelper } from "../src/clone/helper.ts";
import { layout } from "../src/clone/remove.ts";
import { createClone } from "../src/clone/workspace.ts";
import { sha256Hex } from "../src/signing/backend.ts";
import { type Approved, backCandidates, backFromClone, syncWorkspace } from "../src/workspace/ops.ts";
import { RepoLocks, RunStore, commandEnv, runCommand } from "../src/workspace/run.ts";

const mac = process.platform === "darwin";
let base: string;
let helper: CloneCall;
before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cow-ws-run-test-")));
  if (mac) helper = await startHelper({ prefer: ["perl"] });
});
after(() => {
  helper?.close();
  if (base) {
    execFileSync("chmod", ["-R", "u+w", base]);
    rmSync(base, { recursive: true, force: true });
  }
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@example.com";

let n = 0;
function world(file: object) {
  n += 1;
  const root = join(base, `w${n}`);
  const ws = join(root, "ws");
  mkdirSync(join(ws, "notes"), { recursive: true });
  writeFileSync(join(ws, "RULES.md"), "rules\n");
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "a.txt"), `${name}\n`);
    git(path, "init", "-q", "-b", "main");
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "one");
    return path;
  };
  const api = repo("api");
  const web = repo("web");
  const text = JSON.stringify(file);
  writeFileSync(join(ws, "cow.workspace.json"), text);
  const approved: Approved = { folder: ws, text, hash: sha256Hex(text) };
  const data = join(root, "data");
  mkdirSync(data);
  return { root, ws, api, web, approved, data, store: new RunStore(data), locks: new RepoLocks() };
}

test("a command runs in its directory with only the COW_ variables, under its time limit, and its last lines are kept", async () => {
  const dir = mkdtempSync(join(base, "cmd-"));
  const vars = { COW_SOURCE: "/a b/'quoted'", COW_AS: "api", COW_WORKSPACE: "/w", COW_BRANCH: "x;rm -rf ~" };
  const result = await runCommand({ command: 'pwd; printf "%s|%s|%s\\n" "$COW_SOURCE" "$COW_BRANCH" "${COW_CLONE-unset}"; for i in $(seq 1 30); do echo line$i; done; exit 3', cwd: dir, vars, timeoutMs: 10_000 });
  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.tail.length, 20);
  assert.equal(result.tail.at(-1), "line30");
  const full = await runCommand({ command: 'pwd; printf "%s|%s|%s\\n" "$COW_SOURCE" "$COW_BRANCH" "${COW_CLONE-unset}"', cwd: dir, vars, timeoutMs: 10_000 });
  assert.deepEqual(full.tail, [realpathSync(dir), "/a b/'quoted'|x;rm -rf ~|unset"]);
  // Inherited COW_ variables and git redirections never reach it.
  const env = commandEnv({ COW_SOURCE: "s", COW_AS: "a", COW_WORKSPACE: "w" }, { PATH: "/bin", COW_CLONE: "leak", GIT_DIR: "/elsewhere", HOME: "/h" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h", COW_SOURCE: "s", COW_AS: "a", COW_WORKSPACE: "w", GIT_TERMINAL_PROMPT: "0" });
  const slow = await runCommand({ command: "sleep 30 & sleep 30; echo never", cwd: dir, vars, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.code, null);
  assert.ok(slow.ms < 5000);
  assert.match(slow.tail.at(-1)!, /stopped: it ran longer than/);
});

test("sync runs each repository's command in its source, then the workspace's; a dirty source is skipped and untouched; runs are kept", async () => {
  const w = world({ bring: [{ path: "../api", as: "api", sync: 'echo "$COW_AS" >> "$COW_WORKSPACE/../order"; pwd' }, { path: "../web", as: "web", sync: "touch synced" }], sync: 'echo top >> ../order' });
  writeFileSync(join(w.web, "dirty.txt"), "uncommitted\n");
  const results = await syncWorkspace({ store: w.store, locks: w.locks }, w.approved);
  assert.deepEqual(results.map((r) => [r.as, r.status, r.code]), [["api", "ran", 0], ["web", "dirty", null], [null, "ran", 0]]);
  assert.match(results[1]!.why!, /1 uncommitted or untracked/);
  assert.equal(existsSync(join(w.web, "synced")), false);
  assert.equal(readFileSync(join(w.root, "order"), "utf8"), "api\ntop\n");
  const kept = w.store.get(w.api);
  assert.equal(kept.sync!.code, 0);
  assert.deepEqual(kept.sync!.tail, [w.api]);
  assert.equal(kept.sync!.cwd, w.api);
  assert.equal(kept.lastOkSyncAt, kept.sync!.at);
  assert.equal(statSync(join(w.data, "workspace", "runs.json")).mode & 0o777, 0o600);
  // --only picks one; an unknown one is refused.
  assert.deepEqual((await syncWorkspace({ store: w.store, locks: w.locks }, w.approved, ".")).map((r) => r.as), [null]);
  await assert.rejects(syncWorkspace({ store: w.store, locks: w.locks }, w.approved, "nope"), /brings nothing as "nope"/);
  // One at a time per repository.
  const order: string[] = [];
  await Promise.all([
    w.locks.run(w.api, async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 50)); order.push("a2"); }),
    w.locks.run(w.api, async () => { order.push("b1"); }),
  ]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
});

test("a clone from the workspace file: setup runs in each brought folder, back brings only repositories with commits", { skip: !mac }, async () => {
  const w = world({
    bring: [
      { path: "../api", as: "api", setup: 'printf "%s %s %s" "$PWD" "$COW_BRANCH" "$COW_AS" > setup-ran', back: 'git -C "$COW_SOURCE" fetch -q "$COW_CLONE" "$COW_BRANCH:$COW_BRANCH"' },
      { path: "../web", as: "web", back: "touch should-not-run" },
    ],
    setup: "touch top-setup",
    readOnly: ["notes"],
  });
  const paths = layout(join(w.data, "host"));
  const deps = { store: w.store, locks: w.locks };
  const made = await createClone({ paths, pathKey: "k1", branch: "cow/t1", inputs: null, workspace: { approved: w.approved, pick: null }, commands: deps, helper });
  assert.deepEqual(made.resource.workspace, { folder: w.ws, hash: w.approved.hash });
  assert.equal(made.resource.setups, 2);
  assert.equal(readFileSync(join(made.path, "api", "setup-ran"), "utf8"), `${join(made.path, "api")} cow/t1 api`);
  assert.ok(existsSync(join(made.path, "top-setup")));
  assert.deepEqual(made.resource.bring.map((repo) => repo.as), ["api", "web"]);
  // The thread commits in api only.
  writeFileSync(join(made.path, "api", "b.txt"), "work\n");
  git(join(made.path, "api"), "add", "b.txt");
  git(join(made.path, "api"), "commit", "-q", "-m", "work");
  const found = await backCandidates(paths, made.path, null);
  assert.deepEqual(found.repos.map((repo) => [repo.as, repo.ahead]), [[null, null], ["api", 1], ["web", 0]]);
  const results = await backFromClone(deps, paths, made.path, w.approved);
  assert.deepEqual(results.map((r) => [r.as, r.status]), [[null, "skipped"], ["api", "ran"], ["web", "nothing-new"]]);
  assert.equal(results[1]!.code, 0);
  assert.equal(git(w.api, "log", "-1", "--format=%s", "cow/t1"), "work");
  assert.equal(existsSync(join(w.web, "should-not-run")), false);
  assert.equal(w.store.get(w.api).back!.cwd, w.api);
  // Only a clone of cow's, as recorded, is accepted.
  await assert.rejects(backCandidates(paths, join(paths.clones, "k1"), null), /not a copy-on-write workspace/);
  await assert.rejects(backCandidates(paths, w.ws, null), /not a copy-on-write workspace/);
});

test("a subset by name; an unknown name is refused; a failed setup fails the create and removes the clone", { skip: !mac }, async () => {
  const w = world({ bring: [{ path: "../api", as: "api", setup: "echo installing; echo broken >&2; exit 7" }, { path: "../web", as: "web" }] });
  const paths = layout(join(w.data, "host"));
  const deps = { store: w.store, locks: w.locks };
  const picked = await createClone({ paths, pathKey: "k2", branch: "cow/t2", inputs: null, workspace: { approved: { ...w.approved, text: JSON.stringify({ bring: [{ path: "../api", as: "api" }, { path: "../web", as: "web" }] }) }, pick: ["web"] }, commands: deps, helper });
  assert.deepEqual(picked.resource.bring.map((repo) => repo.as), ["web"]);
  await assert.rejects(createClone({ paths, pathKey: "k3", branch: "cow/t3", inputs: null, workspace: { approved: w.approved, pick: ["nope"] }, commands: deps, helper }), /brings nothing by that name/);
  await assert.rejects(
    createClone({ paths, pathKey: "k4", branch: "cow/t4", inputs: null, workspace: { approved: w.approved, pick: null }, commands: deps, helper }),
    (error: Error) => /run setup: setup of api exited 7; its last lines:\ninstalling\nbroken/.test(error.message),
  );
  assert.equal(existsSync(join(paths.clones, "k4")), false);
  assert.equal(existsSync(join(paths.done, "k4.json")), false);
  assert.deepEqual(readdirSync(paths.clones).sort(), ["k2"]);
  assert.equal(w.store.get(w.api).setup!.code, 7);
});

test("sync before clone: an old sync is redone first, and a failure is a warning, not a failed thread", { skip: !mac }, async () => {
  const w = world({ bring: [{ path: "../api", as: "api", sync: "exit 1" }, { path: "../web", as: "web", sync: "touch pulled" }], syncBeforeClone: { olderThanMinutes: 60 } });
  const paths = layout(join(w.data, "host"));
  const deps = { store: w.store, locks: w.locks };
  const made = await createClone({ paths, pathKey: "k5", branch: "cow/t5", inputs: null, workspace: { approved: w.approved, pick: null }, commands: deps, helper });
  assert.ok(existsSync(join(w.web, "pulled")));
  assert.ok(existsSync(join(made.path, "web", "pulled")), "the clone is made after the sync");
  assert.deepEqual(made.resource.warnings.filter((text) => text.startsWith("sync before clone")), ["sync before clone of api failed (exit 1); it was cloned as it is"]);
  // A recent good sync is not repeated.
  rmSync(join(w.web, "pulled"));
  git(w.web, "status");
  await createClone({ paths, pathKey: "k6", branch: "cow/t6", inputs: null, workspace: { approved: w.approved, pick: ["web"] }, commands: deps, helper });
  assert.equal(existsSync(join(w.web, "pulled")), false);
});
