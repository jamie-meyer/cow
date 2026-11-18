// cow's server reads bb's automations for the page and the CLI, through the
// automations plugin's own methods. It only reads: nothing here pauses,
// runs or changes an automation.
//
// The plugin may be absent, disabled or slow. Every call is bounded in time
// and every failure is contained: the answer is then "not available", and
// the page simply has no Automations section.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AUTOMATIONS_PLUGIN, type AutomationsRead, NO_AUTOMATIONS, parseOverview, parseRuns } from "./automations.ts";

/** How long the list of automations may take, and each automation's runs. */
const OVERVIEW_MS = 4000;
const RUNS_MS = 3000;
/** Runs read per enabled automation: the newest, enough to list five and count some older. */
const RUNS_READ = 20;
const CONCURRENCY = 4;
/** One answer serves every caller for this long: a burst of refreshes is one read. */
const FRESH_MS = 1500;

/** The plugin's methods cow calls. Its answers are read without trusting their shape. */
export interface AutomationsCaller {
  call(method: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

async function bounded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every automation, with the latest runs of each enabled one. Never throws. */
export async function readAutomations(caller: AutomationsCaller, limits = { overviewMs: OVERVIEW_MS, runsMs: RUNS_MS }): Promise<AutomationsRead> {
  let automations;
  try {
    automations = parseOverview(await bounded(limits.overviewMs, (signal) => caller.call("automations_overview", null, signal)));
  } catch {
    return NO_AUTOMATIONS;
  }
  const out: AutomationsRead["automations"] = automations.map((automation) => ({ automation, runs: [], moreRuns: false }));
  const pending = out.filter((entry) => entry.automation.enabled);
  const work = async () => {
    for (let entry = pending.shift(); entry; entry = pending.shift()) {
      const { projectId, id } = entry.automation;
      try {
        const read = parseRuns(await bounded(limits.runsMs, (signal) => caller.call("automations_runs", { projectId, automationId: id, limit: RUNS_READ }, signal)));
        entry.runs = read.runs;
        entry.moreRuns = read.more;
      } catch {
        // Its row still shows what the automation itself records of its last run.
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  return { available: true, automations: out };
}

const runSchema = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  skipReason: z.string().nullable(),
  error: z.string().nullable(),
  output: z.string().nullable(),
  exitCode: z.number().nullable(),
  scheduledFor: z.number().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

const automationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: z.union([
    z.object({ kind: z.literal("schedule"), cron: z.string(), timezone: z.string().nullable() }),
    z.object({ kind: z.literal("once"), runAt: z.number().nullable() }),
    z.object({ kind: z.literal("other") }),
  ]),
  mode: z.enum(["agent", "script"]),
  targetThreadId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  runCount: z.number(),
  lastRunStatus: z.enum(["running", "succeeded", "failed", "skipped"]).nullable(),
  lastRunThreadId: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const automationsReadSchema = z.object({
  available: z.boolean(),
  automations: z.array(z.object({ automation: automationSchema, runs: z.array(runSchema), moreRuns: z.boolean() })),
});

export const automationsRpcContract = defineRpcContract({
  /** bb's automations, read through the automations plugin; `available: false` when it is absent or did not answer. */
  automations_read: { input: z.null(), output: automationsReadSchema },
});

/** Registers the page's method, and returns the read the CLI uses. */
export function registerAutomations(bb: BbPluginApi): () => Promise<AutomationsRead> {
  const caller: AutomationsCaller = {
    call: (method, input, signal) =>
      bb.sdk.plugins.callRpc({ pluginId: AUTOMATIONS_PLUGIN, method, input: input as never, outputSchema: z.unknown(), signal }),
  };
  let last: { at: number; read: Promise<AutomationsRead> } | null = null;
  const read = (): Promise<AutomationsRead> => {
    const now = Date.now();
    if (last && now - last.at < FRESH_MS) return last.read;
    const next = readAutomations(caller);
    last = { at: now, read: next };
    return next;
  };
  bb.rpc.register(automationsRpcContract, { automations_read: () => read() });
  return read;
}
