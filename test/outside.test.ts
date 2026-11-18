import assert from "node:assert/strict";
import { test } from "node:test";
import { filterOverview } from "../src/filter.ts";
import { moveRecord, moveRefusal, moveText, moveUpdate, notListedText, outsideMain, undoUpdates } from "../src/outside.ts";
import { type ThreadFacts, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { OUTSIDE_SECTION, afterLeaving, buildOverview, cursorOrder, foldMove, keepFolds, sectionFolded, sectionOf, unfoldAround } from "../src/tree.ts";
import { undoShort, undoText } from "../src/undo.ts";
import { DAY, HOUR, NOW, activity, thread } from "./fixtures.ts";

/** A small bb: Main under a root, a child of Main, and threads with no parent of every kind. */
function world(extra: ThreadFacts[] = []): ThreadFacts[] {
  // Created long ago, so that when each last did anything is its own.
  return [
    thread({ id: "root" }),
    thread({ id: "main", parentThreadId: "root" }),
    thread({ id: "kid", parentThreadId: "main" }),
    thread({ id: "old", latestAttentionAt: NOW - 3 * DAY }),
    thread({ id: "busy", status: "active", latestAttentionAt: NOW - HOUR }),
    thread({ id: "asking", hasPendingInteraction: true, latestAttentionAt: NOW - 2 * HOUR }),
    thread({ id: "fork", originKind: "fork", latestAttentionAt: NOW - DAY }),
    thread({ id: "head", latestAttentionAt: NOW - 5 * DAY }),
    thread({ id: "w1", parentThreadId: "head" }),
    thread({ id: "w2", parentThreadId: "w1" }),
    thread({ id: "w3", parentThreadId: "head", archivedAt: NOW - DAY }),
    thread({ id: "gone", archivedAt: NOW - DAY }),
    thread({ id: "hidden", visibility: "hidden" }),
    thread({ id: "auto1", originPluginId: "automations" }),
    thread({ id: "auto2", originPluginId: "automations" }),
    thread({ id: "otherMain", projectId: "proj_other" }),
    ...extra,
  ].map((t) => ({ ...t, createdAt: NOW - 60 * DAY }));
}

test("Outside Main lists open threads with no parent, newest activity first, and counts what it leaves out", () => {
  const found = outsideMain(world(), "main", new Set(["otherMain"]));
  assert.deepEqual(
    found.lines.map((line) => [line.thread.id, line.state, line.under]),
    [
      ["busy", "running", 0],
      ["asking", "asking", 0],
      ["fork", "resting", 0],
      ["old", "resting", 0],
      ["head", "resting", 2],
    ],
  );
  assert.equal(found.byPlugins, 2);
  assert.equal(found.otherMains, 1);
  assert.equal(notListedText(found), "2 started by plugins, 1 is another project's Main, not listed");
  assert.equal(notListedText({ lines: [], byPlugins: 0, otherMains: 0 }), "");
});

test("Main, and the threads above it, are never outside it; nor is anything under Main", () => {
  const ids = outsideMain(world(), "main").lines.map((line) => line.thread.id);
  for (const id of ["root", "main", "kid", "w1", "w2", "gone", "hidden", "auto1"]) assert.ok(!ids.includes(id), id);
  // Without other Mains named, another project's Main is a thread like any other.
  assert.ok(ids.includes("otherMain"));
  // A parent link that loops does not hang it.
  const looped = [thread({ id: "a", parentThreadId: "b" }), thread({ id: "b", parentThreadId: "a" }), thread({ id: "c" })];
  assert.deepEqual(outsideMain(looped, "a").lines.map((line) => line.thread.id), ["c"]);
});

const derived = (t: ThreadFacts) => derive(t, activity(), NOW, null, null, null, { head: false, seenSeq: null });
const page = (threads = world()) => buildOverview(threads, "main", derived, NOW, { note: () => null, todos: () => [], otherMains: new Set(["otherMain"]) });

test("the section is last on the page, folded by default, and folds like Kept", () => {
  const overview = page();
  assert.equal(overview.outside.lines.length, 5);
  const none = new Set<string>();
  assert.equal(sectionFolded(none, OUTSIDE_SECTION), true);
  const order = cursorOrder(overview, none);
  assert.equal(order[order.length - 1], OUTSIDE_SECTION);
  assert.ok(!order.includes("old"));
  const open = foldMove(overview, none, OUTSIDE_SECTION, "l");
  assert.equal(open.kind, "fold");
  const unfolded = open.kind === "fold" ? open.folded : none;
  assert.equal(sectionFolded(unfolded, OUTSIDE_SECTION), false);
  assert.deepEqual(cursorOrder(overview, unfolded).slice(-6), [OUTSIDE_SECTION, "busy", "asking", "fork", "old", "head"]);
  assert.deepEqual(foldMove(overview, unfolded, "old", "h"), { kind: "cursor", id: OUTSIDE_SECTION });
  assert.deepEqual(foldMove(overview, unfolded, OUTSIDE_SECTION, "l"), { kind: "cursor", id: "busy" });
  // The window remembers it open, and forgets nothing it should keep.
  assert.equal(keepFolds(overview, unfolded), unfolded);
  // A line in it is found where it is, and unfolding around it opens the section.
  assert.equal(sectionOf(overview, "fork"), OUTSIDE_SECTION);
  assert.equal(sectionFolded(unfoldAround(overview, none, "fork"), OUTSIDE_SECTION), false);
  // Leaving it, the cursor lands on another line, never on a heading.
  assert.equal(afterLeaving(overview, "head", unfolded), "old");
});

test("nothing outside Main is in the queue or counted among the page's lines", () => {
  const overview = page();
  assert.ok(overview.queue.every((line) => !overview.outside.lines.some((other) => other.thread.id === line.thread.id)));
  assert.equal(Object.values(overview.counts).reduce((a, b) => a + b, 0), 1);
});

test("/ finds lines outside Main while the section is folded, after every other section", () => {
  const found = filterOverview(page(), "fork");
  assert.deepEqual(found.matches, ["fork"]);
  assert.deepEqual(filterOverview(page(), "k").matches.slice(0, 1), ["kid"]);
});

test("the move is recorded before it is made, and undo puts back exactly what was there", () => {
  const before = moveRecord(thread({ id: "old", title: "Old work", sectionId: "sec_9", parentNotifications: "off" }));
  assert.deepEqual(before, { threadId: "old", title: "Old work", parentThreadId: null, sectionId: "sec_9", parentNotifications: "off" });
  assert.deepEqual(moveUpdate("old", "main"), { threadId: "old", parentThreadId: "main", parentNotifications: "stuck" });
  // The section is set after the parent: clearing a parent gives the thread the old parent's section.
  assert.deepEqual(undoUpdates(before), [
    { threadId: "old", parentThreadId: null, parentNotifications: "off" },
    { threadId: "old", sectionId: "sec_9" },
  ]);
  // A thread bb reported nothing for is taken to have bb's defaults.
  const bare = moveRecord({ ...thread({ id: "x" }), sectionId: undefined, parentNotifications: undefined });
  assert.equal(bare.sectionId, null);
  assert.equal(bare.parentNotifications, "auto");
  const entry = { kind: "move" as const, threadId: "old", title: "Old work", before };
  assert.equal(undoShort(entry), "undo move");
  assert.match(undoText(entry), /back outside Main, with its sidebar section and its notifications as they were/);
});

test("the confirmation says Main gets a notice and starts a turn, and that the thread tells Main only when stuck", () => {
  const line = outsideMain(world(), "main").lines.find((other) => other.thread.id === "head")!;
  const text = moveText(line, "Main");
  assert.match(text, /“head” with the 2 threads under it under Main/);
  assert.match(text, /Main starts a turn/);
  assert.match(text, /“stuck”/);
});

test("bb's refusals are said in plain words", () => {
  assert.match(moveRefusal(Object.assign(new Error("Thread hierarchy too deep"), { code: "too_deep" })), /more than 4 levels deep/);
  assert.match(moveRefusal(new Error("parent thread is archived")), /archived or deleted/);
  // What bb 0.49 says, from the end-to-end check.
  assert.equal(
    moveRefusal(new Error('HTTP 400: Parent thread is invalid {"ok": false, "error": {"code": "parent_thread_invalid"}}')),
    "bb refused: Main cannot take a thread under it, as it is archived or deleted",
  );
  assert.match(moveRefusal(new Error("would create a cycle")), /Main is under that thread/);
  assert.equal(moveRefusal(new Error("something else")), "bb refused: something else");
});

test("bb cow status lists Outside Main, naming another project, and --json has it as outside", () => {
  const threads = world([thread({ id: "elsewhere", title: "Elsewhere", projectId: "proj_b", latestAttentionAt: NOW - 30 * DAY })]);
  const overview = page(threads);
  const report = statusReport(overview, NOW, false, new Map([["proj_b", "Billing"]]));
  assert.deepEqual(report.outsideNotListed, { byPlugins: 2, otherMains: 1 });
  const elsewhere = report.outside.find((line) => line.id === "elsewhere")!;
  assert.equal(elsewhere.project, "Billing");
  assert.equal(elsewhere.since, "4w");
  assert.equal(report.outside.find((line) => line.id === "old")!.project, null);
  assert.equal(report.outside.find((line) => line.id === "asking")!.label, "wants an answer");
  const text = statusText(report);
  assert.match(text, /\nOutside Main: open, with no parent, not under Main \(6; 2 started by plugins, 1 is another project's Main, not listed\)\n/);
  assert.match(text, / {4}at rest · 4w {2}Elsewhere \(elsewhere\) {2}\[project: Billing\]\n/);
  assert.match(text, / {4}at rest · 5d {2}head \(head\) {2}\[2 under it\]\n/);
});
