import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../src/runtime/canonical-json.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRuntimeManager } from "../src/codex/codex-runtime.js";
import { CodexServiceRuntimeBackend } from "../src/codex/codex-runtime-backend.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { ExportCoordinator } from "../src/export/export-coordinator.js";
import type { CodexAppRequest, CodexAppResponse } from "../../../packages/core/src/codex-mcp-protocol.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(generated = true) {
  const root = await mkdtemp(join(tmpdir(), "native-backend-"));
  const pdfPath = join(root, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\nnative resource\n%%EOF");
  const assets = join(root, "assets"); await mkdir(assets);
  await writeFile(join(assets, "pdfium.wasm"), "engine");
  await writeFile(join(assets, "pdfium-codex-worker.js"), "worker");
  const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), portableReader: async () => [],
    inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "next" }] }) });
  const writer = { write: async (): Promise<never> => { throw new Error("unexpected write"); } };
  const picker = { chooseFolder: vi.fn(async (): Promise<string | undefined> => root), locatePdf: vi.fn(async (): Promise<string | undefined> => undefined) };
  const saving = new PdfSaveCoordinator({ broker, writer, picker });
  const exporting = new ExportCoordinator({ writer, capabilities: broker.capabilities });
  const backend = new CodexServiceRuntimeBackend({ broker, saving, exporting, assetRoot: assets });
  let time = 1000;
  const manager = new CodexRuntimeManager(broker, { backend, now: () => new Date(time), panelLeaseMs: 100 });
  cleanups.push(async () => { manager.dispose(); await saving.drain(); await broker.quiesceForShutdown(); await rm(root, { recursive: true, force: true }); });
  const opened = await broker.openReview({ pdfPath, surface: "codex-native", ...(generated ? { workflowMode: "generated-output" as const } : {}) });
  if (opened.kind === "recovery-offered") throw new Error("recovery");
  const sessionId = opened.launch.sessionId;
  // Build the closed pending envelope explicitly, keeping metadata out of requests.
  const panel = async () => {
    const launch = manager.stageLaunch({ sessionId, kind: "opened" })!;
    expect(manager.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: sessionId, documentGeneration: 1, taskSessionId: "task-native" })).toBe(true);
    const d = manager.display(launch.handoff.token)!;
    manager.attestDisplay(d.receipt, "task-native");
    const a = await manager.pending({ protocolVersion: 1, runtimeId: d.privateMeta.runtimeId, attemptId: d.privateMeta.attemptId,
      generation: 1, capability: d.privateMeta.pendingCapability, requestId: "ready_request", authority: "pending", method: "ready", payload: {} });
    if (a.status !== "active") throw new Error("activation");
    return a;
  };
  return { root, broker, manager, backend, saving, sessionId, pdfPath, exporting, picker, panel, advance(ms: number) { time += ms; } };
}
function request(active: Extract<CodexAppResponse, { status: "active" }>, method: CodexAppRequest["method"], payload = {}, requestId = "request_1234") {
  return { protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation,
    capability: active.presentationCapability, authority: "presentation", requestId, method, payload };
}
function payload(result: CodexAppResponse): any { expect(result.status).toBe("ok"); return result.status === "ok" ? result.payload : undefined; }

describe("active native service backend", () => {
  it("scopes resources to each panel and reuses handles for same-generation canonical status", async () => {
    const f = await fixture(); const a = await f.panel(); const b = await f.panel();
    const reads = vi.spyOn(f.broker, "documentRange");
    const first = payload(await f.manager.handle(request(a, "bootstrap")));
    expect(first.scope.launchSurface).toBe("codex");
    expect(JSON.stringify(first)).not.toContain(f.root);
    const handle = first.resourceDescriptors.document.handle;
    expect(payload(await f.manager.handle(request(a, "resource", { handle, offset: 0, length: 256 * 1024 }))).dataBase64).toBeDefined();
    expect(await f.manager.handle(request(b, "resource", { handle, offset: 0, length: 1 }))).toEqual({ status: "denied", reason: "invalid" });
    await f.broker.markLiveDocumentPossiblyStale(f.sessionId);
    const second = payload(await f.manager.handle(request(a, "bootstrap")));
    expect(second.resourceDescriptors).toEqual(first.resourceDescriptors);
    expect(second.state.workflow.freshness).toBe("possibly-stale");
    expect(reads).toHaveBeenCalledTimes(1);
    await f.manager.handle(request(a, "detach"));
    expect(await f.manager.handle(request(a, "resource", { handle, offset: 0, length: 1 }))).toMatchObject({ status: "denied" });
    expect(payload(await f.manager.handle(request(b, "bootstrap"))).resourceDescriptors.document.handle).not.toBe(handle);
    expect(f.backend.retentionStatus().presentations).toBe(1);
  });
  it("uses a separate authenticated lease signal; watermark cannot keep a dead panel alive", async () => {
    const f = await fixture(); const a = await f.panel(); const b = await f.panel();
    expect(payload(await f.manager.handle(request(a, "beginInteraction", { interactionToken: "interaction_123", order: 1, generation: 1 }))).status).toBe("accepted");
    f.advance(70);
    expect(await f.manager.handle(request(a, "watermark"))).toMatchObject({ status: "ok" });
    expect(await f.manager.handle(request(b, "renew"))).toMatchObject({ status: "ok" });
    f.advance(40);
    expect(await f.manager.handle(request(a, "watermark"))).toMatchObject({ status: "denied" });
    expect(f.broker.interactions.held(f.sessionId)).toBe(false);
    expect(await f.manager.handle(request(b, "bootstrap"))).toMatchObject({ status: "ok" });
    expect(f.backend.retentionStatus().presentations).toBe(1);
  });
  it("replays durable command outcomes and denies changed operation identity", async () => {
    const f = await fixture(); const a = await f.panel();
    const command = { type: "set-annotation-name", expectedRevision: 0, annotationName: "Review" };
    const r = request(a, "command", command);
    const first = await f.manager.handle(r);
    expect(first.status).toBe("ok");
    expect(await f.manager.handle(r)).toEqual(first);
    expect(f.broker.state(f.sessionId)?.revision).toBe(1);
    expect(await f.manager.handle(request(a, "command", { ...command, annotationName: "Changed" }))).toMatchObject({ status: "denied" });
    expect(f.broker.state(f.sessionId)?.revision).toBe(1);
  });
  it("retains only current resources through generation, task revocation and repeated detach", async () => {
    const f = await fixture();
    for (let index = 0; index < 8; index++) {
      const a = await f.panel();
      payload(await f.manager.handle(request(a, "bootstrap")));
      await f.manager.handle(request(a, "detach"));
      expect(f.backend.retentionStatus()).toMatchObject({ presentations: 0, resources: 0, cachedOperations: 0, admissions: 0 });
      expect(f.broker.interactions.retentionStatus()).toEqual({ attachments: 0, owners: 0 });
    }
    const a = await f.panel();
    const first = payload(await f.manager.handle(request(a, "bootstrap")));
    await writeFile(f.pdfPath, "%PDF-1.7\nsuccessor\n%%EOF");
    expect(await f.broker.replaceLiveDocument({ sessionId: f.sessionId, outputPath: f.pdfPath, observationEpoch: 1 })).toMatchObject({ status: "committed" });
    expect(await f.manager.handle(request(a, "resource", { handle: first.resources.document, offset: 0, length: 1 }))).toMatchObject({ status: "denied" });
    expect(f.backend.retentionStatus()).toMatchObject({ presentations: 0, resources: 0 });
  });

  it("rejects a late bootstrap after detach and lets a peer hold remain live", async () => {
    const f = await fixture(); const a = await f.panel(); const b = await f.panel();
    await f.manager.handle(request(a, "beginInteraction", { interactionToken: "hold_panel_a", order: 1, generation: 1 }));
    await f.manager.handle(request(b, "beginInteraction", { interactionToken: "hold_panel_b", order: 1, generation: 1 }));
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = f.broker.runtimeState.bind(f.broker);
    vi.spyOn(f.broker, "runtimeState").mockImplementationOnce(async (id) => { reached.resolve(); await gate.promise; return original(id); });
    const pending = f.manager.handle(request(a, "bootstrap"));
    await reached.promise;
    await f.manager.disconnect(request(a, "watermark"));
    expect(f.broker.interactions.held(f.sessionId)).toBe(true);
    gate.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    await f.manager.disconnect(request(b, "watermark"));
    expect(f.broker.interactions.held(f.sessionId)).toBe(false);
    expect(f.backend.retentionStatus()).toMatchObject({ resources: 0, presentations: 0 });
  });

  it("replays from the durable journal after detach and keeps persisted pending outcomes unknown", async () => {
    const f = await fixture(); const a = await f.panel();
    const command = { type: "set-annotation-name", expectedRevision: 0, annotationName: "Recorded" };
    const first = await f.manager.handle(request(a, "command", command));
    await f.manager.detach(a.runtimeId);
    const b = await f.panel();
    expect(await f.manager.handle(request(b, "command", command))).toEqual(first);
    const id = "unknown_request";
    const pendingCommand = { type: "set-annotation-name", expectedRevision: 1, annotationName: "Unknown" };
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await writeFile(join(f.broker.recoveryRoot, f.sessionId, `.codex-operation-${digest(`${f.sessionId}\0${id}`)}.json`), JSON.stringify({
      schemaVersion: 1, status: "pending", fingerprint: digest(canonicalJson({ generation: 1, method: "command", payload: pendingCommand })),
    }));
    expect(await f.manager.handle(request(b, "command", pendingCommand, id))).toEqual({ status: "denied", reason: "unavailable" });
    expect(f.broker.state(f.sessionId)?.annotationName).toBe("Recorded");
  });

  it("uses durable finalization receipts, schedules canonical autosave and protects disconnected drafts", async () => {
    const f = await fixture(false); const a = await f.panel();
    const attachment = payload(await f.manager.handle(request(a, "bootstrap"))).interaction;
    const source = f.broker.state(f.sessionId)!.source;
    await f.broker.establishSaveDestination(f.sessionId, { kind: "original", targetPath: f.pdfPath, capabilityId: source.fileId, fingerprint: source.digest });
    const saves = vi.spyOn(f.saving, "requestSave");
    const draftId = randomUUID();
    payload(await f.manager.handle(request(a, "beginInteraction", { interactionToken: "finalize_token", order: 1, generation: 1, draftId })));
    const draft = { id: draftId, ownerViewId: attachment.attachmentId, baseGeneration: 1, revision: 0, kind: "pageNote", pageIndex: 0,
      text: "native draft", anchor: { kind: "page", pageIndex: 0, nearbyText: "source", rect: { x: 1, y: 1, width: 2, height: 2 } },
      disposition: { kind: "resolved", generation: 1 }, status: "protected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    payload(await f.manager.handle(request(a, "command", { type: "put-draft", expectedRevision: 0, expectedDraftRevision: -1, draft }, "draft_request")));
    await f.saving.drain();
    const final = { interactionToken: "finalize_token", order: 2, outcome: "applied", draftId, expectedDraftRevision: 0 };
    expect(await f.manager.handle(request(a, "finalizeInteraction", { ...final, expectedDraftRevision: 1 }))).toMatchObject({ status: "denied" });
    const before = saves.mock.calls.length;
    const accepted = payload(await f.manager.handle(request(a, "finalizeInteraction", final)));
    expect(accepted).toMatchObject({ status: "finalized", outcome: "applied" });
    await f.saving.drain();
    expect(saves.mock.calls.length).toBe(before + 1);
    expect(payload(await f.manager.handle(request(a, "finalizeInteraction", { ...final, outcome: "discarded" })))).toEqual(accepted);
    expect(f.broker.state(f.sessionId)?.revision).toBe(2);
    const second = { ...draft, id: randomUUID() };
    payload(await f.manager.handle(request(a, "command", { type: "put-draft", expectedRevision: 2, expectedDraftRevision: -1, draft: second }, "draft_request_2")));
    await f.manager.detach(a.runtimeId);
    expect(f.broker.state(f.sessionId)?.pendingDrafts).toHaveLength(1);
    expect(f.broker.state(f.sessionId)?.items).toHaveLength(1);
  });

  it("cannot establish a destination for a replacement after native copy admission", async () => {
    const f = await fixture(false); const a = await f.panel();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = f.broker.capabilities.preauthorizeDestination.bind(f.broker.capabilities);
    vi.spyOn(f.broker.capabilities, "preauthorizeDestination").mockImplementationOnce(async (path) => {
      const capability = await original(path);
      reached.resolve();
      await gate.promise;
      return capability;
    });
    const pending = f.manager.handle(request(a, "chooseCopy", { filename: "copy.pdf" }));
    await reached.promise;
    await writeFile(f.pdfPath, "%PDF-1.7\nreplacement before destination\n%%EOF");
    expect(await f.broker.replaceLiveDocument({ sessionId: f.sessionId, outputPath: f.pdfPath, observationEpoch: 1 })).toMatchObject({ status: "committed" });
    gate.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    expect(f.broker.saveStatus(f.sessionId)?.destination.phase).toBe("none");
  });

  it("drains admitted edits on close, denies fresh admission and releases all panel holds", async () => {
    const f = await fixture(); const a = await f.panel();
    await f.manager.handle(request(a, "beginInteraction", { interactionToken: "closing_hold", order: 1, generation: 1 }));
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = f.broker.acceptMutation.bind(f.broker);
    vi.spyOn(f.broker, "acceptMutation").mockImplementationOnce(async (...args) => { reached.resolve(); await gate.promise; return original(...args); });
    const edit = f.manager.handle(request(a, "command", { type: "set-annotation-name", expectedRevision: 0, annotationName: "Admitted" }));
    await reached.promise;
    const closing = f.manager.close();
    expect(await f.manager.handle(request(a, "bootstrap"))).toEqual({ status: "denied", reason: "unavailable" });
    expect(f.manager.stageLaunch({ sessionId: f.sessionId, kind: "focused" })).toBeUndefined();
    gate.resolve();
    expect(await edit).toMatchObject({ status: "ok" });
    await closing;
    expect(f.broker.state(f.sessionId)?.annotationName).toBe("Admitted");
    expect(f.broker.interactions.held(f.sessionId)).toBe(false);
    expect(f.backend.retentionStatus()).toMatchObject({ presentations: 0, resources: 0, cachedOperations: 0 });
  });

  it("fences a located original before capability rebind after replacement", async () => {
    const f = await fixture(false); const a = await f.panel();
    const originalState = f.broker.state(f.sessionId)!;
    const originalPath = f.broker.capabilities.getFilePath(originalState.source.fileId);
    await f.broker.establishSaveDestination(f.sessionId, { kind: "original", targetPath: f.pdfPath,
      capabilityId: originalState.source.fileId, fingerprint: originalState.source.digest });
    const selected = join(f.root, "located.pdf");
    await writeFile(selected, await readFile(f.pdfPath));
    f.picker.locatePdf.mockResolvedValue(selected);
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = f.broker.relocateOriginalDestination.bind(f.broker);
    vi.spyOn(f.broker, "relocateOriginalDestination").mockImplementationOnce(async (...args) => { reached.resolve(); await gate.promise; return original(...args); });
    const rebind = vi.spyOn(f.broker.capabilities, "rebindApprovedPdf");
    const pending = f.manager.handle(request(a, "locateSave"));
    await reached.promise;
    const rebindsBeforeCommit = rebind.mock.calls.length;
    await writeFile(f.pdfPath, "%PDF-1.7\nreplacement before locate commit\n%%EOF");
    const replacement = await f.broker.replaceLiveDocument({ sessionId: f.sessionId, outputPath: f.pdfPath, observationEpoch: 1 });
    gate.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    expect(rebindsBeforeCommit).toBe(0);
    expect(replacement).toMatchObject({ status: "committed" });
    expect(rebind).not.toHaveBeenCalled();
    expect(f.broker.capabilities.getFilePath(originalState.source.fileId)).toBe(originalPath);
  });

  it("enforces trusted export generation even when the app requests the successor fence", async () => {
    const f = await fixture(false); const a = await f.panel();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const original = f.broker.freezeDelivery.bind(f.broker);
    vi.spyOn(f.broker, "freezeDelivery").mockImplementationOnce(async (...args) => { reached.resolve(); await gate.promise; return original(...args); });
    const exportCopy = vi.spyOn(f.exporting, "exportReviewedCopy");
    const pending = f.manager.handle(request(a, "exportReviewedCopy", { fence: { expectedRevision: 1, documentGeneration: 2 } }));
    await reached.promise;
    await writeFile(f.pdfPath, "%PDF-1.7\nreplacement before export snapshot\n%%EOF");
    expect(await f.broker.replaceLiveDocument({ sessionId: f.sessionId, outputPath: f.pdfPath, observationEpoch: 1 })).toMatchObject({ status: "committed" });
    gate.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    expect(exportCopy).not.toHaveBeenCalled();
  });

  it("updates disconnected reconnect guidance only after a committed canonical relocation", async () => {
    const f = await fixture(false), panel = await f.panel();
    const state = f.broker.state(f.sessionId)!;
    await f.broker.establishSaveDestination(f.sessionId, { kind: "original", targetPath: f.pdfPath, capabilityId: state.source.fileId, fingerprint: state.source.digest });
    await f.manager.detach(panel.runtimeId);
    const previous = f.broker.taskBindings.nativeReconnectForTask("task-native")!;
    const relocated = join(f.root, "relocated.pdf");
    await writeFile(relocated, await readFile(f.pdfPath));
    const approved = await f.broker.capabilities.approvePdf(relocated);
    expect(f.broker.taskBindings.nativeReconnectForTask("task-native")).toEqual(previous);
    await f.broker.relocateOriginalDestination(f.sessionId, { targetPath: approved.canonicalPath, capabilityId: approved.id, fingerprint: state.source.digest });
    expect(f.broker.taskBindings.nativeReconnectForTask("task-native")).toEqual({ ...previous, pdfPath: approved.canonicalPath });
    expect(f.broker.taskBindings.bindingForTask("task-native")).toBeUndefined();
  });

  it("keeps same-generation relocation usable and reconnects with the relocated source proof", async () => {
    const f = await fixture(false); const a = await f.panel(); const b = await f.panel();
    const bootstrap = payload(await f.manager.handle(request(a, "bootstrap")));
    const state = f.broker.state(f.sessionId)!;
    const relocated = join(f.root, "relocated.pdf");
    await writeFile(relocated, await readFile(f.pdfPath));
    await f.broker.establishSaveDestination(f.sessionId, { kind: "original", targetPath: f.pdfPath, capabilityId: state.source.fileId, fingerprint: state.source.digest });
    f.picker.locatePdf.mockResolvedValue(relocated);
    expect(await f.manager.handle(request(a, "locateSave"))).toMatchObject({ status: "ok" });
    const refreshed = payload(await f.manager.handle(request(a, "bootstrap")));
    expect(refreshed.resourceDescriptors).toEqual(bootstrap.resourceDescriptors);
    expect(await f.manager.handle(request(b, "saveStatus"))).toMatchObject({ status: "ok" });
    const matched = await f.broker.restartReconnects.matchNative({ ticket: a.reconnectTicket, runtimeId: a.runtimeId, attemptId: a.attemptId, documentGeneration: 1 });
    expect(matched).toBeDefined();
    const scope = matched === undefined ? undefined : f.broker.nativeRestartScope(matched.sourcePathHash, matched.sourceDigest, matched.reviewSessionHash);
    expect(scope?.canonicalSourcePath).toContain("relocated.pdf");
    expect(f.broker.taskBindings.nativeReconnectForTask("task-native")?.pdfPath).toBe(scope?.canonicalSourcePath);
    await f.manager.close();
    await f.saving.drain();
    await f.broker.quiesceForShutdown();
    expect(f.broker.taskBindings.nativeReconnectForTask("task-native")).toBeUndefined();
    const broker = new SessionBroker({ recoveryRoot: f.broker.recoveryRoot, portableReader: async () => [] });
    await broker.initialize();
    const offered = await broker.openReview({ pdfPath: relocated, surface: "codex-native" });
    if (offered.kind !== "recovery-offered") throw new Error("Expected protected relocation recovery");
    const recovered = await broker.openReview({ pdfPath: relocated, surface: "codex-native", recoveryDecision: "resume", recoveryOffer: offered.recoveryOffer, recoveryOperationId: "relocation_recovery" });
    if (recovered.kind === "recovery-offered") throw new Error("Expected recovered relocation");
    expect(recovered.launch.sessionId).toBe(f.sessionId);
    const reopened = new CodexRuntimeManager(broker);
    cleanups.unshift(async () => { reopened.dispose(); await broker.quiesceForShutdown(); });
    await reopened.trustedTaskPrompt("task-native");
    const reconnect = { ...request(a, "watermark"), authority: "reconnect", method: "reconnect", capability: a.reconnectTicket };
    expect(await reopened.stageReconnect(reconnect)).toMatchObject({ status: "active" });
  });

  it.each([false, true])("retires late disk replay cache after detach while preserving peers: peer=%s", async (keepPeer) => {
    const f = await fixture();
    const command = { type: "set-annotation-name", expectedRevision: 0, annotationName: "Recorded" };
    const a = await f.panel();
    expect(await f.manager.handle(request(a, "command", command))).toMatchObject({ status: "ok" });
    await f.manager.detach(a.runtimeId);
    expect(f.backend.retentionStatus().cachedOperations).toBe(0);
    const b = await f.panel();
    const peer = keepPeer ? await f.panel() : undefined;
    const replays = [
      f.manager.handle(request(b, "command", command)),
      f.manager.handle(request(b, "command", command)),
    ];
    await f.manager.detach(b.runtimeId);
    for (const replay of await Promise.all(replays)) expect(replay).toMatchObject({ status: "denied" });
    expect(f.broker.state(f.sessionId)?.revision).toBe(1);
    expect(f.backend.retentionStatus()).toMatchObject({
      presentations: keepPeer ? 1 : 0,
      resources: 0,
      cachedOperations: keepPeer ? 1 : 0,
      admissions: 0,
    });
    if (peer !== undefined) {
      expect(await f.manager.handle(request(peer, "command", command))).toMatchObject({ status: "ok" });
      await f.manager.detach(peer.runtimeId);
      expect(f.backend.retentionStatus().cachedOperations).toBe(0);
    }
  });

});
