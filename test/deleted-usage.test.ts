// A deleted thread's usage is kept and still counted: under its Main when its
// saved parent chain reaches it, in the all-threads total always. Usage lost
// before that is made again from the ledger. A kept record is never replaced
// by less, and goes only when forgotten on purpose.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type CliActions, cowCli } from "../src/cli.ts";
import { registerLedger } from "../src/ledger-backend.ts";
import { ROW_PREFIX } from "../src/ledger-store.ts";
import { PERSON, rowSchema, tokenFields } from "../src/ledger.ts";
import { spendText } from "../src/spend.ts";
import { USAGE_PREFIX, createUsageStore, lowers } from "../src/usage-store.ts";
import { type Tokens, dayOf, tokenSum, usageTotal } from "../src/usage.ts";
import { HOUR } from "./fixtures.ts";
import { memoryKv } from "./memory.ts";

const MODEL = "claude-haiku-5-5";
const NOW = Date.now();
const counts = (input: number, read: number, write: number, output: number) => ({
  totalTokens: input + read + write + output,
  inputTokens: input,
  cachedInputTokens: read + write,
  cacheReadInputTokens: read,
  cacheWriteInputTokens: write,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
/** A thread's prompt and one usage event: `n` thousand tokens of cache reads, an hour ago. */
const turn = (threadId: string, n: number) => [
  { id: `${threadId}-1`, threadId, seq: 1, createdAt: NOW - HOUR, type: "client/turn/requested", data: { execution: { model: MODEL } } },
  {
    id: `${threadId}-2`,
    threadId,
    seq: 2,
    createdAt: NOW - HOUR + 60_000,
    type: "thread/tokenUsage/updated",
    data: { providerThreadId: `${threadId}-session`, tokenUsage: { total: counts(10, n * 1000, 0, 5), last: counts(10, n * 1000, 0, 5), promptCacheTtlMs: 300_000 } },
  },
];
const used = (n: number) => 10 + n * 1000 + 5;

type Raw = { id: string; projectId: string; title: string; parentThreadId: string | null; status: string; archivedAt: number | null; createdAt: number; updatedAt: number };
const raw = (id: string, parentThreadId: string | null, archivedAt: number | null = null): Raw => ({ id, projectId: "proj_1", title: id, parentThreadId, status: "idle", archivedAt, createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR + 60_000 });

/** A bb with these threads and their events, as much of it as the ledger's backend uses. */
function fakeBb(threads: Raw[], events: Record<string, unknown[]>) {
  const kv = memoryKv();
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const warnings: string[] = [];
  const bb = {
    pluginId: "cow",
    storage: { kv },
    settings: { define: () => ({ get: async () => ({ listPrices: "" }) }) },
    realtime: { publish: () => undefined },
    log: { warn: (text: string) => void warnings.push(text), info: () => undefined },
    events: { on: (name: string, run: (payload: unknown) => void) => void handlers.set(name, [...(handlers.get(name) ?? []), run]) },
    sdk: {
      threads: {
        list: async ({ offset = 0, threadIds }: { offset?: number; threadIds?: string[] }) => (offset > 0 ? [] : threads.filter((t) => !threadIds || threadIds.includes(t.id))),
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, metadata: {} })) }),
        events: {
          list: async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) =>
            (events[threadId] ?? []).filter((e) => afterSeq === undefined || (e as { seq: number }).seq > Number(afterSeq)),
        },
      },
    },
  };
  const backend = registerLedger(bb as unknown as BbPluginApi, async () => []);
  const fire = async (name: string, payload: unknown) => {
    for (const run of handlers.get(name) ?? []) run(payload);
    await new Promise((done) => setTimeout(done, 10));
  };
  /** bb deletes the thread: it goes from the list, and with `event` bb says so. */
  const remove = async (id: string, event = true) => {
    const at = threads.findIndex((t) => t.id === id);
    const [gone] = threads.splice(at, 1);
    if (event) await fire("thread.deleted", { thread: { ...gone, deletedAt: NOW } });
  };
  return { kv, backend, threads, remove, warnings };
}

const workerTokens = async (backend: ReturnType<typeof fakeBb>["backend"]) => {
  const spend = await backend.spend("main");
  return { spend, workers: tokenSum(spend.parts.workers.tokens), total: tokenSum(spend.total.tokens) };
};

for (const event of [true, false]) {
  test(`a deleted worker's usage is still counted under its Main and in the all-threads total: ${event ? "thread.deleted fired" : "it just goes from bb's list"}`, async () => {
    const { kv, backend, remove } = fakeBb([raw("main", null), raw("w", "main", NOW - 1000)], { w: turn("w", 40) });
    const before = await workerTokens(backend);
    assert.equal(before.workers, used(40));
    assert.equal(before.spend.total.deleted, 0);
    const everythingBefore = await backend.everything();
    await remove("w", event);
    const after = await workerTokens(backend);
    assert.equal(after.workers, before.workers, "the worker's tokens stay under Main");
    assert.equal(after.total, before.total);
    assert.equal(after.spend.parts.workers.deleted, 1);
    assert.equal(after.spend.total.deleted, 1);
    assert.equal(after.spend.total.dollars, before.spend.total.dollars);
    assert.ok(spendText(after.spend, "Main").includes("1 deleted thread is still counted"), spendText(after.spend, "Main"));
    const everything = await backend.everything();
    assert.equal(tokenSum(everything.tokens), tokenSum(everythingBefore.tokens));
    assert.equal(everything.deleted, 1);
    const kept = kv.data.get(USAGE_PREFIX + "w") as { deletedAt: number | null; place: { parentThreadId: string; projectId: string; checker: boolean } };
    assert.equal(typeof kept.deletedAt, "number", "marked deleted");
    assert.deepEqual({ parent: kept.place.parentThreadId, project: kept.place.projectId, checker: kept.place.checker }, { parent: "main", project: "proj_1", checker: false });
    assert.ok(!JSON.stringify(kept).includes('"title"'), "no title kept");
  });
}

test("a deleted worker under a deleted parent under Main is counted under Main; one whose chain is lost only in the all-threads total", async () => {
  const { backend, remove } = fakeBb([raw("main", null), raw("p", "main"), raw("w", "p", NOW - 1000), raw("lost", "nobody")], { p: [], w: turn("w", 30), lost: turn("lost", 7) });
  const before = await workerTokens(backend);
  const all = tokenSum((await backend.everything()).tokens);
  assert.equal(before.total, used(30));
  assert.equal(all, used(30) + used(7));
  await remove("w");
  await remove("p", false);
  await remove("lost");
  const after = await workerTokens(backend);
  assert.equal(after.workers, used(30), "w → p (kept) → main");
  assert.equal(after.spend.total.deleted, 1, "p used nothing in the period: not counted");
  const everything = await backend.everything();
  assert.equal(tokenSum(everything.tokens), all, "every kept thread is in the all-threads total");
  assert.equal(everything.deleted, 2);
});

const row = (threadId: string, tokens: Tokens | null, archivedAt: number) =>
  rowSchema.parse({
    threadId,
    projectId: "proj_1",
    dispatchedBy: "main",
    model: MODEL,
    effort: null,
    firstTurnAt: archivedAt - HOUR,
    firstReportAt: archivedAt - 1000,
    toFirstReportMs: HOUR,
    steersByPerson: 0,
    steersByThreads: 0,
    turns: 1,
    outcome: "done",
    judgedBy: PERSON,
    judgedAt: archivedAt,
    outcomeChanges: 0,
    archivedAt,
    archivedBy: PERSON,
    label: null,
    ...tokenFields(tokens),
  });

test("a ledger row whose thread is gone and has no usage record becomes one, on its archive day, once; a row whose thread exists is left alone", async () => {
  const { kv, backend } = fakeBb([raw("main", null), raw("alive", "main", NOW - 1000)], { alive: [] });
  const archivedAt = NOW - 3 * 24 * HOUR;
  const tokens = { input: 100, cacheRead: 2_000_000, cacheWrite: 30_000, output: 4000 };
  await kv.set(ROW_PREFIX + "gone", row("gone", tokens, archivedAt));
  await kv.set(ROW_PREFIX + "alive", row("alive", tokens, archivedAt));
  await kv.set(ROW_PREFIX + "unknown", row("unknown", null, archivedAt));
  assert.equal(await backend.rebuild(), 1);
  const made = kv.data.get(USAGE_PREFIX + "gone") as { state: { total: Record<string, Tokens>; days: Record<string, Record<string, Tokens>> }; fromLedger: boolean; place: { parentThreadId: string } };
  assert.deepEqual(made.state.total, { [MODEL]: tokens });
  assert.deepEqual(made.state.days, { [dayOf(archivedAt)]: { [MODEL]: tokens } });
  assert.equal(made.place.parentThreadId, "main", "its dispatcher is its parent");
  assert.equal(made.fromLedger, true);
  assert.equal(kv.data.has(USAGE_PREFIX + "alive"), false, "its thread exists: left alone");
  assert.equal(kv.data.has(USAGE_PREFIX + "unknown"), false, "no tokens in the row: nothing to make");
  const snapshot = JSON.stringify([...kv.data.entries()]);
  assert.equal(await backend.rebuild(), 0, "run again: nothing made");
  assert.equal(JSON.stringify([...kv.data.entries()]), snapshot, "and nothing changed");
  const spend = await backend.spend("main");
  assert.equal(tokenSum(spend.parts.workers.tokens), tokenSum(tokens));
  assert.equal(spend.total.fromLedger, 1);
  assert.ok(spendText(spend, "Main").includes("1 of them was deleted before cow kept a deleted thread's usage: its usage is its ledger row's, all on its archive day."), spendText(spend, "Main"));
});

test("a stored record that does not parse is kept as it is, not counted, said in spend's notes and cow's log, and not written over", async () => {
  const { kv, backend, warnings } = fakeBb([raw("main", null), raw("w", "main"), raw("v", "main")], { w: turn("w", 5), v: turn("v", 9) });
  const bad = { state: { events: "many" }, seenUpdatedAt: null };
  await kv.set(USAGE_PREFIX + "w", bad);
  await kv.set(USAGE_PREFIX + "gone", "not a record");
  const spend = await backend.spend("main");
  assert.deepEqual(kv.data.get(USAGE_PREFIX + "w"), bad, "not written over");
  assert.equal(kv.data.get(USAGE_PREFIX + "gone"), "not a record");
  assert.equal(tokenSum(spend.total.tokens), used(9), "only the readable thread is counted");
  assert.equal(spend.total.threads, 2, "Main and v: w is not counted as a thread with no usage either");
  assert.equal(spend.unreadable, 2);
  const text = spendText(spend, "Main");
  assert.ok(text.includes("2 usage records could not be read: kept as stored, not counted, and not written over"), text);
  assert.ok(warnings.some((w) => w.includes("w") && w.includes("could not be read")));
  await kv.delete(USAGE_PREFIX + "gone");
  assert.ok(spendText(await backend.spend("main"), "Main").includes("1 usage record could not be read"));
  // The ledger's row is not given less either: the thread's tokens read as unknown.
  const usage = createUsageStore(kv, async () => turn("w", 5));
  await assert.rejects(usage.read("w"));
  assert.deepEqual(kv.data.get(USAGE_PREFIX + "w"), bad);
});

// What each version wrote, in its own shape: 0.2.19 had no `restarted`; 0.2.20 to 0.2.23 have it, and no place.
const t = (n: number): Tokens => ({ input: 10, cacheRead: n, cacheWrite: 200, output: 30 });
const OLD_RECORDS = {
  "0.2.19": { state: { lastSeq: 7, events: 2, model: MODEL, sessions: { s: t(5000) }, ttlMs: 300000, total: { [MODEL]: t(5000) }, days: { "2026-10-30": { [MODEL]: t(5000) } } }, seenUpdatedAt: 111 },
  "0.2.20": { state: { lastSeq: 9, events: 3, model: MODEL, sessions: { s: t(7000) }, restarted: ["s"], ttlMs: 3600000, total: { [MODEL]: t(7000) }, days: { "2026-11-02": { [MODEL]: t(7000) } } }, seenUpdatedAt: 222 },
  "0.2.23": { state: { lastSeq: 12, events: 4, model: MODEL, sessions: { s: t(9000), r: t(1000) }, restarted: [], ttlMs: null, total: { [MODEL]: t(10000) }, days: { "2026-11-20": { [MODEL]: t(10000) } } }, seenUpdatedAt: null },
};

test("records in the shape 0.2.19, 0.2.20 and 0.2.23 wrote read with the same total they held", async () => {
  for (const [version, stored] of Object.entries(OLD_RECORDS)) {
    const kv = memoryKv();
    await kv.set(USAGE_PREFIX + "w", stored);
    const usage = createUsageStore(kv, async () => []);
    const want = Object.values(stored.state.total).reduce((sum, x) => sum + tokenSum(x), 0);
    assert.equal(tokenSum(usageTotal((await usage.kept("w"))!)!), want, version);
    assert.equal(tokenSum(usageTotal((await usage.read("w", null, { parentThreadId: "main", projectId: "proj_1" })).state)!), want, version);
    assert.equal(tokenSum(usageTotal((await usage.kept("w"))!)!), want, `${version}, written back with its place`);
  }
});

test("a fold that would lower a session's stored total is not written; a new session adds to it", async () => {
  const kv = memoryKv();
  const higher = { ...OLD_RECORDS["0.2.23"], state: { ...OLD_RECORDS["0.2.23"].state, lastSeq: 1 } };
  // While this read was folding, the record was written with more (another read of the same thread).
  const usage = createUsageStore(kv, async (_id, after) => {
    if (after === null) await kv.set(USAGE_PREFIX + "w", higher);
    return after === null ? turn("w", 1) : [];
  });
  const got = await usage.read("w");
  assert.deepEqual(kv.data.get(USAGE_PREFIX + "w"), higher, "the higher record stands");
  assert.equal(tokenSum(usageTotal(got.state)!), tokenSum(t(10000)));
  assert.equal(lowers(higher.state, { ...higher.state, total: { [MODEL]: t(9999) } }), true);
  assert.equal(lowers(higher.state, { ...higher.state, events: 5, total: { [MODEL]: t(10000), other: t(1) } }), false, "more, in a new session or model, is written");
  // A new session after the stored one adds to it, as before.
  const kv2 = memoryKv();
  await kv2.set(USAGE_PREFIX + "w", higher);
  const more = createUsageStore(kv2, async () => [{ ...turn("w", 2)[1], seq: 20, data: { providerThreadId: "new", tokenUsage: { total: counts(10, 2000, 0, 5) } } }]);
  const added = await more.read("w");
  assert.equal(tokenSum(usageTotal(added.state)!), tokenSum(t(10000)) + used(2));
});

test("bb cow spend forget --deleted lists without --yes and removes with it; spend drops by exactly those threads", async () => {
  const { kv, backend, remove } = fakeBb([raw("main", null), raw("w", "main", NOW - 1000), raw("x", "main", NOW - 1000), raw("stay", "main")], { w: turn("w", 40), x: turn("x", 3), stay: turn("stay", 2) });
  await backend.spend("main");
  await remove("w");
  await remove("x", false);
  const before = await backend.spend("main");
  assert.equal(tokenSum(before.total.tokens), used(40) + used(3) + used(2));
  const unused = async () => {
    throw new Error("not used");
  };
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
    forgetDeleted: (yes) => backend.forgetDeleted(yes),
  };
  const run = async (...argv: string[]) => cowCli(actions).run(argv, { projectId: "proj_1", threadId: undefined, signal: new AbortController().signal });
  const listed = await run("spend", "forget", "--deleted");
  assert.equal(listed.exitCode, 0);
  assert.match(listed.stdout ?? "", /^Would remove the kept usage of 2 deleted threads/);
  assert.match(listed.stdout ?? "", /\n {2}w · 40\.0k tokens/);
  assert.ok(kv.data.has(USAGE_PREFIX + "w") && kv.data.has(USAGE_PREFIX + "x"), "nothing removed without --yes");
  assert.notEqual((await run("spend", "forget")).exitCode, 0, "--deleted is required");
  const removed = await run("spend", "forget", "--deleted", "--yes");
  assert.match(removed.stdout ?? "", /^Removed the kept usage of 2 deleted threads/);
  assert.equal(kv.data.has(USAGE_PREFIX + "w") || kv.data.has(USAGE_PREFIX + "x"), false);
  assert.ok(kv.data.has(USAGE_PREFIX + "stay"));
  const after = await backend.spend("main");
  assert.equal(tokenSum(before.total.tokens) - tokenSum(after.total.tokens), used(40) + used(3), "dropped by exactly those");
  assert.equal(after.total.deleted, 0);
  assert.match((await run("spend", "forget", "--deleted")).stdout ?? "", /nothing to remove/);
});
