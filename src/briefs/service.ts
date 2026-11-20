// Briefs on the backend: stored with their evidence as it was when
// submitted, audited by a checker that runs in a hidden thread of its own,
// and read back disputes first.

import { z } from "zod";
import { storagePath } from "../asks/ask.ts";
import { type Kv, Refusal, serial } from "../kv.ts";
import { BRIEF_LIMITS, BRIEF_SHAPE, type Brief, type Evidence, briefSchema, clip, validateBrief } from "./brief.ts";
import { checkerPrompt, parseCheckerReply } from "./checker.ts";
import { type CheckerFailure, chooseChecker, nowhereText, startCouldFix, startFailedText, turnFailedText } from "./provider.ts";
import { type BriefMark, type CheckRun, type Review, VERDICTS, disputeCount, markOf, review } from "./review.ts";

const PREFIX = "brief:";
const RUN_PREFIX = "check-run:";
export const MAX_RUNS = 5;
/** A checker that has not answered after this long has failed. */
export const CHECK_TIMEOUT_MS = 10 * 60_000;
/** A thread bb reports idle this soon after it was started may not have begun its turn. */
const START_GRACE_MS = 20_000;

const verdictSchema = z.object({ id: z.string(), shows: z.string(), verdict: z.enum(VERDICTS), needs: z.string().nullable() });
const runBase = {
  threadId: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** 2 for a run started again because the first answer could not be read. */
  attempt: z.number().int().min(1).optional(),
};
/** How much of a checker's unusable answer is kept, to be shown with why it failed. */
export const MAX_KEPT_ANSWER = 20_000;
const checkSchema = z.object({
  model: z.string().nullable(),
  /** The provider the check ran on; null for bb's default. Checks recorded before this was kept have none. */
  provider: z.string().nullable().default(null),
  /** Where the provider and the model came from: the command, cow's settings, the thread that submitted the brief, or bb's default. Absent on checks recorded before 0.2.12. */
  chosen: z
    .object({ provider: z.enum(["given", "setting", "inherited", "default"]), model: z.enum(["given", "setting", "inherited", "default"]) })
    .optional(),
  startedAt: z.number(),
  runs: z.array(
    z.discriminatedUnion("status", [
      z.object({ status: z.literal("running"), ...runBase }),
      z.object({ status: z.literal("done"), verdicts: z.array(verdictSchema), ...runBase }),
      /** `answer`: what the checker said, when it said something that could not be used. */
      z.object({ status: z.literal("failed"), error: z.string(), answer: z.string().nullable().optional(), ...runBase }),
    ]),
  ),
});

/** A run of the check again that gave no usable answer, kept beside the check it did not replace. */
const failedRecheckSchema = z.object({
  startedAt: z.number(),
  finishedAt: z.number(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** Why each of its runs failed. */
  errors: z.array(z.string()),
});

/** What a check being run again would replace, kept until it answers: if no run of it does, this is put back. */
const replacedSchema = z.object({
  check: checkSchema,
  readAt: z.number().nullable(),
  earlierChecks: z.number().int().min(0),
  earlierDisputes: z.number().int().min(0),
  earlierContradicted: z.number().int().min(0).nullable(),
});

export const briefRecordSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  /** 1 for a thread's first brief; each resubmission adds one. */
  version: z.number().int().min(1),
  submittedAt: z.number(),
  /** The thread that ran the command, or null when no thread did. */
  submittedBy: z.string().nullable(),
  brief: briefSchema,
  /** The latest check of this version, or null when none was run. */
  check: checkSchema.nullable(),
  /** How many checks of this version came before the latest. */
  earlierChecks: z.number().int().min(0),
  /** When the person opened this version with its latest check; null until they have. */
  readAt: z.number().nullable().default(null),
  /**
   * The most claims any earlier check of this version disputed while the
   * person had not read it: kept when a check is run again unread, so that
   * running one again cannot take a dispute out of their queue. Back to 0
   * when a check is run again after they have read it.
   */
  earlierDisputes: z.number().int().min(0).default(0),
  /** How many of `earlierDisputes` the evidence contradicted; the rest it could not confirm. Null on records from before 0.2.14. */
  earlierContradicted: z.number().int().min(0).nullable().default(null),
  /** While a check runs again: the usable check it would replace. */
  replaced: replacedSchema.nullable().default(null),
  /** The latest run of the check again that gave no usable answer, when the check before it was kept. */
  failedRecheck: failedRecheckSchema.nullable().default(null),
});
export type BriefRecord = z.infer<typeof briefRecordSchema>;

/**
 * Where a checker's thread starts. It reads only its prompt, so it needs no
 * checkout: a personal workspace is an empty directory of its own, in bb's
 * personal project, that bb removes with the thread. The submitting thread's
 * environment is used only when bb will not make one.
 */
export type CheckerPlace = { type: "personal" } | { type: "reuse"; projectId: string; environmentId: string };

export interface CheckerSettings {
  /** Null when not set: the submitting thread's provider and model are used, or failing those bb's default. */
  model: string | null;
  provider: string | null;
  runs: number;
  /** Check a brief as soon as it is submitted. */
  onSubmit: boolean;
}

/** What cow can see of a checker's thread. */
export interface CheckerSight {
  state: "running" | "idle" | "error" | "gone";
  /** The checker's final message, when it has one. */
  reply: string | null;
  /** Every tool the checker used. It is told to use none. */
  tools: string[];
  /** For state "error": what bb recorded about the failed turn. */
  failure?: CheckerFailure | null;
}

export interface BriefDeps {
  kv: Kv;
  now(): number;
  newId(): string;
  thread(threadId: string): Promise<{ projectId: string; environmentId: string | null } | null>;
  /** The provider a thread runs on and the model of its latest turn, each null when bb does not say. */
  execution(threadId: string): Promise<{ provider: string | null; model: string | null }>;
  ancestors(threadId: string): Promise<readonly string[]>;
  storageRoot(threadId: string): Promise<string | null>;
  /** The text of a file in the thread's storage. Throws, saying why, when it cannot be read as text. */
  readEvidence(threadId: string, path: string): Promise<string>;
  /** Is this an ask of this thread? */
  hasAsk(askId: string, threadId: string): Promise<boolean>;
  settings(): Promise<CheckerSettings>;
  checker: {
    /** Start a checker in a hidden thread of its own, given only `prompt`. Returns the thread's id. */
    start(args: { place: CheckerPlace; prompt: string; model: string | null; provider: string | null }): Promise<string>;
    look(threadId: string): Promise<CheckerSight>;
    /** Stop and archive a checker's thread. */
    discard(threadId: string): Promise<void>;
  };
  changed(): void;
}

export interface Briefs {
  /** Validate and store a brief; with the setting on (or `check` true), start its check. */
  submit(args: { caller: string | null; threadId: string | null; raw: unknown; check?: boolean }): Promise<BriefRecord>;
  /** Start a check of a thread's latest brief. The audited thread cannot order its own audit. */
  check(args: { caller: string | null; threadId: string; model?: string | null; provider?: string | null; runs?: number }): Promise<BriefRecord>;
  /** A thread's brief, with its check moved along; the latest version unless one is named. */
  get(threadId: string, version?: number): Promise<BriefRecord>;
  /** The same, once no run of its check is still going, or after `timeoutMs`. */
  settled(threadId: string, timeoutMs: number, signal?: AbortSignal): Promise<BriefRecord>;
  versions(threadId: string): Promise<number[]>;
  /** Thread id to what its latest brief says, for the threads that have one. */
  marks(threadIds: readonly string[]): Promise<Map<string, BriefMark>>;
  /** Record that the person opened a version of a thread's brief, or with `read` false, that it is theirs to read again. Never call this for an agent. */
  read(threadId: string, version: number, read?: boolean): Promise<BriefRecord>;
  /** Move along the check a checker thread belongs to. For when bb says that thread stopped. */
  checkerStopped(checkerThreadId: string): Promise<void>;
  /** Move along every check that is still running. For when the plugin loads. */
  settleAll(): Promise<void>;
}

const pad = (version: number) => String(version).padStart(4, "0");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

export function createBriefs(deps: BriefDeps): Briefs {
  const { kv } = deps;
  const locked = serial();
  const key = (threadId: string, version: number) => `${PREFIX}${threadId}:${pad(version)}`;

  const versions = async (threadId: string): Promise<number[]> =>
    (await kv.list(`${PREFIX}${threadId}:`)).map((k) => Number(k.slice(k.lastIndexOf(":") + 1))).filter(Number.isInteger).sort((a, b) => a - b);

  const read = async (threadId: string, version?: number): Promise<BriefRecord> => {
    const wanted = version ?? (await versions(threadId)).at(-1);
    const stored = wanted === undefined ? null : briefRecordSchema.safeParse(await kv.get(key(threadId, wanted)));
    if (!stored?.success) {
      throw new Refusal(
        "brief_not_found",
        version === undefined ? `${threadId} has submitted no brief` : `${threadId} has no brief v${version}`,
        "A thread submits one with `bb cow brief submit <file.json>`.",
      );
    }
    return stored.data;
  };
  const write = async (record: BriefRecord) => {
    await kv.set(key(record.threadId, record.version), record);
    deps.changed();
  };

  const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
  /**
   * Start one checker: in a personal workspace, or failing that in the
   * submitting thread's environment. Throws an Error whose message is the
   * failure in words. A refusal another provider could get past is not tried
   * elsewhere: it would be refused there too.
   */
  const launch = async (record: BriefRecord, prompt: string, model: string | null, provider: string | null): Promise<string> => {
    const said = (cause: string) => new Error(startFailedText({ provider, model, cause, threadId: record.threadId }));
    let personal: string;
    try {
      return await deps.checker.start({ place: { type: "personal" }, prompt, model, provider });
    } catch (cause) {
      personal = message(cause);
      if (startCouldFix(personal)) throw said(personal);
    }
    const thread = await deps.thread(record.threadId).catch(() => null);
    if (!thread?.environmentId) throw new Error(nowhereText({ personal, own: null }));
    try {
      return await deps.checker.start({ place: { type: "reuse", projectId: thread.projectId, environmentId: thread.environmentId }, prompt, model, provider });
    } catch (cause) {
      const own = message(cause);
      if (startCouldFix(own)) throw said(own);
      throw new Error(nowhereText({ personal, own }));
    }
  };

  /**
   * A check that has finished with no usable answer, when it was run again
   * over one that had one: the earlier check is put back, as it was, and the
   * attempt is kept beside it. Anything else is returned as it is.
   */
  const keepEarlier = (record: BriefRecord): BriefRecord => {
    const { check, replaced } = record;
    if (replaced === null || check === null) return record;
    if (check.runs.some((run) => run.status === "running")) return record;
    if (check.runs.some((run) => run.status === "done")) return { ...record, replaced: null, failedRecheck: null };
    const errors = check.runs.flatMap((run) => (run.status === "failed" ? [run.error] : []));
    const finishedAt = Math.max(check.startedAt, ...check.runs.map((run) => run.finishedAt ?? 0));
    return {
      ...record,
      check: replaced.check,
      readAt: replaced.readAt,
      earlierChecks: replaced.earlierChecks,
      earlierDisputes: replaced.earlierDisputes,
      earlierContradicted: replaced.earlierContradicted,
      replaced: null,
      failedRecheck: { startedAt: check.startedAt, finishedAt, provider: check.provider, model: check.model, errors },
    };
  };

  /** Where one running run stands now: still running, or its final state. `unreadable`: it answered, and the answer could not be read. */
  const judge = async (run: CheckRun, record: BriefRecord): Promise<CheckRun & { unreadable?: true }> => {
    const { brief } = record;
    const now = deps.now();
    const attempt = run.attempt ?? 1;
    const base = { threadId: run.threadId, startedAt: run.startedAt, finishedAt: now, attempt, answer: null };
    const sight = await deps.checker.look(run.threadId).catch((): CheckerSight => ({ state: "running", reply: null, tools: [] }));
    if (sight.state === "running" || (sight.state === "idle" && sight.reply === null && now - run.startedAt < START_GRACE_MS)) {
      return now - run.startedAt > CHECK_TIMEOUT_MS ? { ...base, status: "failed", error: "the checker did not answer in time" } : run;
    }
    if (sight.state === "gone") return { ...base, status: "failed", error: "the checker's thread is gone" };
    if (sight.state === "error") {
      const error = turnFailedText({ provider: record.check?.provider ?? null, model: record.check?.model ?? null, failure: sight.failure ?? null, threadId: record.threadId });
      return { ...base, status: "failed", error };
    }
    if (sight.tools.length > 0) {
      // It was given everything in its prompt. A checker that went looking elsewhere is not independent of what it found.
      return { ...base, status: "failed", error: `the checker used a tool (${sight.tools.slice(0, 3).join(", ")}); its answer is discarded`, answer: sight.reply?.slice(0, MAX_KEPT_ANSWER) ?? null };
    }
    const parsed = parseCheckerReply(sight.reply, brief.claims.map((claim) => claim.id));
    if (parsed.ok) return { threadId: run.threadId, startedAt: run.startedAt, finishedAt: now, attempt, status: "done", verdicts: parsed.verdicts };
    // What it said is kept, so that whoever reads the failure can see what went wrong.
    const answer = sight.reply === null || sight.reply.trim() === "" ? null : sight.reply.slice(0, MAX_KEPT_ANSWER);
    return { ...base, status: "failed", error: parsed.error, answer, ...(answer === null ? {} : { unreadable: true as const }) };
  };

  /** Run a checker again, once, when its answer could not be read: a slip in its JSON is not a verdict on the brief. */
  const again = async (record: BriefRecord, failed: CheckRun & { status: "failed" }): Promise<CheckRun> => {
    try {
      const checker = await launch(record, checkerPrompt(record.brief, deps.newId()), record.check?.model ?? null, record.check?.provider ?? null);
      await kv.set(`${RUN_PREFIX}${checker}`, { threadId: record.threadId, version: record.version });
      return { status: "running", threadId: checker, startedAt: deps.now(), finishedAt: null, attempt: 2 };
    } catch (cause) {
      return { ...failed, error: `${failed.error}; and it could not be run again: ${message(cause)}` };
    }
  };

  /** Move a brief's check along: read each running run's thread, record what it said, and put the thread away. */
  const settle = (threadId: string, version?: number): Promise<BriefRecord> =>
    locked(threadId, async () => {
      const record = await read(threadId, version);
      if (!record.check?.runs.some((run) => run.status === "running")) return record;
      const runs: CheckRun[] = [];
      /** The checker threads that have finished, whatever became of their run. */
      const over: string[] = [];
      for (const run of record.check.runs) {
        if (run.status !== "running") {
          runs.push(run);
          continue;
        }
        const { unreadable, ...judged } = await judge(run, record);
        if (judged.status !== "running") over.push(run.threadId);
        runs.push(unreadable && judged.status === "failed" && (judged.attempt ?? 1) < 2 ? await again(record, judged) : judged);
      }
      if (over.length === 0) return record;
      const next = keepEarlier({ ...record, check: { ...record.check, runs } });
      await write(next);
      for (const threadId of over) {
        await deps.checker.discard(threadId).catch(() => undefined);
        await kv.delete(`${RUN_PREFIX}${threadId}`);
      }
      return next;
    });

  const startCheck = (threadId: string, overrides: { model?: string | null; provider?: string | null; runs?: number }): Promise<BriefRecord> =>
    locked(threadId, async () => {
      const record = await read(threadId);
      if (record.check?.runs.some((run) => run.status === "running")) {
        throw new Refusal("check_running", `a check of ${threadId}'s brief v${record.version} is already running`, "Wait for it: `bb cow brief show` says when it is done.");
      }
      const settings = await deps.settings();
      // The thread that submitted the brief ran on its provider, so that one works here; bb's default may not.
      const own = await deps.execution(threadId).catch(() => ({ provider: null, model: null }));
      const { provider, model, chosen } = chooseChecker(overrides, settings, own);
      const count = Math.min(MAX_RUNS, Math.max(1, Math.trunc(overrides.runs ?? settings.runs)));
      const prompt = checkerPrompt(record.brief, deps.newId());
      const startedAt = deps.now();
      const runs: CheckRun[] = [];
      for (let n = 0; n < count; n += 1) {
        try {
          const checker = await launch(record, prompt, model, provider);
          await kv.set(`${RUN_PREFIX}${checker}`, { threadId, version: record.version });
          runs.push({ status: "running", threadId: checker, startedAt: deps.now(), finishedAt: null, attempt: 1 });
        } catch (cause) {
          runs.push({ status: "failed", threadId: "", startedAt, finishedAt: deps.now(), attempt: 1, answer: null, error: message(cause) });
        }
      }
      // A new check may say something new, so the brief is the person's to read again.
      // What the check being replaced disputed, and the person has not read, is not lost with it.
      const mark = briefView(record).mark;
      const earlier =
        record.readAt !== null ? { earlierDisputes: 0, earlierContradicted: null }
        : disputeCount(mark) > record.earlierDisputes ? { earlierDisputes: disputeCount(mark), earlierContradicted: mark.contradicted }
        : { earlierDisputes: record.earlierDisputes, earlierContradicted: record.earlierContradicted };
      // A check that gave an answer is kept until the new one gives one: a rerun that fails takes nothing away.
      const usable = record.check?.runs.some((run) => run.status === "done") ?? false;
      const replaced =
        usable && record.check ?
          { check: record.check, readAt: record.readAt, earlierChecks: record.earlierChecks, earlierDisputes: record.earlierDisputes, earlierContradicted: record.earlierContradicted }
        : null;
      const next = keepEarlier({
        ...record,
        check: { model, provider, chosen, startedAt, runs },
        earlierChecks: record.earlierChecks + (record.check ? 1 : 0),
        readAt: null,
        ...earlier,
        replaced,
        failedRecheck: null,
      });
      await write(next);
      return next;
    });

  const allow = async (caller: string | null, target: string, verb: string) => {
    if (caller === null || caller === target) return;
    if (!(await deps.ancestors(target)).includes(caller)) {
      throw new Refusal("not_your_thread", `${caller} cannot ${verb} ${target}: it is neither that thread nor above it`);
    }
  };

  return {
    versions,
    get: (threadId, version) => settle(threadId, version),

    async submit({ caller, threadId, raw, check }) {
      const target = threadId ?? caller;
      if (target === null) throw new Refusal("no_thread", "no thread to submit for: this command was not run inside a thread", "Pass --thread <id>.");
      const thread = await deps.thread(target);
      if (!thread) throw new Refusal("thread_not_found", `there is no thread ${target}`);
      await allow(caller, target, "submit a brief for");
      const valid = validateBrief(raw);
      if (!valid.ok) {
        throw new Refusal("bad_brief", `the brief is not valid:\n${valid.errors.map((error) => `  - ${error}`).join("\n")}`, `The shape is:\n${BRIEF_SHAPE}`);
      }
      const problems: string[] = [];
      for (const [index, call] of valid.brief.judgementCalls.entries()) {
        if (call.askId !== null && !(await deps.hasAsk(call.askId, target))) {
          problems.push(`judgementCalls[${index}].askId: ${call.askId} is not an ask of ${target}; raise it with \`bb cow ask\` and use the id it prints`);
        }
      }
      // The evidence is copied now: the checker reads what was submitted, whatever happens to the files later.
      const root = valid.brief.claims.some((claim) => claim.evidence.some((piece) => piece.path !== undefined)) ? await deps.storageRoot(target) : null;
      let total = 0;
      const claims: Brief["claims"] = [];
      for (const [index, claim] of valid.brief.claims.entries()) {
        const evidence: Evidence[] = [];
        for (const [n, piece] of claim.evidence.entries()) {
          const at = `claims[${index}].evidence[${n}]`;
          if (piece.path === undefined) {
            evidence.push({ description: piece.description, path: null, text: piece.text ?? "", truncated: false });
          } else {
            const path = storagePath(piece.path, root);
            if (!path.ok) {
              problems.push(`${at}.path: ${path.error}${path.hint ? `. ${path.hint}` : ""}`);
              continue;
            }
            try {
              evidence.push({ description: piece.description, path: path.value, ...clip(await deps.readEvidence(target, path.value)) });
            } catch (cause) {
              problems.push(`${at}.path: ${path.value} could not be read from the thread's storage (${cause instanceof Error ? cause.message : String(cause)}); save it as a text file under $BB_THREAD_STORAGE`);
              continue;
            }
          }
          total += evidence.at(-1)?.text.length ?? 0;
        }
        claims.push({ id: claim.id, text: claim.text, label: claim.label, evidence });
      }
      if (total > BRIEF_LIMITS.evidenceTotal) {
        problems.push(`the evidence is ${total} characters in all, over the limit of ${BRIEF_LIMITS.evidenceTotal}; attach the lines that matter instead of whole files`);
      }
      if (problems.length > 0) throw new Refusal("bad_brief", `the brief is not valid:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);

      const record = await locked(target, async () => {
        const version = ((await versions(target)).at(-1) ?? 0) + 1;
        const made: BriefRecord = {
          threadId: target,
          projectId: thread.projectId,
          version,
          submittedAt: deps.now(),
          submittedBy: caller,
          brief: { ...valid.brief, claims },
          check: null,
          earlierChecks: 0,
          readAt: null,
          earlierDisputes: 0,
          earlierContradicted: null,
          replaced: null,
          failedRecheck: null,
        };
        await write(made);
        return made;
      });
      const run = check ?? (await deps.settings()).onSubmit;
      return run ? startCheck(target, {}) : record;
    },

    async check({ caller, threadId, ...overrides }) {
      if (caller !== null && caller === threadId) {
        throw new Refusal("own_audit", "a thread cannot order the audit of its own brief", "Submit the brief again if it changed; the thread above this one, or the user, can run `bb cow brief check`.");
      }
      await allow(caller, threadId, "check a brief of");
      if (overrides.runs !== undefined && (!Number.isInteger(overrides.runs) || overrides.runs < 1 || overrides.runs > MAX_RUNS)) {
        throw new Refusal("bad_runs", `--runs must be from 1 to ${MAX_RUNS}`);
      }
      await settle(threadId);
      return startCheck(threadId, overrides);
    },

    read: (threadId, version, isRead = true) =>
      locked(threadId, async () => {
        const record = await read(threadId, version);
        if ((record.readAt !== null) === isRead) return record;
        const next = { ...record, readAt: isRead ? deps.now() : null };
        await write(next);
        return next;
      }),

    async settled(threadId, timeoutMs, signal) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const record = await settle(threadId);
        const running = record.check?.runs.some((run) => run.status === "running") ?? false;
        if (!running || Date.now() >= deadline || signal?.aborted) return record;
        await sleep(1500, signal);
      }
    },

    async marks(threadIds) {
      const found = new Map<string, BriefMark>();
      const have = new Set((await kv.list(PREFIX)).map((k) => k.slice(PREFIX.length, k.lastIndexOf(":"))));
      for (const threadId of threadIds) {
        if (!have.has(threadId)) continue;
        const record = await settle(threadId).catch(() => null);
        if (record) found.set(threadId, briefView(record).mark);
      }
      return found;
    },

    async checkerStopped(checkerThreadId) {
      const owner = z.object({ threadId: z.string(), version: z.number() }).safeParse(await kv.get(`${RUN_PREFIX}${checkerThreadId}`));
      if (owner.success) await settle(owner.data.threadId, owner.data.version).catch(() => undefined);
    },

    async settleAll() {
      for (const k of await kv.list(RUN_PREFIX)) {
        const owner = z.object({ threadId: z.string(), version: z.number() }).safeParse(await kv.get(k));
        const record = owner.success ? await settle(owner.data.threadId, owner.data.version).catch(() => null) : null;
        // A note left behind by a check that is no longer running is dropped.
        const checker = k.slice(RUN_PREFIX.length);
        if (!record?.check?.runs.some((run) => run.status === "running" && run.threadId === checker)) await kv.delete(k);
      }
    },
  };
}

/** A stored brief as the page and `--json` get it: the record and how to read it. */
export function briefView(record: BriefRecord): { record: BriefRecord; review: Review; mark: BriefMark } {
  const seen = review(record.brief, record.check);
  const at = Math.max(record.submittedAt, ...(record.check?.runs ?? []).map((run) => run.finishedAt ?? 0));
  return { record, review: seen, mark: markOf(record.version, seen, at, record.readAt !== null, record.earlierDisputes, record.earlierChecks > 0, record.earlierContradicted) };
}
