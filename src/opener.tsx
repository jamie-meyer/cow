// "Open cow's page" from anywhere in bb.
//
// A command's run() is handed no navigate, and useBbNavigate() is a hook. So
// a component bb mounts once per window, whatever screen is showing (an app
// overlay, which renders nothing here), holds on to this plugin's navigate,
// and the command uses that.
import { type BbNavigate, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { pageSignal } from "./view.tsx";

let navigate: BbNavigate | null = null;

/** Mounted app-wide: keeps this plugin's navigate where the command can reach it. */
export function NavigateHolder(): null {
  const current = useBbNavigate();
  useEffect(() => {
    navigate = current;
    return () => {
      if (navigate === current) navigate = null;
    };
  }, [current]);
  return null;
}

/** Whether the command can do anything: the holder has mounted. */
export function canOpenPage(): boolean {
  return navigate !== null;
}

/** Go to cow's page; when it is already in view, leave it as it is, open chat and all, and give it the keyboard. */
export function openPage(): void {
  if (pageSignal.mounted) {
    pageSignal.focus?.();
    return;
  }
  navigate?.toPluginPanel("main");
}
