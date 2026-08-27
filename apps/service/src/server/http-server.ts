import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join } from "node:path";
import {
  RESTRICTIVE_CSP,
  validateRequestSecurity,
} from "../../../../packages/core/src/session-security.js";
import type { ReviewCommand } from "../../../../packages/core/src/review-model.js";
import { InvalidReviewCommandError } from "../../../../packages/core/src/review-reducer.js";
import { isContained } from "../files/file-capabilities.js";
import {
  isRecoveryDecision,
  RecoveryOfferUnavailableError,
  type RecoveryOfferIdentity,
  type SessionBroker,
} from "../sessions/session-broker.js";
import type { PdfSaveCoordinator } from "../saving/pdf-save-coordinator.js";
import type { DaemonLifecycleCoordinator } from "../host/daemon-lifecycle.js";
import { ExportCoordinatorError, type ExportCoordinator } from "../export/export-coordinator.js";
import { openPlacekeeperLink, parsePlacekeeperReadableViewRoute } from "../links/placekeeper-link.js";

const MAX_BODY_BYTES = 256 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const VIEW_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECOVERY_ID = /^[A-Za-z0-9_-]{16,128}$/u;

function recoveryOfferIdentity(value: unknown): RecoveryOfferIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "expiresAt" || keys[1] !== "id") return undefined;
  return typeof record.id === "string" && RECOVERY_ID.test(record.id) &&
      typeof record.expiresAt === "string" && Number.isFinite(Date.parse(record.expiresAt))
    ? { id: record.id, expiresAt: record.expiresAt }
    : undefined;
}

/** Stable packaged-daemon browser origin. Direct hosts and tests default to port 0. */
export const PLACEKEEPER_HTTP_PORT = 43_179;

function setBaseHeaders(
  response: ServerResponse,
  csp = RESTRICTIVE_CSP,
  embeddable = false,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (embeddable) response.removeHeader("X-Frame-Options");
  else response.setHeader("X-Frame-Options", "DENY");
}

function send(
  response: ServerResponse,
  status: number,
  body = "",
  contentType = "text/plain; charset=utf-8",
  csp?: string,
  embeddable = false,
): void {
  setBaseHeaders(response, csp, embeddable);
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function publicSaveStatus(status: ReturnType<SessionBroker["saveStatus"]>): unknown {
  if (status === undefined) return undefined;
  const destination = status.destination.phase === "active"
    ? {
        phase: status.destination.phase,
        generation: status.destination.generation,
        kind: status.destination.kind,
        targetPath: status.destination.targetPath,
      }
    : status.destination;
  return {
    destination,
    rewriteEligibility: status.rewriteEligibility,
    sync: {
      phase: status.sync.phase,
      desiredRevision: status.sync.desiredRevision,
      savedRevision: status.sync.savedRevision,
      ...(status.sync.failure === undefined ? {} : { failure: status.sync.failure }),
    },
  };
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > maxBodyBytes) {
      throw new RangeError("Request body is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearerCredential(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  return match?.[1];
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return undefined;
  for (const field of raw.split(";")) {
    const [key, value] = field.trim().split("=", 2);
    if (key === name && value !== undefined) return value;
  }
  return undefined;
}

function clearViewCookie(response: ServerResponse, viewId: string): void {
  response.setHeader(
    "Set-Cookie",
    `placekeeper_view=; Path=/r/${viewId}/; Max-Age=0; HttpOnly; SameSite=Strict`,
  );
}

function bootstrapHtml(sessionId: string, nonce: string, embedded: boolean): string {
  const start = embedded
    ? `
  history.replaceState(null, "", location.pathname + location.search);
  window.__placekeeperSession = Object.freeze({ sessionId: "${sessionId}", credential });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/s/${sessionId}/assets/app.css";
  document.head.append(stylesheet);
  const app = await import("/s/${sessionId}/assets/app.js");
  await app.start(window.__placekeeperSession);`
    : `
  if (!view) throw new Error("Readable review view was not created");
  location.replace(view.pathname + "#" + view.locationFragment);`;
  const script = `
(async () => {
  const capability = new URLSearchParams(location.hash.slice(1)).get("cap");
  if (!capability) throw new Error("Missing launch capability");
  const response = await fetch("/s/${sessionId}/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capability })
  });
  if (!response.ok) throw new Error("Launch capability was rejected");
  const { credential, view } = await response.json();${start}
})().catch(() => { document.body.textContent = "Unable to open this review session."; });`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Placekeeper</title></head><body><div id="root"></div><script type="module" nonce="${nonce}">${script}</script></body></html>`;
}

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function terminalRecoveryMarkup(appLinkBase: string, hidden = false): string {
  const base = htmlAttribute(appLinkBase);
  return `<main data-terminal-recovery${hidden ? " hidden" : ""}><p>This session is no longer available.</p><a data-placekeeper-reopen data-app-link-base="${base}" href="#" aria-disabled="true">Reopen</a></main>`;
}

const terminalRecoveryFallbackScript = `
  const reopen = document.querySelector("[data-placekeeper-reopen]");
  if (reopen instanceof HTMLAnchorElement && reopen.dataset.appLinkBase) {
    reopen.href = reopen.dataset.appLinkBase + "#v=1&page=1";
    reopen.removeAttribute("aria-disabled");
  }`;

function readableViewHtml(nonce: string, appLinkBase: string, viewId: string): string {
  const script = `
let app;
(async () => {
  const match = /^\\/r\\/([0-9a-f-]{36})\\//u.exec(location.pathname);
  if (!match) throw new Error("Invalid review view");
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "/assets/app.css";
  document.head.append(stylesheet);
  app = await import("/assets/app.js");
  await app.resume(match[1], location.pathname);
})().catch(() => {
  document.querySelector("#root")?.remove();
  const recovery = document.querySelector("[data-terminal-recovery]");
  if (recovery instanceof HTMLElement) recovery.hidden = false;
  if (app === undefined) {${terminalRecoveryFallbackScript}
  } else {
    app.showTerminalRecovery("${viewId}");
  }
});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Placekeeper</title></head><body><div id="root"></div>${terminalRecoveryMarkup(appLinkBase, true)}<script type="module" nonce="${nonce}">${script}</script></body></html>`;
}

function terminalRecoveryHtml(nonce: string, appLinkBase: string, viewId: string): string {
  const script = `import("/assets/app.js")
    .then((app) => app.showTerminalRecovery("${viewId}"))
    .catch(() => {${terminalRecoveryFallbackScript}
    });`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Placekeeper</title></head><body>${terminalRecoveryMarkup(appLinkBase)}<script type="module" nonce="${nonce}">${script}</script></body></html>`;
}

function assetContentType(path: string): string {
  switch (extname(path)) {
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".wasm": return "application/wasm";
    case ".map": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

export interface WebAssetOptions {
  /** Directory containing the offline production app module graph and PDFium assets. */
  readonly root: string;
}

export interface LocalHttpServerOptions {
  readonly port?: number;
  readonly webAssets?: WebAssetOptions;
  readonly saving?: Pick<
    PdfSaveCoordinator,
    "proposal" | "chooseCopyFilename" | "chooseFolder" | "chooseOriginal" | "requestSave" | "retry" | "locate"
  >;
  readonly exporting?: Pick<ExportCoordinator, "exportReviewedCopy">;
  readonly lifecycle?: Pick<DaemonLifecycleCoordinator, "enterActivity">;
}

export interface LocalHttpServer {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startHttpServer(
  broker: SessionBroker,
  options: LocalHttpServerOptions = {},
): Promise<LocalHttpServer> {
  let hostHeader = "";
  let origin = "";
  const webAssetRoot = options.webAssets === undefined
    ? undefined
    : await realpath(options.webAssets.root);
  const assetCapabilities = new Map<string, Set<string>>();
  const serveWebAsset = async (response: ServerResponse, assetName: string): Promise<void> => {
    if (webAssetRoot === undefined) {
      send(response, 503, "Production assets are not installed");
      return;
    }
    const candidate = join(webAssetRoot, assetName);
    const physical = await realpath(candidate).catch(() => undefined);
    if (physical === undefined || !isContained(webAssetRoot, physical)) {
      send(response, 404, "Not found");
      return;
    }
    const bytes = await readFile(physical);
    setBaseHeaders(response);
    response.statusCode = 200;
    response.setHeader("Content-Type", assetContentType(physical));
    response.setHeader("Content-Length", bytes.byteLength);
    response.end(bytes);
  };
  const server = createServer(async (request, response) => {
    const activity = options.lifecycle?.enterActivity();
    if (options.lifecycle !== undefined && activity === undefined) {
      send(response, 503, "Placekeeper is restarting; retry shortly.");
      return;
    }
    response.once("finish", () => activity?.complete());
    response.once("close", () => activity?.complete());
    try {
      const requestUrl = new URL(request.url ?? "/", origin);
      const pathname = requestUrl.pathname;
      const exchangeMatch = new RegExp(`^/s/(${UUID})/exchange$`, "u").exec(pathname);
      const resumeMatch = new RegExp(`^/r/(${VIEW_UUID})/resume$`, "u").exec(pathname);
      const scopedReopenMatch = new RegExp(`^/r/(${VIEW_UUID})/reopen$`, "u").exec(pathname);
      const reopenMatch = pathname === "/reopen" || scopedReopenMatch !== null;
      const commandMatch = new RegExp(`^/s/(${UUID})/commands$`, "u").exec(pathname);
      const saveMatch = new RegExp(
        `^/s/(${UUID})/save/(status|proposal|copy|folder|original|retry|locate)$`,
        "u",
      ).exec(pathname);
      const exportMatch = new RegExp(`^/s/(${UUID})/export$`, "u").exec(pathname);
      const mutates = exchangeMatch !== null || resumeMatch !== null || reopenMatch || commandMatch !== null ||
        exportMatch !== null ||
        (saveMatch !== null && saveMatch[2] !== "status" && saveMatch[2] !== "proposal");
      const expectsJson = mutates;
      const contentLength = Number(request.headers["content-length"] ?? 0);
      const bodyLimit = MAX_BODY_BYTES;
      const failure = validateRequestSecurity(
        {
          method: request.method ?? "",
          rawHeaders: request.rawHeaders,
          headers: request.headers,
          ...(request.socket.remoteAddress === undefined
            ? {}
            : { remoteAddress: request.socket.remoteAddress }),
          mutates,
          expectsJson,
          bodyLength: Number.isFinite(contentLength) ? contentLength : bodyLimit + 1,
        },
        { host: hostHeader, origin, maxBodyBytes: bodyLimit },
      );
      if (failure !== undefined) {
        send(response, failure === "body-size" ? 413 : 403, "Request rejected");
        return;
      }

      const bootstrapMatch = new RegExp(`^/s/(${UUID})/bootstrap$`, "u").exec(pathname);
      if (bootstrapMatch !== null) {
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed");
          return;
        }
        const sessionId = bootstrapMatch[1]!;
        if (broker.state(sessionId) === undefined) {
          send(response, 404, "Not found");
          return;
        }
        const nonce = randomBytes(18).toString("base64url");
        const embedded = requestUrl.searchParams.get("embed") === "vscode";
        const csp = RESTRICTIVE_CSP
          .replace(
            "script-src 'self'",
            `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
          )
          .replace(
            "frame-ancestors 'self'",
            embedded ? "frame-ancestors vscode-webview:" : "frame-ancestors 'none'",
          );
        send(
          response,
          200,
          bootstrapHtml(sessionId, nonce, embedded),
          "text/html; charset=utf-8",
          csp,
          embedded,
        );
        return;
      }

      if (exchangeMatch !== null) {
        if (request.method !== "POST") {
          send(response, 405, "Method not allowed");
          return;
        }
        const body = (await readJson(request)) as { capability?: unknown };
        const exchange =
          typeof body.capability === "string"
            ? broker.exchangeBootstrapForHttp(exchangeMatch[1]!, body.capability)
            : undefined;
        if (exchange === undefined) {
          send(response, 401, "Capability rejected");
          return;
        }
        if (exchange.view === undefined) {
          const assetCapability = randomBytes(32).toString("base64url");
          const sessionAssetCapabilities = assetCapabilities.get(exchangeMatch[1]!) ?? new Set<string>();
          while (sessionAssetCapabilities.size >= 8) {
            const oldest = sessionAssetCapabilities.values().next().value;
            if (oldest === undefined) break;
            sessionAssetCapabilities.delete(oldest);
          }
          sessionAssetCapabilities.add(assetCapability);
          assetCapabilities.set(exchangeMatch[1]!, sessionAssetCapabilities);
          response.setHeader(
            "Set-Cookie",
            `placekeeper_session=${assetCapability}; Path=/s/${exchangeMatch[1]!}/assets; HttpOnly; SameSite=Strict`,
          );
        } else {
          response.setHeader("Set-Cookie", [
            `placekeeper_view=${exchange.view.cookie}; Path=/r/${exchange.view.id}/; HttpOnly; SameSite=Strict`,
            ...(exchange.view.reconnectCookie === undefined
              ? []
              : [`placekeeper_reconnect=${exchange.view.reconnectCookie}; Path=/r/${exchange.view.id}/; HttpOnly; SameSite=Strict`]),
          ]);
        }
        sendJson(response, 200, {
          credential: exchange.credential,
          ...(exchange.view === undefined
            ? {}
            : {
                view: {
                  id: exchange.view.id,
                  pathname: exchange.view.pathname,
                  locationFragment: exchange.view.locationFragment,
                },
              }),
        });
        return;
      }

      if (resumeMatch !== null) {
        if (request.method !== "POST") {
          send(response, 405, "Method not allowed");
          return;
        }
        const body = await readJson(request) as { pathname?: unknown };
        const cookie = cookieValue(request, "placekeeper_view");
        const resumed =
          typeof body.pathname === "string" && cookie !== undefined
            ? broker.resumeView(resumeMatch[1]!, body.pathname, cookie)
            : undefined;
        if (resumed === undefined) {
          clearViewCookie(response, resumeMatch[1]!);
          send(response, 401, "View is no longer available");
          return;
        }
        const { appLinkBase } = parsePlacekeeperReadableViewRoute(body.pathname as string);
        sendJson(response, 200, { ...resumed, appLinkBase });
        return;
      }

      if (reopenMatch) {
        if (request.method !== "POST") {
          send(response, 405, "Method not allowed");
          return;
        }
        const body = await readJson(request) as {
          link?: unknown;
          confirmed?: unknown;
          recovery?: unknown;
          recoveryOffer?: unknown;
          recoveryOperationId?: unknown;
        };
        const parsedRecoveryOffer = recoveryOfferIdentity(body.recoveryOffer);
        const hasRecoveryIdentity = body.recoveryOffer !== undefined ||
          body.recoveryOperationId !== undefined;
        if (
          typeof body.link !== "string" ||
          (body.confirmed !== undefined && body.confirmed !== true) ||
          (body.recovery !== undefined && !isRecoveryDecision(body.recovery)) ||
          (body.recovery === undefined && hasRecoveryIdentity) ||
          (body.recovery !== undefined && (
            parsedRecoveryOffer === undefined ||
            typeof body.recoveryOperationId !== "string" ||
            !RECOVERY_ID.test(body.recoveryOperationId)
          ))
        ) {
          send(response, 400, "Invalid request");
          return;
        }
        const opened = await openPlacekeeperLink(broker, {
          link: body.link,
          ...(body.confirmed === undefined ? {} : { confirmed: body.confirmed }),
          ...(body.recovery === undefined ? {} : { recovery: body.recovery }),
          ...(parsedRecoveryOffer === undefined ? {} : { recoveryOffer: parsedRecoveryOffer }),
          ...(typeof body.recoveryOperationId !== "string"
            ? {}
            : { recoveryOperationId: body.recoveryOperationId }),
          surface: "browser",
        });
        if (opened.kind === "confirmation-required") {
          sendJson(response, 200, { ok: true, ...opened });
          return;
        }
        if (opened.kind === "recovery-offered") {
          sendJson(response, 200, {
            ok: true,
            kind: "recovery-offered",
            choices: opened.choices,
            recoveryOffer: opened.recoveryOffer,
          });
          return;
        }
        const reconnectPending = scopedReopenMatch === null
          ? false
          : await broker.stageRestartReconnect({
              browserToken: cookieValue(request, "placekeeper_reconnect") ?? "",
              launch: opened.launch,
            });
        const launch = new URL(opened.launch.launchPath, origin);
        launch.hash = opened.launch.fragment.slice(1);
        sendJson(response, 200, {
          ok: true,
          kind: opened.kind,
          url: launch.href,
          ...(reconnectPending ? { reconnectPending: true } : {}),
        });
        return;
      }

      const readableView = pathname.startsWith("/r/")
        ? (() => {
            try {
              return parsePlacekeeperReadableViewRoute(pathname);
            } catch {
              return undefined;
            }
          })()
        : undefined;
      if (readableView !== undefined) {
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed");
          return;
        }
        const nonce = randomBytes(18).toString("base64url");
        const csp = RESTRICTIVE_CSP
          .replace(
            "script-src 'self'",
            `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
          )
          .replace("frame-ancestors 'self'", "frame-ancestors 'none'");
        const live = broker.isLiveViewRoute(readableView.viewId, pathname);
        if (!live) clearViewCookie(response, readableView.viewId);
        send(
          response,
          200,
          live
            ? readableViewHtml(nonce, readableView.appLinkBase, readableView.viewId)
            : terminalRecoveryHtml(nonce, readableView.appLinkBase, readableView.viewId),
          "text/html; charset=utf-8",
          csp,
        );
        return;
      }

      const publicAssetMatch = /^\/assets\/([A-Za-z0-9._-]+)$/u.exec(pathname);
      if (publicAssetMatch !== null) {
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed");
          return;
        }
        await serveWebAsset(response, publicAssetMatch[1]!);
        return;
      }

      const assetMatch = new RegExp(`^/s/(${UUID})/assets/([A-Za-z0-9._-]+)$`, "u").exec(pathname);
      if (assetMatch !== null) {
        if (request.method !== "GET") {
          send(response, 405, "Method not allowed");
          return;
        }
        const assetCapability = cookieValue(request, "placekeeper_session");
        if (
          assetCapability === undefined ||
          assetCapabilities.get(assetMatch[1]!)?.has(assetCapability) !== true ||
          broker.state(assetMatch[1]!) === undefined
        ) {
          send(response, 401, "Authentication required");
          return;
        }
        await serveWebAsset(response, assetMatch[2]!);
        return;
      }

      const stateMatch = new RegExp(`^/s/(${UUID})/state$`, "u").exec(pathname);
      const scopeMatch = new RegExp(`^/s/(${UUID})/scope$`, "u").exec(pathname);
      const documentMatch = new RegExp(`^/s/(${UUID})/document/(${UUID})$`, "u").exec(pathname);
      const authenticatedSessionId =
        stateMatch?.[1] ?? scopeMatch?.[1] ?? documentMatch?.[1] ?? commandMatch?.[1] ??
        saveMatch?.[1] ?? exportMatch?.[1];
      if (authenticatedSessionId !== undefined) {
        const credential = bearerCredential(request);
        if (
          credential === undefined ||
          !broker.authenticate(authenticatedSessionId, credential)
        ) {
          send(response, 401, "Authentication required");
          return;
        }
      }

      if (stateMatch !== null && request.method === "GET") {
        sendJson(response, 200, broker.state(stateMatch[1]!));
        return;
      }
      if (scopeMatch !== null && request.method === "GET") {
        sendJson(
          response,
          200,
          await broker.sessionScope(scopeMatch[1]!, bearerCredential(request)),
        );
        return;
      }
      if (saveMatch !== null) {
        if (options.saving === undefined) {
          send(response, 503, "Saving service is unavailable");
          return;
        }
        const sessionId = saveMatch[1]!;
        const action = saveMatch[2]!;
        if ((action === "status" || action === "proposal") && request.method === "GET") {
          sendJson(
            response,
            200,
            action === "status"
              ? publicSaveStatus(broker.saveStatus(sessionId))
              : options.saving.proposal(sessionId),
          );
          return;
        }
        if (request.method !== "POST") {
          send(response, 405, "Method not allowed");
          return;
        }
        const body = await readJson(request) as { filename?: unknown; folderSelectionId?: unknown };
        if (action === "copy") {
          await options.saving.chooseCopyFilename(
            sessionId,
            typeof body.filename === "string" ? body.filename : undefined,
            typeof body.folderSelectionId === "string" ? body.folderSelectionId : undefined,
          );
        } else if (action === "folder") {
          sendJson(response, 200, await options.saving.chooseFolder(sessionId));
          return;
        } else if (action === "original") {
          await options.saving.chooseOriginal(sessionId);
        } else if (action === "retry") {
          await options.saving.retry(sessionId);
        } else if (action === "locate") {
          await options.saving.locate(sessionId);
        } else {
          send(response, 405, "Method not allowed");
          return;
        }
        sendJson(response, 200, publicSaveStatus(broker.saveStatus(sessionId)));
        return;
      }
      if (exportMatch !== null) {
        if (request.method !== "POST") {
          send(response, 405, "Method not allowed");
          return;
        }
        if (options.exporting === undefined) {
          send(response, 503, "Export service is unavailable");
          return;
        }
        const body = await readJson(request) as { confirmPossiblyStale?: unknown };
        if (body.confirmPossiblyStale !== undefined && body.confirmPossiblyStale !== true) {
          send(response, 400, "Invalid request");
          return;
        }
        const frozen = await broker.freezeDelivery(exportMatch[1]!);
        const result = await options.exporting.exportReviewedCopy({
          ...frozen,
          ...(body.confirmPossiblyStale === true ? { staleConfirmed: true as const } : {}),
        });
        sendJson(response, 200, result);
        return;
      }
      if (documentMatch !== null && request.method === "GET") {
        const state = broker.state(documentMatch[1]!);
        if (state?.source.fileId !== documentMatch[2]) {
          send(response, 404, "Not found");
          return;
        }
        const bytes = await broker.documentBytes(documentMatch[1]!);
        if (bytes === undefined) {
          send(response, 404, "Not found");
          return;
        }
        setBaseHeaders(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", "inline");
        response.setHeader("Content-Length", bytes.length);
        response.end(bytes);
        return;
      }
      if (commandMatch !== null) {
        if (request.method !== "POST") {
          send(response, 405, "Method not allowed");
          return;
        }
        const next = await broker.acceptMutation(
          commandMatch[1]!,
          (await readJson(request)) as ReviewCommand,
        );
        if (broker.saveStatus(commandMatch[1]!)?.destination.phase === "active") {
          void options.saving?.requestSave(commandMatch[1]!);
        }
        sendJson(response, 200, next);
        return;
      }
      send(response, 404, "Not found");
    } catch (error) {
      if (error instanceof InvalidReviewCommandError) {
        sendJson(response, 422, {
          ok: false,
          error: { kind: "invalid-review-command", message: error.message },
        });
      } else if (error instanceof RangeError) {
        send(response, 413, "Request rejected");
      } else if (error instanceof SyntaxError) {
        send(response, 400, "Invalid request");
      } else if (error instanceof RecoveryOfferUnavailableError) {
        sendJson(response, 409, {
          ok: false,
          error: { kind: "recovery-offer-unavailable" },
        });
      } else if (error instanceof ExportCoordinatorError) {
        sendJson(response, 409, {
          ok: false,
          error: { kind: "export-rejected", code: error.code, message: error.message },
        });
      } else {
        send(response, 409, "Request could not be applied");
      }
    }
  });

  server.on("upgrade", (request, socket: Socket, head) => {
    const activity = options.lifecycle?.enterActivity();
    if (options.lifecycle !== undefined && activity === undefined) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const reject = (): void => {
      activity?.complete();
      socket.destroy();
    };
    try {
      const pathname = new URL(request.url ?? "/", origin).pathname;
      const match = new RegExp(`^/s/(${UUID})/control$`, "u").exec(pathname);
      if (match === null) return reject();
      const failure = validateRequestSecurity(
        {
          method: request.method ?? "",
          rawHeaders: request.rawHeaders,
          headers: request.headers,
          ...(request.socket.remoteAddress === undefined
            ? {}
            : { remoteAddress: request.socket.remoteAddress }),
          mutates: false,
        },
        { host: hostHeader, origin, maxBodyBytes: 0 },
      );
      const connectionTokens = request.headers.connection
        ?.split(",")
        .map((value) => value.trim().toLowerCase());
      if (
        failure !== undefined ||
        request.headers.origin !== origin ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        !connectionTokens?.includes("upgrade") ||
        request.headers["sec-websocket-version"] !== "13"
      ) {
        return reject();
      }
      const protocols = request.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((value) => value.trim());
      const credential = protocols
        ?.find((value) => value.startsWith("placekeeper-auth."))
        ?.slice("placekeeper-auth.".length);
      if (!protocols?.includes("placekeeper")) {
        return reject();
      }
      if (
        credential === undefined ||
        !broker.authenticate(match[1]!, credential)
      ) {
        return reject();
      }
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") return reject();
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: placekeeper\r\n\r\n`,
      );
      broker.controls.registerSocket(match[1]!, socket, head);
      activity?.complete();
    } catch {
      reject();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: options.port ?? 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Local HTTP server did not bind a TCP port");
  }
  hostHeader = `127.0.0.1:${address.port}`;
  origin = `http://${hostHeader}`;
  const unsubscribeSessionEnd = broker.onSessionEnd((sessionId) => {
    assetCapabilities.delete(sessionId);
  });
  return {
    origin,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        unsubscribeSessionEnd();
        broker.controls.closeAllSockets();
        broker.taskBindings.revokeAll();
        assetCapabilities.clear();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections();
      }),
  };
}
