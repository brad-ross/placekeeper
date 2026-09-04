import { createRoot } from "react-dom/client";
import {
  Component,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";

import {
  decodePlacekeeperLink,
  decodePlacekeeperLinkFragment,
  encodePlacekeeperLinkFragment,
} from "../../../packages/core/src/placekeeper-link.js";
import { createReviewState } from "../../../packages/core/src/review-model.js";
import { isReviewPanelKey } from "../../../packages/core/src/review-runtime-protocol.js";
import {
  ProductionReviewApp,
  type HostForwardSyncTexRequest,
  type ProductionSession,
} from "./app/ProductionReviewApp.js";
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
import {
  createRpcHostRuntime,
  createVscodeMessagePort,
  materializeVscodeWorkerResource,
  materializeVscodeWasmResource,
} from "./host/vscode-runtime.js";
import type { HostRuntime, HostRuntimeBootstrap } from "./host/runtime.js";
import { subscribeRuntimeDocumentSource } from "./host/runtime-document-source.js";
import type {
  ReviewCommandInvocation,
  ReviewCommandSurfaceSnapshot,
} from "./review/review-command-surface.js";
import {
  AccessibilityTransitionCoordinator,
  type AccessibilityTransitionEffect,
} from "./app/accessibility-transitions.js";

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
  document.title = identity.filename;
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

export interface VscodePresentationState {
  readonly pageIndex?: number;
  readonly zoom?: number;
}

export function parseVscodePresentationState(value: unknown): VscodePresentationState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.pageIndex !== undefined && (!Number.isSafeInteger(input.pageIndex) || (input.pageIndex as number) < 0)) return undefined;
  if (input.zoom !== undefined && (typeof input.zoom !== "number" || !Number.isFinite(input.zoom) || input.zoom < 0.2 || input.zoom > 60)) return undefined;
  if (input.pageIndex === undefined && input.zoom === undefined) return undefined;
  return {
    ...(input.pageIndex === undefined ? {} : { pageIndex: input.pageIndex as number }),
    ...(input.zoom === undefined ? {} : { zoom: input.zoom as number }),
  };
}

export async function startRuntime(
  runtime: HostRuntime,
  options: {
    readonly initialPresentation?: VscodePresentationState;
    readonly onPresentationChange?: (presentation: { readonly pageIndex: number; readonly zoom: number }) => void;
    readonly onDocumentReady?: (generation: number) => void;
    readonly onDocumentTitleChange?: (title: string, generation: number) => void;
    readonly onRuntimeError?: (error: Error) => void;
  } = {},
): Promise<() => void> {
  const root = document.querySelector("#root");
  if (!(root instanceof HTMLElement)) throw new Error("Production review root is unavailable");
  root.dataset.productionRoot = "true";
  const loaded = await runtime.bootstrap();
  const reactRoot = createRoot(root);
  reactRoot.render(
    <RuntimeFailureBoundary {...(options.onRuntimeError === undefined
      ? {}
      : { onError: options.onRuntimeError })}>
      <RuntimeProductionReviewApp runtime={runtime} initial={loaded} {...options} />
    </RuntimeFailureBoundary>,
  );
  return () => reactRoot.unmount();
}

class RuntimeFailureBoundary extends Component<{
  readonly children: ReactNode;
  readonly onError?: (error: Error) => void;
}, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

const PENDING_SESSION_ID = "00000000-0000-4000-8000-000000000000";
const PENDING_FILE_ID = "00000000-0000-4000-8000-000000000001";

const pendingApi: HostRuntime = {
  host: "macos",
  bootstrap: async () => Promise.reject(new Error("The review is still loading.")),
  subscribeInvalidations: () => () => undefined,
  command: async () => Promise.reject(new Error("The review is still loading.")),
  saveStatus: async () => Promise.reject(new Error("The review is still loading.")),
  saveProposal: async () => Promise.reject(new Error("The review is still loading.")),
  chooseCopy: async () => Promise.reject(new Error("The review is still loading.")),
  chooseFolder: async () => Promise.reject(new Error("The review is still loading.")),
  chooseOriginal: async () => Promise.reject(new Error("The review is still loading.")),
  retrySave: async () => Promise.reject(new Error("The review is still loading.")),
  locateSave: async () => Promise.reject(new Error("The review is still loading.")),
  exportReviewedCopy: async () => Promise.reject(new Error("The review is still loading.")),
  scope: async () => Promise.reject(new Error("The review is still loading.")),
  forwardSyncTex: async () => Promise.reject(new Error("The review is still loading.")),
  reverseSyncTex: async () => Promise.reject(new Error("The review is still loading.")),
  dispose: () => undefined,
};

export function pendingRuntimeBootstrap(documentTitle: string): HostRuntimeBootstrap {
  const created = createReviewState({
    sessionId: PENDING_SESSION_ID,
    source: { fileId: PENDING_FILE_ID, digest: "0".repeat(64), byteLength: 5 },
  });
  const state = {
    ...created,
    workflow: { ...created.workflow, documentGeneration: 0 },
  };
  return {
    sessionId: PENDING_SESSION_ID,
    generation: 0,
    revision: 0,
    session: { sessionId: PENDING_SESSION_ID },
    state,
    scope: { documentTitle, launchSurface: "macos" },
    saveStatus: {
      destination: { phase: "none", generation: 0 },
      sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
    },
    viewerAssets: {
      documentUrl: "placekeeper-resource://document/pending_resource?generation=1&role=document",
      pdfiumWasm: "placekeeper-app://bundle/assets/pdfium.wasm",
      workerUrl: "placekeeper-app://bundle/assets/pdfium-worker.js",
    },
    resourcePolicy: {
      host: "macos",
      resources: {
        document: "placekeeper-resource://document/pending_resource?generation=1&role=document",
        pdfiumWasm: "placekeeper-app://bundle/assets/pdfium.wasm",
        worker: "placekeeper-app://bundle/assets/pdfium-worker.js",
      },
    },
  };
}

export function RuntimeProductionReviewApp(props: {
  readonly runtime?: HostRuntime;
  readonly initial?: HostRuntimeBootstrap;
  readonly loadingDocumentTitle?: string;
  readonly initialPresentation?: VscodePresentationState;
  readonly onPresentationChange?: (presentation: { readonly pageIndex: number; readonly zoom: number }) => void;
  readonly onDocumentReady?: (generation: number) => void;
  readonly onDocumentTitleChange?: (title: string, generation: number) => void;
  readonly onRuntimeError?: (error: Error) => void;
  readonly onCommandSurfaceChange?: (snapshot: ReviewCommandSurfaceSnapshot) => void;
  readonly commandInvocation?: ReviewCommandInvocation;
  readonly transitionAttemptId?: string;
  readonly transitionVisible?: boolean;
}) {
  const [seed, setSeed] = useState(props.initial);
  const [loaded, setLoaded] = useState(props.initial);
  const [refreshStatus, setRefreshStatus] = useState<"idle" | "reconciling" | "failed">("idle");
  const [hostReattachRequestToken, setHostReattachRequestToken] = useState(0);
  const [hostForwardSyncTexRequest, setHostForwardSyncTexRequest] = useState<HostForwardSyncTexRequest>();
  const [hostReverseSyncTexRequestToken, setHostReverseSyncTexRequestToken] = useState(0);
  const transitionCoordinator = useRef(new AccessibilityTransitionCoordinator());
  const [accessibilityTransition, setAccessibilityTransition] = useState<AccessibilityTransitionEffect>();
  const [documentReady, setDocumentReady] = useState<{
    readonly attemptId: string;
    readonly generation: number;
  }>();

  useEffect(() => {
    if (props.initial === undefined) return;
    setSeed(props.initial);
    setLoaded(props.initial);
  }, [props.initial]);
  useEffect(() => {
    if (seed !== undefined || props.runtime === undefined) return;
    const controller = new AbortController();
    void props.runtime.bootstrap(controller.signal).then((initial) => {
      if (controller.signal.aborted) return;
      setSeed(initial);
      setLoaded(initial);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setRefreshStatus("failed");
      props.onRuntimeError?.(error instanceof Error ? error : new Error("The review could not be loaded."));
    });
    return () => controller.abort();
  }, [props.runtime, seed]);
  useEffect(() => seed === undefined || props.runtime === undefined
    ? undefined
    : subscribeRuntimeDocumentSource(props.runtime, seed, (snapshot) => {
    setLoaded(snapshot.loaded);
    setRefreshStatus(snapshot.refreshStatus);
  }), [props.runtime, seed]);
  useEffect(() => props.runtime?.subscribeHostCommands?.((command) => {
    if (command.command === "reattach") {
      setHostReattachRequestToken((token) => token + 1);
      return;
    }
    if (command.command === "reverse-synctex") {
      setHostReverseSyncTexRequestToken((token) => token + 1);
      return;
    }
    setHostForwardSyncTexRequest((current) => ({
      token: (current?.token ?? 0) + 1,
      documentGeneration: command.documentGeneration,
      pageIndex: command.pageIndex,
      point: command.point,
    }));
  }), [props.runtime]);
  useEffect(() => {
    const attemptId = props.transitionAttemptId;
    if (attemptId === undefined) return;
    transitionCoordinator.current.activateAttempt(attemptId);
    const kind = refreshStatus === "failed"
      ? "recoverable-failure"
      : documentReady?.attemptId === attemptId ? "document-ready" : undefined;
    if (kind === undefined) return;
    const effect = transitionCoordinator.current.transition({
      attemptId,
      visible: props.transitionVisible ?? false,
      kind,
      ...(documentReady?.attemptId === attemptId ? { generation: documentReady.generation } : {}),
    });
    if (effect !== undefined) setAccessibilityTransition(effect);
  }, [
    documentReady?.attemptId,
    documentReady?.generation,
    props.transitionAttemptId,
    props.transitionVisible,
    refreshStatus,
  ]);

  const visible = loaded ?? pendingRuntimeBootstrap(props.loadingDocumentTitle ?? "Opening PDF");
  return <ProductionReviewApp
    session={visible.session}
    initialState={visible.state}
    initialSaveStatus={visible.saveStatus}
    scope={visible.scope}
    api={loaded === undefined ? pendingApi : props.runtime ?? pendingApi}
    viewerAssets={visible.viewerAssets}
    resourcePolicy={visible.resourcePolicy}
    {...(loaded === undefined ? {
      viewer: <section
        className="macos-loading-shell__workspace"
        data-runtime-loading-workspace
        aria-busy="true"
      >
        <p role={refreshStatus === "failed" ? "alert" : "status"}>
          {refreshStatus === "failed" ? "This review could not be prepared." : "Preparing this review…"}
        </p>
      </section>,
    } : {})}
    {...(visible.locationHistory === undefined ? {} : { locationHistory: visible.locationHistory })}
    {...(visible.canonicalLinkBase === undefined ? {} : { copyLinkBase: visible.canonicalLinkBase })}
    generationRefreshStatus={refreshStatus}
    hostReattachRequestToken={hostReattachRequestToken}
    hostReverseSyncTexRequestToken={hostReverseSyncTexRequestToken}
    {...(hostForwardSyncTexRequest === undefined ? {} : { hostForwardSyncTexRequest })}
    {...(props.runtime?.host === "vscode"
      ? { onReverseSyncTex: (input: unknown) => props.runtime!.reverseSyncTex(input) }
      : {})}
    {...(props.initialPresentation === undefined ? {} : { initialPresentation: props.initialPresentation })}
    {...(props.onPresentationChange === undefined ? {} : { onPresentationChange: props.onPresentationChange })}
    {...(props.onDocumentReady === undefined && props.transitionAttemptId === undefined ? {} : {
      onDocumentReady: (generation: number) => {
        if (props.transitionAttemptId !== undefined) {
          setDocumentReady({ attemptId: props.transitionAttemptId, generation });
        }
        props.onDocumentReady?.(generation);
      },
    })}
    {...(props.onDocumentTitleChange === undefined
      ? {}
      : { onDocumentTitleChange: props.onDocumentTitleChange })}
    {...(props.onCommandSurfaceChange === undefined
      ? {}
      : { onCommandSurfaceChange: props.onCommandSurfaceChange })}
    {...(props.commandInvocation === undefined
      ? {}
      : { commandInvocation: props.commandInvocation })}
    {...(accessibilityTransition === undefined ? {} : { accessibilityTransition })}
  />;
}

export interface ChromeRuntimeStartResult {
  readonly ready: Promise<number>;
  dispose(): void;
}

/** Mounts the shared production client for a Chrome handler without granting
 * it access to native messaging or service credentials. */
export async function startChromeRuntime(options: {
  readonly runtimeId: string;
  readonly extensionOrigin: string;
  readonly port: {
    postMessage(message: unknown): unknown;
    subscribe(listener: (message: unknown) => void): () => void;
  };
  readonly onDocumentTitleChange?: (title: string, generation: number) => void;
  readonly onRuntimeError?: (error: Error) => void;
}): Promise<ChromeRuntimeStartResult> {
  const runtime = createRpcHostRuntime({
    runtimeId: options.runtimeId,
    postMessage: options.port.postMessage,
    subscribe: options.port.subscribe,
  }, {
    host: "chrome",
    extensionOrigin: options.extensionOrigin,
  });
  const ready = Promise.withResolvers<number>();
  let settled = false;
  let unmount: (() => void) | undefined;
  try {
    unmount = await startRuntime(runtime, {
      onDocumentReady: (generation) => {
        if (settled) return;
        settled = true;
        ready.resolve(generation);
      },
      ...(options.onDocumentTitleChange === undefined
        ? {}
        : { onDocumentTitleChange: options.onDocumentTitleChange }),
      onRuntimeError: (error) => {
        if (!settled) {
          settled = true;
          ready.reject(error);
        }
        options.onRuntimeError?.(error);
      },
    });
  } catch (error) {
    settled = true;
    runtime.dispose();
    throw error;
  }
  return {
    ready: ready.promise,
    dispose: () => {
      if (!settled) {
        settled = true;
        ready.reject(new DOMException("The embedded review was disposed.", "AbortError"));
      }
      unmount?.();
      runtime.dispose();
    },
  };
}

export async function startVscode(options: {
  readonly panelId: string;
  readonly panelKey?: string;
  readonly vscode: {
    postMessage(message: unknown): unknown;
    getState(): unknown;
    setState(state: unknown): unknown;
  };
}): Promise<void> {
  if (options.panelKey !== undefined && !isReviewPanelKey(options.panelKey)) {
    throw new Error("A safe panel key is required.");
  }
  const runtime = createRpcHostRuntime(createVscodeMessagePort(options.panelId, options.vscode), {
    materializePdfiumWasm: materializeVscodeWasmResource,
    materializePdfiumWorker: materializeVscodeWorkerResource,
  });
  globalThis.addEventListener("pagehide", () => runtime.dispose(), { once: true });
  const rawState = options.vscode.getState();
  const rawPanelKey = typeof rawState === "object" && rawState !== null
    ? (rawState as { panelKey?: unknown }).panelKey
    : undefined;
  const persistedPanelKey = isReviewPanelKey(rawPanelKey)
    ? rawPanelKey
    : undefined;
  const panelKey = options.panelKey ?? persistedPanelKey;
  const initialPresentation = parseVscodePresentationState(rawState);
  const persist = (presentation: { readonly pageIndex: number; readonly zoom: number }) => {
    options.vscode.setState({
      ...(panelKey === undefined ? {} : { panelKey }),
      ...presentation,
    });
  };
  options.vscode.setState({
    ...(panelKey === undefined ? {} : { panelKey }),
    ...initialPresentation,
  });
  await startRuntime(runtime, {
    ...(initialPresentation === undefined ? {} : { initialPresentation }),
    onPresentationChange: persist,
  });
}
