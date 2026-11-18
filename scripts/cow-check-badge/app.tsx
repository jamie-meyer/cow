// A throwaway plugin for cow's end-to-end checks of other plugins' badges and
// actions. It shows something only on threads titled "cow test", the checks'
// fixtures: one badge, one badge that always throws, and three actions, one
// plain, one disabled, one with choices. The two that run write to the
// thread's metadata in this plugin's own namespace, where the checks read it.
import {
  type ExperimentalThreadRowMetadataProps,
  type PluginSidebarThread,
  definePluginApp,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";

const TITLE = "cow test";

/** The fixtures among bb's threads, by id. */
function useFixtures(): ReadonlySet<string> {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => new Set(threads.filter((thread) => thread.displayTitle === TITLE).map((thread) => thread.id)), [threads]);
}

const isFixture = (thread: PluginSidebarThread) => thread.displayTitle === TITLE;

function Badge({ thread }: ExperimentalThreadRowMetadataProps) {
  if (!isFixture(thread)) return null;
  return (
    <span data-cow-check-badge={thread.id} title="the check's badge">
      ✓ check badge
    </span>
  );
}

function Throws({ thread }: ExperimentalThreadRowMetadataProps) {
  if (!isFixture(thread)) return null;
  throw new Error("the check's badge that always throws");
}

export default definePluginApp((app) => {
  app.slots.experimental_threadRowMetadata({ id: "badge", order: 1, component: Badge });
  app.slots.experimental_threadRowMetadata({ id: "throws", order: 2, component: Throws });
  app.slots.experimental_threadAction({
    id: "plain",
    title: "Check: mark",
    icon: "Check",
    group: "zz-cow-check",
    order: 1,
    useData: useFixtures,
    item: ({ thread, data, sdk }) =>
      data.has(thread.id)
        ? {
            label: "Check: mark",
            detail: "writes the check's metadata",
            icon: "Check",
            run: async () => {
              await sdk.threads.updatePluginMetadata({ threadId: thread.id, set: { marked: Date.now() } });
            },
          }
        : null,
  });
  app.slots.experimental_threadAction({
    id: "disabled",
    title: "Check: disabled",
    icon: "Ban",
    group: "zz-cow-check",
    order: 2,
    useData: useFixtures,
    item: ({ thread, data, sdk }) =>
      data.has(thread.id)
        ? {
            label: "Check: disabled",
            detail: "must never run",
            icon: "Ban",
            disabled: true,
            run: async () => {
              await sdk.threads.updatePluginMetadata({ threadId: thread.id, set: { disabledRan: Date.now() } });
            },
          }
        : null,
  });
  app.slots.experimental_threadAction({
    id: "choose",
    title: "Check: choose",
    icon: "List",
    group: "zz-cow-check",
    order: 3,
    useData: useFixtures,
    item: ({ thread, data, sdk }) =>
      data.has(thread.id)
        ? {
            label: "Check: choose",
            icon: "List",
            choices: {
              heading: "Which one?",
              items: [
                { id: "red", label: "red" },
                { id: "blue", label: "blue" },
                { id: "grey", label: "grey", disabled: true },
              ],
            },
            run: async ({ value }) => {
              await sdk.threads.updatePluginMetadata({ threadId: thread.id, set: { chose: value ?? null } });
            },
          }
        : null,
  });
});
