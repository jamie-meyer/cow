// What is still on the page after a thread is parked or archived by anyone,
// an agent included: `bb cow park` and `bb cow archive` are not signed, so
// what they leave in front of the person is what the person can rely on.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "../src/asks/ask.ts";
import { parkNow } from "../src/park.ts";
import type { ParkRecord } from "../src/shared.ts";
import { type Activity, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { asideText, buildOverview, cursorOrder, listed } from "../src/tree.ts";
import { DAY, HOUR, NOW, activity, thread } from "./fixtures.ts";

const ids = (lines: { thread: { id: string } }[]) => lines.map((line) => line.thread.id);
const ask = (threadId: string): Ask => ({ id: `ask_${threadId}`, threadId, question: "Which one?", status: "open", createdAt: NOW - HOUR, capability: null }) as unknown as Ask;
const failed: Activity = activity({ turn: { phase: "completed", at: NOW - HOUR, failed: true } });

function build(threads: Parameters<typeof buildOverview>[0], notes: { parks?: Record<string, ParkRecord>; reasons?: Record<string, string>; acts?: Record<string, Activity>; asks?: Record<string, Ask[]> }) {
  return buildOverview(
    threads,
    "main",
    (t) => derive(t, notes.acts?.[t.id], NOW, t.id === "main" ? null : notes.parks?.[t.id], notes.reasons?.[t.id], null, null, { asks: notes.asks?.[t.id] ?? [], brief: null }),
    NOW,
  );
}
const family = (overrides: Record<string, object> = {}) =>
  [
    thread({ id: "main", createdAt: 1 }),
    thread({ id: "worker", parentThreadId: "main", createdAt: 2 }),
    thread({ id: "kid", parentThreadId: "worker", createdAt: 3 }),
    thread({ id: "other", parentThreadId: "main", status: "active", createdAt: 4 }),
  ].map((t) => ({ ...t, ...(overrides[t.id] ?? {}) }));

test("a thread that is parked is on the shelf with the reason given and a count of the threads that went with it", () => {
  const overview = build(family(), { parks: { worker: parkNow("waiting for the vendor", { kind: "none" }, NOW - HOUR) } });
  assert.deepEqual(ids(overview.lines), ["other"]);
  assert.deepEqual(ids(overview.parked), ["worker"]);
  const shelved = overview.parked[0]!;
  assert.equal(shelved.derived.state, "parked");
  assert.equal(shelved.derived.doing, "waiting for the vendor");
  assert.equal(shelved.under, 1);
  assert.equal(overview.counts.parked, 1);
});

test("parking takes a failure off the queue: the line is on the shelf, and comes back to the queue within four weeks", () => {
  const acts = { worker: failed };
  assert.deepEqual(ids(build(family(), { acts }).queue), ["worker"]);
  const parks = { worker: parkNow("later", { kind: "none" }, NOW - HOUR) };
  const parked = build(family(), { acts, parks });
  assert.deepEqual(ids(parked.queue), []);
  assert.deepEqual(ids(parked.parked), ["worker"]);
  // Parked 29 days ago, it is back.
  const old = build(family(), { acts, parks: { worker: parkNow("later", { kind: "none" }, NOW - 29 * DAY) } });
  assert.deepEqual(ids(old.queue), ["worker"]);
});

test("an open ask of a parked thread stays in the queue; so does one of a thread under it, saying what it is under", () => {
  const parks = { worker: parkNow("later", { kind: "none" }, NOW - HOUR) };
  const own = build(family(), { parks, asks: { worker: [ask("worker")] } });
  assert.deepEqual(ids(own.queue), ["worker"]);
  assert.match(own.parked[0]!.derived.doing, /later · asks you: Which one\?/);
  assert.deepEqual(own.asideAsks, []);
  const under = build(family(), { parks, asks: { kid: [ask("kid")] } });
  assert.deepEqual(ids(under.queue), ["kid"]);
  assert.equal(under.parked[0]!.under, 1);
  // The parked thread stays parked; the asking one is listed after the shelf, for its ask alone.
  assert.deepEqual(ids(under.parked), ["worker"]);
  assert.equal(under.parked[0]!.derived.state, "parked");
  assert.deepEqual(ids(under.asideAsks), ["kid"]);
  const line = under.asideAsks[0]!;
  assert.deepEqual(line.aside, { id: "worker", title: "worker", state: "parked" });
  assert.equal(line.derived.state, "wants");
  assert.equal(asideText(line), " · under parked “worker”");
  assert.ok(listed(under).includes(line));
  assert.ok(cursorOrder(under).includes("kid"));
  // Its status line says what it is under.
  assert.match(statusText(statusReport(under, NOW, false)), /kid \(kid\)  asks you: Which one\? · under parked “worker”/);
  // Without an ask, nothing under the shelf is listed.
  assert.deepEqual(ids(build(family(), { parks }).asideAsks), []);
});

test("an ask deeper under a kept thread is in the queue too; an archived thread's ask is not", () => {
  const threads = [...family(), thread({ id: "grandkid", parentThreadId: "kid", createdAt: 5 })];
  const kept = (t: Parameters<typeof derive>[0]) =>
    derive(t, undefined, NOW, null, null, null, null, { asks: t.id === "grandkid" ? [ask("grandkid")] : [], brief: null }, null, t.id === "worker" ? { at: NOW - HOUR, words: null } : null);
  const overview = buildOverview(threads, "main", kept, NOW);
  assert.deepEqual(ids(overview.kept), ["worker"]);
  assert.deepEqual(ids(overview.queue), ["grandkid"]);
  assert.deepEqual(overview.asideAsks[0]!.aside, { id: "worker", title: "worker", state: "kept" });
  const gone = buildOverview(threads.map((t) => (t.id === "grandkid" ? { ...t, archivedAt: NOW - HOUR } : t)), "main", kept, NOW);
  assert.deepEqual(ids(gone.queue), []);
});

test("an archived thread is under Archived with the reason given, for two days; what waited on it no longer waits", () => {
  const archived = family({ worker: { archivedAt: NOW - HOUR }, kid: { archivedAt: NOW - HOUR } });
  const overview = build(archived, { reasons: { worker: "superseded" }, acts: { worker: failed }, asks: { worker: [ask("worker")] } });
  assert.deepEqual(ids(overview.archived), ["worker"]);
  assert.equal(overview.archived[0]!.derived.archivedWhy, "superseded");
  assert.deepEqual(ids(overview.queue), []);
  const older = build(family({ worker: { archivedAt: NOW - 3 * DAY }, kid: { archivedAt: NOW - 3 * DAY } }), { reasons: { worker: "superseded" } });
  assert.deepEqual([ids(older.archived), ids(older.settle)], [[], []]);
});
