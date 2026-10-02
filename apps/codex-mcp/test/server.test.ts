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
