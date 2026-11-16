// A pending question or permission request, opened in place under its line.
// Digits choose, Enter confirms, Escape cancels; choosing alone never sends
// anything.

import { type RefObject } from "react";
import type { Ask, AskQuestion, Draft } from "./answer.ts";
import { PermissionBody, PermissionKeys } from "./PermissionCard.tsx";
import type { FileChange, PermissionDraft } from "./permission.ts";

export interface AnswerState {
  threadId: string;
  /** Null while bb is being asked what the question is. */
  ask: Ask | null;
  draft: Draft;
  /** What is chosen on a permission request. */
  permission: PermissionDraft;
  /** The files a permission request would change; null until they are read. */
  files: readonly FileChange[] | null;
  sending: boolean;
  /** Why Enter did nothing, or why sending failed. */
  note: string;
}

function Question({
  question,
  draft,
  textRef,
  disabled,
  onText,
  onConfirm,
  onCancel,
}: {
  question: AskQuestion;
  draft: Draft;
  textRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onText: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const selected = draft.selected[draft.step] ?? [];
  return (
    <>
      <p className="cow-ans-q" data-cow-answer-prompt="">
        {question.prompt || "It asks you to choose"}
      </p>
      {question.options.map((option, index) => {
        const chosen = selected.includes(option.value);
        return (
          <div
            key={option.value}
            className={chosen ? "cow-ans-o cow-chosen" : "cow-ans-o"}
            data-cow-answer-option={index + 1}
            data-cow-chosen={chosen || undefined}
          >
            <kbd>{index + 1}</kbd>
            <span className="cow-ans-mark">{chosen ? (question.multiSelect ? "☑" : "◉") : question.multiSelect ? "☐" : "○"}</span>
            <span>
              {option.label}
              {option.description ? <small> · {option.description}</small> : null}
            </span>
          </div>
        );
      })}
      {question.allowFreeText ? (
        <div className="cow-ans-o cow-ans-text">
          {question.options.length > 0 ? <kbd>{question.options.length + 1}</kbd> : <span />}
          <span className="cow-ans-mark">✎</span>
          <input
            ref={textRef}
            data-cow-input="answer"
            autoComplete="off"
            spellCheck={false}
            placeholder={question.options.length > 0 ? "or answer in your own words" : "your answer"}
            value={draft.freeText[draft.step] ?? ""}
            disabled={disabled}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Enter") onConfirm();
              else onCancel();
            }}
          />
        </div>
      ) : null}
    </>
  );
}

export function AnswerCard({
  state,
  textRef,
  onText,
  onConfirm,
  onCancel,
}: {
  state: AnswerState;
  textRef: RefObject<HTMLInputElement | null>;
  onText: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { ask, draft } = state;
  let body;
  let keys;
  if (ask === null) {
    body = <p className="cow-ans-q">Reading the question…</p>;
    keys = (
      <>
        <kbd>Esc</kbd> cancel
      </>
    );
  } else if (ask.kind === "other") {
    body = (
      <>
        <p className="cow-ans-q" data-cow-answer-prompt="">
          {ask.title}
        </p>
        <p className="cow-ans-why" data-cow-answer-unsupported="">
          This cannot be answered from here. {ask.why}
        </p>
      </>
    );
    keys = (
      <>
        <kbd>⏎</kbd> open its chat · <kbd>Esc</kbd> cancel
      </>
    );
  } else if (ask.kind === "permission") {
    body = (
      <PermissionBody
        ask={ask}
        draft={state.permission}
        files={state.files}
        textRef={textRef}
        disabled={state.sending}
        onText={onText}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    keys = <PermissionKeys ask={ask} draft={state.permission} />;
  } else {
    const question = ask.questions[draft.step]!;
    const last = draft.step === ask.questions.length - 1;
    body = (
      <Question
        question={question}
        draft={draft}
        textRef={textRef}
        disabled={state.sending}
        onText={onText}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    keys = (
      <>
        {ask.questions.length > 1 ? (
          <b>
            question {draft.step + 1} of {ask.questions.length} ·{" "}
          </b>
        ) : null}
        {question.options.length > 0 ? (
          <>
            <kbd>1</kbd>–<kbd>{question.options.length + (question.allowFreeText ? 1 : 0)}</kbd>{" "}
            {question.multiSelect ? "tick" : "choose"} ·{" "}
          </>
        ) : null}
        <kbd>⏎</kbd> {last ? "send the answer" : "next question"} · <kbd>Esc</kbd> cancel
        {last ? " · an answer cannot be undone" : ""}
      </>
    );
  }
  return (
    <div
      className={ask?.kind === "permission" ? "cow-ans cow-perm" : "cow-ans"}
      data-cow-answer={state.threadId}
      role="group"
      aria-label={ask?.kind === "permission" ? "grant or deny the permission request" : "answer the question"}
    >
      {body}
      <p className="cow-ans-keys">
        {state.sending ? "sending…" : keys}
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
