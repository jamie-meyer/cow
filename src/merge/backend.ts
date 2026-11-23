// cow's server keeps each finished worker's merge-readiness: asked for by
// the page (and `bb cow status`) for threads that have finished a turn, and
// worked out by the host entry on the checkout's machine. It is looked at
// again at most every CHECK_MS for one environment, and the answer is worked
// out again only when the branch's tip or the base's tip has moved: the host
// entry is given the last answer, keyed by the two commit ids, and gives it
// back as it was while both stand still. One call per environment at a time;
// a failure or a timeout reads as not known, never as clean.

import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cloneHostContract } from "../clone/contract.ts";
import { MERGE_CHANGED, type MergeFacts, mergeFactsSchema } from "./text.ts";

/** One environment's tips are looked at again after this long, at the soonest. */
export const CHECK_MS = 30_000;
/** Which environment a thread is in is asked again after this long. */
const ENV_MS = 60_000;
/** How many environments are looked at at once, across repositories. */
const AT_ONCE = 3;

export interface MergeEnvironment {
  id: string;
  hostId: string;
  path: string;
  baseBranch: string | null;
  defaultBranch: string | null;
}

export interface MergeDeps {
  /** The thread's environment when it is a git checkout cow can look at; null for none. */
  environmentOf: (threadId: string) => Promise<MergeEnvironment | null>;
  /** The host entry's answer: never throws for a git failure, may for a host that does not answer. */
  compute: (environment: MergeEnvironment, known: MergeFacts | null) => Promise<MergeFacts>;
  now: () => number;
  /** Something the page shows changed. */
  changed: () => void;
}

export interface MergeWatch {
  /** What is known for these threads now; those due are looked at in the background. */
  read: (threadIds: readonly string[]) => Record<string, MergeFacts>;
  /** What is known for these threads now, starting nothing. */
  peek: (threadIds: readonly string[]) => Record<string, MergeFacts>;
  /** The same, once those due have been looked at, waiting at most `ms`. */
  settled: (threadIds: readonly string[], ms: number) => Promise<Record<string, MergeFacts>>;
}

const notKnown = (why: string, now: number, before: MergeFacts | null): MergeFacts => ({
  state: "unknown",
  why,
  base: before?.base ?? null,
  branch: before?.branch ?? null,
  ahead: null,
  behind: null,
  conflicts: [],
  conflictCount: 0,
  dirty: null,
  head: null,
  baseTip: null,
  at: now,
  checkedAt: now,
  clone: before?.clone ?? false,
});

const same = (a: MergeFacts | null, b: MergeFacts): boolean =>
  a !== null &&
  a.state === b.state &&
  a.ahead === b.ahead &&
  a.behind === b.behind &&
  a.dirty === b.dirty &&
  a.base === b.base &&
  a.why === b.why &&
  a.at === b.at &&
  a.conflicts.join("\0") === b.conflicts.join("\0");

export function createMergeWatch(deps: MergeDeps, checkMs = CHECK_MS): MergeWatch {
  const environments = new Map<string, { at: number; found: Promise<MergeEnvironment | null> }>();
  /** By environment: the last answer, when it was asked for, and the look in flight. */
  const kept = new Map<string, { facts: MergeFacts | null; askedAt: number; running: Promise<void> | null }>();
  /** The environment each thread was last found in. */
  const threadEnv = new Map<string, string | null>();
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    if (active >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    active += 1;
  };
  const free = () => {
    active -= 1;
    waiting.shift()?.();
  };

  const environmentOf = (threadId: string): Promise<MergeEnvironment | null> => {
    const now = deps.now();
    const cached = environments.get(threadId);
    if (cached && now - cached.at < ENV_MS) return cached.found;
    const found = deps.environmentOf(threadId).catch(() => null);
    environments.set(threadId, { at: now, found });
    return found;
  };

  const look = (threadId: string): Promise<void> =>
    environmentOf(threadId).then(async (environment) => {
      const before = threadEnv.get(threadId);
      threadEnv.set(threadId, environment?.id ?? null);
      if (environment === null) {
        if (before) deps.changed();
        return;
      }
      const entry = kept.get(environment.id) ?? { facts: null, askedAt: 0, running: null };
      kept.set(environment.id, entry);
      if (entry.running) return entry.running;
      if (entry.facts !== null && deps.now() - entry.askedAt < checkMs) return;
      entry.askedAt = deps.now();
      entry.running = (async () => {
        await slot();
        try {
          const facts = await deps.compute(environment, entry.facts).catch((cause: unknown) => notKnown(`cow's host entry did not answer: ${cause instanceof Error ? cause.message.slice(0, 160) : "no reason given"}`, deps.now(), entry.facts));
          const changed = !same(entry.facts, facts);
          entry.facts = facts;
          if (changed) deps.changed();
        } finally {
          free();
          entry.running = null;
        }
      })();
      return entry.running;
    });

  const known = (threadIds: readonly string[]): Record<string, MergeFacts> => {
    const out: Record<string, MergeFacts> = {};
    for (const threadId of threadIds) {
      const environmentId = threadEnv.get(threadId);
      const facts = environmentId ? kept.get(environmentId)?.facts : null;
      if (facts) out[threadId] = facts;
    }
    return out;
  };

  return {
    read: (threadIds) => {
      for (const threadId of threadIds) void look(threadId).catch(() => undefined);
      return known(threadIds);
    },
    peek: known,
    settled: async (threadIds, ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(threadIds.map((threadId) => look(threadId).catch(() => undefined))), new Promise((done) => (timer = setTimeout(done, ms)))]);
      clearTimeout(timer);
      return known(threadIds);
    },
  };
}

const id = z.string().min(1).max(200);

export const mergeRpcContract = defineRpcContract({
  /**
   * Merge-readiness of these threads, the page's finished workers: what is
   * known now. Those due are looked at in the background, and the realtime
   * event MERGE_CHANGED says when an answer changed. Only reads.
   */
  merge_read: {
    input: z.object({ threadIds: z.array(id).max(500) }),
    output: z.record(z.string(), mergeFactsSchema),
  },
});

/** How long the host entry's answer may take, its own limit of 15 s per repository included. */
const HOST_MS = 25_000;

/** The watch on bb: the page's `merge_read`, and what the card and `bb cow status` read. */
export function registerMerge(bb: BbPluginApi): MergeWatch {
  const host = bb.hosts.experimental_client({ contract: cloneHostContract });
  let publish: ReturnType<typeof setTimeout> | null = null;
  const watch = createMergeWatch({
    environmentOf: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.environmentId) return null;
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null);
      // Nothing at all for a folder that is not a git checkout, or one bb has removed.
      if (environment === null || environment.path === null || !environment.isGitRepo || environment.status === "destroyed" || environment.lifecycle.phase !== "active") return null;
      return { id: environment.id, hostId: environment.hostId, path: environment.path, baseBranch: environment.baseBranch, defaultBranch: environment.defaultBranch };
    },
    compute: (environment, known) =>
      host.call("merge_facts", { path: environment.path, baseBranch: environment.baseBranch, defaultBranch: environment.defaultBranch, known }, { hostId: environment.hostId, timeoutMs: HOST_MS }),
    now: Date.now,
    // A burst of answers is one event.
    changed: () => {
      publish ??= setTimeout(() => {
        publish = null;
        void Promise.resolve(bb.realtime.publish(MERGE_CHANGED, {})).catch(() => undefined);
      }, 250);
    },
  });
  bb.onDispose(() => {
    if (publish) clearTimeout(publish);
  });
  bb.rpc.register(mergeRpcContract, { merge_read: ({ threadIds }) => watch.read(threadIds) });
  return watch;
}
