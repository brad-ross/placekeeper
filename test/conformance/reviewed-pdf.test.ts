import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PdfStructuralEvidence,
  ReviewAnnotation,
} from "../../packages/core/src/pdf-writer.js";
import { createSelectedPdfWriter } from "../../packages/pdf-backends/src/selected-writer.js";
import { inspectPdfWithEmbedPdf } from "../../packages/pdf-backends/src/embedpdf-adapter.js";
import { ExportCoordinator } from "../../apps/service/src/export/export-coordinator.js";
import { verifyReviewedPdf } from "../../apps/service/src/export/pdf-verifier.js";
import { FileCapabilityRegistry } from "../../apps/service/src/files/file-capabilities.js";

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

const timestamp = "2026-08-07T12:00:00.000Z";
const annotations: readonly ReviewAnnotation[] = [
  {
    kind: "replace",
    id: "10000000-0000-4000-8000-000000000001",
    pageIndex: 0,
    rect: { x: 72, y: 92, width: 130, height: 14 },
    quadPoints: [{ x: 72, y: 92, width: 130, height: 14 }],
    contents: "locally unique equilibrium",
    author: "PDF Proofreader",
    createdAt: timestamp,
    modifiedAt: timestamp,
    textAnchorReliable: true,
  },
  {
    kind: "delete",
    id: "20000000-0000-4000-8000-000000000002",
    pageIndex: 0,
    rect: { x: 210, y: 92, width: 45, height: 14 },
    quadPoints: [{ x: 210, y: 92, width: 45, height: 14 }],
    contents: "",
    author: "PDF Proofreader",
    createdAt: timestamp,
    modifiedAt: timestamp,
    textAnchorReliable: true,
  },
  {
    kind: "insert",
    id: "30000000-0000-4000-8000-000000000003",
    pageIndex: 0,
    rect: { x: 265, y: 88, width: 14, height: 20 },
    contents: "however",
    author: "PDF Proofreader",
    createdAt: timestamp,
    modifiedAt: timestamp,
    textAnchorReliable: true,
  },
  {
    kind: "highlight",
    id: "40000000-0000-4000-8000-000000000004",
    pageIndex: 0,
    rect: { x: 72, y: 120, width: 180, height: 16 },
    quadPoints: [{ x: 72, y: 120, width: 180, height: 16 }],
    contents: "Check this argument.",
    author: "PDF Proofreader",
    createdAt: timestamp,
    modifiedAt: timestamp,
    textAnchorReliable: true,
  },
  {
    kind: "pageNote",
    id: "50000000-0000-4000-8000-000000000005",
    pageIndex: 0,
    rect: { x: 500, y: 700, width: 24, height: 24 },
    contents: "Page-level comment.",
    author: "PDF Proofreader",
    createdAt: timestamp,
    modifiedAt: timestamp,
  },
];

async function deliveryForFixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "pdf-proofreader-conformance-"));
  temporaryDirectories.push(directory);
  const source = new Uint8Array(
    await readFile(resolve("test/fixtures/pdfs", name)),
  );
  const originalPath = join(directory, "paper.pdf");
  const snapshotPath = join(directory, "source.pdf");
  await writeFile(originalPath, source);
  await writeFile(snapshotPath, source);
  const capabilities = new FileCapabilityRegistry();
  const approved = await capabilities.approvePdf(originalPath);
  return {
    source,
    originalPath,
    capabilities,
    delivery: {
      sessionId: randomUUID(),
      source: {
        fileId: approved.id,
        digest: sha256(source),
        byteLength: source.byteLength,
      },
      originalDigest: sha256(source),
      revision: 5,
      sourceSnapshotPath: snapshotPath,
      annotations,
    },
  };
}

describe("reviewed PDF conformance", () => {
  it("exports every v1 type and preserves supported and unsupported source annotations", async () => {
    const fixture = await deliveryForFixture("preservation-corpus.pdf");
    const coordinator = new ExportCoordinator({
      writer: await createSelectedPdfWriter(),
      capabilities: fixture.capabilities,
      backend: { timeoutMs: 20_000 },
    });

    const result = await coordinator.exportReviewedCopy(fixture.delivery);
    const inspected = await inspectPdfWithEmbedPdf(
      new Uint8Array(await readFile(result.path)),
    );

    expect(await readFile(fixture.originalPath)).toEqual(Buffer.from(fixture.source));
    expect(inspected.annotations.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "preserved-highlight",
        "preserved-stamp",
        "preserved-ink",
        "preserved-link",
        "preserved-widget",
        ...annotations.map(({ id }) => id),
      ]),
    );
    for (const annotation of annotations) {
      const written = inspected.annotations.find(({ id }) => id === annotation.id);
      expect(written?.contents).toBe(annotation.contents);
      expect(written?.pageIndex).toBe(annotation.pageIndex);
      expect(written?.flags).toContain("print");
      expect(written?.hasNormalAppearance).toBe(true);
    }
  }, 60_000);

  it.each([
    ["encrypted-no-annotation.pdf", "encrypted"],
    ["docmdp-no-annotation.pdf", "signature-restricted"],
  ] as const)("fails closed for restricted fixture %s", async (name, code) => {
    const fixture = await deliveryForFixture(name);
    const coordinator = new ExportCoordinator({
      writer: await createSelectedPdfWriter(),
      capabilities: fixture.capabilities,
    });

    await expect(coordinator.exportReviewedCopy(fixture.delivery)).rejects.toMatchObject({ code });
    expect(await readFile(fixture.originalPath)).toEqual(Buffer.from(fixture.source));
  }, 60_000);

  it("rejects changed page content even when the page count is unchanged", async () => {
    const source = new Uint8Array(
      await readFile(resolve("test/fixtures/pdfs/text-native.pdf")),
    );
    const candidate = new Uint8Array(
      await readFile(resolve("test/fixtures/pdfs/image-only.pdf")),
    );
    const evidence: PdfStructuralEvidence = {
      backend: "embedpdf",
      backendVersion: "2.14.4",
      originalSha256: sha256(source),
      outputSha256: sha256(candidate),
      pageCount: 1,
      structurallyValid: true,
      preexistingAnnotationIds: [],
      annotations: [],
    };

    await expect(
      verifyReviewedPdf({ sourcePdf: source, candidatePdf: candidate, evidence, annotations: [] }),
    ).rejects.toThrow(/page content or geometry/i);
  }, 60_000);
});
