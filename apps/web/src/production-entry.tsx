import { createRoot } from "react-dom/client";

import { ProductionReviewApp, type ProductionSession } from "./app/ProductionReviewApp.js";
import { loadProductionSession, resumeProductionSession } from "./app/session-api.js";

export async function resume(viewId: string, pathname: string): Promise<void> {
  await start(await resumeProductionSession(viewId, pathname));
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
