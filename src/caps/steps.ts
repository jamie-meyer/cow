// The steps that make a capability, wherever they start: a permission
// request, a permission bb refused, a thread's ask for one, or the sheet.
// The rule (which the person can widen or narrow), a name, an optional
// note, who it applies to, and then one sentence that says exactly what
// will be allowed for whom, which has to be confirmed. Pure.

import { type Result, type RuleDraft, type Scope, readName, readNote, readRule, sentence, suggestName } from "./cap.ts";
import type { Places } from "./paths.ts";

export type Stage = "kind" | "rule" | "name" | "note" | "scope" | "restate";

export interface StepsDraft {
  stage: Stage;
  /** True when the steps began with nothing proposed: the kind is asked first. */
  scratch: boolean;
  kind: "dir" | "command";
  mode: "exact" | "prefix";
  /** The rule as typed. */
  text: string;
  name: string;
  /** Whether the person has typed in the name: until then it follows the rule. */
  named: boolean;
  note: string;
  /** 1-based place among the scopes offered; null before a digit. */
  scope: number | null;
  /** Why Enter did nothing. */
  error: string;
}

export interface Proposal {
  kind: "dir" | "command";
  text: string;
}

/** Who a capability can apply to, as offered: always in this order. */
export function scopeChoices(threadId: string, mainId: string): Scope[] {
  return [
    { kind: "thread", threadId },
    { kind: "subtree", threadId },
    { kind: "main", threadId: mainId },
  ];
}

export function startSteps(proposal: Proposal | null): StepsDraft {
  const base = { scratch: proposal === null, mode: "exact" as const, named: false, note: "", scope: null, error: "" };
  if (proposal === null) return { ...base, stage: "kind", kind: "dir", text: "", name: "" };
  return { ...base, stage: "rule", kind: proposal.kind, text: proposal.text, name: suggestName(ruleOf({ kind: proposal.kind, mode: "exact", text: proposal.text })) };
}

function ruleOf(draft: Pick<StepsDraft, "kind" | "mode" | "text">): RuleDraft {
  return draft.kind === "dir" ? { kind: "dir", text: draft.text } : { kind: "command", mode: draft.mode, text: draft.text };
}

/** Type in the field of the stage that has one. */
export function write(draft: StepsDraft, value: string): StepsDraft {
  if (draft.stage === "rule") {
    const next = { ...draft, text: value, error: "" };
    return draft.named ? next : { ...next, name: suggestName(ruleOf(next)) };
  }
  if (draft.stage === "name") return { ...draft, name: value, named: true, error: "" };
  if (draft.stage === "note") return { ...draft, note: value, error: "" };
  return draft;
}

/** A command rule is the exact line, or a prefix of its words. */
export function toggleMode(draft: StepsDraft): StepsDraft {
  if (draft.stage !== "rule" || draft.kind !== "command") return draft;
  return { ...draft, mode: draft.mode === "exact" ? "prefix" : "exact", error: "" };
}

/** A digit: the kind, from scratch; or who it applies to. It never moves on by itself. */
export function digit(draft: StepsDraft, number: number, scopes: readonly Scope[]): StepsDraft {
  if (draft.stage === "kind" && (number === 1 || number === 2)) return { ...draft, kind: number === 1 ? "dir" : "command", error: "" };
  if (draft.stage === "scope" && scopes[number - 1]) return { ...draft, scope: number, error: "" };
  return draft;
}

export type Advanced =
  | { kind: "stay"; draft: StepsDraft }
  /** The sentence was confirmed: make it. */
  | { kind: "save"; rule: RuleDraft; name: string; note: string | null; scope: Scope };

/** Enter: check this stage and go to the next; on the sentence, save. */
export function advance(draft: StepsDraft, scopes: readonly Scope[], places: Places): Advanced {
  const stay = (change: Partial<StepsDraft>): Advanced => ({ kind: "stay", draft: { ...draft, error: "", ...change } });
  switch (draft.stage) {
    case "kind":
      return stay({ stage: "rule" });
    case "rule": {
      const rule = readRule(ruleOf(draft), places);
      if (!rule.ok) return stay({ error: rule.error });
      // The field shows the rule as it will be stored.
      const text = rule.value.kind === "dir" ? rule.value.dir : rule.value.text;
      const next = { ...draft, text };
      return stay({ stage: "name", text, name: draft.named ? draft.name : suggestName(ruleOf(next)) });
    }
    case "name": {
      const name = readName(draft.name);
      return name.ok ? stay({ stage: "note", name: name.value }) : stay({ error: name.error });
    }
    case "note": {
      const note = readNote(draft.note);
      return note.ok ? stay({ stage: "scope", note: note.value ?? "" }) : stay({ error: note.error });
    }
    case "scope":
      return draft.scope === null || !scopes[draft.scope - 1] ? stay({ error: "choose who it applies to first" }) : stay({ stage: "restate" });
    case "restate": {
      const scope = draft.scope === null ? undefined : scopes[draft.scope - 1];
      const name = readName(draft.name);
      const note = readNote(draft.note);
      if (!scope || !name.ok || !note.ok) return stay({ stage: "scope", error: "choose who it applies to first" });
      return { kind: "save", rule: ruleOf(draft), name: name.value, note: note.value, scope };
    }
  }
}

const ORDER: readonly Stage[] = ["kind", "rule", "name", "note", "scope", "restate"];

/** Escape: back one stage, or null when there is none before this one. */
export function back(draft: StepsDraft): StepsDraft | null {
  const at = ORDER.indexOf(draft.stage);
  const first = draft.scratch ? 0 : 1;
  if (at <= first) return null;
  return { ...draft, stage: ORDER[at - 1]!, error: "" };
}

/** The sentence the last stage shows, or why there is none yet. */
export function restated(draft: StepsDraft, scopes: readonly Scope[], places: Places, titleOf: (threadId: string) => string): Result<string> {
  const rule = readRule(ruleOf(draft), places);
  if (!rule.ok) return { ok: false, error: rule.error };
  const scope = draft.scope === null ? undefined : scopes[draft.scope - 1];
  if (!scope) return { ok: false, error: "choose who it applies to first" };
  return { ok: true, value: sentence(rule.value, scope, titleOf) };
}
