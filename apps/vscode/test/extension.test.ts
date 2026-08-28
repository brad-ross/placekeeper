import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  INPUT_UNAVAILABLE,
  UNSUPPORTED_CONTEXT,
  choosePdfInput,
  classifyWorkspace,
  localSourceRoot,
  resolveLauncherPath,
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
  runLaunchClient,
} from "../src/launch-client.js";
import {
  WEBVIEW_RPC_PROTOCOL,
  WEBVIEW_RPC_VERSION,
  parseWebviewRequest,
} from "../src/webview-bridge.js";

describe("VS Code local host adapter", () => {
  it("uses Placekeeper for every VS Code identity", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("apps/vscode/package.json"), "utf8"),
    ) as {
      name: string;
      displayName: string;
      description: string;
      publisher: string;
      icon: string;
      activationEvents: string[];
      contributes: {
        commands: Array<{
          command: string;
          title: string;
          icon: { light: string; dark: string };
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
      activationEvents: ["onCommand:placekeeper.open"],
      contributes: {
        commands: [{
          command: "placekeeper.open",
          title: "Placekeeper: Open Local PDF",
          icon: {
            light: "assets/placekeeper.svg",
            dark: "assets/placekeeper.svg",
          },
        }],
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
    expect((manifest as unknown as { scripts: { build: string } }).scripts.build)
      .toContain("copy-web-assets.mjs");
  });

  it("accepts only the shared production asset manifest", () => {
    expect(parseSharedAssetManifest({
      schemaVersion: 1,
      app: "app.js",
      stylesheet: "app.css",
      pdfiumWasm: "pdfium.wasm",
    })).toMatchObject({ schemaVersion: 1, app: "app.js" });
    expect(() => parseSharedAssetManifest({
      schemaVersion: 1,
      app: "../../secret.js",
      stylesheet: "app.css",
      pdfiumWasm: "pdfium.wasm",
    })).toThrow(/manifest/u);
  });

  it("uses an existing configured launcher first and otherwise the user-local Placekeeper path", () => {
    expect(resolveLauncherPath("/custom/Placekeeper.app/placekeeper", "/Users/reader"))
      .toBe("/custom/Placekeeper.app/placekeeper");
    expect(resolveLauncherPath(undefined, "/Users/reader")).toBe(
      "/Users/reader/Applications/Placekeeper.app/Contents/MacOS/placekeeper",
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

  it("accepts only structured loopback launch results and emits a direct, network-denying webview", () => {
    const result = parseLaunchResponse(JSON.stringify({ ok: true, kind: "focused", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=vscode#cap=secret" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful launch");
    if (result.kind === "recovery-offered") throw new Error("expected a scoped URL");
    expect(result.kind).toBe("focused");
    const html = buildReviewWebviewHtml({
      nonce: "nonce-value",
      panelId: "panel_identifier_1234",
      scriptUri: "vscode-webview://authority/assets/app.js",
      styleUri: "vscode-webview://authority/assets/app.css",
      cspSource: "vscode-webview://authority",
    });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("worker-src blob:");
    expect(html).toContain("img-src blob: data: vscode-webview://authority");
    expect(html).toContain("connect-src vscode-webview://authority");
    expect(html).toContain("startVscode");
    expect(html).not.toContain("iframe");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("localhost");
    expect(html).not.toContain("cap=secret");
    const options = reviewPanelOptions([]);
    expect(options.localResourceRoots).toEqual([]);
    expect(options.enableScripts).toBe(true);
    expect(options.retainContextWhenHidden).toBe(false);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "opened", url: "https://example.com/#cap=secret" }))).toThrow(/loopback/u);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "opened", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=other#cap=secret" }))).toThrow(/loopback/u);
  });

  it("validates the versioned webview RPC envelope before dispatch", () => {
    const expected = {
      panelId: "panel_identifier_1234",
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 2,
      revision: 7,
    };
    const request = {
      protocol: WEBVIEW_RPC_PROTOCOL,
      version: WEBVIEW_RPC_VERSION,
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
      protocol: WEBVIEW_RPC_PROTOCOL,
      version: WEBVIEW_RPC_VERSION,
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
      protocol: WEBVIEW_RPC_PROTOCOL,
      version: WEBVIEW_RPC_VERSION,
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
      expect.objectContaining({ body: JSON.stringify({ capability: "one_use_capability" }) }),
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
