import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHROME_EXTENSION_ORIGIN, ChromeTransferStore } from "../src/browser/chrome-handoff.js";
import {
  createDaemonChromeBrowserOpener,
  runChromeNativeHostCommand,
} from "../src/browser/chrome-native-host.js";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/browser/native-messaging.js";

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
  it("integrates native framing with the bounded remote handoff", async () => {
    const input = new PassThrough();
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
    const staged = await store.begin("transfer-opaque", "Opaque.pdf");
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
});
