// Which verbs apply to the selected line. The verb bar greys out the rest,
// and a key for a verb that does not apply says why instead of acting.

import { isBusy } from "./state.ts";
import type { Line } from "./tree.ts";
import { ABOVE_MAIN_REFUSAL, ARCHIVE_ASKING, ARCHIVE_RUNNING, MAIN_ARCHIVE_REFUSAL, OTHER_MAIN_REFUSAL, OUTSIDE_REFUSAL } from "./outside.ts";

export type Verb = "answer" | "park" | "resume" | "stop" | "archive" | "brief" | "keep";

export const VERB_KEYS: Record<Verb, string> = {
  answer: "a",
  park: "p",
  resume: "r",
  stop: "x",
  archive: "e",
  brief: "b",
  keep: "z",
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
  // A run of an automation is read, answered, stopped and archived here, never set aside: its automation makes the next.
  if (line.run !== undefined && (verb === "park" || verb === "keep")) return RUN_REFUSAL;
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
    case "keep":
      if (isMain) return "Main cannot be kept";
      if (archived) return "it is archived";
      // A kept line comes off the shelf by itself when a turn starts, so a running one is not kept.
      if (derived.state !== "kept" && isBusy(thread)) return "its turn is running";
      return null;
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
      if (isMain) return MAIN_ARCHIVE_REFUSAL;
      if (archived) return "it is already archived";
      // bb archives a thread's descendants with it.
      if (line.openUnder > 0) return "threads under it are still open";
      // A blocked line whose turn has ended is at rest, like a done one.
      if (derived.state === "blocked" && !isBusy(thread)) return null;
      // So is one that waits only for its brief to be read: archiving it is a way of dealing with it.
      if (derived.briefWaits) return null;
      if (derived.asks) return "it has an open ask: answer it, or have it withdrawn";
      if (isBusy(thread)) return ARCHIVE_RUNNING;
      if (thread.hasPendingInteraction) return ARCHIVE_ASKING;
      // An idle project is at rest too: archiving it is the person saying it is finished.
      // Waiting on someone else is at rest too: archiving it ends the wait. So is a kept line.
      return derived.state === "done" || derived.state === "idle" || derived.state === "failed" || derived.state === "waiting" || derived.state === "kept"
        ? null
        : "only done, idle, waiting, kept or failed lines can be archived";
  }
}

/** Why a thread outside Main is not parked: the shelf is a Main's. */
export const NOT_UNDER_MAIN = "it is outside Main";

/** Why a run of an automation is not parked, kept, marked as a project, or waited on. */
export const RUN_REFUSAL = "it is a run of an automation";

/** For each reason a verb is refused: what to do instead, on the page and from the CLI. */
const INSTEAD: Record<string, { page: string; cli: string }> = {
  [RUN_REFUSAL]: { page: "e archives it once you are done with it", cli: "" },
  "select a line first": { page: "j and k move to one", cli: "" },
  "it is archived": { page: "u takes back an archive made on this page", cli: "`bb thread unarchive <thread>` brings it back." },
  "it is parked: resume it first": { page: "r resumes it", cli: "`bb cow resume <thread>` resumes it." },
  "it has not asked anything": { page: "I says something to it", cli: "" },
  "it has submitted no brief": { page: "its agent submits one with bb cow brief submit", cli: "" },
  "Main cannot be parked": { page: "M chooses another Main", cli: "Park the threads under it instead." },
  "Main cannot be kept": { page: "M chooses another Main", cli: "" },
  "its turn is running": { page: "a line is kept once its turn has ended", cli: "" },
  "it is already parked": { page: "r resumes it", cli: "`bb cow resume <thread>` takes it off the shelf; parking again is for work that has come back." },
  "it is not parked": { page: "p parks it", cli: "`bb cow park <thread> --reason <text>` parks it." },
  "it is parked: resume it, or wait until it comes back": { page: "r resumes it", cli: "" },
  "no turn is running": { page: "there is nothing to stop", cli: "" },
  [ARCHIVE_RUNNING]: { page: "x stops it, and p sets it aside as it is", cli: "Wait for its turn to end, or park it: `bb cow park <thread> --reason <text> --stop`." },
  [ARCHIVE_ASKING]: { page: "a answers it", cli: "The user answers it, in bb or with a on cow's page; then it can be archived." },
  [OTHER_MAIN_REFUSAL]: { page: "", cli: "Nothing in cow archives another project's Main: the user does it in bb if they mean to." },
  [ABOVE_MAIN_REFUSAL]: { page: "", cli: "bb archives a thread with what is under it, Main included: the user does it in bb if they mean to, and cow then asks for another Main." },
  [NOT_UNDER_MAIN]: { page: "A brings it under Main", cli: "Bring it under Main first: `bb thread update <thread> --parent-thread <main>`. Outside Main, `bb cow archive` is what works." },
  [OUTSIDE_REFUSAL]: { page: "", cli: "The user archives it with e on cow's page, or the thread that is Main runs `bb cow archive <thread> --reason <text>`." },
  [MAIN_ARCHIVE_REFUSAL]: { page: "archive it in bb, then choose another Main with M", cli: "Archive it with `bb thread archive <thread>` if you mean to; cow then asks for another Main." },
  "it is already archived": { page: "u takes back an archive made on this page", cli: "`bb thread unarchive <thread>` brings it back." },
  "threads under it are still open": { page: "archive or park those first", cli: "Archive or park those first: `bb cow status` lists them." },
  "it has an open ask: answer it, or have it withdrawn": { page: "a answers it", cli: "The user answers it on cow's page, or its thread runs `bb cow ask withdraw <id>` or `bb cow ask close <id> --answered <text>`." },
  "only done, idle, waiting, kept or failed lines can be archived": { page: "x stops a running turn, and p sets it aside as it is", cli: "Wait for its turn to end, or park it: `bb cow park <thread> --reason <text> --stop`." },
};

/** What to do instead of a refused verb, in the page's keys; empty when the reason already says. */
export function insteadOnPage(why: string): string {
  const instead = INSTEAD[why]?.page ?? "";
  return instead === "" || why.includes(instead) ? "" : instead;
}

/** The same for a refused command; empty when there is nothing to add. */
export const insteadFromCli = (why: string): string => INSTEAD[why]?.cli ?? "";

/**
 * Whether `a` on this line opens a thread's request for a capability: its
 * oldest open ask is one, and no request of bb's own or reminder comes first.
 */
export function decidesCapability(line: Line | null): boolean {
  if (line === null || line.thread.archivedAt !== null || line.thread.hasPendingInteraction || line.derived.wait?.due) return false;
  return line.derived.asks?.[0]?.capability != null;
}

/** What each verb is called on this line; parked work that came back reads differently. */
export function verbLabel(verb: Verb, line: Line | null): string {
  if (verb === "answer" && decidesCapability(line)) return "allow or refuse";
  const returned = line?.derived.park?.due != null;
  if (verb === "park") return returned ? "keep parked" : "park";
  if (verb === "stop") return returned ? "drop" : "stop";
  if (verb === "keep") return line?.derived.state === "kept" ? "unkeep" : "keep";
  return verb;
}
