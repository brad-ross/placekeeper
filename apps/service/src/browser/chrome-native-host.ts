import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { randomBytes } from "node:crypto";

import {
  launchThroughDaemon,
  openChromeBrowserSourceThroughDaemon,
  chromeRuntimeThroughDaemon,
  detachChromeRuntimeThroughDaemon,
} from "../host/service-daemon.js";
import { defaultDaemonPaths } from "../host/service-daemon.js";
import type { LaunchRequest, LaunchResponse } from "../host/placekeeper-host.js";
import {
  CHROME_EXTENSION_ORIGIN,
  ChromeHandoffSession,
  ChromeTransferQuota,
  ChromeTransferStore,
  type ChromeBrowserReviewOpener,
  type SealedBrowserSourceHandle,
} from "./chrome-handoff.js";
import { validatePdfInSubprocess } from "./chrome-pdf-validator.js";
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from "./native-messaging.js";
import type { ChromeBrowserSourceOpenRequest } from "./browser-source-store.js";
import {
  ChromeRuntimeConnection,
  type ChromeRuntimeBackend,
} from "./chrome-runtime.js";
import {
  CHROME_RUNTIME_PROTOCOL,
} from "../../../../packages/core/src/chrome-native-runtime-protocol.js";
import { deadlineWasSubstantiallyDelayed } from "../../../../packages/core/src/suspend-aware-deadline.js";
import type {
  ChromeRuntimeExtensionMessage,
  ChromeRuntimeHostMessage,
} from "../../../../packages/core/src/chrome-native-runtime-protocol.js";

export interface ChromeNativeHostCommandOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly store?: ChromeTransferStore;
  readonly opener?: ChromeBrowserReviewOpener;
  readonly quota?: ChromeTransferQuota;
  readonly maxDurationMs?: number;
  readonly runtimeBackend?: ChromeRuntimeBackend;
  readonly runtimeIdleLeaseMs?: number;
  readonly now?: () => number;
  readonly runtimeExchange?: (portId: string, message: ChromeRuntimeExtensionMessage, signal?: AbortSignal) => Promise<readonly ChromeRuntimeHostMessage[]>;
  readonly runtimeDetach?: (portId: string) => Promise<void>;
}

const DEFAULT_NATIVE_HOST_DURATION_MS = 30_000;
const DEFAULT_RUNTIME_IDLE_LEASE_MS = 90_000;
const RUNTIME_DETACH_BUDGET_MS = 1_000;

async function detachWithinBudget(detach: () => Promise<void>): Promise<void> {
  const pending = detach().catch(() => undefined);
  await Promise.race([
    pending,
    new Promise<void>((resolve) => setTimeout(resolve, RUNTIME_DETACH_BUDGET_MS)),
  ]);
}

export type ChromeBrowserLaunchClient = (
  request: LaunchRequest,
  signal?: AbortSignal,
) => Promise<LaunchResponse>;
export type ChromeBrowserSourceLaunchClient = (
  request: ChromeBrowserSourceOpenRequest,
  signal?: AbortSignal,
) => Promise<LaunchResponse>;

export function createDaemonChromeBrowserOpener(
  store: ChromeTransferStore,
  launch: ChromeBrowserLaunchClient = launchThroughDaemon,
  openBrowserSource: ChromeBrowserSourceLaunchClient = openChromeBrowserSourceThroughDaemon,
): ChromeBrowserReviewOpener {
  const browserDestination = async (response: LaunchResponse): Promise<string> => {
    if (
      !response.ok || response.kind === "recovery-offered" ||
      response.bindProof !== undefined ||
      (response.kind !== "opened" && response.kind !== "focused")
    ) throw new Error("service-unavailable");
    return response.url;
  };
  return {
    async openLocal(pdfPath: string, signal?: AbortSignal) {
      const request = { pdfPath, surface: "browser" as const };
      return browserDestination(await (signal === undefined ? launch(request) : launch(request, signal)));
    },
    async openSealed(handle: SealedBrowserSourceHandle, signal?: AbortSignal) {
      const source = await store.inspect(handle);
      const request = {
        protocolVersion: 1,
        sourceHandle: handle,
        byteLength: source.byteLength,
        sha256: source.sha256,
        ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
      } as const;
      const destination = await browserDestination(await (
        signal === undefined ? openBrowserSource(request) : openBrowserSource(request, signal)
      ));
      // The daemon atomically moved this inode into recovery ownership. Drop
      // the native process's transient handle without deleting owned bytes.
      await store.remove(handle);
      return destination;
    },
  };
}

/**
 * Executes only the Chrome handoff protocol. Browser JSON is decoded into the
 * closed schema before any daemon call and can never become a control request.
 */
export async function runChromeNativeHostCommand(
  args: readonly string[],
  options: ChromeNativeHostCommandOptions = {},
): Promise<number> {
  // Reject before creating the private store or touching the daemon. Chrome's
  // caller-origin argv is the only authority this executable accepts.
  if (args.length !== 1 || args[0] !== CHROME_EXTENSION_ORIGIN) return 2;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const paths = defaultDaemonPaths();
  let store: ChromeTransferStore;
  try {
    store = options.store ?? await ChromeTransferStore.create({
      root: join(paths.appSupportRoot, "browser-sources"),
      validate: validatePdfInSubprocess,
    });
  } catch {
    return 2;
  }
  let session: ChromeHandoffSession | undefined;
  let runtime: ChromeRuntimeConnection | undefined;
  const runtimePortId = randomBytes(24).toString("base64url");
  let runtimeProxyTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeIdleExpired = false;
  let runtimeProxyDetached = false;
  let mode: "handoff-v1" | "runtime-v2" | undefined;
  const lifetime = new AbortController();
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;

  const decoder = new NativeMessageDecoder();
  let protocolFailure = false;
  let queue = Promise.resolve();
  const handleOutputError = (): void => { protocolFailure = true; };
  output.on("error", handleOutputError);
  const write = (value: unknown): Promise<void> => new Promise((resolveWrite, reject) => {
    if (lifetime.signal.aborted) {
      reject(lifetime.signal.reason);
      return;
    }
    let settled = false;
    const cleanup = (): void => lifetime.signal.removeEventListener("abort", onAbort);
    const finish = (error?: Error | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === null || error === undefined) resolveWrite();
      else reject(error);
    };
    const onAbort = (): void => {
      const error = lifetime.signal.reason instanceof Error
        ? lifetime.signal.reason
        : new Error("native-host-timeout");
      output.destroy(error);
      finish(error);
    };
    lifetime.signal.addEventListener("abort", onAbort, { once: true });
    const frame = encodeNativeMessage(value);
    output.write(frame, finish);
  });
  const armLegacyDeadline = (): void => {
    lifetimeTimer ??= setTimeout(
      () => {
        protocolFailure = true;
        lifetime.abort(new Error("native-host-timeout"));
        input.destroy();
      },
      options.maxDurationMs ?? DEFAULT_NATIVE_HOST_DURATION_MS,
    );
  };
  const armRuntimeProxyDeadline = (): void => {
    if (runtimeProxyTimer !== undefined) clearTimeout(runtimeProxyTimer);
    const idleLeaseMs = options.runtimeIdleLeaseMs ?? DEFAULT_RUNTIME_IDLE_LEASE_MS;
    const now = options.now ?? Date.now;
    const armedAt = now();
    runtimeProxyTimer = setTimeout(() => {
      if (deadlineWasSubstantiallyDelayed(armedAt, idleLeaseMs, now())) {
        armRuntimeProxyDeadline();
        return;
      }
      runtimeIdleExpired = true;
      runtimeProxyDetached = true;
      void (options.runtimeDetach ?? detachChromeRuntimeThroughDaemon)(runtimePortId)
        .finally(() => input.destroy());
    }, idleLeaseMs);
    runtimeProxyTimer.unref?.();
  };
  const handleChunk = (chunk: Buffer): void => {
    if (protocolFailure) return;
    input.pause();
    queue = queue.then(async () => {
      for (const message of decoder.push(chunk)) {
        if (mode === undefined) {
          const record = typeof message === "object" && message !== null && !Array.isArray(message)
            ? message as Record<string, unknown> : undefined;
          mode = record?.type === "hello" && record.protocol === CHROME_RUNTIME_PROTOCOL
            ? "runtime-v2" : "handoff-v1";
          if (mode === "handoff-v1") {
            armLegacyDeadline();
            session = new ChromeHandoffSession({
              callerOrigin: args[0]!, store,
              opener: options.opener ?? createDaemonChromeBrowserOpener(store),
              quota: options.quota ?? new ChromeTransferQuota(),
              maxDurationMs: options.maxDurationMs ?? DEFAULT_NATIVE_HOST_DURATION_MS,
              signal: lifetime.signal,
            });
          } else if (options.runtimeBackend !== undefined) {
            runtime = new ChromeRuntimeConnection({
              callerOrigin: args[0]!, backend: options.runtimeBackend,
              ...(options.runtimeIdleLeaseMs === undefined ? {} : { idleLeaseMs: options.runtimeIdleLeaseMs }),
              onAsyncMessage: (event) => {
                void write(event).finally(() => {
                  if (event.type === "failure" && event.reason === "idle-timeout") input.destroy();
                });
              },
            });
          } else {
            armRuntimeProxyDeadline();
          }
        }
        if (mode === "runtime-v2" && runtime === undefined && runtimeProxyTimer !== undefined) {
          clearTimeout(runtimeProxyTimer);
          runtimeProxyTimer = undefined;
        }
        const responses = mode === "runtime-v2"
          ? runtime !== undefined
            ? [await runtime.handle(message)]
            : await (options.runtimeExchange ?? chromeRuntimeThroughDaemon)(
                runtimePortId,
                message as ChromeRuntimeExtensionMessage,
                lifetime.signal,
              )
          : [await session!.handle(message)];
        for (const response of responses) if (response !== undefined) await write(response);
        if (mode === "runtime-v2" && runtime === undefined) armRuntimeProxyDeadline();
      }
    }).catch(() => {
      if (!lifetime.signal.aborted) protocolFailure = true;
    }).finally(() => {
      if (protocolFailure) input.destroy();
      else input.resume();
    });
  };
  input.on("data", handleChunk);
  const termination = await new Promise<"end" | "close" | "error" | "timeout">((resolveEnd) => {
    let settled = false;
    const settle = (reason: "end" | "close" | "error" | "timeout"): void => {
      if (settled) return;
      settled = true;
      input.off("end", onEnd);
      input.off("close", onClose);
      input.off("error", onError);
      resolveEnd(reason);
    };
    const onEnd = (): void => settle("end");
    const onClose = (): void => settle("close");
    const onError = (): void => settle("error");
    input.once("end", onEnd);
    input.once("close", onClose);
    input.once("error", onError);
    lifetime.signal.addEventListener("abort", () => settle("timeout"), { once: true });
  });
  input.off("data", handleChunk);
  if (termination !== "end" && !runtimeIdleExpired) {
    protocolFailure = true;
    lifetime.abort(new Error("native-host-terminated"));
    input.destroy();
  } else if (!lifetime.signal.aborted) {
    const drained = await Promise.race([
      queue.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    if (!drained) lifetime.abort(new Error("native-host-terminated"));
  }
  try {
    decoder.end();
  } catch {
    protocolFailure = true;
  }
  await queue;
  await session?.disconnect();
  await runtime?.disconnect();
  if (mode === "runtime-v2" && runtime === undefined && !runtimeProxyDetached) {
    await detachWithinBudget(
      () => (options.runtimeDetach ?? detachChromeRuntimeThroughDaemon)(runtimePortId),
    );
  }
  if (lifetimeTimer !== undefined) clearTimeout(lifetimeTimer);
  if (runtimeProxyTimer !== undefined) clearTimeout(runtimeProxyTimer);
  output.off("error", handleOutputError);
  return protocolFailure ? 2 : 0;
}
