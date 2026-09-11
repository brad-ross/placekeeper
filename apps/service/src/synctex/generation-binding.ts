import type { DurableGenerationRecordV1 } from "../recovery/draft-snapshot.js";
import {
  snapshotGenerationSyncTexSidecar,
  type GenerationSyncTexSnapshot,
  type GenerationSyncTexSnapshotResult,
  type SyncTexSidecarFingerprint,
} from "../recovery/source-snapshot.js";
import type { SyncTexUnavailableResult } from "../sessions/session-contracts.js";
import type { GenerationSyncTexBinding } from "./query.js";

export function latestSyncTexFingerprintBefore(
  lineage: readonly DurableGenerationRecordV1[],
  generation: number,
): SyncTexSidecarFingerprint | undefined {
  for (let index = lineage.length - 1; index >= 0; index -= 1) {
    const record = lineage[index];
    if (record !== undefined && record.generation < generation && record.syncTex !== undefined) {
      return record.syncTex.fingerprint;
    }
  }
  return undefined;
}

type PreparedGenerationSyncTexBinding = {
  readonly binding: GenerationSyncTexBinding;
  readonly attachment?: GenerationSyncTexSnapshot;
} | SyncTexUnavailableResult;

// Preparation owns private artifact validation, never session mutation or persistence.
// The broker calls this under its existing tail after checking canonical generation.
export function prepareGenerationSyncTexBinding(input: {
  readonly current: DurableGenerationRecordV1;
  readonly lineage: readonly DurableGenerationRecordV1[];
  readonly outputPath: string;
  readonly operationToken: string;
  readonly getSourceRoot: () => string | undefined;
}): PreparedGenerationSyncTexBinding | Promise<PreparedGenerationSyncTexBinding> {
  const { current, operationToken } = input;
  if (
    operationToken.length === 0 || operationToken.length > 256 || operationToken.includes("\0")
  ) {
    return {
      status: "malformed",
      operationToken,
      documentGeneration: current.generation,
      pdfDigest: current.digest,
      reason: "invalid-synctex-operation-token",
    };
  }
  const sourceRoot = input.getSourceRoot();
  if (sourceRoot === undefined) {
    return {
      status: "out-of-root",
      operationToken,
      documentGeneration: current.generation,
      pdfDigest: current.digest,
      reason: "no-approved-source-root",
    };
  }
  const binding = (sidecar: GenerationSyncTexSnapshot): GenerationSyncTexBinding => ({
    outputIdentity: current.outputIdentity,
    documentGeneration: current.generation,
    pdfDigest: current.digest,
    privatePdfPath: current.snapshotPath,
    sidecar,
    sourceRoot,
    operationToken,
  });
  // Cached bindings and validation failures must not introduce a yield before
  // the broker commits the operation token under its tail.
  if (current.syncTex !== undefined) return { binding: binding(current.syncTex) };
  return (async (): Promise<PreparedGenerationSyncTexBinding> => {
    const previousFingerprint = latestSyncTexFingerprintBefore(input.lineage, current.generation);
    let sidecar: GenerationSyncTexSnapshotResult;
    try {
      sidecar = await snapshotGenerationSyncTexSidecar({
        outputPath: input.outputPath,
        privatePdfPath: current.snapshotPath,
        outputIdentity: current.outputIdentity,
        pdfDigest: current.digest,
        ...(previousFingerprint === undefined ? {} : { previousFingerprint }),
      });
    } catch {
      sidecar = { status: "stale", reason: "sidecar-private-copy-failed" };
    }
    if (sidecar.status !== "ready") {
      return {
        status: sidecar.status === "missing"
          ? current.generation === 1 ? "missing" : "pending"
          : sidecar.status,
        operationToken,
        documentGeneration: current.generation,
        pdfDigest: current.digest,
        reason: sidecar.reason,
      };
    }
    return { binding: binding(sidecar.snapshot), attachment: sidecar.snapshot };
  })();
}

// The broker separately checks session lifetime and its newest operation token.
export function matchesGenerationSyncTexBinding(
  current: DurableGenerationRecordV1 | undefined,
  sourceRoot: string | undefined,
  binding: GenerationSyncTexBinding,
): boolean {
  return current !== undefined && current.syncTex !== undefined &&
    current.generation === binding.documentGeneration &&
    current.digest === binding.pdfDigest &&
    current.snapshotPath === binding.privatePdfPath &&
    current.outputIdentity.canonicalPath === binding.outputIdentity.canonicalPath &&
    current.outputIdentity.device === binding.outputIdentity.device &&
    current.outputIdentity.inode === binding.outputIdentity.inode &&
    current.outputIdentity.byteLength === binding.outputIdentity.byteLength &&
    current.outputIdentity.modifiedAtMs === binding.outputIdentity.modifiedAtMs &&
    current.syncTex.snapshotPath === binding.sidecar.snapshotPath &&
    current.syncTex.fingerprint.digest === binding.sidecar.fingerprint.digest &&
    sourceRoot === binding.sourceRoot;
}
