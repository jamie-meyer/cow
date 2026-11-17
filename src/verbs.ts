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
      // A reminder that came is answered too: keep waiting, or it is back with the person.
      if (derived.wait?.due) return null;
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
      // Waiting on someone else is at rest too: archiving it ends the wait.
      return derived.state === "done" || derived.state === "idle" || derived.state === "failed" || derived.state === "waiting" ? null : "only done, idle, waiting or failed lines can be archived";
  }
}

/** For each reason a verb is refused: what to do instead, on the page and from the CLI. */
const INSTEAD: Record<string, { page: string; cli: string }> = {
  "select a line first": { page: "j and k move to one", cli: "" },
  "it is archived": { page: "u takes back an archive made on this page", cli: "`bb thread unarchive <thread>` brings it back." },
  "it is parked: resume it first": { page: "r resumes it", cli: "`bb cow resume <thread>` resumes it." },
  "it has not asked anything": { page: "I says something to it", cli: "" },
  "it has submitted no brief": { page: "its agent submits one with bb cow brief submit", cli: "" },
  "Main cannot be parked": { page: "M chooses another Main", cli: "Park the threads under it instead." },
  "it is already parked": { page: "r resumes it", cli: "`bb cow resume <thread>` takes it off the shelf; parking again is for work that has come back." },
  "it is not parked": { page: "p parks it", cli: "`bb cow park <thread> --reason <text>` parks it." },
  "it is parked: resume it, or wait until it comes back": { page: "r resumes it", cli: "" },
  "no turn is running": { page: "there is nothing to stop", cli: "" },
  "Main cannot be archived from here": { page: "archive it in bb, then choose another Main with M", cli: "Archive it with `bb thread archive <thread>` if you mean to; cow then asks for another Main." },
  "it is already archived": { page: "u takes back an archive made on this page", cli: "`bb thread unarchive <thread>` brings it back." },
  "threads under it are still open": { page: "archive or park those first", cli: "Archive or park those first: `bb cow status` lists them." },
  "it has an open ask: answer it, or have it withdrawn": { page: "a answers it", cli: "The user answers it on cow's page, or its thread runs `bb cow ask withdraw <id>` or `bb cow ask close <id> --answered <text>`." },
  "only done, idle, waiting or failed lines can be archived": { page: "x stops a running turn, and p sets it aside as it is", cli: "Wait for its turn to end, or park it: `bb cow park <thread> --reason <text> --stop`." },
};

/** What to do instead of a refused verb, in the page's keys; empty when the reason already says. */
export function insteadOnPage(why: string): string {
  const instead = INSTEAD[why]?.page ?? "";
  return instead === "" || why.includes(instead) ? "" : instead;
}

/** The same for a refused command; empty when there is nothing to add. */
export const insteadFromCli = (why: string): string => INSTEAD[why]?.cli ?? "";

/** What each verb is called on this line; parked work that came back reads differently. */
export function verbLabel(verb: Verb, line: Line | null): string {
  const returned = line?.derived.park?.due != null;
  if (verb === "park") return returned ? "keep parked" : "park";
  if (verb === "stop") return returned ? "drop" : "stop";
  return verb;
}
