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

export type HandlerState = "idle" | "inspecting" | "pending" | "replacing" | "fallback" | "replaced";

export class HandoffError extends Error {}

export interface HandlerPorts {
  isOptedIn(): Promise<boolean>;
  getStreamInfo(): Promise<unknown>;
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
      if (current === "replacing") return;
      bypassRequested = true;
      abort.abort();
      if (current === "pending") {
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
        current = "pending";
        ports.status?.("Opening this PDF in Placekeeper…");
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
