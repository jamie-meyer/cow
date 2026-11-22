// The transcript reader (src/transcript/read.ts), on lines in the real shape:
// transcript-sample.jsonl is a fixture's main transcript over two turns and a
// compaction, and transcript-subagent-sample.jsonl its sub-agent's file, each
// kept with only the fields read and its message ids replaced. bb's figure for
// the two turns was 208,307 tokens: 14 input, 166,924 cache read, 40,327 cache
// write, 1,042 output; for the first turn alone 100,889.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MAX_READ_BYTES, type TranscriptRead, folderNameOf, readTranscriptUsage, usageOfLines } from "../src/transcript/read.ts";

const MAIN = readFileSync(new URL("./transcript-sample.jsonl", import.meta.url), "utf8");
const SUB = readFileSync(new URL("./transcript-subagent-sample.jsonl", import.meta.url), "utf8");
const SESSION = "0a1b2c3d-1111-2222-3333-444455556666";
const ENV = "/work/env.one";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cow-transcript-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
let homes = 0;
/** A home folder of the test's own, with the transcript for ENV and SESSION holding `text`. */
function home(text: string | null, env = ENV): { home: string; file: string; folder: string } {
  const h = join(scratch, `home${(homes += 1)}`);
  const folder = join(h, ".claude", "projects", folderNameOf(env));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${SESSION}.jsonl`);
  if (text !== null) writeFileSync(file, text);
  return { home: h, file, folder };
}
const sum = (read: TranscriptRead) => {
  assert.equal(read.status, "read");
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const m of read.status === "read" ? read.messages : []) {
    t.input += m.input;
    t.cacheRead += m.cacheRead;
    t.cacheWrite += m.cacheWrite;
    t.output += m.output;
  }
  return t;
};
const BB_TOTAL = { input: 14, cacheRead: 166924, cacheWrite: 40327, output: 1042 };

test("the folder is the path with every character but letters and digits made a dash", () => {
  assert.equal(folderNameOf("/private/var/folders/6_/xy/T/cowfix.Ab12"), "-private-var-folders-6--xy-T-cowfix-Ab12");
  assert.equal(folderNameOf("/Users/me/0/cow"), "-Users-me-0-cow");
});

test("a fixture's transcript: each message id counted once, equal to bb's figure; sidechain entries are not counted", () => {
  const entries = MAIN.split("\n").filter((line) => line.includes('"usage"')).length;
  const got = usageOfLines(MAIN);
  assert.equal(entries, 9, "nine entries with usage");
  assert.equal(got.messages.length, 6, "six messages: the usage repeats across one message's entries");
  const { home: h } = home(MAIN);
  assert.deepEqual(sum(readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h)), BB_TOTAL);
  // The first turn alone, up to the compaction.
  const firstTurn = MAIN.slice(0, MAIN.indexOf('"compact_boundary"'));
  const first = usageOfLines(firstTurn.slice(0, firstTurn.lastIndexOf("\n") + 1)).messages;
  assert.equal(first.reduce((n, m) => n + m.input + m.cacheRead + m.cacheWrite + m.output, 0), 100889);
  // A sub-agent's entries, were they in the main file, are skipped and counted as skipped.
  const mixed = usageOfLines(MAIN + SUB);
  assert.equal(mixed.messages.length, 6);
  assert.equal(mixed.sidechain, 3);
});

test("a sub-agent's own file, beside the main one, is never read", () => {
  const { home: h, folder } = home(MAIN);
  mkdirSync(join(folder, SESSION, "subagents"), { recursive: true });
  writeFileSync(join(folder, SESSION, "subagents", "agent-a1.jsonl"), SUB.replace(/"isSidechain": true/g, '"isSidechain": false'));
  assert.deepEqual(sum(readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h)), BB_TOTAL);
});

test("a repeated message id counts once, the largest of each count when its entries differ", () => {
  const line = (output: number) => JSON.stringify({ type: "assistant", timestamp: "2026-11-21T10:00:00.000Z", isSidechain: false, message: { id: "msg_x", model: "claude-haiku-5-5", usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: output } } });
  const got = usageOfLines(`${line(1)}\n${line(7)}\n${line(7)}\n`);
  assert.equal(got.messages.length, 1);
  assert.deepEqual({ ...got.messages[0], key: "-" }, { key: "-", model: "claude-haiku-5-5", at: Date.parse("2026-11-21T10:00:00.000Z"), input: 3, cacheRead: 10, cacheWrite: 5, output: 7 });
});

test("a half-written last line is left for the next read, and a read from an offset returns only what is new", () => {
  const lines = MAIN.split("\n").filter((l) => l !== "");
  const cut = lines.findIndex((l) => l.includes("msg_sample04"));
  const head = `${lines.slice(0, cut).join("\n")}\n`;
  const half = lines[cut]!.slice(0, 40);
  const { home: h, file } = home(head + half);
  const one = readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h);
  assert.equal(one.status, "read");
  if (one.status !== "read") return;
  assert.equal(one.offset, Buffer.byteLength(head), "it stops at the last complete line");
  assert.deepEqual(one.messages.map((m) => m.key).length, 3);
  // Nothing new yet: the same offset, nothing counted.
  const again = readTranscriptUsage({ path: ENV, session: SESSION, offset: one.offset, partial: false }, h);
  assert.equal(again.status === "read" && again.messages.length, 0);
  assert.equal(again.status === "read" && again.offset, one.offset);
  appendFileSync(file, `${lines[cut]!.slice(40)}\n${lines.slice(cut + 1).join("\n")}\n`);
  const two = readTranscriptUsage({ path: ENV, session: SESSION, offset: one.offset, partial: false }, h);
  assert.equal(two.status, "read");
  if (two.status !== "read") return;
  assert.equal(two.messages.length, 3, "only the messages after the offset");
  const firstKeys = new Set(one.messages.map((m) => m.key));
  assert.ok(two.messages.every((m) => !firstKeys.has(m.key)));
  const total = sum(one);
  const rest = sum(two);
  assert.deepEqual({ input: total.input + rest.input, cacheRead: total.cacheRead + rest.cacheRead, cacheWrite: total.cacheWrite + rest.cacheWrite, output: total.output + rest.output }, BB_TOTAL);
});

test("at most the stated bytes a call: small reads add up to the same, and a line longer than one read is passed over", () => {
  const { home: h } = home(MAIN);
  const keys = new Map<string, number>();
  let offset = 0;
  let partial = false;
  for (let n = 0; n < 10_000; n += 1) {
    const got = readTranscriptUsage({ path: ENV, session: SESSION, offset, partial, maxBytes: 2048 }, h);
    assert.equal(got.status, "read");
    if (got.status !== "read") break;
    assert.ok(got.offset - offset <= 2048);
    for (const m of got.messages) keys.set(m.key, m.input + m.cacheRead + m.cacheWrite + m.output);
    if (got.offset === offset && !got.partial) break;
    offset = got.offset;
    partial = got.partial;
    if (offset >= got.size) break;
  }
  assert.equal([...keys.values()].reduce((a, b) => a + b, 0), 208307);
  // One line longer than a read: skipped, and the reads go on after it.
  const long = JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "msg_long", model: "m", usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, content: "x".repeat(5000) } });
  const short = JSON.stringify({ type: "assistant", isSidechain: false, message: { id: "msg_short", model: "m", usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 } } });
  const { home: h2 } = home(`${long}\n${short}\n`);
  let at = { offset: 0, partial: false };
  const seen: number[] = [];
  for (let n = 0; n < 20; n += 1) {
    const got = readTranscriptUsage({ path: ENV, session: SESSION, ...at, maxBytes: 1024 }, h2);
    if (got.status !== "read") break;
    seen.push(...got.messages.map((m) => m.input));
    if (got.offset >= got.size) break;
    at = { offset: got.offset, partial: got.partial };
  }
  assert.deepEqual(seen, [2]);
  assert.ok(MAX_READ_BYTES >= 1024 * 1024);
});

test("nothing but numbers, the model and a hashed id leave it: marker strings in every text field stay behind", () => {
  const marker = (field: string) => `MARKER_${field}_9f3`;
  const lines = [
    { type: "user", cwd: `/home/${marker("cwd")}`, gitBranch: marker("branch"), message: { role: "user", content: marker("prompt") }, isSidechain: false },
    {
      type: "assistant",
      timestamp: "2026-11-21T10:00:00.000Z",
      cwd: `/home/${marker("cwd")}`,
      gitBranch: marker("branch"),
      sessionId: SESSION,
      uuid: marker("uuid"),
      isSidechain: false,
      requestId: marker("request"),
      message: {
        id: "msg_markers",
        model: "claude-haiku-5-5",
        role: "assistant",
        content: [
          { type: "text", text: marker("text") },
          { type: "thinking", thinking: marker("thinking") },
          { type: "tool_use", id: marker("tooluse"), name: marker("toolname"), input: { command: marker("command"), file_path: `/x/${marker("file")}` } },
        ],
        stop_reason: marker("stop"),
        usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4, service_tier: marker("tier"), server_tool_use: { note: marker("usage") } },
      },
      toolUseResult: { stdout: marker("stdout"), filenames: [marker("filename")] },
    },
    { type: "summary", summary: marker("summary"), leafUuid: marker("leaf") },
    // A model or an id that is not one is not passed on either.
    { type: "assistant", isSidechain: false, message: { id: "msg_bad_model", model: `${marker("model")} with spaces`, usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: "assistant", isSidechain: false, message: { id: `${marker("id")} /etc/passwd`, model: "m", usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
  ];
  const { home: h } = home(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const got = readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h);
  const out = JSON.stringify(got);
  assert.ok(!out.includes("MARKER"), out);
  assert.ok(!out.includes("msg_markers"), "the message id leaves only as a hash");
  assert.ok(!out.includes(scratch) && !out.includes("/home/"), "no path");
  assert.equal(got.status === "read" && got.messages.length, 2);
  assert.deepEqual(got.status === "read" && got.messages.map((m) => m.model), ["claude-haiku-5-5", "unknown"]);
});

test("a session id with a slash or dots is refused, and nothing is opened", () => {
  const { home: h } = home(MAIN);
  for (const session of ["../x", "a/b", "a.b", "..", `${SESSION}.jsonl`, "", "x\0y"]) {
    const got = readTranscriptUsage({ path: ENV, session, offset: 0, partial: false }, h);
    assert.deepEqual(got, { status: "none", why: "the session id is not a plain id" }, session);
  }
});

test("a link in place of the file, or of its folder, is not followed; a missing file is no usage known", () => {
  // The file a link would lead to.
  const elsewhere = join(scratch, "elsewhere.jsonl");
  writeFileSync(elsewhere, MAIN);
  const { home: h, file } = home(null);
  symlinkSync(elsewhere, file);
  assert.equal(readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h).status, "none");
  // The folder a link: not followed either.
  const h2 = join(scratch, "home-linked");
  const real = join(scratch, "real-folder");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, `${SESSION}.jsonl`), MAIN);
  mkdirSync(join(h2, ".claude", "projects"), { recursive: true });
  symlinkSync(real, join(h2, ".claude", "projects", folderNameOf(ENV)));
  assert.equal(readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h2).status, "none");
  // Nothing there: none, not an error.
  const { home: h3 } = home(null);
  assert.deepEqual(readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, h3), { status: "none", why: "there is no transcript for this session" });
  assert.equal(readTranscriptUsage({ path: ENV, session: SESSION, offset: 0, partial: false }, join(scratch, "no-home")).status, "none");
});

test("a file shorter than the offset is read again from the start, and says so", () => {
  const { home: h } = home(MAIN);
  const got = readTranscriptUsage({ path: ENV, session: SESSION, offset: MAIN.length + 100, partial: false }, h);
  assert.equal(got.status === "read" && got.reset, true);
  assert.deepEqual(sum(got), BB_TOTAL);
});
