// cow's server reads a thread's context card for the page: bb's own git and
// pull-request plugins, and every plugin that registered `cow_card` as a
// discoverable method. It only reads.
//
// Each source is bounded in time and contained: one that is absent, slow or
// failing leaves only its own sections out. Another plugin's answer is read
// without trusting it (see `readCardAnswer`). The calls are made from here,
// not from the page, so the other plugin sees cow as the caller, and so that
// one request from the page is one thread's whole card.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BADGE_TONES,
  BB_GIT,
  BB_PULL_REQUEST,
  BB_SOURCE,
  CARD_METHOD,
  type Card,
  type CardSection,
  type CardSource,
  changedFilesSection,
  orderSources,
  pullRequestSection,
  readCardAnswer,
} from "./card.ts";
import type { MergeWatch } from "./merge/backend.ts";
import { type MergeFacts, mergeSection } from "./merge/text.ts";

/** How long another plugin's `cow_card` may take, and bb's own reads. */
export const PLUGIN_MS = 2000;
const BB_MS = 2500;
/** Which plugins offer `cow_card` is asked again after this long. */
const DISCOVER_FRESH_MS = 15_000;

export async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the card's read needs of bb: kept narrow so it can be tested without one. */
export interface CardDeps {
  ownPluginId: string;
  environmentOf(threadId: string, signal: AbortSignal): Promise<string | null>;
  call(pluginId: string, method: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  /** The plugins that registered `cow_card`, with their names. */
  providers(signal: AbortSignal): Promise<{ pluginId: string; name: string }[]>;
  /** cow's own: whether the thread's branch merges into its base, as last worked out; null when nothing is known. */
  merge?(threadId: string): MergeFacts | null;
  now?(): number;
}

/** One thread's card. Never throws. */
export async function readCard(deps: CardDeps, threadId: string, limits = { pluginMs: PLUGIN_MS, bbMs: BB_MS }): Promise<Card> {
  const environmentId = await bounded(limits.bbMs, (signal) => deps.environmentOf(threadId, signal)).catch(() => null);
  const own = async (): Promise<CardSource> => {
    if (environmentId === null) return { pluginId: BB_SOURCE, name: "bb", sections: [] };
    const read = (target: { pluginId: string; method: string }) =>
      bounded(limits.bbMs, (signal) => deps.call(target.pluginId, target.method, { keys: [environmentId] }, signal)).catch(() => null);
    const [pr, git] = await Promise.all([read(BB_PULL_REQUEST), read(BB_GIT)]);
    const sections = [pullRequestSection(pr, environmentId), changedFilesSection(git, environmentId)].filter((section): section is CardSection => section !== null);
    return { pluginId: BB_SOURCE, name: "bb", sections };
  };
  const others = async (): Promise<CardSource[]> => {
    const providers = await bounded(limits.bbMs, (signal) => deps.providers(signal)).catch(() => []);
    return Promise.all(
      providers
        .filter((provider) => provider.pluginId !== deps.ownPluginId && provider.pluginId !== BB_SOURCE)
        .map(async (provider) => ({
          pluginId: provider.pluginId,
          name: provider.name,
          sections: readCardAnswer(await bounded(limits.pluginMs, (signal) => deps.call(provider.pluginId, CARD_METHOD, { threadId }, signal)).catch(() => null)),
        })),
    );
  };
  const [bb, rest] = await Promise.all([own(), others()]);
  const merge = mergeSection(deps.merge?.(threadId) ?? null, deps.now?.() ?? Date.now());
  const cow: CardSource = { pluginId: deps.ownPluginId, name: "cow", sections: merge ? [merge] : [] };
  return { threadId, environmentId, sources: orderSources([bb, cow, ...rest]) };
}

const rowSchema = z.object({
  text: z.string(),
  url: z.string().optional(),
  detail: z.string().optional(),
  badges: z.array(z.object({ text: z.string(), tone: z.enum(BADGE_TONES) })).optional(),
  current: z.boolean().optional(),
  indent: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  file: z.string().optional(),
});
export const cardSchema = z.object({
  threadId: z.string(),
  environmentId: z.string().nullable(),
  sources: z.array(z.object({ pluginId: z.string(), name: z.string(), sections: z.array(z.object({ title: z.string(), rows: z.array(rowSchema) })) })),
});

export const cardRpcContract = defineRpcContract({
  /** One thread's context card: bb's own sections, then each plugin's that answers `cow_card`. */
  card_read: { input: z.object({ threadId: z.string().min(1).max(200) }), output: cardSchema },
});

export function registerCard(bb: BbPluginApi, merge?: MergeWatch): void {
  let discovered: { at: number; list: Promise<{ pluginId: string; name: string }[]> } | null = null;
  const deps: CardDeps = {
    ownPluginId: bb.pluginId,
    merge: merge ? (threadId) => merge.peek([threadId])[threadId] ?? null : undefined,
    environmentOf: async (threadId, signal) => {
      const thread = await bb.sdk.threads.get({ threadId, signal });
      return thread.environmentId ?? null;
    },
    call: (pluginId, method, input, signal) => bb.sdk.plugins.callRpc({ pluginId, method, input: input as never, outputSchema: z.unknown(), signal }),
    providers: (signal) => {
      const now = Date.now();
      if (discovered && now - discovered.at < DISCOVER_FRESH_MS) return discovered.list;
      const list = bb.sdk.plugins
        .experimental_discoverRpc({ method: CARD_METHOD, signal })
        .then((methods) => {
          const byId = new Map<string, string>();
          for (const method of methods) if (method.method === CARD_METHOD && !byId.has(method.pluginId)) byId.set(method.pluginId, method.displayName || method.pluginId);
          return [...byId].map(([pluginId, name]) => ({ pluginId, name }));
        });
      // A failed discovery is asked again next time, not kept.
      discovered = { at: now, list };
      list.catch(() => {
        if (discovered?.list === list) discovered = null;
      });
      return list;
    },
  };
  bb.rpc.register(cardRpcContract, { card_read: ({ threadId }) => readCard(deps, threadId) });
}
