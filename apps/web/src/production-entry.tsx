import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import {
  decodePlacekeeperLink,
  decodePlacekeeperLinkFragment,
  encodePlacekeeperLinkFragment,
} from "../../../packages/core/src/placekeeper-link.js";
import { ProductionReviewApp, type ProductionSession } from "./app/ProductionReviewApp.js";
import {
  reopenProductionSession,
  resumeProductionSession,
  type ReopenRecoveryChoice,
} from "./app/session-api.js";
import {
  createCopyLinkCommand,
  type CopyLinkStatus,
} from "./review/CopyLinkControl.js";
import { ReviewIcon, type ReviewIconName } from "./review/ReviewIcon.js";
import { createBrowserHostRuntime } from "./host/browser-runtime.js";
import { createRpcHostRuntime, createVscodeMessagePort } from "./host/vscode-runtime.js";
import type { HostRuntime, HostRuntimeBootstrap } from "./host/runtime.js";
import { subscribeRuntimeDocumentSource } from "./host/runtime-document-source.js";

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

export function terminalRecoveryDocumentIdentity(appLinkBase: string): {
  readonly filename: string;
} {
  const { path } = decodePlacekeeperLink(`${appLinkBase}#v=1&page=1`);
  const parts = path.split("/");
  return {
    filename: parts.at(-1)!,
  };
}

export function showTerminalRecovery(viewId: string): void {
  if (!/^[0-9a-f-]{36}$/u.test(viewId)) return;
  const recovery = document.querySelector<HTMLElement>("[data-terminal-recovery]");
  const fallback = recovery?.querySelector<HTMLAnchorElement>("[data-placekeeper-reopen]");
  const appLinkBase = fallback?.dataset.appLinkBase;
  if (
    recovery === null ||
    fallback === null ||
    fallback === undefined ||
    appLinkBase === undefined
  ) return;
  const fragment = terminalRecoveryLocationFragment(window.location.hash);
  const link = `${appLinkBase}#${fragment}`;
  const identity = terminalRecoveryDocumentIdentity(appLinkBase);
  fallback.href = link;
  if (document.head.querySelector('link[data-placekeeper-terminal-style]') === null) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = '/assets/app.css';
    stylesheet.dataset.placekeeperTerminalStyle = 'true';
    document.head.append(stylesheet);
  }

  recovery.dataset.terminalRecovery = 'enhanced';
  recovery.className = 'terminal-recovery';
  const header = document.createElement('header');
  header.className = 'terminal-recovery__header';
  const heading = document.createElement('h1');
  heading.textContent = `Reopen ${identity.filename}`;
  heading.tabIndex = -1;
  header.replaceChildren(heading);
  const body = document.createElement('section');
  body.className = 'terminal-recovery__body';
  const explanation = document.createElement('p');
  explanation.id = 'terminal-recovery-explanation';
  const stateStatus = document.createElement('p');
  stateStatus.className = 'terminal-recovery__status';
  stateStatus.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'terminal-recovery__actions';
  body.replaceChildren(explanation, stateStatus, actions);
  const footer = document.createElement('footer');
  footer.className = 'terminal-recovery__footer';
  const footerActions = document.createElement('div');
  footerActions.className = 'terminal-recovery__footer-actions';
  const copyActions = document.createElement('div');
  copyActions.className = 'terminal-recovery__copy-actions';
  const primaryActions = document.createElement('div');
  primaryActions.className = 'terminal-recovery__primary-actions';
  const copyStatus = document.createElement('p');
  copyStatus.className = 'terminal-recovery__copy-status';
  copyStatus.setAttribute('role', 'status');
  footerActions.replaceChildren(copyActions, primaryActions);
  footer.replaceChildren(footerActions, copyStatus);

  const buttonViews = new WeakMap<HTMLButtonElement, {
    readonly iconRoot: ReturnType<typeof createRoot>;
    readonly label: HTMLSpanElement;
  }>();
  const setButtonContent = (
    control: HTMLButtonElement,
    iconName: ReviewIconName,
    label: string,
  ): void => {
    let view = buttonViews.get(control);
    if (view === undefined) {
      const icon = document.createElement('span');
      icon.className = 'terminal-recovery__button-icon';
      icon.setAttribute('aria-hidden', 'true');
      const labelElement = document.createElement('span');
      control.replaceChildren(icon, labelElement);
      view = { iconRoot: createRoot(icon), label: labelElement };
      buttonViews.set(control, view);
    }
    control.dataset.icon = iconName;
    view.iconRoot.render(<ReviewIcon name={iconName} size={14} />);
    view.label.textContent = label;
  };

  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.title = 'Reopen';
  reopen.className = 'terminal-recovery__primary';
  reopen.setAttribute('aria-describedby', explanation.id);
  setButtonContent(reopen, 'redo', 'Reopen');
  let reopenPending = false;
  let activeOffer: Extract<Awaited<ReturnType<typeof reopenProductionSession>>, {
    readonly kind: 'recovery-offered';
  }> | undefined;
  const operationIds = new Map<ReopenRecoveryChoice, string>();
  const operationId = (choice: ReopenRecoveryChoice): string => {
    const existing = operationIds.get(choice);
    if (existing !== undefined) return existing;
    const created = globalThis.crypto.randomUUID();
    operationIds.set(choice, created);
    return created;
  };
  const focusSoon = (target: HTMLElement): void => {
    queueMicrotask(() => target.focus());
  };
  const button = (
    label: string,
    iconName: ReviewIconName,
    onClick: () => void,
    className = 'terminal-recovery__secondary',
  ): HTMLButtonElement => {
    const control = document.createElement('button');
    control.type = 'button';
    control.title = label;
    control.className = className;
    setButtonContent(control, iconName, label);
    control.addEventListener('click', onClick);
    return control;
  };
  const consequenceAction = (
    control: HTMLButtonElement,
    consequence: string,
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'terminal-recovery__choice';
    const copy = document.createElement('p');
    copy.textContent = consequence;
    group.replaceChildren(control, copy);
    return group;
  };
  const showError = (message: string, draftChoice: boolean): void => {
    reopenPending = false;
    stateStatus.setAttribute('role', 'alert');
    stateStatus.tabIndex = -1;
    stateStatus.textContent = message;
    stateStatus.hidden = false;
    if (draftChoice && activeOffer !== undefined) renderRecoveryOffer(false);
    else renderOrdinary(false);
    focusSoon(stateStatus);
  };
  const renderOrdinary = (clearStatus = true): void => {
    explanation.textContent = 'This Placekeeper session was interrupted. Reopen it at the same location. If unfinished work is available, Placekeeper will show the safe recovery choices next.';
    if (clearStatus) {
      stateStatus.hidden = true;
      stateStatus.textContent = '';
      stateStatus.setAttribute('role', 'status');
    }
    reopen.disabled = reopenPending;
    reopen.toggleAttribute('aria-busy', reopenPending);
    setButtonContent(reopen, reopenPending ? 'loading' : 'redo', 'Reopen');
    actions.replaceChildren();
    primaryActions.replaceChildren(reopen);
  };
  const renderRecoveryOffer = (clearStatus = true): void => {
    if (activeOffer === undefined) return;
    explanation.textContent = `Placekeeper found unfinished work for ${identity.filename}. Choose what should happen to that protected draft.`;
    if (clearStatus) {
      stateStatus.hidden = true;
      stateStatus.textContent = '';
      stateStatus.setAttribute('role', 'status');
    }
    const resume = button('Resume draft', 'redo', () => void requestReopen('resume'), 'terminal-recovery__primary');
    const discard = button('Discard draft', 'delete', renderDiscardConfirmation, 'terminal-recovery__destructive');
    const fork = button('Open separate copy', 'plus', () => void requestReopen('fork'));
    primaryActions.replaceChildren();
    actions.replaceChildren(
      consequenceAction(resume, 'Continue the protected draft with all unfinished work.'),
      consequenceAction(discard, 'Permanently remove the protected draft and reopen the PDF without it.'),
      consequenceAction(fork, 'Keep the protected draft and open an independent session.'),
    );
    if (reopenPending) {
      for (const control of actions.querySelectorAll('button')) control.disabled = true;
    }
    if (clearStatus) focusSoon(resume);
  };
  const renderDiscardConfirmation = (): void => {
    explanation.textContent = `Permanently discard the unfinished draft for ${identity.filename}? This cannot be undone. A replacement session will be opened before the protected draft is removed.`;
    stateStatus.hidden = true;
    primaryActions.replaceChildren();
    const confirm = button(
      'Permanently discard draft',
      'delete',
      () => void requestReopen('discard'),
      'terminal-recovery__destructive',
    );
    const cancel = button('Keep draft', 'close', () => renderRecoveryOffer());
    actions.replaceChildren(confirm, cancel);
    focusSoon(confirm);
  };
  const requestReopen = async (recoveryChoice?: ReopenRecoveryChoice) => {
    if (reopenPending) return;
    reopenPending = true;
    stateStatus.setAttribute('role', 'status');
    stateStatus.removeAttribute('tabindex');
    stateStatus.textContent = recoveryChoice === undefined ? 'Checking for unfinished work…' : 'Opening session…';
    stateStatus.hidden = false;
    if (activeOffer === undefined) renderOrdinary(false);
    else renderRecoveryOffer(false);
    try {
      const result = await reopenProductionSession(viewId, link, {
        confirmed: true,
        ...(recoveryChoice === undefined || activeOffer === undefined
          ? {}
          : {
              recovery: recoveryChoice,
              recoveryOffer: activeOffer.recoveryOffer,
              recoveryOperationId: operationId(recoveryChoice),
            }),
      });
      if (result.kind === 'opened' || result.kind === 'focused') {
        window.location.assign(result.url);
        return;
      }
      if (result.kind === 'recovery-offered') {
        activeOffer = result;
        operationIds.clear();
        reopenPending = false;
        renderRecoveryOffer();
        return;
      }
      if (result.kind === 'recovery-refresh-required') {
        activeOffer = undefined;
        operationIds.clear();
        showError(
          'Those recovery choices are no longer current. Reopen the session to check for protected work again.',
          false,
        );
        return;
      }
      throw new Error('The PDF could not be reopened.');
    } catch {
      showError(
        activeOffer === undefined
          ? 'Placekeeper could not reopen this PDF here. Retry the reopen action.'
          : 'Placekeeper could not complete that draft choice. The protected draft and all choices remain available.',
        activeOffer !== undefined,
      );
    }
  };
  reopen.addEventListener('click', (event) => {
    event.preventDefault();
    void requestReopen();
  });
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.title = 'Copy Link';
  copy.className = 'terminal-recovery__secondary';
  setButtonContent(copy, 'link', 'Copy Link');
  const renderCopyStatus = (status: CopyLinkStatus) => {
    const pending = status.status === 'pending';
    copy.disabled = pending;
    if (pending) copy.setAttribute('aria-busy', 'true');
    else copy.removeAttribute('aria-busy');
    copyStatus.setAttribute('role', status.status === 'failure' ? 'alert' : 'status');
    if (status.status === 'pending') {
      copyStatus.textContent = 'Copying Placekeeper link…';
      setButtonContent(copy, 'loading', 'Copy Link');
    }
    else if (status.status === 'success') {
      copyStatus.textContent = 'Placekeeper link copied.';
      copy.title = 'Copy Link';
      setButtonContent(copy, 'link', 'Copy Link');
      copyActions.replaceChildren(copy);
    }
    else if (status.status === 'failure') {
      copyStatus.textContent = 'Clipboard access failed. Retry or select the canonical Placekeeper link.';
      copy.title = 'Retry copying Placekeeper link';
      setButtonContent(copy, 'redo', 'Retry');
      const fallbackValue = document.createElement('input');
      fallbackValue.readOnly = true;
      fallbackValue.value = link;
      fallbackValue.setAttribute('aria-label', 'Canonical Placekeeper link');
      fallbackValue.addEventListener('focus', () => fallbackValue.select());
      copyActions.replaceChildren(copy, fallbackValue);
      focusSoon(copy);
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
  copyActions.replaceChildren(copy);

  renderOrdinary();
  recovery.replaceChildren(header, body, footer);
  requestAnimationFrame(() => heading.focus({ preventScroll: true }));
}

export async function start(session: ProductionSession): Promise<void> {
  await startRuntime(createBrowserHostRuntime(session));
}

export async function startRuntime(runtime: HostRuntime): Promise<void> {
  const root = document.querySelector("#root");
  if (!(root instanceof HTMLElement)) throw new Error("Production review root is unavailable");
  root.dataset.productionRoot = "true";
  const loaded = await runtime.bootstrap();
  createRoot(root).render(
    <RuntimeProductionReviewApp runtime={runtime} initial={loaded} />,
  );
}

function RuntimeProductionReviewApp(props: {
  readonly runtime: HostRuntime;
  readonly initial: HostRuntimeBootstrap;
}) {
  const [loaded, setLoaded] = useState(props.initial);
  const [refreshStatus, setRefreshStatus] = useState<"idle" | "reconciling" | "failed">("idle");

  useEffect(() => subscribeRuntimeDocumentSource(props.runtime, props.initial, (snapshot) => {
    setLoaded(snapshot.loaded);
    setRefreshStatus(snapshot.refreshStatus);
  }), [props.initial, props.runtime]);

  return <ProductionReviewApp
    session={loaded.session}
    initialState={loaded.state}
    initialSaveStatus={loaded.saveStatus}
    scope={loaded.scope}
    api={props.runtime}
    viewerAssets={loaded.viewerAssets}
    resourcePolicy={loaded.resourcePolicy}
    generationRefreshStatus={refreshStatus}
  />;
}

export async function startVscode(options: {
  readonly panelId: string;
  readonly vscode: { postMessage(message: unknown): unknown };
}): Promise<void> {
  const runtime = createRpcHostRuntime(createVscodeMessagePort(options.panelId, options.vscode));
  globalThis.addEventListener("pagehide", () => runtime.dispose(), { once: true });
  await startRuntime(runtime);
}
