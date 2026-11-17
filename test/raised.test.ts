import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { toolsUsed } from "../src/raised-backend.ts";
import { type Attention, absolutePath } from "../src/raised-cli.ts";
import { withAttention } from "../src/raised.ts";
import type { BriefMark } from "../src/briefs/review.ts";
import { type CliActions, cowCli } from "../src/cli.ts";
import { type StatusLine, type StatusReport, statusText } from "../src/status.ts";
import { HOUR, MINUTE } from "./fixtures.ts";
import { world } from "./memory.ts";

const NOW = Date.now();
const line = (id: string, overrides: Partial<StatusLine> = {}): StatusLine => ({
  id,
  title: id,
  state: "running",
  label: "running",
  inStateMs: MINUTE,
  inState: "1m",
  doing: "working",
  next: "",
  note: null,
  todo: [],
  under: null,
  depth: 0,
  queue: null,
  ...overrides,
});
const report = (overrides: Partial<StatusReport> = {}): StatusReport => ({
  main: line("main"),
  queue: [],
  threads: [line("child"), line("grandchild", { depth: 1 })],
  parked: [],
  done: [],
  omitted: { threads: 0, parked: 0, done: 0, queue: 0, olderDone: 0 },
  truncated: false,
  ...overrides,
});
const ask = (id: string, threadId: string, minutesAgo: number, overrides: Partial<Ask> = {}): Ask => ({
  id,
  threadId,
  askedBy: threadId,
  projectId: "proj_1",
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
  ...overrides,
});
const NO_BRIEFS = new Map<string, BriefMark>();

test("a thread with an open ask reads as wanting the user, and each ask is a place in the queue", () => {
  const out = withAttention(report(), [ask("ask_b", "child", 5), ask("ask_a", "child", 90, { risk: "high" }), ask("ask_c", "grandchild", 30)], NO_BRIEFS, NOW, "proj_1");
  const child = out.threads.find((entry) => entry.id === "child");
  assert.equal(child?.state, "wants");
  assert.equal(child?.label, "wants you");
  assert.equal(child?.doing, "asks: Question ask_a? (and 1 more)");
  assert.equal(child?.inState, "1h");
  assert.equal(child?.queue, 1);
  assert.deepEqual(out.queue.map((entry) => [entry.queue, entry.id, entry.doing, entry.waiting]), [
    [1, "child", "asks (ask_a, risk high): Question ask_a?", "1h"],
    [2, "grandchild", "asks (ask_c): Question ask_c?", "30m"],
    [3, "child", "asks (ask_b): Question ask_b?", "5m"],
  ]);
  assert.equal(out.threads.find((entry) => entry.id === "grandchild")?.queue, 2);
  assert.equal(out.main.state, "running");
  assert.deepEqual(out.asks.map((entry) => entry.id), ["ask_a", "ask_c", "ask_b"]);
  const text = statusText(out);
  assert.match(text, /Waiting on the user \(3\)\n 1  child \(child\)  asks \(ask_a, risk high\): Question ask_a\? · waiting 1h/);
  assert.match(text, / 1  wants {5}1h  child \(child\)  asks: Question ask_a\? \(and 1 more\) → answer it on cow's page/);
});

test("asks join what was already waiting, oldest first", () => {
  const waiting = { ...line("grandchild", { state: "failed", label: "failed", inStateMs: HOUR, inState: "1h", doing: "its turn failed", queue: 1 }), waiting: "1h" };
  const out = withAttention(report({ queue: [waiting] }), [ask("ask_old", "child", 180), ask("ask_new", "child", 1)], NO_BRIEFS, NOW, "proj_1");
  assert.deepEqual(out.queue.map((entry) => [entry.queue, entry.id, entry.doing]), [
    [1, "child", "asks (ask_old): Question ask_old?"],
    [2, "grandchild", "its turn failed"],
    [3, "child", "asks (ask_new): Question ask_new?"],
  ]);
});

test("a finished thread with an open ask is not done; a parked one stays parked and still asks", () => {
  const out = withAttention(
    report({ threads: [], done: [line("child", { state: "done", label: "done", doing: "finished" }), line("other", { state: "done", label: "done" })], parked: [line("grandchild", { state: "parked", label: "parked", doing: "waiting on review" })] }),
    [ask("ask_a", "child", 10), ask("ask_b", "grandchild", 20)],
    NO_BRIEFS,
    NOW,
    "proj_1",
  );
  assert.deepEqual(out.threads.map((entry) => [entry.id, entry.state]), [["child", "wants"]]);
  assert.deepEqual(out.done.map((entry) => entry.id), ["other"]);
  assert.equal(out.parked[0]?.state, "parked");
  assert.equal(out.parked[0]?.doing, "waiting on review · asks: Question ask_b?");
  assert.equal(out.queue.length, 2);
});

test("asks on threads the overview does not list are counted, for this project only", () => {
  const out = withAttention(report(), [ask("ask_a", "elsewhere", 5), ask("ask_b", "far", 5, { projectId: "proj_2" }), ask("ask_c", "child", 5)], NO_BRIEFS, NOW, "proj_1");
  assert.equal(out.asksElsewhere, 1);
  assert.deepEqual(out.asks.map((entry) => entry.id), ["ask_c"]);
});

test("the queue stays bounded and counts what it leaves out", () => {
  const many = Array.from({ length: 25 }, (_, n) => ask(`ask_${n}`, "child", n + 1));
  const out = withAttention(report(), many, NO_BRIEFS, NOW, "proj_1");
  assert.equal(out.queue.length, 20);
  assert.equal(out.omitted.queue, 5);
  assert.match(statusText(out), /Waiting on the user \(25\)/);
});

test("a thread's line says what the checker made of its latest brief", () => {
  const briefs = new Map<string, BriefMark>([
    ["child", { version: 2, state: "checked", contradicted: 1, notEstablished: 2, judgementCalls: 0 }],
    ["grandchild", { version: 1, state: "failed", contradicted: 0, notEstablished: 0, judgementCalls: 0 }],
    ["main", { version: 1, state: "checked", contradicted: 0, notEstablished: 0, judgementCalls: 1 }],
    ["unlisted", { version: 1, state: "unchecked", contradicted: 0, notEstablished: 0, judgementCalls: 0 }],
  ]);
  const out = withAttention(report(), [], briefs, NOW, "proj_1");
  assert.equal(out.threads[0]?.doing, "working · brief disputed: 1 contradicted, 2 not established");
  assert.equal(out.threads[1]?.doing, "working · brief: the check failed");
  assert.equal(out.main.doing, "working · brief checked, no disputes");
  assert.deepEqual(Object.keys(out.briefs).sort(), ["child", "grandchild", "main"]);
  // A brief alone does not put a thread in the queue.
  assert.deepEqual(out.queue, []);
});

test("every tool a checker used is found in its timeline, however nested", () => {
  assert.deepEqual(toolsUsed([{ kind: "conversation", role: "assistant", text: "{}" }, { kind: "system", systemKind: "operation" }]), []);
  assert.deepEqual(
    toolsUsed([
      { kind: "turn", children: [{ kind: "work", workKind: "command", command: "bb thread show" }, { kind: "conversation" }] },
      { kind: "work", workKind: "tool", toolName: "Read" },
      { kind: "work", workKind: "delegation", childRows: [{ kind: "work", workKind: "file-read" }] },
      null,
    ]),
    ["command", "Read", "delegation", "file-read"],
  );
});

// ---- the CLI ------------------------------------------------------------

function cli(caller: string | null = "child") {
  const w = world();
  const files = new Map<string, string>();
  const attention: Attention = {
    asks: w.asks,
    briefs: w.briefs,
    readFile: async (_threadId, path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("no such file");
      return text;
    },
  };
  const actions: CliActions = {
    archiveChecked: async () => ({ title: "T", under: 0 }),
    parkChecked: async () => {
      throw new Error("unused");
    },
    resumeChecked: async () => ({ title: "T" }),
    nextChecked: async () => {
      throw new Error("unused");
    },
    todoChecked: async () => {
      throw new Error("unused");
    },
    status: async () => report(),
  };
  const built = cowCli(actions, attention);
  const run = (argv: string[], as: string | null = caller) =>
    built.run(argv, { projectId: "proj_1", cwd: "/work", signal: new AbortController().signal, ...(as === null ? {} : { threadId: as }) });
  return { ...w, files, run };
}

test("ask records a question for the caller's thread and prints its id first", async () => {
  const { run, asks } = cli();
  const result = await run(["ask", "--question", "Which colour?", "--option", "red", "--option", "blue::the colder one", "--risk", "medium", "--context", "for the logo"]);
  assert.equal(result.exitCode, 0, result.stderr);
  const [open] = await asks.list();
  assert.ok(open);
  assert.equal(result.stdout?.split("\n")[0], open.id);
  assert.equal(open.threadId, "child");
  assert.equal(open.risk, "medium");
  assert.deepEqual(open.options.map((option) => option.label), ["red", "blue"]);
  assert.equal(open.optionsOnly, false);

  const asJson = await run(["ask", "--question", "Sure?", "--option", "yes", "--option", "no", "--options-only", "--json"]);
  const body = JSON.parse(asJson.stdout ?? "");
  assert.equal(body.ok, true);
  assert.equal(body.ask.optionsOnly, true);
});

test("ask refuses what it cannot record, with the reason", async () => {
  const { run, asks } = cli();
  const missing = await run(["ask"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /--question/);
  const unrelated = await run(["ask", "--question", "Q?", "--thread", "child"], "other");
  assert.equal(unrelated.exitCode, 1);
  assert.match(unrelated.stderr ?? "", /neither that thread nor above it/);
  const nowhere = await run(["ask", "--question", "Q?"], null);
  assert.equal(nowhere.exitCode, 1);
  assert.match(nowhere.stderr ?? "", /--thread/);
  const badRisk = await run(["ask", "--question", "Q?", "--risk", "extreme"]);
  assert.equal(badRisk.exitCode, 1);
  const asJson = await run(["ask", "--question", "Q?", "--options-only", "--json"]);
  assert.equal(asJson.exitCode, 1);
  assert.equal(JSON.parse(asJson.stdout ?? "").error.code, "bad_ask");
  assert.deepEqual(await asks.list(), []);
});

test("a thread above asks for a thread under it", async () => {
  const { run, asks } = cli();
  const result = await run(["ask", "--question", "Q?", "--thread", "grandchild"], "main");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal((await asks.list())[0]?.threadId, "grandchild");
});

test("asks lists open asks oldest first; --all includes the rest", async () => {
  const { run, asks, clock } = cli();
  assert.equal((await run(["asks"])).stdout, "no open asks\n");
  await run(["ask", "--question", "First?", "--option", "a", "--option", "b"]);
  clock.now += MINUTE;
  await run(["ask", "--question", "Second?", "--thread", "grandchild"], "main");
  const [first, second] = await asks.list();
  assert.ok(first && second);
  const listed = await run(["asks"]);
  assert.ok((listed.stdout ?? "").indexOf("First?") < (listed.stdout ?? "").indexOf("Second?"));
  assert.match(listed.stdout ?? "", /1\. a\n {4}2\. b\n {4}\(or an answer in words\)/);
  assert.doesNotMatch((await run(["asks", "--thread", "grandchild"])).stdout ?? "", /First\?/);

  const gone = await run(["ask", "withdraw", first.id]);
  assert.equal(gone.exitCode, 0, gone.stderr);
  assert.match(gone.stdout ?? "", /withdrew ask_\w+: First\?/);
  assert.doesNotMatch((await run(["asks"])).stdout ?? "", /First\?/);
  const all = JSON.parse((await run(["asks", "--all", "--json"])).stdout ?? "");
  assert.deepEqual(all.asks.map((entry: Ask) => entry.status), ["withdrawn", "open"]);

  const notMine = await run(["ask", "withdraw", second.id], "other");
  assert.equal(notMine.exitCode, 1);
  const unknown = await run(["ask", "withdraw", "ask_nope"]);
  assert.match(unknown.stderr ?? "", /there is no ask ask_nope/);
});

test("there is no command that answers an ask", async () => {
  const { run } = cli();
  const result = await run(["answer", "ask_1", "--option", "1"]);
  assert.equal(result.exitCode, 1);
  const help = await run(["--help"]);
  assert.doesNotMatch(help.stdout ?? "", /^\s*answer\b/m);
});

const BRIEF = {
  summary: "Did it.",
  claims: [
    { text: "A holds", label: "checked", evidence: [{ description: "log", text: "A: yes" }] },
    { text: "B holds", label: "checked", evidence: [{ description: "log", text: "B: no" }] },
  ],
  notDone: ["C"],
};

test("brief submit reads the file, stores the brief and starts the check; show puts disputes first", async () => {
  const { run, files, reply, started } = cli();
  files.set("/work/brief.json", JSON.stringify(BRIEF));
  const stored = await run(["brief", "submit", "brief.json"]);
  assert.equal(stored.exitCode, 0, stored.stderr);
  assert.equal(stored.stdout, "stored brief v1 for child: brief being checked\n");
  assert.equal(started.length, 1);

  reply("chk_1", JSON.stringify({ claims: [{ id: "c1", shows: "The log says A: yes.", verdict: "supported", needs: null }, { id: "c2", shows: "The log says B: no.", verdict: "not-supported", needs: null }] }));
  const shown = await run(["brief", "show", "child"], "main");
  assert.equal(shown.exitCode, 0, shown.stderr);
  const text = shown.stdout ?? "";
  assert.match(text, /Disputes \(1\)\n {2}CONTRADICTED {2}c2 {2}“B holds” {2}\(the agent says: checked\)\n {6}the evidence shows: The log says B: no\.\n {6}checker: not supported/);
  assert.ok(text.indexOf("Disputes (1)") < text.indexOf("Other claims (1)"));

  const body = JSON.parse((await run(["brief", "show", "child", "--json"])).stdout ?? "");
  assert.equal(body.ok, true);
  assert.deepEqual(body.disputes.map((entry: { id: string; dispute: string; agentLabel: string; verdict: string }) => [entry.id, entry.dispute, entry.agentLabel, entry.verdict]), [["c2", "contradicted", "checked", "not-supported"]]);
  assert.deepEqual(body.claims.map((entry: { id: string; verdict: string }) => [entry.id, entry.verdict]), [["c1", "supported"]]);
  // The evidence text stays out of the listing.
  assert.deepEqual(body.claims[0].evidence, [{ description: "log", path: null }]);

  const status = await run(["status"], "main");
  assert.match(status.stdout ?? "", /child \(child\)  working · brief disputed: 1 contradicted/);
});

test("brief submit says what is wrong with a file it cannot take", async () => {
  const { run, files } = cli();
  const missing = await run(["brief", "submit", "/nowhere.json"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr ?? "", /cannot read \/nowhere\.json: no such file/);
  files.set("/work/bad.json", "{ not json");
  assert.match((await run(["brief", "submit", "bad.json"])).stderr ?? "", /is not valid JSON/);
  files.set("/work/thin.json", JSON.stringify({ summary: "x", claims: [{ text: "y", label: "sure" }] }));
  const invalid = await run(["brief", "submit", "thin.json", "--json"]);
  assert.equal(invalid.exitCode, 1);
  const error = JSON.parse(invalid.stdout ?? "").error;
  assert.equal(error.code, "bad_brief");
  assert.match(error.message, /claims\[0\]\.label: must be one of/);
  assert.match(error.hint, /"judgementCalls"/);
});

test("brief check is refused for the audited thread and runs for the one above it", async () => {
  const { run, files, started, reply } = cli();
  files.set("/work/brief.json", JSON.stringify(BRIEF));
  await run(["brief", "submit", "brief.json"]);
  reply("chk_1", "nonsense");
  const own = await run(["brief", "check", "child"]);
  assert.equal(own.exitCode, 1);
  assert.match(own.stderr ?? "", /cannot order the audit of its own brief/);
  const above = await run(["brief", "check", "child", "--runs", "2", "--model", "tiny"], "main");
  assert.equal(above.exitCode, 0, above.stderr);
  assert.match(above.stdout ?? "", /checking brief v1 of child: 2 run\(s\) started/);
  assert.deepEqual(started.slice(1).map((start) => start.model), ["tiny", "tiny"]);
  assert.equal((await run(["brief", "check", "child", "--runs", "9"], "main")).exitCode, 1);
  assert.match((await run(["brief", "show", "main"])).stderr ?? "", /main has submitted no brief/);
});

test("status lists open asks under what is waiting on the user", async () => {
  const { run } = cli();
  await run(["ask", "--question", "Which colour?"]);
  const status = await run(["status"], "main");
  assert.match(status.stdout ?? "", /Waiting on the user \(1\)\n 1  child \(child\)  asks \(ask_\w+\): Which colour\? · waiting 1m/);
  const body = JSON.parse((await run(["status", "--json"], "main")).stdout ?? "");
  assert.equal(body.threads[0].state, "wants");
  assert.equal(body.asks.length, 1);
  assert.equal(body.asksElsewhere, 0);
});

test("a path is read against the folder the command ran in", () => {
  assert.equal(absolutePath("/a/brief.json", "/work"), "/a/brief.json");
  assert.equal(absolutePath("brief.json", "/work/"), "/work/brief.json");
  assert.equal(absolutePath("./out/brief.json", "/work"), "/work/out/brief.json");
  assert.throws(() => absolutePath("brief.json", null), /not known/);
});
