// `bb cow …`: the page's verbs for an agent. Under cow the Main thread is an
// agent that cleans up after the threads it started; these commands let it
// leave the same notes the page does, under the same rules.

import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { type Actions, CowError, MAX_REASON } from "./actions.ts";
import { type Attention, attend, attentionCommands, elsewhereText } from "./raised-cli.ts";
import { pickUpText } from "./park.ts";
import { formatDay } from "./pickup.ts";
import { MAX_NEXT, MAX_TODOS, MAX_WAIT_FOR, MAX_WAIT_ON, type TodoItem } from "./shared.ts";
import { LIMITS } from "./state.ts";
import { statusText, withCapabilities } from "./status.ts";

/** The part of the actions the CLI uses; tests stand in for it. */
export type CliActions = Pick<Actions, "archiveChecked" | "parkChecked" | "resumeChecked" | "status" | "nextChecked" | "todoChecked" | "projectChecked" | "waitChecked">;

const thread = { name: "thread", description: "The thread's id, such as thr_abc123", required: true } as const;
const json = { type: "boolean", description: "Print machine-readable JSON" } as const;

function threadId(value: string): string {
  const id = value.trim().replace(/^@?thread:/, "");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new PluginCliError(`"${value}" is not a thread id`, {
      code: "bad_thread",
      hint: "Thread ids look like thr_abc123; `bb thread list` shows them.",
    });
  }
  return id;
}

function reasonText(value: string, required: boolean): string | null {
  const reason = value.trim().replace(/\s+/g, " ");
  if (reason === "") {
    if (!required) return null;
    throw new PluginCliError("a reason is needed: why is it set aside?", { code: "reason_required" });
  }
  if (reason.length > MAX_REASON) {
    throw new PluginCliError(`keep the reason under ${MAX_REASON} characters`, { code: "reason_too_long" });
  }
  return reason;
}

/** Run an action, turning a refusal into the CLI's kind of error. */
async function acting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof CowError) throw new PluginCliError(cause.message, { code: cause.code, hint: cause.hint });
    throw cause;
  }
}

const print = (asJson: boolean, data: object, text: string) => ({
  exitCode: 0,
  stdout: asJson ? `${JSON.stringify({ ok: true, ...data })}\n` : `${text}\n`,
});

const todoLines = (list: readonly TodoItem[]): string =>
  list.length === 0 ? "    nothing listed" : list.map((item, index) => `${String(index + 1).padStart(3)}  ${item.title}`).join("\n");

function itemNumber(value: string): number {
  if (!/^[1-9][0-9]{0,2}$/.test(value.trim())) {
    throw new PluginCliError(`"${value}" is not an item number`, { code: "bad_number", hint: "`bb cow todo list <thread>` numbers the items from 1." });
  }
  return Number(value.trim());
}

/** The plan commands: what a thread says is next for it, and what it has not started. */
function planCommands(actions: CliActions) {
  const item = { name: "n", description: "The item's number, as `todo list` shows it", required: true } as const;
  const taking = (word: string, summary: string) =>
    cliCommand({
      summary,
      positionals: [thread, item],
      options: { json },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const n = itemNumber(input.positionals.n);
        const done = await acting(() => actions.todoChecked({ callerId: ctx.threadId ?? null, threadId: id, op: { kind: "take", n } }));
        return print(
          input.options.json,
          { threadId: id, title: done.title, item: done.item, todo: done.list },
          `${word} “${done.item?.title ?? ""}” for “${done.title}” (${id}); ${done.list.length} left`,
        );
      },
    });
  return {
    next: cliCommand({
      summary: "Say in one line what happens next for a thread, in your own words",
      description:
        "Shows on the thread's line on cow's page, in the next-move column, marked as the thread's own words. " +
        "Set it whenever you end a turn with work still planned; clear it when nothing is. A thread sets it " +
        "only for itself and for the threads under it.",
      positionals: [thread, { name: "text", description: `What happens next, up to ${MAX_NEXT} characters` }],
      options: { clear: { type: "boolean", description: "Remove the note" }, json },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const text = input.positionals.text;
        if (input.options.clear === (text !== undefined)) {
          throw new PluginCliError("give the text, or --clear, not both and not neither", { code: "bad_next" });
        }
        const done = await acting(() => actions.nextChecked({ callerId: ctx.threadId ?? null, threadId: id, text: text ?? null }));
        return print(
          input.options.json,
          { threadId: id, title: done.title, next: done.note?.text ?? null },
          done.note ? `next for “${done.title}” (${id}): ${done.note.text}` : `cleared what is next for “${done.title}” (${id})`,
        );
      },
    }),
    wait: cliCommand({
      summary: "Say a thread is waiting on someone other than the user: a reviewer, CI, someone outside the team",
      description:
        "The line on cow's page reads waiting, with who or what it waits on and for how long, and it stays out of the user's " +
        "queue. Set it when you end a turn and the next move belongs to someone who is not the user, instead of writing that " +
        "in a next note. It clears by itself when the thread starts a new turn, so set it again if it is still waiting then. " +
        "With --remind, the line comes back to the user's queue on that day. A thread sets it only for itself and for the " +
        "threads under it. --clear removes it.",
      positionals: [thread],
      options: {
        on: { type: "string", description: `Who or what it waits on, up to ${MAX_WAIT_ON} characters: "the reviewer", "CI"` },
        for: { type: "string", description: `What is needed from them, up to ${MAX_WAIT_FOR} characters` },
        remind: { type: "string", description: "Put it in front of the user on this day if it is still waiting: 19 Nov, 2027-11-19, +3d or +2w" },
        clear: { type: "boolean", description: "It is no longer waiting" },
        json,
      },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const { on, clear } = input.options;
        if (clear === (on !== undefined)) {
          throw new PluginCliError("give --on, or --clear, not both and not neither", { code: "bad_wait", hint: 'bb cow wait <thread> --on "the reviewer" [--for "<what>"] [--remind +3d]' });
        }
        if (clear && (input.options.for !== undefined || input.options.remind !== undefined)) {
          throw new PluginCliError("--clear takes no --for or --remind", { code: "bad_wait" });
        }
        const done = await acting(() =>
          actions.waitChecked({
            callerId: ctx.threadId ?? null,
            threadId: id,
            wait: clear ? null : { on: on ?? "", for: input.options.for ?? null, remind: input.options.remind ?? "" },
          }),
        );
        const wait = done.wait;
        return print(
          input.options.json,
          { threadId: id, title: done.title, wait },
          wait
            ? `“${done.title}” (${id}) is waiting on ${wait.on}${wait.for ? `: ${wait.for}` : ""}${wait.remindAt === null ? "" : ` · the user is reminded ${formatDay(wait.remindAt, wait.at)}`} · it clears when the thread starts a new turn`
            : `“${done.title}” (${id}) is no longer waiting on anyone`,
        );
      },
    }),
    project: cliCommand({
      summary: "Mark a thread as a project: long-lived, and one the user talks to",
      description:
        "A project is never done on cow's page: when it has nothing to say it reads idle and keeps its place, and its replies are the " +
        "user's to read. Mark a thread you start when the user will talk to it over days. A thread with threads under it, and Main, are " +
        "projects already. A thread marks only itself and the threads under it. --clear takes the mark off.",
      positionals: [thread],
      options: { clear: { type: "boolean", description: "Take the mark off" }, json },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const done = await acting(() => actions.projectChecked({ callerId: ctx.threadId ?? null, threadId: id, on: input.options.clear !== true }));
        return print(
          input.options.json,
          { threadId: id, title: done.title, project: done.project !== null },
          done.project ? `“${done.title}” (${id}) is marked as a project: it reads idle, never done, until it is archived` : `“${done.title}” (${id}) is no longer marked as a project`,
        );
      },
    }),
    "todo add": cliCommand({
      summary: "List a piece of work a thread has not started yet",
      description:
        `Adds it to the end of the thread's list, which shows inside its group on cow's page. Keep the list to the next few items: it holds ${MAX_TODOS}. ` +
        "A thread lists work only for itself and for the threads under it.",
      positionals: [thread, { name: "title", description: "The work, in a few words", required: true }],
      options: { json },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const done = await acting(() =>
          actions.todoChecked({ callerId: ctx.threadId ?? null, threadId: id, op: { kind: "add", title: input.positionals.title } }),
        );
        return print(
          input.options.json,
          { threadId: id, title: done.title, item: done.item, todo: done.list },
          `listed for “${done.title}” (${id}), as item ${done.list.length}: ${done.item?.title ?? ""}`,
        );
      },
    }),
    "todo done": taking("started, and off the list:", "Take an item off the list because its work has started or is finished"),
    "todo rm": taking("removed", "Take an item off the list because it will not be done"),
    "todo list": cliCommand({
      summary: "The work a thread has listed as not started, numbered",
      positionals: [thread],
      options: { json },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const done = await acting(() => actions.todoChecked({ callerId: ctx.threadId ?? null, threadId: id, op: null }));
        return print(input.options.json, { threadId: id, title: done.title, todo: done.list }, `Not started for “${done.title}” (${id})\n${todoLines(done.list)}`);
      },
    }),
  };
}

export function cowCli<Extra extends Record<string, ReturnType<typeof cliCommand>> = Record<never, never>>(
  actions: CliActions,
  attention?: Attention,
  extra?: Extra,
  /** For each of these threads that holds any capability, their names. */
  capabilityNames?: (threadIds: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>,
  /** The command's name: `bb cow …`. A copy installed under another id answers to that id. */
  name = "cow",
) {
  return defineCli({
    name,
    summary: "🐄 cow's notes on threads: park, resume, archive with a reason, what is next, who it waits on, and the overview",
    commands: {
      ...planCommands(actions),
      status: cliCommand({
        summary: "The overview: every thread under Main with its state, the queue, the parked shelf, what is to settle, what is kept, and the open threads outside Main",
        description:
          "One line per thread: state, time in state, what it is doing or waiting on. At most 80 open threads, " +
          "30 parked, 40 to settle, 30 kept, 20 archived, 40 outside Main and 20 queue entries are listed; the rest are counted. " +
          "Outside Main is every open thread with no parent that is not Main or above it; one a plugin started is only counted. " +
          "To move one under Main, use `bb thread update <thread> --parent-thread <main> --parent-notifications stuck`.",
        options: {
          main: {
            type: "string",
            description: "The Main thread's id. Default: the Main last chosen for this project on cow's page",
          },
          json,
        },
        async run(input, ctx) {
          const main = input.options.main === undefined ? null : threadId(input.options.main);
          const plain = await acting(() => actions.status(main, ctx.projectId ?? null));
          // The asks themselves, and what each brief came to, are added to the overview.
          const attended = attention ? await attend(attention, plain, ctx.projectId ?? null) : null;
          const raisedOrPlain = attended ?? plain;
          const ids = [raisedOrPlain.main, ...raisedOrPlain.threads, ...raisedOrPlain.parked, ...raisedOrPlain.settle, ...raisedOrPlain.kept, ...raisedOrPlain.archived].map((line) => line.id);
          const report = capabilityNames ? withCapabilities(raisedOrPlain, await capabilityNames(ids)) : raisedOrPlain;
          return input.options.json
            ? { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...report })}\n` }
            : { exitCode: 0, stdout: statusText(report) + elsewhereText(attended?.asksElsewhere ?? 0) };
        },
      }),
      archive: cliCommand({
        summary: "Archive a done, idle or failed thread, recording why",
        description:
          "Archives the thread in bb, and the threads under it with it. Refused while it is not done, idle or failed, " +
          "or while threads under it are still open. The reason shows on cow's page under Archived for two days.",
        positionals: [thread],
        options: {
          reason: { type: "string", aliases: ["why"], description: `Why it is archived, up to ${MAX_REASON} characters` },
          json,
        },
        async run(input) {
          const id = threadId(input.positionals.thread);
          const reason = reasonText(input.options.reason ?? "", false);
          const done = await acting(() => actions.archiveChecked(id, reason));
          const with_ = done.under === 0 ? "" : ` with the ${done.under === 1 ? "thread" : `${done.under} threads`} under it`;
          return print(
            input.options.json,
            { threadId: id, title: done.title, reason, archivedUnder: done.under },
            `archived “${done.title}” (${id})${with_}${reason === null ? "" : `: ${reason}`}`,
          );
        },
      }),
      park: cliCommand({
        summary: "Set a thread aside with a reason, and say when to pick it up",
        description:
          "Moves the thread, and the threads under it, to the Parked shelf on cow's page. It comes back to the " +
          "user's queue when the pick-up date arrives, or every 4 weeks without one. The agent is told nothing.",
        positionals: [thread],
        options: {
          reason: {
            type: "string",
            required: true,
            aliases: ["why"],
            description: `Why it is set aside, up to ${MAX_REASON} characters`,
          },
          pickup: {
            type: "string",
            aliases: ["pick-up", "when", "until"],
            description: "A date (19 Nov, 2027-11-19), +3d or +2w, or a condition in words. Default: none",
          },
          stop: { type: "boolean", description: "Stop its turn first when one is running. Stopping cannot be undone" },
          json,
        },
        async run(input, ctx) {
          const id = threadId(input.positionals.thread);
          const reason = reasonText(input.options.reason, true) ?? "";
          const done = await acting(() =>
            actions.parkChecked({ callerId: ctx.threadId ?? null, threadId: id, reason, pickUp: input.options.pickup ?? "", stop: input.options.stop }),
          );
          return print(
            input.options.json,
            { threadId: id, title: done.title, park: done.record, shownToUser: done.traced },
            `${done.kept ? "kept parked" : "parked"} “${done.title}” (${id}): ${reason} · ${pickUpText(done.record, done.record.checkedAt, LIMITS.parkCheckMs)}${done.traced ? "\nit was waiting on the user: they are shown that you parked it, until they acknowledge it" : ""}`,
          );
        },
      }),
      resume: cliCommand({
        summary: "Take a parked thread off the shelf",
        description: "Removes cow's park note. The thread returns to the tree; the agent is told nothing.",
        positionals: [thread],
        options: { json },
        async run(input) {
          const id = threadId(input.positionals.thread);
          const done = await acting(() => actions.resumeChecked(id));
          return print(input.options.json, { threadId: id, title: done.title }, `resumed “${done.title}” (${id}): it is back in the tree`);
        },
      }),
      ...(attention ? attentionCommands(attention) : {}),
      ...(extra ?? {}),
    },
  });
}
