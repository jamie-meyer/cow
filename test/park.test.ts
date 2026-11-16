import assert from "node:assert/strict";
import { test } from "node:test";
import { dueShort, dueText, parkDue, parkNow, pickUpText, reparkNow } from "../src/park.ts";
import { LIMITS, derive, waitingSince } from "../src/state.ts";
import { DAY, HOUR, NOW, thread } from "./fixtures.ts";

const WEEK = 7 * DAY;
const CHECK = LIMITS.parkCheckMs;

test("the four-week check is four weeks", () => {
  assert.equal(CHECK, 4 * WEEK);
});

test("a date brings parked work back when it arrives, not before", () => {
  const record = parkNow("no budget", { kind: "date", at: NOW + 3 * DAY }, NOW);
  assert.equal(parkDue(record, NOW + 3 * DAY - 1, CHECK), null);
  assert.deepEqual(parkDue(record, NOW + 3 * DAY, CHECK), { kind: "date", at: NOW + 3 * DAY });
  // A date is the only thing it waits for, however far off.
  const far = parkNow("next year", { kind: "date", at: NOW + 40 * WEEK }, NOW);
  assert.equal(parkDue(far, NOW + 30 * WEEK, CHECK), null);
});

test("without a date it asks every four weeks, saying how long it has been", () => {
  const record = parkNow("not urgent", { kind: "none" }, NOW);
  assert.equal(parkDue(record, NOW + CHECK - 1, CHECK), null);
  assert.deepEqual(parkDue(record, NOW + CHECK, CHECK), { kind: "check", at: NOW + CHECK, weeks: 4 });
  assert.deepEqual(parkDue(record, NOW + 6 * WEEK, CHECK), { kind: "check", at: NOW + CHECK, weeks: 6 });
});

test("a condition cannot be detected, so it falls back to the four-week check", () => {
  const record = parkNow("vendor", { kind: "condition", text: "support replies" }, NOW);
  assert.equal(parkDue(record, NOW + CHECK - 1, CHECK), null);
  const due = parkDue(record, NOW + CHECK, CHECK);
  assert.equal(due?.kind, "check");
  assert.match(dueText(record, due!, NOW + CHECK), /still parked for 4 weeks.*support replies/);
  assert.match(pickUpText(record, NOW + WEEK, CHECK), /^when support replies · asks in 21d$/);
});

test("keeping it parked restarts the check and keeps the reason and the parked time", () => {
  const record = parkNow("not urgent", { kind: "none" }, NOW);
  const kept = reparkNow(record, { kind: "none" }, NOW + 5 * WEEK);
  assert.equal(kept.reason, "not urgent");
  assert.equal(kept.at, NOW);
  assert.equal(parkDue(kept, NOW + 8 * WEEK, CHECK), null);
  assert.deepEqual(parkDue(kept, NOW + 9 * WEEK, CHECK), {
    kind: "check",
    at: NOW + 9 * WEEK,
    weeks: 9,
  });
  const dated = reparkNow(record, { kind: "date", at: NOW + 6 * WEEK }, NOW + 5 * WEEK);
  assert.equal(parkDue(dated, NOW + 6 * WEEK - 1, CHECK), null);
  assert.equal(parkDue(dated, NOW + 6 * WEEK, CHECK)?.kind, "date");
});

test("the texts say what it waits for and what it asks", () => {
  const day = new Date(2030, 2, 9).getTime();
  const at = day - 10 * DAY;
  const dated = parkNow("r", { kind: "date", at: day }, at);
  assert.equal(pickUpText(dated, at, CHECK), "pick up 9 Mar");
  assert.equal(
    dueText(dated, { kind: "date", at: day }, day),
    "pick-up date arrived (9 Mar): resume, re-park, or drop?",
  );
  assert.equal(dueShort({ kind: "date", at: day }, day), "date arrived: 9 Mar");
  const open = parkNow("r", { kind: "none" }, NOW);
  assert.equal(pickUpText(open, NOW, CHECK), "asks again in 4w");
  assert.equal(
    dueText(open, { kind: "check", at: NOW + CHECK, weeks: 1 }, NOW),
    "still parked for 1 week: keep, resume, or drop?",
  );
});

test("a parked thread reads as parked whatever the agent is doing", () => {
  const record = parkNow("waiting for the cutover date", { kind: "none" }, NOW - 3 * DAY);
  for (const facts of [
    thread({ id: "running", status: "active" }),
    thread({ id: "asking", hasPendingInteraction: true }),
    thread({ id: "failed", status: "error" }),
    thread({ id: "finished" }),
  ]) {
    const derived = derive(facts, undefined, NOW, record);
    assert.equal(derived.state, "parked", facts.id);
    assert.equal(derived.since, NOW - 3 * DAY);
    assert.equal(derived.doing, "waiting for the cutover date");
    assert.equal(derived.waitingOnYou, false);
    assert.equal(derived.park?.due, null);
  }
});

test("parked work that has come back waits on the user, since it came back", () => {
  const record = parkNow("r", { kind: "date", at: NOW - 2 * HOUR }, NOW - 9 * DAY);
  const derived = derive(thread({ id: "t" }), undefined, NOW, record);
  assert.equal(derived.state, "parked");
  assert.equal(derived.waitingOnYou, true);
  assert.equal(derived.since, NOW - 9 * DAY);
  assert.equal(waitingSince(derived), NOW - 2 * HOUR);
  assert.match(derived.next, /^date arrived: /);
});

test("resuming is removing the note: the derived state applies again", () => {
  const facts = thread({ id: "t", status: "active", latestAttentionAt: NOW - HOUR });
  const record = parkNow("r", { kind: "none" }, NOW);
  assert.equal(derive(facts, undefined, NOW, record).state, "parked");
  assert.equal(derive(facts, undefined, NOW, null).state, "running");
  assert.equal(derive(facts, undefined, NOW).state, "running");
});

test("an archived thread is done even if its note is still there", () => {
  const record = parkNow("r", { kind: "none" }, NOW - DAY);
  const derived = derive(thread({ id: "t", archivedAt: NOW - HOUR }), undefined, NOW, record);
  assert.equal(derived.state, "done");
  assert.equal(derived.park, undefined);
});
