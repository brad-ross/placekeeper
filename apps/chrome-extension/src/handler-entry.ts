import { chromeAutoOpenPorts, connectPlacekeeper } from "./chrome-api.js";
import {
  createHandlerController,
  type EmbeddedReviewSession,
} from "./handler-controller.js";
import {
  chromePdfDisplayName,
  createNativeEmbeddedReview,
} from "./chrome-runtime.js";
import { createNativeHandoff } from "./native-handoff.js";
import { readAutoOpenState } from "./opt-in.js";
import {
  platformProofEnabled,
  platformProofFailureCode,
  runInstalledPlatformProof,
} from "./platform-proof.js";

const bypass = document.querySelector<HTMLButtonElement>("#bypass");
const status = document.querySelector<HTMLElement>("#status");
const proofOutput = document.querySelector<HTMLElement>("#platform-proof");
const launchShell = document.querySelector<HTMLElement>("#launch-shell");
const title = document.querySelector<HTMLElement>("#title");
const reopen = document.querySelector<HTMLButtonElement>("#reopen");
const reviewRoot = document.querySelector<HTMLElement>("#root");
if (bypass === null || status === null || proofOutput === null || launchShell === null ||
  title === null || reopen === null || reviewRoot === null) {
  throw new Error("Incomplete Placekeeper handler page");
}

const HANDLER_RUNTIME_VERSION = 2 as const;
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
const handoff = createNativeHandoff({
  connectNative: () => connectPlacekeeper(chrome),
  fetchStream: async (url, signal) => signal === undefined ? fetch(url) : fetch(url, { signal }),
  createTransferId: () => crypto.randomUUID(),
});
const openNativeReview = createNativeEmbeddedReview({
  connectNative: () => connectPlacekeeper(chrome),
  fetchStream: async (url, signal) => signal === undefined ? fetch(url) : fetch(url, { signal }),
  createId: () => crypto.randomUUID().replaceAll("-", "_"),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  getExtensionURL: (path) => chrome.runtime.getURL(path),
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
  const release = async () => {
    if (released) return;
    released = true;
    shared?.dispose();
    await native.release();
  };
  const dispose = () => {
    globalThis.removeEventListener("pagehide", onPageHide);
    unsubscribeNativeLifecycle();
    shared?.dispose();
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
        await loadSharedStylesheet(boundedSignal);
        if (boundedSignal.aborted) throw boundedSignal.reason;
        const module = await loadSharedClient();
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
          shared.dispose();
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
  handlerRuntimeVersion: HANDLER_RUNTIME_VERSION,
  openEmbedded: openEmbeddedReview,
  handoff,
  fallback: () => {
    void chrome.mimeHandler.abortAndFallbackToNativeHandler();
  },
  replace: async (tabId, destination) => {
    await chrome.tabs.update(tabId, { url: destination });
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
      bypass.hidden = true;
      reopen.hidden = false;
      title.textContent = message.includes("updated") ? "Update required" : "Review disconnected";
      reopen.focus({ preventScroll: true });
    }
  },
});

void (async () => {
  const proofEnabled = await platformProofEnabled(chrome);
  if (proofEnabled) {
    bypass.addEventListener("click", () => {
      void chrome.mimeHandler.abortAndFallbackToNativeHandler();
    }, { once: true });
    try {
      await runInstalledPlatformProof({ api: chrome, status, output: proofOutput });
    } catch (error) {
      status.textContent = "Platform proof failed — stop the embedded-viewer rollout.";
      proofOutput.hidden = false;
      proofOutput.textContent = JSON.stringify({
        failureCode: platformProofFailureCode(error),
      }, null, 2);
    }
  } else {
    bypass.addEventListener("click", () => controller.bypass());
    reopen.addEventListener("click", () => globalThis.location.reload());
    void controller.run();
  }
  bypass.focus();
})();
