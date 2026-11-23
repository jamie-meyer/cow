// How merge-readiness reads on a thread's line, in its context card, in
// `bb cow status`, and beside a brief or an ask about merging. Pure: the facts
// are worked out by the host entry (see facts.ts) and kept by cow's server
// (see backend.ts).

import { z } from "zod";
import type { CardRow, CardSection } from "../card.ts";
import { formatAge } from "../text.ts";

export const mergeFactsSchema = z.object({
  state: z.enum(["clean", "conflict", "unknown", "none"]),
  why: z.string().nullable(),
  base: z.string().nullable(),
  branch: z.string().nullable(),
  ahead: z.number().nullable(),
  behind: z.number().nullable(),
  conflicts: z.array(z.string()),
  conflictCount: z.number(),
  dirty: z.boolean().nullable(),
  head: z.string().nullable(),
  baseTip: z.string().nullable(),
  at: z.number(),
  checkedAt: z.number(),
  clone: z.boolean(),
});
export type MergeFacts = z.infer<typeof mergeFactsSchema>;

/** The realtime event cow's server publishes when an answer changes. */
export const MERGE_CHANGED = "merge:changed";

/** How many conflicting files the card names; the count says how many more there are. */
export const CARD_FILES = 5;
/** How many the line's tooltip, the status text and a note beside a brief name. */
export const NAMED_FILES = 3;

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
const baseName = (facts: MergeFacts) => facts.base ?? "its base";

/** Whether the line says anything at all: nothing for no commits of its own, already merged, or no git checkout. */
export const mergeShown = (facts: MergeFacts | null | undefined): facts is MergeFacts => facts != null && facts.state !== "none";

/** On the thread's line: short and quiet when all is well, loud only for a conflict. Null when there is nothing to say. */
export function mergeLineText(facts: MergeFacts | null | undefined): { text: string; tone: "quiet" | "loud"; title: string } | null {
  if (!mergeShown(facts)) return null;
  const into = `into ${baseName(facts)}${facts.clone ? " in the clone's source folder" : ""}`;
  const aside = facts.dirty ? "; uncommitted changes are not in the trial merge" : "";
  if (facts.state === "unknown") return { text: "merge not known", tone: "quiet", title: `whether it merges ${into} is not known: ${facts.why ?? "no reason given"}` };
  if (facts.state === "conflict") {
    const named = facts.conflicts.slice(0, NAMED_FILES).join(", ");
    const more = facts.conflictCount > NAMED_FILES ? ` and ${facts.conflictCount - NAMED_FILES} more` : "";
    return { text: `conflicts in ${files(facts.conflictCount)}`, tone: "loud", title: `a trial merge ${into} conflicts in ${named}${more}${aside}` };
  }
  const behind = facts.behind && facts.behind > 0 ? `${facts.behind} behind · ` : "";
  return { text: `${behind}merges cleanly${facts.dirty ? " · uncommitted aside" : ""}`, tone: "quiet", title: `${facts.ahead} ahead, ${facts.behind} behind ${baseName(facts)}; a trial merge ${into} is clean${aside}` };
}

/** The context card's section: ahead, behind, the base, the conflicting files, and when it was worked out. Null when there is nothing to say. */
export function mergeSection(facts: MergeFacts | null | undefined, now: number): CardSection | null {
  if (!mergeShown(facts)) return null;
  const where = facts.clone ? `${baseName(facts)}, in the source folder` : baseName(facts);
  const rows: CardRow[] = [];
  const when = `worked out ${formatAge(Math.max(0, now - facts.at))} ago`;
  if (facts.state === "unknown") {
    rows.push({ text: "not known", detail: facts.why ?? undefined, badges: [{ text: "not known", tone: "muted" }] });
  } else {
    rows.push(
      facts.state === "conflict"
        ? { text: `conflicts in ${files(facts.conflictCount)}`, badges: [{ text: "conflict", tone: "bad" }] }
        : { text: "merges cleanly", badges: [{ text: "clean", tone: "ok" }] },
    );
    for (const path of facts.conflicts.slice(0, CARD_FILES)) rows.push({ text: path, file: path, indent: 1 });
    if (facts.conflictCount > Math.min(CARD_FILES, facts.conflicts.length)) rows.push({ text: `and ${facts.conflictCount - Math.min(CARD_FILES, facts.conflicts.length)} more`, indent: 1 });
    rows.push({ text: `${facts.ahead} ahead · ${facts.behind} behind`, detail: facts.branch ? `${facts.branch} → ${where}` : undefined });
    if (facts.dirty) rows.push({ text: "uncommitted changes", detail: "not in the trial merge", badges: [{ text: "not counted", tone: "warn" }] });
  }
  rows.push({ text: when, detail: "again when either tip moves" });
  return { title: `Merge into ${baseName(facts)}`, rows };
}

/** The same facts for `bb cow status --json`: without the commit ids' bookkeeping. */
export interface StatusMerge {
  state: "clean" | "conflict" | "unknown";
  base: string | null;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  conflicts: string[];
  conflictCount: number;
  uncommitted: boolean | null;
  why: string | null;
  clone: boolean;
  /** When it was worked out. */
  at: number;
}

export function statusMerge(facts: MergeFacts | null | undefined): StatusMerge | null {
  if (!mergeShown(facts)) return null;
  return {
    state: facts.state as StatusMerge["state"],
    base: facts.base,
    branch: facts.branch,
    ahead: facts.ahead,
    behind: facts.behind,
    conflicts: facts.conflicts.slice(0, 20),
    conflictCount: facts.conflictCount,
    uncommitted: facts.dirty,
    why: facts.why,
    clone: facts.clone,
    at: facts.at,
  };
}

/** One status line's mark. */
export function statusMergeText(merge: StatusMerge): string {
  const base = merge.base ?? "its base";
  if (merge.state === "unknown") return `merge into ${base} not known: ${merge.why ?? "no reason given"}`;
  const counts = `${merge.ahead} ahead, ${merge.behind} behind ${base}`;
  const aside = merge.uncommitted ? "; uncommitted changes not in it" : "";
  if (merge.state === "clean") return `${counts} · merges cleanly${aside}`;
  const more = merge.conflictCount > NAMED_FILES ? ` and ${merge.conflictCount - NAMED_FILES} more` : "";
  return `${counts} · conflicts in ${files(merge.conflictCount)}: ${merge.conflicts.slice(0, NAMED_FILES).join(", ")}${more}${aside}`;
}

/** Beside a brief waiting for the person, or an ask about merging: what they should know before they say merge. Null unless it conflicts. */
export function conflictNote(facts: MergeFacts | null | undefined): string | null {
  if (!facts || facts.state !== "conflict") return null;
  const more = facts.conflictCount > NAMED_FILES ? ` and ${facts.conflictCount - NAMED_FILES} more` : "";
  return `its branch conflicts with ${baseName(facts)} in ${files(facts.conflictCount)}: ${facts.conflicts.slice(0, NAMED_FILES).join(", ")}${more}`;
}

/** An ask is about merging when its question or an option says so. */
export const asksAboutMerging = (ask: { question: string; options?: readonly { label: string; detail?: string | null }[] }): boolean =>
  /\bmerg/i.test(ask.question) || (ask.options ?? []).some((option) => /\bmerg/i.test(`${option.label} ${option.detail ?? ""}`));
