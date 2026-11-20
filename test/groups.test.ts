import assert from "node:assert/strict";
import { test } from "node:test";
import { parkNow } from "../src/park.ts";
import type { ParkRecord, TodoItem } from "../src/shared.ts";
import { type ThreadFacts, derive } from "../src/state.ts";
import {
  type Overview,
  afterLeaving,
  buildOverview,
  cursorOrder,
  foldMove,
  groupsAround,
  headIds,
  keepFolds,
  lineOf,
  nextMove,
  todoRowId,
  unfoldAround,
  unfoldOpen,
  visibleRows,
  waitingInside,
} from "../src/tree.ts";
import { DAY, HOUR, NOW, thread } from "./fixtures.ts";

interface Extras {
  parks?: Record<string, ParkRecord>;
  notes?: Record<string, string>;
  todos?: Record<string, TodoItem[]>;
}
const build = (threads: readonly ThreadFacts[], { parks = {}, notes = {}, todos = {} }: Extras = {}): Overview =>
  buildOverview(threads, "main", (t) => derive(t, undefined, NOW, parks[t.id]), NOW, {
    note: (id) => notes[id] ?? null,
    todos: (id) => todos[id] ?? [],
  });
const rowIds = (overview: Overview, folded?: ReadonlySet<string>) => visibleRows(overview, folded).map((row) => row.id);
const line = (overview: Overview, id: string) => {
  const found = [...overview.lines, ...overview.parked, ...overview.settle, ...overview.kept, ...overview.archived].find((other) => other.thread.id === id);
  assert.ok(found, `no line ${id}`);
  return found;
};
const todo = (id: string): TodoItem => ({ id, title: `do ${id}`, at: NOW });

/**
 * Three levels: main > proj (done) > [w1 running, w2 asks > w2a failed, w3 done]; solo running; old (done).
 */
const three = () => [
  thread({ id: "main", createdAt: 1 }),
  thread({ id: "proj", parentThreadId: "main", createdAt: 2 }),
  thread({ id: "w1", parentThreadId: "proj", status: "active", createdAt: 3 }),
  thread({ id: "w2", parentThreadId: "proj", hasPendingInteraction: true, createdAt: 4 }),
  thread({ id: "w2a", parentThreadId: "w2", status: "error", createdAt: 5 }),
  thread({ id: "w3", parentThreadId: "proj", createdAt: 6 }),
  thread({ id: "solo", parentThreadId: "main", status: "active", createdAt: 7 }),
  thread({ id: "old", parentThreadId: "main", createdAt: 8 }),
];

test("a thread with threads under it heads a group, and groups nest", () => {
  const overview = build(three());
  assert.deepEqual(rowIds(overview), ["proj", "w1", "w2", "w2a", "w3", "solo"]);
  assert.deepEqual(overview.rows.map((row) => row.depth), [0, 1, 1, 2, 1, 0]);
  assert.deepEqual(overview.lines.map((l) => l.members), [4, 0, 1, 0, 0, 0]);
  assert.deepEqual(overview.lines.map((l) => l.parentId), [null, "proj", "proj", "w2", "proj", null]);
  assert.deepEqual(groupsAround(overview, "w2a"), ["proj", "w2"]);
  assert.deepEqual(groupsAround(overview, "proj"), []);
  assert.deepEqual([...headIds(three())].sort(), ["main", "proj", "w2"]);
});

test("a head's rollup counts everything under it by state, at every depth", () => {
  const overview = build(three());
  assert.deepEqual(line(overview, "proj").rollup, { wants: 1, blocked: 0, running: 1, waiting: 0, stuck: 0, parked: 0, kept: 0, failed: 1, idle: 0, done: 1 });
  assert.deepEqual(line(overview, "w2").rollup, { wants: 0, blocked: 0, running: 0, waiting: 0, stuck: 0, parked: 0, kept: 0, failed: 1, idle: 0, done: 0 });
  assert.equal(line(overview, "w1").rollup, null);
  assert.equal(overview.main?.rollup, null);
});

test("a finished member stays in its open group; a finished line under Main goes to To settle", () => {
  const overview = build(three());
  assert.ok(overview.lines.some((l) => l.thread.id === "w3"));
  assert.deepEqual(overview.settle.map((l) => l.thread.id), ["old"]);
  // The head is finished itself, and still stays for its open members.
  assert.equal(line(overview, "proj").derived.state, "done");
  assert.equal(line(overview, "proj").openUnder, 3);
});

test("a member that finished more than two days ago leaves its group for To settle, still counted on its head", () => {
  const threads = three().map((t) => (t.id === "w3" ? { ...t, latestAttentionAt: NOW - 5 * DAY } : t));
  const overview = build(threads);
  assert.deepEqual(rowIds(overview), ["proj", "w1", "w2", "w2a", "solo"]);
  assert.equal(line(overview, "proj").rollup?.done, 1);
  assert.ok(overview.settle.some((l) => l.thread.id === "w3"));
  assert.ok(overview.unarchived.includes("w3"));
});

test("an archived member leaves its group for Archived, with its reason's line", () => {
  const threads = three().map((t) => (t.id === "w3" ? { ...t, archivedAt: NOW - HOUR } : t));
  const overview = build(threads);
  assert.deepEqual(rowIds(overview), ["proj", "w1", "w2", "w2a", "solo"]);
  assert.deepEqual(overview.archived.map((l) => l.thread.id), ["w3"]);
  assert.deepEqual(overview.settle.map((l) => l.thread.id), ["old"]);
  assert.equal(line(overview, "proj").rollup?.done, 0);
});

test("a group that is finished whole is one line to settle, counting what is under it, however old", () => {
  const threads = [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "proj", parentThreadId: "main", latestAttentionAt: NOW - 5 * DAY, createdAt: 2 }),
    thread({ id: "w1", parentThreadId: "proj", latestAttentionAt: NOW - HOUR, createdAt: 3 }),
    thread({ id: "w2", parentThreadId: "proj", latestAttentionAt: NOW - 3 * HOUR, createdAt: 4 }),
    thread({ id: "stale", parentThreadId: "main", latestAttentionAt: NOW - 4 * DAY, createdAt: 5 }),
    thread({ id: "stale-kid", parentThreadId: "stale", latestAttentionAt: NOW - 3 * DAY, createdAt: 6 }),
  ];
  const overview = build(threads);
  assert.deepEqual(overview.rows, []);
  // Nothing is hidden by age: oldest first, as long ago as the newest thing in each finished.
  assert.deepEqual(overview.settle.map((l) => [l.thread.id, l.under, l.finishedAt]), [["stale", 1, NOW - 3 * DAY], ["proj", 2, NOW - HOUR]]);
  assert.deepEqual(overview.unarchived.sort(), ["proj", "stale", "stale-kid", "w1", "w2"]);
});

test("a note of what is next, or work not started, keeps a finished line in the tree", () => {
  const threads = [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "noted", parentThreadId: "main", createdAt: 2 }),
    thread({ id: "listed", parentThreadId: "main", createdAt: 3 }),
    thread({ id: "plain", parentThreadId: "main", createdAt: 4 }),
    thread({ id: "archived", parentThreadId: "main", archivedAt: NOW - HOUR, createdAt: 5 }),
  ];
  const overview = build(threads, {
    notes: { noted: "start the second half on Monday", archived: "never shown" },
    todos: { listed: [todo("a")], archived: [todo("z")] },
  });
  assert.deepEqual(rowIds(overview), ["noted", "listed", todoRowId("listed", "a")]);
  assert.deepEqual(overview.settle.map((l) => l.thread.id), ["plain"]);
  assert.deepEqual(overview.archived.map((l) => l.thread.id), ["archived"]);
  assert.equal(line(overview, "noted").note, "start the second half on Monday");
  assert.equal(line(overview, "archived").note, null);
  // Work not started makes its thread a group.
  assert.equal(line(overview, "listed").members, 1);
});

test("what a thread has not started is listed in its group after its members, in order", () => {
  const overview = build(three(), { todos: { proj: [todo("a"), todo("b")], w2: [todo("c")], main: [todo("m")] } });
  assert.deepEqual(rowIds(overview), [
    "proj", "w1", "w2", "w2a", "todo:w2:c", "w3", "todo:proj:a", "todo:proj:b", "solo", "todo:main:m",
  ]);
  const rows = overview.rows.filter((row) => row.kind === "todo");
  assert.deepEqual(rows.map((row) => [row.ownerId, row.number, row.of, row.depth]), [
    ["w2", 1, 1, 2],
    ["proj", 1, 2, 1],
    ["proj", 2, 2, 1],
    ["main", 1, 1, 0],
  ]);
  // They are rows, not threads: no state is counted for them and nothing is read for them.
  assert.equal(overview.lines.length, 6);
  assert.ok(!overview.unarchived.some((id) => id.startsWith("todo:")));
  assert.deepEqual(cursorOrder(overview).slice(-3), ["todo:main:m", "section:settle", "old"]);
});

test("folding hides a group's members from the page and from the cursor, nested groups too", () => {
  const overview = build(three(), { todos: { proj: [todo("a")] } });
  assert.deepEqual(rowIds(overview, new Set(["proj"])), ["proj", "solo"]);
  assert.deepEqual(rowIds(overview, new Set(["w2"])), ["proj", "w1", "w2", "w3", "todo:proj:a", "solo"]);
  assert.deepEqual(rowIds(overview, new Set(["w2", "proj"])), ["proj", "solo"]);
  assert.deepEqual(cursorOrder(overview, new Set(["proj"])), ["proj", "solo", "section:settle", "old"]);
  // A fold recorded on a line that heads nothing hides nothing.
  assert.deepEqual(rowIds(overview, new Set(["w1", "solo"])), rowIds(overview));
});

test("h folds a head and takes a member to its head; l unfolds and steps in", () => {
  const overview = build(three());
  const none = new Set<string>();
  assert.deepEqual(foldMove(overview, none, "proj", "h"), { kind: "fold", folded: new Set(["proj"]) });
  assert.deepEqual(foldMove(overview, none, "w1", "h"), { kind: "cursor", id: "proj" });
  assert.deepEqual(foldMove(overview, none, "w2a", "h"), { kind: "cursor", id: "w2" });
  assert.deepEqual(foldMove(overview, none, "w2", "h"), { kind: "fold", folded: new Set(["w2"]) });
  // A folded head inside another group: h goes up a level.
  assert.deepEqual(foldMove(overview, new Set(["w2"]), "w2", "h"), { kind: "cursor", id: "proj" });
  assert.deepEqual(foldMove(overview, new Set(["proj"]), "proj", "h"), { kind: "none" });
  assert.deepEqual(foldMove(overview, none, "solo", "h"), { kind: "none" });
  assert.deepEqual(foldMove(overview, new Set(["proj", "w2"]), "proj", "l"), { kind: "fold", folded: new Set(["w2"]) });
  assert.deepEqual(foldMove(overview, none, "proj", "l"), { kind: "cursor", id: "w1" });
  assert.deepEqual(foldMove(overview, none, "w1", "l"), { kind: "none" });
  assert.deepEqual(foldMove(overview, none, null, "h"), { kind: "none" });
  assert.deepEqual(foldMove(overview, none, "old", "l"), { kind: "none" });
});

test("going to a row inside folded groups unfolds exactly the groups around it", () => {
  const overview = build(three());
  const folded = new Set(["proj", "w2", "elsewhere"]);
  assert.deepEqual(unfoldAround(overview, folded, "w2a"), new Set(["elsewhere"]));
  assert.deepEqual(unfoldAround(overview, folded, "w1"), new Set(["w2", "elsewhere"]));
  // Nothing to unfold: the same set, so nothing re-renders.
  assert.equal(unfoldAround(overview, folded, "solo"), folded);
  assert.equal(unfoldAround(overview, folded, "proj"), folded);
});

test("the filter's Enter shows the kept line unfolded: the groups around it, and its own; nothing else", () => {
  const overview = build(three());
  const folded = new Set(["proj", "w2", "elsewhere"]);
  assert.deepEqual(unfoldOpen(overview, folded, "w2"), new Set(["elsewhere"]));
  assert.deepEqual(unfoldOpen(overview, folded, "proj"), new Set(["w2", "elsewhere"]));
  assert.deepEqual(unfoldOpen(overview, folded, "w2a"), new Set(["elsewhere"]));
  // A line with nothing under it, in no folded group: the same set.
  assert.equal(unfoldOpen(overview, folded, "solo"), folded);
});

test("a folded head still knows how many inside wait on the user", () => {
  const overview = build(three());
  assert.deepEqual(overview.queue.map((l) => l.thread.id).sort(), ["w2", "w2a"]);
  assert.equal(waitingInside(overview, "proj"), 2);
  assert.equal(waitingInside(overview, "w2"), 1);
  assert.equal(waitingInside(overview, "solo"), 0);
  // The queue numbers lines inside a folded group all the same.
  assert.ok(line(overview, "w2a").queueNumber !== null);
});

test("fold state forgets threads that have left the page, and keeps the rest", () => {
  const overview = build(three());
  const folded = new Set(["proj", "w3"]);
  assert.equal(keepFolds(overview, folded), folded);
  assert.deepEqual(keepFolds(overview, new Set(["proj", "gone"])), new Set(["proj"]));
});

test("parking a head takes its members to the shelf and counts them; parking a member leaves the group", () => {
  const whole = build(three(), { parks: { proj: parkNow("later", { kind: "none" }, NOW) } });
  assert.deepEqual(rowIds(whole), ["solo"]);
  assert.deepEqual(whole.parked.map((l) => [l.thread.id, l.under]), [["proj", 4]]);
  assert.equal(whole.parked[0]!.rollup, null);
  const member = build(three(), { parks: { w2: parkNow("later", { kind: "none" }, NOW) } });
  assert.deepEqual(rowIds(member), ["proj", "w1", "w3", "solo"]);
  assert.deepEqual(member.parked.map((l) => [l.thread.id, l.under]), [["w2", 1]]);
  // The head counts the parked member once, and nothing under it.
  assert.deepEqual(line(member, "proj").rollup, { wants: 0, blocked: 0, running: 1, waiting: 0, stuck: 0, parked: 1, kept: 0, failed: 0, idle: 0, done: 1 });
});

test("when a row leaves, the cursor skips what leaves with it and what is folded away", () => {
  const overview = build(three(), { todos: { proj: [todo("a"), todo("b")] } });
  assert.equal(afterLeaving(overview, "proj"), "solo");
  assert.equal(afterLeaving(overview, "w2"), "w3");
  assert.equal(afterLeaving(overview, "todo:proj:a"), "todo:proj:b");
  assert.equal(afterLeaving(overview, "todo:proj:b"), "solo");
  assert.equal(afterLeaving(overview, "w1", new Set(["w2"])), "w2");
  assert.equal(afterLeaving(overview, "solo", new Set(["proj"])), "old");
});

test("a line named to a verb counts only unfinished lines as open under it", () => {
  const threads = three();
  const deriveThread = (t: ThreadFacts) => derive(t, undefined, NOW);
  assert.equal(lineOf(threads, "proj", deriveThread, NOW)?.openUnder, 3);
  assert.equal(lineOf(threads, "w3", deriveThread, NOW)?.openUnder, 0);
  const finished = threads.map((t) => ({ ...t, status: "idle", hasPendingInteraction: false }));
  assert.equal(lineOf(finished, "proj", deriveThread, NOW)?.openUnder, 0);
});

test("the next move is the thread's own note, except where only the user can act", () => {
  const note = "open the PR once CI is green";
  const overview = build(
    [
      thread({ id: "main", createdAt: 1 }),
      thread({ id: "running", parentThreadId: "main", status: "active", createdAt: 2 }),
      thread({ id: "done", parentThreadId: "main", createdAt: 3 }),
      thread({ id: "asks", parentThreadId: "main", hasPendingInteraction: true, createdAt: 4 }),
      thread({ id: "failed", parentThreadId: "main", status: "error", createdAt: 5 }),
      thread({ id: "parked", parentThreadId: "main", createdAt: 6 }),
      thread({ id: "plain", parentThreadId: "main", status: "active", createdAt: 7 }),
    ],
    {
      notes: { running: note, done: note, asks: note, failed: note, parked: note },
      parks: { parked: parkNow("later", { kind: "none" }, NOW) },
    },
  );
  assert.deepEqual(nextMove(line(overview, "running")), { text: note, own: true });
  assert.deepEqual(nextMove(line(overview, "done")), { text: note, own: true });
  assert.deepEqual(nextMove(line(overview, "asks")), { text: "answer it: press a", own: false });
  assert.deepEqual(nextMove(line(overview, "failed")), { text: "open it to retry, or archive it", own: false });
  assert.equal(nextMove(line(overview, "parked")).own, false);
  assert.deepEqual(nextMove(line(overview, "plain")), { text: "finishes its turn", own: false });
});

test("a reply waiting on the user still shows the thread's own note of what is next", () => {
  const t = thread({ id: "proj", parentThreadId: "main" });
  const derived = derive(t, { lastEventAt: null, turn: null, latestStep: "", output: "Done.", ask: null, refusals: [], replies: { last: { seq: 9, at: NOW - HOUR }, toPerson: { seq: 9, at: NOW - HOUR }, personSpokeSeq: 5 } }, NOW, null, null, null, { seenSeq: null });
  const base = build([thread({ id: "main" }), t]).settle[0]!;
  assert.deepEqual(nextMove({ ...base, derived, note: "next: the second half" }), { text: "next: the second half", own: true });
  assert.deepEqual(nextMove({ ...base, derived, note: null }), { text: "read it: Enter, or Space once seen", own: false });
});

test("a thread archived out of a group keeps its own line under Archived when the group finishes too", () => {
  const threads = [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "proj", parentThreadId: "main", createdAt: 2 }),
    thread({ id: "kept", parentThreadId: "proj", createdAt: 3 }),
    thread({ id: "gone", parentThreadId: "proj", archivedAt: NOW - HOUR, createdAt: 4 }),
    thread({ id: "gone-kid", parentThreadId: "gone", archivedAt: NOW - HOUR, createdAt: 5 }),
    thread({ id: "long-gone", parentThreadId: "proj", archivedAt: NOW - 9 * DAY, createdAt: 6 }),
  ];
  const overview = build(threads);
  assert.deepEqual(overview.rows, []);
  // The group as one line counting what is still unarchived under it; the archived thread apart, with what went with it.
  assert.deepEqual(overview.settle.map((l) => [l.thread.id, l.under]), [["proj", 1]]);
  // Archived nine days ago, long-gone has left the page.
  assert.deepEqual(overview.archived.map((l) => [l.thread.id, l.under]), [["gone", 0]]);
});
