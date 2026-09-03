import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { createReviewState } from "../../../packages/core/src/review-model.js";
import {
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
} from "../../../packages/core/src/review-runtime-protocol.js";
import { startHttpServer } from "../../service/src/server/http-server.js";
import { SessionBroker } from "../../service/src/sessions/session-broker.js";
import { subscribeRuntimeDocumentSource } from "../../web/src/host/runtime-document-source.js";
import { createRpcHostRuntime } from "../../web/src/host/vscode-runtime.js";
import {
  INPUT_UNAVAILABLE,
  UNSUPPORTED_CONTEXT,
  choosePdfInput,
  classifyWorkspace,
  localSourceRoot,
  resolveSourceOutputBinding,
  resolveExternalLauncherPath,
  resolveLauncherPath,
  selectedUriArguments,
  tabResourceUri,
} from "../src/local-workspace.js";
import {
  buildReviewWebviewHtml,
  parseSharedAssetManifest,
  parseLaunchResponse,
  reviewPanelOptions,
} from "../src/review-panel.js";
import {
  createPrivateSnapshotDirectory,
  exchangeVscodeLaunch,
  materializePrivatePdfSnapshot,
  markLiveDocumentPossiblyStale,
  observeLiveDocument,
  runLaunchClient,
} from "../src/launch-client.js";
import {
  createLoopbackRuntimeClient,
  forwardSyncTexRetryable,
  forwardSyncTexStatus,
  forwardSyncTexTarget,
  parseWebviewRequest,
  VersionedWebviewBridge,
} from "../src/webview-bridge.js";
import { containedSourcePath } from "../src/latex-project.js";
import {
  openSourceEditor,
  preferredVisibleSourceEditor,
  sourceLineNumber,
  sourceLineReveal,
} from "../src/source-navigation.js";

describe("VS Code local host adapter", () => {
  it("reuses the editor group where the reverse SyncTeX source is already visible", () => {
    const sourceDocument = { uri: { toString: () => "file:///work/paper.tex" } };
    expect(preferredVisibleSourceEditor([
      { document: { uri: { toString: () => "file:///work/notes.tex" } }, viewColumn: 2 },
      { document: sourceDocument, viewColumn: 1 },
    ], sourceDocument.uri)?.viewColumn).toBe(1);
  });

  it("opens a hidden source tab in its existing group instead of beside the PDF", async () => {
    const sourceDocument = { uri: { toString: () => "file:///work/paper.tex" } };
    const openTextDocument = vi.fn(async () => sourceDocument);
    const showTextDocument = vi.fn(async (document, options) => ({ document, viewColumn: options.viewColumn }));

    const editor = await openSourceEditor({
      sourceUri: sourceDocument.uri,
      visibleEditors: [{
        document: { uri: { toString: () => "file:///work/notes.tex" } },
        viewColumn: 1,
      }],
      tabGroups: [
        { viewColumn: 1, tabs: [{ input: { uri: sourceDocument.uri } }] },
        { viewColumn: 2, tabs: [{ input: { uri: { toString: () => "file:///work/paper.pdf" } } }] },
      ],
      avoidViewColumn: 2,
      tabResourceUri: (input) => (input as { uri?: typeof sourceDocument.uri }).uri,
      openTextDocument,
      showTextDocument,
    });

    expect(openTextDocument).toHaveBeenCalledOnce();
    expect(showTextDocument).toHaveBeenCalledWith(sourceDocument, {
      viewColumn: 1,
      preview: true,
      preserveFocus: false,
    });
    expect(editor.viewColumn).toBe(1);
  });

  it("does not reopen a source document that is already visible", async () => {
    const sourceDocument = { uri: { toString: () => "file:///work/paper.tex" } };
    const visibleEditor = { document: sourceDocument, viewColumn: 1 };
    const openTextDocument = vi.fn(async () => sourceDocument);
    const showTextDocument = vi.fn(async (document, options) => ({ document, viewColumn: options.viewColumn }));

    await openSourceEditor({
      sourceUri: sourceDocument.uri,
      visibleEditors: [visibleEditor],
      tabGroups: [],
      avoidViewColumn: 2,
      tabResourceUri: () => undefined,
      openTextDocument,
      showTextDocument,
    });

    expect(openTextDocument).not.toHaveBeenCalled();
    expect(showTextDocument).toHaveBeenCalledWith(sourceDocument, {
      viewColumn: 1,
      preview: true,
      preserveFocus: false,
    });
  });

  it("reveals an exact SyncTeX column and highlights its source character", () => {
    expect(sourceLineReveal("This is the source line.", 8)).toEqual({
      character: 8,
      highlightStart: 8,
      highlightEnd: 9,
    });
  });

  it("highlights the mapped source line when SyncTeX has no column", () => {
    expect(sourceLineReveal("  This is the source line.")).toEqual({
      character: 2,
      highlightStart: 0,
      highlightEnd: 26,
    });
  });

  it("rejects stale SyncTeX lines and exact columns instead of clamping them", () => {
    expect(sourceLineNumber(20, 21)).toBeUndefined();
    expect(sourceLineNumber(20, 0)).toBeUndefined();
    expect(sourceLineReveal("short", 6)).toBeUndefined();
  });

  it("resolves broker-relative SyncTeX sources only inside the approved root", () => {
    expect(containedSourcePath("/work/project", "chapters/one.tex"))
      .toBe("/work/project/chapters/one.tex");
    expect(containedSourcePath("/work/project", "/work/project/paper.tex"))
      .toBe("/work/project/paper.tex");
    expect(containedSourcePath("/work/project", "../secret.tex")).toBeUndefined();
  });

  it("uses Placekeeper for every VS Code identity", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("apps/vscode/package.json"), "utf8"),
    ) as {
      name: string;
      displayName: string;
      description: string;
      publisher: string;
      icon: string;
      main: string;
      activationEvents: string[];
      contributes: {
        commands: Array<{
          command: string;
          title: string;
          icon: { light: string; dark: string };
        }>;
        keybindings: Array<{
          command: string;
          key: string;
          mac: string;
          when: string;
        }>;
        configuration: {
          title: string;
          properties: Record<string, { description: string }>;
        };
      };
    };

    expect(manifest).toMatchObject({
      name: "placekeeper-vscode",
      displayName: "Placekeeper",
      publisher: "placekeeper-local",
      icon: "assets/placekeeper.png",
      main: "./dist/extension.cjs",
      activationEvents: expect.arrayContaining([
        "onCommand:placekeeper.viewPdf",
        "onWebviewPanel:placekeeper.review",
      ]),
      contributes: {
        commands: expect.arrayContaining([
          expect.objectContaining({ command: "placekeeper.viewPdf", title: "Placekeeper: View PDF" }),
          expect.objectContaining({ command: "placekeeper.forwardSyncTex" }),
          expect.objectContaining({ command: "placekeeper.goToSource" }),
          expect.objectContaining({ command: "placekeeper.reattach" }),
          expect.objectContaining({ command: "placekeeper.exportReviewedPdf" }),
          expect.objectContaining({ command: "placekeeper.configureLatexWorkshop" }),
        ]),
        configuration: {
          title: "Placekeeper",
          properties: {
            "placekeeper.launcherPath": {
              description: "Absolute path to the installed Placekeeper launcher.",
            },
          },
        },
      },
    });
    expect(manifest.description).toContain("Placekeeper");
    expect(manifest.contributes.keybindings).toEqual([
      {
        command: "placekeeper.forwardSyncTex",
        key: "ctrl+alt+shift+j",
        mac: "cmd+alt+shift+j",
        when: "editorLangId == latex",
      },
      {
        command: "placekeeper.goToSource",
        key: "ctrl+alt+shift+j",
        mac: "cmd+alt+shift+j",
        when: "activeWebviewPanelId == 'placekeeper.review'",
      },
    ]);
    expect((manifest as unknown as { scripts: { build: string } }).scripts.build)
      .toContain("copy-web-assets.mjs");
  });

  it("accepts only the shared production asset manifest", () => {
    expect(parseSharedAssetManifest({
      schemaVersion: 3,
      app: "app.js",
      stylesheet: "app.css",
      pdfiumWasm: "pdfium.wasm",
      pdfiumWorker: "pdfium-worker.js",
      integrity: {
        "app.js": "a".repeat(64),
        "app.css": "b".repeat(64),
        "pdfium.wasm": "c".repeat(64),
        "pdfium-worker.js": "d".repeat(64),
      },
    })).toMatchObject({ schemaVersion: 3, app: "app.js", pdfiumWorker: "pdfium-worker.js" });
    expect(() => parseSharedAssetManifest({
      schemaVersion: 3,
      app: "../../secret.js",
      stylesheet: "app.css",
      pdfiumWasm: "pdfium.wasm",
      pdfiumWorker: "pdfium-worker.js",
      integrity: {},
    })).toThrow(/manifest/u);
  });

  it("uses an existing configured launcher first and otherwise the user-local Placekeeper path", () => {
    expect(resolveLauncherPath("/custom/Placekeeper.app/placekeeper", "/Users/reader"))
      .toBe("/custom/Placekeeper.app/placekeeper");
    expect(resolveLauncherPath(undefined, "/Users/reader")).toBe(
      "/Users/reader/Applications/Placekeeper.app/Contents/MacOS/placekeeper",
    );
    expect(resolveExternalLauncherPath(undefined, "/Users/reader")).toBe(
      "/Users/reader/Applications/Placekeeper.app/Contents/MacOS/placekeeper-vscode",
    );
  });

  it("rejects remote, web, virtual, and non-file workspaces", () => {
    expect(classifyWorkspace({ remoteName: "ssh-remote", uiKind: "desktop", workspaceSchemes: ["file"] })).toEqual(UNSUPPORTED_CONTEXT);
    expect(classifyWorkspace({ uiKind: "web", workspaceSchemes: ["file"] })).toEqual(UNSUPPORTED_CONTEXT);
    expect(classifyWorkspace({ uiKind: "desktop", workspaceSchemes: ["vscode-vfs"] })).toEqual(UNSUPPORTED_CONTEXT);
    expect(classifyWorkspace({ uiKind: "desktop", workspaceSchemes: ["file"] })).toBeUndefined();
  });

  it("accepts one explicit local PDF and maps every other input to the shared error", () => {
    expect(choosePdfInput({ active: { scheme: "file", fsPath: "/tmp/paper.pdf" }, selected: [] })).toBe("/tmp/paper.pdf");
    expect(choosePdfInput({ selected: [{ scheme: "file", fsPath: "/tmp/paper.PDF" }] })).toBe("/tmp/paper.PDF");
    expect(choosePdfInput({ selected: [] })).toEqual(INPUT_UNAVAILABLE);
    expect(choosePdfInput({ selected: [{ scheme: "file", fsPath: "/tmp/a.pdf" }, { scheme: "file", fsPath: "/tmp/b.pdf" }] })).toEqual(INPUT_UNAVAILABLE);
    expect(choosePdfInput({ selected: [{ scheme: "https", fsPath: "/tmp/paper.pdf" }] })).toEqual(INPUT_UNAVAILABLE);
  });

  it("reads the active resource from custom editor tabs", () => {
    const uri = { scheme: "file", fsPath: "/tmp/paper.pdf" };
    expect(tabResourceUri({ uri })).toEqual(uri);
    expect(tabResourceUri({ uri: { scheme: "file" } })).toBeUndefined();
    expect(tabResourceUri({ modified: uri })).toBeUndefined();
    expect(tabResourceUri(null)).toBeUndefined();
  });

  it("ignores internal command values so the active resource remains usable", () => {
    const pdf = { scheme: "file", fsPath: "/work/paper.pdf" };
    expect(selectedUriArguments({ command: "placekeeper.viewPdf" }, undefined)).toEqual([]);
    expect(selectedUriArguments(pdf, undefined)).toEqual([pdf]);
    expect(selectedUriArguments(undefined, [{ id: "internal" }, pdf])).toEqual([pdf]);
  });

  it("accepts only structured loopback launch results and emits a direct, network-denying webview", () => {
    const result = parseLaunchResponse(JSON.stringify({ ok: true, kind: "focused", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=vscode#cap=secret" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful launch");
    if (result.kind === "recovery-offered") throw new Error("expected a scoped URL");
    expect(result.kind).toBe("focused");
    const html = buildReviewWebviewHtml({
      nonce: "nonce-value",
      panelId: "panel_identifier_1234",
      panelKey: "opaque-panel-key",
      scriptUri: "vscode-webview://authority/assets/app.js",
      styleUri: "vscode-webview://authority/assets/app.css",
      cspSource: "vscode-webview://authority",
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("worker-src blob:");
    expect(html).toContain("img-src blob: data: vscode-webview://authority");
    expect(html).toContain("connect-src vscode-webview://authority");
    expect(html).toContain("startVscode");
    expect(html).toContain('panelKey: "opaque-panel-key"');
    expect(html.indexOf("vscode.setState")).toBeLessThan(html.indexOf("await import"));
    expect(html).not.toContain("savedState");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("localhost");
    expect(html).not.toContain("cap=secret");
    expect(() => buildReviewWebviewHtml({
      nonce: "nonce-value",
      panelId: "panel_identifier_1234",
      scriptUri: "https://file+.vscode-resource.vscode-cdn.net/assets/app.js",
      styleUri: "https://file+.vscode-resource.vscode-cdn.net/assets/app.css",
      cspSource: "'self' https://*.vscode-cdn.net",
    })).not.toThrow();
    expect(() => buildReviewWebviewHtml({
      nonce: "nonce-value",
      panelId: "panel_identifier_1234",
      scriptUri: "vscode-webview://authority/assets/app.js",
      styleUri: "vscode-webview://authority/assets/app.css",
      cspSource: "'self' https://*.vscode-cdn.net https://example.com",
    })).toThrow(/CSP source/u);
    const options = reviewPanelOptions([]);
    expect(options.localResourceRoots).toEqual([]);
    expect(options.enableScripts).toBe(true);
    expect(options.retainContextWhenHidden).toBe(false);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "opened", url: "https://example.com/#cap=secret" }))).toThrow(/loopback/u);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "opened", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=other#cap=secret" }))).toThrow(/loopback/u);
  });

  it("records the panel key before the shared application can fail to import", () => {
    const html = buildReviewWebviewHtml({
      nonce: "nonce-value",
      panelId: "panel_identifier_1234",
      panelKey: "opaque-panel-key",
      scriptUri: "vscode-webview://authority/assets/app.js",
      styleUri: "vscode-webview://authority/assets/app.css",
      cspSource: "vscode-webview://authority",
    });
    const moduleScript = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/u)?.[1];
    expect(moduleScript).toBeDefined();
    const beforeImport = moduleScript!.slice(0, moduleScript!.indexOf("const app = await import"));
    const vscode = {
      getState: vi.fn(() => ({ pageIndex: 4, zoom: 1.25 })),
      setState: vi.fn(),
    };

    expect(() => runInNewContext(`${beforeImport}\nthrow new Error("import failed");`, {
      acquireVsCodeApi: () => vscode,
    })).toThrow("import failed");
    expect(vscode.setState).toHaveBeenCalledWith({
      panelKey: "opaque-panel-key",
      pageIndex: 4,
      zoom: 1.25,
    });
  });

  it("validates the versioned webview RPC envelope before dispatch", () => {
    const expected = {
      panelId: "panel_identifier_1234",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 2,
      revision: 7,
    };
    const request = {
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "request",
      panelId: expected.panelId,
      requestId: "request_identifier_1234",
      sessionId: expected.sessionId,
      generation: expected.generation,
      revision: expected.revision,
      method: "scope",
      payload: {},
    };
    expect(parseWebviewRequest(request, expected, new Set())).toEqual(request);
  });

  it("rehydrates through the real bridge with an identity-free successor bootstrap", async () => {
    const panelId = "panel_identifier_1234";
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const identity = { panelId, sessionId, generation: 1, revision: 0 };
    const listeners = new Set<(message: unknown) => void>();
    const bootstrap = vi.fn(async () => {
      const state = createReviewState({
        sessionId,
        source: {
          fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          digest: String(identity.generation).repeat(64),
          byteLength: identity.generation,
        },
        workflowMode: "generated-output",
        documentGeneration: identity.generation,
      });
      return {
        sessionId,
        generation: identity.generation,
        revision: identity.revision,
        state: { ...state, revision: identity.revision },
        scope: { documentTitle: "paper.pdf", launchSurface: "vscode" },
        saveStatus: {},
        resources: {
          document: `vscode-webview://authority/snapshot-${identity.generation}.pdf`,
          pdfiumWasm: "vscode-webview://authority/pdfium.wasm",
        },
      };
    });
    const bridge = new VersionedWebviewBridge({
      identity,
      bootstrap,
      invoke: vi.fn(async () => ({})),
      dispose: vi.fn(),
    }, (message) => listeners.forEach((listener) => listener(message)));
    const runtime = createRpcHostRuntime({
      panelId,
      postMessage: (message) => { void bridge.receive(message); },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });

    await expect(runtime.bootstrap()).resolves.toMatchObject({ generation: 1 });
    identity.generation = 2;
    identity.revision = 3;
    await expect(runtime.bootstrap()).resolves.toMatchObject({ generation: 2, revision: 3 });
    expect(bootstrap).toHaveBeenCalledTimes(2);

    runtime.dispose();
    bridge.dispose();
  });

  it.each([
    ["malformed", null],
    ["wrong protocol", { protocol: "other" }],
    ["wrong version", { version: 99 }],
    ["wrong panel", { panelId: "panel_identifier_9999" }],
    ["wrong session", { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    ["wrong generation", { generation: 1 }],
    ["wrong revision", { revision: 6 }],
    ["arbitrary method", { method: "fetch" }],
    ["arbitrary URL primitive", { payload: { url: "http://127.0.0.1:43179/secret" } }],
    ["arbitrary path primitive", { payload: { path: "/Users/reader/secret.pdf" } }],
    ["oversized payload", { payload: { text: "x".repeat(70_000) } }],
  ])("rejects %s webview messages", (_label, replacement) => {
    const expected = {
      panelId: "panel_identifier_1234",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 2,
      revision: 7,
    };
    const valid = {
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "request",
      panelId: expected.panelId,
      requestId: "request_identifier_1234",
      sessionId: expected.sessionId,
      generation: expected.generation,
      revision: expected.revision,
      method: "scope",
      payload: {},
    };
    const candidate = replacement === null ? null : { ...valid, ...replacement };
    expect(parseWebviewRequest(candidate, expected, new Set())).toBeUndefined();
  });

  it("rejects replayed request identities", () => {
    const expected = {
      panelId: "panel_identifier_1234",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 2,
      revision: 7,
    };
    const request = {
      protocol: REVIEW_RUNTIME_PROTOCOL,
      version: REVIEW_RUNTIME_VERSION,
      kind: "request",
      panelId: expected.panelId,
      requestId: "request_identifier_1234",
      sessionId: expected.sessionId,
      generation: expected.generation,
      revision: expected.revision,
      method: "scope",
      payload: {},
    };
    expect(parseWebviewRequest(request, expected, new Set([request.requestId]))).toBeUndefined();
  });

  it("passes a source root only for a local workspace containing the PDF", () => {
    const pdf = { scheme: "file", fsPath: "/tmp/project/paper.pdf" };
    expect(localSourceRoot(pdf, { scheme: "file", fsPath: "/tmp/project" })).toBe("/tmp/project");
    expect(localSourceRoot(pdf, undefined)).toBeUndefined();
    expect(localSourceRoot(pdf, { scheme: "vscode-vfs", fsPath: "/tmp/project" })).toBeUndefined();
  });

  it("binds an explicit output, one conservative candidate, or asks the user to choose", () => {
    const source = { scheme: "file", fsPath: "/work/paper.tex" };
    expect(resolveSourceOutputBinding({
      activeSource: source,
      explicitPdf: { scheme: "file", fsPath: "/other/result.pdf" },
      candidates: [],
    })).toEqual({ kind: "bound", uri: { scheme: "file", fsPath: "/other/result.pdf" } });
    expect(resolveSourceOutputBinding({
      activeSource: source,
      candidates: [{ scheme: "file", fsPath: "/work/paper.pdf" }],
    })).toMatchObject({ kind: "bound" });
    expect(resolveSourceOutputBinding({
      activeSource: source,
      candidates: [
        { scheme: "file", fsPath: "/work/build-a/paper.pdf" },
        { scheme: "file", fsPath: "/work/build-b/paper.pdf" },
      ],
    })).toMatchObject({ kind: "choose", candidates: expect.any(Array) });
  });

  it("accepts only the exact recovery choice contract", () => {
    const recoveryOffer = {
      id: "opaque_recovery_offer_1234",
      expiresAt: "2026-08-21T20:00:00.000Z",
    };
    expect(parseLaunchResponse(JSON.stringify({ ok: true, kind: "recovery-offered", choices: ["resume", "discard", "fork"], recoverySessionId: "opaque-session", recoveryOffer }))).toMatchObject({ kind: "recovery-offered", recoveryOffer });
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "recovery-offered", choices: ["resume", "fork"], recoverySessionId: "opaque-session", recoveryOffer }))).toThrow(/invalid/u);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "recovery-offered", choices: ["resume", "discard", "fork"], recoverySessionId: "opaque-session" }))).toThrow(/invalid/u);
  });

  it("accepts the bounded shared upgrade-required error without weakening URL checks", () => {
    expect(parseLaunchResponse(JSON.stringify({
      ok: false,
      error: {
        kind: "upgrade-required",
        message: "Placekeeper has an active Codex task. Existing work was preserved.",
        recoveryAction: "End the bound Codex task or wait for its lease, then retry",
      },
    }))).toMatchObject({ ok: false, error: { kind: "upgrade-required" } });
  });

  it("spawns the launch client without a shell and bounds stdout", async () => {
    const invoke = vi.fn(async () => ({ stdout: JSON.stringify({ ok: true, kind: "opened", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=vscode#cap=secret" }), stderr: "" }));
    const result = await runLaunchClient("/Applications/Placekeeper.app/Contents/MacOS/placekeeper", "/tmp/paper.pdf", undefined, invoke);
    expect(invoke).toHaveBeenCalledWith("/Applications/Placekeeper.app/Contents/MacOS/placekeeper", ["open", "--json", "--surface", "vscode", "--pdf", "/tmp/paper.pdf"], { shell: false, timeoutMs: 15_000, maxOutputBytes: 65_536 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful launch");
    expect(result.kind).toBe("opened");
  });

  it("requests generated-output mode and sends observation only to the authenticated broker", async () => {
    const invoke = vi.fn(async (
      _executable: string,
      _args: readonly string[],
      _options: { readonly shell: false; readonly timeoutMs: number; readonly maxOutputBytes: number },
    ) => ({
      stdout: JSON.stringify({ ok: true, kind: "opened", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=vscode#cap=secret" }),
      stderr: "",
    }));
    await runLaunchClient("/placekeeper", "/tmp/paper.pdf", "/tmp", invoke, undefined, "generated-output");
    expect(invoke.mock.calls[0]![1]).toContain("--generated-output");

    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ status: "same-digest" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const launch = {
      origin: "http://127.0.0.1:49152",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credential: "c".repeat(43),
    };
    await observeLiveDocument(launch, { outputPath: "/tmp/paper.pdf", observationEpoch: 4 }, fetch);
    await markLiveDocumentPossiblyStale(launch, { observationEpoch: 5 }, fetch);
    expect(fetch.mock.calls[0]![0]).toBe(`${launch.origin}/s/${launch.sessionId}/observe`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        authorization: `Bearer ${launch.credential}`,
        origin: launch.origin,
      }),
    });
    expect(fetch.mock.calls[1]![0]).toBe(`${launch.origin}/s/${launch.sessionId}/stale`);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ body: JSON.stringify({ observationEpoch: 5 }) });
  });

  it("pins bootstrap document bytes to the state generation", async () => {
    const state = createReviewState({
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: {
        fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        digest: "d".repeat(64),
        byteLength: 3,
      },
      workflowMode: "generated-output",
      documentGeneration: 4,
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/state")) return new Response(JSON.stringify(state));
      if (url.pathname.endsWith("/scope")) return new Response(JSON.stringify({ documentTitle: "paper.pdf" }));
      if (url.pathname.endsWith("/save/status")) return new Response(JSON.stringify({}));
      expect(url.pathname).toMatch(/\/document\/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb$/u);
      expect(url.searchParams.get("generation")).toBe("4");
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const materializeDocument = vi.fn(async () => "vscode-webview://authority/paper.pdf");
    const client = createLoopbackRuntimeClient({
      panelId: "panel_identifier_1234",
      launch: {
        origin: "http://127.0.0.1:49152",
        sessionId: state.sessionId,
        credential: "c".repeat(43),
      },
      assets: { pdfiumWasm: "vscode-webview://authority/pdfium.wasm" },
      materializeDocument,
      fetch,
    });

    await expect(client.bootstrap(new AbortController().signal)).resolves.toMatchObject({ generation: 4 });
    expect(materializeDocument).toHaveBeenCalledWith(expect.objectContaining({ generation: 4 }));
    client.dispose();
  });

  it("keeps absolute SyncTeX source paths in the trusted extension host", async () => {
    const opened = vi.fn(async () => undefined);
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ origin: "http://127.0.0.1:49152" }));
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/synctex/forward")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          sourcePath: "/work/paper.tex", line: 12, column: 4,
        });
        return new Response(JSON.stringify({
          status: "ok", documentGeneration: 4, target: { pageIndex: 0, x: 1, y: 2 },
        }));
      }
      return new Response(JSON.stringify({
        status: "ok",
        target: {
          path: "/work/paper.tex", line: 12, column: 4, confidence: "high", provenance: "synctex",
        },
      }));
    });
    const client = createLoopbackRuntimeClient({
      panelId: "panel_identifier_1234",
      launch: {
        origin: "http://127.0.0.1:49152",
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credential: "c".repeat(43),
      },
      assets: { pdfiumWasm: "vscode-webview://authority/pdfium.wasm" },
      materializeDocument: async () => "vscode-webview://authority/paper.pdf",
      forwardSourceLocation: () => ({ sourcePath: "/work/paper.tex", line: 12, column: 4 }),
      openSourceLocation: opened,
      fetch,
    });
    await expect(client.invoke("forwardSyncTex", {}, new AbortController().signal))
      .resolves.toMatchObject({ status: "ok", documentGeneration: 4, target: { pageIndex: 0, x: 1, y: 2 } });
    const reverse = await client.invoke("reverseSyncTex", { pageIndex: 0, point: { x: 1, y: 2 } }, new AbortController().signal);
    expect(reverse).toMatchObject({ target: { line: 12, column: 4 } });
    expect(reverse).not.toHaveProperty("target.path");
    expect(opened).toHaveBeenCalledWith({ sourcePath: "/work/paper.tex", line: 12, column: 4 });
    expect(forwardSyncTexTarget({ status: "ok", documentGeneration: 4, target: { pageIndex: 2, x: 10, y: 20 } }))
      .toEqual({ documentGeneration: 4, pageIndex: 2, point: { x: 10, y: 20 } });
    expect(forwardSyncTexTarget({ status: "ok", target: { pageIndex: 2, x: 10, y: 20 } }))
      .toBeUndefined();
    for (const documentGeneration of [-1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1]) {
      expect(forwardSyncTexTarget({
        status: "ok",
        documentGeneration,
        target: { pageIndex: 2, x: 10, y: 20 },
      })).toBeUndefined();
    }
    expect(forwardSyncTexTarget({ status: "ok", documentGeneration: 4, target: { pageIndex: -1, x: 10, y: 20 } }))
      .toBeUndefined();
    expect(forwardSyncTexRetryable({ status: "pending" })).toBe(true);
    expect(forwardSyncTexRetryable({ status: "stale" })).toBe(true);
    expect(forwardSyncTexRetryable({ status: "missing" })).toBe(false);
    expect(forwardSyncTexStatus({ status: "out-of-root" })).toBe("out-of-root");
    expect(forwardSyncTexStatus({ status: "ok", target: { pageIndex: 2, x: 10, y: 20 } }))
      .toBeUndefined();
    expect(forwardSyncTexStatus({ status: "other" })).toBeUndefined();
  });

  it("does not run reverse SyncTeX for an untrusted workspace", async () => {
    const fetch = vi.fn();
    const opened = vi.fn(async () => undefined);
    const client = createLoopbackRuntimeClient({
      panelId: "panel_identifier_1234",
      launch: {
        origin: "http://127.0.0.1:49152",
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        credential: "c".repeat(43),
      },
      assets: { pdfiumWasm: "vscode-webview://authority/pdfium.wasm" },
      materializeDocument: async () => "vscode-webview://authority/paper.pdf",
      sourceNavigationAllowed: () => false,
      openSourceLocation: opened,
      fetch,
    });

    await expect(client.invoke(
      "reverseSyncTex",
      { pageIndex: 0, point: { x: 1, y: 2 } },
      new AbortController().signal,
    )).resolves.toEqual({ status: "failed", reason: "workspace-untrusted" });
    expect(fetch).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    client.dispose();
  });

  it("materializes a rebuilt PDF after an originless VS Code control notification", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "placekeeper-vscode-control-"));
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let client: ReturnType<typeof createLoopbackRuntimeClient> | undefined;
    let bridge: VersionedWebviewBridge | undefined;
    let runtime: ReturnType<typeof createRpcHostRuntime> | undefined;
    let broker: SessionBroker | undefined;
    let sessionId: string | undefined;
    try {
      const assets = resolve(temporary, "assets");
      await mkdir(assets);
      await writeFile(resolve(assets, "app.js"), "export function start() {}\n");
      const pdfPath = resolve(temporary, "paper.pdf");
      const original = await PDFDocument.create();
      original.addPage([320, 240]);
      await writeFile(pdfPath, await original.save({ useObjectStreams: false }));
      broker = new SessionBroker({
        recoveryRoot: resolve(temporary, "recovery"),
        portableReader: async () => [],
        rewriteAssessor: async () => ({ eligible: true }),
        inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "successor" }] }),
      });
      const opened = await broker.openReview({
        pdfPath,
        surface: "vscode",
        workflowMode: "generated-output",
      });
      if (opened.kind !== "opened") throw new Error("Expected a new VS Code review");
      sessionId = opened.launch.sessionId;
      server = await startHttpServer(broker, { webAssets: { root: assets } });
      const exchange = await fetch(`${server.origin}/s/${opened.launch.sessionId}/exchange`, {
        method: "POST",
        headers: { origin: server.origin, "content-type": "application/json" },
        body: JSON.stringify({ capability: opened.launch.fragment.slice("#cap=".length) }),
      });
      const { credential } = await exchange.json() as { credential: string };
      const materialized: string[] = [];
      const registeredSocket = vi.spyOn(broker.controls, "registerSocket");
      const authenticatedSurface = vi.spyOn(broker, "authenticateSurface");
      client = createLoopbackRuntimeClient({
        panelId: "panel_identifier_1234",
        launch: { origin: server.origin, sessionId: opened.launch.sessionId, credential },
        assets: { pdfiumWasm: "vscode-webview://authority/pdfium.wasm" },
        materializeDocument: async ({ digest }) => {
          materialized.push(digest);
          return `vscode-webview://authority/${digest}.pdf`;
        },
        fetch: (input, init) => String(input).endsWith("/save/status")
          ? Promise.resolve(new Response(JSON.stringify({ destination: { phase: "none", generation: 0 } })))
          : fetch(input, init),
      });
      const messages = new Set<(message: unknown) => void>();
      bridge = new VersionedWebviewBridge(client, (message) => {
        for (const listener of messages) listener(message);
      });
      runtime = createRpcHostRuntime({
        panelId: "panel_identifier_1234",
        postMessage: (message) => { void bridge!.receive(message); },
        subscribe(listener) {
          messages.add(listener);
          return () => messages.delete(listener);
        },
      });
      const initial = await runtime.bootstrap();
      await vi.waitFor(() => expect(registeredSocket).toHaveBeenCalledTimes(1));
      expect(authenticatedSurface).toHaveBeenCalledWith(
        opened.launch.sessionId,
        credential,
        "vscode",
      );
      const published: Array<{ generation: number; freshness: string; refreshStatus: string }> = [];
      const unsubscribe = subscribeRuntimeDocumentSource(runtime, initial, ({ loaded, refreshStatus }) => {
        published.push({
          generation: loaded.generation,
          freshness: loaded.state.workflow.freshness,
          refreshStatus,
        });
      });

      const successor = await PDFDocument.create();
      successor.setTitle("rebuilt");
      successor.addPage([320, 240]);
      await writeFile(pdfPath, await successor.save({ useObjectStreams: false }));
      const committed = await broker.replaceLiveDocument({
        sessionId: opened.launch.sessionId,
        outputPath: pdfPath,
        observationEpoch: 1,
      });
      expect(committed).toMatchObject({ status: "committed", documentGeneration: 2 });

      await vi.waitFor(() => {
        expect(published.at(-1)).toEqual({
          generation: 2,
          freshness: "current",
          refreshStatus: "idle",
        });
      }, { timeout: 2_000 });

      broker.controls.closeAllSockets();
      const disconnectedSuccessor = await PDFDocument.create();
      disconnectedSuccessor.setTitle("rebuilt while disconnected");
      disconnectedSuccessor.addPage([320, 240]);
      await writeFile(pdfPath, await disconnectedSuccessor.save({ useObjectStreams: false }));
      const disconnectedCommit = await broker.replaceLiveDocument({
        sessionId: opened.launch.sessionId,
        outputPath: pdfPath,
        observationEpoch: 2,
      });
      expect(disconnectedCommit).toMatchObject({ status: "committed", documentGeneration: 3 });
      await vi.waitFor(() => expect(registeredSocket).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      await vi.waitFor(() => {
        expect(published.at(-1)).toEqual({
          generation: 3,
          freshness: "current",
          refreshStatus: "idle",
        });
      }, { timeout: 3_000 });
      unsubscribe();
      expect(materialized).toHaveLength(3);
      expect(materialized[1]).not.toBe(materialized[0]);
      expect(materialized[2]).not.toBe(materialized[1]);
    } finally {
      runtime?.dispose();
      bridge?.dispose();
      if (bridge === undefined) client?.dispose();
      if (broker !== undefined && sessionId !== undefined) await broker.finish(sessionId);
      await server?.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("exchanges the one-use launch capability only in the extension host", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ credential: "c".repeat(43) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(exchangeVscodeLaunch(
      "http://127.0.0.1:49152/s/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bootstrap?embed=vscode#cap=one_use_capability",
      fetch,
    )).resolves.toEqual({
      origin: "http://127.0.0.1:49152",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credential: "c".repeat(43),
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:49152/s/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/exchange",
      expect.objectContaining({
        body: JSON.stringify({ capability: "one_use_capability" }),
        headers: expect.objectContaining({ origin: "http://127.0.0.1:49152" }),
      }),
    );
  });

  it("materializes large PDF bytes outside JSON with private permissions and rejects symlinks", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "placekeeper-u4-"));
    try {
      const directory = await createPrivateSnapshotDirectory(temporary);
      const bytes = new Uint8Array(2 * 1024 * 1024);
      bytes.set(new TextEncoder().encode("%PDF-1.7"));
      const digest = createHash("sha256").update(bytes).digest("hex");
      const path = await materializePrivatePdfSnapshot({
        directory,
        bytes,
        digest,
        byteLength: bytes.byteLength,
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(path)).size).toBe(bytes.byteLength);

      const unsafeDirectory = resolve(temporary, "unsafe");
      await symlink(directory, unsafeDirectory);
      await expect(materializePrivatePdfSnapshot({
        directory: unsafeDirectory,
        bytes,
        digest,
        byteLength: bytes.byteLength,
      })).rejects.toThrow(/unsafe/u);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("carries the exact recovery offer and operation identity", async () => {
    const invoke = vi.fn(async (
      _executable: string,
      _args: readonly string[],
      _options: { readonly shell: false; readonly timeoutMs: number; readonly maxOutputBytes: number },
    ) => ({
      stdout: JSON.stringify({
        ok: true,
        kind: "opened",
        url: "http://127.0.0.1:49152/s/id/bootstrap?embed=vscode#cap=secret",
      }),
      stderr: "",
    }));
    const recovery = {
      decision: "resume" as const,
      offer: {
        id: "opaque_recovery_offer_1234",
        expiresAt: "2026-08-21T20:00:00.000Z",
      },
      operationId: "operation_identifier_1234",
    };
    await runLaunchClient(
      "/Applications/Placekeeper.app/Contents/MacOS/placekeeper",
      "/tmp/paper.pdf",
      undefined,
      invoke,
      recovery,
    );
    expect(invoke.mock.calls[0]![1]).toEqual([
      "open", "--json", "--surface", "vscode", "--pdf", "/tmp/paper.pdf",
      "--recovery", recovery.decision,
      "--recovery-offer-id", recovery.offer.id,
      "--recovery-offer-expires-at", recovery.offer.expiresAt,
      "--recovery-operation-id", recovery.operationId,
    ]);
  });
});
