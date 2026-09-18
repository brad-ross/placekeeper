import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';

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
import { inspectPdfWithEmbedPdf, readEditableReviewItems } from "../../packages/pdf-backends/src/embedpdf-adapter.js";
import { ExportCoordinator } from "../../apps/service/src/export/export-coordinator.js";
import { verifyReviewedPdf } from "../../apps/service/src/export/pdf-verifier.js";
import { FileCapabilityRegistry } from "../../apps/service/src/files/file-capabilities.js";

const temporaryDirectories: string[] = [];
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

const timestamp = "2026-08-07T10:00:00.000Z";
const editedAt = "2026-08-07T10:05:00.000Z";
const outputAt = "2026-08-07T10:20:00.000Z";
const annotationName = "Brad Ross — café";

async function serializedAnnotations(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().flatMap((page, pageIndex) => {
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    return Array.from({ length: annotations?.size() ?? 0 }, (_, index) => {
      const dictionary = annotations!.lookup(index, PDFDict);
      const field = (key: string) => {
        const value = dictionary.lookup(PDFName.of(key));
        return value instanceof PDFString || value instanceof PDFHexString ? value : undefined;
      };
      return { pageIndex, dictionary, id: field('NM')?.decodeText(),
        author: field('T')?.decodeText(),
        createdAt: field('CreationDate')?.decodeDate().toISOString(),
        modifiedAt: field('M')?.decodeDate().toISOString() };
    });
  });
}

describe('standard annotation round trips', () => {
  it('keeps absent native appearances absent and verifies the final saved bytes', async () => {
    const pdf = await PDFDocument.load(await readFile(resolve('test/fixtures/pdfs/text-native.pdf')));
    pdf.getPage(0).node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
      Type: 'Annot', Subtype: 'Highlight', Rect: [72, 680, 200, 698],
      QuadPoints: [72, 698, 200, 698, 72, 680, 200, 680],
      Contents: PDFString.of('Native comment without a saved appearance'),
    }))]));
    const sourcePdf = await pdf.save();
    const requests = (await readEditableReviewItems(sourcePdf)).map((item) => projectReviewItem(item));
    const written = await (await createSelectedPdfWriter()).write({ sourcePdf, sourceSha256: sha256(sourcePdf),
      revision: 1, annotations: requests, manageNativeAnnotations: true });
    const saved = (await PDFDocument.load(written.pdfBytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect(saved.has(PDFName.of('AP'))).toBe(false);
    expect(written.evidence.outputSha256).toBe(sha256(written.pdfBytes));
    expect(written.inspection).toBeUndefined();
    await expect(verifyReviewedPdf({ sourcePdf, candidatePdf: written.pdfBytes, evidence: written.evidence,
      annotations: requests, manageNativeAnnotations: true })).resolves.toMatchObject({ pageCount: 1 });
  });

  it('retains PDF comment and deletion locks on imported annotations', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const note = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text',
      Rect: [100, 600, 120, 620], Contents: PDFString.of('Locked comment'), F: 64 }));
    page.node.set(PDFName.of('Annots'), pdf.context.obj([note]));
    const sourcePdf = await pdf.save();
    const [item] = await readEditableReviewItems(sourcePdf);
    expect(item).toMatchObject({ kind: 'pdfAnnotation', payload: { contentsLocked: true, deletionLocked: true } });
    const writer = await createSelectedPdfWriter();
    const request = { sourcePdf, sourceSha256: sha256(sourcePdf), revision: 1, manageNativeAnnotations: true };
    await expect(writer.write({ ...request, annotations: [projectReviewItem({ ...item!,
      payload: { ...item!.payload, comment: 'Changed' } })] })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(writer.write({ ...request, annotations: [] })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('uses externally edited PDF fields even when Placekeeper metadata is stale', async () => {
    const source = new Uint8Array(await readFile(resolve('test/fixtures/pdfs/text-native.pdf')));
    const item: ReviewItem = {
      id: '966775d4-6c98-4f75-a17e-e9206e9d79dd', kind: 'pageNote', pageIndex: 0,
      createdAt: timestamp, updatedAt: timestamp,
      payload: { position: { x: 100, y: 100, width: 20, height: 20 }, comment: 'Original note' },
    };
    const writer = await createSelectedPdfWriter();
    const original = await writer.write({ sourcePdf: source, sourceSha256: sha256(source), revision: 0, annotations: [projectReviewItem(item)] });
    const external = await PDFDocument.load(original.pdfBytes);
    const mark = external.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    mark.set(PDFName.of('Contents'), PDFHexString.fromText('Edited in another PDF app'));
    mark.set(PDFName.of('T'), PDFString.of('External reviewer'));
    const externalBytes = await external.save();
    const imported = await readEditableReviewItems(externalBytes);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ kind: 'pdfAnnotation', payload: { comment: 'Edited in another PDF app', author: 'External reviewer' } });
    const annotations = imported.map((item) => projectReviewItem({ ...item, payload: { ...item.payload, comment: 'Back in Placekeeper' } }));
    const saved = await writer.write({ sourcePdf: externalBytes, sourceSha256: sha256(externalBytes), revision: 1, annotations, manageNativeAnnotations: true });
    await expect(verifyReviewedPdf({ sourcePdf: externalBytes, candidatePdf: saved.pdfBytes, evidence: saved.evidence,
      annotations, manageNativeAnnotations: true })).resolves.toMatchObject({ pageCount: 1 });
    expect((await readEditableReviewItems(saved.pdfBytes))[0]?.payload.comment).toBe('Back in Placekeeper');
  });

  it('deletes an imported note and its auxiliary popup while preserving its replies', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const parent = pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [100, 600, 120, 620], Contents: PDFString.of('Parent') });
    const parentRef = pdf.context.register(parent);
    const popupRef = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [120, 500, 320, 620], Parent: parentRef }));
    const replyRef = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [130, 600, 150, 620], Contents: PDFString.of('Reply'), IRT: parentRef, RT: 'R' }));
    parent.set(PDFName.of('Popup'), popupRef);
    page.node.set(PDFName.of('Annots'), pdf.context.obj([parentRef, popupRef, replyRef]));
    const sourcePdf = await pdf.save();
    const imported = await readEditableReviewItems(sourcePdf);
    expect(imported).toHaveLength(2);
    const annotations = imported.filter(({ payload }) => payload.comment === 'Reply').map((item) => projectReviewItem(item));
    const written = await (await createSelectedPdfWriter()).write({ sourcePdf, sourceSha256: sha256(sourcePdf), revision: 1, annotations, manageNativeAnnotations: true });
    await expect(verifyReviewedPdf({ sourcePdf, candidatePdf: written.pdfBytes, evidence: written.evidence,
      annotations, manageNativeAnnotations: true })).resolves.toMatchObject({ pageCount: 1 });
    const reopened = await PDFDocument.load(written.pdfBytes);
    const surviving = reopened.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(surviving.size()).toBe(1);
    expect(surviving.lookup(0, PDFDict).has(PDFName.of('IRT'))).toBe(false);
  });

  it('edits and deletes imported comments without duplicating the original marks', async () => {
    const sourcePdf = new Uint8Array(await readFile(resolve('test/fixtures/pdfs/text-native-with-annotations.pdf')));
    const imported = await readEditableReviewItems(sourcePdf);
    expect(imported.map(({ kind }) => kind)).toEqual(['pdfAnnotation', 'pdfAnnotation']);
    const edited = imported.map((item, index) => index === 0
      ? { ...item, updatedAt: timestamp, payload: { ...item.payload, comment: 'Reviewed in Placekeeper — café' } }
      : item);
    const requests = edited.map((item) => projectReviewItem(item));
    const writer = await createSelectedPdfWriter();
    const written = await writer.write({ sourcePdf, sourceSha256: sha256(sourcePdf), revision: 1,
      annotations: requests, manageNativeAnnotations: true });
    await expect(verifyReviewedPdf({ sourcePdf, candidatePdf: written.pdfBytes, evidence: written.evidence,
      annotations: requests, manageNativeAnnotations: true })).resolves.toMatchObject({ pageCount: 1 });
    const reopened = await readEditableReviewItems(written.pdfBytes);
    expect(reopened.map(({ id, payload }) => ({ id, payload: { ...payload, identityProvenance: undefined } })))
      .toEqual(edited.map(({ id, payload }) => ({ id, payload: { ...payload, identityProvenance: undefined } })));
    expect(reopened.map(({ payload }) => payload.identityProvenance)).toEqual(['verified', 'verified']);
    const remaining = reopened.slice(1).map((item) => projectReviewItem(item));
    const deleted = await writer.write({ sourcePdf: written.pdfBytes, sourceSha256: sha256(written.pdfBytes),
      revision: 2, annotations: remaining, manageNativeAnnotations: true });
    await expect(verifyReviewedPdf({ sourcePdf: written.pdfBytes, candidatePdf: deleted.pdfBytes, evidence: deleted.evidence,
      annotations: remaining, manageNativeAnnotations: true })).resolves.toMatchObject({ pageCount: 1 });
    expect((await readEditableReviewItems(deleted.pdfBytes)).map(({ id }) => id)).toEqual([reopened[1]!.id]);
  });

  it('does not treat duplicated legacy Placekeeper names as native identity', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const legacyName = 'placekeeper-native:5e14134c-6d1b-4bbd-8000-000000000000';
    page.node.set(PDFName.of('Annots'), pdf.context.obj([
      pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text',
        Rect: [100, 600, 120, 620], Contents: PDFString.of('First'), NM: PDFString.of(legacyName) })),
      pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text',
        Rect: [200, 600, 220, 620], Contents: PDFString.of('Second'), NM: PDFString.of(legacyName) })),
    ]));
    const sourcePdf = await pdf.save();
    const imported = await readEditableReviewItems(sourcePdf);
    expect(imported).toHaveLength(2);
    expect(new Set(imported.map(({ id }) => id)).size).toBe(2);
    expect(imported.map(({ payload }) => payload.identityProvenance))
      .toEqual(['generation-ordinal', 'generation-ordinal']);

    const writer = await createSelectedPdfWriter();
    const promoted = await writer.write({ sourcePdf, sourceSha256: sha256(sourcePdf), revision: 1,
      annotations: imported.map((item) => projectReviewItem(item)), manageNativeAnnotations: true });
    const reopened = await readEditableReviewItems(promoted.pdfBytes);
    expect(reopened.map(({ id }) => id)).toEqual(imported.map(({ id }) => id));
    expect(reopened.map(({ payload }) => payload.identityProvenance)).toEqual(['verified', 'verified']);

    const retained = reopened.slice(1).map((item) => projectReviewItem({
      ...item,
      payload: { ...item.payload, comment: 'Second edited' },
    }));
    const deleted = await writer.write({ sourcePdf: promoted.pdfBytes,
      sourceSha256: sha256(promoted.pdfBytes), revision: 2,
      annotations: retained, manageNativeAnnotations: true });
    const finalItems = await readEditableReviewItems(deleted.pdfBytes);
    expect(finalItems).toHaveLength(1);
    expect(finalItems[0]).toMatchObject({ id: reopened[1]!.id, payload: { comment: 'Second edited' } });
  }, 60_000);

  it('allocates different verified IDs when independent PDFs promote the same unnamed ordinal', async () => {
    const source = async (custom?: string) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([612, 792]);
      page.node.set(PDFName.of('Annots'), pdf.context.obj([
        pdf.context.register(pdf.context.obj({
          Type: 'Annot', Subtype: 'Text', Rect: [100, 600, 120, 620],
          Contents: PDFString.of('Independent mark'),
          ...(custom === undefined ? {} : { EPDFCustom: PDFHexString.fromText(custom) }),
        })),
      ]));
      return pdf.save();
    };
    const firstSource = await source('{malformed bespoke metadata');
    const secondSource = await source();
    const firstImported = await readEditableReviewItems(firstSource);
    const secondImported = await readEditableReviewItems(secondSource);
    expect(firstImported[0]!.id).not.toBe(secondImported[0]!.id);
    const writer = await createSelectedPdfWriter();
    const promote = (bytes: Uint8Array, item: ReviewItem) => writer.write({
      sourcePdf: bytes,
      sourceSha256: sha256(bytes),
      revision: 1,
      annotations: [projectReviewItem(item)],
      manageNativeAnnotations: true,
    });
    const [firstSaved, secondSaved] = await Promise.all([
      promote(firstSource, firstImported[0]!),
      promote(secondSource, secondImported[0]!),
    ]);
    const [firstVerified, secondVerified] = await Promise.all([
      readEditableReviewItems(firstSaved.pdfBytes),
      readEditableReviewItems(secondSaved.pdfBytes),
    ]);
    expect(firstVerified[0]).toMatchObject({
      id: firstImported[0]!.id,
      payload: { identityProvenance: 'verified' },
    });
    expect(secondVerified[0]).toMatchObject({
      id: secondImported[0]!.id,
      payload: { identityProvenance: 'verified' },
    });
    expect(firstVerified[0]!.id).not.toBe(secondVerified[0]!.id);
    const firstPdf = await PDFDocument.load(firstSaved.pdfBytes);
    const firstDictionary = firstPdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
    expect((firstDictionary.lookup(PDFName.of('EPDFCustom')) as PDFHexString).decodeText())
      .toBe('{malformed bespoke metadata');
  }, 60_000);
});
const annotations: readonly ReviewAnnotation[] = [
  {
    kind: "replace",
    id: "10000000-0000-4000-8000-000000000001",
    pageIndex: 0,
    rect: { x: 72, y: 92, width: 130, height: 14 },
    quadPoints: [{ x: 72, y: 92, width: 130, height: 14 }],
    contents: "locally unique equilibrium",
    author: annotationName,
    createdAt: timestamp,
    modifiedAt: editedAt,
    textAnchorReliable: true,
  },
  {
    kind: "delete",
    id: "20000000-0000-4000-8000-000000000002",
    pageIndex: 0,
    rect: { x: 210, y: 92, width: 45, height: 14 },
    quadPoints: [{ x: 210, y: 92, width: 45, height: 14 }],
    contents: "",
    author: annotationName,
    createdAt: timestamp,
    modifiedAt: editedAt,
    textAnchorReliable: true,
  },
  {
    kind: "insert",
    id: "30000000-0000-4000-8000-000000000003",
    pageIndex: 0,
    rect: { x: 265, y: 88, width: 14, height: 20 },
    contents: "however",
    author: annotationName,
    createdAt: timestamp,
    modifiedAt: editedAt,
    textAnchorReliable: true,
  },
  {
    kind: "highlight",
    id: "40000000-0000-4000-8000-000000000004",
    pageIndex: 0,
    rect: { x: 72, y: 120, width: 180, height: 16 },
    quadPoints: [{ x: 72, y: 120, width: 180, height: 16 }],
    contents: "Check this argument.",
    author: annotationName,
    createdAt: timestamp,
    modifiedAt: editedAt,
    textAnchorReliable: true,
  },
  {
    kind: "pageNote",
    id: "50000000-0000-4000-8000-000000000005",
    pageIndex: 0,
    rect: { x: 500, y: 700, width: 24, height: 24 },
    contents: "Page-level comment.",
    author: annotationName,
    createdAt: timestamp,
    modifiedAt: editedAt,
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
  it("rejects browser-owned-output evidence on the service verification path", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n%%EOF");
    const evidence: PdfStructuralEvidence = {
      coverage: "owned-output",
      backend: "embedpdf",
      backendVersion: "2.14.4",
      originalSha256: sha256(bytes),
      outputSha256: sha256(bytes),
      pageCount: 1,
      structurallyValid: true,
      annotations: [],
    };

    await expect(verifyReviewedPdf({
      sourcePdf: bytes,
      candidatePdf: bytes,
      evidence,
      annotations: [],
    })).rejects.toThrow(/requires exhaustive preservation evidence/i);
  });

  it("exports and verifies one complete cross-page portable group", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(outputAt));
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
      updatedAt: editedAt,
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
    const projections = projectReviewItemProjections(item, annotationName);
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

    expect(inspected.portableItems).toEqual([{ ...item, importedAnnotationAuthor: annotationName }]);
    const serialized = await serializedAnnotations(new Uint8Array(await readFile(result.path)));
    for (const projection of projections) {
      expect(serialized.find(({ id }) => id === projection.id)).toMatchObject({
        pageIndex: projection.pageIndex, author: annotationName, createdAt: timestamp, modifiedAt: editedAt,
      });
    }
    expect(inspected.annotations.filter(({ id }) => id.startsWith(`${item.id}:projection:`)))
      .toHaveLength(3);
    const writer = await createSelectedPdfWriter();
    let bytes: Uint8Array = new Uint8Array(await readFile(result.path));
    for (const name of ["Renamed reviewer", "Renamed reviewer"]) {
      const [reopened] = await readEditableReviewItems(bytes);
      expect(reopened).toBeDefined();
      const renamed = projectReviewItemProjections(reopened!, name);
      const saved = await writer.write({
        sourcePdf: bytes, sourceSha256: sha256(bytes), revision: 6, annotations: renamed,
      });
      bytes = saved.pdfBytes;
      expect(await readEditableReviewItems(bytes)).toEqual([{ ...item, importedAnnotationAuthor: name }]);
      const savedAnnotations = await serializedAnnotations(bytes);
      for (const projection of renamed) {
        expect(savedAnnotations.find(({ id }) => id === projection.id)).toMatchObject({
          pageIndex: projection.pageIndex, author: name, createdAt: timestamp, modifiedAt: editedAt,
        });
      }
      expect((await inspectPdfWithEmbedPdf(bytes)).annotations
        .filter(({ id }) => id.startsWith(`${item.id}:projection:`))
        .every(({ hasNormalAppearance }) => hasNormalAppearance)).toBe(true);
    }
  }, 60_000);

  it("exports every v1 type and preserves supported and unsupported source annotations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(outputAt));
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
    const serialized = await serializedAnnotations(new Uint8Array(await readFile(result.path)));
    for (const annotation of annotations) {
      const written = inspected.annotations.find(({ id }) => id === annotation.id);
      expect(written?.contents).toBe(annotation.contents);
      expect(written?.pageIndex).toBe(annotation.pageIndex);
      expect(written?.flags).toContain("print");
      expect(written?.hasNormalAppearance).toBe(true);
      expect(written?.author).toBe(annotationName);
      expect(serialized.find(({ id }) => id === annotation.id)).toMatchObject({
          author: annotationName, createdAt: timestamp, modifiedAt: editedAt,
        });
    }
  }, 60_000);

  it("round-trips Placekeeper annotations without rewriting untouched metadata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(outputAt));
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
      updatedAt: editedAt,
      payload: { ...editedItem.payload, comment: "Edited after update" },
    };
    const roundTripped = await writer.write({
      sourcePdf: seeded.pdfBytes,
      sourceSha256: sha256(seeded.pdfBytes),
      revision: 2,
      annotations: [projectReviewItem(edited, annotationName), projectReviewItem(untouchedItem, annotationName)],
    });
    const inspected = await inspectPdfWithEmbedPdf(roundTripped.pdfBytes);

    expect(inspected.portableItems).toEqual(expect.arrayContaining(
      [edited, untouchedItem].map((item) => ({ ...item, importedAnnotationAuthor: annotationName })),
    ));
    expect(inspected.portableItems).toHaveLength(2);
    expect(inspected.annotations.find(({ id }) => id === edited.id)).toMatchObject({
      author: annotationName,
      hasNormalAppearance: true,
      custom: { placekeeper: { owner: "placekeeper", schemaVersion: 2, itemId: edited.id } },
    });
    expect(inspected.annotations.find(({ id }) => id === untouchedItem.id)).toMatchObject({
      author: annotationName,
      hasNormalAppearance: true,
      custom: { placekeeper: { owner: "placekeeper", schemaVersion: 2, itemId: untouchedItem.id } },
    });
    expect(inspected.annotations.find(({ id }) => id === external.id)).toMatchObject({
      author: "Placekeeper Preview",
      contents: external.contents,
    });
    let importedNativeDictionary: string | undefined;
    let current = roundTripped;
    for (const name of [annotationName, "Renamed reviewer", "Renamed reviewer"]) {
      const reopened = await readEditableReviewItems(current.pdfBytes);
      const owned = reopened.filter(({ kind }) => kind !== 'pdfAnnotation');
      const native = reopened.filter(({ kind }) => kind === 'pdfAnnotation');
      expect(owned.map(({ id }) => id).sort()).toEqual([edited.id, untouchedItem.id].sort());
      expect(native).toHaveLength(1);
      current = await writer.write({
        sourcePdf: current.pdfBytes, sourceSha256: sha256(current.pdfBytes), revision: 3,
        annotations: [...owned, ...native].map((item) => projectReviewItem(item, name)),
        manageNativeAnnotations: true,
      });
      const serialized = await serializedAnnotations(current.pdfBytes);
      for (const item of [edited, untouchedItem]) {
        expect(serialized.find(({ id }) => id === item.id)).toMatchObject({
          author: name, createdAt: item.createdAt, modifiedAt: item.updatedAt,
        });
      }
      const nativeDictionary = serialized.find(({ author }) => author === external.author)!;
      expect(nativeDictionary.author).toBe(external.author);
      expect(nativeDictionary).toMatchObject({
        createdAt: external.createdAt, modifiedAt: external.modifiedAt,
      });
      // First managed import assigns the native annotation its stable /NM.
      // Subsequent name changes and repeat outputs preserve the whole dictionary.
      if (importedNativeDictionary !== undefined) {
        expect(nativeDictionary.dictionary.toString()).toBe(importedNativeDictionary);
      }
      importedNativeDictionary = nativeDictionary.dictionary.toString();
      const editable = await readEditableReviewItems(current.pdfBytes);
      expect(editable.filter(({ kind }) => kind !== 'pdfAnnotation')).toEqual(
        expect.arrayContaining([edited, untouchedItem].map((item) => ({
          ...item, importedAnnotationAuthor: name,
        }))),
      );
    }
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
