// A refused permission, opened in place under its line: what bb refused
// without asking, in full, and what cow can do about it, numbered. A digit
// only marks a choice; Enter carries it out. The message a choice sends is
// shown first and can be edited.

import { type RefObject } from "react";
import { BLOCKED_OPTIONS, type BlockedDraft, type Refusal, chosenBlocked } from "./refusal.ts";
import { formatAge } from "./text.ts";

export interface BlockedState {
  threadId: string;
  /** What was refused when the card opened; it does not change under the user. */
  refusals: readonly Refusal[];
  draft: BlockedDraft;
  /** "Save a capability for this" is marked. */
  save: boolean;
  sending: boolean;
  /** Why Enter did nothing, or why sending failed. */
  note: string;
}

function Refused({ refusal, now, covered }: { refusal: Refusal; now: number; covered: string | null }) {
  const lines = (refusal.diff ?? "").replace(/\n$/, "").split("\n");
  return (
    <div className="cow-blk-one" data-cow-refusal={refusal.kind}>
      {refusal.kind === "command" ? (
        <>
          <pre className="cow-perm-cmd" data-cow-refusal-command="">
            {refusal.what}
          </pre>
          {refusal.cwd ? (
            <p className="cow-perm-row">
              <span>in</span>
              <code>{refusal.cwd}</code>
            </p>
          ) : null}
        </>
      ) : (
        <div className="cow-perm-file">
          <p className="cow-perm-row">
            <span>file</span>
            <code data-cow-refusal-path="">{refusal.what}</code>
            {refusal.change ? <small> · {refusal.change}</small> : null}
          </p>
          {refusal.diff ? (
            <pre className="cow-perm-diff">
              {lines.map((line, index) => (
                <span
                  key={index}
                  className={
                    /^(\+\+\+|---)/.test(line) ? "cow-diff-head" : line.startsWith("+") ? "cow-diff-add" : line.startsWith("-") ? "cow-diff-del" : undefined
                  }
                >
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          ) : null}
        </div>
      )}
      <p className="cow-perm-row">
        <span>bb said</span>
        <small>
          {refusal.why} · {formatAge(Math.max(0, now - refusal.at))} ago
        </small>
      </p>
      {covered !== null ? (
        <p className="cow-perm-row cow-covered" data-cow-refusal-covered={covered}>
          <span>covered by</span>
          <small>
            <b>{covered}</b> · a capability of this thread's: asked again as you, bb raises a request and cow allows it once
          </small>
        </p>
      ) : null}
    </div>
  );
}

export function BlockedCard({
  state,
  covered,
  now,
  textRef,
  onText,
  onConfirm,
  onLeaveText,
}: {
  state: BlockedState;
  /** For each refusal, the name of the capability that covers it, or null. */
  covered: readonly (string | null)[];
  now: number;
  textRef: RefObject<HTMLTextAreaElement | null>;
  onText: (value: string) => void;
  onConfirm: () => void;
  /** Escape in the message: back to the choices, keeping the edit. */
  onLeaveText: () => void;
}) {
  const { refusals, draft } = state;
  const chosen = chosenBlocked(draft);
  const count = refusals.length;
  return (
    <div
      className="cow-ans cow-perm cow-blk"
      data-cow-blocked={state.threadId}
      data-cow-blocked-count={count}
      role="group"
      aria-label="what to do about the refused permission"
    >
      <p className="cow-perm-kind">
        Blocked on a permission · bb refused {count === 1 ? "this" : `these ${count}`} without asking you
      </p>
      {refusals.map((refusal, index) => (
        <Refused key={`${refusal.id}:${refusal.what}`} refusal={refusal} now={now} covered={covered[index] ?? null} />
      ))}
      <p className="cow-ans-why">
        bb asks for permission only on a turn that a person started. Another thread started this one, so bb said no
        by itself and raised no request.
      </p>
      {BLOCKED_OPTIONS.map((option, index) => {
        const isChosen = draft.chosen === index + 1;
        return (
          <div
            key={option.action}
            className={isChosen ? "cow-ans-o cow-chosen" : "cow-ans-o"}
            data-cow-answer-option={index + 1}
            data-cow-blocked-action={option.action}
            data-cow-chosen={isChosen || undefined}
          >
            <kbd>{index + 1}</kbd>
            <span className="cow-ans-mark">{isChosen ? "◉" : "○"}</span>
            <span>
              {option.label}
              <small> · {option.detail}</small>
            </span>
          </div>
        );
      })}
      <div className={state.save ? "cow-ans-o cow-chosen" : "cow-ans-o"} data-cow-answer-option={BLOCKED_OPTIONS.length + 1} data-cow-blocked-save="" data-cow-chosen={state.save || undefined}>
        <kbd>{BLOCKED_OPTIONS.length + 1}</kbd>
        <span className="cow-ans-mark">{state.save ? "◉" : "○"}</span>
        <span>
          Save a capability for this
          <small> · so that, asked again as you, the request is allowed without your answer; nothing is sent now</small>
        </span>
      </div>
      {chosen === "ask_again" || chosen === "carry_on" ? (
        <label className="cow-blk-msg">
          <span>
            cow will send this to the thread as you · <kbd>e</kbd> edit it
          </span>
          <textarea
            ref={textRef}
            data-cow-input="blocked-message"
            autoComplete="off"
            spellCheck={false}
            rows={Math.min(10, draft.messages[chosen].split("\n").length + 2)}
            value={draft.messages[chosen]}
            disabled={state.sending}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Enter") onConfirm();
                else onLeaveText();
              }
            }}
          />
        </label>
      ) : null}
      <p className="cow-ans-keys">
        {state.sending ? (
          "sending…"
        ) : (
          <>
            <kbd>1</kbd>–<kbd>{BLOCKED_OPTIONS.length + 1}</kbd> choose · <kbd>⏎</kbd>{" "}
            {state.save ? "set up the capability" : chosen === "dismiss" ? "dismiss" : chosen === null ? "confirm" : "send"} · <kbd>Esc</kbd> cancel
            {chosen === "ask_again" || chosen === "carry_on" ? " · a sent message cannot be undone" : ""}
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
