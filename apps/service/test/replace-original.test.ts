import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PdfWriterError,
  type PdfWriteResult,
  type PdfWriteRequest,
  type PdfWriterErrorCode,
  type ReviewAnnotation,
} from "../../../packages/core/src/pdf-writer.js";
import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { FileCapabilityRegistry } from "../src/files/file-capabilities.js";
import { ExportCoordinator } from "../src/export/export-coordinator.js";
import { SessionBroker } from "../src/sessions/session-broker.js";

const temporaryDirectories: string[] = [];
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function replacementFixture() {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-replace-"));
  temporaryDirectories.push(directory);
  const originalPath = join(directory, "paper.pdf");
  const snapshotPath = join(directory, "snapshot.pdf");
  const original = Buffer.from("%PDF-1.7\noriginal immutable bytes\n%%EOF");
  const reviewed = Buffer.from("%PDF-1.7\nreviewed replacement\n%%EOF");
  await writeFile(originalPath, original, { mode: 0o640 });
  await writeFile(snapshotPath, original);
  const capabilities = new FileCapabilityRegistry();
  const approved = await capabilities.approvePdf(originalPath);
  const annotation: ReviewAnnotation = {
    kind: "pageNote",
    id: randomUUID(),
    pageIndex: 0,
    rect: { x: 10, y: 10, width: 20, height: 20 },
    contents: "Check this page.",
    author: "Placekeeper",
    createdAt: "2026-08-07T12:00:00.000Z",
    modifiedAt: "2026-08-07T12:00:00.000Z",
  };
  const result: PdfWriteResult = {
    pdfBytes: reviewed,
    evidence: {
      backend: "embedpdf",
      backendVersion: "2.14.4",
      originalSha256: sha256(original),
      outputSha256: sha256(reviewed),
      pageCount: 1,
      structurallyValid: true,
      preexistingAnnotationIds: [],
      annotations: [],
    },
  };
  const delivery = {
    sessionId: randomUUID(),
    source: {
      fileId: approved.id,
      digest: sha256(original),
      byteLength: original.byteLength,
    },
    originalDigest: sha256(original),
    revision: 1,
    sourceSnapshotPath: snapshotPath,
    annotations: [annotation],
  };
  const verify = async () => ({ pageCount: 1, annotationIds: [annotation.id] });
  return {
    directory,
    originalPath,
    snapshotPath,
    original,
    reviewed,
    capabilities,
    approved,
    annotation,
    result,
    delivery,
    verify,
  };
}

describe("explicit original replacement", () => {
  it("atomically replaces an unchanged permitted original and preserves its mode", async () => {
    const fixture = await replacementFixture();
    let recorded = 0;
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: fixture.verify,
      prepareReplacement: async () => undefined,
      recordSuccessfulReplacement: async () => {
        recorded += 1;
      },
    });

    const result = await coordinator.replaceOriginal(fixture.delivery);

    expect(result.kind).toBe("original-replacement");
    expect(result.path).toBe(fixture.approved.canonicalPath);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.reviewed);
    expect((await stat(fixture.originalPath)).mode & 0o777).toBe(0o640);
    expect(recorded).toBe(1);
  });

  it("aborts when the source drifts at the final pre-commit hook", async () => {
    const fixture = await replacementFixture();
    const changed = Buffer.from("%PDF-1.7\nexternal rebuild\n%%EOF");
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: fixture.verify,
      prepareReplacement: async () => undefined,
      recordSuccessfulReplacement: async () => undefined,
      hooks: { beforeFinalize: () => writeFile(fixture.originalPath, changed) },
    });

    await expect(coordinator.replaceOriginal(fixture.delivery)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    expect(await readFile(fixture.originalPath)).toEqual(changed);
    expect((await readdir(fixture.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("aborts when the approved target is swapped for a symlink", async () => {
    const fixture = await replacementFixture();
    const otherPath = join(fixture.directory, "other.pdf");
    const other = Buffer.from("%PDF-1.7\nother target\n%%EOF");
    await writeFile(otherPath, other);
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: fixture.verify,
      prepareReplacement: async () => undefined,
      recordSuccessfulReplacement: async () => undefined,
      hooks: {
        beforeFinalize: async () => {
          await rm(fixture.originalPath);
          await symlink(otherPath, fixture.originalPath);
        },
      },
    });

    await expect(coordinator.replaceOriginal(fixture.delivery)).rejects.toMatchObject({
      code: "SOURCE_CHANGED",
    });
    expect((await lstat(fixture.originalPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(otherPath)).toEqual(other);
  });

  it("fails closed when the filesystem does not permit replacement", async () => {
    const fixture = await replacementFixture();
    await chmod(fixture.originalPath, 0o440);
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: fixture.verify,
      prepareReplacement: async () => undefined,
      recordSuccessfulReplacement: async () => undefined,
    });

    await expect(coordinator.replaceOriginal(fixture.delivery)).rejects.toMatchObject({
      code: "ORIGINAL_REPLACEMENT_UNAVAILABLE",
    });
    expect(await readFile(fixture.originalPath)).toEqual(fixture.original);
  });

  it("returns a committed warning when directory sync fails after original rename", async () => {
    const fixture = await replacementFixture();
    let recorded = 0;
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: fixture.verify,
      prepareReplacement: async () => undefined,
      recordSuccessfulReplacement: async () => {
        recorded += 1;
      },
      hooks: {
        beforeCommittedDirectorySync: (kind) => {
          if (kind === "original-replacement") {
            throw new Error("simulated directory sync failure");
          }
        },
      },
    });

    const result = await coordinator.replaceOriginal(fixture.delivery);

    expect(result.warning).toContain("original was replaced");
    expect(await readFile(fixture.originalPath)).toEqual(fixture.reviewed);
    expect(recorded).toBe(1);
  });

  it.each([
    ["encrypted", "Encrypted PDFs cannot be replaced."],
    ["signature-restricted", "Signed PDFs cannot be replaced."],
    ["permission-denied", "The PDF forbids annotation."],
  ] as const)("preserves the original for %s writer restrictions", async (code, message) => {
    const fixture = await replacementFixture();
    const coordinator = new ExportCoordinator({
      writer: {
        write: async () => {
          throw new PdfWriterError(code as PdfWriterErrorCode, message);
        },
      },
      capabilities: fixture.capabilities,
      verify: fixture.verify,
      prepareReplacement: async () => undefined,
      recordSuccessfulReplacement: async () => undefined,
    });

    await expect(coordinator.replaceOriginal(fixture.delivery)).rejects.toMatchObject({ code });
    expect(await readFile(fixture.originalPath)).toEqual(fixture.original);
  });

  it("recognizes an exact app-authored replacement after restart and permits a later revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-replace-recovery-"));
    temporaryDirectories.push(directory);
    const originalPath = join(directory, "paper.pdf");
    const original = Buffer.from("%PDF-1.7\nopened source\n%%EOF");
    await writeFile(originalPath, original);
    const recoveryRoot = join(directory, "recovery");
    const firstBroker = new SessionBroker({ recoveryRoot });
    const opened = await firstBroker.openReview({ pdfPath: originalPath });
    if (opened.kind !== "opened") throw new Error("Expected opened review");
    await firstBroker.acceptMutation(
      opened.launch.sessionId,
      addPageNote(
        firstBroker.state(opened.launch.sessionId)!,
        0,
        { x: 10, y: 10, width: 20, height: 20 },
        "First note",
      ),
    );
    const firstFrozen = await firstBroker.freezeDelivery(opened.launch.sessionId);
    expect(firstFrozen.annotations).toMatchObject([{
      author: "Placekeeper",
      custom: {
        placekeeper: {
          owner: "placekeeper",
          schemaVersion: 2,
          projection: { author: "Placekeeper" },
        },
      },
    }]);
    const outputFor = (request: PdfWriteRequest): PdfWriteResult => {
      const pdfBytes = Buffer.from(`%PDF-1.7\nreviewed revision ${request.revision}\n%%EOF`);
      return {
        pdfBytes,
        evidence: {
          backend: "embedpdf",
          backendVersion: "2.14.4",
          originalSha256: request.sourceSha256,
          outputSha256: sha256(pdfBytes),
          pageCount: 1,
          structurallyValid: true,
          preexistingAnnotationIds: [],
          annotations: [],
        },
      };
    };
    const firstCoordinator = new ExportCoordinator({
      writer: { write: async (request) => outputFor(request) },
      capabilities: firstBroker.capabilities,
      controls: firstBroker.controls,
      verify: async ({ annotations: frozenAnnotations }) => ({
        pageCount: 1,
        annotationIds: frozenAnnotations.map(({ id }) => id),
      }),
      prepareReplacement: (sessionId, digest) =>
        firstBroker.prepareReplacement(sessionId, digest),
      recordSuccessfulReplacement: (sessionId, digest) =>
        firstBroker.recordSuccessfulReplacement(sessionId, digest),
    });
    const firstResult = await firstCoordinator.replaceOriginal(firstFrozen);
    await expect(firstBroker.openReview({ pdfPath: originalPath })).resolves.toMatchObject({
      kind: "focused",
      launch: { sessionId: opened.launch.sessionId },
    });

    const restarted = new SessionBroker({ recoveryRoot });
    const offered = await restarted.openReview({ pdfPath: originalPath });
    expect(offered).toEqual({
      kind: "recovery-offered",
      recoverySessionId: opened.launch.sessionId,
      choices: ["resume", "discard", "fork"],
      recoveryOffer: {
        id: expect.any(String),
        expiresAt: expect.any(String),
      },
    });
    if (offered.kind !== "recovery-offered") throw new Error("Expected recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: originalPath,
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected resumed review");
    await expect(restarted.openReview({ pdfPath: originalPath })).resolves.toMatchObject({
      kind: "focused",
      launch: { sessionId: resumed.launch.sessionId },
    });
    await restarted.acceptMutation(
      resumed.launch.sessionId,
      addPageNote(
        restarted.state(resumed.launch.sessionId)!,
        0,
        { x: 40, y: 40, width: 20, height: 20 },
        "Second note",
      ),
    );
    const secondFrozen = await restarted.freezeDelivery(resumed.launch.sessionId);
    expect(secondFrozen.annotations.every(({ author }) => author === "Placekeeper")).toBe(true);
    expect(secondFrozen.source.digest).toBe(sha256(original));
    expect(secondFrozen.originalDigest).toBe(firstResult.digest);
    const secondCoordinator = new ExportCoordinator({
      writer: { write: async (request) => outputFor(request) },
      capabilities: restarted.capabilities,
      controls: restarted.controls,
      verify: async ({ annotations: frozenAnnotations }) => ({
        pageCount: 1,
        annotationIds: frozenAnnotations.map(({ id }) => id),
      }),
      prepareReplacement: (sessionId, digest) =>
        restarted.prepareReplacement(sessionId, digest),
      recordSuccessfulReplacement: (sessionId, digest) =>
        restarted.recordSuccessfulReplacement(sessionId, digest),
    });

    const secondResult = await secondCoordinator.replaceOriginal(secondFrozen);
    expect(secondResult.revision).toBe(2);
    expect(await readFile(originalPath, "utf8")).toContain("reviewed revision 2");
  });

  it("retains a discoverable prepared digest if post-rename bookkeeping is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-replace-crash-"));
    temporaryDirectories.push(directory);
    const originalPath = join(directory, "paper.pdf");
    const original = Buffer.from("%PDF-1.7\ncrash source\n%%EOF");
    const reviewed = Buffer.from("%PDF-1.7\ncommitted before crash\n%%EOF");
    await writeFile(originalPath, original);
    const recoveryRoot = join(directory, "recovery");
    const broker = new SessionBroker({ recoveryRoot });
    const opened = await broker.openReview({ pdfPath: originalPath });
    if (opened.kind !== "opened") throw new Error("Expected opened review");
    await broker.acceptMutation(
      opened.launch.sessionId,
      addPageNote(
        broker.state(opened.launch.sessionId)!,
        0,
        { x: 10, y: 10, width: 20, height: 20 },
        "Crash-safe note",
      ),
    );
    const frozen = await broker.freezeDelivery(opened.launch.sessionId);
    const coordinator = new ExportCoordinator({
      writer: {
        write: async (request) => ({
          pdfBytes: reviewed,
          evidence: {
            backend: "embedpdf",
            backendVersion: "2.14.4",
            originalSha256: request.sourceSha256,
            outputSha256: sha256(reviewed),
            pageCount: 1,
            structurallyValid: true,
            preexistingAnnotationIds: [],
            annotations: [],
          },
        }),
      },
      capabilities: broker.capabilities,
      controls: broker.controls,
      verify: async () => ({
        pageCount: 1,
        annotationIds: frozen.annotations.map(({ id }) => id),
      }),
      prepareReplacement: (sessionId, digest) =>
        broker.prepareReplacement(sessionId, digest),
      recordSuccessfulReplacement: async () => {
        throw new Error("simulated crash after rename");
      },
    });

    const result = await coordinator.replaceOriginal(frozen);
    expect(result.warning).toContain("original was replaced");
    expect(await readFile(originalPath)).toEqual(reviewed);
    const restarted = new SessionBroker({ recoveryRoot });
    await expect(restarted.openReview({ pdfPath: originalPath })).resolves.toEqual({
      kind: "recovery-offered",
      recoverySessionId: opened.launch.sessionId,
      choices: ["resume", "discard", "fork"],
      recoveryOffer: {
        id: expect.any(String),
        expiresAt: expect.any(String),
      },
    });
  });
});
