// `bb cow caps`, `caps log` and `cap request`: how an agent sees which
// capabilities it holds and what the log says, and how it asks the person
// for one. Nothing here makes, changes, grants, deletes or acknowledges a
// capability: those are the person's, on cow's page.

import { PluginCliError, cliCommand } from "@get-bb/plugin-sdk";
import { CAPABILITY_OPTIONS } from "../asks/ask.ts";
import type { Asks } from "../asks/service.ts";
import { Refusal } from "../kv.ts";
import { formatAge } from "../text.ts";
import { CAP_LIMITS, capabilityLine, isActive, kindText, ruleText } from "./cap.ts";
import { eventText } from "./log.ts";
import { sourceText } from "./scope.ts";
import type { Caps } from "./service.ts";

const json = { type: "boolean", description: "Print machine-readable JSON" } as const;

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

const ONLY_THE_PERSON = "Only the user makes, deletes or acknowledges a capability, on cow's page. Ask for one with `bb cow cap request`.";

/** What a thread asks for, as the question of its ask. */
export function requestQuestion(kind: "dir" | "command", rule: string): string {
  return kind === "dir" ? `asks for a capability to write under ${rule}` : `asks for a capability to run “${rule}”`;
}

export function capCommands(caps: Caps, asks: Asks, titleOf: (threadId: string) => Promise<string>) {
  /** Titles for every thread a set of ids names, read once. */
  const titles = async (ids: Iterable<string>) => {
    const found = new Map<string, string>();
    for (const id of new Set(ids)) found.set(id, await titleOf(id));
    return (id: string) => found.get(id) ?? id;
  };

  return {
    caps: cliCommand({
      summary: "The capabilities a thread holds: what cow will allow it without asking the user",
      description:
        "A capability is a grant the user made: to write under one directory, or to run one command. When bb asks for permission and a " +
        "capability that applies to the thread covers the whole request, cow allows it once. Inside a thread this lists what that thread " +
        `holds and where each comes from; --all lists every capability. Read-only. ${ONLY_THE_PERSON}`,
      options: {
        thread: { type: "string", description: "The thread to list for. Default: your own thread" },
        all: { type: "boolean", description: "Every capability, whoever it applies to" },
        json,
      },
      async run(input, ctx) {
        const o = input.options;
        const target = o.thread === undefined ? (ctx.threadId ?? null) : threadId(o.thread);
        const now = Date.now();
        if (target === null || o.all) {
          const all = (await caps.state()).capabilities.filter(isActive);
          const name = await titles(all.map((capability) => capability.scope.threadId));
          const text = all.length === 0 ? "no capabilities" : all.map((capability) => capabilityLine(capability, name, formatAge, now)).join("\n");
          return print(o.json, { capabilities: all }, text);
        }
        const mine = await caps.heldBy(target);
        const name = await titles(mine.flatMap((entry) => [entry.capability.scope.threadId, ...("threadId" in entry.source ? [entry.source.threadId] : [])]));
        const text =
          mine.length === 0
            ? `${target} holds no capability. To ask the user for one: bb cow cap request --kind dir|command --rule <text> --why <text>`
            : mine.map((entry) => `${entry.capability.name}  [${kindText(entry.capability.rule)}]  ${ruleText(entry.capability.rule)}  ·  ${sourceText(entry.source, name)}`).join("\n");
        return print(o.json, { threadId: target, capabilities: mine.map((entry) => ({ ...entry.capability, source: entry.source })) }, text);
      },
    }),
    "caps log": cliCommand({
      summary: "The capability log, newest first: what was made, deleted and allowed, and by which capability",
      description: `Every capability made, deleted or restored, every notice acknowledged, every request cow allowed through a capability or the user decided on cow's page, every request decided somewhere else, and, despite the name, every park of a thread that waited on the user, ask withdrawn, and ask closed as answered when the user had not written since, done by a thread. Read-only: nothing edits or clears it. ${ONLY_THE_PERSON}`,
      options: { limit: { type: "integer", min: 1, max: 500, description: "How many entries. Default: 50" }, json },
      async run(input) {
        const o = input.options;
        const { entries, total, check } = await caps.log({ limit: o.limit ?? 50 });
        const ids = entries.flatMap((entry) => ("threadId" in entry.event && entry.event.threadId ? [entry.event.threadId] : "sourceThreadId" in entry.event && entry.event.sourceThreadId ? [entry.event.sourceThreadId] : []));
        const name = await titles(ids);
        const lines = entries.map((entry) => `${String(entry.seq).padStart(5)}  ${new Date(entry.at).toISOString()}  ${eventText(entry.event, name)}`);
        const head = check.intact ? `${total} ${total === 1 ? "entry" : "entries"}, numbered without a gap` : `THE LOG IS BROKEN at entry ${check.at}: ${check.why}`;
        return print(o.json, { entries, total, check }, [head, ...lines].join("\n"));
      },
    }),
    "cap request": cliCommand({
      summary: "Ask the user for a capability: to write under a directory, or to run a command, without being asked each time",
      description:
        "Raises an ask on cow's page that the user allows or refuses with one key, a, on its line. Say what you need and why. For a directory give its whole path " +
        "from /; for a command give the exact command line, in plain words with no shell operators. The user may narrow or widen what " +
        "you propose. The answer arrives as a message from the user: it names the capability when one was made; anything else, words included, grants nothing, and cow adds a line that says so. There is no other way to get a capability, and you must not look for one.",
      options: {
        kind: { type: "enum", values: ["dir", "command"], required: true, description: "dir: write under a directory. command: run a command" },
        rule: { type: "string", required: true, description: "The directory's absolute path, or the exact command line" },
        why: { type: "string", required: true, description: `Why you need it, up to ${CAP_LIMITS.why} characters` },
        thread: { type: "string", description: "Ask for a thread under yours. Default: your own thread" },
        json,
      },
      async run(input, ctx) {
        const o = input.options;
        const why = o.why.trim();
        if (why === "") throw new PluginCliError("--why is empty: say why you need it", { code: "why_required" });
        if (why.length > CAP_LIMITS.why) throw new PluginCliError(`keep --why under ${CAP_LIMITS.why} characters`, { code: "why_too_long" });
        const kind = o.kind as "dir" | "command";
        // Refused here, with the reason, rather than put to the user as something they could never grant.
        const rule = await acting(() => caps.checkRule(kind === "dir" ? { kind, text: o.rule } : { kind, mode: "exact", text: o.rule }));
        const text = rule.kind === "dir" ? rule.dir : rule.text;
        const ask = await acting(() =>
          asks.ask({
            caller: ctx.threadId ?? null,
            threadId: o.thread === undefined ? null : threadId(o.thread),
            question: requestQuestion(kind, text),
            options: [...CAPABILITY_OPTIONS],
            optionsOnly: false,
            risk: null,
            proofs: [],
            context: why,
            capability: { kind, rule: text },
          }),
        );
        await caps.requested(ask.threadId, ask.id, rule);
        return print(o.json, { ask }, `${ask.id}\nasked the user for a capability. The answer will arrive as a message from the user; carry on with what does not need it, and do not ask again. Only an answer that names the capability made grants one; ` +
            "any other answer (words, a refusal, a close in chat) grants nothing, and cow says so. `bb cow caps` shows what you hold.\n" +
            "If the user asks how to decide it: it is in their queue on cow's page; a on its line opens it, 1 allows it (they then confirm what it covers), 2 and Enter refuse it.");
      },
    }),
  };
}
