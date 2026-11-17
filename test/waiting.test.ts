import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import type { BriefMark } from "../src/briefs/review.ts";
import { cowCli, type CliActions } from "../src/cli.ts";
import type { WaitNote } from "../src/shared.ts";
import { type Activity, type Attention, type ThreadFacts, derive, waitingSince } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { buildOverview } from "../src/tree.ts";
import { undoShort, undoText } from "../src/undo.ts";
import { verbBlocked } from "../src/verbs.ts";
import { parseRemind, waitHolds, waitNote } from "../src/waiting.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

const note = (overrides: Partial<WaitNote> = {}): WaitNote => ({ on: "the reviewer", for: null, remindAt: null, at: NOW - 3 * DAY, by: null, ...overrides });

/** A worker under Main that finished a turn three days ago and a half, before the note was set. */
const child = (overrides: Partial<ThreadFacts> = {}): ThreadFacts => thread({ id: "t", parentThreadId: "main", latestAttentionAt: NOW - 3.5 * DAY, ...overrides });
const rested = (overrides: Partial<Activity> = {}): Activity =>
  activity({ turn: { phase: "completed", at: NOW - 3.5 * DAY, failed: false }, startedAt: NOW - 3.6 * DAY, ...overrides });
/** Its last turn was the person's, so its reply is theirs to read. */
const replied = (): Activity =>
  rested({ output: "Opened the pull request; waiting on review.", replies: { last: { seq: 9, at: NOW - 3.5 * DAY }, toPerson: { seq: 9, at: NOW - 3.5 * DAY }, personSpokeSeq: 2 } });
const attention: Attention = { head: false, seenSeq: null };

const ask = (): Ask => ({
  id: "ask_1", threadId: "t", askedBy: "t", projectId: "proj_test", question: "Which branch?", options: [], optionsOnly: false, risk: null, proofs: [], context: null,
  createdAt: NOW - HOUR, status: "open", answer: null, deliveredAt: null, withdrawnAt: null, closed: null, capability: null,
});
const disputed: BriefMark = { version: 1, state: "checked", contradicted: 1, notEstablished: 0, judgementCalls: 0, at: NOW - 3.5 * DAY, read: false };

test("a thread waiting on someone else reads waiting, says on whom and for how long, and is not the person's", () => {
  const d = derive(child(), rested(), NOW, null, null, null, attention, null, note());
  assert.equal(d.state, "waiting");
  assert.equal(d.doing, "waiting on the reviewer · 3d");
  assert.equal(d.since, NOW - 3 * DAY);
  assert.equal(d.waitingOnYou, false);
  assert.deepEqual(d.wait, { note: note(), due: false });
  const needed = derive(child(), rested(), NOW, null, null, null, attention, null, note({ for: "an approving review" }));
  assert.equal(needed.doing, "waiting on the reviewer: an approving review · 3d");
});

test("waiting outranks a reply addressed to the person, idle and done", () => {
  assert.equal(derive(child(), replied(), NOW, null, null, null, attention).state, "wants");
  assert.equal(derive(child(), replied(), NOW, null, null, null, attention, null, note()).state, "waiting");
  // A project with nothing to say would read idle.
  assert.equal(derive(child(), rested(), NOW, null, null, null, { head: true, project: true, seenSeq: null }, null, note()).state, "waiting");
  assert.equal(derive(child(), rested(), NOW).state, "done");
  assert.equal(derive(child(), rested(), NOW, null, null, null, null, null, note()).state, "waiting");
  // Main's own unread reply, which bb keeps.
  const main = thread({ id: "main", lastReadAt: NOW - 4 * DAY, latestAttentionAt: NOW - 3.5 * DAY });
  assert.equal(derive(main, rested(), NOW).state, "wants");
  assert.equal(derive(main, rested(), NOW, null, null, null, null, null, note()).state, "waiting");
});

test("waiting gives way to what really needs the person, and to a turn in progress", () => {
  const w = note();
  // An open ask.
  assert.equal(derive(child(), rested(), NOW, null, null, null, attention, { asks: [ask()], brief: null }, w).state, "wants");
  // A question or permission request bb holds a turn for.
  assert.equal(derive(child({ hasPendingInteraction: true }), rested(), NOW, null, null, null, attention, null, w).state, "wants");
  // A permission bb refused.
  const refusal = { id: "call_1", kind: "command" as const, what: "npm publish", cwd: null, change: null, diff: null, why: "refused", at: NOW - HOUR, seq: 7 };
  assert.equal(derive(child(), rested({ refusals: [refusal] }), NOW, null, null, null, attention, null, w).state, "blocked");
  // A failed turn.
  assert.equal(derive(child({ status: "error" }), rested(), NOW, null, null, null, attention, null, w).state, "failed");
  // A brief with disputes, or with a judgement call.
  assert.equal(derive(child(), rested(), NOW, null, null, null, attention, { asks: [], brief: disputed }, w).state, "wants");
  assert.equal(derive(child(), rested(), NOW, null, null, null, attention, { asks: [], brief: { ...disputed, contradicted: 0, judgementCalls: 1 } }, w).state, "wants");
  // A brief that waits on nothing does not.
  assert.equal(derive(child(), rested(), NOW, null, null, null, attention, { asks: [], brief: { ...disputed, contradicted: 0 } }, w).state, "waiting");
  // A decision made outside cow.
  assert.equal(derive(child(), rested(), NOW, null, null, null, attention, { asks: [], brief: null, outside: [{ id: "n", text: "approved outside cow: run: ls", at: NOW - HOUR }] }, w).state, "wants");
  // Parked and archived lines are the person's choice, and say so.
  assert.equal(derive(child(), rested(), NOW, { at: NOW - DAY, reason: "later", pickUp: { kind: "none" }, checkedAt: NOW - DAY }, null, null, attention, null, w).state, "parked");
  assert.equal(derive(child({ archivedAt: NOW - HOUR }), rested(), NOW, null, null, null, attention, null, w).state, "done");
  // The agent set it during its own turn, which is still running: running, until it ends.
  const own = rested({ turn: { phase: "started", at: NOW - 3.1 * DAY, failed: false }, startedAt: NOW - 3.1 * DAY, lastEventAt: NOW - MINUTE });
  assert.equal(derive(child({ status: "active" }), own, NOW, null, null, null, attention, null, w).state, "running");
});

test("a turn that started after the note clears it, whoever started it; one that started before keeps it", () => {
  const w = note();
  assert.equal(waitHolds(w, NOW - 3.6 * DAY), true);
  assert.equal(waitHolds(w, null), true);
  assert.equal(waitHolds(w, w.at), true);
  assert.equal(waitHolds(w, NOW - DAY), false);
  // Its new turn is running.
  const running = rested({ turn: { phase: "started", at: NOW - 10 * MINUTE, failed: false }, startedAt: NOW - 10 * MINUTE, lastEventAt: NOW - MINUTE });
  const busy = derive(child({ status: "active" }), running, NOW, null, null, null, attention, null, w);
  assert.equal(busy.state, "running");
  assert.equal(busy.wait, undefined);
  // It has ended: what it said is read as any reply is, and the note is gone.
  const after = rested({ turn: { phase: "completed", at: NOW - MINUTE, failed: false }, startedAt: NOW - 10 * MINUTE, replies: { last: { seq: 20, at: NOW - MINUTE }, toPerson: { seq: 20, at: NOW - MINUTE }, personSpokeSeq: 18 } });
  const d = derive(child(), after, NOW, null, null, null, attention, null, w);
  assert.equal(d.state, "wants");
  assert.equal(d.wait, undefined);
  // Set again after that turn, it holds again.
  assert.equal(derive(child(), after, NOW, null, null, null, attention, null, note({ at: NOW - 30_000 })).state, "waiting");
});

test("a reminder that arrives puts the line in the queue; until then it stays out", () => {
  const remindAt = NOW - HOUR;
  const due = derive(child(), rested(), NOW, null, null, null, attention, null, note({ remindAt }));
  assert.equal(due.state, "waiting");
  assert.equal(due.waitingOnYou, true);
  assert.equal(due.doing, "still waiting on the reviewer after 3 days");
  assert.equal(due.next, "keep waiting, or take it back: press a");
  assert.equal(waitingSince(due), remindAt);
  assert.equal(verbBlocked("answer", { thread: child(), derived: due } as never, false), null);
  const before = derive(child(), rested(), NOW, null, null, null, attention, null, note({ remindAt: NOW + DAY }));
  assert.equal(before.waitingOnYou, false);
  assert.match(before.next, /^reminds you /);
  assert.equal(verbBlocked("answer", { thread: child(), derived: before } as never, false), "it has not asked anything");
  // Without a reminder it never comes back for this reason, however long it waits.
  assert.equal(derive(child(), rested(), NOW + 60 * DAY, null, null, null, attention, null, note()).waitingOnYou, false);
});

test("in the overview a waiting line keeps its place in the tree and is in the queue only when its reminder came", () => {
  const threads = [thread({ id: "main", createdAt: 1 }), child({ createdAt: 2 }), thread({ id: "u", parentThreadId: "main", createdAt: 3, latestAttentionAt: NOW - HOUR })];
  const of = (wait: WaitNote | null) =>
    buildOverview(threads, "main", (t) => derive(t, rested(), NOW, null, null, null, attention, null, t.id === "t" ? wait : null), NOW);
  const waiting = of(note());
  assert.deepEqual(waiting.lines.map((line) => line.thread.id), ["t"]);
  assert.deepEqual(waiting.done.map((line) => line.thread.id), ["u"]);
  assert.equal(waiting.queue.some((line) => line.thread.id === "t"), false);
  assert.equal(waiting.counts.waiting, 1);
  const due = of(note({ remindAt: NOW - HOUR }));
  assert.deepEqual(due.queue.map((line) => line.thread.id), ["t"]);
  // Cleared, it goes where its state puts it: done three days ago, so only counted.
  assert.deepEqual(of(null).lines, []);
  assert.equal(of(null).olderDone, 1);
  // bb cow status says so.
  const text = statusText(statusReport(waiting, NOW, false));
  assert.match(text, /waiting\s+3d\s+t \(t\)\s+waiting on the reviewer · 3d/);
  assert.match(statusText(statusReport(due, NOW, false)), /still waiting on the reviewer after 3 days/);
});

test("a waiting line can be archived, and parked", () => {
  const derived = derive(child(), rested(), NOW, null, null, null, attention, null, note());
  const line = { thread: child(), derived, openUnder: 0 } as never;
  assert.equal(verbBlocked("archive", line, false), null);
  assert.equal(verbBlocked("park", line, false), null);
});

test("what is typed for a wait: who or what, what for, and a reminder read as a pick-up is, but never a condition", () => {
  const made = waitNote({ on: "  on CI ", for: " a green run ", remind: "+3d" }, NOW, "thr_me");
  assert.deepEqual(made, { ok: true, note: { on: "CI", for: "a green run", remindAt: NOW + 3 * DAY, at: NOW, by: "thr_me" } });
  assert.deepEqual(waitNote({ on: "the reviewer", for: null, remind: "" }, NOW, null), { ok: true, note: { on: "the reviewer", for: null, remindAt: null, at: NOW, by: null } });
  assert.equal(waitNote({ on: " ", for: null, remind: "" }, NOW, null).ok, false);
  assert.equal(waitNote({ on: "x".repeat(81), for: null, remind: "" }, NOW, null).ok, false);
  assert.deepEqual(parseRemind("when the review lands", NOW), { ok: false, error: "a reminder is a day: 19 Nov, +3d or +2w, or nothing for none" });
  assert.equal(parseRemind("+0d", NOW).ok, false);
  assert.equal(parseRemind("31 Feb 2030", NOW).ok, false);
});

test("undo says what taking a wait back does", () => {
  assert.equal(undoText({ kind: "wait", threadId: "t", title: "T", before: null }), "undo marking “T” as waiting: it reads as it did before");
  assert.equal(undoText({ kind: "wait", threadId: "t", title: "T", before: note() }), "undo: “T” waits on the reviewer again, as before");
  assert.equal(undoShort({ kind: "wait", threadId: "t", title: "T", before: null }), "undo wait");
});

test("bb cow wait sets and clears, with the calling thread, and refuses half an instruction", async () => {
  const calls: unknown[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const actions: CliActions = {
    archiveChecked: unused, parkChecked: unused, resumeChecked: unused, status: unused, nextChecked: unused, todoChecked: unused, projectChecked: unused,
    waitChecked: async (args) => (calls.push(args), { title: "T", wait: args.wait === null ? null : { on: args.wait.on, for: args.wait.for, remindAt: args.wait.remind ? NOW + 3 * DAY : null, at: NOW, by: args.callerId } }),
  };
  const cli = cowCli(actions);
  const run = (...argv: string[]) => cli.run(argv, { projectId: "proj_1", threadId: "thr_me", signal: new AbortController().signal });
  const set = await run("wait", "thr_a", "--on", "the reviewer", "--for", "a review", "--remind", "+3d");
  assert.equal(set.exitCode, 0);
  assert.match(set.stdout ?? "", /^“T” \(thr_a\) is waiting on the reviewer: a review · the user is reminded .+ · it clears when the thread starts a new turn\n$/);
  const cleared = await run("wait", "thr_a", "--clear", "--json");
  assert.deepEqual(JSON.parse(cleared.stdout ?? ""), { ok: true, threadId: "thr_a", title: "T", wait: null });
  assert.deepEqual(calls, [
    { callerId: "thr_me", threadId: "thr_a", wait: { on: "the reviewer", for: "a review", remind: "+3d" } },
    { callerId: "thr_me", threadId: "thr_a", wait: null },
  ]);
  assert.equal((await run("wait", "thr_a")).exitCode, 1);
  assert.equal((await run("wait", "thr_a", "--on", "CI", "--clear")).exitCode, 1);
  assert.equal((await run("wait", "thr_a", "--clear", "--remind", "+3d")).exitCode, 1);
  assert.equal(calls.length, 2);
});

test("a line the person marked seen stays in its place, marked kept, until the page lets it go", () => {
  const threads = [thread({ id: "main", createdAt: 1 }), child({ createdAt: 2 }), thread({ id: "g", parentThreadId: "main", createdAt: 3, latestAttentionAt: NOW - HOUR }), thread({ id: "g1", parentThreadId: "g", createdAt: 4, latestAttentionAt: NOW - HOUR })];
  const of = (kept: ReadonlySet<string>, archived = false) =>
    buildOverview(
      archived ? threads.map((t) => (t.id === "t" ? { ...t, archivedAt: NOW - MINUTE } : t)) : threads,
      "main",
      (t) => derive(t, rested(), NOW),
      NOW,
      { note: () => null, todos: () => [], kept: (id) => kept.has(id) },
    );
  const plain = of(new Set());
  assert.deepEqual(plain.lines.map((line) => line.thread.id), []);
  const kept = of(new Set(["t"]));
  assert.deepEqual(kept.lines.map((line) => [line.thread.id, line.derived.state, line.kept]), [["t", "done", true]]);
  assert.deepEqual(kept.done.map((line) => line.thread.id), ["g"]);
  // The state, and so the queue and the counts, are the stored ones.
  assert.equal(kept.queue.length, 0);
  // A member kept inside a group that finished keeps the group in the tree with it.
  const member = of(new Set(["g1"]));
  assert.deepEqual(member.lines.map((line) => [line.thread.id, line.kept ?? false]), [["g", false], ["g1", true]]);
  // Archived, it goes to Done whatever the page kept.
  assert.deepEqual(of(new Set(["t"]), true).lines.map((line) => line.thread.id), []);
});
