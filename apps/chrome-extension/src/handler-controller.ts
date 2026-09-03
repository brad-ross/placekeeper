import { validatePlacekeeperDestination } from "./native-protocol.js";

export interface PdfStreamInfo {
  readonly originalUrl: string;
  readonly streamUrl: string;
}

export interface MimeHandlerContext extends PdfStreamInfo {
  readonly tabId: number;
  readonly embedded: boolean;
}

export interface HandoffResult {
  readonly destination: string;
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
  | "replacing"
  | "fallback"
  | "replaced";

export class HandoffError extends Error {}

export interface HandlerPorts {
  isOptedIn(): Promise<boolean>;
  getStreamInfo(): Promise<unknown>;
  /** Version 1 keeps the shipped redirect available until the installed U7 cutover. */
  readonly handlerRuntimeVersion?: 1 | 2;
  openEmbedded?(info: PdfStreamInfo, signal: AbortSignal): Promise<EmbeddedReviewSession>;
  pendingTitle?(originalUrl: string): void;
  handoff(info: PdfStreamInfo, signal: AbortSignal): Promise<HandoffResult>;
  fallback(): void;
  replace(tabId: number, destination: string): Promise<void>;
  status?(message: string): void;
}

export interface HandlerController {
  run(): Promise<void>;
  bypass(): void;
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
    bypass: () => {
      if (current === "replacing" || activeCommitted) return;
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
        current = "pending";
        ports.status?.("Opening this PDF in Placekeeper…");
        if (ports.handlerRuntimeVersion === 2) {
          if (ports.openEmbedded === undefined) throw new HandoffError("embedded-runtime-unavailable");
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
              ? "Placekeeper needs to be updated before this review can reconnect."
              : event.protected
                ? "Placekeeper disconnected. Your review is protected and can be reopened."
                : "Placekeeper disconnected. Reopen this PDF to continue.");
          });
          current = "mounting";
          ports.status?.("Preparing the Placekeeper viewer…");
          await review.mountAndValidate(abort.signal);
          if (terminal || bypassRequested) throw new HandoffError("bypassed");
          current = "activating";
          ports.status?.("Activating this review…");
          await review.activate(abort.signal);
          activeCommitted = true;
          current = "active";
          ports.status?.("Review ready.");
          return;
        }
        const result = await ports.handoff(info, abort.signal);
        if (terminal) return;
        if (bypassRequested) {
          fallbackOnce();
          return;
        }
        const destination = validatePlacekeeperDestination(result.destination);
        if (destination === undefined) {
          fallbackOnce();
          return;
        }
        ports.status?.("Opening Placekeeper.");
        current = "replacing";
        await ports.replace(info.tabId, destination);
        if (terminal) return;
        terminal = true;
        current = "replaced";
      } catch (error) {
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
