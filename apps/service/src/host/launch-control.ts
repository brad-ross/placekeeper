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
import type { LaunchRequest, LaunchResponse, ProofreaderHost } from "./proofreader-host.js";

// Both directions are explicitly bounded. Evidence requests use a stricter
// byte budget before base64 expansion, so a document can never turn this
// private control socket into an unbounded transport.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CONTROL_EVIDENCE_BYTES = 8 * 1024 * 1024;

export type ProofreaderControlRequest =
  | { readonly kind: "launch"; readonly request: LaunchRequest }
  | {
      readonly kind: "claim-binding";
      readonly taskSessionId: string;
      readonly reviewSessionId: string;
      readonly documentGeneration: number;
      readonly bindProof: string;
    }
  | { readonly kind: "refresh-context"; readonly taskSessionId: string }
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
    };

export type ProofreaderControlResponse =
  | { readonly kind: "launch"; readonly response: LaunchResponse }
  | { readonly kind: "binding"; readonly result: TaskBindingClaimResult }
  | { readonly kind: "context"; readonly result: LiveContextRefreshResult }
  | { readonly kind: "revoked" }
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
            readonly evidenceKind: PdfEvidenceRequest["kind"] | "review-items";
            readonly mediaType: string;
            readonly dataBase64: string;
          }
        | { readonly status: "unavailable"; readonly reason: PdfEvidenceUnavailableReason };
    }
  | { readonly kind: "error"; readonly reason: "invalid-request" | "unavailable" };

export interface LaunchControlServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlRequest(value: unknown): value is ProofreaderControlRequest {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "launch") return isObject(value.request);
  if (value.kind === "refresh-context" || value.kind === "revoke-task") {
    return typeof value.taskSessionId === "string";
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
  if (value.kind === "retrieve-review-items-by-handle") return typeof value.handle === "string";
  if (value.kind === "retrieve-evidence" || value.kind === "retrieve-evidence-by-handle") {
    return (value.kind !== "retrieve-evidence" || typeof value.taskSessionId === "string") &&
      typeof value.handle === "string" && isObject(value.request) &&
      typeof value.request.kind === "string";
  }
  return false;
}

async function dispatch(
  host: ProofreaderHost,
  request: ProofreaderControlRequest,
): Promise<ProofreaderControlResponse> {
  if (request.kind === "launch") {
    return { kind: "launch", response: await host.open(request.request) };
  }
  if (request.kind === "claim-binding") {
    return {
      kind: "binding",
      result: host.broker.taskBindings.claim(request),
    };
  }
  if (request.kind === "refresh-context") {
    return {
      kind: "context",
      result: await host.context.refresh({ taskSessionId: request.taskSessionId }),
    };
  }
  if (request.kind === "revoke-task") {
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
  const maxBytes = request.request.maxBytes ?? MAX_CONTROL_EVIDENCE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CONTROL_EVIDENCE_BYTES) {
    return { kind: "evidence", result: { status: "unavailable", reason: "invalid_request" } };
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
}

function writeResponse(socket: Socket, response: ProofreaderControlResponse): void {
  const serialized = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
    socket.end(`${JSON.stringify({ kind: "error", reason: "unavailable" })}\n`);
    return;
  }
  socket.end(serialized);
}

export async function startLaunchControlServer(
  host: ProofreaderHost,
  socketPath: string,
): Promise<LaunchControlServer> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
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
        writeResponse(socket, { kind: "error", reason: "invalid-request" });
        return;
      }
      if (!isControlRequest(parsed)) {
        writeResponse(socket, { kind: "error", reason: "invalid-request" });
        return;
      }
      void dispatch(host, parsed).then(
        (response) => writeResponse(socket, response),
        () => writeResponse(socket, { kind: "error", reason: "unavailable" }),
      );
    });
  });
  await listen(server, socketPath);
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    close: async () => {
      await closeServer(server);
      await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
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
  request: ProofreaderControlRequest,
): Promise<ProofreaderControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("Proofreader service timed out")));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        socket.destroy(new Error("Proofreader response exceeded its size limit"));
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        resolve(JSON.parse(raw) as ProofreaderControlResponse);
      } catch {
        reject(new Error("Proofreader service returned an invalid response"));
      }
    });
  });
}

export async function requestLaunch(
  socketPath: string,
  request: LaunchRequest,
): Promise<LaunchResponse> {
  const response = await requestControl(socketPath, { kind: "launch", request });
  if (response.kind !== "launch") throw new Error("Launch service returned an invalid response");
  return response.response;
}
