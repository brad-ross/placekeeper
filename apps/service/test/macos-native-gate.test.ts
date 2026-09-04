import { describe, expect, it, vi } from "vitest";

import {
  MacosAppLifecycleRegistry,
  MacosLifecycleControlSession,
  MacosReviewHelperManager,
  projectMacosAdmissionToPage,
  type MacosReviewAuthority,
} from "../src/macos/native-gate.js";
import { parseMacosNativeMessage } from "../../../packages/core/src/macos-shell-protocol.js";

function authority(): MacosReviewAuthority {
  return {
    admit: vi.fn(async () => ({
      provisionalId: "claim_12345678",
      resourceId: "resource_12345678",
      generation: 1,
      byteLength: 995,
      digest: "a".repeat(64),
    })),
    readResource: vi.fn(async () => Uint8Array.of(0x25, 0x50, 0x44, 0x46)),
    release: vi.fn(async () => undefined),
  };
}

describe("macOS native feasibility adapter", () => {
  it("carries one admission/resource chain without projecting authority to the page", async () => {
    const backend = authority();
    const manager = new MacosReviewHelperManager(backend);
    const helper = manager.open("window_12345678", "attempt_12345678");
    const admitted = await helper.handle({
      protocolVersion: 1,
      windowId: "window_12345678",
      attemptId: "attempt_12345678",
      requestId: "request_12345678",
      type: "admit",
      sourcePath: "/private/tmp/Paper.pdf",
    });
    expect(admitted.type).toBe("admitted");
    if (admitted.type !== "admitted") throw new Error("Expected provisional admission");
    const pageBootstrap = parseMacosNativeMessage(projectMacosAdmissionToPage(
      admitted,
      "Paper.pdf",
      { identity: "geometry_12345678", trafficLightInset: 76, trailingInset: 12 },
    ));
    expect(pageBootstrap).toMatchObject({ type: "bootstrap", document: { displayName: "Paper.pdf" } });
    expect(JSON.stringify(pageBootstrap)).not.toMatch(/private|path|credential|taskId|provisionalId|token|method/iu);
    await expect(helper.handle({
      protocolVersion: 1,
      windowId: "window_12345678",
      attemptId: "attempt_12345678",
      requestId: "request_resource1",
      type: "read-resource",
      resourceId: admitted.resourceId,
      generation: admitted.generation,
      role: "document",
      offset: 0,
      length: 4,
    })).resolves.toMatchObject({ type: "resource-bytes", data: "JVBERg==" });
  });

  it("allows one provisional admission and only its current resource generation", async () => {
    const backend = authority();
    const manager = new MacosReviewHelperManager(backend);
    const helper = manager.open("window_12345678", "attempt_12345678");
    await expect(helper.handle({
      protocolVersion: 1,
      windowId: "window_12345678",
      attemptId: "attempt_12345678",
      requestId: "request_12345678",
      type: "admit",
      sourcePath: "/private/tmp/Paper.pdf",
    })).resolves.toMatchObject({ type: "admitted", generation: 1 });
    await expect(helper.handle({
      protocolVersion: 1,
      windowId: "window_12345678",
      attemptId: "attempt_12345678",
      requestId: "request_abcdefgh",
      type: "admit",
      sourcePath: "/private/tmp/Paper.pdf",
    })).rejects.toThrow(/one provisional/iu);
    await expect(helper.handle({
      protocolVersion: 1,
      windowId: "window_12345678",
      attemptId: "attempt_12345678",
      requestId: "request_resource1",
      type: "read-resource",
      resourceId: "resource_12345678",
      generation: 2,
      role: "document",
      offset: 0,
      length: 4,
    })).rejects.toThrow(/resource generation/iu);
  });

  it("isolates helper loss to one window and leaves none after the last close", async () => {
    const manager = new MacosReviewHelperManager(authority());
    const first = manager.open("window_12345678", "attempt_12345678");
    const second = manager.open("window_abcdefgh", "attempt_abcdefgh");
    await manager.helperDied(first.windowId);
    expect(manager.activeWindowIds()).toEqual([second.windowId]);
    await manager.close(second.windowId);
    expect(manager.activeWindowIds()).toEqual([]);
  });

  it.each(["eof", "parent-death", "controlled-exit"] as const)(
    "detaches all app ownership on %s",
    (reason) => {
      const registry = new MacosAppLifecycleRegistry();
      const control = new MacosLifecycleControlSession(registry, {
        processId: 123,
        startIdentity: "start_12345678",
        buildIdentity: "build_12345678",
      });
      registry.noteWindow("window_12345678", true);
      if (reason === "eof") control.eof();
      else if (reason === "parent-death") control.parentDied();
      else control.controlledExit();
      expect(registry.snapshot()).toEqual({ registered: false, activeWindows: 0, detachReason: reason });
    },
  );
});
