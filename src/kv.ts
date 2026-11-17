// The small part of bb's key-value storage that asks and briefs are kept in.
// It lives in the plugin's own storage on the server, not on a thread, so an
// agent cannot rewrite the record of what was asked, answered or audited by
// editing its thread's metadata.

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/** Run jobs that share a key one after another, so a read-then-write is never interleaved. */
export function serial(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(job, job);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** A refusal the caller can act on: what is wrong, and what to do instead. */
export class Refusal extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}
