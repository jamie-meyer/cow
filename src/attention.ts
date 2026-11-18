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
//   `status` of "completed", "failed" or "interrupted";
// - bb's own notices carry a `systemMessageKind`: "child-completed" and the
//   like when a thread under it reports, "ownership-assigned" (or
//   "ownership-batch") when a thread is moved under it, "ownership-removed"
//   when one is moved away. A notice is never the person speaking, whatever
//   its `initiator` says.

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
  /** bb told it that a thread was moved under it: it may have threads under it that it never started. */
  adopted?: boolean;
}

export const NO_REPLIES: Replies = { last: null, toPerson: null, personSpokeSeq: null, personSpokeAt: null };

/** Who sent a prompt. */
export type Starter = "person" | "spawn" | "agent" | "system";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Who sent the prompt a `client/turn/requested` event records. */
export function starterOf(data: Record<string, unknown>): Starter {
  if (data.source === "spawn") return "spawn";
  if (typeof data.systemMessageKind === "string") return "system";
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

  const found: Replies = { last: null, toPerson: null, personSpokeSeq: null, personSpokeAt: null, adopted: false };
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
      if (kind === "ownership-assigned" || kind === "ownership-batch") found.adopted = true;
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
 * Whether the person talks to a thread directly, so that every reply of its
 * is theirs. A thread with threads under it is taken to be one they talk to;
 * but one that bb has told a thread was moved under it, and that the person
 * has never written to in the turns read, is a worker that was handed a
 * thread: its replies go to whoever started its turns, as any worker's do.
 * A thread marked as a project is never read that way.
 */
export function talksTo(head: boolean, replies: Replies | undefined, marked = false): boolean {
  // One marked as a project is the person's by their own word, whatever was moved under it.
  return head && (marked || !(replies?.adopted === true && replies.personSpokeSeq == null));
}

/**
 * The reply the person has not seen, or null.
 *
 * - `head`: the thread has threads under it, so the person talks to it
 *   directly and every finished turn ends in a reply for them, whoever
 *   started it. A leaf's reply is theirs only when they started the turn,
 *   and only while that turn is its newest finished one.
 * - `seenSeq`: cow's own record of the turn the person last saw.
 * - A message the person sent after the reply means they read it.
 */
export function unreadReply(replies: Replies | undefined, head: boolean, seenSeq: number | null | undefined): TurnEnd | null {
  // A leaf's reply is the person's only while it ends the newest finished
  // turn: once another turn has ended after it (an agent's, a notice of
  // bb's), the person is no longer in conversation with it.
  const reply = head ? replies?.last : replies?.toPerson && replies.last?.seq === replies.toPerson.seq ? replies.toPerson : null;
  if (!reply) return null;
  if (seenSeq != null && seenSeq >= reply.seq) return null;
  if (replies?.personSpokeSeq != null && replies.personSpokeSeq > reply.seq) return null;
  return reply;
}
