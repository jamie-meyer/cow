// Reading a brief against the checker's verdicts: which claims are disputed,
// and the order a person should read things in. Pure, for the CLI and the page.

import type { Brief, Claim, Label } from "./brief.ts";
import type { ChangedFile } from "./paths.ts";
import { type ChosenBy, checkerOn } from "./provider.ts";

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
  /** `tasks`: a verdict on each check the task sets (none on runs from before 0.2.18). `unaccounted`: changed files no claim accounts for. */
  | { status: "done"; verdicts: ClaimVerdict[]; tasks?: ClaimVerdict[]; unaccounted?: string[] }
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
  /** Where the provider and the model came from; absent on checks recorded before 0.2.12. */
  chosen?: { provider: ChosenBy; model: ChosenBy };
  startedAt: number;
  runs: CheckRun[];
}

/** The most changed files a record keeps; the checker is shown them all (up to DIFF_LIMITS.files). */
export const SHOWN_FILES = 300;

/**
 * What the checker was shown besides the brief, as the record keeps it: the
 * task and its checks, and what changed, without the diff text. Absent on
 * briefs stored before 0.2.18.
 */
export interface Shown {
  task: { state: "none"; why: string } | { state: "read"; chars: number; clipped: boolean; hasSection: boolean; checks: string[]; checksDropped: number };
  diff:
    | { state: "off" }
    | { state: "none"; why: string }
    | {
        state: "collected";
        /** The commit compared against, and what it is. */
        base: string;
        baseText: string;
        /** The changed files, the first `SHOWN_FILES` of them. */
        files: ChangedFile[];
        filesTotal: number;
        /** Characters of diff before clipping. */
        chars: number;
        clipped: string[];
        omitted: string[];
        namesOnly: { path: string; why: "lock file" | "binary" | "secret" }[];
      };
  /** Files whose change decides whether the job's checks pass (see paths.ts): a dispute with no model behind it. */
  flagged: string[];
  /** When cow collected it. */
  at: number;
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

/** A check the task's "Done means" section sets, as a person reads it. */
export interface ReviewedTask {
  id: string;
  text: string;
  /** The weakest verdict among the runs that answered; null when none did. */
  verdict: ClaimVerdict | null;
  /** Not shown ("contradicted"), or cannot be told ("not-established"); either is a dispute. */
  dispute: DisputeKind | null;
  disagreement: Verdict[] | null;
}

/** A task check's verdict as a dispute: anything short of shown is one. */
export const taskDisputeOf = (verdict: Verdict): DisputeKind | null => (verdict === "not-supported" ? "contradicted" : verdict === "cannot-tell" ? "not-established" : null);

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
  provider: string | null;
  /** The provider and model in words, saying when they are the submitting thread's. */
  checker: string;
  runs: { done: number; failed: number; running: number };
  /** When the check's last run finished; null while none has. */
  checkedAt: number | null;
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
  /** Every check the task sets, in order, with what the checker said of it. */
  tasks: ReviewedTask[];
  /** The task checks that are disputed, not shown first. */
  taskDisputes: ReviewedTask[];
  /** The files that changed what decides whether the job's checks pass; empty when none. Disputed whatever the checker says. */
  flagged: string[];
  /** Changed files no claim accounts for, by any run that answered: a note, not a dispute. */
  unaccounted: string[];
  /** What the checker was shown; null on briefs stored before 0.2.18. */
  shown: Shown | null;
}

/** "claude-code, model claude-opus-5-5, the submitting thread's". */
function checkerText(check: Check | null): string {
  const on = checkerOn(check?.provider ?? null, check?.model ?? null);
  const chosen = check?.chosen;
  if (chosen?.provider === "inherited" && chosen.model !== "given" && chosen.model !== "setting") return `${on}, as the submitting thread ran`;
  if (chosen?.provider === "inherited") return `${on}, on the submitting thread's provider`;
  return on;
}

const weakestOf = (given: readonly ClaimVerdict[]): ClaimVerdict | null =>
  given.reduce<ClaimVerdict | null>((worst, verdict) => (worst === null || WEAKNESS[verdict.verdict] < WEAKNESS[worst.verdict] ? verdict : worst), null);

/** Read a brief against its check, and against what the checker was shown. */
export function review(brief: Brief, check: Check | null, shown: Shown | null = null): Review {
  const runs = check?.runs ?? [];
  const done = runs.filter((run) => run.status === "done");
  const failed = runs.filter((run) => run.status === "failed");
  const running = runs.filter((run) => run.status === "running").length;
  const state: CheckState = running > 0 ? "running" : done.length > 0 ? "checked" : failed.length > 0 ? "failed" : "unchecked";

  const reviewed = brief.claims.map((claim): ReviewedClaim => {
    // A verdict counts only once every run has finished: a half-finished check shows nothing.
    const given = state === "checked" ? done.flatMap((run) => run.verdicts.filter((verdict) => verdict.id === claim.id)) : [];
    const weakest = weakestOf(given);
    const differs = given.some((verdict) => verdict.verdict !== given[0]?.verdict);
    return {
      claim,
      verdict: weakest,
      dispute: weakest ? disputeOf(claim.label, weakest.verdict) : null,
      disagreement: differs ? given.map((verdict) => verdict.verdict) : null,
    };
  });
  const rank = (entry: { dispute: DisputeKind | null }) => (entry.dispute === "contradicted" ? 0 : 1);
  const checks = shown?.task.state === "read" ? shown.task.checks : [];
  const tasks = checks.map((text, index): ReviewedTask => {
    const id = `t${index + 1}`;
    const given = state === "checked" ? done.flatMap((run) => (run.tasks ?? []).filter((verdict) => verdict.id === id)) : [];
    const weakest = weakestOf(given);
    const differs = given.some((verdict) => verdict.verdict !== given[0]?.verdict);
    return { id, text, verdict: weakest, dispute: weakest ? taskDisputeOf(weakest.verdict) : null, disagreement: differs ? given.map((verdict) => verdict.verdict) : null };
  });
  const unaccounted = state === "checked" ? [...new Set(done.flatMap((run) => run.unaccounted ?? []))] : [];
  return {
    state,
    model: check?.model ?? null,
    provider: check?.provider ?? null,
    checker: checkerText(check),
    runs: { done: done.length, failed: failed.length, running },
    checkedAt: runs.some((run) => run.finishedAt !== null) ? Math.max(...runs.map((run) => run.finishedAt ?? 0)) : null,
    failures: failed.map((run) => run.error),
    failed: failed.map((run) => ({ error: run.error, answer: run.answer ?? null, retried: (run.attempt ?? 1) > 1 })),
    disputes: reviewed.filter((entry) => entry.dispute !== null).sort((a, b) => rank(a) - rank(b)),
    judgementCalls: brief.judgementCalls,
    claims: reviewed.filter((entry) => entry.dispute === null),
    notDone: brief.notDone,
    tasks,
    taskDisputes: tasks.filter((entry) => entry.dispute !== null).sort((a, b) => rank(a) - rank(b)),
    flagged: shown?.flagged ?? [],
    unaccounted,
    shown,
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
  /**
   * Set when an earlier check of this version disputed claims and the check
   * was run again before the person had read them: how many it disputed. A
   * check anyone can order must not be a way to take a dispute out of the
   * queue, so the brief waits on the person whatever the new check says.
   */
  earlierDisputes?: number;
  /** With `earlierDisputes`: how many of them the evidence contradicted, the rest it could not confirm. Null when not recorded (before 0.2.14). */
  earlierContradicted?: number | null;
  /** Set when this is not the version's first check: a check that was run again. */
  rechecked?: true;
  /** Set when the checker disputes checks the task sets: how many it found not shown or could not tell. */
  tasks?: number;
  /** Set when the diff changed what decides whether the job's checks pass: how many files. One dispute, whatever the check says. */
  flagged?: number;
}

export function markOf(version: number, seen: Review, at = 0, read = false, earlierDisputes = 0, rechecked = false, earlierContradicted: number | null = null): BriefMark {
  const tasks = seen.taskDisputes.length;
  return {
    ...(earlierDisputes > 0 ? { earlierDisputes, earlierContradicted } : {}),
    ...(rechecked ? { rechecked: true as const } : {}),
    ...(tasks > 0 ? { tasks } : {}),
    ...(seen.flagged.length > 0 ? { flagged: seen.flagged.length } : {}),
    version,
    state: seen.state,
    contradicted: seen.disputes.filter((entry) => entry.dispute === "contradicted").length,
    notEstablished: seen.disputes.filter((entry) => entry.dispute === "not-established").length,
    judgementCalls: seen.judgementCalls.length,
    at,
    read,
  };
}

/** How many disputes the checker found: claims and task checks. A rerun must not take these out of the queue unread. */
export const checkerDisputes = (mark: BriefMark): number => mark.contradicted + mark.notEstablished + (mark.tasks ?? 0);

/** How many disputes a brief has: claims and task checks the checker disputes, and one for a change to what decides whether its checks pass. */
export const disputeCount = (mark: BriefMark): number => mark.contradicted + mark.notEstablished + (mark.tasks ?? 0) + ((mark.flagged ?? 0) > 0 ? 1 : 0);

/**
 * Whether a brief is the person's to read: the checker disputes a claim, or
 * the agent left them a decision, and they have not opened it yet. A brief
 * that checked clean waits on nobody. Disputes exist only once a check has
 * answered, so a failed check adds nothing here; while a version's first
 * check runs, the brief waits for it. Anyone can order a check again, so
 * doing that takes nothing out of the queue: a dispute the person never read
 * keeps the brief waiting through the new check and whatever it says, and a
 * judgement call waits while the new check runs too, until they open it. A
 * diff that changed what decides whether the job's checks pass needs no
 * check: it waits from the start, whatever the check comes to.
 */
export function briefWaits(mark: BriefMark): boolean {
  if (mark.read) return false;
  if ((mark.earlierDisputes ?? 0) > 0) return true;
  // Found without a model: it stands whatever becomes of the check, and while it runs.
  if ((mark.flagged ?? 0) > 0) return true;
  if (mark.state === "running" && !mark.rechecked) return false;
  return disputeCount(mark) > 0 || mark.judgementCalls > 0;
}

const claims = (n: number) => `${n} ${n === 1 ? "claim" : "claims"}`;

/**
 * What an earlier check found, in the words of what was counted: claims the
 * evidence contradicted, and claims it could not confirm. Both put a brief in
 * front of the person; only the first is the evidence saying a claim is wrong.
 * "contradicted 1 claim and could not confirm 2 claims".
 */
export function foundText(count: number, contradicted: number | null): string {
  if (contradicted === null) return `contradicted or could not confirm ${claims(count)}`;
  const unconfirmed = Math.max(0, count - contradicted);
  const parts = [...(contradicted > 0 ? [`contradicted ${claims(contradicted)}`] : []), ...(unconfirmed > 0 ? [`could not confirm ${claims(unconfirmed)}`] : [])];
  return parts.join(" and ");
}

/** What a brief says of disputes an earlier check found and the person never read; empty when there are none. */
export function earlierDisputesText(count: number, contradicted: number | null = null): string {
  if (count <= 0) return "";
  return `an earlier check of this version ${foundText(count, contradicted)}, and the check was run again before you had read ${count === 1 ? "it" : "them"}`;
}

/** "2026-11-19 14:03 UTC": the same on every machine, so the CLI and the page agree. */
export function dateText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A run of the check again that gave no usable answer, kept beside the check it did not replace. */
export interface FailedRecheck {
  startedAt: number;
  finishedAt: number;
  provider: string | null;
  model: string | null;
  errors: string[];
}

/** "checked again on <date>: that attempt failed (<cause>); the check below is from <date>". */
export function failedRecheckText(failed: FailedRecheck, checkedAt: number | null): string {
  const causes = [...new Set(failed.errors)];
  const cause = causes.length === 0 ? "no run gave a usable answer" : causes.join("; ");
  const kept = checkedAt === null ? "is the one before it" : `is from ${dateText(checkedAt)}`;
  return `checked again on ${dateText(failed.startedAt)}: that attempt failed (${cause}); the check below ${kept}`;
}

/** What a waiting brief's line says. */
export function briefWaitText(mark: BriefMark): string {
  const parts: string[] = [];
  if ((mark.flagged ?? 0) > 0) parts.push(GATE_TEXT);
  const disputed = disputeCount(mark) - ((mark.flagged ?? 0) > 0 ? 1 : 0);
  if (disputed > 0) parts.push(`${disputed} disputed`);
  if (mark.judgementCalls > 0) parts.push(`${mark.judgementCalls} ${mark.judgementCalls === 1 ? "judgement call" : "judgement calls"}`);
  const earlier = mark.earlierDisputes ?? 0;
  if (earlier > 0) parts.push(`an earlier check, run again unread, ${foundText(earlier, mark.earlierContradicted ?? null)}`);
  return `brief: ${parts.join(", ")}`;
}

/** The model-free dispute, in the words the queue, the text and the sheet use. */
export const GATE_TEXT = "changed what decides whether its checks pass";

/** The mark in a few words, for a line of the overview. */
export function markText(mark: BriefMark): string {
  const gate = (mark.flagged ?? 0) > 0 ? `; ${GATE_TEXT}` : "";
  if (mark.state === "unchecked") return `brief not checked${gate}`;
  if (mark.state === "running") return `brief being checked${gate}`;
  if (mark.state === "failed") return `brief: the check failed${gate}`;
  const parts: string[] = [];
  if (mark.contradicted > 0) parts.push(`${mark.contradicted} contradicted`);
  if (mark.notEstablished > 0) parts.push(`${mark.notEstablished} not established`);
  if ((mark.tasks ?? 0) > 0) parts.push(`${mark.tasks} task ${mark.tasks === 1 ? "check" : "checks"} not shown`);
  return parts.length === 0 ? (gate === "" ? "brief checked, no disputes" : `brief disputed: ${GATE_TEXT}`) : `brief disputed: ${parts.join(", ")}${gate}`;
}

const VERDICT_TEXT: Record<Verdict, string> = { supported: "supported", "not-supported": "not supported", "cannot-tell": "cannot tell" };
const DISPUTE_TEXT: Record<DisputeKind, string> = { contradicted: "CONTRADICTED", "not-established": "NOT ESTABLISHED" };
const LABEL_TEXT: Record<Label, string> = { checked: "checked", inferred: "inferred", "not-checked": "not checked" };

const cut = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** `error` is long enough for a failure's cause and the command that runs the check elsewhere. */
export const SHOW_LIMITS = { disputes: 30, claims: 30, text: 300, error: 1200, answer: 4000 } as const;

/** The checker's verdict and what it saw first; the agent's own label after, as what the agent says. */
function claimLines(entry: ReviewedClaim): string[] {
  const { claim, verdict } = entry;
  const head = `${entry.dispute ? `${DISPUTE_TEXT[entry.dispute]}  ` : ""}${claim.id}  “${cut(claim.text, SHOW_LIMITS.text)}”`;
  const label = `      the agent says: ${LABEL_TEXT[claim.label]}  (its own word, not a check)`;
  if (!verdict) return [`  ${head}`, "      checker: no verdict", label];
  const lines = [`  ${head}`, `      checker: ${VERDICT_TEXT[verdict.verdict]}`, `      the evidence shows: ${cut(verdict.shows, SHOW_LIMITS.text)}`];
  if (verdict.needs) lines.push(`      would settle it: ${cut(verdict.needs, SHOW_LIMITS.text)}`);
  if (entry.disagreement) lines.push(`      the runs disagree: ${entry.disagreement.map((v) => VERDICT_TEXT[v]).join(", ")}`);
  lines.push(label);
  return lines;
}

const TASK_DISPUTE_TEXT: Record<DisputeKind, string> = { contradicted: "NOT SHOWN", "not-established": "CANNOT TELL" };

function taskLines(entry: ReviewedTask): string[] {
  const head = `  ${entry.dispute ? `${TASK_DISPUTE_TEXT[entry.dispute]}  ` : ""}task ${entry.id}  “${cut(entry.text, SHOW_LIMITS.text)}”`;
  if (!entry.verdict) return [head, "      checker: no verdict"];
  const lines = [head, `      checker: ${entry.verdict.verdict === "supported" ? "shown" : VERDICT_TEXT[entry.verdict.verdict]}`, `      it saw: ${cut(entry.verdict.shows, SHOW_LIMITS.text)}`];
  if (entry.verdict.needs) lines.push(`      would settle it: ${cut(entry.verdict.needs, SHOW_LIMITS.text)}`);
  if (entry.disagreement) lines.push(`      the runs disagree: ${entry.disagreement.map((v) => VERDICT_TEXT[v]).join(", ")}`);
  return lines;
}

const names = (paths: readonly string[], max = 10): string => `${paths.slice(0, max).join(", ")}${paths.length > max ? `, and ${paths.length - max} more` : ""}`;

/** What the checker was shown besides the brief, in lines; empty for a brief stored before 0.2.18. */
export function shownLines(shown: Shown | null): string[] {
  if (shown === null) return [];
  const out: string[] = [];
  const { task, diff } = shown;
  if (task.state === "none") out.push(`  task: none (${task.why})`);
  else {
    const checks = task.checks.length === 0 ? (task.hasSection ? 'a "Done means" section with no checks cow could read' : 'no "Done means" section') : `${task.checks.length} ${task.checks.length === 1 ? "check" : "checks"} from its "Done means" section${task.checksDropped > 0 ? ` (${task.checksDropped} more dropped)` : ""}`;
    out.push(`  task: the thread's first message, ${task.chars} characters${task.clipped ? ", cut short" : ""}; ${checks}`);
  }
  if (diff.state === "off") out.push("  diff: none, turned off in cow's settings");
  else if (diff.state === "none") out.push(`  diff: none (${diff.why})`);
  else {
    out.push(`  diff: against ${diff.base.slice(0, 12)}, ${diff.baseText}; ${diff.filesTotal} changed ${diff.filesTotal === 1 ? "file" : "files"}, ${diff.chars} characters of diff`);
    if (diff.clipped.length > 0) out.push(`    cut short: ${names(diff.clipped)}`);
    if (diff.omitted.length > 0) out.push(`    left out for want of room: ${names(diff.omitted)}`);
    if (diff.namesOnly.length > 0) out.push(`    by name only: ${names(diff.namesOnly.map((entry) => `${entry.path} (${entry.why})`))}`);
  }
  return out;
}

/**
 * A brief as text: disputes first (a change to what decides whether its
 * checks pass, then claims, then task checks), then judgement calls, then
 * the other claims and task checks, then what was left undone and what the
 * checker was shown. Each claim gives the checker's verdict and what the
 * evidence shows first, and the agent's own label after, as what the agent
 * says, never as a check.
 */
export function reviewText(
  head: { threadId: string; version: number; summary: string; earlierDisputes?: number; earlierContradicted?: number | null; failedRecheck?: FailedRecheck | null },
  seen: Review,
): string {
  const out: string[] = [`Brief v${head.version} from ${head.threadId}`, `  ${cut(head.summary, 1200)}`, ""];
  if (head.failedRecheck) out.push(`${cut(failedRecheckText(head.failedRecheck, seen.checkedAt), SHOW_LIMITS.error)}`.replace(/^c/, "C"));
  const checker = seen.checker;
  if (seen.state === "unchecked") out.push("NOT CHECKED: no checker has audited this brief. Nothing below is verified.");
  else if (seen.state === "running") out.push(`Check running (${seen.runs.running} of ${seen.runs.running + seen.runs.done + seen.runs.failed} runs still going). Nothing below is verified yet.`);
  else if (seen.state === "failed") out.push("CHECK FAILED: no run of the checker gave a usable answer. Nothing below is verified.");
  else out.push(`Checked by ${checker}: ${seen.runs.done} ${seen.runs.done === 1 ? "run" : "runs"}${seen.runs.failed > 0 ? `, and ${seen.runs.failed} that failed` : ""}.`);
  for (const failure of seen.failed.slice(0, 5)) {
    out.push(`  failed run${failure.retried ? " (the second try: the first answer could not be read either)" : ""}: ${cut(failure.error, SHOW_LIMITS.error)}`);
    if (failure.answer !== null) {
      out.push(`  what the checker answered (${failure.answer.length} characters${failure.answer.length > SHOW_LIMITS.answer ? `, the first ${SHOW_LIMITS.answer} shown` : ""}):`);
      out.push(...failure.answer.slice(0, SHOW_LIMITS.answer).split("\n").map((line) => `    | ${line}`));
    }
  }

  const earlier = earlierDisputesText(head.earlierDisputes ?? 0, head.earlierContradicted ?? null);
  if (earlier !== "") out.push(`  NOTE: ${earlier}. This check replaced that one.`);

  const gate = seen.flagged.length > 0 ? 1 : 0;
  const count = seen.disputes.length + seen.taskDisputes.length + gate;
  out.push("", `Disputes (${count})`);
  if (gate > 0) out.push(`  ${GATE_TEXT.toUpperCase()}  (found by cow from the file list, with no model)`, `      ${names(seen.flagged, 30)}`);
  if (count === 0) out.push(seen.state === "checked" ? "    none" : "    unknown: there is no check to dispute anything");
  else if (gate > 0 && seen.state !== "checked") out.push("    the claims: unknown, there is no check to dispute them");
  for (const entry of seen.disputes.slice(0, SHOW_LIMITS.disputes)) out.push(...claimLines(entry));
  if (seen.disputes.length > SHOW_LIMITS.disputes) out.push(`    … and ${seen.disputes.length - SHOW_LIMITS.disputes} more, not listed`);
  for (const entry of seen.taskDisputes) out.push(...taskLines(entry));

  out.push("", `Judgement calls for you (${seen.judgementCalls.length})`);
  if (seen.judgementCalls.length === 0) out.push("    none");
  for (const call of seen.judgementCalls) out.push(`  - ${cut(call.text, SHOW_LIMITS.text)}${call.askId ? `  (${call.askId})` : ""}`);

  out.push("", `Other claims (${seen.claims.length})`);
  if (seen.claims.length === 0) out.push("    none");
  for (const entry of seen.claims.slice(0, SHOW_LIMITS.claims)) out.push(...claimLines(entry));
  if (seen.claims.length > SHOW_LIMITS.claims) out.push(`    … and ${seen.claims.length - SHOW_LIMITS.claims} more, not listed`);

  const passed = seen.tasks.filter((entry) => entry.dispute === null);
  if (seen.tasks.length > 0) {
    out.push("", `The task's other checks (${passed.length})`);
    if (passed.length === 0) out.push("    none");
    for (const entry of passed) out.push(...taskLines(entry));
  }
  if (seen.unaccounted.length > 0) {
    out.push("", `NOTE: changed files no claim accounts for, as the checker read it (${seen.unaccounted.length})`, `      ${names(seen.unaccounted, 30)}`);
  }

  out.push("", `Left undone (${seen.notDone.length})`);
  if (seen.notDone.length === 0) out.push("    nothing listed");
  for (const entry of seen.notDone) out.push(`  - ${cut(entry, SHOW_LIMITS.text)}`);
  const shown = shownLines(seen.shown);
  if (shown.length > 0) out.push("", "What the checker was shown, besides the claims and their evidence (not the summary, and not the agent's labels)", ...shown);
  return `${out.join("\n")}\n`;
}
