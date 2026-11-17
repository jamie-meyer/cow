// Capabilities, wired to bb: where a request's files are read from, how a
// path's symbolic links are followed, how bb is answered, the events that
// start all of it, and the RPC the page uses.
//
// bb serves a plugin's RPC to any local caller and does not say who it is.
// So nothing here trusts a caller: every method that changes anything goes
// through the service, which logs it and raises a notice.

import { type BbPluginApi, defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { Refusal } from "../kv.ts";
import { fileChanges } from "../permission.ts";
import { CAPS_CHANGED, CAP_LIMITS, VIAS, capabilitySchema, scopeSchema } from "./cap.ts";
import { logEntrySchema } from "./log.ts";
import type { Resolved } from "./match.ts";
import { readPath } from "./paths.ts";
import { type Caps, type InteractionState, MAX_LOG_PAGE, capStateSchema, chainCheckSchema, createCaps } from "./service.ts";

const id = z.string().min(1).max(200);
const ruleDraftSchema = z.union([
  z.object({ kind: z.literal("dir"), text: z.string().max(5000) }),
  z.object({ kind: z.literal("command"), mode: z.enum(["exact", "prefix"]), text: z.string().max(5000) }),
]);
const grantSchema = z.object({
  fileSystem: z.object({ read: z.array(z.string()), write: z.array(z.string()) }).nullable(),
  network: z.object({ enabled: z.boolean().nullable() }).nullable(),
});
const resolutionSchema = z.union([
  z.object({ decision: z.literal("allow_once"), grantedPermissions: z.null() }),
  z.object({ decision: z.literal("allow_for_session"), grantedPermissions: grantSchema }),
  z.object({ decision: z.literal("deny") }),
]);

/**
 * What the page calls. There is no CLI command and no agent tool for any of
 * the methods that change something: making, deleting and acknowledging are
 * the person's, on the page.
 */
export const capsRpcContract = defineRpcContract({
  /** Every capability, the notices not yet acknowledged, what capabilities have allowed on each thread, and where the refused places are. */
  caps_state: { input: z.null(), output: capStateSchema },
  cap_create: {
    input: z.object({
      name: z.string().max(CAP_LIMITS.name * 4),
      note: z.string().max(CAP_LIMITS.note * 4).nullable(),
      rule: ruleDraftSchema,
      scope: scopeSchema,
      via: z.enum(VIAS),
      sourceThreadId: id.nullable(),
      askId: id.nullable(),
    }),
    output: capabilitySchema,
  },
  cap_delete: { input: z.object({ id }), output: capabilitySchema },
  cap_restore: { input: z.object({ id }), output: capabilitySchema },
  cap_ack: { input: z.object({ noticeId: id }), output: z.null() },
  /** The log, newest first; with `capabilityId`, one capability's history. */
  caps_log: {
    input: z.object({ limit: z.number().int().min(1).max(MAX_LOG_PAGE).optional(), capabilityId: id.optional() }),
    output: z.object({ entries: z.array(logEntrySchema), total: z.number(), check: chainCheckSchema }),
  },
  /** Answer one of bb's permission requests as decided on the page, so cow knows the decision was made through it. */
  permission_decide: {
    input: z.object({ threadId: id, interactionId: id, resolution: resolutionSchema }),
    output: z.null(),
  },
});

const REFUSAL_CODES: Record<string, "conflict" | "invalid" | "not_found"> = {
  capability_not_found: "not_found",
  notice_not_found: "not_found",
  thread_not_found: "not_found",
  name_taken: "conflict",
  already_deleted: "conflict",
  not_deleted: "conflict",
  not_decided: "conflict",
};

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Refusal) throw new experimental_PluginRpcRefusal({ code: REFUSAL_CODES[cause.code] ?? "invalid", message: cause.message });
    throw cause;
  }
}

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

export function registerCaps(bb: BbPluginApi): Caps {
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
    hash: (text) => createHash("sha256").update(text).digest("hex"),
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
    cap_create: (input) => refusing(() => caps.create(input)),
    cap_delete: ({ id: capabilityId }) => refusing(() => caps.remove(capabilityId)),
    cap_restore: ({ id: capabilityId }) => refusing(() => caps.restore(capabilityId)),
    cap_ack: async ({ noticeId }) => {
      await refusing(() => caps.acknowledge(noticeId));
      return null;
    },
    caps_log: (filter) => caps.log({ ...(filter.limit === undefined ? {} : { limit: filter.limit }), ...(filter.capabilityId === undefined ? {} : { capabilityId: filter.capabilityId }) }),
    permission_decide: async ({ threadId, interactionId, resolution }) => {
      await refusing(() => caps.decideOnPage(threadId, interactionId, resolution));
      return null;
    },
  });

  const quietly = (what: string) => (cause: unknown) => bb.log.warn(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);

  // A request raised: allowed at once when a capability covers it, and watched either way.
  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    void caps.raised(thread.id, interaction).catch(quietly(`could not look at the request ${interaction.id}`));
  });

  // A watched request that is no longer pending was decided by someone: cow, or not.
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (typeof event.id !== "string" || !(event.changes ?? []).includes("interactions-changed")) return;
      const threadId = event.id;
      clearTimeout(settling.get(threadId));
      settling.set(
        threadId,
        setTimeout(() => {
          settling.delete(threadId);
          void caps.settle(threadId).catch(quietly("could not look at decided requests"));
        }, 400),
      );
    },
  });
  // Events can be missed (a reconnect, a reload); the watched requests are looked at again every so often.
  const sweep = setInterval(() => void caps.settle().catch(quietly("could not look at decided requests")), 20_000);

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
      await caps.settle();
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
