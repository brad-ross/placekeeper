import type { LaunchErrorPresentation } from "./local-workspace.js";

export interface SuccessfulLaunch {
  readonly ok: true;
  readonly kind: "opened" | "focused";
  /** Consumed only by the extension host; never copied into webview HTML or state. */
  readonly url: string;
}

export type RecoveryDecision = "resume" | "discard" | "fork";

export interface RecoveryLaunch {
  readonly ok: true;
  readonly kind: "recovery-offered";
  readonly choices: readonly ["resume", "discard", "fork"];
  readonly recoverySessionId: string;
  readonly recoveryOffer: { readonly id: string; readonly expiresAt: string };
}

export interface FailedLaunch { readonly ok: false; readonly error: LaunchErrorPresentation }

export function reviewPanelOptions(localResourceRoots: readonly unknown[]) {
  return Object.freeze({ enableScripts: true, retainContextWhenHidden: false, localResourceRoots });
}

function isSharedError(value: unknown): value is LaunchErrorPresentation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LaunchErrorPresentation>;
  return (
    (candidate.kind === "input-unavailable" || candidate.kind === "unsupported-context" || candidate.kind === "upgrade-required") &&
    typeof candidate.message === "string" && candidate.message.length > 0 && candidate.message.length <= 240 &&
    typeof candidate.recoveryAction === "string" && candidate.recoveryAction.length > 0 && candidate.recoveryAction.length <= 80
  );
}

export function isScopedLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port.length > 0 &&
      /^\/s\/[^/]+\/bootstrap$/u.test(url.pathname) && url.search === "?embed=vscode" &&
      /^#cap=[A-Za-z0-9_-]+$/u.test(url.hash) && url.username === "" && url.password === "";
  } catch { return false; }
}

export function parseLaunchResponse(serialized: string): SuccessfulLaunch | RecoveryLaunch | FailedLaunch {
  if (Buffer.byteLength(serialized) > 65_536) throw new Error("Launch response exceeded the output limit");
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== "object" || value === null) throw new Error("Launch client returned an invalid response");
  const candidate = value as { readonly ok?: unknown; readonly kind?: unknown; readonly url?: unknown; readonly error?: unknown };
  if (candidate.ok === true && (candidate.kind === "opened" || candidate.kind === "focused") && typeof candidate.url === "string") {
    if (!isScopedLoopbackUrl(candidate.url)) throw new Error("Launch client did not return a scoped loopback URL");
    return { ok: true, kind: candidate.kind, url: candidate.url };
  }
  const recovery = value as Partial<RecoveryLaunch>;
  if (recovery.ok === true && recovery.kind === "recovery-offered" && Array.isArray(recovery.choices) &&
    recovery.choices.length === 3 && recovery.choices[0] === "resume" && recovery.choices[1] === "discard" && recovery.choices[2] === "fork" &&
    typeof recovery.recoverySessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(recovery.recoverySessionId) &&
    typeof recovery.recoveryOffer === "object" && recovery.recoveryOffer !== null &&
    typeof recovery.recoveryOffer.id === "string" && /^[A-Za-z0-9_-]{16,128}$/u.test(recovery.recoveryOffer.id) &&
    typeof recovery.recoveryOffer.expiresAt === "string" && Number.isFinite(Date.parse(recovery.recoveryOffer.expiresAt))) {
    return { ok: true, kind: "recovery-offered", choices: ["resume", "discard", "fork"],
      recoverySessionId: recovery.recoverySessionId, recoveryOffer: recovery.recoveryOffer };
  }
  if (candidate.ok === false && isSharedError(candidate.error)) return { ok: false, error: candidate.error };
  throw new Error("Launch client returned an invalid response");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export interface ReviewWebviewHtmlOptions {
  readonly nonce: string;
  readonly panelId: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly cspSource: string;
}

export interface SharedAssetManifest {
  readonly schemaVersion: 1;
  readonly app: string;
  readonly stylesheet: string;
  readonly pdfiumWasm: string;
}

export function parseSharedAssetManifest(value: unknown): SharedAssetManifest {
  if (typeof value !== "object" || value === null) throw new Error("The shared asset manifest is invalid");
  const candidate = value as Partial<SharedAssetManifest>;
  const safeAsset = (asset: unknown) => typeof asset === "string" && /^[A-Za-z0-9._-]+$/u.test(asset);
  if (candidate.schemaVersion !== 1 || !safeAsset(candidate.app) ||
    !safeAsset(candidate.stylesheet) || !safeAsset(candidate.pdfiumWasm)) {
    throw new Error("The shared asset manifest is invalid");
  }
  return candidate as SharedAssetManifest;
}

export function buildReviewWebviewHtml(options: ReviewWebviewHtmlOptions): string {
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(options.nonce)) throw new Error("A safe nonce is required");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(options.panelId)) throw new Error("A safe panel identity is required");
  const extensionResource = (uri: string) => uri.startsWith("vscode-webview://") ||
    /^https:\/\/[^/\s]+\.vscode-cdn\.net(?:\/|$)/u.test(uri);
  for (const uri of [options.scriptUri, options.styleUri]) {
    if (!extensionResource(uri)) throw new Error("Only extension-issued webview resources are allowed");
  }
  if (!extensionResource(options.cspSource) && !/^https:\/\/\*\.vscode-cdn\.net$/u.test(options.cspSource)) {
    throw new Error("Only the webview CSP source is allowed");
  }
  const nonce = escapeHtml(options.nonce);
  const csp = escapeHtml(options.cspSource);
  const panelId = JSON.stringify(options.panelId).replaceAll("<", "\\u003c");
  const scriptUri = JSON.stringify(options.scriptUri).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src ${csp}; img-src blob: data: ${csp}; font-src ${csp}; style-src ${csp} 'nonce-${nonce}' 'unsafe-inline'; script-src ${csp} 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:;">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
<title>Placekeeper</title></head><body><div id="root"></div>
<script type="module" nonce="${nonce}">
const vscode = acquireVsCodeApi();
const app = await import(${scriptUri});
await app.startVscode({ panelId: ${panelId}, vscode });
</script></body></html>`;
}
