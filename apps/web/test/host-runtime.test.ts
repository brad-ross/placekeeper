import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import { createBrowserHostRuntime } from "../src/host/browser-runtime.js";
import {
  HOST_RUNTIME_PROTOCOL,
  HOST_RUNTIME_VERSION,
  createRpcHostRuntime,
} from "../src/host/vscode-runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("host-neutral review runtime", () => {
  it("keeps browser bootstrap, scope, assets, presence, and export on authenticated HTTP/WebSocket", async () => {
    const state = createReviewState({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/state")) return Response.json(state);
      if (path.endsWith("/scope")) return Response.json({ documentTitle: "paper.pdf", launchSurface: "browser" });
      if (path.endsWith("/save/status")) return Response.json({ destination: { phase: "none", generation: 0 }, sync: { phase: "clean", desiredRevision: 0, desiredDigest: "b".repeat(64), savedRevision: 0, savedDigest: "b".repeat(64) } });
      if (path.endsWith("/export")) return Response.json({ kind: "reviewed-copy", path: "/tmp/reviewed.pdf", revision: 0, digest: "c".repeat(64) });
      throw new Error(`Unexpected request: ${path}`);
    });
    class FakeSocket {
      static created: FakeSocket[] = [];
      constructor(readonly url: string, readonly protocols: readonly string[]) { FakeSocket.created.push(this); }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("location", new URL("http://127.0.0.1:43179/s/id/bootstrap"));
    vi.stubGlobal("window", { location: globalThis.location, setTimeout, clearTimeout });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", FakeSocket);
    const runtime = createBrowserHostRuntime({ sessionId: state.sessionId, credential: "memory-only" });

    const bootstrap = await runtime.bootstrap();
    expect(bootstrap.viewerAssets).toMatchObject({
      documentUrl: `/s/${state.sessionId}/document/${state.source.fileId}`,
      requestHeaders: { authorization: "Bearer memory-only" },
    });
    expect(bootstrap.resourcePolicy).toEqual({ host: "browser", origin: "http://127.0.0.1:43179" });
    await expect(runtime.exportReviewedCopy()).resolves.toMatchObject({ kind: "reviewed-copy" });
    expect(FakeSocket.created[0]).toMatchObject({
      protocols: ["placekeeper", "placekeeper-auth.memory-only"],
    });
    runtime.dispose();
  });

  it("bootstraps and dispatches through a versioned VS Code RPC without credentials", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const postMessage = vi.fn((message: unknown) => {
      const request = message as { requestId: string; method: string };
      queueMicrotask(() => {
        for (const listener of listeners) listener({
          protocol: HOST_RUNTIME_PROTOCOL,
          version: HOST_RUNTIME_VERSION,
          kind: "response",
          panelId: "panel_identifier_1234",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          generation: 1,
          revision: 0,
          requestId: request.requestId,
          ok: true,
          payload: request.method === "bootstrap" ? {
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            generation: 1,
            revision: 0,
            state: { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 0 },
            scope: { documentTitle: "paper.pdf", launchSurface: "vscode" },
            saveStatus: {},
            resources: {
              document: "vscode-webview://authority/snapshots/digest.pdf",
              pdfiumWasm: "vscode-webview://authority/assets/pdfium.wasm",
            },
          } : { documentTitle: "paper.pdf", launchSurface: "vscode" },
        });
      });
    });
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    const bootstrap = await runtime.bootstrap();
    expect(bootstrap.scope.launchSurface).toBe("vscode");
    await expect(runtime.scope()).resolves.toMatchObject({ documentTitle: "paper.pdf" });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("credential");
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("/Users/");
    runtime.dispose();
  });

  it("cancels an in-flight request with the same bounded request identity", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const postMessage = vi.fn();
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const controller = new AbortController();
    const pending = runtime.bootstrap(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(postMessage.mock.calls[1]?.[0]).toMatchObject({ kind: "cancel" });
    runtime.dispose();
  });
});
