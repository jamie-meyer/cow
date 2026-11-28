import assert from "node:assert/strict";
import "./host-data.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkerPrompt } from "../src/briefs/checker.ts";
import { collectBriefDiff } from "../src/briefs/clone-diff.ts";
import { DIFF_LIMITS, type DiffCollected, collectCloneDiff, collectDiff, fairShares, readTextFile } from "../src/briefs/diff.ts";
import { gateChanges } from "../src/briefs/paths.ts";
import { shownLines } from "../src/briefs/review.ts";
import { git } from "../src/clone/git.ts";
import { layout } from "../src/clone/remove.ts";

const run = async (dir: string, ...args: string[]) => {
  const out = await git(dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

/** A repository with one commit holding `files`; its HEAD. */
async function repoAt(dir: string, files: Record<string, string>): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await run(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await run(dir, "add", "-A");
  await run(dir, "commit", "-q", "--allow-empty", "-m", "base");
  return run(dir, "rev-parse", "HEAD");
}

const BRIEF = { summary: "s", claims: [{ id: "c1", text: "app/file.txt was added", label: "checked" as const, evidence: [] }], judgementCalls: [], notDone: [] };
const prompt = (diff: DiffCollected) => checkerPrompt(BRIEF, "NN", { task: { state: "none", why: "none" }, diff: { state: "collected", ...diff } });

/**
 * A clone as cow lays one out: `<data>/clones/<key>/<name>`, with its record
 * in `<data>/done/<key>.json` naming the repositories it brought and their
 * HEADs when it was made.
 */
async function clone(bring: string[], folderIsRepo = true) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), "cow-clone-diff-")));
  const paths = layout(data);
  const ws = join(paths.clones, "key1", "ws");
  mkdirSync(ws, { recursive: true });
  const file = `${JSON.stringify({ bring: bring.map((as) => ({ path: as, as })) })}\n`;
  let head: string | null = null;
  if (folderIsRepo) head = await repoAt(ws, { ".gitignore": bring.map((as) => `/${as}/\n`).join(""), "notes.md": "notes\n", "cow.workspace.json": file });
  else writeFileSync(join(ws, "cow.workspace.json"), file);
  const heads: Record<string, string> = {};
  for (const as of bring) heads[as] = await repoAt(join(ws, as), { "src/main.ts": "export const a = 1;\n", "test/main.test.ts": "test one\n", "NAME": `${as}\n` });
  const record = {
    path: ws,
    resource: {
      branch: "cow/t",
      source: { path: "/src/ws", as: null, head, dirty: false, branched: folderIsRepo },
      bring: bring.map((as) => ({ path: `/src/${as}`, as, head: heads[as], dirty: false, branched: true })),
      workspace: null,
    },
  };
  writeFileSync(join(paths.done, "key1.json"), `${JSON.stringify(record)}\n`);
  return { data, ws, heads, head, done: () => rmSync(data, { recursive: true, force: true }) };
}

test("the person's example: a change committed in a brought repository is listed under its folder, with its diff and its base", async () => {
  const c = await clone(["app"]);
  try {
    writeFileSync(join(c.ws, "app", "file.txt"), "change\n");
    await run(join(c.ws, "app"), "add", "file.txt");
    await run(join(c.ws, "app"), "commit", "-q", "-m", "a change");
    // What the checker was shown before: the folder alone, with nothing changed.
    const before = await collectDiff(git, c.ws, ["main"], readTextFile);
    assert.ok(before.ok && before.diff.files.length === 0);

    const found = await collectBriefDiff(c.data, c.ws, ["main"]);
    assert.ok(found.ok, found.ok ? "" : found.why);
    const { diff } = found;
    assert.deepEqual(diff.files, [{ path: "app/file.txt", status: "added", from: null, untracked: false }]);
    assert.match(diff.text, /^diff --git a\/app\/file\.txt b\/app\/file\.txt\n[\s\S]*\+\+\+ b\/app\/file\.txt\n@@ -0,0 \+1 @@\n\+change\n$/);
    assert.deepEqual(diff.repos, [
      { as: null, base: c.head, baseText: "the commit it was on when cow made the clone", filesTotal: 0, why: null },
      { as: "app", base: c.heads.app, baseText: "the commit it was on when cow made the clone", filesTotal: 1, why: null },
    ]);
    const text = prompt(diff);
    assert.ok(text.includes(`- the workspace folder: against ${c.head!.slice(0, 12)}, the commit it was on when cow made the clone; 0 files changed`));
    assert.ok(text.includes(`- "app" (its files under app/): against ${c.heads.app!.slice(0, 12)}, the commit it was on when cow made the clone; 1 file changed`));
    assert.match(text, /----- BEGIN FILES NN -----\nadded {5}app\/file\.txt\n----- END FILES NN -----/);
    assert.match(text, /cut to 60000 characters in all, shared fairly between the repositories, and 12000 per file/);
    assert.match(text, /----- BEGIN DIFF NN -----\ndiff --git a\/app\/file\.txt/);
  } finally {
    c.done();
  }
});

test("two brought repositories changed: both under their folders, each with its own base; uncommitted and untracked files count", async () => {
  const c = await clone(["app", "lib"]);
  try {
    writeFileSync(join(c.ws, "app", "src", "main.ts"), "export const a = 2;\n");
    writeFileSync(join(c.ws, "lib", "new.ts"), "export const n = 1;\n");
    writeFileSync(join(c.ws, "notes.md"), "notes, more\n");
    const found = await collectBriefDiff(c.data, c.ws, []);
    assert.ok(found.ok, found.ok ? "" : found.why);
    assert.deepEqual(
      found.diff.files.map((file) => [file.path, file.status, file.untracked]),
      [
        ["app/src/main.ts", "modified", false],
        ["lib/new.ts", "added", true],
        ["notes.md", "modified", false],
      ],
    );
    assert.deepEqual(found.diff.repos?.map((repo) => [repo.as, repo.base, repo.filesTotal]), [
      [null, c.head, 1],
      ["app", c.heads.app, 1],
      ["lib", c.heads.lib, 1],
    ]);
    assert.notEqual(c.heads.app, c.heads.lib);
    assert.match(found.diff.text, /--- a\/app\/src\/main\.ts\n\+\+\+ b\/app\/src\/main\.ts/);
    assert.match(found.diff.text, /\+\+\+ b\/lib\/new\.ts\n@@ -0,0 \+1,1 @@\n\+export const n = 1;/);
    const lines = shownLines({ task: { state: "none", why: "x" }, diff: { state: "collected", ...found.diff }, flagged: [], at: 0 });
    assert.ok(lines.includes(`    "lib" (its files under lib/): against ${c.heads.lib!.slice(0, 12)}, the commit it was on when cow made the clone; 1 file changed`), lines.join("\n"));
    assert.match(lines[1] ?? "", /^ {2}diff: 3 repositories of a copy-on-write workspace, each against its own base; 3 changed files/);
  } finally {
    c.done();
  }
});

test("changing an existing test inside a brought repository is flagged, with its folder in the path", async () => {
  const c = await clone(["app"]);
  try {
    writeFileSync(join(c.ws, "app", "test", "main.test.ts"), "test one, weakened\n");
    const found = await collectBriefDiff(c.data, c.ws, []);
    assert.ok(found.ok);
    assert.deepEqual(gateChanges(found.diff.files), ["app/test/main.test.ts"]);
  } finally {
    c.done();
  }
});

test("a brought repository that cannot be read is named as not read, and the others are still shown", async () => {
  const c = await clone(["app", "gone", "plain"]);
  try {
    rmSync(join(c.ws, "gone"), { recursive: true, force: true });
    rmSync(join(c.ws, "plain", ".git"), { recursive: true, force: true });
    writeFileSync(join(c.ws, "app", "file.txt"), "change\n");
    const found = await collectBriefDiff(c.data, c.ws, []);
    assert.ok(found.ok, found.ok ? "" : found.why);
    assert.deepEqual(found.diff.files.map((file) => file.path), ["app/file.txt"]);
    assert.deepEqual(found.diff.repos?.map((repo) => [repo.as, repo.why]), [
      [null, null],
      ["app", null],
      ["gone", "it is no longer in the clone"],
      ["plain", "it is not a git repository"],
    ]);
    const text = prompt(found.diff);
    assert.ok(text.includes('- "gone" (its files under gone/): not read: it is no longer in the clone'));
    assert.ok(text.includes('- "plain" (its files under plain/): not read: it is not a git repository'));
  } finally {
    c.done();
  }
});

test("the repositories come from cow's record of the clone: dropping one from the workspace file in the clone does not hide its changes", async () => {
  const c = await clone(["app", "lib"]);
  try {
    writeFileSync(join(c.ws, "cow.workspace.json"), `${JSON.stringify({ bring: [{ path: "app", as: "app" }] })}\n`);
    writeFileSync(join(c.ws, "lib", "hidden.ts"), "export const h = 1;\n");
    const found = await collectBriefDiff(c.data, c.ws, []);
    assert.ok(found.ok);
    assert.ok(found.diff.files.some((file) => file.path === "lib/hidden.ts"));
    assert.ok(found.diff.files.some((file) => file.path === "cow.workspace.json" && file.status === "modified"));
    assert.deepEqual(found.diff.repos?.map((repo) => repo.as), [null, "app", "lib"]);
  } finally {
    c.done();
  }
});

test("a workspace folder that is not a git checkout still gets the changes of the repositories it brought", async () => {
  const c = await clone(["app"], false);
  try {
    writeFileSync(join(c.ws, "app", "file.txt"), "change\n");
    const found = await collectBriefDiff(c.data, c.ws, []);
    assert.ok(found.ok, found.ok ? "" : found.why);
    assert.deepEqual(found.diff.files.map((file) => file.path), ["app/file.txt"]);
    assert.deepEqual(found.diff.repos?.[0], { as: null, base: null, baseText: null, filesTotal: 0, why: "the workspace folder is not a git checkout" });
    // With nothing readable at all, it says why for each.
    rmSync(join(c.ws, "app", ".git"), { recursive: true, force: true });
    const none = await collectBriefDiff(c.data, c.ws, []);
    assert.deepEqual(none, { ok: false, why: "none of the clone's repositories could be read (the workspace folder: the workspace folder is not a git checkout; app: it is not a git repository)" });
  } finally {
    c.done();
  }
});

test("a checkout that is not one of cow's clones is collected as it always was", async () => {
  const c = await clone(["app"]);
  const other = realpathSync(mkdtempSync(join(tmpdir(), "cow-plain-diff-")));
  try {
    await repoAt(other, { "a.txt": "a\n" });
    writeFileSync(join(other, "a.txt"), "b\n");
    const found = await collectBriefDiff(c.data, other, ["main"]);
    assert.deepEqual(found, await collectDiff(git, other, ["main"], readTextFile));
    assert.ok(found.ok && found.diff.repos === undefined);
  } finally {
    c.done();
    rmSync(other, { recursive: true, force: true });
  }
});

test("the budget is shared between repositories: a large diff in one does not leave out another's small change", async () => {
  assert.deepEqual(fairShares(100, [500, 10]), [90, 10]);
  assert.deepEqual(fairShares(100, [500, 500]), [50, 50]);
  assert.deepEqual(fairShares(100, [20, 30, 500]), [20, 30, 50]);
  assert.deepEqual(fairShares(10, [0, 5]), [0, 5]);
  assert.deepEqual(fairShares(2, [5, 5, 5]), [1, 1, 0]);

  const c = await clone(["big", "small"]);
  try {
    const line = "y".repeat(99);
    // Many files in the first, so that clipping all of them to the smallest share would still not fit.
    for (let n = 0; n < 80; n += 1) writeFileSync(join(c.ws, "big", `f${String(n).padStart(2, "0")}.txt`), `${Array.from({ length: 200 }, () => line).join("\n")}\n`);
    writeFileSync(join(c.ws, "small", "zz.txt"), "the small change\n");
    const limits = { ...DIFF_LIMITS, files: 50 };
    const found = await collectCloneDiff(git, c.ws, [{ as: null, head: c.head }, { as: "big", head: c.heads.big! }, { as: "small", head: c.heads.small! }], [], readTextFile, limits);
    assert.ok(found.ok);
    const { diff } = found;
    assert.equal(diff.filesTotal, 81);
    assert.equal(diff.files.length, 50);
    assert.ok(diff.files.some((file) => file.path === "small/zz.txt"), "the small repository's file is listed");
    assert.match(diff.text, /\+the small change/);
    assert.ok(!diff.omitted.includes("small/zz.txt"));
    assert.ok(diff.omitted.length > 0 && diff.omitted.every((path) => path.startsWith("big/")));
    assert.ok(diff.text.length <= DIFF_LIMITS.total + 50 * 100, String(diff.text.length));
  } finally {
    c.done();
  }
});
