import { describe, expect, it, vi } from "vitest";

import { MacosAppLifecycleManager } from "../src/macos/app-lifecycle.js";

const appInstanceId = "app_instance_1234";

function register(manager: MacosAppLifecycleManager) {
  return manager.handle({
    protocolVersion: 1,
    type: "register-app",
    appInstanceId,
    processId: 123,
    startIdentity: "start_12345678",
    buildIdentity: "build_12345678",
  });
}

describe("macOS app lifecycle ownership", () => {
  it.each(["controlled-exit", "eof", "parent-death"] as const)(
    "atomically detaches every helper on %s",
    async (reason) => {
      const detach = vi.fn(async () => undefined);
      const manager = new MacosAppLifecycleManager({ detach });
      expect(await register(manager)).toMatchObject({ type: "ack" });
      expect(manager.attachHelper(appInstanceId, "helper_12345678")).toBe(true);
      expect(manager.attachHelper(appInstanceId, "helper_abcdefgh")).toBe(true);
      if (reason === "controlled-exit") {
        await manager.handle({ protocolVersion: 1, type: "detach", appInstanceId, reason });
      } else if (reason === "eof") {
        await manager.eof(appInstanceId);
      } else {
        await manager.parentDied(appInstanceId);
      }
      expect(detach).toHaveBeenCalledTimes(2);
      expect(manager.activity()).toEqual({ appInstances: 0, registeredWindows: 0, bootstrappingWindows: 0 });
    },
  );

  it("keeps replacement blocked while windows remain and acknowledges zero-window residency", async () => {
    const manager = new MacosAppLifecycleManager({ detach: vi.fn(async () => undefined) });
    await register(manager);
    manager.attachHelper(appInstanceId, "helper_12345678");
    await manager.handle({
      protocolVersion: 1,
      type: "activity",
      appInstanceId,
      activeWindows: 1,
      bootstrappingWindows: 1,
    });
    await expect(manager.handle({
      protocolVersion: 1,
      type: "prepare-replacement",
      appInstanceId,
    })).resolves.toMatchObject({ type: "failure", code: "busy" });
    manager.releaseHelper(appInstanceId, "helper_12345678");
    await manager.handle({
      protocolVersion: 1,
      type: "activity",
      appInstanceId,
      activeWindows: 0,
      bootstrappingWindows: 0,
    });
    await expect(manager.handle({
      protocolVersion: 1,
      type: "prepare-replacement",
      appInstanceId,
    })).resolves.toMatchObject({ type: "replacement-ready", activeWindows: 0 });
  });

  it("rejects helpers for unregistered or different app instances", () => {
    const manager = new MacosAppLifecycleManager({ detach: vi.fn(async () => undefined) });
    expect(manager.attachHelper(appInstanceId, "helper_12345678")).toBe(false);
  });

  it("detaches a helper exactly once and retires its single-use identity", async () => {
    const detach = vi.fn(async () => undefined);
    const manager = new MacosAppLifecycleManager({ detach });
    await register(manager);
    expect(manager.attachHelper(appInstanceId, "helper_12345678")).toBe(true);

    const message = {
      protocolVersion: 1 as const,
      type: "detach-helper" as const,
      appInstanceId,
      helperId: "helper_12345678",
    };
    await expect(manager.handle(message)).resolves.toMatchObject({ type: "ack" });
    await expect(manager.handle(message)).resolves.toMatchObject({ type: "ack" });

    expect(detach).toHaveBeenCalledOnce();
    expect(manager.ownsHelper(appInstanceId, "helper_12345678")).toBe(false);
    expect(manager.attachHelper(appInstanceId, "helper_12345678")).toBe(false);
  });

  it("retires a helper before admission can attach it", async () => {
    const detach = vi.fn(async () => undefined);
    const manager = new MacosAppLifecycleManager({ detach });
    await register(manager);
    await manager.handle({
      protocolVersion: 1,
      type: "detach-helper",
      appInstanceId,
      helperId: "helper_late_12345678",
    });

    expect(manager.attachHelper(appInstanceId, "helper_late_12345678")).toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });
});
