// A brief: a finished job's report in a form that can be audited. The agent
// that did the work states its claims and attaches the evidence for each; a
// separate checker judges them (see checker.ts). Everything here is pure.

import { z } from "zod";

export const BRIEF_LIMITS = {
  summary: 1200,
  claims: 30,
  claim: 400,
  evidencePerClaim: 6,
  description: 600,
  /** Characters of one inline excerpt, and of one evidence file as the checker reads it. */
  excerpt: 12_000,
  /** Characters of all evidence in one brief. */
  evidenceTotal: 60_000,
  judgementCalls: 10,
  notDone: 20,
  line: 400,
} as const;

/** The agent's own word for how it knows a claim. It is never shown as verification. */
export const LABELS = ["checked", "inferred", "not-checked"] as const;
export type Label = (typeof LABELS)[number];

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "must not be empty")
    .max(max, `must be at most ${max} characters`);

const evidenceInputSchema = z.strictObject({
  /** One line: what this piece of evidence is. */
  description: line(BRIEF_LIMITS.description).refine((value) => !value.includes("\n"), "must be one line"),
  /** An inline excerpt, verbatim. */
  text: z.string().min(1, "must not be empty").max(BRIEF_LIMITS.excerpt, `must be at most ${BRIEF_LIMITS.excerpt} characters`).optional(),
  /** A text file in the thread's storage. */
  path: z.string().min(1, "must not be empty").max(500).optional(),
});

const claimInputSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,24}$/, "must be 1 to 24 letters, digits, - or _")
    .optional(),
  text: line(BRIEF_LIMITS.claim),
  label: z.enum(LABELS, { error: `must be one of: ${LABELS.join(", ")}` }),
  evidence: z.array(evidenceInputSchema).max(BRIEF_LIMITS.evidencePerClaim, `at most ${BRIEF_LIMITS.evidencePerClaim} pieces of evidence per claim`).default([]),
});

const judgementCallInputSchema = z.strictObject({
  text: line(BRIEF_LIMITS.line),
  /** The ask that puts this decision to the user, when one was raised. */
  askId: z
    .string()
    .regex(/^ask_[a-z0-9]{1,40}$/, "must be an ask id such as ask_1a2b3c4d")
    .optional(),
});

const briefInputSchema = z.strictObject({
  summary: line(BRIEF_LIMITS.summary).refine((value) => !/\n\s*\n/.test(value), "must be one paragraph"),
  claims: z.array(claimInputSchema).min(1, "state at least one claim").max(BRIEF_LIMITS.claims, `at most ${BRIEF_LIMITS.claims} claims`),
  judgementCalls: z.array(judgementCallInputSchema).max(BRIEF_LIMITS.judgementCalls, `at most ${BRIEF_LIMITS.judgementCalls} judgement calls`).default([]),
  notDone: z.array(line(BRIEF_LIMITS.line)).max(BRIEF_LIMITS.notDone, `at most ${BRIEF_LIMITS.notDone} entries`).default([]),
});

export interface EvidenceInput {
  description: string;
  text?: string;
  path?: string;
}
export interface BriefInput {
  summary: string;
  claims: { id: string; text: string; label: Label; evidence: EvidenceInput[] }[];
  judgementCalls: { text: string; askId: string | null }[];
  notDone: string[];
}

/** Evidence as kept: the text the checker reads, copied when the brief was submitted. */
export const evidenceSchema = z.object({
  description: z.string(),
  /** The file it came from, relative to the thread's storage; null for an inline excerpt. */
  path: z.string().nullable(),
  text: z.string(),
  /** True when the file was longer than the checker is given. */
  truncated: z.boolean(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const claimSchema = z.object({
  id: z.string(),
  text: z.string(),
  label: z.enum(LABELS),
  evidence: z.array(evidenceSchema),
});
export type Claim = z.infer<typeof claimSchema>;

export const briefSchema = z.object({
  summary: z.string(),
  claims: z.array(claimSchema),
  judgementCalls: z.array(z.object({ text: z.string(), askId: z.string().nullable() })),
  notDone: z.array(z.string()),
});
export type Brief = z.infer<typeof briefSchema>;

export const BRIEF_SHAPE = `{
  "summary": "one paragraph: what was asked and what you did",
  "claims": [
    {
      "id": "c1",                      optional; c1, c2, … when left out
      "text": "one thing you say is true",
      "label": "checked",              checked | inferred | not-checked
      "evidence": [
        { "description": "what this is, in one line", "text": "an excerpt, verbatim" },
        { "description": "what this is, in one line", "path": "file-in-thread-storage.txt" }
      ]
    }
  ],
  "judgementCalls": [ { "text": "a decision the user must make", "askId": "ask_…" } ],   askId optional
  "notDone": [ "what was left undone or not checked" ]
}`;

const where = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((out, part) => (typeof part === "number" ? `${out}[${part}]` : out === "" ? String(part) : `${out}.${String(part)}`), "");

export type Validated = { ok: true; brief: BriefInput } | { ok: false; errors: string[] };

/** Check a submitted brief, strictly. Every error names the field and says what it must be. */
export function validateBrief(raw: unknown): Validated {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["the brief must be a JSON object with summary, claims, judgementCalls and notDone"] };
  }
  const parsed = briefInputSchema.safeParse(raw);
  const errors: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = where(issue.path);
      if (issue.code === "unrecognized_keys") {
        errors.push(`${at === "" ? "the brief" : at}: unknown key ${issue.keys.map((key) => `"${key}"`).join(", ")}`);
      } else if (issue.code === "invalid_type" && issue.input === undefined) {
        errors.push(`${at}: is required`);
      } else {
        errors.push(`${at === "" ? "the brief" : at}: ${issue.message}`);
      }
    }
    return { ok: false, errors };
  }
  const input = parsed.data;
  const seen = new Set<string>();
  const claims = input.claims.map((claim, index) => {
    const at = `claims[${index}]`;
    const id = claim.id ?? `c${index + 1}`;
    if (seen.has(id)) errors.push(`${at}.id: "${id}" is used by an earlier claim; give each claim its own id, or leave ids out`);
    seen.add(id);
    claim.evidence.forEach((piece, n) => {
      const has = Number(piece.text !== undefined) + Number(piece.path !== undefined);
      if (has !== 1) errors.push(`${at}.evidence[${n}]: give exactly one of "text" (an excerpt) or "path" (a file in the thread's storage)`);
    });
    if (claim.label === "checked" && claim.evidence.length === 0) {
      errors.push(`${at}: is labelled "checked" but has no evidence; attach what you checked it against, or label it "inferred" or "not-checked"`);
    }
    return { id, text: claim.text, label: claim.label, evidence: claim.evidence };
  });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    brief: {
      summary: input.summary,
      claims,
      judgementCalls: input.judgementCalls.map((call) => ({ text: call.text, askId: call.askId ?? null })),
      notDone: input.notDone,
    },
  };
}

/** Cut evidence text to what the checker is given. */
export function clip(text: string, max: number = BRIEF_LIMITS.excerpt): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}
