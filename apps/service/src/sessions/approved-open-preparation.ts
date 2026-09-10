import { readFile, stat } from "node:fs/promises";
import { createImportedReviewState } from "../../../../packages/core/src/portable-annotation.js";
import { createReviewState, type ReviewItem } from "../../../../packages/core/src/review-model.js";
import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";
import { reviewStateDigest, type DurableSaveDestination, type DurableSaveSync } from "../recovery/draft-snapshot.js";
import { createSourceSnapshot, snapshotGenerationSyncTexSidecar } from "../recovery/source-snapshot.js";
import type { OpenReviewRequest } from "./session-contracts.js";

// Prepare private source bytes and initial review data. Activation and persistence
// remain with the broker after this candidate is complete.
export async function prepareApprovedOpen(input: {
  readonly request: OpenReviewRequest;
  readonly approvedFile: { readonly id: string; readonly canonicalPath: string };
  readonly approvedRoot: { readonly id: string } | undefined;
  readonly sessionId: string;
  readonly sessionDirectory: string;
  readonly rewriteEligibility: PdfRewriteEligibility;
  readonly portableReader: (bytes: Uint8Array) => Promise<readonly ReviewItem[]>;
}) {
  const { request, approvedFile, approvedRoot, sessionId, sessionDirectory, rewriteEligibility, portableReader } = input;
  const sourceSnapshot = await createSourceSnapshot(
    approvedFile.canonicalPath,
    sessionDirectory,
  );
  const source = {
    fileId: approvedFile.id,
    digest: sourceSnapshot.digest,
    byteLength: sourceSnapshot.byteLength,
  };
  const initialOutputInfo = await stat(approvedFile.canonicalPath);
  let importedItems: readonly ReviewItem[] = [];
  let nativeAnnotationsImported = false;
  try {
    importedItems = await portableReader(
      new Uint8Array(await readFile(sourceSnapshot.path)),
    );
    nativeAnnotationsImported = true;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "invalid-portable-annotation") {
      throw error;
    }
    importedItems = [];
  }
  const initialOutputIdentity = {
    canonicalPath: approvedFile.canonicalPath,
    device: initialOutputInfo.dev,
    inode: initialOutputInfo.ino,
    byteLength: initialOutputInfo.size,
    modifiedAtMs: initialOutputInfo.mtimeMs,
  };
  const initialSyncTex = request.workflowMode === "generated-output"
    ? await snapshotGenerationSyncTexSidecar({
        outputPath: approvedFile.canonicalPath,
        privatePdfPath: sourceSnapshot.path,
        outputIdentity: initialOutputIdentity,
        pdfDigest: sourceSnapshot.digest,
      }).catch(() => undefined)
    : undefined;
  const initialState = importedItems.length === 0
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
  const state = { ...initialState, ...(nativeAnnotationsImported ? { nativeAnnotationImportDigest: source.digest } : {}) };
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
  return { sourceSnapshot, initialOutputIdentity, initialSyncTex, state, destination, sync };
}
