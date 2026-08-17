import { createRoot } from "react-dom/client";

import {
  decodePlacekeeperLinkFragment,
  encodePlacekeeperLinkFragment,
} from "../../../packages/core/src/placekeeper-link.js";
import { ProductionReviewApp, type ProductionSession } from "./app/ProductionReviewApp.js";
import { loadProductionSession, resumeProductionSession } from "./app/session-api.js";

export async function resume(viewId: string, pathname: string): Promise<void> {
  await start(await resumeProductionSession(viewId, pathname));
}

export function showTerminalRecovery(): void {
  const recovery = document.querySelector<HTMLElement>("[data-terminal-recovery]");
  const reopen = recovery?.querySelector<HTMLAnchorElement>("[data-placekeeper-reopen]");
  const appLinkBase = reopen?.dataset.appLinkBase;
  if (
    recovery === null ||
    reopen === null ||
    reopen === undefined ||
    appLinkBase === undefined
  ) return;
  let fragment = encodePlacekeeperLinkFragment({ kind: "page", page: 1 });
  try {
    fragment = encodePlacekeeperLinkFragment(
      decodePlacekeeperLinkFragment(window.location.hash.slice(1)),
    );
  } catch {
    // Invalid or future fragments recover conservatively at page 1.
  }
  reopen.href = `${appLinkBase}#${fragment}`;
}

export async function start(session: ProductionSession): Promise<void> {
  const root = document.querySelector("#root");
  if (!(root instanceof HTMLElement)) throw new Error("Production review root is unavailable");
  root.dataset.productionRoot = "true";
  const loaded = await loadProductionSession(session);
  createRoot(root).render(
    <ProductionReviewApp
      session={session}
      initialState={loaded.state}
      initialSaveStatus={loaded.saveStatus}
      scope={loaded.scope}
      api={loaded.api}
    />,
  );
}
