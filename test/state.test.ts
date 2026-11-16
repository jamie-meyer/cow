import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS, derive, isRecentDone } from "../src/state.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

test("a thread with a turn in progress is running since the turn started", () => {
  const t = thread({ id: "a", status: "active", latestAttentionAt: NOW - HOUR });
  const d = derive(
    t,
    activity({
      turn: { phase: "started", at: NOW - 10 * MINUTE, failed: false },
      lastEventAt: NOW - MINUTE,
      latestStep: "$ npm test",
    }),
    NOW,
  );
  assert.deepEqual(d, {
    state: "running",
    since: NOW - 10 * MINUTE,
    doing: "$ npm test",
    next: "finishes its turn",
    waitingOnYou: false,
  });
});

test("running falls back to plain words before its activity has loaded", () => {
  const d = derive(thread({ id: "a", status: "starting" }), undefined, NOW);
  assert.equal(d.state, "running");
  assert.equal(d.doing, "working");
  assert.equal(derive(thread({ id: "b", status: "pending" }), undefined, NOW).doing, "queued to start");
});

test("a pending interaction wants you, even mid-turn", () => {
  const t = thread({
    id: "a",
    status: "active",
    hasPendingInteraction: true,
    latestAttentionAt: NOW - 5 * MINUTE,
  });
  const d = derive(t, activity({ output: "Which colour?\nred or blue" }), NOW);
  assert.equal(d.state, "wants");
  assert.equal(d.since, NOW - 5 * MINUTE);
  assert.equal(d.doing, "Which colour?");
  assert.equal(d.next, "answer it: press a");
  assert.equal(d.waitingOnYou, true);
});

test("a pending question shows its own words and when it was asked", () => {
  const t = thread({ id: "a", hasPendingInteraction: true, latestAttentionAt: NOW - DAY });
  const d = derive(
    t,
    activity({ output: "Let me check with you.", ask: { kind: "question", text: "Which colour?", at: NOW - HOUR } }),
    NOW,
  );
  assert.equal(d.doing, "Which colour?");
  assert.equal(d.since, NOW - HOUR);
  // A stale ask is ignored once nothing is pending.
  const answered = derive({ ...t, hasPendingInteraction: false, lastReadAt: NOW }, activity({ ask: { kind: "question", text: "Which colour?", at: NOW - HOUR } }), NOW);
  assert.equal(answered.state, "done");
});

test("Main, a thread with no parent, wants you when its reply is unread", () => {
  const t = thread({ id: "main", lastReadAt: NOW - 3 * HOUR, latestAttentionAt: NOW - HOUR });
  const d = derive(t, activity({ output: "## Report\n\nAll done." }), NOW);
  assert.equal(d.state, "wants");
  assert.equal(d.since, NOW - HOUR);
  assert.equal(d.doing, "Report");
  assert.equal(d.next, "read its reply");
  assert.equal(d.waitingOnYou, true);
  assert.equal(derive(thread({ id: "b", lastReadAt: null }), undefined, NOW).state, "wants");
});

test("a finished child is done whether or not anyone opened it, and says what it reported", () => {
  // It reported to its parent, so it is the parent's to deal with.
  const child = thread({
    id: "a",
    parentThreadId: "main",
    lastReadAt: null,
    latestAttentionAt: NOW - DAY,
  });
  const finished = activity({
    turn: { phase: "completed", at: NOW - HOUR, failed: false },
    output: "Outcome: the page is built.\nDetails follow.",
  });
  assert.deepEqual(derive(child, finished, NOW), {
    state: "done",
    since: NOW - HOUR,
    doing: "Outcome: the page is built.",
    next: "",
    waitingOnYou: false,
  });
  assert.equal(derive({ ...child, lastReadAt: NOW }, finished, NOW).state, "done");
});

test("a child with a pending question still wants you", () => {
  const child = thread({ id: "a", parentThreadId: "main", hasPendingInteraction: true });
  const d = derive(child, activity({ ask: { kind: "question", text: "Ship it?", at: NOW - MINUTE } }), NOW);
  assert.equal(d.state, "wants");
  assert.equal(d.waitingOnYou, true);
});

test("a finished thread that has been read is done", () => {
  const t = thread({ id: "a", lastReadAt: NOW - HOUR, latestAttentionAt: NOW - 2 * HOUR });
  const d = derive(t, activity({ output: "All done." }), NOW);
  assert.deepEqual(d, {
    state: "done",
    since: NOW - 2 * HOUR,
    doing: "All done.",
    next: "",
    waitingOnYou: false,
  });
});

test("an archived thread is done from the moment it was archived", () => {
  const t = thread({ id: "a", archivedAt: NOW - DAY, lastReadAt: null, hasPendingInteraction: true });
  const d = derive(t, undefined, NOW);
  assert.equal(d.state, "done");
  assert.equal(d.since, NOW - DAY);
  assert.equal(d.waitingOnYou, false);
});

test("an errored thread has failed, and is the user's to deal with", () => {
  const t = thread({ id: "a", status: "error", lastReadAt: null, latestAttentionAt: NOW - HOUR });
  const d = derive(t, activity({ output: "API Error: overloaded" }), NOW);
  assert.equal(d.state, "failed");
  assert.equal(d.since, NOW - HOUR);
  assert.equal(d.doing, "API Error: overloaded");
  assert.equal(d.waitingOnYou, true);
  const child = derive({ ...t, parentThreadId: "main" }, undefined, NOW);
  assert.equal(child.state, "failed");
  assert.equal(child.waitingOnYou, true);
});

test("an idle thread whose last turn failed has failed", () => {
  const t = thread({ id: "a" });
  const d = derive(
    t,
    activity({ turn: { phase: "completed", at: NOW - 30 * MINUTE, failed: true } }),
    NOW,
  );
  assert.equal(d.state, "failed");
  assert.equal(d.since, NOW - 30 * MINUTE);
  assert.equal(d.doing, "its last turn failed");
});

test("running with no event for longer than the limit is stuck, and says what it was doing", () => {
  const quiet = LIMITS.runningQuietMs + HOUR;
  const t = thread({ id: "a", status: "active", latestAttentionAt: NOW - DAY });
  const d = derive(
    t,
    activity({
      turn: { phase: "started", at: NOW - 5 * HOUR, failed: false },
      lastEventAt: NOW - quiet,
      latestStep: "$ sleep 9999",
    }),
    NOW,
  );
  assert.equal(d.state, "stuck");
  assert.equal(d.since, NOW - quiet);
  assert.equal(d.doing, "no event for 3h · last: $ sleep 9999");
});

test("running just inside the limit is still running", () => {
  const t = thread({ id: "a", status: "active" });
  const d = derive(
    t,
    activity({
      turn: { phase: "started", at: NOW - 5 * HOUR, failed: false },
      lastEventAt: NOW - LIMITS.runningQuietMs + MINUTE,
    }),
    NOW,
  );
  assert.equal(d.state, "running");
});

test("an ask ignored for longer than the limit is stuck but still waits on you", () => {
  const t = thread({
    id: "a",
    hasPendingInteraction: true,
    latestAttentionAt: NOW - LIMITS.waitingOnUserMs - DAY,
  });
  const d = derive(t, undefined, NOW);
  assert.equal(d.state, "stuck");
  assert.equal(d.next, "it has waited 8d on you");
  assert.equal(d.waitingOnYou, true);
});

test("done lines are listed for two days", () => {
  const recent = derive(thread({ id: "a", archivedAt: NOW - DAY }), undefined, NOW);
  const old = derive(thread({ id: "b", archivedAt: NOW - 3 * DAY }), undefined, NOW);
  assert.equal(isRecentDone(recent, NOW), true);
  assert.equal(isRecentDone(old, NOW), false);
});

test("a permission request says what it is and how to decide it", () => {
  const t = thread({ id: "t", parentThreadId: "main", status: "active", hasPendingInteraction: true });
  const d = derive(t, activity({ ask: { kind: "permission", text: "permission to run: echo cow", at: NOW - MINUTE } }), NOW);
  assert.equal(d.state, "wants");
  assert.equal(d.doing, "permission to run: echo cow");
  assert.equal(d.next, "grant or deny: press a");
  assert.equal(d.waitingOnYou, true);
});

test("an archived thread carries the reason it was archived for, and only while archived", () => {
  const archived = thread({ id: "t", parentThreadId: "main", archivedAt: NOW - HOUR });
  assert.equal(derive(archived, activity({ output: "all done" }), NOW, null, "superseded").archivedWhy, "superseded");
  assert.equal(derive(archived, undefined, NOW, null, null).archivedWhy, undefined);
  // Unarchived by undo, the note stays on the thread but the line does not show it.
  const back = derive({ ...archived, archivedAt: null }, undefined, NOW, null, "superseded");
  assert.equal(back.state, "done");
  assert.equal(back.archivedWhy, undefined);
});
