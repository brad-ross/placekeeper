import { describe, expect, it, vi } from "vitest";
import { createNativeHandoff, type NativePort } from "../src/native-handoff.js";

class ReplyEvent<T> {
  readonly #listeners = new Set<(value: T) => void>();
  addListener(listener: (value: T) => void): void { this.#listeners.add(listener); }
  removeListener(listener: (value: T) => void): void { this.#listeners.delete(listener); }
  emit(value: T): void { for (const listener of this.#listeners) listener(value); }
}

function acknowledgingPort(destination: string): NativePort & { sent: unknown[] } {
  const onMessage = new ReplyEvent<unknown>();
  const onDisconnect = new ReplyEvent<void>();
  const sent: unknown[] = [];
  return {
    sent,
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage(message) {
      sent.push(message);
      const record = message as Record<string, unknown>;
      queueMicrotask(() => {
        if (record.type === "start") {
          onMessage.emit({ type: "ack", transferId: record.transferId, phase: "start" });
        } else if (record.type === "chunk") {
          onMessage.emit({
            type: "ack",
            transferId: record.transferId,
            phase: "chunk",
            sequence: record.sequence,
          });
        } else if (record.type === "finish") {
          onMessage.emit({
            type: "success",
            transferId: record.transferId,
            destination,
          });
        }
      });
    },
  };
}

describe("native PDF handoff", () => {
  const destination =
    "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";

  it("fetches the MIME stream exactly once and never fetches the suffixless original URL", async () => {
    const port = acknowledgingPort(destination);
    const fetchStream = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const handoff = createNativeHandoff({
      connectNative: () => port,
      fetchStream,
      createTransferId: () => "transfer-1",
    });

    await expect(handoff({
      originalUrl: "https://papers.example.test/download?id=42",
      streamUrl: "blob:authorized-response",
    })).resolves.toEqual({ destination });

    expect(fetchStream).toHaveBeenCalledExactlyOnceWith("blob:authorized-response", undefined);
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: "start",
      disposition: "remote-temporary",
      transferId: "transfer-1",
    }));
  });

  it("hands an exact local file URL to the host without fetching it", async () => {
    const port = acknowledgingPort(destination);
    const fetchStream = vi.fn();
    const handoff = createNativeHandoff({
      connectNative: () => port,
      fetchStream,
      createTransferId: () => "transfer-local",
    });

    await handoff({
      originalUrl: "file:///Users/reader/Documents/paper.pdf",
      streamUrl: "blob:unused-local-response",
    });

    expect(fetchStream).not.toHaveBeenCalled();
    expect(port.sent).toContainEqual({
      type: "start",
      protocolVersion: 1,
      transferId: "transfer-local",
      disposition: "local",
      fileUrl: "file:///Users/reader/Documents/paper.pdf",
    });
  });

  it("drains the single-use response before surfacing a native failure", async () => {
    const onMessage = new ReplyEvent<unknown>();
    const onDisconnect = new ReplyEvent<void>();
    const reads: number[] = [];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = reads.length;
        reads.push(next);
        if (next === 0) controller.enqueue(new Uint8Array([1]));
        else if (next === 1) controller.enqueue(new Uint8Array([2]));
        else controller.close();
      },
    });
    const port: NativePort = {
      onMessage,
      onDisconnect,
      disconnect: vi.fn(),
      postMessage(message) {
        const record = message as Record<string, unknown>;
        queueMicrotask(() => {
          if (record.type === "start") {
            onMessage.emit({ type: "ack", transferId: record.transferId, phase: "start" });
          } else if (record.type === "chunk") {
            onMessage.emit({ type: "failure", transferId: record.transferId, reason: "host-unavailable" });
          }
        });
      },
    };
    const handoff = createNativeHandoff({
      connectNative: () => port,
      fetchStream: async () => new Response(stream),
      createTransferId: () => "transfer-1",
    });

    await expect(handoff({
      originalUrl: "https://papers.example.test/single-use",
      streamUrl: "blob:single-use",
    })).rejects.toThrow("host-unavailable");

    expect(reads.length).toBeGreaterThanOrEqual(3);
  });

  it("cancels a stalled MIME stream immediately when the user bypasses Placekeeper", async () => {
    const port = acknowledgingPort(destination);
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const controller = new AbortController();
    const handoff = createNativeHandoff({
      connectNative: () => port,
      fetchStream: async () => new Response(stream),
      createTransferId: () => "transfer-bypass",
    });

    const result = handoff({
      originalUrl: "https://papers.example.test/stalled.pdf",
      streamUrl: "blob:stalled-response",
    }, controller.signal);
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: "start" })));
    controller.abort();

    await expect(result).rejects.toThrow("bypassed");
    expect(cancelled).toHaveBeenCalled();
    expect(port.sent).toContainEqual(expect.objectContaining({ type: "cancel" }));
  });
});
