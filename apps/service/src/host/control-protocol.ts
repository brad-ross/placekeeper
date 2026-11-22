import { parseExtensionRequest, type ExtensionRequest, type ExtensionResult } from "../../../../packages/core/src/extension-protocol.js";
import { isUpgradePreparationRequest, normalizeUpgradePreparationRequest, toWireUpgradePreparationRequest, type UpgradePreparationRequest, type UpgradePreparationResult, type UpgradeAttemptCredentials } from "./upgrade-preparation.js";
import { isEditorPath, parseEditorControlRequest, type EditorControlRequest, type EditorControlResponse } from "../../../../packages/core/src/editor-navigation-protocol.js";
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

import { parseElectronDocumentHelperMessage, type ElectronDocumentHelperResponse } from "../../../../packages/core/src/electron-helper-protocol.js";
import { parseElectronAppControlMessage, type ElectronAppControlResponse } from "../../../../packages/core/src/electron-app-control-protocol.js";

export const MANAGEMENT_PROTOCOL_VERSION = 1;

export type DaemonLifecycleState = "accepting" | "draining" | "shutdown-committed";

export interface DaemonAggregateActivity {
  readonly documentPresence: number;
  readonly codexTasks: number;
  readonly transientWork: number;
}

/**
 * Wire spelling of `DaemonAggregateActivity.documentPresence`. Installers and
 * CLIs inspect a daemon that may be older or newer than they are, so readers
 * accept both spellings and the daemon keeps sending the legacy one.
 *
 * TODO(0.4.0): send `documentPresence` once no supported installer or CLI
 * older than 0.3.3 (the first release that accepts it) can inspect a daemon.
 */
export const LEGACY_DOCUMENT_PRESENCE_KEY = "reviewPresence" as const;

export function toWireAggregateActivity(activity: DaemonAggregateActivity): Readonly<Record<string, number>> {
  return {
    [LEGACY_DOCUMENT_PRESENCE_KEY]: activity.documentPresence,
    codexTasks: activity.codexTasks,
    transientWork: activity.transientWork,
  };
}

export function parseAggregateActivity(value: unknown): DaemonAggregateActivity | undefined {
  if (!isObject(value)) return undefined;
  const documentPresence = value.documentPresence ?? value[LEGACY_DOCUMENT_PRESENCE_KEY];
  const counts = [documentPresence, value.codexTasks, value.transientWork];
  if (!counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) return undefined;
  return {
    documentPresence: documentPresence as number,
    codexTasks: value.codexTasks as number,
    transientWork: value.transientWork as number,
  };
}

export interface DaemonManagementStatus {
  readonly protocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
  readonly daemonIdentity: string;
  readonly readinessToken?: string;
  readonly upgradePreparationVersion?: 1;
  readonly lifecycle: DaemonLifecycleState;
  readonly activity: DaemonAggregateActivity;
}

export type DaemonUninspectableReason =
  | "malformed"
  | "oversized"
  | "timeout"
  | "early-close";

export type DaemonUpgradeReason = DaemonUninspectableReason | "incompatible" |
  "review-presence" | "codex-task" | "transient-busy" | "preparation-required";

export type DaemonCompatibilityResult =
  | { readonly kind: "exact"; readonly status: DaemonManagementStatus }
  | { readonly kind: "incompatible"; readonly status: DaemonManagementStatus }
  | { readonly kind: "uninspectable"; readonly reason: DaemonUninspectableReason };

export type PlacekeeperControlRequest =
  | { readonly kind: "extension-app"; readonly request: ExtensionRequest }
  | { readonly kind: "upgrade-preparation"; readonly request: UpgradePreparationRequest }
  | { readonly kind: "electron-resolve-launch"; readonly launchId: string }
  | { readonly kind: "electron-cancel-launch"; readonly launchId: string }
  | { readonly kind: "editor-control"; readonly request: EditorControlRequest; readonly installation?: { readonly identity: string; readonly resources: string } }
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
      readonly preparation?: UpgradeAttemptCredentials;
    }
  | { readonly kind: "launch"; readonly request: LaunchRequest }
  | { readonly kind: "chrome-open"; readonly request: ChromeBrowserSourceOpenRequest }
  | { readonly kind: "chrome-runtime"; readonly portId: string; readonly message: unknown }
  | { readonly kind: "chrome-runtime-detach"; readonly portId: string }
  | {
      readonly kind: "electron-runtime";
      readonly appInstanceId: string;
      readonly helperId: string;
      readonly message: unknown;
    }
  | {
      readonly kind: "electron-runtime-detach";
      readonly appInstanceId: string;
      readonly helperId: string;
    }
  | { readonly kind: "electron-app-control"; readonly message: unknown }
  | { readonly kind: "link-preflight"; readonly link: string }
  | { readonly kind: "link-open"; readonly request: LinkOpenRequest }
  | {
      readonly kind: "claim-binding";
      readonly native?: true;
      readonly taskSessionId: string;
      readonly documentSessionId: string;
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
  | AnnotationsByHandleRequest<AnnotationsByHandleKind>
  | AnnotationChangesByHandleRequest<AnnotationChangesByHandleKind>;

/** Distributes over K so each spelling is its own discriminated member. */
type AnnotationsByHandleRequest<K extends AnnotationsByHandleKind> = K extends unknown ? {
  readonly kind: K;
  readonly handle: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly pageIndex?: number;
  readonly maxBytes?: number;
} : never;
type AnnotationChangesByHandleRequest<K extends AnnotationChangesByHandleKind> = K extends unknown ? {
  readonly kind: K;
  readonly handle: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly maxBytes?: number;
} : never;

export type PlacekeeperControlResponse =
  | { readonly kind: "extension-app"; readonly response: ExtensionResult | CodexAppResponse }
  | { readonly kind: "upgrade-preparation"; readonly result: UpgradePreparationResult }
  | { readonly kind: "electron-resolve-launch"; readonly target?: { readonly sourcePath: string; readonly sessionId: string; readonly documentGeneration: number } }
  | { readonly kind: "electron-cancel-launch"; readonly canceled: boolean }
  | { readonly kind: "editor-control"; readonly response: EditorControlResponse }
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
  | { readonly kind: "electron-runtime"; readonly response: ElectronDocumentHelperResponse }
  | { readonly kind: "electron-runtime-detached" }
  | { readonly kind: "electron-app-control"; readonly response: ElectronAppControlResponse }
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

/**
 * Control request kinds for `placekeeper context items|changes`, legacy
 * spelling first. A long-lived daemon can be older or newer than the CLI that
 * talks to it, so the daemon accepts both spellings and the CLI keeps sending
 * the legacy one.
 *
 * TODO(0.4.0): send the renamed kinds from the CLI once no supported daemon
 * older than 0.3.3 (the first release that accepts them) can still be running.
 */
export const ANNOTATIONS_BY_HANDLE_KINDS = ["retrieve-review-items-by-handle", "retrieve-annotations-by-handle"] as const;
export const ANNOTATION_CHANGES_BY_HANDLE_KINDS = ["retrieve-review-changes-by-handle", "retrieve-annotation-changes-by-handle"] as const;
export type AnnotationsByHandleKind = typeof ANNOTATIONS_BY_HANDLE_KINDS[number];
export type AnnotationChangesByHandleKind = typeof ANNOTATION_CHANGES_BY_HANDLE_KINDS[number];
export function isAnnotationsByHandleKind(value: unknown): value is AnnotationsByHandleKind {
  return (ANNOTATIONS_BY_HANDLE_KINDS as readonly unknown[]).includes(value);
}
export function isAnnotationChangesByHandleKind(value: unknown): value is AnnotationChangesByHandleKind {
  return (ANNOTATION_CHANGES_BY_HANDLE_KINDS as readonly unknown[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wire spelling of the claim-binding document session field. The hook CLI and
 * a long-lived daemon upgrade independently, so the daemon accepts both
 * spellings and senders keep the legacy one through `toWireControlRequest`.
 *
 * TODO(0.4.0): send `documentSessionId` once no supported daemon older than
 * 0.3.3 (the first release that accepts it) can still be running.
 */
export const LEGACY_CLAIM_BINDING_SESSION_KEY = "reviewSessionId" as const;

function claimBindingDocumentSessionId(value: Record<string, unknown>): string | undefined {
  const current = value.documentSessionId;
  const legacy = value[LEGACY_CLAIM_BINDING_SESSION_KEY];
  if (current !== undefined && legacy !== undefined && current !== legacy) return undefined;
  const sessionId = current ?? legacy;
  return typeof sessionId === "string" ? sessionId : undefined;
}

/** Validates and normalizes one decoded control request; the only receive-side
 * translation point for renamed wire fields. */
export function parseControlRequest(value: unknown): PlacekeeperControlRequest | undefined {
  if (!isControlRequest(value)) return undefined;
  const request = value as Record<string, unknown>;
  if (request.kind === "upgrade-preparation") {
    return { kind: "upgrade-preparation", request: normalizeUpgradePreparationRequest(request.request as UpgradePreparationRequest) };
  }
  if (request.kind !== "claim-binding") return value as PlacekeeperControlRequest;
  const { [LEGACY_CLAIM_BINDING_SESSION_KEY]: _legacy, documentSessionId: _current, ...rest } = request;
  return { ...rest, documentSessionId: claimBindingDocumentSessionId(request)! } as PlacekeeperControlRequest;
}

/** The only receive-side translation point for renamed control response
 * fields. Malformed activity is left untouched for the caller's validator. */
export function parseControlResponse(value: unknown): PlacekeeperControlResponse {
  if (!isObject(value)) return value as PlacekeeperControlResponse;
  const withActivity = (holder: unknown): unknown => {
    if (!isObject(holder) || !("activity" in holder)) return holder;
    const activity = parseAggregateActivity(holder.activity);
    return activity === undefined ? holder : { ...holder, activity };
  };
  if (value.kind === "management" && value.operation === "status") {
    return { ...value, status: withActivity(value.status) } as PlacekeeperControlResponse;
  }
  if (value.kind === "management" && value.operation === "shutdown-if-idle") {
    return { ...value, result: withActivity(value.result) } as PlacekeeperControlResponse;
  }
  if (value.kind === "upgrade-preparation") {
    return { ...value, result: withActivity(value.result) } as PlacekeeperControlResponse;
  }
  return value as PlacekeeperControlResponse;
}

/** The only send-side translation point for renamed control response fields. */
export function toWireControlResponse(response: PlacekeeperControlResponse): unknown {
  if (response.kind === "management" && response.operation === "status") {
    return { ...response, status: { ...response.status, activity: toWireAggregateActivity(response.status.activity) } };
  }
  if (response.kind === "management" && response.operation === "shutdown-if-idle" && response.result.status === "refused") {
    return { ...response, result: { ...response.result, activity: toWireAggregateActivity(response.result.activity) } };
  }
  if (response.kind === "upgrade-preparation" && "activity" in response.result) {
    return { ...response, result: { ...response.result, activity: toWireAggregateActivity(response.result.activity) } };
  }
  return response;
}

/** The only send-side translation point for renamed control request fields. */
export function toWireControlRequest(request: PlacekeeperControlRequest): Readonly<Record<string, unknown>> {
  if (request.kind === "upgrade-preparation") return { ...request, request: toWireUpgradePreparationRequest(request.request) };
  if (request.kind !== "claim-binding") return request;
  const { documentSessionId, ...rest } = request;
  return { ...rest, [LEGACY_CLAIM_BINDING_SESSION_KEY]: documentSessionId };
}

/** Validates the wire form, including legacy field spellings. Use
 * `parseControlRequest` to obtain the normalized in-memory request. */
export function isControlRequest(value: unknown): boolean {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "upgrade-preparation") return Object.keys(value).length === 2 && isUpgradePreparationRequest(value.request);
  if (value.kind === "editor-control") return Object.keys(value).length === (value.installation === undefined ? 2 : 3) && parseEditorControlRequest(value.request) !== undefined
    && (value.installation === undefined || (isObject(value.installation) && Object.keys(value.installation).length === 2
      && typeof value.installation.identity === "string" && /^[a-f0-9]{64}$/u.test(value.installation.identity) && isEditorPath(value.installation.resources)));
  if (value.kind === "codex-display") {
    return Object.keys(value).length === 2 &&
      parseCodexDisplayRequest(value.request) !== undefined;
  }
  if (value.kind === "extension-app") return Object.keys(value).length === 2 && parseExtensionRequest(value.request) !== undefined;
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
        (value.operation === "shutdown-if-idle" && (value.preparation === undefined || isUpgradePreparationRequest({ operation: "status", credentials: value.preparation }))));
  }
  if (value.kind === "electron-resolve-launch" || value.kind === "electron-cancel-launch") return typeof value.launchId === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.launchId);
  if (value.kind === "launch") return isObject(value.request) && (value.request.desktop === undefined || value.request.desktop === "electron");
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
  if (value.kind === "electron-runtime") {
    return Object.keys(value).length === 4 && typeof value.appInstanceId === "string"
      && /^[A-Za-z0-9_-]{8,128}$/u.test(value.appInstanceId)
      && typeof value.helperId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.helperId)
      && parseElectronDocumentHelperMessage(value.message) !== undefined;
  }
  if (value.kind === "electron-runtime-detach") {
    return Object.keys(value).length === 3 && typeof value.appInstanceId === "string"
      && /^[A-Za-z0-9_-]{8,128}$/u.test(value.appInstanceId)
      && typeof value.helperId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value.helperId);
  }
  if (value.kind === "electron-app-control") {
    return Object.keys(value).length === 2 && parseElectronAppControlMessage(value.message) !== undefined;
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
      (value.request.surface === undefined || isLaunchSurface(value.request.surface)) &&
      (value.request.desktop === undefined || value.request.desktop === "electron");
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
      claimBindingDocumentSessionId(value) !== undefined &&
      typeof value.documentGeneration === "number" &&
      typeof value.bindProof === "string";
  }
  if (isAnnotationsByHandleKind(value.kind) || isAnnotationChangesByHandleKind(value.kind)) {
    return typeof value.handle === "string";
  }
  if (value.kind === "retrieve-evidence" || value.kind === "retrieve-evidence-by-handle") {
    return (value.kind !== "retrieve-evidence" || typeof value.taskSessionId === "string") &&
      typeof value.handle === "string" && isObject(value.request) &&
      typeof value.request.kind === "string";
  }
  return false;
}

