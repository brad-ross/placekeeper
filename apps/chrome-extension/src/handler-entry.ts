import { chromeAutoOpenPorts, connectPlacekeeper } from "./chrome-api.js";
import {
  createHandlerController,
  type EmbeddedReviewSession,
} from "./handler-controller.js";
import {
  chromePdfDisplayName,
  createChromeInteractionOwnerClaimStore,
  createNativeEmbeddedReview,
} from "./chrome-runtime.js";
import { readAutoOpenState } from "./opt-in.js";
import {
  createRecoveryButtons,
  setHandlerButtonContent,
} from "./handler-ui.js";

const bypass = document.querySelector<HTMLButtonElement>("#bypass");
const status = document.querySelector<HTMLElement>("#status");
const launchShell = document.querySelector<HTMLElement>("#launch-shell");
const handlerActions = document.querySelector<HTMLElement>("#handler-actions");
const title = document.querySelector<HTMLElement>("#title");
const reopen = document.querySelector<HTMLButtonElement>("#reopen");
const reviewRoot = document.querySelector<HTMLElement>("#root");
if (bypass === null || status === null || launchShell === null || handlerActions === null ||
  title === null || reopen === null || reviewRoot === null) {
  throw new Error("Incomplete Placekeeper handler page");
}

const DOCUMENT_READY_TIMEOUT_MS = 20_000;

interface SharedChromeClient {
  readonly ready: Promise<number>;
  dispose(): void;
}

interface SharedClientModule {
  startChromeRuntime(options: {
    readonly runtimeId: string;
    readonly extensionOrigin: string;
    readonly port: {
      postMessage(message: unknown): unknown;
      subscribe(listener: (message: unknown) => void): () => void;
    };
    readonly onDocumentTitleChange?: (title: string, generation: number) => void;
    readonly onRuntimeError?: (error: Error) => void;
  }): Promise<SharedChromeClient>;
}

async function runWithDocumentReadyDeadline<T>(
  signal: AbortSignal,
  task: (boundedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const deadline = new AbortController();
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => {
    deadline.abort(new Error("The PDF viewer did not validate the document."));
  }, DOCUMENT_READY_TIMEOUT_MS);
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const onAbort = () => rejectStopped(boundedSignal.reason);
  boundedSignal.addEventListener("abort", onAbort, { once: true });
  // AbortSignal does not replay an abort that lands between the first check
  // and listener registration. Close that race so bypass never waits for the
  // full validation deadline before returning to Chrome's viewer.
  if (boundedSignal.aborted) onAbort();
  try {
    return await Promise.race([task(boundedSignal), stopped]);
  } finally {
    clearTimeout(timer);
    boundedSignal.removeEventListener("abort", onAbort);
  }
}

async function loadSharedStylesheet(signal: AbortSignal): Promise<void> {
  const existing = document.querySelector<HTMLLinkElement>('link[data-placekeeper-shared-client]');
  if (existing?.sheet !== null && existing?.sheet !== undefined) return;
  const stylesheet = existing ?? document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("shared/app.css");
  stylesheet.dataset.placekeeperSharedClient = "true";
  if (existing === null) document.head.append(stylesheet);
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => {
      stylesheet.removeEventListener("load", onLoad);
      stylesheet.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onLoad = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("Shared review styles failed to load.")); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    stylesheet.addEventListener("load", onLoad, { once: true });
    stylesheet.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function loadSharedClient(): Promise<SharedClientModule> {
  const url = chrome.runtime.getURL("shared/app.js");
  const loaded: unknown = await import(/* @vite-ignore */ url);
  if (typeof loaded !== "object" || loaded === null ||
    typeof (loaded as { startChromeRuntime?: unknown }).startChromeRuntime !== "function") {
    throw new Error("Shared Placekeeper client is unavailable.");
  }
  return loaded as SharedClientModule;
}

const autoOpen = chromeAutoOpenPorts(chrome);
setHandlerButtonContent(bypass, "chrome", "Default");
setHandlerButtonContent(reopen, "redo", "Reopen PDF", "primary");
handlerActions.replaceChildren(bypass);

const ownerClaims = new Map<number, ReturnType<typeof createChromeInteractionOwnerClaimStore>>();

function randomBase64Url(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function interactionOwnerSecret(tabId: number): string {
  let claims = ownerClaims.get(tabId);
  if (claims === undefined) {
    claims = createChromeInteractionOwnerClaimStore({
      tabId,
      navigationType: () => (performance.getEntriesByType("navigation")[0] as { readonly type?: string } | undefined)?.type,
      readHistoryState: () => {
        try { return history.state; } catch { return null; }
      },
      replaceHistoryState: (state) => {
        try { history.replaceState(state, ""); } catch { /* Same-document recovery stays in memory. */ }
      },
      readSession: (key) => {
        try { return sessionStorage.getItem(key); } catch { return null; }
      },
      writeSession: (key, value) => {
        try { sessionStorage.setItem(key, value); } catch { /* Same-document recovery stays in memory. */ }
      },
      createSecret: () => randomBase64Url(32),
      createClaimId: () => randomBase64Url(18),
    });
    ownerClaims.set(tabId, claims);
  }
  return claims.ownerSecret();
}

async function chooseProtectedRecovery(
  _recovery: {
    readonly choices: readonly ["resume", "discard", "fork"];
    readonly offer: { readonly id: string; readonly expiresAt: string };
  },
  signal?: AbortSignal,
): Promise<"resume" | "discard" | "fork"> {
  if (signal?.aborted === true) throw signal.reason;
  title!.textContent = "Existing review recovered";
  status!.textContent = "Choose how Placekeeper should reopen your unfinished review.";
  handlerActions!.setAttribute("aria-label", "Protected recovery choices");
  const buttons = createRecoveryButtons(document);
  const recoveryActions = document.createElement("div");
  recoveryActions.className = "handler-recovery-actions";
  recoveryActions.append(...buttons);
  handlerActions!.replaceChildren(bypass!, recoveryActions);
  const resume = buttons.at(-1)!;
  resume.focus({ preventScroll: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (opening: boolean) => {
      handlerActions!.setAttribute("aria-label", "Handler actions");
      handlerActions!.replaceChildren(bypass!);
      signal?.removeEventListener("abort", onAbort);
      if (opening) status!.textContent = "Opening the protected review…";
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup(false);
      reject(signal?.reason);
    };
    for (const button of buttons) {
      button.addEventListener("click", () => {
        if (settled) return;
        settled = true;
        const choice = button.dataset.recoveryChoice as "resume" | "discard" | "fork";
        cleanup(true);
        resolve(choice);
      }, { once: true });
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

const openNativeReview = createNativeEmbeddedReview({
  connectNative: () => connectPlacekeeper(chrome),
  fetchStream: async (url, signal) => signal === undefined ? fetch(url) : fetch(url, { signal }),
  createId: () => crypto.randomUUID().replaceAll("-", "_"),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  getExtensionURL: (path) => chrome.runtime.getURL(path),
  interactionOwnerSecret: (info) => {
    if (!("tabId" in info) || !Number.isSafeInteger(info.tabId) || Number(info.tabId) < 0) {
      throw new Error("Chrome did not provide a trusted tab identity.");
    }
    return interactionOwnerSecret(Number(info.tabId));
  },
  chooseRecovery: chooseProtectedRecovery,
});

async function openEmbeddedReview(
  info: Parameters<typeof openNativeReview>[0],
  signal: AbortSignal,
): Promise<EmbeddedReviewSession> {
  const native = await openNativeReview(info, signal);
  document.title = native.displayName;
  let shared: SharedChromeClient | undefined;
  let released = false;
  let runtimeFailurePublished = false;
  const lifecycleListeners = new Set<Parameters<EmbeddedReviewSession["subscribeLifecycle"]>[0]>();
  const unsubscribeNativeLifecycle = native.subscribeLifecycle((event) => {
    for (const listener of lifecycleListeners) listener(event);
  });
  const disposeShared = () => {
    shared?.dispose();
    shared = undefined;
  };
  const release = async () => {
    if (released) return;
    released = true;
    disposeShared();
    await native.release();
  };
  const dispose = () => {
    globalThis.removeEventListener("pagehide", onPageHide);
    unsubscribeNativeLifecycle();
    disposeShared();
    native.dispose();
  };
  const onPageHide = () => { void release().finally(dispose); };
  globalThis.addEventListener("pagehide", onPageHide, { once: true });
  return {
    displayName: native.displayName,
    subscribeLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    async mountAndValidate(mountSignal) {
      await runWithDocumentReadyDeadline(mountSignal, async (boundedSignal) => {
        const [, module] = await Promise.all([
          loadSharedStylesheet(boundedSignal),
          loadSharedClient(),
        ]);
        if (boundedSignal.aborted) throw boundedSignal.reason;
        shared = await module.startChromeRuntime({
          runtimeId: native.runtimePort.runtimeId,
          extensionOrigin: globalThis.location.origin,
          port: native.runtimePort,
          onDocumentTitleChange(nextTitle) {
            document.title = nextTitle;
          },
          onRuntimeError() {
            if (runtimeFailurePublished) return;
            runtimeFailurePublished = true;
            for (const listener of lifecycleListeners) listener({
              type: "disconnected",
              protected: native.protected,
            });
          },
        });
        if (boundedSignal.aborted) {
          disposeShared();
          throw boundedSignal.reason;
        }
        await shared.ready;
      });
    },
    activate: (activateSignal) => native.activate(activateSignal),
    release,
    dispose,
  };
}

const controller = createHandlerController({
  isOptedIn: async () => (await readAutoOpenState(autoOpen)).enabled,
  getStreamInfo: async () => chrome.mimeHandler.getStreamInfo(),
  openEmbedded: openEmbeddedReview,
  fallback: () => {
    void chrome.mimeHandler.abortAndFallbackToNativeHandler();
  },
  pendingTitle: (originalUrl) => {
    const name = chromePdfDisplayName(originalUrl);
    document.title = name;
    title.textContent = name;
  },
  status: (message) => {
    status.textContent = message;
    if (message === "Review ready.") {
      reviewRoot.inert = false;
      launchShell.hidden = true;
      return;
    }
    if (message.includes("disconnected") || message.includes("updated")) {
      reviewRoot.inert = true;
      launchShell.hidden = false;
      reopen.hidden = false;
      handlerActions.replaceChildren(reopen);
      title.textContent = message.includes("updated") ? "Update required" : "Review disconnected";
      reopen.focus({ preventScroll: true });
    }
  },
});

bypass.addEventListener("click", () => controller.bypass());
reopen.addEventListener("click", () => globalThis.location.reload());
bypass.focus();
void controller.run();
