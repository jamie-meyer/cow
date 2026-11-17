// A permission request, opened in place under its line: what the agent wants
// to do, in full, and the decisions bb offers, numbered. A digit only marks
// one; Enter confirms; anything wider than this one request asks once more.

import { type RefObject } from "react";
import {
  type FileChange,
  type PermissionAsk,
  type PermissionDraft,
  chosenOption,
  grantText,
  reasonText,
} from "./permission.ts";

function Diff({ change }: { change: FileChange }) {
  const lines = change.diff.replace(/\n$/, "").split("\n");
  return (
    <div className="cow-perm-file" data-cow-permission-file={change.path}>
      <p className="cow-perm-row">
        <span>file</span>
        <code>{change.path}</code>
        {change.change ? <small> · {change.change}</small> : null}
      </p>
      {change.diff ? (
        <pre className="cow-perm-diff" data-cow-permission-diff="">
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
      ) : (
        <p className="cow-ans-why">bb gives no diff for this change.</p>
      )}
    </div>
  );
}

export function PermissionBody({
  ask,
  draft,
  save,
  files,
  textRef,
  disabled,
  onText,
  onConfirm,
  onCancel,
}: {
  ask: PermissionAsk;
  draft: PermissionDraft;
  /** "Allow once, and save as a capability" is marked. */
  save: boolean;
  /** Null while the thread's timeline is being read. */
  files: readonly FileChange[] | null;
  textRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  onText: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { subject } = ask;
  const chosen = chosenOption(draft, ask);
  return (
    <>
      <p className="cow-perm-kind" data-cow-permission={subject.kind}>
        Permission request · {subject.kind === "command" ? "it wants to run a command" : "it wants to change a file"}
      </p>
      {subject.kind === "command" ? (
        <>
          <pre className="cow-perm-cmd" data-cow-permission-command="">
            {subject.command}
          </pre>
          <p className="cow-perm-row">
            <span>in</span>
            {subject.cwd ? <code>{subject.cwd}</code> : <small>bb does not say which directory; by default its workspace</small>}
          </p>
        </>
      ) : files === null ? (
        <p className="cow-ans-why">Reading the change…</p>
      ) : files.length === 0 ? (
        <p className="cow-ans-why" data-cow-permission-nofile="">
          bb has not said which file. {subject.writeScope ? `It would write in ${subject.writeScope}.` : "Open its chat to see the change."}
        </p>
      ) : (
        files.map((change) => <Diff key={change.path} change={change} />)
      )}
      {ask.reason ? (
        <p className="cow-perm-row" data-cow-permission-reason="">
          <span>why bb asks</span>
          <small>{reasonText(ask.reason)}</small>
        </p>
      ) : null}
      {ask.options.map((option, index) => {
        const isChosen = draft.chosen === index + 1;
        return (
          <div
            key={option.action}
            className={`cow-ans-o${isChosen ? " cow-chosen" : ""}${option.text ? " cow-ans-text" : ""}`}
            data-cow-answer-option={index + 1}
            data-cow-permission-action={option.action}
            data-cow-chosen={isChosen || undefined}
          >
            <kbd>{index + 1}</kbd>
            <span className="cow-ans-mark">{option.text ? "✎" : isChosen ? "◉" : "○"}</span>
            {option.text ? (
              <span className="cow-perm-say">
                {option.label}:
                <input
                  ref={textRef}
                  data-cow-input="answer"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="what to tell it"
                  value={draft.message}
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
              </span>
            ) : (
              <span>
                {option.label}
                <small> · {option.detail}</small>
              </span>
            )}
          </div>
        );
      })}
      {canSave(ask) ? (
        <div className={save ? "cow-ans-o cow-chosen" : "cow-ans-o"} data-cow-answer-option={ask.options.length + 1} data-cow-permission-save="" data-cow-chosen={save || undefined}>
          <kbd>{ask.options.length + 1}</kbd>
          <span className="cow-ans-mark">{save ? "◉" : "○"}</span>
          <span>
            Allow once, and save as a capability
            <small> · so cow allows the like without asking: you choose the rule, the name and who it applies to, and confirm</small>
          </span>
        </div>
      ) : null}
      {draft.confirming && chosen?.broad ? (
        <p className="cow-perm-confirm" data-cow-permission-confirm="" role="alert">
          <b>This grants more than this one request.</b> For the rest of this thread's session it may{" "}
          {grantText(ask)}. It cannot be taken back from here; it ends when the session does.{" "}
          <kbd>⏎</kbd> grant it · <kbd>Esc</kbd> go back
        </p>
      ) : null}
    </>
  );
}

/** Whether a capability can be made from this request: it has to be one that can be allowed once. */
export const canSave = (ask: PermissionAsk): boolean => ask.options.some((option) => option.action === "allow_once");

/** The line of keys under the card. */
export function PermissionKeys({ ask, draft, save }: { ask: PermissionAsk; draft: PermissionDraft; save: boolean }) {
  if (draft.confirming) {
    return (
      <>
        <kbd>⏎</kbd> grant for the session · <kbd>Esc</kbd> go back
      </>
    );
  }
  return (
    <>
      <kbd>1</kbd>–<kbd>{ask.options.length + (canSave(ask) ? 1 : 0)}</kbd> choose · <kbd>⏎</kbd> {save ? "set up the capability" : "confirm"} · <kbd>Esc</kbd> cancel · a decision
      cannot be undone: once allowed it runs at once
    </>
  );
}
