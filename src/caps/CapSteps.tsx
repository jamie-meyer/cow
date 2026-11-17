// The steps that make a capability, drawn as a card: under a thread's line
// when they start from its request, refusal or ask, and inside the sheet
// when they start there. Each step is one field or one choice; the last is
// one sentence that says what will be allowed for whom, and Enter on it is
// the confirmation that saves.

import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Capability, type Scope, VIA_TEXT, type Via, kindText, scopeText } from "./cap.ts";
import type { CapsData } from "./data.ts";
import { type Proposal, type StepsDraft, advance, back, digit, restated, scopeChoices, startSteps, toggleMode, write } from "./steps.ts";

export interface StepsOrigin {
  via: Via;
  /** The thread it starts from: who it can apply to is offered around this thread. */
  threadId: string;
  /** Drawn under the thread's line, or inside the capabilities sheet. */
  where: "line" | "sheet";
  /** From a permission request: the request, which is allowed once when the capability is saved. */
  interactionId?: string;
  /** From a thread's ask for a capability: the ask, which is answered when it is saved. */
  askId?: string;
}

export interface CapStepsHost {
  caps: CapsData;
  mainId: string;
  titleOf: (threadId: string) => string;
  say: (message: string) => void;
  focusOverview: () => void;
  /** What follows saving, by where the steps began; returns what to tell the person. */
  after: (origin: StepsOrigin, capability: Capability) => Promise<string>;
  /** The steps were left without saving. */
  cancelled: (origin: StepsOrigin) => string;
}

export interface CapStepsControl {
  origin: StepsOrigin | null;
  start: (origin: StepsOrigin, proposal: Proposal | null) => void;
  /** While the steps are open they take every key; null when they are not. */
  onKey: ((key: string) => void) | null;
  node: ReactNode;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const FIELD: Partial<Record<StepsDraft["stage"], string>> = { rule: "cap-rule", name: "cap-name", note: "cap-note" };
const SCOPE_DETAIL: Record<Scope["kind"], string> = {
  thread: "no other thread, and none it starts",
  subtree: "it, and whatever it starts from now on",
  main: "everything Main has started and will start; not Main itself",
};

export function useCapSteps(host: CapStepsHost): CapStepsControl {
  const [open, setOpen] = useState<{ origin: StepsOrigin; draft: StepsDraft; saving: boolean } | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const stage = open?.draft.stage ?? null;

  // A step with a field holds the keyboard there; a step of choices gives it back.
  useEffect(() => {
    if (stage === null) return;
    if (FIELD[stage]) {
      const field = fieldRef.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    } else host.focusOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  if (open === null) {
    return { origin: null, start: (origin, proposal) => setOpen({ origin, draft: startSteps(proposal), saving: false }), onKey: null, node: null };
  }
  const { origin, draft, saving } = open;
  const scopes = scopeChoices(origin.threadId, host.mainId);
  const set = (next: StepsDraft) => setOpen({ origin, draft: next, saving: false });
  const leave = (message: string) => {
    setOpen(null);
    host.say(message);
    host.focusOverview();
  };

  const confirm = () => {
    if (saving) return;
    const step = advance(draft, scopes, host.caps.places);
    if (step.kind === "stay") return set(step.draft);
    setOpen({ origin, draft, saving: true });
    host.caps
      .create({ name: step.name, note: step.note, rule: step.rule, scope: step.scope, via: origin.via, sourceThreadId: origin.where === "sheet" ? null : origin.threadId, askId: origin.askId ?? null })
      .then((made) => host.after(origin, made))
      .then(leave, (cause: unknown) => setOpen({ origin, draft: { ...draft, error: `not saved: ${errorText(cause)}` }, saving: false }));
  };
  const goBack = () => {
    if (saving) return;
    const before = back(draft);
    if (before === null) leave(host.cancelled(origin));
    else set(before);
  };
  const fieldKeys = (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
    // Tab never leaves the field: on a command's rule it switches between the exact line and a prefix.
    if (event.key !== "Enter" && event.key !== "Escape" && event.key !== "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") confirm();
    else if (event.key === "Escape") goBack();
    else set(toggleMode(draft));
  };
  const onKey = (key: string) => {
    if (key === "Escape") return goBack();
    if (key === "Enter") return confirm();
    if (saving) return;
    if (FIELD[draft.stage]) {
      if (key === "Tab" && draft.stage === "rule") set(toggleMode(draft));
      // Focus was taken from the field, by a click perhaps: give it back.
      return fieldRef.current?.focus();
    }
    if (/^[1-9]$/.test(key)) set(digit(draft, Number(key), scopes));
  };

  const reached = (other: StepsDraft["stage"]) => ["kind", "rule", "name", "note", "scope", "restate"].indexOf(draft.stage) > ["kind", "rule", "name", "note", "scope", "restate"].indexOf(other);
  const field = (name: StepsDraft["stage"], label: string, value: string, placeholder: string) =>
    draft.stage === name ? (
      <label className="cow-cap-field">
        <span>{label}</span>
        <input ref={fieldRef} data-cow-input={FIELD[name]} autoComplete="off" spellCheck={false} placeholder={placeholder} value={value} disabled={saving} onChange={(event) => set(write(draft, event.target.value))} onKeyDown={fieldKeys} />
      </label>
    ) : reached(name) ? (
      <p className="cow-perm-row" data-cow-capsteps-done={name}>
        <span>{label}</span>
        {name === "rule" ? <code>{value}</code> : <small>{value || "none"}</small>}
      </p>
    ) : null;
  const sentence = draft.stage === "restate" ? restated(draft, scopes, host.caps.places, host.titleOf) : null;
  const chosenScope = draft.scope === null ? null : (scopes[draft.scope - 1] ?? null);
  const what = draft.kind === "dir" ? "write a directory" : draft.mode === "exact" ? "run a command" : "run a command, by prefix";

  const node = (
    <div className="cow-ans cow-perm cow-capsteps" data-cow-capsteps={origin.threadId} data-cow-capsteps-stage={draft.stage} data-cow-capsteps-where={origin.where} role="group" aria-label="save a capability">
      <p className="cow-perm-kind">
        Save a capability · {VIA_TEXT[origin.via]}
        {origin.interactionId ? " · this request is allowed once when it is saved" : ""}
      </p>
      {draft.stage === "kind" ? (
        <>
          <p className="cow-ans-q">What kind?</p>
          {(["dir", "command"] as const).map((kind, index) => (
            <div key={kind} className={draft.kind === kind ? "cow-ans-o cow-chosen" : "cow-ans-o"} data-cow-cap-kind={kind} data-cow-chosen={draft.kind === kind || undefined}>
              <kbd>{index + 1}</kbd>
              <span className="cow-ans-mark">{draft.kind === kind ? "◉" : "○"}</span>
              <span>
                {kind === "dir" ? "Write a directory" : "Run a command"}
                <small> · {kind === "dir" ? "create and change files anywhere under one absolute directory" : "one command bb asks about: the exact line, or a prefix of its words"}</small>
              </span>
            </div>
          ))}
        </>
      ) : (
        <p className="cow-perm-row" data-cow-capsteps-kind={draft.kind}>
          <span>kind</span>
          <small>{reached("rule") ? kindText(draft.kind === "dir" ? { kind: "dir", dir: draft.text } : { kind: "command", mode: draft.mode, text: draft.text, words: [draft.text] }) : what}</small>
        </p>
      )}
      {field("rule", draft.kind === "dir" ? "directory" : draft.mode === "exact" ? "command" : "prefix", draft.text, draft.kind === "dir" ? "/an/absolute/directory" : "the command line, in plain words")}
      {draft.stage === "rule" ? (
        draft.kind === "dir" ? (
          <p className="cow-ans-why">Everything under it is covered, at any depth. Delete from the end to widen it to a parent. Refused: the root, your home directory, and anything that is, holds or is inside bb's data or a credentials directory.</p>
        ) : (
          <>
            {(["exact", "prefix"] as const).map((mode) => (
              <div key={mode} className={draft.mode === mode ? "cow-ans-o cow-chosen" : "cow-ans-o"} data-cow-cap-mode={mode} data-cow-chosen={draft.mode === mode || undefined}>
                <kbd>{mode === draft.mode ? "" : "⇥"}</kbd>
                <span className="cow-ans-mark">{draft.mode === mode ? "◉" : "○"}</span>
                <span>
                  {mode === "exact" ? "exactly this command line" : "any command line that begins with these words"}
                  <small> · {mode === "exact" ? "character for character" : "at least two words; cut the line above down to the words that must match"}</small>
                </span>
              </div>
            ))}
            <p className="cow-ans-why">Plain words only: a rule with a shell operator or expansion in it (; &amp; | &lt; &gt; ` $ and the like) is refused, and no rule covers a command that has one.</p>
          </>
        )
      ) : null}
      {field("name", "name", draft.name, "what the log and each line will call it")}
      {field("note", "note", draft.note, "optional: why it exists")}
      {draft.stage === "scope" ? (
        <>
          <p className="cow-ans-q">Who does it apply to?</p>
          {scopes.map((scope, index) => {
            const chosen = draft.scope === index + 1;
            return (
              <div key={scope.kind} className={chosen ? "cow-ans-o cow-chosen" : "cow-ans-o"} data-cow-cap-scope={scope.kind} data-cow-chosen={chosen || undefined}>
                <kbd>{index + 1}</kbd>
                <span className="cow-ans-mark">{chosen ? "◉" : "○"}</span>
                <span>
                  {scopeText(scope, host.titleOf)}
                  <small> · {SCOPE_DETAIL[scope.kind]}</small>
                </span>
              </div>
            );
          })}
        </>
      ) : reached("scope") && chosenScope ? (
        <p className="cow-perm-row" data-cow-capsteps-done="scope">
          <span>for</span>
          <small>{scopeText(chosenScope, host.titleOf)}</small>
        </p>
      ) : null}
      {sentence?.ok ? (
        <p className="cow-perm-confirm" data-cow-capsteps-restate="" role="alert">
          <b>{sentence.value}</b> cow will answer bb “allow once” for each such request and log it. It lasts until you delete it. <kbd>⏎</kbd> save it · <kbd>Esc</kbd> go back
        </p>
      ) : null}
      <p className="cow-ans-keys">
        {saving ? (
          "saving…"
        ) : draft.stage === "restate" ? (
          <>
            <kbd>⏎</kbd> save the capability{origin.interactionId ? ", and allow this request once" : ""} · <kbd>Esc</kbd> back
          </>
        ) : draft.stage === "kind" || draft.stage === "scope" ? (
          <>
            <kbd>1</kbd>–<kbd>{draft.stage === "kind" ? 2 : scopes.length}</kbd> choose · <kbd>⏎</kbd> next · <kbd>Esc</kbd> {back(draft) === null ? "cancel" : "back"}
          </>
        ) : (
          <>
            <kbd>⏎</kbd> next{draft.stage === "rule" && draft.kind === "command" ? (
              <>
                {" "}
                · <kbd>⇥</kbd> exact or prefix
              </>
            ) : null}{" "}
            · <kbd>Esc</kbd> {back(draft) === null ? "cancel" : "back"} · nothing is saved until the last step
          </>
        )}
        {draft.error || (sentence && !sentence.ok) ? (
          <span className="cow-err" data-cow-capsteps-error="">
            {" "}
            {draft.error || (sentence && !sentence.ok ? sentence.error : "")}
          </span>
        ) : null}
      </p>
    </div>
  );

  return { origin, start: (next, proposal) => setOpen({ origin: next, draft: startSteps(proposal), saving: false }), onKey, node };
}
