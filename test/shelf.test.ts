import assert from "node:assert/strict";
import { test } from "node:test";
import { parkNow } from "../src/park.ts";
import type { ParkRecord } from "../src/shared.ts";
import { LIMITS, derive } from "../src/state.ts";
import { afterLeaving, buildOverview, cursorOrder, descendantIds } from "../src/tree.ts";
import { DAY, HOUR, NOW, thread } from "./fixtures.ts";

const ids = (lines: { thread: { id: string } }[]) => lines.map((line) => line.thread.id);
const build = (
  threads: Parameters<typeof buildOverview>[0],
  parks: Record<string, ParkRecord> = {},
  now = NOW,
) => buildOverview(threads, "main", (t) => derive(t, undefined, now, parks[t.id]), now);

/** main > a > (a1 > a1x, a2), b, c(done) */
const family = () => [
  thread({ id: "main", createdAt: 1 }),
  thread({ id: "a", parentThreadId: "main", status: "active", createdAt: 2 }),
  thread({ id: "a1", parentThreadId: "a", status: "active", createdAt: 3 }),
  thread({ id: "a1x", parentThreadId: "a1", status: "error", createdAt: 4 }),
  thread({ id: "a2", parentThreadId: "a", hasPendingInteraction: true, createdAt: 5 }),
  thread({ id: "b", parentThreadId: "main", status: "active", createdAt: 6 }),
  thread({ id: "c", parentThreadId: "main", createdAt: 7 }),
];

test("a parked thread leaves the tree for the shelf, and its descendants go with it", () => {
  const overview = build(family(), { a: parkNow("later", { kind: "none" }, NOW - DAY) });
  assert.deepEqual(ids(overview.lines), ["b"]);
  assert.deepEqual(ids(overview.parked), ["a"]);
  assert.equal(overview.parked[0]!.under, 3);
  assert.equal(overview.parked[0]!.depth, 0);
  assert.equal(overview.counts.parked, 1);
  // The question and the failure under it are set aside too.
  assert.deepEqual(ids(overview.queue), []);
  assert.deepEqual(cursorOrder(overview), ["b", "a", "c"]);
});

test("archived descendants are not counted on a parked line", () => {
  const threads = family().map((t) => (t.id === "a2" ? { ...t, archivedAt: NOW - HOUR } : t));
  const overview = build(threads, { a: parkNow("later", { kind: "none" }, NOW) });
  assert.equal(overview.parked[0]!.under, 2);
});

test("parking a child leaves its parent and siblings in the tree", () => {
  const overview = build(family(), { a1: parkNow("later", { kind: "none" }, NOW) });
  assert.deepEqual(ids(overview.lines), ["a", "a2", "b"]);
  assert.deepEqual(ids(overview.parked), ["a1"]);
  assert.equal(overview.parked[0]!.under, 1);
});

test("a note on a thread inside a parked subtree shows only once its parent is resumed", () => {
  const parks = {
    a: parkNow("outer", { kind: "none" }, NOW - 2 * DAY),
    a1: parkNow("inner", { kind: "none" }, NOW - DAY),
  };
  assert.deepEqual(ids(build(family(), parks).parked), ["a"]);
  const { a: _resumed, ...rest } = parks;
  const overview = build(family(), rest);
  assert.deepEqual(ids(overview.lines), ["a", "a2", "b"]);
  assert.deepEqual(ids(overview.parked), ["a1"]);
});

test("a finished parent does not stay in the tree for a parked child", () => {
  const overview = build(
    [
      thread({ id: "main", createdAt: 1 }),
      thread({ id: "p", parentThreadId: "main", createdAt: 2 }),
      thread({ id: "kid", parentThreadId: "p", status: "active", createdAt: 3 }),
    ],
    { kid: parkNow("later", { kind: "none" }, NOW) },
  );
  assert.deepEqual(ids(overview.lines), []);
  assert.deepEqual(ids(overview.done), ["p"]);
  assert.deepEqual(ids(overview.parked), ["kid"]);
});

test("the shelf lists the longest parked first", () => {
  const overview = build(family(), {
    b: parkNow("x", { kind: "none" }, NOW - DAY),
    a: parkNow("y", { kind: "none" }, NOW - HOUR),
    c: parkNow("z", { kind: "none" }, NOW - 3 * DAY),
  });
  assert.deepEqual(ids(overview.parked), ["c", "b", "a"]);
});

test("parked work returns to the queue when its date arrives", () => {
  const parks = { b: parkNow("x", { kind: "date", at: NOW + 3 * DAY }, NOW) };
  const before = build(family(), parks, NOW + 3 * DAY - 1);
  assert.equal(before.queue.some((line) => line.thread.id === "b"), false);
  const after = build(family(), parks, NOW + 3 * DAY);
  const entry = after.queue.find((line) => line.thread.id === "b");
  assert.ok(entry);
  assert.equal(entry.derived.state, "parked");
  assert.equal(entry.queueNumber !== null, true);
  // It stays on the shelf while it asks.
  assert.deepEqual(ids(after.parked), ["b"]);
});

test("parked work with no date returns every four weeks", () => {
  const parks = { b: parkNow("x", { kind: "none" }, NOW) };
  assert.deepEqual(
    ids(build(family(), parks, NOW + LIMITS.parkCheckMs - 1).queue).includes("b"),
    false,
  );
  const overview = build(family(), parks, NOW + LIMITS.parkCheckMs);
  const back = overview.queue.find((line) => line.thread.id === "b")!.derived.park;
  assert.deepEqual(back?.due, { kind: "check", at: NOW + LIMITS.parkCheckMs, weeks: 4 });
});

test("the queue orders returned work by when it came back", () => {
  const threads = [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "old", parentThreadId: "main", status: "active", createdAt: 2 }),
    thread({ id: "ask", parentThreadId: "main", hasPendingInteraction: true, latestAttentionAt: NOW - DAY, createdAt: 3 }),
  ];
  // Parked a month ago, back two hours ago: behind the day-old question.
  const overview = build(threads, {
    old: parkNow("x", { kind: "date", at: NOW - 2 * HOUR }, NOW - 30 * DAY),
  });
  assert.deepEqual(ids(overview.queue), ["ask", "old"]);
});

test("resuming puts the thread back in the tree with its own state", () => {
  const overview = build(family(), {});
  assert.deepEqual(ids(overview.lines), ["a", "a1", "a1x", "a2", "b"]);
  assert.deepEqual(ids(overview.parked), []);
  assert.equal(overview.lines[0]!.derived.state, "running");
});

test("a tree line knows how many lines are listed under it", () => {
  const overview = build(family());
  assert.deepEqual(
    overview.lines.map((line) => [line.thread.id, line.openUnder]),
    [["a", 3], ["a1", 1], ["a1x", 0], ["a2", 0], ["b", 0]],
  );
});

test("when a line leaves, the cursor goes to the next line down that stays", () => {
  const overview = build(family(), { b: parkNow("x", { kind: "none" }, NOW) });
  // Order: a, a1, a1x, a2 | b (shelf) | c (done)
  assert.equal(afterLeaving(overview, "a1x"), "a2");
  // a1 takes a1x with it.
  assert.equal(afterLeaving(overview, "a1"), "a2");
  // a takes its whole subtree: next is the shelf.
  assert.equal(afterLeaving(overview, "a"), "b");
  assert.equal(afterLeaving(overview, "b"), "c");
  // Nothing below the last line: up.
  assert.equal(afterLeaving(overview, "c"), "b");
  assert.equal(afterLeaving(overview, "nobody"), null);
  const alone = build([thread({ id: "main" }), thread({ id: "only", parentThreadId: "main", status: "active" })]);
  assert.equal(afterLeaving(alone, "only"), null);
});

test("the notes to load are those of every unarchived thread under Main", () => {
  const threads = [
    ...family(),
    thread({ id: "gone", parentThreadId: "main", archivedAt: NOW }),
    thread({ id: "under-gone", parentThreadId: "gone", status: "active" }),
    thread({ id: "stranger", status: "active" }),
  ];
  assert.deepEqual(descendantIds(threads, "main"), ["a", "a1", "a1x", "a2", "b", "c", "under-gone"]);
});
