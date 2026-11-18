// Traces: what an agent did that took something out of the person's queue,
// put in front of them until they acknowledge it. Parking a thread that
// waited on them, withdrawing an ask, and closing an ask as answered in chat
// when they have not written to that thread since it asked are all allowed;
// none of them may go unseen. Pure: the page, the CLI and the backend share it.

import { type Ask, messagedSince } from "./asks/ask.ts";
import type { Line } from "./tree.ts";

/** What an agent did. */
export type TraceAction = "parked" | "withdrew" | "closed";
export const TRACE_ACTIONS = ["parked", "withdrew", "closed"] as const satisfies readonly TraceAction[];

/** One trace, as the service that saw it reports it. Titles are looked up when it is recorded. */
export interface TraceInput {
  action: TraceAction;
  /** The thread that ran the command. Never null: what the person does leaves no trace. */
  actorThreadId: string;
  /** The thread it was done to: the parked thread, or the asking one. Enter on the notice opens its chat. */
  threadId: string;
  /** For an ask: which one, and its question. */
  askId: string | null;
  question: string | null;
  /** What the agent claimed: the park reason, or the answer it said the person gave. */
  claim: string | null;
  /** For a park: what the thread was waiting on the person for. */
  waited: readonly string[];
}

const MAX_QUOTED = 300;
const oneLine = (text: string): string => {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > MAX_QUOTED ? `${flat.slice(0, MAX_QUOTED - 1)}…` : flat;
};

/**
 * What a thread was waiting on the person for, at the moment an agent parks
 * it: an open ask, bb's own question or permission request, a permission bb
 * refused and nobody dismissed, a failure, a brief with disputes or judgement
 * calls, a reply addressed to them not yet seen. Empty when it waited on
 * nothing: such a park leaves no trace.
 */
export function parkWaitedOn(line: Line): string[] {
  const { derived, thread } = line;
  const out: string[] = [];
  const asks = derived.asks?.length ?? 0;
  if (asks > 0) out.push(asks === 1 ? "an open ask" : `${asks} open asks`);
  if (thread.hasPendingInteraction) out.push("a question or permission request of bb's");
  if (derived.blocked) out.push("a permission bb refused");
  if (derived.state === "failed") out.push("a failure");
  if (derived.briefWaits) out.push("a brief with disputes or judgement calls");
  if (derived.reply) out.push("a reply to you not yet seen");
  return out;
}

/**
 * Whether closing an ask as answered in chat leaves a trace: when an agent
 * closes it and the person has not sent that thread a message since it was
 * asked. `spokeAt` and `delivered` are as `messagedSince` takes them.
 */
export function closeLeavesTrace(ask: Ask, caller: string | null, spokeAt: number | null | undefined, delivered: readonly number[] = []): boolean {
  return caller !== null && !messagedSince(ask, spokeAt, delivered);
}

/** The trace as one sentence. `titleOf` names a thread. */
export function traceText(input: Omit<TraceInput, "askId">, titleOf: (threadId: string) => string): string {
  const actor = `“${titleOf(input.actorThreadId)}”`;
  const own = input.actorThreadId === input.threadId;
  const target = `“${titleOf(input.threadId)}”`;
  const claim = input.claim === null ? "" : oneLine(input.claim);
  const question = input.question === null ? "" : `: ${oneLine(input.question)}`;
  switch (input.action) {
    case "parked":
      return `${actor} parked ${own ? "itself" : target}, which was waiting on you for ${input.waited.join(", ") || "something"}${claim ? ` · its reason: ${claim}` : ""}`;
    case "withdrew":
      return `${actor} withdrew ${own ? "its ask" : `an ask of ${target}`}${question}`;
    case "closed":
      return `${actor} closed ${own ? "its ask" : `an ask of ${target}`} as answered in chat, though you have not written to ${own ? "it" : target} since it asked${question}${claim ? ` · the answer it says you gave: ${claim}` : ""}`;
  }
}
