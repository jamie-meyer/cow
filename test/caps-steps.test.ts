import assert from "node:assert/strict";
import { test } from "node:test";
import { type StepsDraft, advance, back, digit, restated, scopeChoices, startSteps, toggleMode, write } from "../src/caps/steps.ts";

const PLACES = { home: "/Users/pat", dataDir: "/Users/pat/.bb" };
const SCOPES = scopeChoices("head", "main");
const title = (id: string) => ({ head: "Billing", main: "Main" })[id] ?? id;
const next = (draft: StepsDraft): StepsDraft => {
  const step = advance(draft, SCOPES, PLACES);
  assert.equal(step.kind, "stay");
  return (step as { draft: StepsDraft }).draft;
};

test("from a request the steps start on the rule, proposed and named; from scratch they ask the kind first", () => {
  const proposed = startSteps({ kind: "dir", text: "/tmp/scratch/one" });
  assert.equal(proposed.stage, "rule");
  assert.equal(proposed.text, "/tmp/scratch/one");
  assert.equal(proposed.name, "write one");
  assert.equal(back(proposed), null);
  const scratch = startSteps(null);
  assert.equal(scratch.stage, "kind");
  assert.equal(digit(scratch, 2, SCOPES).kind, "command");
  assert.equal(digit(scratch, 3, SCOPES).kind, "dir");
  assert.equal(next(digit(scratch, 2, SCOPES)).stage, "rule");
  assert.equal(back(next(scratch))?.stage, "kind");
});

test("who it can apply to is always the thread, the thread and what is under it, and everything under Main", () => {
  assert.deepEqual(SCOPES, [
    { kind: "thread", threadId: "head" },
    { kind: "subtree", threadId: "head" },
    { kind: "main", threadId: "main" },
  ]);
});

test("a refused rule keeps the steps on the rule, with the reason", () => {
  let draft = write(startSteps({ kind: "dir", text: "/tmp/scratch" }), "/Users/pat/.ssh");
  draft = next(draft);
  assert.equal(draft.stage, "rule");
  assert.match(draft.error, /SSH keys/);
  draft = next(write(draft, "/"));
  assert.match(draft.error, /root of the filesystem/);
  const command = next(write(startSteps({ kind: "command", text: "echo cow" }), "echo cow | sh"));
  assert.equal(command.stage, "rule");
  assert.match(command.error, /plain words only/);
  assert.match(next(toggleMode(write(command, "echo"))).error, /at least two words/);
  assert.equal(toggleMode(startSteps({ kind: "dir", text: "/tmp/x" })).mode, "exact");
});

test("the name follows the rule until the person types one; nothing is saved before the sentence is confirmed", () => {
  let draft = write(startSteps({ kind: "dir", text: "/tmp/scratch/one" }), "/tmp/scratch/");
  assert.equal(draft.name, "write scratch");
  draft = next(draft);
  assert.equal(draft.stage, "name");
  assert.equal(draft.text, "/tmp/scratch");
  assert.match(next(write(draft, "  ")).error, /needs a name/);
  draft = next(write(draft, " scratch  files "));
  assert.equal(draft.stage, "note");
  assert.equal(draft.name, "scratch files");
  draft = next(draft);
  assert.equal(draft.stage, "scope");
  assert.match(next(draft).error, /choose who/);
  assert.equal(next(draft).stage, "scope");
  assert.equal(digit(draft, 9, SCOPES).scope, null);
  draft = next(digit(draft, 2, SCOPES));
  assert.equal(draft.stage, "restate");
  assert.deepEqual(restated(draft, SCOPES, PLACES, title), { ok: true, value: "The thread “Billing” and every thread under it, now and later, may create and change files anywhere under /tmp/scratch, each time bb asks, without asking you." });
  assert.deepEqual(advance(draft, SCOPES, PLACES), { kind: "save", rule: { kind: "dir", text: "/tmp/scratch" }, name: "scratch files", note: null, scope: { kind: "subtree", threadId: "head" } });
  // Back from the sentence keeps everything chosen.
  const before = back(draft);
  assert.equal(before?.stage, "scope");
  assert.equal(before?.scope, 2);
  assert.equal(before?.name, "scratch files");
});

test("a prefix rule is stored as its words, and the sentence says anything may follow them", () => {
  let draft = toggleMode(write(startSteps({ kind: "command", text: "git push origin main" }), "git  push   origin"));
  draft = next(draft);
  assert.equal(draft.text, "git push origin");
  draft = next(next(draft));
  draft = next(digit(draft, 3, SCOPES));
  const said = restated(draft, SCOPES, PLACES, title);
  assert.ok(said.ok);
  assert.match(said.value, /^Every thread under “Main”, now and later, may run any command line that begins with the words “git push origin”, whatever follows them/);
  assert.deepEqual((advance(draft, SCOPES, PLACES) as { rule: unknown }).rule, { kind: "command", mode: "prefix", text: "git push origin" });
});

test("typing only goes into the field of the step that has one", () => {
  const scope = { ...startSteps({ kind: "dir", text: "/tmp/x" }), stage: "scope" as const };
  assert.equal(write(scope, "zzz"), scope);
  assert.equal(digit(startSteps({ kind: "dir", text: "/tmp/x" }), 1, SCOPES).scope, null);
});
