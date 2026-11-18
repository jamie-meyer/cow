import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { filterOverview } from "../src/filter.ts";
import { keepHolds, keepNote } from "../src/keep.ts";
import type { KeepNote } from "../src/shared.ts";
import { type Activity, type ThreadFacts, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { KEPT_SECTION, SETTLE_SECTION, buildOverview, cursorOrder, foldMove, keepFolds, sectionFolded, unfoldAround } from "../src/tree.ts";
import { undoShort, undoText } from "../src/undo.ts";
import { verbBlocked, verbLabel } from "../src/verbs.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

const kept = (overrides: Partial<KeepNote> = {}): KeepNote => ({ words: "an idea about pricing", at: NOW - 3 * DAY, ...overrides });
const rested = (startedAgo = 4 * DAY): Activity =>
  activity({ turn: { phase: "completed", at: NOW - startedAgo + MINUTE, failed: false }, startedAt: NOW - startedAgo, output: "ok" });
const ask = (threadId: string): Ask => ({
  id: `ask_${threadId}`, threadId, askedBy: threadId, projectId: "proj_test", question: "Which one?", options: [], optionsOnly: false, risk: null, proofs: [], context: null,
  createdAt: NOW - HOUR, status: "open", answer: null, deliveredAt: null, withdrawnAt: null, closed: null, capability: null,
});
const leaf = (id: string, overrides: Partial<ThreadFacts> = {}) => thread({ id, parentThreadId: "main", latestAttentionAt: NOW - 4 * DAY, ...overrides });

function page(threads: ThreadFacts[], keeps: Record<string, KeepNote>, { acts = {} as Record<string, Activity>, asks = {} as Record<string, Ask[]> } = {}) {
  return buildOverview(
    [thread({ id: "main" }), ...threads],
    "main",
    (t) => derive(t, acts[t.id] ?? rested(), NOW, null, null, null, { seenSeq: null }, { asks: asks[t.id] ?? [], brief: null }, null, t.id === "main" ? null : keeps[t.id]),
    NOW,
  );
}

test("keeping takes a few words or none", () => {
  assert.deepEqual(keepNote("  ", NOW), { ok: true, note: { words: null, at: NOW } });
  assert.deepEqual(keepNote("  ideas   for later ", NOW), { ok: true, note: { words: "ideas for later", at: NOW } });
  assert.equal(keepNote("x".repeat(200), NOW).ok, false);
});

test("a kept thread is on the Kept shelf with its words, asking for nothing, newest kept first", () => {
  const overview = page([leaf("a"), leaf("b"), leaf("c")], { a: kept({ at: NOW - 3 * DAY }), b: kept({ words: null, at: NOW - DAY }) });
  assert.deepEqual(overview.kept.map((line) => [line.thread.id, line.derived.state, line.derived.doing]), [
    ["b", "kept", "ok"],
    ["a", "kept", "an idea about pricing"],
  ]);
  assert.deepEqual(overview.settle.map((line) => line.thread.id), ["c"]);
  assert.deepEqual(overview.queue, []);
  // Its age is how long it has been kept.
  assert.equal(overview.kept[1]!.derived.since, NOW - 3 * DAY);
  assert.equal(overview.counts.kept, 2);
});

test("a failure, or a reply addressed to the person, is quiet on a kept line; an open ask shows through", () => {
  const failing = leaf("f", { status: "error" });
  const overview = page([failing, leaf("q")], { f: kept(), q: kept() }, { asks: { q: [ask("q")] } });
  assert.deepEqual(overview.queue.map((line) => line.thread.id), ["q"]);
  const q = overview.kept.find((line) => line.thread.id === "q")!;
  assert.equal(q.derived.state, "kept");
  assert.match(q.derived.doing, /an idea about pricing · asks you: Which one\?/);
  assert.equal(q.derived.next, "answer it: press a");
  assert.equal(verbBlocked("answer", q, false), null);
});

test("a kept thread comes off the shelf by itself when it starts a new turn", () => {
  const note = kept({ at: NOW - DAY });
  assert.equal(keepHolds(note, NOW - 2 * DAY), true);
  assert.equal(keepHolds(note, null), true);
  assert.equal(keepHolds(note, NOW - HOUR), false);
  // Typed to an hour ago: it reads as any other thread, here a reply to the person.
  const typed: Activity = activity({
    turn: { phase: "completed", at: NOW - HOUR + MINUTE, failed: false },
    startedAt: NOW - HOUR,
    output: "Here is more.",
    replies: { last: { seq: 9, at: NOW - HOUR + MINUTE }, toPerson: { seq: 9, at: NOW - HOUR + MINUTE }, personSpokeSeq: 7 },
  });
  const overview = page([leaf("t", { latestAttentionAt: NOW - HOUR })], { t: note }, { acts: { t: typed } });
  assert.deepEqual(overview.kept, []);
  assert.deepEqual(overview.queue.map((line) => [line.thread.id, line.derived.state]), [["t", "wants"]]);
  // A turn in progress is a new turn too.
  const running = page([leaf("r", { status: "active" })], { r: kept({ at: NOW - HOUR }) }, { acts: { r: rested(2 * HOUR) } });
  assert.deepEqual(running.kept, []);
});

test("what is under a kept thread is set aside with it, and the Main is never kept", () => {
  const overview = page([leaf("head"), thread({ id: "kid", parentThreadId: "head", status: "active" })], { head: kept(), main: kept() });
  assert.deepEqual(overview.lines, []);
  assert.deepEqual(overview.kept.map((line) => [line.thread.id, line.under]), [["head", 1]]);
  assert.equal(overview.main?.derived.state, "done");
});

test("Kept starts folded and To settle open; h and l on their headings fold them, and the choice is kept", () => {
  const overview = page([leaf("a"), leaf("s")], { a: kept() });
  const none = new Set<string>();
  assert.equal(sectionFolded(none, KEPT_SECTION), true);
  assert.equal(sectionFolded(none, SETTLE_SECTION), false);
  assert.deepEqual(cursorOrder(overview, none), [SETTLE_SECTION, "s", KEPT_SECTION]);
  const open = foldMove(overview, none, KEPT_SECTION, "l");
  assert.equal(open.kind, "fold");
  const opened = open.kind === "fold" ? open.folded : none;
  assert.deepEqual(cursorOrder(overview, opened), [SETTLE_SECTION, "s", KEPT_SECTION, "a"]);
  assert.deepEqual(foldMove(overview, opened, KEPT_SECTION, "l"), { kind: "cursor", id: "a" });
  assert.deepEqual(foldMove(overview, opened, "a", "h"), { kind: "cursor", id: KEPT_SECTION });
  const settleFolded = foldMove(overview, opened, SETTLE_SECTION, "h");
  assert.equal(settleFolded.kind === "fold" && sectionFolded(settleFolded.folded, SETTLE_SECTION), true);
  assert.deepEqual(foldMove(overview, none, KEPT_SECTION, "h"), { kind: "none" });
  // The sections' folds outlive the pruning of threads that left the page.
  assert.equal(keepFolds(overview, opened), opened);
  // Jumping to a kept line, from the queue or the filter, opens its section.
  assert.equal(sectionFolded(unfoldAround(overview, none, "a"), KEPT_SECTION), false);
});

test("the filter finds kept lines while their section is folded", () => {
  const overview = page([leaf("pricing ideas"), leaf("other")], { "pricing ideas": kept() });
  assert.deepEqual(filterOverview(overview, "pricing").matches, ["pricing ideas"]);
  // What it is doing is searched too: the words typed when it was kept.
  assert.deepEqual(filterOverview(overview, "idea about").matches, ["pricing ideas"]);
});

test("z keeps any line that is not running, Main and archived ones apart; on a kept line it unkeeps", () => {
  const overview = page([leaf("done"), leaf("kept"), leaf("busy", { status: "active" }), leaf("gone", { archivedAt: NOW - HOUR })], { kept: kept() });
  const line = (id: string) => [...overview.lines, ...overview.settle, ...overview.kept, ...overview.archived].find((l) => l.thread.id === id)!;
  assert.equal(verbBlocked("keep", line("done"), false), null);
  assert.equal(verbBlocked("keep", line("kept"), false), null);
  assert.equal(verbLabel("keep", line("kept")), "unkeep");
  assert.equal(verbLabel("keep", line("done")), "keep");
  assert.equal(verbBlocked("keep", line("busy"), false), "its turn is running");
  assert.equal(verbBlocked("keep", line("gone"), false), "it is archived");
  assert.equal(verbBlocked("keep", overview.main, true), "Main cannot be kept");
  // A kept line can be archived or parked straight from the shelf.
  assert.equal(verbBlocked("archive", line("kept"), false), null);
  assert.equal(verbBlocked("park", line("kept"), false), null);
});

test("u takes back keeping and unkeeping", () => {
  const park = { at: NOW - DAY, reason: "later", pickUp: { kind: "none" as const }, checkedAt: NOW - DAY };
  const keptIt = { kind: "keep" as const, threadId: "t", title: "t", before: null, parked: null };
  assert.equal(undoText(keptIt), "undo keeping “t”: it reads as it did before");
  assert.equal(undoText({ ...keptIt, parked: park }), "undo keeping “t”: it reads as it did before, parked");
  assert.equal(undoText({ ...keptIt, before: kept() }), "undo taking “t” off Kept: it is kept again");
  assert.deepEqual([undoShort(keptIt), undoShort({ ...keptIt, before: kept() })], ["undo keep", "undo unkeep"]);
  assert.equal(undoShort({ kind: "park", threadId: "t", title: "t", before: park }), "undo keep parked");
});

test("bb cow status lists kept threads under their own heading", () => {
  const overview = page([leaf("a"), leaf("s")], { a: kept() });
  const report = statusReport(overview, NOW, false);
  assert.deepEqual(report.kept.map((line) => [line.id, line.state, line.doing, line.inState]), [["a", "kept", "an idea about pricing", "3d"]]);
  assert.match(statusText(report), /Kept: around on purpose, asking for nothing \(1\)\n {4}kept\s+3d  a \(a\)  an idea about pricing\n/);
});
