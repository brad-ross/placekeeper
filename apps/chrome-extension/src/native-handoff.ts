import { HandoffError, type HandoffResult, type PdfStreamInfo } from "./handler-controller.js";
import {
  createChunkMessage,
  MAX_CHUNK_BYTES,
  NATIVE_PROTOCOL_VERSION,
  parseHostMessage,
  type ExtensionMessage,
  type HostMessage,
  type StartMessage,
  validatePlacekeeperDestination,
} from "./native-protocol.js";

interface NativeEvent<T> {
  addListener(listener: (value: T) => void): void;
  removeListener(listener: (value: T) => void): void;
}

export interface NativePort {
  postMessage(message: ExtensionMessage): void;
  disconnect(): void;
  readonly onMessage: NativeEvent<unknown>;
  readonly onDisconnect: NativeEvent<void>;
}

export interface NativeHandoffPorts {
  connectNative(): NativePort;
  fetchStream(url: string, signal?: AbortSignal): Promise<Response>;
  createTransferId(): string;
  timeoutMs?: number;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function displayName(originalUrl: string): string | undefined {
  try {
    const candidate = decodeURIComponent(new URL(originalUrl).pathname.split("/").pop() ?? "")
      .replace(/[\u0000-\u001f\u007f]/gu, "")
      .slice(0, 120);
    return candidate === "" ? undefined : candidate;
  } catch {
    return undefined;
  }
}

function waitForMessage(
  port: NativePort,
  transferId: string,
  accepts: (message: HostMessage) => boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HostMessage> {
  if (isAborted(signal)) return Promise.reject(new HandoffError("bypassed"));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      signal?.removeEventListener("abort", onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onMessage = (value: unknown): void => {
      const message = parseHostMessage(value);
      if (message === undefined || message.transferId !== transferId) return;
      if (message.type === "failure") {
        fail(new HandoffError(message.reason));
        return;
      }
      if (!accepts(message)) return;
      cleanup();
      resolve(message);
    };
    const onDisconnect = (): void => fail(new HandoffError("native-disconnected"));
    const onAbort = (): void => fail(new HandoffError("bypassed"));
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new HandoffError("native-timeout")), timeoutMs);
  });
}

async function postAndWait(
  port: NativePort,
  message: ExtensionMessage,
  transferId: string,
  accepts: (message: HostMessage) => boolean,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HostMessage> {
  const reply = waitForMessage(port, transferId, accepts, signal, timeoutMs);
  port.postMessage(message);
  return reply;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (isAborted(signal)) throw new HandoffError("bypassed");
  if (signal === undefined) return reader.read();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void reader.cancel("bypassed").catch(() => undefined);
      reject(new HandoffError("bypassed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  timeoutMs = 1_000,
): Promise<void> {
  if (reader === undefined) return;
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result === "timeout") {
        await reader.cancel("fallback-drain-timeout").catch(() => undefined);
        return;
      }
      if (result.done) return;
      // Chrome's MIME stream is single-use; bounded draining preserves native fallback.
    }
  } catch {
    // Chrome owns the resulting network error surface.
  }
}

function splitChunk(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, bytes.byteLength)));
  }
  return chunks;
}

export function createNativeHandoff(
  ports: NativeHandoffPorts,
): (info: PdfStreamInfo, signal?: AbortSignal) => Promise<HandoffResult> {
  const timeoutMs = ports.timeoutMs ?? 15_000;
  return async (info, signal) => {
    const transferId = ports.createTransferId();
    let port: NativePort | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let sequence = 0;
    try {
      if (isAborted(signal)) throw new HandoffError("bypassed");
      let start: StartMessage;
      if (new URL(info.originalUrl).protocol === "file:") {
        start = {
          type: "start",
          protocolVersion: NATIVE_PROTOCOL_VERSION,
          transferId,
          disposition: "local",
          fileUrl: info.originalUrl,
        };
      } else {
        let response: Response;
        try {
          response = await ports.fetchStream(info.streamUrl, signal);
        } catch {
          throw new HandoffError("stream-network-error");
        }
        if (response.body === null) throw new HandoffError("stream-body-missing");
        reader = response.body.getReader();
        if (!response.ok) throw new HandoffError(`stream-http-${response.status}`);
        const name = displayName(info.originalUrl);
        start = {
          type: "start",
          protocolVersion: NATIVE_PROTOCOL_VERSION,
          transferId,
          disposition: "remote-temporary",
          ...(name === undefined ? {} : { displayName: name }),
        };
      }

      if (isAborted(signal)) throw new HandoffError("bypassed");
      port = ports.connectNative();
      await postAndWait(
        port,
        start,
        transferId,
        (message) => message.type === "ack" && message.phase === "start",
        signal,
        timeoutMs,
      );

      if (reader !== undefined) {
        while (true) {
          let read: ReadableStreamReadResult<Uint8Array>;
          try {
            read = await readWithAbort(reader, signal);
          } catch (error) {
            if (error instanceof HandoffError) throw error;
            throw new HandoffError("stream-network-error");
          }
          if (read.done) break;
          for (const bytes of splitChunk(read.value)) {
            const chunkSequence = sequence++;
            await postAndWait(
              port,
              createChunkMessage(transferId, chunkSequence, bytes),
              transferId,
              (message) => message.type === "ack" && message.phase === "chunk" &&
                message.sequence === chunkSequence,
              signal,
              timeoutMs,
            );
          }
        }
      }

      const reply = await postAndWait(
        port,
        { type: "finish", transferId, sequence },
        transferId,
        (message) => message.type === "success",
        signal,
        timeoutMs,
      );
      if (reply.type !== "success" || validatePlacekeeperDestination(reply.destination) === undefined) {
        throw new HandoffError("invalid-destination");
      }
      return { destination: reply.destination };
    } catch (error) {
      if (port !== undefined) {
        try {
          const message = error instanceof Error ? error.message : "handoff-failed";
          port.postMessage({
            type: "cancel",
            transferId,
            reason: /^[a-z0-9-]{1,64}$/u.test(message) ? message : "handoff-failed",
          });
        } catch {
          // The disconnected host cannot retain a transfer through this port.
        }
      }
      if (isAborted(signal)) await reader?.cancel("bypassed").catch(() => undefined);
      else await drain(reader);
      throw error;
    } finally {
      port?.disconnect();
    }
  };
}
