import { createRoot } from "react-dom/client";

import {
  decodePlacekeeperLinkFragment,
  encodePlacekeeperLinkFragment,
} from "../../../packages/core/src/placekeeper-link.js";
import { ProductionReviewApp, type ProductionSession } from "./app/ProductionReviewApp.js";
import { loadProductionSession, resumeProductionSession } from "./app/session-api.js";
import {
  createCopyLinkCommand,
  type CopyLinkStatus,
} from "./review/CopyLinkControl.js";

export async function resume(viewId: string, pathname: string): Promise<void> {
  await start(await resumeProductionSession(viewId, pathname));
}

/** Preserves any canonical readable location while stale routes shed all live-session authority. */
export function terminalRecoveryLocationFragment(hash: string): string {
  let fragment = encodePlacekeeperLinkFragment({ kind: "page", page: 1 });
  try {
    fragment = encodePlacekeeperLinkFragment(
      decodePlacekeeperLinkFragment(hash.replace(/^#/u, "")),
    );
  } catch {
    // Invalid or future fragments recover conservatively at page 1.
  }
  return fragment;
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
  const fragment = terminalRecoveryLocationFragment(window.location.hash);
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
  const renderCopyStatus = (status: CopyLinkStatus) => {
    const pending = status.status === 'pending';
    copy.disabled = pending;
    if (pending) copy.setAttribute('aria-busy', 'true');
    else copy.removeAttribute('aria-busy');
    copyStatus.setAttribute('role', status.status === 'failure' ? 'alert' : 'status');
    if (status.status === 'pending') copyStatus.textContent = 'Copying link…';
    else if (status.status === 'success') copyStatus.textContent = 'Link copied.';
    else if (status.status === 'failure') {
      copyStatus.textContent = 'Clipboard access failed. Select and copy the link above, or retry.';
      copy.textContent = 'Retry';
    }
  };
  const copyCommand = createCopyLinkCommand({
    getLink: () => link,
    writeText: async (value) => {
      const write = navigator.clipboard?.writeText;
      if (write === undefined) throw new Error('Clipboard API unavailable');
      await write.call(navigator.clipboard, value);
    },
    onStatus: renderCopyStatus,
  });
  copy.addEventListener('click', () => {
    void copyCommand.run().finally(() => {
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
