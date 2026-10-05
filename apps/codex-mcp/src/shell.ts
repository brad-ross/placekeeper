import { OLD_ATTEMPT_META_KEY } from "./old-attempt-contract.js";
import { ShellOldAttempt } from "./shell-old-attempt.js";
import { QUALIFICATION_CONTROLS_META_KEY } from "./qualification-controls-contract.js";
import { ShellQualificationControls } from "./shell-qualification-controls.js";
import { App } from "@modelcontextprotocol/ext-apps";
import { parseCodexDisplayReceipt, parseCodexPendingPresentation, type CodexAppRequest, type CodexAppResponse, type CodexPendingPresentation } from "../../../packages/core/src/codex-mcp-protocol.js";
import { APP_TOOL, PENDING_META_KEY, QUALIFICATION_META_KEY } from "./transport-contract.js";
import { ResourceAllocationError, VerifiedResourceMaterializer, resourceDescriptors } from "./resources.js";
import { deniedFailure, diagnosticFailure, LifecycleDiagnostics, NativeDiagnosticError, verifiedAppReply } from "./lifecycle-diagnostics.js";

const app = new App({ name: "Placekeeper", version: "1.0.0" });
const status = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
let traceStorage: Storage | undefined;
try { traceStorage = window.sessionStorage; } catch { /* Sandboxed hosts may disable storage. */ }
const qualificationControls = new ShellQualificationControls();
let qualificationButton: HTMLButtonElement | undefined;
let oldAttemptButton: HTMLButtonElement | undefined;
let admissionOldGrant: unknown;
let retiredOwnInvocation = false;
const oldAttempt = new ShellOldAttempt(Date.now, () => { renderOldAttemptButton(); renderDiagnostics(); });
let qualificationExpiry: ReturnType<typeof setTimeout> | undefined;
const diagnostics = new LifecycleDiagnostics(crypto.randomUUID(), () => new Date(), traceStorage);
const diagnosticView = document.createElement("pre");
diagnosticView.setAttribute("aria-label", "Native lifecycle qualification diagnostics");
detail.before(diagnosticView);
function renderDiagnostics() { diagnosticView.textContent = JSON.stringify({ ...diagnostics.snapshot(), ...(oldAttempt.snapshot() === undefined ? {} : { oldAttempt: oldAttempt.snapshot() }), ...(qualificationControls.snapshot() === undefined ? {} : { control: qualificationControls.snapshot() }) }, null, 2); }
function recordDiagnostic(...args: Parameters<LifecycleDiagnostics["record"]>) { diagnostics.record(...args); renderDiagnostics(); }
renderDiagnostics();
let incarnation = 0;
const documentMaterializer = new VerifiedResourceMaterializer();
let pending: CodexPendingPresentation | undefined;
let active: Extract<CodexAppResponse, { status: "active" }> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let renewal: ReturnType<typeof setTimeout> | undefined;
let lastRenewal = "never";
function stop(preserveRetirement = false) {
  if (!preserveRetirement) { oldAttempt.clear(); admissionOldGrant = undefined; }
  else { retiredOwnInvocation = true; pending = undefined; admissionOldGrant = undefined; }
  qualificationControls.clear(); qualificationButton?.remove(); qualificationButton = undefined;
  if (qualificationExpiry !== undefined) clearTimeout(qualificationExpiry);
  incarnation++; documentMaterializer.clear();
  if (timer !== undefined) clearTimeout(timer);
  if (renewal !== undefined) clearTimeout(renewal);
  active = undefined; detail.textContent = "";
}
function display(text: string) { status.textContent = text; }
async function call(request: CodexAppRequest, attempt: number): Promise<CodexAppResponse> {
  let result;
  try { result = await app.callServerTool({ name: APP_TOOL, arguments: { request } }); }
  catch { throw new NativeDiagnosticError("transport"); }
  if (attempt !== incarnation) throw new NativeDiagnosticError("stale-reply");
  const response = verifiedAppReply(result);
  if (response.status !== "denied") armQualificationControl(result._meta?.[QUALIFICATION_CONTROLS_META_KEY]);
  if (response.status === "active") admissionOldGrant = result._meta?.[OLD_ATTEMPT_META_KEY];
  else if (request.authority === "presentation" && request.method === "renew" && response.status === "ok") armOldAttempt(result._meta?.[OLD_ATTEMPT_META_KEY]);
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
  if (response.status === "denied") throw deniedFailure(response.reason);
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
  recordDiagnostic("verified");
  display("Verified native review context. U3 qualification shell; production reader qualification is pending.");
}
/** Runs regardless of visibility. Actual hidden-panel delivery is an installed-host gate. */
async function renew(attempt: number) {
  try { await payload("renew", {}, attempt); if (attempt !== incarnation) return; lastRenewal = new Date().toISOString(); document.querySelector<HTMLElement>("#renewal")!.textContent = `Last authenticated panel renewal: ${lastRenewal}`; recordDiagnostic("renewed"); }
  catch (error) { if (attempt === incarnation) { recordDiagnostic("failed", { failure: diagnosticFailure(error) }); stop(); display("Reconnect: the native connection ended. Accepted work remains recoverable. Ask this chat to reconnect Placekeeper using a fresh native launch."); } return; }
  if (attempt === incarnation) renewal = setTimeout(() => void renew(attempt), 5_000);
}
async function poll(attempt: number, previous?: number) {
  try {
    const response = await payload("watermark", {}, attempt) as { watermark: number };
    if (response.watermark !== previous) await bootstrap(attempt);
    if (attempt === incarnation) timer = setTimeout(() => void poll(attempt, response.watermark), document.hidden ? 5_000 : 1_000);
  } catch (error) { if (attempt === incarnation) { recordDiagnostic("failed", { failure: diagnosticFailure(error) }); stop(); display(error instanceof ResourceAllocationError ? "The host could not allocate memory for this document. Close other panels and reopen the PDF; accepted work remains recoverable." : "Reconnect: current review cannot be verified. Accepted work remains recoverable. Ask this chat to reconnect Placekeeper using a fresh native launch."); } }
}
async function admit(attempt: number, method: PendingRequest["method"] = "ready") {
  try {
    if (method === "ready") { recordDiagnostic("ready"); }
    const response = await call(pendingEnvelope(method), attempt);
    if (response.status === "pending") { recordDiagnostic("pending"); display("Waiting for trusted display hook verification…"); timer = setTimeout(() => void admit(attempt, "status"), 1_000); return; }
    if (response.status === "denied") throw deniedFailure(response.reason);
    if (response.status !== "active") throw new NativeDiagnosticError("unexpected-status");
    if (response.runtimeId !== pending?.runtimeId || response.attemptId !== pending.attemptId || response.generation !== pending.generation) throw new NativeDiagnosticError("incarnation-mismatch");
    active = response; armOldAttempt(admissionOldGrant); admissionOldGrant = undefined; recordDiagnostic("active"); void renew(attempt); void poll(attempt);
  } catch (error) { if (attempt === incarnation) { recordDiagnostic("failed", { failure: diagnosticFailure(error) }); stop(); display("Reconnect: this invocation can no longer establish a native connection. Accepted work remains recoverable. Ask this chat to reconnect Placekeeper using a fresh native launch. If a fresh launch also fails, check the matching plugin hooks and MCP server."); } }
}
function ownQualificationTarget() {
  const correlation = diagnostics.snapshot().qualification;
  return pending === undefined || correlation === undefined ? undefined : { runId: correlation.runId, invocationNonce: correlation.invocationNonce, runtimeId: pending.runtimeId, attemptId: pending.attemptId };
}
function armQualificationControl(value: unknown) {
  const own = ownQualificationTarget();
  if (own === undefined || !qualificationControls.arm(value, own)) return;
  const grant = qualificationControls.available(own);
  if (grant === undefined) return;
  qualificationButton = document.createElement("button");
  qualificationButton.textContent = grant.action === "request-teardown" ? "Qualification: request this panel teardown" : "Qualification: close this panel bridge";
  detail.before(qualificationButton);
  qualificationButton.onclick = async () => {
    const target = ownQualificationTarget();
    qualificationButton?.remove(); qualificationButton = undefined;
    if (target === undefined) { qualificationControls.clear(); return; }
    await qualificationControls.execute(target, app, () => { stop(); document.querySelector<HTMLElement>("#renewal")!.textContent = "Authenticated panel renewal stopped."; display("Reconnect: this panel bridge was closed for qualification. Accepted work remains recoverable. Ask this chat to reconnect Placekeeper using a fresh native launch."); });
    renderDiagnostics();
  };
  qualificationExpiry = setTimeout(() => { qualificationControls.available(own); qualificationButton?.remove(); qualificationButton = undefined; renderDiagnostics(); }, Math.max(0, Date.parse(grant.expiresAt) - Date.now()));
  renderDiagnostics();
}
const oldAttemptSdk = { call: (request: CodexAppRequest, options: { signal: AbortSignal; timeout: number; maxTotalTimeout: number }) => app.callServerTool({ name: APP_TOOL, arguments: { request } }, options) };
function armOldAttempt(value: unknown) {
  const own = ownQualificationTarget();
  if (own !== undefined && active !== undefined) oldAttempt.arm(value, own, active);
}
function renderOldAttemptButton() {
  const phase = oldAttempt.snapshot()?.phase;
  if (phase === "retired") display("Qualification: this own attempt is retired. Verify a real fresh successor before the explicit old-attempt probe.");
  else if (phase === "completed") display("Qualification: old-attempt requests completed. Review the sanitized denial outcomes; unexpected success does not pass.");
  else if (phase === "failed" || phase === "expired") display("Qualification: old-attempt probe failed, timed out or expired. Private authority was discarded; no retry is available.");
  oldAttemptButton?.remove(); oldAttemptButton = undefined;
  const retire = oldAttempt.canRetire(), probe = oldAttempt.canProbe();
  if (!retire && !probe) return;
  const button = document.createElement("button"); oldAttemptButton = button;
  button.textContent = retire ? "Qualification: retire this own attempt" : "Qualification: probe old attempt once after verified successor";
  detail.before(button);
  button.onclick = async () => {
    // Recheck controller phase on every explicit click; stale DOM handlers have no budget.
    if (retire) {
      const own = ownQualificationTarget();
      if (own === undefined || active === undefined) { oldAttempt.clear(); return; }
      await oldAttempt.retire(own, active, oldAttemptSdk, () => {
        stop(true); document.querySelector<HTMLElement>("#renewal")!.textContent = "Authenticated panel renewal stopped.";
        display("Qualification: this attempt is retiring. Keep the original bridge open; verify a real successor before probing.");
      });
    } else await oldAttempt.probe(oldAttemptSdk);
    renderOldAttemptButton(); renderDiagnostics();
  };
}
app.ontoolresult = (result) => {
  if (retiredOwnInvocation) {
    oldAttempt.clear("unsupported");
    display("Qualification unsupported: the host reused the retired shell for another invocation. Its old authority was discarded; reopen through a fresh owning shell.");
    return;
  }
  const next = parseCodexPendingPresentation(result._meta?.[PENDING_META_KEY]), receipt = parseCodexDisplayReceipt(result.structuredContent);
  if (next === undefined || receipt === undefined || next.receiptId !== receipt.receiptId || next.attemptId !== receipt.attemptId || next.generation !== receipt.generation) { display("No verified invocation data. Reopen through the installed Placekeeper skill."); return; }
  if (pending !== undefined) { display("This panel already has an invocation. Reopen to start a new presentation."); return; }
  diagnostics.observeInvocation(result._meta?.[QUALIFICATION_META_KEY]);
  pending = next; recordDiagnostic("invocation"); const attempt = ++incarnation; void admit(attempt);
};
app.onteardown = async () => { oldAttempt.clear("unsupported"); recordDiagnostic("teardown"); const previous = active, attempt = incarnation; if (previous !== undefined) await payload("detach", {}, attempt).catch(() => undefined); stop(); return {}; };
function requestMode(mode: "inline" | "fullscreen") { recordDiagnostic("mode-request", { mode }); void app.requestDisplayMode({ mode }).then((result) => { recordDiagnostic("mode-confirmed", { mode: result.mode }); }).catch(() => { renderDiagnostics(); display(mode === "fullscreen" ? "Expanded presentation unavailable in this host." : "Inline presentation unavailable in this host."); }); }
document.querySelector<HTMLButtonElement>("#expand")!.onclick = () => requestMode("fullscreen");
document.querySelector<HTMLButtonElement>("#restore")!.onclick = () => requestMode("inline");
app.onhostcontextchanged = (context) => { if (context.displayMode !== undefined) { recordDiagnostic("mode-confirmed", { mode: context.displayMode }); } };
app.onclose = () => { oldAttempt.clear("unsupported"); stop(); display("Reconnect: the original native bridge disconnected. The old-attempt probe is unsupported; accepted work remains recoverable."); };
app.onerror = () => { if (!["armed", "retiring", "retired", "probing"].includes(oldAttempt.snapshot()?.phase ?? "")) return; oldAttempt.clear("unsupported"); stop(); display("Reconnect: the native bridge cannot be verified. The old-attempt probe is unsupported; accepted work remains recoverable."); };
void app.connect().then(() => { recordDiagnostic("connected"); }).catch(() => { oldAttempt.clear("unsupported"); recordDiagnostic("failed", { failure: "transport" }); display("This host cannot connect the Placekeeper native app. Enable the plugin, reload Codex, and reopen the PDF."); });
