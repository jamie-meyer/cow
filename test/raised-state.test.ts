import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { type BriefMark, briefWaitText, briefWaits } from "../src/briefs/review.ts";
import { MESSAGED_SINCE, LIMITS, type Raised, asksText, derive } from "../src/state.ts";
import { buildOverview } from "../src/tree.ts";
import { verbBlocked } from "../src/verbs.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

const ask = (id: string, minutesAgo: number, overrides: Partial<Ask> = {}): Ask => ({
  id,
  threadId: "t",
  askedBy: "t",
  projectId: "proj_test",
  question: `Question ${id}?`,
  options: [],
  optionsOnly: false,
  risk: null,
  proofs: [],
  context: null,
  createdAt: NOW - minutesAgo * MINUTE,
  status: "open",
  answer: null,
  deliveredAt: null,
  withdrawnAt: null,
  closed: null,
  ...overrides,
});
const mark = (overrides: Partial<BriefMark> = {}): BriefMark => ({ version: 1, state: "checked", contradicted: 0, notEstablished: 0, judgementCalls: 0, at: NOW - HOUR, read: false, ...overrides });
const raised = (asks: Ask[] = [], brief: BriefMark | null = null): Raised => ({ asks, brief });
const child = (overrides: Partial<Parameters<typeof thread>[0]> = {}) => thread({ id: "t", parentThreadId: "main", ...overrides });
const of = (t: ReturnType<typeof thread>, r: Raised, act = activity(), park: Parameters<typeof derive>[3] = null) => derive(t, act, NOW, park, null, null, null, r);

test("a line says the oldest question and how many more there are", () => {
  assert.equal(asksText([]), "");
  assert.equal(asksText([ask("a", 5, { question: "Ship\n  it?" })]), "asks you: Ship it?");
  assert.equal(asksText([ask("a", 5), ask("b", 2), ask("c", 1)]), "asks you: Question a? (and 2 more)");
});

test("a thread with an open ask asks you, whether it is done or still running", () => {
  const done = of(child(), raised([ask("a", 30), ask("b", 5)]));
  assert.equal(done.state, "wants");
  assert.equal(done.doing, "asks you: Question a? (and 1 more)");
  assert.equal(done.next, "answer it: press a");
  assert.equal(done.waitingOnYou, true);
  assert.equal(done.since, NOW - 30 * MINUTE);
  assert.equal(done.asks?.length, 2);
  const running = of(child({ status: "active" }), raised([ask("a", 30)]));
  assert.equal(running.state, "wants");
  assert.equal(running.doing, "asks you: Question a?");
  // Without an ask the same threads are done and running.
  assert.equal(of(child(), raised()).state, "done");
  assert.equal(of(child({ status: "active" }), raised()).state, "running");
});

test("an ask outranks a reply, a refusal and a brief; a failure and bb's own request outrank it", () => {
  const replied = derive(child(), activity({ replies: { last: { seq: 9, at: NOW - HOUR }, toPerson: { seq: 9, at: NOW - HOUR }, personSpokeSeq: 5 } }), NOW, null, null, null, { head: false, seenSeq: null }, raised([ask("a", 5)]));
  assert.equal(replied.doing, "asks you: Question a?");
  assert.equal(replied.reply, undefined);

  const refusal = { id: "r", seq: 3, at: NOW - HOUR, kind: "command" as const, what: "rm x", why: "no", cwd: null, change: null, diff: null };
  const blocked = of(child(), raised([ask("a", 5)]), activity({ refusals: [refusal] }));
  assert.equal(blocked.state, "wants");
  assert.equal(blocked.doing, "asks you: Question a?");
  // The refusal is still there to deal with once the ask is answered.
  assert.equal(blocked.blocked?.refusals.length, 1);

  const briefed = of(child(), raised([ask("a", 5)], mark({ contradicted: 2 })));
  assert.equal(briefed.doing, "asks you: Question a?");
  assert.equal(briefed.briefWaits, undefined);
  assert.equal(briefed.brief?.contradicted, 2);

  const failed = of(child({ status: "error" }), raised([ask("a", 5)]));
  assert.equal(failed.state, "failed");
  assert.equal(failed.asks?.length, 1);

  const asked = of(child({ hasPendingInteraction: true }), raised([ask("a", 5)]), activity({ ask: { kind: "permission", text: "permission to run: ls", at: NOW - MINUTE } }));
  assert.equal(asked.doing, "permission to run: ls");
  assert.equal(asked.asks?.length, 1);
});

test("an ask that has waited a week reads as stuck, and still says how to answer", () => {
  const old = of(child(), raised([ask("a", (LIMITS.waitingOnUserMs + HOUR) / MINUTE)]));
  assert.equal(old.state, "stuck");
  assert.equal(old.waitingOnYou, true);
  assert.match(old.next, /waited 7d on you: press a/);
});

test("a parked thread's ask still waits on you; an archived thread's does not", () => {
  const park = { at: NOW - DAY, reason: "waiting on review", pickUp: { kind: "none" as const }, checkedAt: NOW - DAY };
  const parked = of(child(), raised([ask("a", 5)]), activity(), park);
  assert.equal(parked.state, "parked");
  assert.equal(parked.waitingOnYou, true);
  assert.equal(parked.doing, "waiting on review · asks you: Question a?");
  assert.equal(parked.next, "answer it: press a");
  assert.equal(of(child(), raised(), activity(), park).waitingOnYou, false);
  const archived = of(child({ archivedAt: NOW - HOUR }), raised([ask("a", 5)], mark()));
  assert.equal(archived.state, "done");
  assert.equal(archived.asks, undefined);
  assert.equal(archived.brief?.version, 1);
});

test("a brief waits on you when it has disputes or judgement calls you have not read", () => {
  assert.equal(briefWaits(mark()), false);
  assert.equal(briefWaits(mark({ contradicted: 1 })), true);
  assert.equal(briefWaits(mark({ notEstablished: 1 })), true);
  assert.equal(briefWaits(mark({ judgementCalls: 1 })), true);
  assert.equal(briefWaits(mark({ contradicted: 1, read: true })), false);
  assert.equal(briefWaits(mark({ state: "running", judgementCalls: 1 })), false);
  assert.equal(briefWaits(mark({ state: "failed" })), false);
  assert.equal(briefWaits(mark({ state: "failed", judgementCalls: 2 })), true);
  assert.equal(briefWaitText(mark({ contradicted: 1, notEstablished: 1 })), "brief: 2 disputed");
  assert.equal(briefWaitText(mark({ contradicted: 1, judgementCalls: 1 })), "brief: 1 disputed, 1 judgement call");
  assert.equal(briefWaitText(mark({ judgementCalls: 2 })), "brief: 2 judgement calls");
});

test("a finished thread with a disputed brief wants you; a clean one is done", () => {
  const disputed = of(child(), raised([], mark({ contradicted: 1, notEstablished: 1 })));
  assert.equal(disputed.state, "wants");
  assert.equal(disputed.doing, "brief: 2 disputed");
  assert.equal(disputed.next, "read it: press b");
  assert.equal(disputed.briefWaits, true);
  assert.equal(disputed.waitingOnYou, true);

  const clean = of(child(), raised([], mark()));
  assert.equal(clean.state, "done");
  assert.equal(clean.waitingOnYou, false);
  assert.equal(clean.brief?.state, "checked");
  // Read, a disputed one stops waiting and keeps its mark.
  const read = of(child(), raised([], mark({ contradicted: 1, read: true })));
  assert.equal(read.state, "done");
  assert.equal(read.brief?.contradicted, 1);
  // While the thread still runs, its brief does not interrupt.
  assert.equal(of(child({ status: "active" }), raised([], mark({ contradicted: 1 }))).state, "running");
  // A failed check is not a dispute and not a pass: the line stays as it was, with the mark.
  const failed = of(child(), raised([], mark({ state: "failed" })));
  assert.equal(failed.state, "done");
  assert.equal(failed.brief?.state, "failed");
});

test("a disputed brief outranks a reply addressed to you", () => {
  const replies = { last: { seq: 9, at: NOW - HOUR }, toPerson: { seq: 9, at: NOW - HOUR }, personSpokeSeq: 5 };
  const both = derive(child(), activity({ replies }), NOW, null, null, null, { head: false, seenSeq: null }, raised([], mark({ contradicted: 1 })));
  assert.equal(both.doing, "brief: 1 disputed");
  const cleanBrief = derive(child(), activity({ replies, output: "all done" }), NOW, null, null, null, { head: false, seenSeq: null }, raised([], mark()));
  assert.equal(cleanBrief.doing, "replied to you: all done");
});

test("asking threads and waiting briefs are in the queue, the parked one included", () => {
  const threads = [
    thread({ id: "main" }),
    thread({ id: "asker", parentThreadId: "main" }),
    thread({ id: "briefer", parentThreadId: "main" }),
    thread({ id: "clean", parentThreadId: "main" }),
    thread({ id: "shelved", parentThreadId: "main" }),
  ];
  const park = { at: NOW - DAY, reason: "later", pickUp: { kind: "none" as const }, checkedAt: NOW - DAY };
  const what: Record<string, Raised> = {
    asker: raised([ask("a", 10)]),
    briefer: raised([], mark({ contradicted: 1, at: NOW - 20 * MINUTE })),
    clean: raised([], mark()),
    shelved: raised([ask("s", 60)]),
  };
  const overview = buildOverview(threads, "main", (t) => derive(t, activity(), NOW, t.id === "shelved" ? park : null, null, null, null, what[t.id] ?? null), NOW);
  assert.deepEqual(overview.queue.map((line) => line.thread.id), ["shelved", "briefer", "asker"]);
  // The asker and the briefer stay in the tree; the clean one is finished.
  assert.deepEqual(overview.lines.map((line) => line.thread.id), ["asker", "briefer"]);
  assert.deepEqual(overview.done.map((line) => line.thread.id), ["clean"]);
});

test("a answers an ask wherever its thread is; b needs a brief; an open ask holds off archiving", () => {
  const threads = [thread({ id: "main" }), thread({ id: "t", parentThreadId: "main" })];
  const park = { at: NOW - DAY, reason: "later", pickUp: { kind: "none" as const }, checkedAt: NOW - DAY };
  const lineWith = (r: Raised, parked = false) => {
    const overview = buildOverview(threads, "main", (t) => derive(t, activity(), NOW, parked && t.id === "t" ? park : null, null, null, null, t.id === "t" ? r : null), NOW);
    const line = [...overview.lines, ...overview.parked, ...overview.done].find((entry) => entry.thread.id === "t");
    assert.ok(line);
    return line;
  };
  const asking = lineWith(raised([ask("a", 5)]));
  assert.equal(verbBlocked("answer", asking, false), null);
  assert.equal(verbBlocked("answer", lineWith(raised([ask("a", 5)]), true), false), null);
  assert.equal(verbBlocked("answer", lineWith(raised(), true), false), "it is parked: resume it first");
  assert.equal(verbBlocked("answer", lineWith(raised()), false), "it has not asked anything");
  assert.equal(verbBlocked("archive", asking, false), "it has an open ask: answer it, or have it withdrawn");

  assert.equal(verbBlocked("brief", lineWith(raised()), false), "it has submitted no brief");
  assert.equal(verbBlocked("brief", lineWith(raised([], mark())), false), null);
  assert.equal(verbBlocked("brief", lineWith(raised([], mark({ state: "failed" })), true), false), null);
  // A line that waits only for its brief to be read can be archived; that deals with it.
  assert.equal(verbBlocked("archive", lineWith(raised([], mark({ contradicted: 1 }))), false), null);
  assert.equal(verbBlocked("archive", lineWith(raised([], mark())), false), null);
});

test("a line says when you have messaged the thread since it asked, and what to do about it", () => {
  const spoke = (at: number) => activity({ replies: { last: null, toPerson: null, personSpokeSeq: 7, personSpokeAt: at } });
  const before = of(child(), raised([ask("a", 30)]), spoke(NOW - HOUR));
  assert.equal(before.doing, "asks you: Question a?");
  assert.equal(before.asksMessaged, undefined);
  const since = of(child(), raised([ask("a", 30), ask("b", 5)]), spoke(NOW - 10 * MINUTE));
  assert.equal(since.doing, `asks you: Question a? (and 1 more) · ${MESSAGED_SINCE}`);
  assert.equal(since.next, "answer it, or say it was answered in chat: press a");
  // Only the ask that was open when the message was sent is marked.
  assert.deepEqual(since.asksMessaged, ["a"]);
  assert.equal(since.state, "wants");
  assert.equal(since.waitingOnYou, true);
  // The message was cow delivering the answer to another of its asks: that answered nothing else.
  const own = derive(child(), spoke(NOW - 10 * MINUTE), NOW, null, null, null, null, { asks: [ask("a", 30)], brief: null, delivered: [NOW - 10 * MINUTE + 900] });
  assert.equal(own.doing, "asks you: Question a?");
  assert.equal(own.asksMessaged, undefined);
  // A parked thread's ask says so too; nothing is ever closed by this.
  const parked = of(child(), raised([ask("a", 30)]), spoke(NOW - MINUTE), { at: NOW - DAY, reason: "later", pickUp: { kind: "none" }, checkedAt: NOW - DAY });
  assert.equal(parked.doing, `later · asks you: Question a? · ${MESSAGED_SINCE}`);
  assert.equal(parked.asks?.length, 1);
});
