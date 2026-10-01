import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CODEX_MAX_ENCODED_RESPONSE_BYTES, CODEX_REVIEW_UI_RESOURCE, parseCodexAppRequest, parseCodexDisplayRequest } from "../../../packages/core/src/codex-mcp-protocol.js";
import { createServiceClient, type NativeServiceClient } from "./service-client.js";

import { APP_TOOL, PENDING_META_KEY, RESPONSE_META_KEY } from "./transport-contract.js";
const unavailable = (): CallToolResult => ({ isError: true, content: [{ type: "text", text: "Placekeeper native integration is unavailable. Check that the installed app and plugin versions match, enable the plugin MCP server and hooks, reload Codex, then reopen the PDF." }] });
export const nativeTools: Tool[] = [
  { name: "display_review", description: "Open the native Placekeeper panel for an installed launch handoff. Returns pending display correlation only; trusted hooks establish chat authority.", inputSchema: { type: "object", additionalProperties: false, required: ["handoff"], properties: { handoff: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } } }, _meta: { ui: { resourceUri: CODEX_REVIEW_UI_RESOURCE, visibility: ["model"] } } },
  { name: APP_TOOL, description: "Private native panel protocol. No independent document or task selection.", inputSchema: { type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "object" } } }, _meta: { ui: { visibility: ["app"] } } },
];
/** Private data is never projected into content or structuredContent, including errors. */
export async function callNativeTool(client: NativeServiceClient, name: string, args: unknown): Promise<CallToolResult> {
  try {
    if (name === "display_review") {
      const request = parseCodexDisplayRequest(args);
      if (request === undefined) return unavailable();
      const { receipt, pending } = await client.display(request);
      return { content: [{ type: "text", text: "Placekeeper native presentation is pending trusted chat verification." }], structuredContent: { ...receipt }, _meta: { [PENDING_META_KEY]: pending } };
    }
    if (name === APP_TOOL && typeof args === "object" && args !== null && Object.keys(args).length === 1 && Object.hasOwn(args, "request")) {
      const request = parseCodexAppRequest((args as { request: unknown }).request);
      if (request === undefined) return unavailable();
      const response = await client.app(request);
      const result: CallToolResult = { content: [], _meta: { [RESPONSE_META_KEY]: response } };
      return Buffer.byteLength(JSON.stringify(result)) <= CODEX_MAX_ENCODED_RESPONSE_BYTES ? result : unavailable();
    }
  } catch { /* Never expose socket errors, paths, or capability-bearing responses. */ }
  return unavailable();
}
export function createNativeServer(client: NativeServiceClient, shell: string): Server {
  const server = new Server({ name: "placekeeper", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: nativeTools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!getUiCapability({ extensions: server.getClientCapabilities()?.extensions ?? {} })?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) return unavailable();
    return callNativeTool(client, params.name, params.arguments);
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: CODEX_REVIEW_UI_RESOURCE, name: "Placekeeper review v1", mimeType: RESOURCE_MIME_TYPE }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== CODEX_REVIEW_UI_RESOURCE) throw new Error("Unknown resource");
    return { contents: [{ uri: CODEX_REVIEW_UI_RESOURCE, mimeType: RESOURCE_MIME_TYPE, text: shell, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] };
  });
  return server;
}
export async function startStdioServer(): Promise<void> {
  const shell = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "review-v1.html"), "utf8");
  await createNativeServer(createServiceClient(), shell).connect(new StdioServerTransport());
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startStdioServer().catch(() => { process.stderr.write("Placekeeper MCP failed to initialize; reinstall the matching app and plugin.\n"); process.exitCode = 1; });
}
