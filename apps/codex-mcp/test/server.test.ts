import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CODEX_REVIEW_UI_RESOURCE } from "../../../packages/core/src/codex-mcp-protocol.js";
import { callNativeTool, createNativeServer, nativeTools } from "../src/server.js";
import { APP_TOOL, PENDING_META_KEY, RESPONSE_META_KEY } from "../src/transport-contract.js";
import type { NativeServiceClient } from "../src/service-client.js";
const pending = { protocolVersion: 1 as const, runtimeId: "runtime-1", attemptId: "attempt-1", generation: 1, receiptId: "receipt-1", pendingCapability: "p".repeat(43) };
const receipt = { protocolVersion: 1 as const, status: "pending" as const, receiptId: pending.receiptId, attemptId: pending.attemptId, generation: 1 };
const request = { protocolVersion: 1, runtimeId: pending.runtimeId, attemptId: pending.attemptId, requestId: "request-1", generation: 1, authority: "pending", method: "ready", payload: {}, capability: pending.pendingCapability };
function fixture(): NativeServiceClient { return { display: vi.fn(async () => ({ receipt, pending })), app: vi.fn(async () => ({ status: "active" as const, runtimeId: pending.runtimeId, attemptId: pending.attemptId, generation: 1, presentationCapability: "a".repeat(43), reconnectTicket: "r".repeat(43) })) }; }
describe("packaged native MCP transport", () => {
  it("returns exact model receipt and invocation-private pending credentials without waiting for hooks", async () => {
    const result = await callNativeTool(fixture(), "display_review", { handoff: "h".repeat(43) });
    expect(result.structuredContent).toEqual(receipt); expect(result._meta?.[PENDING_META_KEY]).toEqual(pending);
    expect(JSON.stringify({ content: result.content, structuredContent: result.structuredContent })).not.toContain(pending.pendingCapability);
  });
  it("private app replies never expose credentials or byte payloads in model surfaces", async () => {
    const result = await callNativeTool(fixture(), APP_TOOL, { request });
    expect(result.content).toEqual([]); expect(result.structuredContent).toBeUndefined(); expect(result._meta?.[RESPONSE_META_KEY]).toMatchObject({ status: "active" });
    expect(nativeTools[1]?._meta).toEqual({ ui: { visibility: ["app"] } });
    expect(nativeTools[1]?._meta).not.toHaveProperty("ui.resourceUri");
  });
  it("rejects malformed requests before service admission and sanitizes transport failures", async () => {
    const client = fixture();
    expect((await callNativeTool(client, APP_TOOL, { request: { ...request, taskSessionId: "forged" } })).isError).toBe(true);
    expect(client.app).not.toHaveBeenCalled();
    client.display = async () => { throw new Error(`private socket ${pending.pendingCapability}`); };
    expect(JSON.stringify(await callNativeTool(client, "display_review", { handoff: "h".repeat(43) }))).not.toContain(pending.pendingCapability);
  });
  it("bounds app result encoding", async () => {
    const client = fixture(); client.app = async () => ({ status: "ok", payload: "x".repeat(1024 * 1024) });
    expect((await callNativeTool(client, APP_TOOL, { request })).isError).toBe(true);
  });
  it("rejects hosts without MCP Apps before consuming a launch handoff", async () => {
    const service = fixture(), server = createNativeServer(service, "<html>shell</html>");
    const client = new Client({ name: "unsupported", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try { expect((await client.callTool({ name: "display_review", arguments: { handoff: "h".repeat(43) } })).isError).toBe(true); expect(service.display).not.toHaveBeenCalled(); }
    finally { await client.close(); await server.close(); }
  });
  it("SDK lists one cached credential-free HTML shell and app calls add no UI resources", async () => {
    const service = fixture(), server = createNativeServer(service, "<html>credential-free</html>");
    const client = new Client({ name: "qualification-test", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      expect((await client.listResources()).resources.map((resource) => resource.uri)).toEqual([CODEX_REVIEW_UI_RESOURCE]);
      const resource = await client.readResource({ uri: CODEX_REVIEW_UI_RESOURCE });
      expect(JSON.stringify(resource)).not.toContain(pending.pendingCapability);
      const result = await client.callTool({ name: "display_review", arguments: { handoff: "h".repeat(43) } });
      expect(result.structuredContent).toEqual(receipt);
      expect((await client.callTool({ name: APP_TOOL, arguments: { request } })).structuredContent).toBeUndefined();
    } finally { await client.close(); await server.close(); }
    expect(service.app).toHaveBeenCalledOnce();
  });
});


describe("packaged native command resolution", () => {
  it("initializes from a spaced fixture HOME without plugin argument interpolation or plugin cwd", async () => {
    const home = await mkdtemp(join(tmpdir(), "pk MCP home "));
    const resources = join(home, "Applications/Placekeeper.app/Contents/Resources");
    const wrapper = join(resources, "integrations/codex-plugin/scripts/mcp.sh");
    const node = join(resources, "node/bin/node"), server = join(resources, "codex-mcp/server.js");
    const sdk = (path: string) => JSON.stringify(pathToFileURL(resolve(`node_modules/@modelcontextprotocol/sdk/dist/esm/${path}`)).href);
    const registration = JSON.parse(await readFile(resolve("integrations/codex-plugin/.mcp.json"), "utf8")).mcpServers.placekeeper as { command: string; args: string[] };
    try {
      await Promise.all([dirname(wrapper), dirname(node), dirname(server)].map((directory) => mkdir(directory, { recursive: true })));
      await copyFile(resolve("integrations/codex-plugin/scripts/mcp.sh"), wrapper);
      await symlink(process.execPath, node);
      await writeFile(server, `import { Server } from ${sdk("server/index.js")};
import { StdioServerTransport } from ${sdk("server/stdio.js")};
import { ListToolsRequestSchema } from ${sdk("types.js")};
const server = new Server({name:"installed-fixture",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
await server.connect(new StdioServerTransport());
`);
      const client = new Client({ name: "packaged-resolution-test", version: "1" });
      const transport = new StdioClientTransport({ ...registration, env: { HOME: home }, cwd: tmpdir(), stderr: "pipe" });
      try {
        await client.connect(transport);
        expect(client.getServerVersion()).toEqual({ name: "installed-fixture", version: "1" });
        expect((await client.listTools()).tools).toEqual([]);
      } finally { await client.close(); }
      // Setting the hook environment variable cannot expand a literal MCP argv.
      const literalClient = new Client({ name: "literal-resolution-test", version: "1" });
      const literal = new StdioClientTransport({ command: "/bin/sh", args: ["${PLUGIN_ROOT}/scripts/mcp.sh"], env: { HOME: home, PLUGIN_ROOT: join(resources, "integrations/codex-plugin") }, cwd: tmpdir(), stderr: "pipe" });
      let stderr = "";
      literal.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      try {
        await expect(literalClient.connect(literal)).rejects.toThrow(/Connection closed/u);
        expect(stderr).toContain("${PLUGIN_ROOT}/scripts/mcp.sh");
      } finally { await literalClient.close(); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

it("qualification metadata is fresh and private while app replies add no UI resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-private-"));
  try {
    await writeFile(join(root, "native-qualification.json"), JSON.stringify({ version: 1, runId: "c".repeat(32), salt: "s".repeat(43), observe: true, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { mode: 0o600 });
    const { NativeQualificationObserver } = await import("../../service/src/codex/native-qualification.js");
    const observer = new NativeQualificationObserver(root, "server");
    const a = await callNativeTool(fixture(), "display_review", { handoff: "h".repeat(43) }, { qualification: observer });
    const b = await callNativeTool(fixture(), "display_review", { handoff: "h".repeat(43) }, { qualification: observer });
    expect(a._meta?.["placekeeper/qualification"]).toBeDefined();
    expect(a._meta?.["placekeeper/qualification"]).not.toEqual(b._meta?.["placekeeper/qualification"]);
    expect(a.content).toEqual(b.content); expect(a.structuredContent).toEqual(receipt);
    expect(JSON.stringify({ content: a.content, structuredContent: a.structuredContent })).not.toContain("invocationNonce");
    const app = await callNativeTool(fixture(), APP_TOOL, { request }, { qualification: observer });
    expect(app.content).toEqual([]); expect(app.structuredContent).toBeUndefined(); expect(app._meta).not.toHaveProperty("ui.resourceUri");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("disabled, expired and failed observation sinks preserve exact normal public and private results", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-fail-soft-"));
  try {
    const { NativeQualificationObserver } = await import("../../service/src/codex/native-qualification.js");
    const args = { handoff: "h".repeat(43) };
    const expected = await callNativeTool(fixture(), "display_review", args);
    expect(await callNativeTool(fixture(), "display_review", args, { qualification: new NativeQualificationObserver(root, "server") })).toEqual(expected);
    const descriptor = { version: 1, runId: "c".repeat(32), salt: "s".repeat(43), observe: true, createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() };
    await writeFile(join(root, "native-qualification.json"), JSON.stringify(descriptor), { mode: 0o600 });
    expect(await callNativeTool(fixture(), "display_review", args, { qualification: new NativeQualificationObserver(root, "server") })).toEqual(expected);
    descriptor.expiresAt = new Date(Date.now() + 60_000).toISOString(); await writeFile(join(root, "native-qualification.json"), JSON.stringify(descriptor));
    await writeFile(join(root, "native-qualification"), "occupied");
    expect(await callNativeTool(fixture(), "display_review", args, { qualification: new NativeQualificationObserver(root, "server") })).toEqual(expected);
    expect(await callNativeTool(fixture(), APP_TOOL, { request }, { qualification: new NativeQualificationObserver(root, "server") })).toEqual(await callNativeTool(fixture(), APP_TOOL, { request }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("grants a selected own shell action only on a normal successful authenticated response, privately and once", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-controls-"));
  try {
    const { NativeQualificationObserver } = await import("../../service/src/codex/native-qualification.js");
    const { NativeQualificationControls } = await import("../../service/src/codex/native-qualification-controls.js");
    const { QUALIFICATION_CONTROLS_META_KEY } = await import("../src/qualification-controls-contract.js");
    const expiry = new Date(Date.now() + 60_000).toISOString();
    await writeFile(join(root, "native-qualification.json"), JSON.stringify({ version: 1, runId: "c".repeat(32), salt: "s".repeat(43), observe: true, createdAt: new Date().toISOString(), expiresAt: expiry }), { mode: 0o600 });
    const observer = new NativeQualificationObserver(root, "server"), controls = new NativeQualificationControls(root), service = fixture();
    const display = await callNativeTool(service, "display_review", { handoff: "h".repeat(43) }, { qualification: observer, controls });
    const correlation = display._meta?.["placekeeper/qualification"] as { runId: string; invocationNonce: string };
    expect(Object.keys(correlation).sort()).toEqual(["expiresAt", "invocationNonce", "runId"]);
    const descriptor = { version: 1, actionId: "d".repeat(32), action: "bridge-close", createdAt: new Date().toISOString(), expiresAt: expiry, budget: 1, target: { ...correlation, processNonce: observer.processNonce, runtimeId: pending.runtimeId, attemptId: pending.attemptId } };
    // The descriptor selector is closed: diagnostic expiry is not a selector.
    delete (descriptor.target as { expiresAt?: string }).expiresAt;
    const normal = await callNativeTool(service, APP_TOOL, { request }, { qualification: observer, controls });
    expect(normal._meta).not.toHaveProperty(QUALIFICATION_CONTROLS_META_KEY);
    await writeFile(join(root, "native-qualification-controls.json"), JSON.stringify(descriptor), { mode: 0o600 });
    service.app = vi.fn(async () => ({ status: "denied" as const, reason: "revoked" as const }));
    expect((await callNativeTool(service, APP_TOOL, { request }, { qualification: observer, controls }))._meta).not.toHaveProperty(QUALIFICATION_CONTROLS_META_KEY);
    service.app = fixture().app;
    expect((await callNativeTool(service, APP_TOOL, { request: { ...request, attemptId: "attempt-peer" } }, { qualification: observer, controls }))._meta).not.toHaveProperty(QUALIFICATION_CONTROLS_META_KEY);
    const granted = await callNativeTool(service, APP_TOOL, { request }, { qualification: observer, controls });
    expect(granted._meta?.[QUALIFICATION_CONTROLS_META_KEY]).toMatchObject({ action: "bridge-close", actionId: descriptor.actionId, target: descriptor.target, budget: 1 });
    expect(granted.content).toEqual([]); expect(granted.structuredContent).toBeUndefined();
    expect(JSON.stringify({ content: display.content, structuredContent: display.structuredContent })).not.toMatch(/actionId|processNonce|invocationNonce|capability|bridge-close/);
    expect(JSON.stringify({ content: granted.content, structuredContent: granted.structuredContent })).not.toMatch(/actionId|processNonce|invocationNonce|capability|bridge-close/);
    expect((await callNativeTool(service, APP_TOOL, { request }, { qualification: observer, controls }))._meta).not.toHaveProperty(QUALIFICATION_CONTROLS_META_KEY);
    expect(service.app).toHaveBeenCalledWith(request);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("preserves successful ordinary display and app replies when qualification controls throw", async () => {
  const { NativeQualificationControls } = await import("../../service/src/codex/native-qualification-controls.js");
  const { NativeQualificationObserver } = await import("../../service/src/codex/native-qualification.js");
  const root = await mkdtemp(join(tmpdir(), "native-control-failure-"));
  try {
    const service = fixture(), observer = new NativeQualificationObserver(root, "server"), controls = new NativeQualificationControls(root);
    vi.spyOn(controls, "remember").mockImplementation(() => { throw new Error("private control failure"); });
    vi.spyOn(controls, "shellGrant").mockImplementation(() => { throw new Error("private control failure"); });
    const normalDisplay = await callNativeTool(service, "display_review", { handoff: "h".repeat(43) });
    expect(await callNativeTool(service, "display_review", { handoff: "h".repeat(43) }, { qualification: observer, controls })).toEqual(normalDisplay);
    const normalApp = await callNativeTool(service, APP_TOOL, { request });
    expect(await callNativeTool(service, APP_TOOL, { request }, { qualification: observer, controls })).toEqual(normalApp);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("paired experiment replaces only closed public receipt and retains each original private invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-public-pair-"));
  try {
    const { NativeQualificationObserver } = await import("../../service/src/codex/native-qualification.js");
    const { NativeQualificationExperiments } = await import("../../service/src/codex/native-qualification-experiments.js");
    const runId = "8".repeat(32), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
    await writeFile(join(root, "native-qualification.json"), JSON.stringify({ version: 1, runId, salt: "s".repeat(43), observe: true, createdAt, expiresAt }), { mode: 0o600 });
    const one = new NativeQualificationObserver(root, "server"), two = new NativeQualificationObserver(root, "server");
    await writeFile(join(root, "native-qualification-experiments.json"), JSON.stringify({ version: 1, actionId: "7".repeat(32), action: "paired-public-result-exchange", createdAt, expiresAt, budget: 1, targets: [{ runId, processNonce: one.processNonce }, { runId, processNonce: two.processNonce }], rendezvousMs: 1000 }), { mode: 0o600 });
    const ownA = pending, ownB = { ...pending, receiptId: "receipt-2", attemptId: "attempt-2", runtimeId: "runtime-2", pendingCapability: "z".repeat(43) }, receiptB = { ...receipt, receiptId: ownB.receiptId, attemptId: ownB.attemptId };
    const serviceB = fixture(); serviceB.display = async () => ({ receipt: receiptB, pending: ownB });
    const results = await Promise.all([callNativeTool(fixture(), "display_review", { handoff: "h".repeat(43) }, { qualification: one, experiments: new NativeQualificationExperiments(root) }), callNativeTool(serviceB, "display_review", { handoff: "j".repeat(43) }, { qualification: two, experiments: new NativeQualificationExperiments(root) })]);
    expect(results.map(r => r.structuredContent)).toEqual([receiptB, receipt]);
    expect(results.map(r => r._meta?.[PENDING_META_KEY])).toEqual([ownA, ownB]);
    for (const r of results) {
      const model = JSON.stringify({ content: r.content, structuredContent: r.structuredContent });
      expect(model).not.toMatch(/pendingCapability|invocationNonce|_meta/); expect(model).not.toContain(ownA.pendingCapability); expect(model).not.toContain(ownB.pendingCapability);
      expect(Object.keys(r.structuredContent!).sort()).toEqual(Object.keys(receipt).sort());
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

import type { NativeQualificationOldAttempt } from "../../service/src/codex/native-qualification-old-attempt.js";
import { OLD_ATTEMPT_META_KEY } from "../src/old-attempt-contract.js";
it("delivers old-attempt grant only after own genuine active admission or successful authenticated renew and only privately", async () => {
  const grant = { version: 1, actionId: "a".repeat(32), action: "retire-own-attempt-then-probe-once", budget: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), target: { runId: "a".repeat(32), processNonce: "b".repeat(32), invocationNonce: "c".repeat(32), runtimeId: pending.runtimeId, attemptId: pending.attemptId } };
  const shellGrant = vi.fn(() => grant), oldAttempt = { shellGrant } as unknown as NativeQualificationOldAttempt, service = fixture();
  for (const method of ["ready", "status"]) {
    const result = await callNativeTool(service, APP_TOOL, { request: { ...request, method } }, { oldAttempt }); expect(result._meta?.[OLD_ATTEMPT_META_KEY]).toEqual(grant); expect(result.content).toEqual([]); expect(result.structuredContent).toBeUndefined();
  }
  service.app = vi.fn(async () => ({ status: "ok" as const, payload: {} }));
  const presentation = { ...request, authority: "presentation", capability: "a".repeat(43) };
  expect((await callNativeTool(service, APP_TOOL, { request: { ...presentation, method: "renew" } }, { oldAttempt }))._meta?.[OLD_ATTEMPT_META_KEY]).toEqual(grant);
  shellGrant.mockClear();
  for (const method of ["detach", "bootstrap", "watermark"]) expect((await callNativeTool(service, APP_TOOL, { request: { ...presentation, method } }, { oldAttempt }))._meta?.[OLD_ATTEMPT_META_KEY]).toBeUndefined();
  expect((await callNativeTool(service, APP_TOOL, { request }, { oldAttempt }))._meta?.[OLD_ATTEMPT_META_KEY]).toBeUndefined();
  service.app = vi.fn(async () => ({ status: "denied" as const, reason: "revoked" as const }));
  expect((await callNativeTool(service, APP_TOOL, { request: { ...presentation, method: "renew" } }, { oldAttempt }))._meta?.[OLD_ATTEMPT_META_KEY]).toBeUndefined(); expect(shellGrant).not.toHaveBeenCalled();
});
