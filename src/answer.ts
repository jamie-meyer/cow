// Answering a pending question from the page: what bb is asking, the draft
// the user builds with digits and text, and the answer bb expects back.

import { firstLine } from "./text.ts";

/** Options are chosen with one digit each. */
const MAX_OPTIONS = 9;

export interface AskOption {
  label: string;
  value: string;
  description: string;
}

export interface AskQuestion {
  id: string;
  prompt: string;
  options: AskOption[];
  allowFreeText: boolean;
  multiSelect: boolean;
  required: boolean;
}

/** A pending interaction, as far as this page can deal with it. */
export type Ask =
  | { kind: "questions"; id: string; at: number; questions: AskQuestion[] }
  /** Something only the chat can answer, with what to tell the user about it. */
  | { kind: "other"; id: string; at: number; title: string; why: string };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function toQuestion(raw: unknown): AskQuestion | null {
  const r = record(raw);
  if (!r || typeof r.id !== "string") return null;
  const options: AskOption[] = [];
  for (const rawOption of Array.isArray(r.options) ? r.options : []) {
    const option = record(rawOption);
    if (!option || typeof option.value !== "string") return null;
    options.push({
      label: text(option.label) || option.value,
      value: option.value,
      description: text(option.description),
    });
  }
  return {
    id: r.id,
    prompt: text(r.prompt),
    options,
    allowFreeText: r.allowFreeText === true,
    multiSelect: r.multiSelect === true,
    required: r.required !== false,
  };
}

function describeOther(payload: Record<string, unknown>): { title: string; why: string } {
  const title = firstLine(text(payload.title)) || firstLine(text(payload.reason));
  if (payload.kind === "approval") {
    const subject = record(payload.subject);
    return {
      title: title || firstLine(text(subject?.command)) || "It asks for your approval",
      why: "This is a permission request. Approve or deny it in its chat, where you can see exactly what it grants.",
    };
  }
  return {
    title: title || "It is waiting for your input",
    why: "This is a form of its own kind, which only its chat can show.",
  };
}

/** Read one of bb's interactions, trusting nothing about its shape. Null unless it is pending. */
export function toAskDetail(raw: unknown): Ask | null {
  const r = record(raw);
  if (!r || typeof r.id !== "string" || r.status !== "pending") return null;
  const at = typeof r.createdAt === "number" ? r.createdAt : 0;
  const payload = record(r.payload) ?? {};
  const other = (why?: string): Ask => {
    const described = describeOther(payload);
    return { kind: "other", id: r.id as string, at, title: described.title, why: why ?? described.why };
  };
  if (payload.kind !== "user_question" || !Array.isArray(payload.questions)) return other();
  const questions: AskQuestion[] = [];
  for (const rawQuestion of payload.questions) {
    const question = toQuestion(rawQuestion);
    if (!question) return other("The page could not read this question.");
    if (question.options.length > MAX_OPTIONS) {
      return other(`It offers more than ${MAX_OPTIONS} options, more than the page can number.`);
    }
    if (question.options.length === 0 && !question.allowFreeText) {
      return other("It offers no options and takes no text.");
    }
    questions.push(question);
  }
  if (questions.length === 0) return other("It asks nothing the page can read.");
  return { kind: "questions", id: r.id, at, questions };
}

/** The oldest pending interaction: the one the thread is waiting on first. */
export function oldestAsk(interactions: readonly unknown[]): Ask | null {
  let oldest: Ask | null = null;
  for (const raw of interactions) {
    const ask = toAskDetail(raw);
    if (ask && (oldest === null || ask.at < oldest.at)) oldest = ask;
  }
  return oldest;
}

/** What the user has chosen so far, one entry per question. */
export interface Draft {
  /** The question being answered now. */
  step: number;
  selected: string[][];
  freeText: string[];
}

export function emptyDraft(questions: readonly AskQuestion[]): Draft {
  return { step: 0, selected: questions.map(() => []), freeText: questions.map(() => "") };
}

const withEntry = <T,>(list: readonly T[], index: number, value: T): T[] =>
  list.map((entry, at) => (at === index ? value : entry));

/**
 * Choose option `number` (1-based) of the current question. One choice
 * replaces another unless the question takes several, where it toggles.
 * Choosing never sends anything. Returns the same draft for a bad number.
 */
export function choose(draft: Draft, questions: readonly AskQuestion[], number: number): Draft {
  const question = questions[draft.step];
  const option = question?.options[number - 1];
  if (!question || !option) return draft;
  const current = draft.selected[draft.step] ?? [];
  const next = question.multiSelect
    ? current.includes(option.value)
      ? current.filter((value) => value !== option.value)
      : [...current, option.value]
    : [option.value];
  return {
    ...draft,
    selected: withEntry(draft.selected, draft.step, next),
    // One answer per question unless it takes several: a choice replaces typed text.
    freeText: question.multiSelect ? draft.freeText : withEntry(draft.freeText, draft.step, ""),
  };
}

/** Type the current question's own-words answer. It replaces a single choice. */
export function writeText(draft: Draft, questions: readonly AskQuestion[], value: string): Draft {
  const question = questions[draft.step];
  if (!question?.allowFreeText) return draft;
  return {
    ...draft,
    freeText: withEntry(draft.freeText, draft.step, value),
    selected:
      question.multiSelect || value.trim() === ""
        ? draft.selected
        : withEntry(draft.selected, draft.step, []),
  };
}

function answered(draft: Draft, index: number): boolean {
  return (draft.selected[index]?.length ?? 0) > 0 || (draft.freeText[index]?.trim() ?? "") !== "";
}

export type Confirmed =
  | { kind: "incomplete"; why: string }
  | { kind: "next"; draft: Draft }
  | { kind: "send"; answers: Record<string, { selected: string[]; freeText?: string }> };

/**
 * Enter: move to the next question, or, on the last one, produce the answer
 * to send. A required question has to be answered first.
 */
export function confirm(draft: Draft, questions: readonly AskQuestion[]): Confirmed {
  const question = questions[draft.step];
  if (!question) return { kind: "incomplete", why: "there is nothing to answer" };
  if (question.required && !answered(draft, draft.step)) {
    return {
      kind: "incomplete",
      why: question.options.length > 0 ? "choose an option first" : "type an answer first",
    };
  }
  if (draft.step < questions.length - 1) return { kind: "next", draft: { ...draft, step: draft.step + 1 } };
  const answers: Record<string, { selected: string[]; freeText?: string }> = {};
  questions.forEach((each, index) => {
    const freeText = draft.freeText[index]?.trim() ?? "";
    answers[each.id] = {
      selected: draft.selected[index] ?? [],
      ...(freeText ? { freeText } : {}),
    };
  });
  return { kind: "send", answers };
}
