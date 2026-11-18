// Asks on the backend: kept in the plugin's own storage, answered by the
// person, and delivered to the asking thread as a message from the user.

import { type Kv, Refusal, serial } from "../kv.ts";
import { type TraceInput, closeLeavesTrace } from "../traces.ts";
import { type Ask, type Risk, answerMessage, answered, askSchema, closedInChat, draftAsk, mayAskFor, openAsks, withdrawn } from "./ask.ts";

const PREFIX = "ask:";
/** Open asks one thread may have at once; more than this is a thread talking to itself. */
export const MAX_OPEN_PER_THREAD = 20;

export interface AskDeps {
  kv: Kv;
  now(): number;
  newId(): string;
  /** The thread's project, or null when bb has no such thread. */
  thread(threadId: string): Promise<{ projectId: string } | null>;
  /** The ids above a thread, nearest first. */
  ancestors(threadId: string): Promise<readonly string[]>;
  /** The absolute path of the thread's storage folder, or null when it cannot be read. */
  storageRoot(threadId: string): Promise<string | null>;
  /** Send the thread a message as the user; it starts a turn when the thread is idle. */
  send(threadId: string, text: string): Promise<void>;
  /** Tell open pages that asks changed. */
  changed(): void;
  /**
   * When the person last sent a thread a message, from anywhere in bb; null
   * when they never have or it cannot be read. Without it, every close by an
   * agent counts as one the person has not written since.
   */
  spokeAt?(threadId: string): Promise<number | null>;
  /** Record a trace: an agent took an ask out of the person's queue. A failure here never undoes what was done. */
  traced?(input: TraceInput): Promise<void>;
  warn?(message: string): void;
}

export interface AskInput {
  /** The thread the command ran in, or null when it ran outside any thread. */
  caller: string | null;
  /** The thread the question is from; default the caller. */
  threadId: string | null;
  question: string;
  options: readonly string[];
  optionsOnly: boolean;
  risk: Risk | null;
  proofs: readonly string[];
  context: string | null;
  /** The capability the thread asks for, when this is that kind of ask. */
  capability?: Ask["capability"];
}

export interface Asks {
  ask(input: AskInput): Promise<Ask>;
  /** Open asks, oldest first; with `all`, answered and withdrawn ones too, newest last. */
  list(filter?: { threadId?: string; all?: boolean }): Promise<Ask[]>;
  get(id: string): Promise<Ask>;
  withdraw(caller: string | null, id: string): Promise<Ask>;
  /**
   * Close an ask the person answered in chat. With `answer`, it is the asking
   * side closing it (the thread, or one above it); without, the person, from
   * the page. Nothing is sent to the thread.
   */
  close(id: string, given: { caller: string | null; answer: string } | { person: true }): Promise<Ask>;
  /** Record the person's answer and deliver it. Never call this for an agent. */
  answer(id: string, given: { option: number | null; text: string | null }): Promise<Ask>;
  /** Deliver answers that were recorded but did not reach their thread. Returns how many it sent. */
  redeliver(): Promise<number>;
}

export function createAsks(deps: AskDeps): Asks {
  const { kv } = deps;
  const locked = serial();
  const key = (id: string) => `${PREFIX}${id}`;

  const read = async (id: string): Promise<Ask | null> => {
    const stored = askSchema.safeParse(await kv.get(key(id)));
    return stored.success ? stored.data : null;
  };
  const get = async (id: string): Promise<Ask> => {
    const ask = /^ask_[a-z0-9]{1,40}$/.test(id) ? await read(id) : null;
    if (!ask) throw new Refusal("ask_not_found", `there is no ask ${id}`, "Run `bb cow asks --all` to see ask ids.");
    return ask;
  };
  const all = async (): Promise<Ask[]> => {
    const keys = await kv.list(PREFIX);
    const found = await Promise.all(keys.map((k) => read(k.slice(PREFIX.length))));
    return found.filter((ask): ask is Ask => ask !== null);
  };
  const write = async (ask: Ask) => {
    await kv.set(key(ask.id), ask);
    deps.changed();
  };

  /** Refuse a caller that is neither the thread nor above it. A caller outside any thread is the person. */
  const allow = async (caller: string | null, target: string, verb: string) => {
    if (caller === null || caller === target) return;
    if (!mayAskFor(caller, target, await deps.ancestors(target))) {
      throw new Refusal(
        "not_your_thread",
        `${caller} cannot ${verb} ${target}: it is neither that thread nor above it`,
        "A thread asks for itself, or for a thread it started.",
      );
    }
  };

  /** Record a trace, after what it traces is done: a failure is reported, and undoes nothing. */
  const trace = async (input: TraceInput) => {
    await deps.traced?.(input).catch((cause: unknown) => deps.warn?.(`could not record that ${input.actorThreadId} ${input.action} ${input.askId}: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  /** When cow delivered answers to the thread's asks: messages from the person that answer nothing else. */
  const deliveredTo = async (threadId: string): Promise<number[]> =>
    (await all()).filter((ask) => ask.threadId === threadId && ask.deliveredAt !== null).map((ask) => ask.deliveredAt!);

  /** Send an answered ask's answer, once, and record that it arrived. */
  const deliver = (id: string): Promise<Ask> =>
    locked(id, async () => {
      const ask = await get(id);
      if (ask.status !== "answered" || ask.deliveredAt !== null) return ask;
      await deps.send(ask.threadId, answerMessage(ask));
      const delivered = { ...ask, deliveredAt: deps.now() };
      await write(delivered);
      return delivered;
    });

  return {
    get,

    async ask(input) {
      const target = input.threadId ?? input.caller;
      if (target === null) {
        throw new Refusal("no_thread", "no thread to ask for: this command was not run inside a thread", "Pass --thread <id>.");
      }
      const thread = await deps.thread(target);
      if (!thread) throw new Refusal("thread_not_found", `there is no thread ${target}`);
      await allow(input.caller, target, "ask for");
      const drafted = draftAsk(
        { ...input, threadId: target, askedBy: input.caller, projectId: thread.projectId },
        `ask_${deps.newId()}`,
        deps.now(),
        input.proofs.length > 0 ? await deps.storageRoot(target) : null,
      );
      if (!drafted.ok) throw new Refusal("bad_ask", drafted.error, drafted.hint);
      return locked(`thread:${target}`, async () => {
        const open = openAsks(await all(), target);
        const same = open.find((ask) => ask.question === drafted.value.question);
        if (same) {
          throw new Refusal("already_asked", `${target} already has this question open as ${same.id}`, `Wait for the answer, or run \`bb cow ask withdraw ${same.id}\` first.`);
        }
        if (open.length >= MAX_OPEN_PER_THREAD) {
          throw new Refusal("too_many_asks", `${target} already has ${open.length} open asks`, "Withdraw the ones that no longer matter with `bb cow ask withdraw <id>`.");
        }
        await write(drafted.value);
        return drafted.value;
      });
    },

    async list(filter = {}) {
      const asks = await all();
      if (!filter.all) return openAsks(asks, filter.threadId);
      return asks
        .filter((ask) => filter.threadId === undefined || ask.threadId === filter.threadId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    },

    async withdraw(caller, id) {
      const done = await locked(id, async () => {
        const ask = await get(id);
        await allow(caller, ask.threadId, "withdraw an ask of");
        const next = withdrawn(ask, deps.now());
        if (!next.ok) throw new Refusal("cannot_withdraw", next.error);
        await write(next.value);
        return next.value;
      });
      // A command run outside any thread is the person's own; any thread's leaves a trace.
      if (caller !== null) await trace({ action: "withdrew", actorThreadId: caller, threadId: done.threadId, askId: done.id, question: done.question, claim: null, waited: [] });
      return done;
    },

    async close(id, given) {
      const person = "person" in given;
      let quiet = true;
      const done = await locked(id, async () => {
        const ask = await get(id);
        if (!person) await allow(given.caller, ask.threadId, "close an ask of");
        // Read before it is closed: whether the person has written to the thread since it asked.
        if (!person && given.caller !== null) {
          const spokeAt = deps.spokeAt ? await deps.spokeAt(ask.threadId).catch(() => null) : null;
          quiet = !closeLeavesTrace(ask, given.caller, spokeAt, await deliveredTo(ask.threadId));
        }
        const next = closedInChat(ask, person ? { by: "person", closedBy: null, answer: null } : { by: "thread", closedBy: given.caller, answer: given.answer }, deps.now());
        if (!next.ok) throw new Refusal("cannot_close", next.error, next.hint);
        await write(next.value);
        return next.value;
      });
      if (!person && !quiet && given.caller !== null) {
        await trace({ action: "closed", actorThreadId: given.caller, threadId: done.threadId, askId: done.id, question: done.question, claim: done.closed?.answer ?? null, waited: [] });
      }
      return done;
    },

    async answer(id, given) {
      // The answer is recorded first, so it is never lost; delivery can be retried.
      await locked(id, async () => {
        const next = answered(await get(id), given, deps.now());
        if (!next.ok) throw new Refusal("cannot_answer", next.error, next.hint);
        await write(next.value);
      });
      try {
        return await deliver(id);
      } catch (cause) {
        throw new Refusal(
          "not_delivered",
          `the answer to ${id} is recorded but did not reach the thread: ${cause instanceof Error ? cause.message : String(cause)}`,
          "cow sends it again when the plugin next loads.",
        );
      }
    },

    async redeliver() {
      let sent = 0;
      for (const ask of await all()) {
        if (ask.status !== "answered" || ask.deliveredAt !== null) continue;
        await deliver(ask.id).then(
          () => (sent += 1),
          () => undefined,
        );
      }
      return sent;
    },
  };
}
