// Short display text made from what a thread said or did.

const MAX_LINE = 160;

/** The first meaningful line of some markdown, as plain text. */
export function firstLine(text: string | null | undefined): string {
  if (!text) return "";
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, "")
      .replace(/[*_`]{1,3}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line && !/^[-=|:\s]+$/.test(line)) {
      return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
    }
  }
  return "";
}

/** One item from a thread's event log, as far as this page reads it. */
export interface EventItem {
  type?: unknown;
  command?: unknown;
  tool?: unknown;
  server?: unknown;
  text?: unknown;
}

/** What an agent's latest step was, in a few words. Empty when unknown. */
export function describeItem(item: EventItem | null | undefined): string {
  if (!item || typeof item.type !== "string") return "";
  switch (item.type) {
    case "commandExecution":
      return typeof item.command === "string" ? `$ ${firstLine(item.command)}` : "running a command";
    case "toolCall": {
      const tool = typeof item.tool === "string" ? item.tool : "a tool";
      return typeof item.server === "string" ? `${item.server}: ${tool}` : `using ${tool}`;
    }
    case "agentMessage":
      return typeof item.text === "string" ? firstLine(item.text) : "";
    case "reasoning":
      return "thinking";
    default:
      return "";
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A compact age: 4m, 3h, 19d, 6w. */
export function formatAge(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ms / HOUR);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(ms / DAY);
  if (days < 28) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
