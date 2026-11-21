import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createLogStore } from "../src/caps/logstore.ts";
import { type CliActions, cowCli } from "../src/cli.ts";
import { Refusal } from "../src/kv.ts";
import { type LimitsDeps, createLimits } from "../src/limits-backend.ts";
import {
  NO_RAISED,
  PACE_FROM_DAY,
  type MonthLine,
  type UsageWindow,
  budgetOf,
  decide,
  monthEnd,
  monthText,
  paceOf,
  usageLineText,
  windowsOf,
} from "../src/limits.ts";
import { type Dispatch, runSigned, sha256Hex, verifyP256 } from "../src/signing/backend.ts";
import { type Envelope, type PublicKey, fingerprintText, formatFingerprint, signedText } from "../src/signing/envelope.ts";
import { createKeys } from "../src/signing/keys.ts";
import { monthStart } from "../src/usage.ts";
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

const month = (dollars: number | null, budget: number | null, at = NOW): MonthLine => ({ month: "2026-11", dollars, noUsage: 0, unpricedTokens: 0, budget, pace: dollars === null ? null : paceOf(dollars, "2026-11", at) });

test("with no budget the line gives the month's dollars and nothing of a budget; with one, the budget and the pace", () => {
  const none = monthText(month(43.03, null));
  assert.equal(none, "Nov so far $43.03 at list price");
  assert.ok(!/budget|pace/.test(none));
  const set = monthText(month(43.03, 500));
  assert.match(set, /^Nov so far \$43\.03 at list price of \$500(\.00)? budget · pace \$[0-9.]+ by month end$/);
  assert.match(usageLineText(windowsOf(response(47, 54)), month(43.03, null), NOW), /Fable 54%.* · Nov so far \$43\.03 at list price$/);
});

test("the pace is the dollars so far divided by the fraction of the month gone, and none before the third day", () => {
  // June has 30 days and no change of clocks: at the start of the 16th, half of it is gone.
  assert.equal(paceOf(100, "2026-06", new Date(2026, 5, 16).getTime()), 200);
  const at = NOW;
  const gone = (at - monthStart("2026-11")) / (monthEnd("2026-11") - monthStart("2026-11"));
  assert.equal(paceOf(43.03, "2026-11", at), 43.03 / gone);
  assert.equal(paceOf(10, "2026-11", new Date(2026, 10, 2, 23, 59).getTime()), null, "the 2nd");
  assert.equal(paceOf(10, "2026-06", new Date(2026, 5, PACE_FROM_DAY).getTime()), 10 / (2 / 30), "from the 3rd");
  assert.equal(monthEnd("2026-12"), new Date(2027, 0, 1).getTime());
  assert.match(monthText(month(5, 500, new Date(2026, 10, 1, 9).getTime())), /pace from the 3rd$/);
});

test("the budget setting: dollars, empty for none, and anything else said", () => {
  assert.deepEqual(budgetOf(""), { budget: null, error: null });
  assert.deepEqual(budgetOf(" $1,200 "), { budget: 1200, error: null });
  assert.deepEqual(budgetOf("500"), { budget: 500, error: null });
  assert.equal(budgetOf("lots").budget, null);
  assert.match(budgetOf("lots").error ?? "", /not a number of dollars/);
  assert.equal(budgetOf("-3").budget, null);
});

const twoWindows = (weekly: number, fable: number, resetsAt = RESETS): UsageWindow[] => windowsOf(response(weekly, fable, resetsAt));

test("a window reaching its percent raises one notice; again in the same period none; after the reset, a new one can", () => {
  let raised = NO_RAISED;
  const step = (windows: UsageWindow[], at: number) => {
    const got = decide(raised, { windows, windowPercent: 80, month: null }, at);
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
  assert.equal(decide(NO_RAISED, { windows: twoWindows(90, 90), windowPercent: 80, month: null }, NOW).drafts.length, 2);
});

test("a window past its reset time is stale and raises nothing; one with no reset time raises again only after it was seen below", () => {
  assert.deepEqual(decide(NO_RAISED, { windows: twoWindows(99, 99, NOW - MINUTE), windowPercent: 80, month: null }, NOW).drafts, []);
  const open: UsageWindow = { provider: "codex", label: "Credits", usedPercent: 90, resetsAt: null, kind: null, model: null };
  let got = decide(NO_RAISED, { windows: [open], windowPercent: 80, month: null }, NOW);
  assert.equal(got.drafts.length, 1);
  assert.match(got.drafts[0]!.text, /reset time not given/);
  got = decide(got.raised, { windows: [open], windowPercent: 80, month: null }, NOW + HOUR);
  assert.equal(got.drafts.length, 0);
  got = decide(got.raised, { windows: [{ ...open, usedPercent: 20 }], windowPercent: 80, month: null }, NOW + 2 * HOUR);
  got = decide(got.raised, { windows: [open], windowPercent: 80, month: null }, NOW + 3 * HOUR);
  assert.equal(got.drafts.length, 1);
});

test("each budget rule raises once a month: the dollars reaching 80% of the budget, and the pace going over it", () => {
  let raised = NO_RAISED;
  const step = (m: MonthLine, at: number) => {
    const got = decide(raised, { windows: [], windowPercent: 80, month: m }, at);
    raised = got.raised;
    return got.drafts.map((draft) => draft.rule);
  };
  const early = new Date(2026, 10, 10).getTime();
  // 9 of 30 days gone: $100 is a pace of $333, under a $500 budget.
  assert.deepEqual(step(month(100, 500, early), early), []);
  // $200 on the 10th: a pace of $667, over it.
  assert.deepEqual(step(month(200, 500, early), early), ["pace"]);
  assert.deepEqual(step(month(300, 500, early + HOUR), early + HOUR), []);
  const late = new Date(2026, 10, 25).getTime();
  assert.deepEqual(step(month(400, 500, late), late), ["spent"]);
  assert.deepEqual(step(month(480, 500, late + HOUR), late + HOUR), []);
  // A new month: each can be raised again.
  const december = new Date(2026, 11, 20).getTime();
  const dec: MonthLine = { month: "2026-12", dollars: 450, noUsage: 0, unpricedTokens: 0, budget: 500, pace: paceOf(450, "2026-12", december) };
  assert.deepEqual(step(dec, december), ["spent", "pace"]);
  assert.deepEqual(step(dec, december + HOUR), []);
  // No budget, or no priced usage: no rule.
  assert.deepEqual(decide(NO_RAISED, { windows: [], windowPercent: 80, month: month(10_000, null, late) }, late).drafts, []);
  assert.deepEqual(decide(NO_RAISED, { windows: [], windowPercent: 80, month: month(null, 5, late) }, late).drafts, []);
  const spent = decide(NO_RAISED, { windows: [], windowPercent: 80, month: month(400, 500, late) }, late).drafts[0]!;
  assert.equal(spent.text, "This month's list-price dollars are $400.00, 80% of the $500.00 monthly budget (told at 80%). Nothing is stopped.");
  const pace = decide(NO_RAISED, { windows: [], windowPercent: 80, month: month(200, 500, early) }, early).drafts[0]!;
  assert.match(pace.text, /^At this month's pace, \$66[0-9]\.[0-9]{2} by the month's end, over the \$500\.00 monthly budget: \$200\.00 so far with 30% of the month gone\. Nothing is stopped\.$/);
});

/** The server's part, over storage that lives in the test, with a clock. */
function world(opts: { budget?: string; notify?: boolean; failNotify?: boolean } = {}) {
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
    month: async () => ({ threads: 3, noUsage: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, dollars: bb.dollars, unpricedTokens: 0, unpricedModels: [], priceError: null }),
    settings: async () => ({ monthlyBudget: opts.budget ?? "", windowPercent: 80, notify: opts.notify ?? true }),
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

test("the budget rules on the server: once each a month; with notifications off, or with none to be had, the notice is still raised", async () => {
  const w = world({ budget: "50", notify: false });
  w.clock.now = new Date(2026, 10, 25).getTime();
  w.bb.response = {};
  w.bb.dollars = 41;
  const got = await w.limits.check();
  assert.deepEqual(got.raised.map((n) => n.rule).sort(), ["pace", "spent"]);
  assert.equal(got.report.month?.budget, 50);
  assert.equal(w.sent.length, 0);
  w.clock.now += 2 * HOUR;
  w.bb.dollars = 49;
  assert.deepEqual((await w.limits.check()).raised, []);
  const failing = world({ budget: "50", failNotify: true });
  failing.clock.now = w.clock.now;
  failing.bb.response = {};
  failing.bb.dollars = 45;
  assert.equal((await failing.limits.check()).raised.length, 2);
  assert.match(failing.warned[0] ?? "", /could not send a notification/);
});

test("the report says what could not be read, and still gives the rest", async () => {
  const w = world({ budget: "lots" });
  w.bb.response = response(10, 10);
  const report = await w.limits.report(true);
  assert.equal(report.windows.length, 2);
  assert.equal(report.month?.budget, null);
  assert.match(report.errors.join(" "), /not a number of dollars/);
});

test("bb cow usage prints the line, each window and the month, or JSON; a provider not signed in is not in it", async () => {
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
  assert.match(text, /^Claude Code Weekly limit 47%, resets in 19h \(Sun 22 Nov 13:00\) · Claude Code Fable 81%, resets in 19h \(Sun 22 Nov 13:00\) · Nov so far \$43\.03 at list price of \$500(\.00)? budget · pace \$[0-9.]+ by month end\n/);
  assert.match(text, /Pace: the dollars so far divided by the fraction of the month gone, from the 3rd day of the month\./);
  assert.match(text, /Usage notices waiting for the person \(acknowledged on the page\): 1\n  Claude Code Fable is at 81%/);
  assert.ok(!/codex|Codex|example\.invalid/.test(text));
  const json = JSON.parse((await run(["--json"])).stdout);
  assert.equal(json.ok, true);
  assert.deepEqual(json.windows.map((x: UsageWindow) => [x.label, x.usedPercent, x.resetsAt]), [["Weekly limit", 47, new Date(RESETS).toISOString()], ["Fable", 81, new Date(RESETS).toISOString()]]);
  assert.equal(json.month.budget, 500);
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
