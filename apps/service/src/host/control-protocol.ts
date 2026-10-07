import {
  parseCodexAppRequest,
  parseCodexDisplayRequest,
  parseCodexDisplayReceipt,
  type CodexAppRequest,
  type CodexAppResponse,
  type CodexDisplayRequest,
  type CodexDisplayReceipt,
  type CodexPendingPresentation,
  type CodexAdmissionFailure,
} from "../../../../packages/core/src/codex-mcp-protocol.js";
import type { LiveContextRefreshResult, LiveExecutionBaselineV1 } from "../../../../packages/core/src/live-context.js";
import type { CompleteDispositionV1, LiveDispositionItemV1 } from "../../../../packages/core/src/disposition.js";
import type { PdfEvidenceRequest, PdfEvidenceUnavailableReason } from "../context/pdf-evidence-service.js";
import type { TaskBindingClaimResult } from "../context/task-binding-registry.js";
import type { AcceptedSourceProposal, SourceReconciliationReportV1, SourceReplacementProposalV1 } from "../context/source-reconciliation-service.js";
import type { CleanRebuildPlanV1, CleanRebuildVerificationV1, SourceWorkflowResult } from "../context/live-source-workflow-service.js";
import type { LaunchRequest, LaunchResponse, LinkLaunchResponse, LinkOpenRequest, LinkPreflightResponse } from "./placekeeper-host.js";
import { PLACEKEEPER_LINK_MAX_LENGTH } from "../../../../packages/core/src/placekeeper-link.js";
import { isLaunchSurface, isRecoveryDecision } from "../sessions/session-broker.js";
import { isChromeBrowserSourceOpenRequest, type ChromeBrowserSourceOpenRequest } from "../browser/browser-source-store.js";
import { type ChromeRuntimeHostMessage } from "../../../../packages/core/src/chrome-native-runtime-protocol.js";
import { parseMacosReviewHelperMessage, type MacosReviewHelperResponse } from "../../../../packages/core/src/macos-helper-protocol.js";
import { parseMacosAppControlMessage, type MacosAppControlResponse } from "../../../../packages/core/src/macos-app-control-protocol.js";

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

export type PlacekeeperControlRequest =
  | { readonly kind: "codex-display"; readonly request: CodexDisplayRequest }
  | { readonly kind: "codex-attest"; readonly taskSessionId: string; readonly receipt: CodexDisplayReceipt }
  | { readonly kind: "codex-app"; readonly request: CodexAppRequest }
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
  | { readonly kind: "chrome-open"; readonly request: ChromeBrowserSourceOpenRequest }
  | { readonly kind: "chrome-runtime"; readonly portId: string; readonly message: unknown }
  | { readonly kind: "chrome-runtime-detach"; readonly portId: string }
  | {
      readonly kind: "macos-runtime";
      readonly appInstanceId: string;
      readonly helperId: string;
      readonly message: unknown;
    }
  | {
      readonly kind: "macos-runtime-detach";
      readonly appInstanceId: string;
      readonly helperId: string;
    }
  | { readonly kind: "macos-app-control"; readonly message: unknown }
  | { readonly kind: "link-preflight"; readonly link: string }
  | { readonly kind: "link-open"; readonly request: LinkOpenRequest }
  | {
      readonly kind: "claim-binding";
      readonly native?: true;
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
  | { readonly kind: "codex-display"; readonly receipt: CodexDisplayReceipt; readonly pending: CodexPendingPresentation }
  | { readonly kind: "codex-attestation"; readonly status: "accepted" | "denied"; readonly reason?: CodexAdmissionFailure }
  | { readonly kind: "codex-app"; readonly response: CodexAppResponse }
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
  | { readonly kind: "chrome-open"; readonly response: LaunchResponse }
  | { readonly kind: "chrome-runtime"; readonly messages: readonly ChromeRuntimeHostMessage[] }
  | { readonly kind: "chrome-runtime-detached" }
  | { readonly kind: "macos-runtime"; readonly response: MacosReviewHelperResponse }
  | { readonly kind: "macos-runtime-detached" }
  | { readonly kind: "macos-app-control"; readonly response: MacosAppControlResponse }
  | { readonly kind: "link-preflight"; readonly response: LinkPreflightResponse }
  | { readonly kind: "link-open"; readonly response: LinkLaunchResponse }
  | { readonly kind: "binding"; readonly result: TaskBindingClaimResult }
  | { readonly kind: "codex-binding"; readonly status: "accepted" | "denied" }
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isControlRequest(value: unknown): value is PlacekeeperControlRequest {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "codex-display") {
    return Object.keys(value).length === 2 &&
      parseCodexDisplayRequest(value.request) !== undefined;
  }
  if (value.kind === "codex-app") {
    return Object.keys(value).length === 2 &&
      parseCodexAppRequest(value.request) !== undefined;
  }
  if (value.kind === "codex-attest") {
    return Object.keys(value).length === 3 &&
      typeof value.taskSessionId === "string" &&
      /^[A-Za-z0-9._:-]{1,256}$/u.test(value.taskSessionId) &&
      parseCodexDisplayReceipt(value.receipt) !== undefined;
  }
  if (value.kind === "management") {
    return value.protocolVersion === MANAGEMENT_PROTOCOL_VERSION &&
      (value.operation === "status" ||
        value.operation === "shutdown-if-idle");
  }
  if (value.kind === "launch") return isObject(value.request);
  if (value.kind === "chrome-open") {
    return Object.keys(value).length === 2 && Object.hasOwn(value, "request") &&
      isChromeBrowserSourceOpenRequest(value.request);
  }
  if (value.kind === "chrome-runtime") {
    return Object.keys(value).length === 3 && typeof value.portId === "string" &&
      /^[A-Za-z0-9_-]{16,128}$/u.test(value.portId) &&
      isObject(value.message);
  }
  if (value.kind === "chrome-runtime-detach") {
    return Object.keys(value).length === 2 && typeof value.portId === "string" &&
      /^[A-Za-z0-9_-]{16,128}$/u.test(value.portId);
  }
  if (value.kind === "macos-runtime") {
    return Object.keys(value).length === 4 && typeof value.appInstanceId === "string"
      && /^[A-Za-z0-9_-]{8,128}$/u.test(value.appInstanceId)
      && typeof value.helperId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.helperId)
      && parseMacosReviewHelperMessage(value.message) !== undefined;
  }
  if (value.kind === "macos-runtime-detach") {
    return Object.keys(value).length === 3 && typeof value.appInstanceId === "string"
      && /^[A-Za-z0-9_-]{8,128}$/u.test(value.appInstanceId)
      && typeof value.helperId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.helperId);
  }
  if (value.kind === "macos-app-control") {
    return Object.keys(value).length === 2 && parseMacosAppControlMessage(value.message) !== undefined;
  }
  if (value.kind === "link-preflight") {
    return typeof value.link === "string" && value.link.length <= PLACEKEEPER_LINK_MAX_LENGTH;
  }
  if (value.kind === "link-open") {
    return isObject(value.request) &&
      typeof value.request.link === "string" &&
      value.request.link.length <= PLACEKEEPER_LINK_MAX_LENGTH &&
      (value.request.confirmed === undefined || typeof value.request.confirmed === "boolean") &&
      (value.request.recovery === undefined || isRecoveryDecision(value.request.recovery)) &&
      (value.request.surface === undefined || isLaunchSurface(value.request.surface));
  }
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
    return (value.native === undefined || value.native === true) && typeof value.taskSessionId === "string" &&
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

