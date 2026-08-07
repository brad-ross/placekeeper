import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import { createSelectedPdfWriter } from "../../../../packages/pdf-backends/src/selected-writer.js";
import {
  ExportCoordinator,
  type FrozenReviewDelivery,
  type PdfExportResult,
} from "../export/export-coordinator.js";
import {
  exportCodexHandoff,
  type CodexHandoffExportResult,
} from "../handoff/handoff-export.js";
import {
  checkCodexResult,
  type CheckCodexResultInput,
  type CodexResultCheck,
} from "../handoff/result-check.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import type { SessionControlRegistry } from "../sessions/control-socket.js";
import { hashFile, isContained } from "../files/file-capabilities.js";
import { querySyncTexHints } from "../synctex/query.js";

interface DeliveryBroker {
  freezeDelivery(sessionId: string): Promise<FrozenReviewDelivery>;
  readonly capabilities: {
    getFilePath(fileId: string): string | undefined;
  };
  readonly controls: Pick<SessionControlRegistry, "beginWrite">;
}

interface DeliveryReceipt {
  readonly sessionId: string;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly reviewedPdfSha256: string;
  readonly revisedPdfDestination: string;
  readonly sourceRoot: string;
  readonly resultDirectory: string;
  readonly baseline: ReadonlyMap<string, string>;
  readonly exclusions: readonly string[];
  readonly prompt: string;
}

export interface PreparedCodexDelivery {
  readonly receiptId: string;
  readonly prompt: string;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly reviewedPdfPath: string;
  readonly reviewedPdfSha256: string;
  readonly resultDirectory: string;
}

export interface CheckSelectedCodexResult {
  readonly receiptId: string;
  readonly dispositionText: string;
  readonly revisedPdfSelected: boolean;
}

export interface ReviewDeliveryServiceOptions {
  readonly broker: DeliveryBroker;
  readonly exportReviewedCopy: (delivery: FrozenReviewDelivery) => Promise<PdfExportResult>;
  readonly replaceOriginal: (delivery: FrozenReviewDelivery) => Promise<PdfExportResult>;
  readonly queryHints: typeof querySyncTexHints;
  readonly exportHandoff: typeof exportCodexHandoff;
  readonly checkResult: (input: CheckCodexResultInput) => Promise<CodexResultCheck>;
}

const MAX_BASELINE_FILES = 10_000;
const MAX_BASELINE_BYTES = 2 * 1024 * 1024 * 1024;

function excluded(candidate: string, exclusions: readonly string[]): boolean {
  return exclusions.some((entry) => candidate === entry || isContained(entry, candidate));
}

async function sourceSnapshot(
  sourceRoot: string,
  exclusions: readonly string[],
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (excluded(path, exclusions)) continue;
      const info = await lstat(path);
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      if (snapshot.size >= MAX_BASELINE_FILES) {
        throw new Error("The approved source root exceeds the 10,000-file result-check limit");
      }
      totalBytes += info.isFile() ? info.size : 0;
      if (totalBytes > MAX_BASELINE_BYTES) {
        throw new Error("The approved source root exceeds the 2 GiB result-check limit");
      }
      const digest = info.isSymbolicLink()
        ? createHash("sha256").update(`symlink:${await readlink(path)}`).digest("hex")
        : await hashFile(path);
      snapshot.set(relative(sourceRoot, path), digest);
    }
  };
  await visit(sourceRoot);
  return snapshot;
}

function revisedName(pdfPath: string): string {
  const name = basename(pdfPath);
  const extension = extname(name);
  const stem = extension.length === 0 ? name : name.slice(0, -extension.length);
  return `${stem}-revised.pdf`;
}

async function syncedText(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ReviewDeliveryService {
  readonly #broker: DeliveryBroker;
  readonly #exportReviewedCopy: ReviewDeliveryServiceOptions["exportReviewedCopy"];
  readonly #replaceOriginal: ReviewDeliveryServiceOptions["replaceOriginal"];
  readonly #queryHints: ReviewDeliveryServiceOptions["queryHints"];
  readonly #exportHandoff: ReviewDeliveryServiceOptions["exportHandoff"];
  readonly #checkResult: ReviewDeliveryServiceOptions["checkResult"];
  readonly #receipts = new Map<string, DeliveryReceipt>();

  constructor(options: ReviewDeliveryServiceOptions) {
    this.#broker = options.broker;
    this.#exportReviewedCopy = options.exportReviewedCopy;
    this.#replaceOriginal = options.replaceOriginal;
    this.#queryHints = options.queryHints;
    this.#exportHandoff = options.exportHandoff;
    this.#checkResult = options.checkResult;
  }

  static async create(broker: SessionBroker): Promise<ReviewDeliveryService> {
    const writer = await createSelectedPdfWriter();
    const coordinator = new ExportCoordinator({
      writer,
      capabilities: broker.capabilities,
      controls: broker.controls,
      recordSuccessfulExport: (sessionId) => broker.recordSuccessfulExport(sessionId),
      prepareReplacement: (sessionId, digest) => broker.prepareReplacement(sessionId, digest),
      recordSuccessfulReplacement: (sessionId, digest) =>
        broker.recordSuccessfulReplacement(sessionId, digest),
    });
    return new ReviewDeliveryService({
      broker,
      exportReviewedCopy: (delivery) => coordinator.exportReviewedCopy(delivery),
      replaceOriginal: (delivery) => coordinator.replaceOriginal(delivery),
      queryHints: querySyncTexHints,
      exportHandoff: exportCodexHandoff,
      checkResult: checkCodexResult,
    });
  }

  async saveReviewedCopy(sessionId: string): Promise<PdfExportResult> {
    return this.#exportReviewedCopy(await this.#broker.freezeDelivery(sessionId));
  }

  async replaceOriginal(sessionId: string): Promise<PdfExportResult> {
    return this.#replaceOriginal(await this.#broker.freezeDelivery(sessionId));
  }

  async prepareCodex(sessionId: string): Promise<PreparedCodexDelivery> {
    const lease = this.#broker.controls.beginWrite(sessionId);
    let resultDirectory: string | undefined;
    try {
      lease.signal.throwIfAborted();
      const delivery = await this.#broker.freezeDelivery(sessionId);
      lease.signal.throwIfAborted();
      const sourcePdfPath = this.#broker.capabilities.getFilePath(delivery.source.fileId);
      if (sourcePdfPath === undefined || delivery.sourceRootPath === undefined) {
        throw new Error("Choose an approved source root before Codex delivery");
      }
      const reviewed = await this.#exportReviewedCopy(delivery);
      lease.signal.throwIfAborted();
      const hints = await this.#queryHints({ delivery, pdfPath: sourcePdfPath });
      lease.signal.throwIfAborted();
      const exported: CodexHandoffExportResult = await this.#exportHandoff({
        delivery,
        reviewedPdf: reviewed,
        resultParent: delivery.sourceRootPath,
        revisedPdfFilename: revisedName(sourcePdfPath),
        sourceHints: hints,
      });
      resultDirectory = await realpath(exported.resultDirectory);
      lease.signal.throwIfAborted();
      const sourceRoot = await realpath(delivery.sourceRootPath);
      const exclusions = [await realpath(reviewed.path), resultDirectory];
      const baseline = await sourceSnapshot(sourceRoot, exclusions);
      lease.signal.throwIfAborted();
      const receiptId = randomUUID();
      this.#receipts.set(receiptId, {
        sessionId,
        handoffPath: exported.handoffPath,
        handoffSha256: exported.handoffSha256,
        reviewedPdfSha256: reviewed.digest,
        revisedPdfDestination: exported.handoff.revisedPdfDestination,
        sourceRoot,
        resultDirectory,
        baseline,
        exclusions,
        prompt: exported.prompt,
      });
      while (this.#receipts.size > 32) this.#receipts.delete(this.#receipts.keys().next().value!);
      return {
        receiptId,
        prompt: exported.prompt,
        handoffPath: exported.handoffPath,
        handoffSha256: exported.handoffSha256,
        reviewedPdfPath: reviewed.path,
        reviewedPdfSha256: reviewed.digest,
        resultDirectory,
      };
    } catch (error) {
      if (resultDirectory !== undefined) {
        await rm(resultDirectory, { recursive: true, force: true });
      }
      throw error;
    } finally {
      lease.complete();
    }
  }

  async saveInstruction(sessionId: string, receiptId: string): Promise<string> {
    const lease = this.#broker.controls.beginWrite(sessionId);
    const receipt = this.#receipt(sessionId, receiptId);
    const path = join(receipt.resultDirectory, "codex-instruction.txt");
    try {
      lease.signal.throwIfAborted();
      await syncedText(path, `${receipt.prompt}\n`);
      lease.signal.throwIfAborted();
      return path;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    } finally {
      lease.complete();
    }
  }

  async checkCodex(
    sessionId: string,
    input: CheckSelectedCodexResult,
  ): Promise<{ readonly status: "Complete" | "Partial" | "Invalid"; readonly message: string }> {
    const receipt = this.#receipt(sessionId, input.receiptId);
    const lease = this.#broker.controls.beginWrite(sessionId);
    const selectedDisposition = join(
      receipt.resultDirectory,
      `.selected-disposition-${randomUUID()}.json`,
    );
    try {
      if (Buffer.byteLength(input.dispositionText) > 16 * 1024 * 1024) {
        throw new Error("The selected disposition exceeds the 16 MiB result limit");
      }
      lease.signal.throwIfAborted();
      await syncedText(selectedDisposition, input.dispositionText);
      lease.signal.throwIfAborted();
      const current = await sourceSnapshot(receipt.sourceRoot, receipt.exclusions);
      lease.signal.throwIfAborted();
      const paths = new Set([...receipt.baseline.keys(), ...current.keys()]);
      const observableChangedPaths = [...paths]
        .filter((path) => receipt.baseline.get(path) !== current.get(path))
        .sort();
      const result = await this.#checkResult({
        handoffPath: receipt.handoffPath,
        expectedHandoffSha256: receipt.handoffSha256,
        expectedReviewedPdfSha256: receipt.reviewedPdfSha256,
        dispositionPath: selectedDisposition,
        observableChangedPaths,
        ...(input.revisedPdfSelected
          ? { revisedPdfPath: receipt.revisedPdfDestination }
          : {}),
      });
      lease.signal.throwIfAborted();
      return {
        status: result.status,
        message: result.issues.length === 0
          ? "The returned artifacts match the immutable handoff and observable local changes."
          : result.issues.join(" "),
      };
    } finally {
      await rm(selectedDisposition, { force: true });
      lease.complete();
    }
  }

  #receipt(sessionId: string, receiptId: string): DeliveryReceipt {
    const receipt = this.#receipts.get(receiptId);
    if (receipt === undefined || receipt.sessionId !== sessionId) {
      throw new Error("Select a result created from this review's trusted handoff receipt");
    }
    return receipt;
  }
}
