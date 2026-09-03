import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHROME_EXTENSION_ORIGIN, ChromeTransferStore } from "../src/browser/chrome-handoff.js";
import {
  createDaemonChromeBrowserOpener,
  runChromeNativeHostCommand,
} from "../src/browser/chrome-native-host.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/browser/native-messaging.js";
import type { ChromeRuntimeBackend } from "../src/browser/chrome-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storeFixture(): Promise<ChromeTransferStore> {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-native-host-"));
  roots.push(root);
  return ChromeTransferStore.create({
    root: join(root, "sources"),
    validate: async (path) => {
      if (!(await readFile(path)).subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new Error("invalid-pdf");
      }
    },
  });
}

describe("Chrome native host entry", () => {
  it("routes a negotiated v2 port without starting the legacy absolute watchdog", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Buffer[] = [];
    output.on("data", (chunk: Buffer) => frames.push(chunk));
    const runtimeBackend: ChromeRuntimeBackend = {
      begin: vi.fn(async () => { throw new Error("unused"); }),
      activate: vi.fn(async () => { throw new Error("unused"); }),
      current: vi.fn(async () => { throw new Error("unused"); }),
      invoke: vi.fn(async () => { throw new Error("unused"); }),
      readDocument: vi.fn(async () => Buffer.alloc(0)),
      detach: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input, output, store: await storeFixture(), runtimeBackend, maxDurationMs: 1,
    });
    input.end(encodeNativeMessage({
      type: "hello", protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
      connectionId: "connection-runtime-1",
    }));

    await expect(run).resolves.toBe(0);
    expect(new NativeMessageDecoder().push(Buffer.concat(frames))).toEqual([
      expect.objectContaining({
        type: "hello-ack", protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
        connectionId: "connection-runtime-1",
      }),
    ]);
  });

  it("actively detaches an idle proxy-mode native port without another Chrome message", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const exchange = vi.fn(async (_portId: string, message: { readonly connectionId: string }) => [{
      type: "hello-ack" as const,
      protocol: "placekeeper.chrome-runtime" as const,
      protocolVersion: 2 as const,
      connectionId: message.connectionId,
      leaseMs: 1_000,
    }]);
    const detach = vi.fn(async () => undefined);
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input, output, store: await storeFixture(), runtimeExchange: exchange,
      runtimeDetach: detach, runtimeIdleLeaseMs: 25,
    });
    input.write(encodeNativeMessage({
      type: "hello", protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
      connectionId: "connection-proxy-idle-1",
    }));

    await expect(run).resolves.toBe(0);
    expect(exchange).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledOnce();
  });

  it("grants a proxy-mode native port one fresh lease after a suspended deadline resumes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Buffer[] = [];
    const firstFrame = Promise.withResolvers<void>();
    output.on("data", (chunk: Buffer) => {
      frames.push(chunk);
      firstFrame.resolve();
    });
    let now = 0;
    const exchange = vi.fn(async (_portId: string, message: { readonly connectionId: string }) => [{
      type: "hello-ack" as const,
      protocol: "placekeeper.chrome-runtime" as const,
      protocolVersion: 2 as const,
      connectionId: message.connectionId,
      leaseMs: 1_000,
    }]);
    const detach = vi.fn(async () => undefined);
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input, output, store: await storeFixture(), runtimeExchange: exchange,
      runtimeDetach: detach, runtimeIdleLeaseMs: 25, now: () => now,
    });
    input.write(encodeNativeMessage({
      type: "hello", protocol: "placekeeper.chrome-runtime", protocolVersion: 2,
      connectionId: "connection-proxy-sleep-1",
    }));
    await firstFrame.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(exchange).toHaveBeenCalledOnce();
    expect(frames.length).toBeGreaterThan(0);

    now = 10_000;
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(detach).not.toHaveBeenCalled();

    now = 10_025;
    await expect(run).resolves.toBe(0);
    expect(detach).toHaveBeenCalledOnce();
  });

  it("integrates native framing with the bounded remote handoff", async () => {
    const input = new PassThrough();
    const pause = vi.spyOn(input, "pause");
    const resume = vi.spyOn(input, "resume");
    const output = new PassThrough();
    const frames: Buffer[] = [];
    output.on("data", (chunk: Buffer) => frames.push(chunk));
    const destination =
      "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";
    const store = await storeFixture();
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input,
      output,
      store,
      opener: {
        openLocal: vi.fn(),
        openSealed: vi.fn(async () => destination),
      },
    });

    for (const message of [
      {
        type: "start", protocolVersion: 1, transferId: "transfer-1",
        disposition: "remote-temporary",
      },
      {
        type: "chunk", transferId: "transfer-1", sequence: 0,
        data: Buffer.from("%PDF-1.7\n%%EOF").toString("base64"),
      },
      { type: "finish", transferId: "transfer-1", sequence: 1 },
    ]) input.write(encodeNativeMessage(message));
    input.end();

    await expect(run).resolves.toBe(0);
    const decoder = new NativeMessageDecoder();
    expect(decoder.push(Buffer.concat(frames))).toEqual([
      { type: "ack", transferId: "transfer-1", phase: "start" },
      { type: "ack", transferId: "transfer-1", phase: "chunk", sequence: 0 },
      { type: "success", transferId: "transfer-1", destination },
    ]);
    expect(pause).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();
  });

  it("constructs only browser-surface launches and rejects a bind proof", async () => {
    const store = await storeFixture();
    const launch = vi.fn(async () => ({
      ok: true as const,
      kind: "opened" as const,
      url: "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
      sessionId: "779e1d9d-58c1-4b12-8dc2-3449dad132c1",
      documentGeneration: 1,
      bindProof: "must-not-cross",
    }));
    const opener = createDaemonChromeBrowserOpener(store, launch);

    await expect(opener.openLocal("/private/local.pdf")).rejects.toThrow("service-unavailable");
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      pdfPath: "/private/local.pdf",
      surface: "browser",
    });
  });

  it("opens sealed bytes through the fixed narrow daemon request without forwarding a path", async () => {
    const store = await storeFixture();
    const staged = await store.begin("Opaque.pdf");
    const bytes = Buffer.from("%PDF-1.7\nopaque\n%%EOF");
    await store.append(staged, bytes);
    const handle = await store.seal(staged);
    const localLaunch = vi.fn();
    const remoteLaunch = vi.fn(async () => ({
      ok: true as const,
      kind: "opened" as const,
      url: "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
      sessionId: "779e1d9d-58c1-4b12-8dc2-3449dad132c1",
      documentGeneration: 1,
    }));
    const opener = createDaemonChromeBrowserOpener(store, localLaunch, remoteLaunch);

    await expect(opener.openSealed(handle)).resolves.toContain("/bootstrap#cap=");
    expect(localLaunch).not.toHaveBeenCalled();
    expect(remoteLaunch).toHaveBeenCalledExactlyOnceWith({
      protocolVersion: 1,
      sourceHandle: handle,
      byteLength: bytes.byteLength,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      displayName: "Opaque.pdf",
    });
    expect(JSON.stringify(remoteLaunch.mock.calls)).not.toContain(store.root);
    await expect(store.inspect(handle)).rejects.toThrow("Unknown sealed browser source");
  });

  it("rejects unauthorized callers before handoff and bounds a slow native connection", async () => {
    const unauthorizedInput = new PassThrough();
    unauthorizedInput.end();
    await expect(runChromeNativeHostCommand(["chrome-extension://evil/"], {
      input: unauthorizedInput,
      output: new PassThrough(),
      store: await storeFixture(),
    })).resolves.toBe(2);

    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Buffer[] = [];
    output.on("data", (chunk: Buffer) => frames.push(chunk));
    const store = await storeFixture();
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input,
      output,
      store,
      opener: { openLocal: vi.fn(), openSealed: vi.fn() },
      maxDurationMs: 25,
    });
    input.write(encodeNativeMessage({
      type: "start",
      protocolVersion: 1,
      transferId: "transfer-slow",
      disposition: "remote-temporary",
    }));

    await expect(run).resolves.toBe(2);
    expect(new NativeMessageDecoder().push(Buffer.concat(frames))).toEqual([
      { type: "ack", transferId: "transfer-slow", phase: "start" },
    ]);
    expect(await readdir(store.root)).toEqual([]);
  });

  it("ends at its deadline even when the review opener never settles", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const store = await storeFixture();
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input,
      output,
      store,
      opener: {
        openLocal: vi.fn(),
        openSealed: vi.fn(() => new Promise<string>(() => undefined)),
      },
      maxDurationMs: 25,
    });
    input.end(Buffer.concat([
      encodeNativeMessage({
        type: "start", protocolVersion: 1, transferId: "transfer-stalled-open",
        disposition: "remote-temporary",
      }),
      encodeNativeMessage({
        type: "chunk", transferId: "transfer-stalled-open", sequence: 0,
        data: Buffer.from("%PDF-1.7\n%%EOF").toString("base64"),
      }),
      encodeNativeMessage({ type: "finish", transferId: "transfer-stalled-open", sequence: 1 }),
    ]));

    await expect(run).resolves.toBe(2);
    expect(await readdir(store.root)).toEqual([]);
  });

  it("ends at its deadline when Chrome stops reading native-host output", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, _callback) {
        // Deliberately leave Chrome's simulated stdout backpressured forever.
      },
    });
    const run = runChromeNativeHostCommand([CHROME_EXTENSION_ORIGIN], {
      input,
      output,
      store: await storeFixture(),
      opener: { openLocal: vi.fn(), openSealed: vi.fn() },
      maxDurationMs: 25,
    });
    input.end(encodeNativeMessage({
      type: "start",
      protocolVersion: 1,
      transferId: "transfer-blocked-output",
      disposition: "remote-temporary",
    }));

    await expect(run).resolves.toBe(2);
  });
});
