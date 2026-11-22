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
import { GROUPINGS, type Grouping, LABEL_RULE, OUTCOMES, OUTCOME_TEXT, type Outcome, isOutcome, labelOf, ledgerText, whoText } from "./ledger.ts";
import { statusText, withCapabilities, withWatch } from "./status.ts";
import { type Spend, spendText } from "./spend.ts";
import { MONTH_PATTERN, USAGE_GAPS_NOTE, tokensText } from "./usage.ts";
import type { UsageReport } from "./limits-backend.ts";
import type { ForgetDeleted } from "./ledger-backend.ts";
import { usageReportText } from "./limits.ts";
import type { StartedStore } from "./automation-runs.ts";
import { Refusal } from "./kv.ts";

/** The part of the actions the CLI uses; tests stand in for it. */
export type CliActions = Pick<Actions, "archiveChecked" | "parkChecked" | "resumeChecked" | "status" | "nextChecked" | "todoChecked" | "projectChecked" | "waitChecked"> &
  Partial<Pick<Actions, "outcomeChecked" | "ledger" | "labelChecked">> & {
    /** The spend under a Main (the last 30 days, or the month given): the one given, or this project's. */
    spend?: (mainId: string | null, projectId: string | null, month: string | undefined) => Promise<Spend & { priceError: string | null; mainTitle: string | null }>;
    /** The kept usage of threads bb deleted, listed; with true, removed. */
    forgetDeleted?: (remove: boolean) => Promise<ForgetDeleted>;
    /** The usage line's figures and the usage notices waiting, read now. */
    usage?: () => Promise<UsageReport>;
    /** Each worker's caps and stuck-check marks, as the page shows them. */
    watchMarks?: () => Promise<Record<string, { reason: string; mark: string; facts: Record<string, string | number | null> }[]>>;
  };

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

const OUTCOME_LIST = OUTCOMES.map((outcome) => `${outcome} (${OUTCOME_TEXT[outcome]})`).join(", ");

function outcomeOf(value: string): Outcome {
  const outcome = value.trim().toLowerCase();
  if (!isOutcome(outcome)) {
    throw new PluginCliError(`"${value}" is not an outcome`, { code: "bad_outcome", hint: `One of: ${OUTCOME_LIST}.` });
  }
  return outcome;
}

function labelText(value: string): string {
  const parsed = labelOf(value);
  if (!parsed.ok) throw new PluginCliError(parsed.why, { code: "bad_label", hint: `The rule: ${LABEL_RULE}.` });
  return parsed.label;
}

const labelOption = {
  type: "string",
  description: "The kind of job, one short word such as lookup, draft or code-change, for grouping the ledger. Optional",
} as const;

function groupingsOf(value: string | undefined): readonly Grouping[] {
  if (value === undefined) return GROUPINGS;
  const by = value.trim().toLowerCase();
  if (!(GROUPINGS as readonly string[]).includes(by)) {
    throw new PluginCliError(`"${value}" is not a grouping`, { code: "bad_grouping", hint: `--by ${GROUPINGS.join(", --by ")}; without it, all three.` });
  }
  return [by as Grouping];
}

/** `bb cow usage`: what the page's usage line shows, read now. */
function usageCommand(usage: () => Promise<UsageReport>) {
  return cliCommand({
    summary: "The usage line: every usage window of each signed-in provider, and the last 30 days' list-price dollars against the budget",
    description:
      "What cow's page shows on its usage line, read now: each usage window bb reports for every signed-in provider on this machine (its percent and when it resets; " +
      "a provider not signed in, or that reports no windows, is left out), and the last 30 days' list-price dollars of every thread on this bb (today and the 29 days before it). " +
      "With a budget set (the budget30Days setting) it adds the budget. Then the usage notices waiting in the person's queue. " +
      "It only reads: nothing is ever paused or stopped, and only the person acknowledges a notice, on the page.",
    options: { json },
    async run(input) {
      const got = await acting(usage);
      const at = got.at;
      return input.options.json
        ? { exitCode: 0, stdout: `${JSON.stringify({ ok: true, listPrice: true, estimate: true, ...got, windows: got.windows.map((w) => ({ ...w, resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString() })) })}\n` }
        : { exitCode: 0, stdout: `${usageReportText(got, at)}\n` };
    },
  });
}

/** The ledger commands: what a finished worker came to, and the rows and summary. */
function ledgerCommands(actions: CliActions): Record<string, ReturnType<typeof cliCommand>> {
  const { outcomeChecked, ledger, labelChecked, spend, forgetDeleted } = actions;
  if (!outcomeChecked || !ledger) return {};
  return {
    ...(forgetDeleted
      ? {
          "spend forget": cliCommand({
            summary: "Remove the kept usage of threads bb has deleted: without --yes, only says what it would remove",
            description:
              "cow keeps a deleted thread's token counts, so the spend under its Main and the usage line still count what it used. " +
              "This removes them, for every thread bb no longer has: they then drop out of every total. Without --yes it lists them and removes nothing. " +
              "It is the only way they go, apart from the oldest days dropping out of a thread's record after 400 days.",
            options: {
              deleted: { type: "boolean", description: "Every deleted thread's kept usage (required: the only kind there is)" },
              yes: { type: "boolean", description: "Remove them; without it, only list them" },
              json,
            },
            async run(input) {
              if (!input.options.deleted) throw new PluginCliError("say which: --deleted", { code: "bad_forget", hint: "bb cow spend forget --deleted, then again with --yes to remove them" });
              const remove = input.options.yes === true;
              const got = await acting(() => forgetDeleted(remove));
              if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...got })}\n` };
              const n = got.threads.length;
              const all = tokensText(got.threads.reduce((sum, t) => sum + t.tokens, 0));
              const recent = tokensText(got.threads.reduce((sum, t) => sum + t.last30Days, 0));
              if (n === 0) return { exitCode: 0, stdout: "No deleted thread's usage is kept: nothing to remove.\n" };
              const head = remove
                ? `Removed the kept usage of ${n} deleted ${n === 1 ? "thread" : "threads"}: ${all} tokens in all, ${recent} of them in the last 30 days. The totals no longer count ${n === 1 ? "it" : "them"}.`
                : `Would remove the kept usage of ${n} deleted ${n === 1 ? "thread" : "threads"}: ${all} tokens in all, ${recent} of them in the last 30 days. Nothing is removed without --yes.`;
              const lines = got.threads.map((t) => `  ${t.threadId} · ${tokensText(t.tokens)} tokens · ${tokensText(t.last30Days)} in the last 30 days${t.fromLedger ? " · from its ledger row" : ""}`);
              return { exitCode: 0, stdout: `${[head, ...lines].join("\n")}\n` };
            },
          }),
        }
      : {}),
    ...(spend
      ? {
          spend: cliCommand({
            summary: "The last 30 days' tokens and list-price dollars under Main: workers, project threads, Main, and cow's checker runs",
            description:
              "The last 30 days, today and the 29 days before it (or a calendar month with --month YYYY-MM), for every thread under Main, archived or not, split into workers, project threads, Main itself and cow's checker runs " +
              "(every check cow ran in those days, whichever Main's brief it checked), with the total. With --json, `period` says which days: its kind (last30Days or month), first and last day. Tokens are bb's own record of them, by the day it recorded them. " +
              "Dollars are an estimate at the providers' list prices, not a bill: on a subscription you are not billed this. A model with no list price shows tokens and no dollars. " +
              "Threads with no usage recorded are counted and said, never shown as zero. " +
              "A thread bb has deleted is still counted (its tokens were spent) when its saved parent chain reaches Main, and said (`deleted` in --json); `bb cow spend forget --deleted` removes those. " +
              "A kept usage record that could not be read is left as it is, not counted, and said (`unreadable`).",
            options: {
              month: { type: "string", description: "A calendar month, YYYY-MM. Default: the last 30 days" },
              main: { type: "string", description: "The Main thread's id. Default: the Main last chosen for this project on cow's page" },
              json,
            },
            async run(input, ctx) {
              const month = input.options.month?.trim();
              if (month !== undefined && !MONTH_PATTERN.test(month)) throw new PluginCliError(`"${input.options.month}" is not a month`, { code: "bad_month", hint: "--month 2026-11" });
              const main = input.options.main === undefined ? null : threadId(input.options.main);
              const spent = await acting(() => spend(main, ctx.projectId ?? null, month));
              const { mainTitle, priceError, ...data } = spent;
              return input.options.json
                ? { exitCode: 0, stdout: `${JSON.stringify({ ok: true, listPrice: true, estimate: true, ...data, priceError, gaps: USAGE_GAPS_NOTE })}\n` }
                : { exitCode: 0, stdout: `${spendText(data, mainTitle)}${priceError ? `\n${priceError}` : ""}\n` };
            },
          }),
        }
      : {}),
    ...(labelChecked
      ? {
          label: cliCommand({
            summary: "Show, set or clear a worker's label: the kind of job, such as lookup, draft or code-change",
            description:
              `The ledger (\`bb cow ledger --by label\`) groups by it, and by model within it, so you can see whether each kind of job is on the right model. ${LABEL_RULE}. ` +
              "Set it when you dispatch a worker; it can be set before or after the worker is archived. Who may set it is who may set its outcome: " +
              "a thread may for a thread under a parent, and outside Main only Main or the thread itself. A label the person set is never overwritten by a thread.",
            positionals: [thread, { name: "label", description: "The label; without it, the label is shown" }],
            options: { clear: { type: "boolean", description: "Remove the label" }, json },
            async run(input, ctx) {
              const id = threadId(input.positionals.thread);
              const given = input.positionals.label;
              if (input.options.clear && given !== undefined) throw new PluginCliError("give the label, or --clear, not both", { code: "bad_label" });
              const label = input.options.clear ? null : given === undefined ? undefined : labelText(given);
              const done = await acting(() => labelChecked({ callerId: ctx.threadId ?? null, threadId: id, ...(label === undefined ? {} : { label }) }));
              const note = done.label;
              const text =
                label === undefined
                  ? note
                    ? `“${done.title}” (${id}) is labelled ${note.label} · set by ${whoText(note.by)}`
                    : `“${done.title}” (${id}) has no label`
                  : note
                    ? `labelled “${done.title}” (${id}): ${note.label}${done.row ? " · its ledger row says so too" : ""}`
                    : `cleared the label of “${done.title}” (${id})`;
              return print(input.options.json, { threadId: id, title: done.title, label: note?.label ?? null, labelledBy: note?.by ?? null, labelledAt: note?.at ?? null, archived: done.archived, row: done.row }, text);
            },
          }),
        }
      : {}),
    outcome: cliCommand({
      summary: "Say what a finished worker came to: done, partial, redone or dropped",
      description:
        `The outcomes: ${OUTCOME_LIST}. "done" means the work was used as it came back. ` +
        "Works on an open thread and on an archived one, under the same rule as archive; it can be changed later, and each change " +
        "keeps who made it and when. An outcome the person set is never overwritten by a thread. It goes in cow's ledger (`bb cow ledger`).",
      positionals: [thread, { name: "outcome", description: "done, partial, redone or dropped", required: true }],
      options: { ...(labelChecked ? { label: labelOption } : {}), json },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const outcome = outcomeOf(input.positionals.outcome);
        const given = (input.options as { label?: string }).label;
        const label = given === undefined ? undefined : labelText(given);
        const done = await acting(() => outcomeChecked({ callerId: ctx.threadId ?? null, threadId: id, outcome, ...(label === undefined ? {} : { label }) }));
        return print(
          input.options.json,
          { threadId: id, title: done.title, outcome: done.judgement.outcome, judgedBy: done.judgement.by, judgedAt: done.judgement.at, changes: done.changes, archived: done.archived, ...(label === undefined ? {} : { label }) },
          `“${done.title}” (${id}) came to: ${outcome} (${OUTCOME_TEXT[outcome]}) · judged by ${whoText(done.judgement.by)}${done.changes > 0 ? ` · changed ${done.changes}×` : ""}${label === undefined ? "" : ` · labelled ${label}`}${done.archived ? "" : " · it is kept for its ledger row, written when it is archived"}`,
        );
      },
    }),
    ledger: cliCommand({
      summary: "What finished workers came to and what they used: rows, and a summary by model, by dispatching thread and by label, with tokens and list-price dollars",
      description:
        "One row per worker archived through cow: its model and effort, time to its first report, how many times the person and other threads " +
        "steered it before that report, how many turns it ran, its outcome and who judged it. No titles, prompts or message text. " +
        "Groups of fewer than 5 workers are counted, not compared. By label, each label's workers are also grouped by model; rows with no label are under (no label). " +
        "Each group shows its tokens, their dollars at list price, and dollars per done: all its dollars, every outcome, divided by how many came to done. " +
        "Dollars are an estimate at the providers' list prices, not a bill. A row with no usage recorded is counted as unknown, not as zero; a model with no list price shows tokens and no dollars.",
      options: {
        days: { type: "string", description: "How many days back to read. Default: 14" },
        by: { type: "string", description: `Only one grouping: ${GROUPINGS.join(", ")}. Default: all three` },
        json,
      },
      async run(input) {
        const raw = input.options.days ?? "14";
        if (!/^[1-9][0-9]{0,3}$/.test(raw.trim())) throw new PluginCliError(`"${raw}" is not a number of days`, { code: "bad_days", hint: "--days 14" });
        const by = groupingsOf(input.options.by);
        const read = await acting(() => ledger(Number(raw.trim())));
        const cost = (row: { threadId: string }) => read.costs[row.threadId] ?? null;
        return input.options.json
          ? {
              exitCode: 0,
              stdout: `${JSON.stringify({ ok: true, listPrice: true, estimate: true, summary: read.summary, rows: read.rows.map((row) => ({ ...row, listPriceUsd: cost(row) })), priceError: read.priceError })}\n`,
            }
          : { exitCode: 0, stdout: `${ledgerText(read.summary, read.rows, by, cost)}${read.priceError ? `\n${read.priceError}` : ""}\n` };
      },
    }),
  };
}

/** Run an action, turning a refusal into the CLI's kind of error. */
async function acting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof CowError) throw new PluginCliError(cause.message, { code: cause.code, hint: cause.hint });
    if (cause instanceof Refusal) throw new PluginCliError(cause.message, { code: cause.code, ...(cause.hint === undefined ? {} : { hint: cause.hint }) });
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

/**
 * `bb cow automation started`: a script automation says which thread it
 * started, so cow lists that thread under it. Not one of the person's: a
 * script has no key, and it changes only where a thread is listed.
 */
export function automationRunCommands(store: Pick<StartedStore, "record" | "clear">) {
  return {
    "automation started": cliCommand({
      summary: "Say which thread a script automation's run started, so cow lists it under the automation",
      description:
        "A script automation that starts a thread itself (`bb thread spawn … --json`) calls this with the new thread's id. " +
        "cow then lists that thread under the automation on its page and in `bb cow status`, as an agent run's thread, and no longer under Outside Main. " +
        "With --run, it is that run's thread; without, a run of its own at the time it was recorded. A script's process has its automation's id in " +
        "$BB_AUTOMATION_ID and its run's in $BB_AUTOMATION_RUN_ID; cow cannot read them itself, so pass them. " +
        "The record is cow's alone: nothing in bb changes, no thread is re-parented, and a thread under Main stays in the tree. " +
        "Any thread or script on this machine can call it; each record made or cleared is written to cow's log. --clear takes the record away.",
      positionals: [thread],
      options: {
        automation: { type: "string", description: "The automation's id, or its name when only one has it: \"$BB_AUTOMATION_ID\" in its script. Required, except with --clear" },
        run: { type: "string", description: "The run that started the thread: \"$BB_AUTOMATION_RUN_ID\" in its script. Optional" },
        clear: { type: "boolean", description: "Take the record away, for a wrong id: the thread is listed where it was before" },
        json,
      },
      async run(input, ctx) {
        const id = threadId(input.positionals.thread);
        const { automation, clear } = input.options;
        const runId = input.options.run?.trim() || null;
        const usage = 'bb cow automation started <thread> --automation "$BB_AUTOMATION_ID" [--run "$BB_AUTOMATION_RUN_ID"]';
        if (clear && runId !== null) throw new PluginCliError("--clear takes no --run", { code: "bad_started", hint: `bb cow automation started ${id} --clear` });
        if (!clear && !automation?.trim()) throw new PluginCliError("say which automation started it: --automation", { code: "automation_required", hint: usage });
        if (runId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(runId)) throw new PluginCliError(`"${runId}" is not a run id`, { code: "bad_run", hint: usage });
        const callerId = ctx.threadId ?? null;
        const done = await acting(() =>
          clear ? store.clear({ threadId: id, automation: automation?.trim() || null, callerId }) : store.record({ threadId: id, automation: automation!.trim(), runId, callerId }),
        );
        const named = `“${done.automation.name}” (${done.automation.id})`;
        const text = clear
          ? done.changed
            ? `cleared: “${done.title}” (${id}) is no longer listed under the automation ${named}`
            : `“${done.title}” (${id}) was not recorded as started by an automation: nothing to clear`
          : `${done.changed ? "recorded" : "already recorded"}: “${done.title}” (${id}) was started by ${done.runId ? `run ${done.runId} of ` : ""}the automation ${named} · cow lists it under the automation`;
        return print(input.options.json, { threadId: id, title: done.title, automationId: done.automation.id, automationName: done.automation.name, runId: done.runId, recorded: !clear, changed: done.changed }, text);
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
          "A worker over a cap or caught by a stuck check has the mark beside its line (`watch` in --json); cow shows it and never stops it. " +
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
          const held = capabilityNames ? withCapabilities(raisedOrPlain, await capabilityNames(ids)) : raisedOrPlain;
          // Caps and stuck checks: marks only, beside the line. cow never stops a worker.
          const report = actions.watchMarks ? withWatch(held, await actions.watchMarks()) : held;
          return input.options.json
            ? { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...report })}\n` }
            : { exitCode: 0, stdout: statusText(report) + elsewhereText(attended?.asksElsewhere ?? 0) };
        },
      }),
      archive: cliCommand({
        summary: "Archive a done, idle or failed thread, recording why",
        description:
          "Archives the thread in bb, and the threads under it with it. Refused while it is not done, idle or failed, " +
          "or while threads under it are still open. The reason shows on cow's page under Archived for two days. " +
          "A thread with no parent that is not Main is listed under Outside Main: only the thread that is Main archives one of those.",
        positionals: [thread],
        options: {
          reason: { type: "string", aliases: ["why"], description: `Why it is archived, up to ${MAX_REASON} characters` },
          ...(actions.outcomeChecked
            ? { outcome: { type: "string", description: `What a worker you dispatched came to, honestly: ${OUTCOME_LIST}. Optional` } as const }
            : {}),
          ...(actions.labelChecked ? { label: labelOption } : {}),
          json,
        },
        async run(input, ctx) {
          const id = threadId(input.positionals.thread);
          const reason = reasonText(input.options.reason ?? "", false);
          const given = (input.options as { outcome?: string }).outcome;
          const outcome = given === undefined ? null : outcomeOf(given);
          const givenLabel = (input.options as { label?: string }).label;
          const label = givenLabel === undefined ? undefined : labelText(givenLabel);
          const done = await acting(() =>
            actions.archiveChecked({ callerId: ctx.threadId ?? null, threadId: id, reason, ...(outcome === null ? {} : { outcome }), ...(label === undefined ? {} : { label }) }),
          );
          const with_ = done.under === 0 ? "" : ` with the ${done.under === 1 ? "thread" : `${done.under} threads`} under it`;
          return print(
            input.options.json,
            { threadId: id, title: done.title, reason, archivedUnder: done.under, outside: done.outside, ...(outcome === null ? {} : { outcome }), ...(label === undefined ? {} : { label }) },
            `archived “${done.title}” (${id})${with_}${reason === null ? "" : `: ${reason}`}${outcome === null ? "" : ` · came to: ${outcome}`}${label === undefined ? "" : ` · labelled ${label}`}${done.outside ? " · it was outside Main: it is listed under Archived for two days" : ""}`,
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
      ...ledgerCommands(actions),
      ...(actions.usage ? { usage: usageCommand(actions.usage) } : {}),
      ...(attention ? attentionCommands(attention) : {}),
      ...(extra ?? {}),
    },
  });
}
