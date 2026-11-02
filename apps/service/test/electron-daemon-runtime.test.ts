import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { requestControl, startLaunchControlServer } from "../src/host/launch-control.js";

it("admits Electron through registered app ownership with bounded resources and independent Mac activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-electron-runtime-"));
  const assets = join(root, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "app.js"), "export function start(){}\n");
  const sourcePath = join(root, "paper.pdf");
  const bytes = "%PDF-1.7\nelectron review\n%%EOF";
  await writeFile(sourcePath, bytes);
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets }, port: 0 });
  const socket = join(root, "control.sock");
  const control = await startLaunchControlServer(host, socket);
  const appInstanceId = "app_electron_1234";
  const helperId = "helper_electron_1234";
  const envelope = { protocolVersion: 1, windowId: "window_electron_1234", attemptId: "attempt_electron_1234" };
  const invoke = (message: object, app = appInstanceId) => requestControl(socket, {
    kind: "electron-runtime", appInstanceId: app, helperId, message: { ...envelope, ...message },
  });
  const interactionOwners = vi.spyOn(host.broker, "replaceInteractionAttachment");
  try {
    await expect(invoke({ type: "admit", requestId: "request_no_app_1234", sourcePath }))
      .resolves.toMatchObject({ kind: "electron-runtime", response: { type: "failure", code: "invalid" } });
    for (const [kind, id] of [["electron-app-control", appInstanceId], ["macos-app-control", "app_macos_1234"]] as const) {
      await expect(requestControl(socket, { kind, message: { protocolVersion: 1, type: "register-app", appInstanceId: id,
        processId: process.pid, startIdentity: "start_identity_1234", buildIdentity: "build_identity_1234" } }))
        .resolves.toMatchObject({ kind, response: { type: "ack" } });
    }
    const admitted = await invoke({ type: "admit", requestId: "request_admit_1234", sourcePath });
    expect(admitted).toMatchObject({ kind: "electron-runtime", response: { type: "admitted", projection: { scope: { launchSurface: "electron" } } } });
    if (admitted.kind !== "electron-runtime" || admitted.response.type !== "admitted") throw new Error("not admitted");
    const serialized = JSON.stringify(admitted.response.projection);
    expect(serialized).not.toContain(sourcePath);
    expect(serialized).not.toContain("canonicalLinkBase");
    expect(serialized).not.toContain("capability");
    await expect(invoke({ type: "activate", requestId: "request_wrong_1234", documentValidated: true, attemptId: "attempt_wrong_1234" }))
      .resolves.toMatchObject({ response: { type: "failure", code: "invalid" } });
    await expect(invoke({ type: "activate", requestId: "request_activate_1234", documentValidated: true }))
      .resolves.toMatchObject({ response: { type: "active" } });
    await expect(invoke({ type: "invoke", requestId: "request_scope_1234", generation: 1, revision: 0, method: "scope", payload: {} }))
      .resolves.toMatchObject({ response: { type: "result", payload: { launchSurface: "electron" } } });
    await expect(invoke({ type: "read-resource", requestId: "request_read_1234", resourceId: admitted.response.resourceId,
      generation: 1, role: "document", offset: 0, length: Buffer.byteLength(bytes) }))
      .resolves.toMatchObject({ response: { type: "resource-bytes", data: Buffer.from(bytes).toString("base64"), done: true } });
    await expect(invoke({ type: "read-resource", requestId: "request_overread_1234", resourceId: admitted.response.resourceId,
      generation: 1, role: "document", offset: 0, length: Buffer.byteLength(bytes) + 1 }))
      .resolves.toMatchObject({ response: { type: "failure", code: "stale" } });
    const macApp = "app_macos_1234";
    const macAdmit = await requestControl(socket, { kind: "macos-runtime", appInstanceId: macApp, helperId,
      message: { ...envelope, type: "admit", requestId: "request_mac_admit_1234", sourcePath } });
    expect(macAdmit).toMatchObject({ response: { type: "admitted", projection: {
      sessionId: admitted.response.projection.sessionId, scope: { launchSurface: "macos" },
    } } });
    await expect(requestControl(socket, { kind: "macos-runtime", appInstanceId: macApp, helperId,
      message: { ...envelope, type: "activate", requestId: "request_mac_activate_1234", documentValidated: true } }))
      .resolves.toMatchObject({ response: { type: "active" } });
    expect(interactionOwners.mock.calls.map((call) => call[1])).toEqual([
      `electron:${helperId}:${envelope.attemptId}`, `macos:${helperId}:${envelope.attemptId}`,
    ]);
    await expect(invoke({ type: "invoke", requestId: "request_mutation_1234", generation: 1, revision: 0,
      method: "command", payload: { type: "set-annotation-name", expectedRevision: 0, annotationName: "Reviewed paper" },
      idempotencyKey: "operation_mutation_1234" }))
      .resolves.toMatchObject({ response: { type: "result", payload: { revision: 1 } } });
    await expect(invoke({ type: "refresh", requestId: "request_protected_1234" }))
      .resolves.toMatchObject({ response: { type: "refreshed", projection: { revision: 1, protected: true } } });
    expect(host.electronRuntime.activity().helpers).toBe(1);
    expect(host.macosLifecycle.activity().appInstances).toBe(1);
    await requestControl(socket, { kind: "electron-runtime-detach", appInstanceId: "app_wrong_1234", helperId });
    expect(host.electronRuntime.activity().helpers).toBe(1);
    await requestControl(socket, { kind: "electron-app-control", message: { protocolVersion: 1, type: "detach-helper", appInstanceId, helperId } });
    expect(host.electronRuntime.activity().helpers).toBe(0);
    expect(host.macosRuntime.activity().activeHelpers).toBe(1);
    expect(host.macosLifecycle.activity().appInstances).toBe(1);
    await expect(invoke({ type: "admit", requestId: "request_retired_1234", sourcePath }))
      .resolves.toMatchObject({ response: { type: "failure", code: "invalid" } });
  } finally {
    await control.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
