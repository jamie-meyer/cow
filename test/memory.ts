import type { Ask } from "../src/asks/ask.ts";
import { type AskDeps, createAsks } from "../src/asks/service.ts";
import { type BriefDeps, type CheckerSight, type CheckerSettings, createBriefs } from "../src/briefs/service.ts";
import type { Kv } from "../src/kv.ts";
import { NOW } from "./fixtures.ts";

/** Storage that lives in the test, and survives making the services again. */
export function memoryKv(): Kv & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => (data.has(key) ? (JSON.parse(JSON.stringify(data.get(key))) as T) : undefined),
    set: async (key, value) => void data.set(key, JSON.parse(JSON.stringify(value))),
    delete: async (key) => void data.delete(key),
    list: async (prefix = "") => [...data.keys()].filter((key) => key.startsWith(prefix)).sort(),
  };
}

/** A small world: main started child, child started grandchild; other is unrelated. */
export const PARENTS: Record<string, string | null> = { main: null, child: "main", grandchild: "child", other: null };

export function world(kv: Kv = memoryKv()) {
  const sent: { threadId: string; text: string }[] = [];
  const clock = { now: NOW };
  let ids = 0;
  const base = {
    kv,
    now: () => clock.now,
    newId: () => `t${(ids += 1)}`,
    ancestors: async (threadId: string) => {
      const above: string[] = [];
      for (let at = PARENTS[threadId] ?? null; at !== null; at = PARENTS[at] ?? null) above.push(at);
      return above;
    },
    storageRoot: async (threadId: string) => `/storage/${threadId}`,
    changed: () => undefined,
  };
  const failSend = { on: false };
  const askDeps: AskDeps = {
    ...base,
    thread: async (threadId) => (threadId in PARENTS ? { projectId: "proj_1" } : null),
    send: async (threadId, text) => {
      if (failSend.on) throw new Error("bb is away");
      sent.push({ threadId, text });
    },
  };
  const asks = createAsks(askDeps);

  const files = new Map<string, string>();
  const checkers = new Map<string, CheckerSight>();
  const started: { prompt: string; model: string | null; provider: string | null; environmentId: string | null }[] = [];
  const discarded: string[] = [];
  const settings: CheckerSettings = { model: null, provider: null, runs: 1, onSubmit: true };
  const briefDeps: BriefDeps = {
    ...base,
    thread: async (threadId) => (threadId in PARENTS ? { projectId: "proj_1", environmentId: "env_1" } : null),
    readEvidence: async (threadId, path) => {
      const text = files.get(`${threadId}/${path}`);
      if (text === undefined) throw new Error("no such file");
      return text;
    },
    hasAsk: (askId, threadId) =>
      asks.get(askId).then(
        (ask: Ask) => ask.threadId === threadId,
        () => false,
      ),
    settings: async () => ({ ...settings }),
    checker: {
      start: async (args) => {
        started.push(args);
        const id = `chk_${started.length}`;
        checkers.set(id, { state: "running", reply: null, tools: [] });
        return id;
      },
      look: async (threadId) => checkers.get(threadId) ?? { state: "gone", reply: null, tools: [] },
      discard: async (threadId) => void discarded.push(threadId),
    },
  };
  const briefs = createBriefs(briefDeps);
  /** Make a checker answer. */
  const reply = (id: string, text: string | null, tools: string[] = []) => checkers.set(id, { state: "idle", reply: text, tools });
  return { kv, asks, briefs, sent, clock, failSend, files, checkers, started, discarded, settings, reply };
}
