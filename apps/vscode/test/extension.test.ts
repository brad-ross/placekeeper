import { readFile } from "node:fs/promises";
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
  parseLaunchResponse,
  reviewPanelOptions,
} from "../src/review-panel.js";
import { runLaunchClient } from "../src/launch-client.js";

describe("VS Code local host adapter", () => {
  it("uses Placekeeper for every VS Code identity", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("apps/vscode/package.json"), "utf8"),
    ) as {
      name: string;
      displayName: string;
      description: string;
      activationEvents: string[];
      contributes: {
        commands: Array<{ command: string; title: string }>;
        configuration: {
          title: string;
          properties: Record<string, { description: string }>;
        };
      };
    };

    expect(manifest).toMatchObject({
      name: "placekeeper-vscode",
      displayName: "Placekeeper",
      activationEvents: ["onCommand:placekeeper.open"],
      contributes: {
        commands: [{ command: "placekeeper.open", title: "Placekeeper: Open Local PDF" }],
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

  it("accepts only structured loopback launch results and never exposes the capability in HTML text", () => {
    const result = parseLaunchResponse(JSON.stringify({ ok: true, kind: "focused", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=vscode#cap=secret" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful launch");
    if (result.kind === "recovery-offered") throw new Error("expected a scoped URL");
    expect(result.kind).toBe("focused");
    const html = buildReviewWebviewHtml(result.url, "nonce-value");
    expect(html).toContain("frame-src http://127.0.0.1:49152");
    expect(html).toContain("vscode.postMessage({ type: 'ready' })");
    expect(html).not.toContain("cap=secret");
    expect(html).toContain('title="Placekeeper"');
    expect(reviewPanelOptions.localResourceRoots).toEqual([]);
    expect(reviewPanelOptions.enableScripts).toBe(true);
    expect(reviewPanelOptions.retainContextWhenHidden).toBe(false);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "opened", url: "https://example.com/#cap=secret" }))).toThrow(/loopback/u);
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "opened", url: "http://127.0.0.1:49152/s/id/bootstrap?embed=other#cap=secret" }))).toThrow(/loopback/u);
  });

  it("passes a source root only for a local workspace containing the PDF", () => {
    const pdf = { scheme: "file", fsPath: "/tmp/project/paper.pdf" };
    expect(localSourceRoot(pdf, { scheme: "file", fsPath: "/tmp/project" })).toBe("/tmp/project");
    expect(localSourceRoot(pdf, undefined)).toBeUndefined();
    expect(localSourceRoot(pdf, { scheme: "vscode-vfs", fsPath: "/tmp/project" })).toBeUndefined();
  });

  it("accepts only the exact recovery choice contract", () => {
    expect(parseLaunchResponse(JSON.stringify({ ok: true, kind: "recovery-offered", choices: ["resume", "discard", "fork"], recoverySessionId: "opaque-session" }))).toMatchObject({ kind: "recovery-offered" });
    expect(() => parseLaunchResponse(JSON.stringify({ ok: true, kind: "recovery-offered", choices: ["resume", "fork"], recoverySessionId: "opaque-session" }))).toThrow(/invalid/u);
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
});
