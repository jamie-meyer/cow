// Asides: things the page says once, quietly, and lets you put away. Two of
// them: bb is outside the version cow was tested on, and cow's own theme
// exists and is not the one in use. A dismissal is remembered in this
// browser's local storage.

import { useCallback, useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { isCowTheme, outsideTested, outsideText, readDismissed, rememberDismissed } from "./support.ts";

interface Aside {
  /** What a dismissal is remembered under. */
  id: string;
  text: string;
  /** A command that goes with it, shown as code. */
  command?: string;
  after?: string;
}

export function useAsides(): { asides: Aside[]; dismiss: (id: string) => void } {
  const sdk = useSdk();
  const [found, setFound] = useState<Aside[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  useEffect(() => {
    let cancelled = false;
    const add = (aside: Aside) => {
      if (!cancelled) setFound((current) => (current.some((other) => other.id === aside.id) ? current : [...current, aside]));
    };
    // Neither is needed for the page to work, so a failure to read one says nothing.
    sdk.system.version().then(
      ({ currentVersion }) => {
        const outside = outsideTested(currentVersion);
        if (outside) add({ id: `bb:${currentVersion}`, text: outsideText(currentVersion, outside) });
      },
      () => undefined,
    );
    Promise.all([sdk.theme.get(), sdk.system.config()]).then(
      ([theme, config]) => {
        if (isCowTheme(theme.themeId)) return;
        // The theme's id carries the id cow is installed under.
        const own = config.pluginThemes.find((entry) => isCowTheme(entry.id) && window.location.pathname.includes(`/plugins/${entry.pluginId}/`));
        if (!own) return;
        add({
          id: "theme",
          text: "cow has a look of its own, paper and ink set in a serif, as a bb theme for the whole app. It is off. Turn it on in Settings → Appearance, or run",
          command: `bb theme set ${own.id}`,
          after: "; bb theme reset goes back.",
        });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  const dismiss = useCallback((id: string) => setDismissed((current) => rememberDismissed(current, id)), []);

  return { asides: found.filter((aside) => !dismissed.includes(aside.id)), dismiss };
}

export function Asides() {
  const { asides, dismiss } = useAsides();
  return (
    <>
      {asides.map((aside) => (
        <p key={aside.id} className="cow-aside" data-cow-aside={aside.id} role="note">
          {aside.text}
          {aside.command ? (
            <>
              {" "}
              <code>{aside.command}</code>
            </>
          ) : null}
          {aside.after ?? ""}{" "}
          <button type="button" className="cow-vb" data-cow-hint="" data-cow-aside-dismiss={aside.id} tabIndex={-1} onClick={() => dismiss(aside.id)}>
            dismiss
          </button>
        </p>
      ))}
    </>
  );
}
