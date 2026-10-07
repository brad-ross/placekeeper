import {
  MANAGEMENT_PROTOCOL_VERSION,
  isControlRequest,
  type DaemonAggregateActivity,
  type DaemonManagementStatus,
  type DaemonLifecycleState,
  type DaemonUpgradeReason,
  type DaemonCompatibilityResult,
  type PlacekeeperControlRequest,
  type PlacekeeperControlResponse,
} from "./control-protocol.js";
export {
  MANAGEMENT_PROTOCOL_VERSION,
  type DaemonLifecycleState,
  type DaemonAggregateActivity,
  type DaemonManagementStatus,
  type DaemonUninspectableReason,
  type DaemonUpgradeReason,
  type DaemonCompatibilityResult,
  type PlacekeeperControlRequest,
  type PlacekeeperControlResponse,
} from "./control-protocol.js";
import { CONTROL_REQUEST_TIMEOUT_MS } from "./control-constants.js";
export { CONTROL_REQUEST_TIMEOUT_MS } from "./control-constants.js";

import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { SourceWorkflowUnavailableError } from "../context/live-source-workflow-service.js";
import type {
  LaunchRequest,
  LaunchResponse,
  LinkLaunchResponse,
  LinkOpenRequest,
  LinkPreflightResponse,
  PlacekeeperHost,
} from "./placekeeper-host.js";
import type { ConditionalShutdownResult } from "./daemon-lifecycle.js";

import { parseMacosReviewHelperMessage } from "../../../../packages/core/src/macos-helper-protocol.js";

// Both directions are explicitly bounded. Evidence requests use a stricter
// byte budget before base64 expansion, so a document can never turn this
// private control socket into an unbounded transport.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CONTROL_EVIDENCE_BYTES = 8 * 1024 * 1024;

export class PlacekeeperControlTimeoutError extends Error {
  constructor() {
    super("Placekeeper service timed out");
    this.name = "PlacekeeperControlTimeoutError";
  }
}

export class PlacekeeperControlProtocolError extends Error {
  constructor(readonly reason: "malformed" | "oversized" | "early-close") {
    super(`Placekeeper service returned an ${reason} response`);
    this.name = "PlacekeeperControlProtocolError";
  }
}

export class DaemonUpgradeRequiredError extends Error {
  readonly recoveryAction: string;

  constructor(readonly reason: DaemonUpgradeReason) {
    const presentation = upgradePresentation(reason);
    super(presentation.message);
    this.recoveryAction = presentation.recoveryAction;
    this.name = "DaemonUpgradeRequiredError";
  }
}

function upgradePresentation(reason: DaemonUpgradeReason): {
  readonly message: string;
  readonly recoveryAction: string;
} {
  if (reason === "review-presence") return {
    message: "Placekeeper has active reviews. The upgrade was deferred and existing work was preserved.",
    recoveryAction: "Close Placekeeper tabs or windows, then retry",
  };
  if (reason === "codex-task") return {
    message: "Placekeeper has an active Codex task. The upgrade was deferred and existing work was preserved.",
    recoveryAction: "End the bound Codex task or wait for its lease, then retry",
  };
  if (reason === "transient-busy") return {
    message: "Placekeeper is finishing saved work or another lifecycle operation. Existing work was preserved.",
    recoveryAction: "Wait a moment, then retry",
  };
  if (["timeout", "malformed", "oversized", "early-close"].includes(reason)) return {
    message: "Placekeeper could not safely inspect the running service. The upgrade was deferred and existing work was preserved.",
    recoveryAction: "Close active work, then retry",
  };
  return {
    message: "Placekeeper is already running an incompatible service build. Existing reviews were preserved.",
    recoveryAction: "Close Placekeeper reviews and retry",
  };
}

export interface LaunchControlServer {
  readonly socketPath: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function dispatch(
  host: PlacekeeperHost,
  request: PlacekeeperControlRequest,
  management: { readonly daemonIdentity: string; readonly readinessToken?: string },
  signal?: AbortSignal,
): Promise<PlacekeeperControlResponse> {
  if (request.kind === "management") {
    if (request.operation === "shutdown-if-idle") {
      return {
        kind: "management",
        protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
        operation: "shutdown-if-idle",
        result: await host.lifecycle.shutdownIfIdle(),
      };
    }
    const live = host.lifecycle.status();
    return {
      kind: "management",
      protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
      operation: "status",
      status: {
        protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
        daemonIdentity: management.daemonIdentity,
        ...(management.readinessToken === undefined
          ? {}
          : { readinessToken: management.readinessToken }),
        lifecycle: live.lifecycle,
        activity: live.activity,
      },
    };
  }
  if (request.kind === "codex-display" || request.kind === "codex-attest" || request.kind === "codex-app") {
    return await host.lifecycle.runActivity<PlacekeeperControlResponse>(async () => {
      if (request.kind === "codex-display") {
        const result = host.codexRuntime.display(request.request.handoff);
        return result === undefined ? { kind: "error", reason: "unavailable" }
          : { kind: "codex-display", receipt: result.receipt, pending: result.privateMeta };
      }
      if (request.kind === "codex-attest") {
        return { kind: "codex-attestation", status: host.codexRuntime.attestDisplay(request.receipt, request.taskSessionId) ? "accepted" : "denied" };
      }
      return { kind: "codex-app", response: await host.codexRuntime.handle(request.request) };
    }) ?? { kind: "error", reason: "unavailable" };
  }
  if (request.kind === "launch") {
    return { kind: "launch", response: await host.open(request.request) };
  }
  if (request.kind === "chrome-open") {
    return { kind: "chrome-open", response: await host.openChromeBrowserSource(request.request, signal) };
  }
  if (request.kind === "chrome-runtime") {
    return { kind: "chrome-runtime", messages: await host.chromeRuntime.handle(request.portId, request.message) };
  }
  if (request.kind === "chrome-runtime-detach") {
    await host.chromeRuntime.detach(request.portId);
    return { kind: "chrome-runtime-detached" };
  }
  if (request.kind === "macos-app-control") {
    return { kind: "macos-app-control", response: await host.macosLifecycle.handle(request.message) };
  }
  if (request.kind === "macos-runtime") {
    const message = parseMacosReviewHelperMessage(request.message)!;
    const isAdmission = message.type === "admit" || message.type === "admit-link";
    const alreadyOwned = host.macosLifecycle.ownsHelper(request.appInstanceId, request.helperId);
    const attached = alreadyOwned || (isAdmission
      && host.macosLifecycle.attachHelper(request.appInstanceId, request.helperId));
    if (!attached) {
      return {
        kind: "macos-runtime",
        response: {
          protocolVersion: 1,
          windowId: message.windowId,
          attemptId: message.attemptId,
          requestId: message.requestId,
          type: "failure",
          code: "invalid",
        },
      };
    }
    const response = await host.macosRuntime.handle(request.helperId, message);
    // A lifecycle detach can race an admission after ownership was attached
    // but before the runtime installed its provisional record. Reconcile after
    // the await so the late result cannot recreate authority for a dead helper.
    if (!host.macosLifecycle.ownsHelper(request.appInstanceId, request.helperId)) {
      await host.macosRuntime.detach(request.helperId);
      return {
        kind: "macos-runtime",
        response: {
          protocolVersion: 1,
          windowId: message.windowId,
          attemptId: message.attemptId,
          requestId: message.requestId,
          type: "failure",
          code: "unavailable",
        },
      };
    }
    if (response.type === "released" || (isAdmission && response.type === "failure")) {
      host.macosLifecycle.releaseHelper(request.appInstanceId, request.helperId);
    }
    return { kind: "macos-runtime", response };
  }
  if (request.kind === "macos-runtime-detach") {
    if (host.macosLifecycle.ownsHelper(request.appInstanceId, request.helperId)) {
      await host.macosRuntime.detach(request.helperId);
      host.macosLifecycle.releaseHelper(request.appInstanceId, request.helperId);
    }
    return { kind: "macos-runtime-detached" };
  }
  if (request.kind === "link-preflight") {
    return { kind: "link-preflight", response: await host.preflightLink(request.link) };
  }
  if (request.kind === "link-open") {
    return { kind: "link-open", response: await host.openLink(request.request) };
  }
  let response: PlacekeeperControlResponse | undefined;
  try {
    response = await host.lifecycle.runActivity<PlacekeeperControlResponse>(async () => {
    if (request.kind === "claim-binding") {
      if (request.native === true) {
        return { kind: "codex-binding", status: host.codexRuntime.claimLaunch(request) ? "accepted" : "denied" };
      }
      return {
        kind: "binding",
        result: await host.broker.claimTaskBinding(request),
      };
    }
    if (request.kind === "refresh-context") {
      await host.codexRuntime.trustedTaskPrompt(request.taskSessionId);
      await host.broker.prepareTaskContext(request.taskSessionId);
      return {
        kind: "context",
        result: await host.context.refresh({
          taskSessionId: request.taskSessionId,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        }),
      };
    }
    if (request.kind === "ack-context") {
      return {
        kind: "context-acknowledged",
        accepted: host.context.acknowledge(request),
      };
    }
    if (request.kind === "revoke-task") {
      host.context.discardTask(request.taskSessionId);
      await host.codexRuntime.revokeTask(request.taskSessionId);
      await host.broker.revokeTask(request.taskSessionId);
      host.reconciliation.discardTask(request.taskSessionId);
      host.sourceWorkflow.discardTask(request.taskSessionId);
      return { kind: "revoked" };
    }
    if (request.kind === "source-begin") {
      return {
        kind: "source-workflow",
        operation: "begin",
        response: await host.sourceWorkflow.begin(request),
      };
    }
    if (request.kind === "source-propose") {
      return {
        kind: "source-workflow",
        operation: "propose",
        response: await host.sourceWorkflow.propose(request),
      };
    }
    if (request.kind === "source-reconcile") {
      return {
        kind: "source-workflow",
        operation: "reconcile",
        response: await host.sourceWorkflow.reconcile(request),
      };
    }
    if (request.kind === "source-rebuild-plan") {
      return {
        kind: "source-workflow",
        operation: "rebuild-plan",
        response: await host.sourceWorkflow.prepareCleanRebuild(request),
      };
    }
    if (request.kind === "source-rebuild-verify") {
      return {
        kind: "source-workflow",
        operation: "rebuild-verify",
        response: await host.sourceWorkflow.verifyCleanRebuild(request),
      };
    }
    if (request.kind === "source-complete") {
      return {
        kind: "source-workflow",
        operation: "complete",
        response: await host.sourceWorkflow.complete(request),
      };
    }
    if (request.kind === "retrieve-review-items-by-handle") {
      const result = host.context.evidence.retrieveReviewItemsWithHandle(request);
      return result.status === "ok"
        ? {
            kind: "evidence",
            result: {
              status: "ok",
              evidenceKind: result.kind,
              mediaType: result.mediaType,
              dataBase64: result.bytes.toString("base64"),
            },
          }
        : { kind: "evidence", result };
    }
    if (request.kind === "retrieve-review-changes-by-handle") {
      const result = host.context.evidence.retrieveReviewChangesWithHandle(request);
      return result.status === "ok"
        ? {
            kind: "evidence",
            result: {
              status: "ok",
              evidenceKind: result.kind,
              mediaType: result.mediaType,
              dataBase64: result.bytes.toString("base64"),
            },
          }
        : { kind: "evidence", result };
    }
    const maxBytes = request.request.maxBytes ?? MAX_CONTROL_EVIDENCE_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_CONTROL_EVIDENCE_BYTES
    ) {
      return {
        kind: "evidence",
        result: { status: "unavailable", reason: "invalid_request" },
      };
    }
    const evidenceInput = { handle: request.handle, request: { ...request.request, maxBytes } };
    const result = request.kind === "retrieve-evidence"
      ? await host.context.evidence.retrieve({ taskSessionId: request.taskSessionId, ...evidenceInput })
      : await host.context.evidence.retrieveWithHandle(evidenceInput);
    return result.status === "ok"
      ? {
          kind: "evidence",
          result: {
            status: "ok",
            evidenceKind: result.kind,
            mediaType: result.mediaType,
            dataBase64: result.bytes.toString("base64"),
          },
        }
      : { kind: "evidence", result };
    });
  } catch (error) {
    if (error instanceof SourceWorkflowUnavailableError) {
      return { kind: "source-workflow-unavailable", reason: error.reason };
    }
    throw error;
  }
  return response ?? { kind: "error", reason: "unavailable" };
}

function writeResponse(socket: Socket, response: PlacekeeperControlResponse): Promise<void> {
  const serialized = `${JSON.stringify(response)}\n`;
  const output = Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES
    ? `${JSON.stringify({ kind: "error", reason: "unavailable" })}\n`
    : serialized;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (hadError: boolean): void => finish(
      hadError ? new Error("control-client-closed") : undefined,
    );
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.end(output);
  });
}

export async function startLaunchControlServer(
  host: PlacekeeperHost,
  socketPath: string,
  management: { readonly daemonIdentity: string; readonly readinessToken?: string } | DaemonManagementStatus = {
    daemonIdentity: "development",
  },
): Promise<LaunchControlServer> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const closed = Promise.withResolvers<void>();
  let closePromise: Promise<void> | undefined;
  const server = createServer((socket) => {
    const requestLifetime = new AbortController();
    socket.once("close", () => requestLifetime.abort(new Error("control-client-closed")));
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const newline = raw.indexOf("\n");
      if (newline === -1) return;
      socket.pause();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.slice(0, newline)) as unknown;
      } catch {
        void writeResponse(socket, { kind: "error", reason: "invalid-request" }).catch(() => undefined);
        return;
      }
      if (!isControlRequest(parsed)) {
        void writeResponse(socket, { kind: "error", reason: "invalid-request" }).catch(() => undefined);
        return;
      }
      void dispatch(host, parsed, management, requestLifetime.signal).then(
        async (response) => {
          try {
            requestLifetime.signal.throwIfAborted();
            await writeResponse(socket, response);
          } catch {
            const openedSessionId = response.kind === "chrome-open" && response.response.ok &&
                response.response.kind !== "recovery-offered"
              ? response.response.sessionId
              : response.kind === "launch" && response.response.ok &&
                  response.response.kind === "opened" && parsed.kind === "launch" &&
                  parsed.request.surface === "browser"
                ? response.response.sessionId
                : undefined;
            if (openedSessionId !== undefined) await host.broker.discard(openedSessionId);
            return;
          }
          if (
            response.kind === "management" &&
            response.operation === "shutdown-if-idle" &&
            response.result.status === "accepted"
          ) {
            await host.close();
            await closeControl();
          }
        },
        () => void writeResponse(socket, { kind: "error", reason: "unavailable" }).catch(() => undefined),
      );
    });
  });
  const closeControl = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await closeServer(server);
        await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        closed.resolve();
      } catch (error) {
        closed.reject(error);
        throw error;
      }
    })();
    return closePromise;
  };
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    closed: closed.promise,
    close: closeControl,
  };
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

export function requestControl(
  socketPath: string,
  request: PlacekeeperControlRequest,
  options: {
    readonly timeoutMs?: number;
    readonly maxMessageBytes?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<PlacekeeperControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onAbort = (): void => { socket.destroy(options.signal?.reason); };
    if (options.signal?.aborted === true) {
      socket.destroy();
      reject(options.signal.reason);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let raw = "";
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS, () =>
      socket.destroy(new PlacekeeperControlTimeoutError()));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > (options.maxMessageBytes ?? MAX_MESSAGE_BYTES)) {
        socket.destroy(new PlacekeeperControlProtocolError("oversized"));
      }
    });
    socket.once("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    socket.once("end", () => {
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (raw.length === 0) {
        reject(new PlacekeeperControlProtocolError("early-close"));
        return;
      }
      try {
        resolve(JSON.parse(raw) as PlacekeeperControlResponse);
      } catch {
        reject(new PlacekeeperControlProtocolError("malformed"));
      }
    });
  });
}

function isAggregateActivity(value: unknown): value is DaemonAggregateActivity {
  if (!isObject(value)) return false;
  return [value.reviewPresence, value.codexTasks, value.transientWork].every(
    (count) => Number.isSafeInteger(count) && (count as number) >= 0,
  );
}

function managementStatus(response: PlacekeeperControlResponse): DaemonManagementStatus | undefined {
  if (
    response.kind !== "management" ||
    response.protocolVersion !== MANAGEMENT_PROTOCOL_VERSION ||
    response.operation !== "status" ||
    !isObject(response.status) ||
    response.status.protocolVersion !== MANAGEMENT_PROTOCOL_VERSION ||
    typeof response.status.daemonIdentity !== "string" ||
    !["accepting", "draining", "shutdown-committed"].includes(String(response.status.lifecycle)) ||
    !isAggregateActivity(response.status.activity)
  ) return undefined;
  if (!/^(?:development|[a-f0-9]{64})$/u.test(response.status.daemonIdentity)) return undefined;
  if (
    response.status.readinessToken !== undefined &&
    !/^[A-Za-z0-9_-]{32}$/u.test(response.status.readinessToken)
  ) return undefined;
  return {
    protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
    daemonIdentity: response.status.daemonIdentity,
    ...(response.status.readinessToken === undefined
      ? {}
      : { readinessToken: response.status.readinessToken }),
    lifecycle: response.status.lifecycle as DaemonLifecycleState,
    activity: {
      reviewPresence: response.status.activity.reviewPresence,
      codexTasks: response.status.activity.codexTasks,
      transientWork: response.status.activity.transientWork,
    },
  };
}

export function managementShutdownResult(response: unknown): ConditionalShutdownResult | undefined {
  if (
    !isObject(response) ||
    response.kind !== "management" ||
    response.protocolVersion !== MANAGEMENT_PROTOCOL_VERSION ||
    response.operation !== "shutdown-if-idle" ||
    !isObject(response.result)
  ) return undefined;
  if (response.result.status === "accepted") return { status: "accepted" };
  if (response.result.status !== "refused" || !isAggregateActivity(response.result.activity)) {
    return undefined;
  }
  return {
    status: "refused",
    activity: {
      reviewPresence: response.result.activity.reviewPresence,
      codexTasks: response.result.activity.codexTasks,
      transientWork: response.result.activity.transientWork,
    },
  };
}

export async function inspectDaemonCompatibility(
  socketPath: string,
  expectedDaemonIdentity: string,
  options: { readonly timeoutMs?: number; readonly maxMessageBytes?: number } = {},
): Promise<DaemonCompatibilityResult> {
  try {
    const response = await requestControl(
      socketPath,
      { kind: "management", protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: "status" },
      options,
    );
    if (response.kind === "error" && response.reason === "invalid-request") {
      return { kind: "uninspectable", reason: "malformed" };
    }
    const status = managementStatus(response);
    if (status === undefined) return { kind: "uninspectable", reason: "malformed" };
    return status.daemonIdentity === expectedDaemonIdentity
      ? { kind: "exact", status }
      : { kind: "incompatible", status };
  } catch (error) {
    if (error instanceof PlacekeeperControlTimeoutError) {
      return { kind: "uninspectable", reason: "timeout" };
    }
    if (error instanceof PlacekeeperControlProtocolError) {
      return { kind: "uninspectable", reason: error.reason };
    }
    throw error;
  }
}

export async function requestLaunch(
  socketPath: string,
  request: LaunchRequest,
): Promise<LaunchResponse> {
  const response = await requestControl(socketPath, { kind: "launch", request });
  if (response.kind !== "launch") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}

export async function requestLinkPreflight(
  socketPath: string,
  link: string,
): Promise<LinkPreflightResponse> {
  const response = await requestControl(socketPath, { kind: "link-preflight", link });
  if (response.kind !== "link-preflight") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}

export async function requestLinkOpen(
  socketPath: string,
  request: LinkOpenRequest,
): Promise<LinkLaunchResponse> {
  const response = await requestControl(socketPath, { kind: "link-open", request });
  if (response.kind !== "link-open") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}
