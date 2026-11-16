// Test hooks, read from this tab's session storage. They exist so the
// end-to-end check can move time forward and keep its own tab on its fixture
// project. Neither is a feature: nothing on the page sets them.

import { useEffect, useState } from "react";

const OFFSET_KEY = "cow:test-clock-offset-ms";
const OFFSET_CHANGED = "cow:test-clock";
const PROJECT_KEY = "cow:test-project";
/** How often ages on the page are recomputed. */
const TICK_MS = 20_000;

function stored(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The page's clock: every age and every parked thread's return comes from it. */
export function clockNow(): number {
  const offset = Number(stored(OFFSET_KEY));
  return Date.now() + (Number.isFinite(offset) ? offset : 0);
}

export function useNow(): number {
  const [now, setNow] = useState(clockNow);
  useEffect(() => {
    const tick = () => setNow(clockNow());
    const timer = setInterval(tick, TICK_MS);
    window.addEventListener(OFFSET_CHANGED, tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener(OFFSET_CHANGED, tick);
    };
  }, []);
  return now;
}

/** The project a test has pinned this tab to, whatever project is current elsewhere. */
export function pinnedProjectId(): string | null {
  return stored(PROJECT_KEY) || null;
}
