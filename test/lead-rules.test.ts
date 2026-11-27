import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type LeadStore, createLeadRules, createLeadStore, createRules, isProjectBrief } from "../src/lead-rules.ts";
import { type Attention } from "../src/raised-cli.ts";
import { type CliActions, cowCli } from "../src/cli.ts";
import { withWorkerRules } from "../src/status.ts";
import { type DispatchFacts, type WorkerSettings, createWorkerRules, createWorkerStore, readRules } from "../src/worker-rules.ts";
import { memoryKv, world } from "./memory.ts";

const LEAD_URL = new URL("../rules/lead.md", import.meta.url);
const LEAD = readFileSync(LEAD_URL, "utf8");
const WORKER = readFileSync(new URL("../rules/worker.md", import.meta.url), "utf8");

function first(threadId: string, text: string, overrides: Partial<DispatchFacts> = {}): DispatchFacts {
  return { threadId, status: "pending", attempt: "start-turn", initiator: "agent", text, ...overrides };
}

const ON: WorkerSettings = { enabled: true, extra: "" };

function setup(kv = memoryKv()) {
  const now = { lead: ON, worker: ON };
  const leadStore = createLeadStore(kv);
  const workerStore = createWorkerStore(kv);
  const lead = createLeadRules({ store: leadStore, rules: LEAD, settings: () => now.lead, now: () => 1000, warn: () => undefined });
  const worker = createWorkerRules({ store: workerStore, rules: WORKER, settings: () => now.worker, now: () => 1000, warn: () => undefined });
  const rules = createRules(lead, worker);
  return { kv, now, leadStore, workerStore, rules, load: async () => Promise.all([leadStore.load(), workerStore.load()]) };
}

const settle = () => new Promise((done) => setImmediate(done));

test("a project brief is a thread whose first non-empty line is exactly PROJECT BRIEF", () => {
  assert.equal(isProjectBrief("PROJECT BRIEF\n\n# A project"), true);
  assert.equal(isProjectBrief("\n  PROJECT BRIEF  \r\nmore"), true);
  assert.equal(isProjectBrief("PROJECT BRIEF: the thing"), false);
  assert.equal(isProjectBrief("project brief"), false);
  assert.equal(isProjectBrief("Hello\nPROJECT BRIEF"), false);
  assert.equal(isProjectBrief("WORKER BRIEF"), false);
});

test("each of the three ways gives the text; a plain thread and a worker get none of it", async () => {
  const { rules, leadStore } = setup();
  leadStore.setMains(["thr_main"]);
  await leadStore.setProject("thr_proj", true, 1);
  await rules.dispatch(first("thr_brief", "PROJECT BRIEF\n\nTalk with the person about the roadmap."));
  await rules.dispatch(first("thr_worker", "WORKER BRIEF\nShape: ship"));
  await rules.dispatch(first("thr_plain", "Please look at the tests."));
  await settle();
  for (const id of ["thr_main", "thr_proj", "thr_brief"]) {
    assert.equal(rules.instructions(id), LEAD.trim(), id);
    assert.equal(rules.lead(id), true, id);
    assert.equal(rules.worker(id), false, id);
  }
  assert.equal(rules.instructions("thr_plain"), null);
  assert.equal(rules.lead("thr_plain"), false);
  assert.equal(rules.instructions("thr_worker"), WORKER.trim());
  assert.equal(rules.lead("thr_worker"), false);
  assert.equal(rules.worker("thr_worker"), true);
});

test("only a first message counts as a project brief", async () => {
  const { rules } = setup();
  await rules.dispatch(first("thr_a", "PROJECT BRIEF\n", { status: "idle" }));
  await rules.dispatch(first("thr_b", "PROJECT BRIEF\n", { attempt: "join-turn", status: "active" }));
  await rules.dispatch(first("thr_c", "PROJECT BRIEF\n", { initiator: "system" }));
  await settle();
  for (const id of ["thr_a", "thr_b", "thr_c"]) assert.equal(rules.instructions(id), null, id);
});

test("a worker later marked as a project gets this text and not the worker rules; unmarking gives it the worker rules again", async () => {
  const { rules, leadStore } = setup();
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await settle();
  assert.equal(rules.instructions("thr_w"), WORKER.trim());
  await leadStore.setProject("thr_w", true, 2);
  assert.equal(rules.instructions("thr_w"), LEAD.trim());
  assert.equal(rules.worker("thr_w"), false);
  assert.equal(rules.lead("thr_w"), true);
  await leadStore.setProject("thr_w", false, 3);
  assert.equal(rules.lead("thr_w"), false);
  assert.equal(rules.instructions("thr_w"), WORKER.trim(), "still recorded as a worker");
  // A plain thread marked and unmarked: nothing after.
  await leadStore.setProject("thr_p", true, 4);
  assert.equal(rules.instructions("thr_p"), LEAD.trim());
  await leadStore.setProject("thr_p", false, 5);
  assert.equal(rules.instructions("thr_p"), null);
});

test("changing Main moves the text", () => {
  const { rules, leadStore } = setup();
  leadStore.setMains(["thr_one", "thr_other_project"]);
  assert.equal(rules.lead("thr_one"), true);
  leadStore.setMains(["thr_two", "thr_other_project"]);
  assert.equal(rules.lead("thr_one"), false);
  assert.equal(rules.instructions("thr_one"), null);
  assert.equal(rules.instructions("thr_two"), LEAD.trim());
  assert.equal(rules.lead("thr_other_project"), true);
  leadStore.setMains([]);
  assert.equal(rules.lead("thr_two"), false);
});

test("leadRules off gives nothing and records nothing, while the worker rules still work", async () => {
  const { rules, leadStore, now, kv } = setup();
  now.lead = { enabled: false, extra: "" };
  leadStore.setMains(["thr_main"]);
  await rules.dispatch(first("thr_brief", "PROJECT BRIEF\n"));
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await settle();
  assert.equal(rules.instructions("thr_main"), null);
  assert.equal(rules.instructions("thr_brief"), null);
  assert.equal(rules.lead("thr_brief"), false);
  assert.deepEqual(await kv.list("lead-rules:"), [], "no project brief is recorded");
  assert.equal(rules.instructions("thr_w"), WORKER.trim());
  // As in 0.2.28: a Main recorded as a worker gets the worker rules.
  await rules.dispatch(first("thr_wmain", "WORKER BRIEF\n"));
  leadStore.setMains(["thr_wmain"]);
  assert.equal(rules.instructions("thr_wmain"), WORKER.trim());
  assert.equal(rules.worker("thr_wmain"), true);
  // On again: the brief made while off stays unrecorded; the Main has the lead text.
  now.lead = ON;
  assert.equal(rules.instructions("thr_brief"), null);
  assert.equal(rules.instructions("thr_wmain"), LEAD.trim());
});

test("workerRules off gives no worker rules, while the lead rules still work", async () => {
  const { rules, leadStore, now, kv } = setup();
  now.worker = { enabled: false, extra: "" };
  leadStore.setMains(["thr_main"]);
  await rules.dispatch(first("thr_brief", "PROJECT BRIEF\n"));
  await rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await settle();
  assert.equal(rules.instructions("thr_w"), null);
  assert.equal(rules.worker("thr_w"), false);
  assert.deepEqual(await kv.list("worker-rules:"), []);
  assert.equal(rules.instructions("thr_main"), LEAD.trim());
  assert.equal(rules.instructions("thr_brief"), LEAD.trim());
});

test("the extra text follows the rules", async () => {
  const { rules, leadStore, now } = setup();
  now.lead = { enabled: true, extra: "  On this machine, asks wait until morning.  " };
  leadStore.setMains(["thr_main"]);
  const given = rules.instructions("thr_main")!;
  assert.ok(given.startsWith("# Asking the person"));
  assert.ok(given.endsWith("\n\nOn this machine, asks wait until morning."));
  assert.ok(given.indexOf("look up yourself.") < given.indexOf("On this machine"));
});

test("the facts are still right after the stores are loaded afresh", async () => {
  const kv = memoryKv();
  const before = setup(kv);
  await before.rules.dispatch(first("thr_brief", "PROJECT BRIEF\n"));
  await before.rules.dispatch(first("thr_w", "WORKER BRIEF\n"));
  await before.leadStore.setProject("thr_proj", true, 1);
  await before.leadStore.setProject("thr_wproj", true, 1);
  await before.rules.dispatch(first("thr_wproj", "WORKER BRIEF\n"));
  await before.leadStore.setProject("thr_gone", true, 1);
  await before.leadStore.setProject("thr_gone", false, 2);
  await settle();
  const after = setup(kv);
  assert.equal(after.rules.lead("thr_brief"), false, "not before it is loaded");
  await after.load();
  // The Mains come from cow's stored state, read when it loads.
  after.leadStore.setMains(["thr_main"]);
  for (const id of ["thr_brief", "thr_proj", "thr_wproj", "thr_main"]) assert.equal(after.rules.instructions(id), LEAD.trim(), id);
  assert.equal(after.rules.instructions("thr_w"), WORKER.trim());
  assert.equal(after.rules.instructions("thr_gone"), null);
  await after.leadStore.forget("thr_brief");
  await after.leadStore.forget("thr_proj");
  const again = setup(kv);
  await again.load();
  assert.equal(again.rules.lead("thr_brief"), false, "a deleted thread is forgotten");
  assert.equal(again.rules.lead("thr_proj"), false);
});

test("marks found by reading the threads are added, unless changed since the reading began", async () => {
  const kv = memoryKv();
  const { leadStore, rules } = setup(kv);
  const since = leadStore.changes();
  await leadStore.setProject("thr_unmarked_meanwhile", false, 1);
  await leadStore.found(["thr_old_mark", "thr_unmarked_meanwhile"], since);
  assert.equal(rules.lead("thr_old_mark"), true);
  assert.equal(rules.lead("thr_unmarked_meanwhile"), false);
  const fresh = createLeadStore(kv);
  await fresh.load();
  assert.equal(fresh.has("thr_old_mark"), true, "and mirrored");
});

test("the hook always lets a message through", async () => {
  const { rules } = setup();
  for (const text of ["PROJECT BRIEF\n", "WORKER BRIEF\n", "", "hello"]) assert.deepEqual(await rules.dispatch(first("thr_x", text)), { action: "proceed" });
  const throwing: LeadStore = {
    ...createLeadStore(memoryKv()),
    recordBrief: () => {
      throw new Error("storage is gone");
    },
  };
  const rejecting: LeadStore = { ...throwing, recordBrief: async () => Promise.reject(new Error("write failed")) };
  for (const store of [throwing, rejecting]) {
    const lead = createLeadRules({ store, rules: LEAD, settings: () => ON, now: () => 1, warn: () => {
      throw new Error("no log");
    } });
    assert.deepEqual(await lead.dispatch(first("thr_b", "PROJECT BRIEF\n")), { action: "proceed" });
  }
  const broken = createLeadRules({ store: throwing, rules: LEAD, settings: () => {
    throw new Error("settings are gone");
  }, now: () => 1, warn: () => undefined });
  const worker = createWorkerRules({ store: createWorkerStore(memoryKv()), rules: WORKER, settings: () => ON, now: () => 1, warn: () => undefined });
  const both = createRules(broken, worker);
  assert.deepEqual(await both.dispatch(first("thr_w", "WORKER BRIEF\n")), { action: "proceed" });
  assert.equal(both.instructions("thr_w"), WORKER.trim(), "a lead side that throws leaves the worker rules alone");
  await settle();
});

test("no rule file, no lead rules", () => {
  const store = createLeadStore(memoryKv());
  store.setMains(["thr_main"]);
  const lead = createLeadRules({ store, rules: null, settings: () => ON, now: () => 1, warn: () => undefined });
  assert.equal(lead.instructions("thr_main"), null);
  assert.equal(lead.gave("thr_main"), false);
});

test("status --json lines say leadRules beside workerRules", async () => {
  const { rules, leadStore } = setup();
  leadStore.setMains(["main"]);
  await rules.dispatch(first("child", "WORKER BRIEF\n"));
  const line = { id: "x" } as never;
  const report = withWorkerRules({ main: { ...(line as object), id: "main" }, queue: [], threads: [{ ...(line as object), id: "child" }], parked: [], settle: [], kept: [], archived: [], outside: [] } as never, rules.worker, rules.lead) as unknown as { main: Record<string, unknown>; threads: Record<string, unknown>[] };
  assert.deepEqual([report.main.workerRules, report.main.leadRules], [false, true]);
  assert.deepEqual([report.threads[0]!.workerRules, report.threads[0]!.leadRules], [true, false]);
});

test("the shipped lead rules name no folder, tool or tracker of one particular setup", () => {
  const text = readRules(LEAD_URL);
  assert.ok(text !== null && text.startsWith("# Asking the person"));
  const banned: [string, RegExp][] = [
    ["memory/", /memory\//i],
    [".bb/", /\.bb\//i],
    ["a home folder", /(\/Users\/|\/home\/|~\/|\$HOME|%USERPROFILE%|C:\\Users)/i],
    ["an issue tracker", /\b(linear|jira|github issues?|gitlab|trello|asana|youtrack|clickup|shortcut\.com|bugzilla|redmine|notion)\b/i],
    ["an issue id", /\b[A-Z]{2,10}-[0-9]+\b/],
  ];
  for (const [what, pattern] of banned) assert.equal(pattern.test(text), false, `the rule file has ${what}`);
});

/** Split a command line as a shell would, for the simple quoting the rule file uses. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}

test("every bb cow command in the lead rules parses against the command definitions", async () => {
  const w = world();
  const attention: Attention = { asks: w.asks, briefs: w.briefs, readFile: async () => "" };
  const unused = async () => {
    throw new Error("unused");
  };
  const actions: CliActions = { archiveChecked: unused, parkChecked: unused, resumeChecked: unused, projectChecked: unused, nextChecked: unused, waitChecked: unused, todoChecked: unused, status: unused };
  const cli = cowCli(actions, attention);
  const run = (argv: string[]) => cli.run(argv, { projectId: "proj_1", cwd: "/work", threadId: "child", signal: new AbortController().signal });
  const commands = [...LEAD.replace(/\s*\n\s*/g, " ").matchAll(/`bb cow ([^`]+)`/g)].map((match) => match[1]!);
  assert.ok(commands.length >= 2, `found ${JSON.stringify(commands)}`);
  // An ask for the commands that name one.
  const asked = await run(["ask", "--question", "Ship it?", "--option", "yes", "--option", "no"]);
  assert.equal(asked.exitCode, 0, asked.stderr);
  const id = asked.stdout!.split("\n")[0]!;
  for (const command of commands) {
    const argv = words(command.replaceAll("<id>", id).replaceAll("<their words>", "yes, ship it"));
    // A command named without its required options is checked as a command: its help.
    const bare = !argv.some((word) => word.startsWith("--"));
    const result = await run(bare ? [...argv, "--help"] : argv);
    assert.equal(result.exitCode, 0, `bb cow ${command}: ${result.stderr ?? ""}`);
    if (bare) assert.match(result.stdout ?? "", new RegExp(`bb cow ${argv.join(" ")}`), `bb cow ${command} is a command`);
  }
  assert.equal((await w.asks.list({ all: true })).find((ask) => ask.id === id)?.status, "closed", "the close in the rules closed the ask");
});

test("each project mark the actions set or take off reaches the store", async () => {
  const { createActions } = await import("../src/actions.ts");
  const raw = (id: string, parent: string | null) => ({ id, projectId: "proj_1", title: id, parentThreadId: parent, status: "idle", archivedAt: null, createdAt: 1 });
  const threads = [raw("main", null), raw("kid", "main")];
  const bb = {
    pluginId: "cow",
    storage: { kv: memoryKv() },
    realtime: { publish: () => undefined },
    log: { warn: () => undefined, info: () => undefined },
    sdk: {
      threads: {
        list: async (args: { threadIds?: string[] }) => threads.filter((t) => !args.threadIds || args.threadIds.includes(t.id)),
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, metadata: {} })) }),
        updatePluginMetadata: async () => undefined,
        events: { list: async () => [] },
        interactions: { list: async () => [] },
      },
      projects: { list: async () => [] },
    },
  };
  const { rules, leadStore } = setup();
  const actions = createActions(bb as never, async () => ({ mains: { proj_1: "main" }, currentProjectId: "proj_1" }), undefined, undefined, undefined, (threadId, marked) => {
    void leadStore.setProject(threadId, marked, 1);
  });
  await actions.projectChecked({ callerId: null, threadId: "kid", on: true });
  assert.equal(rules.instructions("kid"), LEAD.trim(), "bb cow project");
  await actions.projectChecked({ callerId: null, threadId: "kid", on: false });
  assert.equal(rules.lead("kid"), false, "bb cow project --clear");
  await actions.setProject("kid", { at: 1, by: null });
  assert.equal(rules.lead("kid"), true, "the page's mark");
  await actions.setProject("kid", null);
  assert.equal(rules.lead("kid"), false);
});
