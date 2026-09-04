import {
  MACOS_SHELL_PROTOCOL_VERSION,
  parseMacosPageMessage,
  type MacosNativeMessage,
  type MacosPageMessage,
} from "../../../../packages/core/src/macos-shell-protocol.js";
import type { HostRuntime } from "./runtime.js";
import { createRpcHostRuntime } from "./vscode-runtime.js";

const ID = /^[A-Za-z0-9_-]{8,128}$/u;

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
  }, { host: "macos" });
}
