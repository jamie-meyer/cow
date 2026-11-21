import assert from "node:assert/strict";
import { test } from "node:test";
import { type CliActions, cowCli } from "../src/cli.ts";
import { type LedgerRow, PERSON, costText, rowUsageText, ledgerText, rowSchema, rowTokens, summarize, tokenFields } from "../src/ledger.ts";
import { ROW_PREFIX, createLedgerStore } from "../src/ledger-store.ts";
import { LIST_PRICES, LIST_PRICE_NOTE, cacheWritePrice, dollarsOf, priceOf, pricesWith } from "../src/prices.ts";
import { type SpendFacts, spendOf, spendText, spendThreads } from "../src/spend.ts";
import { USAGE_PREFIX, createUsageStore } from "../src/usage-store.ts";
import { NO_USAGE, dayOf, foldUsage, monthStart, monthUsage, readUsage, tokensOf, usageTotal } from "../src/usage.ts";
import { HOUR, NOW } from "./fixtures.ts";
import { memoryKv } from "./memory.ts";

// ---- bb's event, in the shape bb writes it ------------------------------------------
// The counts are the ones a three-turn Claude Code thread on claude-haiku-5-5
// recorded: its first turn ran a sub-agent, so its `last` (the final model
// call) is far below its `total`; the next two turns were one call each, and
// each `total` grew by exactly that turn's `last`.

const SESSION = "0d9a6c1e-session";
const counts = (total: number, input: number, read: number, write: number, output: number) => ({
  totalTokens: total,
  inputTokens: input,
  cachedInputTokens: read + write,
  cacheReadInputTokens: read,
  cacheWriteInputTokens: write,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
let seq = 0;
const usageEvent = (createdAt: number, total: ReturnType<typeof counts>, last: ReturnType<typeof counts>, session = SESSION) => ({
  id: `evt_${++seq}`,
  scope: { kind: "turn", turnId: `turn-${seq}` },
  threadId: "thr_w",
  seq,
  createdAt,
  type: "thread/tokenUsage/updated",
  data: { providerThreadId: session, tokenUsage: { total, last, modelContextWindow: 1_000_000, promptCacheTtlMs: 3_600_000 } },
});
const promptEvent = (createdAt: number, model: string) => ({ id: `evt_${++seq}`, threadId: "thr_w", seq, createdAt, type: "client/turn/requested", data: { source: "spawn", execution: { model } } });

const T1 = counts(133938, 10, 99646, 33896, 386);
const L1 = counts(34949, 4, 34479, 418, 48);
const T2 = counts(169519, 12, 134543, 34575, 389);
const L2 = counts(35581, 2, 34897, 679, 3);
const T3 = counts(205338, 14, 170119, 34628, 577);
const L3 = counts(35819, 2, 35576, 53, 188);

function threeTurns(start = NOW - 3 * HOUR) {
  seq = 0;
  return [promptEvent(start, "claude-haiku-5-5"), usageEvent(start + 60_000, T1, L1), usageEvent(start + HOUR, T2, L2), usageEvent(start + 2 * HOUR, T3, L3)];
}

test("bb's counts read as the four: input apart from the cache, cache reads, cache writes, output", () => {
  assert.deepEqual(tokensOf(T1), { input: 10, cacheRead: 99646, cacheWrite: 33896, output: 386 });
  // A provider that counts cached input inside input, with no read/write split (totalTokens = input + output).
  assert.deepEqual(tokensOf({ totalTokens: 1500, inputTokens: 1000, cachedInputTokens: 600, outputTokens: 500, reasoningOutputTokens: 200 }), { input: 400, cacheRead: 600, cacheWrite: 0, output: 500 });
  // Reasoning apart from output (totalTokens counts it on its own).
  assert.deepEqual(tokensOf({ totalTokens: 1800, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 500, reasoningOutputTokens: 300 }), { input: 1000, cacheRead: 0, cacheWrite: 0, output: 800 });
  assert.equal(tokensOf({ inputTokens: "x" }), null);
});

test("three turns: the thread's usage is its latest total, each turn's the step from the one before; summing totals or lasts would be wrong", () => {
  const state = readUsage(threeTurns());
  assert.equal(state.events, 3);
  assert.deepEqual(usageTotal(state), tokensOf(T3), "the latest total is all of it");
  // A one-call turn's step is exactly its last.
  assert.deepEqual(foldUsage(readUsage(threeTurns().slice(0, 2)), threeTurns().slice(2, 3)).total["claude-haiku-5-5"], tokensOf(T2));
  const step2 = { input: T2.inputTokens - T1.inputTokens, cacheRead: T2.cacheReadInputTokens - T1.cacheReadInputTokens, cacheWrite: T2.cacheWriteInputTokens - T1.cacheWriteInputTokens, output: T2.outputTokens - T1.outputTokens };
  assert.deepEqual(step2, tokensOf(L2));
  assert.equal(T3.totalTokens - T2.totalTokens, L3.totalTokens);
  // The turn with a sub-agent: its last is one call, not the turn.
  assert.ok(L1.totalTokens < T1.totalTokens);
  assert.notEqual(L1.totalTokens + L2.totalTokens + L3.totalTokens, T3.totalTokens);
  assert.equal(state.ttlMs, 3_600_000);
  assert.equal(state.model, "claude-haiku-5-5");
});

test("reading on from where it stopped comes to the same as reading it all; an event already read is not counted twice", () => {
  const all = threeTurns();
  const once = readUsage(all);
  const inSteps = foldUsage(foldUsage(readUsage(all.slice(0, 2)), all.slice(2, 3)), all);
  assert.deepEqual(inSteps, once);
});

test("bb keeps only the latest event: reading it alone gives the same total", () => {
  const all = threeTurns();
  const latest = readUsage([all[0], all[3]]);
  assert.deepEqual(usageTotal(latest), usageTotal(readUsage(all)));
});

test("a total that falls back is a new session: it is added, not subtracted", () => {
  seq = 0;
  const state = readUsage([usageEvent(NOW, T2, L2), usageEvent(NOW + 1, counts(100, 10, 50, 20, 20), counts(100, 10, 50, 20, 20))]);
  assert.deepEqual(usageTotal(state), { input: 22, cacheRead: 134593, cacheWrite: 34595, output: 409 });
  seq = 0;
  const two = readUsage([usageEvent(NOW, T1, L1, "a"), usageEvent(NOW + 1, T1, L1, "b")]);
  assert.equal(usageTotal(two)?.input, 20, "two sessions of one thread both count");
});

// A long-lived thread, as bb recorded one: its provider process starts again
// often (bb writes `thread/identity`), the session id stays the same, and the
// new process's `total` starts from zero. With a context that only grows, the
// new `total` can be above the old one in all four counts after a single
// turn, so it does not look like a fall.
const identityEvent = (createdAt: number, session = SESSION) => ({ id: `evt_${++seq}`, threadId: "thr_w", seq, createdAt, type: "thread/identity", data: { providerThreadId: session } });
const BIG_TURN = counts(290563, 12, 256151, 34000, 400);

test("a new provider process starts its total again: after thread/identity the next total is all new, even when it is above the last", () => {
  seq = 0;
  const events = [identityEvent(NOW), promptEvent(NOW, "claude-haiku-5-5"), usageEvent(NOW + 1, T1, L1), identityEvent(NOW + 2), usageEvent(NOW + 3, BIG_TURN, BIG_TURN)];
  const state = readUsage(events);
  // Every count is above T1's, so 0.2.19 took the step from T1, as if one process had gone on: 133,938 of the turn's 290,563 tokens were lost.
  assert.ok(BIG_TURN.inputTokens >= T1.inputTokens && BIG_TURN.cacheReadInputTokens >= T1.cacheReadInputTokens && BIG_TURN.cacheWriteInputTokens >= T1.cacheWriteInputTokens && BIG_TURN.outputTokens >= T1.outputTokens);
  assert.deepEqual(usageTotal(state), { input: 10 + 12, cacheRead: 99646 + 256151, cacheWrite: 33896 + 34000, output: 386 + 400 });
  // Read one event at a time, as cow does at the end of each turn, it comes to the same.
  let piecewise = NO_USAGE;
  for (const event of events) piecewise = foldUsage(piecewise, [event]);
  assert.deepEqual(usageTotal(piecewise), usageTotal(state));
  // The mark is used once: the same process's next turn is a step again.
  const next = foldUsage(state, [usageEvent(NOW + 4, counts(BIG_TURN.totalTokens + 999, 12, 256151 + 900, 34000, 400 + 99), L1)]);
  assert.equal(usageTotal(next)!.cacheRead, 99646 + 256151 + 900);
  assert.deepEqual(next.restarted, []);
});

test("a thread/identity before any usage, or of another session, changes nothing", () => {
  seq = 0;
  const state = readUsage([identityEvent(NOW), usageEvent(NOW + 1, T1, L1), identityEvent(NOW + 2, "other"), usageEvent(NOW + 3, T2, L2)]);
  assert.deepEqual(usageTotal(state), usageTotal(readUsage([usageEvent(NOW + 1, T1, L1), usageEvent(NOW + 3, T2, L2)])));
});

test("the mark of a new process is kept with the rest: read before its usage arrives, it still counts", async () => {
  const kv = memoryKv();
  seq = 0;
  const pages = [[usageEvent(NOW, T1, L1), identityEvent(NOW + 1)], [usageEvent(NOW + 2, BIG_TURN, BIG_TURN)]];
  let at = 0;
  const store = createUsageStore(kv, async () => pages[at++] ?? []);
  await store.read("thr_w");
  assert.deepEqual((await store.kept("thr_w"))?.restarted, [SESSION]);
  // A new store, as after cow is loaded again, over the same storage.
  const again = createUsageStore(kv, async () => pages[at++] ?? []);
  const { state } = await again.read("thr_w");
  assert.equal(usageTotal(state)!.cacheRead, 99646 + 256151);
  // A record kept by 0.2.19 has no such mark, and reads as before.
  const old = { ...(kv.data.get(USAGE_PREFIX + "thr_w") as { state: Record<string, unknown> }) };
  const { restarted: _gone, ...state19 } = old.state;
  kv.data.set(USAGE_PREFIX + "thr_old", { ...old, state: state19 });
  assert.equal(usageTotal((await again.kept("thr_old"))!)!.cacheRead, 99646 + 256151);
});

test("usage is kept by day, so a month is summed for a thread that spans months", () => {
  seq = 0;
  const oct = new Date(2026, 9, 31, 22).getTime();
  const nov = new Date(2026, 10, 1, 9).getTime();
  const state = readUsage([promptEvent(oct - 1, "claude-opus-5-5"), usageEvent(oct, T1, L1), usageEvent(nov, T2, L2)]);
  assert.deepEqual(Object.keys(state.days).sort(), [dayOf(oct), dayOf(nov)]);
  assert.deepEqual(monthUsage(state, "2026-10")["claude-opus-5-5"], tokensOf(T1));
  assert.deepEqual(monthUsage(state, "2026-11")["claude-opus-5-5"], tokensOf(L2));
  assert.equal(monthStart("2026-11"), new Date(2026, 10, 1).getTime());
});

test("a thread with no usage event has unknown usage, never zero", () => {
  assert.equal(usageTotal(readUsage([promptEvent(NOW, "x")])), null);
  assert.equal(usageTotal(NO_USAGE), null);
});

// ---- list prices --------------------------------------------------------------------

test("every price in the table says when it was taken and from which page", () => {
  for (const [model, price] of Object.entries(LIST_PRICES)) {
    assert.match(price.taken, /^\d{4}-\d{2}-\d{2}$/, model);
    assert.match(price.source, /^https:\/\//, model);
    assert.ok(price.cacheWrite.length > 0, model);
  }
});

test("the cache lifetime picks the cache-write price; with none known, the shortest", () => {
  const opus = LIST_PRICES["claude-opus-5-5"];
  assert.ok(opus);
  assert.equal(cacheWritePrice(opus, 300_000), 5);
  assert.equal(cacheWritePrice(opus, 3_600_000), 8);
  assert.equal(cacheWritePrice(opus, null), 5);
  // 1M each of input, cache read, 1h cache write and output on Opus 5.5: 4 + 0.2 + 8 + 20.
  assert.equal(dollarsOf({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, opus, 3_600_000), 32.2);
});

test("the setting changes a price, adds one, or takes one out; a bad setting is said and the table stands", () => {
  const set = pricesWith(JSON.stringify({ "claude-opus-5-5": { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 }, "my-model": { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 }, "gpt-5.5": null }));
  assert.equal(set.error, null);
  assert.equal(priceOf(set.prices, "claude-opus-5-5")?.input, 1);
  assert.equal(priceOf(set.prices, "my-model")?.taken, "setting");
  assert.equal(priceOf(set.prices, "gpt-5.5"), null);
  assert.equal(priceOf(LIST_PRICES, "openai-codex/gpt-6-sol"), LIST_PRICES["gpt-6-sol"], "the same model through another provider");
  const bad = pricesWith("{oops");
  assert.match(bad.error ?? "", /not JSON/);
  assert.equal(bad.prices, LIST_PRICES);
});

// ---- the ledger ------------------------------------------------------------------------

const turnLog = [
  { seq: 1, createdAt: NOW - 2 * HOUR, type: "client/turn/requested", data: { source: "spawn", execution: { model: "claude-haiku-5-5", reasoningLevel: "low" } } },
  { seq: 2, createdAt: NOW - 2 * HOUR, type: "turn/started", data: {} },
  { seq: 3, createdAt: NOW - HOUR, type: "turn/completed", data: { status: "completed" } },
];
const worker = { id: "thr_w", projectId: "proj_1", parentThreadId: "thr_lead" };

function usageSource(events: unknown[]) {
  const asked: (number | null)[] = [];
  return {
    asked,
    events,
    read: async (_id: string, after: number | null) => (asked.push(after), (events as { seq: number }[]).filter((e) => after === null || e.seq > after)),
  };
}

test("a worker archived with usage has the four counts in its row; usage that comes later brings the row up to date", async () => {
  const kv = memoryKv();
  const events = threeTurns().slice(0, 3);
  const source = usageSource(events);
  const usage = createUsageStore(kv, source.read);
  const ledger = createLedgerStore(kv, async () => turnLog, () => undefined, usage);
  const row = await ledger.record(worker, { at: NOW, by: PERSON });
  assert.deepEqual(row && rowTokens(row), tokensOf(T2));
  assert.ok(kv.data.has(USAGE_PREFIX + worker.id), "what was read is kept");
  events.push(threeTurns()[3] as never);
  const later = await ledger.syncUsage(worker.id);
  assert.deepEqual(later && rowTokens(later), tokensOf(T3));
  assert.equal(source.asked[source.asked.length - 1], 3, "read on from the last event seen");
  assert.equal(await ledger.syncUsage(worker.id), null, "nothing new: nothing written");
  assert.equal(await ledger.syncUsage("thr_none"), null, "no row: nothing to bring up to date");
});

test("the usage store asks bb nothing when bb says the thread has not changed since it was read", async () => {
  const kv = memoryKv();
  const source = usageSource(threeTurns());
  const usage = createUsageStore(kv, source.read);
  await usage.read("thr_w", 1000);
  const asked = source.asked.length;
  const again = await usage.read("thr_w", 1000);
  assert.equal(source.asked.length, asked);
  assert.equal(again.fresh, false);
  await usage.read("thr_w", 2000);
  assert.equal(source.asked.length, asked + 1);
});

const at = (n: number) => NOW - n * HOUR;
const ledgerRow = (overrides: Partial<LedgerRow>): LedgerRow =>
  rowSchema.parse({
    threadId: `thr_${Math.random().toString(36).slice(2, 8)}`,
    projectId: "proj_1",
    dispatchedBy: "thr_lead",
    model: "claude-opus-5-5",
    effort: "high",
    firstTurnAt: at(3),
    firstReportAt: at(2),
    toFirstReportMs: HOUR,
    steersByPerson: 0,
    steersByThreads: 0,
    turns: 1,
    outcome: "done",
    judgedBy: PERSON,
    judgedAt: at(1),
    outcomeChanges: 0,
    archivedAt: at(1),
    archivedBy: PERSON,
    label: "lookup",
    ...overrides,
  });
const million = tokenFields({ input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 });

function costWith(setting?: string) {
  const { prices } = pricesWith(setting);
  return (row: LedgerRow) => {
    const tokens = rowTokens(row);
    const price = priceOf(prices, row.model);
    return tokens === null || price === null ? null : dollarsOf(tokens, price, null);
  };
}

const rows = [
  ledgerRow({ ...million, outcome: "done" }),
  ledgerRow({ ...million, outcome: "redone" }),
  ledgerRow({ ...million, model: "no-such-model", outcome: "done", label: "draft" }),
  // Written by 0.2.18: no token fields at all.
  rowSchema.parse(Object.fromEntries(Object.entries(ledgerRow({ label: "draft" })).filter(([key]) => !key.endsWith("Tokens")))),
];

test("by label: tokens, list-price dollars and dollars per done; no price shows tokens and no dollars; an old row is unknown", () => {
  const summary = summarize(rows, NOW, 14, costWith());
  const lookup = summary.byLabel.find((g) => g.key === "lookup");
  assert.equal(lookup?.dollars, 8, "2M input tokens on Opus 5.5 at $4");
  assert.equal(lookup?.dollarsPerDone, 8, "all of it, every outcome, over the one done");
  const draft = summary.byLabel.find((g) => g.key === "draft");
  assert.equal(draft?.dollars, null);
  assert.equal(draft?.unpriced, 1);
  assert.equal(draft?.unknownUsage, 1);
  assert.equal(draft?.tokens.input, 1e6);
  const text = ledgerText(summary, rows, ["label"], costWith());
  assert.match(text, /lookup: 2 workers .* 2\.00M tokens · \$8\.00 at list price · \$8\.00 per done/);
  assert.match(text, /draft: 2 workers .* 1\.00M tokens · no list price \(1 with usage unknown\)/);
  assert.doesNotMatch(text.split("\n").filter((line) => line.includes("no-such-model")).join("\n"), /\$0/);
  assert.match(text, /usage unknown/);
  assert.match(text, /estimate at the providers' list prices/);
  assert.equal(costText({ workers: 1, tokens: rowTokens(million as never) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, unknownUsage: 1, dollars: null, unpriced: 0, dollarsPerDone: null }), "usage unknown");
});

test("a row's usage as the sheet and the CLI show it: unknown for an old row, tokens and no dollars with no price", () => {
  assert.equal(rowUsageText(rows[3] as LedgerRow, null), "usage unknown");
  assert.equal(rowUsageText(rows[2] as LedgerRow, null), "1.00M tokens (input 1.00M, cache read 0, cache write 0, output 0) · no list price");
  assert.equal(rowUsageText(rows[0] as LedgerRow, 4), "1.00M tokens (input 1.00M, cache read 0, cache write 0, output 0) · $4.00 at list price");
});

test("a changed price changes the dollars of rows already written", () => {
  const before = summarize(rows, NOW, 14, costWith()).byLabel.find((g) => g.key === "lookup")?.dollars;
  const after = summarize(rows, NOW, 14, costWith(JSON.stringify({ "claude-opus-5-5": { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } }))).byLabel.find((g) => g.key === "lookup")?.dollars;
  assert.equal(before, 8);
  assert.equal(after, 2);
});

test("a row in storage written by 0.2.18 reads as unknown usage", async () => {
  const kv = memoryKv();
  const old = Object.fromEntries(Object.entries(ledgerRow({ threadId: "thr_old" })).filter(([key]) => !key.endsWith("Tokens")));
  await kv.set(ROW_PREFIX + "thr_old", old);
  const [read] = await createLedgerStore(kv, async () => []).rows();
  assert.equal(read && rowTokens(read), null);
});

// ---- the month ---------------------------------------------------------------------------

const facts = (id: string, parentThreadId: string | null, extra: Partial<SpendFacts> = {}): SpendFacts => ({
  id,
  projectId: "proj_1",
  title: id,
  parentThreadId,
  status: "idle",
  hasPendingInteraction: false,
  archivedAt: null,
  lastReadAt: null,
  latestAttentionAt: 0,
  createdAt: 0,
  originPluginId: null,
  originKind: null,
  visibility: "visible",
  sectionId: null,
  parentNotifications: "auto",
  updatedAt: NOW,
  ...extra,
});

test("the month: workers, project threads, Main and checker runs apart, archived ones too, and threads with no usage said", () => {
  const since = NOW - 10 * 24 * HOUR;
  const threads = [
    facts("main", null),
    facts("proj", "main"),
    facts("w1", "proj"),
    facts("w2", "main", { archivedAt: NOW - HOUR }),
    facts("w3", "main"),
    facts("old", "main", { archivedAt: since - HOUR, updatedAt: since - HOUR }),
    facts("check", null, { visibility: "hidden" }),
    facts("elsewhere", null),
  ];
  const wanted = spendThreads(threads, "main", [], ["check"], since);
  assert.deepEqual(
    Object.fromEntries(wanted.map((t) => [t.id, t.kind])),
    { main: "main", proj: "projects", w1: "workers", w2: "workers", w3: "workers", check: "checkers" },
  );
  seq = 0;
  const month = dayOf(NOW).slice(0, 7);
  const used = readUsage([promptEvent(NOW - 2, "claude-opus-5-5"), usageEvent(NOW - 1, T1, L1)]);
  const spend = spendOf(
    month,
    "main",
    wanted.map((t) => ({ kind: t.kind, state: t.id === "w3" ? NO_USAGE : used })),
    LIST_PRICES,
  );
  assert.equal(spend.parts.workers.threads, 3);
  assert.equal(spend.parts.workers.noUsage, 1);
  assert.equal(spend.total.threads, 6);
  assert.ok((spend.parts.main.dollars ?? 0) > 0);
  const text = spendText(spend, "Main");
  for (const line of ["Workers: 3 threads", "Project threads: 1 thread", "Main: 1 thread", "cow's checker runs: 1 thread", "Total: 6 threads", "1 thread with no usage recorded"]) assert.ok(text.includes(line), `${line} in:\n${text}`);
  assert.ok(text.includes(LIST_PRICE_NOTE));
});

test("bb cow spend prints the month or JSON, and refuses a bad month", async () => {
  const unused = async () => {
    throw new Error("not used");
  };
  const asked: unknown[] = [];
  const actions: CliActions = {
    archiveChecked: unused,
    parkChecked: unused,
    resumeChecked: unused,
    status: unused,
    nextChecked: unused,
    todoChecked: unused,
    projectChecked: unused,
    waitChecked: unused,
    outcomeChecked: unused,
    ledger: unused,
    spend: async (mainId, projectId, month) => (asked.push([mainId, projectId, month]), { ...spendOf(month ?? "2026-11", "thr_main", [], LIST_PRICES), priceError: null, mainTitle: "M" }),
  };
  const command = cowCli(actions);
  const run = async (...argv: string[]) => command.run(argv, { projectId: "proj_1", threadId: undefined, signal: new AbortController().signal });
  assert.match((await run("spend")).stdout ?? "", /Spend in 2026-11 under Main “M” \(thr_main\)/);
  const json = JSON.parse((await run("spend", "--month", "2026-10", "--json")).stdout ?? "");
  assert.equal(json.month, "2026-10");
  assert.equal(json.listPrice, true);
  assert.equal(json.estimate, true);
  assert.deepEqual(asked, [[null, "proj_1", undefined], [null, "proj_1", "2026-10"]]);
  assert.notEqual((await run("spend", "--month", "Nov")).exitCode, 0);
});
