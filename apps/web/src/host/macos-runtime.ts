import {
  MACOS_SHELL_PROTOCOL_VERSION,
  parseMacosPageMessage,
  type MacosNativeMessage,
  type MacosPageMessage,
} from "../../../../packages/core/src/macos-shell-protocol.js";
import type { HostRuntime } from "./runtime.js";
import { createRpcHostRuntime } from "./vscode-runtime.js";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const PACKAGED_PDFIUM_SOURCE = "placekeeper-app://bundle/assets/pdfium.wasm";

declare global {
  var __PLACEKEEPER_MAC_PDFIUM_URL__: string | undefined;
  var __PLACEKEEPER_MAC_WORKER_URL__: string | undefined;
  var __PLACEKEEPER_MAC_DOCUMENT_RESOURCE__: {
    readonly source: string;
    readonly url: string;
  } | undefined;
}

export interface MacosRuntimeBridge {
  readonly runtimeId: string;
  readonly attemptId: string;
  postToNative(message: MacosPageMessage): void;
  subscribeNative(listener: (message: MacosNativeMessage) => void): () => void;
}
export function createMacosHostRuntime(bridge: MacosRuntimeBridge): HostRuntime {
  if (!ID.test(bridge.runtimeId) || !ID.test(bridge.attemptId)) {
    throw new Error("A safe macOS runtime and attempt identity are required.");
  }
  const packagedPdfium = globalThis.__PLACEKEEPER_MAC_PDFIUM_URL__;
  const packagedWorker = globalThis.__PLACEKEEPER_MAC_WORKER_URL__;
  const documentResource = globalThis.__PLACEKEEPER_MAC_DOCUMENT_RESOURCE__;
  return createRpcHostRuntime({
    runtimeId: bridge.runtimeId,
    postMessage(message) {
      const wrapped = parseMacosPageMessage({
        protocolVersion: MACOS_SHELL_PROTOCOL_VERSION,
        type: "runtime-message",
        runtimeId: bridge.runtimeId,
        attemptId: bridge.attemptId,
        message,
      });
      if (wrapped === undefined) throw new Error("The macOS runtime request was invalid.");
      bridge.postToNative(wrapped);
    },
    subscribe(listener) {
      return bridge.subscribeNative((message) => {
        if (message.type !== "runtime-message" || message.runtimeId !== bridge.runtimeId
          || message.attemptId !== bridge.attemptId) return;
        listener(message.message);
      });
    },
  }, {
    host: "macos",
    ...(documentResource === undefined ? {} : {
      materializeDocument: async (sourceUrl: string) => {
        if (sourceUrl !== documentResource.source || !documentResource.url.startsWith("blob:")) {
          throw new Error("The packaged document resource identity was invalid.");
        }
        return {
          url: documentResource.url,
          dispose: () => URL.revokeObjectURL(documentResource.url),
        };
      },
    }),
    ...(packagedPdfium === undefined ? {} : {
      materializePdfiumWasm: async (sourceUrl: string) => {
        if (sourceUrl !== PACKAGED_PDFIUM_SOURCE ||
          !packagedPdfium.startsWith("blob:")) {
          throw new Error("The packaged PDF engine identity was invalid.");
        }
        return { url: packagedPdfium, dispose: () => URL.revokeObjectURL(packagedPdfium) };
      },
    }),
    ...(packagedWorker === undefined ? {} : {
      materializePdfiumWorker: async (sourceUrl: string) => {
        if (sourceUrl !== "placekeeper-app://bundle/assets/pdfium-worker.js" ||
          !packagedWorker.startsWith("blob:")) {
          throw new Error("The packaged PDF worker identity was invalid.");
        }
        return { url: packagedWorker, dispose: () => URL.revokeObjectURL(packagedWorker) };
      },
    }),
  });
}
