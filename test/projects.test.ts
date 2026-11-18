import assert from "node:assert/strict";
import { test } from "node:test";
import { cowCli } from "../src/cli.ts";
import { type Attention, LIMITS, atRest, derive, isSettling } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { buildOverview, lineOf, projectIds } from "../src/tree.ts";
import { undoShort, undoText } from "../src/undo.ts";
import { verbBlocked } from "../src/verbs.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

const project: Attention = { head: true, project: true, seenSeq: null };
const done = (at: number) => ({ phase: "completed" as const, at, failed: false });
const replies = (seq: number, at: number) => ({ last: { seq, at }, toPerson: null, personSpokeSeq: null });

test("a project is Main, a thread that has or has had threads under it, or a marked one", () => {
  const threads = [
    thread({ id: "main" }),
    thread({ id: "head", parentThreadId: "main" }),
    thread({ id: "kid", parentThreadId: "head" }),
    thread({ id: "had", parentThreadId: "main" }),
    thread({ id: "gone", parentThreadId: "had", archivedAt: NOW - 9 * DAY }),
    thread({ id: "marked", parentThreadId: "main" }),
    thread({ id: "worker", parentThreadId: "main" }),
  ];
  assert.deepEqual([...projectIds(threads, ["marked"], "main")].sort(), ["had", "head", "main", "marked"]);
  assert.deepEqual([...projectIds(threads, [], null)].sort(), ["had", "head", "main"]);
});

test("a project that finished a turn replied to you; once seen it is idle, never done", () => {
  const t = thread({ id: "p", parentThreadId: "main" });
  const finished = activity({ output: "All set.", turn: done(NOW - HOUR), replies: replies(9, NOW - HOUR) });
  const unseen = derive(t, finished, NOW, null, null, null, project);
  assert.equal(unseen.state, "wants");
  assert.equal(unseen.doing, "replied to you: All set.");
  assert.deepEqual(unseen.reply, { seq: 9 });
  const seen = derive(t, finished, NOW, null, null, null, { ...project, seenSeq: 9 });
  assert.deepEqual(seen, { state: "idle", since: NOW - HOUR, doing: "All set.", next: "", waitingOnYou: false });
  // The same thread, not a project: a worker that reported to its parent.
  assert.equal(derive(t, finished, NOW, null, null, null, { head: false, seenSeq: null }).state, "done");
  assert.equal(derive(t, finished, NOW).state, "done");
  // With nothing known of what it said, it is quiet.
  assert.equal(derive(t, undefined, NOW, null, null, null, { ...project, seenSeq: 9 }).doing, "quiet");
  assert.equal(atRest("idle") && atRest("done") && !atRest("running") && !atRest("wants"), true);
});

test("everything else still happens to a project: running, stuck, asking, failed, parked, archived", () => {
  const t = thread({ id: "p", parentThreadId: "main" });
  assert.equal(derive({ ...t, status: "active" }, activity({ lastEventAt: NOW - MINUTE }), NOW, null, null, null, project).state, "running");
  assert.equal(derive({ ...t, status: "active", latestAttentionAt: NOW - 4 * HOUR }, activity({ lastEventAt: NOW - 3 * HOUR }), NOW, null, null, null, project).state, "stuck");
  assert.equal(derive({ ...t, hasPendingInteraction: true }, undefined, NOW, null, null, null, project).state, "wants");
  assert.equal(derive({ ...t, status: "error" }, undefined, NOW, null, null, null, project).state, "failed");
  const parked = derive(t, undefined, NOW, { at: NOW - DAY, reason: "later", pickUp: { kind: "none" }, checkedAt: NOW - DAY }, null, null, project);
  assert.equal(parked.state, "parked");
  // Archiving is the person saying it is finished.
  const archived = derive({ ...t, archivedAt: NOW - HOUR }, undefined, NOW, null, "shipped", null, project);
  assert.equal(archived.state, "done");
  assert.equal(archived.archivedWhy, "shipped");
});

test("Main with no parent is idle once its reply is read", () => {
  const main = thread({ id: "main", lastReadAt: NOW - HOUR, latestAttentionAt: NOW - 2 * HOUR });
  assert.equal(derive(main, undefined, NOW, null, null, null, project).state, "idle");
  assert.equal(derive({ ...main, lastReadAt: null }, undefined, NOW, null, null, null, project).state, "wants");
});

function page(marked: readonly string[], threads = [
  thread({ id: "main", createdAt: 1 }),
  thread({ id: "head", parentThreadId: "main", createdAt: 2 }),
  thread({ id: "kid", parentThreadId: "head", createdAt: 3 }),
  thread({ id: "marked", parentThreadId: "main", createdAt: 4 }),
  thread({ id: "worker", parentThreadId: "main", createdAt: 5 }),
]) {
  const projects = projectIds(threads, marked, "main");
  const deriveThread = (t: (typeof threads)[number]) => derive(t, undefined, NOW, null, null, null, { head: projects.has(t.id), project: projects.has(t.id), seenSeq: null });
  const overview = buildOverview(threads, "main", deriveThread, NOW, { note: () => null, todos: () => [], marked: (id) => marked.includes(id) });
  return { overview, threads, deriveThread };
}

test("an idle project keeps its place in the tree and never goes to Done; a finished worker does", () => {
  const { overview } = page(["marked"]);
  assert.deepEqual(overview.rows.map((row) => [row.id, row.kind === "line" ? row.line.derived.state : "todo", row.depth]), [
    ["head", "idle", 0],
    ["kid", "done", 1],
    ["marked", "idle", 0],
  ]);
  assert.deepEqual(overview.settle.map((line) => line.thread.id), ["worker"]);
  assert.equal(overview.main?.derived.state, "idle");
  assert.deepEqual([overview.counts.idle, overview.counts.done], [2, 2]);
  assert.deepEqual(overview.queue, []);
  const byId = new Map(overview.lines.map((line) => [line.thread.id, line]));
  assert.equal(byId.get("head")!.project, "head");
  assert.equal(byId.get("marked")!.project, "marked");
  assert.equal(byId.get("kid")!.project, null);
  // An idle project under a head is counted on the head as idle, not as open work.
  assert.equal(byId.get("head")!.openUnder, 0);
});

test("without the mark a quiet thread with nothing under it is done, as before", () => {
  const { overview } = page([]);
  assert.deepEqual(overview.rows.map((row) => row.id), ["head", "kid"]);
  assert.deepEqual(overview.settle.map((line) => line.thread.id).sort(), ["marked", "worker"]);
});

test("a group whose members finished long ago still shows its idle head; they go to To settle", () => {
  const { overview } = page([], [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "head", parentThreadId: "main", createdAt: 2, latestAttentionAt: NOW - 9 * DAY }),
    thread({ id: "old", parentThreadId: "head", createdAt: 3, latestAttentionAt: NOW - 9 * DAY }),
  ]);
  assert.deepEqual(overview.rows.map((row) => row.id), ["head"]);
  const head = overview.lines[0]!;
  assert.deepEqual([head.derived.state, head.rollup?.done, head.members], ["idle", 1, 0]);
  assert.deepEqual(overview.settle.map((line) => line.thread.id), ["old"]);
});

test("archiving a project still takes it out of the tree and lists it under Archived", () => {
  const { overview } = page(["marked"], [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "marked", parentThreadId: "main", createdAt: 2, archivedAt: NOW - HOUR }),
    thread({ id: "head", parentThreadId: "main", createdAt: 3, archivedAt: NOW - HOUR }),
    thread({ id: "kid", parentThreadId: "head", createdAt: 4, archivedAt: NOW - HOUR }),
  ]);
  assert.deepEqual(overview.rows, []);
  assert.deepEqual(overview.archived.map((line) => [line.thread.id, line.derived.state]).sort(), [["head", "done"], ["marked", "done"]]);
});

test("an idle project can be archived and parked; it cannot be answered or stopped", () => {
  const { threads, deriveThread } = page(["marked"]);
  const line = lineOf(threads, "marked", deriveThread, NOW)!;
  assert.equal(line.derived.state, "idle");
  assert.equal(verbBlocked("archive", line, false), null);
  assert.equal(verbBlocked("park", line, false), null);
  assert.equal(verbBlocked("answer", line, false), "it has not asked anything");
  assert.equal(verbBlocked("stop", line, false), "no turn is running");
  // A head whose members are at rest can be archived with them.
  assert.equal(verbBlocked("archive", lineOf(threads, "head", deriveThread, NOW)!, false), null);
});

test("status marks projects and gives idle as a state of its own", () => {
  const { overview } = page(["marked"]);
  const report = statusReport(overview, NOW, false);
  assert.equal(report.main.project, true);
  assert.deepEqual(report.threads.map((line) => [line.id, line.state, line.project]), [["head", "idle", true], ["kid", "done", false], ["marked", "idle", true]]);
  const text = statusText(report);
  assert.match(text, /^Main: main \(main\) · idle /);
  assert.match(text, /idle\s+2h  marked \(marked\) \[project\]  quiet/);
  assert.match(text, /idle\s+2h  head \(head\) \[project\]  quiet  \[under it: 1 done\]/);
  assert.match(text, /done\s+2h  worker \(worker\)  finished/);
});

test("a thread at rest whose newest known turn event is a start is still settling, and reads as running", () => {
  const t = thread({ id: "w", parentThreadId: "main" });
  const started = activity({ lastEventAt: NOW - 2000, turn: { phase: "started", at: NOW - 30_000, failed: false }, latestStep: "$ npm test", replies: replies(4, NOW - HOUR) });
  assert.equal(isSettling(t, started, NOW), true);
  const settling = derive(t, started, NOW, null, null, null, { head: true, seenSeq: null });
  // Not done for a moment, and not an older reply: it is as it was, running.
  assert.deepEqual([settling.state, settling.doing, settling.waitingOnYou], ["running", "$ npm test", false]);
  assert.equal(settling.since, NOW - 30_000);
  // The end is read: now it is what the turn came to.
  const ended = activity({ lastEventAt: NOW - 1000, turn: done(NOW - 1000), output: "ok", replies: replies(8, NOW - 1000) });
  assert.equal(isSettling(t, ended, NOW), false);
  assert.equal(derive(t, ended, NOW, null, null, null, { head: true, seenSeq: null }).doing, "replied to you: ok");
  // A turn whose end never comes is not waited on for ever.
  const stale = activity({ lastEventAt: NOW - LIMITS.settlingMs - 1000, turn: { phase: "started", at: NOW - HOUR, failed: false } });
  assert.equal(isSettling(t, stale, NOW), false);
  assert.equal(derive(t, stale, NOW).state, "done");
  // Running, failed, or nothing known: not settling.
  assert.equal(isSettling({ ...t, status: "active" }, started, NOW), false);
  assert.equal(isSettling({ ...t, status: "error" }, started, NOW), false);
  assert.equal(isSettling(t, undefined, NOW), false);
  // A question bb raised still shows while it settles.
  assert.equal(derive({ ...t, hasPendingInteraction: true }, started, NOW).state, "wants");
});

test("Main with no parent does not read as replied while its turn is settling", () => {
  const main = thread({ id: "main", lastReadAt: NOW - HOUR, latestAttentionAt: NOW - 1000 });
  const started = activity({ lastEventAt: NOW - 500, turn: { phase: "started", at: NOW - 20_000, failed: false } });
  assert.equal(derive(main, started, NOW, null, null, null, project).state, "running");
});

test("undo names a project mark and its removal", () => {
  assert.equal(undoShort({ kind: "project", threadId: "t", title: "T", before: null }), "undo project");
  assert.equal(undoShort({ kind: "project", threadId: "t", title: "T", before: { at: NOW, by: null } }), "undo unmark");
  assert.match(undoText({ kind: "project", threadId: "t", title: "T", before: null }), /undo marking “T” as a project/);
});

test("bb cow project marks and clears, and says which thread is asking", async () => {
  const calls: unknown[] = [];
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const cli = cowCli({
    archiveChecked: unused,
    parkChecked: unused,
    resumeChecked: unused,
    status: unused,
    nextChecked: unused,
    todoChecked: unused,
    waitChecked: unused,
    projectChecked: async (args) => (calls.push(args), { title: "T", project: args.on ? { at: NOW, by: args.callerId } : null }),
  });
  const command = cli.commands?.find((entry) => entry.name === "project");
  assert.ok(command);
  const run = (argv: string[], threadId: string | null) => cli.run(argv, { projectId: "proj_1", ...(threadId === null ? {} : { threadId }), signal: new AbortController().signal });
  const marked = await run(["project", "thr_a"], "thr_main");
  assert.equal(marked.exitCode, 0);
  assert.match(marked.stdout ?? "", /“T” \(thr_a\) is marked as a project/);
  const cleared = await run(["project", "thr_a", "--clear", "--json"], null);
  assert.deepEqual(JSON.parse(cleared.stdout ?? ""), { ok: true, threadId: "thr_a", title: "T", project: false });
  assert.deepEqual(calls, [
    { callerId: "thr_main", threadId: "thr_a", on: true },
    { callerId: null, threadId: "thr_a", on: false },
  ]);
});
