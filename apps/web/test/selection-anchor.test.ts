import { describe, expect, it } from 'vitest';
import { Rotation, transformRect } from '@embedpdf/models';

import {
  createCaretAnchor,
  createSelectionAnchor,
  type AnchorPage,
} from '../src/pdf/selection-anchor.js';
import { captureViewerSelection } from '../src/pdf/viewer-selection-adapter.js';
import { buildViewerDocumentOptions } from '../src/pdf/embedpdf-viewer.js';

const naturalRect = {
  origin: { x: 24, y: 36 },
  size: { width: 120, height: 18 },
};

const page = (rotation: Rotation): AnchorPage => ({
  pageIndex: 2,
  size: { width: 540, height: 720 },
  cropBox: { left: 36, top: 48, right: 576, bottom: 768 },
  rotation,
  extractedText: 'before <unique equilibrium> after',
  textRects: [{ content: '<unique equilibrium>', rect: naturalRect }],
});

describe('selection anchors', () => {
  it.each([Rotation.Degree0, Rotation.Degree90, Rotation.Degree180, Rotation.Degree270])(
    'normalizes rotation %s exactly once and includes a nonzero CropBox origin',
    (rotation) => {
      const rotated = transformRect(page(rotation).size, naturalRect, rotation, 1);
      const result = createSelectionAnchor({
        page: page(rotation),
        quote: '<unique equilibrium>',
        glyphCount: 20,
        formattedSelections: [
          { pageIndex: 2, segmentRects: [rotated], coordinateRotation: rotation },
        ],
        contextCharacters: 7,
      });

      expect(result).toEqual({
        ok: true,
        anchor: {
          pageIndex: 2,
          quote: '<unique equilibrium>',
          prefix: 'before ',
          suffix: ' after',
          rect: { x: 60, y: 84, width: 120, height: 18 },
          segmentRects: [{ x: 60, y: 84, width: 120, height: 18 }],
          reliable: true,
        },
      });
    },
  );

  it('preserves exact whitespace and HTML-like quote/context without normalization', () => {
    const exactPage: AnchorPage = {
      ...page(Rotation.Degree0),
      extractedText: 'A\t<script>alert(1)</script>\nB',
      textRects: [{ content: '<script>alert(1)</script>', rect: naturalRect }],
    };
    const result = createSelectionAnchor({
      page: exactPage,
      quote: '<script>alert(1)</script>',
      glyphCount: 25,
      formattedSelections: [
        { pageIndex: 2, segmentRects: [naturalRect], coordinateRotation: Rotation.Degree0 },
      ],
      contextCharacters: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      anchor: {
        quote: '<script>alert(1)</script>',
        prefix: 'A\t',
        suffix: '\nB',
      },
    });
  });

  it('fails visibly instead of fabricating a cross-page or repeated quote anchor', () => {
    expect(
      createSelectionAnchor({
        page: page(Rotation.Degree0),
        quote: '<unique equilibrium>',
        glyphCount: 20,
        formattedSelections: [
          { pageIndex: 2, segmentRects: [naturalRect], coordinateRotation: Rotation.Degree0 },
          { pageIndex: 3, segmentRects: [naturalRect], coordinateRotation: Rotation.Degree0 },
        ],
      }),
    ).toMatchObject({ ok: false, diagnostic: 'selection-crosses-pages' });

    expect(
      createSelectionAnchor({
        page: { ...page(Rotation.Degree0), extractedText: 'same same' },
        quote: 'same',
        glyphCount: 4,
        formattedSelections: [
          { pageIndex: 2, segmentRects: [naturalRect], coordinateRotation: Rotation.Degree0 },
        ],
      }),
    ).toMatchObject({ ok: false, diagnostic: 'selection-quote-not-unique' });
  });

  it('uses the engine offset to disambiguate repeated exact text', () => {
    const repeatedPage = {
      ...page(Rotation.Degree0),
      extractedText: 'same then same',
      textRects: [{ content: 'same', rect: naturalRect }],
    };
    expect(
      createSelectionAnchor({
        page: repeatedPage,
        quote: 'same',
        quoteStart: 10,
        glyphCount: 4,
        formattedSelections: [
          {
            pageIndex: 2,
            segmentRects: [naturalRect],
            coordinateRotation: Rotation.Degree0,
          },
        ],
      }),
    ).toMatchObject({ ok: true, anchor: { prefix: 'same then ', quote: 'same' } });
  });

  it('removes viewer zoom exactly once and rejects off-page segment geometry', () => {
    const zoom = 2.5;
    const scaled = {
      origin: { x: naturalRect.origin.x * zoom, y: naturalRect.origin.y * zoom },
      size: { width: naturalRect.size.width * zoom, height: naturalRect.size.height * zoom },
    };
    expect(
      createSelectionAnchor({
        page: page(Rotation.Degree0),
        quote: '<unique equilibrium>',
        glyphCount: 20,
        formattedSelections: [
          {
            pageIndex: 2,
            segmentRects: [scaled],
            coordinateRotation: Rotation.Degree0,
            coordinateScale: zoom,
          },
        ],
      }),
    ).toMatchObject({ ok: true, anchor: { segmentRects: [{ x: 60, y: 84 }] } });

    expect(
      createSelectionAnchor({
        page: page(Rotation.Degree0),
        quote: '<unique equilibrium>',
        glyphCount: 20,
        formattedSelections: [
          {
            pageIndex: 2,
            segmentRects: [{ ...naturalRect, origin: { x: 500, y: 710 } }],
            coordinateRotation: Rotation.Degree0,
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });

  it('creates a caret with left/right context and no fabricated quote', () => {
    expect(
      createCaretAnchor({
        page: page(Rotation.Degree0),
        textOffset: 7,
        position: { origin: { x: 20, y: 20 }, size: { width: 2, height: 14 } },
        contextCharacters: 7,
      }),
    ).toEqual({
      ok: true,
      anchor: {
        pageIndex: 2,
        position: { x: 56, y: 68, width: 2, height: 14 },
        leftContext: 'before ',
        rightContext: '<unique',
        reliable: true,
      },
    });
  });

  it('captures the public viewer selection seam without applying presentation rotation', async () => {
    const anchorPage = page(Rotation.Degree90);
    const result = await captureViewerSelection({
      documentId: 'doc-1',
      selection: {
        getFormattedSelection: () => [
          { pageIndex: 2, rect: naturalRect, segmentRects: [naturalRect] },
        ],
        getSelectedText: () => ({
          toPromise: async () => ['<unique equilibrium>'],
        }),
        getState: () => ({
          geometry: {},
          rects: {},
          selection: { start: { page: 2, index: 7 }, end: { page: 2, index: 26 } },
          slices: { 2: { start: 7, count: 20 } },
          active: true,
          selecting: false,
        }),
      },
      pages: { read: async () => anchorPage },
      contextCharacters: 7,
    });

    expect(result).toMatchObject({
      ok: true,
      anchor: {
        quote: '<unique equilibrium>',
        prefix: 'before ',
        suffix: ' after',
        segmentRects: [{ x: 60, y: 84 }],
      },
    });
  });

  it('passes the memory-only session credential through public document request headers', () => {
    const headers = { Authorization: 'Bearer in-memory-only' };
    expect(
      buildViewerDocumentOptions(
        {
          pdfiumWasm: '/pdfium.wasm',
          documentUrl: '/document/file-1',
          requestHeaders: headers,
        },
        'http://127.0.0.1:4173',
      ),
    ).toMatchObject({
      url: 'http://127.0.0.1:4173/document/file-1',
      requestOptions: { credentials: 'omit', headers },
    });
  });
});
