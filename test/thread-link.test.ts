import assert from "node:assert/strict";
import { test } from "node:test";
import { threadFromHref, threadFromMention } from "../src/reader/threadLink.ts";

test("a mention of a thread names it in what bb keeps on the link; a mention of anything else is not a thread link", () => {
  assert.equal(threadFromMention('{"kind":"thread","threadId":"thr_abc123","projectId":"proj_x","label":"cow test"}'), "thr_abc123");
  assert.equal(threadFromMention('{"kind":"thread","threadId":"thr_abc123","label":"thr_abc123"}'), "thr_abc123");
  assert.equal(threadFromMention('{"kind":"file","path":"README.md"}'), null);
  assert.equal(threadFromMention('{"kind":"thread","threadId":"../etc"}'), null);
  assert.equal(threadFromMention("not json"), null);
  assert.equal(threadFromMention(undefined), null);
});

test("bb's own address of a thread, with or without its project, is a thread link; anything else is not", () => {
  assert.equal(threadFromHref("/projects/proj_x/threads/thr_abc123"), "thr_abc123");
  assert.equal(threadFromHref("/threads/thr_abc123"), "thr_abc123");
  assert.equal(threadFromHref("http://127.0.0.1:38886/projects/proj_x/threads/thr_abc123", "http://127.0.0.1:38886"), "thr_abc123");
  assert.equal(threadFromHref("https://example.com/projects/proj_x/threads/thr_abc123", "http://127.0.0.1:38886"), null);
  assert.equal(threadFromHref("/projects/proj_x/threads/thr_abc123/files"), null);
  assert.equal(threadFromHref("/projects/proj_x"), null);
  assert.equal(threadFromHref("file:///tmp/threads/thr_abc123"), null);
  assert.equal(threadFromHref("threads/thr_abc123"), null);
});
