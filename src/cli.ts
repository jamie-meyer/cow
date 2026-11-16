// `bb cow …`: the page's verbs for an agent. Under cow the Main thread is an
// agent that cleans up after the threads it started; these commands let it
// leave the same notes the page does, under the same rules.

import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { type Actions, CowError, MAX_REASON } from "./actions.ts";
import { pickUpText } from "./park.ts";
import { LIMITS } from "./state.ts";
import { statusText } from "./status.ts";

/** The part of the actions the CLI uses; tests stand in for it. */
export type CliActions = Pick<Actions, "archiveChecked" | "parkChecked" | "resumeChecked" | "status">;

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

export function cowCli(actions: CliActions) {
  return defineCli({
    name: "cow",
    summary: "🐄 cow's notes on threads: park, resume, archive with a reason, and the overview",
    commands: {
      status: cliCommand({
        summary: "The overview: every thread under Main with its state, the queue, and the parked shelf",
        description:
          "One line per thread: state, time in state, what it is doing or waiting on. At most 80 open threads, " +
          "30 parked, 20 done and 20 queue entries are listed; the rest are counted.",
        options: {
          main: {
            type: "string",
            description: "The Main thread's id. Default: the Main last chosen for this project on cow's page",
          },
          json,
        },
        async run(input, ctx) {
          const main = input.options.main === undefined ? null : threadId(input.options.main);
          const report = await acting(() => actions.status(main, ctx.projectId ?? null));
          return input.options.json
            ? { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...report })}\n` }
            : { exitCode: 0, stdout: statusText(report) };
        },
      }),
      archive: cliCommand({
        summary: "Archive a done or failed thread, recording why",
        description:
          "Archives the thread in bb, and the threads under it with it. Refused while it is not done or failed, " +
          "or while threads under it are still open. The reason shows on cow's page under Done.",
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
        async run(input) {
          const id = threadId(input.positionals.thread);
          const reason = reasonText(input.options.reason, true) ?? "";
          const done = await acting(() =>
            actions.parkChecked({ threadId: id, reason, pickUp: input.options.pickup ?? "", stop: input.options.stop }),
          );
          return print(
            input.options.json,
            { threadId: id, title: done.title, park: done.record },
            `${done.kept ? "kept parked" : "parked"} “${done.title}” (${id}): ${reason} · ${pickUpText(done.record, done.record.checkedAt, LIMITS.parkCheckMs)}`,
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
    },
  });
}
