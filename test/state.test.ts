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
  assert.equal(d.next, "answer it in its chat");
  assert.equal(d.waitingOnYou, true);
});

test("a pending question shows its own words and when it was asked", () => {
  const t = thread({ id: "a", hasPendingInteraction: true, latestAttentionAt: NOW - DAY });
  const d = derive(
    t,
    activity({ output: "Let me check with you.", ask: { text: "Which colour?", at: NOW - HOUR } }),
    NOW,
  );
  assert.equal(d.doing, "Which colour?");
  assert.equal(d.since, NOW - HOUR);
  // A stale ask is ignored once nothing is pending.
  const answered = derive({ ...t, hasPendingInteraction: false, lastReadAt: NOW }, activity({ ask: { text: "Which colour?", at: NOW - HOUR } }), NOW);
  assert.equal(answered.state, "done");
});

test("a finished thread with an unread reply wants you", () => {
  const t = thread({ id: "a", lastReadAt: NOW - 3 * HOUR, latestAttentionAt: NOW - HOUR });
  const d = derive(t, activity({ output: "## Report\n\nAll done." }), NOW);
  assert.equal(d.state, "wants");
  assert.equal(d.doing, "Report");
  assert.equal(d.next, "read its reply");
  assert.equal(derive(thread({ id: "b", lastReadAt: null }), undefined, NOW).state, "wants");
});

test("a child thread's unread reply shows only in its event log", () => {
  // bb never moves a child's attention time, so its facts alone look read.
  const child = thread({
    id: "a",
    parentThreadId: "main",
    lastReadAt: NOW - DAY + 5,
    latestAttentionAt: NOW - DAY,
  });
  assert.equal(derive(child, undefined, NOW).state, "done");
  const finished = activity({ turn: { phase: "completed", at: NOW - HOUR, failed: false } });
  const d = derive(child, finished, NOW);
  assert.equal(d.state, "wants");
  assert.equal(d.since, NOW - HOUR);
  assert.equal(d.waitingOnYou, true);
  const read = derive({ ...child, lastReadAt: NOW - MINUTE }, finished, NOW);
  assert.equal(read.state, "done");
  assert.equal(read.since, NOW - HOUR);
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

test("an errored thread has failed, and is not an ask", () => {
  const t = thread({ id: "a", status: "error", lastReadAt: null, latestAttentionAt: NOW - HOUR });
  const d = derive(t, activity({ output: "API Error: overloaded" }), NOW);
  assert.equal(d.state, "failed");
  assert.equal(d.since, NOW - HOUR);
  assert.equal(d.doing, "API Error: overloaded");
  assert.equal(d.waitingOnYou, false);
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
