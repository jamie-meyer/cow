// Which verbs apply to the selected line. The verb bar greys out the rest,
// and a key for a verb that does not apply says why instead of acting.

import { isBusy } from "./state.ts";
import type { Line } from "./tree.ts";

export type Verb = "answer" | "park" | "resume" | "stop" | "archive";

export const VERB_KEYS: Record<Verb, string> = {
  answer: "a",
  park: "p",
  resume: "r",
  stop: "x",
  archive: "e",
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
      if (parked) return "it is parked: resume it first";
      return thread.hasPendingInteraction && !archived ? null : "it has not asked anything";
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
      return derived.state === "done" || derived.state === "failed" ? null : "only done or failed lines can be archived";
  }
}

/** What each verb is called on this line; parked work that came back reads differently. */
export function verbLabel(verb: Verb, line: Line | null): string {
  const returned = line?.derived.park?.due != null;
  if (verb === "park") return returned ? "keep parked" : "park";
  if (verb === "stop") return returned ? "drop" : "stop";
  return verb;
}
