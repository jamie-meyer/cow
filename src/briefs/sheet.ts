// A brief as the page's sheet lays it out: the stops the cursor makes, in
// reading order. Disputes first, then the judgement calls, then the claims
// the checker did not dispute. Pure, so the order can be tested.

import type { Ask } from "../asks/ask.ts";
import type { Review, ReviewedClaim } from "./review.ts";

export type SheetItem =
  | { kind: "dispute" | "claim"; id: string; entry: ReviewedClaim }
  /** `ask` is the open ask this decision was raised as, when there is one to answer. */
  | { kind: "call"; id: string; text: string; askId: string | null; ask: Ask | null };

export function sheetItems(seen: Review, openAsks: readonly Ask[]): SheetItem[] {
  return [
    ...seen.disputes.map((entry): SheetItem => ({ kind: "dispute", id: `claim:${entry.claim.id}`, entry })),
    ...seen.judgementCalls.map(
      (call, index): SheetItem => ({ kind: "call", id: `call:${index}`, text: call.text, askId: call.askId, ask: openAsks.find((ask) => ask.id === call.askId) ?? null }),
    ),
    ...seen.claims.map((entry): SheetItem => ({ kind: "claim", id: `claim:${entry.claim.id}`, entry })),
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
  const disagreed = [...seen.disputes, ...seen.claims].filter((entry) => entry.disagreement !== null).length;
  const failed = seen.runs.failed > 0 ? `, and ${seen.runs.failed} that failed` : "";
  const agreement = seen.runs.done < 2 ? "" : disagreed === 0 ? "; the runs agreed on every claim" : `; the runs disagreed on ${disagreed} ${disagreed === 1 ? "claim" : "claims"}`;
  return { tone: "checked", text: `Audited by ${runs(seen.runs.done)} of ${model}${failed}${agreement}. It read only the evidence attached here.` };
}
