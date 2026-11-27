// Lead rules: the threads that talk with the person (a chosen Main, a thread
// marked as a project, a thread whose first message begins with the line
// `PROJECT BRIEF`) are given the text of rules/lead.md as part of their
// instructions, and not the worker rules, which say never to address the
// person.
//
// The instructions callback is synchronous, so the three facts are held in
// memory: the Mains from cow's own stored state, set when it loads and each
// time a Main is chosen; the project marks mirrored in cow's storage each
// time one is set or taken off, with the marks made before this existed
// found once by reading the threads; the PROJECT BRIEF threads recorded when
// their first message is dispatched, as workers are. Only text is given:
// nothing here enforces anything. The whole piece is this file, the rule
// file and a few lines in server.ts; the leadRules setting turns it off.
import type { Kv } from "./kv.ts";
import { type DispatchFacts, type WorkerRules, type WorkerSettings, firstLineIs, rulesWith } from "./worker-rules.ts";

/** The line that makes a thread one that talks with the person, alone on the first non-empty line of its first message. */
export const PROJECT_LINE = "PROJECT BRIEF";
const BRIEF_PREFIX = "lead-rules:brief:";
const PROJECT_PREFIX = "lead-rules:project:";

/** Whether this message's first non-empty line is exactly `PROJECT BRIEF` (surrounding spaces aside). */
export const isProjectBrief = (text: string): boolean => firstLineIs(text, PROJECT_LINE);

/** Which threads talk with the person, held in memory for the synchronous callback. */
export interface LeadStore {
  /** Read the recorded briefs and the mirrored project marks. */
  load(): Promise<void>;
  /** Whether this thread is a Main, marked as a project, or started with a project brief. */
  has(threadId: string): boolean;
  /** The chosen Mains, all projects': replaces those known before. */
  setMains(threadIds: Iterable<string>): void;
  recordBrief(threadId: string, at: number): Promise<void>;
  /** A project mark set (true) or taken off (false). */
  setProject(threadId: string, marked: boolean, at: number): Promise<void>;
  /** A count that moves with every mark set or taken off: what `found` was read after. */
  changes(): number;
  /**
   * The marks found by reading the threads themselves, which began when
   * `changes()` was `since`: a mark not yet mirrored is added, unless that
   * thread's mark has been changed since.
   */
  found(marked: readonly string[], since: number): Promise<void>;
  forget(threadId: string): Promise<void>;
}

export function createLeadStore(kv: Kv): LeadStore {
  let mains = new Set<string>();
  const briefs = new Set<string>();
  const projects = new Set<string>();
  /** For each thread whose mark changed, the count at that change. */
  const changedAt = new Map<string, number>();
  let count = 0;
  return {
    async load() {
      for (const key of await kv.list(BRIEF_PREFIX)) briefs.add(key.slice(BRIEF_PREFIX.length));
      for (const key of await kv.list(PROJECT_PREFIX)) projects.add(key.slice(PROJECT_PREFIX.length));
    },
    has: (threadId) => mains.has(threadId) || projects.has(threadId) || briefs.has(threadId),
    setMains(threadIds) {
      mains = new Set(threadIds);
    },
    async recordBrief(threadId, at) {
      // In memory first: the first turn's instructions are resolved right after the hook answers.
      briefs.add(threadId);
      await kv.set(`${BRIEF_PREFIX}${threadId}`, { at });
    },
    async setProject(threadId, marked, at) {
      count += 1;
      changedAt.set(threadId, count);
      if (marked) {
        projects.add(threadId);
        await kv.set(`${PROJECT_PREFIX}${threadId}`, { at });
      } else {
        projects.delete(threadId);
        await kv.delete(`${PROJECT_PREFIX}${threadId}`);
      }
    },
    changes: () => count,
    async found(marked, since) {
      for (const threadId of marked) {
        if (projects.has(threadId) || (changedAt.get(threadId) ?? 0) > since) continue;
        projects.add(threadId);
        await kv.set(`${PROJECT_PREFIX}${threadId}`, { at: null });
      }
    },
    async forget(threadId) {
      briefs.delete(threadId);
      projects.delete(threadId);
      await kv.delete(`${BRIEF_PREFIX}${threadId}`);
      await kv.delete(`${PROJECT_PREFIX}${threadId}`);
    },
  };
}

export interface LeadRulesDeps {
  store: LeadStore;
  /** The rule file's text, or null when it could not be read. */
  rules: string | null;
  /** The settings as last read: the callback is synchronous. */
  settings: () => WorkerSettings;
  now: () => number;
  warn: (text: string) => void;
}

export function createLeadRules(deps: LeadRulesDeps) {
  const gave = (threadId: string): boolean => deps.settings().enabled && deps.rules !== null && deps.store.has(threadId);
  return {
    /** Whether cow gives this thread the lead rules. */
    gave,
    instructions(threadId: string): string | null {
      return gave(threadId) ? rulesWith(deps.rules!, deps.settings().extra) : null;
    },
    /** Before a message reaches the agent: a thread's first message that is a project brief is recorded. Always lets it through. */
    async dispatch(facts: DispatchFacts): Promise<{ action: "proceed" }> {
      const failed = (cause: unknown) => {
        try {
          deps.warn(`could not record ${facts.threadId} as a project brief: ${String(cause)}`);
        } catch {
          // Nothing more to do: the message goes through either way.
        }
      };
      try {
        if (!deps.settings().enabled) return { action: "proceed" };
        const first = facts.status === "pending" && facts.attempt === "start-turn" && facts.initiator !== "system";
        if (first && isProjectBrief(facts.text)) void deps.store.recordBrief(facts.threadId, deps.now()).catch((cause: unknown) => failed(cause));
      } catch (cause) {
        failed(cause);
      }
      return { action: "proceed" };
    },
  };
}
export type LeadRules = ReturnType<typeof createLeadRules>;

/** Both rule files, as one thread sees them: the lead rules win over the worker rules. */
export function createRules(lead: LeadRules, worker: WorkerRules) {
  const leadGave = (threadId: string): boolean => {
    try {
      return lead.gave(threadId);
    } catch {
      return false;
    }
  };
  return {
    instructions: (threadId: string): string | null => (leadGave(threadId) ? lead.instructions(threadId) : worker.instructions(threadId)),
    lead: leadGave,
    worker: (threadId: string): boolean => !leadGave(threadId) && worker.gave(threadId),
    /** Both hooks see every message; the answer is always proceed. */
    async dispatch(facts: DispatchFacts): Promise<{ action: "proceed" }> {
      await Promise.all([worker.dispatch(facts).catch(() => undefined), lead.dispatch(facts).catch(() => undefined)]);
      return { action: "proceed" };
    },
  };
}
