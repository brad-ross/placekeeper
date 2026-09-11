import { readFile } from "node:fs/promises";
import type { ReviewItem, ReviewState } from "../../../../packages/core/src/review-model.js";
import { migrateLegacyReviewStateGeometry } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import { hashFile } from "../files/file-capabilities.js";
import type { RecoverableDraftV3 } from "../recovery/draft-snapshot.js";
import type { OpenReviewRequest } from "./session-contracts.js";

export async function prepareRecoveredReview(input: {
  readonly matchingDraft: RecoverableDraftV3;
  readonly recoveredSnapshotPath: string;
  readonly approvedFile: { readonly id: string };
  readonly approvedRoot: { readonly id: string } | undefined;
  readonly request: OpenReviewRequest;
  readonly portableReader: (bytes: Uint8Array) => Promise<readonly ReviewItem[]>;
}) {
  const { matchingDraft, recoveredSnapshotPath, approvedFile, approvedRoot, request, portableReader } = input;
  const sourceSnapshotBytes = new Uint8Array(await readFile(recoveredSnapshotPath));
  if (
    (await hashFile(recoveredSnapshotPath)) !==
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
  // Older recovery records never imported standard marks. Add them once to
  // the current state and every undo snapshot, so undo cannot delete them.
  let nativeMigration: readonly ReviewItem[] = [];
  let nativeImportSucceeded = migratedState.nativeAnnotationImportDigest === migratedState.source.digest;
  if (!nativeImportSucceeded) {
    try {
      nativeMigration = (await portableReader(sourceSnapshotBytes))
        .filter((item) => item.kind === 'pdfAnnotation' && !migratedState.items.some(({ id }) => id === item.id));
      nativeImportSucceeded = true;
    } catch { /* Preserve all source annotations until an import can succeed. */ }
  }
  const mergeNative = (items: readonly ReviewItem[]) => [...items,
    ...nativeMigration.filter((item) => !items.some(({ id }) => id === item.id))];
  const resumedState: ReviewState = {
    ...migratedState,
    ...(nativeImportSucceeded ? { nativeAnnotationImportDigest: migratedState.source.digest } : {}),
    items: mergeNative(migratedState.items),
    history: migratedState.history.map((entry) => ({ ...entry,
      beforeItems: mergeNative(entry.beforeItems), afterItems: mergeNative(entry.afterItems),
    })),
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
  return { resumedState, geometryMigrated, nativeMigration };
}
