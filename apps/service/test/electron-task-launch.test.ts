import { spawn } from "node:child_process";
import { once } from "node:events";
import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { DraftSnapshotStore, type SnapshotHooks } from "../src/recovery/draft-snapshot.js";
import { NativeAppLifecycleManager } from "../src/desktop/app-lifecycle.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { BrowserSourceStore } from "../src/browser/browser-source-store.js";
import { ChromeTransferStore } from "../src/browser/chrome-handoff.js";
import { ChromeServiceRuntimeBackend } from "../src/browser/chrome-runtime-backend.js";
import { NativeTaskLaunchRegistry } from "../src/desktop/native-task-launches.js";
import { NativeRuntimeManager } from "../src/desktop/native-runtime.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { ExportCoordinator } from "../src/export/export-coordinator.js";
import type { PdfWriter } from "../../../packages/core/src/pdf-writer.js";

const fixtures: { root: string; broker: SessionBroker; manager: NativeRuntimeManager }[] = [];
afterEach(async () => {
  for (const { root, broker, manager } of fixtures.splice(0)) {
    await manager.close();
    await broker.quiesceForShutdown();
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(snapshotHooks?: SnapshotHooks) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-electron-task-"));
  const source = join(root, "paper.pdf");
  await writeFile(source, "%PDF-1.7\nnative task launch\n%%EOF");
  const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), portableReader: async () => [],
    ...(snapshotHooks === undefined ? {} : { snapshotHooks }),
    inspectGeneration: async () => ({ pageCount: 1, pages: [] }) });
  const opened = await broker.openReview({ pdfPath: source, surface: "codex-native" });
  if (opened.kind === "recovery-offered") throw new Error("unexpected recovery");
  const browserSources = await BrowserSourceStore.create(join(root, "browser-sources"));
  const transferStore = await ChromeTransferStore.create({ root: browserSources.root, validate: async () => {} });
  const writer: PdfWriter = { write: async () => { throw new Error("Unexpected PDF publication"); } };
  const saving = new PdfSaveCoordinator({ broker, writer });
  const backend = new ChromeServiceRuntimeBackend({ broker, browserSources, transferStore, saving,
    exporting: new ExportCoordinator({ writer, capabilities: broker.capabilities }), runtimeHost: "electron" });
  const manager = new NativeRuntimeManager("electron", backend.authority());
  fixtures.push({ root, broker, manager });
  const envelope = { protocolVersion: 1, windowId: "window_task_launch", attemptId: "attempt_task_launch" };
  const helper = "helper_task_launch";
  const sessionId = opened.launch.sessionId;
  let pendingLaunchId: string | undefined;
  const stage = () => { const launch = manager.stageLaunch({ sessionId, kind: "focused" }); pendingLaunchId = launch?.launchId; return launch; };
  const activate = () => manager.handle(helper, { ...envelope, ...(pendingLaunchId === undefined ? {} : { launchId: pendingLaunchId }), type: "activate", documentValidated: true,
    requestId: "request_activate_task" });
  return { root, source, broker, backend, manager, envelope, helper, sessionId, stage, activate };
}

describe("correlated Electron task launch", () => {
  it.each(["claim-first", "visible-first"] as const)("activates only after both claim and exact visible attempt (%s)", async (order) => {
    const { broker, manager, envelope, helper, sessionId, stage, activate } = await setup();
    const launch = stage();
    if (launch === undefined) throw new Error("expected staged launch");
    expect(launch).toMatchObject({ ok: true, surface: "electron", native: true, sessionId, documentGeneration: 1 });
    const claim = { taskSessionId: "task_native_launch", reviewSessionId: sessionId,
      documentGeneration: launch.documentGeneration, bindProof: launch.bindProof };
    const claimIt = () => expect(manager.claimLaunch(claim)).toBe(true);
    if (order === "claim-first") claimIt();
    expect(broker.taskBindings.bindingForTask(claim.taskSessionId)).toBeUndefined();
    const admitted = await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: launch.launchId,
      requestId: "request_admit_task" });
    expect(admitted.type).toBe("admitted");
    expect(JSON.stringify(admitted)).not.toContain(launch.bindProof);
    expect(JSON.stringify(admitted)).not.toContain(launch.launchId);
    expect(broker.taskBindings.bindingForTask(claim.taskSessionId)).toBeUndefined();
    expect((await activate()).type).toBe("active");
    if (order === "visible-first") {
      expect(broker.taskBindings.bindingForTask(claim.taskSessionId)).toBeUndefined();
      claimIt();
    }
    expect(broker.taskBindings.bindingForTask(claim.taskSessionId)).toMatchObject({ reviewSessionId: sessionId, documentGeneration: 1 });
    await manager.detach(helper);
    expect(broker.taskBindings.bindingForTask(claim.taskSessionId)).toBeUndefined();
  });

  it("retains an ordinary active window while a focused launch waits for fresh visibility", async () => {
    const { source, broker, manager, envelope, helper, sessionId, stage } = await setup();
    const admitted = await manager.handle(helper, { ...envelope, type: "admit", sourcePath: source, requestId: "request_ordinary_admit" });
    expect(admitted.type).toBe("admitted");
    const active = await manager.handle(helper, { ...envelope, type: "activate", documentValidated: true, requestId: "request_ordinary_active" });
    expect(active.type).toBe("active");
    expect(broker.taskBindings.activityCount()).toBe(0);
    const launch = stage()!;
    expect(manager.claimLaunch({ bindProof: launch.bindProof, taskSessionId: "task_focused_launch", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(true);
    const focused = await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: launch.launchId, requestId: "request_attach_focused" });
    expect(focused.type).toBe("refreshed");
    expect(manager.resourceId(helper)).toBe(admitted.type === "admitted" ? admitted.resourceId : undefined);
    expect(broker.taskBindings.bindingForTask("task_focused_launch")).toBeUndefined();
    expect((await manager.handle(helper, { ...envelope, type: "activate", documentValidated: true, launchId: launch.launchId, requestId: "request_focus_visible" })).type).toBe("active");
    expect(broker.taskBindings.bindingForTask("task_focused_launch")).toMatchObject({ reviewSessionId: sessionId });
    expect(await manager.handle(helper, { ...envelope, type: "activate", documentValidated: true, requestId: "request_visible_replay" }))
      .toMatchObject({ type: "failure", code: "invalid" });
  });

  it("rejects an old focused-launch callback without promoting or retiring its replacement", async () => {
    const { source, broker, manager, envelope, helper, sessionId, stage } = await setup();
    await manager.handle(helper, { ...envelope, type: "admit", sourcePath: source, requestId: "request_callback_admit" });
    await manager.handle(helper, { ...envelope, type: "activate", documentValidated: true, requestId: "request_callback_active" });
    const first = stage()!;
    await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: first.launchId, requestId: "request_first_focus" });
    const second = stage()!;
    expect(manager.claimLaunch({ bindProof: second.bindProof, taskSessionId: "task_replacement_launch", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(true);
    await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: second.launchId, requestId: "request_second_focus" });
    expect(await manager.handle(helper, { ...envelope, type: "activate", launchId: first.launchId,
      documentValidated: true, requestId: "request_old_visible" })).toMatchObject({ type: "failure" });
    expect(broker.taskBindings.bindingForTask("task_replacement_launch")).toBeUndefined();
    expect(await manager.handle(helper, { ...envelope, type: "activate", launchId: second.launchId,
      documentValidated: true, requestId: "request_new_visible" })).toMatchObject({ type: "active" });
    expect(broker.taskBindings.bindingForTask("task_replacement_launch")).toMatchObject({ reviewSessionId: sessionId });
  });

  it("rejects attaching a launch for another document without detaching the current window", async () => {
    const { root, source, broker, manager, envelope, helper } = await setup();
    await manager.handle(helper, { ...envelope, type: "admit", sourcePath: source, requestId: "request_wrong_target_admit" });
    await manager.handle(helper, { ...envelope, type: "activate", documentValidated: true, requestId: "request_wrong_target_active" });
    const other = join(root, "other.pdf");
    await writeFile(other, "%PDF-1.7\nother document\n%%EOF");
    const opened = await broker.openReview({ pdfPath: other, surface: "codex-native" });
    if (opened.kind === "recovery-offered") throw new Error("unexpected recovery");
    const launch = manager.stageLaunch({ sessionId: opened.launch.sessionId, kind: "opened" })!;
    expect(manager.claimLaunch({ bindProof: launch.bindProof, taskSessionId: "task_wrong_document", reviewSessionId: launch.sessionId, documentGeneration: 1 })).toBe(true);
    expect(await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: launch.launchId,
      requestId: "request_wrong_target_attach" })).toMatchObject({ type: "failure" });
    expect(broker.taskBindings.bindingForTask("task_wrong_document")).toBeUndefined();
    expect(await manager.handle(helper, { ...envelope, type: "keepalive", requestId: "request_original_still_active" }))
      .toMatchObject({ type: "refreshed" });
  });

  it("rejects another helper, wrong window, replayed tokens, and task claims after detach", async () => {
    const { broker, manager, envelope, helper, sessionId, stage, activate } = await setup();
    const launch = stage()!;
    const admission = { ...envelope, type: "admit-launch", launchId: launch.launchId, requestId: "request_admit_owned" };
    expect((await manager.handle(helper, admission)).type).toBe("admitted");
    expect(await manager.handle("helper_other_task", { ...admission, requestId: "request_replay_other" })).toMatchObject({ type: "failure" });
    expect(await manager.handle(helper, { ...envelope, windowId: "window_wrong_task", type: "activate", documentValidated: true,
      requestId: "request_wrong_window" })).toMatchObject({ type: "failure", code: "invalid" });
    expect(await manager.handle(helper, { ...envelope, attemptId: "attempt_wrong_task", type: "activate", documentValidated: true,
      requestId: "request_wrong_attempt" })).toMatchObject({ type: "failure", code: "invalid" });
    expect((await activate()).type).toBe("active");
    await manager.detach(helper);
    expect(manager.claimLaunch({ bindProof: launch.bindProof, taskSessionId: "task_detached_launch", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(false);
    expect(broker.taskBindings.bindingForTask("task_detached_launch")).toBeUndefined();
    expect(await manager.handle(helper, { ...admission, requestId: "request_after_detach" })).toMatchObject({ type: "failure" });
  });

  it.each(["staged", "admitted", "visible"] as const)("retires a launch whose PDF changes while %s", async (phase) => {
    const { source, broker, backend, manager, envelope, helper, sessionId, stage, activate } = await setup();
    const launch = stage()!;
    if (phase !== "staged") {
      expect((await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: launch.launchId, requestId: "request_before_change" })).type).toBe("admitted");
    }
    if (phase === "visible") expect((await activate()).type).toBe("active");
    if (phase === "admitted") expect(manager.claimLaunch({ bindProof: launch.bindProof, taskSessionId: "task_stale_launch",
      reviewSessionId: sessionId, documentGeneration: 1 })).toBe(true);
    await writeFile(source, "%PDF-1.7\nnew native generation\n%%EOF");
    await broker.replaceLiveDocument({ sessionId, outputPath: source, observationEpoch: 1 });
    expect(broker.state(sessionId)!.workflow.documentGeneration).toBeGreaterThan(launch.documentGeneration);
    expect(manager.claimLaunch({ bindProof: launch.bindProof, taskSessionId: "task_stale_launch", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(false);
    expect(broker.taskBindings.bindingForTask("task_stale_launch")).toBeUndefined();
    expect(manager.resolveLaunch(launch.launchId)).toBeUndefined();
    if (phase === "admitted") {
      expect((await activate()).type).toBe("failure");
      expect(backend.retentionStatus().presentations).toBe(0);
    }
  });

  it("does not promote a launch when its current attempt detaches during asynchronous activation", async () => {
    const { broker, backend, manager, envelope, helper, sessionId, stage, activate } = await setup();
    const launch = stage()!;
    expect(manager.claimLaunch({ bindProof: launch.bindProof, taskSessionId: "task_activation_race", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(true);
    await manager.handle(helper, { ...envelope, type: "admit-launch", launchId: launch.launchId, requestId: "request_race_admit" });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const realActivate = backend.activate.bind(backend);
    vi.spyOn(backend, "activate").mockImplementation(async (...args) => {
      const projection = await realActivate(...args);
      reached.resolve();
      await release.promise;
      return projection;
    });
    const activating = activate();
    await reached.promise;
    await manager.detach(helper);
    release.resolve();
    expect((await activating).type).toBe("failure");
    expect(broker.taskBindings.bindingForTask("task_activation_race")).toBeUndefined();
  });

  it("expires and cancels unused launches, invalidating their proofs and one-use admission", async () => {
    const { broker, sessionId } = await setup();
    let now = 1_000;
    const registry = new NativeTaskLaunchRegistry(broker, { now: () => new Date(now), pendingTtlMs: 100 });
    try {
      const expired = registry.stageLaunch({ sessionId, kind: "focused" })!;
      expect(registry.resolveLaunch(expired.launchId)).toMatchObject({ sessionId });
      now += 101;
      expect(registry.resolveLaunch(expired.launchId)).toBeUndefined();
      expect(registry.claimLaunch({ bindProof: expired.bindProof, taskSessionId: "task_expired_launch", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(false);
      const cancelled = registry.stageLaunch({ sessionId, kind: "focused" })!;
      expect(registry.cancelLaunch(cancelled.launchId)).toBe(true);
      expect(registry.reserve(cancelled.launchId)).toBeUndefined();
      expect(registry.claimLaunch({ bindProof: cancelled.bindProof, taskSessionId: "task_cancelled_launch", reviewSessionId: sessionId, documentGeneration: 1 })).toBe(false);
    } finally { registry.close(); }
  });


  it("retires a proven-dead child parent only after its protected mutation settles, retaining another live app", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let blockMutation = false;
    const { root, source, broker, manager, envelope, helper, sessionId } = await setup({ beforeFinalRename: async () => {
      if (!blockMutation) return;
      blockMutation = false;
      entered.resolve();
      await release.promise;
    } });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const detached = Promise.withResolvers<void>();
    const lifecycle = new NativeAppLifecycleManager({ detach: async (helperId) => {
      const settling = manager.detachAndSettle(helperId);
      detached.resolve();
      await settling;
    } });
    const deadApp = "app_child_native_test";
    const liveApp = "app_live_native_test";
    const otherHelper = "helper_other_live_test";
    const otherEnvelope = { ...envelope, windowId: "window_other_live_test", attemptId: "attempt_other_live_test" };
    try {
      for (const [appInstanceId, processId] of [[deadApp, child.pid!], [liveApp, process.pid]] as const) {
        expect(await lifecycle.handle({ protocolVersion: 1, type: "register-app", appInstanceId, processId,
          startIdentity: "start_process_native_test", buildIdentity: "build_process_native_test" })).toMatchObject({ type: "ack" });
      }
      expect(lifecycle.attachHelper(deadApp, helper)).toBe(true);
      expect(lifecycle.attachHelper(liveApp, otherHelper)).toBe(true);
      for (const [helperId, identity] of [[helper, envelope], [otherHelper, otherEnvelope]] as const) {
        expect((await manager.handle(helperId, { ...identity, type: "admit", sourcePath: source, requestId: "request_parent_admit" })).type).toBe("admitted");
        expect((await manager.handle(helperId, { ...identity, type: "activate", documentValidated: true, requestId: "request_parent_activate" })).type).toBe("active");
      }
      await lifecycle.sweepDeadParents();
      expect(lifecycle.activity().appInstances).toBe(2);
      await broker.protectChromeReview(sessionId);
      blockMutation = true;
      const command = addPageNote(broker.state(sessionId)!, 0, { x: 1, y: 1, width: 2, height: 2 }, "survives parent death");
      const pending = manager.handle(helper, { ...envelope, type: "invoke", method: "command", generation: 1, revision: 0,
        payload: command, requestId: "request_parent_pending", idempotencyKey: "operation_parent_pending" });
      await entered.promise;
      // A helper release can already have removed its replay records before
      // parent death. Settlement must still retain the accepted operation.
      const released = manager.handle(helper, { ...envelope, type: "release", requestId: "request_release_pending" });
      expect((await released).type).toBe("released");
      const releasing = lifecycle.releaseHelper(deadApp, helper);
      await detached.promise;
      const exited = once(child, "exit");
      child.kill();
      await exited;
      const sweeping = lifecycle.sweepDeadParents();
      await detached.promise;
      expect(lifecycle.activity().appInstances).toBe(2);
      expect(manager.activity().helpers).toBe(1);
      expect(lifecycle.attachHelper(deadApp, "helper_too_late_test")).toBe(false);
      release.resolve();
      await Promise.all([sweeping, releasing]);
      expect((await pending).type).toBe("failure");
      expect(lifecycle.activity().appInstances).toBe(1);
      expect(lifecycle.ownsHelper(liveApp, otherHelper)).toBe(true);
      expect((await manager.handle(otherHelper, { ...otherEnvelope, type: "keepalive", requestId: "request_other_still_live" })).type).not.toBe("failure");
      const recovered = await new DraftSnapshotStore(join(root, "recovery", sessionId)).recover();
      expect(recovered?.chromeProtected).toBe(true);
      expect(recovered?.state.revision).toBe(1);
      expect(recovered?.state.items[0]?.payload).toMatchObject({ comment: "survives parent death" });
    } finally {
      release.resolve();
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      await lifecycle.close();
    }
  });

});
