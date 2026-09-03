import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PdfStructuralEvidence,
  ReviewAnnotation,
} from "../../packages/core/src/pdf-writer.js";
import {
  projectReviewItem,
  projectReviewItemProjections,
} from "../../packages/core/src/annotation-projection.js";
import type { ReviewItem } from "../../packages/core/src/review-model.js";
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
    author: "Placekeeper",
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
    author: "Placekeeper",
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
    author: "Placekeeper",
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
    author: "Placekeeper",
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
    author: "Placekeeper",
    createdAt: timestamp,
    modifiedAt: timestamp,
  },
];

async function deliveryForFixture(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-conformance-"));
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
  it("exports and verifies one complete cross-page portable group", async () => {
    const fixture = await deliveryForFixture("pdf-search.pdf");
    const pages = [0, 1, 2].map((pageIndex) => ({
      pageIndex,
      quote: `page ${pageIndex + 1}`,
      prefix: pageIndex === 0 ? "before " : "",
      suffix: pageIndex === 2 ? " after" : "",
      rect: { x: 72, y: 92 + pageIndex * 12, width: 120, height: 16 },
      segmentRects: [{ x: 72, y: 92 + pageIndex * 12, width: 120, height: 16 }],
    }));
    const item: ReviewItem = {
      id: "80000000-0000-4000-8000-000000000008",
      kind: "replace",
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: pages.map(({ quote }) => quote).join("\n"),
        prefix: pages[0]!.prefix,
        suffix: pages[2]!.suffix,
        rect: pages[0]!.rect,
        segmentRects: pages[0]!.segmentRects,
        pages,
        pageBoundaries: [
          { afterPageIndex: 0, separator: "\n" },
          { afterPageIndex: 1, separator: "\n" },
        ],
        reliable: true,
        proposedText: "Replacement across pages",
      },
    };
    const projections = projectReviewItemProjections(item);
    const coordinator = new ExportCoordinator({
      writer: await createSelectedPdfWriter(),
      capabilities: fixture.capabilities,
      backend: { timeoutMs: 20_000 },
    });

    const result = await coordinator.exportReviewedCopy({
      ...fixture.delivery,
      annotations: projections,
    });
    const inspected = await inspectPdfWithEmbedPdf(
      new Uint8Array(await readFile(result.path)),
    );

    expect(inspected.portableItems).toEqual([item]);
    expect(inspected.annotations.filter(({ id }) => id.startsWith(`${item.id}:projection:`)))
      .toHaveLength(3);
  }, 60_000);

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
      expect(written?.author).toBe("Placekeeper");
    }
  }, 60_000);

  it("round-trips Placekeeper annotations without rewriting untouched metadata", async () => {
    const source = new Uint8Array(
      await readFile(resolve("test/fixtures/pdfs/text-native.pdf")),
    );
    const editedItem: ReviewItem = {
      id: "60000000-0000-4000-8000-000000000006",
      kind: "highlight",
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        quote: "unique equilibrium",
        prefix: "text: ",
        suffix: " clearly",
        rect: { x: 72, y: 92, width: 150, height: 16 },
        segmentRects: [{ x: 72, y: 92, width: 150, height: 16 }],
        reliable: true,
        comment: "Initial edit",
      },
    };
    const untouchedItem: ReviewItem = {
      id: "70000000-0000-4000-8000-000000000007",
      kind: "pageNote",
      pageIndex: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      payload: {
        position: { x: 450, y: 650, width: 18, height: 18 },
        comment: "Untouched note",
      },
    };
    const external: ReviewAnnotation = {
      kind: "highlight",
      id: "external-placekeeper-preview",
      pageIndex: 0,
      rect: { x: 72, y: 140, width: 100, height: 14 },
      quadPoints: [{ x: 72, y: 140, width: 100, height: 14 }],
      contents: "External review",
      author: "Placekeeper Preview",
      createdAt: timestamp,
      modifiedAt: timestamp,
      textAnchorReliable: true,
    };
    const writer = await createSelectedPdfWriter();
    const seeded = await writer.write({
      sourcePdf: source,
      sourceSha256: sha256(source),
      revision: 1,
      annotations: [
        projectReviewItem(editedItem),
        projectReviewItem(untouchedItem),
        external,
      ],
    });
    const edited: ReviewItem = {
      ...editedItem,
      updatedAt: "2026-08-07T12:01:00.000Z",
      payload: { ...editedItem.payload, comment: "Edited after update" },
    };
    const roundTripped = await writer.write({
      sourcePdf: seeded.pdfBytes,
      sourceSha256: sha256(seeded.pdfBytes),
      revision: 2,
      annotations: [projectReviewItem(edited), projectReviewItem(untouchedItem)],
    });
    const inspected = await inspectPdfWithEmbedPdf(roundTripped.pdfBytes);

    expect(inspected.portableItems).toEqual(expect.arrayContaining([edited, untouchedItem]));
    expect(inspected.portableItems).toHaveLength(2);
    expect(inspected.annotations.find(({ id }) => id === edited.id)).toMatchObject({
      author: "Placekeeper",
      hasNormalAppearance: true,
      custom: { placekeeper: { owner: "placekeeper", schemaVersion: 2, itemId: edited.id } },
    });
    expect(inspected.annotations.find(({ id }) => id === untouchedItem.id)).toMatchObject({
      author: "Placekeeper",
      hasNormalAppearance: true,
      custom: { placekeeper: { owner: "placekeeper", schemaVersion: 2, itemId: untouchedItem.id } },
    });
    expect(inspected.annotations.find(({ id }) => id === external.id)).toMatchObject({
      author: "Placekeeper Preview",
      contents: external.contents,
    });
  }, 60_000);

  it("preserves generated links whose PDF dictionary has no persistent annotation ID", async () => {
    const fixture = await deliveryForFixture("hostile-actions.pdf");
    const [firstInspection, secondInspection] = await Promise.all([
      inspectPdfWithEmbedPdf(fixture.source),
      inspectPdfWithEmbedPdf(fixture.source),
    ]);
    expect(firstInspection.annotations).toHaveLength(1);
    expect(secondInspection.annotations).toHaveLength(1);
    expect(firstInspection.annotations[0]?.id).not.toBe(secondInspection.annotations[0]?.id);
    expect(firstInspection.annotations[0]?.preservationFingerprint).toBe(
      secondInspection.annotations[0]?.preservationFingerprint,
    );

    const coordinator = new ExportCoordinator({
      writer: await createSelectedPdfWriter(),
      capabilities: fixture.capabilities,
      backend: { timeoutMs: 20_000 },
    });
    await expect(coordinator.exportReviewedCopy(fixture.delivery)).resolves.toMatchObject({
      kind: "reviewed-copy",
    });
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
