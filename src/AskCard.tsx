// An ask, opened in place: the question with its context, risk, options and
// proof, and the other asks the same thread has open. A digit marks an
// option and Enter confirms; an answer with more at stake is restated, or
// needs a word typed, before it goes. Nothing is sent on one key.

import { type RefObject } from "react";
import type { Ask } from "./asks/ask.ts";
import { type AskDraft, CONFIRM_WORD, chatDigit, draftAnswer } from "./asks/card.ts";
import { MESSAGED_SINCE } from "./state.ts";
import { fileAttribute } from "./reader/trigger.ts";
import { formatAge } from "./text.ts";

export interface AskState {
  threadId: string;
  /** The ask being answered. */
  askId: string;
  draft: AskDraft;
  sending: boolean;
  /** Why Enter did nothing, or why sending failed. */
  note: string;
  /** What has been sent from this card so far, one line each. */
  sent: readonly string[];
  /** Opened for this one ask only: the card closes once it is answered. */
  single: boolean;
}

const RISK_TEXT = { low: "low risk", medium: "medium risk · the answer is shown back to you before it is sent", high: `high risk · the answer is sent only after you type ${CONFIRM_WORD}` } as const;

export function AskCard({
  state,
  asks,
  title,
  now,
  messaged,
  textRef,
  wordRef,
  onText,
  onWord,
  onConfirm,
  onBack,
}: {
  state: AskState;
  /** The thread's open asks, oldest first. */
  asks: readonly Ask[];
  /** The asking thread's title: where the answer goes. */
  title: string;
  now: number;
  /** The person has sent the thread a message since it asked this: it may be answered in chat already. */
  messaged: boolean;
  textRef: RefObject<HTMLInputElement | null>;
  wordRef: RefObject<HTMLInputElement | null>;
  onText: (value: string) => void;
  onWord: (value: string) => void;
  onConfirm: () => void;
  /** Escape in a field: back one step. */
  onBack: () => void;
}) {
  const ask = asks.find((entry) => entry.id === state.askId) ?? null;
  const { draft } = state;
  const fieldKeys = (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") onConfirm();
    else onBack();
  };
  const sent = state.sent.map((line, index) => (
    <p key={index} className="cow-ask-sent" data-cow-ask-sent="">
      {line}
    </p>
  ));
  if (ask === null) {
    return (
      <div className="cow-ans cow-ask" data-cow-ask-card={state.threadId} role="group" aria-label="answer the ask">
        {sent}
        <p className="cow-ans-why">That ask is no longer open.</p>
      </div>
    );
  }
  const at = asks.indexOf(ask);
  const others = asks.filter((entry) => entry !== ask);
  const answer = draftAnswer(draft, ask);
  const staged = draft.stage !== "choose";
  // The field has a digit when there is anything else to choose.
  const fieldDigit = !ask.optionsOnly && (ask.options.length > 0 || messaged);
  const digits = ask.options.length + (fieldDigit ? 1 : 0) + (messaged ? 1 : 0);
  return (
    <div
      className={`cow-ans cow-ask${ask.risk ? ` cow-risk-${ask.risk}` : ""}`}
      data-cow-ask-card={state.threadId}
      data-cow-ask={ask.id}
      data-cow-ask-stage={draft.stage}
      data-cow-ask-count={asks.length}
      role="group"
      aria-label="answer the ask"
    >
      {sent}
      <p className="cow-perm-kind">
        {asks.length > 1 ? `Ask ${at + 1} of ${asks.length}` : "Ask"} · from {title} · {formatAge(Math.max(0, now - ask.createdAt))} ago
        {ask.risk ? (
          <b className={`cow-risk cow-risk-${ask.risk}`} data-cow-ask-risk={ask.risk}>
            {" "}
            · {RISK_TEXT[ask.risk]}
          </b>
        ) : null}
      </p>
      <p className="cow-ans-q" data-cow-answer-prompt="">
        {ask.question}
      </p>
      {ask.context ? (
        <p className="cow-ans-why cow-ask-context" data-cow-ask-context="">
          {ask.context}
        </p>
      ) : null}
      {ask.proofs.length > 0 ? (
        <p className="cow-perm-row" data-cow-ask-proofs="">
          <span>proof</span>
          <span className="cow-ask-proofs">
            {ask.proofs.map((path) => (
              <button
                key={path}
                type="button"
                className="cow-filelink"
                tabIndex={-1}
                data-cow-file={fileAttribute({ kind: "rooted", threadId: ask.threadId, root: "storage", relPath: path, lines: null })}
                data-cow-ask-proof={path}
              >
                {path}
              </button>
            ))}
          </span>
        </p>
      ) : null}
      {ask.options.map((option, index) => {
        const chosen = draft.option === index + 1;
        return (
          <div
            key={option.label}
            className={chosen ? "cow-ans-o cow-chosen" : "cow-ans-o"}
            data-cow-answer-option={index + 1}
            data-cow-chosen={chosen || undefined}
          >
            <kbd>{index + 1}</kbd>
            <span className="cow-ans-mark">{chosen ? "◉" : "○"}</span>
            <span>
              {option.label}
              {option.detail ? <small> · {option.detail}</small> : null}
            </span>
          </div>
        );
      })}
      {ask.optionsOnly ? null : (
        <div className="cow-ans-o cow-ans-text">
          {fieldDigit ? <kbd>{ask.options.length + 1}</kbd> : <span />}
          <span className="cow-ans-mark">✎</span>
          <input
            ref={textRef}
            data-cow-input="ask-answer"
            autoComplete="off"
            spellCheck={false}
            placeholder={ask.options.length > 0 ? "or answer in your own words; with an option marked, a note on it" : "your answer"}
            value={draft.text}
            disabled={state.sending || staged}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={fieldKeys}
          />
        </div>
      )}
      {messaged ? (
        <>
          <p className="cow-ans-why cow-ask-messaged" data-cow-ask-messaged="">
            {MESSAGED_SINCE[0]!.toUpperCase()}
            {MESSAGED_SINCE.slice(1)}. If that message answered it, close it here: nothing more is sent.
          </p>
          <div className={draft.chat ? "cow-ans-o cow-chosen" : "cow-ans-o"} data-cow-ask-chat="" data-cow-chosen={draft.chat || undefined}>
            <kbd>{chatDigit(ask)}</kbd>
            <span className="cow-ans-mark">{draft.chat ? "◉" : "○"}</span>
            <span>
              already answered in chat
              <small> · closes the ask and sends the thread nothing</small>
            </span>
          </div>
        </>
      ) : null}
      {staged && answer.ok ? (
        <div className="cow-perm-confirm cow-ask-restate" data-cow-ask-restate="">
          <p>
            This will be sent to <b>{title}</b> as a message from you, and it starts its next turn:
          </p>
          <p className="cow-ask-said" data-cow-ask-said="">
            {answer.text}
          </p>
          {draft.stage === "word" ? (
            <label className="cow-ask-word">
              type <b>{CONFIRM_WORD}</b> to confirm:{" "}
              <input
                ref={wordRef}
                data-cow-input="ask-word"
                autoComplete="off"
                spellCheck={false}
                value={draft.word}
                disabled={state.sending}
                onChange={(event) => onWord(event.target.value)}
                onKeyDown={fieldKeys}
              />
            </label>
          ) : null}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="cow-ask-others" data-cow-ask-others={others.length}>
          <p className="cow-perm-kind">Also open on this thread, answered one at a time</p>
          {others.map((other) => (
            <p key={other.id} className="cow-ask-other">
              {other.question}
              {other.risk ? <small> · {other.risk} risk</small> : null}
            </p>
          ))}
        </div>
      ) : null}
      <p className="cow-ans-keys">
        {state.sending ? (
          "sending…"
        ) : draft.stage === "restate" ? (
          <>
            <kbd>⏎</kbd> send it · <kbd>Esc</kbd> back to the choices · an answer cannot be undone
          </>
        ) : draft.stage === "word" ? (
          <>
            type <b>{CONFIRM_WORD}</b>, then <kbd>⏎</kbd> sends it · <kbd>Esc</kbd> back to the choices · an answer cannot be undone
          </>
        ) : (
          <>
            {digits > 0 ? (
              <>
                <kbd>1</kbd>
                {digits > 1 ? (
                  <>
                    –<kbd>{digits}</kbd>
                  </>
                ) : null}{" "}
                choose ·{" "}
              </>
            ) : null}
            <kbd>⏎</kbd> {draft.chat ? "close it, sending nothing" : ask.risk === "medium" || ask.risk === "high" ? "review the answer" : "send the answer"}
            {others.length > 0 && !state.single ? (
              <>
                {" "}
                · <kbd>⇥</kbd> next ask
              </>
            ) : null}{" "}
            · <kbd>Esc</kbd> cancel · an answer cannot be undone
          </>
        )}
        {state.note ? (
          <span className="cow-err" data-cow-answer-note="">
            {" "}
            {state.note}
          </span>
        ) : null}
      </p>
    </div>
  );
}
