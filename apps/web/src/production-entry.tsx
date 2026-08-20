import { createRoot } from "react-dom/client";

import {
  decodePlacekeeperLinkFragment,
  type PlacekeeperLinkLocation,
} from "../../../packages/core/src/placekeeper-link.js";
import { ProductionReviewApp, type ProductionSession } from "./app/ProductionReviewApp.js";
import {
  loadProductionSession,
  reopenProductionSession,
  resumeProductionSession,
  type ReopenRecoveryChoice,
} from "./app/session-api.js";
import {
  buildPlacekeeperCopyLink,
  createCopyLinkCommand,
  type CopyLinkStatus,
} from "./review/CopyLinkControl.js";

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
  let location: PlacekeeperLinkLocation = { kind: "page", page: 1 };
  try {
    location = decodePlacekeeperLinkFragment(window.location.hash.slice(1));
  } catch {
    // Invalid or future fragments recover conservatively at page 1.
  }
  const link = buildPlacekeeperCopyLink(appLinkBase, location);
  const browserLink = buildPlacekeeperCopyLink(
    `${window.location.origin}${window.location.pathname}`,
    location,
  );
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
  const reopenStatus = document.createElement('p');
  reopenStatus.setAttribute('role', 'status');
  const reopenActions = document.createElement('div');
  let reopenPending = false;
  const requestReopen = async (options: {
    readonly confirmed?: true;
    readonly recovery?: ReopenRecoveryChoice;
  } = {}) => {
    if (reopenPending) return;
    reopenPending = true;
    reopen.setAttribute('aria-busy', 'true');
    reopen.setAttribute('aria-disabled', 'true');
    reopenStatus.setAttribute('role', 'status');
    reopenStatus.textContent = 'Opening…';
    reopenActions.replaceChildren();
    try {
      const result = await reopenProductionSession(link, options);
      if (result.kind === 'opened' || result.kind === 'focused') {
        window.location.assign(result.url);
        return;
      }
      if (result.kind === 'confirmation-required') {
        reopenStatus.textContent = 'Confirm opening the local PDF named in the Placekeeper link below.';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.textContent = 'Open this PDF';
        confirm.title = 'Open this PDF';
        confirm.addEventListener('click', () => { void requestReopen({ confirmed: true }); });
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.title = 'Cancel';
        cancel.addEventListener('click', () => {
          reopenActions.replaceChildren();
          reopenStatus.textContent = '';
          reopen.focus({ preventScroll: true });
        });
        reopenActions.replaceChildren(confirm, cancel);
        queueMicrotask(() => confirm.focus({ preventScroll: true }));
        return;
      }
      if (result.kind === 'recovery-offered') {
        reopenStatus.textContent = 'Choose how to handle the recovered draft.';
        const labels = {
          resume: 'Resume draft',
          discard: 'Discard draft',
          fork: 'Open separate copy',
        } as const;
        reopenActions.replaceChildren(...result.choices.map((choice) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = labels[choice];
          button.title = labels[choice];
          button.addEventListener('click', () => {
            void requestReopen({ ...options, recovery: choice });
          });
          return button;
        }));
        queueMicrotask(() => reopenActions.querySelector('button')?.focus({ preventScroll: true }));
        return;
      }
      throw new Error('The PDF could not be reopened.');
    } catch {
      reopenStatus.setAttribute('role', 'alert');
      reopenStatus.textContent = 'Placekeeper could not reopen this PDF here. Use the Placekeeper task link below in Codex chat to reconnect it to this task.';
    } finally {
      reopenPending = false;
      reopen.removeAttribute('aria-busy');
      reopen.removeAttribute('aria-disabled');
    }
  };
  reopen.addEventListener('click', (event) => {
    event.preventDefault();
    void requestReopen();
  });
  reopen.removeAttribute('aria-disabled');
  const addressLabel = document.createElement('label');
  addressLabel.textContent = 'Browser link';
  const address = document.createElement('input');
  address.readOnly = true;
  address.value = browserLink;
  address.setAttribute('aria-label', 'Browser link');
  address.addEventListener('focus', () => address.select());
  addressLabel.append(address);
  const taskAddressLabel = document.createElement('label');
  taskAddressLabel.textContent = 'Placekeeper task link';
  const taskAddress = document.createElement('input');
  taskAddress.readOnly = true;
  taskAddress.value = link;
  taskAddress.setAttribute('aria-label', 'Placekeeper link');
  taskAddress.addEventListener('focus', () => taskAddress.select());
  taskAddressLabel.append(taskAddress);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy Link';
  copy.title = 'Copy Link';
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
    getLink: () => browserLink,
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

  recovery.replaceChildren(
    heading,
    explanation,
    reopen,
    reopenStatus,
    reopenActions,
    copy,
    addressLabel,
    taskAddressLabel,
    copyStatus,
  );
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
