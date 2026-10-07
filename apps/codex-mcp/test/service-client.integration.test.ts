import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PlacekeeperHost } from "../../service/src/host/placekeeper-host.js";
import { requestControl, requestLaunch, startLaunchControlServer } from "../../service/src/host/launch-control.js";
import { CODEX_INSTALLED_LAUNCHER_COMMAND, runHookCommand } from "../../service/src/cli/hook-command.js";
import { parseCodexAppResponse, parseCodexDisplayReceipt, parseCodexNativeLaunchSuccess, parseCodexPendingPresentation, type CodexAppRequest, type CodexAppResponse } from "../../../packages/core/src/codex-mcp-protocol.js";
import { MacOsDestinationPicker } from "../../service/src/host/destination-picker.js";
import { createServiceClient } from "../src/service-client.js";
import { createNativeServer } from "../src/server.js";
import { PENDING_META_KEY, RESPONSE_META_KEY } from "../src/transport-contract.js";

describe("native SDK transport with canonical daemon", () => {
  it("isolates private invocations, retains peers after client EOF and denies old-incarnation renewal/release", async () => {
    const root = await mkdtemp(join(tmpdir(), "pk-mcp-"));
    const assets = join(root, "assets"), pdf = join(root, "review.pdf"), socket = join(root, "c.sock");
    await mkdir(assets); await copyFile(resolve("test/fixtures/pdfs/text-native-with-annotations.pdf"), pdf);
    await writeFile(join(assets, "pdfium.wasm"), "engine"); await writeFile(join(assets, "pdfium-worker.js"), "worker");
    const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), webAssets: { root: assets }, port: 0 });
    const control = await startLaunchControlServer(host, socket);
    const request = (value: Parameters<typeof requestControl>[1]) => requestControl(socket, value);
    const clients: Client[] = [], servers: ReturnType<typeof createNativeServer>[] = [];
    const owner = "native-mcp-test-chat";
    async function panel() {
      const launch = parseCodexNativeLaunchSuccess(await requestLaunch(socket, { pdfPath: pdf, surface: "codex-native", workflowMode: "generated-output" }));
      if (launch === undefined) throw new Error("Native launch required");
      await runHookCommand(["hook", "--event"], JSON.stringify({ session_id: owner, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex-native --pdf '${pdf}' --generated-output` }, tool_response: JSON.stringify(launch) }), request, () => {});
      const server = createNativeServer(createServiceClient(socket), "<html>same cached shell</html>"), client = new Client({ name: "native-test", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
      servers.push(server); clients.push(client);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      const display = await client.callTool({ name: "display_review", arguments: { handoff: launch.handoff.token } });
      const pending = parseCodexPendingPresentation(display._meta?.[PENDING_META_KEY]), receipt = parseCodexDisplayReceipt(display.structuredContent);
      if (pending === undefined || receipt === undefined) throw new Error("Private display required");
      expect(JSON.stringify({ content: display.content, structuredContent: display.structuredContent })).not.toContain(pending.pendingCapability);
      await runHookCommand(["hook", "--event"], JSON.stringify({ session_id: owner, hook_event_name: "PostToolUse", tool_name: "mcp__placekeeper__display_review", tool_input: { handoff: launch.handoff.token }, tool_response: { structuredContent: receipt } }), request, () => {});
      const ready = await client.callTool({ name: "review_app", arguments: { request: { protocolVersion: 1, runtimeId: pending.runtimeId, attemptId: pending.attemptId, generation: pending.generation, requestId: randomUUID(), capability: pending.pendingCapability, authority: "pending", method: "ready", payload: {} } } });
      const active = parseCodexAppResponse(ready._meta?.[RESPONSE_META_KEY]);
      if (active?.status !== "active") throw new Error("Promotion required");
      return { client, server, active };
    }
    async function app(client: Client, active: Extract<CodexAppResponse, { status: "active" }>, method: Extract<CodexAppRequest, { authority: "presentation" }>["method"], overrides: Partial<CodexAppRequest> = {}) {
      const result = await client.callTool({ name: "review_app", arguments: { request: { protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, requestId: randomUUID(), capability: active.presentationCapability, authority: "presentation", method, payload: {}, ...overrides } } });
      expect(result.content).toEqual([]); expect(result.structuredContent).toBeUndefined();
      return parseCodexAppResponse(result._meta?.[RESPONSE_META_KEY]);
    }
    try {
      const a = await panel(), b = await panel();
      expect(a.active.presentationCapability).not.toBe(b.active.presentationCapability);
      await a.client.close(); await a.server.close();
      expect(await app(b.client, b.active, "renew")).toMatchObject({ status: "ok" });
      for (const method of ["renew", "detach"] as const) expect(await app(b.client, b.active, method, { attemptId: a.active.attemptId, capability: a.active.presentationCapability })).toMatchObject({ status: "denied" });
      expect(await app(b.client, b.active, "watermark")).toMatchObject({ status: "ok" });
      expect(host.broker.taskBindings.bindingForTask(owner)).toBeDefined();
    } finally {
      await Promise.all(clients.map((client) => client.close())); await Promise.all(servers.map((server) => server.close()));
      await control.close(); await host.close(); await rm(root, { recursive: true, force: true });
    }
  });
});


it.runIf(process.platform === "darwin")("retains native picker results after the ordinary five-second socket deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-picker-")), pdf = join(root, "review.pdf"), socket = join(root, "c.sock");
  await copyFile(resolve("test/fixtures/pdfs/text-native.pdf"), pdf);
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, "recovery"), port: 0 });
  const control = await startLaunchControlServer(host, socket);
  const folder = vi.spyOn(MacOsDestinationPicker.prototype, "chooseFolder").mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 5_200)); return root;
  });
  const locate = vi.spyOn(MacOsDestinationPicker.prototype, "locatePdf").mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 5_200)); return undefined;
  });
  try {
    const opened = await host.broker.openReview({ pdfPath: pdf, surface: "codex-native" });
    if (opened.kind === "recovery-offered") throw new Error("unexpected recovery");
    const sessionId = opened.launch.sessionId, manager = host.codexRuntime;
    const launch = manager.stageLaunch({ sessionId, kind: "opened" })!;
    expect(manager.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: sessionId, documentGeneration: 1, taskSessionId: "picker-chat" })).toBe(true);
    const display = manager.display(launch.handoff.token)!;
    expect(manager.attestDisplay(display.receipt, "picker-chat")).toBe(true);
    const active = await manager.pending({ protocolVersion: 1, runtimeId: display.privateMeta.runtimeId, attemptId: display.privateMeta.attemptId,
      generation: 1, capability: display.privateMeta.pendingCapability, requestId: randomUUID(), authority: "pending", method: "ready", payload: {} });
    if (active.status !== "active") throw new Error("Expected admission");
    const client = createServiceClient(socket);
    const request = (method: "chooseFolder" | "locateSave" | "chooseOriginal") => ({ protocolVersion: 1 as const, runtimeId: active.runtimeId, attemptId: active.attemptId,
      generation: 1, capability: active.presentationCapability, requestId: randomUUID(), authority: "presentation" as const, method, payload: {} });
    // Actual socket baseline: the unmodified short control policy loses the picker result.
    await expect(requestControl(socket, { kind: "codex-app", request: request("chooseFolder") })).rejects.toThrow("timed out");
    const response = await client.app(request("chooseFolder"));
    expect(response).toMatchObject({ status: "ok", payload: { cancelled: false, selectionId: expect.any(String) } });
    expect(await client.app(request("chooseOriginal"))).toMatchObject({ status: "ok" });
    await host.saving.drain();
    expect(await client.app(request("locateSave"))).toMatchObject({ status: "ok" });
    expect(folder).toHaveBeenCalledTimes(2); expect(locate).toHaveBeenCalledTimes(1);
  } finally {
    folder.mockRestore(); locate.mockRestore(); await control.close(); await host.close(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
