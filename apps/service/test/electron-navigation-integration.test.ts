import { establishPrivateDirectory } from "../src/platform/private-storage.js";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { requestControl, startLaunchControlServer } from "../src/host/launch-control.js";

it("redeems, admits, binds and invokes Electron navigation through the shared runtime", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "electron-navigation-")));
  await establishPrivateDirectory(root);
  const sourcePath = join(root, "paper.pdf");
  const tex = join(root, "paper.tex");
  await writeFile(sourcePath, "%PDF-1.7\nelectron navigation\n%%EOF");
  await writeFile(tex, "Hello");
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), port: 0 });
  const control = await startLaunchControlServer(host, join(root, "control.sock"));
  const appInstanceId = "app_navigation_1234", helperId = "helper_navigation_1234";
  const app = (message: object) => requestControl(join(root, "control.sock"), { kind: "electron-app-control", message: { protocolVersion: 1, appInstanceId, ...message } });
  const envelope = { protocolVersion: 1, windowId: "window_navigation_1234", attemptId: "attempt_navigation_1234" };
  let order = 0;
  const runtime = (message: object) => requestControl(join(root, "control.sock"), { kind: "electron-runtime", appInstanceId, helperId, message: { ...envelope, requestId: `request_navigation_${++order}`, ...message } });
  try {
    await host.editorNavigation.profiles.add({ name: "editor", kind: "command", executable: process.execPath, args: ["-e", "", "{file}"] });
    const registration = await host.editorNavigation.profiles.register({ profile: "editor", sourceRoot: root });
    const accepted = await host.editorNavigation.control({ operation: "forward", pdfPath: sourcePath, sourcePath: tex, line: 1, intent: "explicit", session: registration.handle });
    if (!accepted.ok || accepted.operation !== "forward") throw new Error("Missing ticket");
    await app({ type: "register-app", processId: process.pid, startIdentity: "start_navigation_1234", buildIdentity: "build_navigation_1234", installationIdentity: host.editorNavigation.installationIdentity });
    const redeemed = await app({ type: "redeem-navigation", ticket: accepted.ticket });
    expect(redeemed).toMatchObject({ response: { type: "navigation", pdfPath: sourcePath } });
    if (redeemed.kind !== "electron-app-control" || redeemed.response.type !== "navigation") throw new Error("Missing navigation");
    const navigationHandle = redeemed.response.navigationHandle;
    const admitted = await runtime({ type: "admit", sourcePath, navigationHandle });
    expect(admitted).toMatchObject({ response: { type: "admitted", projection: { state: { workflow: { mode: "generated-output" } } } } });
    if (admitted.kind !== "electron-runtime" || admitted.response.type !== "admitted") throw new Error("Not admitted");
    await expect(runtime({ type: "activate", documentValidated: true })).resolves.toMatchObject({ response: { type: "active" } });
    await expect(app({ type: "bind-navigation", helperId, navigationHandle })).resolves.toMatchObject({ response: { type: "ack" } });
    const navigationResult = { operationToken: "navigation_operation", documentGeneration: 1, pdfDigest: "a".repeat(64),
      outputIdentity: { canonicalPath: sourcePath, device: 1, inode: 1, byteLength: 1, modifiedAtMs: 1 },
      sidecarFingerprint: { digest: "b".repeat(64), device: 1, inode: 2, byteLength: 1, modifiedAtMs: 1, compressed: false } };
    const forward = vi.spyOn(host.broker, "forwardSyncTex").mockResolvedValue({ ...navigationResult, status: "ok", target: { pageIndex: 0, x: 10, y: 20 } });
    const invoke = (generation: number, revision: number, payload: object) => runtime({ type: "invoke", generation, revision, method: "forwardSyncTex", payload });
    // Navigation bypasses annotation revision fences, while retaining generation fences.
    const target = await invoke(1, 999, { action: "poll" });
    expect(target).toMatchObject({ response: { type: "result", payload: { status: "ready", generation: 1 } } });
    expect(forward).toHaveBeenCalledTimes(1);
    await expect(invoke(2, 999, { action: "poll" })).resolves.toMatchObject({ response: { type: "failure" } });
    const sequence = host.editorNavigation.intentForHelper(helperId)!.sequence;
    await expect(invoke(1, 999, { action: "ack", sequence, generation: 1, outcome: "applied" })).resolves.toMatchObject({ response: { type: "result", payload: { status: "applied" } } });
    const reverse = vi.spyOn(host.broker, "reverseSyncTex").mockResolvedValue({ ...navigationResult, status: "ok", target: { path: "paper.tex", line: 1, confidence: "high", provenance: "synctex" } });
    await expect(runtime({ type: "invoke", generation: 1, revision: 999, method: "reverseSyncTex", payload: { pageIndex: 0, point: { x: 10, y: 20 } } })).resolves.toMatchObject({ response: { type: "result", payload: { status: "opened" } } });
    expect(reverse).toHaveBeenCalledTimes(1);
    await app({ type: "detach-helper", helperId });
    expect(host.editorNavigation.intentForHelper(helperId)).toBeUndefined();
    await expect(invoke(1, 999, { action: "poll" })).resolves.toMatchObject({ response: { type: "failure" } });
  } finally { await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
