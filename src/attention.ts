// Whose a finished turn's reply is. bb tracks unread replies only for threads
// without a parent, so for the rest cow works it out from the event log: a
// reply is addressed to the person when they started the turn it ends, or
// when the thread is one they talk to directly (a group head).
//
// How a turn's start looks in the log, established against bb 0.49:
// - every prompt is a `client/turn/requested` event with `source` ("spawn"
//   for the thread's first prompt, "tell" for the rest), `initiator` ("user",
//   "agent", or "system" for bb's own notices) and a `target` that says
//   whether it starts a turn or steers the one in progress;
// - bb records a thread's first prompt as sent by "user" whoever spawned it,
//   so `source: "spawn"` is never the person speaking;
// - `turn/started` and `turn/completed` bracket the turn, the latter with a
//   `status` of "completed", "failed" or "interrupted".

/** Where a turn ended: its `turn/completed` event. */
export interface TurnEnd {
  seq: number;
  at: number;
}

export interface Replies {
  /** The newest turn that finished normally, whoever started it. */
  last: TurnEnd | null;
  /** The newest finished turn the person started, or spoke into while it ran. */
  toPerson: TurnEnd | null;
  /** Where in the log the person last sent the thread a message. */
  personSpokeSeq: number | null;
}

export const NO_REPLIES: Replies = { last: null, toPerson: null, personSpokeSeq: null };

/** Who sent a prompt. */
export type Starter = "person" | "spawn" | "agent" | "system";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Who sent the prompt a `client/turn/requested` event records. */
export function starterOf(data: Record<string, unknown>): Starter {
  if (data.source === "spawn") return "spawn";
  if (data.initiator === "user") return "person";
  return data.initiator === "agent" ? "agent" : "system";
}

/**
 * Read a thread's recent turns. The events may come in any order and need
 * only be the recent ones; the kinds read are `client/turn/requested`,
 * `turn/started` and `turn/completed`. A turn whose start is older than the
 * events given is not credited to the person: it is left out rather than
 * guessed at.
 */
export function findReplies(events: readonly unknown[]): Replies {
  const log: { seq: number; at: number; type: string; data: Record<string, unknown> }[] = [];
  for (const raw of events) {
    const r = record(raw);
    if (!r || typeof r.seq !== "number" || typeof r.type !== "string") continue;
    log.push({ seq: r.seq, at: typeof r.createdAt === "number" ? r.createdAt : 0, type: r.type, data: record(r.data) ?? {} });
  }
  log.sort((a, b) => a.seq - b.seq);

  const found: Replies = { last: null, toPerson: null, personSpokeSeq: null };
  /** Who sent the prompt that the next turn starts from; null when it is not among the events. */
  let waiting: Starter | null = null;
  /** Whether the turn in progress is the person's. */
  let personsTurn = false;
  for (const event of log) {
    if (event.type === "client/turn/requested") {
      const starter = starterOf(event.data);
      if (starter === "person") found.personSpokeSeq = event.seq;
      const steers = record(event.data.target)?.kind === "steer";
      if (steers) {
        // Said into a turn that is running: its reply answers the person too.
        if (starter === "person") personsTurn = true;
      } else {
        waiting = starter;
      }
    } else if (event.type === "turn/started") {
      personsTurn = waiting === "person";
      waiting = null;
    } else if (event.type === "turn/completed") {
      if (event.data.status === "completed" || event.data.status === undefined) {
        const end = { seq: event.seq, at: event.at };
        found.last = end;
        if (personsTurn) found.toPerson = end;
      }
      personsTurn = false;
    }
  }
  return found;
}

/**
 * The reply the person has not seen, or null.
 *
 * - `head`: the thread has threads under it, so the person talks to it
 *   directly and every finished turn ends in a reply for them, whoever
 *   started it. A leaf's reply is theirs only when they started the turn.
 * - `seenSeq`: cow's own record of the turn the person last saw.
 * - A message the person sent after the reply means they read it.
 */
export function unreadReply(replies: Replies | undefined, head: boolean, seenSeq: number | null | undefined): TurnEnd | null {
  const reply = head ? replies?.last : replies?.toPerson;
  if (!reply) return null;
  if (seenSeq != null && seenSeq >= reply.seq) return null;
  if (replies?.personSpokeSeq != null && replies.personSpokeSeq > reply.seq) return null;
  return reply;
}
