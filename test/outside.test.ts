import assert from "node:assert/strict";
import { test } from "node:test";
import { filterOverview } from "../src/filter.ts";
import {
  ABOVE_MAIN_REFUSAL,
  MAIN_ARCHIVE_REFUSAL,
  OTHER_MAIN_REFUSAL,
  OUTSIDE_REFUSAL,
  archivePlace,
  moveRecord,
  moveRefusal,
  moveText,
  moveUpdate,
  notListedText,
  outsideArchiveBlocked,
  outsideMain,
  undoUpdates,
} from "../src/outside.ts";
import { insteadFromCli, insteadOnPage } from "../src/verbs.ts";
import { type ThreadFacts, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { OUTSIDE_SECTION, afterLeaving, archivedOutsideIds, buildOverview, cursorOrder, foldMove, keepFolds, sectionFolded, sectionOf, unfoldAround } from "../src/tree.ts";
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

const derived = (t: ThreadFacts) => derive(t, activity(), NOW, null, null, null, { seenSeq: null });
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

// ---- archiving a thread outside Main ----------------------------------------

const MAINS = { proj_test: "main", proj_other: "otherMain" };

test("who archives a thread outside Main: the person, Main, or the thread itself", () => {
  const threads = world();
  assert.deepEqual(archivePlace(threads, MAINS, null, "proj_test", "old"), { outside: true, why: null });
  assert.deepEqual(archivePlace(threads, MAINS, "main", "proj_test", "old"), { outside: true, why: null });
  assert.deepEqual(archivePlace(threads, MAINS, "old", "proj_test", "old"), { outside: true, why: null });
  // Another thread, under Main or outside it, is refused, and told who does it.
  assert.deepEqual(archivePlace(threads, MAINS, "kid", "proj_test", "old"), { outside: true, why: OUTSIDE_REFUSAL });
  assert.deepEqual(archivePlace(threads, MAINS, "fork", "proj_test", "old"), { outside: true, why: OUTSIDE_REFUSAL });
  assert.match(insteadFromCli(OUTSIDE_REFUSAL), /the thread that is Main runs `bb cow archive/);
  // Another project's Main may archive a thread with no parent: Outside Main lists threads of every project.
  assert.deepEqual(archivePlace(threads, MAINS, "otherMain", "proj_other", "old"), { outside: true, why: null });
});

test("only the chosen Main is refused as Main; another project's Main, and what is above a Main, are never archived here", () => {
  const threads = world();
  assert.equal(archivePlace(threads, MAINS, null, "proj_test", "main").why, MAIN_ARCHIVE_REFUSAL);
  assert.equal(archivePlace(threads, MAINS, "main", "proj_test", "main").why, MAIN_ARCHIVE_REFUSAL);
  assert.equal(archivePlace(threads, MAINS, "main", "proj_test", "otherMain").why, OTHER_MAIN_REFUSAL);
  assert.equal(archivePlace(threads, MAINS, null, "proj_test", "otherMain").why, OTHER_MAIN_REFUSAL);
  assert.equal(archivePlace(threads, MAINS, "otherMain", "proj_other", "otherMain").why, MAIN_ARCHIVE_REFUSAL);
  assert.equal(archivePlace(threads, MAINS, null, "proj_test", "root").why, ABOVE_MAIN_REFUSAL);
  assert.equal(OTHER_MAIN_REFUSAL, "it is the Main chosen for another project");
  // A thread under a parent is left to the rules every line has.
  assert.deepEqual(archivePlace(threads, MAINS, "kid", "proj_test", "w1"), { outside: false, why: null });
  assert.deepEqual(archivePlace(threads, MAINS, "kid", "proj_test", "kid"), { outside: false, why: null });
});

test("e on a line outside Main: refused while it runs, bb asks it something, it has an open ask, or threads under it are open", () => {
  const lines = new Map(outsideMain(world(), "main").lines.map((line) => [line.thread.id, line]));
  assert.equal(outsideArchiveBlocked(lines.get("old")!, 0), null);
  assert.equal(outsideArchiveBlocked(lines.get("old")!, 1), "it has an open ask: answer it, or have it withdrawn");
  assert.equal(outsideArchiveBlocked(lines.get("busy")!, 0), "its turn is still running");
  assert.equal(outsideArchiveBlocked(lines.get("asking")!, 0), "bb is asking it a question");
  assert.equal(outsideArchiveBlocked(lines.get("head")!, 0), "threads under it are still open");
  assert.equal(insteadOnPage("its turn is still running"), "x stops it, and p sets it aside as it is");
  assert.match(insteadFromCli("bb is asking it a question"), /The user answers it/);
});

test("a thread archived from Outside Main is listed under Archived with its reason for two days, then leaves", () => {
  const notes = new Set(["was"]);
  const threads = (archivedAt: number) => [...world(), thread({ id: "was", archivedAt, latestAttentionAt: archivedAt - HOUR }), thread({ id: "plain", archivedAt })];
  const overview = (archivedAt: number) =>
    buildOverview(threads(archivedAt), "main", (t) => derive(t, activity(), NOW, null, t.id === "was" ? "old work" : null), NOW, {
      note: () => null,
      todos: () => [],
      otherMains: new Set(["otherMain"]),
      archivedOutside: (id) => notes.has(id),
    });
  const listed = overview(NOW - HOUR).archived;
  // Only the one cow's note marks: a thread archived some other way is not known to have been outside Main.
  assert.deepEqual(listed.map((line) => line.thread.id), ["was"]);
  assert.equal(listed[0]!.derived.archivedWhy, "old work");
  assert.deepEqual(overview(NOW - 3 * DAY).archived, []);
  assert.deepEqual(archivedOutsideIds(threads(NOW - HOUR), "main", NOW - 2 * DAY), ["gone", "plain", "was"]);
});

test("the sections, everywhere, in one order: the tree, Parked, To settle, Kept, Automations, Outside Main, then Archived", () => {
  const threads = [...world(), thread({ id: "forked", archivedAt: NOW - HOUR, latestAttentionAt: NOW - 2 * HOUR })];
  const overview = buildOverview(threads, "main", (t) => derive(t, activity(), NOW, null, t.id === "forked" ? "old work" : null), NOW, {
    note: () => null,
    todos: () => [],
    otherMains: new Set(["otherMain"]),
    archivedOutside: (id) => id === "forked",
  });
  assert.deepEqual(overview.archived.map((line) => line.thread.id), ["forked"]);
  // The cursor: Archived's lines come after Outside Main's heading, folded or not.
  const order = cursorOrder(overview, new Set());
  assert.deepEqual(order.slice(-2), [OUTSIDE_SECTION, "forked"]);
  const unfolded = cursorOrder(overview, new Set([OUTSIDE_SECTION]));
  assert.ok(unfolded.indexOf("head") < unfolded.indexOf("forked"));
  assert.equal(unfolded[unfolded.length - 1], "forked");
  // The filter: a match outside Main comes before one under Archived.
  assert.deepEqual(filterOverview(overview, "fork").matches, ["fork", "forked"]);
  // bb cow status: Archived is the last heading, and the last list of --json.
  const report = statusReport(overview, NOW, false, new Map());
  const text = statusText(report);
  assert.ok(text.indexOf("\nKept:") < text.indexOf("\nOutside Main:"));
  assert.ok(text.indexOf("\nOutside Main:") < text.indexOf("\nArchived in the last 2 days"));
  const keys = Object.keys(report);
  assert.ok(keys.indexOf("outside") < keys.indexOf("archived") && keys.indexOf("kept") < keys.indexOf("automations"));
});
