// Whose a finished turn's reply is, worked out from the event log, the same
// way for every thread under Main and for Main itself: a reply is addressed
// to the person when it ends the thread's newest finished turn and the person
// started that turn, or spoke into it while it ran. A turn an agent or one of
// bb's notices started ends in a reply that is not theirs.
//
// How a turn's start looks in the log, established against bb 0.49:
// - every prompt is a `client/turn/requested` event with `source` ("spawn"
//   for the thread's first prompt, "tell" for the rest), `initiator` ("user",
//   "agent", or "system" for bb's own notices) and a `target` that says
//   whether it starts a turn or steers the one in progress;
// - bb records a thread's first prompt as sent by "user" whoever spawned it,
//   so `source: "spawn"` is never the person speaking;
// - `turn/started` and `turn/completed` bracket the turn, the latter with a
//   `status` of "completed", "failed" or "interrupted";
// - bb's own notices carry a `systemMessageKind`: "child-completed" and the
//   like when a thread under it reports, "ownership-assigned" (or
//   "ownership-batch") when a thread is moved under it, "ownership-removed"
//   when one is moved away; an ordinary message carries "unlabeled". A
//   notice is never the person speaking, whatever its `initiator` says.

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
  /** When that message was sent. */
  personSpokeAt?: number | null;
}

export const NO_REPLIES: Replies = { last: null, toPerson: null, personSpokeSeq: null, personSpokeAt: null };

/** Who sent a prompt. */
export type Starter = "person" | "spawn" | "agent" | "system";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Who sent the prompt a `client/turn/requested` event records. */
export function starterOf(data: Record<string, unknown>): Starter {
  if (data.source === "spawn") return "spawn";
  // bb labels every prompt: "unlabeled" for an ordinary message, a kind of its own for a notice.
  if (typeof data.systemMessageKind === "string" && data.systemMessageKind !== "unlabeled") return "system";
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

  const found: Replies = { last: null, toPerson: null, personSpokeSeq: null, personSpokeAt: null };
  /** Who sent the prompt that the next turn starts from; null when it is not among the events. */
  let waiting: Starter | null = null;
  /** Whether the turn in progress is the person's. */
  let personsTurn = false;
  /** Whether the next turn, and the one in progress, were started only to say a thread was moved: bb's bookkeeping, which ends in no reply. */
  let waitingOwnership = false;
  let ownershipTurn = false;
  for (const event of log) {
    if (event.type === "client/turn/requested") {
      const starter = starterOf(event.data);
      if (starter === "person") {
        found.personSpokeSeq = event.seq;
        found.personSpokeAt = event.at;
      }
      const kind = event.data.systemMessageKind;
      const steers = record(event.data.target)?.kind === "steer";
      if (steers) {
        // Said into a turn that is running: its reply answers the person too.
        if (starter === "person") personsTurn = true;
      } else {
        waiting = starter;
        waitingOwnership = typeof kind === "string" && kind.startsWith("ownership-");
      }
    } else if (event.type === "turn/started") {
      personsTurn = waiting === "person";
      ownershipTurn = waitingOwnership;
      waiting = null;
      waitingOwnership = false;
    } else if (event.type === "turn/completed") {
      // A turn bb started only to say a thread was moved ends in no reply
      // anyone asked for, unless the person spoke into it.
      if (ownershipTurn && !personsTurn) {
        ownershipTurn = false;
        continue;
      }
      ownershipTurn = false;
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
 * A reply the person has not seen, or null.
 *
 * - `anyTurn` false: the reply addressed to them, which puts a line in the
 *   queue: it ends the newest finished turn, and they started that turn.
 *   Once another turn has ended after it (an agent's, a notice of bb's),
 *   the person is no longer in conversation with the thread.
 * - `anyTurn` true: the newest reply, whoever started its turn: what a line
 *   marks unread without putting it in the queue.
 * - `seenSeq`: cow's own record of the turn the person last saw.
 * - A message the person sent after the reply means they read it.
 */
export function unreadReply(replies: Replies | undefined, anyTurn: boolean, seenSeq: number | null | undefined): TurnEnd | null {
  const reply = anyTurn ? replies?.last : replies?.toPerson && replies.last?.seq === replies.toPerson.seq ? replies.toPerson : null;
  if (!reply) return null;
  if (seenSeq != null && seenSeq >= reply.seq) return null;
  if (replies?.personSpokeSeq != null && replies.personSpokeSeq > reply.seq) return null;
  return reply;
}
