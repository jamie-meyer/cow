// Reading a brief against the checker's verdicts: which claims are disputed,
// and the order a person should read things in. Pure, for the CLI and the page.

import type { Brief, Claim, Label } from "./brief.ts";

/** The checker's verdict on one claim. Only this is ever shown as verification. */
export const VERDICTS = ["supported", "not-supported", "cannot-tell"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ClaimVerdict {
  id: string;
  /** One sentence: what the evidence literally shows. */
  shows: string;
  verdict: Verdict;
  /** For cannot-tell: the evidence that would settle it. */
  needs: string | null;
}

/** One independent run of the checker. */
export type CheckRun = (
  | { status: "running" }
  | { status: "done"; verdicts: ClaimVerdict[] }
  /** The checker did not answer in the required form, used a tool, failed or timed out. */
  | { status: "failed"; error: string; /** What the checker said, when it said something that could not be used. */ answer?: string | null }
) & {
  /** The hidden thread the checker ran in. */
  threadId: string;
  startedAt: number;
  finishedAt: number | null;
  /** 2 for a run started again because the first answer could not be read. */
  attempt?: number;
};

export interface Check {
  /** The model the checker was asked to use; null for bb's default. */
  model: string | null;
  /** The provider it ran on; null or absent for bb's default. */
  provider?: string | null;
  startedAt: number;
  runs: CheckRun[];
}

/**
 * "contradicted": the checker says the evidence does not support the claim.
 * "not-established": the checker cannot tell from the evidence.
 */
export type DisputeKind = "contradicted" | "not-established";

/**
 * Is a claim disputed? It is when the checker's verdict is weaker than the
 * agent's label warrants: `checked` or `inferred` but not supported, or
 * `checked` but cannot tell. A cannot-tell on a claim the agent itself
 * called inferred or not checked is agreement, not a dispute.
 */
export function disputeOf(label: Label, verdict: Verdict): DisputeKind | null {
  if (verdict === "not-supported") return label === "not-checked" ? null : "contradicted";
  if (verdict === "cannot-tell") return label === "checked" ? "not-established" : null;
  return null;
}

const WEAKNESS: Record<Verdict, number> = { "not-supported": 0, "cannot-tell": 1, supported: 2 };

/** A claim as a person reads it: the agent's label, and what the checker found. */
export interface ReviewedClaim {
  claim: Claim;
  /** The weakest verdict among the runs that answered; null when none did. */
  verdict: ClaimVerdict | null;
  dispute: DisputeKind | null;
  /** Each run's verdict on this claim, in run order, when the runs did not all agree. */
  disagreement: Verdict[] | null;
}

export type CheckState =
  /** No check was run on this brief. */
  | "unchecked"
  | "running"
  /** At least one run answered in the required form. */
  | "checked"
  /** Every run failed. The brief is not verified. */
  | "failed";

export interface Review {
  state: CheckState;
  model: string | null;
  runs: { done: number; failed: number; running: number };
  /** Why each failed run failed. */
  failures: string[];
  /** The same runs, each with what the checker answered when it answered something unusable, and whether it was a second try. */
  failed: { error: string; answer: string | null; retried: boolean }[];
  /** Disputed claims, contradicted ones first. */
  disputes: ReviewedClaim[];
  judgementCalls: Brief["judgementCalls"];
  /** The claims that are not disputed, in the brief's order. */
  claims: ReviewedClaim[];
  notDone: string[];
}

/** Read a brief against its check. */
export function review(brief: Brief, check: Check | null): Review {
  const runs = check?.runs ?? [];
  const done = runs.filter((run) => run.status === "done");
  const failed = runs.filter((run) => run.status === "failed");
  const running = runs.filter((run) => run.status === "running").length;
  const state: CheckState = running > 0 ? "running" : done.length > 0 ? "checked" : failed.length > 0 ? "failed" : "unchecked";

  const reviewed = brief.claims.map((claim): ReviewedClaim => {
    // A verdict counts only once every run has finished: a half-finished check shows nothing.
    const given = state === "checked" ? done.flatMap((run) => run.verdicts.filter((verdict) => verdict.id === claim.id)) : [];
    const weakest = given.reduce<ClaimVerdict | null>(
      (worst, verdict) => (worst === null || WEAKNESS[verdict.verdict] < WEAKNESS[worst.verdict] ? verdict : worst),
      null,
    );
    const differs = given.some((verdict) => verdict.verdict !== given[0]?.verdict);
    return {
      claim,
      verdict: weakest,
      dispute: weakest ? disputeOf(claim.label, weakest.verdict) : null,
      disagreement: differs ? given.map((verdict) => verdict.verdict) : null,
    };
  });
  const rank = (entry: ReviewedClaim) => (entry.dispute === "contradicted" ? 0 : 1);
  return {
    state,
    model: check?.model ?? null,
    runs: { done: done.length, failed: failed.length, running },
    failures: failed.map((run) => run.error),
    failed: failed.map((run) => ({ error: run.error, answer: run.answer ?? null, retried: (run.attempt ?? 1) > 1 })),
    disputes: reviewed.filter((entry) => entry.dispute !== null).sort((a, b) => rank(a) - rank(b)),
    judgementCalls: brief.judgementCalls,
    claims: reviewed.filter((entry) => entry.dispute === null),
    notDone: brief.notDone,
  };
}

/** What a thread's line says about its latest brief. */
export interface BriefMark {
  version: number;
  state: CheckState;
  contradicted: number;
  notEstablished: number;
  judgementCalls: number;
  /** When the brief was submitted, or its latest check finished. */
  at: number;
  /** The person has opened this version with this check. */
  read: boolean;
}

export function markOf(version: number, seen: Review, at = 0, read = false): BriefMark {
  return {
    version,
    state: seen.state,
    contradicted: seen.disputes.filter((entry) => entry.dispute === "contradicted").length,
    notEstablished: seen.disputes.filter((entry) => entry.dispute === "not-established").length,
    judgementCalls: seen.judgementCalls.length,
    at,
    read,
  };
}

/** How many claims the checker disputes. */
export const disputeCount = (mark: BriefMark): number => mark.contradicted + mark.notEstablished;

/**
 * Whether a brief is the person's to read: the checker disputes a claim, or
 * the agent left them a decision, and they have not opened it yet. A brief
 * that checked clean waits on nobody. Disputes exist only once a check has
 * answered, so a failed check adds nothing here; while one runs, the brief
 * waits for it.
 */
export function briefWaits(mark: BriefMark): boolean {
  if (mark.read || mark.state === "running") return false;
  return disputeCount(mark) > 0 || mark.judgementCalls > 0;
}

/** What a waiting brief's line says. */
export function briefWaitText(mark: BriefMark): string {
  const parts: string[] = [];
  const disputed = disputeCount(mark);
  if (disputed > 0) parts.push(`${disputed} disputed`);
  if (mark.judgementCalls > 0) parts.push(`${mark.judgementCalls} ${mark.judgementCalls === 1 ? "judgement call" : "judgement calls"}`);
  return `brief: ${parts.join(", ")}`;
}

/** The mark in a few words, for a line of the overview. */
export function markText(mark: BriefMark): string {
  if (mark.state === "unchecked") return "brief not checked";
  if (mark.state === "running") return "brief being checked";
  if (mark.state === "failed") return "brief: the check failed";
  const parts: string[] = [];
  if (mark.contradicted > 0) parts.push(`${mark.contradicted} contradicted`);
  if (mark.notEstablished > 0) parts.push(`${mark.notEstablished} not established`);
  return parts.length === 0 ? "brief checked, no disputes" : `brief disputed: ${parts.join(", ")}`;
}

const VERDICT_TEXT: Record<Verdict, string> = { supported: "supported", "not-supported": "not supported", "cannot-tell": "cannot tell" };
const DISPUTE_TEXT: Record<DisputeKind, string> = { contradicted: "CONTRADICTED", "not-established": "NOT ESTABLISHED" };
const LABEL_TEXT: Record<Label, string> = { checked: "checked", inferred: "inferred", "not-checked": "not checked" };

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export const SHOW_LIMITS = { disputes: 30, claims: 30, text: 300, answer: 4000 } as const;

function claimLines(entry: ReviewedClaim): string[] {
  const { claim, verdict } = entry;
  const head = `${entry.dispute ? `${DISPUTE_TEXT[entry.dispute]}  ` : ""}${claim.id}  “${cut(claim.text, SHOW_LIMITS.text)}”  (the agent says: ${LABEL_TEXT[claim.label]})`;
  if (!verdict) return [`  ${head}`, "      checker: no verdict"];
  const lines = [`  ${head}`, `      the evidence shows: ${cut(verdict.shows, SHOW_LIMITS.text)}`, `      checker: ${VERDICT_TEXT[verdict.verdict]}`];
  if (verdict.needs) lines.push(`      would settle it: ${cut(verdict.needs, SHOW_LIMITS.text)}`);
  if (entry.disagreement) lines.push(`      the runs disagree: ${entry.disagreement.map((v) => VERDICT_TEXT[v]).join(", ")}`);
  return lines;
}

/**
 * A brief as text: disputes first, then judgement calls, then the other
 * claims, then what was left undone. The agent's label is given as what the
 * agent says, never as a check.
 */
export function reviewText(head: { threadId: string; version: number; summary: string }, seen: Review): string {
  const out: string[] = [`Brief v${head.version} from ${head.threadId}`, `  ${cut(head.summary, 1200)}`, ""];
  const checker = seen.model ?? "bb's default model";
  if (seen.state === "unchecked") out.push("NOT CHECKED: no checker has audited this brief. Nothing below is verified.");
  else if (seen.state === "running") out.push(`Check running (${seen.runs.running} of ${seen.runs.running + seen.runs.done + seen.runs.failed} runs still going). Nothing below is verified yet.`);
  else if (seen.state === "failed") out.push("CHECK FAILED: no run of the checker gave a usable answer. Nothing below is verified.");
  else out.push(`Checked by ${checker}: ${seen.runs.done} ${seen.runs.done === 1 ? "run" : "runs"}${seen.runs.failed > 0 ? `, and ${seen.runs.failed} that failed` : ""}.`);
  for (const failure of seen.failed.slice(0, 5)) {
    out.push(`  failed run${failure.retried ? " (the second try: the first answer could not be read either)" : ""}: ${cut(failure.error, SHOW_LIMITS.text)}`);
    if (failure.answer !== null) {
      out.push(`  what the checker answered (${failure.answer.length} characters${failure.answer.length > SHOW_LIMITS.answer ? `, the first ${SHOW_LIMITS.answer} shown` : ""}):`);
      out.push(...failure.answer.slice(0, SHOW_LIMITS.answer).split("\n").map((line) => `    | ${line}`));
    }
  }

  out.push("", `Disputes (${seen.disputes.length})`);
  if (seen.disputes.length === 0) out.push(seen.state === "checked" ? "    none" : "    unknown: there is no check to dispute anything");
  for (const entry of seen.disputes.slice(0, SHOW_LIMITS.disputes)) out.push(...claimLines(entry));
  if (seen.disputes.length > SHOW_LIMITS.disputes) out.push(`    … and ${seen.disputes.length - SHOW_LIMITS.disputes} more, not listed`);

  out.push("", `Judgement calls for you (${seen.judgementCalls.length})`);
  if (seen.judgementCalls.length === 0) out.push("    none");
  for (const call of seen.judgementCalls) out.push(`  - ${cut(call.text, SHOW_LIMITS.text)}${call.askId ? `  (${call.askId})` : ""}`);

  out.push("", `Other claims (${seen.claims.length})`);
  if (seen.claims.length === 0) out.push("    none");
  for (const entry of seen.claims.slice(0, SHOW_LIMITS.claims)) out.push(...claimLines(entry));
  if (seen.claims.length > SHOW_LIMITS.claims) out.push(`    … and ${seen.claims.length - SHOW_LIMITS.claims} more, not listed`);

  out.push("", `Left undone (${seen.notDone.length})`);
  if (seen.notDone.length === 0) out.push("    nothing listed");
  for (const entry of seen.notDone) out.push(`  - ${cut(entry, SHOW_LIMITS.text)}`);
  return `${out.join("\n")}\n`;
}
