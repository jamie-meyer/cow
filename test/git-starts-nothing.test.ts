// git that cow runs in a folder a thread can write starts no program the
// folder names. Each test builds throwaway repositories under a temporary
// folder of its own, plants a program by every way git has of being told to
// start one (each program only creates a marker file there), runs cow's own
// function, and asserts that no marker exists and that the answer is still
// what it should be.
import assert from "node:assert/strict";
import "./host-data.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { collectCloneDiff, collectDiff, readTextFile } from "../src/briefs/diff.ts";
import { NO_REPOSITORY, detachedEnv, git, isNoRepository, noRepository, useHostData } from "../src/clone/git.ts";
import { hostData } from "./host-data.ts";
import { unsavedWork } from "../src/clone/held.ts";
import { type CloneCall, startHelper } from "../src/clone/helper.ts";
import { layout } from "../src/clone/remove.ts";
import { createClone, preflight } from "../src/clone/workspace.ts";
import { defaultDeps, resetVersionCheck, workOut } from "../src/merge/facts.ts";
import { cleanState } from "../src/workspace/ops.ts";

const mac = process.platform === "darwin";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cow-starts-nothing-test-")));
let helper: CloneCall | null = null;
before(async () => {
  if (mac) helper = await startHelper({ prefer: ["perl"] });
});
after(() => {
  helper?.close();
  execFileSync("chmod", ["-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
});

/** The test's own git, for building: neither the person's configuration nor the system's is read. */
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
};

let count = 0;
interface World {
  dir: string;
  /** Where the planted programs leave their markers. */
  marks: string;
  /** A repository on `main`. */
  main: string;
  /** A linked worktree of it on `work`, one commit ahead, with uncommitted and untracked changes. */
  wt: string;
  /** A repository of its own on `work`, in the same state: what a clone is. */
  solo: string;
  /** The commit `solo` started from. */
  base: string;
}

/** A program that only creates the marker `name`; `passes` for a filter, which must hand its input on. */
function program(w: { dir: string; marks: string }, name: string, passes = false): string {
  const path = join(w.dir, "programs", name);
  write(w.dir, join("programs", name), `#!/bin/sh\n: > '${join(w.marks, name)}'\n${passes ? "cat\n" : ""}`);
  chmodSync(path, 0o755);
  return path;
}

/** Every setting by which git can be told to start a program, each with a program of its own. */
function planted(w: { dir: string; marks: string }): [string, string][] {
  const hooks = join(w.dir, "programs", "hooks");
  for (const hook of ["post-checkout", "reference-transaction", "post-index-change", "pre-commit", "post-merge", "pre-auto-gc"]) {
    write(w.dir, join("programs", "hooks", hook), `#!/bin/sh\n: > '${join(w.marks, `hook-${hook}`)}'\n`);
    chmodSync(join(hooks, hook), 0o755);
  }
  return [
    ["filter.x.clean", program(w, "filter-clean", true)],
    ["filter.x.smudge", program(w, "filter-smudge", true)],
    ["filter.y.process", program(w, "filter-process")],
    ["core.hooksPath", hooks],
    ["core.fsmonitor", program(w, "fsmonitor")],
    ["diff.external", program(w, "diff-external")],
    ["diff.d.command", program(w, "diff-driver-command")],
    ["diff.d.textconv", program(w, "diff-textconv", true)],
    ["merge.m.driver", `${program(w, "merge-driver")} %A`],
    ["merge.default", "m"],
    ["core.pager", program(w, "pager", true)],
    ["pager.diff", "true"],
    ["pager.status", "true"],
    ["pager.config", "true"],
    ["core.editor", program(w, "editor")],
    ["core.sshCommand", program(w, "ssh")],
    ["core.askPass", program(w, "askpass")],
    ["credential.helper", program(w, "credential")],
    ["gpg.program", program(w, "gpg")],
    ["core.alternateRefsCommand", program(w, "alternate-refs")],
    ["alias.status", `!${program(w, "alias-status")}`],
    ["alias.diff", `!${program(w, "alias-diff")}`],
    ["status.submoduleSummary", "true"],
    ["diff.submodule", "diff"],
    ["submodule.recurse", "true"],
    ["diff.ignoreSubmodules", "none"],
  ];
}
const ATTRIBUTES = "* filter=x diff=d merge=m\n*.bin filter=y\n";

/** A repository, a linked worktree and a repository of its own, all with a conflict against `main` ahead of them and changes not committed. */
function world(): World {
  const dir = join(root, `w${++count}`);
  const marks = join(dir, "marks");
  mkdirSync(marks, { recursive: true });
  const build = (path: string) => {
    mkdirSync(path, { recursive: true });
    run(path, "init", "-q", "-b", "main");
    write(path, "a.txt", "one\ntwo\nthree\n");
    write(path, "b.txt", "bee\n");
    write(path, "c.bin", "sea\n");
    run(path, "add", "-A");
    run(path, "commit", "-q", "-m", "base");
  };
  const work = (path: string) => {
    write(path, "a.txt", "one\nTWO of work\nthree\n");
    write(path, ".gitattributes", ATTRIBUTES);
    run(path, "add", "-A");
    run(path, "commit", "-q", "-m", "work");
    write(path, "b.txt", "bee\nnot committed\n");
    write(path, "c.bin", "sea change\n");
    write(path, "new.txt", "untracked\n");
  };
  const ahead = (path: string) => {
    write(path, "a.txt", "one\nTWO of main\nthree\n");
    run(path, "commit", "-q", "-am", "main moves");
  };
  const main = join(dir, "main");
  build(main);
  const wt = join(dir, "wt");
  run(main, "worktree", "add", "-q", "-b", "work", wt, "main");
  work(wt);
  ahead(main);
  const solo = join(dir, "solo");
  build(solo);
  const base = run(solo, "rev-parse", "HEAD");
  ahead(solo);
  run(solo, "checkout", "-q", "-b", "work", base);
  work(solo);
  return { dir, marks, main, wt, solo, base };
}

const set = (file: string, settings: [string, string][]) => {
  for (const [key, value] of settings) run(join(file, ".."), "config", "--file", file, key, value);
};
const gitDir = (path: string) => run(path, "rev-parse", "--absolute-git-dir");

/** Where a thread could put the settings. */
const PLACES: Record<string, (w: World) => void> = {
  "the repository's configuration": (w) => {
    set(join(w.main, ".git", "config"), planted(w));
    set(join(w.solo, ".git", "config"), planted(w));
  },
  "a worktree's own configuration (config.worktree)": (w) => {
    for (const path of [w.main, w.solo]) run(path, "config", "extensions.worktreeConfig", "true");
    set(join(gitDir(w.wt), "config.worktree"), planted(w));
    set(join(w.solo, ".git", "config.worktree"), planted(w));
  },
  "a file in the working tree that the configuration includes": (w) => {
    for (const [repo, tree] of [[w.main, w.wt], [w.solo, w.solo]] as const) {
      write(tree, "tools/settings", "");
      set(join(tree, "tools", "settings"), planted(w));
      run(repo, "config", "include.path", join(tree, "tools", "settings"));
    }
  },
  "the hooks folder and attributes file of the git folder itself": (w) => {
    for (const path of [w.wt, w.solo]) {
      const common = run(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
      for (const hook of ["post-checkout", "reference-transaction", "post-index-change"]) {
        write(common, join("hooks", hook), `#!/bin/sh\n: > '${join(w.marks, `own-hook-${hook}`)}'\n`);
        chmodSync(join(common, "hooks", hook), 0o755);
      }
      write(common, "info/attributes", ATTRIBUTES);
      set(join(common, "config"), planted(w).filter(([key]) => key !== "core.hooksPath"));
    }
  },
};

/** The files of a diff, without the file of settings one place plants in the working tree. */
const shownFiles = (files: readonly { status: string; path: string; untracked: boolean }[]) => files.filter((file) => !file.path.startsWith("tools/")).map((file) => `${file.status} ${file.path}${file.untracked ? " (untracked)" : ""}`);
const marksOf = (w: { marks: string }) => readdirSync(w.marks).sort();
const noMarks = (w: { marks: string }, when: string) => assert.deepEqual(marksOf(w), [], `a planted program ran ${when}`);

for (const [place, plant] of Object.entries(PLACES)) {
  test(`the brief's diff starts nothing planted in ${place}`, async () => {
    const w = world();
    plant(w);
    const found = await collectDiff(git, w.wt, ["main"], readTextFile);
    noMarks(w, "while the diff was collected");
    assert.ok(found.ok, found.ok ? "" : found.why);
    assert.deepEqual(shownFiles(found.diff.files), ["added .gitattributes", "modified a.txt", "modified b.txt", "modified c.bin", "added new.txt (untracked)"]);
    // Every tracked file here passes through a filter by its attributes: by name only, never a diff that compares the wrong things.
    assert.deepEqual(found.diff.namesOnly.map((entry) => `${entry.path}: ${entry.why}`), [".gitattributes: git filter", "a.txt: git filter", "b.txt: git filter", "c.bin: git filter"]);
    assert.match(found.diff.text, /\+untracked/);

    const clone = await collectCloneDiff(git, w.solo, [{ as: null, head: w.base }], [], readTextFile);
    noMarks(w, "while a clone's diff was collected");
    assert.ok(clone.ok, clone.ok ? "" : clone.why);
    assert.deepEqual(shownFiles(clone.diff.files), ["added .gitattributes", "modified a.txt", "modified b.txt", "modified c.bin", "added new.txt (untracked)"]);
  });

  test(`merge-readiness starts nothing planted in ${place}`, async () => {
    const w = world();
    plant(w);
    resetVersionCheck();
    const facts = await workOut({ path: w.wt, baseBranch: null, defaultBranch: "main", sourcePath: null }, null, defaultDeps(), new AbortController().signal);
    noMarks(w, "while merge-readiness was worked out");
    assert.equal(facts.state, "conflict", facts.why ?? "");
    assert.deepEqual(facts.conflicts, ["a.txt"]);
    assert.deepEqual([facts.ahead, facts.behind, facts.dirty], [1, 1, true]);
    // Again with the answer known: only whether there are uncommitted changes is read.
    const again = await workOut({ path: w.wt, baseBranch: null, defaultBranch: "main", sourcePath: null }, facts, defaultDeps(), new AbortController().signal);
    noMarks(w, "while uncommitted changes were looked for");
    assert.equal(again.dirty, true);
  });

  test(`a clone's unsaved work and a source's state start nothing planted in ${place}`, async () => {
    const w = world();
    plant(w);
    const extra = existsSync(join(w.solo, "tools")) ? 1 : 0;
    const unsaved = await unsavedWork(w.solo, w.dir);
    noMarks(w, "while unsaved work was looked for");
    assert.deepEqual(unsaved, { repo: true, uncommitted: 3 + extra, branches: ["main", "work"], error: null });
    assert.deepEqual(await cleanState(w.solo), { clean: false, why: `${3 + extra} uncommitted or untracked change(s)` });
    noMarks(w, "while a source's state was read");
    mkdirSync(join(w.dir, "clones"), { recursive: true });
    const checked = await preflight({ source: w.solo, bring: [], readOnly: [], exclude: [] } as never, join(w.dir, "clones"));
    noMarks(w, "while a source was looked at before cloning");
    assert.equal(checked.facts[0]!.dirty, true);
  });

  test(`making a clone and putting it on the thread's branch starts nothing planted in ${place}`, { skip: !mac }, async () => {
    const w = world();
    plant(w);
    const paths = layout(join(w.dir, "data"));
    const made = await createClone({ paths, pathKey: "key", branch: "cow/thread", inputs: { source: w.solo }, helper: helper! });
    noMarks(w, "while the clone was made");
    assert.equal(run(made.path, "-c", "core.hooksPath=/dev/null", "symbolic-ref", "--short", "HEAD"), "cow/thread");
    assert.equal(run(made.path, "-c", "core.hooksPath=/dev/null", "rev-parse", "cow/thread"), run(w.solo, "-c", "core.hooksPath=/dev/null", "rev-parse", "work"));
    // Uncommitted changes came along, untouched.
    assert.equal(readFileSync(join(made.path, "b.txt"), "utf8"), "bee\nnot committed\n");
    assert.equal(existsSync(join(made.path, "new.txt")), true);
  });
}

test("a nested repository or a submodule: nothing its own configuration names is started", async () => {
  const w = world();
  for (const path of [w.wt, w.solo]) {
    // A repository inside, recorded as a submodule, with every setting planted in its own configuration and changes of its own.
    const sub = join(path, "sub");
    mkdirSync(sub);
    run(sub, "init", "-q", "-b", "main");
    write(sub, "inside.txt", "in\n");
    write(sub, ".gitattributes", ATTRIBUTES);
    run(sub, "add", "-A");
    run(sub, "commit", "-q", "-m", "inside");
    write(path, ".gitmodules", '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    run(path, "-c", "advice.addEmbeddedRepo=false", "add", "sub", ".gitmodules");
    run(path, "commit", "-q", "-m", "a submodule");
    write(sub, "inside.txt", "in\nchanged inside\n");
    set(join(sub, ".git", "config"), planted(w));
    // And one that is not recorded at all.
    const loose = join(path, "loose");
    mkdirSync(loose);
    run(loose, "init", "-q", "-b", "main");
    write(loose, "l.txt", "l\n");
    run(loose, "add", "-A");
    run(loose, "commit", "-q", "-m", "loose");
    write(loose, "l.txt", "l\nmore\n");
    set(join(loose, ".git", "config"), planted(w));
  }
  const found = await collectDiff(git, w.wt, ["main"], readTextFile);
  noMarks(w, "while the diff was collected");
  assert.ok(found.ok, found.ok ? "" : found.why);
  assert.ok(found.diff.files.some((file) => file.path === "sub" && file.status === "added"));

  resetVersionCheck();
  const facts = await workOut({ path: w.wt, baseBranch: null, defaultBranch: "main", sourcePath: null }, null, defaultDeps(), new AbortController().signal);
  noMarks(w, "while merge-readiness was worked out");
  assert.equal(facts.state, "conflict");

  // The submodule's uncommitted change counts as one more, as `git status` counts it; so does the folder git knows nothing of.
  const unsaved = await unsavedWork(w.solo, w.dir);
  noMarks(w, "while unsaved work was looked for");
  assert.equal(unsaved.error, null);
  assert.equal(unsaved.uncommitted, 5);
  assert.deepEqual(await cleanState(w.solo), { clean: false, why: "5 uncommitted or untracked change(s)" });
  noMarks(w, "while a source's state was read");

  // With everything else committed, the submodule's own change is still seen, and shown by name.
  run(w.solo, "-c", "core.hooksPath=/dev/null", "add", "-A", "--", "b.txt", "c.bin", "new.txt");
  run(w.solo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "the rest");
  rmSync(join(w.solo, "loose"), { recursive: true });
  assert.equal((await unsavedWork(w.solo, w.dir)).uncommitted, 1);
  const head = run(w.solo, "rev-parse", "HEAD");
  const inside = await collectCloneDiff(git, w.solo, [{ as: null, head }], [], readTextFile);
  noMarks(w, "while a clone's diff was collected");
  assert.ok(inside.ok);
  assert.deepEqual(inside.diff.files.map((file) => `${file.status} ${file.path}`), ["modified sub"]);
  assert.deepEqual(inside.diff.namesOnly, [{ path: "sub", why: "submodule" }]);
});

test("a missing object is not fetched: no program a remote's configuration names is started", async () => {
  const dir = join(root, `w${++count}`);
  const marks = join(dir, "marks");
  mkdirSync(marks, { recursive: true });
  const w = { dir, marks };
  const make = (name: string) => {
    const path = join(dir, name);
    mkdirSync(path, { recursive: true });
    run(path, "init", "-q", "-b", "main");
    write(path, "a.txt", `${name}\n`);
    run(path, "add", "-A");
    run(path, "commit", "-q", "-m", name);
    return path;
  };
  const source = make("source");
  const clone = make("clone");
  const elsewhere = make("elsewhere");
  // Both say a missing object is to be fetched from a remote whose programs are planted.
  for (const repo of [source, clone]) {
    set(join(repo, ".git", "config"), [
      ["core.repositoryformatversion", "1"],
      ["extensions.partialClone", "origin"],
      ["remote.origin.url", elsewhere],
      ["remote.origin.promisor", "true"],
      ["remote.origin.uploadpack", program(w, "upload-pack")],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
      ["remote.origin.vcs", ""],
      ["core.sshCommand", program(w, "ssh")],
    ]);
    run(repo, "config", "--unset", "remote.origin.vcs");
  }
  // The source lacks the clone's commit: `cat-file -e` in it meets a missing object.
  const unsaved = await unsavedWork(clone, source);
  noMarks(w, "while unsaved work was looked for");
  assert.deepEqual(unsaved, { repo: true, uncommitted: 0, branches: ["main"], error: null });
  // A base that is not there at all, in the diff and in a clone's diff.
  const gone = "1234567890123456789012345678901234567890";
  const found = await collectCloneDiff(git, clone, [{ as: null, head: gone }], [gone], readTextFile);
  noMarks(w, "while a clone's diff was collected");
  assert.ok(found.ok);
});

test("a file that passes through a git filter: left out when it did not change, by name only when it did, and never a wrong diff", async () => {
  const dir = join(root, `w${++count}`);
  const marks = join(dir, "marks");
  mkdirSync(marks, { recursive: true });
  const w = { dir, marks };
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", "main");
  // What a filter would have stored: a short pointer. No filter is set up yet, so git stores the files as they are.
  write(repo, ".gitattributes", "*.big filter=big\n");
  write(repo, "same.big", "pointer 0001\n");
  write(repo, "edited.big", "pointer 0002\n");
  write(repo, "plain.txt", "plain\n");
  // Written a while ago, as a checkout's files are: git trusts the size and time it records only for a file older than its index.
  const then = new Date(Date.now() - 60_000);
  for (const name of ["same.big", "edited.big", "plain.txt"]) utimesSync(join(repo, name), then, then);
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "base");
  // What the filter would have put on disk: the real content. `same.big` keeps the size and time the index recorded,
  // as a file does in a copy of a checkout; its bytes are not what is stored, and only the filter could say they match.
  const recorded = statSync(join(repo, "same.big"));
  writeFileSync(join(repo, "same.big"), "REAL CONTENT\n");
  utimesSync(join(repo, "same.big"), recorded.atime, recorded.mtime);
  writeFileSync(join(repo, "edited.big"), "REAL CONTENT, and then it was edited\n");
  writeFileSync(join(repo, "plain.txt"), "plain\nand more\n");
  // The filter is real for the person, and planted as far as cow goes: it must not start.
  set(join(repo, ".git", "config"), [
    ["filter.big.clean", program(w, "big-clean", true)],
    ["filter.big.smudge", program(w, "big-smudge", true)],
    ["filter.big.required", "true"],
  ]);

  const found = await collectDiff(git, repo, ["main"], readTextFile);
  noMarks(w, "while the diff was collected");
  assert.ok(found.ok, found.ok ? "" : found.why);
  assert.deepEqual(found.diff.files.map((file) => `${file.status} ${file.path}`), ["modified edited.big", "modified plain.txt"]);
  assert.deepEqual(found.diff.namesOnly, [{ path: "edited.big", why: "git filter" }]);
  assert.match(found.diff.text, /\+and more/);
  assert.doesNotMatch(found.diff.text, /REAL CONTENT|pointer 000/);

  const unsaved = await unsavedWork(repo, repo);
  noMarks(w, "while unsaved work was looked for");
  assert.equal(unsaved.uncommitted, 2);

  // With only the unchanged filtered file differing on disk, the checkout is clean.
  run(repo, "-c", "core.hooksPath=/dev/null", "-c", "filter.big.clean=", "-c", "filter.big.smudge=", "-c", "filter.big.required=false", "checkout", "-q", "--", "edited.big", "plain.txt");
  noMarks(w, "while the test put two files back");
  assert.deepEqual(await cleanState(repo), { clean: true, why: null });
  assert.equal((await unsavedWork(repo, repo)).uncommitted, 0);
  const none = await collectDiff(git, repo, ["main"], readTextFile);
  assert.ok(none.ok);
  assert.deepEqual(none.diff.files, []);
  noMarks(w, "at the end");
});

test("an ordinary repository: what cow counts as uncommitted is what git status lists", async () => {
  const dir = join(root, `w${++count}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", "main");
  for (const name of ["kept.txt", "edited.txt", "staged.txt", "both.txt", "gone.txt", "moved.txt", "removed.txt"]) write(repo, name, `${name}\nline two of a file long enough to be found again when it moves\n`);
  write(repo, ".gitignore", "*.log\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "base");
  write(repo, "edited.txt", "edited\n");
  write(repo, "staged.txt", "staged\n");
  write(repo, "both.txt", "staged\n");
  run(repo, "add", "staged.txt", "both.txt");
  write(repo, "both.txt", "and edited again\n");
  rmSync(join(repo, "gone.txt"));
  run(repo, "mv", "moved.txt", "moved-to.txt");
  run(repo, "rm", "-q", "removed.txt");
  write(repo, "added-then-deleted.txt", "x\n");
  run(repo, "add", "added-then-deleted.txt");
  rmSync(join(repo, "added-then-deleted.txt"));
  write(repo, "fresh.txt", "new\n");
  write(repo, "folder/one.txt", "1\n");
  write(repo, "folder/two.txt", "2\n");
  write(repo, "noise.log", "ignored by .gitignore\n");
  write(repo, "private.tmp", "ignored by the repository's own ignore file\n");
  write(repo, ".git/info/exclude", "*.tmp\n");
  const lines = run(repo, "-c", "core.hooksPath=/dev/null", "status", "--porcelain", "--untracked-files=normal").split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 9, lines.join("\n"));
  assert.deepEqual(await cleanState(repo), { clean: false, why: "9 uncommitted or untracked change(s)" });
  assert.equal((await unsavedWork(repo, repo)).uncommitted, 9);
  const found = await collectDiff(git, repo, ["main"], readTextFile);
  assert.ok(found.ok);
  assert.deepEqual(found.diff.namesOnly, []);
  assert.deepEqual(
    found.diff.files.map((file) => file.path),
    ["both.txt", "edited.txt", "folder/one.txt", "folder/two.txt", "fresh.txt", "gone.txt", "moved-to.txt", "removed.txt", "staged.txt"],
  );
});

test("a repository whose objects are named by SHA-256 is read all the same", async () => {
  const dir = join(root, `w${++count}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", "main", "--object-format=sha256");
  write(repo, "a.txt", "one\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-q", "-m", "base");
  write(repo, "a.txt", "one\ntwo\n");
  assert.deepEqual(await cleanState(repo), { clean: false, why: "1 uncommitted or untracked change(s)" });
  const found = await collectDiff(git, repo, ["main"], readTextFile);
  assert.ok(found.ok, found.ok ? "" : found.why);
  assert.match(found.diff.text, /\+two/);
});

test("cow's empty git folder: made when missing, made again when it is not exactly what it should be, never a link, and nothing runs without it", async () => {
  const data = realpathSync(mkdtempSync(join(root, "host-data-")));
  const repo = join(root, `w${++count}`);
  mkdirSync(repo, { recursive: true });
  run(repo, "init", "-q", "-b", "main");
  write(repo, "a.txt", "one\n");
  try {
    useHostData(data);
    for (const format of ["sha1", "sha256"] as const) {
      const dir = join(data, NO_REPOSITORY[format].folder);
      const exact = () => {
        assert.equal(noRepository(format), dir);
        assert.ok(lstatSync(dir).isDirectory());
        assert.deepEqual(readdirSync(dir).sort(), ["HEAD", "config", "refs"]);
        assert.deepEqual(readdirSync(join(dir, "refs")), []);
        for (const [name, text] of Object.entries(NO_REPOSITORY[format].files)) assert.equal(readFileSync(join(dir, name), "utf8"), text);
        // Nothing is left beside it from the making.
        assert.deepEqual(readdirSync(data).filter((name) => name.includes(".new.") || name.includes(".old.")), []);
      };
      // Missing: made.
      assert.equal(existsSync(dir), false);
      exact();
      // Each way it can differ is seen at the next use, and it is made again.
      const marker = join(data, "ran");
      const spoil: Record<string, () => void> = {
        "a configuration that names a program": () => writeFileSync(join(dir, "config"), `${NO_REPOSITORY[format].files.config}[core]\n\tfsmonitor = touch '${marker}'\n`),
        "another HEAD": () => writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n"),
        "an extra file": () => writeFileSync(join(dir, "config.worktree"), "[core]\n"),
        "a hooks folder": () => mkdirSync(join(dir, "hooks")),
        "a ref": () => writeFileSync(join(dir, "refs", "x"), "0\n"),
        "a missing file": () => rmSync(join(dir, "HEAD")),
        "a config that is a link": () => {
          const real = join(data, "elsewhere-config");
          writeFileSync(real, NO_REPOSITORY[format].files.config);
          rmSync(join(dir, "config"));
          symlinkSync(real, join(dir, "config"));
        },
        "refs that is a link": () => {
          mkdirSync(join(data, "elsewhere-refs"), { recursive: true });
          rmSync(join(dir, "refs"), { recursive: true });
          symlinkSync(join(data, "elsewhere-refs"), join(dir, "refs"));
        },
        "a link in its place, to a folder with the right contents": () => {
          const real = join(data, "elsewhere");
          rmSync(real, { recursive: true, force: true });
          mkdirSync(join(real, "refs"), { recursive: true });
          for (const [name, text] of Object.entries(NO_REPOSITORY[format].files)) writeFileSync(join(real, name), text);
          rmSync(dir, { recursive: true });
          symlinkSync(real, dir);
        },
        "a file in its place": () => {
          rmSync(dir, { recursive: true });
          writeFileSync(dir, "not a folder\n");
        },
      };
      for (const [what, change] of Object.entries(spoil)) {
        change();
        assert.equal(isNoRepository(dir, format), false, what);
        exact();
        assert.equal(detachedEnv(format)!.GIT_DIR, dir, what);
      }
      // What a link pointed at was left alone: the link was removed, not followed.
      assert.equal(existsSync(join(data, "elsewhere", "HEAD")), true);
      assert.equal(existsSync(marker), false);
    }
    // cow's own function, with the folder spoiled just before: it is made again first, and the answer is right.
    writeFileSync(join(data, "no-repository", "config"), "[core]\n\tfsmonitor = false\n[filter \"x\"]\n\tclean = false\n");
    assert.deepEqual(await cleanState(repo), { clean: false, why: "1 uncommitted or untracked change(s)" });
    assert.equal(isNoRepository(join(data, "no-repository"), "sha1"), true);

    // Where it cannot be made, nothing detached runs, and cow says so.
    const blocked = join(root, "host-data-read-only");
    mkdirSync(blocked);
    useHostData(blocked);
    chmodSync(blocked, 0o500);
    assert.equal(noRepository("sha1"), null);
    assert.equal(detachedEnv("sha1"), null);
    const state = await cleanState(repo);
    assert.equal(state.clean, false);
    assert.match(state.why ?? "", /empty git folder could not be made/);
    const found = await collectDiff(git, repo, [], readTextFile);
    assert.ok(!found.ok && /empty git folder could not be made/.test(found.why));
  } finally {
    useHostData(hostData);
  }
});
