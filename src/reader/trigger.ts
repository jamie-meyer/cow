// What makes the reader open: a click, or a hint, on something on cow's
// page that names a file. cow hears the click before bb does and bb never
// opens its side panel. A file tab that bb opens on cow's page all the same
// is closed in the same moment, and the reader shows what it would have.

import { useCallback, useLayoutEffect, useRef } from "react";
import { experimental_useAppPanel as useAppPanel, experimental_usePanelTabs as usePanelTabs } from "@get-bb/plugin-sdk/app";
import type { OpenTarget } from "./files.ts";
import { type TabFile, parseFileHref, parseTimelineRow, tabFile } from "./link.ts";

export interface ClickHost {
  /** cow's page. */
  root: () => HTMLElement | null;
  /** The thread whose chat is open in the pane. */
  paneThread: () => string | null;
  open: (target: OpenTarget) => void;
  /** A link inside the file the reader is showing. False when it is not to a file. */
  openLink: (href: string) => boolean;
}

/** A link of cow's own to a file: what `data-cow-file` holds. */
export function fileAttribute(target: Extract<OpenTarget, { kind: "rooted" }>): string {
  return JSON.stringify(target);
}

function ownTarget(raw: string | undefined): OpenTarget | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.kind !== "rooted" || typeof value.relPath !== "string" || (value.root !== "workspace" && value.root !== "storage")) return null;
    return { kind: "rooted", threadId: typeof value.threadId === "string" ? value.threadId : null, root: value.root, relPath: value.relPath, lines: null };
  } catch {
    return null;
  }
}

/** What a click on `element` would open in the reader, or null. A link inside the reader is answered with "link". */
export function classifyClick(element: Element, paneThread: string | null): OpenTarget | { kind: "link"; href: string } | null {
  const own = element.closest<HTMLElement>("[data-cow-file]");
  if (own) return ownTarget(own.dataset.cowFile);
  const anchor = element.closest("a[href]");
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (anchor.closest("[data-cow-reader]")) return { kind: "link", href };
    const file = parseFileHref(href);
    if (!file) return null;
    return { kind: "path", threadId: anchor.closest("[data-cow-chat]") ? paneThread : null, path: file.path, lines: file.lines };
  }
  // A file change in a chat's timeline: the row's own heading, not the diff bb draws under it.
  const toggle = element.closest("button[aria-expanded]");
  if (!toggle || !toggle.closest("[data-cow-chat]") || element.closest("[data-timeline-file-diff]")) return null;
  const row = toggle.closest<HTMLElement>("[data-timeline-row-id]");
  const change = row ? parseTimelineRow(row.dataset.timelineRowId ?? "") : null;
  return change ? { kind: "change", threadId: change.threadId, rowId: change.rowId, path: change.path } : null;
}

/**
 * Hear clicks on cow's page before bb does. A plain click on a file opens
 * the reader and goes no further; a click with Cmd, Ctrl, Alt or Shift held
 * is left to bb, as is everything that is not a file.
 */
export function attachFileClicks(host: ClickHost): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const element = event.target instanceof Element ? event.target : null;
    const root = host.root();
    if (!element || !root || !root.contains(element)) return;
    const found = classifyClick(element, host.paneThread());
    if (found === null) return;
    if (found.kind === "link") {
      if (!host.openLink(found.href)) return;
    } else host.open(found);
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", onClick, { capture: true });
  return () => window.removeEventListener("click", onClick, { capture: true });
}

export interface PanelFiles {
  /** The next file tab is one cow asked bb for: leave it open. */
  allowNext: () => void;
  /** Close the file tab bb is showing beside the page. False when there is none. */
  closeShown: () => boolean;
}

/** How long after cow asks bb for a file tab that tab is taken to be the one asked for. */
const ALLOW_MS = 3000;

/** Watch the side panel of cow's page: a file tab cow did not ask for is closed at once and handed to `open`. */
export function usePanelFiles(open: (file: TabFile) => void): PanelFiles {
  const panel = useAppPanel();
  const tabs = usePanelTabs();
  const known = useRef<Set<string> | null>(null);
  const allowUntil = useRef(0);
  const live = useRef({ open, panel, tabs });
  live.current = { open, panel, tabs };

  // A layout effect, so the tab is gone before the panel is ever painted.
  useLayoutEffect(() => {
    const before = known.current;
    known.current = new Set(tabs.tabs.map((tab) => tab.key));
    // Tabs that were open when the page was: they were opened on purpose, some other time.
    if (before === null) return;
    let taken: TabFile | null = null;
    let left = tabs.tabs.length;
    for (const tab of tabs.tabs) {
      if (before.has(tab.key)) continue;
      const file = tabFile(tab.detail);
      if (file === null || !tab.closable || Date.now() < allowUntil.current) continue;
      if (panel.closeTab(tab.key)) {
        known.current.delete(tab.key);
        taken = file;
        left -= 1;
      }
    }
    if (taken === null) return;
    if (left === 0) panel.close();
    live.current.open(taken);
  }, [tabs, panel]);

  const allowNext = useCallback(() => {
    allowUntil.current = Date.now() + ALLOW_MS;
  }, []);
  const closeShown = useCallback(() => {
    const now = live.current.tabs;
    if (!now.open) return false;
    const shown = now.tabs.find((tab) => tab.key === now.selectedKey);
    if (!shown || !shown.closable || tabFile(shown.detail) === null) return false;
    if (!live.current.panel.closeTab(shown.key)) return false;
    if (now.tabs.length === 1) live.current.panel.close();
    return true;
  }, []);
  return { allowNext, closeShown };
}
