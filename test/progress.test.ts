// Progress, caps and the stuck checks: from events in bb's real shape (a
// fixture's log, kept in progress-events.json with only the fields read, its
// ids replaced and its times moved), with a clock of the test's own.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createActions } from "../src/actions.ts";
import { createLogStore } from "../src/caps/logstore.ts";
import { Refusal } from "../src/kv.ts";
import { createLedgerStore } from "../src/ledger-store.ts";
import { DEFAULT_STUCK, NO_PROGRESS, type Progress, capsOf, findings, foldProgress, noticeText, workingMinutes } from "../src/progress.ts";
import { PROGRESS_PREFIX, createProgressStore } from "../src/progress-store.ts";
import { type Dispatch, runSigned, sha256Hex, verifyP256 } from "../src/signing/backend.ts";
import { createKeys } from "../src/signing/keys.ts";
import { PROJECT_KEY } from "../src/shared.ts";
import type { ThreadFacts } from "../src/state.ts";
import { createTicker } from "../src/ticker.ts";
import { workerShaped } from "../src/tree.ts";
import { type WatchDeps, createWatch } from "../src/watch-backend.ts";
import { memoryKv } from "./memory.ts";

const MINUTE = 60_000;
const SAMPLE: { seq: number; createdAt: number; type: string; data: Record<string, unknown> }[] = JSON.parse(readFileSync(new URL("./progress-events.json", import.meta.url), "utf8"));
const upTo = (seq: number) => SAMPLE.filter((event) => event.seq <= seq);
const T0 = SAMPLE[0]!.createdAt;

let seq = 1000;
const item = (type: "item/started" | "item/completed", at: number, it: Record<string, unknown>) => ({ seq: ++seq, createdAt: at, type, data: { item: it } });
const command = (id: string, text: string, at: number, done = true) => [
  item("item/started", at, { type: "commandExecution", id, command: text, status: "pending" }),
  ...(done ? [item("item/completed", at + 500, { type: "commandExecution", id, command: text, status: "completed", exitCode: 0, aggregatedOutput: "SECRET OUTPUT" })] : []),
];
const turnStarted = (at: number) => ({ seq: ++seq, createdAt: at, type: "turn/started", data: {} });
const turnCompleted = (at: number) => ({ seq: ++seq, createdAt: at, type: "turn/completed", data: { status: "completed" } });
const running = (progress: Progress, label: string | null = null) => ({ progress, label, dollars: null, running: true });

test("a fixture's real log: tool calls counted, three identical commands in a row found, the last different one ends it", () => {
  const all = foldProgress(NO_PROGRESS, SAMPLE);
  // Four commands and one file change; reasoning and the reply are no calls.
  assert.equal(all.toolCalls, 5);
  assert.equal(all.turns, 1);
  assert.equal(all.turnStartedAt, null, "the turn ended");
  assert.ok(all.workingMs > 0 && all.workingMs === SAMPLE.find((e) => e.type === "turn/completed")!.createdAt - T0);
  assert.ok(all.lastFileChangeAt !== null);
  assert.deepEqual(all.open, []);
  assert.equal(all.repeat, 1);
  assert.deepEqual(all.recent.map((call) => [call.kind, call.label]), [
    ["commandExecution", "echo cow-repeat"],
    ["commandExecution", "echo cow-repeat"],
    ["commandExecution", "echo cow-repeat"],
    ["commandExecution", "echo cow-other"],
    ["fileChange", "1 file"],
  ]);
  // At the third echo, the turn still running: caught.
  const third = SAMPLE.find((e) => e.type === "item/started" && (e.data.item as { command?: string }).command === "echo cow-repeat" && e.seq > 31)!;
  const atThird = foldProgress(NO_PROGRESS, upTo(third.seq));
  assert.equal(atThird.repeat, 3);
  assert.equal(atThird.turnStartedAt, T0);
  const found = findings(running(atThird), {}, DEFAULT_STUCK, third.createdAt + 1000);
  assert.deepEqual(found.map((f) => [f.reason, f.mark]), [["repeat", "the same command 3 times"]]);
  assert.equal(noticeText("cow test", found[0]!), "“cow test” ran the same command 3 times in a row: echo cow-repeat. 3 tool calls, 0m since its first turn started. cow does not stop it.");
  // Read in two parts, the same.
  assert.deepEqual(foldProgress(foldProgress(NO_PROGRESS, upTo(31)), SAMPLE), all);
  assert.deepEqual(foldProgress(all, SAMPLE), all, "events already read are skipped");
});

test("three different commands in a row are no repeat, and each threshold at 0 raises nothing", () => {
  const at = T0 + 10 * MINUTE;
  const p = foldProgress(NO_PROGRESS, [turnStarted(at), ...command("a", "ls", at + 1), ...command("b", "pwd", at + 2), ...command("c", "date", at + 3)]);
  assert.equal(p.toolCalls, 3);
  assert.equal(p.repeat, 1);
  assert.deepEqual(findings(running(p), {}, DEFAULT_STUCK, at + 4), []);
  const same = foldProgress(NO_PROGRESS, [turnStarted(at), ...command("a", "ls", at + 1), ...command("b", "ls", at + 2), ...command("c", "ls", at + 3), ...command("d", "ls", at + 4)]);
  assert.equal(findings(running(same), {}, DEFAULT_STUCK, at + 5)[0]?.mark, "the same command 4 times");
  assert.deepEqual(findings(running(same), {}, { ...DEFAULT_STUCK, repeats: 0 }, at + 5), []);
  // The same tool with other arguments is another call; with the same, the same.
  const tool = (id: string, args: unknown) => item("item/started", at, { type: "toolCall", id, tool: "Read", arguments: args, status: "pending" });
  assert.equal(foldProgress(NO_PROGRESS, [tool("x", { path: "a" }), tool("y", { path: "b" }), tool("z", { path: "a" })]).repeat, 1);
  assert.equal(foldProgress(NO_PROGRESS, [tool("x", { path: "a", n: 1 }), tool("y", { n: 1, path: "a" }), tool("z", { path: "a", n: 1 })]).repeat, 3);
  // A command moved to the background is the same call, not another.
  assert.equal(foldProgress(same, [item("item/started", at + 6, { type: "backgroundTask", id: "bg", status: "pending" })]).toolCalls, same.toolCalls);
  // Not while the turn is at rest.
  assert.deepEqual(findings({ ...running(same), running: false }, {}, DEFAULT_STUCK, at + 5), []);
});

test("quiet is told from one item in progress, by the clock", () => {
  const at = T0;
  const quiet = foldProgress(NO_PROGRESS, [turnStarted(at), ...command("a", "ls", at + 1000)]);
  const busy = foldProgress(NO_PROGRESS, [turnStarted(at), ...command("a", "sleep 3600", at + 1000, false)]);
  assert.equal(busy.open.length, 1);
  const last = at + 1500;
  assert.deepEqual(findings(running(quiet), {}, DEFAULT_STUCK, last + 14 * MINUTE), [], "14 minutes quiet: not yet");
  assert.deepEqual(findings(running(quiet), {}, DEFAULT_STUCK, last + 22 * MINUTE).map((f) => f.mark), ["quiet 22m"]);
  assert.deepEqual(findings(running(busy), {}, DEFAULT_STUCK, at + 22 * MINUTE), [], "an item in progress is not quiet");
  assert.deepEqual(findings(running(busy), {}, DEFAULT_STUCK, at + 1000 + 52 * MINUTE).map((f) => f.mark), ["one command in progress 52m"]);
  assert.deepEqual(findings(running(quiet), {}, { ...DEFAULT_STUCK, quietMinutes: 0 }, last + 60 * MINUTE), []);
  assert.deepEqual(findings(running(busy), {}, { ...DEFAULT_STUCK, longItemMinutes: 0 }, at + 90 * MINUTE), []);
  assert.deepEqual(findings({ ...running(quiet), running: false }, {}, DEFAULT_STUCK, last + 60 * MINUTE), [], "a turn at rest is never quiet");
});

test("the caps setting: empty is none, a bad value is reported and nothing of it applied", () => {
  assert.deepEqual(capsOf(""), { caps: {}, error: null });
  assert.deepEqual(capsOf(' {"lookup": {"toolCalls": 2}, "*": {"minutes": 90, "dollars": 1.5}} ').caps, { lookup: { toolCalls: 2 }, "*": { minutes: 90, dollars: 1.5 } });
  for (const bad of ["{", "[1]", '{"Two words": {"toolCalls": 2}}', '{"lookup": {"toolCalls": 2.5}}', '{"lookup": {"tokens": 2}}', '{"lookup": {}}', '{"lookup": {"toolCalls": 2}, "draft": {"minutes": -1}}']) {
    const got = capsOf(bad);
    assert.deepEqual(got.caps, {}, bad);
    assert.match(got.error ?? "", /^the caps setting is not applied: /, bad);
  }
});

test("caps: over by label, `*` for the rest, never with none set; dollars only once known", () => {
  const at = T0;
  const p = foldProgress(NO_PROGRESS, [turnStarted(at), ...command("a", "ls", at), ...command("b", "pwd", at), ...command("c", "date", at)]);
  const { caps } = capsOf('{"lookup": {"toolCalls": 2}}');
  assert.deepEqual(findings(running(p, "lookup"), {}, DEFAULT_STUCK, at + MINUTE), [], "no caps: no mark");
  assert.deepEqual(findings(running(p, "lookup"), caps, DEFAULT_STUCK, at + MINUTE).map((f) => f.mark), ["over cap: 3 of 2 tool calls"]);
  assert.deepEqual(findings(running(p, "draft"), caps, DEFAULT_STUCK, at + MINUTE), [], "another label");
  assert.deepEqual(findings(running(p, null), caps, DEFAULT_STUCK, at + MINUTE), [], "no label");
  const any = capsOf('{"lookup": {"toolCalls": 5}, "*": {"toolCalls": 2, "minutes": 60, "dollars": 2}}').caps;
  assert.deepEqual(findings(running(p, "lookup"), any, DEFAULT_STUCK, at + MINUTE), [], "its own label's cap, not *'s");
  assert.deepEqual(findings({ ...running(p, null), dollars: null }, any, { ...DEFAULT_STUCK, quietMinutes: 0 }, at + 95 * MINUTE).map((f) => f.mark), ["over cap: 3 of 2 tool calls", "over cap: 95 of 60 minutes"]);
  const cost = findings({ ...running(p, "draft"), dollars: 3.2, running: false }, any, DEFAULT_STUCK, at + MINUTE).map((f) => f.mark);
  assert.deepEqual(cost, ["over cap: 3 of 2 tool calls", "over cap: $3.20 of $2.00 (list price, known only once a turn has ended)"], "caps hold while the turn is at rest too");
  const two = foldProgress(NO_PROGRESS, [turnStarted(at), ...command("a", "ls", at), ...command("b", "pwd", at)]);
  assert.deepEqual(findings(running(two, "lookup"), caps, DEFAULT_STUCK, at), [], "at the cap is not over it");
});

test("what is kept holds no message text, output or file contents, and a command only clipped", async () => {
  const long = `cat > notes.md <<'EOF'\nTHE FILE BODY\nEOF`;
  const longLine = `echo ${"x".repeat(200)}`;
  const events = [
    turnStarted(T0),
    item("item/completed", T0, { type: "agentMessage", id: "m", text: "A MESSAGE TO THE PERSON" }),
    item("item/completed", T0, { type: "reasoning", id: "r", summary: [], content: ["A THOUGHT"] }),
    ...command("a", long, T0),
    ...command("b", longLine, T0),
    item("item/completed", T0, { type: "toolCall", id: "w", tool: "Write", arguments: { path: "x", content: "WRITTEN CONTENT" }, status: "completed" }),
    item("item/completed", T0, { type: "fileChange", id: "f", changes: [{ path: "/tmp/a", kind: "add", diff: "+DIFF BODY" }], status: "completed" }),
  ];
  const kv = memoryKv();
  const store = createProgressStore(kv, async (_id, after) => events.filter((event) => after === null || event.seq > after));
  const p = await store.read("thr_w");
  assert.equal(p.toolCalls, 4);
  const kept = JSON.stringify(kv.data.get(`${PROGRESS_PREFIX}thr_w`));
  for (const text of ["MESSAGE", "THOUGHT", "FILE BODY", "SECRET OUTPUT", "WRITTEN CONTENT", "DIFF BODY", "x".repeat(60)]) assert.ok(!kept.includes(text), text);
  assert.deepEqual(p.recent.map((call) => call.label), ["cat > notes.md <<'EOF'", `echo ${"x".repeat(54)}…`, "Write", "1 file"]);
  assert.ok(p.recent.every((call) => call.label.length <= 60 && /^[0-9a-f]{16}$/.test(call.hash)));
});

test("working minutes are the turns' lengths summed", () => {
  const p = foldProgress(NO_PROGRESS, [turnStarted(T0), turnCompleted(T0 + 10 * MINUTE), turnStarted(T0 + 60 * MINUTE), turnCompleted(T0 + 62.5 * MINUTE)]);
  assert.equal(workingMinutes(p), 12.5);
  assert.equal(p.firstTurnAt, T0);
});

// ---- the service: marks, notices once, acknowledged by a signed call -------------

const facts = (id: string, over: Partial<ThreadFacts> = {}): ThreadFacts => ({
  id,
  projectId: "proj_1",
  title: id,
  parentThreadId: "main",
  status: "active",
  hasPendingInteraction: false,
  archivedAt: null,
  lastReadAt: null,
  latestAttentionAt: 0,
  createdAt: 0,
  ...over,
});

function world(opts: { caps?: string; stuck?: typeof DEFAULT_STUCK } = {}) {
  const kv = memoryKv();
  const clock = { now: T0 };
  const events = new Map<string, unknown[]>();
  const labels = new Map<string, string>();
  const threads: ThreadFacts[] = [facts("main", { parentThreadId: null }), facts("proj"), facts("kid", { parentThreadId: "proj" }), facts("w1"), facts("w2")];
  const log = createLogStore({ kv, now: () => clock.now, hash: sha256Hex });
  let ids = 0;
  let changes = 0;
  const settings = { caps: opts.caps ?? "", stuck: opts.stuck ?? DEFAULT_STUCK };
  const deps: WatchDeps = {
    kv,
    now: () => clock.now,
    newId: () => `n${(ids += 1)}`,
    threads: async () => threads,
    thread: async (id) => threads.find((t) => t.id === id) ?? null,
    mains: async () => ["main"],
    marked: async () => [],
    label: async (id) => labels.get(id) ?? null,
    dollars: async () => null,
    progress: createProgressStore(kv, async (id, after) => (events.get(id) ?? []).filter((event) => after === null || (event as { seq: number }).seq > after)),
    settings: async () => settings,
    log,
    changed: () => void (changes += 1),
  };
  const watch = createWatch(deps);
  // Every thread runs the same three commands: Main and the project too.
  for (const t of threads) events.set(t.id, [turnStarted(T0), ...command(`${t.id}a`, "ls", T0), ...command(`${t.id}b`, "ls", T0), ...command(`${t.id}c`, "ls", T0)]);
  return { kv, clock, events, labels, threads, log, watch, settings, changes: () => changes };
}

test("each check raises one notice per worker per reason, none for Main or a project, and none again once acknowledged", async () => {
  const w = world();
  const first = await w.watch.check();
  assert.deepEqual(Object.keys(first.marks).sort(), ["kid", "w1", "w2"], "the project's own thread is a worker; Main and the project are not");
  assert.deepEqual(first.notices.map((n) => [n.threadId, n.reason]), [["kid", "repeat"], ["w1", "repeat"], ["w2", "repeat"]]);
  assert.equal(first.marks.w1?.[0]?.mark, "the same command 3 times");
  // The quiet check, 20 minutes on: one more each.
  w.clock.now = T0 + 20 * MINUTE;
  const later = await w.watch.check();
  assert.deepEqual(later.notices.filter((n) => n.threadId === "w1").map((n) => n.reason), ["repeat", "quiet"]);
  assert.deepEqual(later.marks.w1?.map((f) => f.mark), ["the same command 3 times", "quiet 19m"]);
  // Acknowledged: gone, and not raised again, though the mark stays while it is true.
  for (const notice of later.notices.filter((n) => n.threadId === "w1")) await w.watch.acknowledge(notice.id, "0000-1111-2222-3333");
  w.clock.now = T0 + 40 * MINUTE;
  const after = await w.watch.check();
  assert.deepEqual(after.notices.filter((n) => n.threadId === "w1"), []);
  assert.deepEqual(after.marks.w1?.map((f) => f.mark), ["the same command 3 times", "quiet 39m"]);
  assert.ok(!Object.keys(after.marks).includes("main") && !Object.keys(after.marks).includes("proj"));
  // The long-item check, by the clock, once.
  w.events.set("w2", [...(w.events.get("w2") ?? []), ...command("w2d", "sleep 9999", T0 + 40 * MINUTE, false)]);
  await w.watch.check(["w2"]);
  w.clock.now = T0 + 90 * MINUTE;
  await w.watch.check();
  w.clock.now = T0 + 100 * MINUTE;
  const long = await w.watch.check();
  assert.deepEqual(long.notices.filter((n) => n.threadId === "w2" && n.reason === "long-item").length, 1);
  assert.match(long.notices.find((n) => n.reason === "long-item")!.text, /^“w2” has had one command in progress 50m: sleep 9999\. 4 tool calls, 90m since its first turn started\. cow does not stop it\.$/);
  // A worker that ends its turn is no longer checked for being stuck.
  w.threads.find((t) => t.id === "w2")!.status = "idle";
  assert.equal((await w.watch.check()).marks.w2, undefined);
});

test("with each stuck threshold at 0 and no caps, nothing is ever marked or raised", async () => {
  const w = world({ stuck: { repeats: 0, quietMinutes: 0, longItemMinutes: 0 } });
  w.clock.now = T0 + 300 * MINUTE;
  const got = await w.watch.check();
  assert.deepEqual([got.marks, got.notices], [{}, []]);
});

test("a cap of 2 tool calls for a label: its worker of 3 gets the mark and exactly one notice; another label none, until `*`", async () => {
  const w = world({ caps: '{"lookup": {"toolCalls": 2}}', stuck: { repeats: 0, quietMinutes: 0, longItemMinutes: 0 } });
  w.labels.set("w1", "lookup");
  w.labels.set("w2", "draft");
  for (const t of w.threads) t.status = "idle";
  await w.watch.check();
  const got = await w.watch.check();
  assert.deepEqual(Object.fromEntries(Object.entries(got.marks).map(([id, f]) => [id, f.map((x) => x.mark)])), { w1: ["over cap: 3 of 2 tool calls"] });
  assert.deepEqual(got.notices.map((n) => [n.threadId, n.reason, n.text]), [["w1", "cap-toolCalls", "“w1” (lookup) is over cap: 3 of 2 tool calls. 3 tool calls, 0m since its first turn started. cow does not stop it."]]);
  w.settings.caps = '{"lookup": {"toolCalls": 2}, "*": {"toolCalls": 2}}';
  const any = await w.watch.check();
  assert.deepEqual(Object.keys(any.marks).sort(), ["kid", "w1", "w2"]);
  assert.equal(any.notices.length, 3);
  w.settings.caps = '{"lookup": {"toolCalls": "two"}}';
  const bad = await w.watch.check();
  assert.deepEqual(bad.marks, {}, "a bad setting applies no cap");
  assert.match(bad.errors.join(" "), /the caps setting is not applied/);
});

test("acknowledging a worker notice is a signed call: an unsigned one is refused and the notice stays", async () => {
  const w = world();
  const [notice] = (await w.watch.check()).notices;
  const keys = createKeys({ kv: w.kv, now: () => w.clock.now, hash: sha256Hex, verify: verifyP256, log: w.log, resetPath: "/data/reset", takeResetFile: async () => false, changed: () => undefined });
  const dispatch = { watch_ack: async (args: { noticeId: string }, by: string) => (await w.watch.acknowledge(args.noticeId, by), null) } as unknown as Dispatch;
  const refusedAs = (code: string) => (cause: unknown) => cause instanceof Refusal && cause.code === code;
  await assert.rejects(runSigned(keys, dispatch, { action: "watch_ack", args: { noticeId: notice!.id } }), refusedAs("unsigned"));
  assert.equal((await w.watch.report()).notices.length, 3);
  await assert.rejects(w.watch.acknowledge("watch_nosuch", "x"), refusedAs("notice_not_found"));
});

test("the shared timer runs each job once per its period, never two at once", async () => {
  const clock = { now: 0 };
  const ticker = createTicker(() => clock.now, () => undefined, false);
  const ran: string[] = [];
  ticker.every("usage", 5 * MINUTE, async () => void ran.push("usage"));
  ticker.every("watch", MINUTE, async () => void ran.push("watch"));
  for (let minute = 0; minute <= 10; minute += 1) {
    clock.now = minute * MINUTE;
    await ticker.tick();
  }
  assert.equal(ran.filter((name) => name === "watch").length, 11);
  assert.equal(ran.filter((name) => name === "usage").length, 3);
});

// ---- who is a worker -------------------------------------------------------------

test("a thread under a parent whose own threads are all archived is a worker; one with a live thread under it, or marked, is not", () => {
  const archived = { archivedAt: 5 };
  const threads = [facts("main", { parentThreadId: null }), facts("w"), facts("t1", { parentThreadId: "w", ...archived }), facts("t2", { parentThreadId: "w", ...archived }), facts("p"), facts("live", { parentThreadId: "p" })];
  const of = (id: string) => threads.find((t) => t.id === id)!;
  assert.equal(workerShaped(threads, of("w"), []), true);
  assert.equal(workerShaped(threads, of("p"), []), false, "a live thread under it");
  assert.equal(workerShaped(threads, of("w"), ["w"]), false, "marked");
  assert.equal(workerShaped(threads, of("main"), []), false, "no parent");
});

/** A bb with these threads, cow's notes on them, and their events: enough for the actions' outcome and archive. */
function fakeBb(threads: Record<string, unknown>[], metadata: Record<string, Record<string, unknown>>) {
  const kv = memoryKv();
  const archived: string[] = [];
  const touched: string[] = [];
  const bb = {
    pluginId: "cow",
    storage: { kv },
    realtime: { publish: () => undefined },
    log: { warn: () => undefined, info: () => undefined },
    sdk: {
      threads: {
        list: async (args: { threadIds?: string[] }) => threads.filter((t) => !args.threadIds || args.threadIds.includes(t.id as string)),
        experimental_listPluginMetadata: async ({ threadIds }: { threadIds: string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, metadata: metadata[threadId] ?? {} })) }),
        archive: async ({ threadId }: { threadId: string }) => {
          archived.push(threadId);
          const t = threads.find((x) => x.id === threadId);
          if (t) t.archivedAt = 99;
        },
        stop: async ({ threadId }: { threadId: string }) => void touched.push(`stop ${threadId}`),
        send: async ({ threadId }: { threadId: string }) => void touched.push(`send ${threadId}`),
        updatePluginMetadata: async () => undefined,
        events: { list: async () => [] },
        interactions: { list: async () => [] },
      },
      projects: { list: async () => [] },
    },
  };
  return { bb: bb as unknown as BbPluginApi, kv, archived, touched };
}

test("a worker whose own threads are all archived gets an outcome and a ledger row with tool calls and minutes; a live one under it, a marked project and Main are refused", async () => {
  const raw = (id: string, parent: string | null, archivedAt: number | null = null) => ({ id, projectId: "proj_1", title: id, parentThreadId: parent, status: "idle", archivedAt, createdAt: 1 });
  const threads = [raw("main", null), raw("w", "main"), raw("t1", "w", 50), raw("busy", "main"), raw("t2", "busy"), raw("marked", "main")];
  const { bb, kv, touched } = fakeBb(threads, { marked: { [PROJECT_KEY]: { at: 1, by: null } } });
  const turns = [turnStarted(T0), turnCompleted(T0 + 6 * MINUTE)];
  const progress = createProgressStore(kv, async (_id, after) => [...turns, ...command("x", "ls", T0 + MINUTE), ...command("y", "pwd", T0 + 2 * MINUTE)].filter((e) => after === null || e.seq > after));
  const ledger = createLedgerStore(kv, async () => turns, undefined, undefined, async (id) => {
    const p = await progress.read(id);
    return { toolCalls: p.toolCalls, workingMinutes: workingMinutes(p) };
  });
  const actions = createActions(bb, async () => ({ mains: { proj_1: "main" }, currentProjectId: "proj_1" }), undefined, ledger);
  const judged = await actions.outcomeChecked({ callerId: null, threadId: "w", outcome: "done" });
  assert.equal(judged.judgement.outcome, "done");
  await actions.archive({ threadId: "w", reason: null, dropped: false, at: T0 + 10 * MINUTE });
  const row = (await ledger.rows()).find((r) => r.threadId === "w");
  assert.deepEqual([row?.outcome, row?.toolCalls, row?.workingMinutes], ["done", 2, 6]);
  for (const id of ["busy", "marked", "main"]) {
    await assert.rejects(actions.outcomeChecked({ callerId: null, threadId: id, outcome: "done" }), (cause: Error) => /not a worker|project|Main/.test(cause.message), id);
  }
  assert.deepEqual(touched, [], "no thread was stopped or sent anything");
});
