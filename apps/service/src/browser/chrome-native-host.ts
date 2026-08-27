import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { launchThroughDaemon } from "../host/service-daemon.js";
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

export interface ChromeNativeHostCommandOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly store?: ChromeTransferStore;
  readonly opener?: ChromeBrowserReviewOpener;
  readonly quota?: ChromeTransferQuota;
  readonly maxDurationMs?: number;
}

const DEFAULT_NATIVE_HOST_DURATION_MS = 30_000;

export type ChromeBrowserLaunchClient = (request: LaunchRequest) => Promise<LaunchResponse>;

export function createDaemonChromeBrowserOpener(
  store: ChromeTransferStore,
  launch: ChromeBrowserLaunchClient = launchThroughDaemon,
): ChromeBrowserReviewOpener {
  const browserDestination = async (pdfPath: string): Promise<string> => {
    const response = await launch({ pdfPath, surface: "browser" });
    if (
      !response.ok || response.kind === "recovery-offered" ||
      response.bindProof !== undefined ||
      (response.kind !== "opened" && response.kind !== "focused")
    ) throw new Error("service-unavailable");
    return response.url;
  };
  return {
    openLocal: browserDestination,
    async openSealed(handle: SealedBrowserSourceHandle) {
      const source = await store.inspect(handle);
      return browserDestination(source.path);
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
  try {
    session = new ChromeHandoffSession({
      callerOrigin: args[0]!,
      store,
      opener: options.opener ?? createDaemonChromeBrowserOpener(store),
      quota: options.quota ?? new ChromeTransferQuota(),
      maxDurationMs: options.maxDurationMs ?? DEFAULT_NATIVE_HOST_DURATION_MS,
    });
  } catch {
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
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      protocolFailure = true;
      return;
    }
    for (const message of messages) {
      queue = queue.then(async () => {
        const response = await session.handle(message);
        if (response !== undefined) await write(response);
      }).catch(() => {
        protocolFailure = true;
      });
    }
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
    input.destroy();
  }
  try {
    decoder.end();
  } catch {
    protocolFailure = true;
  }
  await queue;
  await session.disconnect();
  output.off("error", handleOutputError);
  return protocolFailure ? 2 : 0;
}
