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
} from "../../../../packages/core/src/review-model.js";
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
}

export type FrozenPdfDelivery = Omit<
  FrozenReviewDelivery,
  "items" | "sourceRootId" | "sourceRootPath"
> &
  Partial<Pick<FrozenReviewDelivery, "items" | "sourceRootId" | "sourceRootPath">>;

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
}

export class ExportCoordinatorError extends Error {
  readonly code:
    | "EMPTY_REVIEW"
    | "ORIGINAL_REPLACEMENT_UNAVAILABLE"
    | "SOURCE_SNAPSHOT_INVALID"
    | "SESSION_CAPABILITY_REVOKED";

  constructor(code: ExportCoordinatorError["code"], message: string) {
    super(message);
    this.name = "ExportCoordinatorError";
    this.code = code;
  }
}

function temporaryOutputPath(originalPath: string): string {
  return join(dirname(originalPath), `.pdf-proofreader-${randomUUID()}.tmp`);
}

function committedWarning(kind: PdfExportResult["kind"]): string {
  return kind === "reviewed-copy"
    ? "The reviewed copy was created, but final durability bookkeeping was interrupted. Verify the saved artifact before closing the review."
    : "The original was replaced, but final durability bookkeeping was interrupted. Reopen the PDF to resume the retained recovery draft.";
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
  readonly #copyInFlight = new Map<string, Promise<PdfExportResult>>();
  readonly #copyCompleted = new Map<string, PdfExportResult>();
  readonly #replaceInFlight = new Map<string, Promise<PdfExportResult>>();
  readonly #replaceCompleted = new Map<string, PdfExportResult>();

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
  }

  exportReviewedCopy(delivery: FrozenPdfDelivery): Promise<PdfExportResult> {
    this.#assertDeliverable(delivery);
    const key = `${delivery.sessionId}:${delivery.revision}`;
    const complete = this.#copyCompleted.get(key);
    if (complete !== undefined) return Promise.resolve(complete);
    const existing = this.#copyInFlight.get(key);
    if (existing !== undefined) return existing;
    const pending = this.#runCopy(delivery)
      .then((result) => {
        this.#copyCompleted.set(key, result);
        return result;
      })
      .finally(() => this.#copyInFlight.delete(key));
    this.#copyInFlight.set(key, pending);
    return pending;
  }

  replaceOriginal(delivery: FrozenPdfDelivery): Promise<PdfExportResult> {
    this.#assertDeliverable(delivery);
    const key = `${delivery.sessionId}:${delivery.revision}`;
    const complete = this.#replaceCompleted.get(key);
    if (complete !== undefined) return Promise.resolve(complete);
    const existing = this.#replaceInFlight.get(key);
    if (existing !== undefined) return existing;
    const pending = this.#runReplacement(delivery)
      .then((result) => {
        this.#replaceCompleted.set(key, result);
        return result;
      })
      .finally(() => this.#replaceInFlight.delete(key));
    this.#replaceInFlight.set(key, pending);
    return pending;
  }

  #assertDeliverable(delivery: FrozenPdfDelivery): void {
    if (delivery.annotations.length === 0) {
      throw new ExportCoordinatorError(
        "EMPTY_REVIEW",
        "There is no review feedback to deliver. Add an annotation first.",
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
