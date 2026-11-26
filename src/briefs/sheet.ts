// A brief as the page's sheet lays it out: the stops the cursor makes, in
// reading order. Disputes first (a change to what decides whether its checks
// pass, then claims, then the task's checks), then the judgement calls, then
// the claims and task checks the checker did not dispute. A brief that has
// something for the person opens on that: its disputes and judgement calls,
// then one stop that counts the rest and unfolds it. Pure, so the order can
// be tested.

import type { Ask } from "../asks/ask.ts";
import { type Review, type ReviewedClaim, type ReviewedTask, restText } from "./review.ts";

export type SheetItem =
  | { kind: "dispute" | "claim"; id: string; entry: ReviewedClaim }
  /** The dispute cow raises with no model: the files that decide whether the job's checks pass changed. */
  | { kind: "flag"; id: string; files: string[] }
  /** A check the task sets; `disputed` when it was not shown or could not be told. */
  | { kind: "task"; id: string; entry: ReviewedTask; disputed: boolean }
  /** `ask` is the open ask this decision was raised as, when there is one to answer. */
  | { kind: "call"; id: string; text: string; askId: string | null; ask: Ask | null }
  /** On a brief that needs the person: the line that counts everything else, folded until it is opened. */
  | { kind: "rest"; id: "rest"; text: string; open: boolean };

/**
 * The stops, in reading order. `fold` is given for a brief that needs the
 * person: what is in doubt and what is theirs to decide comes first, and the
 * rest sits behind one stop, under it only once `fold.open`.
 */
export function sheetItems(seen: Review, openAsks: readonly Ask[], fold: { open: boolean } | null = null): SheetItem[] {
  const task = (entry: ReviewedTask): SheetItem => ({ kind: "task", id: `task:${entry.id}`, entry, disputed: entry.dispute !== null });
  return [
    ...(seen.flagged.length > 0 ? [{ kind: "flag", id: "flag", files: seen.flagged } as const] : []),
    ...seen.disputes.map((entry): SheetItem => ({ kind: "dispute", id: `claim:${entry.claim.id}`, entry })),
    ...seen.taskDisputes.map(task),
    ...seen.judgementCalls.map(
      (call, index): SheetItem => ({ kind: "call", id: `call:${index}`, text: call.text, askId: call.askId, ask: openAsks.find((ask) => ask.id === call.askId) ?? null }),
    ),
    ...(fold ? [{ kind: "rest", id: "rest", text: restText(seen), open: fold.open } as const] : []),
    ...(fold === null || fold.open
      ? [...seen.claims.map((entry): SheetItem => ({ kind: "claim", id: `claim:${entry.claim.id}`, entry })), ...seen.tasks.filter((entry) => entry.dispute === null).map(task)]
      : []),
  ];
}

/** The stop `by` places from `current`, staying inside the list; the first when `current` is not in it. */
export function moveStop(items: readonly SheetItem[], current: string | null, by: number): string | null {
  if (items.length === 0) return null;
  const at = items.findIndex((item) => item.id === current);
  if (at < 0) return items[0]!.id;
  return items[Math.max(0, Math.min(items.length - 1, at + by))]!.id;
}

/** How the check went, in the words the sheet's heading uses. Only a check that answered is ever called a check. */
export function checkLine(seen: Review): { tone: "failed" | "running" | "none" | "checked"; text: string } {
  const model = seen.checker;
  const runs = (count: number) => `${count} ${count === 1 ? "run" : "runs"}`;
  if (seen.state === "failed") return { tone: "failed", text: "Check failed: no run of the checker gave a usable answer. Nothing below is verified." };
  if (seen.state === "running") return { tone: "running", text: `Checking now (${runs(seen.runs.running)} of ${model} still going). Nothing below is verified yet.` };
  if (seen.state === "unchecked") return { tone: "none", text: "Not checked: no checker has audited this brief. Nothing below is verified." };
  const disagreed = [...seen.disputes, ...seen.claims, ...seen.tasks].filter((entry) => entry.disagreement !== null).length;
  const failed = seen.runs.failed > 0 ? `, and ${seen.runs.failed} that failed` : "";
  const agreement = seen.runs.done < 2 ? "" : disagreed === 0 ? "; the runs agreed on every claim" : `; the runs disagreed on ${disagreed} ${disagreed === 1 ? "claim" : "claims"}`;
  return { tone: "checked", text: `Audited by ${runs(seen.runs.done)} of ${model}${failed}${agreement}. ${readText(seen)}` };
}

/** What the checker read, in a sentence. A brief stored before 0.2.18 says what it always said. */
export function readText(seen: Review): string {
  const shown = seen.shown;
  if (shown === null) return "It read only the evidence attached here.";
  const parts = ["the claims and their evidence"];
  if (shown.task.state === "read") parts.push(shown.task.checks.length > 0 ? `the task with its ${shown.task.checks.length} ${shown.task.checks.length === 1 ? "check" : "checks"}` : "the task");
  if (shown.diff.state === "collected") parts.push(shown.diff.clipped.length + shown.diff.omitted.length > 0 ? "the diff, clipped" : "the diff");
  const last = parts.pop();
  return `It read ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}; not the agent's summary or labels. It ran nothing.`;
}
