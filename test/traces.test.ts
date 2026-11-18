// What an agent takes out of the person's queue is put in front of them:
// a park of a thread that waited on them, an ask withdrawn, and an ask closed
// as answered in chat when they had not written to the thread since.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { type AskDeps, createAsks } from "../src/asks/service.ts";
import { eventText } from "../src/caps/log.ts";
import { createLogStore } from "../src/caps/logstore.ts";
import { createCaps } from "../src/caps/service.ts";
import { parkNow } from "../src/park.ts";
import { type Activity, type ThreadFacts, derive } from "../src/state.ts";
import { statusText } from "../src/status.ts";
import { type TraceInput, closeLeavesTrace, parkWaitedOn, traceText } from "../src/traces.ts";
import { lineOf } from "../src/tree.ts";
import { verbBlocked } from "../src/verbs.ts";
import { HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";
import { PARENTS, memoryKv } from "./memory.ts";

const ask = (overrides: Partial<Ask> = {}): Ask => ({
  id: "ask_1",
  threadId: "child",
  askedBy: "child",
  projectId: "proj_1",
  question: "Which one?",
  options: [],
  optionsOnly: false,
  risk: null,
  proofs: [],
  context: null,
  createdAt: NOW - HOUR,
  status: "open",
  answer: null,
  deliveredAt: null,
  withdrawnAt: null,
  closed: null,
  capability: null,
  ...overrides,
});

/** A thread under Main as a verb reads it, with what it carries. */
function line(overrides: Partial<ThreadFacts> = {}, act: Activity = activity({ turn: { phase: "completed", at: NOW - HOUR, failed: false } }), extra: { asks?: Ask[]; dismissed?: number; park?: ReturnType<typeof parkNow> } = {}) {
  const threads = [thread({ id: "main" }), thread({ id: "w", parentThreadId: "main", ...overrides })];
  const found = lineOf(threads, "w", (t) => derive(t, act, NOW, extra.park ?? null, null, extra.dismissed ?? null, { seenSeq: null }, { asks: extra.asks ?? [], brief: null }), NOW);
  assert.ok(found);
  return found;
}

const refusal = { id: "call_1", kind: "command" as const, what: "npm publish", cwd: null, change: null, diff: null, why: "refused", at: NOW - HOUR, seq: 7 };
const personTurn = { last: { seq: 9, at: NOW - HOUR }, toPerson: { seq: 9, at: NOW - HOUR }, personSpokeSeq: 5, personSpokeAt: NOW - 2 * HOUR };
const agentTurn = { last: { seq: 9, at: NOW - HOUR }, toPerson: null, personSpokeSeq: null, personSpokeAt: null };

test("a park leaves a trace only when the thread waited on the person at that moment", () => {
  // Waited on nothing: done, idle, running.
  assert.deepEqual(parkWaitedOn(line()), []);
  assert.deepEqual(parkWaitedOn(line({ status: "active" })), []);
  // An agent's own turn ended in a reply: not the person's to read.
  assert.deepEqual(parkWaitedOn(line({}, activity({ replies: agentTurn }))), []);
  // Each thing that waits on the person.
  assert.deepEqual(parkWaitedOn(line({}, undefined, { asks: [ask({ threadId: "w" })] })), ["an open ask"]);
  assert.deepEqual(parkWaitedOn(line({ hasPendingInteraction: true }, activity({ ask: { kind: "question", text: "Go?", at: NOW - MINUTE } }))), ["a question or permission request of bb's"]);
  assert.deepEqual(parkWaitedOn(line({}, activity({ refusals: [refusal] }))), ["a permission bb refused"]);
  // Dismissed, the refusal no longer waits.
  assert.deepEqual(parkWaitedOn(line({}, activity({ refusals: [refusal] }), { dismissed: 7 })), []);
  assert.deepEqual(parkWaitedOn(line({ status: "error" })), ["a failure"]);
  assert.deepEqual(parkWaitedOn(line({}, activity({ replies: personTurn }))), ["a reply to you not yet seen"]);
  // Already parked: what it waited on was set aside already; its open ask still waits.
  const parked = parkNow("later", { kind: "none" }, NOW - HOUR);
  assert.deepEqual(parkWaitedOn(line({ status: "error" }, undefined, { park: parked })), []);
  assert.deepEqual(parkWaitedOn(line({}, undefined, { park: parked, asks: [ask({ threadId: "w" })] })), ["an open ask"]);
});

test("closing an ask as answered leaves a trace when an agent closes it and the person has not written since it asked", () => {
  const open = ask();
  assert.equal(closeLeavesTrace(open, "child", null), true);
  assert.equal(closeLeavesTrace(open, "child", open.createdAt - MINUTE), true);
  // The person wrote after it asked: the ordinary case, quiet.
  assert.equal(closeLeavesTrace(open, "child", open.createdAt + MINUTE), false);
  // That message was cow delivering an answer to another ask: not the person writing.
  assert.equal(closeLeavesTrace(open, "child", open.createdAt + MINUTE, [open.createdAt + MINUTE + 2000]), true);
  // The person, from a terminal, leaves none.
  assert.equal(closeLeavesTrace(open, null, null), false);
});

test("a trace says who did it, to what, and what it claimed", () => {
  const titleOf = (id: string) => ({ main: "Main", child: "Worker", w: "Writer" })[id] ?? id;
  const base: Omit<TraceInput, "askId"> = { action: "parked", actorThreadId: "main", threadId: "w", question: null, claim: "not needed  now", waited: ["an open ask", "a failure"] };
  assert.equal(traceText(base, titleOf), "“Main” parked “Writer”, which was waiting on you for an open ask, a failure · its reason: not needed now");
  assert.equal(traceText({ ...base, actorThreadId: "w" }, titleOf), "“Writer” parked itself, which was waiting on you for an open ask, a failure · its reason: not needed now");
  assert.equal(traceText({ ...base, action: "withdrew", actorThreadId: "child", threadId: "child", question: "Which one?", claim: null }, titleOf), "“Worker” withdrew its ask: Which one?");
  assert.equal(traceText({ ...base, action: "withdrew", threadId: "child", question: "Which one?", claim: null }, titleOf), "“Main” withdrew an ask of “Worker”: Which one?");
  assert.equal(
    traceText({ ...base, action: "closed", actorThreadId: "child", threadId: "child", question: "Which one?", claim: "the second" }, titleOf),
    "“Worker” closed its ask as answered in chat, though you have not written to it since it asked: Which one? · the answer it says you gave: the second",
  );
});

/** The asks service, with when the person last wrote to each thread and the traces it records. */
function asksWorld() {
  const clock = { now: NOW };
  let ids = 0;
  const spoke = new Map<string, number>();
  const traces: TraceInput[] = [];
  const deps: AskDeps = {
    kv: memoryKv(),
    now: () => clock.now,
    newId: () => `t${(ids += 1)}`,
    thread: async (threadId) => (threadId in PARENTS ? { projectId: "proj_1" } : null),
    ancestors: async (threadId) => {
      const above: string[] = [];
      for (let at = PARENTS[threadId] ?? null; at !== null; at = PARENTS[at] ?? null) above.push(at);
      return above;
    },
    storageRoot: async (threadId) => `/storage/${threadId}`,
    send: async () => undefined,
    changed: () => undefined,
    spokeAt: async (threadId) => spoke.get(threadId) ?? null,
    traced: async (input) => void traces.push(input),
  };
  const asks = createAsks(deps);
  const raise = (caller = "child") => asks.ask({ caller, threadId: null, question: `Q${ids + 1}?`, options: [], optionsOnly: false, risk: null, proofs: [], context: null });
  return { asks, raise, spoke, traces, clock };
}

test("an agent's withdrawal leaves a trace; the person's, from a terminal, does not", async () => {
  const { asks, raise, traces } = asksWorld();
  const own = await raise();
  await asks.withdraw("child", own.id);
  assert.deepEqual(traces, [{ action: "withdrew", actorThreadId: "child", threadId: "child", askId: own.id, question: own.question, claim: null, waited: [] }]);
  // A thread above it withdraws it: the trace names who did it.
  const second = await raise();
  await asks.withdraw("main", second.id);
  assert.equal(traces[1]!.actorThreadId, "main");
  const third = await raise();
  await asks.withdraw(null, third.id);
  assert.equal(traces.length, 2);
  // A refused withdrawal leaves nothing.
  await assert.rejects(asks.withdraw("other", (await raise()).id));
  assert.equal(traces.length, 2);
});

test("closing as answered leaves a trace only when the person has not written since it asked; the person's own close never", async () => {
  const { asks, raise, spoke, traces, clock } = asksWorld();
  const quiet = await raise();
  clock.now += MINUTE;
  await asks.close(quiet.id, { caller: "child", answer: "the second" });
  assert.deepEqual(traces, [{ action: "closed", actorThreadId: "child", threadId: "child", askId: quiet.id, question: quiet.question, claim: "the second", waited: [] }]);
  // The person wrote to the thread after it asked: the ordinary case.
  const answered = await raise();
  clock.now += MINUTE;
  spoke.set("child", clock.now);
  clock.now += MINUTE;
  await asks.close(answered.id, { caller: "child", answer: "yes" });
  assert.equal(traces.length, 1);
  // The person closes one on the page, or from a terminal: no trace.
  const third = await raise();
  await asks.close(third.id, { person: true });
  const fourth = await raise();
  await asks.close(fourth.id, { caller: null, answer: "yes" });
  assert.equal(traces.length, 1);
});

test("a trace is logged and raised as a notice until acknowledged; the acknowledgement is logged", async () => {
  const kv = memoryKv();
  const clock = { now: NOW };
  let ids = 0;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const log = createLogStore({ kv, now: () => (clock.now += 1), hash: sha });
  const caps = createCaps({
    kv,
    now: () => (clock.now += 1),
    newId: () => `t${(ids += 1)}`,
    log,
    places: async () => ({ home: "/Users/pat", dataDir: "/Users/pat/.bb" }),
    thread: async (threadId) => (threadId in PARENTS ? { title: threadId.toUpperCase() } : null),
    ancestors: async () => [],
    changedPaths: async () => [],
    resolve: async () => null,
    decide: async () => undefined,
    interaction: async () => ({ status: "gone" }),
    changed: () => undefined,
    warn: () => undefined,
  });
  const notice = await caps.trace({ action: "parked", actorThreadId: "main", threadId: "child", askId: null, question: null, claim: "later", waited: ["an open ask"] });
  assert.equal(notice.kind, "trace");
  assert.equal(notice.threadId, "child");
  assert.equal(notice.text, "“MAIN” parked “CHILD”, which was waiting on you for an open ask · its reason: later");
  assert.deepEqual(notice.trace, { action: "parked", actorThreadId: "main", askId: null });
  assert.deepEqual((await caps.state()).notices.map((n) => n.id), [notice.id]);
  const before = await caps.log();
  assert.equal(before.entries[0]!.event.kind, "trace");
  assert.equal(before.entries[0]!.by, null);
  assert.equal(eventText(before.entries[0]!.event, (id) => id), notice.text);
  await caps.acknowledge(notice.id, "aaaa-bbbb");
  assert.deepEqual((await caps.state()).notices, []);
  const after = await caps.log();
  assert.equal(after.entries[0]!.event.kind, "acknowledged");
  assert.equal(after.entries[0]!.by, "aaaa-bbbb");
  assert.equal(after.check.intact, true);
  // Gone once acknowledged: it cannot be acknowledged again.
  await assert.rejects(caps.acknowledge(notice.id, "aaaa-bbbb"));
});

test("status lists the traces not acknowledged under a heading of their own, and nothing when there are none", () => {
  const report = {
    main: { id: "main", title: "Main", state: "idle", label: "idle", inStateMs: 0, inState: "0m", doing: "", next: "", note: null, todo: [], under: null, project: true, depth: 0, queue: null },
    queue: [],
    threads: [],
    parked: [],
    settle: [],
    kept: [],
    archived: [],
    automations: [],
    outside: [],
    outsideNotListed: { byPlugins: 0, otherMains: 0 },
    omitted: { threads: 0, parked: 0, settle: 0, kept: 0, archived: 0, automations: 0, outside: 0, queue: 0 },
    truncated: false,
  } as unknown as Parameters<typeof statusText>[0];
  assert.doesNotMatch(statusText(report), /Taken out of the user's queue/);
  const text = statusText({ ...report, traces: [{ id: "note_1", threadId: "w", actorThreadId: "main", action: "withdrew", text: "“Main” withdrew an ask of “W”: Q?", at: NOW }] });
  assert.match(text, /Taken out of the user's queue by an agent, not yet acknowledged by the user \(1\)\n    “Main” withdrew an ask of “W”: Q\? \(note_1\)/);
});

test("an agent can archive a finished worker whose report it started; a reply the person started and has not seen still refuses", () => {
  // The worker's last turn was started by an agent (spawned, or told by its parent): its report is not the person's.
  const report = line({}, activity({ turn: { phase: "completed", at: NOW - HOUR, failed: false }, replies: agentTurn }));
  assert.equal(report.derived.state, "done");
  assert.equal(verbBlocked("archive", report, false), null);
  // The person started the turn, and has not seen its reply: it is addressed to them.
  const theirs = line({}, activity({ turn: { phase: "completed", at: NOW - HOUR, failed: false }, replies: personTurn }));
  assert.equal(theirs.derived.waitingOnYou, true);
  assert.notEqual(verbBlocked("archive", theirs, false), null);
});
