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
  const link = `${appLinkBase}#${fragment}`;
  reopen.href = link;
  if (document.head.querySelector('link[data-placekeeper-terminal-style]') === null) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/assets/app.css';
    stylesheet.dataset.placekeeperTerminalStyle = 'true';
    document.head.append(stylesheet);
  }

  const heading = document.createElement('h1');
  heading.textContent = 'Reopen this PDF';
  heading.tabIndex = -1;
  const explanation = document.createElement('p');
  explanation.textContent = 'This live review is no longer available. Reopen the current PDF at this location in a fresh review.';
  const addressLabel = document.createElement('label');
  addressLabel.textContent = 'Placekeeper link';
  const address = document.createElement('input');
  address.readOnly = true;
  address.value = link;
  address.setAttribute('aria-label', 'Placekeeper link');
  address.addEventListener('focus', () => address.select());
  addressLabel.append(address);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy Link';
  const copyStatus = document.createElement('p');
  copyStatus.setAttribute('role', 'status');
  let copyPending = false;
  copy.addEventListener('click', () => {
    if (copyPending) return;
    copyPending = true;
    copy.disabled = true;
    copy.setAttribute('aria-busy', 'true');
    copyStatus.textContent = 'Copying link…';
    const write = navigator.clipboard?.writeText;
    const attempt = write === undefined
      ? Promise.reject(new Error('Clipboard API unavailable'))
      : write.call(navigator.clipboard, link);
    void attempt.then(() => {
      copyStatus.textContent = 'Link copied.';
    }).catch(() => {
      copyStatus.setAttribute('role', 'alert');
      copyStatus.textContent = 'Clipboard access failed. Select and copy the link above, or retry.';
      copy.textContent = 'Retry';
    }).finally(() => {
      copyPending = false;
      copy.disabled = false;
      copy.removeAttribute('aria-busy');
      copy.focus({ preventScroll: true });
    });
  });

  recovery.replaceChildren(heading, explanation, reopen, copy, addressLabel, copyStatus);
  requestAnimationFrame(() => heading.focus({ preventScroll: true }));
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
