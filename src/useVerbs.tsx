// The verbs: what each one asks before it acts, what it does to bb and to
// cow's notes, and where the cursor goes afterwards.
//
// The cursor rule: a verb that makes a line leave its place (park, resume,
// archive, drop) moves the cursor to the next line down, or up when nothing
// is below. Undo puts the cursor on the line it brought back. Every other
// verb leaves the cursor where it is.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { useSdk } from "@get-bb/plugin-sdk/app";
import { AnswerCard, type AnswerState } from "./AnswerCard.tsx";
import { choose, confirm, emptyDraft, oldestAsk, writeText } from "./answer.ts";
import { clockNow } from "./clock.ts";
import { parkNow, reparkNow } from "./park.ts";
import type { Parks } from "./parks.ts";
import { type PickUp, parsePickUp } from "./pickup.ts";
import { ConfirmPrompt, TextPrompt } from "./prompts.tsx";
import type { ParkRecord } from "./shared.ts";
import { isBusy } from "./state.ts";
import { type Line, type Overview, afterLeaving, listed } from "./tree.ts";
import { type UndoEntry, undoText } from "./undo.ts";
import { type Verb, verbBlocked } from "./verbs.ts";

type Sdk = ReturnType<typeof useSdk>;

const MAX_REASON = 300;
const MAX_UNDO = 50;

type Modal =
  | { kind: "park-reason"; threadId: string; value: string; error: string }
  /** `reason` is null when parked work is kept parked: its reason stays. */
  | { kind: "park-pickup"; threadId: string; reason: string | null; value: string; error: string }
  | { kind: "confirm"; mode: string; threadId: string; label: string; cancelled: string; run: () => void }
  | ({ kind: "answer" } & AnswerState);

export interface VerbHost {
  sdk: Sdk;
  overview: Overview;
  main: Line;
  selected: Line | null;
  parks: Parks;
  /** The unarchived threads under a thread, which bb archives along with it. */
  under: (id: string) => string[];
  setCursor: (id: string | null) => void;
  say: (message: string) => void;
  openChat: (id: string) => void;
  focusOverview: () => void;
}

export interface Verbs {
  /** The mode shown at the left of the status line, or null in normal mode. */
  mode: string | null;
  start: (verb: Verb) => void;
  startUndo: () => void;
  /** The newest thing `u` would take back. */
  undoable: UndoEntry | null;
  /** While a prompt is open it takes every key; null when none is. */
  onKey: ((key: string) => void) | null;
  /** The status line's content while a prompt is open. */
  footer: ReactNode | null;
  /** The question card, and the thread whose line it belongs under. */
  card: { threadId: string; node: ReactNode } | null;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function useVerbs(host: VerbHost): Verbs {
  const { sdk, overview, main, parks, setCursor, say, focusOverview } = host;
  const [modal, setModal] = useState<Modal | null>(null);
  const [undo, setUndo] = useState<readonly UndoEntry[]>([]);
  const promptRef = useRef<HTMLInputElement | null>(null);
  const answerRef = useRef<HTMLInputElement | null>(null);

  const lineOf = (id: string): Line | null =>
    [main, ...listed(overview)].find((line) => line.thread.id === id) ?? null;

  const close = useCallback(
    (message?: string) => {
      setModal(null);
      if (message !== undefined) say(message);
      focusOverview();
    },
    [say, focusOverview],
  );

  const remember = (entry: UndoEntry) => setUndo((entries) => [...entries.slice(1 - MAX_UNDO), entry]);

  // A text prompt holds the keyboard for as long as it is open.
  const promptKey = modal?.kind === "park-reason" || modal?.kind === "park-pickup" ? modal.kind : null;
  useEffect(() => {
    if (promptKey !== null) promptRef.current?.focus();
  }, [promptKey]);

  // A question with nothing to choose from goes straight to its text field.
  const answerStep =
    modal?.kind === "answer" && modal.ask?.kind === "questions" ? modal.ask.questions[modal.draft.step] : null;
  useEffect(() => {
    if (answerStep && answerStep.options.length === 0) answerRef.current?.focus();
    else if (answerStep) focusOverview();
  }, [answerStep, focusOverview]);

  // A prompt about a line that has gone, or a question answered elsewhere, closes.
  const target = modal === null ? null : lineOf(modal.threadId);
  const stale =
    modal !== null &&
    (target === null ||
      (modal.kind === "answer" && !modal.sending && !target.thread.hasPendingInteraction));
  useEffect(() => {
    if (stale) close(modal?.kind === "answer" ? "that question is no longer waiting" : "");
  }, [stale, close, modal?.kind]);

  // ---- what the verbs do ------------------------------------------------

  const park = async (line: Line, record: ParkRecord, stopFirst: boolean) => {
    const id = line.thread.id;
    const before = line.derived.park?.record ?? null;
    // Kept parked, the line stays on the shelf; newly parked, it leaves the tree.
    const next = before === null ? afterLeaving(overview, id) : id;
    try {
      if (stopFirst) await sdk.threads.stop({ threadId: id });
      await parks.set(id, record);
      remember({ kind: "park", threadId: id, title: line.thread.title, before });
      setCursor(next);
      close(before === null ? "parked: it is on the shelf" : "kept parked");
    } catch (cause) {
      close(`not parked: ${errorText(cause)}`);
    }
  };

  const submitPickUp = (line: Line, reason: string | null, pickUp: PickUp) => {
    const now = clockNow();
    const before = line.derived.park?.record;
    const record = reason === null && before ? reparkNow(before, pickUp, now) : parkNow(reason ?? "", pickUp, now);
    if (before || !isBusy(line.thread)) return void park(line, record, false);
    setModal({
      kind: "confirm",
      mode: "PARK",
      threadId: line.thread.id,
      label: "its turn is running: stop it and park? Stopping cannot be undone.",
      cancelled: "not parked: its turn is still running",
      run: () => void park(line, record, true),
    });
  };

  const resume = async (line: Line) => {
    const record = line.derived.park?.record;
    if (!record) return;
    const id = line.thread.id;
    const next = afterLeaving(overview, id);
    try {
      await parks.set(id, null);
      remember({ kind: "resume", threadId: id, title: line.thread.title, record });
      setCursor(next);
      say("resumed: it is back in the tree");
    } catch (cause) {
      say(`not resumed: ${errorText(cause)}`);
    }
  };

  const stop = async (line: Line) => {
    try {
      await sdk.threads.stop({ threadId: line.thread.id });
      close("stopped its turn");
    } catch (cause) {
      close(`not stopped: ${errorText(cause)}`);
    }
  };

  const archive = async (line: Line, dropped: boolean) => {
    const id = line.thread.id;
    const next = afterLeaving(overview, id);
    const under = host.under(id);
    try {
      // Dropping ends whatever the thread still runs; a thread at rest has
      // nothing to stop, which is not a reason to keep it.
      if (dropped) await sdk.threads.stop({ threadId: id }).catch(() => undefined);
      await sdk.threads.archive({ threadId: id });
      remember({ kind: "archive", threadId: id, title: line.thread.title, dropped, under });
      setCursor(next);
      close(dropped ? "dropped: stopped and archived" : "archived");
    } catch (cause) {
      close(`not archived: ${errorText(cause)}`);
    }
  };

  const takeBack = async (entry: UndoEntry) => {
    try {
      if (entry.kind === "park") await parks.set(entry.threadId, entry.before);
      else if (entry.kind === "resume") await parks.set(entry.threadId, entry.record);
      else {
        for (const threadId of [entry.threadId, ...entry.under]) await sdk.threads.unarchive({ threadId });
      }
      setUndo((entries) => entries.filter((other) => other !== entry));
      setCursor(entry.threadId);
      close("undone");
    } catch (cause) {
      close(`not undone: ${errorText(cause)}`);
    }
  };

  const openAnswer = (line: Line) => {
    const threadId = line.thread.id;
    setModal({ kind: "answer", threadId, ask: null, draft: emptyDraft([]), sending: false, note: "" });
    sdk.threads.interactions.list({ threadId }).then(
      (interactions) => {
        const ask = oldestAsk(interactions);
        if (ask === null) return close("that question is no longer waiting");
        setModal((current) =>
          current?.kind === "answer" && current.threadId === threadId && current.ask === null
            ? { ...current, ask, draft: emptyDraft(ask.kind === "questions" ? ask.questions : []) }
            : current,
        );
      },
      (cause: unknown) => close(`could not read the question: ${errorText(cause)}`),
    );
  };

  const confirmAnswer = () => {
    if (modal?.kind !== "answer" || modal.sending || modal.ask === null) return;
    const { ask, threadId } = modal;
    if (ask.kind === "other") {
      close();
      return host.openChat(threadId);
    }
    const result = confirm(modal.draft, ask.questions);
    if (result.kind === "incomplete") return setModal({ ...modal, note: result.why });
    if (result.kind === "next") return setModal({ ...modal, draft: result.draft, note: "" });
    setModal({ ...modal, sending: true, note: "" });
    sdk.threads.interactions
      .resolve({
        threadId,
        interactionId: ask.id,
        resolution: { kind: "user_answer", answers: result.answers },
      })
      .then(
        () => close("answered: it carries on with your answer"),
        (cause: unknown) =>
          setModal((current) =>
            current?.kind === "answer"
              ? { ...current, sending: false, note: `not sent: ${errorText(cause)}` }
              : current,
          ),
      );
  };

  // ---- starting a verb --------------------------------------------------

  const start = (verb: Verb) => {
    const line = host.selected;
    const blocked = verbBlocked(verb, line, line?.thread.id === main.thread.id);
    if (line === null || blocked !== null) return say(`cannot ${verb}: ${blocked}`);
    const threadId = line.thread.id;
    const returned = line.derived.park?.due != null;
    const under = host.under(threadId).length;
    const withUnder = under === 0 ? "" : ` and the ${under === 1 ? "thread" : `${under} threads`} under it`;
    say("");
    switch (verb) {
      case "answer":
        return openAnswer(line);
      case "park":
        return setModal(
          returned
            ? { kind: "park-pickup", threadId, reason: null, value: "", error: "" }
            : { kind: "park-reason", threadId, value: "", error: "" },
        );
      case "resume":
        return void resume(line);
      case "stop":
        return setModal(
          returned
            ? {
                kind: "confirm",
                mode: "DROP",
                threadId,
                label: `drop it: stop it, and archive it${withUnder}? Stopping cannot be undone.`,
                cancelled: "not dropped",
                run: () => void archive(line, true),
              }
            : {
                kind: "confirm",
                mode: "STOP",
                threadId,
                label: "stop its turn? This cannot be undone.",
                cancelled: "not stopped",
                run: () => void stop(line),
              },
        );
      case "archive":
        return setModal({
          kind: "confirm",
          mode: "ARCHIVE",
          threadId,
          label: `archive it${withUnder} in bb? u takes it back.`,
          cancelled: "not archived",
          run: () => void archive(line, false),
        });
    }
  };

  const undoable = undo[undo.length - 1] ?? null;
  const startUndo = () => {
    if (undoable === null) return say("nothing to undo: only the last park, resume or archive can be taken back");
    setModal({
      kind: "confirm",
      mode: "UNDO",
      // Undo is about the page, not the selected line, so it stays open
      // whichever line the cursor is on.
      threadId: main.thread.id,
      label: `${undoText(undoable)}?`,
      cancelled: "nothing undone",
      run: () => void takeBack(undoable),
    });
  };

  // ---- the open prompt --------------------------------------------------

  if (modal === null) {
    return { mode: null, start, startUndo, undoable, onKey: null, footer: null, card: null };
  }
  const title = target?.thread.title ?? "";

  if (modal.kind === "confirm") {
    return {
      mode: modal.mode,
      start,
      startUndo,
      undoable,
      onKey: (key) => {
        if (key !== "y" && key !== "Y") return close(modal.cancelled);
        // Closed before it runs, so a second y cannot run it twice.
        close();
        modal.run();
      },
      footer: <ConfirmPrompt mode={modal.mode} name={modal.mode === "UNDO" ? "" : title} label={modal.label} />,
      card: null,
    };
  }

  if (modal.kind === "answer") {
    const questions = modal.ask?.kind === "questions" ? modal.ask.questions : [];
    const question = questions[modal.draft.step];
    return {
      mode: "ANSWER",
      start,
      startUndo,
      undoable,
      onKey: (key) => {
        if (key === "Escape") return close("not answered");
        if (key === "Enter") return confirmAnswer();
        if (!question || modal.sending || !/^[1-9]$/.test(key)) return;
        const number = Number(key);
        if (question.allowFreeText && number === question.options.length + 1) {
          return answerRef.current?.focus();
        }
        setModal({ ...modal, draft: choose(modal.draft, questions, number), note: "" });
      },
      footer: (
        <>
          <span className="cow-mode cow-m-prompt">ANSWER</span>
          <span className="cow-noun">{title}</span>
          <span className="cow-sep">▸</span>
          <span>its question is open under its line</span>
        </>
      ),
      card: {
        threadId: modal.threadId,
        node: (
          <AnswerCard
            state={modal}
            textRef={answerRef}
            onText={(value) =>
              setModal({ ...modal, draft: writeText(modal.draft, questions, value), note: "" })
            }
            onConfirm={confirmAnswer}
            onCancel={() => close("not answered")}
          />
        ),
      },
    };
  }

  const submit = () => {
    if (target === null) return;
    const value = modal.value.trim();
    if (modal.kind === "park-reason") {
      if (value === "") return setModal({ ...modal, error: "a reason is needed: why is it set aside?" });
      if (value.length > MAX_REASON) {
        return setModal({ ...modal, error: `keep the reason under ${MAX_REASON} characters` });
      }
      return setModal({ kind: "park-pickup", threadId: modal.threadId, reason: value, value: "", error: "" });
    }
    const parsed = parsePickUp(value, clockNow());
    if (!parsed.ok) return setModal({ ...modal, error: parsed.error });
    submitPickUp(target, modal.reason, parsed.pickUp);
  };
  const asksReason = modal.kind === "park-reason";
  return {
    mode: "PARK",
    start,
    startUndo,
    undoable,
    // Focus was taken from the prompt, by a click perhaps: give it back.
    onKey: () => promptRef.current?.focus(),
    footer: (
      <TextPrompt
        key={modal.kind}
        mode="PARK"
        name={asksReason ? "park-reason" : "park-pickup"}
        label={
          <>
            {asksReason ? "park" : modal.reason === null ? "keep parked" : "park"} · <b>{title}</b> ·{" "}
            {asksReason ? "reason:" : "pick up when:"}
          </>
        }
        placeholder={
          asksReason ? "why it is set aside" : "19 Nov, +3d, +2w, or a condition; empty asks every 4 weeks"
        }
        value={modal.value}
        error={modal.error}
        go={asksReason ? "next" : "park"}
        inputRef={promptRef}
        onChange={(value) => setModal({ ...modal, value, error: "" })}
        onSubmit={submit}
        onCancel={() => close("not parked")}
      />
    ),
    card: null,
  };
}
