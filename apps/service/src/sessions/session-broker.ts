import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  documentOrderedItems,
  projectReviewItems,
} from "../../../../packages/core/src/annotation-projection.js";
import type {
  ReviewCommand,
  ReviewItem,
  ReviewState,
  ReviewWorkflowMode,
} from "../../../../packages/core/src/review-model.js";
import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";
import {
  encodePlacekeeperLinkFragment,
  encodePlacekeeperReadableViewPathname,
  type PlacekeeperLinkLocation,
} from "../../../../packages/core/src/placekeeper-link.js";
import { createReviewState } from "../../../../packages/core/src/review-model.js";
import {
  assertPortableAnnotationWritable,
  createImportedReviewState,
} from "../../../../packages/core/src/portable-annotation.js";
import { reduceReview } from "../../../../packages/core/src/review-reducer.js";
import {
  createReviewStateSummary,
  reviewSemanticDigest,
} from "../../../../packages/core/src/live-context.js";
import {
  digestSecretHex,
  SessionCredentialStore,
} from "../../../../packages/core/src/session-security.js";
import {
  FileCapabilityRegistry,
  hashFile,
} from "../files/file-capabilities.js";
import {
  DraftSnapshotStore,
  reviewStateDigest,
  type DurableSaveDestination,
  type DurableSaveSync,
  type RecoverableDraftV2,
  type SaveFailureReason,
  type SnapshotHooks,
} from "../recovery/draft-snapshot.js";
import {
  createSourceSnapshot,
  ensurePrivateDirectory,
} from "../recovery/source-snapshot.js";
import type { FrozenReviewDelivery } from "../export/export-coordinator.js";
import {
  assessPdfRewriteEligibility,
  migrateLegacyReviewStateGeometry,
  readPortableReviewItems,
} from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import { SessionControlRegistry } from "./control-socket.js";
import { TaskBindingRegistry } from "../context/task-binding-registry.js";
import {
  RestartReconnectStore,
  type MatchedRestartReconnectTicket,
} from "../context/restart-reconnect-store.js";

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
export const LAUNCH_SURFACES = ["browser", "finder", "codex", "vscode"] as const;
export type LaunchSurface = typeof LAUNCH_SURFACES[number];

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
  readonly surface?: LaunchSurface;
  readonly requestedLocation?: PlacekeeperLinkLocation;
  readonly workflowMode?: ReviewWorkflowMode;
}

export interface SessionLaunch {
  readonly sessionId: string;
  readonly fileId: string;
  readonly rootId?: string;
  readonly launchPath: string;
  readonly fragment: string;
  readonly surface: LaunchSurface;
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

interface RecoveryOfferRecord {
  readonly expiresAt: string;
  readonly recoverySessionId: string;
  readonly recoveredSourceDigest: string;
  readonly canonicalSourcePath: string;
  readonly requestedSourceDigest: string;
  readonly expiresAtMs: number;
  claimedOperationId?: string;
  claimedDecision?: RecoveryDecision;
}

interface RecoveryOperationRecord {
  readonly fingerprint: string;
  readonly result: Promise<OpenReviewResult>;
  readonly offerId: string;
  readonly recoverySessionId?: string;
  readonly expiresAtMs: number;
}

interface ActiveSession {
  readonly id: string;
  canonicalSourcePath: string;
  readonly sourceSnapshotPath: string;
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
  readonly documentGeneration: number;
}

interface BrowserLaunchScope {
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly surface: LaunchSurface;
  readonly browserCapabilityHash: string;
  readonly requestedLocation?: PlacekeeperLinkLocation;
  readonly expiresAtMs: number;
  readonly reconnectBrowserToken?: string;
}

interface BrowserViewRecord {
  readonly id: string;
  readonly cookieHash: string;
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly credential: string;
  readonly pathname: string;
}

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

interface ReconnectBindingMetadata {
  readonly taskSessionId: string;
  readonly browserToken: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly browserCapabilityHash: string;
  readonly canonicalSourcePath: string;
  readonly sourceDigest: string;
}

interface PendingRestartReconnect {
  readonly ticket: MatchedRestartReconnectTicket;
  readonly browserToken: string;
  readonly reviewSessionId: string;
  readonly documentGeneration: number;
  readonly browserCapabilityHash: string;
  readonly canonicalSourcePath: string;
  readonly sourceDigest: string;
}

export interface ResumedBrowserView {
  readonly sessionId: string;
  readonly credential: string;
}

const BOOTSTRAP_TTL_MS = 60_000;
const RECOVERY_OFFER_TTL_MS = 5 * 60_000;
const RECOVERY_ID = /^[A-Za-z0-9_-]{16,128}$/u;
// A prompt and the replacement browser bootstrap commonly arrive together;
// keep the control request bounded while allowing their two-sided handshake.
const RESTART_RECONNECT_WAIT_MS = 4_500;

export interface SessionBrokerOptions {
  readonly recoveryRoot: string;
  readonly capabilities?: FileCapabilityRegistry;
  readonly credentials?: SessionCredentialStore;
  readonly controls?: SessionControlRegistry;
  readonly now?: () => Date;
  readonly snapshotHooks?: SnapshotHooks;
  readonly portableReader?: (bytes: Uint8Array) => Promise<readonly ReviewItem[]>;
  readonly rewriteAssessor?: (bytes: Uint8Array) => Promise<PdfRewriteEligibility>;
  readonly taskBindings?: TaskBindingRegistry;
  readonly restartReconnectStore?: RestartReconnectStore;
}

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

function activeKey(path: string, digest: string): string {
  return `${path}\0${digest}`;
}

export class SessionBroker {
  readonly recoveryRoot: string;
  readonly capabilities: FileCapabilityRegistry;
  readonly credentials: SessionCredentialStore;
  readonly controls: SessionControlRegistry;
  readonly taskBindings: TaskBindingRegistry;
  readonly restartReconnects: RestartReconnectStore;
  readonly #now: () => Date;
  readonly #snapshotHooks: SnapshotHooks;
  readonly #portableReader: (bytes: Uint8Array) => Promise<readonly ReviewItem[]>;
  readonly #rewriteAssessor: (bytes: Uint8Array) => Promise<PdfRewriteEligibility>;
  readonly #activeById = new Map<string, ActiveSession>();
  readonly #activeBySource = new Map<string, string>();
  readonly #bootstrapScopes = new Map<string, BrowserLaunchScope>();
  readonly #credentialScopes = new Map<string, BrowserLaunchScope>();
  readonly #viewsById = new Map<string, BrowserViewRecord>();
  readonly #recoveryOffers = new Map<string, RecoveryOfferRecord>();
  readonly #recoveryOperations = new Map<string, RecoveryOperationRecord>();
  readonly #reconnectByBindProofHash = new Map<
    string,
    Omit<ReconnectBindingMetadata, "taskSessionId"> & { readonly expiresAtMs: number }
  >();
  readonly #reconnectBindingsByCapabilityHash = new Map<string, ReconnectBindingMetadata>();
  readonly #pendingRestartReconnects = new Map<string, PendingRestartReconnect>();
  readonly #restartReconnectWaiters = new Map<string, Set<() => void>>();
  readonly #sessionEndListeners = new Set<(sessionId: string) => void>();

  constructor(options: SessionBrokerOptions) {
    this.recoveryRoot = options.recoveryRoot;
    this.capabilities = options.capabilities ?? new FileCapabilityRegistry();
    this.credentials = options.credentials ?? new SessionCredentialStore();
    this.controls = options.controls ?? new SessionControlRegistry();
    this.taskBindings = options.taskBindings ?? new TaskBindingRegistry(
      options.now === undefined ? {} : { now: options.now },
    );
    this.restartReconnects = options.restartReconnectStore ??
      new RestartReconnectStore(join(this.recoveryRoot, ".restart-reconnect"), {
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    this.#now = options.now ?? (() => new Date());
    this.#snapshotHooks = options.snapshotHooks ?? {};
    this.#portableReader = options.portableReader ?? readPortableReviewItems;
    this.#rewriteAssessor = options.rewriteAssessor ??
      (options.portableReader === undefined
        ? assessPdfRewriteEligibility
        : async () => ({ eligible: true }));
  }

  onSessionEnd(listener: (sessionId: string) => void): () => void {
    this.#sessionEndListeners.add(listener);
    return () => this.#sessionEndListeners.delete(listener);
  }

  #store(sessionId: string): DraftSnapshotStore {
    return new DraftSnapshotStore(
      join(this.recoveryRoot, sessionId),
      this.#snapshotHooks,
    );
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.recoveryRoot);
    await this.restartReconnects.initialize();
    const entries = await readdir(this.recoveryRoot, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) =>
          this.#store(entry.name).initialize(),
        ),
    );
  }

  async #recoverableDrafts(): Promise<RecoverableDraftV2[]> {
    await this.initialize();
    const entries = await readdir(this.recoveryRoot, { withFileTypes: true });
    const recovered = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) =>
          this.#store(entry.name).recover(),
        ),
    );
    return recovered.filter(
      (draft): draft is RecoverableDraftV2 => draft !== undefined,
    );
  }

  #launch(
    session: ActiveSession,
    surface: LaunchSurface,
    requestedLocation?: PlacekeeperLinkLocation,
  ): SessionLaunch {
    const capability = this.credentials.issueBootstrap(session.id, BOOTSTRAP_TTL_MS);
    const reconnectBrowserToken = surface === "codex"
      ? randomBytes(32).toString("base64url")
      : undefined;
    const launchScope: BrowserLaunchScope = {
      sessionId: session.id,
      documentGeneration: session.documentGeneration,
      surface,
      browserCapabilityHash: digestSecretHex(capability),
      ...(requestedLocation === undefined ? {} : { requestedLocation }),
      expiresAtMs: this.#now().getTime() + BOOTSTRAP_TTL_MS,
      ...(reconnectBrowserToken === undefined ? {} : { reconnectBrowserToken }),
    };
    this.#bootstrapScopes.set(digestSecretHex(capability), launchScope);
    const bindProof = surface === "codex"
      ? this.taskBindings.issueBindProof({
          reviewSessionId: session.id,
          documentGeneration: session.documentGeneration,
          browserCapability: capability,
        })
      : undefined;
    if (bindProof !== undefined && reconnectBrowserToken !== undefined) {
      this.#reconnectByBindProofHash.set(digestSecretHex(bindProof), {
        browserToken: reconnectBrowserToken,
        reviewSessionId: session.id,
        documentGeneration: session.documentGeneration,
        browserCapabilityHash: launchScope.browserCapabilityHash,
        canonicalSourcePath: session.canonicalSourcePath,
        sourceDigest: session.state.source.digest,
        expiresAtMs: launchScope.expiresAtMs,
      });
    }
    return {
      sessionId: session.id,
      fileId: session.fileId,
      ...(session.rootId === undefined ? {} : { rootId: session.rootId }),
      launchPath: `/s/${session.id}/bootstrap`,
      fragment: `#cap=${capability}`,
      surface,
      documentGeneration: session.documentGeneration,
      ...(bindProof === undefined ? {} : { bindProof }),
    };
  }

  async openReview(request: OpenReviewRequest): Promise<OpenReviewResult> {
    await this.initialize();
    this.#sweepRecoveryRecords();
    const approvedFile = await this.capabilities.approvePdf(request.pdfPath);
    const sourceDigest = await hashFile(approvedFile.canonicalPath);
    if (request.recoveryDecision === undefined) {
      if (request.recoveryOffer !== undefined || request.recoveryOperationId !== undefined) {
        this.capabilities.revokeFile(approvedFile.id);
        throw new Error("Recovery identity requires an exact recovery choice");
      }
      return this.#openApprovedReview(request, approvedFile, sourceDigest);
    }
    const boundRecovery = request.recoveryOffer !== undefined &&
      request.recoveryOperationId !== undefined;
    if (!boundRecovery) {
      if (request.recoveryDecision !== "fork") {
        this.capabilities.revokeFile(approvedFile.id);
        throw new Error("Recovery decision requires an exact offer and operation identity");
      }
      return this.#openApprovedReview(request, approvedFile, sourceDigest);
    }
    if (
      !RECOVERY_ID.test(request.recoveryOffer!.id) ||
      !RECOVERY_ID.test(request.recoveryOperationId!) ||
      !Number.isFinite(Date.parse(request.recoveryOffer!.expiresAt))
    ) {
      this.capabilities.revokeFile(approvedFile.id);
      throw new Error("Recovery identity is invalid");
    }
    const fingerprint = [
      request.recoveryOffer!.id,
      request.recoveryOffer!.expiresAt,
      request.recoveryDecision,
      approvedFile.canonicalPath,
      sourceDigest,
    ].join("\0");
    const existing = this.#recoveryOperations.get(request.recoveryOperationId!);
    if (existing !== undefined) {
      this.capabilities.revokeFile(approvedFile.id);
      if (existing.fingerprint !== fingerprint) {
        throw new Error("Recovery operation was replayed with a different offer or choice");
      }
      return existing.result;
    }
    const offered = this.#recoveryOffers.get(request.recoveryOffer!.id);
    const result = this.#openApprovedReview(request, approvedFile, sourceDigest);
    this.#recoveryOperations.set(request.recoveryOperationId!, {
      fingerprint,
      result,
      offerId: request.recoveryOffer!.id,
      ...(offered === undefined ? {} : { recoverySessionId: offered.recoverySessionId }),
      expiresAtMs: offered?.expiresAtMs ?? this.#now().getTime() + RECOVERY_OFFER_TTL_MS,
    });
    try {
      return await result;
    } catch (error) {
      this.#recoveryOperations.delete(request.recoveryOperationId!);
      const offer = this.#recoveryOffers.get(request.recoveryOffer!.id);
      if (offer?.claimedOperationId === request.recoveryOperationId) {
        delete offer.claimedOperationId;
        delete offer.claimedDecision;
      }
      throw error;
    }
  }

  async #openApprovedReview(
    request: OpenReviewRequest,
    approvedFile: { readonly id: string; readonly canonicalPath: string },
    sourceDigest: string,
  ): Promise<OpenReviewResult> {
    const key = activeKey(approvedFile.canonicalPath, sourceDigest);
    const existingSessionId = this.#activeBySource.get(key);
    if (existingSessionId !== undefined && request.recoveryDecision === undefined) {
      this.capabilities.revokeFile(approvedFile.id);
      const session = this.#activeById.get(existingSessionId);
      if (session === undefined) throw new Error("Active session index is inconsistent");
      if (request.workflowMode !== undefined && request.workflowMode !== session.state.workflow.mode) {
        throw new Error("A review session workflow mode cannot be downgraded or changed");
      }
      if (request.sourceRootPath !== undefined) {
        await this.#attachSourceRoot(session, request.sourceRootPath);
      }
      return {
        kind: "focused",
        launch: this.#launch(session, request.surface ?? "browser", request.requestedLocation),
      };
    }

    const rewriteEligibility = await this.#rewriteAssessor(
      new Uint8Array(await readFile(approvedFile.canonicalPath)),
    );

    const drafts = await this.#recoverableDrafts();
    const identityMatches = drafts.filter(
      (draft) =>
        draft.sync.phase !== "clean" &&
        (draft.state.source.digest === sourceDigest ||
          draft.acceptedOriginalDigests?.includes(sourceDigest) === true ||
          (draft.destination.phase === "active" &&
            draft.destination.kind === "original" &&
            draft.destination.fingerprint === sourceDigest)),
    );
    const pathMatches = identityMatches.filter(
      (draft) => draft.canonicalSourcePath === approvedFile.canonicalPath,
    );
    const movedOriginalMatches = identityMatches.filter(
      (draft) =>
        draft.destination.phase === "active" &&
        draft.destination.kind === "original" &&
        draft.destination.fingerprint === sourceDigest,
    );
    if (pathMatches.length > 1 || (pathMatches.length === 0 && movedOriginalMatches.length > 1)) {
      this.capabilities.revokeFile(approvedFile.id);
      throw new Error("Recovery target is ambiguous; protected work was left unchanged");
    }
    const matchingDraft = pathMatches[0] ?? movedOriginalMatches[0];

    if (matchingDraft !== undefined && request.recoveryDecision === undefined) {
      this.capabilities.revokeFile(approvedFile.id);
      const currentOffer = [...this.#recoveryOffers.entries()].find(([, offer]) =>
        offer.expiresAtMs > this.#now().getTime() &&
        offer.recoverySessionId === matchingDraft.state.sessionId &&
        offer.recoveredSourceDigest === matchingDraft.state.source.digest &&
        offer.canonicalSourcePath === approvedFile.canonicalPath &&
        offer.requestedSourceDigest === sourceDigest
      );
      const recoveryOffer = currentOffer === undefined
        ? {
            id: randomBytes(24).toString("base64url"),
            expiresAt: new Date(this.#now().getTime() + RECOVERY_OFFER_TTL_MS).toISOString(),
          } satisfies RecoveryOfferIdentity
        : { id: currentOffer[0], expiresAt: currentOffer[1].expiresAt };
      if (currentOffer === undefined) {
        this.#recoveryOffers.set(recoveryOffer.id, {
          expiresAt: recoveryOffer.expiresAt,
          recoverySessionId: matchingDraft.state.sessionId,
          recoveredSourceDigest: matchingDraft.state.source.digest,
          canonicalSourcePath: approvedFile.canonicalPath,
          requestedSourceDigest: sourceDigest,
          expiresAtMs: Date.parse(recoveryOffer.expiresAt),
        });
      }
      return {
        kind: "recovery-offered",
        recoverySessionId: matchingDraft.state.sessionId,
        choices: RECOVERY_DECISIONS,
        recoveryOffer,
      };
    }

    if (request.recoveryOffer !== undefined) {
      if (request.recoveryOperationId === undefined || request.recoveryDecision === undefined) {
        this.capabilities.revokeFile(approvedFile.id);
        throw new Error("Recovery offer requires an exact choice and operation identity");
      }
      const offer = this.#recoveryOffers.get(request.recoveryOffer.id);
      if (
        offer === undefined ||
        offer.expiresAt !== request.recoveryOffer.expiresAt ||
        offer.expiresAtMs <= this.#now().getTime() ||
        matchingDraft === undefined ||
        offer.recoverySessionId !== matchingDraft.state.sessionId ||
        offer.recoveredSourceDigest !== matchingDraft.state.source.digest ||
        offer.canonicalSourcePath !== approvedFile.canonicalPath ||
        offer.requestedSourceDigest !== sourceDigest
      ) {
        this.capabilities.revokeFile(approvedFile.id);
        throw new RecoveryOfferUnavailableError(
          "Recovery offer is stale, expired, or does not match this protected draft",
        );
      }
      if (
        offer.claimedOperationId !== undefined &&
        (offer.claimedOperationId !== request.recoveryOperationId ||
          offer.claimedDecision !== request.recoveryDecision)
      ) {
        this.capabilities.revokeFile(approvedFile.id);
        throw new RecoveryOfferUnavailableError(
          "Recovery offer was already used by a different operation or choice",
        );
      }
      offer.claimedOperationId = request.recoveryOperationId;
      offer.claimedDecision = request.recoveryDecision;
      for (const [siblingId, sibling] of this.#recoveryOffers) {
        if (
          siblingId !== request.recoveryOffer.id &&
          sibling.recoverySessionId === offer.recoverySessionId
        ) {
          this.#deleteRecoveryOffer(siblingId);
        }
      }
    } else if (matchingDraft !== undefined) {
      this.capabilities.revokeFile(approvedFile.id);
      throw new Error("Protected recovery requires the exact offered identity");
    }

    let approvedRoot:
      | { readonly id: string; readonly canonicalPath: string }
      | undefined;
    if (request.sourceRootPath !== undefined) {
      approvedRoot = await this.capabilities.approveRoot(request.sourceRootPath);
    }

    if (matchingDraft !== undefined && request.recoveryDecision === "resume") {
      const sourceSnapshotBytes = new Uint8Array(await readFile(matchingDraft.sourceSnapshotPath));
      if (
        (await hashFile(matchingDraft.sourceSnapshotPath)) !==
          matchingDraft.state.source.digest ||
        sourceSnapshotBytes.byteLength !== matchingDraft.state.source.byteLength
      ) {
        throw new Error("Recovery source snapshot failed integrity validation");
      }
      const geometryMigrated = matchingDraft.state.schemaVersion === 1;
      const migratedState = await migrateLegacyReviewStateGeometry(
        sourceSnapshotBytes,
        matchingDraft.state,
      );
      const resumedState: ReviewState = {
        ...migratedState,
        source: { ...migratedState.source, fileId: approvedFile.id },
        ...(approvedRoot === undefined ? {} : { sourceRootId: approvedRoot.id }),
      };
      if (
        request.workflowMode !== undefined &&
        resumedState.workflow.mode !== request.workflowMode
      ) {
        throw new Error("A review session workflow mode cannot be downgraded or changed");
      }
      if (approvedRoot === undefined) delete (resumedState as { sourceRootId?: string }).sourceRootId;
      let destination = matchingDraft.destination;
      let sync = matchingDraft.sync.phase === "saving"
        ? { ...matchingDraft.sync, phase: "not-saved" as const, failure: "write-failed" as const }
        : matchingDraft.sync;
      if (geometryMigrated) {
        sync = {
          ...sync,
          phase: "not-saved",
          desiredDigest: reviewStateDigest(resumedState),
          failure: resumedState.items.length === 0
            ? "destination-unconfigured"
            : "write-failed",
        };
      }
      if (resumedState.workflow.mode === "generated-output") {
        destination = { phase: "none", generation: 0 };
        sync = {
          phase: resumedState.revision === 0 && resumedState.items.length === 0 && resumedState.pendingDrafts.length === 0
            ? "clean"
            : "not-saved",
          desiredRevision: resumedState.revision,
          desiredDigest: reviewStateDigest(resumedState),
          savedRevision: -1,
          ...(resumedState.revision === 0 && resumedState.items.length === 0 && resumedState.pendingDrafts.length === 0
            ? { savedDigest: reviewStateDigest(resumedState) }
            : { failure: "destination-unconfigured" as const }),
        };
      } else if (destination.phase === "active" && destination.kind === "original") {
        destination = {
          ...destination,
          targetPath: approvedFile.canonicalPath,
          capabilityId: approvedFile.id,
          fingerprint: sourceDigest,
        };
      } else if (destination.phase === "active" && destination.kind === "copy") {
        try {
          const capability = await this.capabilities.preauthorizeDestination(
            destination.targetPath,
          );
          if (destination.fingerprint === undefined) {
            if (capability.existingTarget !== undefined) {
              throw new Error("Unidentified recovery target already exists");
            }
          } else {
            await this.capabilities.refreshDestination(
              capability.id,
              destination.fingerprint,
            );
          }
          destination = {
            ...destination,
            targetPath: join(capability.parentPath, capability.filename),
            capabilityId: capability.id,
          };
        } catch (error) {
          const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
          const { capabilityId: _staleCapabilityId, ...unboundDestination } = destination;
          destination = unboundDestination;
          sync = {
            ...sync,
            phase: "not-saved",
            failure: missing ? "missing" : "target-changed",
          };
        }
      }
      const session: ActiveSession = {
        id: matchingDraft.state.sessionId,
        canonicalSourcePath: approvedFile.canonicalPath,
        sourceSnapshotPath: matchingDraft.sourceSnapshotPath,
        store: this.#store(matchingDraft.state.sessionId),
        fileId: approvedFile.id,
        ...(approvedRoot === undefined ? {} : { rootId: approvedRoot.id }),
        state: resumedState,
        ...(matchingDraft.lastExportAt === undefined
          ? {}
          : { lastExportAt: matchingDraft.lastExportAt }),
        currentOriginalDigest: sourceDigest,
        acceptedOriginalDigests: [...(matchingDraft.acceptedOriginalDigests ?? [])],
        writeTail: Promise.resolve(),
        ending: false,
        destination,
        sync,
        rewriteEligibility,
        documentGeneration: 1,
      };
      await session.store.persist(this.#draft(session));
      this.#activate(session);
      return {
        kind: "opened",
        launch: this.#launch(session, request.surface ?? "browser", request.requestedLocation),
      };
    }

    const sessionId = randomUUID();
    const sessionDirectory = join(this.recoveryRoot, sessionId);
    const sourceSnapshot = await createSourceSnapshot(
      approvedFile.canonicalPath,
      sessionDirectory,
    );
    const source = {
      fileId: approvedFile.id,
      digest: sourceSnapshot.digest,
      byteLength: sourceSnapshot.byteLength,
    };
    let importedItems: readonly ReviewItem[] = [];
    try {
      importedItems = await this.#portableReader(
        new Uint8Array(await readFile(sourceSnapshot.path)),
      );
    } catch {
      importedItems = [];
    }
    const state = importedItems.length === 0
      ? createReviewState({
          sessionId,
          source,
          ...(approvedRoot === undefined ? {} : { sourceRootId: approvedRoot.id }),
          ...(request.workflowMode === undefined ? {} : { workflowMode: request.workflowMode }),
        })
      : createImportedReviewState({
          sessionId,
          source,
          ...(approvedRoot === undefined ? {} : { sourceRootId: approvedRoot.id }),
          items: importedItems,
          ...(request.workflowMode === undefined ? {} : { workflowMode: request.workflowMode }),
        });
    const digest = reviewStateDigest(state);
    const destination: DurableSaveDestination = state.workflow.mode === "generated-output" || importedItems.length === 0 || !rewriteEligibility.eligible
      ? { phase: "none", generation: 0 }
      : {
          phase: "active",
          generation: 1,
          kind: "original",
          targetPath: approvedFile.canonicalPath,
          capabilityId: approvedFile.id,
          fingerprint: sourceSnapshot.digest,
        };
    const sync: DurableSaveSync = {
      phase: "clean",
      desiredRevision: state.revision,
      desiredDigest: digest,
      savedRevision: state.revision,
      savedDigest: digest,
    };
    const session: ActiveSession = {
      id: sessionId,
      canonicalSourcePath: approvedFile.canonicalPath,
      sourceSnapshotPath: sourceSnapshot.path,
      store: this.#store(sessionId),
      fileId: approvedFile.id,
      ...(approvedRoot === undefined ? {} : { rootId: approvedRoot.id }),
      state,
      currentOriginalDigest: sourceSnapshot.digest,
      acceptedOriginalDigests: [],
      ending: false,
      writeTail: Promise.resolve(),
      destination,
      sync,
      rewriteEligibility,
      documentGeneration: 1,
    };
    await session.store.persist(this.#draft(session));
    this.#activate(session);
    if (matchingDraft !== undefined && request.recoveryDecision === "discard") {
      try {
        await this.#store(matchingDraft.state.sessionId).remove();
      } catch {
        // The replacement is already durable and active. Redundant protected
        // data is safer than making the successfully reopened review fail.
      }
    }
    return {
      kind: "opened",
      launch: this.#launch(session, request.surface ?? "browser", request.requestedLocation),
    };
  }

  async #attachSourceRoot(session: ActiveSession, sourceRootPath: string): Promise<void> {
    const approvedRoot = await this.capabilities.approveRoot(sourceRootPath);
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    try {
      if (session.ending) throw new Error("Review session is ending");
      const previousRootId = session.rootId;
      const nextState: ReviewState = {
        ...session.state,
        sourceRootId: approvedRoot.id,
      };
      const nextDraft: RecoverableDraftV2 = {
        ...this.#draft(session),
        state: nextState,
      };
      await session.store.persist(nextDraft);
      session.rootId = approvedRoot.id;
      session.state = nextState;
      if (previousRootId !== undefined) this.capabilities.revokeRoot(previousRootId);
    } catch (error) {
      this.capabilities.revokeRoot(approvedRoot.id);
      throw error;
    } finally {
      release();
    }
  }

  #activate(session: ActiveSession): void {
    this.#activeById.set(session.id, session);
    this.#activeBySource.set(
      activeKey(session.canonicalSourcePath, session.state.source.digest),
      session.id,
    );
    this.#activeBySource.set(
      activeKey(session.canonicalSourcePath, session.currentOriginalDigest),
      session.id,
    );
  }

  #draft(session: ActiveSession): RecoverableDraftV2 {
    return {
      schemaVersion: 2,
      canonicalSourcePath: session.canonicalSourcePath,
      sourceSnapshotPath: session.sourceSnapshotPath,
      state: session.state,
      acknowledgedAt: this.#now().toISOString(),
      ...(session.lastExportAt === undefined
        ? {}
        : { lastExportAt: session.lastExportAt }),
      ...(session.acceptedOriginalDigests.length === 0
        ? {}
        : { acceptedOriginalDigests: [...session.acceptedOriginalDigests] }),
      destination: session.destination,
      sync: session.sync,
    };
  }

  #exchangeBootstrap(sessionId: string, capability: string): HttpBootstrapExchange | undefined {
    this.#sweepBootstrapScopes();
    if (!this.#activeById.has(sessionId)) return undefined;
    const scopeKey = digestSecretHex(capability);
    const scope = this.#bootstrapScopes.get(scopeKey);
    const credential = this.credentials.exchangeBootstrap(sessionId, capability);
    if (credential === undefined) return undefined;
    this.controls.noteAuthenticatedPage(sessionId);
    this.#bootstrapScopes.delete(scopeKey);
    if (scope !== undefined && scope.sessionId === sessionId) {
      this.#credentialScopes.set(digestSecretHex(credential), scope);
      this.#notifyRestartReconnectExchange(scope.browserCapabilityHash);
      if (scope.surface === "codex") {
        this.taskBindings.activateBrowser({
          reviewSessionId: sessionId,
          documentGeneration: scope.documentGeneration,
          browserCapability: capability,
        });
      }
    }
    if (
      scope === undefined ||
      scope.sessionId !== sessionId ||
      scope.surface === "vscode"
    ) return { credential };
    const session = this.#activeById.get(sessionId);
    if (
      session === undefined ||
      session.ending ||
      session.documentGeneration !== scope.documentGeneration
    ) return undefined;
    const id = randomUUID();
    const cookie = randomBytes(32).toString("base64url");
    const location = scope.requestedLocation ?? { kind: "page" as const, page: 1 };
    const pathname = encodePlacekeeperReadableViewPathname({
      viewId: id,
      path: session.canonicalSourcePath,
    });
    this.#viewsById.set(id, {
      id,
      cookieHash: digestSecretHex(cookie),
      sessionId,
      documentGeneration: scope.documentGeneration,
      credential,
      pathname,
    });
    return {
      credential,
      view: {
        id,
        cookie,
        pathname,
        locationFragment: encodePlacekeeperLinkFragment(location),
        ...(scope.reconnectBrowserToken === undefined
          ? {}
          : { reconnectCookie: scope.reconnectBrowserToken }),
      },
    };
  }

  exchangeBootstrap(sessionId: string, capability: string): string | undefined {
    return this.#exchangeBootstrap(sessionId, capability)?.credential;
  }

  exchangeBootstrapForHttp(
    sessionId: string,
    capability: string,
  ): HttpBootstrapExchange | undefined {
    return this.#exchangeBootstrap(sessionId, capability);
  }

  async claimTaskBinding(input: {
    readonly bindProof: string;
    readonly taskSessionId: string;
    readonly reviewSessionId: string;
    readonly documentGeneration: number;
  }): Promise<ReturnType<TaskBindingRegistry["claim"]>> {
    const proofHash = digestSecretHex(input.bindProof);
    const metadata = this.#reconnectByBindProofHash.get(proofHash);
    const result = this.taskBindings.claim(input);
    this.#reconnectByBindProofHash.delete(proofHash);
    if (
      result.status === "denied" ||
      metadata === undefined ||
      metadata.reviewSessionId !== input.reviewSessionId ||
      metadata.documentGeneration !== input.documentGeneration
    ) return result;
    const { expiresAtMs: _expiresAtMs, ...reconnectMetadata } = metadata;
    const binding: ReconnectBindingMetadata = {
      ...reconnectMetadata,
      taskSessionId: input.taskSessionId,
    };
    this.#reconnectBindingsByCapabilityHash.set(metadata.browserCapabilityHash, binding);
    await this.restartReconnects.issue(binding);
    return result;
  }

  /** Matches only a path-scoped browser restart token. Task ownership is
   * deliberately unavailable until a later Codex hook supplies it. */
  async stageRestartReconnect(input: {
    readonly browserToken: string;
    readonly launch: SessionLaunch;
  }): Promise<boolean> {
    const session = this.#activeById.get(input.launch.sessionId);
    if (
      session === undefined ||
      session.ending ||
      session.documentGeneration !== input.launch.documentGeneration
    ) return false;
    const ticket = await this.restartReconnects.matchBrowser({
      browserToken: input.browserToken,
      canonicalSourcePath: session.canonicalSourcePath,
      sourceDigest: session.state.source.digest,
    });
    if (ticket === undefined) return false;
    const capability = new URLSearchParams(input.launch.fragment.replace(/^#/u, "")).get("cap");
    if (capability === null) return false;
    const scopeKey = digestSecretHex(capability);
    const scope = this.#bootstrapScopes.get(scopeKey);
    if (
      scope === undefined ||
      scope.sessionId !== session.id ||
      scope.documentGeneration !== session.documentGeneration ||
      scope.browserCapabilityHash !== scopeKey
    ) return false;
    this.#bootstrapScopes.set(scopeKey, { ...scope, reconnectBrowserToken: input.browserToken });
    this.#pendingRestartReconnects.set(scopeKey, {
      ticket,
      browserToken: input.browserToken,
      reviewSessionId: session.id,
      documentGeneration: session.documentGeneration,
      browserCapabilityHash: scopeKey,
      canonicalSourcePath: session.canonicalSourcePath,
      sourceDigest: session.state.source.digest,
    });
    return true;
  }

  /** Runs before each task context refresh. A restarted browser is attached
   * only when its private ticket and this exact task identity both match. */
  async prepareTaskContext(taskSessionId: string): Promise<void> {
    this.#sweepBootstrapScopes();
    for (const [capabilityHash, pending] of this.#pendingRestartReconnects) {
      if (!this.restartReconnects.matchesTask(pending.ticket, taskSessionId)) continue;
      const authenticatedBrowser = await this.#waitForRestartReconnectExchange(capabilityHash, pending);
      if (!authenticatedBrowser) continue;
      // Re-read and consume the persisted record before making the task
      // binding visible; staged copies are only advisory and may be revoked.
      const consumed = await this.restartReconnects.consumeForTask(pending.ticket, taskSessionId);
      if (!consumed) {
        this.#clearPendingRestartReconnects(pending.ticket.ticketId);
        continue;
      }
      this.#clearPendingRestartReconnects(pending.ticket.ticketId);
      const attached = this.taskBindings.attachReconnectedBrowser({
        taskSessionId,
        reviewSessionId: pending.reviewSessionId,
        documentGeneration: pending.documentGeneration,
        browserCapabilityHash: capabilityHash,
      });
      if (attached.status === "denied") continue;
      for (const [credentialHash, scope] of this.#credentialScopes) {
        if (
          scope.sessionId === pending.reviewSessionId &&
          scope.documentGeneration === pending.documentGeneration &&
          scope.browserCapabilityHash === capabilityHash
        ) {
          this.#credentialScopes.set(credentialHash, {
            ...scope,
            surface: "codex",
            reconnectBrowserToken: pending.browserToken,
          });
        }
      }
      const binding: ReconnectBindingMetadata = {
        taskSessionId,
        browserToken: pending.browserToken,
        reviewSessionId: pending.reviewSessionId,
        documentGeneration: pending.documentGeneration,
        browserCapabilityHash: capabilityHash,
        canonicalSourcePath: pending.canonicalSourcePath,
        sourceDigest: pending.sourceDigest,
      };
      this.#reconnectBindingsByCapabilityHash.set(capabilityHash, binding);
      await this.restartReconnects.issue(binding);
      return;
    }
    for (const binding of this.#reconnectBindingsByCapabilityHash.values()) {
      if (binding.taskSessionId !== taskSessionId) continue;
      const active = this.taskBindings.bindingForTask(taskSessionId);
      if (
        active?.reviewSessionId === binding.reviewSessionId &&
        active.documentGeneration === binding.documentGeneration
      ) await this.restartReconnects.issue(binding);
      return;
    }
  }

  async revokeTask(taskSessionId: string): Promise<void> {
    this.taskBindings.revokeTask(taskSessionId);
    for (const [capabilityHash, binding] of this.#reconnectBindingsByCapabilityHash) {
      if (binding.taskSessionId === taskSessionId) {
        this.#reconnectBindingsByCapabilityHash.delete(capabilityHash);
      }
    }
    for (const pending of this.#pendingRestartReconnects.values()) {
      if (this.restartReconnects.matchesTask(pending.ticket, taskSessionId)) {
        this.#clearPendingRestartReconnects(pending.ticket.ticketId);
      }
    }
    await this.restartReconnects.revokeTask(taskSessionId);
  }

  #isAuthenticatedRestartReconnect(capabilityHash: string, pending: PendingRestartReconnect): boolean {
    return [...this.#credentialScopes.values()].some((scope) =>
      scope.sessionId === pending.reviewSessionId &&
      scope.documentGeneration === pending.documentGeneration &&
      scope.browserCapabilityHash === capabilityHash
    );
  }

  #waitForRestartReconnectExchange(
    capabilityHash: string,
    pending: PendingRestartReconnect,
  ): Promise<boolean> {
    if (this.#isAuthenticatedRestartReconnect(capabilityHash, pending)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.#restartReconnectWaiters.get(capabilityHash) ?? new Set<() => void>();
      const finish = () => {
        clearTimeout(timeout);
        waiters.delete(finish);
        if (waiters.size === 0) this.#restartReconnectWaiters.delete(capabilityHash);
        resolve(this.#isAuthenticatedRestartReconnect(capabilityHash, pending));
      };
      const timeout = setTimeout(finish, RESTART_RECONNECT_WAIT_MS);
      waiters.add(finish);
      this.#restartReconnectWaiters.set(capabilityHash, waiters);
    });
  }

  #notifyRestartReconnectExchange(capabilityHash: string): void {
    for (const finish of this.#restartReconnectWaiters.get(capabilityHash) ?? []) finish();
  }

  #clearPendingRestartReconnects(ticketId: string): void {
    for (const [capabilityHash, candidate] of this.#pendingRestartReconnects) {
      if (candidate.ticket.ticketId !== ticketId) continue;
      this.#notifyRestartReconnectExchange(capabilityHash);
      this.#pendingRestartReconnects.delete(capabilityHash);
    }
  }

  resumeView(
    viewId: string,
    pathname: string,
    cookie: string,
  ): ResumedBrowserView | undefined {
    const view = this.#liveView(viewId, pathname, digestSecretHex(cookie));
    if (view === undefined) return undefined;
    this.controls.noteAuthenticatedPage(view.sessionId);
    return { sessionId: view.sessionId, credential: view.credential };
  }

  isLiveViewRoute(viewId: string, pathname: string): boolean {
    return this.#liveView(viewId, pathname) !== undefined;
  }

  #liveView(
    viewId: string,
    pathname: string,
    cookieHash?: string,
  ): BrowserViewRecord | undefined {
    const view = this.#viewsById.get(viewId);
    if (
      view === undefined ||
      view.pathname !== pathname ||
      (cookieHash !== undefined && view.cookieHash !== cookieHash)
    ) return undefined;
    const session = this.#activeById.get(view.sessionId);
    const live =
      session !== undefined &&
      !session.ending &&
      session.documentGeneration === view.documentGeneration &&
      this.credentials.authenticate(view.sessionId, view.credential);
    if (!live) this.#viewsById.delete(viewId);
    return live ? view : undefined;
  }

  revokeView(viewId: string): void {
    const view = this.#viewsById.get(viewId);
    if (view === undefined) return;
    this.#viewsById.delete(viewId);
    this.credentials.revoke(view.sessionId, view.credential);
    this.#credentialScopes.delete(digestSecretHex(view.credential));
  }

  authenticate(sessionId: string, credential: string): boolean {
    return (
      this.#activeById.has(sessionId) &&
      this.credentials.authenticate(sessionId, credential)
    );
  }

  activity(): {
    readonly reviewPresence: number;
    readonly codexTasks: number;
    readonly transientWork: number;
  } {
    this.#sweepBootstrapScopes();
    const controls = this.controls.activity();
    return {
      reviewPresence: controls.reviewPresence + this.credentials.pendingBootstrapCount(),
      codexTasks: this.taskBindings.activityCount(),
      transientWork: controls.transientWork,
    };
  }

  /** Lexical, process-memory-only ownership check used before admitting a
   * custom-scheme link. It intentionally performs no path resolution or I/O. */
  activeReviewOwnsPath(path: string): boolean {
    for (const session of this.#activeById.values()) {
      if (!session.ending && session.canonicalSourcePath === path) return true;
    }
    return false;
  }

  #sweepBootstrapScopes(): void {
    const now = this.#now().getTime();
    for (const [key, scope] of this.#bootstrapScopes) {
      if (scope.expiresAtMs <= now) this.#bootstrapScopes.delete(key);
    }
    for (const [proofHash, metadata] of this.#reconnectByBindProofHash) {
      if (metadata.expiresAtMs <= now) this.#reconnectByBindProofHash.delete(proofHash);
    }
    for (const [capabilityHash, pending] of this.#pendingRestartReconnects) {
      if (pending.ticket.expiresAtMs <= now) {
        this.#pendingRestartReconnects.delete(capabilityHash);
      }
    }
    this.#sweepRecoveryRecords();
  }

  #sweepRecoveryRecords(): void {
    const now = this.#now().getTime();
    for (const [offerId, offer] of this.#recoveryOffers) {
      if (offer.expiresAtMs <= now) this.#deleteRecoveryOffer(offerId);
    }
    for (const [operationId, operation] of this.#recoveryOperations) {
      if (operation.expiresAtMs <= now || !this.#recoveryOffers.has(operation.offerId)) {
        this.#recoveryOperations.delete(operationId);
      }
    }
  }

  #deleteRecoveryOffer(offerId: string): void {
    this.#recoveryOffers.delete(offerId);
    for (const [operationId, operation] of this.#recoveryOperations) {
      if (operation.offerId === offerId) this.#recoveryOperations.delete(operationId);
    }
  }

  #clearRecoveryRecordsForSession(sessionId: string): void {
    const removedOffers = new Set<string>();
    for (const [offerId, offer] of this.#recoveryOffers) {
      if (offer.recoverySessionId === sessionId) {
        removedOffers.add(offerId);
        this.#recoveryOffers.delete(offerId);
      }
    }
    for (const [operationId, operation] of this.#recoveryOperations) {
      if (operation.recoverySessionId === sessionId || removedOffers.has(operation.offerId)) {
        this.#recoveryOperations.delete(operationId);
      }
    }
  }

  state(sessionId: string): ReviewState | undefined {
    return this.#activeById.get(sessionId)?.state;
  }

  saveStatus(sessionId: string):
    | {
        readonly destination: DurableSaveDestination;
        readonly sync: DurableSaveSync;
        readonly rewriteEligibility: PdfRewriteEligibility;
      }
    | undefined {
    const session = this.#activeById.get(sessionId);
    return session === undefined
      ? undefined
      : {
          destination: session.destination,
          sync: session.sync,
          rewriteEligibility: session.rewriteEligibility,
        };
  }

  async #withSessionTail<T>(
    session: ActiveSession,
    work: () => Promise<T>,
  ): Promise<T> {
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async #recordCommittedSave(
    session: ActiveSession,
    input: {
      readonly revision: number;
      readonly stateDigest: string;
      readonly targetDigest: string;
    },
  ): Promise<boolean> {
    if (session.destination.phase !== "active") {
      throw new Error("Save destination is not active");
    }
    const current =
      session.state.revision === input.revision &&
      session.sync.desiredDigest === input.stateDigest;
    const destination: DurableSaveDestination = {
      ...session.destination,
      fingerprint: input.targetDigest,
    };
    const sync: DurableSaveSync = {
      phase: current ? "clean" : "saving",
      desiredRevision: session.state.revision,
      desiredDigest: session.sync.desiredDigest,
      savedRevision: input.revision,
      savedDigest: input.stateDigest,
    };
    const acceptedOriginalDigests = destination.kind === "original"
      ? [...new Set([...session.acceptedOriginalDigests, input.targetDigest])]
      : session.acceptedOriginalDigests;
    await session.store.persist({
      ...this.#draft(session),
      destination,
      sync,
      ...(acceptedOriginalDigests.length === 0 ? {} : { acceptedOriginalDigests }),
    });
    session.destination = destination;
    session.sync = sync;
    if (destination.kind === "original") {
      session.currentOriginalDigest = input.targetDigest;
      session.acceptedOriginalDigests = acceptedOriginalDigests;
    }
    return current;
  }

  async establishSaveDestination(
    sessionId: string,
    input: {
      readonly kind: "original" | "copy";
      readonly targetPath: string;
      readonly capabilityId: string;
      readonly fingerprint?: string;
    },
  ): Promise<{ readonly destination: DurableSaveDestination; readonly sync: DurableSaveSync }> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) throw new Error("Review session is not active");
    return this.#withSessionTail(session, async () => {
      if (session.ending) throw new Error("Review session is ending");
      const generation = session.destination.generation + 1;
      const destination: DurableSaveDestination = {
        phase: "active",
        generation,
        kind: input.kind,
        targetPath: input.targetPath,
        capabilityId: input.capabilityId,
        ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
      };
      const sync: DurableSaveSync = {
        phase: "saving",
        desiredRevision: session.state.revision,
        desiredDigest: session.sync.desiredDigest,
        savedRevision: session.sync.savedRevision,
        ...(session.sync.savedDigest === undefined ? {} : { savedDigest: session.sync.savedDigest }),
      };
      await session.store.persist({ ...this.#draft(session), destination, sync });
      session.destination = destination;
      session.sync = sync;
      return { destination, sync };
    });
  }

  async relocateOriginalDestination(
    sessionId: string,
    input: {
      readonly targetPath: string;
      readonly capabilityId: string;
      readonly fingerprint: string;
    },
  ): Promise<{ readonly destination: DurableSaveDestination; readonly sync: DurableSaveSync }> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) throw new Error("Review session is not active");
    return this.#withSessionTail(session, async () => {
      if (session.ending) throw new Error("Review session is ending");
      const destination: DurableSaveDestination = {
        phase: "active",
        generation: session.destination.generation + 1,
        kind: "original",
        targetPath: input.targetPath,
        capabilityId: input.capabilityId,
        fingerprint: input.fingerprint,
      };
      const sync: DurableSaveSync = {
        phase: "saving",
        desiredRevision: session.state.revision,
        desiredDigest: session.sync.desiredDigest,
        savedRevision: session.sync.savedRevision,
        ...(session.sync.savedDigest === undefined ? {} : { savedDigest: session.sync.savedDigest }),
      };
      await session.store.persist({
        ...this.#draft(session),
        canonicalSourcePath: input.targetPath,
        destination,
        sync,
      });
      for (const [key, owner] of this.#activeBySource) {
        if (owner === sessionId) this.#activeBySource.delete(key);
      }
      session.canonicalSourcePath = input.targetPath;
      session.destination = destination;
      session.sync = sync;
      this.#activate(session);
      return { destination, sync };
    });
  }

  async markSaveCommitted(input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly revision: number;
    readonly stateDigest: string;
    readonly targetDigest: string;
  }): Promise<boolean> {
    const session = this.#activeById.get(input.sessionId);
    if (session === undefined || session.ending) return false;
    return this.#withSessionTail(session, async () => {
      if (
        session.destination.phase !== "active" ||
        session.destination.generation !== input.generation
      ) return false;
      return this.#recordCommittedSave(session, input);
    });
  }

  async commitSaveCandidate(input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly revision: number;
    readonly stateDigest: string;
    readonly commit: () => Promise<string>;
  }): Promise<"committed-current" | "committed-stale" | "generation-stale"> {
    const session = this.#activeById.get(input.sessionId);
    if (session === undefined || session.ending) return "generation-stale";
    return this.#withSessionTail(session, async () => {
      if (
        session.destination.phase !== "active" ||
        session.destination.generation !== input.generation
      ) return "generation-stale";
      const targetDigest = await input.commit();
      const current = await this.#recordCommittedSave(session, {
        revision: input.revision,
        stateDigest: input.stateDigest,
        targetDigest,
      });
      return current ? "committed-current" : "committed-stale";
    });
  }

  async markSaveFailed(
    sessionId: string,
    generation: number,
    failure: SaveFailureReason,
  ): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) return;
    return this.#withSessionTail(session, async () => {
      if (
        session.destination.phase !== "active" ||
        session.destination.generation !== generation
      ) return;
      const sync: DurableSaveSync = {
        phase: "not-saved",
        desiredRevision: session.state.revision,
        desiredDigest: session.sync.desiredDigest,
        savedRevision: session.sync.savedRevision,
        ...(session.sync.savedDigest === undefined ? {} : { savedDigest: session.sync.savedDigest }),
        failure,
      };
      await session.store.persist({ ...this.#draft(session), sync });
      session.sync = sync;
    });
  }

  async sessionScope(sessionId: string, credential?: string): Promise<
    | {
        readonly documentTitle: string;
        readonly sourceRootPath?: string;
        readonly launchSurface?: LaunchSurface;
        /** A browser-authenticated restart successor is waiting for its
         * owning task's next prompt. This contains no task identity. */
        readonly reconnectPending?: true;
        readonly requestedLocation?: PlacekeeperLinkLocation;
        readonly codexContext?: ReturnType<TaskBindingRegistry["statusForReview"]>;
      }
    | undefined
  > {
    const session = this.#activeById.get(sessionId);
    if (session === undefined) return undefined;
    const sourceRootPath = session.rootId === undefined
      ? undefined
      : this.capabilities.getRootPath(session.rootId);
    const launchScope = credential === undefined || !this.authenticate(sessionId, credential)
      ? undefined
      : this.#credentialScopes.get(digestSecretHex(credential));
    const trustedLaunchScope = launchScope?.sessionId === sessionId
      ? launchScope
      : undefined;
    const trustedCodexScope =
      trustedLaunchScope?.surface === "codex" &&
      trustedLaunchScope.documentGeneration === session.documentGeneration
        ? trustedLaunchScope
        : undefined;
    if (trustedCodexScope !== undefined) {
      const heartbeat = this.taskBindings.renewBrowserHeartbeat({
        reviewSessionId: sessionId,
        documentGeneration: session.documentGeneration,
        browserCapabilityHash: trustedCodexScope.browserCapabilityHash,
      });
      const reconnectBinding = this.#reconnectBindingsByCapabilityHash.get(
        trustedCodexScope.browserCapabilityHash,
      );
      if (
        heartbeat.status === "active" &&
        reconnectBinding?.reviewSessionId === sessionId &&
        reconnectBinding.documentGeneration === session.documentGeneration &&
        reconnectBinding.canonicalSourcePath === session.canonicalSourcePath &&
        reconnectBinding.sourceDigest === session.state.source.digest
      ) {
        await this.restartReconnects.issue(reconnectBinding);
      }
    }
    return {
      documentTitle: basename(session.canonicalSourcePath),
      ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
      ...(trustedLaunchScope === undefined
        ? {}
        : { launchSurface: trustedLaunchScope.surface }),
      ...(trustedLaunchScope?.surface === "browser" &&
          this.#pendingRestartReconnects.has(trustedLaunchScope.browserCapabilityHash)
        ? { reconnectPending: true as const }
        : {}),
      ...(trustedLaunchScope?.requestedLocation === undefined
        ? {}
        : { requestedLocation: trustedLaunchScope.requestedLocation }),
      ...(trustedLaunchScope?.surface === "codex"
        ? {
            codexContext: this.taskBindings.statusForReview(
              sessionId,
              {
                documentGeneration: session.documentGeneration,
                reviewRevision: session.state.revision,
                sourceDigest: session.state.source.digest,
                stateDigest: reviewSemanticDigest(session.state.items),
              },
              trustedLaunchScope.browserCapabilityHash,
            ),
          }
        : {}),
    };
  }

  async documentBytes(sessionId: string): Promise<Buffer | undefined> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined) return undefined;
    return readFile(session.sourceSnapshotPath);
  }

  /** Capture a lightweight, internally consistent session snapshot. The write
   * tail is held only while in-memory metadata is cloned. */
  async snapshotAtomicSession(sessionId: string): Promise<AtomicSessionProjection | undefined> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) return undefined;
    return this.#withSessionTail(session, async () => {
      if (session.ending || this.#activeById.get(sessionId) !== session) return undefined;
      const sourceRootPath = session.rootId === undefined
        ? undefined
        : this.capabilities.getRootPath(session.rootId);
      return {
        sessionId: session.id,
        documentGeneration: session.documentGeneration,
        state: structuredClone(session.state),
        destination: structuredClone(session.destination),
        sync: structuredClone(session.sync),
        sourceByteLength: session.state.source.byteLength,
        sourceSnapshotPath: session.sourceSnapshotPath,
        sourcePdfPath: session.canonicalSourcePath,
        ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
      };
    });
  }

  /** Compatibility projection over a lightweight atomic snapshot. The
   * callback deliberately runs outside the session write tail. */
  async projectAtomicSession<T>(
    sessionId: string,
    project: (snapshot: AtomicSessionProjection) => Promise<T>,
  ): Promise<T | undefined> {
    const snapshot = await this.snapshotAtomicSession(sessionId);
    return snapshot === undefined ? undefined : project(snapshot);
  }

  /** Read immutable source bytes without holding the mutation tail, then prove
   * the active session still has the expected generation and source identity. */
  async loadVerifiedSourceSnapshot(
    sessionId: string,
    expected: { readonly documentGeneration: number; readonly sourceDigest: string },
  ): Promise<VerifiedSourceSnapshot | undefined> {
    const before = await this.snapshotAtomicSession(sessionId);
    if (
      before === undefined ||
      before.documentGeneration !== expected.documentGeneration ||
      before.state.source.digest !== expected.sourceDigest
    ) return undefined;
    const bytes = await readFile(before.sourceSnapshotPath);
    if (
      bytes.byteLength !== before.sourceByteLength ||
      createHash("sha256").update(bytes).digest("hex") !== expected.sourceDigest
    ) return undefined;
    const after = await this.snapshotAtomicSession(sessionId);
    if (
      after === undefined ||
      after.documentGeneration !== expected.documentGeneration ||
      after.state.source.digest !== expected.sourceDigest ||
      after.sourceSnapshotPath !== before.sourceSnapshotPath
    ) return undefined;
    return {
      documentGeneration: after.documentGeneration,
      sourceDigest: after.state.source.digest,
      bytes,
    };
  }

  async freezeDelivery(sessionId: string): Promise<FrozenReviewDelivery> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    try {
      if (session.ending) throw new Error("Review session is ending");
      const state = structuredClone(session.state);
      const sourceRootPath = session.rootId === undefined
        ? undefined
        : this.capabilities.getRootPath(session.rootId);
      const summary = createReviewStateSummary(state);
      return {
        sessionId: session.id,
        source: { ...state.source },
        originalDigest: session.currentOriginalDigest,
        revision: state.revision,
        sourceSnapshotPath: session.sourceSnapshotPath,
        annotations: projectReviewItems(state.items),
        items: documentOrderedItems(state.items),
        workflowMode: state.workflow.mode,
        documentGeneration: state.workflow.documentGeneration,
        dispositionDigest: summary.reconciliation.dispositionDigest,
        stateDigest: reviewStateDigest(state),
        exportEligibility: summary.export,
        ...(session.rootId === undefined ? {} : { sourceRootId: session.rootId }),
        ...(sourceRootPath === undefined ? {} : { sourceRootPath }),
      };
    } finally {
      release();
    }
  }

  isFrozenDeliveryCurrent(delivery: FrozenReviewDelivery): boolean {
    const session = this.#activeById.get(delivery.sessionId);
    if (session === undefined || session.ending) return false;
    const summary = createReviewStateSummary(session.state);
    return session.state.revision === delivery.revision &&
      session.state.workflow.documentGeneration === delivery.documentGeneration &&
      summary.reconciliation.dispositionDigest === delivery.dispositionDigest &&
      reviewStateDigest(session.state) === delivery.stateDigest;
  }

  async acceptMutation(
    sessionId: string,
    command: ReviewCommand,
  ): Promise<ReviewState> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }

    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      write.signal.throwIfAborted();
      const nextState = reduceReview(session.state, command);
      projectReviewItems(nextState.items).forEach(assertPortableAnnotationWritable);
      const desiredDigest = reviewStateDigest(nextState);
      const nextSync: DurableSaveSync = {
        phase: session.destination.phase === "active" ? "saving" : "not-saved",
        desiredRevision: nextState.revision,
        desiredDigest,
        savedRevision: session.sync.savedRevision,
        ...(session.sync.savedDigest === undefined
          ? {}
          : { savedDigest: session.sync.savedDigest }),
        ...(session.destination.phase === "active"
          ? {}
          : { failure: "destination-unconfigured" as const }),
      };
      const nextDraft: RecoverableDraftV2 = {
        ...this.#draft(session),
        state: nextState,
        sync: nextSync,
        acknowledgedAt: this.#now().toISOString(),
      };
      await session.store.persist(nextDraft, write.signal);
      write.signal.throwIfAborted();
      session.state = nextState;
      session.sync = nextSync;
      return nextState;
    } finally {
      write.complete();
      release();
    }
  }

  async recordSuccessfulExport(sessionId: string): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      const lastExportAt = this.#now().toISOString();
      await session.store.persist(
        { ...this.#draft(session), lastExportAt },
        write.signal,
      );
      write.signal.throwIfAborted();
      session.lastExportAt = lastExportAt;
    } finally {
      write.complete();
      release();
    }
  }

  async recordSuccessfulReplacement(
    sessionId: string,
    replacementDigest: string,
  ): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      const lastExportAt = this.#now().toISOString();
      const acceptedOriginalDigests = [
        ...new Set([...session.acceptedOriginalDigests, replacementDigest]),
      ];
      await session.store.persist(
        {
          ...this.#draft(session),
          lastExportAt,
          acceptedOriginalDigests,
        },
        write.signal,
      );
      write.signal.throwIfAborted();
      session.lastExportAt = lastExportAt;
      session.currentOriginalDigest = replacementDigest;
      session.acceptedOriginalDigests = acceptedOriginalDigests;
      this.#activeBySource.set(
        activeKey(session.canonicalSourcePath, replacementDigest),
        session.id,
      );
    } finally {
      write.complete();
      release();
    }
  }

  async prepareReplacement(
    sessionId: string,
    candidateDigest: string,
  ): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined || session.ending) {
      throw new Error("Review session is not active");
    }
    const predecessor = session.writeTail;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    session.writeTail = promise;
    await predecessor;
    if (session.ending) {
      release();
      throw new Error("Review session is ending");
    }
    const write = this.controls.beginWrite(sessionId);
    try {
      const acceptedOriginalDigests = [
        ...new Set([...session.acceptedOriginalDigests, candidateDigest]),
      ];
      await session.store.persist(
        { ...this.#draft(session), acceptedOriginalDigests },
        write.signal,
      );
      write.signal.throwIfAborted();
      session.acceptedOriginalDigests = acceptedOriginalDigests;
    } finally {
      write.complete();
      release();
    }
  }

  async finish(sessionId: string): Promise<void> {
    await this.#end(sessionId);
  }

  async discard(sessionId: string): Promise<void> {
    await this.#end(sessionId);
  }

  async quiesceForShutdown(): Promise<void> {
    const sessions = [...this.#activeById.values()];
    await this.drainWrites();
    for (const session of sessions) session.ending = true;
    // Recovery cleanup is garbage collection, not a shutdown precondition.
    // A verified-clean directory that cannot be removed may be retried later;
    // it must never prevent capability revocation and control-socket teardown.
    await Promise.allSettled(sessions.map(async (session) => {
      const clean = session.sync.phase === "clean" &&
        session.sync.savedRevision === session.sync.desiredRevision &&
        session.sync.savedDigest === session.sync.desiredDigest;
      if (clean) await session.store.remove();
    }));
    for (const session of sessions) {
      this.capabilities.revokeFile(session.fileId);
      if (session.rootId !== undefined) this.capabilities.revokeRoot(session.rootId);
      this.credentials.revokeSession(session.id);
      this.taskBindings.revokeSession(session.id);
      this.controls.cancel(session.id);
      for (const listener of this.#sessionEndListeners) listener(session.id);
    }
    this.#activeById.clear();
    this.#activeBySource.clear();
    this.#bootstrapScopes.clear();
    this.#credentialScopes.clear();
    this.#viewsById.clear();
    this.#reconnectByBindProofHash.clear();
    this.#reconnectBindingsByCapabilityHash.clear();
    for (const capabilityHash of this.#restartReconnectWaiters.keys()) {
      this.#notifyRestartReconnectExchange(capabilityHash);
    }
    this.#pendingRestartReconnects.clear();
    this.#recoveryOffers.clear();
    this.#recoveryOperations.clear();
  }

  async drainWrites(): Promise<void> {
    while (true) {
      const sessions = [...this.#activeById.values()];
      const tails = sessions.map((session) => session.writeTail);
      await Promise.all(tails);
      if (sessions.every((session, index) => session.writeTail === tails[index])) return;
    }
  }

  async #end(sessionId: string): Promise<void> {
    const session = this.#activeById.get(sessionId);
    if (session === undefined) return;
    session.ending = true;
    this.#clearRecoveryRecordsForSession(sessionId);
    this.#activeById.delete(sessionId);
    for (const [key, owner] of this.#activeBySource) {
      if (owner === sessionId) this.#activeBySource.delete(key);
    }
    for (const candidate of this.#activeById.values()) {
      if (!candidate.ending && candidate.canonicalSourcePath === session.canonicalSourcePath) {
        this.#activeBySource.set(
          activeKey(candidate.canonicalSourcePath, candidate.currentOriginalDigest),
          candidate.id,
        );
      }
    }
    this.controls.cancel(sessionId);
    this.taskBindings.revokeSession(sessionId);
    await this.restartReconnects.revokeSession(sessionId);
    await session.writeTail;
    this.credentials.revokeSession(sessionId);
    for (const [key, scope] of this.#bootstrapScopes) {
      if (scope.sessionId === sessionId) this.#bootstrapScopes.delete(key);
    }
    for (const [proofHash, metadata] of this.#reconnectByBindProofHash) {
      if (metadata.reviewSessionId === sessionId) {
        this.#reconnectByBindProofHash.delete(proofHash);
      }
    }
    for (const [key, scope] of this.#credentialScopes) {
      if (scope.sessionId === sessionId) this.#credentialScopes.delete(key);
    }
    for (const [viewId, view] of this.#viewsById) {
      if (view.sessionId === sessionId) this.#viewsById.delete(viewId);
    }
    for (const [capabilityHash, binding] of this.#reconnectBindingsByCapabilityHash) {
      if (binding.reviewSessionId === sessionId) {
        this.#reconnectBindingsByCapabilityHash.delete(capabilityHash);
      }
    }
    for (const [capabilityHash, pending] of this.#pendingRestartReconnects) {
      if (pending.reviewSessionId === sessionId) {
        this.#notifyRestartReconnectExchange(capabilityHash);
        this.#pendingRestartReconnects.delete(capabilityHash);
      }
    }
    this.capabilities.revokeFile(session.fileId);
    if (session.rootId !== undefined) this.capabilities.revokeRoot(session.rootId);
    await session.store.remove();
    for (const listener of this.#sessionEndListeners) listener(sessionId);
  }
}
