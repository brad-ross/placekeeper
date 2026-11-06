import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { ExtensionRuntimeManager } from "../src/codex/extension-runtime.js";
import { CodexServiceRuntimeBackend } from "../src/codex/codex-runtime-backend.js";
import { PdfSaveCoordinator } from "../src/saving/pdf-save-coordinator.js";
import { ExportCoordinator } from "../src/export/export-coordinator.js";
import type { CodexAppRequest, CodexAppResponse } from "../../../packages/core/src/codex-mcp-protocol.js";
import { DraftSnapshotStore, type SnapshotHooks } from "../src/recovery/draft-snapshot.js";
import type { DestinationPicker } from "../src/host/destination-picker.js";

type Active = Extract<CodexAppResponse, { status: "active" }>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(snapshotHooks?: SnapshotHooks, picker?: DestinationPicker) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-extension-"));
  const pdfPath = join(root, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\nextension fixture\n%%EOF");
  const assets = join(root, "assets"); await mkdir(assets);
  await writeFile(join(assets, "pdfium.wasm"), "engine");
  await writeFile(join(assets, "pdfium-codex-worker.js"), "worker");
  let time = Date.now();
  const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), portableReader: async () => [],
    ...(snapshotHooks === undefined ? {} : { snapshotHooks }),
    inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "next" }] }) });
  const writer = { write: async (): Promise<never> => { throw new Error("unexpected write"); } };
  const saving = new PdfSaveCoordinator({ broker, writer, ...(picker === undefined ? {} : { picker }) });
  const exporting = new ExportCoordinator({ writer, capabilities: broker.capabilities });
  const backend = new CodexServiceRuntimeBackend({ broker, saving, exporting, assetRoot: assets });
  const manager = new ExtensionRuntimeManager(broker, { backend, now: () => time, panelLeaseMs: 100, grantIdleMs: 1000,
    pickPdf: async () => pdfPath });
  cleanups.push(async () => { await manager.close(); await saving.drain(); await broker.quiesceForShutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, broker, backend, manager, saving, pdfPath, advance(ms: number) { time += ms; } };
}
function request(active: Active, method: string, payload: unknown = {}): CodexAppRequest {
  return { protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation,
    capability: active.presentationCapability, authority: "presentation", requestId: randomUUID(), method, payload } as CodexAppRequest;
}
function active(result: Awaited<ReturnType<ExtensionRuntimeManager["resume"]>>) {
  if (result.status !== "active") throw new Error(`Expected active, got ${result.status}`);
  return result;
}
function payload(result: CodexAppResponse): any {
  if (result.status !== "ok") throw new Error(`Expected ok, got ${result.status}`);
  return result.payload;
}

async function opened(manager: ExtensionRuntimeManager, input: {pdfPath?:string}) {
  const provisional = await manager.open(input);
  if(provisional.status !== 'provisional') throw Error(`Expected provisional, got ${provisional.status}`);
  return active(await manager.resume(provisional.grant,randomUUID(),'activate'));
}

describe("app-owned extension presentations", () => {
  it("rejects a folder picker result when its presentation retires while the picker is open", async () => {
    const entered = Promise.withResolvers<void>(), selection = Promise.withResolvers<string>();
    const f = await fixture(undefined, { chooseFolder: async () => { entered.resolve(); return selection.promise; }, locatePdf: async () => undefined });
    const panel = await opened(f.manager, {});
    const pending = f.manager.handle(request(panel.presentation, "chooseFolder"));
    await entered.promise;
    await f.manager.handle(request(panel.presentation, "detach"));
    selection.resolve("/tmp");
    expect(await pending).toMatchObject({ status: "denied" });
  });

  it("keeps a protected draft when its finalization presentation retires before publication", async () => {
    let gate = false;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = await fixture({ beforeFinalRename: async () => {
      if (gate) { gate = false; entered.resolve(); await release.promise; }
    } });
    const panel = await opened(f.manager, {});
    const initial = payload(await f.manager.handle(request(panel.presentation, "bootstrap")));
    const draftId = randomUUID(), interactionToken = randomUUID(), timestamp = new Date().toISOString();
    expect(await f.manager.handle(request(panel.presentation, "beginInteraction", { interactionToken, order: 1, generation: 1, draftId }))).toMatchObject({ status: "ok" });
    expect(await f.manager.handle(request(panel.presentation, "command", { type: "put-draft", expectedRevision: 0, expectedDraftRevision: -1, draft: {
      id: draftId, ownerViewId: initial.interaction.attachmentId, baseGeneration: 1, revision: 0, kind: "pageNote", pageIndex: 0,
      text: "protected note", anchor: { kind: "page", pageIndex: 0, nearbyText: "next", rect: { x: 1, y: 1, width: 1, height: 1 } },
      disposition: { kind: "resolved", generation: 1 }, status: "protected", createdAt: timestamp, updatedAt: timestamp,
    } }))).toMatchObject({ status: "ok" });
    gate = true;
    const pending = f.manager.handle(request(panel.presentation, "finalizeInteraction", {
      interactionToken, order: 2, outcome: "applied", draftId, expectedDraftRevision: 0,
    }));
    await entered.promise;
    await f.manager.handle(request(panel.presentation, "detach"));
    release.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    expect(f.broker.state(initial.sessionId)?.revision).toBe(1);
    expect(f.broker.state(initial.sessionId)?.pendingDrafts).toHaveLength(1);
    expect(f.broker.state(initial.sessionId)?.items).toHaveLength(0);
    const recovered = await new DraftSnapshotStore(join(f.broker.recoveryRoot, initial.sessionId)).recover();
    expect(recovered?.state.pendingDrafts).toHaveLength(1);
    expect(recovered?.interactionReceipts ?? []).toHaveLength(0);
  });

  it.each(["detach", "resume"] as const)("rejects a command after %s retires authority while protection is pending", async (retirement) => {
    const f = await fixture(), panel = await opened(f.manager, {});
    const initial = payload(await f.manager.handle(request(panel.presentation, "bootstrap")));
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const protect = f.broker.protectChromeReview.bind(f.broker);
    vi.spyOn(f.broker, "protectChromeReview").mockImplementationOnce(async (id) => {
      await protect(id); entered.resolve(); await release.promise;
    });
    const command = { type: "set-annotation-name", expectedRevision: 0, annotationName: "retired" };
    const pending = f.manager.handle(request(panel.presentation, "command", command));
    await entered.promise;
    const fresh = retirement === "resume" ? active(await f.manager.resume(panel.grant, randomUUID())) : undefined;
    if (retirement === "detach") await f.manager.handle(request(panel.presentation, "detach"));
    release.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    expect(f.broker.state(initial.sessionId)?.revision).toBe(0);
    const recovered = await new DraftSnapshotStore(join(f.broker.recoveryRoot, initial.sessionId)).recover();
    expect(recovered?.state.revision).toBe(0);
    expect(f.broker.chromeProtected(initial.sessionId)).toBe(true);
    if (fresh) {
      expect(await f.manager.handle(request(fresh.presentation, "command", { ...command, annotationName: "current" }))).toMatchObject({ status: "ok" });
      expect(f.broker.state(initial.sessionId)?.annotationName).toBe("current");
    }
  });

  it.each(["predecessor", "publication"] as const)("rejects retired command authority at the %s boundary", async (boundary) => {
    let gate = false;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = await fixture({ beforeFinalRename: async () => {
      if (gate) { gate = false; entered.resolve(); await release.promise; }
    } });
    const panel = await opened(f.manager, {});
    const initial = payload(await f.manager.handle(request(panel.presentation, "bootstrap")));
    await f.broker.protectChromeReview(initial.sessionId);
    gate = true;
    const predecessor = boundary === "predecessor" ? f.broker.acceptMutation(initial.sessionId, {
      type: "set-annotation-name", expectedRevision: 0, annotationName: "predecessor",
    }) : undefined;
    if (predecessor) await entered.promise;
    const queued = Promise.withResolvers<void>();
    const accept = f.broker.acceptMutation.bind(f.broker);
    vi.spyOn(f.broker, "acceptMutation").mockImplementationOnce((...args) => { queued.resolve(); return accept(...args); });
    const expectedRevision = predecessor ? 1 : 0;
    const pending = f.manager.handle(request(panel.presentation, "command", {
      type: "set-annotation-name", expectedRevision, annotationName: "retired",
    }));
    await queued.promise;
    if (!predecessor) await entered.promise;
    await f.manager.handle(request(panel.presentation, "detach"));
    release.resolve();
    await predecessor;
    expect(await pending).toMatchObject({ status: "denied" });
    expect(f.broker.state(initial.sessionId)?.revision).toBe(expectedRevision);
    const recovered = await new DraftSnapshotStore(join(f.broker.recoveryRoot, initial.sessionId)).recover();
    expect(recovered?.state.revision).toBe(expectedRevision);
    expect(recovered?.state.annotationName).not.toBe("retired");
  });

  it.each(["chooseCopy", "chooseOriginal"] as const)("rejects %s publication after the presentation detaches", async (method) => {
    let gate = false;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const f = await fixture({ beforeFinalRename: async () => {
      if (gate) { gate = false; entered.resolve(); await release.promise; }
    } });
    const panel = await opened(f.manager, {});
    const initial = payload(await f.manager.handle(request(panel.presentation, "bootstrap")));
    await f.broker.protectChromeReview(initial.sessionId);
    const before = f.broker.saveStatus(initial.sessionId);
    gate = true;
    const pending = f.manager.handle(request(panel.presentation, method, method === "chooseCopy" ? { filename: "reviewed.pdf" } : {}));
    await entered.promise;
    await f.manager.handle(request(panel.presentation, "detach"));
    release.resolve();
    expect(await pending).toMatchObject({ status: "denied" });
    expect(f.broker.saveStatus(initial.sessionId)).toEqual(before);
    const recovered = await new DraftSnapshotStore(join(f.broker.recoveryRoot, initial.sessionId)).recover();
    expect(recovered?.destination).toEqual(before?.destination);
  });

  it("opens via a user picker without a task binding and serves the canonical reader", async () => {
    const f = await fixture();
    const initialOpen = await opened(f.manager, {});
    expect(f.broker.taskBindings.activityCount()).toBe(0);
    const initial = payload(await f.manager.handle(request(initialOpen.presentation, "bootstrap")));
    expect(initial.state.source).toBeDefined();
    expect(initial.scope.codexContext).toBeUndefined();
    expect(JSON.stringify(initial)).not.toContain(f.pdfPath);
    expect(payload(await f.manager.handle(request(initialOpen.presentation, "resource", {
      handle: initial.resourceDescriptors.document.handle, offset: 0, length: 8,
    }))).dataBase64).toBe(Buffer.from("%PDF-1.7").toString("base64"));
    expect(f.manager.activityCount()).toBe(1);
  });

  it("suspends after a lost lease and resumes durable work with fresh presentation authority", async () => {
    const f = await fixture(), initialOpen = await opened(f.manager, { pdfPath: f.pdfPath });
    const initial = payload(await f.manager.handle(request(initialOpen.presentation, "bootstrap")));
    const timestamp = new Date().toISOString();
    await f.broker.acceptMutation(initial.sessionId, { type: "add", expectedRevision: 0, item: {
      id: randomUUID(), kind: "highlight", pageIndex: 0, createdAt: timestamp, updatedAt: timestamp,
      payload: { quote: "remember", prefix: "", suffix: "", rect: { x: 72, y: 92, width: 80, height: 14 },
        segmentRects: [{ x: 72, y: 92, width: 80, height: 14 }], reliable: true, comment: "accepted" },
    } });
    f.advance(101);
    expect(await f.manager.handle(request(initialOpen.presentation, "watermark"))).toEqual({ status: "denied", reason: "expired" });
    expect(f.manager.activityCount()).toBe(0);
    expect(f.backend.retentionStatus().presentations).toBe(0);
    const resumed = active(await f.manager.resume(initialOpen.grant, randomUUID()));
    expect(resumed.presentation.runtimeId).not.toBe(initialOpen.presentation.runtimeId);
    expect(resumed.presentation.presentationCapability).not.toBe(initialOpen.presentation.presentationCapability);
    expect(payload(await f.manager.handle(request(resumed.presentation, "bootstrap"))).state.items[0].payload.comment).toBe("accepted");
    expect(await f.manager.handle(request(initialOpen.presentation, "bootstrap"))).toMatchObject({ status: "denied" });
  });

  it("explicitly recovers a disconnected local review and retires every old authority", async () => {
    const f = await fixture(), before = await opened(f.manager, { pdfPath: f.pdfPath });
    const original = payload(await f.manager.handle(request(before.presentation, 'bootstrap')));
    await f.broker.acceptMutation(original.sessionId, { type: 'set-annotation-name', expectedRevision: 0, annotationName: 'retained work' });
    const initialOffer = await f.manager.open({ pdfPath: f.pdfPath });
    if (initialOffer.status !== 'busy') throw Error('Expected choice');
    const pending = await f.manager.dispatch({ action: 'recheck', recoveryToken: initialOffer.recoveryToken });
    expect(pending).toMatchObject({ status: 'busy', canResume: false });
    expect(pending).not.toHaveProperty('canRecover');
    if (pending.status !== 'busy') throw Error('Expected refreshed choice');
    expect(await f.manager.dispatch({ action: 'recheck', recoveryToken: initialOffer.recoveryToken })).toEqual(pending);
    f.advance(60);
    expect((await f.manager.handle(request(before.presentation, 'renew'))).status).toBe('ok');
    f.advance(41);
    const renewed = await f.manager.dispatch({ action: 'recheck', recoveryToken: pending.recoveryToken });
    expect(renewed).toMatchObject({ status: 'busy', canResume: false });
    expect(renewed).not.toHaveProperty('canRecover');
    if (renewed.status !== 'busy') throw Error('Expected renewed choice');
    expect(f.manager.activityCount()).toBe(1);
    f.advance(60);
    const offer = await f.manager.dispatch({ action: 'recheck', recoveryToken: renewed.recoveryToken });
    expect(offer).toMatchObject({ status: 'busy', canResume: false, canRecover: true });
    expect(f.manager.activityCount()).toBe(0);
    if (offer.status !== 'busy') throw Error('Expected choice');
    const input = { action: 'choose', recoveryToken: offer.recoveryToken, choice: 'recover', operationId: randomUUID() } as const;
    const chosen = await f.manager.dispatch(input);
    expect(chosen.status).toBe('provisional');
    if (chosen.status !== 'provisional') throw Error('Expected provisional');
    expect(await f.manager.dispatch(input)).toEqual(chosen);
    const after = active(await f.manager.resume(chosen.grant, randomUUID(), 'activate'));
    const restored = payload(await f.manager.handle(request(after.presentation, 'bootstrap')));
    expect(restored.sessionId).toBe(original.sessionId);
    expect(restored.state.annotationName).toBe('retained work');
    expect(await f.manager.resume(before.grant, randomUUID())).toEqual({ status: 'unavailable' });
    expect(await f.manager.handle(request(before.presentation, 'command', { type: 'set-annotation-name', expectedRevision: 1, annotationName: 'stale' }))).toMatchObject({ status: 'denied' });
    expect(f.broker.state(original.sessionId)?.annotationName).toBe('retained work');
  });
  it("rechecks a released review and offers explicit resume without acquiring it", async () => {
    const f = await fixture(), panel = await opened(f.manager, { pdfPath: f.pdfPath });
    const original = payload(await f.manager.handle(request(panel.presentation, 'bootstrap')));
    const busy = await f.manager.open({ pdfPath: f.pdfPath });
    if (busy.status !== 'busy') throw Error('Expected choice');
    expect(busy.canResume).toBe(false);
    await f.manager.revoke(panel.grant);
    const offer = await f.manager.dispatch({ action: 'recheck', recoveryToken: busy.recoveryToken });
    expect(offer).toMatchObject({ status: 'busy', canResume: true });
    expect(offer).not.toHaveProperty('canRecover');
    expect(f.manager.activityCount()).toBe(0);
    if (offer.status !== 'busy') throw Error('Expected refreshed choice');
    const chosen = await f.manager.choose({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'resume', operationId: randomUUID() });
    if (chosen.status !== 'provisional') throw Error('Expected resumed review');
    const resumed = active(await f.manager.resume(chosen.grant, randomUUID(), 'activate'));
    expect(payload(await f.manager.handle(request(resumed.presentation, 'bootstrap'))).sessionId).toBe(original.sessionId);
  });

  it("rejects disconnected recovery after the old panel reconnects and loses its next lease", async () => {
    const f = await fixture(), before = await opened(f.manager, {});
    const liveOffer = await f.manager.open({ pdfPath: f.pdfPath });
    expect(liveOffer).not.toHaveProperty('canRecover', true);
    if (liveOffer.status !== 'busy') throw Error('Expected choice');
    f.advance(101);
    const offer = await f.manager.open({ pdfPath: f.pdfPath });
    expect(offer).toMatchObject({ canRecover: true });
    if (offer.status !== 'busy') throw Error('Expected choice');
    const resumed = active(await f.manager.resume(before.grant, randomUUID()));
    expect(await f.manager.dispatch({ action: 'recheck', recoveryToken: liveOffer.recoveryToken })).toEqual({ status: 'unavailable' });
    expect(await f.manager.dispatch({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'recover', operationId: randomUUID() })).toEqual({ status: 'unavailable' });
    expect((await f.manager.handle(request(resumed.presentation, 'renew'))).status).toBe('ok');
    f.advance(101);
    expect(await f.manager.dispatch({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'recover', operationId: randomUUID() })).toEqual({ status: 'unavailable' });
    expect((await f.manager.resume(resumed.grant, randomUUID())).status).toBe('active');
  });

  it("rejects an old offer after the owner rotates and releases its replacement grant", async () => {
    const f = await fixture(), panel = await opened(f.manager, { pdfPath: f.pdfPath });
    const busy = await f.manager.open({ pdfPath: f.pdfPath });
    if (busy.status !== 'busy') throw Error('Expected choice');
    const replacement = active(await f.manager.resume(panel.grant, randomUUID()));
    expect(await f.manager.revoke(replacement.grant)).toBe(true);
    expect(await f.manager.dispatch({ action: 'recheck', recoveryToken: busy.recoveryToken })).toEqual({ status: 'unavailable' });
    expect(await f.manager.open({ pdfPath: f.pdfPath })).toMatchObject({ status: 'busy', canResume: true });
  });

  it("rejects an older unowned resume offer after an intervening owner releases", async () => {
    const f = await fixture(), panel = await opened(f.manager, { pdfPath: f.pdfPath });
    expect(await f.manager.revoke(panel.grant)).toBe(true);
    const older = await f.manager.open({ pdfPath: f.pdfPath });
    const newer = await f.manager.open({ pdfPath: f.pdfPath });
    if (older.status !== 'busy' || newer.status !== 'busy') throw Error('Expected choices');
    const next = await f.manager.choose({ action: 'choose', recoveryToken: newer.recoveryToken, choice: 'resume', operationId: randomUUID() });
    if (next.status !== 'provisional') throw Error('Expected grant');
    expect(await f.manager.revoke(next.grant)).toBe(true);
    expect(await f.manager.choose({ action: 'choose', recoveryToken: older.recoveryToken, choice: 'resume', operationId: randomUUID() })).toEqual({ status: 'unavailable' });
  });

  it("rejects rechecking an older document generation under the same grant", async () => {
    const f = await fixture(), panel = await opened(f.manager, { pdfPath: f.pdfPath });
    const original = payload(await f.manager.handle(request(panel.presentation, 'bootstrap')));
    const busy = await f.manager.open({ pdfPath: f.pdfPath });
    if (busy.status !== 'busy') throw Error('Expected choice');
    await writeFile(f.pdfPath, "%PDF-1.7\nnew extension source generation\n%%EOF");
    await f.broker.observeLiveDocumentHint({ sessionId: original.sessionId, outputPath: f.pdfPath, hostReason: 'activation' });
    // A filesystem watcher may supersede the explicit observation before it completes.
    await vi.waitFor(() => expect(f.broker.nativeAdmissionScope(original.sessionId)?.documentGeneration).toBe(2));
    expect(await f.manager.dispatch({ action: 'recheck', recoveryToken: busy.recoveryToken })).toEqual({ status: 'unavailable' });
  });

  it("activates and reconnects protected work when the optional recent index is malformed", async () => {
    const f = await fixture(), provisional = await f.manager.open({ pdfPath: f.pdfPath });
    if (provisional.status !== 'provisional') throw Error('Expected provisional');
    await writeFile(join(f.broker.recoveryRoot, 'extension-recent-reviews.json'), '{invalid', { mode: 0o600 });
    const first = active(await f.manager.resume(provisional.grant, randomUUID(), 'activate'));
    const state = payload(await f.manager.handle(request(first.presentation, 'bootstrap')));
    expect(f.broker.chromeProtected(state.sessionId)).toBe(true);
    await expect(f.manager.dispatch({ action: 'recent-list' })).rejects.toThrow();
    f.advance(101);
    const next = active(await f.manager.resume(first.grant, randomUUID()));
    expect(payload(await f.manager.handle(request(next.presentation, 'bootstrap'))).sessionId).toBe(state.sessionId);
  });

  it("opens an independent review of an exact clean browser session without changing that session", async () => {
    const f = await fixture(), original = await f.broker.openReview({ pdfPath: f.pdfPath });
    if (original.kind === 'recovery-offered') throw Error('Expected clean review');
    const state = f.broker.state(original.launch.sessionId);
    expect(f.broker.chromeProtected(original.launch.sessionId)).toBe(false);
    const offered = await f.manager.open({ pdfPath: f.pdfPath });
    expect(offered).toMatchObject({ status: 'busy', canResume: false });
    if (offered.status !== 'busy') throw Error('Expected choice');
    const fork = await f.manager.choose({ action: 'choose', recoveryToken: offered.recoveryToken, choice: 'fork', operationId: randomUUID() });
    expect(fork.status).toBe('provisional');
    if (fork.status !== 'provisional') throw Error('Expected fork');
    const after = active(await f.manager.resume(fork.grant, randomUUID(), 'activate'));
    expect(payload(await f.manager.handle(request(after.presentation, 'bootstrap'))).sessionId).not.toBe(original.launch.sessionId);
    expect(f.broker.state(original.launch.sessionId)).toEqual(state);
    expect(f.broker.chromeProtected(original.launch.sessionId)).toBe(false);
  });

  it("lists private recent reviews and resumes the selected review at its retained page", async () => {
    const f = await fixture(), before = await opened(f.manager, {});
    const original = payload(await f.manager.handle(request(before.presentation, 'watermark')));
    expect(await f.manager.dispatch({ action: 'reading-position', grant: before.grant, page: 1 })).toEqual({ status: 'position-saved' });
    const list: any = await f.manager.dispatch({ action: 'recent-list' });
    expect(list).toMatchObject({ status: 'recent-reviews', items: [{ title: 'paper.pdf', page: 1 }] });
    expect(JSON.stringify(list)).not.toContain(f.pdfPath);
    expect(JSON.stringify(list)).not.toContain(original.sessionId);
    expect(JSON.stringify(list)).not.toContain(before.grant);
    await f.manager.revoke(before.grant);
    const offered: any = await f.manager.dispatch({ action: 'recent-open', id: list.items[0].id });
    expect(offered).toMatchObject({ status: 'busy', canResume: true });
    const chosen: any = await f.manager.choose({ action: 'choose', recoveryToken: offered.recoveryToken, choice: 'resume', operationId: randomUUID() });
    const after = active(await f.manager.resume(chosen.grant, randomUUID(), 'activate'));
    const boot = payload(await f.manager.handle(request(after.presentation, 'bootstrap')));
    expect(boot.sessionId).toBe(original.sessionId);
    expect(boot.location).toEqual({ kind: 'page', page: 1 });
    expect(await f.manager.dispatch({ action: 'recent-open', id: f.pdfPath })).toEqual({ status: 'unavailable' });
    expect(await f.manager.dispatch({ action: 'reading-position', grant: before.grant, page: 2 })).toEqual({ status: 'unavailable' });
  });

  it("resumes the exact independent recent review after a service restart", async () => {
    const f = await fixture(), first = await opened(f.manager, {});
    const firstState = payload(await f.manager.handle(request(first.presentation, 'watermark')));
    const offer = await f.manager.open({pdfPath:f.pdfPath});if(offer.status!=='busy')throw Error('Expected choice');
    const fork=await f.manager.choose({action:'choose',recoveryToken:offer.recoveryToken,choice:'fork',operationId:randomUUID()});if(fork.status!=='provisional')throw Error('Expected fork');
    const second=active(await f.manager.resume(fork.grant,randomUUID(),'activate'));
    const secondState=payload(await f.manager.handle(request(second.presentation,'watermark')));
    await f.broker.acceptMutation(firstState.sessionId,{type:'set-annotation-name',expectedRevision:0,annotationName:'first'});
    await f.broker.acceptMutation(secondState.sessionId,{type:'set-annotation-name',expectedRevision:0,annotationName:'independent'});
    await f.manager.dispatch({action:'reading-position',grant:second.grant,page:1});
    const list:any=await f.manager.dispatch({action:'recent-list'});expect(list.items).toHaveLength(2);
    const id=list.items[0].id;
    await f.manager.close();await f.saving.drain();await f.broker.quiesceForShutdown();
    const broker=new SessionBroker({recoveryRoot:join(f.root,'recovery'),portableReader:async()=>[],inspectGeneration:async()=>({pageCount:1,pages:[{pageIndex:0,text:'next'}]})});
    const writer={write:async():Promise<never>=>{throw Error('unexpected write');}};
    const saving=new PdfSaveCoordinator({broker,writer}),exporting=new ExportCoordinator({writer,capabilities:broker.capabilities});
    const backend=new CodexServiceRuntimeBackend({broker,saving,exporting,assetRoot:join(f.root,'assets')});
    const manager=new ExtensionRuntimeManager(broker,{backend});
    cleanups.push(async()=>{await manager.close();await saving.drain();await broker.quiesceForShutdown();});
    const selected:any=await manager.dispatch({action:'recent-open',id});expect(selected).toMatchObject({status:'busy',canResume:true});
    const chosen:any=await manager.choose({action:'choose',recoveryToken:selected.recoveryToken,choice:'resume',operationId:randomUUID()});
    const resumed=active(await manager.resume(chosen.grant,randomUUID(),'activate'));
    const boot=payload(await manager.handle(request(resumed.presentation,'bootstrap')));
    expect(boot.sessionId).toBe(secondState.sessionId);expect(boot.state.annotationName).toBe('independent');expect(boot.location).toEqual({kind:'page',page:1});
  });

  it("reobserves a superseded canonical check before exposing a new source generation", async () => {
    const f = await fixture(), initialOpen = await opened(f.manager, { pdfPath: f.pdfPath });
    const initial = payload(await f.manager.handle(request(initialOpen.presentation, "bootstrap")));
    f.advance(101);
    await f.manager.handle(request(initialOpen.presentation, "watermark"));
    await writeFile(f.pdfPath, "%PDF-1.7\nnew extension source generation\n%%EOF");
    const observe = f.broker.observeLiveDocumentHint.bind(f.broker);
    const observation = vi.spyOn(f.broker, "observeLiveDocumentHint").mockResolvedValueOnce({ status: "superseded", sessionId: initial.sessionId, documentGeneration: 1, reason: "observation-hint-was-coalesced-or-session-ended" });
    observation.mockImplementation(observe);
    const resumed = active(await f.manager.resume(initialOpen.grant, randomUUID()));
    expect(resumed.presentation.generation).toBe(2);
    expect(observation.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["superseded", "deferred"] as const)("keeps a suspended reader inactive while canonical reconciliation remains %s", async (status) => {
    const f = await fixture(), initialOpen = await opened(f.manager, { pdfPath: f.pdfPath });
    const initial = payload(await f.manager.handle(request(initialOpen.presentation, "bootstrap")));
    f.advance(101);
    await f.manager.handle(request(initialOpen.presentation, "watermark"));
    vi.spyOn(f.broker, "observeLiveDocumentHint").mockResolvedValue({ status, sessionId: initial.sessionId, documentGeneration: 1, reason: "canonical observation not settled" });
    expect(await f.manager.resume(initialOpen.grant, randomUUID())).toEqual({ status: "unavailable" });
    expect(f.backend.retentionStatus().presentations).toBe(0);
    expect(await f.manager.handle(request(initialOpen.presentation, "bootstrap"))).toMatchObject({ status: "denied" });
  });

  it("does not borrow another app's grant or expose its document resources", async () => {
    const f = await fixture(), a = await opened(f.manager, { pdfPath: f.pdfPath });
    const busy = await f.manager.open({ pdfPath: f.pdfPath });
    expect(busy.status).toBe("busy");
    expect(JSON.stringify(busy)).not.toContain(a.grant);
    expect(JSON.stringify(busy)).not.toContain(a.presentation.presentationCapability);
    expect(await f.manager.resume("x".repeat(43), randomUUID())).toEqual({ status: "unavailable" });
    expect(await f.manager.handle({ ...request(a.presentation, "bootstrap"), capability: "x".repeat(43) })).toMatchObject({ status: "denied" });
  });

  it("acknowledges a lost revoke reply without granting access or revoking a rotated owner", async () => {
    const f = await fixture(), first = await opened(f.manager, {});
    const second = active(await f.manager.resume(first.grant, randomUUID()));
    expect(await f.manager.dispatch({ action: 'revoke', grant: first.grant })).toEqual({ status: 'unavailable' });
    expect((await f.manager.handle(request(second.presentation, 'renew'))).status).toBe('ok');
    expect(await f.manager.dispatch({ action: 'revoke', grant: second.grant })).toEqual({ status: 'closed' });
    f.advance(10_000);
    expect(await f.manager.dispatch({ action: 'revoke', grant: second.grant })).toEqual({ status: 'closed' });
    expect(await f.manager.resume(second.grant, randomUUID())).toEqual({ status: 'unavailable' });
    f.advance(290_001);
    expect(await f.manager.dispatch({ action: 'revoke', grant: second.grant })).toEqual({ status: 'unavailable' });
  });
  it("offers explicit recovery of a local review after its app owner closes", async () => {
    const f = await fixture(), before = await opened(f.manager, { pdfPath: f.pdfPath });
    const original = payload(await f.manager.handle(request(before.presentation, 'watermark')));
    await f.manager.revoke(before.grant);
    const offer = await f.manager.open({ pdfPath: f.pdfPath });
    expect(offer).toMatchObject({ status: 'busy', canResume: true });
    if (offer.status !== 'busy') throw Error('Expected recovery choice');
    const chosen = await f.manager.choose({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'resume', operationId: randomUUID() });
    if (chosen.status !== 'provisional') throw Error('Expected provisional');
    const after = active(await f.manager.resume(chosen.grant, randomUUID(), 'activate'));
    expect(payload(await f.manager.handle(request(after.presentation, 'watermark'))).sessionId).toBe(original.sessionId);
    expect(await f.manager.handle(request(before.presentation, 'bootstrap'))).toMatchObject({ status: 'denied' });
  });
  it("rejects a stale local recovery choice once another app resumes", async () => {
    const f = await fixture(), before = await opened(f.manager, { pdfPath: f.pdfPath });
    await f.manager.revoke(before.grant);
    const first = await f.manager.open({ pdfPath: f.pdfPath });
    const second = await f.manager.open({ pdfPath: f.pdfPath });
    if (first.status !== 'busy' || second.status !== 'busy') throw Error('Expected recovery choices');
    expect(first.canResume && second.canResume).toBe(true);
    const chosen = await f.manager.choose({ action: 'choose', recoveryToken: first.recoveryToken, choice: 'resume', operationId: randomUUID() });
    expect(chosen.status).toBe('provisional');
    expect(await f.manager.choose({ action: 'choose', recoveryToken: second.recoveryToken, choice: 'resume', operationId: randomUUID() })).toEqual({ status: 'unavailable' });
    expect(await f.manager.open({ pdfPath: f.pdfPath })).toMatchObject({ status: 'busy', canResume: false });
  });
  it("does not create an ownerless review when a recovery path is retargeted", async () => {
    const f = await fixture();
    const alias = `${f.pdfPath}.link.pdf`, other = `${f.pdfPath}.other.pdf`;
    await symlink(f.pdfPath, alias);
    await writeFile(other, "%PDF-1.7\nother source\n%%EOF");
    const before = await opened(f.manager, { pdfPath: alias });
    await f.manager.revoke(before.grant);
    const offer = await f.manager.open({ pdfPath: alias });
    if (offer.status !== 'busy' || !offer.canResume) throw Error('Expected recovery');
    await unlink(alias);
    await symlink(other, alias);
    expect(await f.manager.dispatch({ action: 'recheck', recoveryToken: offer.recoveryToken })).toEqual({ status: 'unavailable' });
    expect(await f.manager.choose({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'resume', operationId: randomUUID() })).toEqual({ status: 'unavailable' });
    expect(await f.manager.open({ pdfPath: other })).toMatchObject({ status: 'provisional' });
  });
  it("explicit close revokes resumption while idle grant expiry releases suspended records", async () => {
    const f = await fixture(), a = await opened(f.manager, { pdfPath: f.pdfPath });
    expect(await f.manager.revoke(a.grant)).toBe(true);
    expect(await f.manager.resume(a.grant, randomUUID())).toEqual({ status: "unavailable" });
    expect(await f.manager.handle(request(a.presentation, "bootstrap"))).toMatchObject({ status: "denied" });
    const secondPath = join(f.pdfPath, "..", "second.pdf");
    await writeFile(secondPath, "%PDF-1.7\nother source\n%%EOF");
    const b = await opened(f.manager, { pdfPath: secondPath });
    f.advance(1001);
    expect(await f.manager.resume(b.grant, randomUUID())).toEqual({ status: "unavailable" });
    expect(f.manager.activityCount()).toBe(0);
  });

  it("reopening without a grant requires an explicit independent review choice", async () => {
    const f = await fixture(), a = await opened(f.manager, { pdfPath: f.pdfPath });
    const busy = await f.manager.open({ pdfPath: f.pdfPath });
    if (busy.status !== "busy") throw new Error("Expected busy");
    expect(await f.manager.choose({ action: "choose", recoveryToken: busy.recoveryToken, choice: "resume", operationId: randomUUID() })).toEqual({ status: "unavailable" });
    const chosen = await f.manager.choose({ action: "choose", recoveryToken: busy.recoveryToken, choice: "fork", operationId: randomUUID() });
    if (chosen.status !== "provisional") throw Error("Expected provisional");
    const b = active(await f.manager.resume(chosen.grant, randomUUID(), "activate"));
    const stateA = payload(await f.manager.handle(request(a.presentation, "watermark")));
    const stateB = payload(await f.manager.handle(request(b.presentation, "watermark")));
    expect(stateB.sessionId).not.toBe(stateA.sessionId);
  });
  it("rejects a delayed recovery choice without reopening its source or allocating authority", async () => {
    const f = await fixture();
    await opened(f.manager, { pdfPath: f.pdfPath });
    const busy = await f.manager.open({ pdfPath: f.pdfPath });
    if (busy.status !== "busy") throw Error("Expected busy");
    const reopen = vi.spyOn(f.broker, "openReview");
    f.advance(95_000);
    expect(await f.manager.dispatch({ action: "recheck", recoveryToken: busy.recoveryToken })).toEqual({ status: "unavailable" });
    expect(await f.manager.choose({ action: "choose", recoveryToken: busy.recoveryToken, choice: "fork", operationId: randomUUID() })).toEqual({ status: "unavailable" });
    expect(reopen).not.toHaveBeenCalled();
    expect(f.manager.activityCount()).toBe(0);
    const fresh = await f.manager.open({ pdfPath: f.pdfPath });
    expect(fresh.status).toBe("busy");
    if (fresh.status !== "busy") throw Error("Expected fresh choice");
    expect(fresh.recoveryToken).not.toBe(busy.recoveryToken);
    expect(await f.manager.choose({ action: "choose", recoveryToken: fresh.recoveryToken, choice: "fork", operationId: randomUUID() })).toMatchObject({ status: "provisional" });
  });

  it.each(['activate', 'resume'] as const)("revokes a pending %s whose rotated grant is still current", async action => {
    const f = await fixture();
    const previous = action === 'activate'
      ? await f.manager.open({ pdfPath: f.pdfPath })
      : await opened(f.manager, { pdfPath: f.pdfPath });
    if (!('grant' in previous)) throw Error('Expected grant');
    const operationId = randomUUID();
    const result = active(await f.manager.resume(previous.grant, operationId, action));
    const revoke = { action: 'revoke', grant: previous.grant, operationId };
    expect(await f.manager.dispatch({ ...revoke, operationId: randomUUID() })).toEqual({ status: 'unavailable' });
    expect(await f.manager.dispatch({ action: 'revoke', grant: previous.grant })).toEqual({ status: 'unavailable' });
    expect(f.manager.activityCount()).toBe(1);
    expect(await f.manager.dispatch(revoke)).toEqual({ status: 'closed' });
    expect(await f.manager.handle(request(result.presentation, 'bootstrap'))).toMatchObject({ status: 'denied' });
    const offer = await f.manager.open({ pdfPath: f.pdfPath });
    if (offer.status !== 'busy') throw Error('Expected resume offer');
    const chosen = await f.manager.choose({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'resume', operationId: randomUUID() });
    if (chosen.status !== 'provisional') throw Error('Expected grant');
    const next = active(await f.manager.resume(chosen.grant, randomUUID(), 'activate'));
    expect(await f.manager.dispatch(revoke)).toEqual({ status: 'closed' });
    expect(await f.manager.dispatch({ ...revoke, operationId: randomUUID() })).toEqual({ status: 'unavailable' });
    expect((await f.manager.handle(request(next.presentation, 'renew'))).status).toBe('ok');
  });

  it("revokes a pending rotation after a document generation change suspends its presentation", async () => {
    const f = await fixture(), previous = await opened(f.manager, { pdfPath: f.pdfPath });
    const original = payload(await f.manager.handle(request(previous.presentation, 'bootstrap')));
    const operationId = randomUUID();
    const rotated = active(await f.manager.resume(previous.grant, operationId));
    await writeFile(f.pdfPath, "%PDF-1.7\nnew extension source generation\n%%EOF");
    await f.broker.observeLiveDocumentHint({ sessionId: original.sessionId, outputPath: f.pdfPath, hostReason: 'activation' });
    // A filesystem watcher may supersede the explicit observation before it completes.
    await vi.waitFor(() => expect(f.broker.nativeAdmissionScope(original.sessionId)?.documentGeneration).toBe(2));
    expect(f.manager.activityCount()).toBe(0);
    expect(await f.manager.resume(previous.grant, operationId)).toEqual({ status: 'unavailable' });
    expect(await f.manager.dispatch({ action: 'revoke', grant: previous.grant, operationId })).toEqual({ status: 'closed' });
    expect(await f.manager.resume(rotated.grant, randomUUID())).toEqual({ status: 'unavailable' });
  });

  it("does not revoke a grant after a later rotation supersedes the pending operation", async () => {
    const f = await fixture(), first = await opened(f.manager, { pdfPath: f.pdfPath });
    const operationId = randomUUID();
    const second = active(await f.manager.resume(first.grant, operationId));
    const third = active(await f.manager.resume(second.grant, randomUUID()));
    expect(await f.manager.dispatch({ action: 'revoke', grant: first.grant, operationId })).toEqual({ status: 'unavailable' });
    expect((await f.manager.handle(request(third.presentation, 'renew'))).status).toBe('ok');
  });

  it("replays a lost activation response but rejects competing reuse and retired presentations", async () => {
    const f=await fixture(), provisional=await f.manager.open({pdfPath:f.pdfPath});
    if(provisional.status!=='provisional')throw Error('Expected provisional');
    expect(f.manager.activityCount()).toBe(0);
    const operationId=randomUUID();
    const a=active(await f.manager.resume(provisional.grant,operationId,'activate'));
    expect(await f.manager.resume(provisional.grant,operationId,'activate')).toEqual(a);
    expect(await f.manager.resume(provisional.grant,randomUUID(),'activate')).toEqual({status:'unavailable'});
    const b=active(await f.manager.resume(a.grant,randomUUID()));
    expect(await f.manager.handle(request(a.presentation,'watermark'))).toMatchObject({status:'denied'});
    expect(payload(await f.manager.handle(request(b.presentation,'watermark'))).sessionId).toBeDefined();
    expect(await f.manager.resume(provisional.grant,operationId,'activate')).toEqual({status:'unavailable'});
  });

  it("expires unactivated grants without allocating presentation authority",async()=>{
    const f=await fixture();
    const provisional=await f.manager.open({pdfPath:f.pdfPath});
    if(provisional.status!=='provisional')throw Error('Expected provisional');
    f.advance(1001);
    expect(await f.manager.resume(provisional.grant,randomUUID(),'activate')).toEqual({status:'unavailable'});
    expect(f.backend.retentionStatus().presentations).toBe(0);
  });

});

it('keeps context publication intent with its app grant across rotation and isolates fresh invocations', async () => {
  const f = await fixture(), first = await opened(f.manager, { pdfPath: f.pdfPath });
  expect(first.contextPublished).toBe(false);
  expect(await f.manager.dispatch({ action: 'context-published', grant: first.grant })).toEqual({ status: 'context-ready' });
  const resumed = active(await f.manager.resume(first.grant, randomUUID()));
  expect(resumed.contextPublished).toBe(true);
  expect(await f.manager.dispatch({ action: 'context-published', grant: first.grant })).toEqual({ status: 'unavailable' });
  const otherPath = join(f.pdfPath, '..', 'other.pdf'); await writeFile(otherPath, '%PDF-1.7\nother\n%%EOF');
  const other = await opened(f.manager, { pdfPath: otherPath }); expect(other.contextPublished).toBe(false);
});

it('rejects retired settings and mention requests even with a live grant', async () => {
  const f = await fixture(), panel = await opened(f.manager, { pdfPath: f.pdfPath });
  for (const request of [
    { action: 'settings-read' },
    { action: 'settings-update', set: { mentions: true } },
    { action: 'catalogue', grant: panel.grant, operation: 'capture' },
    { action: 'mention-search', query: '' },
    { action: 'mention-read', uri: 'placekeeper-mention://' + 'a'.repeat(32) },
  ]) expect(await f.manager.dispatch(request)).toEqual({ status: 'unavailable' });
});
