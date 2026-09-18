export interface PdfStreamInfo {
  readonly originalUrl: string;
  readonly streamUrl: string;
  readonly tabId?: number;
}

export interface MimeHandlerContext extends PdfStreamInfo {
  readonly tabId: number;
  readonly embedded: boolean;
}

export type EmbeddedReviewLifecycleEvent =
  | { readonly type: "disconnected"; readonly protected: boolean }
  | { readonly type: "update-required"; readonly protected: boolean };

export interface EmbeddedReviewSession {
  readonly displayName: string;
  /** Resolves only after the main PDF generation has been parsed and accepted by the viewer. */
  mountAndValidate(signal: AbortSignal): Promise<void>;
  activate(signal: AbortSignal): Promise<void>;
  release(): Promise<void>;
  dispose(): void;
  subscribeLifecycle(listener: (event: EmbeddedReviewLifecycleEvent) => void): () => void;
}

export type HandlerState =
  | "idle"
  | "inspecting"
  | "pending"
  | "mounting"
  | "activating"
  | "active"
  | "disconnected-clean"
  | "disconnected-protected"
  | "update-required"
  | "fallback";

export interface HandlerPorts {
  isOptedIn(): Promise<boolean>;
  getStreamInfo(): Promise<unknown>;
  openEmbedded(info: MimeHandlerContext, signal: AbortSignal): Promise<EmbeddedReviewSession>;
  pendingTitle?(originalUrl: string): void;
  fallback(): void;
  reloadTab(tabId: number): Promise<void>;
  status?(message: string): void;
}

export interface HandlerController {
  run(): Promise<void>;
  bypass(): void;
  reopen(): Promise<void>;
  state(): HandlerState;
}

function isTopLevelMimeHandlerContext(value: unknown): value is MimeHandlerContext {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.originalUrl === "string" &&
    info.originalUrl.length > 0 &&
    typeof info.streamUrl === "string" &&
    info.streamUrl.length > 0 &&
    typeof info.tabId === "number" &&
    Number.isSafeInteger(info.tabId) &&
    info.tabId >= 0 &&
    info.embedded === false
  );
}

export function createHandlerController(ports: HandlerPorts): HandlerController {
  let current: HandlerState = "idle";
  let terminal = false;
  let bypassRequested = false;
  const abort = new AbortController();
  let activeCommitted = false;
  let tabId: number | undefined;
  let reopening = false;
  let review: EmbeddedReviewSession | undefined;
  let unsubscribeLifecycle: (() => void) | undefined;

  const fallbackOnce = (): void => {
    if (terminal) return;
    terminal = true;
    current = "fallback";
    ports.status?.("Opening in Chrome’s PDF viewer.");
    ports.fallback();
  };

  return {
    state: () => current,
    async reopen() {
      if (reopening || tabId === undefined ||
          !["disconnected-clean", "disconnected-protected", "update-required"].includes(current)) return;
      reopening = true;
      try {
        // Reload the PDF's owning tab, not the MIME handler's extension frame.
        // Chrome must create a new response stream for the replacement handler.
        await ports.reloadTab(tabId);
      } catch {
        ports.status?.("Could not reopen this PDF. Try again or reload the browser tab.");
      } finally {
        reopening = false;
      }
    },
    bypass: () => {
      if (activeCommitted) return;
      bypassRequested = true;
      abort.abort();
      if (current === "pending" || current === "mounting" || current === "activating") {
        ports.status?.("Finishing the PDF response before opening Chrome’s viewer…");
      } else {
        fallbackOnce();
      }
    },
    async run() {
      if (terminal || current !== "idle") return;
      current = "inspecting";
      try {
        if (!await ports.isOptedIn()) {
          fallbackOnce();
          return;
        }
        const info = await ports.getStreamInfo();
        if (!isTopLevelMimeHandlerContext(info)) {
          fallbackOnce();
          return;
        }
        ports.pendingTitle?.(info.originalUrl);
        tabId = info.tabId;
        current = "pending";
        ports.status?.("Opening this PDF in Placekeeper…");
        review = await ports.openEmbedded(info, abort.signal);
        if (terminal || bypassRequested) {
          await review.release();
          review.dispose();
          review = undefined;
          fallbackOnce();
          return;
        }
        unsubscribeLifecycle = review.subscribeLifecycle((event) => {
          if (!activeCommitted || terminal) return;
          current = event.type === "update-required"
            ? "update-required"
            : event.protected ? "disconnected-protected" : "disconnected-clean";
          ports.status?.(event.type === "update-required"
            ? event.protected
              ? "Placekeeper needs to be updated before this protected review can reopen."
              : "Placekeeper needs to be updated before this review can reconnect."
            : event.protected
              ? "Placekeeper disconnected. Your review is protected and can be reopened."
              : "Placekeeper disconnected. Reopen this PDF to continue.");
        });
        current = "mounting";
        ports.status?.("Preparing the Placekeeper viewer…");
        await review.mountAndValidate(abort.signal);
        if (terminal || bypassRequested) throw new Error("bypassed");
        current = "activating";
        ports.status?.("Activating this review…");
        await review.activate(abort.signal);
        activeCommitted = true;
        current = "active";
        ports.status?.("Review ready.");
      } catch {
        if (!activeCommitted && review !== undefined) {
          unsubscribeLifecycle?.();
          unsubscribeLifecycle = undefined;
          await review.release().catch(() => undefined);
          review.dispose();
          review = undefined;
        }
        if (terminal) return;
        if (bypassRequested) {
          fallbackOnce();
          return;
        }
        fallbackOnce();
      }
    },
  };
}
