import { App } from "@modelcontextprotocol/ext-apps";
import { parseCodexAppResponse, parseCodexDisplayReceipt, parseCodexPendingPresentation, type CodexAppRequest, type CodexAppResponse, type CodexPendingPresentation } from "../../../packages/core/src/codex-mcp-protocol.js";
import { APP_TOOL, PENDING_META_KEY, RESPONSE_META_KEY } from "./transport-contract.js";
import { ResourceAllocationError, VerifiedResourceMaterializer, resourceDescriptors } from "./resources.js";

const app = new App({ name: "Placekeeper", version: "1.0.0" });
const status = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
let incarnation = 0;
const documentMaterializer = new VerifiedResourceMaterializer();
let pending: CodexPendingPresentation | undefined;
let active: Extract<CodexAppResponse, { status: "active" }> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let renewal: ReturnType<typeof setTimeout> | undefined;
let lastRenewal = "never";
function stop() { incarnation++; documentMaterializer.clear(); if (timer !== undefined) clearTimeout(timer); if (renewal !== undefined) clearTimeout(renewal); active = undefined; }
function display(text: string) { status.textContent = text; }
async function call(request: CodexAppRequest, attempt: number): Promise<CodexAppResponse> {
  const result = await app.callServerTool({ name: APP_TOOL, arguments: { request } });
  const response = parseCodexAppResponse(result._meta?.[RESPONSE_META_KEY]);
  if (attempt !== incarnation || response === undefined) throw new Error("Unverified or stale native reply");
  return response;
}
type PendingRequest = Extract<CodexAppRequest, { authority: "pending" }>;
type PresentationRequest = Extract<CodexAppRequest, { authority: "presentation" }>;
function envelopeIdentity(identity: Pick<CodexAppRequest, "runtimeId" | "attemptId" | "generation">) {
  return { protocolVersion: 1 as const, runtimeId: identity.runtimeId, attemptId: identity.attemptId, generation: identity.generation, requestId: crypto.randomUUID() };
}
function pendingEnvelope(method: PendingRequest["method"]): PendingRequest {
  if (pending === undefined) throw new Error("No native presentation");
  return { ...envelopeIdentity(pending), authority: "pending", method, payload: {}, capability: pending.pendingCapability };
}
function presentationEnvelope(method: PresentationRequest["method"], value: unknown = {}): PresentationRequest {
  if (active === undefined) throw new Error("No native presentation");
  return { ...envelopeIdentity(active), authority: "presentation", method, payload: value, capability: active.presentationCapability };
}
async function payload(method: PresentationRequest["method"], value: unknown = {}, attempt = incarnation): Promise<unknown> {
  const response = await call(presentationEnvelope(method, value), attempt);
  if (response.status !== "ok") throw new Error(`Native request ${response.status}`);
  return response.payload;
}
async function bootstrap(attempt: number) {
  const result = await payload("bootstrap", {}, attempt) as Record<string, unknown>;
  const descriptors = resourceDescriptors(result.resourceDescriptors);
  if (descriptors === undefined) throw new Error("Unverified document manifest");
  const bytes = await documentMaterializer.materialize(attempt, descriptors.document, (offset, length) => payload("resource", { handle: descriptors.document.handle, offset, length }, attempt), { current: () => incarnation === attempt, digest: async (data) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map((byte) => byte.toString(16).padStart(2, "0")).join("") });
  if (attempt !== incarnation) return;
  detail.textContent = JSON.stringify({ generation: result.generation, revision: result.revision, reviewState: result.state, saveSync: result.saveStatus, protected: result.protected, document: { byteLength: bytes.length, sha256: descriptors.document.sha256 }, lastRenewal }, null, 2);
  display("Verified native review context. U3 qualification shell; production reader qualification is pending.");
}
/** Runs regardless of visibility. Actual hidden-panel delivery is an installed-host gate. */
async function renew(attempt: number) {
  try { await payload("renew", {}, attempt); lastRenewal = new Date().toISOString(); document.querySelector<HTMLElement>("#renewal")!.textContent = `Last authenticated panel renewal: ${lastRenewal}`; }
  catch { if (attempt === incarnation) { stop(); display("Native participation disconnected. Reopen this PDF to restore verified context."); } return; }
  if (attempt === incarnation) renewal = setTimeout(() => void renew(attempt), 5_000);
}
async function poll(attempt: number, previous?: number) {
  try {
    const response = await payload("watermark", {}, attempt) as { watermark: number };
    if (response.watermark !== previous) await bootstrap(attempt);
    if (attempt === incarnation) timer = setTimeout(() => void poll(attempt, response.watermark), document.hidden ? 5_000 : 1_000);
  } catch (error) { if (attempt === incarnation) { stop(); display(error instanceof ResourceAllocationError ? "The host could not allocate memory for this document. Close other panels and reopen the PDF; accepted work remains recoverable." : "Current review cannot be verified. Reopen the PDF; accepted work remains recoverable."); } }
}
async function admit(attempt: number, method: PendingRequest["method"] = "ready") {
  try {
    const response = await call(pendingEnvelope(method), attempt);
    if (response.status === "pending") { display("Waiting for trusted display hook verification…"); timer = setTimeout(() => void admit(attempt, "status"), 1_000); return; }
    if (response.status !== "active") throw new Error("Admission denied");
    if (response.runtimeId !== pending?.runtimeId || response.attemptId !== pending.attemptId || response.generation !== pending.generation) throw new Error("Mismatched native incarnation");
    active = response; void renew(attempt); void poll(attempt);
  } catch { if (attempt === incarnation) { stop(); display("Native admission unavailable. Enable the matching Placekeeper hooks and MCP server, reload Codex, and reopen this PDF."); } }
}
app.ontoolresult = (result) => {
  const next = parseCodexPendingPresentation(result._meta?.[PENDING_META_KEY]), receipt = parseCodexDisplayReceipt(result.structuredContent);
  if (next === undefined || receipt === undefined || next.receiptId !== receipt.receiptId || next.attemptId !== receipt.attemptId || next.generation !== receipt.generation) { display("No verified invocation data. Reopen through the installed Placekeeper skill."); return; }
  if (pending !== undefined) { display("This panel already has an invocation. Reopen to start a new presentation."); return; }
  pending = next; const attempt = ++incarnation; void admit(attempt);
};
app.onteardown = async () => { const previous = active, attempt = incarnation; if (previous !== undefined) await payload("detach", {}, attempt).catch(() => undefined); stop(); return {}; };
document.querySelector<HTMLButtonElement>("#expand")!.onclick = () => { void app.requestDisplayMode({ mode: "fullscreen" }).catch(() => display("Expanded presentation unavailable in this host.")); };
document.querySelector<HTMLButtonElement>("#restore")!.onclick = () => { void app.requestDisplayMode({ mode: "inline" }).catch(() => display("Inline presentation unavailable in this host.")); };
void app.connect().catch(() => display("This host cannot connect the Placekeeper native app. Enable the plugin, reload Codex, and reopen the PDF."));
