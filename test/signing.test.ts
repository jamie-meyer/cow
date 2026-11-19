import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createLogStore } from "../src/caps/logstore.ts";
import { Refusal } from "../src/kv.ts";
import { eventText } from "../src/caps/log.ts";
import { attentionRpcContract } from "../src/raised-backend.ts";
import type { Dismissal, Seen } from "../src/shared.ts";
import { ACTION_ARGS, type Dispatch, queueDispatch, runSigned, sha256Hex, signingRpcContract, verifyP256 } from "../src/signing/backend.ts";
import { rpcContract } from "../server.ts";
import { canonical } from "../src/signing/canonical.ts";
import { type Envelope, PERSON_ACTIONS, type PublicKey, SIGNATURE_WINDOW_MS, fingerprintText, formatFingerprint, notEnrolledText, signedText } from "../src/signing/envelope.ts";
import { MAX_REQUESTS, createKeys } from "../src/signing/keys.ts";
import { NOW } from "./fixtures.ts";
import { memoryKv, world as raisedWorld } from "./memory.ts";

/** A page's key, made and used the way a browser does. */
async function page() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const key: PublicKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  const fingerprint = formatFingerprint(sha256Hex(fingerprintText(key)));
  let nonces = 0;
  const sign = async (action: string, args: unknown, at: number, nonce = `nonce-${fingerprint}-${(nonces += 1)}`): Promise<Envelope> => {
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signedText({ action, args, at, nonce })));
    return { action, args, at, nonce, key: fingerprint, sig: Buffer.from(sig).toString("base64url") };
  };
  return { key, fingerprint, sign };
}

function world(kv = memoryKv()) {
  const clock = { now: NOW };
  const file = { present: false, removable: true };
  const log = createLogStore({ kv, now: () => clock.now, hash: sha256Hex });
  const keys = createKeys({
    kv,
    now: () => clock.now,
    hash: sha256Hex,
    verify: verifyP256,
    log,
    resetPath: "/data/plugins/cow/reset-enrollment",
    takeResetFile: async () => {
      if (!file.present || !file.removable) return false;
      file.present = false;
      return true;
    },
    changed: () => undefined,
  });
  const ran: { action: string; args: unknown; by: string }[] = [];
  const record = (action: string) => async (args: unknown, by: string) => {
    ran.push({ action, args, by });
    return { did: action };
  };
  const dispatch = {
    ...Object.fromEntries(PERSON_ACTIONS.map((action) => [action, record(action)])),
    key_approve: (args: { fingerprint: string }, by: string) => keys.approve(args.fingerprint, by),
    key_refuse: (args: { fingerprint: string }, by: string) => keys.refuse(args.fingerprint, by),
    key_remove: (args: { fingerprint: string }, by: string) => keys.remove(args.fingerprint, by),
  } as unknown as Dispatch;
  const call = (envelope: unknown) => runSigned(keys, dispatch, envelope);
  const kinds = async () => (await log.all()).map((entry) => [entry.event.kind, entry.by]);
  return { kv, clock, file, log, keys, ran, call, kinds };
}
const refused = async (run: Promise<unknown>, code: string) => {
  await assert.rejects(run, (cause: unknown) => cause instanceof Refusal && cause.code === code, `expected a refusal with code ${code}`);
};
const ACK = { noticeId: "note_1" };

test("what is signed is the same text whatever order the fields come in", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}');
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(signedText({ action: "cap_ack", args: { noticeId: "n" }, at: 5, nonce: "abc" }), '{"action":"cap_ack","args":{"noticeId":"n"},"at":5,"nonce":"abc"}');
  assert.equal(signedText({ nonce: "abc", at: 5, args: { noticeId: "n" }, action: "cap_ack" }), signedText({ action: "cap_ack", args: { noticeId: "n" }, at: 5, nonce: "abc" }));
  assert.equal(formatFingerprint("0123456789abcdef0123"), "0123-4567-89ab-cdef");
});

test("every action only the person may do has its arguments defined, and nothing else is an action", () => {
  assert.deepEqual(Object.keys(ACTION_ARGS).sort(), [...PERSON_ACTIONS].sort());
  for (const action of ["cap_create", "cap_delete", "cap_restore", "cap_ack", "permission_decide", "send", "ask_answer", "ask_close", "seen_set", "dismissal_set", "brief_read", "main_choose", "automation_delete", "outcome_set", "key_approve", "key_refuse", "key_remove"]) {
    assert.ok((PERSON_ACTIONS as readonly string[]).includes(action), action);
  }
});

test("with no key enrolled the first page to ask is enrolled, and says so in the log", async () => {
  const w = world();
  const first = await page();
  assert.deepEqual(await w.keys.enrol(first.key, "Chrome on macOS"), { outcome: "enrolled-first", fingerprint: first.fingerprint });
  const state = await w.keys.state();
  assert.deepEqual(state.keys.map((key) => [key.fingerprint, key.how, key.approvedBy, key.label]), [[first.fingerprint, "first", null, "Chrome on macOS"]]);
  assert.equal(state.resetPath, "/data/plugins/cow/reset-enrollment");
  assert.deepEqual(await w.kinds(), [["key-enrolled", null]]);
  // Asking again changes nothing.
  assert.equal((await w.keys.enrol(first.key, "x")).outcome, "enrolled");
  assert.equal((await w.log.all()).length, 1);
  await refused(w.keys.enrol({ kty: "EC", crv: "P-256", x: "short", y: "short" }, "x"), "bad_key");
  await refused(w.keys.enrol({ kty: "RSA", n: "x", e: "AQAB" }, "x"), "bad_key");
  await refused(w.keys.enrol(null, "x"), "bad_key");
});

test("a signed call from the enrolled key runs, as that key", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  assert.deepEqual(await w.call(await first.sign("cap_ack", ACK, w.clock.now)), { did: "cap_ack" });
  assert.deepEqual(w.ran, [{ action: "cap_ack", args: ACK, by: first.fingerprint }]);
  assert.equal((await w.keys.state()).keys[0]!.lastUsedAt, w.clock.now);
});

test("an unsigned call, a call with no key, and a call that is not an envelope at all are refused", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  const good = await first.sign("cap_ack", ACK, w.clock.now);
  await refused(w.call({ action: "cap_ack", args: ACK }), "unsigned");
  await refused(w.call({ ...good, sig: "" }), "unsigned");
  await refused(w.call({ ...good, key: "" }), "unsigned");
  await refused(w.call({ ...good, nonce: "short" }), "unsigned");
  await refused(w.call(null), "unsigned");
  await refused(w.call("cap_ack"), "unsigned");
  await refused(w.call({ ...good, sig: "AAAA" }), "bad_signature");
  await refused(w.call({ ...good, sig: Buffer.alloc(64).toString("base64url") }), "bad_signature");
  await refused(w.call({ ...good, sig: "not base64 at all !!" }), "bad_signature");
  assert.deepEqual(w.ran, []);
});

test("a call signed by a key that is not enrolled is refused, whatever it claims", async () => {
  const w = world();
  const first = await page();
  const stranger = await page();
  await w.keys.enrol(first.key, "Chrome");
  await refused(w.call(await stranger.sign("cap_ack", ACK, w.clock.now)), "unknown_key");
  // Signed by the stranger, but naming the enrolled key: the signature does not match that key.
  await refused(w.call({ ...(await stranger.sign("cap_ack", ACK, w.clock.now)), key: first.fingerprint }), "bad_signature");
  // A stranger that only asked to be enrolled is still not enrolled.
  assert.equal((await w.keys.enrol(stranger.key, "an agent")).outcome, "pending");
  await refused(w.call(await stranger.sign("cap_ack", ACK, w.clock.now)), "unknown_key");
  await refused(w.call(await stranger.sign("key_approve", { fingerprint: stranger.fingerprint }, w.clock.now)), "unknown_key");
  assert.deepEqual(w.ran, []);
});

test("changing anything after it was signed breaks the signature: the action, an argument, the time, the nonce", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  const signed = await first.sign("cap_delete", { id: "cap_1" }, w.clock.now);
  await refused(w.call({ ...signed, action: "cap_restore" }), "bad_signature");
  await refused(w.call({ ...signed, args: { id: "cap_2" } }), "bad_signature");
  await refused(w.call({ ...signed, args: { id: "cap_1", extra: true } }), "bad_signature");
  await refused(w.call({ ...signed, at: signed.at + 1 }), "bad_signature");
  await refused(w.call({ ...signed, nonce: `${signed.nonce}x` }), "bad_signature");
  assert.deepEqual(w.ran, []);
  // Untouched, it still runs: none of the tries above used it up.
  assert.deepEqual(await w.call(signed), { did: "cap_delete" });
});

test("a signed call runs once: sent again it is refused as a replay", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  const signed = await first.sign("cap_ack", ACK, w.clock.now);
  await w.call(signed);
  await refused(w.call(signed), "replayed");
  await refused(w.call({ ...signed }), "replayed");
  w.clock.now += 60_000;
  await refused(w.call(signed), "replayed");
  assert.equal(w.ran.length, 1);
  // The same action signed afresh is a new call.
  await w.call(await first.sign("cap_ack", ACK, w.clock.now));
  assert.equal(w.ran.length, 2);
});

test("a stale call is refused: signed too long ago, too far ahead, or before cow last started", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  w.clock.now += 10 * 60_000;
  await refused(w.call(await first.sign("cap_ack", ACK, w.clock.now - SIGNATURE_WINDOW_MS - 1)), "stale");
  await refused(w.call(await first.sign("cap_ack", ACK, w.clock.now + SIGNATURE_WINDOW_MS + 1)), "stale");
  await refused(w.call(await first.sign("cap_ack", ACK, Number.NaN)), "unsigned");
  assert.deepEqual(await w.call(await first.sign("cap_ack", ACK, w.clock.now - SIGNATURE_WINDOW_MS + 1000)), { did: "cap_ack" });
  // A call captured before a restart cannot be replayed after it, though the nonces it had seen are gone.
  const kv = memoryKv();
  const before = world(kv);
  await before.keys.enrol(first.key, "Chrome");
  const captured = await first.sign("cap_ack", ACK, before.clock.now);
  await before.call(captured);
  const after = world(kv);
  after.clock.now = before.clock.now + 30_000;
  const restarted = createKeys({ kv, now: () => after.clock.now, hash: sha256Hex, verify: verifyP256, log: after.log, resetPath: "", takeResetFile: async () => false, changed: () => undefined });
  await refused(restarted.verify(captured), "stale");
  assert.equal((await restarted.verify(await first.sign("cap_ack", ACK, after.clock.now))).by, first.fingerprint);
});

test("an action that does not exist, and arguments in the wrong form, are refused even when signed", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  await refused(w.call(await first.sign("log_clear", {}, w.clock.now)), "bad_action");
  await refused(w.call(await first.sign("caps_state", null, w.clock.now)), "bad_action");
  await refused(w.call(await first.sign("cap_delete", { id: 7 }, w.clock.now)), "bad_arguments");
  await refused(w.call(await first.sign("key_approve", { fingerprint: "../key:x" }, w.clock.now)), "bad_arguments");
  await refused(w.call(await first.sign("send", { threadId: "t", text: "" }, w.clock.now)), "bad_arguments");
  assert.deepEqual(w.ran, []);
});

test("a second key waits until an enrolled key approves it with a signed call; then it works", async () => {
  const w = world();
  const first = await page();
  const second = await page();
  await w.keys.enrol(first.key, "Chrome");
  assert.deepEqual(await w.keys.enrol(second.key, "bb's desktop app"), { outcome: "pending", fingerprint: second.fingerprint });
  assert.equal((await w.keys.enrol(second.key, "bb's desktop app")).outcome, "pending");
  let state = await w.keys.state();
  assert.deepEqual(state.requests.map((request) => [request.fingerprint, request.status, request.label]), [[second.fingerprint, "pending", "bb's desktop app"]]);
  // It cannot approve itself, and nobody can approve it without a signature.
  await refused(w.call(await second.sign("key_approve", { fingerprint: second.fingerprint }, w.clock.now)), "unknown_key");
  await refused(w.call({ action: "key_approve", args: { fingerprint: second.fingerprint } }), "unsigned");
  w.clock.now += 1000;
  await w.call(await first.sign("key_approve", { fingerprint: second.fingerprint }, w.clock.now));
  state = await w.keys.state();
  assert.deepEqual(state.keys.map((key) => [key.fingerprint, key.how, key.approvedBy]), [[first.fingerprint, "first", null], [second.fingerprint, "approved", first.fingerprint]]);
  assert.deepEqual(state.requests, []);
  assert.equal((await w.keys.enrol(second.key, "x")).outcome, "enrolled");
  assert.deepEqual(await w.call(await second.sign("cap_ack", ACK, w.clock.now)), { did: "cap_ack" });
  assert.equal(w.ran.at(-1)!.by, second.fingerprint);
  assert.deepEqual(await w.kinds(), [["key-enrolled", null], ["key-requested", null], ["key-enrolled", first.fingerprint]]);
  await refused(w.call(await first.sign("key_approve", { fingerprint: second.fingerprint }, w.clock.now)), "request_not_found");
});

test("a refused key stays refused until the refusal is forgotten; a removed key can do nothing", async () => {
  const w = world();
  const first = await page();
  const second = await page();
  await w.keys.enrol(first.key, "Chrome");
  await w.keys.enrol(second.key, "somewhere");
  await w.call(await first.sign("key_refuse", { fingerprint: second.fingerprint }, w.clock.now));
  assert.equal((await w.keys.enrol(second.key, "somewhere")).outcome, "refused");
  assert.equal((await w.keys.state()).requests[0]!.status, "refused");
  await refused(w.call(await second.sign("cap_ack", ACK, w.clock.now)), "unknown_key");
  // Forgotten, it may ask again, and be approved.
  await w.call(await first.sign("key_remove", { fingerprint: second.fingerprint }, w.clock.now));
  assert.equal((await w.keys.enrol(second.key, "somewhere")).outcome, "pending");
  await w.call(await first.sign("key_approve", { fingerprint: second.fingerprint }, w.clock.now));
  await w.call(await second.sign("cap_ack", ACK, w.clock.now));
  // Removed, its signature is worth nothing, at once.
  await w.call(await first.sign("key_remove", { fingerprint: second.fingerprint }, w.clock.now));
  await refused(w.call(await second.sign("cap_ack", ACK, w.clock.now)), "unknown_key");
  await refused(w.call(await first.sign("key_remove", { fingerprint: second.fingerprint }, w.clock.now)), "key_not_found");
  assert.deepEqual((await w.kinds()).map(([kind, by]) => [kind, by === first.fingerprint]), [
    ["key-enrolled", false],
    ["key-requested", false],
    ["key-refused", true],
    ["key-removed", true],
    ["key-requested", false],
    ["key-enrolled", true],
    ["key-removed", true],
  ]);
});

test("asking to be enrolled is bounded, so that it cannot be used to flood the person", async () => {
  const w = world();
  await w.keys.enrol((await page()).key, "Chrome");
  for (let n = 0; n < MAX_REQUESTS; n += 1) assert.equal((await w.keys.enrol((await page()).key, `page ${n}`)).outcome, "pending");
  await refused(w.keys.enrol((await page()).key, "one more"), "too_many_requests");
  assert.equal((await w.keys.state()).requests.length, MAX_REQUESTS);
  // A label is the page's own word: it is kept short and on one line.
  const odd = world();
  await odd.keys.enrol((await page()).key, `  a\nlabel\u0000 ${"x".repeat(500)}`);
  const label = (await odd.keys.state()).keys[0]!.label;
  assert.ok(label.startsWith("a label x") && label.length <= 80 && !/[\n\u0000]/.test(label));
});

test("the reset file clears every key and is logged; the next page to ask is enrolled by first use", async () => {
  const w = world();
  const taken = await page();
  const person = await page();
  // Something else got there first: the person's page is the one that waits.
  await w.keys.enrol(taken.key, "not the person");
  assert.equal((await w.keys.enrol(person.key, "Chrome")).outcome, "pending");
  assert.equal(await w.keys.resetIfAsked(), false);
  w.file.present = true;
  const state = await w.keys.state();
  assert.deepEqual([state.keys, state.requests], [[], []]);
  assert.equal(w.file.present, false);
  assert.deepEqual((await w.kinds()).at(-1), ["enrollment-reset", null]);
  assert.deepEqual((await w.log.all()).at(-1)!.event, { kind: "enrollment-reset", keys: 1 });
  await refused(w.call(await taken.sign("cap_ack", ACK, w.clock.now)), "unknown_key");
  assert.equal((await w.keys.enrol(person.key, "Chrome")).outcome, "enrolled-first");
  assert.equal((await w.keys.enrol(taken.key, "not the person")).outcome, "pending");
  // The file is consumed once: nothing resets again by itself.
  assert.equal(await w.keys.resetIfAsked(), false);
  assert.equal((await w.keys.state()).keys.length, 1);
});

test("a reset file that cannot be taken away resets nothing, and a reset is noticed by a signed call too", async () => {
  const w = world();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  w.file.present = true;
  w.file.removable = false;
  assert.equal((await w.keys.state()).keys.length, 1);
  w.file.removable = true;
  // The call that finds the file is refused: its key is no longer enrolled.
  await refused(w.call(await first.sign("cap_ack", ACK, w.clock.now)), "unknown_key");
  assert.deepEqual(w.ran, []);
});

test("a page that cannot act says why, and how to change that", () => {
  const pending = notEnrolledText("pending", "aaaa-bbbb-cccc-dddd", "/data/plugins/cow/reset-enrollment");
  assert.match(pending, /key aaaa-bbbb-cccc-dddd is not enrolled, so this page can only read/);
  assert.match(pending, /Approve it from a page that is enrolled/);
  assert.match(pending, /touch \/data\/plugins\/cow\/reset-enrollment/);
  assert.match(notEnrolledText("refused", "aaaa-bbbb-cccc-dddd", ""), /was refused/);
  assert.match(notEnrolledText("unavailable", null, ""), /cannot hold a signing key/);
});

// ---- what takes a line out of the person's queue ------------------------------

const BRIEF = { summary: "Did it.", claims: [{ text: "It works", label: "inferred", evidence: [{ description: "the run", text: "ok" }] }] };

/** The real dispatch for seen, dismissed and read, over storage that lives in the test, with a brief to read. */
async function queueWorld() {
  const kv = memoryKv();
  const w = world(kv);
  const raised = raisedWorld(kv);
  raised.settings.onSubmit = false;
  await raised.briefs.submit({ caller: "child", threadId: null, raw: BRIEF });
  const seen = new Map<string, Seen>();
  const dismissals = new Map<string, Dismissal>();
  const mains = new Map<string, string>();
  let published = 0;
  const dispatch = queueDispatch(
    w.log,
    {
      setSeen: async (threadId, value) => void (value === null ? seen.delete(threadId) : seen.set(threadId, value)),
      setDismissal: async (threadId, value) => void (value === null ? dismissals.delete(threadId) : dismissals.set(threadId, value)),
      readBrief: (threadId, version, read) => raised.briefs.read(threadId, version, read),
      chooseMain: async (projectId, threadId) => {
        if (threadId === null) mains.delete(projectId);
        else mains.set(projectId, threadId);
        return { mains: Object.fromEntries(mains), currentProjectId: threadId === null ? null : projectId };
      },
    },
    () => void (published += 1),
  );
  const call = (envelope: unknown) => runSigned(w.keys, dispatch as unknown as Dispatch, envelope);
  const readAt = async () => (await raised.briefs.get("child")).readAt;
  return { ...w, call, seen, dismissals, mains, readAt, published: () => published };
}
const SEEN = { threadId: "child", seen: { seq: 41, at: NOW } };
const DISMISSAL = { threadId: "child", dismissal: { throughSeq: 17, at: NOW } };
const READ = { threadId: "child", version: 1, read: true };
const MAIN = { projectId: "proj_1", threadId: "main" };

test("marking a reply as seen, dismissing a refusal, marking a brief as read and recording Main are not methods anyone can call: only the signed one reaches them", () => {
  const methods = [...Object.keys(rpcContract), ...Object.keys(attentionRpcContract), ...Object.keys(signingRpcContract)];
  for (const gone of ["seen_set", "dismissal_set", "brief_read", "main_choose"]) assert.ok(!methods.includes(gone), `${gone} is still an RPC method`);
  assert.ok(methods.includes("signed"));
});

test("unsigned, or signed by a key that is not enrolled, none of the three does anything or is logged", async () => {
  const w = await queueWorld();
  const first = await page();
  const stranger = await page();
  await w.keys.enrol(first.key, "Chrome");
  for (const [action, args] of [["seen_set", SEEN], ["dismissal_set", DISMISSAL], ["brief_read", READ], ["main_choose", MAIN]] as const) {
    await refused(w.call({ action, args }), "unsigned");
    await refused(w.call(args), "unsigned");
    await refused(w.call({ ...(await first.sign(action, args, w.clock.now)), sig: Buffer.alloc(64).toString("base64url") }), "bad_signature");
    await refused(w.call(await stranger.sign(action, args, w.clock.now)), "unknown_key");
    // Signed for one thread, it cannot be turned on another.
    await refused(w.call({ ...(await first.sign(action, args, w.clock.now)), args: { ...args, threadId: "other" } }), "bad_signature");
  }
  assert.deepEqual([w.seen.size, w.dismissals.size, w.mains.size, await w.readAt(), w.published()], [0, 0, 0, null, 0]);
  assert.deepEqual(await w.kinds(), [["key-enrolled", null]]);
});

test("signed by an enrolled key, each is done and logged with that key's fingerprint; so is taking it back", async () => {
  const w = await queueWorld();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  const sign = (action: string, args: unknown) => first.sign(action, args, w.clock.now);

  assert.equal(await w.call(await sign("seen_set", SEEN)), null);
  assert.deepEqual(w.seen.get("child"), SEEN.seen);
  assert.equal(await w.call(await sign("dismissal_set", DISMISSAL)), null);
  assert.deepEqual(w.dismissals.get("child"), DISMISSAL.dismissal);
  assert.equal(await w.call(await sign("brief_read", READ)), null);
  assert.equal(typeof (await w.readAt()), "number");

  // The undo of each is the same action, signed and logged the same way.
  await w.call(await sign("seen_set", { threadId: "child", seen: null }));
  await w.call(await sign("dismissal_set", { threadId: "child", dismissal: null }));
  await w.call(await sign("brief_read", { ...READ, read: false }));
  assert.deepEqual([w.seen.size, w.dismissals.size, await w.readAt()], [0, 0, null]);
  assert.equal(w.published(), 6);

  const entries = (await w.log.all()).slice(1);
  assert.deepEqual(
    entries.map((entry) => [entry.by, entry.event]),
    [
      [first.fingerprint, { kind: "seen", threadId: "child", seq: 41 }],
      [first.fingerprint, { kind: "refusals-dismissed", threadId: "child", throughSeq: 17 }],
      [first.fingerprint, { kind: "brief-read", threadId: "child", version: 1, read: true }],
      [first.fingerprint, { kind: "seen", threadId: "child", seq: null }],
      [first.fingerprint, { kind: "refusals-dismissed", threadId: "child", throughSeq: null }],
      [first.fingerprint, { kind: "brief-read", threadId: "child", version: 1, read: false }],
    ],
  );
  assert.deepEqual(await w.log.check(), { intact: true, entries: 7 });
  const title = () => "Refunds";
  assert.deepEqual(
    entries.map((entry) => eventText(entry.event, title)),
    [
      "marked a reply of “Refunds” as seen: it no longer waits",
      "dismissed what bb refused “Refunds”: it no longer reads as blocked",
      "opened the brief of “Refunds”, version 1: it no longer waits",
      "took back marking a reply of “Refunds” as seen: it waits again",
      "showed again what bb refused “Refunds”: it reads as blocked again",
      "marked the brief of “Refunds”, version 1, as not read: it waits again",
    ],
  );
});

test("a signed call for a brief that is not there, or with arguments in the wrong form, is refused and not logged", async () => {
  const w = await queueWorld();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  const sign = (action: string, args: unknown) => first.sign(action, args, w.clock.now);
  await refused(w.call(await sign("brief_read", { ...READ, version: 4 })), "brief_not_found");
  await refused(w.call(await sign("brief_read", { ...READ, threadId: "grandchild" })), "brief_not_found");
  await refused(w.call(await sign("brief_read", { threadId: "child", version: 1 })), "bad_arguments");
  await refused(w.call(await sign("seen_set", { threadId: "child", seen: { seq: "41" } })), "bad_arguments");
  await refused(w.call(await sign("seen_set", { threadId: "child" })), "bad_arguments");
  await refused(w.call(await sign("dismissal_set", { threadId: "", dismissal: null })), "bad_arguments");
  assert.deepEqual([w.seen.size, w.dismissals.size, await w.readAt(), w.published()], [0, 0, null, 0]);
  assert.deepEqual(await w.kinds(), [["key-enrolled", null]]);
});

test("a signed mark cannot be replayed to take a line out of the queue again after the person took it back", async () => {
  const w = await queueWorld();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  const mark = await first.sign("seen_set", SEEN, w.clock.now);
  await w.call(mark);
  await w.call(await first.sign("seen_set", { threadId: "child", seen: null }, w.clock.now));
  await refused(w.call(mark), "replayed");
  assert.equal(w.seen.size, 0);
});

test("recording which thread is Main, where a new window starts, is signed and logged; forgetting it too", async () => {
  const w = await queueWorld();
  const first = await page();
  await w.keys.enrol(first.key, "Chrome");
  assert.deepEqual(await w.call(await first.sign("main_choose", MAIN, w.clock.now)), { mains: { proj_1: "main" }, currentProjectId: "proj_1" });
  assert.equal(w.mains.get("proj_1"), "main");
  await w.call(await first.sign("main_choose", { projectId: "proj_1", threadId: null }, w.clock.now));
  assert.equal(w.mains.size, 0);
  await refused(w.call(await first.sign("main_choose", { projectId: "", threadId: "main" }, w.clock.now)), "bad_arguments");
  const entries = (await w.log.all()).slice(1);
  assert.deepEqual(
    entries.map((entry) => [entry.by, entry.event]),
    [
      [first.fingerprint, { kind: "main-chosen", projectId: "proj_1", threadId: "main" }],
      [first.fingerprint, { kind: "main-chosen", projectId: "proj_1", threadId: null }],
    ],
  );
  assert.equal(eventText(entries[0]!.event, () => "Main"), "chose “Main” as Main: a new window starts there");
});
