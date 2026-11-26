import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type DispatchFacts, type WorkerSettings, type WorkerStore, createWorkerRules, createWorkerStore, isWorkerBrief, readRules, rulesWith } from "../src/worker-rules.ts";
import { memoryKv } from "./memory.ts";

const RULES_URL = new URL("../rules/worker.md", import.meta.url);
const RULES = readFileSync(RULES_URL, "utf8");

function first(threadId: string, text: string, overrides: Partial<DispatchFacts> = {}): DispatchFacts {
  return { threadId, status: "pending", attempt: "start-turn", initiator: "agent", text, ...overrides };
}

function setup(settings: WorkerSettings = { enabled: true, extra: "" }, kv = memoryKv()) {
  const store = createWorkerStore(kv);
  const now = { settings };
  const warnings: string[] = [];
  const rules = createWorkerRules({ store, rules: RULES, settings: () => now.settings, now: () => 1000, warn: (text) => void warnings.push(text) });
  return { kv, store, rules, now, warnings };
}

/** Let the write that the hook does not wait for land. */
const settle = () => new Promise((done) => setImmediate(done));

test("a worker is a thread whose first non-empty line is exactly WORKER BRIEF", () => {
  assert.equal(isWorkerBrief("WORKER BRIEF\n\n# Do a thing"), true);
  assert.equal(isWorkerBrief("WORKER BRIEF"), true);
  assert.equal(isWorkerBrief("WORKER BRIEF\r\nShape: ship"), true);
  assert.equal(isWorkerBrief("\n\n  \nWORKER BRIEF\nShape: scout"), true, "leading blank lines are passed over");
  assert.equal(isWorkerBrief("WORKER BRIEF: do a thing"), false, "a line that only starts with those words");
  assert.equal(isWorkerBrief("WORKER BRIEFS\n"), false);
  assert.equal(isWorkerBrief("worker brief\n"), false);
  assert.equal(isWorkerBrief("Here is the task.\nWORKER BRIEF\n"), false, "the line further down");
  assert.equal(isWorkerBrief(""), false, "an empty message");
  assert.equal(isWorkerBrief("\n  \n"), false);
});

test("the callback gives the rules to a recorded worker and nothing to any other thread", async () => {
  const { rules, kv } = setup();
  await rules.dispatch(first("thr_w", "WORKER BRIEF\nShape: ship"));
  await rules.dispatch(first("thr_o", "Please look at the tests."));
  await settle();
  assert.equal(rules.instructions("thr_w"), RULES.trim());
  assert.equal(rules.gave("thr_w"), true);
  assert.equal(rules.instructions("thr_o"), null);
  assert.equal(rules.gave("thr_o"), false);
  assert.equal(rules.instructions("thr_never_seen"), null);
  assert.deepEqual(await kv.list("worker-rules:"), ["worker-rules:thr_w"], "only the worker is recorded");
});

test("only the first message counts: a later message with the line makes nothing a worker", async () => {
  const { rules } = setup();
  await rules.dispatch(first("thr_a", "WORKER BRIEF\n", { status: "idle" }));
  await rules.dispatch(first("thr_b", "WORKER BRIEF\n", { attempt: "join-turn", status: "active" }));
  await rules.dispatch(first("thr_c", "WORKER BRIEF\n", { initiator: "system" }));
  await settle();
  for (const id of ["thr_a", "thr_b", "thr_c"]) assert.equal(rules.instructions(id), null, id);
});

test("a worker stays a worker when later messages do not have the line", async () => {
  const { rules } = setup();
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await rules.dispatch(first("thr_w", "carry on", { status: "idle" }));
  assert.equal(rules.gave("thr_w"), true);
});

test("with the setting off nothing is given and nothing is recorded", async () => {
  const { rules, kv, now } = setup({ enabled: false, extra: "" });
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await settle();
  assert.equal(rules.instructions("thr_w"), null);
  assert.deepEqual(await kv.list(), []);
  // A worker recorded while it was on is given nothing once it is off.
  now.settings = { enabled: true, extra: "" };
  await rules.dispatch(first("thr_v", "WORKER BRIEF\n"));
  now.settings = { enabled: false, extra: "" };
  assert.equal(rules.instructions("thr_v"), null);
  assert.equal(rules.gave("thr_v"), false);
});

test("this machine's text comes after the rules", async () => {
  const { rules } = setup({ enabled: true, extra: "  Builds on this machine use the slow disk.  " });
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  const given = rules.instructions("thr_w")!;
  assert.ok(given.startsWith("# Worker rules"));
  assert.ok(given.endsWith("\n\nBuilds on this machine use the slow disk."));
  assert.ok(given.indexOf("they win.") < given.indexOf("Builds on this machine"));
  assert.equal(rulesWith("A", ""), "A");
});

test("the hook lets the message through when recording throws", async () => {
  const warnings: string[] = [];
  const throwing: WorkerStore = {
    load: async () => undefined,
    has: () => false,
    record: () => {
      throw new Error("storage is gone");
    },
    forget: async () => undefined,
  };
  const rejecting: WorkerStore = { ...throwing, record: async () => Promise.reject(new Error("write failed")) };
  for (const store of [throwing, rejecting]) {
    const rules = createWorkerRules({ store, rules: RULES, settings: () => ({ enabled: true, extra: "" }), now: () => 1, warn: (text) => void warnings.push(text) });
    assert.deepEqual(await rules.dispatch(first("thr_w", "WORKER BRIEF\n")), { action: "proceed" });
  }
  // Even a warning that throws leaves the message going through.
  const rules = createWorkerRules({ store: throwing, rules: RULES, settings: () => ({ enabled: true, extra: "" }), now: () => 1, warn: () => {
    throw new Error("no log");
  } });
  assert.deepEqual(await rules.dispatch(first("thr_w", "WORKER BRIEF\n")), { action: "proceed" });
  const broken = createWorkerRules({ store: throwing, rules: RULES, settings: () => {
    throw new Error("settings are gone");
  }, now: () => 1, warn: () => undefined });
  assert.deepEqual(await broken.dispatch(first("thr_w", "WORKER BRIEF\n")), { action: "proceed" });
  await settle();
  assert.equal(warnings.length, 2);
});

test("every answer the hook gives is proceed", async () => {
  const { rules } = setup();
  for (const text of ["WORKER BRIEF\n", "", "hello", "WORKER BRIEF: no"]) assert.deepEqual(await rules.dispatch(first("thr_x", text)), { action: "proceed" });
});

test("the recorded fact is still read when the store is loaded afresh", async () => {
  const kv = memoryKv();
  const before = setup({ enabled: true, extra: "" }, kv);
  await before.rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await settle();
  const after = setup({ enabled: true, extra: "" }, kv);
  assert.equal(after.rules.instructions("thr_w"), null, "not before it is loaded");
  await after.store.load();
  assert.equal(after.rules.instructions("thr_w"), RULES.trim());
  await after.store.forget("thr_w");
  const again = setup({ enabled: true, extra: "" }, kv);
  await again.store.load();
  assert.equal(again.rules.gave("thr_w"), false, "a deleted thread is forgotten");
});

test("no rule file, no rules", async () => {
  assert.equal(readRules(new URL("../rules/no-such-file.md", import.meta.url)), null);
  const store = createWorkerStore(memoryKv());
  const rules = createWorkerRules({ store, rules: null, settings: () => ({ enabled: true, extra: "x" }), now: () => 1, warn: () => undefined });
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  assert.equal(rules.instructions("thr_w"), null);
  assert.equal(rules.gave("thr_w"), false);
});

test("the shipped rule file names no folder, tool or tracker of one particular setup", () => {
  const text = readRules(RULES_URL);
  assert.ok(text !== null && text.startsWith("# Worker rules"));
  const banned: [string, RegExp][] = [
    ["memory/", /memory\//i],
    [".bb/", /\.bb\//i],
    ["a home folder", /(\/Users\/|\/home\/|~\/|\$HOME|%USERPROFILE%|C:\\Users)/i],
    ["an issue tracker", /\b(linear|jira|github issues?|gitlab|trello|asana|youtrack|clickup|shortcut\.com|bugzilla|redmine|notion)\b/i],
    ["an issue id", /\b[A-Z]{2,10}-[0-9]+\b/],
  ];
  for (const [what, pattern] of banned) assert.equal(pattern.test(text), false, `the rule file has ${what}`);
});
