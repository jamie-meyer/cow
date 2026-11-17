import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { followLinks, interactionState } from "../src/caps/backend.ts";
import type { Resolved } from "../src/caps/match.ts";
import { createLogStore } from "../src/caps/logstore.ts";
import { type CapDeps, type CreateInput, type InteractionState, createCaps } from "../src/caps/service.ts";
import { Refusal } from "../src/kv.ts";
import type { PermissionResolution } from "../src/permission.ts";
import { NOW } from "./fixtures.ts";
import { PARENTS, memoryKv } from "./memory.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BY = "aaaa-bbbb-cccc-dddd";

/** A small bb: threads from PARENTS, requests that can be decided, and a filesystem of links. */
function world(kv = memoryKv()) {
  const clock = { now: NOW };
  let ids = 0;
  const decided: { threadId: string; interactionId: string; resolution: PermissionResolution }[] = [];
  const states = new Map<string, InteractionState>();
  const paths = new Map<string, string[]>();
  /** null: links cannot be followed. Otherwise a path maps to itself unless listed here. */
  const links: { map: Map<string, string> | null } = { map: new Map() };
  const failDecide = { on: false };
  const deps: CapDeps = {
    kv,
    now: () => (clock.now += 1),
    newId: () => `t${(ids += 1)}`,
    log: createLogStore({ kv, now: () => (clock.now += 1), hash: sha }),
    places: async () => ({ home: "/Users/pat", dataDir: "/Users/pat/.bb" }),
    thread: async (threadId) => (threadId in PARENTS ? { title: threadId.toUpperCase() } : null),
    ancestors: async (threadId) => {
      const above: string[] = [];
      for (let at = PARENTS[threadId] ?? null; at !== null; at = PARENTS[at] ?? null) above.push(at);
      return above;
    },
    changedPaths: async (_threadId, itemId) => paths.get(itemId) ?? [],
    resolve: async (_threadId, wanted): Promise<Resolved> => {
      const map = links.map;
      if (map === null) return null;
      // A link applies to everything under it, as on a disk.
      const real = (path: string) => {
        const from = [...map.keys()].filter((link) => path === link || path.startsWith(`${link}/`)).sort((a, b) => b.length - a.length)[0];
        return from === undefined ? path : map.get(from)! + path.slice(from.length);
      };
      return new Map(wanted.map((path) => [path, real(path)]));
    },
    decide: async (threadId, interactionId, resolution) => {
      if (failDecide.on) throw new Error("bb is away");
      decided.push({ threadId, interactionId, resolution });
      states.set(interactionId, { status: "decided", decision: resolution.decision });
    },
    interaction: async (_threadId, interactionId) => states.get(interactionId) ?? { status: "gone" },
    changed: () => undefined,
    warn: () => undefined,
  };
  const real = createCaps(deps);
  // The person's actions are reached only through a verified signature; here the key that signed is BY unless a test names another.
  const caps = {
    ...real,
    create: (given: CreateInput, by = BY) => real.create(given, by),
    remove: (id: string, by = BY) => real.remove(id, by),
    restore: (id: string, by = BY) => real.restore(id, by),
    acknowledge: (noticeId: string, by = BY) => real.acknowledge(noticeId, by),
    decideOnPage: (threadId: string, interactionId: string, resolution: PermissionResolution, by = BY) => real.decideOnPage(threadId, interactionId, resolution, by),
  };
  const commandRequest = (id: string, command: string, decisions = ["allow_once", "deny"]) => {
    states.set(id, { status: "pending" });
    return { id, status: "pending", createdAt: NOW, payload: { kind: "approval", subject: { kind: "command", itemId: `item_${id}`, command, cwd: null }, availableDecisions: decisions, reason: "dangerouslyDisableSandbox" } };
  };
  const fileRequest = (id: string, files: string[], decisions = ["allow_once", "allow_for_session", "deny"]) => {
    states.set(id, { status: "pending" });
    paths.set(`item_${id}`, files);
    return {
      id,
      status: "pending",
      createdAt: NOW,
      payload: { kind: "approval", subject: { kind: "file_change", itemId: `item_${id}`, writeScope: null, sessionGrant: { network: null, fileSystem: { read: [], write: ["/tmp/scratch"] } } }, availableDecisions: decisions, reason: "Path is outside allowed working directories" },
    };
  };
  return { kv, caps, deps, clock, decided, decisions: () => decided.map((entry) => entry.resolution.decision), states, paths, links, failDecide, commandRequest, fileRequest };
}

const input = (overrides: Partial<CreateInput> = {}): CreateInput => ({
  name: "scratch",
  note: null,
  rule: { kind: "dir", text: "/tmp/scratch" },
  scope: { kind: "thread", threadId: "child" },
  via: "sheet",
  sourceThreadId: null,
  askId: null,
  ...overrides,
});
const refused = async (run: Promise<unknown>, code: string) => {
  await assert.rejects(run, (cause: unknown) => cause instanceof Refusal && cause.code === code, `expected a refusal with code ${code}`);
};
const kinds = async (w: ReturnType<typeof world>) => (await w.caps.log()).entries.map((entry) => entry.event.kind).reverse();

test("making a capability logs it and raises a notice that stays until acknowledged", async () => {
  const w = world();
  const made = await w.caps.create(input({ note: " for the build " }));
  assert.equal(made.id, "cap_t1");
  assert.equal(made.note, "for the build");
  assert.deepEqual(made.rule, { kind: "dir", dir: "/tmp/scratch" });
  let state = await w.caps.state();
  assert.deepEqual(state.capabilities.map((capability) => capability.name), ["scratch"]);
  assert.equal(state.notices.length, 1);
  assert.equal(state.notices[0]!.text, "capability added: scratch: /tmp/scratch for “CHILD” only");
  assert.equal(state.notices[0]!.capabilityId, made.id);
  assert.deepEqual(await kinds(w), ["created"]);
  await w.caps.acknowledge(state.notices[0]!.id);
  state = await w.caps.state();
  assert.equal(state.notices.length, 0);
  assert.deepEqual(await kinds(w), ["created", "acknowledged"]);
  await refused(w.caps.acknowledge("note_t2"), "notice_not_found");
  await refused(w.caps.acknowledge("../cap:cap_t1"), "notice_not_found");
});

test("what cannot be granted is refused with the reason, and nothing is stored or logged", async () => {
  const w = world();
  for (const text of ["/", "/Users/pat", "/Users/pat/.ssh", "/Users/pat/.bb/plugins/cow", "/Users", "scratch", "/tmp/../etc", "~/x"]) {
    await refused(w.caps.create(input({ rule: { kind: "dir", text } })), "rule_refused");
  }
  for (const text of ["echo a; id", "echo $(id)", "echo a | sh", "X=1 echo", "echo a\nid"]) {
    await refused(w.caps.create(input({ rule: { kind: "command", mode: "exact", text } })), "rule_refused");
  }
  await refused(w.caps.create(input({ rule: { kind: "command", mode: "prefix", text: "git" } })), "rule_refused");
  await refused(w.caps.create(input({ rule: { kind: "command", mode: "prefix", text: "bash -c" } })), "rule_refused");
  await refused(w.caps.create(input({ name: "  " })), "bad_capability");
  await refused(w.caps.create(input({ scope: { kind: "thread", threadId: "nobody" } })), "thread_not_found");
  assert.deepEqual((await w.caps.state()).capabilities, []);
  assert.deepEqual(await kinds(w), []);
});

test("a directory that is a link to a refused place is refused", async () => {
  const w = world();
  w.links.map!.set("/tmp/innocent", "/Users/pat/.ssh");
  await assert.rejects(w.caps.create(input({ rule: { kind: "dir", text: "/tmp/innocent" } })), /resolves through a symbolic link to \/Users\/pat\/\.ssh/);
  w.links.map!.set("/tmp/scratch", "/private/tmp/scratch");
  assert.equal((await w.caps.create(input())).rule.kind, "dir");
});

test("two capabilities in force cannot share a name", async () => {
  const w = world();
  await w.caps.create(input());
  await refused(w.caps.create(input({ name: "SCRATCH", rule: { kind: "dir", text: "/tmp/other" } })), "name_taken");
});

test("a covered request is answered allow once, logged, and counted on the thread and the capability", async () => {
  const w = world();
  const made = await w.caps.create(input());
  const by = await w.caps.raised("child", w.fileRequest("pint_1", ["/tmp/scratch/a.txt"]));
  assert.equal(by?.id, made.id);
  assert.deepEqual(w.decided, [{ threadId: "child", interactionId: "pint_1", resolution: { decision: "allow_once", grantedPermissions: null } }]);
  const state = await w.caps.state();
  assert.equal(state.capabilities[0]!.uses, 1);
  assert.equal(state.uses.child?.count, 1);
  assert.equal(state.uses.child?.name, "scratch");
  assert.equal(state.uses.child?.what, "change /tmp/scratch/a.txt");
  const [entry] = (await w.caps.log()).entries;
  assert.deepEqual(entry!.event, { kind: "auto-allowed", threadId: "child", interactionId: "pint_1", capabilityId: made.id, name: "scratch", what: "change /tmp/scratch/a.txt", links: "followed" });
  // What cow did by itself names no key; what the person did names the key that signed it.
  assert.equal(entry!.by, null);
  assert.equal((await w.caps.log()).entries.at(-1)!.by, BY);
  // It was cow's own decision: it is never flagged as made somewhere else.
  await w.caps.settle();
  assert.equal((await w.caps.state()).notices.filter((notice) => notice.kind === "outside").length, 0);
  await w.caps.raised("child", w.fileRequest("pint_2", ["/tmp/scratch/b.txt"]));
  assert.equal((await w.caps.state()).uses.child?.count, 2);
});

test("a request is never answered with anything wider than allow once, and never without it on offer", async () => {
  const w = world();
  await w.caps.create(input());
  assert.equal(await w.caps.raised("child", w.fileRequest("pint_1", ["/tmp/scratch/a.txt"], ["allow_for_session", "deny"])), null);
  assert.equal(await w.caps.raised("child", w.fileRequest("pint_2", ["/tmp/scratch/a.txt"], ["deny"])), null);
  assert.deepEqual(w.decisions(), []);
  await w.caps.raised("child", w.fileRequest("pint_3", ["/tmp/scratch/a.txt"]));
  assert.deepEqual(w.decisions(), ["allow_once"]);
});

test("a request that is not wholly covered is left for the person", async () => {
  const w = world();
  await w.caps.create(input());
  await w.caps.create(input({ name: "echo", rule: { kind: "command", mode: "exact", text: "echo cow" } }));
  await w.caps.create(input({ name: "push", rule: { kind: "command", mode: "prefix", text: "git push origin" } }));
  const left = [
    w.fileRequest("pint_1", ["/tmp/scratch/a.txt", "/tmp/elsewhere/b.txt"]),
    w.fileRequest("pint_2", ["/tmp/scratchy/a.txt"]),
    w.fileRequest("pint_3", ["/tmp/scratch/../x"]),
    w.fileRequest("pint_4", []),
    w.commandRequest("pint_5", "echo cow; id"),
    w.commandRequest("pint_6", "echo moo"),
    w.commandRequest("pint_7", "git push origin main && id"),
    w.commandRequest("pint_8", "touch /tmp/scratch/a.txt"),
  ];
  for (const request of left) assert.equal(await w.caps.raised("child", request), null, request.id);
  assert.deepEqual(w.decisions(), []);
  assert.equal((await w.caps.raised("child", w.commandRequest("pint_9", "echo cow")))?.name, "echo");
  assert.equal((await w.caps.raised("child", w.commandRequest("pint_10", "git push origin main")))?.name, "push");
});

test("a capability allows only the threads it applies to", async () => {
  const w = world();
  await w.caps.create(input({ scope: { kind: "subtree", threadId: "child" } }));
  assert.notEqual(await w.caps.raised("child", w.fileRequest("pint_1", ["/tmp/scratch/a"])), null);
  assert.notEqual(await w.caps.raised("grandchild", w.fileRequest("pint_2", ["/tmp/scratch/a"])), null);
  assert.equal(await w.caps.raised("main", w.fileRequest("pint_3", ["/tmp/scratch/a"])), null);
  assert.equal(await w.caps.raised("other", w.fileRequest("pint_4", ["/tmp/scratch/a"])), null);
  const under = world();
  await under.caps.create(input({ scope: { kind: "main", threadId: "main" } }));
  assert.equal(await under.caps.raised("main", under.fileRequest("pint_1", ["/tmp/scratch/a"])), null);
  assert.notEqual(await under.caps.raised("grandchild", under.fileRequest("pint_2", ["/tmp/scratch/a"])), null);
  assert.equal(await under.caps.raised("other", under.fileRequest("pint_3", ["/tmp/scratch/a"])), null);
  assert.deepEqual((await under.caps.heldBy("grandchild")).map((entry) => entry.source), [{ from: "main", threadId: "main" }]);
});

test("a file that a link takes out of the directory is not allowed; with links unknown the log says so", async () => {
  const w = world();
  w.links.map!.set("/tmp/scratch", "/private/tmp/scratch");
  await w.caps.create(input());
  w.links.map!.set("/tmp/scratch/out", "/Users/pat/.ssh");
  assert.equal(await w.caps.raised("child", w.fileRequest("pint_1", ["/tmp/scratch/out/authorized_keys"])), null);
  assert.notEqual(await w.caps.raised("child", w.fileRequest("pint_2", ["/tmp/scratch/in/a.txt"])), null);
  w.links.map = null;
  assert.notEqual(await w.caps.raised("child", w.fileRequest("pint_3", ["/tmp/scratch/out/authorized_keys"])), null);
  assert.equal(((await w.caps.log()).entries[0]!.event as { links: string }).links, "not-followed");
});

test("deleting takes effect at once, undo puts it back with a new notice, and all of it is logged", async () => {
  const w = world();
  const made = await w.caps.create(input());
  await w.caps.acknowledge((await w.caps.state()).notices[0]!.id);
  await w.caps.remove(made.id);
  assert.equal(await w.caps.raised("child", w.fileRequest("pint_1", ["/tmp/scratch/a"])), null);
  assert.deepEqual(await w.caps.heldBy("child"), []);
  await refused(w.caps.remove(made.id), "already_deleted");
  // A deleted name is free again.
  const second = await w.caps.create(input());
  await refused(w.caps.restore(made.id), "name_taken");
  await w.caps.remove(second.id);
  const back = await w.caps.restore(made.id);
  assert.equal(back.deletedAt, null);
  await refused(w.caps.restore(made.id), "not_deleted");
  const notices = (await w.caps.state()).notices;
  assert.deepEqual(notices.map((notice) => notice.text), ["capability added: scratch: /tmp/scratch for “CHILD” only", "capability restored: scratch: /tmp/scratch for “CHILD” only"]);
  assert.notEqual(await w.caps.raised("child", w.fileRequest("pint_2", ["/tmp/scratch/a"])), null);
  assert.deepEqual(await kinds(w), ["created", "acknowledged", "deleted", "created", "deleted", "restored", "auto-allowed"]);
  await refused(w.caps.remove("cap_nope"), "capability_not_found");
  await refused(w.caps.remove("../x"), "capability_not_found");
});

test("a notice outlives its capability: one made and deleted unseen still has to be acknowledged", async () => {
  const w = world();
  const made = await w.caps.create(input());
  await w.caps.remove(made.id);
  const state = await w.caps.state();
  assert.equal(state.notices.length, 1);
  assert.equal(state.capabilities[0]!.deletedAt !== null, true);
});

test("the page is given a deleted capability for a day, and for as long as its notice waits", async () => {
  const w = world();
  const seen = await w.caps.create(input());
  await w.caps.acknowledge((await w.caps.state()).notices[0]!.id);
  const unseen = await w.caps.create(input({ name: "other", rule: { kind: "dir", text: "/tmp/other" } }));
  await w.caps.remove(seen.id);
  await w.caps.remove(unseen.id);
  assert.deepEqual((await w.caps.state()).capabilities.map((capability) => capability.name), ["scratch", "other"]);
  w.clock.now += 25 * 60 * 60_000;
  assert.deepEqual((await w.caps.state()).capabilities.map((capability) => capability.name), ["other"]);
  // It is still in storage: its history and undo do not depend on the page having it.
  assert.equal((await w.caps.restore(seen.id)).deletedAt, null);
});

test("a capability deleted between the look and the answer allows nothing", async () => {
  const w = world();
  const made = await w.caps.create(input());
  // Deleted while the request is being read.
  w.deps.resolve = async () => {
    await w.caps.remove(made.id);
    return null;
  };
  assert.equal(await w.caps.raised("child", w.fileRequest("pint_1", ["/tmp/scratch/a"])), null);
  assert.deepEqual(w.decisions(), []);
});

test("a decision made on the page is cow's own; one made anywhere else is flagged, logged, and waits to be acknowledged", async () => {
  const w = world();
  // Raised and left for the person: no capability covers it.
  await w.caps.raised("child", w.commandRequest("pint_1", "echo cow"));
  await w.caps.raised("child", w.commandRequest("pint_2", "echo moo"));
  await w.caps.raised("grandchild", w.commandRequest("pint_3", "echo baa"));
  await w.caps.settle();
  assert.deepEqual((await w.caps.state()).notices, []);
  assert.deepEqual((await w.caps.watching()).sort(), ["child", "grandchild"]);
  await w.caps.decideOnPage("child", "pint_1", { decision: "allow_once", grantedPermissions: null });
  // Another thread, or bb's own view, decides the other two.
  w.states.set("pint_2", { status: "decided", decision: "allow_once" });
  w.states.set("pint_3", { status: "decided", decision: "deny" });
  await w.caps.settle("child");
  let notices = (await w.caps.state()).notices;
  assert.deepEqual(notices.map((notice) => [notice.kind, notice.threadId, notice.text]), [["outside", "child", "approved outside cow: run: echo moo"]]);
  await w.caps.settle();
  await w.caps.settle();
  notices = (await w.caps.state()).notices;
  assert.deepEqual(notices.map((notice) => notice.text), ["approved outside cow: run: echo moo", "denied outside cow: run: echo baa"]);
  assert.deepEqual(await kinds(w), ["decided", "outside", "outside"]);
  assert.deepEqual((await w.caps.log()).entries.map((entry) => entry.by).reverse(), [BY, null, null]);
  assert.deepEqual(await w.caps.watching(), []);
  await w.caps.acknowledge(notices[0]!.id);
  assert.equal((await w.caps.state()).notices.length, 1);
});

test("a request that ended with no decision is not flagged, and a failed answer leaves it for the person", async () => {
  const w = world();
  await w.caps.raised("child", w.commandRequest("pint_1", "echo cow"));
  w.states.set("pint_1", { status: "gone" });
  await w.caps.settle();
  assert.deepEqual((await w.caps.state()).notices, []);
  await w.caps.create(input({ name: "echo", rule: { kind: "command", mode: "exact", text: "echo cow" } }));
  w.failDecide.on = true;
  assert.equal(await w.caps.raised("child", w.commandRequest("pint_2", "echo cow")), null);
  assert.equal((await w.caps.state()).capabilities[0]!.uses, 0);
  await refused(w.caps.decideOnPage("child", "pint_2", { decision: "deny" }), "not_decided");
  // Decided elsewhere after cow failed to: that is not cow's decision.
  w.states.set("pint_2", { status: "decided", decision: "allow_once" });
  await w.caps.settle();
  assert.equal((await w.caps.state()).notices.filter((notice) => notice.kind === "outside").length, 1);
});

test("what is not a permission request is ignored, and a kind no rule covers is still watched", async () => {
  const w = world();
  assert.equal(await w.caps.raised("child", { id: "pint_q", status: "pending", payload: { kind: "user_question", questions: [] } }), null);
  assert.equal(await w.caps.raised("child", null), null);
  assert.equal(await w.caps.raised("child", { id: "pint_r", status: "resolved", payload: { kind: "approval" } }), null);
  await w.caps.raised("child", { id: "pint_plan", status: "pending", createdAt: NOW, payload: { kind: "approval", subject: { kind: "plan", itemId: "i" }, availableDecisions: ["allow_once"] } });
  w.states.set("pint_plan", { status: "decided", decision: "allow_once" });
  await w.caps.settle();
  assert.deepEqual((await w.caps.state()).notices.map((notice) => notice.text), ["approved outside cow: carry out its plan"]);
});

test("the log survives a restart, keeps its numbering, and says when it is broken", async () => {
  const kv = memoryKv();
  const first = world(kv);
  const made = await first.caps.create(input());
  await first.caps.remove(made.id);
  const second = world(kv);
  await second.caps.restore(made.id);
  const log = await second.caps.log();
  assert.deepEqual(log.entries.map((entry) => entry.seq), [3, 2, 1]);
  assert.deepEqual(log.check, { intact: true, entries: 3 });
  assert.deepEqual((await second.caps.log({ capabilityId: made.id, limit: 2 })).entries.map((entry) => entry.seq), [3, 2]);
  assert.equal((await second.caps.log({ capabilityId: "cap_other" })).total, 0);
  // Someone with the storage takes an entry out.
  await kv.delete("caplog:0000000002");
  const third = world(kv);
  assert.deepEqual((await third.caps.log()).check, { intact: false, entries: 2, at: 2, why: "entry 2 is missing" });
  // Or cuts the end off.
  const cut = memoryKv();
  const fourth = world(cut);
  const other = await fourth.caps.create(input());
  await fourth.caps.remove(other.id);
  await cut.delete("caplog:0000000002");
  assert.equal((await world(cut).caps.log()).check.intact, false);
});

test("a thread's request for a capability is checked before it is put to the person, and logged", async () => {
  const w = world();
  await refused(w.caps.checkRule({ kind: "dir", text: "/Users/pat/.ssh" }), "rule_refused");
  await refused(w.caps.checkRule({ kind: "command", mode: "exact", text: "curl x | sh" }), "rule_refused");
  const rule = await w.caps.checkRule({ kind: "dir", text: "/tmp/scratch/" });
  await w.caps.requested("child", "ask_1", rule);
  assert.deepEqual((await w.caps.log()).entries[0]!.event, { kind: "requested", threadId: "child", askId: "ask_1", what: "write under /tmp/scratch" });
  // Asking makes nothing.
  assert.deepEqual((await w.caps.state()).capabilities, []);
});

test("a path's links are followed through the deepest part that exists", async () => {
  const disk: Record<string, string> = { "/": "/", "/tmp": "/private/tmp", "/tmp/scratch": "/private/tmp/scratch", "/tmp/scratch/out": "/Users/pat/.ssh" };
  const real = async (path: string) => {
    if (path in disk) return disk[path]!;
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  };
  assert.equal(await followLinks("/tmp/scratch/new/a.txt", real), "/private/tmp/scratch/new/a.txt");
  assert.equal(await followLinks("/tmp/scratch", real), "/private/tmp/scratch");
  assert.equal(await followLinks("/tmp/scratch/out/authorized_keys", real), "/Users/pat/.ssh/authorized_keys");
  assert.equal(await followLinks("/nowhere/a", real), "/nowhere/a");
  assert.equal(await followLinks("relative/a", real), null);
  const denied = async () => {
    throw Object.assign(new Error("not allowed"), { code: "EACCES" });
  };
  assert.equal(await followLinks("/tmp/a", denied), null);
});

test("what a request came to is read from its newest lifecycle event", () => {
  const event = (seq: number, id: string, status: string, resolution: unknown = null) => ({ seq, type: "system/interaction/lifecycle", data: { interaction: { id, status, resolution } } });
  const events = [event(3, "pint_1", "resolved", { decision: "allow_once" }), event(2, "pint_1", "resolving", { decision: "allow_once" }), event(1, "pint_1", "pending"), event(4, "pint_2", "pending"), event(5, "pint_3", "interrupted")];
  assert.deepEqual(interactionState(events, "pint_1"), { status: "decided", decision: "allow_once" });
  assert.deepEqual(interactionState([...events].reverse(), "pint_1"), { status: "decided", decision: "allow_once" });
  assert.deepEqual(interactionState(events, "pint_2"), { status: "pending" });
  assert.deepEqual(interactionState(events, "pint_3"), { status: "gone" });
  assert.equal(interactionState(events, "pint_9"), null);
  assert.equal(interactionState([null, 4, {}], "pint_1"), null);
});
