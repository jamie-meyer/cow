// Where the log is kept: appended to, and read whole. The capability service
// and the key service both write here, so there is one numbering and one
// chain. Nothing in this module removes or rewrites an entry.

import { z } from "zod";
import { type Kv, serial } from "../kv.ts";
import { type ChainCheck, type Hash, type LogEntry, type LogEvent, checkChain, logEntrySchema, nextEntry } from "./log.ts";

const LOG = "caplog:";
const LOG_HEAD = "caplog-head";
const pad = (seq: number): string => String(seq).padStart(10, "0");

export interface LogStore {
  /** Add an entry. `by`: the fingerprint of the key that signed the call it records, or null for what cow did or saw by itself. */
  append(event: LogEvent, by: string | null): Promise<LogEntry>;
  /** Every entry, oldest first. */
  all(): Promise<readonly LogEntry[]>;
  /** Whether the numbering and the hashes hold, end included. */
  check(): Promise<ChainCheck>;
}

export function createLogStore(deps: { kv: Kv; now(): number; hash: Hash }): LogStore {
  const { kv } = deps;
  const locked = serial();
  /** The whole log, oldest first. This process is the only writer, so it is read from storage once. */
  let entries: LogEntry[] | null = null;
  const load = async (): Promise<LogEntry[]> => {
    if (entries === null) {
      const keys = await kv.list(LOG);
      const found = await Promise.all(keys.map(async (key) => logEntrySchema.safeParse(await kv.get(key))));
      entries = found.flatMap((entry) => (entry.success ? [entry.data] : [])).sort((a, b) => a.seq - b.seq);
    }
    return entries;
  };
  return {
    all: load,
    append: (event, by) =>
      locked("log", async () => {
        const log = await load();
        const entry = nextEntry(log[log.length - 1] ?? null, event, deps.now(), deps.hash, by);
        await kv.set(LOG + pad(entry.seq), entry);
        await kv.set(LOG_HEAD, { seq: entry.seq, hash: entry.hash });
        log.push(entry);
        return entry;
      }),
    async check() {
      const head = z.object({ seq: z.number(), hash: z.string() }).safeParse(await kv.get(LOG_HEAD));
      return checkChain(await load(), deps.hash, head.success ? head.data : null);
    },
  };
}
