import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseChecker, failureOf, turnFailedText } from "../src/briefs/provider.ts";
import { briefView } from "../src/briefs/service.ts";
import { world } from "./memory.ts";

const none = { provider: null, model: null };
const own = { provider: "claude-code", model: "claude-opus-5-5" };

test("with nothing given or set, the checker runs on the submitting thread's provider and model", () => {
  assert.deepEqual(chooseChecker({}, none, own), { provider: "claude-code", model: "claude-opus-5-5", chosen: { provider: "inherited", model: "inherited" } });
  // bb did not say the model: that provider's default.
  assert.deepEqual(chooseChecker({}, none, { provider: "codex", model: null }), { provider: "codex", model: null, chosen: { provider: "inherited", model: "default" } });
  // Nothing known at all: bb's default, as before.
  assert.deepEqual(chooseChecker({}, none, none), { provider: null, model: null, chosen: { provider: "default", model: "default" } });
});

test("cow's settings come ahead of the inherited provider and model", () => {
  assert.deepEqual(chooseChecker({}, { provider: "codex", model: "gpt-small" }, own), { provider: "codex", model: "gpt-small", chosen: { provider: "setting", model: "setting" } });
  // A provider set without a model: that provider's default, never the other provider's model.
  assert.deepEqual(chooseChecker({}, { provider: "codex", model: null }, own), { provider: "codex", model: null, chosen: { provider: "setting", model: "default" } });
  // A model set without a provider runs on the inherited provider.
  assert.deepEqual(chooseChecker({}, { provider: null, model: "claude-haiku-5-5" }, own), { provider: "claude-code", model: "claude-haiku-5-5", chosen: { provider: "inherited", model: "setting" } });
});

test("what the command gives overrides both", () => {
  const set = { provider: "codex", model: "gpt-small" };
  assert.deepEqual(chooseChecker({ provider: "pi", model: "m" }, set, own), { provider: "pi", model: "m", chosen: { provider: "given", model: "given" } });
  // A provider given alone is not paired with the setting's model.
  assert.deepEqual(chooseChecker({ provider: "pi" }, set, own), { provider: "pi", model: null, chosen: { provider: "given", model: "default" } });
  // Given the submitting thread's own provider, its model goes with it.
  assert.deepEqual(chooseChecker({ provider: "claude-code" }, none, own), { provider: "claude-code", model: "claude-opus-5-5", chosen: { provider: "given", model: "inherited" } });
  assert.deepEqual(chooseChecker({ model: "claude-haiku-5-5" }, none, own), { provider: "claude-code", model: "claude-haiku-5-5", chosen: { provider: "inherited", model: "given" } });
});

test("a failed turn says where it ran, why, and how to run it elsewhere", () => {
  // Newest first, as bb's events are read.
  const signedOut = failureOf([
    { type: "turn/completed", data: { status: "failed", error: { message: "Your access token could not be refreshed." } } },
    { type: "provider/error", data: { message: "Provider error", detail: "Your access token could not be refreshed. Please sign in again.", errorInfo: { category: "unauthorized", providerCode: "unauthorized", httpStatusCode: null } } },
  ]);
  assert.deepEqual(signedOut, { category: "unauthorized", detail: "Your access token could not be refreshed. Please sign in again.", httpStatus: null });
  assert.equal(
    turnFailedText({ provider: "codex", model: "gpt-x", failure: signedOut, threadId: "thr_a" }),
    'the checker\'s turn failed on codex, model gpt-x: the provider is not signed in (bb said: "Your access token could not be refreshed. Please sign in again."). ' +
      "To check it on another provider: bb cow brief check thr_a --provider <provider> --model <model>",
  );

  const noModel = failureOf([{ type: "provider/error", data: { detail: "There's an issue with the selected model.", errorInfo: { category: "bad-request", httpStatusCode: 404 } } }]);
  assert.match(turnFailedText({ provider: "claude-code", model: "nope", failure: noModel, threadId: "thr_a" }), /on claude-code, model nope: the provider does not have that model, or not for this account \(bb said: "There's an issue/);

  const http401 = failureOf([{ type: "provider/error", data: { message: "HTTP 401", errorInfo: { category: "unknown", httpStatusCode: 401 } } }]);
  assert.match(turnFailedText({ provider: null, model: null, failure: http401, threadId: "thr_a" }), /on bb's default provider and model: the provider is not signed in \(bb said: "HTTP 401"\)/);

  const onlyTurn = failureOf([{ type: "turn/completed", data: { status: "failed", error: { message: "boom" } } }]);
  assert.match(turnFailedText({ provider: "codex", model: null, failure: onlyTurn, threadId: "thr_a" }), /on codex, its default model: bb said: "boom"\.$/);

  const odd = failureOf([{ type: "provider/error", data: { errorInfo: { category: "something-new" } } }]);
  assert.match(turnFailedText({ provider: "codex", model: null, failure: odd, threadId: "thr_a" }), /: the provider reported an error \(something-new\)\.$/);

  assert.equal(failureOf([{ type: "turn/completed", data: { status: "failed" } }]), null);
  assert.match(turnFailedText({ provider: "codex", model: null, failure: null, threadId: "thr_a" }), /: bb recorded no cause\.$/);
});

test("a check records the inherited provider, and its failure says it failed there", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  Object.assign(w.own, { provider: "codex", model: "gpt-x" });
  const record = await w.briefs.submit({
    caller: "child",
    threadId: null,
    raw: { summary: "Did it.", claims: [{ id: "c1", text: "A holds", label: "checked", evidence: [{ description: "the diff", path: "diff.txt" }] }], judgementCalls: [], notDone: [] },
  });
  assert.deepEqual([w.started[0]?.provider, w.started[0]?.model], ["codex", "gpt-x"]);
  assert.deepEqual([record.check?.provider, record.check?.model, record.check?.chosen], ["codex", "gpt-x", { provider: "inherited", model: "inherited" }]);
  w.checkers.set("chk_1", { state: "error", reply: null, tools: [], failure: { category: "unauthorized", detail: "signed out", httpStatus: 401 } });
  const view = briefView(await w.briefs.get("child"));
  assert.equal(view.review.state, "failed");
  // A broken inherited provider is a failed check, not a quiet retry elsewhere.
  assert.equal(w.started.length, 1);
  assert.equal(
    view.review.failures[0],
    'the checker\'s turn failed on codex, model gpt-x: the provider is not signed in (bb said: "signed out"). To check it on another provider: bb cow brief check child --provider <provider> --model <model>',
  );
});

test("`brief show` keeps the way out at the end of a long failure", async () => {
  const { review, reviewText } = await import("../src/briefs/review.ts");
  const error = turnFailedText({ provider: "claude-code", model: "m", failure: { category: "bad-request", detail: "x".repeat(2000), httpStatus: 404 }, threadId: "thr_a" });
  const brief = { summary: "S", claims: [], judgementCalls: [], notDone: [] };
  const text = reviewText({ threadId: "thr_a", version: 1, summary: "S" }, review(brief, { model: "m", provider: "claude-code", startedAt: 1, runs: [{ status: "failed", error, threadId: "c", startedAt: 1, finishedAt: 2 }] }));
  assert.match(text, /To check it on another provider: bb cow brief check thr_a --provider <provider> --model <model>/);
});
