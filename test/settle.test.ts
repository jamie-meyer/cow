import assert from "node:assert/strict";
import { test } from "node:test";
import type { BriefMark } from "../src/briefs/review.ts";
import { type Activity, type Attention, type ThreadFacts, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { type Line, buildOverview, leftBehind, settleHeadingHeat, unread } from "../src/tree.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

const turnEnd = (seq: number, ago: number) => ({ seq, at: NOW - ago });
/** A thread at rest whose newest turn ended `ago`; `toPerson` when the person started that turn. */
const rested = (ago: number, { toPerson = false, spoke = null as number | null, seq = 10 } = {}): Activity =>
  activity({
    turn: { phase: "completed", at: NOW - ago, failed: false },
    startedAt: NOW - ago - MINUTE,
    output: "Finished the job.",
    replies: { last: turnEnd(seq, ago), toPerson: toPerson ? turnEnd(seq, ago) : null, personSpokeSeq: spoke },
  });
const leaf = (id: string, ago: number, overrides: Partial<ThreadFacts> = {}) =>
  thread({ id, parentThreadId: "main", latestAttentionAt: NOW - ago, createdAt: NOW - 30 * DAY, ...overrides });
const attention = (seen: Record<string, number> = {}) => (t: ThreadFacts): Attention => ({ project: false, seenSeq: seen[t.id] ?? null });

function page(threads: ThreadFacts[], acts: Record<string, Activity>, seen: Record<string, number> = {}, brief: Record<string, BriefMark> = {}) {
  const look = attention(seen);
  return buildOverview(
    [thread({ id: "main" }), ...threads],
    "main",
    (t) => derive(t, acts[t.id], NOW, null, null, null, look(t), { asks: [], brief: brief[t.id] ?? null }),
    NOW,
  );
}
const ids = (lines: readonly Line[]) => lines.map((line) => line.thread.id);

test("a job's report, a turn the person did not start, does not enter the queue: the line is to settle, unread", () => {
  const overview = page([leaf("job", HOUR)], { job: rested(HOUR) });
  assert.deepEqual(ids(overview.queue), []);
  assert.deepEqual(ids(overview.settle), ["job"]);
  const line = overview.settle[0]!;
  assert.equal(line.derived.state, "done");
  assert.deepEqual(line.derived.unseen, { seq: 10 });
  assert.equal(unread(line), true);
  assert.deepEqual(leftBehind(line), ["a reply you have not seen"]);
});

test("a reply ending a turn the person started enters the queue as before; once seen the line is to settle, read", () => {
  const talked = page([leaf("chat", HOUR)], { chat: rested(HOUR, { toPerson: true, spoke: 8 }) });
  assert.deepEqual(ids(talked.queue), ["chat"]);
  assert.match(talked.queue[0]!.derived.doing, /^replied to you: /);
  const seen = page([leaf("chat", HOUR)], { chat: rested(HOUR, { toPerson: true, spoke: 8 }) }, { chat: 10 });
  assert.deepEqual(ids(seen.queue), []);
  assert.deepEqual(ids(seen.settle), ["chat"]);
  assert.equal(unread(seen.settle[0]!), false);
});

test("a person's reply is no longer theirs to read once another turn has ended after it", () => {
  // The person spoke at 2 and got a reply at 5; then another agent started a turn that ended at 10.
  const later: Activity = { ...rested(HOUR), replies: { last: turnEnd(10, HOUR), toPerson: turnEnd(5, 2 * HOUR), personSpokeSeq: 2 } };
  const overview = page([leaf("t", HOUR)], { t: later });
  assert.deepEqual(ids(overview.queue), []);
  assert.deepEqual(overview.settle[0]!.derived.unseen, { seq: 10 });
});

test("a reply the person never read, however old, never reads stuck", () => {
  const old = page([leaf("chat", 30 * DAY)], { chat: rested(30 * DAY, { toPerson: true }) });
  assert.equal(old.queue[0]!.derived.state, "wants");
  assert.equal(old.counts.stuck, 0);
  const report = page([leaf("job", 30 * DAY)], { job: rested(30 * DAY) });
  assert.equal(report.settle[0]!.derived.state, "done");
});

test("a project's reply, and Main's, enter the queue only when the person started the turn", () => {
  const head = thread({ id: "head", parentThreadId: "main", latestAttentionAt: NOW - HOUR });
  const kid = thread({ id: "kid", parentThreadId: "head", latestAttentionAt: NOW - HOUR });
  const overview = buildOverview(
    [thread({ id: "main", lastReadAt: NOW - 3 * HOUR, latestAttentionAt: NOW - 2 * HOUR }), head, kid],
    "main",
    (t) => derive(t, rested(HOUR, { toPerson: t.id === "main" }), NOW, null, null, null, { project: t.id !== "kid", main: t.id === "main", seenSeq: null }),
    NOW,
  );
  // Main's reply ends a turn the person started; head's ends its worker's report.
  assert.deepEqual(ids(overview.queue), ["main"]);
  assert.deepEqual(overview.lines.find((line) => line.thread.id === "head")?.derived.unseen, { seq: 10 });
});

test("To settle lists every finished line however old, unread first, then oldest first", () => {
  const threads = [leaf("fresh", HOUR), leaf("week", 8 * DAY), leaf("month", 40 * DAY), leaf("unread-new", 2 * HOUR), leaf("unread-old", 5 * DAY)];
  const acts = { fresh: rested(HOUR), week: rested(8 * DAY), month: rested(40 * DAY), "unread-new": rested(2 * HOUR), "unread-old": rested(5 * DAY) };
  const seen = { fresh: 10, week: 10, month: 10 };
  const overview = page(threads, acts, seen);
  assert.deepEqual(ids(overview.settle), ["unread-old", "unread-new", "month", "week", "fresh"]);
  assert.equal(overview.counts.done, 5);
});

test("the heading of To settle takes the colour of its oldest line", () => {
  const line = (ago: number) => ({ finishedAt: NOW - ago }) as Line;
  assert.equal(settleHeadingHeat([], NOW), "plain");
  assert.equal(settleHeadingHeat([line(HOUR), line(DAY)], NOW), "plain");
  assert.equal(settleHeadingHeat([line(HOUR), line(4 * DAY)], NOW), "warm");
  // Listed unread first, so the oldest is not always the last line.
  assert.equal(settleHeadingHeat([line(8 * DAY), line(HOUR)], NOW), "old");
});

test("what archiving leaves behind: an unseen reply under it, a brief not read; nothing for a settled one", () => {
  const group = [
    leaf("proj", 3 * DAY),
    thread({ id: "w", parentThreadId: "proj", latestAttentionAt: NOW - 3 * DAY, createdAt: NOW - 29 * DAY }),
  ];
  const archivedHead = page(group, { proj: rested(3 * DAY, { seq: 4 }), w: rested(3 * DAY, { seq: 7 }) }, { proj: 4 });
  // A head is a project; here it is read as a plain line by this page's attention, so it is done with its member.
  const line = archivedHead.settle[0]!;
  assert.deepEqual([line.thread.id, line.under, line.unseenUnder, unread(line)], ["proj", 1, 1, true]);
  assert.deepEqual(leftBehind(line), ["1 unseen reply under it"]);
  const unreadBrief: BriefMark = { version: 1, state: "checked", contradicted: 0, notEstablished: 0, judgementCalls: 0, at: NOW - HOUR, read: false };
  const briefed = page([leaf("b", HOUR)], { b: rested(HOUR) }, { b: 10 }, { b: unreadBrief });
  assert.deepEqual(leftBehind(briefed.settle[0]!), ["a brief not read"]);
  assert.deepEqual(leftBehind({ ...briefed.settle[0]!, derived: { ...briefed.settle[0]!.derived, brief: { ...unreadBrief, read: true } } }), []);
});

test("bb cow status lists To settle with unread marks and how long since each finished", () => {
  const overview = page([leaf("job", 9 * DAY), leaf("seen", HOUR)], { job: rested(9 * DAY), seen: rested(HOUR) }, { seen: 10 });
  const report = statusReport(overview, NOW, false);
  assert.deepEqual(report.settle.map((line) => [line.id, line.unread, line.inState, line.leftBehind]), [
    ["job", true, "9d", ["a reply you have not seen"]],
    ["seen", false, "1h", []],
  ]);
  const text = statusText(report);
  assert.match(text, /done\s+9d  job \(job\) \[unread\]  Finished the job\.  \[archiving leaves: a reply you have not seen\]/);
});
