// What `c` shows under a line: the capabilities that apply to that thread,
// where each comes from, and what waits to be acknowledged on it. Read-only.

import { formatAge } from "../text.ts";
import { kindText, ruleText } from "./cap.ts";
import { type Held, sourceText } from "./scope.ts";
import type { Notice, Use } from "./service.ts";

export function HeldCard({
  threadId,
  held,
  fresh,
  use,
  outside,
  titleOf,
  now,
}: {
  threadId: string;
  held: readonly Held[];
  /** The ids of the capabilities whose notice has not been acknowledged. */
  fresh: ReadonlySet<string>;
  use: Use | null;
  outside: readonly Notice[];
  titleOf: (threadId: string) => string;
  now: number;
}) {
  return (
    <div className="cow-ans cow-perm cow-held" data-cow-capsfor={threadId} data-cow-capsfor-count={held.length} role="group" aria-label="the capabilities this thread holds">
      <p className="cow-perm-kind">
        Capabilities of this thread ·{" "}
        {held.length === 0 ? "it holds none: every permission request it raises is yours to decide" : `it holds ${held.length}: cow allows what ${held.length === 1 ? "it covers" : "they cover"}, once, each time bb asks`}
      </p>
      {held.map(({ capability, source }) => (
        <p key={capability.id} className="cow-perm-row cow-held-row" data-cow-capsfor-item={capability.id} data-cow-capsfor-from={source.from} data-cow-capsfor-new={fresh.has(capability.id) || undefined}>
          <span>{kindText(capability.rule)}</span>
          <span>
            {fresh.has(capability.id) ? <b className="cow-cap-tag">new</b> : null}
            <b>{capability.name}</b> <code>{ruleText(capability.rule)}</code>
            <small>
              {" "}
              · {sourceText(source, titleOf)} · {capability.uses === 0 ? "never used" : `used ${capability.uses}×`}
            </small>
          </span>
        </p>
      ))}
      {use ? (
        <p className="cow-perm-row" data-cow-capsfor-use={use.count}>
          <span>allowed here</span>
          <small>
            {use.count} {use.count === 1 ? "request" : "requests"}; last by <b>{use.name}</b>, {formatAge(Math.max(0, now - use.lastAt))} ago: {use.what}
          </small>
        </p>
      ) : null}
      {outside.map((notice) => (
        <p key={notice.id} className="cow-perm-row" data-cow-capsfor-outside={notice.id}>
          <span>not cow</span>
          <small>
            {notice.text} · {formatAge(Math.max(0, now - notice.at))} ago · <kbd>␣</kbd> on the line acknowledges it
          </small>
        </p>
      ))}
      <p className="cow-ans-keys">
        <kbd>c</kbd> <kbd>Esc</kbd> close · <kbd>C</kbd> every capability, the log, and where to make, delete and acknowledge them
      </p>
    </div>
  );
}
