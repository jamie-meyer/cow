import assert from "node:assert/strict";
import { test } from "node:test";
import { type StartedDeps, type StartedRecord, createStartedStore, recordedRunId, withRecorded } from "../src/automation-runs.ts";
import type { AutomationRecord, AutomationsRead, RunRecord } from "../src/automations.ts";
import { automationRunCommands } from "../src/cli.ts";
import { Refusal } from "../src/kv.ts";
import { type ThreadFacts, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { buildOverview, listed } from "../src/tree.ts";
import { HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

function automation(overrides: Partial<AutomationRecord> & { id: string }): AutomationRecord {
  return {
    projectId: "proj_test",
    projectName: "test",
    name: overrides.id,
    enabled: true,
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    mode: "script",
    targetThreadId: null,
    nextRunAt: NOW + 3 * HOUR,
    lastRunAt: NOW - HOUR,
    runCount: 3,
    lastRunStatus: "succeeded",
    lastRunThreadId: null,
    lastError: null,
    ...overrides,
  };
}

function run(id: string, threadId: string | null, hoursAgo: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const startedAt = NOW - hoursAgo * HOUR;
  return { id, threadId, status: "succeeded", skipReason: null, error: null, output: null, exitCode: 0, scheduledFor: startedAt, startedAt, finishedAt: startedAt + MINUTE, ...overrides };
}

const READ: AutomationsRead = {
  available: true,
  automations: [
    { automation: automation({ id: "auto_nightly", name: "Nightly check" }), runs: [run("arun_2", null, 1, { output: "spawned: spawned2" }), run("arun_1", null, 25)], moreRuns: false },
    { automation: automation({ id: "auto_other", name: "Other" }), runs: [run("arun_o", null, 2)], moreRuns: false },
    { automation: automation({ id: "auto_agent", name: "Agent", mode: "agent" }), runs: [run("arun_a", "agentRun", 3)], moreRuns: false },
    { automation: automation({ id: "auto_twin1", name: "Twin" }), runs: [], moreRuns: false },
    { automation: automation({ id: "auto_twin2", name: "Twin" }), runs: [], moreRuns: false },
  ],
};

function memoryKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    kv: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      set: async (key: string, value: unknown) => void map.set(key, structuredClone(value)),
      delete: async (key: string) => void map.delete(key),
      list: async (prefix = "") => [...map.keys()].filter((key) => key.startsWith(prefix)),
    },
  };
}

function world(read: AutomationsRead = READ) {
  const { kv, map } = memoryKv();
  const logged: Parameters<StartedDeps["log"]>[0][] = [];
  let changes = 0;
  const threads = new Set(["spawned1", "spawned2", "agentRun"]);
  const store = createStartedStore({
    kv,
    now: () => NOW,
    thread: async (id) =>
      id === "worker" ? { title: "A worker", parentThreadId: "main", main: false } : id === "main" ? { title: "Main", parentThreadId: null, main: true } : threads.has(id) ? { title: `Thread ${id}` } : null,
    automations: async () => read,
    runIds: async (a) => read.automations.find((entry) => entry.automation.id === a.id)?.runs.map((r) => r.id) ?? null,
    log: async (event) => void logged.push(event),
    changed: () => void (changes += 1),
  });
  return { store, map, logged, changes: () => changes };
}

const refused = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (cause: unknown) => cause instanceof Refusal && cause.code === code && typeof cause.hint === "string" && cause.hint.length > 0);
};

test("a record is made once: by id or name, with or without its run; the same pair again changes nothing", async () => {
  const w = world();
  const made = await w.store.record({ threadId: "spawned2", automation: "auto_nightly", runId: "arun_2", callerId: null });
  assert.deepEqual([made.changed, made.automation, made.runId, made.title], [true, { id: "auto_nightly", name: "Nightly check" }, "arun_2", "Thread spawned2"]);
  assert.deepEqual(w.logged, [{ action: "recorded", threadId: "spawned2", automationId: "auto_nightly", name: "Nightly check", runId: "arun_2", by: null }]);
  assert.equal(w.changes(), 1);
  const again = await w.store.record({ threadId: "spawned2", automation: "Nightly check", runId: "arun_2", callerId: "thr_caller" });
  assert.equal(again.changed, false);
  // Without --run, the record already there is kept as it is.
  assert.equal((await w.store.record({ threadId: "spawned2", automation: "auto_nightly", runId: null, callerId: null })).changed, false);
  assert.equal(w.logged.length, 1);
  assert.equal(w.changes(), 1);
  const all = await w.store.all();
  assert.deepEqual(all.get("spawned2"), { automationId: "auto_nightly", runId: "arun_2", at: NOW, by: null });
  // A record without a run, by a thread: who ran it is kept.
  await w.store.record({ threadId: "spawned1", automation: "auto_nightly", runId: null, callerId: "thr_caller" });
  assert.equal((await w.store.all()).get("spawned1")!.by, "thr_caller");
});

test("refused: no such thread, no such automation, a name two have, an agent automation, a run not its own, another automation's thread", async () => {
  const w = world();
  await refused(w.store.record({ threadId: "nosuch", automation: "auto_nightly", runId: null, callerId: null }), "thread_not_found");
  await refused(w.store.record({ threadId: "spawned1", automation: "auto_nosuch", runId: null, callerId: null }), "automation_not_found");
  await refused(w.store.record({ threadId: "spawned1", automation: "Twin", runId: null, callerId: null }), "automation_ambiguous");
  await refused(w.store.record({ threadId: "spawned1", automation: "auto_agent", runId: null, callerId: null }), "not_a_script");
  await refused(w.store.record({ threadId: "spawned1", automation: "auto_nightly", runId: "arun_o", callerId: null }), "run_not_found");
  await refused(w.store.record({ threadId: "agentRun", automation: "auto_nightly", runId: null, callerId: null }), "thread_is_another_run");
  await w.store.record({ threadId: "spawned1", automation: "auto_nightly", runId: null, callerId: null });
  await refused(w.store.record({ threadId: "spawned1", automation: "auto_other", runId: null, callerId: null }), "recorded_for_another");
  await w.store.record({ threadId: "spawned2", automation: "auto_nightly", runId: "arun_2", callerId: null });
  await refused(w.store.record({ threadId: "spawned2", automation: "auto_nightly", runId: "arun_1", callerId: null }), "recorded_for_another_run");
  // Nothing refused was written.
  assert.deepEqual([...(await w.store.all()).keys()].sort(), ["spawned1", "spawned2"]);
  const unavailable = world({ available: false, automations: [] });
  await refused(unavailable.store.record({ threadId: "spawned1", automation: "auto_nightly", runId: null, callerId: null }), "automations_unavailable");
});

test("a record whose automation was deleted gives way to a new one", async () => {
  const w = world();
  await w.store.record({ threadId: "spawned1", automation: "auto_twin1", runId: null, callerId: null });
  const gone: AutomationsRead = { available: true, automations: READ.automations.filter((entry) => entry.automation.id !== "auto_twin1") };
  const later = createStartedStore({
    kv: { get: async (k) => w.map.get(k) as never, set: async (k, v) => void w.map.set(k, v), delete: async (k) => void w.map.delete(k), list: async (p = "") => [...w.map.keys()].filter((k) => k.startsWith(p)) },
    now: () => NOW,
    thread: async () => ({ title: "t" }),
    automations: async () => gone,
    runIds: async () => null,
    log: async () => undefined,
    changed: () => undefined,
  });
  assert.equal((await later.record({ threadId: "spawned1", automation: "auto_other", runId: null, callerId: null })).changed, true);
  assert.equal((await later.all()).get("spawned1")!.automationId, "auto_other");
});

test("cleared: the record goes, once, and is logged; another automation named is refused", async () => {
  const w = world();
  await w.store.record({ threadId: "spawned1", automation: "auto_nightly", runId: null, callerId: null });
  await refused(w.store.clear({ threadId: "spawned1", automation: "auto_other", callerId: null }), "recorded_for_another");
  const cleared = await w.store.clear({ threadId: "spawned1", automation: null, callerId: "thr_caller" });
  assert.deepEqual([cleared.changed, cleared.automation.name], [true, "Nightly check"]);
  assert.equal((await w.store.all()).size, 0);
  assert.deepEqual(w.logged.at(-1), { action: "cleared", threadId: "spawned1", automationId: "auto_nightly", name: "Nightly check", runId: null, by: "thr_caller" });
  assert.equal((await w.store.clear({ threadId: "spawned1", automation: null, callerId: null })).changed, false);
  assert.equal(w.logged.length, 2);
  // A thread bb deleted is forgotten.
  await w.store.record({ threadId: "spawned2", automation: "auto_nightly", runId: null, callerId: null });
  await w.store.forget("spawned2");
  assert.equal((await w.store.all()).size, 0);
});

test("merged into the read: on its run when that run is known, else a run of its own in time order", () => {
  const records = new Map<string, StartedRecord>([
    ["spawned2", { automationId: "auto_nightly", runId: "arun_2", at: NOW - HOUR, by: null }],
    ["spawned1", { automationId: "auto_nightly", runId: null, at: NOW - 2 * HOUR, by: null }],
    ["lost", { automationId: "auto_deleted", runId: null, at: NOW, by: null }],
  ]);
  const merged = withRecorded(READ, records);
  const nightly = merged.automations[0]!;
  assert.deepEqual(nightly.runs.map((r) => [r.id, r.threadId]), [["arun_2", "spawned2"], [recordedRunId("spawned1"), "spawned1"], ["arun_1", null]]);
  // The plugin's answer itself is not changed, and a deleted automation's record is left out.
  assert.equal(READ.automations[0]!.runs[0]!.threadId, null);
  assert.ok(!JSON.stringify(merged).includes("lost"));
  assert.equal(withRecorded(READ, new Map()), READ);
});

const derived = (t: ThreadFacts) => derive(t, activity({ output: `${t.id} said this` }), NOW, null, null, null, { seenSeq: null });

test("listed: a recorded thread is under its automation and not outside Main; an unrecorded one is unchanged; one under Main stays in the tree", () => {
  const threads = [
    thread({ id: "main" }),
    thread({ id: "kid", parentThreadId: "main" }),
    thread({ id: "spawned2", hasPendingInteraction: true }),
    thread({ id: "spawned1" }),
  ];
  const records = new Map<string, StartedRecord>([
    ["spawned2", { automationId: "auto_nightly", runId: "arun_2", at: NOW - HOUR, by: null }],
    ["kid", { automationId: "auto_other", runId: null, at: NOW, by: null }],
  ]);
  const overview = (read: AutomationsRead) => buildOverview(threads, "main", derived, NOW, { note: () => null, todos: () => [], automations: read });
  const before = overview(READ);
  assert.deepEqual(before.outside.lines.map((line) => line.thread.id).sort(), ["spawned1", "spawned2"]);
  const after = overview(withRecorded(READ, records));
  const nightly = after.automations.groups.find((group) => group.automation.id === "auto_nightly")!;
  assert.deepEqual(nightly.runs.map((line) => line.thread.id), ["spawned2"]);
  // Its row shows what its latest run came to: the thread's state, as an agent run's.
  assert.equal(nightly.last.kind, "wants");
  assert.deepEqual(after.outside.lines.map((line) => line.thread.id), ["spawned1"]);
  // Needing the person, it is in the queue as an agent run is.
  assert.equal(after.queue.find((line) => line.thread.id === "spawned2")?.run, nightly.id);
  // A thread under Main is never taken out of the tree.
  assert.equal(after.automations.groups.find((group) => group.automation.id === "auto_other")!.runs.length, 0);
  assert.ok(listed(after).some((line) => line.thread.id === "kid" && line.run === undefined));
  // And so `bb cow status` says.
  const text = statusText(statusReport(after, NOW, false));
  const automationsPart = text.slice(text.indexOf("Automations"), text.indexOf("Outside Main"));
  assert.match(automationsPart, /spawned2/);
  assert.doesNotMatch(text.slice(text.indexOf("Outside Main")), /spawned2/);
});

test("the command: --automation is needed to record, not to clear; --clear takes no --run", async () => {
  const w = world();
  const commands = automationRunCommands(w.store);
  const command = commands["automation started"] as unknown as { run(input: unknown, ctx: unknown): Promise<{ stdout: string }> };
  const call = (positionals: object, options: object) => command.run({ positionals, options }, { threadId: undefined });
  await assert.rejects(call({ thread: "spawned1" }, {}), /--automation/);
  await assert.rejects(call({ thread: "spawned1" }, { clear: true, run: "arun_2" }), /--clear takes no --run/);
  await assert.rejects(call({ thread: "nosuch" }, { automation: "auto_nightly" }), /there is no thread nosuch/);
  const out = await call({ thread: "@thread:spawned2" }, { automation: "auto_nightly", run: "arun_2" });
  assert.match(out.stdout, /recorded: “Thread spawned2” \(spawned2\) was started by run arun_2 of the automation “Nightly check”/);
  assert.match((await call({ thread: "spawned2" }, { automation: "auto_nightly", run: "arun_2" })).stdout, /^already recorded/);
  const json = JSON.parse((await call({ thread: "spawned2" }, { clear: true, json: true })).stdout);
  assert.deepEqual([json.ok, json.recorded, json.changed, json.automationId], [true, false, true, "auto_nightly"]);
});

test("refused: a thread another thread started, and a Main; nothing is written", async () => {
  const w = world();
  await refused(w.store.record({ threadId: "worker", automation: "auto_nightly", runId: null, callerId: "worker" }), "thread_has_parent");
  await refused(w.store.record({ threadId: "main", automation: "auto_nightly", runId: null, callerId: null }), "thread_is_main");
  assert.equal(w.map.size, 0);
  assert.equal(w.logged.length, 0);
});
