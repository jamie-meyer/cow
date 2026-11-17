// A capability: a named, reusable grant the person gives to threads. It lets
// cow answer one of bb's permission requests "allow once" without asking,
// when the request is from a thread it applies to and it covers the whole
// request. Everything here is pure; the page and the backend both use it.

import { z } from "zod";
import { readCommandRule } from "./command.ts";
import { type Places, readDirectoryRule } from "./paths.ts";

export const CAP_LIMITS = { name: 60, note: 300, why: 600 } as const;

/** Realtime channel: published whenever a capability, a notice or the log changes. */
export const CAPS_CHANGED = "caps-changed";

export const ruleSchema = z.union([
  /** Create and change files anywhere under this absolute directory. */
  z.object({ kind: z.literal("dir"), dir: z.string().min(1) }),
  /**
   * Run a command. `exact`: the command line `text`, character for
   * character. `prefix`: any plain command line whose first words are
   * `words`.
   */
  z.object({ kind: z.literal("command"), mode: z.enum(["exact", "prefix"]), text: z.string().min(1), words: z.array(z.string()).min(1) }),
]);
export type Rule = z.infer<typeof ruleSchema>;

export const scopeSchema = z.object({
  /**
   * `thread`: that thread alone. `subtree`: that thread and every thread
   * under it, now and later. `main`: every thread under that Main, now and
   * later, and not the Main itself.
   */
  kind: z.enum(["thread", "subtree", "main"]),
  threadId: z.string().min(1).max(200),
});
export type Scope = z.infer<typeof scopeSchema>;

/** Where on the page a capability was made. */
export const VIAS = ["card", "blocked", "sheet", "ask"] as const;
export type Via = (typeof VIAS)[number];
export const VIA_TEXT: Record<Via, string> = {
  card: "from a permission request",
  blocked: "from a permission bb refused",
  sheet: "from the capabilities sheet",
  ask: "from a thread's request for it",
};

export const capabilitySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(CAP_LIMITS.name),
  note: z.string().max(CAP_LIMITS.note).nullable(),
  rule: ruleSchema,
  scope: scopeSchema,
  createdAt: z.number(),
  via: z.enum(VIAS),
  /** The thread whose request, refusal or ask it was made from; null from the sheet. */
  sourceThreadId: z.string().nullable(),
  /** The ask it was granted from, when a thread requested it. */
  askId: z.string().nullable(),
  /** Set when it was deleted. A deleted capability allows nothing; it is kept for its history and for undo. */
  deletedAt: z.number().nullable(),
  /** How many requests it has allowed, and when it last did. */
  uses: z.number().int().min(0),
  lastUsedAt: z.number().nullable(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export const isActive = (capability: Capability): boolean => capability.deletedAt === null;

/** The rule in a few words: the directory, the command, or the prefix with what may follow. */
export function ruleText(rule: Rule): string {
  if (rule.kind === "dir") return rule.dir;
  return rule.mode === "exact" ? rule.text : `${rule.text} …`;
}

export function kindText(rule: Rule): string {
  if (rule.kind === "dir") return "write a directory";
  return rule.mode === "exact" ? "run a command" : "run a command, by prefix";
}

/** What the rule allows, as the end of a sentence that starts "… may". */
export function allowsText(rule: Rule): string {
  if (rule.kind === "dir") return `create and change files anywhere under ${rule.dir}`;
  if (rule.mode === "exact") return `run exactly the command “${rule.text}”`;
  return `run any command line that begins with the words “${rule.text}”, whatever follows them`;
}

/** Who a scope is, in words. `titleOf` names a thread. */
export function scopeText(scope: Scope, titleOf: (threadId: string) => string): string {
  const title = `“${titleOf(scope.threadId)}”`;
  if (scope.kind === "thread") return `${title} only`;
  if (scope.kind === "subtree") return `${title} and every thread under it, now and later`;
  return `every thread under ${title}, now and later`;
}

/** The one sentence that says exactly what a capability will allow, and for whom. */
export function sentence(rule: Rule, scope: Scope, titleOf: (threadId: string) => string): string {
  const who =
    scope.kind === "thread"
      ? `The thread “${titleOf(scope.threadId)}”, and no other,`
      : scope.kind === "subtree"
        ? `The thread “${titleOf(scope.threadId)}” and every thread under it, now and later,`
        : `Every thread under “${titleOf(scope.threadId)}”, now and later,`;
  return `${who} may ${allowsText(rule)}, each time bb asks, without asking you.`;
}

/** What a notice says when a capability is added or comes back. */
export function addedText(capability: Pick<Capability, "name" | "rule" | "scope">, change: "added" | "restored", titleOf: (threadId: string) => string): string {
  return `capability ${change}: ${capability.name}: ${ruleText(capability.rule)} for ${scopeText(capability.scope, titleOf)}`;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** A name as stored: one line, outer spaces gone. */
export function readName(raw: string): Result<string> {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (name === "") return { ok: false, error: "a capability needs a name: it is what the log and each line will say" };
  if (name.length > CAP_LIMITS.name) return { ok: false, error: `keep the name under ${CAP_LIMITS.name} characters` };
  return { ok: true, value: name };
}

export function readNote(raw: string | null | undefined): Result<string | null> {
  const note = (raw ?? "").trim().replace(/\s+/g, " ");
  if (note.length > CAP_LIMITS.note) return { ok: false, error: `keep the note under ${CAP_LIMITS.note} characters` };
  return { ok: true, value: note === "" ? null : note };
}

/** What a rule is made from: what the person typed, before it is checked. */
export type RuleDraft = { kind: "dir"; text: string } | { kind: "command"; mode: "exact" | "prefix"; text: string };

/** Check a rule as typed and make the rule that is stored. The same check runs on the page and again on the backend. */
export function readRule(draft: RuleDraft, places: Places): Result<Rule> {
  if (draft.kind === "dir") {
    const read = readDirectoryRule(draft.text, places);
    return read.ok ? { ok: true, value: { kind: "dir", dir: read.dir } } : { ok: false, error: read.why };
  }
  const read = readCommandRule(draft.text, draft.mode);
  return read.ok ? { ok: true, value: { kind: "command", mode: read.mode, text: read.text, words: read.words } } : { ok: false, error: read.why };
}

/** The draft a stored rule came from, to check it again. */
export function ruleDraft(rule: Rule): RuleDraft {
  return rule.kind === "dir" ? { kind: "dir", text: rule.dir } : { kind: "command", mode: rule.mode, text: rule.text };
}

/** A name to start from, which the person can change. */
export function suggestName(rule: RuleDraft): string {
  const text = rule.text.trim();
  if (rule.kind === "dir") {
    const last = text.split("/").filter(Boolean).pop();
    return last ? `write ${last}`.slice(0, CAP_LIMITS.name) : "";
  }
  return text.split(/[ \t]+/).slice(0, 3).join(" ").slice(0, CAP_LIMITS.name);
}

/** One capability as a line of text, for the CLI. */
export function capabilityLine(capability: Capability, titleOf: (threadId: string) => string, age: (ms: number) => string, now: number): string {
  const used = capability.uses === 0 ? "never used" : `used ${capability.uses}×, last ${age(Math.max(0, now - (capability.lastUsedAt ?? now)))} ago`;
  return `${capability.id}  ${capability.name}  [${kindText(capability.rule)}]  ${ruleText(capability.rule)}  ·  for ${scopeText(capability.scope, titleOf)}  ·  ${used}  ·  made ${age(Math.max(0, now - capability.createdAt))} ago ${VIA_TEXT[capability.via]}${capability.deletedAt === null ? "" : "  ·  DELETED"}`;
}
