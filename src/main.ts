// The page: one column of panels, one log. Every panel re-renders from
// scratch after an action — there is no state here worth diffing.

// First, and before every other import: the Solana packages read `Buffer` at
// module top level, and imports evaluate before this file's body.
import "./polyfill.ts";

import { type Lab, buildLab } from "./lab.ts";
import { corePanel } from "./panels/core.ts";
import { fundingPanel } from "./panels/funding.ts";
import { participantsPanel, refreshBalances } from "./panels/participants.ts";
import { subscriptionPanel } from "./panels/subscription.ts";
import { tasksPanel } from "./panels/tasks.ts";
import { el, log, section } from "./ui.ts";
import { onWalletsChanged } from "./wallet.ts";

async function main(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;

  const render = (lab: Lab): void => {
    app.replaceChildren(
      el("h1", { textContent: "Crown Lab — devnet" }),
      el("div", { className: "muted" }, [
        `профиль ${lab.profile} · реплика ${lab.icHost} · всё ниже — настоящий devnet и настоящие канистры`,
      ]),
      participantsPanel(lab),
      corePanel(lab),
      tasksPanel(lab),
      fundingPanel(lab),
      subscriptionPanel(lab),
      section("Журнал", logBox),
    );
  };

  // The log survives re-renders: it is the record of the session.
  const logBox = el("div", { id: "log" });

  let lab: Lab;
  const refresh = (): void => render(lab);
  lab = await buildLab(refresh);
  render(lab);
  // Wallet extensions announce themselves after load; repaint when they do.
  onWalletsChanged(refresh);

  log(`лаборатория поднята: профиль ${lab.profile}, сеть ${lab.chainId}`, "ok");
  const missing = Object.entries(lab.ids)
    .filter(([, id]) => !id)
    .map(([name]) => name);
  if (missing.length > 0) {
    log(`canister id не заданы: ${missing.join(", ")} — запусти scripts/lab-up.sh и перезапусти vite`, "wait");
  }
  if (lab.participants.length > 0) await refreshBalances(lab);
}

void main().catch((error: unknown) => {
  const app = document.getElementById("app");
  if (app) app.textContent = `не поднялось: ${error instanceof Error ? error.message : String(error)}`;
});
