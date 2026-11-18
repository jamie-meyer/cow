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
import { AskCard, type AskState } from "./AskCard.tsx";
import { backOut, chatDigit, confirmAsk, emptyAskDraft, markChat, markOption, nextAsk, writeAnswer, writeWord } from "./asks/card.ts";
import type { RaisedData } from "./raisedData.ts";
import { choose, confirm, emptyDraft, oldestAsk, writeText } from "./answer.ts";
import { BlockedCard, type BlockedState } from "./BlockedCard.tsx";
import type { StepsOrigin } from "./caps/CapSteps.tsx";
import type { CapsData } from "./caps/data.ts";
import { parentDirectory } from "./caps/paths.ts";
import type { Proposal } from "./caps/steps.ts";
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
import { BLOCKED_OPTIONS, type Refusal, chooseBlocked, confirmBlocked, emptyBlockedDraft, writeBlocked } from "./refusal.ts";
import { keepNote } from "./keep.ts";
import { type KeepNote, MAX_KEEP_WORDS, type ParkRecord, type WaitNote } from "./shared.ts";
import { isBusy } from "./state.ts";
import { type Line, type Overview, type TodoRow, afterLeaving as leaving, listed } from "./tree.ts";
import { type UndoEntry, undoText } from "./undo.ts";
import { type Verb, insteadOnPage, verbBlocked } from "./verbs.ts";
import { waitNote } from "./waiting.ts";

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
  /** Who or what it waits on, then an optional reminder. */
  | { kind: "wait-on"; threadId: string; value: string; error: string }
  /** `keep` when it was waiting already and its reminder came: who it waits on, and what for, stay. */
  | { kind: "wait-remind"; threadId: string; on: string; needed: string | null; keep: boolean; value: string; error: string }
  /** Its reminder came: keep waiting, or it is back with the person. */
  | { kind: "wait-due"; threadId: string; note: WaitNote }
  /** Keeping it: a few words of the person's, or none. */
  | { kind: "keep-words"; threadId: string; value: string; error: string }
  | ({ kind: "answer" } & AnswerState)
  | ({ kind: "ask" } & AskState)
  | ({ kind: "blocked" } & BlockedState);

export interface VerbHost {
  sdk: Sdk;
  overview: Overview;
  main: Line;
  selected: Line | null;
  parks: Parks;
  /** Open asks and briefs, and the calls that answer and read them. */
  raised: RaisedData;
  /** Open a thread's brief over the page. */
  openBrief: (threadId: string) => void;
  /** Capabilities: bb's permission requests are answered through here, so cow knows which decisions were made on its page. */
  caps: CapsData;
  /** For each refusal of a thread, the name of the capability that would cover it when asked again, or null. */
  coverage: (threadId: string, refusals: readonly Refusal[]) => (string | null)[];
  /** Send a thread a message as the person: a signed call, so only an enrolled page can. */
  sendAs: (threadId: string, text: string) => Promise<void>;
  /** Start the steps that make a capability. */
  startCap: (origin: StepsOrigin, proposal: Proposal | null) => void;
  now: number;
  /** The groups folded in this window: the cursor skips their members. */
  folded: ReadonlySet<string>;
  /** The unarchived threads under a thread, which bb archives along with it. */
  under: (id: string) => string[];
  setCursor: (id: string | null) => void;
  /** Put the cursor on a line that is about to move, and unfold what holds it once it has: undo's cursor. */
  follow: (id: string) => void;
  say: (message: string) => void;
  openChat: (id: string) => void;
  focusOverview: () => void;
  /** Keep a line the person marked seen in its place on this page; `false` lets it go where its state puts it. */
  stay: (id: string, stays: boolean) => void;
}

export interface Verbs {
  /** The mode shown at the left of the status line, or null in normal mode. */
  mode: string | null;
  start: (verb: Verb) => void;
  /** Open the ask card for one ask, wherever its thread's line is. */
  startAsk: (threadId: string, askId: string) => void;
  startUndo: () => void;
  /** Mark the line's reply as seen. Quietly when the person opened or answered it; `u` takes back only a marking they asked for. */
  markSeen: (line: Line, asked: boolean) => void;
  /** Mark the line as a project, or take the mark off. `u` takes it back. */
  toggleProject: (line: Line) => void;
  /** Say the line waits on someone other than the person, or on a waiting line, offer to clear it. `u` takes it back. */
  startWait: (line: Line | null) => void;
  /** Ask, then take a not-started item off its list. */
  removeTodo: (row: TodoRow) => void;
  moveTodo: (row: TodoRow, by: 1 | -1) => void;
  /** The newest thing `u` would take back. */
  undoable: UndoEntry | null;
  /** While a prompt is open it takes every key; null when none is. */
  onKey: ((key: string) => void) | null;
  /** The status line's content while a prompt is open. */
  footer: ReactNode | null;
  /** The question card, and the thread whose line it belongs under; `askId` when it answers one ask alone. */
  card: { threadId: string; askId?: string; node: ReactNode } | null;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function useVerbs(host: VerbHost): Verbs {
  const { sdk, overview, main, parks, setCursor, say, focusOverview } = host;
  const [modal, setModal] = useState<Modal | null>(null);
  const [undo, setUndo] = useState<readonly UndoEntry[]>([]);
  const promptRef = useRef<HTMLInputElement | null>(null);
  const answerRef = useRef<HTMLInputElement | null>(null);
  const blockedRef = useRef<HTMLTextAreaElement | null>(null);
  const askWordRef = useRef<HTMLInputElement | null>(null);

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
    modal?.kind === "park-reason" || modal?.kind === "park-pickup" || modal?.kind === "archive-reason" || modal?.kind === "wait-on" || modal?.kind === "wait-remind" || modal?.kind === "keep-words"
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

  // An ask with nothing to choose from goes straight to its text field, and
  // a high-risk answer to the field for its word.
  const openAsks = modal?.kind === "ask" ? (host.raised.asks.get(modal.threadId) ?? []) : [];
  const currentAsk = modal?.kind === "ask" ? (openAsks.find((ask) => ask.id === modal.askId) ?? null) : null;
  // The person has messaged the thread since it asked: the ask may be answered in chat already.
  const askMessaged = modal?.kind === "ask" && currentAsk !== null && (lineOf(modal.threadId)?.derived.asksMessaged?.includes(currentAsk.id) ?? false);
  // With that choice on the card, a digit has to reach it: the field waits for its own digit.
  const askFocus = modal?.kind !== "ask" || currentAsk === null ? null : modal.draft.stage === "word" ? "word" : modal.draft.stage === "choose" && currentAsk.options.length === 0 && !askMessaged ? "text" : "none";
  const askKey = modal?.kind === "ask" ? modal.askId : null;
  useEffect(() => {
    if (askFocus === "word") askWordRef.current?.focus();
    else if (askFocus === "text") answerRef.current?.focus();
    else if (askFocus === "none") focusOverview();
  }, [askFocus, askKey, focusOverview]);

  // An ask that was withdrawn, or answered somewhere else, leaves the card:
  // the next one takes its place, or the card closes.
  const askGone = modal?.kind === "ask" && !modal.sending && currentAsk === null;
  useEffect(() => {
    if (!askGone || modal?.kind !== "ask") return;
    const next = modal.single ? null : (openAsks[0] ?? null);
    if (next) setModal({ ...modal, askId: next.id, draft: emptyAskDraft, note: "that ask is no longer open; this is the next one" });
    else close(modal.sent.length > 0 ? modal.sent[modal.sent.length - 1] : "that ask is no longer open: it was withdrawn or answered");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askGone]);

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
    // Parking a kept line takes it off Kept: undo puts it back.
    const kept = line.derived.keep?.note ?? null;
    // Kept parked, the line stays on the shelf; newly parked, it leaves the tree.
    const next = before === null ? afterLeaving(id) : id;
    try {
      if (stopFirst) await sdk.threads.stop({ threadId: id });
      await parks.set(id, record);
      host.stay(id, false);
      remember({ kind: "park", threadId: id, title: line.thread.title, before, kept });
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
      host.stay(id, false);
      remember({ kind: "archive", threadId: id, title: line.thread.title, dropped, under, reason });
      setCursor(next);
      close(`${dropped ? "dropped: stopped and archived" : "archived"}${reason === null ? "" : `: ${reason}`}`);
    } catch (cause) {
      close(`not archived: ${errorText(cause)}`);
    }
  };

  const takeBack = async (entry: UndoEntry) => {
    try {
      if (entry.kind === "park") {
        await parks.set(entry.threadId, entry.before);
        if (entry.kept) await parks.setKeep(entry.threadId, entry.kept);
      } else if (entry.kind === "keep") {
        await parks.setKeep(entry.threadId, entry.before);
        // Keeping took it off Parked; taking the keep back puts it there again.
        if (entry.before === null && entry.parked) await parks.set(entry.threadId, entry.parked);
      } else if (entry.kind === "resume") await parks.set(entry.threadId, entry.record);
      else if (entry.kind === "dismiss") await parks.setDismissal(entry.threadId, entry.before);
      else if (entry.kind === "seen") await parks.setSeen(entry.threadId, entry.before);
      else if (entry.kind === "project") await parks.setProject(entry.threadId, entry.before);
      else if (entry.kind === "wait") await parks.setWait(entry.threadId, entry.before);
      else {
        for (const threadId of [entry.threadId, ...entry.under]) await sdk.threads.unarchive({ threadId });
      }
      setUndo((entries) => entries.filter((other) => other !== entry));
      // Where the line was is not where it goes: what to unfold is decided once it is there.
      host.follow(entry.threadId);
      close("undone");
    } catch (cause) {
      close(`not undone: ${errorText(cause)}`);
    }
  };

  const markSeen = (line: Line, asked: boolean) => {
    // A reply waiting on the person, or the unseen reply of a line to settle.
    const reply = line.derived.reply ?? line.derived.unseen;
    const id = line.thread.id;
    if (!reply) {
      if (asked) say(line.derived.waitingOnYou ? "it waits on more than a reply: Space only marks a reply as seen" : "it has no reply waiting on you");
      return;
    }
    const before = parks.seen.get(id) ?? null;
    parks.setSeen(id, { seq: reply.seq, at: clockNow() }).then(
      () => {
        // Seen, a line that waited on the person stays where it is on this
        // page, whatever its state now says. One already to settle is in its place.
        if (line.derived.reply) host.stay(id, true);
        if (!asked) return;
        remember({ kind: "seen", threadId: id, title: line.thread.title, before });
        say("marked as seen: u takes it back");
      },
      // Opening its chat tried to mark it, without being asked to: said as what is still true of the line.
      (cause: unknown) => say(asked ? `not marked as seen: ${errorText(cause)}` : `its reply still waits on you: ${errorText(cause)}`),
    );
  };

  const toggleProject = (line: Line) => {
    const id = line.thread.id;
    if (id === main.thread.id) return say("Main is a project already, and always");
    if (line.thread.archivedAt !== null) return say("it is archived: a project is marked while it is open · u takes back an archive made on this page");
    const before = parks.projects.get(id) ?? null;
    const project = before === null ? { at: clockNow(), by: null } : null;
    parks.setProject(id, project).then(
      () => {
        remember({ kind: "project", threadId: id, title: line.thread.title, before });
        say(
          project
            ? "marked as a project: it is never done, and idle when quiet · u takes it back"
            : line.project === "head" || line.members > 0
              ? "unmarked, but it has threads under it, so it is a project still · u takes it back"
              : "no longer marked as a project · u takes it back",
        );
      },
      (cause: unknown) => say(`not changed: ${errorText(cause)}`),
    );
  };

  const setWait = (line: Line, note: WaitNote | null, said: string) => {
    const id = line.thread.id;
    const before = parks.waits.get(id) ?? null;
    parks.setWait(id, note).then(
      () => {
        remember({ kind: "wait", threadId: id, title: line.thread.title, before });
        close(`${said} · u takes it back`);
      },
      (cause: unknown) => close(`not changed: ${errorText(cause)}`),
    );
  };

  const startWait = (line: Line | null) => {
    if (line === null) return say("select a line first");
    const id = line.thread.id;
    if (line.thread.archivedAt !== null) return say("it is archived, so it waits on nobody");
    if (line.derived.state === "parked") return say("it is parked: r resumes it first");
    if (line.derived.state === "kept") return say("it is kept, and reminds you of nothing: z takes it off Kept first");
    say("");
    const wait = line.derived.wait;
    if (wait) {
      return setModal({
        kind: "confirm",
        mode: "WAIT",
        threadId: id,
        label: `it is no longer waiting on ${wait.note.on}: it reads as it did before?`,
        cancelled: `still waiting on ${wait.note.on}`,
        run: () => setWait(line, null, `no longer waiting on ${wait.note.on}`),
      });
    }
    setModal({ kind: "wait-on", threadId: id, value: "", error: "" });
  };

  /** Keep it with this note, or with null take it off Kept. Either way it leaves its place. */
  const keep = (line: Line, note: KeepNote | null) => {
    const id = line.thread.id;
    const before = line.derived.keep?.note ?? null;
    const parked = note !== null ? (line.derived.park?.record ?? null) : null;
    const next = afterLeaving(id);
    parks.setKeep(id, note).then(
      () => {
        host.stay(id, false);
        remember({ kind: "keep", threadId: id, title: line.thread.title, before, parked });
        setCursor(next);
        close(note === null ? "off Kept: it reads as any other line · u takes it back" : "kept: it asks for nothing, and comes off Kept when it starts a turn · u takes it back");
      },
      (cause: unknown) => close(`${note === null ? "still kept" : "not kept"}: ${errorText(cause)}`),
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
      save: false,
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

  /** What a capability made from a request would start as: the command itself, or the directory of the file. */
  const proposalFor = (kind: "command" | "file_change", what: string | null): Proposal | null => {
    if (what === null) return null;
    if (kind === "command") return { kind: "command", text: what };
    const dir = parentDirectory(what);
    return dir === null ? null : { kind: "dir", text: dir };
  };

  const confirmPermissionAnswer = (state: Extract<Modal, { kind: "answer" }>, ask: PermissionAsk) => {
    const { threadId } = state;
    if (state.save) {
      const proposal = ask.subject.kind === "command" ? proposalFor("command", ask.subject.command) : proposalFor("file_change", state.files?.[0]?.path ?? null);
      if (proposal === null) {
        return setModal({ ...state, note: state.files === null ? "the change is still being read: try again in a moment" : "bb has not said which file, so there is no directory to propose: allow it once here, and make the capability with C" });
      }
      // The request stays open until the capability is saved; then it is allowed once.
      setModal(null);
      return host.startCap({ via: "card", threadId, where: "line", interactionId: ask.id }, proposal);
    }
    const result = confirmPermission(state.permission, ask);
    if (result.kind === "incomplete") return setModal({ ...state, note: result.why });
    if (result.kind === "confirm") return setModal({ ...state, permission: result.draft, note: "" });
    const { resolution, message } = result;
    const failed = (what: string) => (cause: unknown) =>
      setModal((current) =>
        current?.kind === "answer" ? { ...current, sending: false, note: `${what}: ${errorText(cause)}` } : current,
      );
    setModal({ ...state, sending: true, note: "" });
    host.caps.decide(threadId, ask.id, resolution).then(() => {
      if (resolution.decision !== "deny") {
        return close(
          resolution.decision === "allow_once"
            ? "allowed once: it carries on"
            : "allowed for the rest of its session: it carries on",
        );
      }
      if (message === null) return close("denied: it was told no");
      // bb's denial carries no text, so the reason follows as a message.
      host
        .sendAs(threadId, message)
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

  const startAsk = (threadId: string, askId: string, single = true) => {
    say("");
    setModal({ kind: "ask", threadId, askId, draft: emptyAskDraft, sending: false, note: "", sent: [], single });
  };

  const confirmAskAnswer = () => {
    if (modal?.kind !== "ask" || modal.sending || currentAsk === null) return;
    // Granting a capability a thread asked for is not an answer in one key: it goes through the steps, and they answer the ask.
    if (currentAsk.capability && modal.draft.option === 1 && !modal.draft.chat) {
      const { capability } = currentAsk;
      setModal(null);
      return host.startCap({ via: "ask", threadId: modal.threadId, where: "line", askId: currentAsk.id }, { kind: capability.kind, text: capability.rule });
    }
    const step = confirmAsk(modal.draft, currentAsk);
    if (step.kind === "incomplete") return setModal({ ...modal, note: step.why });
    if (step.kind === "stage") return setModal({ ...modal, draft: step.draft, note: "" });
    const title = lineOf(modal.threadId)?.thread.title ?? "the thread";
    const left = openAsks.filter((ask) => ask.id !== currentAsk.id);
    setModal({ ...modal, sending: true, note: "" });
    // Closing as answered in chat records it and sends the thread nothing.
    const sent = step.kind === "close" ? host.raised.close(currentAsk.id) : host.raised.answer(currentAsk.id, step.option, step.text);
    sent.then(
      () => {
        const line = step.kind === "close" ? `closed as answered in chat: nothing was sent to “${title}” · it cannot be undone` : `sent to “${title}”: ${step.said} · it cannot be undone`;
        const next = modal.single ? null : (left[0] ?? null);
        if (next === null) return close(line);
        setModal({ ...modal, askId: next.id, draft: emptyAskDraft, sending: false, note: "", sent: [...modal.sent, line] });
      },
      (cause: unknown) =>
        setModal((current) => (current?.kind === "ask" ? { ...current, sending: false, note: `not sent: ${errorText(cause)}` } : current)),
    );
  };

  const confirmBlockedChoice = () => {
    if (modal?.kind !== "blocked" || modal.sending) return;
    const { threadId, refusals } = modal;
    if (modal.save) {
      // The first refusal nothing covers yet is the one to make a capability from.
      const covered = host.coverage(threadId, refusals);
      const refusal = refusals.find((_, index) => covered[index] === null) ?? refusals[0];
      const proposal = refusal ? proposalFor(refusal.kind, refusal.what) : null;
      if (proposal === null) return setModal({ ...modal, note: "there is no directory to propose for that file: make the capability with C" });
      setModal(null);
      return host.startCap({ via: "blocked", threadId, where: "line" }, proposal);
    }
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
    host
      .sendAs(threadId, result.text)
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
    if (line === null || blocked !== null) {
      const instead = insteadOnPage(blocked ?? "");
      return say(`cannot ${verb}: ${blocked}${instead ? ` · ${instead}` : ""}`);
    }
    const threadId = line.thread.id;
    const returned = line.derived.park?.due != null;
    say("");
    switch (verb) {
      case "brief":
        return host.openBrief(threadId);
      case "answer": {
        // A reminder that came: it is still waiting, or it is back with the person.
        if (line.derived.wait?.due) return setModal({ kind: "wait-due", threadId, note: line.derived.wait.note });
        // A request of bb's own comes first: it holds a turn. Then the thread's asks, oldest first.
        const oldest = line.derived.asks?.[0];
        if (!line.thread.hasPendingInteraction && oldest) return startAsk(threadId, oldest.id, false);
        // A refusal has no request to answer.
        const refusals = line.derived.blocked?.refusals;
        if (line.thread.hasPendingInteraction || !refusals) return openAnswer(line);
        return setModal({
          kind: "blocked",
          threadId,
          refusals,
          // Covered by a capability: asking again is marked, so a and Enter are all it takes.
          draft: emptyBlockedDraft(refusals, host.coverage(threadId, refusals).every((name) => name !== null)),
          save: false,
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
      case "keep":
        // On a kept line z takes it off the shelf at once: u takes that back.
        if (line.derived.state === "kept") return keep(line, null);
        return setModal({ kind: "keep-words", threadId, value: "", error: "" });
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
    if (undoable === null) return say("nothing to undo: only the last park, resume, archive, dismissal, mark as seen, project mark, wait or keep can be taken back");
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

  const common = { start, startAsk, startUndo, markSeen, toggleProject, startWait, removeTodo, moveTodo, undoable };
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
          // The digit after bb's own choices: allow once, and save as a capability.
          if (Number(key) === request.options.length + 1 && request.options.some((option) => option.action === "allow_once")) {
            setModal({ ...modal, permission: emptyPermissionDraft, save: true, note: "" });
            return focusOverview();
          }
          const permission = choosePermission(modal.permission, request, Number(key));
          setModal({ ...modal, permission, save: permission.chosen === null ? modal.save : false, note: "" });
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

  if (modal.kind === "ask") {
    const back = () => {
      if (modal.sending) return;
      const draft = backOut(modal.draft);
      if (draft) return setModal({ ...modal, draft, note: "" });
      close(modal.sent.length > 0 ? modal.sent[modal.sent.length - 1] : "not answered: the ask is still open");
    };
    return {
      mode: "ASK",
      ...common,
      onKey: (key) => {
        if (key === "Escape") return back();
        if (key === "Enter") return confirmAskAnswer();
        if (modal.sending || currentAsk === null || modal.draft.stage !== "choose") return;
        if (key === "Tab") {
          const next = modal.single ? null : nextAsk(openAsks, currentAsk.id);
          if (next) setModal({ ...modal, askId: next.id, draft: emptyAskDraft, note: "" });
          return;
        }
        if (!/^[1-9]$/.test(key)) return;
        const number = Number(key);
        if (askMessaged && number === chatDigit(currentAsk)) return setModal({ ...modal, draft: markChat(modal.draft), note: "" });
        if (!currentAsk.optionsOnly && number === currentAsk.options.length + 1) return answerRef.current?.focus();
        setModal({ ...modal, draft: markOption(modal.draft, currentAsk, number), note: "" });
      },
      footer: (
        <>
          <span className="cow-mode cow-m-prompt">ASK</span>
          <span className="cow-noun">{title}</span>
          <span className="cow-sep">▸</span>
          <span>{openAsks.length > 1 && !modal.single ? `its ${openAsks.length} asks are open under its line, one at a time` : "its ask is open under its line"}</span>
        </>
      ),
      card: {
        threadId: modal.threadId,
        ...(modal.single ? { askId: modal.askId } : {}),
        node: (
          <AskCard
            state={modal}
            asks={openAsks}
            title={title}
            now={host.now}
            messaged={askMessaged}
            textRef={answerRef}
            wordRef={askWordRef}
            onText={(value) => setModal({ ...modal, draft: writeAnswer(modal.draft, value), note: "" })}
            onWord={(value) => setModal({ ...modal, draft: writeWord(modal.draft, value), note: "" })}
            onConfirm={confirmAskAnswer}
            onBack={() => {
              // Escape in the answer field leaves the field; in the word field it goes back a step.
              if (modal.draft.stage === "choose" && currentAsk !== null && currentAsk.options.length > 0) return focusOverview();
              back();
            }}
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
        if (!/^[1-9]$/.test(key)) return;
        // The digit after the three choices: save a capability that covers this.
        if (Number(key) === BLOCKED_OPTIONS.length + 1) return setModal({ ...modal, draft: { ...modal.draft, chosen: null }, save: true, note: "" });
        setModal({ ...modal, draft: chooseBlocked(modal.draft, Number(key)), save: false, note: "" });
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
            covered={host.coverage(modal.threadId, modal.refusals)}
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

  if (modal.kind === "wait-due") {
    const { note } = modal;
    return {
      mode: "WAIT",
      ...common,
      onKey: (key) => {
        if (key === "1") return setModal({ kind: "wait-remind", threadId: modal.threadId, on: note.on, needed: note.for, keep: true, value: "", error: "" });
        if (key === "2" && target) return setWait(target, null, `back with you: no longer waiting on ${note.on}`);
        close(`still waiting on ${note.on}; it stays in your queue`);
      },
      footer: (
        <>
          <span className="cow-mode cow-m-prompt">WAIT</span>
          <span className="cow-noun">{title}</span>
          <span className="cow-sep">▸</span>
          <span className="cow-prompt" data-cow-wait-due="">
            <label>still waiting on {note.on}:</label>
            <small>
              <kbd>1</kbd> keep waiting, with a new reminder · <kbd>2</kbd> it is back with me · any other key cancels
            </small>
          </span>
        </>
      ),
      card: null,
    };
  }
  if (modal.kind === "wait-on" || modal.kind === "wait-remind") {
    const asksOn = modal.kind === "wait-on";
    const submitWait = () => {
      if (target === null) return;
      if (modal.kind === "wait-on") {
        const value = modal.value.trim();
        if (value === "") return setModal({ ...modal, error: "who or what is it waiting on?" });
        const checked = waitNote({ on: value, for: null, remind: "" }, clockNow(), null);
        if (!checked.ok) return setModal({ ...modal, error: checked.error });
        return setModal({ kind: "wait-remind", threadId: modal.threadId, on: checked.note.on, needed: null, keep: false, value: "", error: "" });
      }
      const checked = waitNote({ on: modal.on, for: modal.needed, remind: modal.value }, clockNow(), null);
      if (!checked.ok) return setModal({ ...modal, error: checked.error });
      setWait(target, checked.note, `waiting on ${checked.note.on}${checked.note.remindAt === null ? "" : `: it comes back to you on the day`}`);
    };
    return {
      mode: "WAIT",
      ...common,
      onKey: () => promptRef.current?.focus(),
      footer: (
        <TextPrompt
          key={modal.kind}
          mode="WAIT"
          name={modal.kind}
          label={
            <>
              {modal.kind === "wait-remind" && modal.keep ? "keep waiting" : "waiting"} · <b>{title}</b> · {asksOn ? "on whom or what:" : `on ${modal.on} · remind me:`}
            </>
          }
          placeholder={asksOn ? "the reviewer, CI, someone outside the team" : "19 Nov, +3d, +2w, or nothing for no reminder"}
          value={modal.value}
          error={modal.error}
          go={asksOn ? "next" : "set it; u takes it back"}
          inputRef={promptRef}
          onChange={(value) => setModal({ ...modal, value, error: "" })}
          onSubmit={submitWait}
          onCancel={() => close(modal.kind === "wait-remind" && modal.keep ? "still waiting; it stays in your queue" : "not changed")}
        />
      ),
      card: null,
    };
  }
  if (modal.kind === "keep-words") {
    const submitKeep = () => {
      if (target === null) return;
      const checked = keepNote(modal.value, clockNow());
      if (!checked.ok) return setModal({ ...modal, error: checked.error });
      keep(target, checked.note);
    };
    return {
      mode: "KEEP",
      ...common,
      onKey: () => promptRef.current?.focus(),
      footer: (
        <TextPrompt
          mode="KEEP"
          name="keep-words"
          label={
            <>
              keep · <b>{title}</b> · a few words, if you like:
            </>
          }
          placeholder={`nothing is needed; under ${MAX_KEEP_WORDS} characters`}
          value={modal.value}
          error={modal.error}
          go="keep it, with no reminder; u takes it back"
          inputRef={promptRef}
          onChange={(value) => setModal({ ...modal, value, error: "" })}
          onSubmit={submitKeep}
          onCancel={() => close("not kept")}
        />
      ),
      card: null,
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
