import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { createEmbedPdfWriter } from "../../../packages/pdf-backends/src/embedpdf-adapter.js";
import { reviewStateDigest } from "../src/recovery/draft-snapshot.js";
import { prepareReplacementReview } from "../src/sessions/document-replacement-preparation.js";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
async function fixture(realNative = false) {
  const root = await mkdtemp(join(tmpdir(), "native-backend-"));
  const pdfPath = join(root, "paper.pdf");
  if (realNative) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 500]);
    const annotation = pdf.context.obj({ Type: PDFName.of("Annot"), Subtype: PDFName.of("Highlight"),
      Rect: [10, 20, 100, 40], QuadPoints: [10, 40, 100, 40, 10, 20, 100, 20], Contents: PDFString.of("original comment") });
    page.node.set(PDFName.of("Annots"), pdf.context.obj([pdf.context.register(annotation)]));
    await writeFile(pdfPath, await pdf.save());
  } else await writeFile(pdfPath, "%PDF-1.7\nnative resource\n%%EOF");
  const assets = join(root, "assets"); await mkdir(assets);
  await writeFile(join(assets, "pdfium.wasm"), "engine");
  await writeFile(join(assets, "pdfium-codex-worker.js"), "worker");
  const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), ...(!realNative ? { portableReader: async () => [],
    inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "next" }] }) } : {}) });
  const nativeWriter = realNative ? await createEmbedPdfWriter() : undefined;
  const beforeWrite = vi.fn(async () => {});
  const writer = {
    assess: async (bytes: Uint8Array) => nativeWriter?.assess === undefined ? { eligible: true as const } : nativeWriter.assess(bytes),
    write: vi.fn(async (input: import("../../../packages/core/src/pdf-writer.js").PdfWriteRequest): Promise<import("../../../packages/core/src/pdf-writer.js").PdfWriteResult> => {
      await beforeWrite();
      if (nativeWriter !== undefined) return nativeWriter.write(input);
      const pdfBytes = new TextEncoder().encode(`%PDF-1.7\nitems:${input.annotations.map(item => item.id).join(",")}\n%%EOF`);
      return { pdfBytes, evidence: { backend: "embedpdf" as const, backendVersion: "test", originalSha256: input.sourceSha256,
        outputSha256: createHash("sha256").update(pdfBytes).digest("hex"), pageCount: 1, structurallyValid: true,
        preexistingAnnotationIds: [], annotations: input.annotations.map(item => ({ id: item.id, subtype: "highlight" as const,
          contents: item.contents, author: item.author, flags: ["print" as const], hasNormalAppearance: true })) } };
    }),
  };
  const picker = { chooseFolder: vi.fn(async (): Promise<string | undefined> => root), locatePdf: vi.fn(async (): Promise<string | undefined> => undefined) };
  const saving = new PdfSaveCoordinator({ broker, writer, picker, ...(!realNative ? { verify: async ({ annotations }: { annotations: readonly {id:string}[] }) => ({ pageCount: 1, annotationIds: annotations.map(item => item.id) }) } : {}) });
  const beforeExportCommit = vi.fn(async () => {});
  const exporting = new ExportCoordinator({ writer, capabilities: broker.capabilities, controls: broker.controls,
    verify: async ({ annotations }) => ({ pageCount: 1, annotationIds: annotations.map(item => item.id) }),
    hooks: { beforeFinalize: beforeExportCommit } });
  const backend = new CodexServiceRuntimeBackend({ broker, saving, exporting, assetRoot: assets });
  let time = 1000;
  const manager = new CodexRuntimeManager(broker, { backend, now: () => new Date(time), panelLeaseMs: 100 });
  cleanups.push(async () => { await manager.close(); await saving.drain(); await broker.quiesceForShutdown(); await rm(root, { recursive: true, force: true }); });
  const opened = await broker.openReview({ pdfPath, surface: "codex-native",  });
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
  return { root, broker, manager, backend, saving, sessionId, pdfPath, exporting, picker, panel, writer, beforeWrite, beforeExportCommit, advance(ms: number) { time += ms; } };
}
function request(active: Extract<CodexAppResponse, { status: "active" }>, method: CodexAppRequest["method"], payload = {}, requestId = "request_1234") {
  return { protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation,
    capability: active.presentationCapability, authority: "presentation", requestId, method, payload };
}
function payload(result: CodexAppResponse): any { expect(result.status).toBe("ok"); return result.status === "ok" ? result.payload : undefined; }


function add(revision: number) {
  return { type: "add", expectedRevision: revision, item: { id: randomUUID(), kind: "highlight", pageIndex: 0,
    createdAt: "2026-10-05T12:00:00Z", updatedAt: "2026-10-05T12:00:00Z", payload: {
      quote: "native resource", prefix: "", suffix: "", rect: { x: 1, y: 1, width: 2, height: 2 },
      segmentRects: [{ x: 1, y: 1, width: 2, height: 2 }], reliable: true, comment: "recoverable note" } } };
}

describe("native persistence composition", () => {
  it("accepts recoverable edits without awaiting an older write and saves the latest revision", async () => {
    const f = await fixture(), a = await f.panel();
    payload(await f.manager.handle(request(a, "chooseCopy", { filename: "reviewed.pdf" }, "choose_copy")));
    await f.saving.drain();
    const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
    f.beforeWrite.mockImplementationOnce(async () => { reached.resolve(); await gate.promise; });
    const first = add(0);
    const command = request(a, "command", first, "accepted_first");
    expect(payload(await f.manager.handle(command)).revision).toBe(1);
    await reached.promise;
    expect(payload(await f.manager.handle(command)).revision).toBe(1);
    expect(payload(await f.manager.handle(request(a, "command", add(1), "accepted_second"))).revision).toBe(2);
    expect(payload(await f.manager.handle(request(a, "saveStatus"))).sync).toMatchObject({ phase: "saving", desiredRevision: 2, savedRevision: 0 });
    expect(f.broker.state(f.sessionId)?.items).toHaveLength(2);
    gate.resolve(); await f.saving.drain();
    expect(payload(await f.manager.handle(request(a, "saveStatus"))).sync).toMatchObject({ phase: "clean", desiredRevision: 2, savedRevision: 2 });
    expect(await readFile(join(f.root, "reviewed.pdf"), "utf8")).toContain(first.item.id);
    expect(await readFile(f.pdfPath, "utf8")).toContain("native resource");
    // One initial copy, one older write, one coalesced successor: replay did not schedule another.
    expect(f.writer.write).toHaveBeenCalledTimes(3);
  });

  it("retains failed accepted work on detach and reports truthful retry in a fresh panel", async () => {
    const f = await fixture(), a = await f.panel();
    payload(await f.manager.handle(request(a, "chooseCopy", { filename: "reviewed.pdf" }, "choose_copy")));
    await f.saving.drain();
    f.beforeWrite.mockRejectedValueOnce(new Error("disk unavailable"));
    const command = add(0);
    payload(await f.manager.handle(request(a, "command", command, "failed_write_edit")));
    await f.saving.drain();
    expect(payload(await f.manager.handle(request(a, "saveStatus"))).sync).toMatchObject({ phase: "not-saved", desiredRevision: 1, savedRevision: 0 });
    await f.manager.detach(a.runtimeId);
    const b = await f.panel();
    const reopened = payload(await f.manager.handle(request(b, "bootstrap")));
    expect(reopened.state.items[0].id).toBe(command.item.id);
    expect(reopened.saveStatus.sync).toMatchObject({ phase: "not-saved", desiredRevision: 1, savedRevision: 0 });
    payload(await f.manager.handle(request(b, "retrySave", {}, "retry_write")));
    expect(payload(await f.manager.handle(request(b, "saveStatus"))).sync).toMatchObject({ phase: "clean", savedRevision: 1 });
  });

  it("cancels the native folder dialog without choosing a destination or reporting completion", async () => {
    const f = await fixture(), a = await f.panel();
    const before = f.broker.saveStatus(f.sessionId);
    f.picker.chooseFolder.mockResolvedValue(undefined);
    payload(await f.manager.handle(request(a, "chooseFolder", {}, "cancel_folder")));
    expect(f.broker.saveStatus(f.sessionId)).toEqual(before);
    expect(f.writer.write).not.toHaveBeenCalled();
  });

  it("does not publish or report a native export cancelled at the actual coordinator commit boundary", async () => {
    const f = await fixture(), a = await f.panel();
    payload(await f.manager.handle(request(a, "command", add(0), "export_feedback")));
    const before = f.broker.saveStatus(f.sessionId);
    const original = await readFile(f.pdfPath);
    f.beforeExportCommit.mockImplementationOnce(async () => { f.broker.controls.cancel(f.sessionId); });
    expect(await f.manager.handle(request(a, "exportReviewedCopy", {}, "cancelled_native_export"))).toMatchObject({ status: "denied" });
    expect(f.beforeExportCommit).toHaveBeenCalledOnce();
    expect(f.writer.write).toHaveBeenCalledOnce();
    expect((await readdir(f.root)).filter(name => name.endsWith(".pdf"))).toEqual(["paper.pdf"]);
    expect(await readFile(f.pdfPath)).toEqual(original);
    expect(f.broker.saveStatus(f.sessionId)).toEqual(before);
  });


  it.each([false, true])("carries verified original-save identity across edits and restart before first rewrite=%s", async (restartFirst) => {
    const f = await fixture(true), a = await f.panel();
    const initial = f.broker.state(f.sessionId)!;
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]!.payload.identityProvenance).toBe("generation-ordinal");
    const beforeDigest = reviewStateDigest(initial);
    payload(await f.manager.handle(request(a, "chooseOriginal", {}, "save_original_native")));
    await f.saving.drain();
    expect(f.broker.saveStatus(f.sessionId)?.sync.phase).toBe("clean");
    expect(f.broker.state(f.sessionId)?.revision).toBe(initial.revision);
    expect(reviewStateDigest(f.broker.state(f.sessionId)!)).toBe(beforeDigest);
    payload(await f.manager.handle(request(a, "command", { type: "edit", expectedRevision: initial.revision, id: initial.items[0]!.id, updatedAt: "2026-10-05T12:00:00Z", payload: { comment: "intervening comment" } }, "intervening_edit")));
    await f.saving.drain();
    // Undo history is unchanged by save evidence, and cannot erase its proof.
    payload(await f.manager.handle(request(a, "command", { type: "undo", expectedRevision: f.broker.state(f.sessionId)!.revision }, "undo_after_save")));
    await f.saving.drain();
    const durable = JSON.parse(await readFile(join(f.broker.recoveryRoot, f.sessionId, "draft.json"), "utf8")).payload;
    expect(durable.nativeAnnotationLedger.managed[0].provenance).toBe("verified");
    const saved = await readFile(f.pdfPath);
    const pdf = await PDFDocument.load(saved);
    const name = pdf.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).lookup(0, PDFDict).lookup(PDFName.of("NM"), PDFString).decodeText();
    expect(name).toBe(`placekeeper-native:v1:${initial.items[0]!.id}`);
    if (!restartFirst) {
      pdf.addPage([400, 500]); await writeFile(f.pdfPath, await pdf.save());
      expect(await f.broker.replaceLiveDocument({ sessionId: f.sessionId, outputPath: f.pdfPath, observationEpoch: 1 })).toMatchObject({ status: "committed" });
      expect(f.broker.state(f.sessionId)?.items).toHaveLength(1);
      expect(f.broker.state(f.sessionId)?.items[0]).toMatchObject({ id: initial.items[0]!.id, payload: { identityProvenance: "verified", comment: "original comment" } });
      await f.saving.requestSave(f.sessionId);
      expect(f.broker.saveStatus(f.sessionId)?.sync.phase).toBe("clean");
    }
    await f.manager.close(); await f.broker.quiesceForShutdown();
    const broker = new SessionBroker({ recoveryRoot: f.broker.recoveryRoot });
    await broker.initialize();
    cleanups.unshift(async () => { await broker.quiesceForShutdown(); });
    const offer = await broker.openReview({ pdfPath: f.pdfPath, surface: "codex-native" });
    if (offer.kind !== "recovery-offered") throw new Error("Expected durable review recovery");
    const resumed = await broker.openReview({ pdfPath: f.pdfPath, surface: "codex-native", recoveryDecision: "resume", recoveryOffer: offer.recoveryOffer, recoveryOperationId: "resume_identity_proof" });
    if (resumed.kind === "recovery-offered") throw new Error("Recovery did not resume");
    const resumedId = resumed.launch.sessionId;
    const restoredPdf = await PDFDocument.load(await readFile(f.pdfPath));
    restoredPdf.addPage([400, 500]); await writeFile(f.pdfPath, await restoredPdf.save());
    expect(await broker.replaceLiveDocument({ sessionId: resumedId, outputPath: f.pdfPath, observationEpoch: 1 })).toMatchObject({ status: "committed" });
    expect(broker.state(resumedId)?.items).toHaveLength(1);
    expect(broker.state(resumedId)?.items[0]).toMatchObject({ id: initial.items[0]!.id, payload: { identityProvenance: "verified" } });
    const coordinator = new PdfSaveCoordinator({ broker, writer: f.writer });
    await coordinator.requestSave(resumedId);
    expect(broker.saveStatus(resumedId)?.sync.phase).toBe("clean");
  });

  it.each(["copy", "failed"] as const)("does not grant original identity proof after a %s save", async (kind) => {
    const f = await fixture(true), a = await f.panel();
    const before = f.broker.state(f.sessionId)!;
    if (kind === "failed") f.beforeWrite.mockRejectedValueOnce(new Error("writer failed"));
    payload(await f.manager.handle(request(a, kind === "copy" ? "chooseCopy" : "chooseOriginal", kind === "copy" ? {filename:"copy.pdf"} : {}, "unproven_save")));
    await f.saving.drain();
    const durable = JSON.parse(await readFile(join(f.broker.recoveryRoot, f.sessionId, "draft.json"), "utf8")).payload;
    expect(durable.nativeAnnotationLedger.managed[0].provenance).toBe("generation-ordinal");
    const item = before.items[0]!;
    // A matching name alone is not evidence that an ordinal source was saved.
    const successor = { ...item, payload: { ...item.payload, identityProvenance: "verified" } };
    const state = prepareReplacementReview(before, 2, before.source.fileId, before.source, [], [successor]);
    expect(state.items).toHaveLength(2);
    expect(state.items[0]!.id).toBe(item.id);
    expect(state.items[1]!.id).not.toBe(item.id);
  });


  it.each(["unpublished", "superseded", "uncertain"] as const)("does not promote native identity for %s save publication", async (status) => {
    const f = await fixture(true), state = f.broker.state(f.sessionId)!;
    await f.broker.settlePhysicalSaveBarrier(f.sessionId);
    await f.broker.establishSaveDestination(f.sessionId, { kind: "original", targetPath: f.pdfPath,
      capabilityId: state.source.fileId, fingerprint: state.source.digest });
    const destination = f.broker.saveStatus(f.sessionId)!.destination;
    let settle: "superseded" | "uncertain" = status === "uncertain" ? "uncertain" : "superseded";
    const result = await f.broker.commitSaveCandidate({ sessionId: f.sessionId, generation: destination.generation,
      documentGeneration: state.workflow.documentGeneration, sourceDigest: state.source.digest,
      revision: state.revision, stateDigest: reviewStateDigest(state), targetDigest: state.source.digest,
      verifiedNativeAnnotationIds: [state.items[0]!.id],
      commit: async () => status === "unpublished" ? undefined : { targetDigest: state.source.digest, settle: async () => settle },
    });
    expect(result).toBe(status === "unpublished" ? "generation-stale" : status === "uncertain" ? "commit-pending" : "target-superseded");
    if (status === "uncertain") { settle = "superseded"; await f.broker.settlePhysicalSaveBarrier(f.sessionId); }
    const durable = JSON.parse(await readFile(join(f.broker.recoveryRoot, f.sessionId, "draft.json"), "utf8")).payload;
    expect(durable.nativeAnnotationLedger.managed[0].provenance).toBe("generation-ordinal");
    expect(f.broker.state(f.sessionId)?.items[0]!.payload.identityProvenance).toBe("generation-ordinal");
    expect(f.writer.write).not.toHaveBeenCalled();
  });

});
