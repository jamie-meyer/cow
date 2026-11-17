// Which verbs apply to the selected line. The verb bar greys out the rest,
// and a key for a verb that does not apply says why instead of acting.

import { isBusy } from "./state.ts";
import type { Line } from "./tree.ts";

export type Verb = "answer" | "park" | "resume" | "stop" | "archive" | "brief";

export const VERB_KEYS: Record<Verb, string> = {
  answer: "a",
  park: "p",
  resume: "r",
  stop: "x",
  archive: "e",
  brief: "b",
};

/**
 * Why `verb` cannot be used on `line`, or null when it can. `isMain` marks
 * the page heading, which can be answered and stopped but never set aside.
 */
export function verbBlocked(verb: Verb, line: Line | null, isMain: boolean): string | null {
  if (line === null) return "select a line first";
  const { thread, derived } = line;
  const parked = derived.state === "parked";
  const returned = derived.park?.due != null;
  const archived = thread.archivedAt !== null;
  switch (verb) {
    case "answer":
      if (archived) return "it is archived";
      // An ask stays the person's to answer wherever its thread has gone, the shelf included.
      if (derived.asks) return null;
      if (parked) return "it is parked: resume it first";
      // A refused permission is answered too: ask again, carry on, or dismiss.
      return thread.hasPendingInteraction || derived.blocked ? null : "it has not asked anything";
    case "brief":
      return derived.brief ? null : "it has submitted no brief";
    case "park":
      if (isMain) return "Main cannot be parked";
      if (archived) return "it is archived";
      return parked && !returned ? "it is already parked" : null;
    case "resume":
      return parked ? null : "it is not parked";
    case "stop":
      if (parked) return returned ? null : "it is parked: resume it, or wait until it comes back";
      return isBusy(thread) && !archived ? null : "no turn is running";
    case "archive":
      if (isMain) return "Main cannot be archived from here";
      if (archived) return "it is already archived";
      // bb archives a thread's descendants with it.
      if (line.openUnder > 0) return "threads under it are still open";
      // A blocked line whose turn has ended is at rest, like a done one.
      if (derived.state === "blocked" && !isBusy(thread)) return null;
      // So is one that waits only for its brief to be read: archiving it is a way of dealing with it.
      if (derived.briefWaits) return null;
      if (derived.asks) return "it has an open ask: answer it, or have it withdrawn";
      // An idle project is at rest too: archiving it is the person saying it is finished.
      return derived.state === "done" || derived.state === "idle" || derived.state === "failed" ? null : "only done, idle or failed lines can be archived";
  }
}

/** What each verb is called on this line; parked work that came back reads differently. */
export function verbLabel(verb: Verb, line: Line | null): string {
  const returned = line?.derived.park?.due != null;
  if (verb === "park") return returned ? "keep parked" : "park";
  if (verb === "stop") return returned ? "drop" : "stop";
  return verb;
}
