import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CARD_LIMITS,
  type Card,
  CardCache,
  FILES_NAMED,
  cardIsEmpty,
  cardShown,
  cardThreadOf,
  changedFilesSection,
  orderSources,
  plain,
  pullRequestSection,
  readCardAnswer,
  safeUrl,
} from "../src/card.ts";
import { type CardDeps, readCard } from "../src/card-backend.ts";

test("a well-formed answer is kept as it is", () => {
  const sections = readCardAnswer({
    sections: [
      {
        title: "Stack",
        rows: [
          { text: "#1 base", badges: [{ text: "merged", tone: "ok" }] },
          { text: "#2 this", current: true, indent: 1, url: "https://example.com/2", detail: "head → base" },
        ],
      },
    ],
  });
  assert.deepEqual(sections, [
    {
      title: "Stack",
      rows: [
        { text: "#1 base", badges: [{ text: "merged", tone: "ok" }] },
        { text: "#2 this", current: true, indent: 1, url: "https://example.com/2", detail: "head → base" },
      ],
    },
  ]);
});

test("malformed sections, rows and badges are dropped, and nothing else is taken from a row", () => {
  const sections = readCardAnswer({
    sections: [
      { title: "", rows: [{ text: "no title" }] },
      { title: "no rows", rows: "none" },
      "not a section",
      {
        title: "Kept",
        rows: [
          { text: 42 },
          { text: "   " },
          null,
          { text: "ok", tone: "bad", file: "/etc/passwd", indent: 5, current: "yes", badges: [{ text: "x", tone: "loud" }, { text: "", tone: "ok" }, { text: "fine", tone: "warn" }] },
        ],
      },
      { title: "only bad rows", rows: [{ text: null }] },
    ],
  });
  assert.deepEqual(sections, [{ title: "Kept", rows: [{ text: "ok", badges: [{ text: "fine", tone: "warn" }] }] }]);
  assert.deepEqual(readCardAnswer(null), []);
  assert.deepEqual(readCardAnswer({ sections: {} }), []);
  assert.deepEqual(readCardAnswer("sections"), []);
});

test("text is one line of plain text, cut with an ellipsis at the limits", () => {
  assert.equal(plain("a\nb\t\u0007c d", 50), "a b c d");
  const long = readCardAnswer({ sections: [{ title: "t".repeat(200), rows: [{ text: "x".repeat(1000), detail: "y".repeat(1000), badges: [{ text: "z".repeat(100), tone: "ok" }] }] }] });
  const row = long[0]!.rows[0]!;
  assert.equal([...long[0]!.title].length, CARD_LIMITS.title);
  assert.equal([...row.text].length, CARD_LIMITS.text);
  assert.ok(row.text.endsWith("…"));
  assert.equal([...row.detail!].length, CARD_LIMITS.detail);
  assert.equal([...row.badges![0]!.text].length, CARD_LIMITS.badgeText);
  assert.equal(plain("<b>bold</b>", 50), "<b>bold</b>", "markup is kept as text, never read as markup");
});

test("the counts are capped: sections, rows and badges beyond them are left out", () => {
  const many = readCardAnswer({
    sections: Array.from({ length: 10 }, (_, s) => ({
      title: `s${s}`,
      rows: Array.from({ length: 50 }, (_, r) => ({ text: `r${r}`, badges: Array.from({ length: 9 }, (_, b) => ({ text: `b${b}`, tone: "muted" })) })),
    })),
  });
  assert.equal(many.length, CARD_LIMITS.sections);
  assert.equal(many[0]!.rows.length, CARD_LIMITS.rows);
  assert.equal(many[0]!.rows[0]!.badges!.length, CARD_LIMITS.badges);
});

test("only http and https links are kept", () => {
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeUrl("http://example.com"), "http://example.com/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "//example.com", "not a url", 7, `https://e.com/${"a".repeat(3000)}`]) assert.equal(safeUrl(bad), null, String(bad).slice(0, 40));
  assert.deepEqual(readCardAnswer({ sections: [{ title: "t", rows: [{ text: "x", url: "javascript:alert(1)" }] }] })[0]!.rows[0], { text: "x" });
});

test("bb's own sections come first, then other plugins by name, then id; empty sources are left out", () => {
  const source = (pluginId: string, name: string, empty = false) => ({ pluginId, name, sections: empty ? [] : [{ title: "t", rows: [{ text: "r" }] }] });
  const ordered = orderSources([source("zeta", "Alpha"), source("beta", "Beta"), source("alpha", "Alpha"), source("bb", "bb"), source("quiet", "Quiet", true)]);
  assert.deepEqual(
    ordered.map((s) => s.pluginId),
    ["bb", "alpha", "zeta", "beta"],
  );
});

test("the pull request's section: number, title, state, checks, review, link", () => {
  const answer = {
    env1: {
      outcome: "available",
      pullRequest: { number: 12, title: "Fix it", state: "open", url: "https://github.com/o/r/pull/12", headRefName: "fix", baseRefName: "main", checks: { state: "failing" }, review: { state: "approved" } },
    },
  };
  assert.deepEqual(pullRequestSection(answer, "env1"), {
    title: "Pull request",
    rows: [
      {
        text: "#12 Fix it",
        url: "https://github.com/o/r/pull/12",
        detail: "fix → main",
        badges: [
          { text: "open", tone: "info" },
          { text: "checks fail", tone: "bad" },
          { text: "approved", tone: "ok" },
        ],
      },
    ],
  });
  assert.equal(pullRequestSection({ env1: { outcome: "absent" } }, "env1"), null);
  assert.equal(pullRequestSection(answer, "env2"), null);
  assert.equal(pullRequestSection("garbage", "env1"), null);
});

test("changed files: committed and uncommitted, each once, the first few named and the rest counted", () => {
  const files = (paths: string[]) => paths.map((path) => ({ path }));
  const answer = {
    env1: {
      outcome: "available",
      workspace: {
        mergeBase: { files: files(["a.ts", "b.ts", "c.ts"]) },
        workingTree: { files: files(["b.ts", "d.ts", "e.ts", "f.ts"]) },
        allChanges: { fileCount: 6 },
      },
    },
  };
  const section = changedFilesSection(answer, "env1")!;
  assert.equal(section.title, "Changed files · 6");
  assert.deepEqual(
    section.rows.slice(0, FILES_NAMED).map((row) => row.file),
    ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
  );
  assert.equal(section.rows[FILES_NAMED]!.text, "and 1 more");
  assert.equal(changedFilesSection({ env1: { outcome: "available", workspace: { workingTree: { files: [] }, mergeBase: { files: [] }, allChanges: { fileCount: 0 } } } }, "env1"), null);
  assert.equal(changedFilesSection({ env1: { outcome: "not_applicable" } }, "env1"), null);
});

test("a card is only ever shown under its own thread's line, and never when empty", () => {
  const card: Card = { threadId: "t1", environmentId: null, sources: [{ pluginId: "x", name: "X", sections: [{ title: "s", rows: [{ text: "r" }] }] }] };
  assert.equal(cardShown("t1", card), card);
  assert.equal(cardShown("t2", card), null);
  assert.equal(cardShown(null, card), null);
  assert.equal(cardShown("t1", { ...card, sources: [] }), null);
  assert.ok(cardIsEmpty(null));
});

test("which lines get a card: thread lines, not headings, automations' rows or not-started items", () => {
  const known = new Set(["thr_a", "thr_b"]);
  const isThread = (id: string) => known.has(id);
  assert.equal(cardThreadOf("thr_a", isThread), "thr_a");
  assert.equal(cardThreadOf("section:kept", isThread), null);
  assert.equal(cardThreadOf("automation:p:1", isThread), null);
  assert.equal(cardThreadOf("todo:thr_a:1", isThread), null);
  assert.equal(cardThreadOf("thr_gone", isThread), null);
  assert.equal(cardThreadOf(null, isThread), null);
});

test("the cache keeps each thread's card, fresh for a while", () => {
  const cache = new CardCache(30_000);
  const card: Card = { threadId: "t1", environmentId: null, sources: [] };
  assert.equal(cache.get("t1"), null);
  assert.equal(cache.fresh("t1", 0), false);
  cache.put(card, 1000);
  assert.equal(cache.get("t1"), card);
  assert.equal(cache.fresh("t1", 30_999), true);
  assert.equal(cache.fresh("t1", 31_000), false);
  assert.equal(cache.get("t1"), card, "a stale card is still shown while the new one loads");
  assert.equal(cache.get("t2"), null);
});

function deps(over: Partial<CardDeps> = {}): CardDeps {
  return {
    ownPluginId: "cow",
    environmentOf: async () => "env1",
    providers: async () => [
      { pluginId: "stack", name: "Stack" },
      { pluginId: "cow", name: "cow" },
    ],
    call: async (pluginId, method, input) => {
      if (pluginId === "bb--github-pr-status") return { env1: { outcome: "absent" } };
      if (pluginId === "bb--git") return { env1: { outcome: "available", workspace: { workingTree: { files: [{ path: "x.ts" }] } } } };
      if (pluginId === "stack" && method === "cow_card") return { sections: [{ title: "Stack", rows: [{ text: `for ${(input as { threadId: string }).threadId}` }] }] };
      throw new Error(`unexpected ${pluginId} ${method}`);
    },
    ...over,
  };
}

test("a thread's card: bb's own, then each plugin that answers, never cow's own", async () => {
  const card = await readCard(deps(), "t1");
  assert.equal(card.environmentId, "env1");
  assert.deepEqual(
    card.sources.map((s) => [s.pluginId, s.sections.map((x) => x.title)]),
    [
      ["bb", ["Changed files · 1"]],
      ["stack", ["Stack"]],
    ],
  );
  assert.equal(card.sources[1]!.sections[0]!.rows[0]!.text, "for t1");
});

test("a plugin that fails or is slow leaves only its own sections out", async () => {
  const slow = deps({
    providers: async () => [
      { pluginId: "slow", name: "Slow" },
      { pluginId: "broken", name: "Broken" },
      { pluginId: "stack", name: "Stack" },
    ],
    call: async (pluginId, method, input, signal) => {
      if (pluginId === "slow") return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ sections: [] })));
      if (pluginId === "broken") throw new Error("no");
      return deps().call(pluginId, method, input, signal);
    },
  });
  const started = Date.now();
  const card = await readCard(slow, "t1", { pluginMs: 50, bbMs: 200 });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(
    card.sources.map((s) => s.pluginId),
    ["bb", "stack"],
  );
});

test("without an environment, or with bb's plugins failing, bb's sections are left out", async () => {
  const card = await readCard(deps({ environmentOf: async () => null }), "t1");
  assert.deepEqual(
    card.sources.map((s) => s.pluginId),
    ["stack"],
  );
  const failing = await readCard(deps({ providers: async () => { throw new Error("no discovery"); }, call: async () => { throw new Error("down"); } }), "t1");
  assert.deepEqual(failing.sources, []);
});
