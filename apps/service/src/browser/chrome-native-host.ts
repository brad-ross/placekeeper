import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  launchThroughDaemon,
  openChromeBrowserSourceThroughDaemon,
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

export interface ChromeNativeHostCommandOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly store?: ChromeTransferStore;
  readonly opener?: ChromeBrowserReviewOpener;
  readonly quota?: ChromeTransferQuota;
  readonly maxDurationMs?: number;
}

const DEFAULT_NATIVE_HOST_DURATION_MS = 30_000;

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
  let session: ChromeHandoffSession;
  const lifetime = new AbortController();
  const lifetimeTimer = setTimeout(
    () => lifetime.abort(new Error("native-host-timeout")),
    options.maxDurationMs ?? DEFAULT_NATIVE_HOST_DURATION_MS,
  );
  try {
    session = new ChromeHandoffSession({
      callerOrigin: args[0]!,
      store,
      opener: options.opener ?? createDaemonChromeBrowserOpener(store),
      quota: options.quota ?? new ChromeTransferQuota(),
      maxDurationMs: options.maxDurationMs ?? DEFAULT_NATIVE_HOST_DURATION_MS,
      signal: lifetime.signal,
    });
  } catch {
    clearTimeout(lifetimeTimer);
    return 2;
  }

  const decoder = new NativeMessageDecoder();
  let protocolFailure = false;
  let queue = Promise.resolve();
  const handleOutputError = (): void => { protocolFailure = true; };
  output.on("error", handleOutputError);
  const write = (value: unknown): Promise<void> => new Promise((resolveWrite, reject) => {
    const frame = encodeNativeMessage(value);
    output.write(frame, (error) => error === null || error === undefined ? resolveWrite() : reject(error));
  });
  const handleChunk = (chunk: Buffer): void => {
    if (protocolFailure) return;
    input.pause();
    queue = queue.then(async () => {
      for (const message of decoder.push(chunk)) {
        const response = await session.handle(message);
        if (response !== undefined) await write(response);
      }
    }).catch(() => {
      protocolFailure = true;
    }).finally(() => {
      if (protocolFailure) input.destroy();
      else input.resume();
    });
  };
  input.on("data", handleChunk);
  const termination = await new Promise<"end" | "close" | "error" | "timeout">((resolveEnd) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (reason: "end" | "close" | "error" | "timeout"): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
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
    timer = setTimeout(
      () => settle("timeout"),
      options.maxDurationMs ?? DEFAULT_NATIVE_HOST_DURATION_MS,
    );
  });
  input.off("data", handleChunk);
  if (termination !== "end") {
    protocolFailure = true;
    lifetime.abort(new Error("native-host-terminated"));
    input.destroy();
  }
  try {
    decoder.end();
  } catch {
    protocolFailure = true;
  }
  await queue;
  await session.disconnect();
  clearTimeout(lifetimeTimer);
  output.off("error", handleOutputError);
  return protocolFailure ? 2 : 0;
}
