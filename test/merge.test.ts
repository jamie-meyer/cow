import assert from "node:assert/strict";
import "./host-data.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, beforeEach, test } from "node:test";
import { type FactsDeps, type GitRun, type MergeFacts, type MergeInput, RepoLocks, chooseBase, defaultDeps, repoKey, resetVersionCheck, runGit, tooOld, workOut, workOutBounded } from "../src/merge/facts.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cow-merge-test-")));
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => resetVersionCheck());

let count = 0;
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=cow test", "-c", "user.email=cow-test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
}
function write(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}
function commit(dir: string, files: Record<string, string>, message = "change"): string {
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD").trim();
}
/** A repository on `trunk` with one commit, and a worktree of it on `work` made from there. */
function repo(trunk = "main"): { main: string; wt: string } {
  const dir = join(root, `r${++count}`);
  const main = join(dir, "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", trunk);
  commit(main, { "a.txt": "one\ntwo\nthree\n", "b.txt": "bee\n", "c.txt": "sea\n" }, "base");
  const wt = join(dir, "wt");
  git(main, "worktree", "add", "-q", "-b", "work", wt, trunk);
  return { main, wt };
}
const input = (wt: string, more: Partial<MergeInput> = {}): MergeInput => ({ path: wt, baseBranch: null, defaultBranch: "main", sourcePath: null, ...more });
const facts = (i: MergeInput, known: MergeFacts | null = null, deps: FactsDeps = defaultDeps()) => workOut(i, known, deps, new AbortController().signal);

test("ahead only, and clean", async () => {
  const { wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  commit(wt, { "b.txt": "bee two\n" });
  const got = await facts(input(wt));
  assert.equal(got.state, "clean");
  assert.equal(got.ahead, 2);
  assert.equal(got.behind, 0);
  assert.equal(got.base, "main");
  assert.equal(got.branch, "work");
  assert.equal(got.dirty, false);
  assert.deepEqual(got.conflicts, []);
});

test("behind, and clean", async () => {
  const { main, wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  commit(main, { "b.txt": "bee two\n" });
  commit(main, { "c.txt": "sea two\n" });
  commit(main, { "e.txt": "e\n" });
  const got = await facts(input(wt));
  assert.equal(got.state, "clean");
  assert.equal(got.ahead, 1);
  assert.equal(got.behind, 3);
});

test("conflicting: the files are named", async () => {
  const { main, wt } = repo();
  commit(wt, { "a.txt": "one\nTWO\nthree\n", "c.txt": "mine\n", "d.txt": "fine\n" });
  commit(main, { "a.txt": "one\n2\nthree\n", "c.txt": "theirs\n" });
  const got = await facts(input(wt));
  assert.equal(got.state, "conflict");
  assert.deepEqual([...got.conflicts].sort(), ["a.txt", "c.txt"]);
  assert.equal(got.conflictCount, 2);
  assert.equal(got.ahead, 1);
  assert.equal(got.behind, 1);
});

test("already merged: nothing to say", async () => {
  const { main, wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  git(main, "merge", "-q", "--ff-only", "work");
  const got = await facts(input(wt));
  assert.equal(got.state, "none");
  assert.equal(got.ahead, 0);
  // Merged by a squash: the commits are its own, the changes are in the base.
  const other = repo();
  commit(other.wt, { "d.txt": "new\n" });
  commit(other.wt, { "e.txt": "more\n" });
  git(other.main, "merge", "-q", "--squash", "work");
  git(other.main, "commit", "-q", "-m", "squashed");
  const squashed = await facts(input(other.wt));
  assert.equal(squashed.state, "none");
  assert.match(squashed.why ?? "", /already merged/);
});

test("no commits of its own: nothing to say", async () => {
  const { main, wt } = repo();
  assert.equal((await facts(input(wt))).state, "none");
  commit(main, { "b.txt": "moved on\n" });
  const got = await facts(input(wt));
  assert.equal(got.state, "none");
  assert.equal(got.behind, 1);
});

test("a detached head: nothing to say", async () => {
  const { wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  git(wt, "checkout", "-q", "--detach");
  const got = await facts(input(wt));
  assert.equal(got.state, "none");
  assert.match(got.why ?? "", /detached/);
});

test("a default branch not called main: bb's, then the one found locally", async () => {
  const { wt } = repo("trunk");
  commit(wt, { "d.txt": "new\n" });
  const told = await facts(input(wt, { defaultBranch: "trunk" }));
  assert.equal(told.state, "clean");
  assert.equal(told.base, "trunk");
  // bb names a default that is not here: there is no main or master either, so it is not known; never clean.
  const lost = await facts(input(wt, { defaultBranch: "develop" }));
  assert.equal(lost.state, "unknown");
  assert.match(lost.why ?? "", /no base branch/);
  // The branch the worktree was made from comes first.
  assert.equal(chooseBase({ baseBranch: "release", defaultBranch: "main" }, new Map([["main", "1"], ["release", "2"]]), null), "release");
  assert.equal(chooseBase({ baseBranch: "origin/release", defaultBranch: null }, new Map([["release", "2"]]), null), "release");
  assert.equal(chooseBase({ baseBranch: null, defaultBranch: null }, new Map([["trunk", "1"]]), "refs/remotes/origin/trunk"), "trunk");
  assert.equal(chooseBase({ baseBranch: "gone", defaultBranch: null }, new Map([["master", "1"]]), null), "master");
});

test("uncommitted changes are shown, and not counted in the trial merge", async () => {
  const { main, wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  commit(main, { "a.txt": "one\n2\nthree\n" });
  // Would conflict with main if it were committed.
  write(wt, "a.txt", "one\nTWO\nthree\n");
  write(wt, "untracked.txt", "u\n");
  const got = await facts(input(wt));
  assert.equal(got.state, "clean");
  assert.equal(got.dirty, true);
});

test("a repository that has gone reads not known", async () => {
  const { wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  rmSync(wt, { recursive: true, force: true });
  const got = await facts(input(wt));
  assert.equal(got.state, "unknown");
  assert.match(got.why ?? "", /no longer there/);
  // A folder that is there and is no repository at all.
  const bare = join(root, "not-a-repo");
  mkdirSync(bare);
  const outside = await workOut(input(bare), null, { ...defaultDeps(), git: (cwd, args, options) => runGit()(cwd, args, { ...options, env: { GIT_CEILING_DIRECTORIES: root } }) }, new AbortController().signal);
  assert.equal(outside.state, "unknown");
});

test("git failing, too old or timing out reads not known, never clean", async () => {
  const { wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  const missing = await facts(input(wt), null, defaultDeps(join(root, "no-such-git")));
  assert.equal(missing.state, "unknown");
  assert.match(missing.why ?? "", /git did not run/);

  resetVersionCheck();
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const old = join(bin, "old-git");
  writeFileSync(old, "#!/bin/sh\necho 'git version 2.30.1'\n");
  chmodSync(old, 0o755);
  const tooOldFacts = await facts(input(wt), null, defaultDeps(old));
  assert.equal(tooOldFacts.state, "unknown");
  assert.match(tooOldFacts.why ?? "", /older than 2\.38/);
  assert.equal(tooOld("git version 2.38.0"), null);
  assert.equal(tooOld("git version 2.54.0 (Apple Git-157)"), null);

  // A merge-tree that fails: every other command is real.
  resetVersionCheck();
  const real = runGit();
  const failing: GitRun = (cwd, args, options) => (args[0] === "merge-tree" ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: broken\n" }) : real(cwd, args, options));
  const failed = await facts(input(wt), null, { ...defaultDeps(), git: failing });
  assert.equal(failed.state, "unknown");
  assert.match(failed.why ?? "", /merge-tree failed: fatal: broken/);

  // One that never answers is stopped at the time limit.
  resetVersionCheck();
  const slow = join(bin, "slow-git");
  writeFileSync(slow, `#!/bin/sh\ncase "$*" in *merge-tree*) exec sleep 30;; esac\nexec git "$@"\n`);
  chmodSync(slow, 0o755);
  const started = Date.now();
  const timed = await workOutBounded(new RepoLocks(), input(wt), null, defaultDeps(slow), 1500);
  assert.equal(timed.state, "unknown");
  assert.match(timed.why ?? "", /timed out/);
  assert.ok(Date.now() - started < 10_000);
});

test("the answer is reused while both tips stand still, and worked out again when either moves", async () => {
  const { main, wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  const calls: string[] = [];
  const real = runGit();
  const deps: FactsDeps = { ...defaultDeps(), git: (cwd, args, options) => (calls.push(args[0]!), real(cwd, args, options)) };
  const first = await facts(input(wt), null, deps);
  assert.equal(first.state, "clean");
  assert.ok(calls.includes("merge-tree"));

  calls.length = 0;
  const again = await facts(input(wt), first, deps);
  assert.deepEqual({ ...again, checkedAt: 0, dirty: null }, { ...first, checkedAt: 0, dirty: null });
  assert.equal(again.at, first.at);
  assert.ok(!calls.includes("merge-tree") && !calls.includes("rev-list"), calls.join(" "));

  // The branch moves.
  commit(wt, { "e.txt": "more\n" });
  calls.length = 0;
  const moved = await facts(input(wt), again, deps);
  assert.ok(calls.includes("merge-tree"));
  assert.equal(moved.ahead, 2);

  // The base moves.
  const stood = await facts(input(wt), moved, deps);
  calls.length = 0;
  commit(main, { "d.txt": "clash\n" });
  const baseMoved = await facts(input(wt), stood, deps);
  assert.ok(calls.includes("merge-tree"));
  assert.equal(baseMoved.state, "conflict");
  assert.deepEqual(baseMoved.conflicts, ["d.txt"]);
});

/** Everything of a checkout the brief says must not change, as bytes. */
function snapshot(checkout: string, gitDir: string, commonDir: string): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (name === ".git" && dir === checkout) continue;
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else files.push(`${relative(checkout, path)}\n${readFileSync(path, "base64")}`);
    }
  };
  walk(checkout);
  const objects: string[] = [];
  const walkObjects = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walkObjects(path);
      else objects.push(relative(commonDir, path));
    }
  };
  walkObjects(join(commonDir, "objects"));
  const read = (path: string) => {
    try {
      return readFileSync(path, "base64");
    } catch {
      return "(none)";
    }
  };
  const locks = readdirSync(gitDir).filter((name) => name.endsWith(".lock"));
  return JSON.stringify({
    files,
    index: read(join(gitDir, "index")),
    head: read(join(gitDir, "HEAD")),
    config: read(join(commonDir, "config")),
    refs: git(checkout, "for-each-ref", "--format=%(refname) %(objectname)"),
    packed: read(join(commonDir, "packed-refs")),
    stash: git(checkout, "stash", "list"),
    status: git(checkout, "-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"),
    objects,
    locks,
  });
}

test("both checkouts are byte for byte the same after the trial merge: tree, index, refs, stash, status, config and objects", async () => {
  const { main, wt } = repo();
  commit(wt, { "a.txt": "one\nTWO\nthree\n", "d.txt": "new\n" });
  commit(main, { "a.txt": "one\n2\nthree\n" });
  write(main, "b.txt", "changed in main, not committed\n");
  git(main, "stash", "push", "-q", "-m", "kept");
  write(wt, "c.txt", "changed, not committed\n");
  write(wt, "new.txt", "untracked\n");
  git(wt, "add", "new.txt");
  write(wt, "loose.txt", "untracked\n");
  const common = join(main, ".git");
  const wtGit = git(wt, "rev-parse", "--path-format=absolute", "--git-dir").trim();
  const before = [snapshot(main, common, common), snapshot(wt, wtGit, common)];
  const got = await facts(input(wt));
  assert.equal(got.state, "conflict");
  assert.equal(got.dirty, true);
  // And once more on an answer kept, and while it is clean.
  await facts(input(wt), got);
  const after = [snapshot(main, common, common), snapshot(wt, wtGit, common)];
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
});

test("one git process per repository at a time, and the lock is keyed by the shared repository", async () => {
  const { main, wt } = repo();
  commit(wt, { "d.txt": "new\n" });
  assert.equal(repoKey(wt), repoKey(main));
  const second = join(main, "..", "wt2");
  git(main, "worktree", "add", "-q", "-b", "work2", second, "main");
  commit(second, { "e.txt": "e\n" });
  let running = 0;
  let most = 0;
  const real = runGit();
  const deps: FactsDeps = {
    ...defaultDeps(),
    git: async (cwd, args, options) => {
      running += 1;
      most = Math.max(most, running);
      try {
        return await real(cwd, args, options);
      } finally {
        running -= 1;
      }
    },
  };
  const locks = new RepoLocks();
  const both = await Promise.all([workOutBounded(locks, input(wt), null, deps), workOutBounded(locks, input(second), null, deps), workOutBounded(locks, input(wt), null, deps)]);
  assert.deepEqual(both.map((f) => f.state), ["clean", "clean", "clean"]);
  assert.equal(most, 1);
});

test("a clone: its branch in its own repository, its base in the source folder's, worked out without writing to either", async () => {
  const dir = join(root, `clone${++count}`);
  const source = join(dir, "source");
  mkdirSync(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  commit(source, { "a.txt": "one\n", "b.txt": "bee\n" }, "base");
  // A copy of the whole folder, as a clone is, on a branch of its own.
  const clone = join(dir, "clone");
  execFileSync("cp", ["-R", source, clone]);
  git(clone, "checkout", "-q", "-b", "thread");
  commit(clone, { "a.txt": "mine\n" });
  // The source moves on after the copy, with objects the clone does not have.
  commit(source, { "a.txt": "theirs\n" });
  const before = [snapshot(source, join(source, ".git"), join(source, ".git")), snapshot(clone, join(clone, ".git"), join(clone, ".git"))];
  const got = await facts({ path: clone, baseBranch: null, defaultBranch: "main", sourcePath: source });
  assert.equal(got.clone, true);
  assert.equal(got.state, "conflict");
  assert.deepEqual(got.conflicts, ["a.txt"]);
  assert.equal(got.behind, 1);
  assert.equal(got.ahead, 1);
  const after = [snapshot(source, join(source, ".git"), join(source, ".git")), snapshot(clone, join(clone, ".git"), join(clone, ".git"))];
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
});
