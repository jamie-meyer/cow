// Answering an ask on the page: what is marked, what Enter does next, and
// what would be sent. A digit only marks an option. Enter sends a low-risk
// answer; a medium-risk one is restated first and needs a second Enter; a
// high-risk one needs a word typed. Pure, so it can be tested without a page.

import { type Ask, answerText, answered } from "./ask.ts";

/** The word a high-risk answer has to be confirmed with. */
export const CONFIRM_WORD = "send";

export interface AskDraft {
  /** 1-based place of the marked option, or null. */
  option: number | null;
  text: string;
  /** `restate`: shown what will be sent, waiting for a second Enter. `word`: waiting for the word. */
  stage: "choose" | "restate" | "word";
  word: string;
  /** "Already answered in chat" is marked: Enter closes the ask and sends nothing. */
  chat: boolean;
}

export const emptyAskDraft: AskDraft = { option: null, text: "", stage: "choose", word: "", chat: false };

/** Mark option `number`, or unmark it when it is marked already. Anything else is ignored. */
export function markOption(draft: AskDraft, ask: Ask, number: number): AskDraft {
  if (draft.stage !== "choose" || number < 1 || number > ask.options.length) return draft;
  return { ...draft, chat: false, option: draft.option === number ? null : number };
}

/**
 * The digit that marks "already answered in chat": the one after the options
 * and the field for words. While it is offered the field has a digit of its
 * own even on an ask with no options, and does not take the caret by itself.
 */
export function chatDigit(ask: Ask): number {
  return ask.options.length + (ask.optionsOnly ? 0 : 1) + 1;
}

/** Mark "already answered in chat", or unmark it when it is marked. It takes the place of any option. */
export function markChat(draft: AskDraft): AskDraft {
  if (draft.stage !== "choose") return draft;
  return { ...draft, option: null, chat: !draft.chat };
}

export const writeAnswer = (draft: AskDraft, text: string): AskDraft => ({ ...draft, text });
export const writeWord = (draft: AskDraft, word: string): AskDraft => ({ ...draft, word });

/** The answer as the thread would be given it, or why there is none yet. */
export function draftAnswer(draft: AskDraft, ask: Ask): { ok: true; text: string; option: number | null; words: string | null } | { ok: false; why: string } {
  const words = draft.text.trim() === "" ? null : draft.text.trim();
  const result = answered(ask, { option: draft.option, text: words }, 0);
  if (!result.ok) {
    if (draft.option === null && words === null) {
      return { ok: false, why: ask.options.length === 0 ? "type your answer first" : ask.optionsOnly ? "choose an option first" : "choose an option, or type your answer, first" };
    }
    return { ok: false, why: result.error };
  }
  return { ok: true, text: answerText(result.value), option: draft.option, words };
}

export type AskStep =
  | { kind: "incomplete"; why: string }
  /** Show what will be sent and wait for the next Enter, or for the word. */
  | { kind: "stage"; draft: AskDraft }
  | { kind: "send"; option: number | null; text: string | null; said: string }
  /** Close the ask as answered in chat. Nothing is sent, whatever the risk: no answer goes anywhere. */
  | { kind: "close" };

/** What Enter does. */
export function confirmAsk(draft: AskDraft, ask: Ask): AskStep {
  if (draft.chat) return { kind: "close" };
  const answer = draftAnswer(draft, ask);
  if (!answer.ok) return { kind: "incomplete", why: answer.why };
  const send: AskStep = { kind: "send", option: answer.option, text: answer.words, said: answer.text };
  if (ask.risk === "medium") return draft.stage === "restate" ? send : { kind: "stage", draft: { ...draft, stage: "restate" } };
  if (ask.risk === "high") {
    if (draft.stage !== "word") return { kind: "stage", draft: { ...draft, stage: "word", word: "" } };
    return draft.word.trim().toLowerCase() === CONFIRM_WORD ? send : { kind: "incomplete", why: `type the word ${CONFIRM_WORD} to send a high-risk answer` };
  }
  return send;
}

/** What Escape does: back from the confirmation to the choices, or null to close the card. */
export function backOut(draft: AskDraft): AskDraft | null {
  return draft.stage === "choose" ? null : { ...draft, stage: "choose", word: "" };
}

/** The ask after `currentId` among `asks`, wrapping round; null when it is the only one. */
export function nextAsk(asks: readonly Ask[], currentId: string): Ask | null {
  const others = asks.filter((ask) => ask.id !== currentId);
  if (others.length === 0) return null;
  const at = asks.findIndex((ask) => ask.id === currentId);
  return asks.slice(at + 1).find((ask) => ask.id !== currentId) ?? others[0]!;
}
