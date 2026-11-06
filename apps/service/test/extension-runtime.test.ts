import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  return { broker, backend, manager, pdfPath, advance(ms: number) { time += ms; } };
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
    expect(await f.manager.choose({ action: "choose", recoveryToken: busy.recoveryToken, choice: "fork", operationId: randomUUID() })).toEqual({ status: "unavailable" });
    expect(reopen).not.toHaveBeenCalled();
    expect(f.manager.activityCount()).toBe(0);
    const fresh = await f.manager.open({ pdfPath: f.pdfPath });
    expect(fresh.status).toBe("busy");
    if (fresh.status !== "busy") throw Error("Expected fresh choice");
    expect(fresh.recoveryToken).not.toBe(busy.recoveryToken);
    expect(await f.manager.choose({ action: "choose", recoveryToken: fresh.recoveryToken, choice: "fork", operationId: randomUUID() })).toMatchObject({ status: "provisional" });
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

it('catalogues only an explicit active grant and exposes snapshots without review authority',async()=>{
 const f=await fixture();
 expect(await f.manager.dispatch({action:'mention-search',query:''})).toEqual({status:'mention-results',items:[]});
 const a=await opened(f.manager,{pdfPath:f.pdfPath});
 expect(await f.manager.dispatch({action:'catalogue',grant:a.grant,operation:'capture'})).toEqual({status:'unavailable'});
 expect(await f.manager.dispatch({action:'settings-update',set:{mentions:true}})).toMatchObject({status:'settings',revision:1});
 expect(await f.manager.dispatch({action:'catalogue',grant:'x'.repeat(43),operation:'capture'})).toEqual({status:'unavailable'});
 expect(await f.manager.dispatch({action:'catalogue',grant:a.grant,operation:'capture'})).toMatchObject({status:'catalogue',included:true,snapshot:{generation:1,revision:0}});
 const results=await f.manager.dispatch({action:'mention-search',query:'next'});
 if(results.status!=='mention-results')throw Error('Expected mentions');
 expect(results.items).toHaveLength(1);const uri=results.items[0]!.resourceUri;
 const resource=await f.manager.dispatch({action:'mention-read',uri});
 expect(resource.status).toBe('mention-resource');
 const text=JSON.stringify(resource);expect(text).toContain('untrusted-document-snapshot');expect(text).toContain('[Page 1]');
 for(const privateValue of [f.pdfPath,a.grant,a.presentation.presentationCapability,a.presentation.runtimeId])expect(text).not.toContain(privateValue);
 expect(await f.manager.resume(uri,randomUUID())).toEqual({status:'unavailable'});
 expect(f.broker.taskBindings.activityCount()).toBe(0);
 await f.manager.dispatch({action:'catalogue',grant:a.grant,operation:'remove'});
 expect(await f.manager.dispatch({action:'mention-read',uri})).toEqual({status:'unavailable'});
});

it('rejects capture when the app grant retires during document extraction',async()=>{
 const f=await fixture(),a=await opened(f.manager,{pdfPath:f.pdfPath});
 await f.manager.dispatch({action:'settings-update',set:{mentions:true}});
 let release!:(value:string)=>void;const delayed=new Promise<string>(resolve=>{release=resolve});
 let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
 vi.spyOn(f.broker,'documentSnapshotSummary').mockImplementation(async()=>{entered();return delayed;});
 const capture=f.manager.dispatch({action:'catalogue',grant:a.grant,operation:'capture'});
 await started;
 await f.manager.handle(request(a.presentation,'detach'));
 release('snapshot text');
 expect(await capture).toEqual({status:'unavailable'});
 expect(await f.manager.dispatch({action:'mention-search',query:''})).toEqual({status:'mention-results',items:[]});
});
