// Worker rules: a thread whose first message begins with the line
// `WORKER BRIEF` is a worker, and its agent is given the text of
// rules/worker.md as part of its instructions, from its first turn on.
//
// The fact is recognised when the first message is dispatched and kept in
// cow's own storage, so the synchronous instructions callback can read it,
// after a restart too. Only text is given: nothing here enforces anything.
// The whole piece is this file, the rule file and a few lines in server.ts;
// the workerRules setting turns it off.
import { readFileSync } from "node:fs";
import type { Kv } from "./kv.ts";

/** The line that makes a thread a worker, alone on the first non-empty line of its first message. */
export const WORKER_LINE = "WORKER BRIEF";
const KEY_PREFIX = "worker-rules:";

/** Whether this message's first non-empty line is exactly `line` (surrounding spaces aside). */
export function firstLineIs(text: string, line: string): boolean {
  for (const each of text.split(/\r?\n/)) {
    const trimmed = each.trim();
    if (trimmed !== "") return trimmed === line;
  }
  return false;
}

/** Whether this message's first non-empty line is exactly `WORKER BRIEF` (surrounding spaces aside). */
export const isWorkerBrief = (text: string): boolean => firstLineIs(text, WORKER_LINE);

/** The rules, with this machine's own text after them when there is any. */
export function rulesWith(rules: string, extra: string): string {
  const more = extra.trim();
  return more === "" ? rules.trim() : `${rules.trim()}\n\n${more}`;
}

/** Read the shipped rule file; null (and nothing given) when it cannot be read. */
export function readRules(url: URL): string | null {
  try {
    const text = readFileSync(url, "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

/** The threads recognised as workers, held in memory for the synchronous callback and kept in the plugin's storage. */
export interface WorkerStore {
  load(): Promise<void>;
  has(threadId: string): boolean;
  record(threadId: string, at: number): Promise<void>;
  forget(threadId: string): Promise<void>;
}

export function createWorkerStore(kv: Kv): WorkerStore {
  const known = new Set<string>();
  return {
    async load() {
      for (const key of await kv.list(KEY_PREFIX)) known.add(key.slice(KEY_PREFIX.length));
    },
    has: (threadId) => known.has(threadId),
    async record(threadId, at) {
      // In memory first: the first turn's instructions are resolved right after the hook answers.
      known.add(threadId);
      await kv.set(`${KEY_PREFIX}${threadId}`, { at });
    },
    async forget(threadId) {
      known.delete(threadId);
      await kv.delete(`${KEY_PREFIX}${threadId}`);
    },
  };
}

export interface WorkerSettings {
  enabled: boolean;
  extra: string;
}

/** What the dispatch hook reads of a message: enough to tell a thread's first message. */
export interface DispatchFacts {
  threadId: string;
  /** The thread's status: `pending` until its first turn has started. */
  status: string;
  attempt: "start-turn" | "join-turn";
  initiator: string;
  text: string;
}

export interface WorkerRulesDeps {
  store: WorkerStore;
  /** The rule file's text, or null when it could not be read. */
  rules: string | null;
  /** The settings as last read: the callback is synchronous. */
  settings: () => WorkerSettings;
  now: () => number;
  warn: (text: string) => void;
}

export function createWorkerRules(deps: WorkerRulesDeps) {
  const gave = (threadId: string): boolean => deps.settings().enabled && deps.rules !== null && deps.store.has(threadId);
  return {
    /** Whether cow gives this thread the worker rules. */
    gave,
    /** The instructions callback's answer: the rules for a recorded worker, nothing for any other thread. */
    instructions(threadId: string): string | null {
      return gave(threadId) ? rulesWith(deps.rules!, deps.settings().extra) : null;
    },
    /**
     * Before a message reaches the agent: a thread's first message that is a
     * worker brief is recorded. It always lets the message through, at once
     * when recording fails.
     */
    async dispatch(facts: DispatchFacts): Promise<{ action: "proceed" }> {
      const failed = (cause: unknown) => {
        try {
          deps.warn(`could not record ${facts.threadId} as a worker: ${String(cause)}`);
        } catch {
          // Nothing more to do: the message goes through either way.
        }
      };
      try {
        if (!deps.settings().enabled) return { action: "proceed" };
        const first = facts.status === "pending" && facts.attempt === "start-turn" && facts.initiator !== "system";
        // Kept in memory at once; the write to storage is not waited for, so the message is never held up by it.
        if (first && !deps.store.has(facts.threadId) && isWorkerBrief(facts.text)) void deps.store.record(facts.threadId, deps.now()).catch((cause: unknown) => failed(cause));
      } catch (cause) {
        failed(cause);
      }
      return { action: "proceed" };
    },
  };
}
export type WorkerRules = ReturnType<typeof createWorkerRules>;
