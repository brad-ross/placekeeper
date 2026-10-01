import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexPendingPresentation, CodexAppResponse } from "../../../packages/core/src/codex-mcp-protocol.js";
import { CodexRuntimeManager } from "../src/codex/codex-runtime.js";
import { SessionBroker } from "../src/sessions/session-broker.js";
import { TaskBindingRegistry } from "../src/context/task-binding-registry.js";

const roots: string[] = [];
const brokers: SessionBroker[] = [];
const managers: CodexRuntimeManager[] = [];
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.dispose());
  await Promise.all(brokers.splice(0).map((broker) => broker.quiesceForShutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(generated = false) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-native-")); roots.push(root);
  const pdf = join(root, "paper.pdf"); await writeFile(pdf, "%PDF-1.7\nnative authority fixture\n%%EOF");
  let time = 1000;
  const now = () => new Date(time);
  const build = () => {
    const broker = new SessionBroker({ recoveryRoot: join(root, "recovery"), now, portableReader: async () => [],
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "successor" }] }),
      taskBindings: new TaskBindingRegistry({ now, pendingTtlMs: 100, activeLeaseTtlMs: 1000 }) });
    brokers.push(broker);
    const manager = new CodexRuntimeManager(broker, { now, pendingTtlMs: 100 }); managers.push(manager);
    return { broker, manager };
  };
  const initial = build();
  const opened = await initial.broker.openReview({ pdfPath: pdf, ...(generated ? { workflowMode: "generated-output" as const } : {}) });
  if (opened.kind !== "opened") throw new Error("Expected opened");
  return { ...initial, pdf, sessionId: opened.launch.sessionId, build, advance(ms: number) { time += ms; } };
}
function request(meta: CodexPendingPresentation, method: "ready" | "status" = "ready") {
  return { protocolVersion: 1, runtimeId: meta.runtimeId, attemptId: meta.attemptId, requestId: "request_1234",
    generation: meta.generation, capability: meta.pendingCapability, authority: "pending", method, payload: {} };
}
function activeRequest(active: Extract<CodexAppResponse, { status: "active" }>) {
  return { ...request({ ...active, receiptId: "unused123", pendingCapability: active.presentationCapability, protocolVersion: 1 }), authority: "presentation", method: "watermark" };
}
function stage(manager: CodexRuntimeManager, sessionId: string, task = "task-a") {
  const launch = manager.stageLaunch({ sessionId, kind: "opened" })!;
  expect(manager.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: launch.sessionId, documentGeneration: launch.documentGeneration, taskSessionId: task })).toBe(true);
  return { launch, ...manager.display(launch.handoff.token)! };
}
async function activate(manager: CodexRuntimeManager, sessionId: string) {
  const panel = stage(manager, sessionId);
  expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(true);
  const active = await manager.pending(request(panel.privateMeta));
  if (active.status !== "active") throw new Error("Expected active");
  return { ...panel, active };
}
async function protectWork(broker: SessionBroker, sessionId: string) {
  const timestamp = new Date().toISOString();
  await broker.acceptMutation(sessionId, { type: "add", expectedRevision: 0, item: {
    id: randomUUID(), kind: "highlight", pageIndex: 0, createdAt: timestamp, updatedAt: timestamp,
    payload: { quote: "remember", prefix: "", suffix: "", rect: { x: 72, y: 92, width: 80, height: 14 },
      segmentRects: [{ x: 72, y: 92, width: 80, height: 14 }], reliable: true, comment: "protected" },
  } });
}
function reconnect(active: Extract<CodexAppResponse, { status: "active" }>) {
  return { ...activeRequest(active), authority: "reconnect", method: "reconnect", capability: active.reconnectTicket };
}

describe("native two-hook admission with real broker authority", () => {
  it.each(["ready-first", "hook-first"])("requires every panel's hooks and readiness, %s", async (order) => {
    const { broker, manager, sessionId } = await fixture();
    for (let index = 0; index < 2; index++) {
      const panel = stage(manager, sessionId);
      expect(manager.resolveActive({ ...request(panel.privateMeta), authority: "presentation", method: "watermark", capability: panel.receipt.receiptId })).toBeUndefined();
      if (order === "ready-first") {
        expect(await manager.pending(request(panel.privateMeta))).toEqual({ status: "pending" });
        expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(true);
      } else {
        expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(true);
        expect(await manager.pending(request(panel.privateMeta, "status"))).toEqual({ status: "pending" });
      }
      expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(false);
      const active = await manager.pending(request(panel.privateMeta));
      expect(active.status).toBe("active");
      if (active.status === "active") expect(manager.resolveActive(activeRequest(active))).toMatchObject({ sessionId, taskSessionId: "task-a" });
    }
    expect(broker.taskBindings.bindingForTask("task-a")?.reviewSessionId).toBe(sessionId);
  });

  it("rejects wrong hooks, launch/display replays and ownership conflicts", async () => {
    const { manager, broker, sessionId, pdf } = await fixture();
    const launch = manager.stageLaunch({ sessionId, kind: "opened" })!;
    expect(manager.display(launch.handoff.token)).toBeUndefined();
    const claim = { bindProof: launch.bindProof, reviewSessionId: sessionId, documentGeneration: 1, taskSessionId: "task-a" };
    expect(manager.claimLaunch(claim)).toBe(true); expect(manager.claimLaunch(claim)).toBe(false);
    const panel = manager.display(launch.handoff.token)!;
    expect(manager.display(launch.handoff.token)).toBeUndefined();
    expect(manager.attestDisplay(panel.receipt, "task-b")).toBe(false);
    expect(await manager.pending(request(panel.privateMeta))).toEqual({ status: "pending" });
    const foreign = manager.stageLaunch({ sessionId, kind: "focused" })!;
    expect(manager.claimLaunch({ ...claim, bindProof: foreign.bindProof, taskSessionId: "task-b" })).toBe(false);
    const otherPdf = pdf.replace("paper", "other"); await writeFile(otherPdf, "%PDF-1.7\nother\n%%EOF");
    const other = await broker.openReview({ pdfPath: otherPdf }); if (other.kind !== "opened") throw new Error("Expected opened");
    const second = manager.stageLaunch({ sessionId: other.launch.sessionId, kind: "opened" })!;
    expect(manager.claimLaunch({ ...claim, bindProof: second.bindProof, reviewSessionId: second.sessionId })).toBe(false);
    expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(true);
    expect((await manager.pending(request(panel.privateMeta))).status).toBe("active");
  });

  it("expires admissions and rejects revoked, stale and wrong-attempt authority", async () => {
    const { manager, broker, sessionId, advance } = await fixture();
    const panel = stage(manager, sessionId); advance(100);
    expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(false);
    expect((await manager.pending(request(panel.privateMeta))).status).toBe("denied");
    const active = await activate(manager, sessionId);
    expect(manager.resolveActive({ ...activeRequest(active.active), attemptId: "wrong_attempt" })).toBeUndefined();
    broker.taskBindings.migrateGeneration({ reviewSessionId: sessionId, previousGeneration: 1, successorGeneration: 2 });
    expect(manager.resolveActive(activeRequest(active.active))).toBeUndefined();
    expect(manager.activityCount()).toBe(0);
  });

  it("cleans unclaimed launch proofs and claimed admissions on dispose", async () => {
    const { manager, broker, sessionId } = await fixture();
    manager.stageLaunch({ sessionId, kind: "opened" });
    const panel = stage(manager, sessionId);
    expect(broker.taskBindings.activityCount()).toBe(2);
    expect(broker.taskBindings.unavailableReasonForTask("task-a")).toBe("pending");
    manager.dispose();
    expect(manager.activityCount()).toBe(0);
    expect(broker.taskBindings.activityCount()).toBe(0);
    expect(manager.attestDisplay(panel.receipt, "task-a")).toBe(false);
    expect((await manager.pending(request(panel.privateMeta))).status).toBe("denied");
  });

  it("detaches one panel while keeping peer authority and durable work", async () => {
    const { manager, broker, sessionId } = await fixture();
    const one = await activate(manager, sessionId); const two = await activate(manager, sessionId);
    await manager.detach(one.active.runtimeId);
    expect(manager.resolveActive(activeRequest(one.active))).toBeUndefined();
    expect(manager.resolveActive(activeRequest(two.active))).toBeDefined();
    expect(broker.state(sessionId)).toBeDefined();
    await manager.revokeTask("task-a");
    expect(manager.resolveActive(activeRequest(two.active))).toBeUndefined();
  });

  it.each(["task-first", "panel-first"])("reconnects two independent panels after new broker, %s", async (order) => {
    const { manager, broker, sessionId, build, pdf } = await fixture();
    const one = await activate(manager, sessionId); const two = await activate(manager, sessionId);
    await protectWork(broker, sessionId); manager.dispose(); await broker.quiesceForShutdown();
    const next = build(); await next.broker.initialize();
    expect(await next.manager.stageReconnect(reconnect(one.active))).toEqual({ status: "denied", reason: "unavailable" });
    const offered = await next.broker.openReview({ pdfPath: pdf });
    const reopened = offered.kind === "recovery-offered" ? await next.broker.openReview({ pdfPath: pdf,
      recoveryDecision: "resume", recoveryOffer: offered.recoveryOffer, recoveryOperationId: randomUUID() }) : offered;
    if (reopened.kind !== "opened") throw new Error("Expected reopened");
    expect(reopened.launch.sessionId).toBe(sessionId);
    if (order === "task-first") await next.manager.trustedTaskPrompt("task-a");
    const first = await next.manager.stageReconnect(reconnect(one.active));
    const second = await next.manager.stageReconnect(reconnect(two.active));
    if (order === "panel-first") {
      expect(first.status).toBe("pending"); expect(second.status).toBe("pending");
      await next.manager.trustedTaskPrompt("task-b");
      expect(next.broker.taskBindings.bindingForTask("task-b")).toBeUndefined();
      await next.manager.trustedTaskPrompt("task-a");
    }
    for (const previous of [one, two]) {
      const refreshed = await next.manager.pending({ ...request(previous.privateMeta, "status"), capability: previous.active.reconnectTicket });
      expect(refreshed.status).toBe("active");
      if (refreshed.status === "active") expect(next.manager.resolveActive(activeRequest(refreshed))).toBeDefined();
      expect((await next.manager.stageReconnect(reconnect(previous.active))).status).toBe("denied");
    }
  });

  it("leaves a pristine deleted review ticket unavailable after same-source reapproval", async () => {
    const { manager, broker, sessionId, build, pdf } = await fixture();
    const panel = await activate(manager, sessionId); manager.dispose(); await broker.quiesceForShutdown();
    const next = build(); const opened = await next.broker.openReview({ pdfPath: pdf });
    if (opened.kind !== "opened") throw new Error("Expected fresh review");
    expect(opened.launch.sessionId).not.toBe(sessionId);
    await next.manager.trustedTaskPrompt("task-a");
    expect(await next.manager.stageReconnect(reconnect(panel.active))).toEqual({ status: "denied", reason: "unavailable" });
    expect(await next.broker.restartReconnects.matchNative({ ticket: panel.active.reconnectTicket, runtimeId: panel.active.runtimeId,
      attemptId: panel.active.attemptId, documentGeneration: panel.active.generation })).toBeDefined();
    expect((await activate(next.manager, opened.launch.sessionId)).active.status).toBe("active");
  });

  it("never selects a new fork with matching source bytes for an old restart ticket", async () => {
    const { manager, broker, sessionId, build, pdf } = await fixture();
    const panel = await activate(manager, sessionId); await protectWork(broker, sessionId);
    manager.dispose(); await broker.quiesceForShutdown();
    const next = build(); const offered = await next.broker.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const fork = await next.broker.openReview({ pdfPath: pdf, recoveryDecision: "fork", recoveryOffer: offered.recoveryOffer, recoveryOperationId: randomUUID() });
    if (fork.kind !== "opened") throw new Error("Expected fork");
    expect(fork.launch.sessionId).not.toBe(sessionId);
    await next.manager.trustedTaskPrompt("task-a");
    expect(await next.manager.stageReconnect(reconnect(panel.active))).toEqual({ status: "denied", reason: "unavailable" });
    expect(next.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
  });

  it.each(["detach", "dispose"])("%s of a staged reconnect preserves only the authorized continuation", async (action) => {
    const { manager, broker, sessionId, build, pdf } = await fixture();
    const panel = await activate(manager, sessionId);
    await protectWork(broker, sessionId);
    manager.dispose();
    await broker.quiesceForShutdown();

    const next = build();
    const offered = await next.broker.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    await next.broker.openReview({
      pdfPath: pdf,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    expect(await next.manager.stageReconnect(reconnect(panel.active))).toEqual({ status: "pending" });
    if (action === "detach") {
      await next.manager.detach(panel.active.runtimeId);
    }
    next.manager.dispose();

    const successor = new CodexRuntimeManager(next.broker, { now: () => new Date(1000) });
    managers.push(successor);
    await successor.trustedTaskPrompt("task-a");
    const result = await successor.stageReconnect(reconnect(panel.active));
    expect(result.status).toBe(action === "detach" ? "denied" : "active");
    if (action === "detach") {
      expect(next.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
    }
    expect(next.broker.state(sessionId)?.revision).toBe(1);
  });

  it.each(["task", "session", "generation", "stale-generation", "all"])("fences canonical %s revocation after ticket consumption", async (scope) => {
    const { manager, broker, sessionId } = await fixture();
    const panel = await activate(manager, sessionId);
    manager.dispose();
    const next = new CodexRuntimeManager(broker, { now: () => new Date(1000) });
    managers.push(next);
    expect(await next.stageReconnect(reconnect(panel.active))).toEqual({ status: "pending" });

    let reached!: () => void;
    let release!: () => void;
    const consumed = new Promise<void>((resolve) => { reached = resolve; });
    const continuation = new Promise<void>((resolve) => { release = resolve; });
    const consume = broker.restartReconnects.consumeForTask.bind(broker.restartReconnects);
    const spy = vi.spyOn(broker.restartReconnects, "consumeForTask").mockImplementation(async (...args) => {
      const result = await consume(...args);
      reached();
      await continuation;
      return result;
    });
    const promotion = next.trustedTaskPrompt("task-a");
    await consumed;
    expect(broker.taskBindings.activityCount()).toBe(1);
    if (scope === "task") await broker.revokeTask("task-a");
    if (scope === "session") broker.taskBindings.revokeSession(sessionId);
    if (scope === "generation") broker.taskBindings.migrateGeneration({ reviewSessionId: sessionId, previousGeneration: 1, successorGeneration: 2 });
    if (scope === "stale-generation") broker.taskBindings.revokeGeneration(sessionId, 2);
    if (scope === "all") broker.taskBindings.revokeAll();
    release();
    await promotion;
    spy.mockRestore();

    expect(broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
    expect(broker.taskBindings.activityCount()).toBe(0);
    expect((await next.pending({ ...request(panel.privateMeta, "status"), capability: panel.active.reconnectTicket })).status).toBe("denied");
  });

  it.each(["canonical-revoke", "dispose"])("fences %s after ticket issuance and releases in-flight checks", async (action) => {
    const { manager, broker, sessionId } = await fixture();
    const panel = await activate(manager, sessionId);
    expect(broker.taskBindings.activityCount()).toBe(1);
    manager.dispose();
    const next = new CodexRuntimeManager(broker, { now: () => new Date(1000) });
    managers.push(next);
    expect(await next.stageReconnect(reconnect(panel.active))).toEqual({ status: "pending" });
    let reached!: () => void;
    let release!: () => void;
    const issued = new Promise<void>((resolve) => { reached = resolve; });
    const continuation = new Promise<void>((resolve) => { release = resolve; });
    const issue = broker.restartReconnects.issue.bind(broker.restartReconnects);
    const spy = vi.spyOn(broker.restartReconnects, "issue").mockImplementation(async (...args) => {
      await issue(...args);
      reached();
      await continuation;
    });
    const promotion = next.trustedTaskPrompt("task-a");
    await issued;
    expect(broker.taskBindings.activityCount()).toBe(2);
    if (action === "canonical-revoke") {
      await broker.revokeTask("task-a");
    } else {
      next.dispose();
    }
    release();
    await promotion;
    spy.mockRestore();
    expect(broker.taskBindings.activityCount()).toBe(0);
    expect((await next.pending({ ...request(panel.privateMeta, "status"), capability: panel.active.reconnectTicket })).status).toBe("denied");
  });

  it("releases in-flight checks and presentation authority if ticket issuance fails", async () => {
    const { manager, broker, sessionId } = await fixture();
    const panel = stage(manager, sessionId);
    manager.attestDisplay(panel.receipt, "task-a");
    const spy = vi.spyOn(broker.restartReconnects, "issue").mockRejectedValueOnce(new Error("ticket storage unavailable"));
    await expect(manager.pending(request(panel.privateMeta))).rejects.toThrow("ticket storage unavailable");
    spy.mockRestore();
    expect(broker.taskBindings.activityCount()).toBe(0);
    expect(broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
    expect(broker.state(sessionId)).toBeDefined();
  });

  it("rechecks persisted revocation after a restart ticket was staged", async () => {
    const { manager, broker, sessionId, build, pdf } = await fixture();
    const panel = await activate(manager, sessionId); await protectWork(broker, sessionId); manager.dispose(); await broker.quiesceForShutdown();
    const next = build(); const offered = await next.broker.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    await next.broker.openReview({ pdfPath: pdf, recoveryDecision: "resume", recoveryOffer: offered.recoveryOffer, recoveryOperationId: randomUUID() });
    expect((await next.manager.stageReconnect(reconnect(panel.active))).status).toBe("pending");
    await next.broker.restartReconnects.revokeTask("task-a");
    await next.manager.trustedTaskPrompt("task-a");
    expect(next.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
    expect((await next.manager.pending({ ...request(panel.privateMeta, "status"), capability: panel.active.reconnectTicket })).status).toBe("denied");
  });
});


describe("canonical native watermark", () => {
  it("observes same-generation destination and save phase changes through authenticated reads", async () => {
    const { broker, manager, sessionId, pdf } = await fixture();
    const { active } = await activate(manager, sessionId);
    const raw = activeRequest(active);
    const events: string[] = [];
    const unsubscribe = broker.onStateInvalidation((event) => events.push(event.reason));
    const initial = manager.readWatermark(raw)!;
    expect(initial.watermark).toBe(0);
    expect(manager.readWatermark({ ...raw, capability: "wrong-capability" })).toBeUndefined();
    await broker.establishSaveDestination(sessionId, { kind: "copy", targetPath: pdf + ".copy", capabilityId: "destination" });
    const saving = manager.readWatermark(raw)!;
    expect(saving.watermark).toBeGreaterThan(initial.watermark);
    expect(saving.documentGeneration).toBe(initial.documentGeneration);
    expect(saving.reviewRevision).toBe(initial.reviewRevision);
    await broker.markSaveFailed(sessionId, broker.saveStatus(sessionId)!.destination.generation, "write-failed");
    expect(manager.readWatermark(raw)!.watermark).toBeGreaterThan(saving.watermark);
    expect(events).toEqual(["save", "save"]);
    const pending = broker.saveStatus(sessionId)!.sync;
    const failedWatermark = manager.readWatermark(raw)!.watermark;
    expect(await broker.markSaveCommitted({ sessionId, generation: broker.saveStatus(sessionId)!.destination.generation,
      revision: pending.desiredRevision - 1, stateDigest: "older-state", targetDigest: "older-target" })).toBe(false);
    expect(broker.saveStatus(sessionId)!.sync.phase).toBe("saving");
    expect(manager.readWatermark(raw)!.watermark).toBeGreaterThan(failedWatermark);
    expect(events).toEqual(["save", "save", "save"]);
    unsubscribe();
    await broker.establishSaveDestination(sessionId, { kind: "copy", targetPath: pdf + ".other", capabilityId: "other" });
    expect(events).toHaveLength(3);
  });

  it("watermarks real mutation, authoring finalize, release and disconnect; keeps browser delivery", async () => {
    const { broker, manager, sessionId } = await fixture();
    const { active } = await activate(manager, sessionId);
    const raw = activeRequest(active);
    const frames: string[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { frames.push(chunk.toString()); done(); } });
    const close = broker.controls.registerSocket(sessionId, socket);
    const events: string[] = [];
    broker.onStateInvalidation((event) => events.push(event.reason));
    let last = manager.readWatermark(raw)!.watermark;
    const advanced = () => { const next = manager.readWatermark(raw)!.watermark; expect(next).toBeGreaterThan(last); last = next; };
    await protectWork(broker, sessionId); advanced();
    const attachment = broker.replaceInteractionAttachment(sessionId, "author");
    const draftId = randomUUID();
    await broker.beginReviewInteraction({ sessionId, attachment, generation: 1, interactionToken: "authoring_token_1", order: 1, draftId }); advanced();
    await broker.acceptMutation(sessionId, { type: "put-draft", expectedRevision: 1, expectedDraftRevision: -1, draft: {
      id: draftId, ownerViewId: attachment.attachmentId, baseGeneration: 1, revision: 0, kind: "pageNote", pageIndex: 0,
      text: "a note", anchor: { kind: "page", pageIndex: 0, nearbyText: "source", rect: { x: 1, y: 1, width: 1, height: 1 } },
      disposition: { kind: "resolved", generation: 1 }, status: "protected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } }); advanced();
    expect(await broker.finalizeReviewInteraction({ sessionId, attachment, interactionToken: "authoring_token_1", order: 2,
      outcome: "applied", draftId, expectedDraftRevision: 0 })).toMatchObject({ status: "finalized", outcome: "applied" }); advanced();
    await broker.beginReviewInteraction({ sessionId, attachment, generation: 1, interactionToken: "authoring_token_2", order: 3, draftId: "draft_released" }); advanced();
    await broker.releaseReviewInteraction({ sessionId, attachment, interactionToken: "authoring_token_2", order: 4 }); advanced();
    await broker.beginReviewInteraction({ sessionId, attachment, generation: 1, interactionToken: "authoring_token_3", order: 5, draftId: "draft_disconnected" }); advanced();
    broker.disconnectInteractionIncarnation(sessionId, "author", attachment); advanced();
    expect(events.filter((reason) => reason === "revision")).toHaveLength(3);
    expect(events.filter((reason) => reason === "presence").length).toBeGreaterThanOrEqual(6);
    expect(frames.some((frame) => frame.includes('"kind":"session-invalidated"') && frame.includes('"reason":"revision"'))).toBe(true);
    expect(frames.some((frame) => frame.includes('"reason":"presence"'))).toBe(true);
    close(); socket.destroy();
  });

  it("watermarks freshness and generation, rejects the old generation, and cleans termination", async () => {
    const { broker, manager, sessionId, pdf } = await fixture(true);
    const { active } = await activate(manager, sessionId);
    const raw = activeRequest(active);
    const events: string[] = [];
    broker.onStateInvalidation((event) => events.push(event.reason));
    const initial = manager.readWatermark(raw)!;
    await broker.markLiveDocumentPossiblyStale(sessionId);
    expect(manager.readWatermark(raw)!.watermark).toBeGreaterThan(initial.watermark);
    await broker.replaceLiveDocument({ sessionId, outputPath: pdf, observationEpoch: 2 });
    expect(broker.state(sessionId)!.workflow.freshness).toBe("current");
    expect(events.filter((reason) => reason === "freshness")).toHaveLength(2);
    await writeFile(pdf, "%PDF-1.7\nsuccessor native document\n%%EOF");
    const successor = await broker.replaceLiveDocument({ sessionId, outputPath: pdf, observationEpoch: 3 });
    expect(successor.status).toBe("committed");
    expect(events).toContain("generation");
    expect(manager.readWatermark(raw)).toBeUndefined();
    expect(manager.activityCount()).toBe(0);
    const next = await activate(manager, sessionId);
    await broker.finish(sessionId);
    expect(events.at(-1)).toBe("terminated");
    expect(manager.readWatermark(activeRequest(next.active))).toBeUndefined();
    expect(manager.activityCount()).toBe(0);
  });

  it("notifies save commit and recovered pending scheduling without materializing documents", async () => {
    const { broker, manager, sessionId, pdf, build } = await fixture();
    const { active } = await activate(manager, sessionId);
    await protectWork(broker, sessionId);
    await broker.establishSaveDestination(sessionId, { kind: "original", targetPath: pdf, capabilityId: "original" });
    const sync = broker.saveStatus(sessionId)!.sync;
    const before = manager.readWatermark(activeRequest(active))!.watermark;
    expect(await broker.markSaveCommitted({ sessionId, generation: broker.saveStatus(sessionId)!.destination.generation,
      revision: sync.desiredRevision, stateDigest: sync.desiredDigest, targetDigest: broker.state(sessionId)!.source.digest })).toBe(true);
    expect(manager.readWatermark(activeRequest(active))!.watermark).toBeGreaterThan(before);
    await protectWorkWithRevision(broker, sessionId);
    manager.dispose(); await broker.quiesceForShutdown();
    const next = build();
    const resumed: string[] = []; const events: string[] = [];
    next.broker.onPhysicalSaveResume((id) => resumed.push(id));
    next.broker.onStateInvalidation((event) => events.push(event.reason));
    const offered = await next.broker.openReview({ pdfPath: pdf });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    await next.broker.openReview({ pdfPath: pdf, recoveryDecision: "resume", recoveryOffer: offered.recoveryOffer, recoveryOperationId: randomUUID() });
    expect(next.broker.saveStatus(sessionId)!.sync.phase).toBe("saving");
    expect(resumed).toEqual([sessionId]);
    expect(events).toContain("save");
  });

});

async function protectWorkWithRevision(broker: SessionBroker, sessionId: string) {
  const item = broker.state(sessionId)!.items[0]!;
  await broker.acceptMutation(sessionId, { type: "remove", expectedRevision: broker.state(sessionId)!.revision, id: item.id });
}
