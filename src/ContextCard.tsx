// The context card on the page: the selected line's at the bottom of the
// right column, above the legend, and the open chat's at the top of the chat
// pane. What is in it comes from cow's server (see `card-backend.ts`); this
// draws it as plain text, one line per row.

import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { cardRpcContract } from "./card-backend.ts";
import { CARD_REST_MS, type Card, CardCache, PANE_OPEN_LINES, cardRowCount, cardShown } from "./card.ts";

/** One window's cards: kept while the page is open, never stored. */
const cache = new CardCache();

/** Whether the card is hidden in this window: the window remembers, a reload included. */
const HIDDEN_KEY = "cow:card-hidden";
export function readCardHidden(): boolean {
  try {
    return window.sessionStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}
export function rememberCardHidden(hidden: boolean): void {
  try {
    if (hidden) window.sessionStorage.setItem(HIDDEN_KEY, "1");
    else window.sessionStorage.removeItem(HIDDEN_KEY);
  } catch {
    // A window that cannot remember shows the card again after a reload.
  }
}

/**
 * The card for `threadId`, read once the cursor has rested on it. While a
 * new one loads, the card kept for that thread shows, or nothing: never
 * another thread's.
 */
export function useCard(threadId: string | null, enabled: boolean): Card | null {
  const rpc = useRpc<typeof cardRpcContract>();
  const [card, setCard] = useState<Card | null>(null);
  const current = useRef(threadId);
  current.current = threadId;
  useEffect(() => {
    if (threadId === null || !enabled) return;
    setCard(cache.get(threadId));
    const read = () => {
      if (cache.fresh(threadId, Date.now())) return;
      rpc.call("card_read", { threadId }).then(
        (answer) => {
          cache.put(answer, Date.now());
          if (current.current === answer.threadId) setCard(answer);
        },
        // Without an answer the card is the one kept, or none.
        () => undefined,
      );
    };
    const rest = setTimeout(read, CARD_REST_MS);
    // A card left in view is read again once it is no longer fresh.
    const again = setInterval(() => {
      if (document.visibilityState !== "hidden") read();
    }, 10_000);
    return () => {
      clearTimeout(rest);
      clearInterval(again);
    };
  }, [rpc, threadId, enabled]);
  return enabled ? cardShown(threadId, card) : null;
}

interface CardProps {
  card: Card;
  where: "side" | "pane";
  onOpenFile: (card: Card, path: string) => void;
  onOpenUrl: (url: string) => void;
}

/** The card itself. Nothing in it is a stop for j and k; f hints its links, files and, folded in the pane, its section titles. */
export function ContextCard({ card, where, onOpenFile, onOpenUrl }: CardProps) {
  const tall = where === "pane" && cardRowCount(card) > PANE_OPEN_LINES;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Folding is per thread: another thread's card starts folded again.
  useEffect(() => setOpen(new Set()), [card.threadId]);
  const toggle = (key: string) =>
    setOpen((before) => {
      const next = new Set(before);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <section className={`cow-ctx cow-ctx-${where}`} data-cow-ctx={card.threadId} aria-label="what bb and other plugins know about this thread" onMouseDown={(event) => event.preventDefault()}>
      {card.sources.map((source) => (
        <div key={source.pluginId} className="cow-ctx-src" data-cow-ctx-source={source.pluginId}>
          {source.sections.map((section, index) => {
            const key = `${source.pluginId}\u0000${index}`;
            const folded = tall && !open.has(key);
            return (
              <div key={key} className="cow-ctx-sec" data-cow-ctx-section={section.title} data-cow-ctx-folded={folded ? "" : undefined}>
                <h4
                  className={tall ? "cow-ctx-h cow-ctx-fold" : "cow-ctx-h"}
                  data-cow-hint={tall ? "" : undefined}
                  onClick={tall ? () => toggle(key) : undefined}
                  title={tall ? (folded ? "show its rows" : "fold it") : undefined}
                >
                  {tall ? <span className="cow-ctx-tw">{folded ? "▸" : "▾"}</span> : null}
                  <span className="cow-ctx-t">{section.title}</span>
                  <span className="cow-ctx-from">{source.name}</span>
                  {folded ? <span className="cow-ctx-n">{section.rows.length}</span> : null}
                </h4>
                {folded
                  ? null
                  : section.rows.map((row, rowIndex) => {
                      const opens = row.file !== undefined ? () => onOpenFile(card, row.file!) : row.url !== undefined ? () => onOpenUrl(row.url!) : undefined;
                      return (
                        <div
                          key={rowIndex}
                          className={["cow-ctx-row", row.current ? "cow-ctx-cur" : "", opens ? "cow-ctx-go" : ""].join(" ").trim()}
                          style={row.indent ? { paddingLeft: `${row.indent * 12 + 4}px` } : undefined}
                          data-cow-ctx-row={row.text}
                          data-cow-ctx-current={row.current ? "" : undefined}
                          data-cow-ctx-file={row.file}
                          data-cow-ctx-url={row.url}
                          data-cow-hint={opens ? "" : undefined}
                          title={[row.text, row.detail, row.url].filter(Boolean).join("\n")}
                          onClick={opens}
                        >
                          <span className="cow-ctx-text">{row.text}</span>
                          {row.detail ? <span className="cow-ctx-detail">{row.detail}</span> : null}
                          {row.badges?.map((badge, badgeIndex) => (
                            <span key={badgeIndex} className={`cow-ctx-b cow-ctx-b-${badge.tone}`} data-cow-ctx-badge={badge.tone}>
                              {badge.text}
                            </span>
                          ))}
                        </div>
                      );
                    })}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
