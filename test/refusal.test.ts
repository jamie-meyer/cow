import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Refusal,
  askAgainMessage,
  carryOnMessage,
  chooseBlocked,
  confirmBlocked,
  emptyBlockedDraft,
  findRefusals,
  refusalSummary,
  undismissed,
  writeBlocked,
} from "../src/refusal.ts";
import { derive } from "../src/state.ts";
import { verbBlocked } from "../src/verbs.ts";
import { NOW, activity, thread } from "./fixtures.ts";

// The events below have the shape bb 0.49 gives them, cut down to what is read.

const SANDBOX =
  "bb's workspace sandbox allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
const OUTSIDE = "Path is outside allowed working directories";

let seq = 0;
const next = () => (seq += 1);
const prompt = (initiator: "user" | "agent" | "system") => ({
  seq: next(),
  createdAt: NOW + seq,
  type: "client/turn/requested",
  data: { initiator, target: { kind: "new-turn" } },
});
const turnStarted = () => ({ seq: next(), createdAt: NOW + seq, type: "turn/started", data: {} });
const command = (cmd: string, how: "refused" | "ran" | "failed" | "user-denied") => ({
  seq: next(),
  createdAt: NOW + seq,
  type: "item/completed",
  data: {
    item: {
      type: "commandExecution",
      id: `item-${seq}`,
      command: cmd,
      cwd: "",
      status: how === "ran" ? "completed" : how === "user-denied" ? "interrupted" : "failed",
      approvalStatus: how === "user-denied" ? "denied" : null,
      aggregatedOutput: how === "refused" ? SANDBOX : how === "failed" ? "sh: nope: command not found" : "",
      exitCode: how === "ran" ? 0 : 1,
    },
  },
});
const fileChange = (path: string, how: "refused" | "written" | "failed") => ({
  seq: next(),
  createdAt: NOW + seq,
  type: "item/completed",
  data: {
    item: {
      type: "fileChange",
      id: `item-${seq}`,
      changes: [{ path, kind: "add", diff: `--- /dev/null\n+++ b${path}\n+cow\n` }],
      status: how === "written" ? "completed" : "failed",
      approvalStatus: null,
      ...(how === "written" ? {} : { error: how === "refused" ? OUTSIDE : "File has not been read yet" }),
    },
  },
});
/** A turn another thread started. Its events are numbered in the order given. */
const agentTurn = (...events: { seq: number; createdAt: number }[]) =>
  [prompt("agent"), turnStarted(), ...events].map((event) => {
    const at = next();
    return { ...event, seq: at, createdAt: NOW + at };
  });
const whats = (refusals: readonly Refusal[]) => refusals.map((refusal) => refusal.what);

test("a command bb refused on a turn an agent started is found, with what bb said", () => {
  const [refusal] = findRefusals(agentTurn(command("echo cow", "refused")));
  assert.ok(refusal);
  assert.equal(refusal.kind, "command");
  assert.equal(refusal.what, "echo cow");
  assert.equal(refusal.why, SANDBOX);
  assert.ok(refusal.at > NOW && refusal.seq > 0);
});

test("a refused file change is found, with its path and diff", () => {
  const [refusal] = findRefusals(agentTurn(fileChange("/tmp/cow/a.txt", "refused")));
  assert.ok(refusal);
  assert.equal(refusal.kind, "file_change");
  assert.equal(refusal.what, "/tmp/cow/a.txt");
  assert.equal(refusal.change, "add");
  assert.match(refusal.diff ?? "", /\+cow/);
});

test("a turn started by the system counts as not started by a person", () => {
  const events = [prompt("system"), turnStarted(), command("echo cow", "refused")];
  assert.deepEqual(whats(findRefusals(events)), ["echo cow"]);
});

test("a denial by the user is not a refusal", () => {
  const events = [prompt("user"), turnStarted(), command("echo cow", "user-denied")];
  assert.deepEqual(findRefusals(events), []);
});

test("a command or change that failed for its own reasons is not a refusal", () => {
  assert.deepEqual(findRefusals(agentTurn(command("nope", "failed"), fileChange("/w/a.txt", "failed"))), []);
});

test("nothing is refused on a turn the user started, whatever the error says", () => {
  assert.deepEqual(findRefusals([prompt("user"), turnStarted(), command("echo cow", "refused")]), []);
});

test("events may come newest first, as bb lists them", () => {
  const events = agentTurn(command("echo cow", "refused"), fileChange("/tmp/a", "refused"));
  assert.deepEqual(whats(findRefusals([...events].reverse())), ["echo cow", "/tmp/a"]);
});

test("unresolved: a message from the user afterwards clears it", () => {
  const events = [...agentTurn(command("echo cow", "refused")), prompt("user"), turnStarted()];
  assert.deepEqual(findRefusals(events), []);
});

test("unresolved: a newer turn clears it, whoever started that turn", () => {
  const events = [...agentTurn(command("echo cow", "refused")), ...agentTurn(command("ls", "ran"))];
  assert.deepEqual(findRefusals(events), []);
});

test("unresolved: the same action succeeding later in the turn clears only that one", () => {
  const events = agentTurn(
    command("echo cow", "refused"),
    fileChange("/tmp/a", "refused"),
    command("echo cow", "ran"),
  );
  assert.deepEqual(whats(findRefusals(events)), ["/tmp/a"]);
  assert.deepEqual(findRefusals([...events, fileChange("/tmp/a", "written")]), []);
});

test("unresolved: a different command succeeding does not clear it", () => {
  assert.deepEqual(whats(findRefusals(agentTurn(command("echo cow", "refused"), command("ls", "ran")))), ["echo cow"]);
});

test("the same action refused twice is one refusal, at its newest", () => {
  const events = agentTurn(command("echo cow", "refused"), command("echo cow", "refused"));
  const found = findRefusals(events);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.seq, seq);
});

test("a refusal whose prompt is not among the events is left out", () => {
  assert.deepEqual(findRefusals([command("echo cow", "refused")]), []);
});

test("events of other shapes are ignored", () => {
  assert.deepEqual(findRefusals([null, 3, { seq: "x" }, { seq: 1, type: "item/completed", data: { item: 7 } }]), []);
});

test("dismissing hides refusals up to that place in the log, not later ones", () => {
  const found = findRefusals(agentTurn(command("echo cow", "refused"), command("echo moo", "refused")));
  assert.deepEqual(whats(undismissed(found, null)), ["echo cow", "echo moo"]);
  assert.deepEqual(whats(undismissed(found, found[0]!.seq)), ["echo moo"]);
  assert.deepEqual(undismissed(found, found[1]!.seq), []);
});

test("the line says what was refused, and how many more", () => {
  const found = findRefusals(agentTurn(command("echo cow\necho more", "refused"), fileChange("/tmp/a", "refused")));
  assert.equal(refusalSummary(found.slice(0, 1)), "bb refused to run: echo cow");
  assert.equal(refusalSummary(found), "bb refused to run: echo cow (and 1 more)");
  assert.equal(refusalSummary(found.slice(1)), "bb refused to change /tmp/a");
});

test("the messages name exactly what was refused", () => {
  const found = findRefusals(agentTurn(command("echo cow", "refused"), fileChange("/tmp/a", "refused")));
  assert.match(askAgainMessage(found.slice(0, 1)), /Run exactly this command again, the same way as before:\n\necho cow$/);
  assert.match(askAgainMessage(found.slice(1)), /Make exactly this file change again.*\n\nchange the file \/tmp\/a$/s);
  assert.match(askAgainMessage(found), /Do exactly these again.*\n\necho cow\nchange the file \/tmp\/a$/s);
  assert.match(carryOnMessage(found), /I will not grant it.*\n\necho cow\nchange the file \/tmp\/a$/s);
});

test("the card: a digit only marks; Enter needs a choice; a message can be edited", () => {
  const found = findRefusals(agentTurn(command("echo cow", "refused")));
  let draft = emptyBlockedDraft(found);
  assert.deepEqual(confirmBlocked(draft), { kind: "incomplete", why: "choose an option first" });
  assert.equal(chooseBlocked(draft, 9), draft);
  // Nothing is chosen, so there is no message to edit.
  assert.equal(writeBlocked(draft, "x"), draft);

  draft = chooseBlocked(draft, 1);
  assert.deepEqual(confirmBlocked(draft), { kind: "send", action: "ask_again", text: askAgainMessage(found) });
  draft = writeBlocked(draft, "  try echo cow again  ");
  assert.deepEqual(confirmBlocked(draft), { kind: "send", action: "ask_again", text: "try echo cow again" });
  assert.equal(confirmBlocked(writeBlocked(draft, " ")).kind, "incomplete");

  // The other message is untouched by the edit.
  draft = chooseBlocked(draft, 2);
  assert.deepEqual(confirmBlocked(draft), { kind: "send", action: "carry_on", text: carryOnMessage(found) });
  assert.deepEqual(confirmBlocked(chooseBlocked(draft, 3)), { kind: "dismiss" });
});

// ---- the state ----------------------------------------------------------

const refused = () => findRefusals(agentTurn(command("echo cow", "refused"), fileChange("/tmp/a", "refused")));

test("a thread with an unresolved refusal is blocked, wants the user, and says what was refused", () => {
  const refusals = refused();
  const derived = derive(thread({ id: "t", parentThreadId: "main" }), activity({ refusals }), NOW + 60_000);
  assert.equal(derived.state, "blocked");
  assert.equal(derived.waitingOnYou, true);
  assert.equal(derived.since, refusals[0]!.at);
  assert.equal(derived.doing, "bb refused to run: echo cow (and 1 more)");
  assert.equal(derived.blocked?.refusals.length, 2);
});

test("blocked shows while the turn still runs, and gives way to a real request, a failure, parking and archiving", () => {
  const refusals = refused();
  const act = activity({ refusals });
  const base = { id: "t", parentThreadId: "main" };
  assert.equal(derive(thread({ ...base, status: "active" }), act, NOW).state, "blocked");
  assert.equal(derive(thread({ ...base, hasPendingInteraction: true }), act, NOW).state, "wants");
  assert.equal(derive(thread({ ...base, status: "error" }), act, NOW).state, "failed");
  assert.equal(derive(thread({ ...base, archivedAt: NOW }), act, NOW).state, "done");
  const park = { at: NOW, reason: "later", pickUp: { kind: "none" as const }, checkedAt: NOW };
  assert.equal(derive(thread(base), act, NOW, park).state, "parked");
});

test("dismissed refusals leave the thread in the state it would have had", () => {
  const refusals = refused();
  const t = thread({ id: "t", parentThreadId: "main" });
  const partly = derive(t, activity({ refusals }), NOW, null, null, refusals[0]!.seq);
  assert.equal(partly.state, "blocked");
  assert.equal(partly.doing, "bb refused to change /tmp/a");
  assert.equal(derive(t, activity({ refusals }), NOW, null, null, refusals[1]!.seq).state, "done");
});

test("a blocked line can be answered, and archived once its turn has ended", () => {
  const refusals = refused();
  const line = (status: string) => {
    const t = thread({ id: "t", parentThreadId: "main", status });
    return { thread: t, derived: derive(t, activity({ refusals }), NOW), depth: 0, parentId: null, queueNumber: 1, under: 0, openUnder: 0, members: 0, rollup: null, finishedAt: 0, unseenUnder: 0, note: null, project: null };
  };
  assert.equal(verbBlocked("answer", line("idle"), false), null);
  assert.equal(verbBlocked("archive", line("idle"), false), null);
  assert.equal(verbBlocked("archive", line("active"), false), "only done, idle, waiting, kept or failed lines can be archived");
  assert.equal(verbBlocked("park", line("idle"), false), null);
});
