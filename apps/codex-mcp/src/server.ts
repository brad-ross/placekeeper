import { NativeQualificationOldAttempt } from "../../service/src/codex/native-qualification-old-attempt.js";
import { OLD_ATTEMPT_META_KEY, type OldAttemptGrant } from "./old-attempt-contract.js";
import { NativeQualificationExperiments } from "../../service/src/codex/native-qualification-experiments.js";
import { NativeQualificationControls } from "../../service/src/codex/native-qualification-controls.js";
import { QUALIFICATION_CONTROLS_META_KEY, type QualificationControlGrant } from "./qualification-controls-contract.js";
import { NativeQualificationObserver } from "../../service/src/codex/native-qualification.js";
import { defaultDaemonPaths } from "../../service/src/host/service-daemon.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { CODEX_MAX_ENCODED_RESPONSE_BYTES, CODEX_REVIEW_UI_RESOURCE, parseCodexAppRequest, parseCodexDisplayRequest } from "../../../packages/core/src/codex-mcp-protocol.js";
import { createServiceClient, type NativeServiceClient } from "./service-client.js";

import { APP_TOOL, PENDING_META_KEY, RESPONSE_META_KEY, QUALIFICATION_META_KEY } from "./transport-contract.js";
const unavailable = (): CallToolResult => ({ isError: true, content: [{ type: "text", text: "Placekeeper native integration is unavailable. Check that the installed app and plugin versions match, enable the plugin MCP server and hooks, reload Codex, then reopen the PDF." }] });
export const nativeTools: Tool[] = [
  { name: "display_review", description: "Open the native Placekeeper panel for an installed launch handoff. Returns pending display correlation only; trusted hooks establish chat authority.", inputSchema: { type: "object", additionalProperties: false, required: ["handoff"], properties: { handoff: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } } }, _meta: { ui: { resourceUri: CODEX_REVIEW_UI_RESOURCE, visibility: ["model"] } } },
  { name: APP_TOOL, description: "Private native panel protocol. No independent document or task selection.", inputSchema: { type: "object", additionalProperties: false, required: ["request"], properties: { request: { type: "object" } } }, _meta: { ui: { visibility: ["app"] } } },
];
export interface NativeQualificationDependencies {
  qualification?: NativeQualificationObserver;
  controls?: NativeQualificationControls;
  oldAttempt?: NativeQualificationOldAttempt;
  experiments?: NativeQualificationExperiments;
}
/** Private data is never projected into content or structuredContent, including errors. */
export async function callNativeTool(client: NativeServiceClient, name: string, args: unknown, dependencies: NativeQualificationDependencies = {}): Promise<CallToolResult> {
  const { qualification, controls, experiments, oldAttempt } = dependencies;
  try {
    if (name === "display_review") {
      const request = parseCodexDisplayRequest(args);
      if (request === undefined) return unavailable();
      const { receipt, pending } = await client.display(request);
      const invocation = qualification?.invocation({ runtimeId: pending.runtimeId, attemptId: pending.attemptId, receiptId: pending.receiptId, generation: pending.generation, envelope: JSON.stringify(pending) });
      try { if (qualification !== undefined) { controls?.remember(invocation, pending.runtimeId, pending.attemptId, qualification.processNonce); oldAttempt?.remember(invocation, pending.runtimeId, pending.attemptId, qualification.processNonce); } }
      catch { /* Qualification controls cannot change a successful display. */ }
      const publicReceipt = qualification === undefined ? receipt : await experiments?.publicResult(receipt, invocation, qualification.processNonce, qualification) ?? receipt;
      return { content: [{ type: "text", text: "Placekeeper native presentation is pending trusted chat verification." }], structuredContent: { ...publicReceipt }, _meta: { [PENDING_META_KEY]: pending, ...(invocation === undefined ? {} : { [QUALIFICATION_META_KEY]: invocation }) } };
    }
    if (name === APP_TOOL && typeof args === "object" && args !== null && Object.keys(args).length === 1 && Object.hasOwn(args, "request")) {
      const request = parseCodexAppRequest((args as { request: unknown }).request);
      if (request === undefined) return unavailable();
      const response = await client.app(request);
      let grant: QualificationControlGrant | undefined;
      try { if (response.status === "active" || response.status === "ok") grant = controls?.shellGrant(request.runtimeId, request.attemptId); }
      catch { /* Controls fail closed while the ordinary service reply survives. */ }
      let oldGrant: OldAttemptGrant | undefined;
      try {
        if ((request.authority === "pending" && (request.method === "ready" || request.method === "status") && response.status === "active" && response.runtimeId === request.runtimeId && response.attemptId === request.attemptId && response.generation === request.generation) ||
          (request.authority === "presentation" && request.method === "renew" && response.status === "ok")) oldGrant = oldAttempt?.shellGrant(request.runtimeId, request.attemptId);
      } catch { /* Separate qualification injection cannot affect the service response. */ }
      const result: CallToolResult = { content: [], _meta: { [RESPONSE_META_KEY]: response, ...(oldGrant === undefined ? {} : { [OLD_ATTEMPT_META_KEY]: oldGrant }), ...(grant === undefined ? {} : { [QUALIFICATION_CONTROLS_META_KEY]: grant }) } };
      const bounded = Buffer.byteLength(JSON.stringify(result)) <= CODEX_MAX_ENCODED_RESPONSE_BYTES ? result : unavailable();
      qualification?.record("app-result", { runtimeId: request.runtimeId, attemptId: request.attemptId, generation: request.generation, method: request.method, status: response.status, uiResource: typeof bounded._meta?.ui === "object" && bounded._meta.ui !== null && "resourceUri" in bounded._meta.ui, privateMetadata: bounded._meta !== undefined, contentCount: bounded.content.length, structuredKeyCount: Object.keys(bounded.structuredContent ?? {}).length });
      return bounded;
    }
  } catch { /* Never expose socket errors, paths, or capability-bearing responses. */ }
  return unavailable();
}
export function createNativeServer(client: NativeServiceClient, shell: string, dependencies: NativeQualificationDependencies = {}): Server {
  const server = new Server({ name: "placekeeper", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: nativeTools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!getUiCapability({ extensions: server.getClientCapabilities()?.extensions ?? {} })?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) return unavailable();
    return callNativeTool(client, params.name, params.arguments, dependencies);
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
  await createNativeServer(createServiceClient(), shell, {
    qualification: new NativeQualificationObserver(defaultDaemonPaths().appSupportRoot, "server"),
    oldAttempt: new NativeQualificationOldAttempt(defaultDaemonPaths().appSupportRoot),
    controls: new NativeQualificationControls(defaultDaemonPaths().appSupportRoot),
    experiments: new NativeQualificationExperiments(defaultDaemonPaths().appSupportRoot),
  }).connect(new StdioServerTransport());
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startStdioServer().catch(() => { process.stderr.write("Placekeeper MCP failed to initialize; reinstall the matching app and plugin.\n"); process.exitCode = 1; });
}
