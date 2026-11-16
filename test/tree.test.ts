import assert from "node:assert/strict";
import { test } from "node:test";
import { derive } from "../src/state.ts";
import { buildOverview, cursorOrder, descendantIds } from "../src/tree.ts";
import { DAY, HOUR, NOW, thread } from "./fixtures.ts";

const build = (threads: Parameters<typeof buildOverview>[0], mainId = "main") =>
  buildOverview(threads, mainId, (t) => derive(t, undefined, NOW), NOW);
const ids = (lines: { thread: { id: string } }[]) => lines.map((line) => line.thread.id);

test("lists Main's descendants under their parents, in creation order", () => {
  const overview = build([
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "b", parentThreadId: "main", status: "active", createdAt: 30 }),
    thread({ id: "a", parentThreadId: "main", status: "active", createdAt: 20 }),
    thread({ id: "a1", parentThreadId: "a", status: "active", createdAt: 40 }),
    thread({ id: "a2", parentThreadId: "a", status: "active", createdAt: 35 }),
    thread({ id: "stranger", status: "active", createdAt: 5 }),
    thread({ id: "strangers-child", parentThreadId: "stranger", status: "active" }),
  ]);
  assert.equal(overview.main?.thread.id, "main");
  assert.deepEqual(ids(overview.lines), ["a", "a2", "a1", "b"]);
  assert.deepEqual(
    overview.lines.map((line) => line.depth),
    [0, 1, 1, 0],
  );
});

test("a line keeps its place when its state changes", () => {
  const before = [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "a", parentThreadId: "main", status: "active", createdAt: 2 }),
    thread({ id: "b", parentThreadId: "main", status: "active", createdAt: 3 }),
    thread({ id: "c", parentThreadId: "main", status: "active", createdAt: 4 }),
  ];
  const after = before.map((t) =>
    t.id === "b" ? { ...t, status: "error" } : t.id === "a" ? { ...t, hasPendingInteraction: true } : t,
  );
  assert.deepEqual(ids(build(after).lines), ids(build(before).lines));
});

test("finished threads move to Done, newest first; older ones are only counted", () => {
  const overview = build([
    thread({ id: "main" }),
    thread({ id: "open", parentThreadId: "main", status: "active" }),
    thread({ id: "yesterday", parentThreadId: "main", archivedAt: NOW - DAY }),
    thread({ id: "just-now", parentThreadId: "main", archivedAt: NOW - HOUR }),
    thread({ id: "last-week", parentThreadId: "main", archivedAt: NOW - 7 * DAY }),
    thread({ id: "last-month", parentThreadId: "main", archivedAt: NOW - 30 * DAY }),
  ]);
  assert.deepEqual(ids(overview.lines), ["open"]);
  assert.deepEqual(ids(overview.done), ["just-now", "yesterday"]);
  assert.equal(overview.olderDone, 2);
  assert.deepEqual(cursorOrder(overview), ["open", "just-now", "yesterday"]);
  assert.equal(overview.counts.done, 2);
  assert.equal(overview.counts.running, 1);
});

test("a finished thread stays in the tree while work under it is open", () => {
  const overview = build([
    thread({ id: "main" }),
    thread({ id: "parent", parentThreadId: "main", archivedAt: NOW - 30 * DAY, createdAt: 2 }),
    thread({ id: "child", parentThreadId: "parent", status: "active", createdAt: 3 }),
    thread({ id: "done-child", parentThreadId: "parent", archivedAt: NOW - HOUR, createdAt: 4 }),
  ]);
  assert.deepEqual(ids(overview.lines), ["parent", "child"]);
  assert.deepEqual(ids(overview.done), ["done-child"]);
  assert.equal(overview.olderDone, 0);
});

test("the queue holds questions, failures and Main's unread reply, oldest first", () => {
  const overview = build([
    thread({ id: "main", lastReadAt: NOW - 3 * HOUR, latestAttentionAt: NOW - 2 * HOUR }),
    thread({ id: "newer", parentThreadId: "main", hasPendingInteraction: true, latestAttentionAt: NOW - HOUR, createdAt: 2 }),
    thread({ id: "running", parentThreadId: "main", status: "active", createdAt: 3 }),
    thread({ id: "finished", parentThreadId: "main", lastReadAt: null, createdAt: 4 }),
    thread({ id: "failed", parentThreadId: "main", status: "error", latestAttentionAt: NOW - 5 * HOUR, createdAt: 5 }),
    thread({ id: "ancient", parentThreadId: "main", hasPendingInteraction: true, latestAttentionAt: NOW - 30 * DAY, createdAt: 6 }),
  ]);
  assert.deepEqual(ids(overview.queue), ["ancient", "failed", "main", "newer"]);
  const numbers = Object.fromEntries(overview.lines.map((l) => [l.thread.id, l.queueNumber]));
  assert.deepEqual(numbers, { newer: 4, running: null, failed: 2, ancient: 1 });
  assert.equal(overview.main?.queueNumber, 3);
  assert.deepEqual(ids(overview.done), ["finished"]);
  assert.equal(overview.counts.stuck, 1);
  assert.equal(overview.counts.wants, 1);
  assert.equal(overview.counts.failed, 1);
});

test("a finished, never-opened child goes to Done and stays out of the queue", () => {
  const overview = build([
    thread({ id: "main" }),
    thread({ id: "child", parentThreadId: "main", lastReadAt: null, latestAttentionAt: NOW - HOUR }),
  ]);
  assert.deepEqual(ids(overview.lines), []);
  assert.deepEqual(ids(overview.done), ["child"]);
  assert.deepEqual(overview.queue, []);
});

test("a Main that is missing gives an empty overview", () => {
  const overview = build([thread({ id: "a" })], "gone");
  assert.equal(overview.main, null);
  assert.deepEqual(overview.lines, []);
});

test("a parent loop does not hang", () => {
  const overview = build([
    thread({ id: "main", parentThreadId: "b" }),
    thread({ id: "a", parentThreadId: "main", status: "active" }),
    thread({ id: "b", parentThreadId: "a", status: "active" }),
  ]);
  assert.deepEqual(ids(overview.lines), ["a", "b"]);
});

test("notes are read for open threads and for those archived recently enough to be listed", () => {
  const threads = [
    thread({ id: "main" }),
    thread({ id: "open", parentThreadId: "main" }),
    thread({ id: "fresh", parentThreadId: "open", archivedAt: NOW - HOUR }),
    thread({ id: "old", parentThreadId: "main", archivedAt: NOW - 3 * DAY }),
    thread({ id: "elsewhere", archivedAt: NOW - HOUR }),
  ];
  assert.deepEqual(descendantIds(threads, "main"), ["open"]);
  assert.deepEqual(descendantIds(threads, "main", NOW - 2 * DAY), ["fresh", "open"]);
});
