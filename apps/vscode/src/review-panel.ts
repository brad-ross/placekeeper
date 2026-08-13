import type { LaunchErrorPresentation } from "./local-workspace.js";

export interface SuccessfulLaunch {
  readonly ok: true;
  readonly kind: "opened" | "focused";
  readonly url: string;
}

export type RecoveryDecision = "resume" | "discard" | "fork";

export interface RecoveryLaunch {
  readonly ok: true;
  readonly kind: "recovery-offered";
  readonly choices: readonly ["resume", "discard", "fork"];
  readonly recoverySessionId: string;
}

export interface FailedLaunch {
  readonly ok: false;
  readonly error: LaunchErrorPresentation;
}

export const reviewPanelOptions = Object.freeze({
  enableScripts: true,
  retainContextWhenHidden: false,
  localResourceRoots: [] as const,
});

function isSharedError(value: unknown): value is LaunchErrorPresentation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LaunchErrorPresentation>;
  return (
    (candidate.kind === "input-unavailable" || candidate.kind === "unsupported-context" || candidate.kind === "upgrade-required") &&
    typeof candidate.message === "string" &&
    candidate.message.length > 0 &&
    candidate.message.length <= 240 &&
    typeof candidate.recoveryAction === "string" &&
    candidate.recoveryAction.length > 0 &&
    candidate.recoveryAction.length <= 80
  );
}

function isScopedLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port.length > 0 &&
      /^\/s\/[^/]+\/bootstrap$/u.test(url.pathname) &&
      url.search === "?embed=vscode" &&
      /^#cap=[A-Za-z0-9_-]+$/u.test(url.hash) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function parseLaunchResponse(serialized: string): SuccessfulLaunch | RecoveryLaunch | FailedLaunch {
  if (Buffer.byteLength(serialized) > 65_536) {
    throw new Error("Launch response exceeded the output limit");
  }
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== "object" || value === null) {
    throw new Error("Launch client returned an invalid response");
  }
  const candidate = value as {
    readonly ok?: unknown;
    readonly kind?: unknown;
    readonly url?: unknown;
    readonly error?: unknown;
  };
  if (
    candidate.ok === true &&
    (candidate.kind === "opened" || candidate.kind === "focused") &&
    typeof candidate.url === "string"
  ) {
    if (!isScopedLoopbackUrl(candidate.url)) {
      throw new Error("Launch client did not return a scoped loopback URL");
    }
    return { ok: true, kind: candidate.kind, url: candidate.url };
  }
  const recovery = value as Partial<RecoveryLaunch>;
  if (
    recovery.ok === true &&
    recovery.kind === "recovery-offered" &&
    Array.isArray(recovery.choices) &&
    recovery.choices.length === 3 &&
    recovery.choices[0] === "resume" &&
    recovery.choices[1] === "discard" &&
    recovery.choices[2] === "fork" &&
    typeof recovery.recoverySessionId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(recovery.recoverySessionId)
  ) {
    return {
      ok: true,
      kind: "recovery-offered",
      choices: ["resume", "discard", "fork"],
      recoverySessionId: recovery.recoverySessionId,
    };
  }
  if (candidate.ok === false && isSharedError(candidate.error)) {
    return { ok: false, error: candidate.error };
  }
  throw new Error("Launch client returned an invalid response");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildReviewWebviewHtml(serviceUrl: string, nonce: string): string {
  if (!isScopedLoopbackUrl(serviceUrl)) throw new Error("A scoped loopback URL is required");
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(nonce)) throw new Error("A safe nonce is required");
  const origin = new URL(serviceUrl).origin;
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${nonce}">html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style></head>
<body><iframe id="review" title="Placekeeper" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
addEventListener('message', (event) => {
  if (event.data?.type !== 'launch-url' || typeof event.data.url !== 'string') return;
  try {
    const url = new URL(event.data.url);
    if (url.origin !== '${escapeAttribute(origin)}' || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.search !== '?embed=vscode' || !/^\\/s\\/[^/]+\\/bootstrap$/.test(url.pathname) || !/^#cap=[A-Za-z0-9_-]+$/.test(url.hash)) return;
    document.getElementById('review').src = url.href;
  } catch {}
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
