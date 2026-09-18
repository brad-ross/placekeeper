import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeReviewState, type ReviewState } from "../../../../packages/core/src/review-model.js";
import { canonicalSha256 } from "../../../../packages/core/src/live-context.js";
import type { NativePdfAnnotationIdentityProvenance } from "../../../../packages/core/src/native-pdf-annotation.js";
import type {
  SaveDestination,
  SaveSync,
} from "../../../../packages/core/src/save-status.js";
export type { SaveFailureReason } from "../../../../packages/core/src/save-status.js";
import { ensurePrivateDirectory } from "./source-snapshot.js";
import type {
  GenerationOutputIdentity,
  GenerationSyncTexSnapshot,
} from "./source-snapshot.js";
import {
  isRecoveryTemporaryPathActive,
  trackRecoveryTemporaryPath,
} from "./temporary-path-registry.js";

const RECOVERY_ID = /^[A-Za-z0-9_-]{8,128}$/u;

export interface LegacyRecoverableDraft {
  readonly schemaVersion: 1;
  readonly canonicalSourcePath: string;
  readonly sourceSnapshotPath: string;
  readonly state: ReviewState;
  readonly acknowledgedAt: string;
  readonly lastExportAt?: string;
  readonly acceptedOriginalDigests?: readonly string[];
}

export type DurableSaveDestination = SaveDestination;
export type DurableSaveSync = SaveSync;

export interface DurableGenerationRecordV1 {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly digest: string;
  readonly byteLength: number;
  readonly snapshotPath: string;
  readonly outputIdentity: GenerationOutputIdentity;
  readonly observationEpoch: number;
  readonly committedAt: string;
  readonly syncTex?: GenerationSyncTexSnapshot;
}

export interface DurableSourceWorkInterruptionV1 {
  readonly schemaVersion: 1;
  readonly taskSessionId: string;
  readonly previousGeneration: number;
  readonly successorGeneration: number;
  readonly disposition: "interrupted-by-generation";
  readonly interruptedAt: string;
  readonly appliedChanges?: readonly DurableInterruptedSourceChangeV1[];
}

export interface DurableNativeAnnotationLedgerV1 {
  readonly schemaVersion: 1;
  readonly managed: readonly {
    readonly id: string;
    readonly provenance: NativePdfAnnotationIdentityProvenance;
    readonly sourceDigest: string;
    readonly documentGeneration: number;
  }[];
  readonly deletedIds: readonly string[];
}

export interface DurableInterruptedSourceChangeV1 {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly itemId: string;
  readonly path: string;
  readonly guardSha256: string;
  readonly observedSha256: string;
}

export interface RecoverableDraftV2 {
  readonly schemaVersion: 2;
  readonly canonicalSourcePath: string;
  readonly sourceSnapshotPath: string;
  readonly state: ReviewState;
  readonly acknowledgedAt: string;
  readonly lastExportAt?: string;
  readonly acceptedOriginalDigests?: readonly string[];
  readonly destination: DurableSaveDestination;
  readonly sync: DurableSaveSync;
  readonly generationLineage?: readonly DurableGenerationRecordV1[];
  readonly latestObservationEpoch?: number;
  readonly sourceWorkInterruptions?: readonly DurableSourceWorkInterruptionV1[];
  readonly nativeAnnotationLedger?: DurableNativeAnnotationLedgerV1;
}

export type SourceDisposition = "local" | "remote-temporary";

export interface LocalSourceOwnership {
  readonly disposition: "local";
  readonly canonicalSourcePath: string;
  readonly sourceSnapshotPath: string;
  readonly displayName: string;
}

export interface RemoteTemporarySourceOwnership {
  readonly disposition: "remote-temporary";
  readonly acquisitionId: string;
  readonly leaseId: string;
  readonly displayName: string;
  readonly digest: string;
  readonly byteLength: number;
  /** Stable native-normalized identity for Chrome re-acquisition. It is
   * private recovery metadata and is never projected to the extension. */
  readonly sourceIdentity?: string;
}

export type RecoverableSourceOwnership =
  | LocalSourceOwnership
  | RemoteTemporarySourceOwnership;

export interface RecoverableDraftV3 {
  readonly schemaVersion: 3;
  readonly source: RecoverableSourceOwnership;
  readonly state: ReviewState;
  readonly acknowledgedAt: string;
  readonly lastExportAt?: string;
  readonly acceptedOriginalDigests?: readonly string[];
  readonly destination: DurableSaveDestination;
  readonly sync: DurableSaveSync;
  readonly generationLineage?: readonly DurableGenerationRecordV1[];
  readonly latestObservationEpoch?: number;
  readonly sourceWorkInterruptions?: readonly DurableSourceWorkInterruptionV1[];
  readonly nativeAnnotationLedger?: DurableNativeAnnotationLedgerV1;
  readonly interactionReceipts?: readonly {
    readonly status: "finalized";
    readonly sessionId: string;
    readonly attachmentId: string;
    readonly interactionToken: string;
    readonly draftId?: string;
    readonly generation: number;
    readonly outcome: "applied" | "discarded";
    readonly reviewRevision: number;
  }[];
  /** A Chrome review that accepted a potentially durable side effect must
   * remain recoverable even when its save state is currently clean. */
  readonly chromeProtected?: true;
}

export type RecoverableDraft = LegacyRecoverableDraft | RecoverableDraftV2 | RecoverableDraftV3;

interface SnapshotEnvelope {
  readonly checksum: string;
  readonly payload: RecoverableDraft;
}

export interface SnapshotHooks {
  readonly afterTemporarySync?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
  /** Fault-injection seam for an exception after the authoritative record
   * rename, when callers must inspect recovery rather than assume failure. */
  readonly afterFinalRename?: () => void | Promise<void>;
  readonly beforeRecover?: () => void | Promise<void>;
}

function serialize(draft: RecoverableDraft): string {
  const payload = JSON.stringify(draft);
  const envelope: SnapshotEnvelope = {
    checksum: createHash("sha256").update(payload).digest("hex"),
    payload: draft,
  };
  return JSON.stringify(envelope);
}

export function reviewStateDigest(
  state: Pick<ReviewState, "items"> & Partial<Pick<ReviewState, "workflow" | "pendingDrafts" | "discardAudit" | "annotationName">>,
): string {
  const ordered = [...state.items].sort((left, right) => left.id.localeCompare(right.id));
  return canonicalSha256({
    items: ordered,
    ...(state.annotationName === undefined ? {} : { annotationName: state.annotationName }),
    workflow: state.workflow,
    pendingDrafts: state.pendingDrafts ?? [],
    discardAudit: state.discardAudit ?? [],
  });
}

export function migrateRecoverableDraft(draft: RecoverableDraft): RecoverableDraftV3 {
  const state = normalizeReviewState(draft.state);
  if (draft.schemaVersion === 3) return { ...draft, state };
  const desiredDigest = reviewStateDigest(state);
  const v2: RecoverableDraftV2 = draft.schemaVersion === 2
    ? {
        ...draft,
        state,
        sync: { ...draft.sync, desiredDigest },
      }
    : {
        ...draft,
        schemaVersion: 2,
        state,
        destination: { phase: "none", generation: 0 },
        sync: (() => {
          const hasChanges = state.revision > 0 || state.items.length > 0;
          return {
            phase: hasChanges ? "not-saved" as const : "clean" as const,
            desiredRevision: state.revision,
            desiredDigest,
            savedRevision: hasChanges ? -1 : state.revision,
            ...(hasChanges ? { failure: "destination-unconfigured" as const } : { savedDigest: desiredDigest }),
          };
        })(),
      };
  const {
    canonicalSourcePath,
    sourceSnapshotPath,
    schemaVersion: _schemaVersion,
    ...rest
  } = v2;
  return {
    ...rest,
    schemaVersion: 3,
    source: {
      disposition: "local",
      canonicalSourcePath,
      sourceSnapshotPath,
      displayName: basename(canonicalSourcePath),
    },
  };
}

function validV3Source(source: RecoverableSourceOwnership): boolean {
  if (source.disposition === "local") {
    return source.canonicalSourcePath.length > 0 && source.sourceSnapshotPath.length > 0 &&
      source.displayName.length > 0;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(source.acquisitionId) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(source.leaseId) && source.displayName.length > 0 && source.displayName.length <= 120 &&
    !/[\\/\u0000-\u001f\u007f]/u.test(source.displayName) &&
    /^[a-f0-9]{64}$/u.test(source.digest) &&
    (source.sourceIdentity === undefined || /^[a-f0-9]{64}$/u.test(source.sourceIdentity)) &&
    Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0;
}

function validNativeAnnotationLedger(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ledger = value as Partial<DurableNativeAnnotationLedgerV1>;
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.managed) || !Array.isArray(ledger.deletedIds)) return false;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const seen = new Set<string>();
  for (const entry of ledger.managed) {
    if (entry === null || typeof entry !== "object" ||
      !uuid.test(entry.id) || seen.has(entry.id) ||
      (entry.provenance !== "verified" && entry.provenance !== "generation-ordinal") ||
      !/^[a-f0-9]{64}$/u.test(entry.sourceDigest) ||
      !Number.isSafeInteger(entry.documentGeneration) || entry.documentGeneration < 1) return false;
    seen.add(entry.id);
  }
  return ledger.deletedIds.every((id) => typeof id === "string" && uuid.test(id) && seen.has(id)) &&
    new Set(ledger.deletedIds).size === ledger.deletedIds.length;
}

function validInteractionReceipts(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 256) return false;
  return value.every((entry) => entry !== null && typeof entry === "object" &&
    (entry as { status?: unknown }).status === "finalized" &&
    typeof (entry as { sessionId?: unknown }).sessionId === "string" &&
    typeof (entry as { attachmentId?: unknown }).attachmentId === "string" &&
    typeof (entry as { interactionToken?: unknown }).interactionToken === "string" &&
    ((entry as { draftId?: unknown }).draftId === undefined ||
      (typeof (entry as { draftId?: unknown }).draftId === "string" &&
        RECOVERY_ID.test((entry as { draftId: string }).draftId))) &&
    Number.isSafeInteger((entry as { generation?: unknown }).generation) &&
    ((entry as { generation: number }).generation > 0) &&
    ((entry as { outcome?: unknown }).outcome === "applied" || (entry as { outcome?: unknown }).outcome === "discarded") &&
    Number.isSafeInteger((entry as { reviewRevision?: unknown }).reviewRevision) &&
    ((entry as { reviewRevision: number }).reviewRevision >= 0));
}

function parse(contents: string): RecoverableDraftV3 | undefined {
  try {
    const envelope = JSON.parse(contents) as SnapshotEnvelope;
    const payload = JSON.stringify(envelope.payload);
    const checksum = createHash("sha256").update(payload).digest("hex");
    if (
      checksum !== envelope.checksum ||
      ![1, 2, 3].includes(envelope.payload.schemaVersion) ||
      (envelope.payload.schemaVersion === 3 && (
        !validV3Source(envelope.payload.source) ||
        !validNativeAnnotationLedger(envelope.payload.nativeAnnotationLedger) ||
        !validInteractionReceipts(envelope.payload.interactionReceipts) ||
        (envelope.payload.chromeProtected !== undefined && envelope.payload.chromeProtected !== true) ||
        (envelope.payload.source.disposition === "remote-temporary" && (
          envelope.payload.source.digest !== envelope.payload.state.source.digest ||
          envelope.payload.source.byteLength !== envelope.payload.state.source.byteLength
        ))
      ))
    ) {
      return undefined;
    }
    return migrateRecoverableDraft(envelope.payload);
  } catch {
    return undefined;
  }
}

async function readValid(path: string): Promise<RecoverableDraftV3 | undefined> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export class DraftSnapshotStore {
  readonly directory: string;
  readonly #hooks: SnapshotHooks;
  #cleanedDirectoryIdentity: string | undefined;

  constructor(directory: string, hooks: SnapshotHooks = {}) {
    this.directory = directory;
    this.#hooks = hooks;
  }

  get currentPath(): string {
    return join(this.directory, "draft.json");
  }

  get previousPath(): string {
    return join(this.directory, "draft.previous.json");
  }

  async initialize(): Promise<void> {
    try {
      // Permission validation runs on every access; only the temporary-file
      // traversal is cached. Identity and mtime also detect replacement and
      // externally created entries, without caching recovered draft contents.
      await ensurePrivateDirectory(this.directory);
      const info = await stat(this.directory, { bigint: true });
      const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}:${info.mtimeNs}`;
      if (identity === this.#cleanedDirectoryIdentity) return;
      this.#cleanedDirectoryIdentity = undefined;
      const entries = await readdir(this.directory, { withFileTypes: true });
      const temporary = entries.filter((entry) =>
        entry.isFile() && /^\.(?:draft|source|synctex|runtime-operation)-.*\.tmp$/u.test(entry.name),
      );
      let hasActiveTemporary = false;
      await Promise.all(temporary.map(async (entry) => {
        const path = join(this.directory, entry.name);
        if (isRecoveryTemporaryPathActive(path)) {
          hasActiveTemporary = true;
          return;
        }
        await rm(path, { force: true });
      }));
      // An active temporary can become abandoned without a directory change.
      // Retain the pre-scan identity so concurrent changes force another scan.
      if (!hasActiveTemporary) this.#cleanedDirectoryIdentity = identity;
    } catch (error) {
      this.#cleanedDirectoryIdentity = undefined;
      throw error;
    }
  }

  async persist(draft: RecoverableDraft, signal?: AbortSignal): Promise<void> {
    await this.initialize();
    signal?.throwIfAborted();
    const temporaryPath = join(this.directory, `.draft-${randomUUID()}.tmp`);
    const stopTracking = trackRecoveryTemporaryPath(temporaryPath);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(serialize(draft), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.#hooks.afterTemporarySync?.();
      signal?.throwIfAborted();
      try {
        await rename(this.currentPath, this.previousPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await this.#hooks.beforeFinalRename?.();
      signal?.throwIfAborted();
      await rename(temporaryPath, this.currentPath);
      await this.#hooks.afterFinalRename?.();
      await chmod(this.currentPath, 0o600);
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      this.#cleanedDirectoryIdentity = undefined;
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      stopTracking();
    }
  }

  async recover(): Promise<RecoverableDraftV3 | undefined> {
    await this.#hooks.beforeRecover?.();
    await this.initialize();
    const candidates = await Promise.all([
      readValid(this.currentPath),
      readValid(this.previousPath),
    ]).catch((error: unknown) => {
      this.#cleanedDirectoryIdentity = undefined;
      throw error;
    });
    return candidates
      .filter((draft): draft is RecoverableDraftV3 => draft !== undefined)
      .sort((left, right) => right.state.revision - left.state.revision)[0];
  }

  async remove(): Promise<void> {
    this.#cleanedDirectoryIdentity = undefined;
    await rm(this.directory, { recursive: true, force: true });
  }

  async allocatedBytes(): Promise<number> {
    await this.initialize();
    let total = 0;
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((error: unknown) => {
      this.#cleanedDirectoryIdentity = undefined;
      throw error;
    });
    const files = entries.filter((entry) => entry.isFile() && !entry.name.endsWith(".tmp"));
    // Keep cleanup and session traversal sequential. Only independent read-only
    // stats overlap, in small batches, with errors consumed in directory order.
    for (let offset = 0; offset < files.length; offset += 8) {
      const results = await Promise.allSettled(
        files.slice(offset, offset + 8).map((entry) => stat(join(this.directory, entry.name))),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          this.#cleanedDirectoryIdentity = undefined;
          throw result.reason;
        }
        total += result.value.size;
      }
    }
    return total;
  }
}
