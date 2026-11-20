import assert from "node:assert/strict";
import { test } from "node:test";
import { type Brief, validateBrief } from "../src/briefs/brief.ts";
import { checkerPrompt, parseCheckerReply } from "../src/briefs/checker.ts";
import { type Check, type ClaimVerdict, briefWaitText, briefWaits, disputeOf, markOf, markText, review, reviewText } from "../src/briefs/review.ts";
import { CHECK_TIMEOUT_MS, briefView } from "../src/briefs/service.ts";
import { Refusal } from "../src/kv.ts";
import { NOW } from "./fixtures.ts";
import { memoryKv, world } from "./memory.ts";

const RAW = {
  summary: "Added a rate limit to the login endpoint.",
  claims: [
    { text: "The limit is 5 a minute", label: "checked", evidence: [{ description: "the rule", text: "rate = 5/min" }] },
    { text: "No other rule changed", label: "inferred", evidence: [{ description: "the diff", path: "diff.txt" }] },
    { text: "It holds under load", label: "not-checked" },
  ],
  judgementCalls: [{ text: "Is 5 a minute too strict?" }],
  notDone: ["No load test was run"],
};
const errorsOf = (raw: unknown): string[] => {
  const result = validateBrief(raw);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.errors;
};

test("a valid brief is read, and claims get ids when they have none", () => {
  const result = validateBrief(RAW);
  assert.ok(result.ok);
  assert.deepEqual(result.brief.claims.map((claim) => claim.id), ["c1", "c2", "c3"]);
  assert.deepEqual(result.brief.claims[2]?.evidence, []);
  assert.deepEqual(result.brief.judgementCalls, [{ text: "Is 5 a minute too strict?", askId: null }]);
  const minimal = validateBrief({ summary: "Did it.", claims: [{ text: "It works", label: "not-checked" }] });
  assert.ok(minimal.ok);
  assert.deepEqual(minimal.brief.notDone, []);
});

test("validation errors name the field and say what it must be", () => {
  assert.match(errorsOf("nope")[0] ?? "", /must be a JSON object/);
  assert.deepEqual(errorsOf({}), ["summary: is required", "claims: is required"]);
  assert.match(errorsOf({ ...RAW, claims: [] }).join("\n"), /claims: state at least one claim/);
  assert.match(errorsOf({ ...RAW, summary: "one\n\ntwo" }).join("\n"), /summary: must be one paragraph/);
  assert.match(errorsOf({ ...RAW, extra: 1 }).join("\n"), /the brief: unknown key "extra"/);
  assert.match(errorsOf({ ...RAW, claims: [{ text: "x", label: "verified" }] }).join("\n"), /claims\[0\]\.label: must be one of: checked, inferred, not-checked/);
  assert.match(errorsOf({ ...RAW, claims: [{ text: "x", label: "checked" }] }).join("\n"), /claims\[0\]: is labelled "checked" but has no evidence/);
  assert.match(
    errorsOf({ ...RAW, claims: [{ text: "x", label: "inferred", evidence: [{ description: "d", text: "t", path: "p" }] }] }).join("\n"),
    /claims\[0\]\.evidence\[0\]: give exactly one of "text"/,
  );
  assert.match(errorsOf({ ...RAW, claims: [{ text: "x", label: "inferred", evidence: [{ description: "d" }] }] }).join("\n"), /exactly one of/);
  assert.match(errorsOf({ ...RAW, claims: [{ text: "x", label: "inferred", evidence: [{ text: "t" }] }] }).join("\n"), /claims\[0\]\.evidence\[0\]\.description: is required/);
  assert.match(
    errorsOf({ ...RAW, claims: [{ id: "a", text: "x", label: "inferred" }, { id: "a", text: "y", label: "inferred" }] }).join("\n"),
    /claims\[1\]\.id: "a" is used by an earlier claim/,
  );
  assert.match(errorsOf({ ...RAW, judgementCalls: [{ text: "x", askId: "42" }] }).join("\n"), /judgementCalls\[0\]\.askId: must be an ask id/);
  assert.match(errorsOf({ ...RAW, notDone: [""] }).join("\n"), /notDone\[0\]: must not be empty/);
});

test("a claim is disputed when the verdict is weaker than the label warrants", () => {
  assert.equal(disputeOf("checked", "not-supported"), "contradicted");
  assert.equal(disputeOf("inferred", "not-supported"), "contradicted");
  assert.equal(disputeOf("checked", "cannot-tell"), "not-established");
  // Agreement: the agent itself did not claim to know.
  assert.equal(disputeOf("inferred", "cannot-tell"), null);
  assert.equal(disputeOf("not-checked", "cannot-tell"), null);
  assert.equal(disputeOf("not-checked", "not-supported"), null);
  for (const label of ["checked", "inferred", "not-checked"] as const) assert.equal(disputeOf(label, "supported"), null);
});

const BRIEF: Brief = {
  summary: "Did the job.",
  claims: [
    { id: "c1", text: "A holds", label: "checked", evidence: [{ description: "log", path: null, text: "A: yes", truncated: false }] },
    { id: "c2", text: "B holds", label: "checked", evidence: [{ description: "log", path: "b.txt", text: "B: no", truncated: false }] },
    { id: "c3", text: "C holds", label: "checked", evidence: [] },
    { id: "c4", text: "D holds", label: "inferred", evidence: [] },
  ],
  judgementCalls: [{ text: "Ship it?", askId: "ask_1" }],
  notDone: ["E was not looked at"],
};
const verdicts = (c1: ClaimVerdict["verdict"], c2: ClaimVerdict["verdict"], c3: ClaimVerdict["verdict"], c4: ClaimVerdict["verdict"]): ClaimVerdict[] =>
  [c1, c2, c3, c4].map((verdict, index) => ({ id: `c${index + 1}`, shows: `shows ${index + 1}`, verdict, needs: verdict === "cannot-tell" ? "the full log" : null }));
const run = (v: ClaimVerdict[]) => ({ status: "done" as const, verdicts: v, threadId: "chk", startedAt: NOW, finishedAt: NOW });
const check = (...runs: Check["runs"]): Check => ({ model: "small", startedAt: NOW, runs });

test("a review puts contradicted claims first, then not established, and leaves the rest in order", () => {
  const seen = review(BRIEF, check(run(verdicts("supported", "not-supported", "cannot-tell", "cannot-tell"))));
  assert.equal(seen.state, "checked");
  assert.deepEqual(seen.disputes.map((entry) => [entry.claim.id, entry.dispute]), [
    ["c2", "contradicted"],
    ["c3", "not-established"],
  ]);
  assert.deepEqual(seen.claims.map((entry) => entry.claim.id), ["c1", "c4"]);
  assert.equal(seen.disputes[1]?.verdict?.needs, "the full log");
  const reordered = review(BRIEF, check(run(verdicts("cannot-tell", "supported", "not-supported", "supported"))));
  assert.deepEqual(reordered.disputes.map((entry) => entry.claim.id), ["c3", "c1"]);
  assert.deepEqual(markOf(2, seen, NOW, true), { version: 2, state: "checked", contradicted: 1, notEstablished: 1, judgementCalls: 1, at: NOW, read: true });
  assert.equal(markText(markOf(2, seen)), "brief disputed: 1 contradicted, 1 not established");
});

test("without a usable check nothing is verified and nothing is disputed", () => {
  const none = review(BRIEF, null);
  assert.equal(none.state, "unchecked");
  assert.deepEqual(none.disputes, []);
  assert.ok(none.claims.every((entry) => entry.verdict === null));
  assert.equal(markText(markOf(1, none)), "brief not checked");

  const failed = review(BRIEF, check({ status: "failed", error: "not JSON", threadId: "chk", startedAt: NOW, finishedAt: NOW }));
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.failures, ["not JSON"]);
  assert.ok(failed.claims.every((entry) => entry.verdict === null));
  assert.equal(markText(markOf(1, failed)), "brief: the check failed");
  const text = reviewText({ threadId: "thr_a", version: 1, summary: BRIEF.summary }, failed);
  assert.match(text, /CHECK FAILED/);
  assert.match(text, /failed run: not JSON/);
  assert.doesNotMatch(text, /supported/);

  // A check with a run still going shows no verdict from the runs that finished.
  const half = review(BRIEF, check(run(verdicts("supported", "supported", "supported", "supported")), { status: "running", threadId: "chk2", startedAt: NOW, finishedAt: null }));
  assert.equal(half.state, "running");
  assert.ok(half.claims.every((entry) => entry.verdict === null));
});

test("with several runs the weakest verdict stands and disagreement is recorded per claim", () => {
  const seen = review(
    BRIEF,
    check(
      run(verdicts("supported", "supported", "supported", "supported")),
      run(verdicts("supported", "not-supported", "supported", "supported")),
      { status: "failed", error: "used a tool", threadId: "chk3", startedAt: NOW, finishedAt: NOW },
    ),
  );
  assert.equal(seen.state, "checked");
  assert.deepEqual(seen.runs, { done: 2, failed: 1, running: 0 });
  assert.deepEqual(seen.disputes.map((entry) => entry.claim.id), ["c2"]);
  assert.deepEqual(seen.disputes[0]?.disagreement, ["supported", "not-supported"]);
  assert.equal(seen.claims.find((entry) => entry.claim.id === "c1")?.disagreement, null);
  assert.match(reviewText({ threadId: "t", version: 1, summary: "s" }, seen), /the runs disagree: supported, not supported/);
});

test("the text shows disputes, then judgement calls, then other claims, then what was left undone", () => {
  const text = reviewText({ threadId: "thr_a", version: 3, summary: BRIEF.summary }, review(BRIEF, check(run(verdicts("supported", "not-supported", "cannot-tell", "supported")))));
  const order = ["Brief v3 from thr_a", "Checked by bb's default provider, model small: 1 run.", "Disputes (2)", "CONTRADICTED  c2", "NOT ESTABLISHED  c3", "Judgement calls for you (1)", "Ship it?  (ask_1)", "Other claims (2)", "c1  “A holds”", "Left undone (1)", "E was not looked at"];
  let at = -1;
  for (const part of order) {
    const found = text.indexOf(part, at + 1);
    assert.ok(found > at, `"${part}" is missing or out of order in:\n${text}`);
    at = found;
  }
  assert.match(text, /CONTRADICTED  c2  “B holds”  \(the agent says: checked\)\n      the evidence shows: shows 2\n      checker: not supported/);
  assert.match(text, /would settle it: the full log/);
  // The agent's label never stands in for a check.
  assert.doesNotMatch(text, /^\s*c\d.*✓/m);
});

test("the text is bounded", () => {
  const many: Brief = { ...BRIEF, claims: Array.from({ length: 40 }, (_, n) => ({ id: `c${n}`, text: "x".repeat(400), label: "checked" as const, evidence: [] })) };
  const all = many.claims.map((claim) => ({ id: claim.id, shows: "y".repeat(900), verdict: "not-supported" as const, needs: null }));
  const text = reviewText({ threadId: "t", version: 1, summary: "s" }, review(many, check(run(all))));
  assert.match(text, /… and 10 more, not listed/);
  assert.ok(text.length < 30_000, String(text.length));
});

test("the checker's prompt carries the brief and its evidence and nothing else", () => {
  const prompt = checkerPrompt(BRIEF, "N0NCE");
  assert.match(prompt, /^You are an independent checker\./);
  assert.match(prompt, /Do not use any tool/);
  assert.match(prompt, /Claim c2 \(the agent says: checked\): B holds/);
  assert.match(prompt, /Evidence 1 for c2: log \(the file b\.txt\)\n----- BEGIN EVIDENCE N0NCE -----\nB: no\n----- END EVIDENCE N0NCE -----/);
  assert.match(prompt, /Claim c3 \(the agent says: checked\): C holds\nNo evidence attached\./);
  assert.match(prompt, /- E was not looked at/);
  // Judgement calls are the user's; they are not put to the checker.
  assert.doesNotMatch(prompt, /Ship it\?/);
});

const IDS = ["c1", "c2"];
const good = { claims: [{ id: "c1", shows: "The log says yes.", verdict: "supported", needs: null }, { id: "c2", shows: "Nothing on B.", verdict: "cannot-tell", needs: "B's log" }] };

test("a well-formed reply is read, bare or in one fence", () => {
  const expected = [
    { id: "c1", shows: "The log says yes.", verdict: "supported", needs: null },
    { id: "c2", shows: "Nothing on B.", verdict: "cannot-tell", needs: "B's log" },
  ];
  assert.deepEqual(parseCheckerReply(JSON.stringify(good), IDS), { ok: true, verdicts: expected });
  assert.deepEqual(parseCheckerReply(`Here it is:\n\`\`\`json\n${JSON.stringify(good, null, 2)}\n\`\`\`\n`, IDS), { ok: true, verdicts: expected });
  // The order asked for is the order kept, and `needs` is dropped where it does not apply.
  const swapped = { claims: [{ ...good.claims[1] }, { ...good.claims[0], needs: "more" }] };
  assert.deepEqual(parseCheckerReply(JSON.stringify(swapped), IDS), { ok: true, verdicts: expected });
});

test("a reply that is not in the required form is a failed check, with the reason", () => {
  const fails = (reply: string | null, pattern: RegExp) => {
    const parsed = parseCheckerReply(reply, IDS);
    assert.equal(parsed.ok, false, `expected a failure for: ${reply}`);
    if (!parsed.ok) assert.match(parsed.error, pattern);
  };
  const withClaims = (claims: unknown) => JSON.stringify({ claims });
  fails(null, /gave no answer/);
  fails("   ", /gave no answer/);
  fails("Both claims look fine to me. DECISION: approve", /not the one JSON object/);
  fails("```json\n{}\n```\nand\n```json\n{}\n```", /not the one JSON object/);
  fails('{"claims": [', /not valid JSON/);
  fails("{}", /not in the required form/);
  fails(JSON.stringify({ ...good, decision: "approve" }), /not in the required form/);
  fails(withClaims([{ ...good.claims[0], verdict: "approved" }, good.claims[1]]), /not in the required form: claims\.0\.verdict/);
  fails(withClaims([{ ...good.claims[0], shows: " " }, good.claims[1]]), /not in the required form: claims\.0\.shows/);
  fails(withClaims([good.claims[0]]), /no verdict on c2/);
  fails(withClaims([good.claims[0], good.claims[0], good.claims[1]]), /judged claim c1 twice/);
  fails(withClaims([...good.claims, { id: "c9", shows: "x", verdict: "supported", needs: null }]), /does not have: c9/);
  fails(withClaims([good.claims[0], { ...good.claims[1], needs: null }]), /cannot-tell on c2 without saying/);
  fails(withClaims([good.claims[0], { id: "c2", shows: "x", verdict: "cannot-tell" }]), /cannot-tell on c2 without saying/);
});

const refused = async (run: Promise<unknown>, code: string, pattern?: RegExp) => {
  await assert.rejects(run, (cause: unknown) => cause instanceof Refusal && cause.code === code && (pattern === undefined || pattern.test(cause.message)), `expected ${code}`);
};
const answerAll = (verdict: string) => JSON.stringify({ claims: ["c1", "c2", "c3"].map((id) => ({ id, shows: `About ${id}.`, verdict, needs: verdict === "cannot-tell" ? "more" : null })) });

test("submitting stores the brief with its evidence copied, and starts the check", async () => {
  const w = world();
  w.files.set("child/diff.txt", "+ rate = 5/min");
  const record = await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  assert.equal(record.version, 1);
  assert.equal(record.threadId, "child");
  assert.deepEqual(record.brief.claims[1]?.evidence, [{ description: "the diff", path: "diff.txt", text: "+ rate = 5/min", truncated: false }]);
  assert.equal(record.check?.runs.length, 1);
  assert.equal(record.check?.runs[0]?.status, "running");
  assert.equal(w.started.length, 1);
  assert.match(w.started[0]?.prompt ?? "", /\+ rate = 5\/min/);
  assert.equal(w.started[0]?.environmentId, "env_1");
  assert.equal(briefView(record).mark.state, "running");

  // The file changing later does not change what was submitted.
  w.files.set("child/diff.txt", "something else");
  assert.equal((await w.briefs.get("child")).brief.claims[1]?.evidence[0]?.text, "+ rate = 5/min");
});

test("a brief that cannot be stored says what to fix", async () => {
  const w = world();
  await refused(w.briefs.submit({ caller: "child", threadId: null, raw: { summary: "x" } }), "bad_brief", /claims: is required/);
  await refused(w.briefs.submit({ caller: "child", threadId: null, raw: RAW }), "bad_brief", /claims\[1\]\.evidence\[0\]\.path: diff\.txt could not be read/);
  w.files.set("child/diff.txt", "ok");
  const leaving = { ...RAW, claims: [{ text: "x", label: "inferred", evidence: [{ description: "d", path: "../main/secret.txt" }] }] };
  await refused(w.briefs.submit({ caller: "child", threadId: null, raw: leaving }), "bad_brief", /leaves the thread's storage/);
  await refused(w.briefs.submit({ caller: "child", threadId: null, raw: { ...RAW, judgementCalls: [{ text: "x", askId: "ask_zz" }] } }), "bad_brief", /ask_zz is not an ask of child/);
  const huge = { ...RAW, claims: Array.from({ length: 6 }, (_, n) => ({ text: `c${n}`, label: "inferred", evidence: [{ description: "d", text: "x".repeat(11_000) }] })) };
  await refused(w.briefs.submit({ caller: "child", threadId: null, raw: huge }), "bad_brief", /over the limit of 60000/);
  await refused(w.briefs.submit({ caller: "other", threadId: "child", raw: RAW }), "not_your_thread");
  await refused(w.briefs.submit({ caller: null, threadId: null, raw: RAW }), "no_thread");
  await refused(w.briefs.get("child"), "brief_not_found");
  assert.equal(w.started.length, 0);
});

test("a judgement call can point at an ask of the same thread", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  const ask = await w.asks.ask({ caller: "child", threadId: null, question: "Too strict?", options: [], optionsOnly: false, risk: null, proofs: [], context: null });
  const record = await w.briefs.submit({ caller: "child", threadId: null, raw: { ...RAW, judgementCalls: [{ text: "Is 5 too strict?", askId: ask.id }] } });
  assert.equal(record.brief.judgementCalls[0]?.askId, ask.id);
});

test("the checker's answer settles the check: a contradicted claim is disputed, a supported one is not", async () => {
  const w = world();
  w.files.set("child/diff.txt", "+ rate = 50/min");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply(
    "chk_1",
    JSON.stringify({
      claims: [
        { id: "c1", shows: "The rule sets 5 a minute.", verdict: "supported", needs: null },
        { id: "c2", shows: "The diff changes another rule to 50 a minute.", verdict: "not-supported", needs: null },
        { id: "c3", shows: "No evidence is attached.", verdict: "cannot-tell", needs: "a load test" },
      ],
    }),
  );
  await w.briefs.checkerStopped("chk_1");
  const view = briefView(await w.briefs.get("child"));
  assert.equal(view.review.state, "checked");
  assert.deepEqual(view.review.disputes.map((entry) => [entry.claim.id, entry.dispute]), [["c2", "contradicted"]]);
  assert.deepEqual(view.review.claims.map((entry) => [entry.claim.id, entry.verdict?.verdict]), [["c1", "supported"], ["c3", "cannot-tell"]]);
  assert.deepEqual(w.discarded, ["chk_1"]);
  assert.deepEqual(await w.kv.list("check-run:"), []);
  assert.deepEqual([...(await w.briefs.marks(["child", "main"]))], [["child", { version: 1, state: "checked", contradicted: 1, notEstablished: 0, judgementCalls: 1, at: NOW, read: false }]]);
});

test("a malformed answer, a tool call, an error and silence are each a failed check, never a pass", async () => {
  const cases: [string, (w: ReturnType<typeof world>) => void, RegExp][] = [
    ["a tool", (w) => w.reply("chk_1", answerAll("supported"), ["Read"]), /used a tool \(Read\)/],
    ["an error", (w) => w.checkers.set("chk_1", { state: "error", reply: null, tools: [] }), /turn failed/],
    ["gone", (w) => w.checkers.delete("chk_1"), /thread is gone/],
    ["silence", (w) => (w.clock.now += CHECK_TIMEOUT_MS + 1), /did not answer in time/],
    ["idle with nothing said", (w) => (w.reply("chk_1", null), (w.clock.now += 60_000)), /gave no answer/],
  ];
  for (const [name, arrange, pattern] of cases) {
    const w = world();
    w.files.set("child/diff.txt", "ok");
    await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
    arrange(w);
    const view = briefView(await w.briefs.get("child"));
    assert.equal(view.review.state, "failed", name);
    assert.match(view.review.failures[0] ?? "", pattern, name);
    assert.deepEqual(view.review.disputes, [], name);
    assert.ok(view.review.claims.every((entry) => entry.verdict === null), name);
    assert.deepEqual(w.discarded, ["chk_1"], name);
  }
});

test("an answer that cannot be read is tried once more, and both the reason and what the checker said are kept", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  const slip = answerAll("supported").replace('"id":"c2"', '"id":"c2":""');
  w.reply("chk_1", slip);
  // The first answer is not valid JSON: the run is started again, and nothing is called failed yet.
  let view = briefView(await w.briefs.get("child"));
  assert.equal(view.review.state, "running");
  assert.equal(w.started.length, 2);
  assert.deepEqual(w.discarded, ["chk_1"]);
  assert.notEqual(w.started[1]!.prompt, "");
  assert.deepEqual([w.started[1]!.model, w.started[1]!.provider], [w.started[0]!.model, w.started[0]!.provider]);
  // The second answers well: the check stands on it.
  w.reply("chk_2", answerAll("supported"));
  view = briefView(await w.briefs.get("child"));
  assert.equal(view.review.state, "checked");
  assert.deepEqual(view.review.runs, { done: 1, failed: 0, running: 0 });

  // When the second is unreadable too, the check fails, and says what came back.
  const again = world();
  again.files.set("child/diff.txt", "ok");
  await again.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  again.reply("chk_1", "All three claims check out.");
  await again.briefs.get("child");
  again.reply("chk_2", slip);
  const failed = briefView(await again.briefs.get("child"));
  assert.equal(failed.review.state, "failed");
  assert.equal(again.started.length, 2);
  assert.deepEqual(failed.review.failed, [{ error: "the checker's answer is not valid JSON", answer: slip, retried: true }]);
  assert.deepEqual(again.discarded, ["chk_1", "chk_2"]);
  const text = reviewText({ threadId: "child", version: 1, summary: "s" }, failed.review);
  assert.match(text, /failed run \(the second try: the first answer could not be read either\): the checker's answer is not valid JSON/);
  assert.match(text, /what the checker answered \(\d+ characters\):\n    \| \{"claims"/);
  assert.ok(text.includes('"id":"c2":""'));
});

test("a checker that used a tool, failed or said nothing is not tried again", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", answerAll("supported"), ["Read"]);
  const view = briefView(await w.briefs.get("child"));
  assert.equal(view.review.state, "failed");
  assert.equal(w.started.length, 1);
  assert.equal(view.review.failed[0]!.retried, false);
  // What it said is kept all the same.
  assert.equal(view.review.failed[0]!.answer, answerAll("supported"));
});

test("reading a brief is recorded once, and a new check makes it unread again", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", answerAll("not-supported"));
  assert.equal(briefView(await w.briefs.get("child")).mark.read, false);
  w.clock.now += 5000;
  const read = await w.briefs.read("child", 1);
  assert.equal(read.readAt, w.clock.now);
  w.clock.now += 5000;
  assert.equal((await w.briefs.read("child", 1)).readAt, read.readAt);
  assert.equal(briefView(await w.briefs.get("child")).mark.read, true);
  await refused(w.briefs.read("child", 4), "brief_not_found");
  assert.equal((await w.briefs.read("child", 1, false)).readAt, null);
  await w.briefs.read("child", 1);
  const again = await w.briefs.check({ caller: "main", threadId: "child" });
  assert.equal(again.readAt, null);
  // A record stored before reads were kept is unread, not broken.
  const stored = (await w.kv.get<Record<string, unknown>>("brief:child:0001")) ?? {};
  delete stored.readAt;
  await w.kv.set("brief:child:0001", stored);
  assert.equal((await w.briefs.get("child")).readAt, null);
});

test("a checker that bb reports idle before its turn began is still running", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", null);
  assert.equal(briefView(await w.briefs.get("child")).review.state, "running");
  assert.deepEqual(w.discarded, []);
});

test("a check survives the services being made again, and is caught up on load", async () => {
  const kv = memoryKv();
  const before = world(kv);
  before.files.set("child/diff.txt", "ok");
  await before.briefs.submit({ caller: "child", threadId: null, raw: RAW });

  const after = world(kv);
  after.reply("chk_1", answerAll("supported"));
  await after.briefs.settleAll();
  const record = await world(kv).briefs.get("child");
  assert.equal(briefView(record).review.state, "checked");
  assert.deepEqual(after.discarded, ["chk_1"]);

  // A note about a checker whose check is over is dropped, not kept for ever.
  await kv.set("check-run:chk_old", { threadId: "child", version: 1 });
  await kv.set("check-run:chk_bad", "nonsense");
  await after.briefs.settleAll();
  assert.deepEqual(await kv.list("check-run:"), []);
});

test("resubmitting keeps versions; each has its own check", async () => {
  const w = world();
  w.files.set("child/diff.txt", "v1");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  w.reply("chk_1", answerAll("not-supported"));
  w.files.set("child/diff.txt", "v2");
  const second = await w.briefs.submit({ caller: "child", threadId: null, raw: { ...RAW, summary: "Second go." } });
  assert.equal(second.version, 2);
  assert.deepEqual(await w.briefs.versions("child"), [1, 2]);
  assert.equal((await w.briefs.get("child")).brief.summary, "Second go.");
  const first = await w.briefs.get("child", 1);
  assert.equal(first.brief.claims[1]?.evidence[0]?.text, "v1");
  assert.equal(briefView(first).mark.contradicted, 2);
  await refused(w.briefs.get("child", 7), "brief_not_found");
});

test("settings decide the model, the number of runs, and whether a submit is checked", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  Object.assign(w.settings, { model: "tiny", provider: "p", runs: 3, onSubmit: false });
  const stored = await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  assert.equal(stored.check, null);
  assert.equal(w.started.length, 0);
  assert.equal(briefView(stored).mark.state, "unchecked");

  const checking = await w.briefs.check({ caller: "main", threadId: "child" });
  assert.equal(checking.check?.runs.length, 3);
  assert.equal(checking.check?.model, "tiny");
  assert.deepEqual(w.started.map((start) => [start.model, start.provider]), [["tiny", "p"], ["tiny", "p"], ["tiny", "p"]]);
  // Every run gets the same prompt, and none sees another.
  assert.equal(new Set(w.started.map((start) => start.prompt)).size, 1);

  w.reply("chk_1", answerAll("supported"));
  w.reply("chk_2", answerAll("supported").replace('"c2","shows":"About c2.","verdict":"supported"', '"c2","shows":"About c2.","verdict":"not-supported"'));
  w.reply("chk_3", "no idea");
  // The unreadable one is tried once more, as chk_4, and fails for good when that is unreadable too.
  assert.deepEqual(briefView(await w.briefs.get("child")).review.runs, { done: 2, failed: 0, running: 1 });
  w.reply("chk_4", "still no idea");
  const view = briefView(await w.briefs.get("child"));
  assert.deepEqual(view.review.runs, { done: 2, failed: 1, running: 0 });
  assert.deepEqual(view.review.disputes.map((entry) => [entry.claim.id, entry.disagreement]), [["c2", ["supported", "not-supported"]]]);
});

test("a thread cannot order its own audit; the thread above it and the user can", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  w.settings.onSubmit = false;
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  await refused(w.briefs.check({ caller: "child", threadId: "child" }), "own_audit");
  await refused(w.briefs.check({ caller: "other", threadId: "child" }), "not_your_thread");
  await refused(w.briefs.check({ caller: null, threadId: "main" }), "brief_not_found");
  await refused(w.briefs.check({ caller: null, threadId: "child", runs: 9 }), "bad_runs");
  const byUser = await w.briefs.check({ caller: null, threadId: "child", model: "big", runs: 1 });
  assert.equal(byUser.check?.model, "big");
  await refused(w.briefs.check({ caller: "main", threadId: "child" }), "check_running");
  w.reply("chk_1", answerAll("supported"));
  const again = await w.briefs.check({ caller: "main", threadId: "child" });
  assert.equal(again.earlierChecks, 1);
  assert.equal(again.check?.runs[0]?.threadId, "chk_2");
});

test("a checker that cannot be started is a failed run", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  const kv = w.kv;
  const broken = world(kv);
  broken.files.set("child/diff.txt", "ok");
  broken.settings.onSubmit = false;
  await broken.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  // Stand in a checker that refuses to start.
  const { createBriefs } = await import("../src/briefs/service.ts");
  const failing = createBriefs({
    kv,
    now: () => NOW,
    newId: () => "n",
    thread: async () => ({ projectId: "proj_1", environmentId: null }),
    execution: async () => ({ provider: "codex", model: null }),
    ancestors: async () => ["main"],
    storageRoot: async () => null,
    readEvidence: async () => "",
    hasAsk: async () => false,
    settings: async () => ({ model: null, provider: null, runs: 1, onSubmit: true }),
    checker: { start: async () => Promise.reject(new Error("no such model")), look: async () => ({ state: "gone", reply: null, tools: [] }), discard: async () => undefined },
    changed: () => undefined,
  });
  const record = await failing.check({ caller: "main", threadId: "child" });
  const view = briefView(record);
  assert.equal(view.review.state, "failed");
  assert.match(view.review.failures[0] ?? "", /could not be started on codex, its default model: no such model\. To check it on another provider: bb cow brief check child --provider <provider> --model <model>$/);
});

test("running a check again cannot take a dispute the person has not read out of their queue", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  await w.briefs.submit({ caller: "child", threadId: null, raw: { ...RAW, judgementCalls: [] } });
  w.reply("chk_1", answerAll("not-supported"));
  const disputed = briefView(await w.briefs.get("child")).mark;
  const count = disputed.contradicted + disputed.notEstablished;
  assert.ok(count > 0 && briefWaits(disputed));
  // Anyone can order a check, with any model: here one that cannot answer.
  await w.briefs.check({ caller: null, threadId: "child", model: "no-such-model" });
  const running = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([running.state, running.earlierDisputes, briefWaits(running)], ["running", count, true]);
  w.checkers.set("chk_2", { state: "error", reply: null, tools: [] });
  await w.briefs.checkerStopped("chk_2");
  const failed = briefView(await w.briefs.get("child"));
  assert.deepEqual([failed.mark.state, failed.mark.contradicted + failed.mark.notEstablished, failed.mark.earlierDisputes], ["failed", 0, count]);
  assert.equal(briefWaits(failed.mark), true);
  assert.match(briefWaitText(failed.mark), /disputed by an earlier check that was run again unread/);
  // Nor does a check that comes back clean, however many times it is run.
  await w.briefs.check({ caller: "main", threadId: "child" });
  w.reply("chk_3", answerAll("supported"));
  const clean = briefView(await w.briefs.get("child"));
  assert.deepEqual([clean.mark.state, clean.mark.contradicted + clean.mark.notEstablished, clean.mark.earlierDisputes, briefWaits(clean.mark)], ["checked", 0, count, true]);
  assert.match(reviewText({ threadId: "child", version: 1, summary: "s", earlierDisputes: clean.record.earlierDisputes }, clean.review), /NOTE: an earlier check of this version disputed/);
  // The person opening it is what ends the wait; a check they order after that starts from nothing.
  await w.briefs.read("child", 1);
  assert.equal(briefWaits(briefView(await w.briefs.get("child")).mark), false);
  await w.briefs.check({ caller: null, threadId: "child" });
  w.reply("chk_4", answerAll("supported"));
  const after = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([after.earlierDisputes, briefWaits(after)], [undefined, false]);
});

test("a judgement call waits through a check that is run again, though not through the first check", async () => {
  const w = world();
  w.files.set("child/diff.txt", "ok");
  await w.briefs.submit({ caller: "child", threadId: null, raw: RAW });
  // The first check is still running: the brief waits for its verdicts.
  const first = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([first.state, first.rechecked, briefWaits(first)], ["running", undefined, false]);
  w.reply("chk_1", answerAll("supported"));
  const checked = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([checked.state, checked.judgementCalls, briefWaits(checked)], ["checked", 1, true]);
  // Ordered again by anyone, the running check does not take the judgement call out of the queue.
  await w.briefs.check({ caller: null, threadId: "child" });
  const again = briefView(await w.briefs.get("child")).mark;
  assert.deepEqual([again.state, again.rechecked, briefWaits(again)], ["running", true, true]);
});
