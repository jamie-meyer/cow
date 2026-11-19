// An ask: one question from a thread to the person, which stays open until
// it is answered or withdrawn. Everything here is pure; the page can use it.

import { z } from "zod";

export const ASK_LIMITS = { question: 600, context: 2000, options: 9, label: 120, detail: 300, proofs: 8, answer: 4000 } as const;

export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

const optionSchema = z.object({
  label: z.string().min(1).max(ASK_LIMITS.label),
  detail: z.string().max(ASK_LIMITS.detail).nullable(),
});

const answerSchema = z.object({
  /** 1-based place of the chosen option, or null for an answer in words only. */
  option: z.number().int().min(1).nullable(),
  /** The person's own words; with an option, a note on it. */
  text: z.string().max(ASK_LIMITS.answer).nullable(),
  at: z.number(),
});
export type Answer = z.infer<typeof answerSchema>;

/**
 * How an ask was closed without an answer given on the page: the person had
 * answered it in an ordinary message to the thread.
 */
const closedSchema = z.object({
  /** Who closed it: the asking side, with `bb cow ask close`, or the person, on the page. */
  by: z.enum(["thread", "person"]),
  /** The thread that ran the command; null for the person, and for a command run outside any thread. */
  closedBy: z.string().nullable(),
  /** The person's answer as the thread quotes it; null when the person closed it. */
  answer: z.string().max(ASK_LIMITS.answer).nullable(),
  at: z.number(),
});
export type Closed = z.infer<typeof closedSchema>;

export const askSchema = z.object({
  id: z.string(),
  /** The thread the question is from, and where the answer goes. */
  threadId: z.string(),
  /** The thread that ran the command: the same one, or one above it. Null when no thread did. */
  askedBy: z.string().nullable(),
  projectId: z.string().nullable(),
  question: z.string().min(1).max(ASK_LIMITS.question),
  options: z.array(optionSchema).max(ASK_LIMITS.options),
  /** True when only one of the options is an answer. */
  optionsOnly: z.boolean(),
  risk: z.enum(RISKS).nullable(),
  /** Files in the asking thread's storage, as paths relative to it. */
  proofs: z.array(z.string()).max(ASK_LIMITS.proofs),
  context: z.string().max(ASK_LIMITS.context).nullable(),
  createdAt: z.number(),
  /** `closed`: answered in chat, not on the page. See `closed`. */
  status: z.enum(["open", "answered", "withdrawn", "closed"]),
  answer: answerSchema.nullable(),
  /** When the answer reached the thread as a message; null while it has not. */
  deliveredAt: z.number().nullable(),
  withdrawnAt: z.number().nullable(),
  /** Set when it was closed as answered in chat. Asks recorded before this existed have none. */
  closed: closedSchema.nullable().default(null),
  /**
   * Set when the thread asks for a capability, with `bb cow cap request`:
   * the rule it proposes, as it typed it. The person grants it from the
   * ask's card, through the same steps as any capability, or refuses.
   */
  capability: z
    .object({ kind: z.enum(["dir", "command"]), rule: z.string().max(5000) })
    .nullable()
    .default(null),
});
export type Ask = z.infer<typeof askSchema>;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; hint?: string };
const fail = (error: string, hint?: string): Result<never> => ({ ok: false, error, ...(hint ? { hint } : {}) });

const oneLine = (value: string): string => value.trim().replace(/\s+/g, " ");

/** Read `label` or `label::detail`, as `--option` takes it. */
export function parseOption(raw: string): Result<{ label: string; detail: string | null }> {
  const at = raw.indexOf("::");
  const label = oneLine(at < 0 ? raw : raw.slice(0, at));
  const detail = at < 0 ? "" : oneLine(raw.slice(at + 2));
  if (label === "") return fail(`--option "${raw}" has no label`, "Write it as --option 'label' or --option 'label::what choosing it means'.");
  if (label.length > ASK_LIMITS.label) return fail(`--option label is over ${ASK_LIMITS.label} characters: "${label.slice(0, 40)}…"`, "Keep the label short and put the rest after `::`.");
  if (detail.length > ASK_LIMITS.detail) return fail(`--option detail is over ${ASK_LIMITS.detail} characters`);
  return { ok: true, value: { label, detail: detail === "" ? null : detail } };
}

/**
 * A proof path as stored: relative to the thread's storage. An absolute path
 * is accepted when it is inside `storageRoot`.
 */
export function storagePath(raw: string, storageRoot: string | null): Result<string> {
  let path = raw.trim();
  if (path === "") return fail("a path is empty");
  const root = storageRoot === null ? null : storageRoot.replace(/\/+$/, "");
  if (path.startsWith("/")) {
    if (root === null || !(path === root || path.startsWith(`${root}/`))) {
      return fail(`${raw} is not in the thread's storage`, "Save the file under $BB_THREAD_STORAGE and pass that path.");
    }
    path = path.slice(root.length + 1);
  }
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) return fail(`${raw} names the storage folder, not a file in it`);
  if (parts.includes("..")) return fail(`${raw} leaves the thread's storage`, "Pass a path under $BB_THREAD_STORAGE without `..`.");
  return { ok: true, value: parts.join("/") };
}

export interface AskDraft {
  threadId: string;
  askedBy: string | null;
  projectId: string | null;
  question: string;
  options: readonly string[];
  optionsOnly: boolean;
  risk: Risk | null;
  proofs: readonly string[];
  context: string | null;
  /** The capability the thread asks for, when this is that kind of ask. */
  capability?: Ask["capability"];
}

/** The two answers an ask for a capability offers. Granting is the first. */
export const CAPABILITY_OPTIONS = ["allow it::you check what it covers, name it, choose who it applies to, and confirm", "refuse it::it is told no"] as const;

/** Check a question as the CLI received it and make the record. */
export function draftAsk(draft: AskDraft, id: string, now: number, storageRoot: string | null): Result<Ask> {
  const question = draft.question.trim();
  if (question === "") return fail("--question is empty", "Ask one question the user can answer.");
  if (question.length > ASK_LIMITS.question) {
    return fail(`--question is over ${ASK_LIMITS.question} characters`, "Ask the question in a sentence or two and put the background in --context.");
  }
  if (draft.options.length > ASK_LIMITS.options) return fail(`at most ${ASK_LIMITS.options} options`);
  const options: Ask["options"] = [];
  for (const raw of draft.options) {
    const option = parseOption(raw);
    if (!option.ok) return option;
    if (options.some((other) => other.label === option.value.label)) return fail(`two options are both "${option.value.label}"`);
    options.push(option.value);
  }
  if (draft.optionsOnly && options.length < 2) {
    return fail("--options-only needs at least two --option", "Give the options, or leave --options-only out to take an answer in words.");
  }
  if (draft.proofs.length > ASK_LIMITS.proofs) return fail(`at most ${ASK_LIMITS.proofs} --proof files`);
  const proofs: string[] = [];
  for (const raw of draft.proofs) {
    const path = storagePath(raw, storageRoot);
    if (!path.ok) return fail(`--proof: ${path.error}`, path.hint);
    if (!proofs.includes(path.value)) proofs.push(path.value);
  }
  const context = draft.context?.trim() ?? "";
  if (context.length > ASK_LIMITS.context) return fail(`--context is over ${ASK_LIMITS.context} characters`);
  return {
    ok: true,
    value: {
      id,
      threadId: draft.threadId,
      askedBy: draft.askedBy,
      projectId: draft.projectId,
      question,
      options,
      optionsOnly: draft.optionsOnly,
      risk: draft.risk,
      proofs,
      context: context === "" ? null : context,
      createdAt: now,
      status: "open",
      answer: null,
      deliveredAt: null,
      withdrawnAt: null,
      closed: null,
      capability: draft.capability ?? null,
    },
  };
}

/**
 * May `caller` ask for `target`? A thread asks for itself or for a thread
 * under it. `ancestors` are the ids above `target`, nearest first.
 */
export function mayAskFor(caller: string, target: string, ancestors: readonly string[]): boolean {
  return caller === target || ancestors.includes(caller);
}

/** The ask, answered. Refused when it is not open or the answer does not fit the question. */
export function answered(ask: Ask, given: { option: number | null; text: string | null }, now: number): Result<Ask> {
  if (ask.status === "answered") return fail(`${ask.id} is already answered`);
  if (ask.status === "withdrawn") return fail(`${ask.id} was withdrawn by the thread that asked`);
  if (ask.status === "closed") return fail(`${ask.id} was closed as answered in chat`);
  const text = given.text?.trim() ?? "";
  if (text.length > ASK_LIMITS.answer) return fail(`the answer is over ${ASK_LIMITS.answer} characters`);
  if (given.option !== null) {
    if (!Number.isInteger(given.option) || given.option < 1 || given.option > ask.options.length) {
      return fail(
        ask.options.length === 0 ? `${ask.id} has no options; answer in words` : `${ask.id} has options 1 to ${ask.options.length}; there is no option ${given.option}`,
      );
    }
  } else if (text === "") {
    return fail("the answer is empty", ask.options.length > 0 ? "Choose an option or answer in words." : "Answer in words.");
  } else if (ask.optionsOnly) {
    return fail(`${ask.id} takes one of its options, not an answer in words`, `Choose an option from 1 to ${ask.options.length}.`);
  }
  return { ok: true, value: { ...ask, status: "answered", answer: { option: given.option, text: text === "" ? null : text, at: now } } };
}

/** The ask, withdrawn by a thread that may ask for it. */
export function withdrawn(ask: Ask, now: number): Result<Ask> {
  if (ask.status === "answered") return fail(`${ask.id} is already answered`);
  if (ask.status === "withdrawn") return fail(`${ask.id} is already withdrawn`);
  if (ask.status === "closed") return fail(`${ask.id} is already closed as answered in chat`);
  return { ok: true, value: { ...ask, status: "withdrawn", withdrawnAt: now } };
}

/**
 * The ask, closed because the person answered it in an ordinary message to
 * the thread instead of on the page. The asking side closes it with the
 * answer as it understood it; the person closes it with nothing more to
 * say. Nothing is sent to the thread either way. It is a record of its own:
 * not an answer given on the page, and not a withdrawal.
 */
export function closedInChat(ask: Ask, given: { by: "thread" | "person"; closedBy: string | null; answer: string | null }, now: number): Result<Ask> {
  if (ask.status === "answered") return fail(`${ask.id} is already answered`);
  if (ask.status === "withdrawn") return fail(`${ask.id} was withdrawn`);
  if (ask.status === "closed") return fail(`${ask.id} is already closed as answered in chat`);
  const answer = given.answer?.trim() ?? "";
  if (given.by === "thread" && answer === "") {
    return fail("--answered is empty", "Quote, or closely paraphrase, what the user answered. To drop a question that no longer needs an answer, use `bb cow ask withdraw`.");
  }
  if (answer.length > ASK_LIMITS.answer) return fail(`the answer is over ${ASK_LIMITS.answer} characters`);
  return { ok: true, value: { ...ask, status: "closed", closed: { by: given.by, closedBy: given.closedBy, answer: answer === "" ? null : answer, at: now } } };
}

/** How a closed ask was closed, in a line. */
export function closedText(ask: Ask): string {
  const closed = ask.closed;
  if (!closed) return "";
  if (closed.by === "person") return "closed by the user on cow's page: answered in chat";
  const who = closed.closedBy === null ? "closed from a terminal" : closed.closedBy === ask.threadId ? "closed by the thread" : `closed by ${closed.closedBy}, a thread above it`;
  return `${who}: answered in chat${closed.answer ? `: ${closed.answer}` : ""}`;
}

/** The person's messages to a thread that cow sent itself, as answers: within this long of one arriving. */
const OWN_ANSWER_MS = 15_000;

/**
 * Whether the person has sent the asking thread a message of their own
 * since it asked: the sign that the ask may have been answered in chat.
 * `spokeAt` is when the person last sent the thread a message, from
 * anywhere in bb; `delivered` are the times cow delivered answers to that
 * thread's other asks, which are messages from the person too and are not
 * counted.
 */
export function messagedSince(ask: Ask, spokeAt: number | null | undefined, delivered: readonly number[] = []): boolean {
  if (ask.status !== "open" || spokeAt == null || spokeAt <= ask.createdAt) return false;
  return !delivered.some((at) => Math.abs(at - spokeAt) <= OWN_ANSWER_MS);
}

/** The answer in a line: the chosen option, the person's words, or both. */
export function answerText(ask: Ask): string {
  const answer = ask.answer;
  if (!answer) return "";
  const option = answer.option === null ? null : ask.options[answer.option - 1];
  if (option && answer.text) return `${option.label} (option ${answer.option}): ${answer.text}`;
  if (option) return `${option.label} (option ${answer.option})`;
  return answer.text ?? "";
}

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** What the asking thread is sent, as the user, when its ask is answered. */
export function answerMessage(ask: Ask): string {
  return [`Answer to your question (${ask.id}):`, "", quote(ask.question), "", answerText(ask)].join("\n");
}

/** Open asks, oldest first; `threadId` narrows them to one thread. */
export function openAsks(asks: readonly Ask[], threadId?: string): Ask[] {
  return asks
    .filter((ask) => ask.status === "open" && (threadId === undefined || ask.threadId === threadId))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Thread id to its open asks, oldest first. A thread in this map wants the user. */
export function asksByThread(asks: readonly Ask[]): Map<string, Ask[]> {
  const found = new Map<string, Ask[]>();
  for (const ask of openAsks(asks)) found.set(ask.threadId, [...(found.get(ask.threadId) ?? []), ask]);
  return found;
}

/** One ask as a few lines of text. */
export function askText(ask: Ask, now: number, age: (ms: number) => string): string {
  const head = `${ask.id}  ${ask.threadId}  ${ask.status}${ask.risk ? `  risk ${ask.risk}` : ""}  ${age(Math.max(0, now - ask.createdAt))}`;
  const lines = [head, `  ${ask.question}`];
  ask.options.forEach((option, index) => lines.push(`    ${index + 1}. ${option.label}${option.detail ? `: ${option.detail}` : ""}`));
  if (ask.options.length > 0) lines.push(ask.optionsOnly ? "    (one of the options)" : "    (or an answer in words)");
  if (ask.proofs.length > 0) lines.push(`  proof: ${ask.proofs.join(", ")}`);
  if (ask.status === "answered") lines.push(`  answered on cow's page: ${answerText(ask)}${ask.deliveredAt === null ? " (not delivered yet)" : ""}`);
  if (ask.status === "closed") lines.push(`  ${closedText(ask)}`);
  return lines.join("\n");
}
