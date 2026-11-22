import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createLogStore } from "../src/caps/logstore.ts";
import { type CliActions, cowCli } from "../src/cli.ts";
import { Refusal } from "../src/kv.ts";
import { type LimitsDeps, createLimits } from "../src/limits-backend.ts";
import {
  NO_RAISED,
  type Raised,
  type TotalLine,
  type UsageWindow,
  budgetOf,
  budgetSetting,
  decide,
  raisedOf,
  totalText,
  usageLineText,
  windowsOf,
} from "../src/limits.ts";
import { type Dispatch, runSigned, sha256Hex, verifyP256 } from "../src/signing/backend.ts";
import { type Envelope, type PublicKey, fingerprintText, formatFingerprint, signedText } from "../src/signing/envelope.ts";
import { createKeys } from "../src/signing/keys.ts";
import { memoryKv } from "./memory.ts";

// bb's usage response, in the shape `bb settings usage --json` gives it: one
// provider signed in with two windows, the others not. The account fields
// are placeholders.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date(2026, 10, 21, 18, 0).getTime();
const RESETS = NOW + 19 * HOUR;
const response = (weekly: number, fable: number, resetsAt = RESETS) => ({
  codex: { status: "expired" },
  "claude-code": {
    status: "ok",
    accountEmail: "someone@example.invalid",
    planLabel: "Max",
    windows: [
      { label: "Weekly limit", usedPercent: weekly, resetsAt: new Date(resetsAt).toISOString(), kind: "weekly" },
      { label: "Fable", usedPercent: fable, resetsAt: new Date(resetsAt).toISOString(), kind: "weekly", model: "fable" },
    ],
  },
  "acp-cursor": { status: "not_installed" },
  gemini: { status: "unauthenticated" },
  other: { status: "error", message: "the provider did not answer" },
  quiet: { status: "ok", accountEmail: null, planLabel: null, windows: [] },
});

test("two windows of a signed-in provider are read; a provider not signed in, in error or with no windows is left out", () => {
  const windows = windowsOf(response(47, 54));
  assert.deepEqual(
    windows.map((w) => [w.provider, w.label, w.usedPercent, w.resetsAt, w.kind, w.model]),
    [
      ["claude-code", "Weekly limit", 47, RESETS, "weekly", null],
      ["claude-code", "Fable", 54, RESETS, "weekly", "fable"],
    ],
  );
  const line = usageLineText(windows, null, NOW);
  assert.equal(line, "Claude Code Weekly limit 47%, resets in 19h (Sun 22 Nov 13:00) · Claude Code Fable 54%, resets in 19h (Sun 22 Nov 13:00)");
  for (const left of ["codex", "Codex", "cursor", "gemini", "other", "quiet", "error", "example.invalid"]) assert.ok(!line.includes(left), left);
  assert.deepEqual(windowsOf(null), []);
  assert.deepEqual(windowsOf({ x: { status: "ok", windows: [{ label: "no percent" }] } }), []);
});

const total = (dollars: number | null, budget: number | null): TotalLine => ({ first: "2026-10-23", last: "2026-11-21", dollars, noUsage: 0, unpricedTokens: 0, budget });
const NAMES = /pace|month|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/;

test("the line gives the last 30 days' dollars, and with a budget the budget beside them; never a pace or a month's name", () => {
  const none = totalText(total(653.07, null));
  assert.equal(none, "last 30 days $653.07 at list price");
  assert.ok(!/budget/.test(none));
  const set = totalText(total(653.07, 1000));
  assert.equal(set, "last 30 days $653.07 at list price of $1000.00 budget");
  assert.equal(totalText(total(null, 1000)), "last 30 days: no list-priced usage of $1000.00 budget");
  for (const line of [none, set]) assert.ok(!NAMES.test(line), line);
  assert.match(usageLineText(windowsOf(response(47, 54)), total(43.03, null), NOW), /Fable 54%.* · last 30 days \$43\.03 at list price$/);
});

test("the budget setting: dollars, empty for none, and anything else said", () => {
  assert.deepEqual(budgetOf(""), { budget: null, error: null });
  assert.deepEqual(budgetOf(" $1,200 "), { budget: 1200, error: null });
  assert.deepEqual(budgetOf("500"), { budget: 500, error: null });
  assert.equal(budgetOf("lots").budget, null);
  assert.match(budgetOf("lots").error ?? "", /not a number of dollars/);
  assert.equal(budgetOf("-3").budget, null);
});

test("budget30Days is the budget; monthlyBudget, which it was renamed from, counts only when it is empty; a bad value is said", () => {
  assert.deepEqual(budgetSetting("700", ""), { budget: 700, error: null });
  assert.deepEqual(budgetSetting("", "500"), { budget: 500, error: null });
  assert.deepEqual(budgetSetting(undefined, "500"), { budget: 500, error: null });
  assert.deepEqual(budgetSetting("700", "500"), { budget: 700, error: null });
  assert.deepEqual(budgetSetting("", ""), { budget: null, error: null });
  assert.match(budgetSetting("lots", "500").error ?? "", /^the budget for 30 days "lots" is not a number of dollars: no budget is applied$/);
  assert.equal(budgetSetting("lots", "500").budget, null);
  assert.match(budgetSetting("", "lots").error ?? "", /set as monthlyBudget.*not a number of dollars/);
});

const twoWindows = (weekly: number, fable: number, resetsAt = RESETS): UsageWindow[] => windowsOf(response(weekly, fable, resetsAt));

test("a window reaching its percent raises one notice; again in the same period none; after the reset, a new one can", () => {
  let raised = NO_RAISED;
  const step = (windows: UsageWindow[], at: number) => {
    const got = decide(raised, { windows, windowPercent: 80, total: null }, at);
    raised = got.raised;
    return got.drafts;
  };
  assert.deepEqual(step(twoWindows(47, 79), NOW), []);
  const first = step(twoWindows(47, 81), NOW + MINUTE);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.rule, "window");
  assert.match(first[0]!.text, /^Claude Code Fable is at 81% of its window \(told at 80%\); it resets in 18h 59m \(Sun 22 Nov 13:00\)\.$/);
  // Checked again in the same period, higher still, and with a reset time read a little differently: nothing.
  assert.deepEqual(step(twoWindows(47, 95, RESETS + 300), NOW + HOUR), []);
  assert.deepEqual(step(twoWindows(47, 99), NOW + 18 * HOUR), []);
  // After the reset time, bb reports the window's next period: below, then above again.
  const next = RESETS + 7 * 24 * HOUR;
  assert.deepEqual(step(twoWindows(10, 5, next), RESETS + MINUTE), []);
  const again = step(twoWindows(10, 85, next), RESETS + 2 * HOUR);
  assert.equal(again.length, 1);
  assert.match(again[0]!.text, /Fable.* 85%/);
  // Both windows at once: one each.
  assert.equal(decide(NO_RAISED, { windows: twoWindows(90, 90), windowPercent: 80, total: null }, NOW).drafts.length, 2);
});

test("a window past its reset time is stale and raises nothing; one with no reset time raises again only after it was seen below", () => {
  assert.deepEqual(decide(NO_RAISED, { windows: twoWindows(99, 99, NOW - MINUTE), windowPercent: 80, total: null }, NOW).drafts, []);
  const open: UsageWindow = { provider: "codex", label: "Credits", usedPercent: 90, resetsAt: null, kind: null, model: null };
  let got = decide(NO_RAISED, { windows: [open], windowPercent: 80, total: null }, NOW);
  assert.equal(got.drafts.length, 1);
  assert.match(got.drafts[0]!.text, /reset time not given/);
  got = decide(got.raised, { windows: [open], windowPercent: 80, total: null }, NOW + HOUR);
  assert.equal(got.drafts.length, 0);
  got = decide(got.raised, { windows: [{ ...open, usedPercent: 20 }], windowPercent: 80, total: null }, NOW + 2 * HOUR);
  got = decide(got.raised, { windows: [open], windowPercent: 80, total: null }, NOW + 3 * HOUR);
  assert.equal(got.drafts.length, 1);
});

test("each budget rule raises once on reaching its threshold, none while the total stays above, and again only after falling below", () => {
  let raised: Raised = NO_RAISED;
  let at = NOW;
  const step = (dollars: number) => {
    at += HOUR;
    const got = decide(raised, { windows: [], windowPercent: 80, total: total(dollars, 500) }, at);
    raised = got.raised;
    return got.drafts.map((draft) => draft.rule);
  };
  assert.deepEqual(step(100), []);
  assert.deepEqual(step(399), []);
  assert.deepEqual(step(400), ["spent"], "rising through 80%");
  assert.deepEqual(step(450), [], "staying above");
  assert.deepEqual(step(420), []);
  assert.deepEqual(step(399.99), [], "falling below");
  assert.deepEqual(step(410), ["spent"], "rising to it again");
  assert.deepEqual(step(500), ["budget"], "reaching the budget");
  assert.deepEqual(step(600), []);
  assert.deepEqual(step(499), [], "below the budget, still above 80%");
  assert.deepEqual(step(520), ["budget"], "the budget again");
  assert.deepEqual(step(100), [], "far below both");
  assert.deepEqual(step(900), ["spent", "budget"], "through both at once");
  assert.deepEqual(step(900), []);
  // No budget, or no priced usage: no rule, and what was raised is kept.
  assert.deepEqual(decide(NO_RAISED, { windows: [], windowPercent: 80, total: total(10_000, null) }, NOW).drafts, []);
  assert.deepEqual(decide(NO_RAISED, { windows: [], windowPercent: 80, total: total(null, 5) }, NOW).drafts, []);
  assert.deepEqual(decide(raised, { windows: [], windowPercent: 80, total: total(1, null) }, NOW).raised, raised);
  const [spent, budget] = decide(NO_RAISED, { windows: [], windowPercent: 80, total: total(500, 500) }, NOW).drafts;
  assert.equal(spent!.text, "The last 30 days' list-price dollars are $500.00, 100% of the $500.00 budget for 30 days (told at 80%). Nothing is stopped.");
  assert.equal(budget!.text, "The last 30 days' list-price dollars are $500.00, at or over the $500.00 budget for 30 days. Nothing is stopped.");
  for (const draft of [spent!, budget!]) assert.ok(!/pace|month/.test(draft.text), draft.text);
});

test("a record of what was raised in 0.2.20's shape is read without error: this month's 80% notice counts as raised, the pace and earlier months are dropped", () => {
  const windows = { "claude-code|weekly||Weekly limit": { resetsAt: RESETS, at: NOW } };
  const old = raisedOf({ windows, rules: { spent: "2026-11", pace: "2026-11" } }, NOW);
  assert.deepEqual(old, { windows, rules: { spent: NOW } });
  // Still above 80%: no second notice. Reaching the budget is new.
  assert.deepEqual(decide(old, { windows: [], windowPercent: 80, total: total(450, 500) }, NOW).drafts, []);
  assert.deepEqual(decide(old, { windows: [], windowPercent: 80, total: total(550, 500) }, NOW).drafts.map((d) => d.rule), ["budget"]);
  assert.deepEqual(raisedOf({ windows: {}, rules: { spent: "2026-10", pace: "2026-10" } }, NOW), { windows: {}, rules: {} });
  assert.deepEqual(raisedOf({ windows: {}, rules: { spent: 5, budget: 6 } }, NOW), { windows: {}, rules: { spent: 5, budget: 6 } });
});

/** The server's part, over storage that lives in the test, with a clock. */
function world(opts: { budget?: string; monthlyBudget?: string; notify?: boolean; failNotify?: boolean } = {}) {
  const kv = memoryKv();
  const clock = { now: NOW };
  const bb = { response: response(47, 54) as unknown, dollars: 43.03 as number | null };
  const sent: { title: string; body: string }[] = [];
  const warned: string[] = [];
  let ids = 0;
  let changes = 0;
  const log = createLogStore({ kv, now: () => clock.now, hash: sha256Hex });
  const deps: LimitsDeps = {
    kv,
    now: () => clock.now,
    newId: () => `n${(ids += 1)}`,
    usageLimits: async () => bb.response,
    total: async () => ({ period: { kind: "last30Days", month: null, first: "2026-10-23", last: "2026-11-21" }, threads: 3, noUsage: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, dollars: bb.dollars, unpricedTokens: 0, unpricedModels: [], deleted: 0, fromLedger: 0, priceError: null }),
    settings: async () => ({ budget30Days: opts.budget ?? "", monthlyBudget: opts.monthlyBudget ?? "", windowPercent: 80, notify: opts.notify ?? true }),
    notify: async (title, body) => {
      if (opts.failNotify) throw new Error("no plugin push-notifications");
      sent.push({ title, body });
    },
    log,
    changed: () => void (changes += 1),
    warn: (text) => void warned.push(text),
  };
  const limits = createLimits(deps);
  return { kv, clock, bb, sent, warned, log, limits, changes: () => changes };
}

test("the server's check: a window passing its percent raises exactly one notice and one notification; checking again raises none", async () => {
  const w = world();
  assert.deepEqual((await w.limits.check()).raised, []);
  w.bb.response = response(47, 82);
  w.clock.now += 5 * MINUTE;
  const first = await w.limits.check();
  assert.equal(first.raised.length, 1);
  assert.equal(first.report.notices.length, 1);
  assert.deepEqual(w.sent.map((s) => s.title), ["🐄 cow: usage"]);
  assert.equal(w.sent[0]!.body, first.raised[0]!.text);
  for (let i = 0; i < 5; i += 1) {
    w.clock.now += 5 * MINUTE;
    w.bb.response = response(47, 85 + i);
    assert.deepEqual((await w.limits.check()).raised, []);
  }
  assert.equal((await w.limits.notices()).length, 1);
  assert.equal(w.sent.length, 1);
  // After the reset time, the next period's window can raise one again; the one not acknowledged gives way to it.
  w.clock.now = RESETS + MINUTE;
  w.bb.response = response(3, 90, RESETS + 7 * 24 * HOUR);
  const again = await w.limits.check();
  assert.equal(again.raised.length, 1);
  assert.deepEqual((await w.limits.notices()).map((n) => n.id), [again.raised[0]!.id]);
});

test("acknowledged, a notice is gone, logged under the key that signed, and does not come back in the period", async () => {
  const w = world();
  w.bb.response = response(81, 20);
  const [notice] = (await w.limits.check()).raised;
  const gone = await w.limits.acknowledge(notice!.id, "abcd-ef01-2345-6789");
  assert.equal(gone.id, notice!.id);
  assert.deepEqual(await w.limits.notices(), []);
  const entry = (await w.log.all()).at(-1)!;
  assert.equal(entry.event.kind, "acknowledged");
  assert.equal(entry.by, "abcd-ef01-2345-6789");
  w.clock.now += HOUR;
  assert.deepEqual((await w.limits.check()).raised, []);
  assert.deepEqual(await w.limits.notices(), []);
  await assert.rejects(w.limits.acknowledge(notice!.id, "abcd-ef01-2345-6789"), (cause: unknown) => cause instanceof Refusal && cause.code === "notice_not_found");
  await assert.rejects(w.limits.acknowledge("note_1", "x"), (cause: unknown) => cause instanceof Refusal && cause.code === "notice_not_found");
});

test("the budget rules on the server: once each; with notifications off, or with none to be had, the notice is still raised", async () => {
  const w = world({ budget: "50", notify: false });
  w.bb.response = {};
  w.bb.dollars = 41;
  const got = await w.limits.check();
  assert.deepEqual(got.raised.map((n) => n.rule), ["spent"]);
  assert.equal(got.report.total?.budget, 50);
  assert.equal(w.sent.length, 0);
  w.clock.now += 2 * HOUR;
  w.bb.dollars = 49;
  assert.deepEqual((await w.limits.check()).raised, []);
  w.clock.now += 2 * HOUR;
  w.bb.dollars = 50;
  assert.deepEqual((await w.limits.check()).raised.map((n) => n.rule), ["budget"]);
  const failing = world({ budget: "50", failNotify: true });
  failing.bb.response = {};
  failing.bb.dollars = 45;
  assert.equal((await failing.limits.check()).raised.length, 1);
  assert.match(failing.warned[0] ?? "", /could not send a notification/);
});

test("the server reads a record and a notice kept by 0.2.20 without error and without a duplicate", async () => {
  const w = world({ budget: "50" });
  w.bb.response = {};
  w.bb.dollars = 45;
  await w.kv.set("limits-raised", { windows: {}, rules: { spent: "2026-11", pace: "2026-11" } });
  await w.kv.set("limit-notice:limit_old1", { id: "limit_old1", rule: "pace", key: "pace:2026-11", text: "At this month's pace …", at: NOW - HOUR });
  const got = await w.limits.check();
  assert.deepEqual(got.raised, [], "80% was raised this month already");
  assert.deepEqual((await w.limits.notices()).map((n) => n.id), ["limit_old1"], "the old notice is still there to acknowledge");
  assert.deepEqual(await w.kv.get("limits-raised"), { windows: {}, rules: { spent: NOW } }, "rewritten in today's shape");
  await w.limits.acknowledge("limit_old1", "abcd-ef01-2345-6789");
  assert.deepEqual(await w.limits.notices(), []);
  // A monthly 80% notice from an earlier month, not acknowledged, gives way to the new one.
  const v = world({ budget: "50" });
  v.bb.response = {};
  v.bb.dollars = 45;
  await v.kv.set("limits-raised", { windows: {}, rules: { spent: "2026-10" } });
  await v.kv.set("limit-notice:limit_old2", { id: "limit_old2", rule: "spent", key: "spent:2026-10", text: "This month's …", at: NOW - 30 * 24 * HOUR });
  const raised = (await v.limits.check()).raised;
  assert.deepEqual(raised.map((n) => n.rule), ["spent"]);
  assert.deepEqual((await v.limits.notices()).map((n) => n.id), [raised[0]!.id]);
});

test("monthlyBudget set alone is the budget on the server's line; with budget30Days set too, budget30Days wins", async () => {
  const alone = world({ monthlyBudget: "300" });
  assert.equal((await alone.limits.report(true)).total?.budget, 300);
  const both = world({ budget: "700", monthlyBudget: "300" });
  assert.equal((await both.limits.report(true)).total?.budget, 700);
});

test("the report says what could not be read, and still gives the rest", async () => {
  const w = world({ budget: "lots" });
  w.bb.response = response(10, 10);
  const report = await w.limits.report(true);
  assert.equal(report.windows.length, 2);
  assert.equal(report.total?.budget, null);
  assert.match(report.errors.join(" "), /not a number of dollars/);
});

test("bb cow usage prints the line, each window and the last 30 days, or JSON; a provider not signed in is not in it", async () => {
  const w = world({ budget: "500" });
  w.bb.response = response(47, 81);
  await w.limits.check();
  const unused = async () => {
    throw new Error("not used");
  };
  const actions: CliActions = { archiveChecked: unused, parkChecked: unused, resumeChecked: unused, status: unused, nextChecked: unused, todoChecked: unused, projectChecked: unused, waitChecked: unused, usage: () => w.limits.report(true) };
  const cli = cowCli(actions);
  const run = async (args: string[]) => ({ stdout: (await cli.run(["usage", ...args], { projectId: "proj_1", threadId: undefined, signal: new AbortController().signal })).stdout ?? "" });
  const text = (await run([])).stdout;
  assert.match(text, /^Claude Code Weekly limit 47%, resets in 19h \(Sun 22 Nov 13:00\) · Claude Code Fable 81%, resets in 19h \(Sun 22 Nov 13:00\) · last 30 days \$43\.03 at list price of \$500\.00 budget\n/);
  assert.match(text, /2026-10-23 to 2026-11-21: today and the 29 days before it/);
  assert.ok(!/pace|Pace|November|Nov so far|month/.test(text), text);
  assert.match(text, /Usage notices waiting for the person \(acknowledged on the page\): 1\n  Claude Code Fable is at 81%/);
  assert.ok(!/codex|Codex|example\.invalid/.test(text));
  const json = JSON.parse((await run(["--json"])).stdout);
  assert.equal(json.ok, true);
  assert.deepEqual(json.windows.map((x: UsageWindow) => [x.label, x.usedPercent, x.resetsAt]), [["Weekly limit", 47, new Date(RESETS).toISOString()], ["Fable", 81, new Date(RESETS).toISOString()]]);
  assert.equal(json.total.budget, 500);
  assert.equal(json.total.first, "2026-10-23");
  const bare = world();
  const plain = (await cowCli({ ...actions, usage: () => bare.limits.report(true) }).run(["usage"], { projectId: "proj_1", threadId: undefined, signal: new AbortController().signal })).stdout ?? "";
  assert.match(plain, / · last 30 days \$43\.03 at list price\n/);
  assert.match(plain, /No budget is set \(the budget30Days setting\)/);
  assert.ok(!/pace|Pace|Nov so far|month/.test(plain), plain);
  assert.equal(json.notices.length, 1);
});

/** A page's key, made and used the way a browser does. */
async function pageKey() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const key: PublicKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  const fingerprint = formatFingerprint(sha256Hex(fingerprintText(key)));
  const sign = async (action: string, args: unknown, at: number, nonce: string): Promise<Envelope> => {
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signedText({ action, args, at, nonce })));
    return { action, args, at, nonce, key: fingerprint, sig: Buffer.from(sig).toString("base64url") };
  };
  return { key, fingerprint, sign };
}

test("acknowledging a usage notice is a signed call: an unsigned one is refused and the notice stays", async () => {
  const w = world();
  w.bb.response = response(90, 10);
  const [notice] = (await w.limits.check()).raised;
  const keys = createKeys({ kv: w.kv, now: () => w.clock.now, hash: sha256Hex, verify: verifyP256, log: w.log, resetPath: "/data/reset", takeResetFile: async () => false, changed: () => undefined });
  const dispatch = { limit_ack: async (args: { noticeId: string }, by: string) => (await w.limits.acknowledge(args.noticeId, by), null) } as unknown as Dispatch;
  const call = (envelope: unknown) => runSigned(keys, dispatch, envelope);
  const page = await pageKey();
  await keys.enrol(page.key, "Chrome");
  const refusedAs = (code: string) => (cause: unknown) => cause instanceof Refusal && cause.code === code;
  await assert.rejects(call({ action: "limit_ack", args: { noticeId: notice!.id } }), refusedAs("unsigned"));
  const other = await pageKey();
  await assert.rejects(call(await other.sign("limit_ack", { noticeId: notice!.id }, w.clock.now, "nonce-other-0001")), refusedAs("unknown_key"));
  assert.equal((await w.limits.notices()).length, 1);
  assert.equal(await call(await page.sign("limit_ack", { noticeId: notice!.id }, w.clock.now, "nonce-page-00001")), null);
  assert.deepEqual(await w.limits.notices(), []);
  assert.equal((await w.log.all()).at(-1)?.by, page.fingerprint);
});
