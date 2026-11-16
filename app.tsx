// cow's frontend entry: one full page, and a command to change Main.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./src/cow.css";
import { CowPage, pageSignal } from "./src/view.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "main",
    title: "cow",
    icon: "Milk",
    path: "main",
    component: CowPage,
  });
  app.commands.register({
    id: "choose-main",
    title: "🐄 cow: choose the Main thread",
    isAvailable: () => pageSignal.mounted,
    run: () => pageSignal.chooseMain?.(),
  });
});
