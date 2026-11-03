import { establishPrivateDirectory } from "../src/platform/private-storage.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { requestControl, startLaunchControlServer } from "../src/host/launch-control.js";

it("admits Electron through registered app ownership with bounded resources and independent app activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-electron-runtime-"));
  await establishPrivateDirectory(root);
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
    for (const [kind, id] of [["electron-app-control", appInstanceId], ["electron-app-control", "app_other_1234"]] as const) {
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
    const macApp = "app_other_1234";
    const otherHelperId = "helper_other_app_1234";
    const otherEnvelope = { ...envelope, attemptId: "attempt_other_app_1234" };
    const otherAdmit = await requestControl(socket, { kind: "electron-runtime", appInstanceId: macApp, helperId: otherHelperId,
      message: { ...otherEnvelope, type: "admit", requestId: "request_other_admit_1234", sourcePath } });
    expect(otherAdmit).toMatchObject({ response: { type: "admitted", projection: {
      sessionId: admitted.response.projection.sessionId, scope: { launchSurface: "electron" },
    } } });
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId: macApp, helperId: otherHelperId,
      message: { ...otherEnvelope, type: "activate", requestId: "request_other_activate_1234", documentValidated: true } }))
      .resolves.toMatchObject({ response: { type: "active" } });
    expect(interactionOwners.mock.calls.map((call) => call[1])).toEqual([
      `electron:${helperId}:${envelope.attemptId}`, `electron:${otherHelperId}:${otherEnvelope.attemptId}`,
    ]);
    await expect(invoke({ type: "invoke", requestId: "request_mutation_1234", generation: 1, revision: 0,
      method: "command", payload: { type: "set-annotation-name", expectedRevision: 0, annotationName: "Reviewed paper" },
      idempotencyKey: "operation_mutation_1234" }))
      .resolves.toMatchObject({ response: { type: "result", payload: { revision: 1 } } });
    await expect(invoke({ type: "refresh", requestId: "request_protected_1234" }))
      .resolves.toMatchObject({ response: { type: "refreshed", projection: { revision: 1, protected: true } } });
    expect(host.electronRuntime.activity().helpers).toBe(2);
    expect(host.electronLifecycle.activity().appInstances).toBe(2);
    await requestControl(socket, { kind: "electron-runtime-detach", appInstanceId: "app_wrong_1234", helperId });
    expect(host.electronRuntime.activity().helpers).toBe(2);
    await requestControl(socket, { kind: "electron-app-control", message: { protocolVersion: 1, type: "detach-helper", appInstanceId, helperId } });
    expect(host.electronRuntime.activity().helpers).toBe(1);
    expect(host.electronRuntime.activity().activeHelpers).toBe(1);
    expect(host.electronLifecycle.activity().appInstances).toBe(2);
    await expect(invoke({ type: "admit", requestId: "request_retired_1234", sourcePath }))
      .resolves.toMatchObject({ response: { type: "failure", code: "invalid" } });
  } finally {
    await control.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("attaches a fresh helper through a staged desktop launch over private control", async () => {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-electron-staged-control-"));
  await establishPrivateDirectory(root);
  const assets = join(root, "assets"); await mkdir(assets); await writeFile(join(assets, "app.js"), "export {}\n");
  const sourcePath = join(root, "paper.pdf"); await writeFile(sourcePath, "%PDF-1.7\nstaged desktop launch\n%%EOF");
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets }, port: 0 });
  const socket = join(root, "control.sock"); const control = await startLaunchControlServer(host, socket);
  try {
    const staged = await requestControl(socket, { kind: "launch", request: { pdfPath: sourcePath, desktop: "electron" } });
    if (staged.kind !== "launch" || !staged.response.ok || !("launchId" in staged.response)) throw new Error("missing native launch receipt");
    expect(staged.response).not.toHaveProperty("url");
    const appInstanceId = "app_fresh_launch_1234"; const helperId = "helper_fresh_launch_1234";
    await requestControl(socket, { kind: "electron-app-control", message: { protocolVersion: 1, type: "register-app", appInstanceId,
      processId: process.pid, startIdentity: "start_fresh_launch_1234", buildIdentity: "build_fresh_launch_1234" } });
    expect(host.electronLifecycle.ownsHelper(appInstanceId, helperId)).toBe(false);
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId, helperId, message: {
      protocolVersion: 1, windowId: "window_fresh_launch_1234", attemptId: "attempt_fresh_launch_1234", requestId: "request_fresh_launch_1234", type: "admit-launch", launchId: staged.response.launchId,
    } })).resolves.toMatchObject({ kind: "electron-runtime", response: { type: "admitted" } });
    expect(host.electronLifecycle.ownsHelper(appInstanceId, helperId)).toBe(true);
  } finally { await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});


it("releases recovered Electron admission without leaking browser presence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-native-recovery-"));
  await establishPrivateDirectory(root);
  const recoveryRoot = join(root, "recovery"); const sourcePath = join(root, "paper.pdf");
  await copyFile(resolve("test/fixtures/pdfs/multi-page-text.pdf"), sourcePath);
  const seed = new SessionBroker({ recoveryRoot });
  let sessionId = "";
  try {
    const opened = await seed.openReview({ pdfPath: sourcePath, surface: "codex-native" });
    if (opened.kind !== "opened") throw new Error("Expected disposable review");
    sessionId = opened.launch.sessionId;
    await seed.acceptMutation(sessionId, { type: "set-annotation-name", expectedRevision: 0, annotationName: "Acknowledged before native recovery" });
  } finally { await seed.quiesceForShutdown(); }
  const assets = join(root, "assets"); await mkdir(assets); await writeFile(join(assets, "app.js"), "export {}\n");
  const host = await PlacekeeperHost.start({ recoveryRoot, webAssets: { root: assets }, port: 0 });
  const socket = join(root, "control.sock"); const control = await startLaunchControlServer(host, socket);
  const runtimeKind = "electron-runtime";
  const appControlKind = "electron-app-control";
  const appInstanceId = "app_native_recovery_1234"; const helperId = "helper_native_recovery_1234";
  const envelope = { protocolVersion: 1, windowId: "window_native_recovery_1234", attemptId: "attempt_native_recovery_1234" };
  const browserExchanges = vi.spyOn(host.broker, "exchangeBootstrap");
  const authenticatedPages = vi.spyOn(host.broker.controls, "noteAuthenticatedPage");
  try {
    await requestControl(socket, { kind: appControlKind, message: { protocolVersion: 1, type: "register-app", appInstanceId,
      processId: process.pid, startIdentity: "start_native_recovery_1234", buildIdentity: "build_native_recovery_1234" } });
    const offer = await requestControl(socket, { kind: runtimeKind, appInstanceId, helperId,
      message: { ...envelope, type: "admit", requestId: "request_native_recovery_offer", sourcePath } });
    if (offer.kind !== "electron-runtime" || offer.response.type !== "recovery-offered") throw new Error("Expected native recovery offer");
    const recovered = await requestControl(socket, { kind: runtimeKind, appInstanceId, helperId, message: { ...envelope,
      type: "recover", requestId: "request_native_recovery_resume", decision: "resume", offer: offer.response.offer, idempotencyKey: "operation_native_recovery_1234" } });
    expect(recovered).toMatchObject({ kind: runtimeKind, response: { type: "admitted", projection: { sessionId, revision: 1 } } });
    await expect(requestControl(socket, { kind: runtimeKind, appInstanceId, helperId,
      message: { ...envelope, type: "release", requestId: "request_native_recovery_release" } })).resolves.toMatchObject({ response: { type: "released" } });
    await expect(requestControl(socket, { kind: appControlKind, message: { protocolVersion: 1, type: "detach", appInstanceId, reason: "controlled-exit" } })).resolves.toMatchObject({ response: { type: "ack" } });
    expect(host.lifecycle.status().activity).toEqual({ reviewPresence: 0, codexTasks: 0, transientWork: 0 });
    expect(browserExchanges).not.toHaveBeenCalled();
    expect(authenticatedPages).not.toHaveBeenCalled();
    const retained = JSON.parse(await readFile(join(recoveryRoot, sessionId, "draft.json"), "utf8")) as { payload: { state: { annotationName: string } } };
    expect(retained.payload.state.annotationName).toBe("Acknowledged before native recovery");
  } finally { await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

it("keeps the first provisional review activatable when a focused task admission is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-focus-admission-"));
  await establishPrivateDirectory(root);
  const assets = join(root, "assets"); await mkdir(assets); await writeFile(join(assets, "app.js"), "export {}\n");
  const sourcePath = join(root, "paper.pdf"); await writeFile(sourcePath, "%PDF-1.7\nprovisional duplicate\n%%EOF");
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets }, port: 0 });
  const socket = join(root, "control.sock"); const control = await startLaunchControlServer(host, socket);
  const appInstanceId = "app_provisional_focus_1234"; const helperId = "helper_provisional_focus_1234";
  const envelope = { protocolVersion: 1, windowId: "window_provisional_focus_1234", attemptId: "attempt_provisional_focus_1234" };
  const stage = async () => {
    const result = await requestControl(socket, { kind: "launch", request: { pdfPath: sourcePath, desktop: "electron" } });
    if (result.kind !== "launch" || !result.response.ok || !("launchId" in result.response)) throw new Error("Expected staged native launch");
    return result.response;
  };
  try {
    await requestControl(socket, { kind: "electron-app-control", message: { protocolVersion: 1, type: "register-app", appInstanceId,
      processId: process.pid, startIdentity: "start_provisional_focus_1234", buildIdentity: "build_provisional_focus_1234" } });
    const first = await stage();
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId, helperId,
      message: { ...envelope, type: "admit-launch", launchId: first.launchId, requestId: "request_provisional_first" } })).resolves.toMatchObject({ response: { type: "admitted" } });
    expect(host.electronRuntime.activity()).toMatchObject({ helpers: 1, activeHelpers: 0 });
    const duplicate = await stage();
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId, helperId,
      message: { ...envelope, type: "admit-launch", launchId: duplicate.launchId, requestId: "request_provisional_duplicate" } })).resolves.toMatchObject({ response: { type: "failure", code: "unavailable" } });
    expect(host.electronLifecycle.ownsHelper(appInstanceId, helperId)).toBe(true);
    expect(host.electronRuntime.activity()).toMatchObject({ helpers: 1, activeHelpers: 0 });
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId, helperId,
      message: { ...envelope, type: "activate", launchId: first.launchId, documentValidated: true, requestId: "request_provisional_activate" } })).resolves.toMatchObject({ response: { type: "active", projection: { sessionId: first.sessionId } } });
    expect(host.electronRuntime.activity()).toMatchObject({ helpers: 1, activeHelpers: 1 });

    const failedHelper = "helper_failed_initial_1234";
    const failedEnvelope = { protocolVersion: 1, windowId: "window_failed_initial_1234", attemptId: "attempt_failed_initial_1234" };
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId, helperId: failedHelper,
      message: { ...failedEnvelope, type: "admit-launch", launchId: "x".repeat(43), requestId: "request_failed_initial_1234" } })).resolves.toMatchObject({ response: { type: "failure", code: "invalid" } });
    expect(host.electronLifecycle.ownsHelper(appInstanceId, failedHelper)).toBe(false);
    expect(host.electronRuntime.activity()).toMatchObject({ helpers: 1, activeHelpers: 1 });
    await expect(requestControl(socket, { kind: "electron-runtime", appInstanceId, helperId: failedHelper,
      message: { ...failedEnvelope, type: "admit", sourcePath, requestId: "request_failed_retry_1234" } })).resolves.toMatchObject({ response: { type: "failure", code: "invalid" } });
  } finally { await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('blocks native menu authoring after upgrade protection while leaving every window attached until commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pk-upgrade-electron-'));
  const sourcePath = join(root, 'paper.pdf'); await copyFile('test/fixtures/pdfs/text-native.pdf', sourcePath);
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, 'recovery'), port: 0 });
  const appInstanceId = 'upgrade_electron_app'; const helperId = 'upgrade_electron_helper';
  const envelope = { protocolVersion: 1, windowId: 'upgrade_electron_window', attemptId: 'upgrade_window_attempt' };
  let sequence = 0;
  const send = (message: object) => host.electronRuntime.handle(helperId, { ...envelope, requestId: `request_upgrade_${++sequence}`, ...message });
  try {
    await host.electronLifecycle.handle({ protocolVersion: 1, type: 'register-app', upgradePreparationVersion: 1, appInstanceId, processId: process.pid, startIdentity: 'upgrade_start_identity', buildIdentity: 'upgrade_build_identity' });
    await send({ type: 'admit', sourcePath });
    expect(host.electronLifecycle.attachHelper(appInstanceId, helperId)).toBe(true);
    await send({ type: 'activate', documentValidated: true });
    await host.electronLifecycle.handle({ protocolVersion: 1, type: 'activity', appInstanceId, activeWindows: 1, bootstrappingWindows: 0 });
    const attempt = host.upgradePreparation.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
    host.upgradePreparation.begin(attempt, true); await host.prepareUpgradeTasks();
    expect(await send({ type: 'invoke', generation: 1, revision: 0, method: 'upgradeSettle', payload: { attemptId: attempt.attemptId } })).toMatchObject({ type: 'result', payload: { phase: 'preparing' } });
    const command = { type: 'invoke', generation: 1, revision: 0, method: 'command', payload: { type: 'set-annotation-name', expectedRevision: 0, annotationName: 'Must not run from a native menu' }, idempotencyKey: 'upgrade_menu_operation_1' };
    expect(await send(command)).toMatchObject({ type: 'failure' });
    expect(host.electronRuntime.activity().helpers).toBe(1);
    expect((await host.electronLifecycle.handle({ protocolVersion: 1, type: 'upgrade-settle', appInstanceId, request: { attemptId: attempt.attemptId } }))).toMatchObject({ upgrade: { phase: 'ready' } });
    expect(await send({ ...command, idempotencyKey: 'upgrade_menu_operation_2' })).toMatchObject({ type: 'failure' });
    expect(host.electronRuntime.activity().helpers).toBe(1);
    host.upgradePreparation.cancel(attempt);
    expect(await send({ ...command, idempotencyKey: 'upgrade_menu_operation_3' })).toMatchObject({ type: 'result', payload: { revision: 1 } });
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
