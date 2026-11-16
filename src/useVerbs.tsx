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
import { BlockedCard, type BlockedState } from "./BlockedCard.tsx";
import { clockNow } from "./clock.ts";
import { parkNow, reparkNow } from "./park.ts";
import type { Parks } from "./parks.ts";
import {
  type PermissionAsk,
  choosePermission,
  confirmPermission,
  emptyPermissionDraft,
  fileChanges,
} from "./permission.ts";
import { type PickUp, parsePickUp } from "./pickup.ts";
import { ConfirmPrompt, TextPrompt } from "./prompts.tsx";
import { chooseBlocked, confirmBlocked, emptyBlockedDraft, writeBlocked } from "./refusal.ts";
import type { ParkRecord } from "./shared.ts";
import { isBusy } from "./state.ts";
import { type Line, type Overview, type TodoRow, afterLeaving as leaving, listed } from "./tree.ts";
import { type UndoEntry, undoText } from "./undo.ts";
import { type Verb, verbBlocked } from "./verbs.ts";

type Sdk = ReturnType<typeof useSdk>;

const MAX_REASON = 300;
const MAX_UNDO = 50;

type Modal =
  | { kind: "park-reason"; threadId: string; value: string; error: string }
  /** `reason` is null when parked work is kept parked: its reason stays. */
  | { kind: "park-pickup"; threadId: string; reason: string | null; value: string; error: string }
  /** Why it is archived, or dropped: one optional line, then it happens. */
  | { kind: "archive-reason"; threadId: string; dropped: boolean; value: string; error: string }
  | { kind: "confirm"; mode: string; threadId: string; label: string; cancelled: string; run: () => void }
  | ({ kind: "answer" } & AnswerState)
  | ({ kind: "blocked" } & BlockedState);

export interface VerbHost {
  sdk: Sdk;
  overview: Overview;
  main: Line;
  selected: Line | null;
  parks: Parks;
  now: number;
  /** The groups folded in this window: the cursor skips their members. */
  folded: ReadonlySet<string>;
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
  /** Mark the line's reply as seen. Quietly when the person opened or answered it; `u` takes back only a marking they asked for. */
  markSeen: (line: Line, asked: boolean) => void;
  /** Ask, then take a not-started item off its list. */
  removeTodo: (row: TodoRow) => void;
  moveTodo: (row: TodoRow, by: 1 | -1) => void;
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
  const blockedRef = useRef<HTMLTextAreaElement | null>(null);

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

  const afterLeaving = (id: string) => leaving(overview, id, host.folded);

  const remember = (entry: UndoEntry) => setUndo((entries) => [...entries.slice(1 - MAX_UNDO), entry]);

  // A text prompt holds the keyboard for as long as it is open.
  const promptKey =
    modal?.kind === "park-reason" || modal?.kind === "park-pickup" || modal?.kind === "archive-reason"
      ? modal.kind
      : null;
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
      (modal.kind === "answer" && !modal.sending && !target.thread.hasPendingInteraction) ||
      (modal.kind === "blocked" && !modal.sending && !target.derived.blocked));
  useEffect(() => {
    if (!stale) return;
    close(
      modal?.kind === "answer"
        ? "that question is no longer waiting"
        : modal?.kind === "blocked"
          ? "it is no longer blocked on that"
          : "",
    );
  }, [stale, close, modal?.kind]);

  // ---- what the verbs do ------------------------------------------------

  const park = async (line: Line, record: ParkRecord, stopFirst: boolean) => {
    const id = line.thread.id;
    const before = line.derived.park?.record ?? null;
    // Kept parked, the line stays on the shelf; newly parked, it leaves the tree.
    const next = before === null ? afterLeaving(id) : id;
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
    const next = afterLeaving(id);
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

  const archive = async (line: Line, dropped: boolean, reason: string | null) => {
    const id = line.thread.id;
    const next = afterLeaving(id);
    const under = host.under(id);
    try {
      // The backend records the reason, stops a dropped thread, and archives it.
      await parks.archive(id, reason, dropped, clockNow());
      remember({ kind: "archive", threadId: id, title: line.thread.title, dropped, under, reason });
      setCursor(next);
      close(`${dropped ? "dropped: stopped and archived" : "archived"}${reason === null ? "" : `: ${reason}`}`);
    } catch (cause) {
      close(`not archived: ${errorText(cause)}`);
    }
  };

  const takeBack = async (entry: UndoEntry) => {
    try {
      if (entry.kind === "park") await parks.set(entry.threadId, entry.before);
      else if (entry.kind === "resume") await parks.set(entry.threadId, entry.record);
      else if (entry.kind === "dismiss") await parks.setDismissal(entry.threadId, entry.before);
      else if (entry.kind === "seen") await parks.setSeen(entry.threadId, entry.before);
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

  const markSeen = (line: Line, asked: boolean) => {
    const reply = line.derived.reply;
    const id = line.thread.id;
    if (!reply) {
      if (asked) say(line.derived.waitingOnYou ? "it waits on more than a reply: Space only marks a reply as seen" : "it has no reply waiting on you");
      return;
    }
    const before = parks.seen.get(id) ?? null;
    parks.setSeen(id, { seq: reply.seq, at: clockNow() }).then(
      () => {
        if (!asked) return;
        remember({ kind: "seen", threadId: id, title: line.thread.title, before });
        say("marked as seen: u takes it back");
      },
      (cause: unknown) => say(`not marked as seen: ${errorText(cause)}`),
    );
  };

  const removeTodo = (row: TodoRow) => {
    const next = afterLeaving(row.id);
    say("");
    setModal({
      kind: "confirm",
      mode: "REMOVE",
      threadId: row.ownerId,
      label: `remove “${row.item.title}” from what is not started? This cannot be undone.`,
      cancelled: "not removed",
      run: () =>
        void parks.changeTodo(row.ownerId, row.item.id, "remove").then(
          () => {
            setCursor(next);
            say("removed from the list");
          },
          (cause: unknown) => say(`not removed: ${errorText(cause)}`),
        ),
    });
  };

  const moveTodo = (row: TodoRow, by: 1 | -1) => {
    if (by < 0 ? row.number === 1 : row.number === row.of) return say(by < 0 ? "it is first already" : "it is last already");
    parks.changeTodo(row.ownerId, row.item.id, by < 0 ? "up" : "down").then(
      () => say(""),
      (cause: unknown) => say(`not moved: ${errorText(cause)}`),
    );
  };

  const openAnswer = (line: Line) => {
    const threadId = line.thread.id;
    setModal({
      kind: "answer",
      threadId,
      ask: null,
      draft: emptyDraft([]),
      permission: emptyPermissionDraft,
      files: null,
      sending: false,
      note: "",
    });
    sdk.threads.interactions.list({ threadId }).then(
      (interactions) => {
        const ask = oldestAsk(interactions);
        if (ask === null) return close("that question is no longer waiting");
        setModal((current) =>
          current?.kind === "answer" && current.threadId === threadId && current.ask === null
            ? { ...current, ask, draft: emptyDraft(ask.kind === "questions" ? ask.questions : []) }
            : current,
        );
        if (ask.kind === "permission") readChange(threadId, ask);
      },
      (cause: unknown) => close(`could not read the question: ${errorText(cause)}`),
    );
  };

  /** The file and diff a request is about are in the thread's timeline, not in the request. */
  const readChange = (threadId: string, ask: PermissionAsk) => {
    const show = (files: ReturnType<typeof fileChanges>) =>
      setModal((current) =>
        current?.kind === "answer" && current.threadId === threadId && current.ask?.id === ask.id
          ? { ...current, files }
          : current,
      );
    if (ask.subject.kind !== "file_change") return show([]);
    sdk.threads.timeline({ threadId }).then(
      (timeline) => show(fileChanges((timeline as { rows?: unknown[] }).rows ?? [], ask.itemId)),
      // The card then says bb has not named the file.
      () => show([]),
    );
  };

  const confirmPermissionAnswer = (state: Extract<Modal, { kind: "answer" }>, ask: PermissionAsk) => {
    const { threadId } = state;
    const result = confirmPermission(state.permission, ask);
    if (result.kind === "incomplete") return setModal({ ...state, note: result.why });
    if (result.kind === "confirm") return setModal({ ...state, permission: result.draft, note: "" });
    const { resolution, message } = result;
    const failed = (what: string) => (cause: unknown) =>
      setModal((current) =>
        current?.kind === "answer" ? { ...current, sending: false, note: `${what}: ${errorText(cause)}` } : current,
      );
    setModal({ ...state, sending: true, note: "" });
    sdk.threads.interactions.resolve({ threadId, interactionId: ask.id, resolution }).then(() => {
      if (resolution.decision !== "deny") {
        return close(
          resolution.decision === "allow_once"
            ? "allowed once: it carries on"
            : "allowed for the rest of its session: it carries on",
        );
      }
      if (message === null) return close("denied: it was told no");
      // bb's denial carries no text, so the reason follows as a message.
      sdk.threads
        .send({ threadId, mode: "auto", input: [{ type: "text", text: message, mentions: [] }] })
        .then(
          () => close("denied, and told why"),
          (cause: unknown) => close(`denied, but your message was not sent: ${errorText(cause)}`),
        );
    }, failed("not sent"));
  };

  const confirmAnswer = () => {
    if (modal?.kind !== "answer" || modal.sending || modal.ask === null) return;
    const { ask, threadId } = modal;
    if (ask.kind === "other") {
      close();
      return host.openChat(threadId);
    }
    if (ask.kind === "permission") return confirmPermissionAnswer(modal, ask);
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

  const confirmBlockedChoice = () => {
    if (modal?.kind !== "blocked" || modal.sending) return;
    const { threadId, refusals } = modal;
    const result = confirmBlocked(modal.draft);
    if (result.kind === "incomplete") return setModal({ ...modal, note: result.why });
    const failed = (what: string) => (cause: unknown) =>
      setModal((current) =>
        current?.kind === "blocked" ? { ...current, sending: false, note: `${what}: ${errorText(cause)}` } : current,
      );
    setModal({ ...modal, sending: true, note: "" });
    if (result.kind === "dismiss") {
      const before = parks.dismissals.get(threadId) ?? null;
      const throughSeq = Math.max(...refusals.map((refusal) => refusal.seq));
      return void parks.setDismissal(threadId, { throughSeq, at: clockNow() }).then(() => {
        remember({ kind: "dismiss", threadId, title: lineOf(threadId)?.thread.title ?? "", before });
        close("dismissed: the thread was told nothing");
      }, failed("not dismissed"));
    }
    // Sent as the user, so the turn it starts is one a person started.
    sdk.threads
      .send({ threadId, mode: "auto", input: [{ type: "text", text: result.text, mentions: [] }] })
      .then(
        () =>
          close(
            result.action === "ask_again"
              ? "asked again as you: bb will ask you for permission when it tries"
              : "told it to carry on without that permission",
          ),
        failed("not sent"),
      );
  };

  // ---- starting a verb --------------------------------------------------

  const start = (verb: Verb) => {
    const line = host.selected;
    const blocked = verbBlocked(verb, line, line?.thread.id === main.thread.id);
    if (line === null || blocked !== null) return say(`cannot ${verb}: ${blocked}`);
    const threadId = line.thread.id;
    const returned = line.derived.park?.due != null;
    say("");
    switch (verb) {
      case "answer": {
        // A real request comes first; a refusal has no request to answer.
        const refusals = line.derived.blocked?.refusals;
        if (line.thread.hasPendingInteraction || !refusals) return openAnswer(line);
        return setModal({
          kind: "blocked",
          threadId,
          refusals,
          draft: emptyBlockedDraft(refusals),
          sending: false,
          note: "",
        });
      }
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
            ? { kind: "archive-reason", threadId, dropped: true, value: parks.archives.get(threadId)?.reason ?? "", error: "" }
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
        // A reason given before, and kept through an undo, is offered again.
        return setModal({
          kind: "archive-reason",
          threadId,
          dropped: false,
          value: parks.archives.get(threadId)?.reason ?? "",
          error: "",
        });
    }
  };

  const undoable = undo[undo.length - 1] ?? null;
  const startUndo = () => {
    if (undoable === null) return say("nothing to undo: only the last park, resume, archive, dismissal or mark as seen can be taken back");
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

  const common = { start, startUndo, markSeen, removeTodo, moveTodo, undoable };
  if (modal === null) {
    return { mode: null, ...common, onKey: null, footer: null, card: null };
  }
  const title = target?.thread.title ?? "";

  if (modal.kind === "confirm") {
    return {
      mode: modal.mode,
      ...common,
      onKey: (key) => {
        if (key !== "y" && key !== "Y") return close(modal.cancelled);
        // Closed before it runs, so a second y cannot run it twice.
        close();
        modal.run();
      },
      footer: <ConfirmPrompt mode={modal.mode} name={modal.mode === "UNDO" || modal.mode === "REMOVE" ? "" : title} label={modal.label} />,
      card: null,
    };
  }

  if (modal.kind === "answer") {
    const questions = modal.ask?.kind === "questions" ? modal.ask.questions : [];
    const question = questions[modal.draft.step];
    return {
      mode: "ANSWER",
      ...common,
      onKey: (key) => {
        const request = modal.ask?.kind === "permission" ? modal.ask : null;
        if (key === "Escape") {
          // Escape first backs out of a wider grant that is waiting for its second Enter.
          if (request && modal.permission.confirming && !modal.sending) {
            return setModal({ ...modal, permission: { ...modal.permission, confirming: false }, note: "" });
          }
          return close(request ? "not decided: it is still waiting" : "not answered");
        }
        if (key === "Enter") return confirmAnswer();
        if (request) {
          if (modal.sending || !/^[1-9]$/.test(key)) return;
          const permission = choosePermission(modal.permission, request, Number(key));
          setModal({ ...modal, permission, note: "" });
          if (request.options[Number(key) - 1]?.text) answerRef.current?.focus();
          else focusOverview();
          return;
        }
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
          <span>
            {modal.ask?.kind === "permission" ? "its permission request" : "its question"} is open under its line
          </span>
        </>
      ),
      card: {
        threadId: modal.threadId,
        node: (
          <AnswerCard
            state={modal}
            textRef={answerRef}
            onText={(value) =>
              setModal(
                modal.ask?.kind === "permission"
                  ? { ...modal, permission: { ...modal.permission, message: value }, note: "" }
                  : { ...modal, draft: writeText(modal.draft, questions, value), note: "" },
              )
            }
            onConfirm={confirmAnswer}
            onCancel={() =>
              close(modal.ask?.kind === "permission" ? "not decided: it is still waiting" : "not answered")
            }
          />
        ),
      },
    };
  }

  if (modal.kind === "blocked") {
    const leaveText = () => focusOverview();
    return {
      mode: "BLOCKED",
      ...common,
      onKey: (key) => {
        if (key === "Escape") return close("nothing sent: it is still blocked");
        if (key === "Enter") return confirmBlockedChoice();
        if (modal.sending) return;
        if (key === "e") {
          const field = blockedRef.current;
          if (!field) return;
          field.focus();
          // The caret goes to the end: an edit usually adds to the message.
          return field.setSelectionRange(field.value.length, field.value.length);
        }
        if (/^[1-9]$/.test(key)) setModal({ ...modal, draft: chooseBlocked(modal.draft, Number(key)), note: "" });
      },
      footer: (
        <>
          <span className="cow-mode cow-m-prompt">BLOCKED</span>
          <span className="cow-noun">{title}</span>
          <span className="cow-sep">▸</span>
          <span>what bb refused it is open under its line</span>
        </>
      ),
      card: {
        threadId: modal.threadId,
        node: (
          <BlockedCard
            state={modal}
            now={host.now}
            textRef={blockedRef}
            onText={(value) => setModal({ ...modal, draft: writeBlocked(modal.draft, value), note: "" })}
            onConfirm={confirmBlockedChoice}
            onLeaveText={leaveText}
          />
        ),
      },
    };
  }

  if (modal.kind === "archive-reason") {
    const { dropped } = modal;
    const under = host.under(modal.threadId).length;
    const withUnder = under === 0 ? "" : ` and the ${under === 1 ? "thread" : `${under} threads`} under it`;
    const cancelled = dropped ? "not dropped" : "not archived";
    const submitReason = () => {
      if (target === null) return;
      const value = modal.value.trim();
      if (value.length > MAX_REASON) {
        return setModal({ ...modal, error: `keep the reason under ${MAX_REASON} characters` });
      }
      // Closed before it runs, so a second Enter cannot run it twice.
      close();
      void archive(target, dropped, value === "" ? null : value);
    };
    return {
      mode: dropped ? "DROP" : "ARCHIVE",
      ...common,
      onKey: () => promptRef.current?.focus(),
      footer: (
        <TextPrompt
          mode={dropped ? "DROP" : "ARCHIVE"}
          name="archive-reason"
          label={
            <>
              {dropped ? "drop" : "archive"} · <b>{title}</b>
              {withUnder} · reason:
            </>
          }
          placeholder="why, or nothing"
          value={modal.value}
          error={modal.error}
          go={dropped ? "stop it for good and archive it; u brings it back, stopped" : "archive it in bb; u takes it back"}
          inputRef={promptRef}
          onChange={(value) => setModal({ ...modal, value, error: "" })}
          onSubmit={submitReason}
          onCancel={() => close(cancelled)}
        />
      ),
      card: null,
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
    ...common,
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
