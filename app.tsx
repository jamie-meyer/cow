// cow's frontend entry: one full page, a command that opens it from anywhere,
// and a command to change Main.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/cow.css";
import { NavigateHolder, canOpenPage, openPage } from "./src/opener.tsx";
import { CowPage, pageSignal } from "./src/view.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "main",
    title: "cow",
    icon: "Milk",
    path: "main",
    component: CowPage,
  });
  app.slots.experimental_appOverlay({ id: "navigate", component: NavigateHolder });
  app.commands.register({
    id: "open",
    title: "🐄 cow: open cow's page",
    defaultShortcut: { key: "c", control: true, alt: true },
    isAvailable: canOpenPage,
    run: openPage,
  });
  app.commands.register({
    id: "choose-main",
    title: "🐄 cow: choose the Main thread",
    isAvailable: () => pageSignal.mounted,
    run: () => pageSignal.chooseMain?.(),
  });
});
