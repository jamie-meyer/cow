// `bb cow ask`, `asks` and `brief`: how an agent puts a question in front of
// the user so it stays there, and how it reports a finished job in a form a
// checker can audit. Answering an ask is not here: that is the user's, on
// cow's page.

import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { type Ask, RISKS, askText } from "./asks/ask.ts";
import type { Asks } from "./asks/service.ts";
import { withAttention } from "./raised.ts";
import { BRIEF_SHAPE } from "./briefs/brief.ts";
import { markText, reviewText } from "./briefs/review.ts";
import { type BriefRecord, type Briefs, MAX_RUNS, briefView } from "./briefs/service.ts";
import { Refusal } from "./kv.ts";
import type { StatusReport } from "./status.ts";
import { formatAge } from "./text.ts";

export interface Attention {
  asks: Asks;
  briefs: Briefs;
  /** The text of a file, by absolute path, on the machine the calling thread runs on (the server's, for no thread). */
  readFile(threadId: string | null, path: string): Promise<string>;
}

/** A path as typed, made absolute against the folder the command ran in. */
export function absolutePath(path: string, cwd: string | null): string {
  if (path.startsWith("/")) return path;
  if (cwd === null) throw new Error("the path is relative and the folder the command ran in is not known");
  return `${cwd.replace(/\/+$/, "")}/${path.replace(/^\.\//, "")}`;
}

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
const MAX_LISTED = 50;
const MAX_WAIT_MS = 15 * 60_000;

function threadId(value: string): string {
  const id = value.trim().replace(/^@?thread:/, "");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new PluginCliError(`"${value}" is not a thread id`, { code: "bad_thread", hint: "Thread ids look like thr_abc123; `bb thread list` shows them." });
  }
  return id;
}

async function acting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof Refusal) throw new PluginCliError(cause.message, { code: cause.code, hint: cause.hint });
    throw cause;
  }
}

const print = (asJson: boolean, data: object, text: string) => ({
  exitCode: 0,
  stdout: asJson ? `${JSON.stringify({ ok: true, ...data })}\n` : `${text.replace(/\n+$/, "")}\n`,
});

/** A brief for `--json`: how to read it, without the evidence text. */
function briefJson(record: BriefRecord) {
  const { review, mark } = briefView(record);
  const slim = (entry: (typeof review.claims)[number]) => ({
    id: entry.claim.id,
    text: entry.claim.text,
    agentLabel: entry.claim.label,
    evidence: entry.claim.evidence.map((piece) => ({ description: piece.description, path: piece.path })),
    shows: entry.verdict?.shows ?? null,
    verdict: entry.verdict?.verdict ?? null,
    needs: entry.verdict?.needs ?? null,
    dispute: entry.dispute,
    disagreement: entry.disagreement,
  });
  return {
    threadId: record.threadId,
    version: record.version,
    submittedAt: record.submittedAt,
    summary: record.brief.summary,
    check: { state: review.state, model: review.model, runs: review.runs, failures: review.failures },
    mark,
    disputes: review.disputes.map(slim),
    judgementCalls: review.judgementCalls,
    claims: review.claims.map(slim),
    notDone: review.notDone,
  };
}

const briefText = (record: BriefRecord): string =>
  reviewText({ threadId: record.threadId, version: record.version, summary: record.brief.summary }, briefView(record).review);

/** The overview with asks and briefs on it. */
export async function attend(attention: Attention, report: StatusReport, projectId: string | null, now: number) {
  const open = await attention.asks.list();
  const ids = [report.main, ...report.threads, ...report.parked, ...report.done].map((line) => line.id);
  return withAttention(report, open, await attention.briefs.marks(ids), now, projectId);
}

/** What `status` adds under its text when asks are open on threads it does not list. */
export const elsewhereText = (count: number): string =>
  count > 0 ? `\n${count} more open ${count === 1 ? "ask" : "asks"} on threads not listed here: bb cow asks\n` : "";

export function attentionCommands(attention: Attention) {
  const { asks, briefs } = attention;
  const wait = { type: "boolean", description: "Wait for the check to finish, at most 15 minutes" } as const;
  const afterCheck = async (record: BriefRecord, waiting: boolean, signal: AbortSignal | undefined) =>
    waiting ? acting(() => briefs.settled(record.threadId, MAX_WAIT_MS, signal)) : record;

  return {
    ask: cliCommand({
      summary: "Ask the user one question; it stays in front of them until answered",
      description:
        "Records one question from your thread to the user and prints its id. It shows on cow's page and in " +
        "`bb cow status` until it is answered or withdrawn. The answer arrives later as a message from the user that " +
        "quotes the question: carry on with work that does not depend on it, or end your turn. One ask per decision. " +
        "Up to 9 options; the user can also answer in words unless --options-only.",
      options: {
        question: { type: "string", required: true, aliases: ["q"], description: "The question, up to 600 characters" },
        option: { type: "string", repeatable: true, aliases: ["options"], description: "An answer to choose: 'label' or 'label::what choosing it means'. Repeat for each" },
        "options-only": { type: "boolean", description: "Take only one of the options, not an answer in words" },
        risk: { type: "enum", values: [...RISKS], description: "How much is at stake in the answer" },
        proof: { type: "string", repeatable: true, description: "A file under $BB_THREAD_STORAGE the user should see. Repeat for each, up to 8" },
        context: { type: "string", description: "Background the user needs to answer, up to 2000 characters" },
        thread: { type: "string", description: "Ask for a thread under yours. Default: your own thread" },
        json,
      },
      async run(input, ctx) {
        const o = input.options;
        const ask = await acting(() =>
          asks.ask({
            caller: ctx.threadId ?? null,
            threadId: o.thread === undefined ? null : threadId(o.thread),
            question: o.question,
            options: o.option ?? [],
            optionsOnly: o["options-only"],
            risk: o.risk ?? null,
            proofs: o.proof ?? [],
            context: o.context ?? null,
          }),
        );
        return print(o.json, { ask }, `${ask.id}\nasked the user. The answer will arrive as a message from the user quoting the question; do not ask again.`);
      },
    }),
    "ask withdraw": cliCommand({
      summary: "Withdraw a question you asked that no longer needs an answer",
      positionals: [{ name: "id", description: "The ask's id, such as ask_1a2b3c4d", required: true }],
      options: { json },
      async run(input, ctx) {
        const ask = await acting(() => asks.withdraw(ctx.threadId ?? null, input.positionals.id.trim()));
        return print(input.options.json, { ask }, `withdrew ${ask.id}: ${ask.question}`);
      },
    }),
    asks: cliCommand({
      summary: "Open questions for the user, oldest first",
      description: `Lists at most ${MAX_LISTED}; the rest are counted. Only the user answers an ask, on cow's page.`,
      options: {
        thread: { type: "string", description: "Only this thread's asks" },
        all: { type: "boolean", description: "Include answered and withdrawn asks" },
        json,
      },
      async run(input) {
        const o = input.options;
        const found = await acting(() => asks.list({ ...(o.thread === undefined ? {} : { threadId: threadId(o.thread) }), all: o.all }));
        // With --all the newest are the ones worth seeing.
        const listed: Ask[] = o.all ? found.slice(-MAX_LISTED) : found.slice(0, MAX_LISTED);
        const now = Date.now();
        const text =
          found.length === 0
            ? "no open asks"
            : [...listed.map((ask) => askText(ask, now, formatAge)), ...(found.length > listed.length ? [`… and ${found.length - listed.length} more, not listed`] : [])].join("\n");
        return print(o.json, { asks: listed, omitted: found.length - listed.length }, text);
      },
    }),
    "brief submit": cliCommand({
      summary: "Submit the brief of your finished job: claims, evidence, judgement calls, what was left undone",
      description:
        "Reads a JSON file and stores it as your thread's brief; submitting again stores a new version. An independent " +
        "checker then audits each claim against its evidence, and the user is shown the disputes first. Label claims " +
        "honestly: your label is shown as what you say, never as verification. Evidence files are read from " +
        `$BB_THREAD_STORAGE when you submit.\n\nThe file:\n${BRIEF_SHAPE}`,
      positionals: [{ name: "file", description: "Path to the brief's JSON file", required: true }],
      options: {
        thread: { type: "string", description: "Submit for a thread under yours. Default: your own thread" },
        wait,
        json,
      },
      async run(input, ctx) {
        const o = input.options;
        const caller = ctx.threadId ?? null;
        const text = await Promise.resolve()
          .then(() => attention.readFile(caller, absolutePath(input.positionals.file, ctx.cwd ?? null)))
          .catch((cause: unknown) => {
          throw new PluginCliError(`cannot read ${input.positionals.file}: ${cause instanceof Error ? cause.message : String(cause)}`, {
            code: "file_unreadable",
            hint: "Pass the absolute path of a JSON file.",
          });
        });
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch (cause) {
          throw new PluginCliError(`${input.positionals.file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, {
            code: "bad_json",
            hint: `The shape is:\n${BRIEF_SHAPE}`,
          });
        }
        const stored = await acting(() => briefs.submit({ caller, threadId: o.thread === undefined ? null : threadId(o.thread), raw }));
        const record = await afterCheck(stored, o.wait, ctx.signal);
        const state = briefView(record).mark;
        return print(o.json, briefJson(record), o.wait ? briefText(record) : `stored brief v${record.version} for ${record.threadId}: ${markText(state)}`);
      },
    }),
    "brief check": cliCommand({
      summary: "Run the independent checker on a thread's latest brief",
      description:
        "Starts a new audit: a separate agent that sees only the brief and its evidence. Refused for the thread the " +
        "brief is from; the thread above it, or the user, can run it.",
      positionals: [{ name: "thread", description: "The thread whose brief to check", required: true }],
      options: {
        model: { type: "string", description: "The checker's model. Default: cow's setting" },
        provider: { type: "string", description: "The checker's provider. Default: cow's setting" },
        runs: { type: "integer", min: 1, max: MAX_RUNS, description: `Independent runs, 1 to ${MAX_RUNS}. Default: cow's setting` },
        wait,
        json,
      },
      async run(input, ctx) {
        const o = input.options;
        const id = threadId(input.positionals.thread);
        const started = await acting(() =>
          briefs.check({
            caller: ctx.threadId ?? null,
            threadId: id,
            ...(o.model === undefined ? {} : { model: o.model }),
            ...(o.provider === undefined ? {} : { provider: o.provider }),
            ...(o.runs === undefined ? {} : { runs: o.runs }),
          }),
        );
        const record = await afterCheck(started, o.wait, ctx.signal);
        return print(o.json, briefJson(record), o.wait ? briefText(record) : `checking brief v${record.version} of ${id}: ${record.check?.runs.length ?? 0} run(s) started`);
      },
    }),
    "brief show": cliCommand({
      summary: "A thread's brief as the checker left it: disputes first",
      description:
        "Disputed claims (the claim, the agent's own label, what the evidence literally shows, the checker's verdict), " +
        "then judgement calls, then the other claims, then what was left undone. At most 30 disputes and 30 other claims.",
      positionals: [{ name: "thread", description: "The thread whose brief to show", required: true }],
      options: { version: { type: "integer", min: 1, max: 9999, description: "An earlier version. Default: the latest" }, wait, json },
      async run(input, ctx) {
        const o = input.options;
        const id = threadId(input.positionals.thread);
        const found = await acting(() => briefs.get(id, o.version));
        const record = o.version === undefined ? await afterCheck(found, o.wait, ctx.signal) : found;
        return print(o.json, briefJson(record), briefText(record));
      },
    }),
  };
}
