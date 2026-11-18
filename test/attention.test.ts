import assert from "node:assert/strict";
import { test } from "node:test";
import { findReplies, starterOf, unreadReply } from "../src/attention.ts";
import { derive } from "../src/state.ts";
import { buildOverview, projectIds } from "../src/tree.ts";
import type { Refusal } from "../src/refusal.ts";
import { HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

let seq = 0;
const at = (n: number) => NOW - HOUR + n * MINUTE;
type Sender = "person" | "spawn" | "agent" | "system";
/** A prompt as bb records it. */
function prompt(sender: Sender, steer = false) {
  seq += 1;
  const data =
    sender === "spawn"
      ? { source: "spawn", initiator: "user", senderThreadId: null }
      : sender === "person"
        ? { source: "tell", initiator: "user", senderThreadId: null }
        : sender === "agent"
          ? { source: "tell", initiator: "agent", senderThreadId: "thr_parent" }
          : { source: "tell", initiator: "system", senderThreadId: null, systemMessageKind: "child-completed" };
  return {
    seq,
    createdAt: at(seq),
    type: "client/turn/requested",
    data: { ...data, target: steer ? { kind: "steer", expectedTurnId: "t" } : { kind: "new-turn" } },
  };
}
const started = () => ({ seq: ++seq, createdAt: at(seq), type: "turn/started", data: {} });
const completed = (status = "completed") => ({ seq: ++seq, createdAt: at(seq), type: "turn/completed", data: { status } });
/** One whole turn started by `sender`. */
const turn = (sender: Sender, status = "completed") => [prompt(sender), started(), completed(status)];

test("who sent a prompt: the first prompt is never the person, whatever bb records", () => {
  assert.equal(starterOf({ source: "spawn", initiator: "user" }), "spawn");
  assert.equal(starterOf({ source: "tell", initiator: "user" }), "person");
  assert.equal(starterOf({ source: "tell", initiator: "agent", senderThreadId: "thr_a" }), "agent");
  assert.equal(starterOf({ source: "tell", initiator: "system", systemMessageKind: "child-completed" }), "system");
  // bb labels an ordinary message "unlabeled": that is not a notice.
  assert.equal(starterOf({ source: "tell", initiator: "user", systemMessageKind: "unlabeled" }), "person");
  assert.equal(starterOf({ source: "tell", initiator: "agent", systemMessageKind: "unlabeled" }), "agent");
  assert.equal(starterOf({ source: "tell", initiator: "user", systemMessageKind: "ownership-assigned" }), "system");
  assert.equal(starterOf({}), "system");
});

test("a turn the person started ends in a reply to them", () => {
  const events = turn("person");
  const replies = findReplies(events);
  assert.equal(replies.toPerson?.seq, events[2]!.seq);
  assert.equal(replies.last?.seq, events[2]!.seq);
  assert.equal(replies.toPerson?.at, events[2]!.createdAt);
  assert.equal(replies.personSpokeSeq, events[0]!.seq);
});

for (const sender of ["spawn", "agent", "system"] as const) {
  test(`a turn started by ${sender === "spawn" ? "the thread's first prompt" : sender === "agent" ? "another agent" : "one of bb's notices"} is not a reply to the person`, () => {
    const events = turn(sender);
    const replies = findReplies(events);
    assert.equal(replies.toPerson, null);
    assert.equal(replies.last?.seq, events[2]!.seq);
    assert.equal(replies.personSpokeSeq, null);
  });
}

test("the events may come newest first", () => {
  const events = [...turn("agent"), ...turn("person")];
  assert.deepEqual(findReplies([...events].reverse()), findReplies(events));
  assert.equal(findReplies(events).toPerson?.seq, events[5]!.seq);
});

test("a later turn by someone else leaves the person's reply where it was", () => {
  const events = [...turn("person"), ...turn("agent"), ...turn("system")];
  const replies = findReplies(events);
  assert.equal(replies.toPerson?.seq, events[2]!.seq);
  assert.equal(replies.last?.seq, events[8]!.seq);
});

test("a message the person steers into a running turn makes its reply theirs", () => {
  const events = [prompt("agent"), started(), prompt("person", true), completed()];
  assert.equal(findReplies(events).toPerson?.seq, events[3]!.seq);
  // An agent steering it does not.
  const other = [prompt("person"), started(), completed(), prompt("agent"), started(), prompt("agent", true), completed()];
  assert.equal(findReplies(other).toPerson?.seq, other[2]!.seq);
});

test("a prompt queued while a turn runs starts the next turn, not this one", () => {
  const events = [prompt("agent"), started(), prompt("person"), completed(), started(), completed()];
  const replies = findReplies(events);
  assert.equal(replies.toPerson?.seq, events[5]!.seq);
});

test("a failed or interrupted turn is not a reply", () => {
  assert.deepEqual(findReplies(turn("person", "failed")).toPerson, null);
  assert.deepEqual(findReplies(turn("person", "interrupted")).last, null);
});

test("a turn whose start is older than the events read is not credited to the person", () => {
  const events = turn("person");
  const replies = findReplies(events.slice(1));
  assert.equal(replies.toPerson, null);
  assert.equal(replies.last?.seq, events[2]!.seq);
});

test("junk among the events is ignored", () => {
  assert.deepEqual(findReplies([null, 3, {}, { seq: "x", type: "turn/completed" }]), {
    last: null,
    toPerson: null,
    personSpokeSeq: null,
    personSpokeAt: null,
  });
});

test("unread: the person's reply counts only while it ends the newest finished turn; the newest reply of any turn can be marked", () => {
  const events = [...turn("person"), ...turn("agent")];
  const replies = findReplies(events);
  // The person's turn is no longer the newest: another thread has spoken to it since.
  assert.equal(unreadReply(replies, false, null), null);
  assert.equal(unreadReply(replies, true, null)?.seq, events[5]!.seq);
  const theirs = [...turn("agent"), ...turn("person")];
  assert.equal(unreadReply(findReplies(theirs), false, null)?.seq, theirs[5]!.seq);
  assert.equal(unreadReply(findReplies(turn("agent")), false, null), null);
  assert.equal(unreadReply(undefined, true, null), null);
});

test("unread: seen through that turn is read; a reply after the seen one is unread again", () => {
  const first = turn("person");
  const replies = findReplies(first);
  const end = first[2]!.seq;
  assert.equal(unreadReply(replies, false, end), null);
  assert.equal(unreadReply(replies, false, end + 100), null);
  assert.equal(unreadReply(replies, false, end - 1)?.seq, end);
  const second = [...first, ...turn("person")];
  assert.equal(unreadReply(findReplies(second), false, end)?.seq, second[5]!.seq);
  // Any turn: a notice-started turn after the seen one is a new reply to mark.
  const noticed = [...first, ...turn("system")];
  assert.equal(unreadReply(findReplies(noticed), true, end)?.seq, noticed[5]!.seq);
  assert.equal(unreadReply(findReplies(noticed), false, end), null);
});

test("unread: a message the person sent after the reply means they read it", () => {
  const events = [...turn("system"), prompt("person"), started(), completed("interrupted")];
  const replies = findReplies(events);
  assert.equal(replies.last?.seq, events[2]!.seq);
  assert.equal(unreadReply(replies, true, null), null);
});

// ---- the line's state ----------------------------------------------------

const child = (overrides = {}) => thread({ id: "a", parentThreadId: "main", lastReadAt: null, ...overrides });
const said = (events: unknown[]) => activity({ output: "All merged.\nDetails follow.", replies: findReplies(events) });
const state = (t: ReturnType<typeof thread>, events: unknown[], project: boolean, seenSeq: number | null = null) =>
  derive(t, said(events), NOW, null, null, null, { project, seenSeq });

test("a leaf that finished a turn its parent started is done", () => {
  for (const sender of ["spawn", "agent", "system"] as const) {
    const d = state(child(), turn(sender), false);
    assert.equal(d.state, "done", sender);
    assert.equal(d.waitingOnYou, false);
    assert.equal(d.reply, undefined);
  }
});

test("a leaf that finished a turn the person started replied to them", () => {
  const events = turn("person");
  const d = state(child(), events, false);
  assert.equal(d.state, "wants");
  assert.equal(d.waitingOnYou, true);
  assert.equal(d.doing, "replied to you: All merged.");
  assert.equal(d.next, "read it: Enter, or Space once seen");
  assert.equal(d.since, events[2]!.createdAt);
  assert.deepEqual(d.reply, { seq: events[2]!.seq });
});

test("seen, it is done; a reply after the seen one wants the person again", () => {
  const first = turn("person");
  const seen = first[2]!.seq;
  assert.equal(state(child(), first, false, seen).state, "done");
  const again = [...first, ...turn("person")];
  const d = state(child(), again, false, seen);
  assert.equal(d.state, "wants");
  assert.deepEqual(d.reply, { seq: again[5]!.seq });
});

test("while its turn runs it is running, and a question outranks a reply", () => {
  const events = turn("person");
  assert.equal(state(child({ status: "active" }), events, true).state, "running");
  const asking = state(child({ hasPendingInteraction: true }), events, true);
  assert.equal(asking.state, "wants");
  assert.equal(asking.next, "answer it: press a");
  assert.equal(asking.reply, undefined);
});

test("a reply nobody read for a week is still the person's, and never reads as stuck: it is at rest", () => {
  seq = 0;
  const events = turn("person").map((event) => ({ ...event, createdAt: NOW - 8 * 24 * HOUR }));
  const d = state(child(), events, false);
  assert.equal(d.state, "wants");
  assert.equal(d.waitingOnYou, true);
  assert.deepEqual(d.reply, { seq: events[2]!.seq });
});

test("without attention, or for a thread with no parent that is not Main, bb's own unread record decides", () => {
  const events = turn("person");
  assert.equal(derive(child(), said(events), NOW).state, "done");
  const main = thread({ id: "main", lastReadAt: NOW, latestAttentionAt: NOW - HOUR });
  assert.equal(derive(main, said(events), NOW, null, null, null, { seenSeq: null }).state, "done");
  const unread = thread({ id: "main", lastReadAt: NOW - 2 * HOUR, latestAttentionAt: NOW - HOUR });
  const d = derive(unread, said(events), NOW, null, null, null, { seenSeq: 10_000 });
  assert.equal(d.state, "wants");
  assert.equal(d.next, "read its reply");
});

test("parked, archived and failed outrank an unseen reply", () => {
  const events = turn("person");
  const park = { at: NOW - HOUR, reason: "later", pickUp: { kind: "none" as const }, checkedAt: NOW - HOUR };
  assert.equal(derive(child(), said(events), NOW, park, null, null, { seenSeq: null }).state, "parked");
  assert.equal(state(child({ archivedAt: NOW - MINUTE }), events, true).state, "done");
  assert.equal(state(child({ status: "error" }), events, true).state, "failed");
});

test("a refused permission outranks an unseen reply, which is still there once it is dismissed", () => {
  const events = turn("person");
  const refusal: Refusal = { id: "c1", kind: "command", what: "echo cow", cwd: null, change: null, diff: null, why: "refused", at: NOW - MINUTE, seq: 900 };
  const blocked = activity({ output: "ok", replies: findReplies(events), refusals: [refusal] });
  const d = derive(child(), blocked, NOW, null, null, null, { seenSeq: null });
  assert.equal(d.state, "blocked");
  assert.equal(d.reply, undefined);
  const dismissed = derive(child(), blocked, NOW, null, null, 900, { seenSeq: null });
  assert.equal(dismissed.state, "wants");
  assert.deepEqual(dismissed.reply, { seq: events[2]!.seq });
});

// ---- a worker handed a thread ---------------------------------------------

/** bb's notice that a thread was moved under this one, as it records it. */
function ownershipNotice(initiator = "system", kind = "ownership-assigned") {
  seq += 1;
  return {
    seq,
    createdAt: at(seq),
    type: "client/turn/requested",
    data: { source: "tell", initiator, senderThreadId: null, systemMessageKind: kind, target: { kind: "new-turn" } },
  };
}
/** What a permission prompt adds to the log: none of it is a turn's start or end. */
const permissionPrompt = () => [
  { seq: ++seq, createdAt: at(seq), type: "system/interaction/lifecycle", data: { phase: "requested", interaction: { kind: "approval" } } },
  { seq: ++seq, createdAt: at(seq), type: "system/interaction/lifecycle", data: { phase: "resolved", decision: "allow_once" } },
];

test("a worker spawned by an agent, that hit a permission prompt, then was handed a thread, is not the person's to read", () => {
  // Its one turn: spawned with a brief, a permission prompt on the way, a final report.
  const work = [prompt("spawn"), started(), ...permissionPrompt(), completed()];
  // Then a thread was moved under it, and bb started a turn to say so.
  const notice = [ownershipNotice(), started(), completed()];
  const events = [...work, ...notice];
  const replies = findReplies(events);
  // The permission prompt changes nothing: the turn is still its spawner's.
  assert.equal(findReplies(work).toPerson, null);
  assert.equal(replies.toPerson, null);
  assert.equal(replies.personSpokeSeq, null);
  // bb's notice ends in no reply: the last one is its report.
  assert.equal(replies.last?.seq, work[work.length - 1]!.seq);
  // Having a thread under it makes it a project: idle, its report marked unread, not in the queue.
  const project = derive(child(), said(events), NOW, null, null, null, { project: true, seenSeq: null });
  assert.equal(project.state, "idle");
  assert.equal(project.waitingOnYou, false);
  assert.equal(project.reply, undefined);
  assert.deepEqual(project.unseen, { seq: work[work.length - 1]!.seq });
});

test("a notice of bb's is never the person, whatever initiator it records", () => {
  assert.equal(starterOf({ source: "tell", initiator: "user", systemMessageKind: "ownership-assigned" }), "system");
  const events = [prompt("person"), started(), completed(), ownershipNotice("user"), started(), completed()];
  const replies = findReplies(events);
  assert.equal(replies.personSpokeSeq, events[0]!.seq);
  // The person's turn is still the newest that ended in a reply.
  assert.equal(replies.last?.seq, events[2]!.seq);
  assert.equal(replies.toPerson?.seq, events[2]!.seq);
});

test("a project the person wrote to replied to them, though a thread was moved under it since; a later report ends that", () => {
  const spoken = [prompt("person"), started(), completed(), ownershipNotice(), started(), completed()];
  const d = state(child(), spoken, true);
  assert.equal(d.state, "wants");
  assert.deepEqual(d.reply, { seq: spoken[2]!.seq });
  // A notice that a thread was moved away ends in no reply either.
  const moved = [...turn("person"), ownershipNotice("system", "ownership-removed"), started(), completed()];
  assert.equal(findReplies(moved).last?.seq, moved[2]!.seq);
  // A report from a thread under it starts a turn that is not the person's: its reply is marked, not queued.
  const reported = [...spoken, ...turn("system")];
  const after = state(child(), reported, true);
  assert.deepEqual([after.state, after.waitingOnYou, after.unseen], ["idle", false, { seq: reported[reported.length - 1]!.seq }]);
});

// ---- the rule, for every kind of thread -----------------------------------

type Opener = "person" | "steer" | "agent" | "notice" | "spawn";
/** One whole turn, opened as named: "steer" is an agent's turn the person spoke into while it ran. */
function opened(by: Opener) {
  if (by === "steer") return [prompt("agent"), started(), prompt("person", true), completed()];
  return turn(by === "notice" ? "system" : by);
}

test("a reply enters the queue only when the person started its turn, or spoke into it, for Main, a project, a group head and a worker alike", () => {
  const kinds = ["main", "marked", "head", "worker"] as const;
  for (const by of ["person", "steer", "agent", "notice", "spawn"] as const) {
    for (const kind of kinds) {
      for (const seen of [false, true]) {
        seq = 0;
        const events = opened(by);
        const end = events[events.length - 1]!.seq;
        // bb has Main unread throughout: its own record no longer decides.
        const threads = [
          thread({ id: "main", lastReadAt: null, latestAttentionAt: NOW }),
          thread({ id: "marked", parentThreadId: "main", createdAt: 2 }),
          thread({ id: "head", parentThreadId: "main", createdAt: 3 }),
          thread({ id: "kid", parentThreadId: "head", createdAt: 4, status: "active" }),
          thread({ id: "worker", parentThreadId: "main", createdAt: 5 }),
        ];
        const projects = projectIds(threads, ["marked"], "main");
        const overview = buildOverview(
          threads,
          "main",
          (t) =>
            derive(t, t.id === kind ? said(events) : activity({ lastEventAt: NOW }), NOW, null, null, null, {
              project: projects.has(t.id),
              main: t.id === "main",
              seenSeq: t.id === kind && seen ? end : null,
            }),
          NOW,
          { note: () => null, todos: () => [], marked: (id) => id === "marked" },
        );
        const line = kind === "main" ? overview.main! : [...overview.lines, ...overview.settle].find((l) => l.thread.id === kind)!;
        const where = `${by} · ${kind} · ${seen ? "seen" : "unseen"}`;
        const persons = by === "person" || by === "steer";
        const queued = overview.queue.some((l) => l.thread.id === kind);
        assert.equal(queued, persons && !seen, where);
        if (persons && !seen) {
          assert.deepEqual([line.derived.state, line.derived.reply], ["wants", { seq: end }], where);
          continue;
        }
        assert.equal(line.derived.state, kind === "worker" ? "done" : "idle", where);
        assert.equal(line.derived.reply, undefined, where);
        // Unseen, the reply is marked; seen, nothing is.
        assert.deepEqual(line.derived.unseen, seen ? undefined : { seq: end }, where);
        if (kind === "worker") assert.equal(overview.settle.some((l) => l.thread.id === "worker"), true, where);
      }
    }
  }
});
