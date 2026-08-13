import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import type {
  LiveContextRefreshResult,
  LiveExecutionBaselineV1,
} from "../../../../packages/core/src/live-context.js";
import type {
  CompleteDispositionV1,
  LiveDispositionItemV1,
} from "../../../../packages/core/src/disposition.js";
import type {
  PdfEvidenceRequest,
  PdfEvidenceUnavailableReason,
} from "../context/pdf-evidence-service.js";
import type { TaskBindingClaimResult } from "../context/task-binding-registry.js";
import type {
  AcceptedSourceProposal,
  SourceReconciliationReportV1,
  SourceReplacementProposalV1,
} from "../context/source-reconciliation-service.js";
import type {
  CleanRebuildPlanV1,
  CleanRebuildVerificationV1,
  SourceWorkflowResult,
} from "../context/live-source-workflow-service.js";
import { SourceWorkflowUnavailableError } from "../context/live-source-workflow-service.js";
import type { LaunchRequest, LaunchResponse, PlacekeeperHost } from "./placekeeper-host.js";
import type { ConditionalShutdownResult } from "./daemon-lifecycle.js";

// Both directions are explicitly bounded. Evidence requests use a stricter
// byte budget before base64 expansion, so a document can never turn this
// private control socket into an unbounded transport.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CONTROL_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
export const MANAGEMENT_PROTOCOL_VERSION = 1;

export type DaemonLifecycleState = "accepting" | "draining" | "shutdown-committed";

export interface DaemonAggregateActivity {
  readonly reviewPresence: number;
  readonly codexTasks: number;
  readonly transientWork: number;
}

export interface DaemonManagementStatus {
  readonly protocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
  readonly daemonIdentity: string;
  readonly readinessToken?: string;
  readonly lifecycle: DaemonLifecycleState;
  readonly activity: DaemonAggregateActivity;
}

export type DaemonUninspectableReason =
  | "malformed"
  | "oversized"
  | "timeout"
  | "early-close";

export type DaemonUpgradeReason = DaemonUninspectableReason | "incompatible" |
  "review-presence" | "codex-task" | "transient-busy";

export type DaemonCompatibilityResult =
  | { readonly kind: "exact"; readonly status: DaemonManagementStatus }
  | { readonly kind: "incompatible"; readonly status: DaemonManagementStatus }
  | { readonly kind: "uninspectable"; readonly reason: DaemonUninspectableReason };

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

export type PlacekeeperControlRequest =
  | {
      readonly kind: "management";
      readonly protocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
      readonly operation: "status";
    }
  | {
      readonly kind: "management";
      readonly protocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
      readonly operation: "shutdown-if-idle";
    }
  | { readonly kind: "launch"; readonly request: LaunchRequest }
  | {
      readonly kind: "claim-binding";
      readonly taskSessionId: string;
      readonly reviewSessionId: string;
      readonly documentGeneration: number;
      readonly bindProof: string;
    }
  | { readonly kind: "refresh-context"; readonly taskSessionId: string; readonly cursor?: string }
  | { readonly kind: "ack-context"; readonly taskSessionId: string; readonly cursor: string }
  | { readonly kind: "revoke-task"; readonly taskSessionId: string }
  | {
      readonly kind: "source-begin";
      readonly handle: string;
      readonly sourcePaths?: readonly string[];
    }
  | {
      readonly kind: "source-propose";
      readonly handle: string;
      readonly executionId: string;
      readonly proposal: SourceReplacementProposalV1;
    }
  | {
      readonly kind: "source-reconcile";
      readonly handle: string;
      readonly executionId: string;
      readonly expectedSourceSha256ByProposal?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "source-rebuild-plan";
      readonly handle: string;
      readonly executionId: string;
      readonly command: string;
      readonly outputPath: string;
    }
  | {
      readonly kind: "source-rebuild-verify";
      readonly handle: string;
      readonly executionId: string;
      readonly planId: string;
    }
  | {
      readonly kind: "source-complete";
      readonly handle: string;
      readonly executionId: string;
      readonly items: readonly LiveDispositionItemV1[];
      readonly rebuildVerificationId?: string;
    }
  | {
      readonly kind: "retrieve-evidence";
      readonly taskSessionId: string;
      readonly handle: string;
      readonly request: PdfEvidenceRequest;
    }
  | {
      readonly kind: "retrieve-evidence-by-handle";
      readonly handle: string;
      readonly request: PdfEvidenceRequest;
    }
  | {
      readonly kind: "retrieve-review-items-by-handle";
      readonly handle: string;
      readonly offset?: number;
      readonly limit?: number;
      readonly pageIndex?: number;
      readonly maxBytes?: number;
    }
  | {
      readonly kind: "retrieve-review-changes-by-handle";
      readonly handle: string;
      readonly offset?: number;
      readonly limit?: number;
      readonly maxBytes?: number;
    };

export type PlacekeeperControlResponse =
  | {
      readonly kind: "management";
      readonly protocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
      readonly operation: "status";
      readonly status: DaemonManagementStatus;
    }
  | {
      readonly kind: "management";
      readonly protocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
      readonly operation: "shutdown-if-idle";
      readonly result:
        | { readonly status: "accepted" }
        | {
            readonly status: "refused";
            readonly activity: DaemonAggregateActivity;
          };
    }
  | { readonly kind: "launch"; readonly response: LaunchResponse }
  | { readonly kind: "binding"; readonly result: TaskBindingClaimResult }
  | { readonly kind: "context"; readonly result: LiveContextRefreshResult }
  | { readonly kind: "revoked" }
  | { readonly kind: "context-acknowledged"; readonly accepted: boolean }
  | {
      readonly kind: "source-workflow-unavailable";
      readonly reason: PdfEvidenceUnavailableReason;
    }
  | {
      readonly kind: "source-workflow";
      readonly operation: "begin";
      readonly response: SourceWorkflowResult<LiveExecutionBaselineV1>;
    }
  | {
      readonly kind: "source-workflow";
      readonly operation: "propose";
      readonly response: SourceWorkflowResult<AcceptedSourceProposal>;
    }
  | {
      readonly kind: "source-workflow";
      readonly operation: "reconcile";
      readonly response: SourceWorkflowResult<SourceReconciliationReportV1>;
    }
  | {
      readonly kind: "source-workflow";
      readonly operation: "rebuild-plan";
      readonly response: SourceWorkflowResult<CleanRebuildPlanV1>;
    }
  | {
      readonly kind: "source-workflow";
      readonly operation: "rebuild-verify";
      readonly response: SourceWorkflowResult<CleanRebuildVerificationV1>;
    }
  | {
      readonly kind: "source-workflow";
      readonly operation: "complete";
      readonly response: SourceWorkflowResult<CompleteDispositionV1>;
    }
  | {
      readonly kind: "evidence";
      readonly result:
        | {
            readonly status: "ok";
            readonly evidenceKind: PdfEvidenceRequest["kind"] | "review-items" | "review-changes";
            readonly mediaType: string;
            readonly dataBase64: string;
          }
        | { readonly status: "unavailable"; readonly reason: PdfEvidenceUnavailableReason };
    }
  | { readonly kind: "error"; readonly reason: "invalid-request" | "unavailable" };

export interface LaunchControlServer {
  readonly socketPath: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlRequest(value: unknown): value is PlacekeeperControlRequest {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "management") {
    return value.protocolVersion === MANAGEMENT_PROTOCOL_VERSION &&
      (value.operation === "status" ||
        value.operation === "shutdown-if-idle");
  }
  if (value.kind === "launch") return isObject(value.request);
  if (value.kind === "refresh-context" || value.kind === "revoke-task") {
    return typeof value.taskSessionId === "string" &&
      (value.kind !== "refresh-context" || value.cursor === undefined || typeof value.cursor === "string");
  }
  if (value.kind === "ack-context") {
    return typeof value.taskSessionId === "string" && typeof value.cursor === "string";
  }
  if (value.kind === "source-begin") {
    return typeof value.handle === "string" &&
      (value.sourcePaths === undefined ||
        (Array.isArray(value.sourcePaths) && value.sourcePaths.every((path) => typeof path === "string")));
  }
  if (value.kind === "source-propose") {
    return typeof value.handle === "string" && typeof value.executionId === "string" &&
      isObject(value.proposal);
  }
  if (value.kind === "source-reconcile") {
    return typeof value.handle === "string" && typeof value.executionId === "string" &&
      (value.expectedSourceSha256ByProposal === undefined || isObject(value.expectedSourceSha256ByProposal));
  }
  if (value.kind === "source-rebuild-plan") {
    return typeof value.handle === "string" && typeof value.executionId === "string" &&
      typeof value.command === "string" && typeof value.outputPath === "string";
  }
  if (value.kind === "source-rebuild-verify") {
    return typeof value.handle === "string" && typeof value.executionId === "string" &&
      typeof value.planId === "string";
  }
  if (value.kind === "source-complete") {
    return typeof value.handle === "string" && typeof value.executionId === "string" &&
      Array.isArray(value.items) &&
      (value.rebuildVerificationId === undefined || typeof value.rebuildVerificationId === "string");
  }
  if (value.kind === "claim-binding") {
    return typeof value.taskSessionId === "string" &&
      typeof value.reviewSessionId === "string" &&
      typeof value.documentGeneration === "number" &&
      typeof value.bindProof === "string";
  }
  if (value.kind === "retrieve-review-items-by-handle" || value.kind === "retrieve-review-changes-by-handle") {
    return typeof value.handle === "string";
  }
  if (value.kind === "retrieve-evidence" || value.kind === "retrieve-evidence-by-handle") {
    return (value.kind !== "retrieve-evidence" || typeof value.taskSessionId === "string") &&
      typeof value.handle === "string" && isObject(value.request) &&
      typeof value.request.kind === "string";
  }
  return false;
}

async function dispatch(
  host: PlacekeeperHost,
  request: PlacekeeperControlRequest,
  management: { readonly daemonIdentity: string; readonly readinessToken?: string },
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
  if (request.kind === "launch") {
    return { kind: "launch", response: await host.open(request.request) };
  }
  let response: PlacekeeperControlResponse | undefined;
  try {
    response = await host.lifecycle.runActivity<PlacekeeperControlResponse>(async () => {
    if (request.kind === "claim-binding") {
      return {
        kind: "binding",
        result: host.broker.taskBindings.claim(request),
      };
    }
    if (request.kind === "refresh-context") {
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
      host.broker.taskBindings.revokeTask(request.taskSessionId);
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
  return new Promise((resolve) => socket.end(output, resolve));
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
        void writeResponse(socket, { kind: "error", reason: "invalid-request" });
        return;
      }
      if (!isControlRequest(parsed)) {
        void writeResponse(socket, { kind: "error", reason: "invalid-request" });
        return;
      }
      void dispatch(host, parsed, management).then(
        async (response) => {
          await writeResponse(socket, response);
          if (
            response.kind === "management" &&
            response.operation === "shutdown-if-idle" &&
            response.result.status === "accepted"
          ) {
            await host.close();
            await closeControl();
          }
        },
        () => void writeResponse(socket, { kind: "error", reason: "unavailable" }),
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
  options: { readonly timeoutMs?: number; readonly maxMessageBytes?: number } = {},
): Promise<PlacekeeperControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
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
    socket.once("error", reject);
    socket.once("end", () => {
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
