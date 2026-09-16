import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";
import type { PlacekeeperLinkLocation } from "../../../../packages/core/src/placekeeper-link.js";
import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import type { MatchedRestartReconnectTicket } from "../context/restart-reconnect-store.js";
import type {
  DraftSnapshotStore,
  DurableGenerationRecordV1,
  DurableSaveDestination,
  DurableSaveSync,
  DurableSourceWorkInterruptionV1,
  DurableNativeAnnotationLedgerV1,
  RecoverableSourceOwnership,
} from "../recovery/draft-snapshot.js";
import type { OpenReviewResult, RecoveryDecision, ReviewPresentationSurface } from "./session-contracts.js";
import type { ReviewInteractionReceipt } from "./review-interactions.js";

export interface RecoveryOfferRecord {
  readonly expiresAt: string;
  readonly recoverySessionId: string;
  readonly recoveredSourceDigest: string;
  readonly canonicalSourcePath: string;
  readonly requestedSourceDigest: string;
  readonly expiresAtMs: number;
  claimedOperationId?: string;
  claimedDecision?: RecoveryDecision;
}

export interface RecoveryOperationRecord {
  readonly fingerprint: string;
  readonly result: Promise<OpenReviewResult>;
  readonly offerId: string;
  readonly recoverySessionId?: string;
  readonly expiresAtMs: number;
}

export interface ActiveSession {
  readonly id: string;
  canonicalSourcePath: string;
  sourceSnapshotPath: string;
  readonly store: DraftSnapshotStore;
  readonly fileId: string;
  rootId?: string;
  state: ReviewState;
  lastExportAt?: string;
  currentOriginalDigest: string;
  acceptedOriginalDigests: string[];
  ending: boolean;
  writeTail: Promise<void>;
  destination: DurableSaveDestination;
  sync: DurableSaveSync;
  rewriteEligibility: PdfRewriteEligibility;
  generationLineage: DurableGenerationRecordV1[];
  latestObservationEpoch: number;
  /** The newest source observation that must settle before predecessor bytes
   * may be committed to either the original or an active copy destination. */
  physicalSaveBarrierEpoch?: number;
  sourceWorkInterruptions: DurableSourceWorkInterruptionV1[];
  nativeAnnotationLedger: DurableNativeAnnotationLedgerV1;
  syncTexOperationToken?: string;
  readonly documentGeneration: number;
  sourceOwnership: RecoverableSourceOwnership;
  chromeProtected: boolean;
  interactionReceipts: ReviewInteractionReceipt[];
  /** Blocks every serialized mutation/save/publication while a thrown recovery
   * persistence call has an unclassified authoritative winner. */
  replacementCommitBarrier?: {
    readonly resolve: () => Promise<"successor" | "predecessor" | "uncertain">;
  };
}

export interface BrowserLaunchScope {
  readonly sessionId: string;
  documentGeneration: number;
  readonly surface: ReviewPresentationSurface;
  readonly browserCapabilityHash: string;
  readonly requestedLocation?: PlacekeeperLinkLocation;
  readonly expiresAtMs: number;
  readonly reconnectBrowserToken?: string;
}

export interface BrowserViewRecord {
  readonly id: string;
  readonly cookieHash: string;
  readonly sessionId: string;
  documentGeneration: number;
  readonly credential: string;
  readonly pathname: string;
}

export interface ReconnectBindingMetadata {
  readonly taskSessionId: string;
  readonly browserToken: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly browserCapabilityHash: string;
  readonly canonicalSourcePath: string;
  readonly sourceDigest: string;
}

export interface PendingRestartReconnect {
  readonly ticket: MatchedRestartReconnectTicket;
  readonly browserToken: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly browserCapabilityHash: string;
  readonly canonicalSourcePath: string;
  readonly sourceDigest: string;
}
