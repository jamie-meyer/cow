// One timer on cow's server, shared by the checks that run on a clock: the
// usage line's notices (every few minutes) and the caps and stuck checks
// (every minute). Each job runs at most once per its period, never two of
// the same at once, and the first tick waits for the rest of cow to load.

/** The timer ticks this often; a job's period is a multiple of it, or rounds up to one. */
export const TICK_MS = 60_000;
/** The first tick, once cow has loaded. */
export const FIRST_TICK_MS = 20_000;

export interface Ticker {
  /** Run `job` every `periodMs`, from the first tick. */
  every(name: string, periodMs: number, job: () => Promise<unknown>): void;
  /** Run every job now: what a test's clock does. */
  tick(): Promise<void>;
  stop(): void;
}

export function createTicker(now: () => number = Date.now, warn: (text: string) => void = () => undefined, timers = true): Ticker {
  const jobs = new Map<string, { periodMs: number; job: () => Promise<unknown>; last: number | null; running: boolean }>();
  const tick = async () => {
    const at = now();
    await Promise.all(
      [...jobs.entries()].map(async ([name, entry]) => {
        // A little early is on time: the timer drifts.
        if (entry.running || (entry.last !== null && at - entry.last < entry.periodMs - 1000)) return;
        entry.running = true;
        entry.last = at;
        try {
          await entry.job();
        } catch (cause) {
          warn(`${name}: ${String(cause)}`);
        } finally {
          entry.running = false;
        }
      }),
    );
  };
  const first = timers ? setTimeout(() => void tick(), FIRST_TICK_MS) : null;
  const interval = timers ? setInterval(() => void tick(), TICK_MS) : null;
  return {
    every: (name, periodMs, job) => void jobs.set(name, { periodMs, job, last: null, running: false }),
    tick,
    stop: () => {
      if (first) clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
