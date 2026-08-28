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
import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import type {
  SaveDestination,
  SaveSync,
} from "../../../../packages/core/src/save-status.js";
export type { SaveFailureReason } from "../../../../packages/core/src/save-status.js";
import { ensurePrivateDirectory } from "./source-snapshot.js";
import {
  isRecoveryTemporaryPathActive,
  trackRecoveryTemporaryPath,
} from "./temporary-path-registry.js";

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
}

export type RecoverableDraft = LegacyRecoverableDraft | RecoverableDraftV2 | RecoverableDraftV3;

interface SnapshotEnvelope {
  readonly checksum: string;
  readonly payload: RecoverableDraft;
}

export interface SnapshotHooks {
  readonly afterTemporarySync?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

function serialize(draft: RecoverableDraft): string {
  const payload = JSON.stringify(draft);
  const envelope: SnapshotEnvelope = {
    checksum: createHash("sha256").update(payload).digest("hex"),
    payload: draft,
  };
  return JSON.stringify(envelope);
}

export function reviewStateDigest(state: Pick<ReviewState, "items">): string {
  const ordered = [...state.items].sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export function migrateRecoverableDraft(draft: RecoverableDraft): RecoverableDraftV3 {
  if (draft.schemaVersion === 3) return draft;
  const v2: RecoverableDraftV2 = draft.schemaVersion === 2
    ? draft
    : {
        ...draft,
        schemaVersion: 2,
        destination: { phase: "none", generation: 0 },
        sync: (() => {
          const desiredDigest = reviewStateDigest(draft.state);
          const hasChanges = draft.state.revision > 0 || draft.state.items.length > 0;
          return {
            phase: hasChanges ? "not-saved" as const : "clean" as const,
            desiredRevision: draft.state.revision,
            desiredDigest,
            savedRevision: hasChanges ? -1 : draft.state.revision,
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
    /^[a-f0-9]{64}$/u.test(source.digest) && Number.isSafeInteger(source.byteLength) &&
    source.byteLength > 0;
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
    await ensurePrivateDirectory(this.directory);
    const entries = await readdir(this.directory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            /^\.(?:draft|source)-.*\.tmp$/u.test(entry.name) &&
            !isRecoveryTemporaryPathActive(join(this.directory, entry.name)),
        )
        .map((entry) => rm(join(this.directory, entry.name), { force: true })),
    );
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
      await chmod(this.currentPath, 0o600);
      const directoryHandle = await open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      stopTracking();
    }
  }

  async recover(): Promise<RecoverableDraftV3 | undefined> {
    await this.initialize();
    const candidates = await Promise.all([
      readValid(this.currentPath),
      readValid(this.previousPath),
    ]);
    return candidates
      .filter((draft): draft is RecoverableDraftV3 => draft !== undefined)
      .sort((left, right) => right.state.revision - left.state.revision)[0];
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  async allocatedBytes(): Promise<number> {
    await this.initialize();
    let total = 0;
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
      total += (await stat(join(this.directory, entry.name))).size;
    }
    return total;
  }
}
