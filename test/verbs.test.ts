import assert from "node:assert/strict";
import { test } from "node:test";
import { parkNow } from "../src/park.ts";
import type { ParkRecord } from "../src/shared.ts";
import { type ThreadFacts, derive } from "../src/state.ts";
import type { Line } from "../src/tree.ts";
import { undoShort, undoText } from "../src/undo.ts";
import { type Verb, verbBlocked, verbLabel } from "../src/verbs.ts";
import { DAY, NOW, thread } from "./fixtures.ts";

const VERBS: Verb[] = ["answer", "park", "resume", "stop", "archive"];
const line = (facts: ThreadFacts, park?: ParkRecord, openUnder = 0): Line => ({
  thread: facts,
  derived: derive(facts, undefined, NOW, park),
  depth: 0,
  parentId: null,
  queueNumber: null,
  under: 0,
  openUnder,
  members: 0,
  rollup: null,
  olderUnder: 0,
  note: null,
});
const allowed = (target: Line | null, isMain = false) =>
  VERBS.filter((verb) => verbBlocked(verb, target, isMain) === null);

test("with no line selected, no verb applies", () => {
  assert.deepEqual(allowed(null), []);
});

test("a running line can be parked or stopped", () => {
  assert.deepEqual(allowed(line(thread({ id: "t", status: "active" }))), ["park", "stop"]);
});

test("a line with a pending question can be answered", () => {
  const asking = line(thread({ id: "t", status: "active", hasPendingInteraction: true }));
  assert.deepEqual(allowed(asking), ["answer", "park", "stop"]);
  const atRest = line(thread({ id: "t", hasPendingInteraction: true }));
  assert.deepEqual(allowed(atRest), ["answer", "park"]);
});

test("a done or failed line can be parked or archived", () => {
  assert.deepEqual(allowed(line(thread({ id: "t" }))), ["park", "archive"]);
  assert.deepEqual(allowed(line(thread({ id: "t", status: "error" }))), ["park", "archive"]);
});

test("a line with open threads under it cannot be archived", () => {
  const blocked = verbBlocked("archive", line(thread({ id: "t", status: "error" }), undefined, 2), false);
  assert.match(blocked ?? "", /still open/);
});

test("an archived line takes no verb", () => {
  assert.deepEqual(allowed(line(thread({ id: "t", archivedAt: NOW }))), []);
});

test("a parked line can only be resumed until it comes back", () => {
  const parked = line(
    thread({ id: "t", status: "active", hasPendingInteraction: true }),
    parkNow("r", { kind: "date", at: NOW + DAY }, NOW),
  );
  assert.deepEqual(allowed(parked), ["resume"]);
  assert.equal(verbLabel("park", parked), "park");
});

test("parked work that came back can be kept, resumed or dropped", () => {
  const back = line(thread({ id: "t" }), parkNow("r", { kind: "date", at: NOW - 1 }, NOW - DAY));
  assert.deepEqual(allowed(back), ["park", "resume", "stop"]);
  assert.equal(verbLabel("park", back), "keep parked");
  assert.equal(verbLabel("stop", back), "drop");
  assert.equal(verbLabel("resume", back), "resume");
});

test("Main can be answered and stopped, never parked or archived", () => {
  const main = line(thread({ id: "main", status: "active", hasPendingInteraction: true }));
  assert.deepEqual(allowed(main, true), ["answer", "stop"]);
  assert.deepEqual(allowed(line(thread({ id: "main" })), true), []);
});

test("undo says what it will take back", () => {
  const record = parkNow("r", { kind: "none" }, NOW);
  const base = { threadId: "t", title: "Billing" };
  assert.match(undoText({ kind: "park", ...base, before: null }), /undo parking “Billing”.*tree/);
  assert.match(undoText({ kind: "park", ...base, before: record }), /asks again/);
  assert.match(undoText({ kind: "resume", ...base, record }), /back on the shelf/);
  assert.match(undoText({ kind: "archive", ...base, dropped: false, under: [], reason: null }), /: it is unarchived$/);
  assert.match(
    undoText({ kind: "archive", ...base, dropped: false, under: ["a", "b"], reason: null }),
    /it and the 2 threads under it are unarchived$/,
  );
  assert.match(
    undoText({ kind: "archive", ...base, dropped: false, under: [], reason: "superseded" }),
    /it is unarchived; its reason is kept$/,
  );
  assert.match(undoText({ kind: "archive", ...base, dropped: true, under: ["a"], reason: null }), /the thread under it.*stays stopped/);
  assert.equal(undoShort({ kind: "archive", ...base, dropped: true, under: [], reason: null }), "undo drop");
  assert.equal(undoShort({ kind: "park", ...base, before: null }), "undo park");
  assert.match(undoText({ kind: "dismiss", ...base, before: null }), /undo dismissing what bb refused “Billing”.*blocked again/);
  assert.equal(undoShort({ kind: "dismiss", ...base, before: null }), "undo dismiss");
});
