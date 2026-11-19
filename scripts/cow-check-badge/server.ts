// The check plugin's server: cow's context-card contract, `cow_card`,
// registered as discoverable so cow finds it without being configured. It
// answers only for "cow test" threads that are under another thread: two
// sections, a stack of three rows (the middle one is this thread) with two
// badges each, a row with a link, an oversized row cow must cut, and a
// malformed row cow must drop. Every other thread gets nothing.
import { type BbPluginApi, defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const TITLE = "cow test";

const contract = defineRpcContract({
  cow_card: {
    input: z.object({ threadId: z.string() }),
    // The answer is deliberately not all in cow's shape: cow reads it without trusting it.
    output: z.object({ sections: z.array(z.unknown()) }),
  },
});

export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.rpc.register(
    contract,
    {
      cow_card: async ({ threadId }) => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.title !== TITLE || !thread.parentThreadId) return { sections: [] };
        const tail = threadId.slice(-4);
        return {
          sections: [
            {
              title: "Check stack",
              rows: [
                { text: "#101 check base", badges: [{ text: "merged", tone: "ok" }, { text: "ci ok", tone: "ok" }] },
                { text: `#102 check this thread ${tail}`, current: true, indent: 1, badges: [{ text: "open", tone: "info" }, { text: "ci running", tone: "warn" }] },
                { text: "#103 check top", indent: 2, badges: [{ text: "draft", tone: "muted" }, { text: "ci failed", tone: "bad" }] },
              ],
            },
            {
              title: "Check extras",
              rows: [
                { text: "check link", url: "https://example.com/cow-check", detail: "opens outside bb" },
                { text: `check oversized ${"x".repeat(600)}`, detail: "y".repeat(600), badges: Array.from({ length: 9 }, (_, n) => ({ text: `b${n}`, tone: "muted" })) },
                { text: 42, url: "javascript:alert(1)", badges: "none" },
              ],
            },
          ],
        };
      },
    },
    { experimental_discoverable: true, experimental_description: "cow's context card: sections for cow's end-to-end check fixtures." },
  );
}
