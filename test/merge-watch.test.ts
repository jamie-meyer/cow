import assert from "node:assert/strict";
import { test } from "node:test";
import { type MergeEnvironment, createMergeWatch } from "../src/merge/backend.ts";
import { type MergeFacts, asksAboutMerging, conflictNote, mergeLineText, mergeSection, statusMerge, statusMergeText } from "../src/merge/text.ts";
import { type StatusReport, mergeCandidates, withMerge } from "../src/status.ts";

const facts = (more: Partial<MergeFacts> = {}): MergeFacts => ({
  state: "clean",
  why: null,
  base: "main",
  branch: "work",
  ahead: 2,
  behind: 3,
  conflicts: [],
  conflictCount: 0,
  dirty: false,
  head: "h1",
  baseTip: "b1",
  at: 1000,
  checkedAt: 1000,
  clone: false,
  ...more,
});
const env: MergeEnvironment = { id: "env1", hostId: "host", path: "/tmp/x", baseBranch: null, defaultBranch: "main" };
const tick = () => new Promise((done) => setTimeout(done, 5));

test("the line: quiet when clean, loud for a conflict, nothing when there is nothing to say", () => {
  assert.deepEqual(mergeLineText(facts())?.text, "3 behind · merges cleanly");
  assert.equal(mergeLineText(facts({ behind: 0 }))?.text, "merges cleanly");
  assert.equal(mergeLineText(facts())?.tone, "quiet");
  const clash = mergeLineText(facts({ state: "conflict", conflicts: ["a.ts", "b.ts"], conflictCount: 2 }));
  assert.equal(clash?.text, "conflicts in 2 files");
  assert.equal(clash?.tone, "loud");
  assert.match(clash?.title ?? "", /a\.ts, b\.ts/);
  assert.equal(mergeLineText(facts({ state: "none", why: "no commits of its own" })), null);
  assert.equal(mergeLineText(null), null);
  assert.equal(mergeLineText(facts({ state: "unknown", why: "timed out" }))?.text, "merge not known");
  assert.match(mergeLineText(facts({ dirty: true }))?.text ?? "", /uncommitted aside/);
});

test("the card: ahead, behind, the base, the files capped with how many more, and when", () => {
  const many = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
  const section = mergeSection(facts({ state: "conflict", conflicts: many, conflictCount: 8, dirty: true, at: 0 }), 5 * 60_000)!;
  assert.equal(section.title, "Merge into main");
  const texts = section.rows.map((row) => row.text);
  assert.equal(texts[0], "conflicts in 8 files");
  assert.deepEqual(texts.slice(1, 6), many.slice(0, 5));
  assert.equal(section.rows[1]!.file, "f0.ts");
  assert.ok(texts.includes("and 3 more"));
  assert.ok(texts.includes("2 ahead · 3 behind"));
  assert.ok(texts.includes("uncommitted changes"));
  assert.ok(texts.includes("worked out 5m ago"));
  assert.equal(mergeSection(facts({ state: "none" }), 0), null);
  assert.equal(mergeSection(facts({ state: "unknown", why: "git rev-list failed" }), 0)!.rows[0]!.detail, "git rev-list failed");
  assert.match(mergeSection(facts({ clone: true }), 0)!.rows.find((row) => row.detail?.includes("source folder"))?.detail ?? "", /source folder/);
});

test("status, and the note beside a brief or an ask about merging", () => {
  const clash = facts({ state: "conflict", conflicts: ["a.ts"], conflictCount: 1 });
  assert.equal(statusMergeText(statusMerge(clash)!), "2 ahead, 3 behind main · conflicts in 1 file: a.ts");
  assert.equal(statusMergeText(statusMerge(facts())!), "2 ahead, 3 behind main · merges cleanly");
  assert.equal(statusMerge(facts({ state: "none" })), null);
  assert.equal(conflictNote(clash), "its branch conflicts with main in 1 file: a.ts");
  assert.equal(conflictNote(facts()), null);
  assert.ok(asksAboutMerging({ question: "Shall I merge it into main?" }));
  assert.ok(asksAboutMerging({ question: "Which way?", options: [{ label: "merged", detail: null }] }));
  assert.ok(!asksAboutMerging({ question: "Which colour?", options: [{ label: "red", detail: null }] }));
  const line = (id: string, state: string) => ({ id, state }) as never;
  const report = { main: line("m", "idle"), queue: [], threads: [line("a", "done"), line("b", "running"), line("m", "idle")], parked: [], settle: [line("c", "done")], kept: [], archived: [line("d", "done")] } as unknown as StatusReport;
  assert.deepEqual(mergeCandidates(report), ["a", "c"]);
  const marked = withMerge(report, { a: statusMerge(clash) });
  assert.equal(marked.threads[0]!.merge?.state, "conflict");
  assert.equal(marked.threads[1]!.merge, undefined);
});

test("the server looks again only after a while, one look per environment at a time, and passes the last answer on", async () => {
  let now = 0;
  const calls: (MergeFacts | null)[] = [];
  let release: (() => void) | null = null;
  let changed = 0;
  const watch = createMergeWatch(
    {
      environmentOf: async () => env,
      compute: async (_environment, known) => {
        calls.push(known);
        await new Promise<void>((done) => (release = done));
        return facts({ at: 1000, checkedAt: now });
      },
      now: () => now,
      changed: () => (changed += 1),
    },
    30_000,
  );
  assert.deepEqual(watch.read(["t1", "t2"]), {});
  await tick();
  // Two threads in one environment: one look.
  assert.equal(calls.length, 1);
  watch.read(["t1"]);
  await tick();
  assert.equal(calls.length, 1);
  release!();
  await tick();
  assert.equal(watch.read(["t1", "t2"]).t1?.state, "clean");
  assert.equal(changed, 1);
  // Within the interval: nothing is asked.
  now = 10_000;
  watch.read(["t1"]);
  await tick();
  assert.equal(calls.length, 1);
  // After it: asked with the last answer, which the host gives back while the tips stand still.
  now = 31_000;
  watch.read(["t1"]);
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.head, "h1");
  release!();
  await tick();
  // The same answer again is no change.
  assert.equal(changed, 1);
});

test("a host that does not answer reads not known, never clean; a thread with no checkout has nothing", async () => {
  const watch = createMergeWatch({
    environmentOf: async (threadId) => (threadId === "none" ? null : env),
    compute: async () => {
      throw new Error("host is not connected");
    },
    now: () => 0,
    changed: () => undefined,
  });
  const got = await watch.settled(["t1", "none"], 2000);
  assert.equal(got.t1?.state, "unknown");
  assert.match(got.t1?.why ?? "", /host is not connected/);
  assert.equal(got.none, undefined);
  // The card only peeks: it starts nothing.
  assert.equal(watch.peek(["t1"]).t1?.state, "unknown");
});
