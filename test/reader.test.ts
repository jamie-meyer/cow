import assert from "node:assert/strict";
import { test } from "node:test";
import { fileKind, formatSize, textLines, toPatch } from "../src/reader/kind.ts";
import { type Roots, absoluteIn, copyText, normalise, parseDocLink, parseFileHref, parseTimelineRow, placeFile, splitLines, tabFile } from "../src/reader/link.ts";
import { ReaderKeys, blockTarget, moveCursor, scrollToShow } from "../src/reader/move.ts";
import { findMatches, firstMatch, stepMatch } from "../src/reader/search.ts";

const ROOTS: Roots = {
  hostId: "host_1",
  workspace: { environmentId: "env_1", rootPath: "/work/repo" },
  storage: { threadId: "thr_a", rootPath: "/store/thr_a/" },
};

test("lines are split off a path in every form bb writes them", () => {
  assert.deepEqual(splitLines("/a/b.ts#L12"), { path: "/a/b.ts", lines: { start: 12, end: 12 } });
  assert.deepEqual(splitLines("/a/b.ts#L12-L20"), { path: "/a/b.ts", lines: { start: 12, end: 20 } });
  assert.deepEqual(splitLines("/a/b.ts#L12C3-L20C1"), { path: "/a/b.ts", lines: { start: 12, end: 20 } });
  assert.deepEqual(splitLines("/a/b.ts#L20-12"), { path: "/a/b.ts", lines: { start: 12, end: 20 } });
  assert.deepEqual(splitLines("/a/b.ts:62"), { path: "/a/b.ts", lines: { start: 62, end: 62 } });
  assert.deepEqual(splitLines("/a/b.ts:62:7"), { path: "/a/b.ts", lines: { start: 62, end: 62 } });
  assert.deepEqual(splitLines("/a/b.ts:3-9"), { path: "/a/b.ts", lines: { start: 3, end: 9 } });
  assert.deepEqual(splitLines("/a/b.ts"), { path: "/a/b.ts", lines: null });
  // A zero is not a line; the path keeps it.
  assert.deepEqual(splitLines("/a/b.ts:0"), { path: "/a/b.ts:0", lines: null });
});

test("a file link in a chat is a file:// href; anything else is not a file", () => {
  assert.deepEqual(parseFileHref("file:///work/repo/src/keys.ts#L62"), { path: "/work/repo/src/keys.ts", lines: { start: 62, end: 62 } });
  assert.deepEqual(parseFileHref("file:///work/repo/READ%20ME.md#L40-L44"), { path: "/work/repo/READ ME.md", lines: { start: 40, end: 44 } });
  assert.deepEqual(parseFileHref("file:///work/repo/a/../b.txt"), { path: "/work/repo/b.txt", lines: null });
  assert.equal(parseFileHref("https://example.com/a.txt"), null);
  assert.equal(parseFileHref("/projects/p/threads/t"), null);
  assert.equal(parseFileHref("file://host/a.txt"), null);
  assert.equal(parseFileHref("file:///../../etc"), null);
  assert.equal(parseFileHref("file:///"), null);
});

test("a link inside a file is read against the folder of that file", () => {
  const doc = "/work/repo/docs/guide.md";
  assert.deepEqual(parseDocLink("other.md", doc), { path: "/work/repo/docs/other.md", lines: null });
  assert.deepEqual(parseDocLink("../src/keys.ts:62", doc), { path: "/work/repo/src/keys.ts", lines: { start: 62, end: 62 } });
  assert.deepEqual(parseDocLink("/abs/file.txt#L3", doc), { path: "/abs/file.txt", lines: { start: 3, end: 3 } });
  assert.deepEqual(parseDocLink("file:///abs/file.txt", doc), { path: "/abs/file.txt", lines: null });
  for (const not of ["https://getbb.app", "mailto:a@b.c", "#heading", "", "~/notes.md", "//host/share", "docs/", "../../../../up"]) {
    assert.equal(parseDocLink(not, doc), null, not);
  }
});

test("a timeline row's id says when it is a file change, and of which file", () => {
  const id = "thr_a:file-edit:da54-i76:/work/repo/.cow-e2e/sample.txt:file-change:0";
  assert.deepEqual(parseTimelineRow(id), { threadId: "thr_a", callId: "da54-i76", path: "/work/repo/.cow-e2e/sample.txt", rowId: id });
  assert.equal(parseTimelineRow("thr_a:command:da54-i75"), null);
  assert.equal(parseTimelineRow("thr_a:assistant:kind:assistant|turn:t4|item:i77"), null);
  assert.equal(parseTimelineRow("thr_a:file-edit:i1:relative/path.txt:file-change:0"), null);
  assert.equal(parseTimelineRow(""), null);
});

test("a path is placed in the workspace first, then the thread's storage, then on its machine", () => {
  const inWork = placeFile("/work/repo/src/a.ts", ROOTS, "thr_a");
  assert.deepEqual([inWork.root, inWork.relPath, inWork.rootPath, inWork.environmentId], ["workspace", "src/a.ts", "/work/repo", "env_1"]);
  const inStore = placeFile("/store/thr_a/proof.txt", ROOTS, "thr_b");
  assert.deepEqual([inStore.root, inStore.relPath, inStore.rootPath, inStore.threadId], ["storage", "proof.txt", "/store/thr_a", "thr_a"]);
  const elsewhere = placeFile("/etc/hosts", ROOTS, "thr_a");
  assert.deepEqual([elsewhere.root, elsewhere.relPath, elsewhere.rootPath, elsewhere.hostId], ["host", "/etc/hosts", null, "host_1"]);
  // A folder whose name only starts like the root is not inside it.
  assert.equal(placeFile("/work/repo2/a.ts", ROOTS, null).root, "host");
  assert.equal(placeFile("/work/repo/a.ts", { hostId: null, workspace: null, storage: null }, null).root, "host");
});

test("a path under a root is made absolute, and may not leave the root", () => {
  assert.equal(absoluteIn("storage", "proof.txt", ROOTS), "/store/thr_a/proof.txt");
  assert.equal(absoluteIn("workspace", "src/../README.md", ROOTS), "/work/repo/README.md");
  assert.equal(absoluteIn("workspace", "../other/secret", ROOTS), null);
  assert.equal(absoluteIn("workspace", "a.ts", { ...ROOTS, workspace: null }), null);
  assert.equal(normalise("/a//b/./c/../d"), "/a/b/d");
  assert.equal(normalise("relative"), null);
});

test("a file tab of bb's is read whether bb or a plugin's opener drew it", () => {
  assert.deepEqual(tabFile({ kind: "file", path: "src/a.ts" }), { path: "src/a.ts", source: null });
  assert.deepEqual(
    tabFile({ kind: "plugin", pluginId: "x", tab: { id: "file-opener:docs" }, params: { path: "README.md", source: { kind: "workspace", environmentId: "env_1", threadId: null } } }),
    { path: "README.md", source: { kind: "workspace", threadId: null, environmentId: "env_1" } },
  );
  assert.deepEqual(
    tabFile({ kind: "plugin", tab: { id: "file-opener:m" }, params: { path: "proof.txt", source: { kind: "thread-storage", threadId: "thr_a" } } })?.source,
    { kind: "storage", threadId: "thr_a", environmentId: null },
  );
  for (const not of [null, { kind: "info" }, { kind: "terminal", terminalId: "t" }, { kind: "plugin", tab: { id: "notes" }, params: { path: "a" } }, { kind: "file" }]) {
    assert.equal(tabFile(not), null);
  }
});

test("the path copied is under the workspace for a workspace file, absolute otherwise", () => {
  assert.equal(copyText({ root: "workspace", relPath: "src/a.ts", absPath: "/work/repo/src/a.ts" }, null), "src/a.ts");
  assert.equal(copyText({ root: "workspace", relPath: "src/a.ts", absPath: "/work/repo/src/a.ts" }, 62), "src/a.ts:62");
  assert.equal(copyText({ root: "storage", relPath: "proof.txt", absPath: "/store/thr_a/proof.txt" }, 3), "/store/thr_a/proof.txt:3");
});

test("search finds every match in order, ignoring case unless the query has a capital", () => {
  const lines = ["Hint mode", "no match here", "a hint and a Hint", ""];
  assert.deepEqual(findMatches(lines, "hint").matches, [
    { line: 0, start: 0, end: 4 },
    { line: 2, start: 2, end: 6 },
    { line: 2, start: 13, end: 17 },
  ]);
  assert.deepEqual(findMatches(lines, "Hint").matches.map((match) => [match.line, match.start]), [[0, 0], [2, 13]]);
  assert.deepEqual(findMatches(lines, ""), { matches: [], more: false });
  assert.deepEqual(findMatches(["aaaa"], "aa").matches.map((match) => match.start), [0, 2]);
  const capped = findMatches(["x x x x"], "x", 2);
  assert.equal(capped.matches.length, 2);
  assert.equal(capped.more, true);
});

test("n and N step through the matches from the cursor, and wrap round", () => {
  const { matches } = findMatches(["a", "x", "b", "x x", "c"], "x");
  assert.equal(firstMatch(matches, 2), 1);
  assert.equal(firstMatch(matches, 4), 0);
  assert.equal(firstMatch([], 0), null);
  assert.deepEqual(stepMatch(matches, 0, 1), { index: 0, wrapped: false });
  assert.deepEqual(stepMatch(matches, 1, 1, 0), { index: 1, wrapped: false });
  // Two matches on one line are stepped through one at a time.
  assert.deepEqual(stepMatch(matches, 3, 1, 1), { index: 2, wrapped: false });
  assert.deepEqual(stepMatch(matches, 3, 1, 2), { index: 0, wrapped: true });
  assert.deepEqual(stepMatch(matches, 1, -1, 0), { index: 2, wrapped: true });
  assert.deepEqual(stepMatch(matches, 4, -1), { index: 2, wrapped: false });
  assert.deepEqual(stepMatch(matches, 0, -1), { index: 2, wrapped: true });
  // The cursor moved off the match it was on: the step is from the line.
  assert.deepEqual(stepMatch(matches, 2, 1, 0), { index: 1, wrapped: false });
  assert.equal(stepMatch([], 0, 1), null);
});

test("keys: counts, gg and G, Ctrl for pages, and the reader's own verbs", () => {
  const keys = new ReaderKeys();
  const read = (key: string, ctrl = false, at = 0) => keys.read(key, ctrl, at);
  assert.deepEqual(read("j"), { kind: "motion", motion: { kind: "lines", by: 1 } });
  assert.deepEqual(read("5"), { kind: "pending" });
  assert.equal(keys.typed, "5");
  assert.deepEqual(read("k"), { kind: "motion", motion: { kind: "lines", by: -5 } });
  assert.equal(keys.typed, "");
  for (const digit of "120") read(digit);
  assert.deepEqual(read("G"), { kind: "motion", motion: { kind: "goto", line: 120 } });
  assert.deepEqual(read("G"), { kind: "motion", motion: { kind: "bottom" } });
  assert.deepEqual(read("g", false, 1000), { kind: "pending" });
  assert.deepEqual(read("g", false, 1200), { kind: "motion", motion: { kind: "top" } });
  // A second g that comes too late starts again.
  assert.deepEqual(read("g", false, 5000), { kind: "pending" });
  assert.deepEqual(read("g", false, 9000), { kind: "pending" });
  assert.deepEqual(read("j", false, 9001), { kind: "motion", motion: { kind: "lines", by: 1 } });
  read("7");
  read("g", false, 100);
  assert.deepEqual(read("g", false, 200), { kind: "motion", motion: { kind: "goto", line: 7 } });
  // 0 alone is not a count.
  assert.deepEqual(read("0"), { kind: "none" });
  assert.deepEqual(read("d", true), { kind: "motion", motion: { kind: "half", by: 1 } });
  assert.deepEqual(read("u", true), { kind: "motion", motion: { kind: "half", by: -1 } });
  assert.deepEqual(read("f", true), { kind: "motion", motion: { kind: "page", by: 1 } });
  assert.deepEqual(read("b", true), { kind: "motion", motion: { kind: "page", by: -1 } });
  assert.deepEqual(read("x", true), { kind: "none" });
  assert.deepEqual(read("/"), { kind: "search" });
  assert.deepEqual(read("n"), { kind: "match", by: 1 });
  assert.deepEqual(read("N"), { kind: "match", by: -1 });
  assert.deepEqual(read("f"), { kind: "hints" });
  assert.deepEqual(read("r"), { kind: "raw" });
  assert.deepEqual(read("u"), { kind: "split" });
  assert.deepEqual(read("y"), { kind: "copy", withLine: false });
  assert.deepEqual(read("Y"), { kind: "copy", withLine: true });
  assert.deepEqual(read("o"), { kind: "panel" });
  assert.deepEqual(read("q"), { kind: "close" });
  assert.deepEqual(read("Escape"), { kind: "close" });
  // Nothing of the page's is a reader key.
  for (const key of ["p", "e", "x", "a", "b", "i", "m", "P", "Tab"]) assert.deepEqual(read(key), { kind: "none" }, key);
});

test("the cursor moves by lines, half pages and pages, and stops at the ends", () => {
  assert.equal(moveCursor(10, { kind: "lines", by: 3 }, 100, 40), 13);
  assert.equal(moveCursor(1, { kind: "lines", by: -5 }, 100, 40), 0);
  assert.equal(moveCursor(98, { kind: "lines", by: 5 }, 100, 40), 99);
  assert.equal(moveCursor(10, { kind: "half", by: 1 }, 100, 40), 30);
  assert.equal(moveCursor(10, { kind: "half", by: -1 }, 100, 40), 0);
  assert.equal(moveCursor(10, { kind: "page", by: 1 }, 100, 40), 48);
  assert.equal(moveCursor(50, { kind: "page", by: -1 }, 100, 40), 12);
  assert.equal(moveCursor(50, { kind: "top" }, 100, 40), 0);
  assert.equal(moveCursor(50, { kind: "bottom" }, 100, 40), 99);
  assert.equal(moveCursor(50, { kind: "goto", line: 62 }, 100, 40), 61);
  assert.equal(moveCursor(50, { kind: "goto", line: 9999 }, 100, 40), 99);
  assert.equal(moveCursor(0, { kind: "bottom" }, 0, 40), 0);
});

test("{ and } go to the blank line that ends a block", () => {
  //             0      1     2     3      4     5      6     7
  const blank = [false, false, true, false, false, true, true, false];
  assert.equal(blockTarget(blank, 0, 1), 2);
  assert.equal(blockTarget(blank, 2, 1), 5);
  assert.equal(blockTarget(blank, 5, 1), 7);
  assert.equal(blockTarget(blank, 7, -1), 2);
  assert.equal(blockTarget(blank, 4, -1), 2);
  assert.equal(blockTarget(blank, 1, -1), 0);
  assert.equal(moveCursor(0, { kind: "block", by: 1 }, 8, 4, blank), 2);
  // Without blank lines to go by, a block is half a page.
  assert.equal(moveCursor(0, { kind: "block", by: 1 }, 100, 40), 20);
});

test("the window scrolls only as far as it takes to show the cursor's line", () => {
  assert.equal(scrollToShow(100, 18, 0, 600, 40), 0);
  assert.equal(scrollToShow(590, 18, 0, 600, 40), 48);
  assert.equal(scrollToShow(10, 18, 200, 600, 40), -230);
  // At the very top there is no room to keep above.
  assert.equal(scrollToShow(0, 18, 0, 600, 40), -40);
});

test("a file's kind comes from its name; sizes and lines read plainly", () => {
  assert.equal(fileKind("/a/README.md"), "markdown");
  assert.equal(fileKind("/a/shot.PNG"), "image");
  assert.equal(fileKind("/a/keys.ts"), "source");
  assert.equal(fileKind("/a/Makefile"), "source");
  assert.equal(formatSize(812), "812 B");
  assert.equal(formatSize(14_500), "14 KB");
  assert.equal(formatSize(2_400_000), "2.3 MB");
  assert.deepEqual(textLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(textLines("a\r\n\r\nb"), ["a", "", "b"]);
  assert.deepEqual(textLines(""), [""]);
});

test("a change bb recorded without a hunk header is given one, so it draws as a diff", () => {
  const added = toPatch("--- /dev/null\n+++ b/work/repo/.cow-e2e/sample.txt\n+alpha\n+beta\n+gamma\n", ".cow-e2e/sample.txt");
  assert.equal(added.text, "--- /dev/null\n+++ b/.cow-e2e/sample.txt\n@@ -0,0 +1,3 @@\n+alpha\n+beta\n+gamma\n");
  assert.deepEqual([added.before, added.after, added.added, added.removed], ["/dev/null", ".cow-e2e/sample.txt", 3, 0]);
  const edited = toPatch("--- a/x\n+++ b/x\n alpha\n-beta\n+delta\n gamma\n", "x.txt");
  assert.match(edited.text, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@ -1,3 \+1,3 @@\n alpha\n-beta\n\+delta\n gamma\n$/);
  assert.deepEqual([edited.added, edited.removed], [1, 1]);
  // A patch that has its hunks keeps them.
  const whole = toPatch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -4,2 +4,2 @@\n-a\n+b\n c\n", "x");
  assert.equal(whole.text, "--- a/x\n+++ b/x\n@@ -4,2 +4,2 @@\n-a\n+b\n c\n");
  const removed = toPatch("--- a/x\n+++ /dev/null\n-only\n", "x");
  assert.match(removed.text, /^--- a\/x\n\+\+\+ \/dev\/null\n@@ -1,1 \+0,0 @@\n-only\n$/);
  assert.equal(removed.after, "/dev/null");
});
