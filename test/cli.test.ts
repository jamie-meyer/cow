import assert from "node:assert/strict";
import { test } from "node:test";
import { CowError } from "../src/actions.ts";
import { type CliActions, cowCli } from "../src/cli.ts";
import { derive } from "../src/state.ts";
import { type StatusReport, statusReport, statusText } from "../src/status.ts";
import { buildOverview, lineOf } from "../src/tree.ts";
import { verbBlocked } from "../src/verbs.ts";
import { DAY, HOUR, NOW, activity, thread } from "./fixtures.ts";

const EMPTY_REPORT: StatusReport = {
  main: { id: "main", title: "Main", state: "done", label: "done", inStateMs: 0, inState: "1m", doing: "", next: "", note: null, todo: [], under: null, project: true, depth: 0, queue: null },
  queue: [],
  threads: [],
  parked: [],
  done: [],
  omitted: { threads: 0, parked: 0, done: 0, queue: 0, olderDone: 0 },
  truncated: false,
};

/** Actions that record what they were asked to do. */
function recorder(overrides: Partial<CliActions> = {}) {
  const calls: unknown[][] = [];
  const actions: CliActions = {
    archiveChecked: async (...args) => (calls.push(["archive", ...args]), { title: "T", under: 0 }),
    parkChecked: async (args) => (
      calls.push(["park", args]),
      { title: "T", kept: false, record: { at: NOW, reason: args.reason, pickUp: { kind: "none" }, checkedAt: NOW } }
    ),
    resumeChecked: async (...args) => (calls.push(["resume", ...args]), { title: "T" }),
    status: async (...args) => (calls.push(["status", ...args]), EMPTY_REPORT),
    nextChecked: async (args) => (
      calls.push(["next", args]),
      { title: "T", note: args.text === null ? null : { text: args.text, at: NOW, by: args.callerId } }
    ),
    projectChecked: async (args) => (calls.push(["project", args]), { title: "T", project: args.on ? { at: NOW, by: args.callerId } : null }),
    todoChecked: async (args) => (
      calls.push(["todo", args]),
      { title: "T", list: [{ id: "i1", title: "first", at: NOW }], item: args.op === null ? null : { id: "i1", title: "first", at: NOW } }
    ),
    ...overrides,
  };
  const cli = cowCli(actions);
  const run = (...argv: string[]) => cli.run(argv, { projectId: "proj_1", threadId: "thr_me", signal: new AbortController().signal });
  return { calls, run, cli };
}

test("archive takes a thread and an optional reason", async () => {
  const { calls, run } = recorder();
  const plain = await run("archive", "thr_a");
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.stdout, "archived “T” (thr_a)\n");
  const reasoned = await run("archive", "thr_a", "--reason", "merged  and done");
  assert.equal(reasoned.stdout, "archived “T” (thr_a): merged and done\n");
  assert.deepEqual(calls, [
    ["archive", "thr_a", null],
    ["archive", "thr_a", "merged and done"],
  ]);
});

test("archive says how many threads went with it", async () => {
  const { run } = recorder({ archiveChecked: async () => ({ title: "T", under: 2 }) });
  assert.equal((await run("archive", "thr_a")).stdout, "archived “T” (thr_a) with the 2 threads under it\n");
});

test("park needs a reason, and passes the pick-up through as typed", async () => {
  const { calls, run } = recorder();
  const missing = await run("park", "thr_a");
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /--reason/);
  const blank = await run("park", "thr_a", "--reason", "  ");
  assert.equal(blank.exitCode, 1);
  assert.match(blank.stderr ?? "", /a reason is needed/);
  assert.deepEqual(calls, []);

  const parked = await run("park", "thr_a", "--reason", "waiting on review", "--pickup", "+3d");
  assert.equal(parked.exitCode, 0);
  assert.match(parked.stdout ?? "", /^parked “T” \(thr_a\): waiting on review · /);
  await run("park", "thr_a", "--reason", "r", "--stop");
  assert.deepEqual(calls, [
    ["park", { threadId: "thr_a", reason: "waiting on review", pickUp: "+3d", stop: false }],
    ["park", { threadId: "thr_a", reason: "r", pickUp: "", stop: true }],
  ]);
});

test("a reason that is too long is refused before anything happens", async () => {
  const { calls, run } = recorder();
  const result = await run("park", "thr_a", "--reason", "x".repeat(301));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr ?? "", /under 300 characters/);
  assert.deepEqual(calls, []);
});

test("resume takes a thread", async () => {
  const { calls, run } = recorder();
  assert.equal((await run("resume", "thr_a")).stdout, "resumed “T” (thr_a): it is back in the tree\n");
  assert.deepEqual(calls, [["resume", "thr_a"]]);
});

test("a thread is required, and has to look like an id", async () => {
  const { calls, run } = recorder();
  for (const verb of ["archive", "resume"]) {
    const missing = await run(verb);
    assert.equal(missing.exitCode, 1, verb);
  }
  const bad = await run("resume", "not a thread");
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr ?? "", /is not a thread id/);
  assert.deepEqual(calls, []);
  await run("resume", "thread:thr_b");
  assert.deepEqual(calls, [["resume", "thr_b"]]);
});

test("status uses the caller's project unless a Main is named", async () => {
  const { calls, run } = recorder();
  const text = await run("status");
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout ?? "", /^Main: Main \(main\)/);
  const json = await run("status", "--main", "thr_m", "--json");
  assert.equal(JSON.parse(json.stdout ?? "").main.id, "main");
  assert.deepEqual(calls, [
    ["status", null, "proj_1"],
    ["status", "thr_m", "proj_1"],
  ]);
});

test("a rule's refusal exits non-zero with what is wrong, and as JSON when asked", async () => {
  const refuse = async () => {
    throw new CowError("cannot_archive", "cannot archive “T” (thr_a): threads under it are still open", "Archive those first.");
  };
  const { run } = recorder({ archiveChecked: refuse });
  const text = await run("archive", "thr_a");
  assert.equal(text.exitCode, 1);
  assert.match(text.stderr ?? "", /threads under it are still open/);
  const json = await run("archive", "thr_a", "--json");
  assert.equal(json.exitCode, 1);
  const body = JSON.parse(json.stdout ?? "");
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "cannot_archive");
});

test("help lists every command; an unknown command or option fails", async () => {
  const { run, cli } = recorder();
  const help = await run("help");
  assert.equal(help.exitCode, 0);
  for (const name of ["status", "archive", "park", "project", "resume", "next", "todo add", "todo done", "todo rm", "todo list"]) assert.match(help.stdout ?? "", new RegExp(`bb cow ${name}`));
  assert.deepEqual(cli.commands?.map((command) => command.name).sort(), ["archive", "next", "park", "project", "resume", "status", "todo-add", "todo-done", "todo-list", "todo-rm"]);
  assert.equal((await run("park", "--help")).exitCode, 0);
  assert.equal((await run("moo")).exitCode, 1);
  assert.equal((await run("resume", "thr_a", "--nope")).exitCode, 1);
});

// ---- what the commands print, and the rules they check --------------------

const park = { at: NOW - 15 * DAY, reason: "waiting on a review", pickUp: { kind: "none" as const }, checkedAt: NOW - 15 * DAY };
const THREADS = [
  thread({ id: "main" }),
  thread({ id: "a", parentThreadId: "main", status: "active", title: "build the thing" }),
  thread({ id: "a1", parentThreadId: "a", hasPendingInteraction: true }),
  thread({ id: "b", parentThreadId: "main" }),
  thread({ id: "c", parentThreadId: "main" }),
  thread({ id: "old", parentThreadId: "main", latestAttentionAt: NOW - 9 * DAY }),
];
const ACTIVITY = new Map([
  ["a", activity({ turn: { phase: "started", at: NOW - HOUR, failed: false }, lastEventAt: NOW, latestStep: "$ npm test" })],
  ["a1", activity({ ask: { kind: "question", text: "Which colour?", at: NOW - 5 * 60_000 } })],
  ["b", activity({ output: "all done" })],
]);
const deriveThread = (t: (typeof THREADS)[number]) => derive(t, ACTIVITY.get(t.id), NOW, t.id === "c" ? park : null);

test("status gives one line per thread, the queue, and the shelf", () => {
  const report = statusReport(buildOverview(THREADS, "main", deriveThread, NOW), NOW, false);
  assert.deepEqual(report.threads.map((line) => [line.id, line.state, line.depth]), [
    ["a", "running", 0],
    ["a1", "wants", 1],
  ]);
  assert.deepEqual(report.queue.map((line) => [line.id, line.doing, line.waiting]), [["a1", "Which colour?", "5m"]]);
  assert.deepEqual(report.parked.map((line) => [line.id, line.doing, line.inState]), [["c", "waiting on a review", "15d"]]);
  assert.deepEqual(report.done.map((line) => line.id), ["b"]);
  assert.equal(report.omitted.olderDone, 1);

  const text = statusText(report);
  assert.match(text, /^Main: main \(main\) · /);
  assert.match(text, /Waiting on the user \(1\)\n 1  a1 \(a1\)  Which colour\? · waiting 5m/);
  assert.match(text, /running\s+1h  build the thing \(a\) \[project\]  \$ npm test → finishes its turn/);
  assert.match(text, / 1  wants\s+5m    a1 \(a1\)  Which colour\?/);
  assert.match(text, /Parked \(1\)\n    parked\s+15d  c \(c\)  waiting on a review/);
  assert.match(text, /Done in the last 2 days \(1; 1 older, not listed\)/);
});

test("status is bounded: long lists are cut and counted, long text is shortened", () => {
  const many = [
    thread({ id: "main" }),
    ...Array.from({ length: 120 }, (_, index) =>
      thread({ id: `t${index}`, parentThreadId: "main", status: "active", title: "x".repeat(300) }),
    ),
  ];
  const report = statusReport(buildOverview(many, "main", (t) => derive(t, undefined, NOW), NOW), NOW, true);
  assert.equal(report.threads.length, 80);
  assert.equal(report.omitted.threads, 40);
  assert.ok(report.threads.every((line) => line.title.length <= 80));
  const text = statusText(report);
  assert.match(text, /Threads \(120\)/);
  assert.match(text, /… and 40 more, not listed/);
  assert.match(text, /bb has more threads than cow reads/);
  assert.ok(text.length < 40_000);
});

test("a thread named to a verb is judged by the page's rules", () => {
  const line = (id: string) => lineOf(THREADS, id, deriveThread, NOW);
  assert.equal(lineOf(THREADS, "missing", deriveThread, NOW), null);
  // Open threads under it: the page refuses to archive, and so does the CLI.
  assert.equal(line("a")!.openUnder, 1);
  assert.equal(verbBlocked("archive", line("a"), false), "threads under it are still open");
  assert.equal(verbBlocked("archive", line("b"), false), null);
  // Done long enough ago not to be listed on the page, it can still be archived.
  assert.equal(verbBlocked("archive", line("old"), false), null);
  assert.equal(verbBlocked("resume", line("b"), false), "it is not parked");
  assert.equal(verbBlocked("park", line("b"), false), null);
});

test("a parked thread named to a verb counts what is under it", () => {
  const threads = [...THREADS, thread({ id: "c1", parentThreadId: "c" })];
  const line = lineOf(threads, "c", (t) => derive(t, undefined, NOW, t.id === "c" ? park : null), NOW)!;
  assert.equal(line.derived.state, "parked");
  assert.equal(line.under, 1);
  assert.equal(verbBlocked("resume", line, false), null);
  assert.equal(verbBlocked("park", line, false), "it is already parked");
});

// ---- what is next -----------------------------------------------------------

test("next takes one line of text, or --clear, and says who is asking", async () => {
  const { calls, run } = recorder();
  const set = await run("next", "thr_a", "open the PR once CI is green");
  assert.equal(set.exitCode, 0);
  assert.equal(set.stdout, "next for “T” (thr_a): open the PR once CI is green\n");
  const cleared = await run("next", "thr_a", "--clear");
  assert.equal(cleared.stdout, "cleared what is next for “T” (thr_a)\n");
  assert.deepEqual(calls, [
    ["next", { callerId: "thr_me", threadId: "thr_a", text: "open the PR once CI is green" }],
    ["next", { callerId: "thr_me", threadId: "thr_a", text: null }],
  ]);
  assert.equal((await run("next", "thr_a")).exitCode, 1);
  assert.equal((await run("next", "thr_a", "text", "--clear")).exitCode, 1);
  assert.equal(calls.length, 2);
});

test("todo add, done, rm and list pass the thread, the caller and the change", async () => {
  const { calls, run } = recorder();
  assert.equal((await run("todo", "add", "thr_a", "write the migration")).stdout, "listed for “T” (thr_a), as item 1: first\n");
  assert.equal((await run("todo", "done", "thr_a", "1")).stdout, "started, and off the list: “first” for “T” (thr_a); 1 left\n");
  assert.equal((await run("todo", "rm", "thr_a", "2")).stdout, "removed “first” for “T” (thr_a); 1 left\n");
  assert.equal((await run("todo", "list", "thr_a")).stdout, "Not started for “T” (thr_a)\n  1  first\n");
  assert.deepEqual(calls, [
    ["todo", { callerId: "thr_me", threadId: "thr_a", op: { kind: "add", title: "write the migration" } }],
    ["todo", { callerId: "thr_me", threadId: "thr_a", op: { kind: "take", n: 1 } }],
    ["todo", { callerId: "thr_me", threadId: "thr_a", op: { kind: "take", n: 2 } }],
    ["todo", { callerId: "thr_me", threadId: "thr_a", op: null }],
  ]);
  const bad = await run("todo", "rm", "thr_a", "first");
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr ?? "", /not an item number/);
  const json = JSON.parse((await run("todo", "list", "thr_a", "--json")).stdout ?? "");
  assert.deepEqual(json.todo.map((item: { title: string }) => item.title), ["first"]);
});

test("a refusal to plan for a thread that is not yours exits non-zero and says why", async () => {
  const { run } = recorder({
    nextChecked: async () => {
      throw new CowError("not_yours", "cannot set this on “T” (thr_a): a thread sets this only for itself and for the threads under it");
    },
  });
  const refused = await run("next", "thr_a", "x", "--json");
  assert.equal(refused.exitCode, 1);
  assert.equal(JSON.parse(refused.stdout ?? "").error.code, "not_yours");
});

test("status shows a thread's own note, what it has not started, and what is under a group", () => {
  const threads = [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "proj", title: "Project", parentThreadId: "main", createdAt: 2 }),
    thread({ id: "w1", title: "Worker", parentThreadId: "proj", status: "active", createdAt: 3 }),
    thread({ id: "w2", title: "Asker", parentThreadId: "proj", hasPendingInteraction: true, createdAt: 4 }),
  ];
  const plans = {
    note: (id: string) => (id === "proj" ? "cut the release on Friday" : null),
    todos: (id: string) => (id === "proj" ? [{ id: "a", title: "write the changelog", at: NOW }] : []),
  };
  const overview = buildOverview(threads, "main", (t) => derive(t, undefined, NOW), NOW, plans);
  const report = statusReport(overview, NOW, false);
  const proj = report.threads[0]!;
  assert.equal(proj.note, "cut the release on Friday");
  assert.deepEqual(proj.todo, ["write the changelog"]);
  assert.deepEqual(proj.under, { wants: 1, running: 1 });
  assert.equal(report.threads[1]!.under, null);
  const text = statusText(report);
  assert.match(text, /Project \(proj\) \[project\]  .* → next, in its words: cut the release on Friday  \[under it: 1 wants, 1 running\]/);
  assert.match(text, /\n +not started 1: write the changelog\n/);
});
