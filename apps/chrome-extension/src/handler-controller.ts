import { validatePlacekeeperDestination } from "./native-protocol.js";

export interface PdfStreamInfo {
  readonly originalUrl: string;
  readonly streamUrl: string;
}

export interface HandoffResult {
  readonly transferId: string;
  readonly destination: string;
}

export type HandlerState = "idle" | "inspecting" | "pending" | "fallback" | "replaced";

export class HandoffError extends Error {}

export interface HandlerPorts {
  isOptedIn(): Promise<boolean>;
  getStreamInfo(): Promise<PdfStreamInfo | undefined>;
  handoff(info: PdfStreamInfo, signal: AbortSignal): Promise<HandoffResult>;
  fallback(): void;
  replace(destination: string): void;
  status?(message: string): void;
}

export interface HandlerController {
  run(): Promise<void>;
  bypass(): void;
  state(): HandlerState;
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
        if (info === undefined || info.streamUrl.length === 0 || info.originalUrl.length === 0) {
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
        terminal = true;
        current = "replaced";
        ports.status?.("Opening Placekeeper.");
        ports.replace(destination);
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
