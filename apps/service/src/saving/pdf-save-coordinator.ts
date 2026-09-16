import { InvalidReviewCommandError, ReviewConflictError, ReviewDraftConflictError } from "../../../../packages/core/src/review-reducer.js";
import { ReviewGenerationConflictError } from "../sessions/session-broker.js";
import type { ReviewState, SaveDestinationConfirmation } from "../../../../packages/core/src/review-model.js";
import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PdfWriter } from "../../../../packages/core/src/pdf-writer.js";
import { PdfWriterError } from "../../../../packages/core/src/pdf-writer.js";
import { runPdfBackend, type PdfBackendRunOptions } from "../../../../packages/pdf-backends/src/backend-host.js";
import {
  inspectPdfWithEmbedPdf,
  type InspectedPdf,
} from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import {
  FileCapabilityError,
  FileCapabilityRegistry,
  hashFile,
  validatePdfFilename,
} from "../files/file-capabilities.js";
import { syncDirectory } from "../files/durability.js";
import { verifyReviewedPdf, type PdfExportVerifier } from "../export/pdf-verifier.js";
import { reviewStateDigest, type SaveFailureReason } from "../recovery/draft-snapshot.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import { defaultAnnotatedFilename, proposedCopyPath } from "./save-destination.js";
import type { DestinationPicker } from "../host/destination-picker.js";

/** Only semantic name rejection is recoverable in the still-open confirmation dialog. */
export function rejectedDestinationName(error: unknown, state: ReviewState | undefined) {
  if (state === undefined) return undefined;
  if (!(error instanceof InvalidReviewCommandError || error instanceof ReviewConflictError ||
    error instanceof ReviewDraftConflictError || error instanceof ReviewGenerationConflictError)) return undefined;
  return {
    accepted: false as const, state,
    message: error instanceof InvalidReviewCommandError ? error.message
      : error instanceof ReviewGenerationConflictError
        ? "The PDF was rebuilt before this name could be applied. Review the current generation and retry explicitly."
        : "Another review window changed this draft. Review the current revision and retry explicitly.",
    reason: error instanceof ReviewGenerationConflictError ? "generation-conflict" as const : "rejected" as const,
  };
}

const targetTails = new Map<string, Promise<void>>();

async function withTargetLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const predecessor = targetTails.get(path) ?? Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  targetTails.set(path, promise);
  await predecessor;
  try {
    return await work();
  } finally {
    resolve();
    if (targetTails.get(path) === promise) targetTails.delete(path);
  }
}

function classifyFailure(error: unknown): SaveFailureReason {
  if (error instanceof FileCapabilityError) {
    if (error.code === "SOURCE_CHANGED" || error.code === "TARGET_CHANGED") return "target-changed";
    if (error.code === "INVALID_PATH") return "missing";
  }
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
  if ((error as NodeJS.ErrnoException)?.code === "EACCES" ||
      (error as NodeJS.ErrnoException)?.code === "EPERM") return "permission-denied";
  if ((error as { code?: unknown })?.code === "OUTPUT_VERIFICATION_FAILED") {
    return "verification-failed";
  }
  if (error instanceof PdfWriterError && error.code === "invalid-annotation-geometry") {
    return "invalid-annotation-geometry";
  }
  return "write-failed";
}

export interface PdfSaveCoordinatorOptions {
  readonly broker: SessionBroker;
  readonly writer: PdfWriter;
  readonly capabilities?: FileCapabilityRegistry;
  readonly verify?: PdfExportVerifier;
  readonly backend?: Omit<PdfBackendRunOptions, "signal">;
  readonly picker?: DestinationPicker;
}

interface QueueState {
  requested: boolean;
  running?: Promise<void>;
}

export type SaveCopyProposal =
  | {
      readonly sourceDisposition: "local";
      readonly filename: string;
      readonly folder: string;
    }
  | { readonly sourceDisposition: "remote-temporary" };

export class PdfSaveCoordinator {
  readonly #broker: SessionBroker;
  readonly #writer: PdfWriter;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #verify: PdfExportVerifier;
  readonly #backend: Omit<PdfBackendRunOptions, "signal">;
  readonly #picker: DestinationPicker | undefined;
  readonly #reuseBackendInspection: boolean;
  readonly #folderSelections = new Map<string, { readonly sessionId: string; readonly path: string }>();
  readonly #queues = new Map<string, QueueState>();
  readonly #sourceInspections = new Map<string, Promise<InspectedPdf>>();

  constructor(options: PdfSaveCoordinatorOptions) {
    this.#broker = options.broker;
    this.#writer = options.writer;
    this.#capabilities = options.capabilities ?? options.broker.capabilities;
    this.#verify = options.verify ?? verifyReviewedPdf;
    this.#backend = options.backend ?? {};
    this.#picker = options.picker;
    this.#reuseBackendInspection = options.verify === undefined;
    this.#broker.onPhysicalSaveResume((sessionId) => {
      if (
        this.#queues.get(sessionId)?.running === undefined &&
        this.#broker.saveStatus(sessionId)?.sync.phase !== "clean"
      ) {
        void this.requestSave(sessionId);
      }
    });
  }

  #assertRewriteEligible(sessionId: string): void {
    const state = this.#broker.state(sessionId);
    if (state?.workflow.mode === "generated-output") {
      throw new PdfWriterError(
        "permission-denied",
        "Generated output is immutable. Use explicit export to create a reviewed copy.",
      );
    }
    const eligibility = this.#broker.saveStatus(sessionId)?.rewriteEligibility;
    if (eligibility?.eligible === false) {
      throw new PdfWriterError(eligibility.code, eligibility.message);
    }
  }

  proposal(sessionId: string): SaveCopyProposal {
    const state = this.#broker.state(sessionId);
    if (state === undefined) throw new Error("Review session is not active");
    if (this.#broker.sourceDisposition(sessionId) === "remote-temporary") {
      return { sourceDisposition: "remote-temporary" };
    }
    const sourcePath = this.#capabilities.getFilePath(state.source.fileId);
    if (sourcePath === undefined) throw new Error("Original PDF capability is unavailable");
    return {
      sourceDisposition: "local",
      filename: defaultAnnotatedFilename(sourcePath),
      folder: dirname(sourcePath),
    };
  }

  async chooseCopyFilename(
    sessionId: string,
    filename?: string,
    folderSelectionId?: string,
    confirmation?: SaveDestinationConfirmation,
  ): Promise<ReviewState | void> {
    const state = this.#broker.state(sessionId);
    if (state === undefined) throw new Error("Review session is not active");
    const remote = this.#broker.sourceDisposition(sessionId) === "remote-temporary";
    const sourcePath = this.#capabilities.getFilePath(state.source.fileId);
    if (sourcePath === undefined) throw new Error("Original PDF capability is unavailable");
    const selected = folderSelectionId === undefined
      ? undefined
      : this.#folderSelections.get(folderSelectionId);
    if (selected !== undefined && selected.sessionId !== sessionId) {
      this.#folderSelections.delete(folderSelectionId!);
      throw new FileCapabilityError("INVALID_PATH", "Folder selection belongs to another session");
    }
    if (remote && selected === undefined) {
      throw new FileCapabilityError(
        "INVALID_PATH",
        "Choose a new location for this remote browser PDF",
      );
    }
    const target = selected === undefined
      ? proposedCopyPath(sourcePath, filename)
      : join(selected.path, validatePdfFilename(
          remote ? filename ?? "" : filename ?? defaultAnnotatedFilename(sourcePath),
        ));
    // Claim the opaque selection before crossing an async boundary so it
    // cannot be replayed concurrently. Restore it on a destination error so
    // the dialog can preserve the user's location while they correct input.
    if (folderSelectionId !== undefined) this.#folderSelections.delete(folderSelectionId);
    try {
      return await this.chooseCopy(sessionId, target, confirmation);
    } catch (error) {
      if (folderSelectionId !== undefined && selected !== undefined) {
        this.#folderSelections.set(folderSelectionId, selected);
      }
      throw error;
    }
  }

  async chooseFolder(sessionId: string): Promise<
    | { readonly cancelled: true }
    | { readonly cancelled: false; readonly selectionId: string; readonly folder: string }
  > {
    if (this.#picker === undefined) throw new Error("Native destination picker is unavailable");
    const proposal = this.proposal(sessionId);
    const path = await this.#picker.chooseFolder(
      proposal.sourceDisposition === "local" ? proposal.folder : undefined,
    );
    if (path === undefined) return { cancelled: true };
    const selectionId = randomUUID();
    this.#folderSelections.set(selectionId, { sessionId, path });
    while (this.#folderSelections.size > 32) {
      this.#folderSelections.delete(this.#folderSelections.keys().next().value!);
    }
    return { cancelled: false, selectionId, folder: path };
  }

  async locate(sessionId: string): Promise<void> {
    if (this.#picker === undefined) throw new Error("Native destination picker is unavailable");
    const status = this.#broker.saveStatus(sessionId);
    if (status?.destination.phase !== "active" || status.destination.fingerprint === undefined) {
      throw new Error("There is no saved PDF identity to locate");
    }
    const selected = await this.#picker.locatePdf(dirname(status.destination.targetPath));
    if (selected === undefined) return;
    if ((await hashFile(selected)) !== status.destination.fingerprint) {
      throw new FileCapabilityError("TARGET_CHANGED", "The selected PDF is not the missing saved file");
    }
    if (status.destination.kind === "original") {
      const state = this.#broker.state(sessionId);
      if (state === undefined) throw new Error("Review session is not active");
      const targetPath = await this.#capabilities.rebindApprovedPdf(
        state.source.fileId,
        selected,
        status.destination.fingerprint,
      );
      await this.#broker.relocateOriginalDestination(sessionId, {
        targetPath,
        capabilityId: state.source.fileId,
        fingerprint: status.destination.fingerprint,
      });
    } else {
      const capability = await this.#capabilities.preauthorizeDestination(selected);
      await this.#capabilities.refreshDestination(capability.id, status.destination.fingerprint);
      await this.#broker.establishSaveDestination(sessionId, {
        kind: "copy",
        targetPath: join(capability.parentPath, capability.filename),
        capabilityId: capability.id,
        fingerprint: status.destination.fingerprint,
      });
    }
    await this.requestSave(sessionId);
  }

  async retry(sessionId: string): Promise<void> {
    const status = this.#broker.saveStatus(sessionId);
    if (status?.destination.phase !== "active") {
      throw new Error("Choose a save destination first");
    }
    await this.requestSave(sessionId);
  }

  async chooseCopy(sessionId: string, targetPath: string, confirmation?: SaveDestinationConfirmation): Promise<ReviewState | void> {
    this.#assertRewriteEligible(sessionId);
    const capability = await this.#capabilities.preauthorizeDestination(targetPath);
    let acceptedState: ReviewState;
    try {
      if (capability.existingTarget !== undefined) {
        throw new FileCapabilityError("TARGET_CHANGED", "A file already exists at that location");
      }
      const established = await this.#broker.establishSaveDestination(sessionId, {
        kind: "copy",
        targetPath: join(capability.parentPath, capability.filename),
        capabilityId: capability.id,
        ...(confirmation === undefined ? {} : { confirmation }),
      });
      acceptedState = established.state;
    } catch (error) {
      this.#capabilities.revokeDestination(capability.id);
      throw error;
    }
    await this.requestSave(sessionId);
    return confirmation === undefined ? undefined : acceptedState;
  }

  async chooseOriginal(sessionId: string, confirmation?: SaveDestinationConfirmation): Promise<ReviewState | void> {
    this.#assertRewriteEligible(sessionId);
    if (this.#broker.sourceDisposition(sessionId) === "remote-temporary") {
      throw new Error("A remote browser PDF cannot modify its private temporary source");
    }
    const state = this.#broker.state(sessionId);
    if (state === undefined) throw new Error("Review session is not active");
    const targetPath = this.#capabilities.getFilePath(state.source.fileId);
    if (targetPath === undefined) throw new Error("Original PDF capability is unavailable");
    const status = await this.#broker.establishSaveDestination(sessionId, {
      kind: "original",
      targetPath,
      capabilityId: state.source.fileId,
      fingerprint: state.source.digest,
      ...(confirmation === undefined ? {} : { confirmation }),
    });
    if (
      status.state.revision === 0 &&
      status.state.items.length === 0 &&
      status.destination.phase === "active"
    ) {
      await this.#broker.markSaveCommitted({
        sessionId,
        generation: status.destination.generation,
        revision: status.state.revision,
        stateDigest: status.sync.desiredDigest,
        targetDigest: state.source.digest,
      });
      return confirmation === undefined ? undefined : status.state;
    }
    await this.requestSave(sessionId);
    return confirmation === undefined ? undefined : status.state;
  }

  requestSave(sessionId: string): Promise<void> {
    if (this.#broker.state(sessionId)?.workflow.mode === "generated-output") {
      return Promise.resolve();
    }
    const queue = this.#queues.get(sessionId) ?? { requested: false };
    queue.requested = true;
    if (queue.running === undefined) {
      queue.running = this.#drain(sessionId, queue).finally(() => {
        delete queue.running;
        if (!queue.requested) this.#queues.delete(sessionId);
      });
    }
    this.#queues.set(sessionId, queue);
    return queue.running;
  }

  activityCount(): number {
    let count = 0;
    for (const queue of this.#queues.values()) {
      if (queue.requested || queue.running !== undefined) count += 1;
    }
    return count;
  }

  async drain(): Promise<void> {
    while (true) {
      const running = [...this.#queues.values()]
        .map((queue) => queue.running)
        .filter((promise): promise is Promise<void> => promise !== undefined);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  async #drain(sessionId: string, queue: QueueState): Promise<void> {
    while (queue.requested) {
      queue.requested = false;
      const status = this.#broker.saveStatus(sessionId);
      if (status?.destination.phase !== "active") return;
      if (
        this.#broker.physicalSaveBarrierPending(sessionId) &&
        !await this.#broker.settlePhysicalSaveBarrier(sessionId)
      ) return;
      const destination = status.destination;
      const generation = destination.generation;
      try {
        const delivery = await this.#broker.freezeDelivery(sessionId);
        const stateDigest = delivery.stateDigest ?? reviewStateDigest({ items: delivery.items ?? [] });
        await withTargetLock(destination.targetPath, async () => {
          const sourcePdf = new Uint8Array(await readFile(delivery.sourceSnapshotPath));
          const written = await runPdfBackend(this.#writer, {
            sourcePdf,
            sourceSha256: delivery.source.digest,
            revision: delivery.revision,
            annotations: delivery.annotations,
            manageNativeAnnotations: delivery.manageNativeAnnotations ?? false,
          }, this.#backend);
          let inspections: {
            readonly sourceInspection?: InspectedPdf;
            readonly candidateInspection?: InspectedPdf;
          } = {};
          if (this.#reuseBackendInspection) {
            let sourceInspection = this.#sourceInspections.get(delivery.source.digest);
            if (sourceInspection === undefined) {
              sourceInspection = inspectPdfWithEmbedPdf(sourcePdf);
              this.#sourceInspections.set(delivery.source.digest, sourceInspection);
              void sourceInspection.catch(() => {
                if (this.#sourceInspections.get(delivery.source.digest) === sourceInspection) {
                  this.#sourceInspections.delete(delivery.source.digest);
                }
              });
            }
            inspections = {
              sourceInspection: await sourceInspection,
              ...(
                written.inspection === undefined
                  ? {}
                  : { candidateInspection: written.inspection as InspectedPdf }
              ),
            };
          }
          await this.#verify({
            sourcePdf,
            candidatePdf: written.pdfBytes,
            evidence: written.evidence,
            annotations: delivery.annotations,
            manageNativeAnnotations: delivery.manageNativeAnnotations ?? false,
            ...inspections,
          });

          const target = destination.targetPath;
          const targetDirectory = dirname(target);
          const privateDirectory = dirname(delivery.sourceSnapshotPath);
          const [targetDirectoryInfo, privateDirectoryInfo] = await Promise.all([
            stat(targetDirectory),
            stat(privateDirectory),
          ]);
          const temporary = join(
            targetDirectoryInfo.dev === privateDirectoryInfo.dev ? privateDirectory : targetDirectory,
            `.placekeeper-${randomUUID()}.tmp`,
          );
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(written.pdfBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            if (
              this.#broker.physicalSaveBarrierPending(sessionId) &&
              !await this.#broker.settlePhysicalSaveBarrier(sessionId)
            ) {
              await rm(temporary, { force: true });
              queue.requested = true;
              return;
            }
            const committed = await this.#broker.commitSaveCandidate({
              sessionId,
              generation,
              documentGeneration: delivery.documentGeneration,
              sourceDigest: delivery.source.digest,
              revision: delivery.revision,
              stateDigest,
              commit: async () => {
                const validatedTarget = destination.kind === "original"
                  ? await this.#capabilities.validateOriginalForReplacement(
                      destination.capabilityId!,
                      delivery.originalDigest,
                    )
                  : await this.#capabilities.validateDestination(
                      destination.capabilityId!,
                    );
                if (validatedTarget !== target) {
                  throw new FileCapabilityError("TARGET_CHANGED", "Save target identity changed");
                }
                if (destination.kind === "original") {
                  const originalMode = (await stat(validatedTarget)).mode & 0o777;
                  await chmod(temporary, originalMode);
                }
                await rename(temporary, target);
                await syncDirectory(dirname(target));
                if (destination.kind === "original") {
                  await this.#capabilities.refreshApprovedPdf(
                    destination.capabilityId!,
                    written.evidence.outputSha256,
                  );
                } else {
                  await this.#capabilities.refreshDestination(
                    destination.capabilityId!,
                    written.evidence.outputSha256,
                  );
                }
                return written.evidence.outputSha256;
              },
            });
            if (committed === "generation-stale") {
              await rm(temporary, { force: true });
              queue.requested = true;
            } else if (committed === "committed-stale") {
              queue.requested = true;
            }
          } catch (error) {
            await rm(temporary, { force: true });
            throw error;
          }
        });
      } catch (error) {
        await this.#broker.markSaveFailed(sessionId, generation, classifyFailure(error));
        return;
      }
    }
  }
}
