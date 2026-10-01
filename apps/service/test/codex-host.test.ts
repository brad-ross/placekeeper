import { randomUUID } from "node:crypto";
import { copyFile, appendFile, readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePlacekeeperLink, type PlacekeeperLinkLocation } from "../../../packages/core/src/placekeeper-link.js";
import { CODEX_DISPLAY_TOOL, parseCodexNativeLaunchSuccess, type CodexAppRequest, type CodexAppResponse } from "../../../packages/core/src/codex-mcp-protocol.js";
import { CODEX_INSTALLED_LAUNCHER_COMMAND, runHookCommand } from "../src/cli/hook-command.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { requestControl, requestLaunch, startLaunchControlServer } from "../src/host/launch-control.js";
import { MacOsDestinationPicker } from "../src/host/destination-picker.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pk-native-host-"));
  const pdf = join(root, "paper.pdf"), assets = join(root, "assets"), recoveryRoot = join(root, "recovery");
  await mkdir(assets);
  await copyFile(resolve("test/fixtures/pdfs/text-native.pdf"), pdf);
  await writeFile(join(assets, "app.js"), "export function start(){}\n");
  await writeFile(join(assets, "pdfium.wasm"), "engine");
  await writeFile(join(assets, "pdfium-worker.js"), "worker");
  let startCount = 0;
  const start = async () => {
    const host = await PlacekeeperHost.start({ recoveryRoot, webAssets: { root: assets } });
    const socketPath = join(root, `s${++startCount}.sock`);
    const control = await startLaunchControlServer(host, socketPath);
    cleanups.push(async () => { await host.close(); await control.close(); });
    return { host, control, socketPath, request: (r: Parameters<typeof requestControl>[1]) => requestControl(socketPath, r) };
  };
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, pdf, start, ...await start() };
}
type Connection = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;
async function launch(f: Connection & { pdf: string }, owner = "task-native") {
  const result = parseCodexNativeLaunchSuccess(await requestLaunch(f.socketPath, { pdfPath: f.pdf, surface: "codex-native", workflowMode: "generated-output" }));
  if (result === undefined) throw new Error("Expected native launch");
  expect(result).not.toHaveProperty("url");
  await runHookCommand(["hook", "--event"], JSON.stringify({ session_id: owner, hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_input: { command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex-native --pdf '${f.pdf}' --generated-output` }, tool_response: JSON.stringify(result) }), f.request, () => {});
  return result;
}
async function display(f: Connection, handoff: string) {
  const result = await f.request({ kind: "codex-display", request: { handoff } });
  if (result.kind !== "codex-display") throw new Error("Expected display");
  expect(JSON.stringify(result.receipt)).not.toContain(result.pending.pendingCapability);
  return result;
}
async function attest(f: Connection, d: Awaited<ReturnType<typeof display>>, owner = "task-native") {
  await runHookCommand(["hook", "--event"], JSON.stringify({ session_id: owner, hook_event_name: "PostToolUse", tool_name: CODEX_DISPLAY_TOOL,
    tool_input: { handoff: "h".repeat(43) }, tool_response: { structuredContent: d.receipt } }), f.request, () => {});
}
async function app(f: Connection, raw: CodexAppRequest): Promise<CodexAppResponse> {
  const result = await f.request({ kind: "codex-app", request: raw });
  if (result.kind !== "codex-app") throw new Error(`Unexpected app response: ${JSON.stringify(result)}`);
  return result.response;
}
function pending(d: Awaited<ReturnType<typeof display>>, method: "ready" | "status" = "ready"): CodexAppRequest {
  const m = d.pending;
  return { protocolVersion: 1, runtimeId: m.runtimeId, attemptId: m.attemptId, generation: m.generation, capability: m.pendingCapability,
    requestId: randomUUID(), authority: "pending", method, payload: {} };
}
type Active = Extract<CodexAppResponse, { status: "active" }>;
function request(a: Active, method: Extract<CodexAppRequest, { authority: "presentation" }>["method"], payload: unknown = {}, requestId = randomUUID()): CodexAppRequest {
  return { protocolVersion: 1, runtimeId: a.runtimeId, attemptId: a.attemptId, generation: a.generation, capability: a.presentationCapability, authority: "presentation", requestId, method, payload };
}
async function panel(f: Connection & { pdf: string }, readyFirst = false): Promise<Active> {
  const l = await launch(f), d = await display(f, l.handoff.token);
  if (readyFirst) expect(await app(f, pending(d))).toEqual({ status: "pending" });
  await attest(f, d);
  const a = await app(f, pending(d, readyFirst ? "status" : "ready"));
  if (a.status !== "active") throw new Error(`Expected active: ${JSON.stringify(a)}`);
  return a;
}
function payload(r: CodexAppResponse): any { expect(r.status).toBe("ok"); return r.status === "ok" ? r.payload : undefined; }

describe("native host private control and trusted hooks", () => {
  it("opens without a URL, promotes in either order, shares edits and isolates resources; detaching returns native activity to baseline", async () => {
    const f = await fixture(); const a = await panel(f, true), b = await panel(f);
    const sessionId = f.host.broker.taskBindings.bindingForTask("task-native")!.reviewSessionId;
    const bootstrap = payload(await app(f, request(a, "bootstrap")));
    expect(bootstrap.scope.launchSurface).toBe("codex"); expect(JSON.stringify(bootstrap)).not.toContain(f.root);
    const handle = bootstrap.resources.document;
    expect(payload(await app(f, request(a, "resource", { handle, offset: 0, length: 256 * 1024 }))).dataBase64).toBeTruthy();
    expect(await app(f, request(b, "resource", { handle, offset: 0, length: 1 }))).toMatchObject({ status: "denied" });
    const before = payload(await app(f, request(b, "watermark"))).watermark;
    const edit = request(a, "command", { type: "set-annotation-name", expectedRevision: 0, annotationName: "Accepted" });
    const accepted = await app(f, edit); expect(accepted.status).toBe("ok"); expect(await app(f, edit)).toEqual(accepted);
    expect(f.host.broker.state(sessionId)?.revision).toBe(1);
    expect(payload(await app(f, request(b, "watermark"))).watermark).toBeGreaterThan(before);
    expect(await f.host.lifecycle.shutdownIfIdle()).toMatchObject({ status: "refused" });
    expect(await app(f, request(a, "detach"))).toMatchObject({ status: "ok" });
    expect(await app(f, request(b, "bootstrap"))).toMatchObject({ status: "ok" });
    await app(f, request(b, "detach"));
    expect(f.host.codexRuntime.activityCount()).toBe(0);
    await f.request({ kind: "revoke-task", taskSessionId: "task-native" });
    expect(f.host.lifecycle.status().activity).toEqual({ reviewPresence: 0, codexTasks: 0, transientWork: 0 });
  });
  it.each<PlacekeeperLinkLocation>([
    { kind: "page", page: 2 },
    { kind: "item", page: 2, itemId: "00000000-0000-4000-8000-000000000001" },
    { kind: "destination", page: 2, mode: "fit-rectangle", params: [1, 2, 30, 40] },
  ])("preserves the trusted native link location $kind", async (location) => {
    const f = await fixture(), link = encodePlacekeeperLink({ path: f.pdf, location });
    const response = await f.request({ kind: "link-open", request: { link, confirmed: true, surface: "codex-native" } });
    if (response.kind !== "link-open") throw new Error("Expected link open");
    const result = parseCodexNativeLaunchSuccess(response.response); if (result === undefined) throw new Error("Expected native link");
    await runHookCommand(["hook", "--event"], JSON.stringify({ session_id: "task-native", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open-link --json --surface codex-native --confirmed --link '${link}'` }, tool_response: JSON.stringify(result) }), f.request, () => {});
    const d = await display(f, result.handoff.token); await attest(f, d);
    const a = await app(f, pending(d)); if (a.status !== "active") throw new Error("Expected active link");
    expect(payload(await app(f, request(a, "bootstrap"))).location).toEqual(location);
  });
  it("never promotes an unclaimed, wrong-task, missing-hook or additional unattested presentation", async () => {
    const f = await fixture();
    const raw = parseCodexNativeLaunchSuccess(await requestLaunch(f.socketPath, { pdfPath: f.pdf, surface: "codex-native", workflowMode: "generated-output" }))!;
    expect(await f.request({ kind: "codex-display", request: { handoff: raw.handoff.token } })).toMatchObject({ kind: "error" });
    const a = await panel(f); const l = await launch(f), d = await display(f, l.handoff.token);
    expect(await f.request({ kind: "codex-attest", taskSessionId: "other-task", receipt: d.receipt })).toMatchObject({ status: "denied" });
    expect(await app(f, pending(d))).toEqual({ status: "pending" });
    expect(await app(f, { ...pending(d), authority: "presentation", method: "bootstrap" })).toMatchObject({ status: "denied" });
    expect(await app(f, request(a, "bootstrap"))).toMatchObject({ status: "ok" });
    await attest(f, d); expect(await app(f, pending(d, "status"))).toMatchObject({ status: "active" });
    const conflict = parseCodexNativeLaunchSuccess(await requestLaunch(f.socketPath, { pdfPath: f.pdf, surface: "codex-native", workflowMode: "generated-output" }))!;
    expect(await f.request({ kind: "claim-binding", native: true, taskSessionId: "other-task", reviewSessionId: conflict.sessionId, documentGeneration: conflict.documentGeneration, bindProof: conflict.bindProof })).toEqual({ kind: "codex-binding", status: "denied" });
  });
  it("peer holds defer the newest replacement and native disconnect preserves its protected draft", async () => {
    const f = await fixture(), a = await panel(f), b = await panel(f);
    const sessionId = f.host.broker.taskBindings.bindingForTask("task-native")!.reviewSessionId;
    const bootstrap = payload(await app(f, request(a, "bootstrap"))), draftId = randomUUID();
    expect(payload(await app(f, request(a, "beginInteraction", { interactionToken: "hold_panel_a", order: 1, generation: 1, draftId }))).status).toBe("accepted");
    expect(payload(await app(f, request(b, "beginInteraction", { interactionToken: "hold_panel_b", order: 1, generation: 1 }))).status).toBe("accepted");
    const now = new Date().toISOString();
    const draft = { id: draftId, ownerViewId: bootstrap.interaction.attachmentId, baseGeneration: 1, revision: 0, kind: "pageNote", pageIndex: 0,
      text: "Protected after native detach", anchor: { kind: "page", pageIndex: 0, nearbyText: "source", rect: { x: 1, y: 1, width: 2, height: 2 } },
      disposition: { kind: "resolved", generation: 1 }, status: "protected", createdAt: now, updatedAt: now };
    expect(await app(f, request(a, "command", { type: "put-draft", expectedRevision: 0, expectedDraftRevision: -1, draft }))).toMatchObject({ status: "ok" });
    await appendFile(f.pdf, "\n% first native successor\n");
    expect(await f.host.broker.replaceLiveDocument({ sessionId, outputPath: f.pdf, observationEpoch: 1 })).toMatchObject({ status: "deferred" });
    await appendFile(f.pdf, "% newest native successor\n");
    expect(await f.host.broker.replaceLiveDocument({ sessionId, outputPath: f.pdf, observationEpoch: 2 })).toMatchObject({ status: "deferred" });
    await app(f, request(a, "detach"));
    expect(f.host.broker.interactions.held(sessionId)).toBe(true);
    expect(f.host.broker.state(sessionId)?.pendingDrafts).toHaveLength(1);
    expect(f.host.broker.state(sessionId)?.workflow.documentGeneration).toBe(1);
    await app(f, request(b, "releaseInteraction", { interactionToken: "hold_panel_b", order: 2 }));
    await vi.waitFor(() => expect(f.host.broker.state(sessionId)?.workflow.documentGeneration).toBe(2));
    const { createHash } = await import("node:crypto");
    expect(f.host.broker.state(sessionId)?.source.digest).toBe(createHash("sha256").update(await readFile(f.pdf)).digest("hex"));
    expect(f.host.broker.state(sessionId)?.pendingDrafts).toHaveLength(1);
    expect(await app(f, request(b, "bootstrap"))).toMatchObject({ status: "denied" });
  });
  it("one control client EOF preserves admitted mutation, live peers and daemon", async () => {
    const f = await fixture(), a = await panel(f), b = await panel(f);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = f.host.broker.acceptMutation.bind(f.host.broker);
    vi.spyOn(f.host.broker, "acceptMutation").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    const edit = request(a, "command", { type: "set-annotation-name", expectedRevision: 0, annotationName: "EOF accepted" });
    const socket = createConnection(f.socketPath); socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => { socket.write(`${JSON.stringify({ kind: "codex-app", request: edit })}\n`); resolve(); }));
    await entered.promise; socket.destroy();
    expect(f.host.lifecycle.status().activity.transientWork).toBeGreaterThan(0);
    expect(await f.host.lifecycle.shutdownIfIdle()).toMatchObject({ status: "refused" });
    release.resolve();
    const replay = await app(f, edit); expect(replay.status).toBe("ok");
    expect(await app(f, request(b, "bootstrap"))).toMatchObject({ status: "ok" });
    expect(f.host.lifecycle.status().lifecycle).toBe("accepting");
  });
  it("shutdown racing activation waits admitted ticket work and releases native authority", async () => {
    const f = await fixture(), l = await launch(f), d = await display(f, l.handoff.token); await attest(f, d);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = f.host.broker.restartReconnects.issue.bind(f.host.broker.restartReconnects);
    vi.spyOn(f.host.broker.restartReconnects, "issue").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    const activating = app(f, pending(d)); await entered.promise;
    expect(await f.host.lifecycle.shutdownIfIdle()).toMatchObject({ status: "refused" });
    const close = f.host.close(); release.resolve(); await activating; await close;
    expect(f.host.codexRuntime.activityCount()).toBe(0); expect(f.host.broker.interactions.retentionStatus()).toEqual({ attachments: 0, owners: 0 });
  });
  it.skipIf(process.platform !== "darwin")("admitted native picker holds shutdown activity and close waits its completion", async () => {
    const f = await fixture(), a = await panel(f);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string | undefined>();
    vi.spyOn(MacOsDestinationPicker.prototype, "chooseFolder").mockImplementation(async () => { entered.resolve(); return release.promise; });
    const picking = app(f, request(a, "chooseFolder")); await entered.promise;
    expect(f.host.lifecycle.status().activity.transientWork).toBeGreaterThan(0);
    expect(await f.host.lifecycle.shutdownIfIdle()).toMatchObject({ status: "refused" });
    const close = f.host.close(); release.resolve(undefined); await picking; await close;
    expect(f.host.codexRuntime.activityCount()).toBe(0);
  });
  it.each(["task-first", "panel-first"] as const)("restores two independent native panel tickets after restart (%s)", async (order) => {
    const f = await fixture(), a = await panel(f), b = await panel(f);
    const sessionId = f.host.broker.taskBindings.bindingForTask("task-native")!.reviewSessionId;
    await app(f, request(a, "command", { type: "set-annotation-name", expectedRevision: 0, annotationName: "Restart" }));
    await f.host.close(); await f.control.close();
    const next = await f.start();
    const offered = await requestLaunch(next.socketPath, { pdfPath: f.pdf, surface: "codex-native" });
    if (!offered.ok || offered.kind !== "recovery-offered") throw new Error("Expected recovery");
    const resumed = parseCodexNativeLaunchSuccess(await requestLaunch(next.socketPath, { pdfPath: f.pdf, surface: "codex-native", recovery: "resume", recoveryOffer: offered.recoveryOffer, recoveryOperationId: randomUUID() }))!;
    expect(resumed.sessionId).toBe(sessionId);
    const prompt = async (owner: string) => next.request({ kind: "refresh-context", taskSessionId: owner });
    if (order === "task-first") await prompt("task-native");
    for (const previous of [a, b]) {
      const r = await app(next, { ...request(previous, "bootstrap"), authority: "reconnect", method: "reconnect", capability: previous.reconnectTicket, payload: {} });
      expect(r.status).toBe(order === "task-first" ? "active" : "pending");
    }
    if (order === "panel-first") {
      await prompt("wrong-task"); expect(next.host.broker.taskBindings.bindingForTask("wrong-task")).toBeUndefined();
      expect(await prompt("task-native")).toMatchObject({ kind: "context", result: { status: "current" } });
    }
    for (const previous of [a, b]) {
      const active = await app(next, { ...request(previous, "bootstrap"), authority: "pending", method: "status", capability: previous.reconnectTicket, payload: {} });
      expect(active.status).toBe("active");
      if (active.status === "active") expect(await app(next, request(active, "bootstrap"))).toMatchObject({ status: "ok" });
    }
    await next.request({ kind: "revoke-task", taskSessionId: "task-native" });
    expect(next.host.codexRuntime.activityCount()).toBe(1); // Only the unused resumed launch remains staged.
    expect(next.host.broker.taskBindings.bindingForTask("task-native")).toBeUndefined();
  });
  it.each(["resume", "fork"] as const)("native protected recovery %s is idempotent through the actual control and hook path", async (choice) => {
    const f = await fixture(), a = await panel(f), l = await launch(f);
    expect(await app(f, request(a, "command", { type: "set-annotation-name", expectedRevision: 0, annotationName: "Recoverable" }))).toMatchObject({ status: "ok" });
    await f.host.close(); await f.control.close();
    const next = { ...await f.start(), pdf: f.pdf };
    const offered = await requestLaunch(next.socketPath, { pdfPath: f.pdf, surface: "codex-native" });
    if (!offered.ok || offered.kind !== "recovery-offered") throw new Error("Expected protected recovery");
    const input = { pdfPath: f.pdf, surface: "codex-native" as const, workflowMode: "generated-output" as const, recovery: choice, recoveryOffer: offered.recoveryOffer, recoveryOperationId: randomUUID() };
    const resumed = parseCodexNativeLaunchSuccess(await requestLaunch(next.socketPath, input))!;
    const replay = parseCodexNativeLaunchSuccess(await requestLaunch(next.socketPath, input))!;
    expect(replay.sessionId).toBe(resumed.sessionId);
    if (choice === "resume") {
      expect(resumed.sessionId).toBe(l.sessionId);
      expect(next.host.broker.state(resumed.sessionId)?.annotationName).toBe("Recoverable");
      expect(next.host.broker.state(resumed.sessionId)?.revision).toBe(1);
    } else {
      expect(resumed.sessionId).not.toBe(l.sessionId);
      expect(next.host.broker.state(resumed.sessionId)?.revision).toBe(0);
    }
    await runHookCommand(["hook", "--event"], JSON.stringify({ session_id: "task-native", hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex-native --pdf '${f.pdf}' --generated-output --recovery ${choice} --recovery-offer-id '${offered.recoveryOffer.id}' --recovery-offer-expires-at '${offered.recoveryOffer.expiresAt}' --recovery-operation-id '${input.recoveryOperationId}'` }, tool_response: JSON.stringify(resumed) }), next.request, () => {});
    const d = await display(next, resumed.handoff.token); await attest(next, d);
    const b = await app(next, pending(d)); if (b.status !== "active") throw new Error("Expected recovery continuation activation");
    expect(await app(next, request(b, "bootstrap"))).toMatchObject({ status: "ok" });
  });
});
