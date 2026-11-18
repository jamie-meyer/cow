import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AutomationRecord,
  type AutomationsRead,
  type RunRecord,
  NO_AUTOMATIONS,
  lastResult,
  lastResultText,
  nextRunText,
  olderText,
  parseOverview,
  parseRuns,
  runThreadIds,
  scriptOutput,
} from "../src/automations.ts";
import { readAutomations } from "../src/automations-backend.ts";
import { runThreadsKey } from "../src/automationsData.ts";
import { filterOverview } from "../src/filter.ts";
import { type ThreadFacts, derive } from "../src/state.ts";
import { statusReport, statusText } from "../src/status.ts";
import { formatAge } from "../src/text.ts";
import { AUTOMATIONS_SECTION, OUTSIDE_SECTION, afterLeaving, buildOverview, cursorOrder, foldMove, keepFolds, listed, sectionOf, unfoldAround } from "../src/tree.ts";
import { verbBlocked } from "../src/verbs.ts";
import { DAY, HOUR, MINUTE, NOW, activity, thread } from "./fixtures.ts";

function automation(overrides: Partial<AutomationRecord> & { id: string }): AutomationRecord {
  return {
    projectId: "proj_test",
    projectName: "test",
    name: overrides.id,
    enabled: true,
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    mode: "agent",
    targetThreadId: null,
    nextRunAt: NOW + 3 * HOUR,
    lastRunAt: NOW - HOUR,
    runCount: 3,
    lastRunStatus: "succeeded",
    lastRunThreadId: null,
    lastError: null,
    ...overrides,
  };
}

function run(id: string, threadId: string | null, hoursAgo: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const startedAt = NOW - hoursAgo * HOUR;
  return { id, threadId, status: "succeeded", skipReason: null, error: null, output: null, exitCode: null, scheduledFor: startedAt, startedAt, finishedAt: startedAt + MINUTE, ...overrides };
}

test("the plugin's answers are read without trusting their shape", () => {
  const found = parseOverview({
    automations: [
      {
        automation: {
          id: "a1",
          projectId: "p1",
          name: "Nightly check",
          enabled: true,
          trigger: { triggerType: "schedule", cron: "0 2 * * *", timezone: "UTC" },
          execution: { mode: "agent", targetThreadId: "thr_target" },
          nextRunAt: 5,
          lastRunAt: null,
          runCount: 0,
          lastRunStatus: null,
          lastRunThreadId: null,
          lastError: null,
        },
        project: { id: "p1", name: "Work" },
      },
      { automation: { id: "a2", projectId: "p1", trigger: { triggerType: "once", runAt: 9 }, execution: { mode: "script" }, lastRunStatus: "nonsense" } },
      { automation: { name: "no id" } },
      "junk",
    ],
  });
  assert.equal(found.length, 2);
  assert.deepEqual([found[0]!.name, found[0]!.projectName, found[0]!.trigger.kind, found[0]!.targetThreadId, found[0]!.mode], ["Nightly check", "Work", "schedule", "thr_target", "agent"]);
  assert.deepEqual([found[1]!.name, found[1]!.mode, found[1]!.trigger, found[1]!.lastRunStatus, found[1]!.projectName], ["a2", "script", { kind: "once", runAt: 9 }, null, null]);
  assert.deepEqual(parseOverview(null), []);
  assert.deepEqual(parseOverview({ automations: "no" }), []);

  const runs = parseRuns({ runs: [{ id: "r1", status: "failed", startedAt: 1 }, { id: "r2", status: "running", startedAt: 3 }, { id: "r3", status: "odd" }], nextCursor: "c" });
  assert.deepEqual(runs.runs.map((r) => r.id), ["r2", "r1"]);
  assert.equal(runs.more, true);
  assert.equal(parseRuns({ runs: [], nextCursor: null }).more, false);
});

test("when it runs next, in plain words", () => {
  // NOW is 2027-01-15 08:00 UTC.
  const at = (ms: number, overrides: Partial<AutomationRecord> = {}) => nextRunText(automation({ id: "a", nextRunAt: ms, ...overrides }), NOW, "UTC");
  assert.equal(at(NOW + 3 * HOUR), "in 3h");
  assert.equal(at(NOW + 25 * MINUTE), "in 25m");
  assert.equal(at(NOW + 10 * 1000), "due now");
  assert.equal(at(NOW - HOUR), "due now");
  assert.equal(at(NOW + 13 * HOUR), "today 21:00");
  assert.equal(at(NOW + DAY + HOUR), "tomorrow 09:00");
  assert.equal(at(NOW + 3 * DAY), "Mon 08:00");
  assert.equal(at(NOW + 20 * DAY), "4 Feb 08:00");
  assert.equal(at(NOW + HOUR, { enabled: false }), "paused");
  assert.equal(nextRunText(automation({ id: "a", nextRunAt: null, trigger: { kind: "once", runAt: NOW - DAY }, runCount: 1 }), NOW, "UTC"), "ran once");
  assert.equal(nextRunText(automation({ id: "a", nextRunAt: null, runCount: 0 }), NOW, "UTC"), "not scheduled");
});

const derived = (t: ThreadFacts) => derive(t, activity({ output: `${t.id} said this` }), NOW, null, null, null, { seenSeq: null });

test("the last run's result: a script's own; an agent's is what its thread came to", () => {
  const script = automation({ id: "s", mode: "script" });
  assert.deepEqual(lastResult(script, run("r", null, 2), null), { kind: "succeeded", at: NOW - 2 * HOUR + MINUTE, why: null });
  const failed = lastResult(script, run("r", null, 2, { status: "failed", error: "exit code 1\nstack…" }), null);
  assert.deepEqual([failed.kind, failed.why], ["failed", "exit code 1"]);
  assert.equal(lastResultText(failed, NOW, formatAge), "failed 1h ago: exit code 1");
  assert.equal(lastResultText(lastResult(script, run("r", null, 1, { status: "running", startedAt: NOW - 5 * MINUTE }), null), NOW, formatAge), "running for 5m");
  assert.equal(lastResultText(lastResult(automation({ id: "n", lastRunStatus: null, lastRunAt: null }), null, null), NOW, formatAge), "never ran");
  // Without runs read (a paused one), what the automation records.
  assert.deepEqual(lastResult(automation({ id: "p", lastRunStatus: "failed", lastError: "no such model" }), null, null).why, "no such model");

  const page = buildOverview(
    [thread({ id: "main" }), thread({ id: "bad", status: "error" }), thread({ id: "ok" }), thread({ id: "ask", hasPendingInteraction: true })],
    "main",
    derived,
    NOW,
    { note: () => null, todos: () => [], automations: { available: true, automations: [
      { automation: automation({ id: "x" }), runs: [run("r1", "bad", 1)], moreRuns: false },
      { automation: automation({ id: "y" }), runs: [run("r2", "ok", 1)], moreRuns: false },
      { automation: automation({ id: "z" }), runs: [run("r3", "ask", 1)], moreRuns: false },
    ] } },
  );
  assert.deepEqual(page.automations.groups.map((group) => group.last.kind), ["failed", "done", "wants"]);
});

/** Main under a root, a thread under Main, and runs of three automations. */
function world(extra: ThreadFacts[] = []): ThreadFacts[] {
  return [
    thread({ id: "root" }),
    thread({ id: "main", parentThreadId: "root" }),
    thread({ id: "kid", parentThreadId: "main" }),
    // Nightly's runs: seven, newest first; one archived; one needs the person.
    ...Array.from({ length: 7 }, (_, index) => thread({ id: `n${index}`, originPluginId: "automations", latestAttentionAt: NOW - index * DAY, lastReadAt: NOW - 2 * DAY })),
    thread({ id: "nGone", originPluginId: "automations", archivedAt: NOW - HOUR }),
    thread({ id: "asking", originPluginId: "automations", hasPendingInteraction: true }),
    // Another plugin's thread, and a run of an automation nobody read: still counted outside Main.
    thread({ id: "other", originPluginId: "elsewhere" }),
    thread({ id: "stray", originPluginId: "automations" }),
    ...extra,
  ];
}

const READ: AutomationsRead = {
  available: true,
  automations: [
    {
      automation: automation({ id: "nightly", name: "Nightly check" }),
      runs: [run("ra", "asking", 0.5), ...Array.from({ length: 7 }, (_, index) => run(`r${index}`, `n${index}`, index * 24 + 1)), run("rg", "nGone", 200)],
      moreRuns: true,
    },
    { automation: automation({ id: "into", name: "Into kid", targetThreadId: "kid" }), runs: [run("rk", "kid", 2)], moreRuns: false },
    { automation: automation({ id: "paused", name: "A paused one", enabled: false, lastRunThreadId: "n6" }), runs: [], moreRuns: false },
    { automation: automation({ id: "script", name: "Backup", mode: "script", projectId: "proj_other", projectName: "Home" }), runs: [run("rs", null, 3, { output: "copied 3 files", exitCode: 0 })], moreRuns: false },
  ],
};

const page = (threads = world(), read: AutomationsRead = READ) => buildOverview(threads, "main", derived, NOW, { note: () => null, todos: () => [], automations: read });

test("one row per automation, enabled first; its open runs not under Main under it, newest first, at most five", () => {
  const { automations } = page();
  assert.equal(automations.available, true);
  assert.deepEqual(automations.groups.map((group) => group.automation.id), ["script", "into", "nightly", "paused"]);
  const nightly = automations.groups.find((group) => group.automation.id === "nightly")!;
  assert.deepEqual(nightly.runs.map((line) => line.thread.id), ["asking", "n0", "n1", "n2", "n3"]);
  assert.equal(nightly.older, 3);
  assert.equal(olderText(nightly), "3 older, and more not listed");
  // A run that sends into a thread under Main leaves it in the tree.
  const into = automations.groups.find((group) => group.automation.id === "into")!;
  assert.deepEqual([into.runs.length, into.intoTree], [0, true]);
  assert.ok(!page().automations.threadIds.has("kid"));
  assert.ok(page().settle.some((line) => line.thread.id === "kid"));
  // A thread is listed under one automation only: the paused one's last run is Nightly's already.
  assert.equal(automations.groups.find((group) => group.automation.id === "paused")!.runs.length, 0);
  assert.equal(automations.groups.find((group) => group.automation.id === "script")!.project, "Home");
  assert.deepEqual([...automations.threadIds].sort(), ["asking", "n0", "n1", "n2", "n3", "n4", "n5", "n6"]);
  assert.ok(runThreadIds(READ).includes("nGone"));
});

test("a run that needs the person is in the queue; a finished one is not, nor under To settle, nor counted twice", () => {
  const overview = page();
  assert.deepEqual(overview.queue.map((line) => line.thread.id), ["asking"]);
  assert.equal(overview.queue[0]!.run, "automation:nightly");
  // A run's reply bb has as unread is no one's to read: done, at rest.
  const n0 = listed(overview).find((line) => line.thread.id === "n0")!;
  assert.deepEqual([n0.derived.state, n0.derived.waitingOnYou], ["done", false]);
  assert.deepEqual(overview.settle.map((line) => line.thread.id), ["kid"]);
  // Outside Main counts only what this section does not take.
  assert.equal(overview.outside.byPlugins, 2);
  // The legend counts what is under Main, not runs.
  assert.equal(overview.counts.wants, 0);
  // A failed run is failed, but at rest: it waits on nobody.
  const failedRun = page(world([thread({ id: "f", status: "error", originPluginId: "automations" })]), {
    available: true,
    automations: [{ automation: automation({ id: "f" }), runs: [run("rf", "f", 1)], moreRuns: false }],
  });
  const line = failedRun.automations.groups[0]!.runs[0]!;
  assert.deepEqual([line.derived.state, line.derived.waitingOnYou], ["failed", false]);
  assert.equal(failedRun.queue.length, 0);
});

test("without the plugin there is no section, and Outside Main counts every plugin's thread as before", () => {
  const overview = page(world(), NO_AUTOMATIONS);
  assert.equal(overview.automations.available, false);
  assert.equal(overview.automations.groups.length, 0);
  assert.equal(overview.outside.byPlugins, 10);
  assert.ok(!cursorOrder(overview).includes(AUTOMATIONS_SECTION));
});

test("the section folds, and so does each automation; both start folded", () => {
  const overview = page();
  const order = cursorOrder(overview);
  const at = order.indexOf(AUTOMATIONS_SECTION);
  assert.ok(at >= 0);
  // After Archived and before Outside Main.
  const withOutside = cursorOrder(page(world([thread({ id: "loose" })])));
  assert.ok(withOutside.indexOf(AUTOMATIONS_SECTION) < withOutside.indexOf(OUTSIDE_SECTION));
  assert.ok(!order.includes("automation:nightly"));
  const open = foldMove(overview, new Set(), AUTOMATIONS_SECTION, "l");
  assert.equal(open.kind, "fold");
  const sectionOpen = open.kind === "fold" ? open.folded : new Set<string>();
  assert.deepEqual(cursorOrder(overview, sectionOpen).slice(at, at + 5), [AUTOMATIONS_SECTION, "automation:script", "automation:into", "automation:nightly", "automation:paused"]);
  // l on an automation unfolds its runs; l again steps onto the newest; h on a run goes back to its row.
  const unfolded = foldMove(overview, sectionOpen, "automation:nightly", "l");
  assert.equal(unfolded.kind, "fold");
  const both = unfolded.kind === "fold" ? unfolded.folded : new Set<string>();
  assert.deepEqual(cursorOrder(overview, both).slice(at + 3, at + 9), ["automation:nightly", "asking", "n0", "n1", "n2", "n3"]);
  assert.deepEqual(foldMove(overview, both, "automation:nightly", "l"), { kind: "cursor", id: "asking" });
  assert.deepEqual(foldMove(overview, both, "n1", "h"), { kind: "cursor", id: "automation:nightly" });
  assert.deepEqual(foldMove(overview, both, "automation:nightly", "h"), { kind: "fold", folded: sectionOpen });
  // h on a folded automation, or one with no runs, goes to the heading.
  assert.deepEqual(foldMove(overview, sectionOpen, "automation:into", "h"), { kind: "cursor", id: AUTOMATIONS_SECTION });
  assert.deepEqual(foldMove(overview, sectionOpen, "automation:into", "l"), { kind: "none" });
  // Jumping to a run (the queue's Tab) unfolds the section and its automation.
  const shown = unfoldAround(overview, new Set(), "asking");
  assert.ok(cursorOrder(overview, shown).includes("asking"));
  assert.equal(sectionOf(overview, "asking"), AUTOMATIONS_SECTION);
  assert.equal(sectionOf(overview, "automation:paused"), AUTOMATIONS_SECTION);
  // What is remembered: an unfolded automation is kept while it exists, and until the automations are read.
  assert.ok(keepFolds(overview, both).has("automation:nightly"));
  assert.ok(!keepFolds(overview, new Set(["automation:gone"])).has("automation:gone"));
  assert.ok(keepFolds(page(world(), NO_AUTOMATIONS), new Set(["automation:gone"])).has("automation:gone"));
  // Archiving a run moves the cursor to the next line down.
  assert.equal(afterLeaving(overview, "n1", both), "n2");
});

test("/ finds automations by name, and their runs, while folded", () => {
  const overview = page();
  const found = filterOverview(overview, "nightly");
  assert.ok(found.matches.includes("automation:nightly"));
  const run = filterOverview(overview, "n2 said");
  assert.deepEqual(run.matches, ["n2"]);
  assert.ok(run.keep.has("automation:nightly"));
});

test("a run is archived as any line, but never parked or kept", () => {
  const n0 = listed(page()).find((line) => line.thread.id === "n0")!;
  assert.equal(verbBlocked("archive", n0, false), null);
  assert.equal(verbBlocked("park", n0, false), "it is a run of an automation");
  assert.equal(verbBlocked("keep", n0, false), "it is a run of an automation");
});

test("bb cow status has an Automations heading with the same rows, and --json an automations list", () => {
  const report = statusReport(page(), NOW, false);
  assert.deepEqual(report.automations.map((row) => [row.name, row.next, row.paused]), [
    ["Backup", "in 3h", false],
    ["Into kid", "in 3h", false],
    ["Nightly check", "in 3h", false],
    ["A paused one", "paused", true],
  ]);
  const nightly = report.automations.find((row) => row.id === "nightly")!;
  assert.deepEqual(nightly.runs.map((line) => line.id), ["asking", "n0", "n1", "n2", "n3"]);
  assert.equal(nightly.runs[0]!.queue, 1);
  const text = statusText(report);
  assert.match(text, /Automations: bb's scheduled runs, each with its recent run threads \(4\)/);
  assert.match(text, /Backup \(script\) · script · next: in 3h · last: succeeded 2h ago {2}\[project: Home\]/);
  assert.match(text, /Into kid \(into\) .*\[runs in a thread under Main\]/);
  assert.match(text, /3 older, and more not listed/);
  assert.ok(text.indexOf("Automations:") < text.indexOf("Outside Main:"));
  // Without the plugin, no heading.
  assert.doesNotMatch(statusText(statusReport(page(world(), NO_AUTOMATIONS), NOW, false)), /Automations/);
});

test("a script's last output is what Enter shows", () => {
  const group = page().automations.groups.find((other) => other.automation.id === "script")!;
  assert.equal(scriptOutput(group), "copied 3 files\n\nexit code 0");
  assert.equal(scriptOutput(page().automations.groups.find((other) => other.automation.id === "nightly")!), null);
});

test("the read-through contains a missing, failing or slow plugin", async () => {
  assert.deepEqual(await readAutomations({ call: () => Promise.reject(new Error("no plugin automations")) }), NO_AUTOMATIONS);
  // One automation's runs failing leaves its row, without runs.
  const read = await readAutomations({
    call: async (method, input) => {
      if (method === "automations_overview") {
        return { automations: [{ automation: { id: "a", projectId: "p", enabled: true } }, { automation: { id: "b", projectId: "p", enabled: true } }, { automation: { id: "c", projectId: "p", enabled: false } }] };
      }
      const { automationId } = input as { automationId: string };
      if (automationId === "c") throw new Error("a paused automation's runs are not read");
      if (automationId === "b") throw new Error("failed");
      return { runs: [{ id: "r", status: "succeeded", threadId: "t" }], nextCursor: null };
    },
  });
  assert.equal(read.available, true);
  assert.deepEqual(read.automations.map((entry) => [entry.automation.id, entry.runs.length]), [["a", 1], ["b", 0], ["c", 0]]);
  // A plugin that never answers is given up on.
  const started = Date.now();
  const slow = await readAutomations({ call: (_method, _input, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }, { overviewMs: 50, runsMs: 50 });
  assert.equal(slow.available, false);
  assert.ok(Date.now() - started < 1000);
});

test("the page reads again only when an automation's thread appears or changes", () => {
  const before = runThreadsKey(world());
  assert.equal(runThreadsKey(world().map((t) => (t.id === "kid" ? { ...t, status: "active" } : t))), before);
  assert.notEqual(runThreadsKey(world().map((t) => (t.id === "n0" ? { ...t, status: "active" } : t))), before);
  assert.notEqual(runThreadsKey(world([thread({ id: "new", originPluginId: "automations" })])), before);
});

test("a run bb refused a permission without asking is blocked and in the queue, like any blocked thread; dismissed, it leaves", () => {
  const refusal = { id: "call_1", kind: "command" as const, what: "npm publish", cwd: null, change: null, diff: null, why: "refused", at: NOW - HOUR, seq: 7 };
  const threads = world([thread({ id: "refused", originPluginId: "automations", lastReadAt: NOW })]);
  const read: AutomationsRead = { available: true, automations: [{ automation: automation({ id: "r" }), runs: [run("rr", "refused", 1)], moreRuns: false }] };
  const blockedDerive = (dismissed: number | null) => (t: ThreadFacts) =>
    t.id === "refused" ? derive(t, activity({ output: "tried", refusals: [refusal] }), NOW, null, null, dismissed, { seenSeq: null }) : derived(t);
  const overview = buildOverview(threads, "main", blockedDerive(null), NOW, { note: () => null, todos: () => [], automations: read });
  const line = overview.queue.find((other) => other.thread.id === "refused");
  assert.ok(line, "the blocked run is in the queue");
  assert.deepEqual([line.derived.state, line.run], ["blocked", "automation:r"]);
  assert.equal(line.derived.blocked?.refusals.length, 1);
  const dismissed = buildOverview(threads, "main", blockedDerive(7), NOW, { note: () => null, todos: () => [], automations: read });
  assert.ok(!dismissed.queue.some((other) => other.thread.id === "refused"));
});
