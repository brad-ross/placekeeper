import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  PdfWriter,
  ReviewAnnotation,
} from "../../../../packages/core/src/pdf-writer.js";
import type {
  ReviewItem,
  ReviewSourceIdentity,
  ReviewWorkflowMode,
} from "../../../../packages/core/src/review-model.js";
import type { ReviewStateSummaryV1 } from "../../../../packages/core/src/live-context.js";
import {
  runPdfBackend,
  type PdfBackendRunOptions,
} from "../../../../packages/pdf-backends/src/backend-host.js";
import {
  FileCapabilityRegistry,
  hashFile,
} from "../files/file-capabilities.js";
import { syncDirectory } from "../files/durability.js";
import { SessionControlRegistry } from "../sessions/control-socket.js";
import { reviewedPdfFilename } from "./output-names.js";
import {
  verifyReviewedPdf,
  type PdfExportVerifier,
  type PdfVerificationReport,
} from "./pdf-verifier.js";

export interface FrozenReviewDelivery {
  readonly sessionId: string;
  readonly source: ReviewSourceIdentity;
  readonly originalDigest: string;
  readonly revision: number;
  readonly sourceSnapshotPath: string;
  readonly annotations: readonly ReviewAnnotation[];
  /** Canonical semantic evidence from the same frozen revision as annotations. */
  readonly items: readonly ReviewItem[];
  readonly sourceRootId?: string;
  readonly sourceRootPath?: string;
  readonly workflowMode: ReviewWorkflowMode;
  readonly documentGeneration: number;
  readonly dispositionDigest: string;
  readonly stateDigest: string;
  readonly exportEligibility: ReviewStateSummaryV1["export"];
  readonly staleConfirmed?: true;
}

export type FrozenPdfDelivery = Omit<
  FrozenReviewDelivery,
  "items" | "sourceRootId" | "sourceRootPath" | "workflowMode" | "documentGeneration" | "dispositionDigest" | "stateDigest" | "exportEligibility" | "staleConfirmed"
> &
  Partial<Pick<FrozenReviewDelivery, "items" | "sourceRootId" | "sourceRootPath" | "workflowMode" | "documentGeneration" | "dispositionDigest" | "stateDigest" | "exportEligibility" | "staleConfirmed">>;

export interface PdfExportResult {
  readonly kind: "reviewed-copy" | "original-replacement";
  readonly path: string;
  readonly revision: number;
  readonly digest: string;
  readonly verification: PdfVerificationReport;
  readonly warning?: string;
}

export interface ExportCoordinatorHooks {
  readonly afterCandidateSync?: () => void | Promise<void>;
  readonly beforeFinalize?: (signal: AbortSignal) => void | Promise<void>;
  readonly afterOriginalValidation?: () => void | Promise<void>;
  readonly beforeCommittedDirectorySync?: (
    kind: PdfExportResult["kind"],
  ) => void | Promise<void>;
}

export interface ExportCoordinatorOptions {
  readonly writer: PdfWriter;
  readonly capabilities: FileCapabilityRegistry;
  readonly controls?: SessionControlRegistry;
  readonly verify?: PdfExportVerifier;
  readonly backend?: Omit<PdfBackendRunOptions, "signal">;
  readonly recordSuccessfulExport?: (sessionId: string) => Promise<void>;
  readonly prepareReplacement?: (
    sessionId: string,
    candidateDigest: string,
  ) => Promise<void>;
  readonly recordSuccessfulReplacement?: (
    sessionId: string,
    replacementDigest: string,
  ) => Promise<void>;
  readonly hooks?: ExportCoordinatorHooks;
  readonly validateFrozenDelivery?: (delivery: FrozenPdfDelivery) => boolean | Promise<boolean>;
}

export class ExportCoordinatorError extends Error {
  readonly code:
    | "EMPTY_REVIEW"
    | "ORIGINAL_REPLACEMENT_UNAVAILABLE"
    | "SOURCE_SNAPSHOT_INVALID"
    | "SESSION_CAPABILITY_REVOKED"
    | "RECONCILIATION_INCOMPLETE"
    | "GENERATED_OUTPUT_IMMUTABLE"
    | "EXPORT_FENCE_STALE";

  constructor(code: ExportCoordinatorError["code"], message: string) {
    super(message);
    this.name = "ExportCoordinatorError";
    this.code = code;
  }
}

function temporaryOutputPath(originalPath: string): string {
  return join(dirname(originalPath), `.placekeeper-${randomUUID()}.tmp`);
}

function committedWarning(kind: PdfExportResult["kind"]): string {
  return kind === "reviewed-copy"
    ? "The reviewed copy was created, but final durability bookkeeping was interrupted. Verify the saved artifact before closing the review."
    : "The original was replaced, but final durability bookkeeping was interrupted. Reopen the PDF to resume the retained recovery draft.";
}

interface ExportOperations {
  readonly inFlight: Map<string, Promise<PdfExportResult>>;
  readonly completed: Map<string, PdfExportResult>;
}

interface SessionExports {
  readonly copy: ExportOperations;
  readonly replacement: ExportOperations;
}

function exportOperations(): ExportOperations {
  return { inFlight: new Map(), completed: new Map() };
}

export class ExportCoordinator {
  readonly #writer: PdfWriter;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #controls: SessionControlRegistry;
  readonly #verify: PdfExportVerifier;
  readonly #backend: Omit<PdfBackendRunOptions, "signal">;
  readonly #recordSuccessfulExport: (sessionId: string) => Promise<void>;
  readonly #prepareReplacement:
    | ((sessionId: string, candidateDigest: string) => Promise<void>)
    | undefined;
  readonly #recordSuccessfulReplacement:
    | ((sessionId: string, replacementDigest: string) => Promise<void>)
    | undefined;
  readonly #hooks: ExportCoordinatorHooks;
  readonly #validateFrozenDelivery: (delivery: FrozenPdfDelivery) => boolean | Promise<boolean>;
  readonly #sessions = new Map<string, SessionExports>();

  constructor(options: ExportCoordinatorOptions) {
    this.#writer = options.writer;
    this.#capabilities = options.capabilities;
    this.#controls = options.controls ?? new SessionControlRegistry();
    this.#verify = options.verify ?? verifyReviewedPdf;
    this.#backend = options.backend ?? {};
    this.#recordSuccessfulExport =
      options.recordSuccessfulExport ?? (async () => undefined);
    this.#prepareReplacement = options.prepareReplacement;
    this.#recordSuccessfulReplacement = options.recordSuccessfulReplacement;
    this.#hooks = options.hooks ?? {};
    this.#validateFrozenDelivery = options.validateFrozenDelivery ?? (() => true);
  }

  exportReviewedCopy(delivery: FrozenPdfDelivery): Promise<PdfExportResult> {
    this.#assertDeliverable(delivery);
    return this.#runOnce(delivery, "copy", () => this.#runCopy(delivery));
  }

  replaceOriginal(delivery: FrozenPdfDelivery): Promise<PdfExportResult> {
    this.#assertDeliverable(delivery);
    if (delivery.workflowMode === "generated-output") {
      throw new ExportCoordinatorError(
        "GENERATED_OUTPUT_IMMUTABLE",
        "Replace Original is unavailable for generated output.",
      );
    }
    return this.#runOnce(delivery, "replacement", () => this.#runReplacement(delivery));
  }

  /** Called after the broker revokes a session, never on presentation detach. */
  releaseSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  retentionStatus(): { readonly sessions: number; readonly completed: number; readonly inFlight: number } {
    let completed = 0;
    let inFlight = 0;
    for (const session of this.#sessions.values()) {
      completed += session.copy.completed.size + session.replacement.completed.size;
      inFlight += session.copy.inFlight.size + session.replacement.inFlight.size;
    }
    return { sessions: this.#sessions.size, completed, inFlight };
  }

  #runOnce(
    delivery: FrozenPdfDelivery,
    kind: keyof SessionExports,
    run: () => Promise<PdfExportResult>,
  ): Promise<PdfExportResult> {
    const session = this.#sessions.get(delivery.sessionId) ?? {
      copy: exportOperations(), replacement: exportOperations(),
    };
    this.#sessions.set(delivery.sessionId, session);
    const operations = session[kind];
    const key = this.#deliveryKey(delivery);
    const complete = operations.completed.get(key);
    if (complete !== undefined) return Promise.resolve(complete);
    const existing = operations.inFlight.get(key);
    if (existing !== undefined) return existing;
    const pending = run().then((result) => {
      // A finishing write may settle after session revocation. It must not
      // restore the discarded cache, even when the artifact already committed.
      if (this.#sessions.get(delivery.sessionId) === session) operations.completed.set(key, result);
      return result;
    }).finally(() => {
      operations.inFlight.delete(key);
      if (
        this.#sessions.get(delivery.sessionId) === session
        && session.copy.inFlight.size + session.copy.completed.size
          + session.replacement.inFlight.size + session.replacement.completed.size === 0
      ) this.#sessions.delete(delivery.sessionId);
    });
    operations.inFlight.set(key, pending);
    return pending;
  }

  #assertDeliverable(delivery: FrozenPdfDelivery): void {
    const confirmedStale = delivery.exportEligibility?.eligible === false &&
      delivery.exportEligibility.requiresStaleConfirmation &&
      delivery.exportEligibility.reasons.length === 1 &&
      delivery.exportEligibility.reasons[0] === "possibly-stale" &&
      delivery.staleConfirmed === true;
    if (
      delivery.workflowMode === "generated-output" &&
      delivery.exportEligibility?.eligible !== true &&
      !confirmedStale
    ) {
      throw new ExportCoordinatorError(
        "RECONCILIATION_INCOMPLETE",
        "Generated-output reconciliation must be complete before explicit export.",
      );
    }
    if (delivery.annotations.length === 0) {
      throw new ExportCoordinatorError(
        "EMPTY_REVIEW",
        "There is no review feedback to deliver. Add an annotation first.",
      );
    }
  }

  #deliveryKey(delivery: FrozenPdfDelivery): string {
    return [
      delivery.sessionId,
      delivery.documentGeneration ?? 1,
      delivery.revision,
      delivery.dispositionDigest ?? "legacy",
    ].join(":");
  }

  async #assertFrozenDeliveryCurrent(delivery: FrozenPdfDelivery): Promise<void> {
    if (!await this.#validateFrozenDelivery(delivery)) {
      throw new ExportCoordinatorError(
        "EXPORT_FENCE_STALE",
        "The PDF generation or review state changed during export. Refresh and export again.",
      );
    }
  }

  #originalPath(delivery: FrozenPdfDelivery): string {
    const path = this.#capabilities.getFilePath(delivery.source.fileId);
    if (path === undefined) {
      throw new ExportCoordinatorError(
        "SESSION_CAPABILITY_REVOKED",
        "The review session no longer has access to its original PDF.",
      );
    }
    return path;
  }

  async #sourceBytes(delivery: FrozenPdfDelivery): Promise<Uint8Array> {
    const sourcePdf = new Uint8Array(await readFile(delivery.sourceSnapshotPath));
    if (
      sourcePdf.byteLength !== delivery.source.byteLength ||
      (await hashFile(delivery.sourceSnapshotPath)) !== delivery.source.digest
    ) {
      throw new ExportCoordinatorError(
        "SOURCE_SNAPSHOT_INVALID",
        "The private source snapshot failed its integrity check.",
      );
    }
    return sourcePdf;
  }

  async #writeVerifiedCandidate(
    delivery: FrozenPdfDelivery,
    originalPath: string,
    signal: AbortSignal,
  ): Promise<{
    path: string;
    digest: string;
    verification: PdfVerificationReport;
  }> {
    signal.throwIfAborted();
    const sourcePdf = await this.#sourceBytes(delivery);
    const written = await runPdfBackend(
      this.#writer,
      {
        sourcePdf,
        sourceSha256: delivery.source.digest,
        revision: delivery.revision,
        annotations: delivery.annotations,
      },
      { ...this.#backend, signal },
    );
    signal.throwIfAborted();

    const path = temporaryOutputPath(originalPath);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(written.pdfBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await this.#hooks.afterCandidateSync?.();
      signal.throwIfAborted();
      const candidatePdf = new Uint8Array(await readFile(path));
      const verification = await this.#verify({
        sourcePdf,
        candidatePdf,
        evidence: written.evidence,
        annotations: delivery.annotations,
      });
      signal.throwIfAborted();
      return { path, digest: written.evidence.outputSha256, verification };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async #runCopy(delivery: FrozenPdfDelivery): Promise<PdfExportResult> {
    const originalPath = this.#originalPath(delivery);
    const lease = this.#controls.beginWrite(delivery.sessionId);
    let candidatePath: string | undefined;
    try {
      const candidate = await this.#writeVerifiedCandidate(
        delivery,
        originalPath,
        lease.signal,
      );
      candidatePath = candidate.path;
      await this.#hooks.beforeFinalize?.(lease.signal);
      await this.#assertFrozenDeliveryCurrent(delivery);
      lease.signal.throwIfAborted();

      const directory = dirname(originalPath);
      let collisionIndex = 0;
      let outputPath: string;
      for (;;) {
        outputPath = join(
          directory,
          reviewedPdfFilename(originalPath, collisionIndex),
        );
        try {
          lease.signal.throwIfAborted();
          await link(candidatePath, outputPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          collisionIndex += 1;
        }
      }
      let warning: string | undefined;
      try {
        await unlink(candidatePath);
      } catch {
        warning = committedWarning("reviewed-copy");
        await rm(candidatePath, { force: true }).catch(() => undefined);
      }
      candidatePath = undefined;
      try {
        await this.#hooks.beforeCommittedDirectorySync?.("reviewed-copy");
        await syncDirectory(directory);
      } catch {
        warning = committedWarning("reviewed-copy");
      }
      try {
        await this.#recordSuccessfulExport(delivery.sessionId);
      } catch {
        warning = committedWarning("reviewed-copy");
      }
      return {
        kind: "reviewed-copy",
        path: outputPath,
        revision: delivery.revision,
        digest: candidate.digest,
        verification: candidate.verification,
        ...(warning === undefined ? {} : { warning }),
      };
    } finally {
      if (candidatePath !== undefined) await rm(candidatePath, { force: true });
      lease.complete();
    }
  }

  async #runReplacement(delivery: FrozenPdfDelivery): Promise<PdfExportResult> {
    if (
      this.#prepareReplacement === undefined ||
      this.#recordSuccessfulReplacement === undefined
    ) {
      throw new ExportCoordinatorError(
        "ORIGINAL_REPLACEMENT_UNAVAILABLE",
        "Original replacement is unavailable because durable recovery is not configured.",
      );
    }
    const originalPath = this.#originalPath(delivery);
    const lease = this.#controls.beginWrite(delivery.sessionId);
    let candidatePath: string | undefined;
    try {
      const candidate = await this.#writeVerifiedCandidate(
        delivery,
        originalPath,
        lease.signal,
      );
      candidatePath = candidate.path;

      const validatedPath = await this.#capabilities.validateOriginalForReplacement(
        delivery.source.fileId,
        delivery.originalDigest,
      );
      if (validatedPath !== originalPath) {
        throw new ExportCoordinatorError(
          "SOURCE_SNAPSHOT_INVALID",
          "The original PDF target changed after the review opened.",
        );
      }
      const originalInfo = await stat(validatedPath);
      const parentInfo = await stat(dirname(validatedPath));
      if (
        (originalInfo.mode & 0o222) === 0 ||
        (parentInfo.mode & 0o222) === 0
      ) {
        throw new ExportCoordinatorError(
          "ORIGINAL_REPLACEMENT_UNAVAILABLE",
          "The original PDF or its containing folder is not writable.",
        );
      }
      const originalMode = originalInfo.mode & 0o777;
      await chmod(candidatePath, originalMode);
      await this.#prepareReplacement(delivery.sessionId, candidate.digest);
      lease.signal.throwIfAborted();
      await this.#hooks.afterOriginalValidation?.();
      await this.#hooks.beforeFinalize?.(lease.signal);
      await this.#assertFrozenDeliveryCurrent(delivery);
      await this.#capabilities.validateOriginalForReplacement(
        delivery.source.fileId,
        delivery.originalDigest,
      );
      lease.signal.throwIfAborted();

      await rename(candidatePath, originalPath);
      candidatePath = undefined;
      let warning: string | undefined;
      try {
        await this.#hooks.beforeCommittedDirectorySync?.("original-replacement");
        await syncDirectory(dirname(originalPath));
      } catch {
        warning = committedWarning("original-replacement");
      }
      try {
        await this.#capabilities.refreshApprovedPdf(
          delivery.source.fileId,
          candidate.digest,
        );
      } catch {
        warning = committedWarning("original-replacement");
      }
      try {
        await this.#recordSuccessfulReplacement(
          delivery.sessionId,
          candidate.digest,
        );
      } catch {
        warning = committedWarning("original-replacement");
      }
      return {
        kind: "original-replacement",
        path: originalPath,
        revision: delivery.revision,
        digest: candidate.digest,
        verification: candidate.verification,
        ...(warning === undefined ? {} : { warning }),
      };
    } finally {
      if (candidatePath !== undefined) await rm(candidatePath, { force: true });
      lease.complete();
    }
  }
}
