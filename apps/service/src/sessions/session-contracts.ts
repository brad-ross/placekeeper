import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";
import type { PlacekeeperLinkLocation } from "../../../../packages/core/src/placekeeper-link.js";
import type { ReviewItem, ReviewState, ReviewWorkflowMode } from "../../../../packages/core/src/review-model.js";
import type { SessionCredentialStore } from "../../../../packages/core/src/session-security.js";
import type { ChromePdfInspection } from "../browser/chrome-pdf-validator.js";
import type { RestartReconnectStore } from "../context/restart-reconnect-store.js";
import type { TaskBindingRegistry } from "../context/task-binding-registry.js";
import type { FileCapabilityRegistry } from "../files/file-capabilities.js";
import type { PdfAnchorPage } from "../reconciliation/pdf-anchor-reconciler.js";
import type {
  DurableInterruptedSourceChangeV1,
  DurableSaveDestination,
  DurableSaveSync,
  SnapshotHooks,
} from "../recovery/draft-snapshot.js";
import type { ForwardSyncTexResult, ReverseSyncTexResult, SyncTexNavigationStatus } from "../synctex/query.js";
import type { SessionControlRegistry } from "./control-socket.js";

export const RECOVERY_DECISIONS = ["resume", "discard", "fork"] as const;
export type RecoveryDecision = typeof RECOVERY_DECISIONS[number];
export interface RecoveryOfferIdentity {
  readonly id: string;
  readonly expiresAt: string;
}

export class RecoveryOfferUnavailableError extends Error {
  constructor(message = "Recovery choices are no longer current") {
    super(message);
    this.name = "RecoveryOfferUnavailableError";
  }
}

export class ReviewGenerationConflictError extends Error {
  constructor(
    readonly expectedGeneration: number,
    readonly currentGeneration: number,
    readonly currentRevision: number,
  ) {
    super(`Review generation ${expectedGeneration} is stale; current generation is ${currentGeneration}`);
    this.name = "ReviewGenerationConflictError";
  }
}
export const LAUNCH_SURFACES = ["browser", "finder", "codex", "vscode", "chrome"] as const;
export type LaunchSurface = typeof LAUNCH_SURFACES[number];
export const REVIEW_PRESENTATION_SURFACES = [...LAUNCH_SURFACES, "macos"] as const;
export type ReviewPresentationSurface = typeof REVIEW_PRESENTATION_SURFACES[number];

export function isRecoveryDecision(value: unknown): value is RecoveryDecision {
  return typeof value === "string" && RECOVERY_DECISIONS.includes(value as RecoveryDecision);
}

export function isLaunchSurface(value: unknown): value is LaunchSurface {
  return typeof value === "string" && LAUNCH_SURFACES.includes(value as LaunchSurface);
}

export interface OpenReviewRequest {
  readonly pdfPath: string;
  readonly sourceRootPath?: string;
  readonly recoveryDecision?: RecoveryDecision;
  readonly recoveryOffer?: RecoveryOfferIdentity;
  readonly recoveryOperationId?: string;
  readonly surface?: ReviewPresentationSurface;
  readonly requestedLocation?: PlacekeeperLinkLocation;
  readonly workflowMode?: ReviewWorkflowMode;
}

export interface SessionLaunch {
  readonly sessionId: string;
  readonly fileId: string;
  readonly rootId?: string;
  readonly launchPath: string;
  readonly fragment: string;
  readonly surface: ReviewPresentationSurface;
  readonly documentGeneration: number;
  readonly bindProof?: string;
}

export type OpenReviewResult =
  | { readonly kind: "opened" | "focused"; readonly launch: SessionLaunch }
  | {
      readonly kind: "recovery-offered";
      readonly recoverySessionId: string;
      readonly choices: readonly RecoveryDecision[];
      readonly recoveryOffer: RecoveryOfferIdentity;
    };

export interface HttpBootstrapExchange {
  readonly credential: string;
  readonly view?: {
    readonly id: string;
    readonly cookie: string;
    readonly pathname: string;
    readonly locationFragment: string;
    readonly reconnectCookie?: string;
  };
}

export interface ResumedBrowserView {
  readonly sessionId: string;
  readonly credential: string;
}

export interface SessionBrokerOptions {
  readonly recoveryRoot: string;
  readonly capabilities?: FileCapabilityRegistry;
  readonly credentials?: SessionCredentialStore;
  readonly controls?: SessionControlRegistry;
  readonly now?: () => Date;
  readonly snapshotHooks?: SnapshotHooks;
  readonly portableReader?: (bytes: Uint8Array) => Promise<readonly ReviewItem[]>;
  readonly rewriteAssessor?: (bytes: Uint8Array) => Promise<PdfRewriteEligibility>;
  readonly browserSourceInspector?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<ChromePdfInspection>;
  readonly taskBindings?: TaskBindingRegistry;
  readonly restartReconnectStore?: RestartReconnectStore;
  readonly maxGenerationBytes?: number;
  readonly maxGenerationCount?: number;
  readonly inspectGeneration?: (
    bytes: Uint8Array,
  ) => Promise<{ readonly pageCount: number; readonly pages: readonly PdfAnchorPage[] }>;
}

export type LiveDocumentReplacementResult =
  | {
      readonly status: "committed";
      readonly sessionId: string;
      readonly previousGeneration: number;
      readonly documentGeneration: number;
      readonly digest: string;
      readonly reviewRevision: number;
      readonly migratedTaskSessionId?: string;
    }
  | {
      readonly status: "same-digest" | "invalid" | "superseded" | "generation-conflict" | "deferred" |
        "retention-rejected";
      readonly sessionId: string;
      readonly documentGeneration: number;
      readonly reason: string;
    };

export interface DocumentGenerationEvent {
  readonly sessionId: string;
  readonly previousGeneration: number;
  readonly documentGeneration: number;
  readonly reviewRevision: number;
  readonly migratedTaskSessionId?: string;
}

export interface LocalDocumentObservationEvent {
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly observationSequence: number;
  readonly reason: string;
  readonly changed: boolean;
  readonly publication: "generated-output" | "ordinary-local";
}

export interface SourceWorkInterruptionCollection {
  readonly taskSessionId: string;
  readonly previousGeneration: number;
}

export type SourceWorkInterruptionCollector = (
  input: SourceWorkInterruptionCollection,
) => Promise<readonly DurableInterruptedSourceChangeV1[]>;

/**
 * Internal-only material used to build one atomic model-facing observation.
 * Paths and destination capabilities must be consumed inside the service and
 * never copied into a live-context response.
 */
export interface AtomicSessionProjection {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly state: ReviewState;
  readonly destination: DurableSaveDestination;
  readonly sync: DurableSaveSync;
  readonly sourceByteLength: number;
  readonly sourceSnapshotPath: string;
  readonly sourcePdfPath: string;
  readonly sourceRootPath?: string;
}

export interface VerifiedSourceSnapshot {
  readonly documentGeneration: number;
  readonly sourceDigest: string;
  readonly bytes: Buffer;
}

export interface SyncTexUnavailableResult {
  readonly status: Exclude<SyncTexNavigationStatus, "ok">;
  readonly operationToken: string;
  readonly documentGeneration?: number;
  readonly pdfDigest?: string;
  readonly reason: string;
}

export type BrokerForwardSyncTexResult = ForwardSyncTexResult | SyncTexUnavailableResult;
export type BrokerReverseSyncTexResult = ReverseSyncTexResult | SyncTexUnavailableResult;
