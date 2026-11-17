// Links to bb threads inside the chat in cow's pane. bb draws a mention of a
// thread (`@thread:thr_…` in a message) as a link whose
// `data-prompt-mention-resource` names the thread, and its own links to a
// thread (the parent named above the composer) as plain links to
// `/projects/<project>/threads/<thread>`. A plain click on either opens that
// thread in cow's pane instead of bb's own chat page.

const ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The thread a link's address points at, or null. Only bb's own addresses: a path on this origin. */
export function threadFromHref(href: string, origin?: string): string | null {
  let path = href.trim();
  if (origin && path.startsWith(origin)) path = path.slice(origin.length);
  const found = /^\/(?:projects\/[^/?#]+\/)?threads\/([^/?#]+)\/?$/.exec(path);
  return found && ID.test(found[1]!) ? found[1]! : null;
}

/** The thread a mention names, from what bb keeps on it; null for a mention of anything else. */
export function threadFromMention(resource: string | undefined): string | null {
  if (!resource) return null;
  try {
    const value = JSON.parse(resource) as Record<string, unknown>;
    return value.kind === "thread" && typeof value.threadId === "string" && ID.test(value.threadId) ? value.threadId : null;
  } catch {
    return null;
  }
}

/** The thread a click on `element` in the chat would open, or null when it is not on a link to one. */
export function classifyThreadLink(element: Element, origin?: string): string | null {
  if (!element.closest("[data-cow-chat]")) return null;
  const anchor = element.closest<HTMLElement>("a[href]");
  if (!anchor) return null;
  const mention = anchor.getAttribute("data-prompt-mention-resource");
  if (mention !== null) return threadFromMention(mention);
  return threadFromHref(anchor.getAttribute("href") ?? "", origin);
}
