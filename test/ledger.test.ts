import assert from "node:assert/strict";
import { test } from "node:test";
import { type CliActions, cowCli } from "../src/cli.ts";
import {
  type Judgement,
  type LedgerRow,
  MAX_JUDGEMENTS,
  OUTCOMES,
  OUTCOME_TEXT,
  PERSON,
  ROW_KEYS,
  SMALL_GROUP,
  buildRow,
  durationText,
  groupText,
  judge,
  labelOf,
  ledgerText,
  median,
  outcomeFields,
  readTurns,
  rowSchema,
  summarize,
} from "../src/ledger.ts";
import { JUDGED_PREFIX, LABEL_PREFIX, ROW_PREFIX, createLedgerStore, turnEvents } from "../src/ledger-store.ts";
import { Refusal } from "../src/kv.ts";
import { DAY, HOUR, MINUTE, NOW } from "./fixtures.ts";
import { memoryKv } from "./memory.ts";

// ---- made-up event logs -------------------------------------------------------

let seq = 0;
const at = (minutes: number) => NOW - DAY + minutes * MINUTE;
const prompt = (minutes: number, data: Record<string, unknown>) => ({ seq: ++seq, createdAt: at(minutes), type: "client/turn/requested", data });
const spawn = (minutes: number, execution: Record<string, unknown> | null = { model: "claude-haiku-5-5", reasoningLevel: "low" }) =>
  prompt(minutes, { source: "spawn", initiator: "user", systemMessageKind: "unlabeled", target: { kind: "thread-start" }, ...(execution ? { execution } : {}) });
const person = (minutes: number, steer = true) => prompt(minutes, { source: "tell", initiator: "user", systemMessageKind: "unlabeled", target: { kind: steer ? "steer" : "turn" } });
const agent = (minutes: number) => prompt(minutes, { source: "tell", initiator: "agent", systemMessageKind: "unlabeled", senderThreadId: "thr_lead", target: { kind: "steer" } });
const notice = (minutes: number) => prompt(minutes, { source: "tell", initiator: "user", systemMessageKind: "child-completed", target: { kind: "turn" } });
const started = (minutes: number) => ({ seq: ++seq, createdAt: at(minutes), type: "turn/started", data: {} });
const completed = (minutes: number, status = "completed") => ({ seq: ++seq, createdAt: at(minutes), type: "turn/completed", data: { status } });

/** A worker on a small model: steered once by the person and twice by its lead before it reported; then two more turns. */
function workerLog() {
  seq = 0;
  return [
    spawn(0),
    started(1),
    person(5),
    agent(7),
    notice(8),
    agent(9),
    completed(31),
    // After the first report: no steer counts.
    person(40, false),
    started(40),
    completed(45),
    agent(50),
    started(50),
    completed(52),
  ];
}

test("the first prompt says the model and effort; the first report is the first turn that finished; steers before it are counted by who sent them", () => {
  const facts = readTurns(workerLog());
  assert.deepEqual(facts, {
    model: "claude-haiku-5-5",
    effort: "low",
    firstTurnAt: at(1),
    firstReportAt: at(31),
    steersByPerson: 1,
    steersByThreads: 2,
    turns: 3,
  });
});

test("events in any order are read in the order bb wrote them", () => {
  const log = workerLog();
  assert.deepEqual(readTurns([...log].reverse()), readTurns(log));
});

test("a failed or interrupted first turn is no report: the steers that rescued it count, and the report is the turn that finished", () => {
  seq = 0;
  const facts = readTurns([spawn(0, { model: "claude-opus-5-5" }), started(1), completed(10, "failed"), person(12, false), started(12), completed(14, "interrupted"), agent(15), started(15), completed(30)]);
  assert.equal(facts.firstTurnAt, at(1));
  assert.equal(facts.firstReportAt, at(30));
  assert.equal(facts.steersByPerson, 1);
  assert.equal(facts.steersByThreads, 1);
  assert.equal(facts.turns, 3);
  assert.equal(facts.model, "claude-opus-5-5");
  assert.equal(facts.effort, null, "no effort recorded: null, not a guess");
});

test("a thread that never finished a turn has no row; nor model when bb recorded none", () => {
  seq = 0;
  const facts = readTurns([spawn(0, null), started(1)]);
  assert.equal(facts.firstReportAt, null);
  assert.equal(facts.model, null);
  assert.equal(buildRow({ id: "t", projectId: "p", parentThreadId: "lead" }, facts, { at: NOW, by: PERSON }, []), null);
});

const thread = { id: "thr_w", projectId: "proj_1", parentThreadId: "thr_lead" };

test("the row's keys are exactly the allowed set: no title, prompt, message text or reason", () => {
  const row = buildRow(thread, readTurns(workerLog()), { at: NOW, by: "thr_lead" }, [{ outcome: "done", by: "thr_lead", at: NOW }]);
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
  assert.deepEqual(Object.keys(rowSchema.shape).sort(), [...ROW_KEYS].sort());
  assert.equal(rowSchema.safeParse({ ...row, title: "x" }).success, false, "a row with anything more is not a row");
  assert.equal(row.toFirstReportMs, 30 * MINUTE);
  assert.equal(row.dispatchedBy, "thr_lead");
  assert.equal(row.archivedBy, "thr_lead");
  assert.equal(row.outcome, "done");
  assert.equal(row.label, null, "no label: null");
  const { label: _label, ...old } = row;
  assert.equal(rowSchema.parse(old).label, null, "a row written before labels reads as no label");
  assert.equal(row.inputTokens, null, "no usage given: unknown, not zero");
  const { inputTokens: _i, cacheReadTokens: _r, cacheWriteTokens: _w, outputTokens: _o, ...before } = row;
  const read = rowSchema.parse(before);
  assert.deepEqual([read.inputTokens, read.cacheReadTokens, read.cacheWriteTokens, read.outputTokens], [null, null, null, null], "a row written by 0.2.18 reads as unknown usage");
  for (const value of Object.values(row)) assert.ok(typeof value !== "string" || value.length <= 200);
});

test("each outcome has one short line of meaning; done means used as it came back", () => {
  assert.deepEqual([...OUTCOMES], ["done", "partial", "redone", "dropped"]);
  assert.match(OUTCOME_TEXT.done, /used as it came back/);
  for (const outcome of OUTCOMES) assert.ok(OUTCOME_TEXT[outcome].length < 60);
});

test("who may overwrite whom: the person anyone's, a thread a thread's, never a thread the person's", () => {
  const byLead = judge([], "done", "thr_lead", 1);
  assert.ok(byLead.ok);
  const byOther = judge(byLead.judgements, "partial", "thr_other", 2);
  assert.ok(byOther.ok);
  const byPerson = judge(byOther.judgements, "redone", PERSON, 3);
  assert.ok(byPerson.ok);
  const refused = judge(byPerson.judgements, "done", "thr_lead", 4);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, "person_judged");
    assert.match(refused.why, /the person judged it “redone”/);
  }
  const again = judge(byPerson.judgements, "dropped", PERSON, 5);
  assert.ok(again.ok);
  assert.deepEqual(outcomeFields(again.judgements), { outcome: "dropped", judgedBy: PERSON, judgedAt: 5, outcomeChanges: 3 });
  assert.deepEqual(outcomeFields([]), { outcome: null, judgedBy: null, judgedAt: null, outcomeChanges: 0 });
});

test("past the limit of judgements a change is refused, so the count of changes stays true", () => {
  let list: Judgement[] = [];
  for (let i = 0; i < MAX_JUDGEMENTS; i += 1) {
    const next = judge(list, "done", PERSON, i);
    assert.ok(next.ok);
    list = next.judgements;
  }
  const over = judge(list, "partial", PERSON, 99);
  assert.equal(over.ok, false);
});

// ---- the summary -----------------------------------------------------------------

const row = (overrides: Partial<LedgerRow>): LedgerRow => ({
  threadId: `thr_${Math.random().toString(36).slice(2, 8)}`,
  projectId: "proj_1",
  dispatchedBy: "thr_lead",
  model: "claude-haiku-5-5",
  effort: "low",
  firstTurnAt: NOW - 2 * HOUR,
  firstReportAt: NOW - HOUR,
  toFirstReportMs: HOUR,
  steersByPerson: 0,
  steersByThreads: 0,
  turns: 1,
  outcome: null,
  judgedBy: null,
  judgedAt: null,
  outcomeChanges: 0,
  archivedAt: NOW - HOUR,
  archivedBy: PERSON,
  label: null,
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: null,
  ...overrides,
});

test("median of an even and an odd count", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("the summary groups by model and by dispatcher, counts each outcome and the unsaid, and gives medians and the share the person judged", () => {
  const rows = [
    row({ model: "claude-opus-5-5", outcome: "done", judgedBy: PERSON, toFirstReportMs: 10 * MINUTE, steersByPerson: 1 }),
    row({ model: "claude-opus-5-5", outcome: "done", judgedBy: "thr_lead", toFirstReportMs: 20 * MINUTE }),
    row({ model: "claude-opus-5-5", outcome: "partial", judgedBy: PERSON, toFirstReportMs: 30 * MINUTE, steersByThreads: 2 }),
    row({ model: "claude-opus-5-5", outcome: "redone", judgedBy: PERSON, toFirstReportMs: 40 * MINUTE, steersByPerson: 3 }),
    row({ model: "claude-opus-5-5", toFirstReportMs: 50 * MINUTE }),
    row({ model: "claude-haiku-5-5", dispatchedBy: "thr_other", outcome: "dropped", judgedBy: "thr_other" }),
    // Outside the window.
    row({ model: "claude-haiku-5-5", archivedAt: NOW - 20 * DAY }),
  ];
  const summary = summarize(rows, NOW, 14);
  assert.equal(summary.rows, 6);
  const [opus, haiku] = summary.byModel;
  assert.equal(opus?.key, "claude-opus-5-5");
  assert.equal(opus?.workers, 5);
  assert.deepEqual(opus?.outcomes, { done: 2, partial: 1, redone: 1, dropped: 0, unsaid: 1 });
  assert.equal(opus?.medianToFirstReportMs, 30 * MINUTE);
  assert.equal(opus?.medianSteers, 1);
  assert.equal(opus?.judgedByPerson, 3);
  assert.equal(opus?.small, false);
  assert.equal(opus?.shares?.judgedByPerson, 0.6);
  assert.equal(opus?.shares?.outcomes.done, 0.4);
  assert.equal(haiku?.workers, 1);
  assert.equal(haiku?.small, true);
  assert.equal(haiku?.shares, null, "a small group has no percentages");
  assert.deepEqual(summary.byDispatcher.map((g) => [g.key, g.workers]), [["thr_lead", 5], ["thr_other", 1]]);
});

test("a group of fewer than five shows counts and says it is too small to compare, with no percentages", () => {
  const summary = summarize([row({ outcome: "done", judgedBy: PERSON }), row({})], NOW, 14);
  const text = groupText(summary.byModel[0]!);
  assert.match(text, /2 workers · done 1, partial 0, redone 0, dropped 0, unsaid 1/);
  assert.match(text, new RegExp(`fewer than ${SMALL_GROUP} workers: too small to compare`));
  assert.doesNotMatch(text, /%/);
  const big = summarize(Array.from({ length: 5 }, () => row({ outcome: "done", judgedBy: PERSON })), NOW, 14);
  assert.match(groupText(big.byModel[0]!), /done 5 \(100%\)/);
  assert.match(groupText(big.byModel[0]!), /judged by the person 5 \(100%\)/);
});

test("durations are written short", () => {
  assert.equal(durationText(null), "–");
  assert.equal(durationText(45_000), "45s");
  assert.equal(durationText(12 * MINUTE), "12m");
  assert.equal(durationText(65 * MINUTE), "1h 5m");
  assert.equal(durationText(51 * HOUR), "2d 3h");
});

test("the ledger as text holds no titles, says what it holds, and says when it is empty", () => {
  const empty = ledgerText(summarize([], NOW, 14), []);
  assert.match(empty, /0 workers archived through cow in the last 14 days/);
  assert.match(empty, /no titles, prompts or message text/);
  const one = row({ threadId: "thr_one", outcome: "redone", judgedBy: PERSON, outcomeChanges: 1, steersByPerson: 2 });
  const text = ledgerText(summarize([one], NOW, 14), [one]);
  assert.match(text, /By model\n  claude-haiku-5-5: 1 worker/);
  assert.match(text, /thr_one · claude-haiku-5-5 · low · first report after 1h · steered 2 by the person, 0 by threads · 1 turn · redone \(judged by the person, changed 1×\)/);
});

// ---- the store --------------------------------------------------------------------

/** Events served a page at a time, oldest first, as bb does. */
function served(log: readonly { seq: number }[], pageSize = 100) {
  const asked: (number | null)[] = [];
  return {
    asked,
    read: async (_threadId: string, afterSeq: number | null) => {
      asked.push(afterSeq);
      return log.filter((event) => afterSeq === null || event.seq > afterSeq).slice(0, pageSize);
    },
  };
}

test("a long log is read page by page to its end", async () => {
  seq = 0;
  const log = [spawn(0), ...Array.from({ length: 150 }, (_, i) => [started(i * 2 + 1), completed(i * 2 + 2)]).flat()];
  const source = served(log);
  const events = await turnEvents(source.read, "t");
  assert.equal(events.length, 301);
  assert.deepEqual(source.asked, [null, 100, 200, 300]);
  assert.equal(readTurns(events).turns, 150);
});

test("archiving writes the row with the outcome judged so far; a later outcome updates it; a thread cannot overwrite the person", async () => {
  const kv = memoryKv();
  let changes = 0;
  const store = createLedgerStore(kv, served(workerLog()).read, () => (changes += 1));
  // Judged on its To settle line before it was archived.
  await store.judge(thread.id, "partial", "thr_lead", NOW - 2 * HOUR);
  assert.equal(kv.data.has(ROW_PREFIX + thread.id), false, "no row until it is archived");
  const row = await store.record(thread, { at: NOW - HOUR, by: "thr_lead" });
  assert.equal(row?.outcome, "partial");
  assert.equal(row?.judgedBy, "thr_lead");
  // The person changes it later: the row shows the latest, and the count of changes.
  const later = await store.judge(thread.id, "redone", PERSON, NOW);
  assert.equal(later.row?.outcome, "redone");
  assert.equal(later.row?.outcomeChanges, 1);
  assert.deepEqual((await store.rows())[0], later.row);
  assert.deepEqual(
    (await store.judgements(thread.id)).map((j) => [j.outcome, j.by]),
    [["partial", "thr_lead"], ["redone", PERSON]],
  );
  // A thread is refused, and told why.
  const refusal = await store.refusal(thread.id, "thr_lead");
  assert.ok(refusal instanceof Refusal);
  await assert.rejects(store.judge(thread.id, "done", "thr_lead", NOW), (cause: unknown) => cause instanceof Refusal && cause.code === "person_judged" && /a thread cannot change what the person judged/.test(cause.message));
  assert.equal((await store.outcomes()).get(thread.id)?.outcome, "redone");
  assert.equal(await store.refusal(thread.id, PERSON), null);
  assert.ok(changes >= 3);
  assert.ok(kv.data.has(JUDGED_PREFIX + thread.id));
});

test("a thread that never finished a turn gets no row, and says so", async () => {
  seq = 0;
  const store = createLedgerStore(memoryKv(), served([spawn(0), started(1)]).read);
  assert.equal(await store.record(thread, { at: NOW, by: PERSON }), null);
  assert.equal(await store.finished(thread.id), false);
  assert.deepEqual(await store.rows(), []);
});

// ---- the commands -------------------------------------------------------------------

function cli(overrides: Partial<CliActions> = {}) {
  const calls: unknown[][] = [];
  const unused = async () => {
    throw new Error("not used");
  };
  const actions: CliActions = {
    archiveChecked: async (args) => (calls.push(["archive", args]), { title: "T", under: 0, outside: false }),
    parkChecked: unused,
    resumeChecked: unused,
    status: unused,
    nextChecked: unused,
    todoChecked: unused,
    projectChecked: unused,
    waitChecked: unused,
    outcomeChecked: async (args) => (
      calls.push(["outcome", args]),
      { title: "T", archived: true, judgement: { outcome: args.outcome, by: args.callerId ?? PERSON, at: NOW }, changes: 1, row: true }
    ),
    ledger: async (days) => (calls.push(["ledger", days]), { rows: [], summary: summarize([], NOW, days), outcomes: {}, costs: {}, priceError: null }),
    ...overrides,
  };
  const command = cowCli(actions);
  const run = async (threadId: string | null, ...argv: string[]) => {
    const result = await command.run(argv, { projectId: "proj_1", threadId: threadId ?? undefined, signal: new AbortController().signal });
    return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { calls, run };
}

test("bb cow outcome takes a thread and one of the four, as the calling thread, or as the person outside any thread", async () => {
  const { calls, run } = cli();
  const done = await run("thr_lead", "outcome", "thr_w", "Partial");
  assert.equal(done.exitCode, 0);
  assert.match(done.stdout, /“T” \(thr_w\) came to: partial \(some of it was used, or it needed a second worker\) · judged by thr_lead · changed 1×/);
  await run(null, "outcome", "thr_w", "redone");
  assert.deepEqual(calls, [
    ["outcome", { callerId: "thr_lead", threadId: "thr_w", outcome: "partial" }],
    ["outcome", { callerId: null, threadId: "thr_w", outcome: "redone" }],
  ]);
  const bad = await run("thr_lead", "outcome", "thr_w", "great");
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stdout + bad.stderr, /not an outcome/);
});

test("bb cow archive passes --outcome through, and only when given", async () => {
  const { calls, run } = cli();
  const out = await run("thr_lead", "archive", "thr_w", "--reason", "merged", "--outcome", "done");
  assert.match(out.stdout, /archived “T” \(thr_w\): merged · came to: done/);
  await run("thr_lead", "archive", "thr_w");
  assert.deepEqual(calls, [
    ["archive", { callerId: "thr_lead", threadId: "thr_w", reason: "merged", outcome: "done" }],
    ["archive", { callerId: "thr_lead", threadId: "thr_w", reason: null }],
  ]);
  assert.notEqual((await run("thr_lead", "archive", "thr_w", "--outcome", "fine")).exitCode, 0);
});

test("bb cow ledger reads 14 days unless told, as text or JSON, and refuses a bad number of days", async () => {
  const { calls, run } = cli();
  assert.match((await run(null, "ledger")).stdout, /in the last 14 days/);
  const json = JSON.parse((await run(null, "ledger", "--days", "30", "--json")).stdout);
  assert.equal(json.ok, true);
  assert.equal(json.summary.days, 30);
  assert.deepEqual(json.rows, []);
  assert.deepEqual(calls, [["ledger", 14], ["ledger", 30]]);
  assert.notEqual((await run(null, "ledger", "--days", "0")).exitCode, 0);
});

// ---- labels ---------------------------------------------------------------------------

test("a label is one short word, lower-cased; anything else is refused with the rule", () => {
  assert.deepEqual(labelOf(" Code-Change "), { ok: true, label: "code-change" });
  assert.deepEqual(labelOf("lookup2"), { ok: true, label: "lookup2" });
  for (const bad of ["", "-draft", "two words", "a".repeat(25), "draft!", "naïve", "x_y"]) {
    const parsed = labelOf(bad);
    assert.equal(parsed.ok, false, bad);
    if (!parsed.ok) assert.match(parsed.why, /lower-case letters, digits and hyphens/);
  }
  assert.ok(labelOf("a".repeat(24)).ok);
});

test("a label set before archiving is in the row; one set after updates it; a thread cannot overwrite or clear the person's", async () => {
  const kv = memoryKv();
  const store = createLedgerStore(kv, served(workerLog()).read);
  await store.setLabel(thread.id, "lookup", "thr_lead", NOW - 2 * HOUR);
  assert.equal((await store.record(thread, { at: NOW - HOUR, by: "thr_lead" }))?.label, "lookup");
  const later = await store.setLabel(thread.id, "draft", "thr_lead", NOW);
  assert.equal(later.row?.label, "draft");
  assert.equal((await store.rows())[0]?.label, "draft");
  await store.setLabel(thread.id, "code-change", PERSON, NOW);
  assert.ok((await store.labelRefusal(thread.id, "thr_lead")) instanceof Refusal);
  await assert.rejects(store.setLabel(thread.id, "draft", "thr_lead", NOW), (cause: unknown) => cause instanceof Refusal && cause.code === "person_labelled");
  await assert.rejects(store.setLabel(thread.id, null, "thr_lead", NOW), (cause: unknown) => cause instanceof Refusal);
  assert.equal((await store.label(thread.id))?.label, "code-change");
  const cleared = await store.setLabel(thread.id, null, PERSON, NOW);
  assert.equal(cleared.row?.label, null);
  assert.equal(kv.data.has(LABEL_PREFIX + thread.id), false);
});

test("the summary groups by label, with (no label), and by model within each label; the text can show one grouping", () => {
  const rows = [
    row({ label: "code-change", model: "claude-opus-5-5", outcome: "done" }),
    row({ label: "code-change", model: "claude-haiku-5-5", outcome: "redone" }),
    row({ label: "code-change", model: "claude-haiku-5-5", outcome: "redone" }),
    row({ label: "lookup", model: "claude-haiku-5-5", outcome: "done" }),
    row({ model: "claude-haiku-5-5" }),
  ];
  const summary = summarize(rows, NOW, 14);
  assert.deepEqual(summary.byLabel.map((g) => [g.key, g.workers]), [["code-change", 3], ["(no label)", 1], ["lookup", 1]]);
  const code = summary.byLabel[0]!;
  assert.deepEqual(code.outcomes, { done: 1, partial: 0, redone: 2, dropped: 0, unsaid: 0 });
  assert.deepEqual(code.byModel.map((g) => [g.key, g.workers, g.outcomes.redone]), [["claude-haiku-5-5", 2, 2], ["claude-opus-5-5", 1, 0]]);
  const all = ledgerText(summary, rows);
  assert.match(all, /By model\n[\s\S]*By dispatching thread\n[\s\S]*By label, then by model\n  code-change: 3 workers[^\n]*\n    claude-haiku-5-5: 2 workers/);
  const only = ledgerText(summary, rows, ["label"]);
  assert.doesNotMatch(only, /By model\n/);
  assert.match(only, /\(no label\): 1 worker/);
});

test("bb cow label shows, sets and clears, refuses a bad label with the rule, and archive and outcome take --label", async () => {
  const labelCalls: unknown[] = [];
  const { calls, run } = cli({
    labelChecked: async (args) => (
      labelCalls.push(args),
      { title: "T", archived: false, label: args.label ? { label: args.label, by: args.callerId ?? PERSON, at: NOW } : args.label === undefined ? { label: "lookup", by: PERSON, at: NOW } : null, row: false }
    ),
  });
  assert.match((await run("thr_lead", "label", "thr_w", "Code-Change")).stdout, /labelled “T” \(thr_w\): code-change/);
  assert.match((await run("thr_lead", "label", "thr_w")).stdout, /is labelled lookup · set by the person/);
  assert.match((await run(null, "label", "thr_w", "--clear")).stdout, /cleared the label/);
  assert.deepEqual(labelCalls, [
    { callerId: "thr_lead", threadId: "thr_w", label: "code-change" },
    { callerId: "thr_lead", threadId: "thr_w" },
    { callerId: null, threadId: "thr_w", label: null },
  ]);
  const bad = await run("thr_lead", "label", "thr_w", "two words");
  assert.notEqual(bad.exitCode, 0);
  assert.match(bad.stdout + bad.stderr, /lower-case letters, digits and hyphens/);
  assert.notEqual((await run("thr_lead", "label", "thr_w", "x", "--clear")).exitCode, 0);
  await run("thr_lead", "archive", "thr_w", "--label", "draft");
  await run("thr_lead", "outcome", "thr_w", "done", "--label", "lookup");
  assert.deepEqual(calls, [
    ["archive", { callerId: "thr_lead", threadId: "thr_w", reason: null, label: "draft" }],
    ["outcome", { callerId: "thr_lead", threadId: "thr_w", outcome: "done", label: "lookup" }],
  ]);
  assert.notEqual((await run("thr_lead", "archive", "thr_w", "--label", "Bad Label")).exitCode, 0);
  assert.notEqual((await run(null, "ledger", "--by", "kind")).exitCode, 0);
  assert.match((await run(null, "ledger", "--by", "label")).stdout, /in the last 14 days/);
});
