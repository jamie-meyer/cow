// Capabilities, wired to bb: where a request's files are read from, how a
// path's symbolic links are followed, how bb is answered, the events that
// start all of it, and the RPC the page uses.
//
// bb serves a plugin's RPC to any local caller and does not say who it is.
// So nothing here trusts a caller: every method that changes anything goes
// through the service, which logs it and raises a notice.

import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { fileChanges } from "../permission.ts";
import { CAPS_CHANGED } from "./cap.ts";
import { logEntrySchema } from "./log.ts";
import type { LogStore } from "./logstore.ts";
import type { Resolved } from "./match.ts";
import { readPath } from "./paths.ts";
import { type Caps, type InteractionState, MAX_LOG_PAGE, capStateSchema, chainCheckSchema, createCaps } from "./service.ts";

const id = z.string().min(1).max(200);

/**
 * What anyone may read. Nothing here changes anything: making, deleting,
 * restoring and acknowledging, and deciding a request, are the person's, and
 * are reached only as signed calls (see ../signing/backend.ts).
 */
export const capsRpcContract = defineRpcContract({
  /** Every capability, the notices not yet acknowledged, what capabilities have allowed on each thread, and where the refused places are. */
  caps_state: { input: z.null(), output: capStateSchema },
  /** The log, newest first; with `capabilityId`, one capability's history. */
  caps_log: {
    input: z.object({ limit: z.number().int().min(1).max(MAX_LOG_PAGE).optional(), capabilityId: id.optional() }),
    output: z.object({ entries: z.array(logEntrySchema), total: z.number(), check: chainCheckSchema }),
  },
});

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A path with the symbolic links in it followed, on this machine. What does
 * not exist yet cannot be a link: the deepest part that exists is resolved
 * and the rest is kept as written.
 */
export async function followLinks(path: string, real: (path: string) => Promise<string> = realpath): Promise<string | null> {
  const read = readPath(path);
  if (!read.ok) return null;
  for (let keep = read.segments.length; keep >= 0; keep -= 1) {
    const head = `/${read.segments.slice(0, keep).join("/")}`;
    try {
      const resolved = await real(head);
      const rest = read.segments.slice(keep);
      return rest.length === 0 ? resolved : `${resolved.replace(/\/+$/, "")}/${rest.join("/")}`;
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      // Only "there is no such thing" means try the directory above; anything else is not knowing.
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
  }
  return null;
}

/** What a request has come to, read from its lifecycle events, newest first. */
export function interactionState(events: readonly unknown[], interactionId: string): InteractionState | null {
  let newest: { seq: number; state: InteractionState } | null = null;
  for (const raw of events) {
    const event = record(raw);
    const interaction = record(record(event?.data)?.interaction);
    if (!event || !interaction || interaction.id !== interactionId) continue;
    const seq = typeof event.seq === "number" ? event.seq : 0;
    if (newest !== null && newest.seq > seq) continue;
    const decision = record(interaction.resolution)?.decision;
    const state: InteractionState =
      interaction.status === "pending" || interaction.status === "resolving"
        ? { status: "pending" }
        : interaction.status === "resolved" && typeof decision === "string"
          ? { status: "decided", decision }
          : { status: "gone" };
    newest = { seq, state };
  }
  return newest?.state ?? null;
}

export function registerCaps(bb: BbPluginApi, log: LogStore): Caps {
  const changed = () => bb.realtime.publish(CAPS_CHANGED, {});
  const threadOf = async (threadId: string) => {
    const [found] = await bb.sdk.threads.list({ threadIds: [threadId], limit: 1, includeHidden: true });
    return found && found.deletedAt == null ? found : null;
  };

  /** Whether a thread runs on the machine this server runs on: the only place this code can look at files. */
  const onThisMachine = async (threadId: string): Promise<boolean> => {
    const thread = await threadOf(threadId);
    if (!thread?.environmentId) return false;
    const [environment, config] = await Promise.all([bb.sdk.environments.get({ environmentId: thread.environmentId }), bb.sdk.system.config()]);
    const here = (config as { primaryHostId?: unknown }).primaryHostId;
    return typeof here === "string" && environment.hostId === here;
  };

  const caps = createCaps({
    kv: bb.storage.kv,
    now: Date.now,
    newId: () => randomUUID().replace(/-/g, "").slice(0, 10),
    log,
    places: async () => ({ home: homedir() || null, dataDir: bb.server.experimental_dataDir || null }),
    thread: async (threadId) => {
      const found = await threadOf(threadId);
      return found ? { title: (typeof found.title === "string" && found.title.trim()) || threadId } : null;
    },
    ancestors: async (threadId) => (await bb.sdk.threads.experimental_listAncestors({ threadIds: [threadId] })).threads.find((entry) => entry.threadId === threadId)?.ancestorIds ?? [],
    changedPaths: async (threadId, itemId) => {
      // The request is raised a moment before the change it is about reaches the timeline.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const timeline = await bb.sdk.threads.timeline({ threadId });
        const paths = fileChanges((timeline as { rows?: unknown[] }).rows ?? [], itemId).map((change) => change.path);
        if (paths.length > 0) return paths;
        await wait(350);
      }
      return [];
    },
    resolve: async (threadId, paths): Promise<Resolved> => {
      if (!(await onThisMachine(threadId).catch(() => false))) return null;
      const found = new Map<string, string>();
      for (const path of paths) {
        const real = await followLinks(path);
        if (real === null) return null;
        found.set(path, real);
      }
      return found;
    },
    decide: async (threadId, interactionId, resolution) => {
      await bb.sdk.threads.interactions.resolve({ threadId, interactionId, resolution });
    },
    interaction: async (threadId, interactionId) => {
      const events = await bb.sdk.threads.events.list({ threadId, limit: "100", order: "desc", types: ["system/interaction/lifecycle"] as never });
      const state = interactionState(events, interactionId);
      if (state !== null) return state;
      const pending = await bb.sdk.threads.interactions.list({ threadId });
      return pending.some((entry) => entry.id === interactionId && entry.status === "pending") ? { status: "pending" } : { status: "gone" };
    },
    changed,
    warn: (message) => bb.log.warn(message),
  });

  bb.rpc.register(capsRpcContract, {
    caps_state: () => caps.state(),
    caps_log: (filter) => caps.log({ ...(filter.limit === undefined ? {} : { limit: filter.limit }), ...(filter.capabilityId === undefined ? {} : { capabilityId: filter.capabilityId }) }),
  });

  const quietly = (what: string) => (cause: unknown) => bb.log.warn(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);

  /** The threads with a request cow is watching: only their events are worth a look. */
  let watched = new Set<string>();
  const rewatch = () => caps.watching().then((ids) => void (watched = new Set(ids)));
  const look = (threadId?: string) =>
    caps
      .settle(threadId)
      .then(rewatch)
      .catch(quietly("could not look at decided requests"));

  // A request raised: allowed at once when a capability covers it, and watched either way.
  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    watched.add(thread.id);
    void caps.raised(thread.id, interaction).catch(quietly(`could not look at the request ${interaction.id}`));
  });

  // A watched request that is no longer pending was decided by someone: cow, or not.
  // bb says a request was decided in the thread's events, a moment after it stops being pending.
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (typeof event.id !== "string" || !watched.has(event.id)) return;
      const threadId = event.id;
      clearTimeout(settling.get(threadId));
      settling.set(
        threadId,
        setTimeout(() => {
          settling.delete(threadId);
          void look(threadId);
        }, 400),
      );
    },
  });
  // Events can be missed (a reconnect, a reload); the watched requests are looked at again every so often.
  const sweep = setInterval(() => void look(), 20_000);

  // What was raised while cow was not running is looked at when it loads.
  const catchUp = setTimeout(() => {
    void (async () => {
      for (let offset = 0; offset < 5000; offset += 200) {
        const page = await bb.sdk.threads.list({ limit: 200, offset });
        for (const thread of page) {
          if (thread.hasPendingInteraction !== true || thread.deletedAt != null) continue;
          for (const interaction of await bb.sdk.threads.interactions.list({ threadId: thread.id })) await caps.raised(thread.id, interaction);
        }
        if (page.length < 200) break;
      }
      await look();
    })().catch(quietly("could not catch up on permission requests"));
  }, 2500);

  bb.events.on("thread.deleted", ({ thread }) => void caps.forget(thread.id).catch(() => undefined));
  bb.onDispose(() => {
    unsubscribe();
    clearInterval(sweep);
    clearTimeout(catchUp);
    for (const timer of settling.values()) clearTimeout(timer);
  });

  return caps;
}
