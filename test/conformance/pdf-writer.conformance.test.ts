import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PdfWriteRequest, ReviewAnnotation } from '../../packages/core/src/pdf-writer.js';
import { PdfWriterError } from '../../packages/core/src/pdf-writer.js';
import {
  createEmbedPdfWriter,
  inspectPdfWithEmbedPdf,
} from '../../packages/pdf-backends/src/embedpdf-adapter.js';
import { runPdfBackend } from '../../packages/pdf-backends/src/backend-host.js';

const fixtures = resolve('test/fixtures/pdfs');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const annotations: readonly ReviewAnnotation[] = [
  {
    kind: 'replace',
    id: '11111111-1111-4111-8111-111111111111',
    pageIndex: 0,
    rect: { x: 72, y: 92, width: 150, height: 16 },
    quadPoints: [{ x: 72, y: 92, width: 150, height: 16 }],
    contents: 'locally unique equilibrium',
    author: 'Proofreader',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'delete',
    id: '22222222-2222-4222-8222-222222222222',
    pageIndex: 0,
    rect: { x: 230, y: 92, width: 55, height: 16 },
    quadPoints: [{ x: 230, y: 92, width: 55, height: 16 }],
    contents: '',
    author: 'Proofreader',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'insert',
    id: '33333333-3333-4333-8333-333333333333',
    pageIndex: 0,
    rect: { x: 292, y: 88, width: 14, height: 20 },
    contents: 'however',
    author: 'Proofreader',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'highlight',
    id: '44444444-4444-4444-8444-444444444444',
    pageIndex: 0,
    rect: { x: 72, y: 120, width: 220, height: 34 },
    quadPoints: [
      { x: 72, y: 120, width: 220, height: 16 },
      { x: 72, y: 138, width: 130, height: 16 },
    ],
    contents: 'Check this argument.',
    author: 'Proofreader',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
  {
    kind: 'pageNote',
    id: '55555555-5555-4555-8555-555555555555',
    pageIndex: 0,
    rect: { x: 500, y: 700, width: 24, height: 24 },
    contents: 'Page-level comment.',
    author: 'Proofreader',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
  },
  {
    kind: 'highlight',
    id: '66666666-6666-4666-8666-666666666666',
    pageIndex: 0,
    rect: { x: 320, y: 120, width: 90, height: 16 },
    quadPoints: [{ x: 320, y: 120, width: 90, height: 16 }],
    contents: '',
    author: 'Proofreader',
    createdAt: '2026-08-06T12:00:00.000Z',
    modifiedAt: '2026-08-06T12:00:00.000Z',
    textAnchorReliable: true,
  },
];

async function requestFor(name: string, items = annotations): Promise<PdfWriteRequest> {
  const sourcePdf = new Uint8Array(await readFile(resolve(fixtures, name)));
  return {
    sourcePdf,
    sourceSha256: sha256(sourcePdf),
    revision: 7,
    annotations: items,
  };
}

describe('EmbedPDF writer gate', () => {
  it('writes all five standard mappings, reopens, and preserves the source and existing annotations', async () => {
    const request = await requestFor('text-native-with-annotations.pdf');
    const original = request.sourcePdf.slice();
    const writer = await createEmbedPdfWriter();

    const result = await runPdfBackend(writer, request, {
      timeoutMs: 15_000,
      maxSourceBytes: 2_000_000,
      maxOutputBytes: 4_000_000,
    });

    expect(request.sourcePdf).toEqual(original);
    expect(result.pdfBytes).not.toEqual(original);
    expect(result.evidence.originalSha256).toBe(request.sourceSha256);
    expect(result.evidence.outputSha256).toBe(sha256(result.pdfBytes));
    expect(result.evidence.pageCount).toBe(1);
    expect(result.evidence.structurallyValid).toBe(true);
    expect(result.evidence.preexistingAnnotationIds).toEqual(
      expect.arrayContaining(['existing-highlight', 'existing-stamp']),
    );

    await mkdir(resolve('output/pdf'), { recursive: true });
    await writeFile(resolve('output/pdf/u1-all-annotations-golden.pdf'), result.pdfBytes);

    const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);
    expect(reopened.annotationSubtypes).toEqual(
      expect.arrayContaining(['strikeOut', 'highlight', 'text', 'stamp']),
    );
    const expectedSubtype: Record<ReviewAnnotation['kind'], string> = {
      replace: 'strikeOut',
      delete: 'strikeOut',
      insert: 'text',
      highlight: 'highlight',
      pageNote: 'text',
    };
    for (const annotation of annotations) {
      const written = reopened.annotations.find((candidate) => candidate.id === annotation.id);
      expect(written, annotation.id).toBeDefined();
      expect(written?.subtype).toBe(expectedSubtype[annotation.kind]);
      expect(written?.contents).toBe(annotation.contents);
      expect(written?.author).toBe(annotation.author);
      expect(written?.flags).toContain('print');
      expect(written?.hasNormalAppearance).toBe(true);
    }
  });

  it.each([0, 90, 180, 270])(
    'preserves annotation geometry on a %i-degree cropped page',
    async (rotation) => {
      const request = await requestFor(`rotation-${rotation}-crop.pdf`, [annotations[3]!]);
      const result = await runPdfBackend(await createEmbedPdfWriter(), request);
      const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);
      const written = reopened.annotations.find(({ id }) => id === annotations[3]!.id);

      expect(written?.segmentRects?.[0]).toEqual({
        origin: {
          x: annotations[3]!.quadPoints![0]!.x,
          y: annotations[3]!.quadPoints![0]!.y,
        },
        size: {
          width: annotations[3]!.quadPoints![0]!.width,
          height: annotations[3]!.quadPoints![0]!.height,
        },
      });
      expect(written?.hasNormalAppearance).toBe(true);
    },
  );

  it('round-trips Unicode review content without inventing source text', async () => {
    const contents = '日本語; العربية; ﬁ; soft\u00adhyphen; e\u0301';
    const unicodeAnnotation = { ...annotations[3]!, contents };
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('text-native.pdf', [unicodeAnnotation]),
    );
    const reopened = await inspectPdfWithEmbedPdf(result.pdfBytes);

    expect(reopened.annotations.find(({ id }) => id === unicodeAnnotation.id)?.contents).toBe(
      contents,
    );
  });

  it('preserves hostile-action annotations as inert source objects while adding review data', async () => {
    const result = await runPdfBackend(
      await createEmbedPdfWriter(),
      await requestFor('hostile-actions.pdf', [annotations[4]!]),
    );

    expect(result.evidence.preexistingAnnotationIds).toHaveLength(1);
    expect((await inspectPdfWithEmbedPdf(result.pdfBytes)).annotationSubtypes).toContain('link');
  });

  it('rejects malformed PDFs with a typed failure', async () => {
    await expect(
      runPdfBackend(
        await createEmbedPdfWriter(),
        await requestFor('malformed.pdf', [annotations[4]!]),
      ),
    ).rejects.toMatchObject({ code: 'invalid-pdf' });
  });

  it('rejects unreliable semantic markup without emitting output', async () => {
    const request = await requestFor('image-only.pdf', [
      { ...annotations[0]!, textAnchorReliable: false },
    ]);
    const writer = await createEmbedPdfWriter();

    await expect(runPdfBackend(writer, request)).rejects.toMatchObject({
      code: 'unreliable-text-geometry',
    });
  });

  it.each([
    ['encrypted-no-annotation.pdf', 'encrypted'],
    ['docmdp-no-annotation.pdf', 'signature-restricted'],
  ] as const)('fails closed for %s', async (name, code) => {
    const writer = await createEmbedPdfWriter();
    await expect(runPdfBackend(writer, await requestFor(name))).rejects.toMatchObject({ code });
  });

  it('enforces digest, resource, cancellation, and timeout boundaries with typed errors', async () => {
    const writer = await createEmbedPdfWriter();
    const mismatched = await requestFor('text-native.pdf');
    mismatched.sourceSha256 = '0'.repeat(64);
    await expect(runPdfBackend(writer, mismatched)).rejects.toMatchObject({
      code: 'source-digest-mismatch',
    });

    const oversized = await requestFor('text-native.pdf');
    await expect(runPdfBackend(writer, oversized, { maxSourceBytes: 1 })).rejects.toMatchObject({
      code: 'resource-limit',
    });

    await expect(
      runPdfBackend(writer, await requestFor('text-native.pdf'), { maxOutputBytes: 1 }),
    ).rejects.toMatchObject({ code: 'resource-limit' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      runPdfBackend(writer, await requestFor('text-native.pdf'), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });

    const neverWriter = { write: () => new Promise<never>(() => undefined) };
    await expect(
      runPdfBackend(neverWriter, await requestFor('text-native.pdf'), { timeoutMs: 10 }),
    ).rejects.toEqual(expect.any(PdfWriterError));
    await expect(
      runPdfBackend(neverWriter, await requestFor('text-native.pdf'), { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
