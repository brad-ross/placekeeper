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
  }

  #assertRewriteEligible(sessionId: string): void {
    const eligibility = this.#broker.saveStatus(sessionId)?.rewriteEligibility;
    if (eligibility?.eligible === false) {
      throw new PdfWriterError(eligibility.code, eligibility.message);
    }
  }

  proposal(sessionId: string): { readonly filename: string; readonly folder: string } {
    const state = this.#broker.state(sessionId);
    if (state === undefined) throw new Error("Review session is not active");
    const sourcePath = this.#capabilities.getFilePath(state.source.fileId);
    if (sourcePath === undefined) throw new Error("Original PDF capability is unavailable");
    return { filename: defaultAnnotatedFilename(sourcePath), folder: dirname(sourcePath) };
  }

  async chooseCopyFilename(
    sessionId: string,
    filename?: string,
    folderSelectionId?: string,
  ): Promise<void> {
    const state = this.#broker.state(sessionId);
    if (state === undefined) throw new Error("Review session is not active");
    const sourcePath = this.#capabilities.getFilePath(state.source.fileId);
    if (sourcePath === undefined) throw new Error("Original PDF capability is unavailable");
    const selected = folderSelectionId === undefined
      ? undefined
      : this.#folderSelections.get(folderSelectionId);
    if (folderSelectionId !== undefined) this.#folderSelections.delete(folderSelectionId);
    if (selected !== undefined && selected.sessionId !== sessionId) {
      throw new FileCapabilityError("INVALID_PATH", "Folder selection belongs to another session");
    }
    const target = selected === undefined
      ? proposedCopyPath(sourcePath, filename)
      : join(
          selected.path,
          validatePdfFilename(filename ?? defaultAnnotatedFilename(sourcePath)),
        );
    await this.chooseCopy(sessionId, target);
  }

  async chooseFolder(sessionId: string): Promise<
    | { readonly cancelled: true }
    | { readonly cancelled: false; readonly selectionId: string; readonly folder: string }
  > {
    if (this.#picker === undefined) throw new Error("Native destination picker is unavailable");
    const proposal = this.proposal(sessionId);
    const path = await this.#picker.chooseFolder(proposal.folder);
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

  async chooseCopy(sessionId: string, targetPath: string): Promise<void> {
    this.#assertRewriteEligible(sessionId);
    const capability = await this.#capabilities.preauthorizeDestination(targetPath);
    if (capability.existingTarget !== undefined) {
      this.#capabilities.revokeDestination(capability.id);
      throw new FileCapabilityError("TARGET_CHANGED", "A file already exists at that location");
    }
    await this.#broker.establishSaveDestination(sessionId, {
      kind: "copy",
      targetPath: join(capability.parentPath, capability.filename),
      capabilityId: capability.id,
    });
    await this.requestSave(sessionId);
  }

  async chooseOriginal(sessionId: string): Promise<void> {
    this.#assertRewriteEligible(sessionId);
    const state = this.#broker.state(sessionId);
    if (state === undefined) throw new Error("Review session is not active");
    const targetPath = this.#capabilities.getFilePath(state.source.fileId);
    if (targetPath === undefined) throw new Error("Original PDF capability is unavailable");
    const status = await this.#broker.establishSaveDestination(sessionId, {
      kind: "original",
      targetPath,
      capabilityId: state.source.fileId,
      fingerprint: state.source.digest,
    });
    if (
      state.revision === 0 &&
      state.items.length === 0 &&
      status.destination.phase === "active"
    ) {
      await this.#broker.markSaveCommitted({
        sessionId,
        generation: status.destination.generation,
        revision: state.revision,
        stateDigest: status.sync.desiredDigest,
        targetDigest: state.source.digest,
      });
      return;
    }
    await this.requestSave(sessionId);
  }

  requestSave(sessionId: string): Promise<void> {
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

  async #drain(sessionId: string, queue: QueueState): Promise<void> {
    while (queue.requested) {
      queue.requested = false;
      const status = this.#broker.saveStatus(sessionId);
      if (status?.destination.phase !== "active") return;
      const destination = status.destination;
      const generation = destination.generation;
      try {
        const delivery = await this.#broker.freezeDelivery(sessionId);
        const stateDigest = reviewStateDigest({ items: delivery.items ?? [] });
        await withTargetLock(destination.targetPath, async () => {
          const sourcePdf = new Uint8Array(await readFile(delivery.sourceSnapshotPath));
          const written = await runPdfBackend(this.#writer, {
            sourcePdf,
            sourceSha256: delivery.source.digest,
            revision: delivery.revision,
            annotations: delivery.annotations,
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
            ...inspections,
          });

          const target = destination.targetPath;
          const temporary = join(dirname(target), `.pdf-markup-${randomUUID()}.tmp`);
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(written.pdfBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            const committed = await this.#broker.commitSaveCandidate({
              sessionId,
              generation,
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
