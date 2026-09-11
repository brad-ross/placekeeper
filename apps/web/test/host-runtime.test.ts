import { afterEach, describe, expect, it, vi } from "vitest";

import { setAnnotationName } from "../../../packages/core/src/review-commands.js";
import { createReviewState } from "../../../packages/core/src/review-model.js";
import {
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
} from "../../../packages/core/src/review-runtime-protocol.js";
import {
  parseMacosNativeMessage,
  type MacosPageMessage,
} from "../../../packages/core/src/macos-shell-protocol.js";
import { createBrowserHostRuntime } from "../src/host/browser-runtime.js";
import { subscribeRuntimeDocumentSource } from "../src/host/runtime-document-source.js";
import type {
  HostRuntime,
  HostRuntimeBootstrap,
  HostRuntimeInvalidation,
} from "../src/host/runtime.js";
import {
  createRpcHostRuntime,
  materializeVscodeWorkerResource,
  materializeVscodeWasmResource,
} from "../src/host/vscode-runtime.js";
import { createMacosHostRuntime } from "../src/host/macos-runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("host-neutral review runtime", () => {
  it("bootstraps the packaged Mac runtime through an attempt-fenced native bridge", async () => {
    const runtimeId = "runtime_identifier_1234";
    const attemptId = "attempt_identifier_1234";
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createReviewState({
      sessionId,
      source: {
        fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        digest: "a".repeat(64),
        byteLength: 100,
      },
    });
    const documentBlob = "blob:placekeeper-document-resource";
    const pdfiumBlob = "blob:placekeeper-pdfium-resource";
    const workerBlob = "blob:placekeeper-worker-resource";
    vi.stubGlobal("__PLACEKEEPER_MAC_DOCUMENT_RESOURCE__", {
      source: "placekeeper-resource://document/resource_12345678?generation=1&role=document",
      url: documentBlob,
    });
    vi.stubGlobal("__PLACEKEEPER_MAC_PDFIUM_URL__", pdfiumBlob);
    vi.stubGlobal("__PLACEKEEPER_MAC_WORKER_URL__", workerBlob);
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const nativeListeners = new Set<(message: NonNullable<ReturnType<typeof parseMacosNativeMessage>>) => void>();
    const postToNative = vi.fn((wrapped: MacosPageMessage) => {
      if (wrapped.type !== "runtime-message") throw new Error("Expected a runtime request");
      const request = wrapped.message as { readonly requestId: string; readonly method: string };
      queueMicrotask(() => {
        const message = parseMacosNativeMessage({
          protocolVersion: 1,
          type: "runtime-message",
          runtimeId,
          attemptId,
          message: {
            protocol: REVIEW_RUNTIME_PROTOCOL,
            version: REVIEW_RUNTIME_VERSION,
            kind: "response",
            runtimeId,
            sessionId,
            generation: 1,
            revision: 0,
            requestId: request.requestId,
            method: request.method,
            ok: true,
            payload: {
              sessionId,
              generation: 1,
              revision: 0,
              state,
              scope: {
                documentTitle: "Paper.pdf",
                launchSurface: "macos",
                sourceRootPath: "/must/not/cross",
              },
              saveStatus: {
                destination: { phase: "none", generation: 0 },
                sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
              },
              resources: {
                document: "placekeeper-resource://document/resource_12345678?generation=1&role=document",
                pdfiumWasm: "placekeeper-app://bundle/assets/pdfium.wasm",
                worker: "placekeeper-app://bundle/assets/pdfium-worker.js",
              },
              location: { kind: "page", page: 4 },
            },
          },
        });
        if (message === undefined) throw new Error("Expected a valid native response");
        for (const listener of nativeListeners) listener(message);
      });
    });
    const runtime = createMacosHostRuntime({
      runtimeId,
      attemptId,
      postToNative,
      subscribeNative(listener) {
        nativeListeners.add(listener);
        return () => nativeListeners.delete(listener);
      },
    });

    const bootstrap = await runtime.bootstrap();
    expect(bootstrap).toMatchObject({
      scope: { documentTitle: "Paper.pdf", launchSurface: "macos" },
      resourcePolicy: {
        host: "macos",
        resources: {
          document: documentBlob,
          pdfiumWasm: pdfiumBlob,
          worker: workerBlob,
        },
      },
      viewerAssets: {
        documentUrl: documentBlob,
        pdfiumWasm: pdfiumBlob,
        workerUrl: workerBlob,
      },
    });
    expect(JSON.stringify(bootstrap)).not.toMatch(/must\/not\/cross|credential|canonicalLinkBase/u);
    expect(bootstrap.locationHistory?.read()).toEqual({ kind: "page", page: 4 });
    expect(postToNative).toHaveBeenCalledWith(expect.objectContaining({
      type: "runtime-message",
      runtimeId,
      attemptId,
    }));
    runtime.dispose();
    await Promise.resolve();
    expect(revokeObjectURL.mock.calls.map(([url]) => url).sort()).toEqual([
      documentBlob,
      pdfiumBlob,
      workerBlob,
    ].sort());
  });

  it("materializes extension-issued PDFium bytes into a worker-readable blob", async () => {
    const createObjectURL = vi.fn(() => "blob:vscode-webview://authority/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const revokeObjectURL = vi.fn();
    const resource = await materializeVscodeWasmResource("vscode-webview://authority/pdfium.wasm", {
      fetch: vi.fn(async () => new Response(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0))),
      createObjectURL,
      revokeObjectURL,
    });
    expect(resource.url).toMatch(/^blob:vscode-webview:/u);
    resource.dispose();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(resource.url);
  });

  it.each([
    ["rejected response", new Response("missing", { status: 404 })],
    ["empty response", new Response(new Uint8Array())],
    ["invalid magic", new Response(Uint8Array.of(1, 2, 3, 4))],
    ["oversized response", new Response(new Uint8Array(16 * 1024 * 1024 + 1))],
  ])("rejects a %s before creating a PDFium blob URL", async (_label, response) => {
    const createObjectURL = vi.fn(() => "blob:invalid");
    await expect(materializeVscodeWasmResource("vscode-webview://authority/pdfium.wasm", {
      fetch: vi.fn(async () => response),
      createObjectURL,
      revokeObjectURL: vi.fn(),
    })).rejects.toThrow(/packaged PDF engine/iu);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("materializes only a bounded packaged PDFium worker into a webview blob", async () => {
    const createObjectURL = vi.fn(() => "blob:vscode-webview://authority/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const revokeObjectURL = vi.fn();
    const source = 'class PdfiumEngineRunner {}\nif (message.type === "wasmInit") {}';
    const resource = await materializeVscodeWorkerResource("vscode-webview://authority/pdfium-worker.js", {
      fetch: vi.fn(async () => new Response(source)),
      createObjectURL,
      revokeObjectURL,
    });
    expect(resource.url).toMatch(/^blob:vscode-webview:/u);
    resource.dispose();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(resource.url);

    await expect(materializeVscodeWorkerResource("vscode-webview://authority/pdfium-worker.js", {
      fetch: vi.fn(async () => new Response("self.postMessage('unexpected')")),
      createObjectURL,
    })).rejects.toThrow(/packaged PDF worker/iu);
  });

  it("keeps browser bootstrap, scope, assets, presence, and export on authenticated HTTP/WebSocket", async () => {
    const state = createReviewState({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.endsWith("/state")) return Response.json(state);
      if (path.endsWith("/commands")) return Response.json({ ...state, revision: 1, annotationName: "Brad Ross" });
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
      documentUrl: `/s/${state.sessionId}/document/${state.source.fileId}?generation=1`,
      workerUrl: `/s/${state.sessionId}/assets/pdfium-worker.js`,
      requestHeaders: { authorization: "Bearer memory-only" },
    });
    expect(bootstrap.resourcePolicy).toEqual({ host: "browser", origin: "http://127.0.0.1:43179" });
    await expect(runtime.command(setAnnotationName(state, "Brad Ross"))).resolves.toMatchObject({ annotationName: "Brad Ross", revision: 1 });
    expect(fetch).toHaveBeenCalledWith(`/s/${state.sessionId}/commands`, expect.objectContaining({
      body: JSON.stringify(setAnnotationName(state, "Brad Ross")),
      headers: expect.objectContaining({ "x-placekeeper-generation": "1" }),
    }));
    await expect(runtime.exportReviewedCopy()).resolves.toMatchObject({ kind: "reviewed-copy" });
    expect(FakeSocket.created[0]).toMatchObject({
      protocols: ["placekeeper", "placekeeper-auth.memory-only"],
    });
    runtime.dispose();
  });

  it("publishes only the newest complete successor and retains the last PDF on failure", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const loaded = (generation: number, revision: number): HostRuntimeBootstrap => ({
      sessionId,
      generation,
      revision,
      session: { sessionId },
      state: createReviewState({
        sessionId,
        source: {
          fileId: `file-${generation}`,
          digest: String(generation).repeat(64),
          byteLength: generation,
        },
        workflowMode: "generated-output",
        documentGeneration: generation,
      }),
      scope: { documentTitle: "paper.pdf" },
      saveStatus: {
        destination: { phase: "none", generation: 0 },
        sync: { phase: "clean", desiredRevision: revision, savedRevision: revision },
      },
      viewerAssets: { documentUrl: `snapshot-${generation}.pdf`, pdfiumWasm: "pdfium.wasm" },
      resourcePolicy: { host: "vscode", issued: new Set([`snapshot-${generation}.pdf`, "pdfium.wasm"]) },
    });
    const completions: Array<{
      resolve: (value: HostRuntimeBootstrap) => void;
      reject: (error: Error) => void;
    }> = [];
    let listener: ((event: HostRuntimeInvalidation) => void) | undefined;
    const runtime = {
      bootstrap: vi.fn(() => new Promise<HostRuntimeBootstrap>((resolve, reject) => {
        completions.push({ resolve, reject });
      })),
      subscribeInvalidations: vi.fn((next: (event: HostRuntimeInvalidation) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }),
    } as unknown as HostRuntime;
    const published: Array<{ loaded: HostRuntimeBootstrap; refreshStatus: string }> = [];
    const initial = loaded(1, 0);
    const unsubscribe = subscribeRuntimeDocumentSource(runtime, initial, (snapshot) => published.push(snapshot));
    const event = (generation: number, previousGeneration: number, revision: number): HostRuntimeInvalidation => ({
      sessionId,
      generation,
      previousGeneration,
      revision,
      reason: "generation",
    });

    listener?.(event(2, 1, 2));
    listener?.(event(3, 2, 3));
    expect(published.map(({ refreshStatus }) => refreshStatus)).toEqual(["reconciling", "reconciling"]);
    completions[0]!.resolve(loaded(2, 2));
    await Promise.resolve();
    expect(published.at(-1)?.refreshStatus).toBe("reconciling");
    completions[1]!.resolve(loaded(3, 3));
    await Promise.resolve();
    expect(published.at(-1)).toMatchObject({ refreshStatus: "idle", loaded: { generation: 3 } });

    listener?.(event(4, 3, 4));
    completions[2]!.reject(new Error("invalid successor"));
    await vi.waitFor(() => {
      expect(published.at(-1)).toMatchObject({ refreshStatus: "failed", loaded: { generation: 3 } });
    });
    unsubscribe();
  });

  it("rehydrates same-generation freshness invalidations and fences racing refreshes", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const loaded = (revision: number, freshness: "current" | "possibly-stale"): HostRuntimeBootstrap => ({
      sessionId,
      generation: 1,
      revision,
      session: { sessionId },
      state: {
        ...createReviewState({
          sessionId,
          source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
          workflowMode: "generated-output",
          documentGeneration: 1,
        }),
        revision,
        workflow: {
          ...createReviewState({
            sessionId,
            source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
            workflowMode: "generated-output",
            documentGeneration: 1,
          }).workflow,
          freshness,
        },
      },
      scope: { documentTitle: "paper.pdf" },
      saveStatus: { destination: { phase: "none", generation: 0 }, sync: { phase: "clean", desiredRevision: revision, savedRevision: revision } },
      viewerAssets: { documentUrl: "snapshot-1.pdf", pdfiumWasm: "pdfium.wasm" },
      resourcePolicy: { host: "vscode", issued: new Set(["snapshot-1.pdf", "pdfium.wasm"]) },
    });
    const completions: Array<(value: HostRuntimeBootstrap) => void> = [];
    let listener: ((event: HostRuntimeInvalidation) => void) | undefined;
    const runtime = {
      bootstrap: vi.fn(() => new Promise<HostRuntimeBootstrap>((resolve) => completions.push(resolve))),
      subscribeInvalidations: vi.fn((next: (event: HostRuntimeInvalidation) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }),
    } as unknown as HostRuntime;
    const published: Array<{ loaded: HostRuntimeBootstrap; refreshStatus: string }> = [];
    subscribeRuntimeDocumentSource(runtime, loaded(0, "current"), (snapshot) => published.push(snapshot));

    listener?.({ sessionId, generation: 1, revision: 0, reason: "freshness" });
    listener?.({ sessionId, generation: 1, revision: 1, reason: "revision" });
    completions[0]!(loaded(0, "possibly-stale"));
    await Promise.resolve();
    expect(published.at(-1)?.refreshStatus).toBe("reconciling");
    completions[1]!(loaded(1, "possibly-stale"));
    await Promise.resolve();
    expect(published.at(-1)).toMatchObject({
      refreshStatus: "idle",
      loaded: { generation: 1, revision: 1, state: { workflow: { freshness: "possibly-stale" } } },
    });
  });

  it("rehydrates concurrent browser and VS Code views from one successor identity", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const loaded = (generation: number, host: "browser" | "vscode"): HostRuntimeBootstrap => ({
      sessionId,
      generation,
      revision: generation,
      session: { sessionId },
      state: createReviewState({
        sessionId,
        source: {
          fileId: `file-${generation}`,
          digest: String(generation).repeat(64),
          byteLength: generation,
        },
        workflowMode: "generated-output",
        documentGeneration: generation,
      }),
      scope: { documentTitle: "paper.pdf" },
      saveStatus: {
        destination: { phase: "none", generation: 0 },
        sync: { phase: "clean", desiredRevision: generation, savedRevision: generation },
      },
      viewerAssets: { documentUrl: `snapshot-${generation}.pdf`, pdfiumWasm: "pdfium.wasm" },
      resourcePolicy: host === "browser"
        ? { host, origin: "http://127.0.0.1:43179" }
        : { host, issued: new Set([`snapshot-${generation}.pdf`, "pdfium.wasm"]) },
    });
    const surface = (host: "browser" | "vscode") => {
      let listener: ((event: HostRuntimeInvalidation) => void) | undefined;
      const runtime = {
        bootstrap: vi.fn(async () => loaded(2, host)),
        subscribeInvalidations: vi.fn((next: (event: HostRuntimeInvalidation) => void) => {
          listener = next;
          return () => { listener = undefined; };
        }),
      } as unknown as HostRuntime;
      const published: Array<{ loaded: HostRuntimeBootstrap; refreshStatus: string }> = [];
      subscribeRuntimeDocumentSource(runtime, loaded(1, host), (snapshot) => published.push(snapshot));
      return { runtime, published, invalidate: (event: HostRuntimeInvalidation) => listener?.(event) };
    };
    const browser = surface("browser");
    const vscode = surface("vscode");
    const event: HostRuntimeInvalidation = {
      sessionId,
      generation: 2,
      previousGeneration: 1,
      revision: 2,
      reason: "generation",
    };

    browser.invalidate(event);
    vscode.invalidate(event);
    await vi.waitFor(() => {
      expect(browser.published.at(-1)).toMatchObject({ refreshStatus: "idle", loaded: { generation: 2 } });
      expect(vscode.published.at(-1)).toMatchObject({ refreshStatus: "idle", loaded: { generation: 2 } });
    });
    expect(browser.runtime.bootstrap).toHaveBeenCalledOnce();
    expect(vscode.runtime.bootstrap).toHaveBeenCalledOnce();
  });

  it("bootstraps and dispatches through a versioned VS Code RPC without credentials", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const postMessage = vi.fn((message: unknown) => {
      const request = message as { requestId: string; method: string };
      queueMicrotask(() => {
        for (const listener of listeners) listener({
          protocol: REVIEW_RUNTIME_PROTOCOL,
          version: REVIEW_RUNTIME_VERSION,
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
              worker: "vscode-webview://authority/assets/pdfium-worker.js",
            },
          } : { documentTitle: "paper.pdf", launchSurface: "vscode" },
        });
      });
    });
    const materializePdfiumWorker = vi.fn(async () => ({
      url: "blob:vscode-webview://authority/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      dispose: vi.fn(),
    }));
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }, { materializePdfiumWorker });

    const bootstrap = await runtime.bootstrap();
    expect(bootstrap.scope.launchSurface).toBe("vscode");
    expect(bootstrap.viewerAssets.workerUrl).toBe(
      "blob:vscode-webview://authority/cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    expect(bootstrap.resourcePolicy.host).toBe("vscode");
    if (bootstrap.resourcePolicy.host !== "vscode") throw new Error("Expected VS Code resource policy");
    expect(bootstrap.resourcePolicy.issued).toContain(bootstrap.viewerAssets.workerUrl);
    expect(materializePdfiumWorker).toHaveBeenCalledWith(
      "vscode-webview://authority/assets/pdfium-worker.js",
    );
    await expect(runtime.scope()).resolves.toMatchObject({ documentTitle: "paper.pdf" });
    const scopeRequest = postMessage.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .find((message) => message.method === "scope");
    expect(scopeRequest).toEqual({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "request",
      panelId: "panel_identifier_1234",
      requestId: expect.any(String),
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 1,
      revision: 0,
      method: "scope",
      payload: {},
    });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("credential");
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain("/Users/");
    runtime.dispose();
  });

  it("mounts a reduced Chrome RPC runtime with independent history, link, and resource seams", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const requests: Record<string, unknown>[] = [];
    const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createReviewState({
      sessionId,
      source: {
        fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        digest: "a".repeat(64),
        byteLength: 100,
      },
      sourceRootId: "must-not-cross",
    });
    const runtime = createRpcHostRuntime({
      runtimeId: "chrome_connection_1234",
      postMessage(message) {
        const request = message as Record<string, unknown>;
        requests.push(request);
        if (request.kind !== "request") return;
        queueMicrotask(() => listeners.forEach((listener) => listener({
          protocol: REVIEW_RUNTIME_PROTOCOL,
          version: REVIEW_RUNTIME_VERSION,
          kind: "response",
          runtimeId: "chrome_connection_1234",
          sessionId,
          generation: 1,
          revision: 0,
          requestId: request.requestId,
          ok: true,
          payload: request.method === "bootstrap" ? {
            sessionId,
            generation: 1,
            revision: 0,
            state,
            scope: {
              documentTitle: "Paper.pdf",
              launchSurface: "chrome",
              sourceRootPath: "/Users/reader/secret",
              codexContext: { taskId: "task-secret", bindProof: "proof-secret" },
            },
            saveStatus: {
              destination: { phase: "none", generation: 0 },
              sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 },
            },
            resources: {
              document: `blob:${extensionOrigin}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
              pdfiumWasm: `${extensionOrigin}/assets/pdfium.wasm`,
              worker: `${extensionOrigin}/assets/pdfium-worker.js`,
            },
            canonicalLinkBase: "placekeeper:///Papers/Paper.pdf",
            location: { kind: "page", page: 3 },
          } : {},
        })));
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }, { host: "chrome", extensionOrigin });

    const bootstrap = await runtime.bootstrap();
    expect(runtime.host).toBe("chrome");
    expect(bootstrap.canonicalLinkBase).toBe("placekeeper:///Papers/Paper.pdf");
    expect(bootstrap.locationHistory?.read()).toEqual({ kind: "page", page: 3 });
    expect(bootstrap.resourcePolicy).toEqual({
      host: "chrome",
      extensionOrigin,
      resources: {
        document: `blob:${extensionOrigin}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        pdfiumWasm: `${extensionOrigin}/assets/pdfium.wasm`,
        worker: `${extensionOrigin}/assets/pdfium-worker.js`,
      },
    });
    expect(JSON.stringify(bootstrap)).not.toMatch(/task-secret|proof-secret|must-not-cross|\/Users\/reader/iu);
    await expect(runtime.reverseSyncTex({})).rejects.toThrow(/unavailable.*Chrome/iu);
    expect(requests.some((request) => request.method === "reverseSyncTex")).toBe(false);
    runtime.dispose();
  });

  it("settles an older VS Code command response after a concurrent rehydrate advances the panel", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const requests: Record<string, unknown>[] = [];
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage(message) {
        if (typeof message === "object" && message !== null) requests.push(message as Record<string, unknown>);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createReviewState({
      sessionId,
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
      workflowMode: "generated-output",
      documentGeneration: 1,
    });
    const respond = (request: Record<string, unknown>, revision: number, payload: unknown) => {
      const message = {
        protocol: REVIEW_RUNTIME_PROTOCOL,
        version: REVIEW_RUNTIME_VERSION,
        kind: "response",
        panelId: "panel_identifier_1234",
        sessionId,
        generation: 1,
        revision,
        requestId: request.requestId,
        ok: true,
        payload,
      };
      listeners.forEach((listener) => listener(message));
    };
    const bootstrapPayload = (revision: number) => ({
      sessionId,
      generation: 1,
      revision,
      state: { ...state, revision },
      scope: { documentTitle: "paper.pdf" },
      saveStatus: {},
      resources: {
        document: "vscode-webview://authority/snapshots/digest.pdf",
        pdfiumWasm: "vscode-webview://authority/assets/pdfium.wasm",
      },
    });

    const initial = runtime.bootstrap();
    respond(requests.at(-1)!, 0, bootstrapPayload(0));
    await initial;
    const command = runtime.command(setAnnotationName(state, "Brad Ross"));
    const commandRequest = requests.at(-1)!;
    expect(commandRequest).toMatchObject({ generation: 1, revision: 0, payload: setAnnotationName(state, "Brad Ross") });
    const refresh = runtime.bootstrap();
    const refreshRequest = requests.at(-1)!;
    expect(refreshRequest).not.toHaveProperty("sessionId");
    expect(refreshRequest).not.toHaveProperty("generation");
    expect(refreshRequest).not.toHaveProperty("revision");
    respond(refreshRequest, 1, bootstrapPayload(1));
    await refresh;
    respond(commandRequest, 0, { ...state, revision: 1, annotationName: "Brad Ross" });

    await expect(command).resolves.toMatchObject({ revision: 1, annotationName: "Brad Ross" });
    runtime.dispose();
  });

  it("does not rehydrate the VS Code PDF for the revision returned by its own command", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const requests: Record<string, unknown>[] = [];
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage(message) {
        if (typeof message === "object" && message !== null) requests.push(message as Record<string, unknown>);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createReviewState({
      sessionId,
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
      workflowMode: "generated-output",
      documentGeneration: 1,
    });
    const respond = (request: Record<string, unknown>, revision: number, payload: unknown) => {
      const message = {
        protocol: REVIEW_RUNTIME_PROTOCOL,
        version: REVIEW_RUNTIME_VERSION,
        kind: "response",
        panelId: "panel_identifier_1234",
        sessionId,
        generation: 1,
        revision,
        requestId: request.requestId,
        ok: true,
        payload,
      };
      listeners.forEach((listener) => listener(message));
    };
    const initial = runtime.bootstrap();
    respond(requests.at(-1)!, 0, {
      sessionId,
      generation: 1,
      revision: 0,
      state,
      scope: { documentTitle: "paper.pdf" },
      saveStatus: {},
      resources: {
        document: "vscode-webview://authority/snapshots/digest.pdf",
        pdfiumWasm: "vscode-webview://authority/assets/pdfium.wasm",
      },
    });
    await initial;
    const invalidations: HostRuntimeInvalidation[] = [];
    runtime.subscribeInvalidations((event) => invalidations.push(event));

    const command = runtime.command({ type: "undo", expectedRevision: 0 });
    const commandRequest = requests.at(-1)!;
    const ownRevision = {
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "session-invalidated",
      panelId: "panel_identifier_1234",
      payload: { sessionId, generation: 1, revision: 1, reason: "revision" },
    };
    listeners.forEach((listener) => listener(ownRevision));

    expect(invalidations).toEqual([]);
    respond(commandRequest, 0, { ...state, revision: 1 });
    await expect(command).resolves.toMatchObject({ revision: 1 });
    expect(invalidations).toEqual([]);

    listeners.forEach((listener) => listener({
      ...ownRevision,
      payload: { sessionId, generation: 1, revision: 2, reason: "revision" },
    }));
    expect(invalidations).toEqual([
      { sessionId, generation: 1, revision: 2, reason: "revision" },
    ]);
    runtime.dispose();
  });

  it("releases a deferred revision invalidation when its command fails", async () => {
    const listeners = new Set<(message: unknown) => void>();
    const requests: Record<string, unknown>[] = [];
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage(message) {
        if (typeof message === "object" && message !== null) requests.push(message as Record<string, unknown>);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const state = createReviewState({
      sessionId,
      source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 100 },
      workflowMode: "generated-output",
      documentGeneration: 1,
    });
    const respond = (request: Record<string, unknown>, ok: boolean, payload: unknown) => {
      listeners.forEach((listener) => listener({
        protocol: REVIEW_RUNTIME_PROTOCOL,
        version: REVIEW_RUNTIME_VERSION,
        kind: "response",
        panelId: "panel_identifier_1234",
        sessionId,
        generation: 1,
        revision: 0,
        requestId: request.requestId,
        ok,
        payload,
      }));
    };
    const initial = runtime.bootstrap();
    respond(requests.at(-1)!, true, {
      sessionId,
      generation: 1,
      revision: 0,
      state,
      scope: { documentTitle: "paper.pdf" },
      saveStatus: {},
      resources: {
        document: "vscode-webview://authority/snapshots/digest.pdf",
        pdfiumWasm: "vscode-webview://authority/assets/pdfium.wasm",
      },
    });
    await initial;
    const invalidations: HostRuntimeInvalidation[] = [];
    runtime.subscribeInvalidations((event) => invalidations.push(event));

    const command = runtime.command({ type: "undo", expectedRevision: 0 });
    const commandRequest = requests.at(-1)!;
    listeners.forEach((listener) => listener({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "session-invalidated",
      panelId: "panel_identifier_1234",
      payload: { sessionId, generation: 1, revision: 1, reason: "revision" },
    }));
    expect(invalidations).toEqual([]);

    respond(commandRequest, false, {});
    await expect(command).rejects.toThrow("trusted host rejected");
    expect(invalidations).toEqual([
      { sessionId, generation: 1, revision: 1, reason: "revision" },
    ]);
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

  it("accepts only bounded VS Code host commands for its exact panel", () => {
    const listeners = new Set<(message: unknown) => void>();
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage: vi.fn(),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const commands: unknown[] = [];
    const unsubscribe = runtime.subscribeHostCommands?.((command) => commands.push(command));
    const publish = (message: unknown) => listeners.forEach((listener) => listener(message));

    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "other_panel_identifier",
      payload: { command: "reattach" },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "reattach", path: "/Users/reader/paper.tex" },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "reattach" },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "export-reviewed-pdf", path: "/Users/reader/reviewed.pdf" },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "export-reviewed-pdf" },
    });

    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "forward-synctex", pageIndex: 2, point: { x: 72, y: 144 } },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "forward-synctex", documentGeneration: 4, pageIndex: 2, point: { x: 72, y: 144 } },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "forward-synctex", pageIndex: -1, point: { x: 72, y: 144 } },
    });
    publish({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "reverse-synctex" },
    });

    expect(commands).toEqual([
      { command: "reattach" },
      { command: "export-reviewed-pdf" },
      { command: "forward-synctex", documentGeneration: 4, pageIndex: 2, point: { x: 72, y: 144 } },
      { command: "reverse-synctex" },
    ]);
    unsubscribe?.();
    runtime.dispose();
  });

  it("replays a VS Code invalidation that arrives before the webview subscribes", () => {
    const listeners = new Set<(message: unknown) => void>();
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage: vi.fn(),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const event = {
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 2,
      revision: 0,
      reason: "generation",
      previousGeneration: 1,
    } as const;
    for (const listener of listeners) listener({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "session-invalidated",
      panelId: "panel_identifier_1234",
      payload: event,
    });

    const received: HostRuntimeInvalidation[] = [];
    runtime.subscribeInvalidations((value) => received.push(value));
    expect(received).toEqual([event]);
    runtime.dispose();
  });

  it("replays a VS Code host command that arrives before the webview subscribes", () => {
    const listeners = new Set<(message: unknown) => void>();
    const runtime = createRpcHostRuntime({
      panelId: "panel_identifier_1234",
      postMessage: vi.fn(),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    for (const listener of listeners) listener({
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "event",
      event: "host-command",
      panelId: "panel_identifier_1234",
      payload: { command: "reverse-synctex" },
    });

    const commands: unknown[] = [];
    runtime.subscribeHostCommands?.((command) => commands.push(command));
    expect(commands).toEqual([{ command: "reverse-synctex" }]);
    runtime.dispose();
  });
});
