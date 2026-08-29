import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import {
  normalizePdfMetadataTitle,
  pdfDocumentTitleForSource,
  resolvePdfMetadataTitle,
} from '../src/pdf/pdf-document-title.js';

const document = { id: 'document' } as PdfDocumentObject;

function engineWithTitle(title: string | null): PdfEngine {
  return {
    getMetadata: vi.fn(() => ({
      toPromise: async () => ({ title }),
    })),
  } as unknown as PdfEngine;
}

describe('PDF document title', () => {
  it('uses a normalized nonblank PDF metadata title', async () => {
    expect(normalizePdfMetadataTitle('  Identification\n  Strategy  '))
      .toBe('Identification Strategy');
    await expect(resolvePdfMetadataTitle(
      engineWithTitle('  Identification\n  Strategy  '),
      document,
    )).resolves.toBe('Identification Strategy');
  });

  it.each([null, '', ' \n\t '])('returns no metadata title for %j metadata', async (title) => {
    await expect(resolvePdfMetadataTitle(
      engineWithTitle(title),
      document,
    )).resolves.toBeUndefined();
  });

  it('returns no metadata title when metadata cannot be read', async () => {
    const engine = {
      getMetadata: vi.fn(() => ({
        toPromise: async () => { throw new Error('metadata unavailable'); },
      })),
    } as unknown as PdfEngine;

    await expect(resolvePdfMetadataTitle(engine, document)).resolves.toBeUndefined();
  });

  it('keeps metadata authoritative while the filename fallback changes', () => {
    const metadata = { sourceIdentity: 'source-a', title: 'Identification Strategy' };

    expect(pdfDocumentTitleForSource(metadata, 'source-a', 'original.pdf'))
      .toBe('Identification Strategy');
    expect(pdfDocumentTitleForSource(metadata, 'source-a', 'renamed.pdf'))
      .toBe('Identification Strategy');
  });

  it('ignores metadata resolved for a replaced source', () => {
    const staleMetadata = { sourceIdentity: 'source-a', title: 'Old title' };

    expect(pdfDocumentTitleForSource(staleMetadata, 'source-b', 'replacement.pdf'))
      .toBe('replacement.pdf');
  });
});
