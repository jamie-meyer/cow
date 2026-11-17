import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { toolsUsed } from "../src/raised-backend.ts";
import { type Attention, absolutePath } from "../src/raised-cli.ts";
import { withRaised } from "../src/raised.ts";
import type { BriefMark } from "../src/briefs/review.ts";
import { type CliActions, cowCli } from "../src/cli.ts";
import type { StatusLine, StatusReport } from "../src/status.ts";
import { MINUTE } from "./fixtures.ts";
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
  project: false,
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
  closed: null,
  capability: null,
  ...overrides,
});

test("the overview lists its asks, and each line says what its brief came to", () => {
  const mark = (overrides: Partial<BriefMark>): BriefMark => ({ version: 1, state: "checked", contradicted: 0, notEstablished: 0, judgementCalls: 0, at: NOW, read: false, ...overrides });
  const briefs = new Map<string, BriefMark>([
    ["child", mark({ version: 2, contradicted: 1, notEstablished: 2 })],
    ["grandchild", mark({ state: "failed" })],
    ["main", mark({ judgementCalls: 1 })],
    ["unlisted", mark({ state: "unchecked" })],
  ]);
  const waiting = { ...line("child", { state: "wants", doing: "brief: 3 disputed", queue: 1 }), waiting: "1m" };
  const out = withRaised(
    report({ threads: [line("child", { state: "wants", doing: "brief: 3 disputed", queue: 1 }), line("grandchild", { depth: 1 })], queue: [waiting] }),
    [ask("ask_b", "child", 5), ask("ask_a", "child", 90), ask("ask_x", "elsewhere", 5), ask("ask_y", "far", 5, { projectId: "proj_2" })],
    briefs,
    "proj_1",
  );
  // A line that already waits on its brief is not told twice.
  assert.equal(out.threads[0]?.doing, "brief: 3 disputed");
  assert.equal(out.queue[0]?.doing, "brief: 3 disputed");
  assert.equal(out.threads[1]?.doing, "working · brief: the check failed");
  assert.equal(out.main.doing, "working · brief checked, no disputes");
  assert.deepEqual(Object.keys(out.briefs).sort(), ["child", "grandchild", "main"]);
  assert.deepEqual(out.asks.map((entry) => entry.id), ["ask_a", "ask_b"]);
  assert.equal(out.asksElsewhere, 1);
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
    projectChecked: async () => {
      throw new Error("unused");
    },
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

test("ask close records the user's answer as given in chat; the asks list says who closed what", async () => {
  const { run, asks, sent } = cli();
  await run(["ask", "--question", "Which colour?", "--option", "red", "--option", "blue"]);
  await run(["ask", "--question", "What size?"]);
  await run(["ask", "--question", "Which font?"]);
  const [colour, size, font] = await asks.list();
  assert.ok(colour && size && font);

  const closed = await run(["ask", "close", colour.id, "--answered", "blue, as you said in chat"]);
  assert.equal(closed.exitCode, 0, closed.stderr);
  assert.match(closed.stdout ?? "", new RegExp(`closed ${colour.id} as answered in chat: Which colour\\?\\n  the answer, as you gave it: blue, as you said in chat`));
  // Nothing is sent to the thread, and it is out of the open list at once.
  assert.deepEqual(sent, []);
  assert.doesNotMatch((await run(["asks"])).stdout ?? "", /Which colour\?/);

  // The answer is required; an unrelated thread cannot close it; it closes once.
  assert.equal((await run(["ask", "close", size.id])).exitCode, 1);
  const empty = await run(["ask", "close", size.id, "--answered", "  "]);
  assert.equal(empty.exitCode, 1);
  assert.match(empty.stderr ?? "", /--answered is empty/);
  assert.equal((await run(["ask", "close", size.id, "--answered", "large"], "other")).exitCode, 1);
  assert.equal((await run(["ask", "close", colour.id, "--answered", "again"])).exitCode, 1);
  // A thread above closes it for the thread under it.
  assert.equal((await run(["ask", "close", size.id, "--answered", "large"], "main")).exitCode, 0);

  // The three ways an ask ends are told apart, each by who ended it.
  await asks.answer(font.id, { option: null, text: "serif" });
  await run(["ask", "--question", "Dropped?"]);
  const dropped = (await asks.list())[0]!;
  await run(["ask", "withdraw", dropped.id]);
  const all = await run(["asks", "--all"]);
  assert.match(all.stdout ?? "", /closed by the thread: answered in chat: blue, as you said in chat/);
  assert.match(all.stdout ?? "", /closed by main, a thread above it: answered in chat: large/);
  assert.match(all.stdout ?? "", /answered on cow's page: serif/);
  const json = JSON.parse((await run(["asks", "--all", "--json"])).stdout ?? "");
  assert.deepEqual(json.asks.map((entry: Ask) => entry.status), ["closed", "closed", "answered", "withdrawn"]);
  assert.deepEqual(json.asks[0].closed, { by: "thread", closedBy: "child", answer: "blue, as you said in chat", at: json.asks[0].closed.at });
  const help = await run(["--help"]);
  assert.match(help.stdout ?? "", /bb cow ask close/);
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
  assert.equal(JSON.parse((await run(["status", "--json"], "main")).stdout ?? "").briefs.child.contradicted, 1);
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
  // A checker that used a tool has failed for good; one whose answer could not be read would be run again first.
  reply("chk_1", "nonsense", ["Read"]);
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

test("status carries the open asks of the threads it lists", async () => {
  const { run } = cli();
  await run(["ask", "--question", "Which colour?"]);
  const body = JSON.parse((await run(["status", "--json"], "main")).stdout ?? "");
  assert.equal(body.asks.length, 1);
  assert.equal(body.asks[0].question, "Which colour?");
  assert.equal(body.asksElsewhere, 0);
});

test("a path is read against the folder the command ran in", () => {
  assert.equal(absolutePath("/a/brief.json", "/work"), "/a/brief.json");
  assert.equal(absolutePath("brief.json", "/work/"), "/work/brief.json");
  assert.equal(absolutePath("./out/brief.json", "/work"), "/work/out/brief.json");
  assert.throws(() => absolutePath("brief.json", null), /not known/);
});
