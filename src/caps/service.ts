// Capabilities on the backend: where they are kept, how one is made, deleted
// and put back, how a request is allowed through one, how a decision cow did
// not make is noticed, and the log of all of it.
//
// Everything is in the plugin's own storage, never on a thread, so a thread
// cannot write itself a capability by editing its metadata. That is the only
// thing the storage protects against: bb does not say who calls the plugin,
// so every change made here is logged and put in front of the person
// instead of being trusted.

import { toAskDetail } from "../answer.ts";
import { type Kv, Refusal, serial } from "../kv.ts";
import { type PermissionResolution, permissionSummary } from "../permission.ts";
import { type Capability, type Rule, type RuleDraft, type Scope, type Via, addedText, capabilitySchema, isActive, readName, readNote, readRule, ruleDraft, ruleText } from "./cap.ts";
import { type ChainCheck, type Hash, type LogEntry, type LogEvent, checkChain, entryCapability, logEntrySchema, nextEntry, outsideText } from "./log.ts";
import { type Request, type Resolved, covers, coversResolved, requestText } from "./match.ts";
import { type Places, directoryRefusal, readPath } from "./paths.ts";
import { type Held, held } from "./scope.ts";
import { z } from "zod";

const CAP = "cap:";
const LOG = "caplog:";
const LOG_HEAD = "caplog-head";
const NOTICE = "capnote:";
const USE = "capuse:";
const PENDING = "cappend:";
const OWN = "capown:";

/** Capabilities in force at once; more than this is not something a person reads. */
export const MAX_CAPABILITIES = 200;
/** The log entries the page and the CLI are given at once, newest first. */
export const MAX_LOG_PAGE = 500;

/** Something the person has to acknowledge on the page: a capability that appeared, or a decision cow did not make. */
export const noticeSchema = z.object({
  id: z.string(),
  kind: z.enum(["capability", "outside"]),
  /** For a capability: which one. */
  capabilityId: z.string().nullable(),
  /** For a decision made outside cow: on which thread. */
  threadId: z.string().nullable(),
  text: z.string(),
  at: z.number(),
});
export type Notice = z.infer<typeof noticeSchema>;

/** What capabilities have allowed on one thread. */
export const useSchema = z.object({
  count: z.number().int().min(0),
  lastAt: z.number(),
  capabilityId: z.string(),
  name: z.string(),
  what: z.string(),
});
export type Use = z.infer<typeof useSchema>;

const pendingSchema = z.object({ interactionId: z.string(), threadId: z.string(), what: z.string(), at: z.number() });
type Pending = z.infer<typeof pendingSchema>;

const placesSchema = z.object({ home: z.string().nullable(), dataDir: z.string().nullable() });
export const capStateSchema = z.object({
  /** Every capability, deleted ones included: the page shows a deleted one while its notice is unacknowledged. */
  capabilities: z.array(capabilitySchema),
  notices: z.array(noticeSchema),
  uses: z.record(z.string(), useSchema),
  places: placesSchema,
});
export type CapState = z.infer<typeof capStateSchema>;

export const chainCheckSchema = z.union([
  z.object({ intact: z.literal(true), entries: z.number() }),
  z.object({ intact: z.literal(false), entries: z.number(), at: z.number(), why: z.string() }),
]);

/** What bb says a request has come to. */
export type InteractionState = { status: "pending" } | { status: "decided"; decision: string } | { status: "gone" };

export interface CapDeps {
  kv: Kv;
  now(): number;
  newId(): string;
  hash: Hash;
  /** Where home and bb's data are on the server's machine. */
  places(): Promise<Places>;
  /** A thread's title, or null when bb has no such thread. */
  thread(threadId: string): Promise<{ title: string } | null>;
  /** The ids above a thread, nearest first. */
  ancestors(threadId: string): Promise<readonly string[]>;
  /** The files the tool call `itemId` of a thread would change, as bb names them; empty when bb has not said. */
  changedPaths(threadId: string, itemId: string): Promise<string[]>;
  /** Each path with its symbolic links followed, on the thread's machine; null when that cannot be found out. */
  resolve(threadId: string, paths: readonly string[]): Promise<Resolved>;
  /** Answer one of bb's permission requests. */
  decide(threadId: string, interactionId: string, resolution: PermissionResolution): Promise<void>;
  /** What a request has come to. */
  interaction(threadId: string, interactionId: string): Promise<InteractionState>;
  /** Tell open pages that something here changed. */
  changed(): void;
  warn(message: string): void;
}

export interface CreateInput {
  name: string;
  note: string | null;
  rule: RuleDraft;
  scope: Scope;
  via: Via;
  sourceThreadId: string | null;
  askId: string | null;
}

export interface Caps {
  state(): Promise<CapState>;
  /** Make a capability. It is logged, and a notice is raised that stays until acknowledged. */
  create(input: CreateInput): Promise<Capability>;
  /** Delete one. It allows nothing from this moment. */
  remove(id: string): Promise<Capability>;
  /** Put a deleted one back in force. A notice is raised, as for a new one. */
  restore(id: string): Promise<Capability>;
  acknowledge(noticeId: string): Promise<Notice>;
  /** The log, newest first, and whether its chain holds. `capabilityId` narrows it to one capability's history. */
  log(filter?: { limit?: number; capabilityId?: string }): Promise<{ entries: LogEntry[]; total: number; check: ChainCheck }>;
  /** The capabilities in force that apply to a thread. */
  heldBy(threadId: string): Promise<Held[]>;
  /** Check a rule a thread asks for, before an ask is raised for it. */
  checkRule(rule: RuleDraft): Promise<Rule>;
  /** Record that a thread asked for a capability. */
  requested(threadId: string, askId: string, rule: Rule): Promise<void>;
  /** Answer a request as decided on the page, and record that cow did it. */
  decideOnPage(threadId: string, interactionId: string, resolution: PermissionResolution): Promise<void>;
  /** bb raised a request: remember it, and allow it once when a capability covers it. Returns the capability that allowed it. */
  raised(threadId: string, interaction: unknown): Promise<Capability | null>;
  /** Look again at the requests cow is watching (of one thread, or all): flag the ones decided somewhere else. */
  settle(threadId?: string): Promise<void>;
  /** Forget what is kept about a thread that bb has deleted. Capabilities and the log stay. */
  forget(threadId: string): Promise<void>;
}

const pad = (seq: number): string => String(seq).padStart(10, "0");

export function createCaps(deps: CapDeps): Caps {
  const { kv } = deps;
  const locked = serial();

  const readAll = async <T>(prefix: string, schema: z.ZodType<T>): Promise<T[]> => {
    const keys = await kv.list(prefix);
    const found = await Promise.all(keys.map(async (key) => schema.safeParse(await kv.get(key))));
    return found.flatMap((entry) => (entry.success ? [entry.data] : []));
  };
  const capabilities = async (): Promise<Capability[]> =>
    (await readAll(CAP, capabilitySchema)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const capability = async (id: string): Promise<Capability> => {
    const found = /^cap_[a-z0-9]{1,40}$/.test(id) ? capabilitySchema.safeParse(await kv.get(CAP + id)) : null;
    if (!found?.success) throw new Refusal("capability_not_found", `there is no capability ${id}`);
    return found.data;
  };
  const titleOf = async (threadId: string): Promise<string> => (await deps.thread(threadId))?.title ?? threadId;

  // ---- the log ----------------------------------------------------------

  /** The whole log, oldest first. This process is the only writer, so it is read from storage once. */
  let entries: LogEntry[] | null = null;
  const loadLog = async (): Promise<LogEntry[]> => {
    if (entries === null) entries = (await readAll(LOG, logEntrySchema)).sort((a, b) => a.seq - b.seq);
    return entries;
  };
  const append = (event: LogEvent): Promise<LogEntry> =>
    locked("log", async () => {
      const log = await loadLog();
      const last = log[log.length - 1] ?? null;
      const entry = nextEntry(last, event, deps.now(), deps.hash);
      await kv.set(LOG + pad(entry.seq), entry);
      await kv.set(LOG_HEAD, { seq: entry.seq, hash: entry.hash });
      log.push(entry);
      return entry;
    });

  const notify = async (notice: Omit<Notice, "id" | "at">): Promise<Notice> => {
    const made: Notice = { ...notice, id: `note_${deps.newId()}`, at: deps.now() };
    await kv.set(NOTICE + made.id, made);
    return made;
  };

  // ---- making and deleting ------------------------------------------------

  /** Check a rule as typed, and for a directory, where it really is on the machine of the thread it is for. */
  const checkedRule = async (draft: RuleDraft, threadId: string | null): Promise<Rule> => {
    const places = await deps.places();
    const read = readRule(draft, places);
    if (!read.ok) throw new Refusal("rule_refused", read.error);
    const rule = read.value;
    if (rule.kind === "dir" && threadId !== null) {
      const real = (await deps.resolve(threadId, [rule.dir]))?.get(rule.dir);
      const path = real === undefined ? null : readPath(real);
      if (path?.ok && path.path !== rule.dir) {
        const refused = directoryRefusal(path.segments, places);
        if (refused !== null) throw new Refusal("rule_refused", `that directory is refused: it resolves through a symbolic link to ${path.path}, and ${refused}`);
      }
    }
    return rule;
  };

  const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const create: Caps["create"] = (input) =>
    locked("capabilities", async () => {
      const name = readName(input.name);
      if (!name.ok) throw new Refusal("bad_capability", name.error);
      const note = readNote(input.note);
      if (!note.ok) throw new Refusal("bad_capability", note.error);
      if (!(await deps.thread(input.scope.threadId))) throw new Refusal("thread_not_found", `there is no thread ${input.scope.threadId} for it to apply to`);
      const rule = await checkedRule(input.rule, input.scope.threadId);
      const all = await capabilities();
      const active = all.filter(isActive);
      if (active.length >= MAX_CAPABILITIES) throw new Refusal("too_many", `there are already ${active.length} capabilities: delete some first`);
      const clash = active.find((other) => sameName(other.name, name.value));
      if (clash) throw new Refusal("name_taken", `a capability is already named “${clash.name}”: names are what the log and each line say, so each must differ`);
      const made: Capability = {
        id: `cap_${deps.newId()}`,
        name: name.value,
        note: note.value,
        rule,
        scope: input.scope,
        createdAt: deps.now(),
        via: input.via,
        sourceThreadId: input.sourceThreadId,
        askId: input.askId,
        deletedAt: null,
        uses: 0,
        lastUsedAt: null,
      };
      const title = await titleOf(made.scope.threadId);
      const summary = addedText(made, "added", () => title);
      // Logged before it is in force: nothing can be allowed by a capability the log does not hold.
      await append({ kind: "created", capabilityId: made.id, name: made.name, summary, via: made.via, sourceThreadId: made.sourceThreadId });
      await notify({ kind: "capability", capabilityId: made.id, threadId: null, text: summary });
      await kv.set(CAP + made.id, made);
      deps.changed();
      return made;
    });

  const remove: Caps["remove"] = (id) =>
    locked("capabilities", async () => {
      const found = await capability(id);
      if (!isActive(found)) throw new Refusal("already_deleted", `“${found.name}” is already deleted`);
      const deleted = { ...found, deletedAt: deps.now() };
      await kv.set(CAP + id, deleted);
      await append({ kind: "deleted", capabilityId: id, name: found.name });
      deps.changed();
      return deleted;
    });

  const restore: Caps["restore"] = (id) =>
    locked("capabilities", async () => {
      const found = await capability(id);
      if (isActive(found)) throw new Refusal("not_deleted", `“${found.name}” is not deleted`);
      if (!(await deps.thread(found.scope.threadId))) throw new Refusal("thread_not_found", `the thread “${found.name}” applied to no longer exists`);
      // The refusals may have changed since it was made, and so may where its directory really is.
      await checkedRule(ruleDraft(found.rule), found.scope.threadId);
      const clash = (await capabilities()).find((other) => isActive(other) && sameName(other.name, found.name));
      if (clash) throw new Refusal("name_taken", `another capability is now named “${clash.name}”: delete that one first`);
      const title = await titleOf(found.scope.threadId);
      const summary = addedText(found, "restored", () => title);
      await append({ kind: "restored", capabilityId: id, name: found.name, summary });
      await notify({ kind: "capability", capabilityId: id, threadId: null, text: summary });
      const restored = { ...found, deletedAt: null };
      await kv.set(CAP + id, restored);
      deps.changed();
      return restored;
    });

  const acknowledge: Caps["acknowledge"] = (noticeId) =>
    locked(`notice:${noticeId}`, async () => {
      const found = /^note_[a-z0-9]{1,40}$/.test(noticeId) ? noticeSchema.safeParse(await kv.get(NOTICE + noticeId)) : null;
      if (!found?.success) throw new Refusal("notice_not_found", `there is no notice ${noticeId} to acknowledge`);
      const notice = found.data;
      await append({ kind: "acknowledged", noticeId, capabilityId: notice.capabilityId, threadId: notice.threadId, summary: notice.text });
      await kv.delete(NOTICE + noticeId);
      deps.changed();
      return notice;
    });

  // ---- allowing a request -------------------------------------------------

  /** What a request asks for, read from bb's interaction; null for a kind no rule covers. */
  const requestOf = async (threadId: string, raw: unknown): Promise<{ id: string; what: string; request: Request | null; allowOnce: boolean } | null> => {
    const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    const payload = r && typeof r.payload === "object" && r.payload !== null ? (r.payload as Record<string, unknown>) : null;
    if (!r || typeof r.id !== "string" || r.status !== "pending" || payload?.kind !== "approval") return null;
    const ask = toAskDetail(raw);
    const fallback = permissionSummary(payload).replace(/^permission to /, "");
    if (ask?.kind !== "permission") return { id: r.id, what: fallback, request: null, allowOnce: false };
    const allowOnce = ask.options.some((option) => option.action === "allow_once");
    if (ask.subject.kind === "command") {
      const request: Request = { kind: "command", command: ask.subject.command };
      return { id: r.id, what: requestText(request), request, allowOnce };
    }
    const paths = await deps.changedPaths(threadId, ask.itemId).catch(() => []);
    if (paths.length === 0) return { id: r.id, what: fallback, request: null, allowOnce };
    const request: Request = { kind: "file_change", paths };
    return { id: r.id, what: requestText(request), request, allowOnce };
  };

  /** The first capability that covers a request for a thread, and whether links could be followed. */
  const covering = async (threadId: string, request: Request): Promise<{ capability: Capability; links: "followed" | "not-followed" | "none" } | null> => {
    const candidates = held(await capabilities(), threadId, await deps.ancestors(threadId));
    if (candidates.length === 0) return null;
    const places = await deps.places();
    for (const { capability: candidate } of candidates) {
      const { rule } = candidate;
      if (!covers(rule, request).covered) continue;
      if (rule.kind !== "dir" || request.kind !== "file_change") return { capability: candidate, links: "none" };
      // A rule stored before a refusal was added to the list must not outlive it.
      const dir = readPath(rule.dir);
      if (!dir.ok || directoryRefusal(dir.segments, places) !== null) continue;
      const resolved = await deps.resolve(threadId, [rule.dir, ...request.paths]).catch(() => null);
      if (coversResolved(rule.dir, request.paths, resolved, places).covered) return { capability: candidate, links: resolved === null ? "not-followed" : "followed" };
    }
    return null;
  };

  const raised: Caps["raised"] = async (threadId, raw) => {
    const read = await requestOf(threadId, raw).catch(() => null);
    if (read === null) return null;
    return locked(`interaction:${read.id}`, async () => {
      // Remembered whatever happens next, so that a decision made somewhere else can be told from cow's own.
      const known = pendingSchema.safeParse(await kv.get(PENDING + read.id));
      if (!known.success) await kv.set(PENDING + read.id, { interactionId: read.id, threadId, what: read.what, at: deps.now() } satisfies Pending);
      if (read.request === null || !read.allowOnce) return null;
      if ((await kv.get(OWN + read.id)) !== undefined) return null;
      const found = await covering(threadId, read.request);
      if (found === null) return null;
      // It must still be in force at the moment of answering.
      const now = capabilitySchema.safeParse(await kv.get(CAP + found.capability.id));
      if (!now.success || !isActive(now.data) || JSON.stringify(now.data.rule) !== JSON.stringify(found.capability.rule) || JSON.stringify(now.data.scope) !== JSON.stringify(found.capability.scope)) return null;
      await kv.set(OWN + read.id, { by: "capability", at: deps.now() });
      try {
        await deps.decide(threadId, read.id, { decision: "allow_once", grantedPermissions: null });
      } catch (cause) {
        await kv.delete(OWN + read.id);
        deps.warn(`could not allow ${read.id} through “${now.data.name}”: ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }
      const at = deps.now();
      await append({ kind: "auto-allowed", threadId, interactionId: read.id, capabilityId: now.data.id, name: now.data.name, what: read.what, links: found.links });
      const used = await locked("capabilities", async () => {
        const fresh = capabilitySchema.safeParse(await kv.get(CAP + now.data.id));
        const next = { ...(fresh.success ? fresh.data : now.data), uses: (fresh.success ? fresh.data.uses : now.data.uses) + 1, lastUsedAt: at };
        await kv.set(CAP + next.id, next);
        return next;
      });
      const before = useSchema.safeParse(await kv.get(USE + threadId));
      await kv.set(USE + threadId, { count: (before.success ? before.data.count : 0) + 1, lastAt: at, capabilityId: used.id, name: used.name, what: read.what } satisfies Use);
      deps.changed();
      return used;
    });
  };

  const decideOnPage: Caps["decideOnPage"] = async (threadId, interactionId, resolution) => {
    await locked(`interaction:${interactionId}`, async () => {
      const known = pendingSchema.safeParse(await kv.get(PENDING + interactionId));
      await kv.set(OWN + interactionId, { by: "page", at: deps.now() });
      try {
        await deps.decide(threadId, interactionId, resolution);
      } catch (cause) {
        await kv.delete(OWN + interactionId);
        throw new Refusal("not_decided", cause instanceof Error ? cause.message : String(cause));
      }
      await append({ kind: "decided", threadId, interactionId, decision: resolution.decision, what: known.success ? known.data.what : "a permission request" });
      // Only a request cow is watching is looked at again; for any other there is nothing left to tell apart.
      if (!known.success) await kv.delete(OWN + interactionId);
    });
    deps.changed();
  };

  const settleOne = (pending: Pending): Promise<void> =>
    locked(`interaction:${pending.interactionId}`, async () => {
      const state = await deps.interaction(pending.threadId, pending.interactionId);
      if (state.status === "pending") return;
      const own = (await kv.get(OWN + pending.interactionId)) !== undefined;
      await kv.delete(PENDING + pending.interactionId);
      await kv.delete(OWN + pending.interactionId);
      // A request that ended with no decision (its turn was stopped) was neither allowed nor denied by anyone.
      if (own || state.status === "gone") return;
      const text = outsideText(state.decision, pending.what);
      await append({ kind: "outside", threadId: pending.threadId, interactionId: pending.interactionId, decision: state.decision, what: pending.what });
      await notify({ kind: "outside", capabilityId: null, threadId: pending.threadId, text });
      deps.changed();
    });

  const settle: Caps["settle"] = async (threadId) => {
    for (const pending of await readAll(PENDING, pendingSchema)) {
      if (threadId !== undefined && pending.threadId !== threadId) continue;
      await settleOne(pending).catch((cause: unknown) => deps.warn(`could not read what became of ${pending.interactionId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  };

  return {
    create,
    remove,
    restore,
    acknowledge,
    raised,
    settle,
    decideOnPage,

    async state() {
      const uses: Record<string, Use> = {};
      for (const key of await kv.list(USE)) {
        const use = useSchema.safeParse(await kv.get(key));
        if (use.success) uses[key.slice(USE.length)] = use.data;
      }
      const notices = (await readAll(NOTICE, noticeSchema)).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      return { capabilities: await capabilities(), notices, uses, places: await deps.places() };
    },

    async log(filter = {}) {
      const all = await loadLog();
      const head = z.object({ seq: z.number(), hash: z.string() }).safeParse(await kv.get(LOG_HEAD));
      const check = checkChain(all, deps.hash, head.success ? head.data : null);
      const wanted = filter.capabilityId === undefined ? all : all.filter((entry) => entryCapability(entry.event) === filter.capabilityId);
      const limit = Math.max(1, Math.min(filter.limit ?? MAX_LOG_PAGE, MAX_LOG_PAGE));
      return { entries: wanted.slice(-limit).reverse(), total: wanted.length, check };
    },

    async heldBy(threadId) {
      return held(await capabilities(), threadId, await deps.ancestors(threadId));
    },

    checkRule: (rule) => checkedRule(rule, null),

    async requested(threadId, askId, rule) {
      await append({ kind: "requested", threadId, askId, what: `${rule.kind === "dir" ? "write under" : rule.mode === "exact" ? "run" : "run commands beginning"} ${ruleText(rule)}` });
      deps.changed();
    },

    async forget(threadId) {
      await kv.delete(USE + threadId);
      for (const pending of await readAll(PENDING, pendingSchema)) {
        if (pending.threadId !== threadId) continue;
        await kv.delete(PENDING + pending.interactionId);
        await kv.delete(OWN + pending.interactionId);
      }
    },
  };
}
