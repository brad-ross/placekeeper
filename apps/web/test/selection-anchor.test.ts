import { describe, expect, it } from 'vitest';
import { Rotation, transformPosition, transformRect } from '@embedpdf/models';

import {
  createCaretAnchor,
  createCaretAnchorAtPoint,
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
  rotation,
  extractedText: 'before <unique equilibrium> after',
  textRects: [{ content: '<unique equilibrium>', rect: naturalRect }],
});

describe('selection anchors', () => {
  it.each([Rotation.Degree0, Rotation.Degree90, Rotation.Degree180, Rotation.Degree270])(
    'normalizes rotation %s exactly once in crop-relative page space',
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
          rect: { x: 24, y: 36, width: 120, height: 18 },
          segmentRects: [{ x: 24, y: 36, width: 120, height: 18 }],
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
    ).toMatchObject({ ok: true, anchor: { segmentRects: [{ x: 24, y: 36 }] } });

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
        position: { x: 20, y: 20, width: 2, height: 14 },
        leftContext: 'before ',
        rightContext: '<unique',
        reliable: true,
      },
    });
  });

  it.each([Rotation.Degree0, Rotation.Degree90, Rotation.Degree180, Rotation.Degree270])(
    'hit-tests an atomic text rect after normalizing rotation %s and zoom',
    (rotation) => {
      const hitPage: AnchorPage = {
        ...page(rotation),
        extractedText: 'ab',
        textRects: [
          { content: 'a', rect: { origin: { x: 20, y: 30 }, size: { width: 8, height: 12 } } },
          { content: 'b', rect: { origin: { x: 28, y: 30 }, size: { width: 8, height: 12 } } },
        ],
      };
      const transformedPoint = transformPosition(hitPage.size, { x: 34, y: 36 }, rotation, 2);
      const result = createCaretAnchorAtPoint({
        page: hitPage,
        point: transformedPoint,
        coordinateRotation: rotation,
        coordinateScale: 2,
      });

      expect(result).toMatchObject({
        ok: true,
        anchor: { leftContext: 'ab', rightContext: '', reliable: true },
      });
    },
  );

  it('uses only exact edges for multi-character rects', () => {
    const hitPage = {
      ...page(Rotation.Degree0),
      extractedText: 'word',
      textRects: [{ content: 'word', rect: { origin: { x: 20, y: 30 }, size: { width: 40, height: 12 } } }],
    };

    expect(createCaretAnchorAtPoint({ page: hitPage, point: { x: 20, y: 36 } }))
      .toMatchObject({ ok: true, anchor: { leftContext: '', rightContext: 'word' } });
    expect(createCaretAnchorAtPoint({ page: hitPage, point: { x: 60, y: 36 } }))
      .toMatchObject({ ok: true, anchor: { leftContext: 'word', rightContext: '' } });
    expect(createCaretAnchorAtPoint({ page: hitPage, point: { x: 40, y: 36 } }))
      .toMatchObject({ ok: false, diagnostic: 'caret-point-inside-multichar-rect' });
  });

  it('aligns PDFium text rectangles with trailing control markers', () => {
    const hitPage = {
      ...page(Rotation.Degree0),
      extractedText: 'first line\r\nsecond line',
      textRects: [
        {
          content: 'first line\u0004',
          rect: { origin: { x: 20, y: 30 }, size: { width: 60, height: 12 } },
        },
        {
          content: 'second line\u0088',
          rect: { origin: { x: 20, y: 50 }, size: { width: 66, height: 12 } },
        },
      ],
    };

    expect(createCaretAnchorAtPoint({ page: hitPage, point: { x: 86, y: 56 } }))
      .toMatchObject({
        ok: true,
        anchor: {
          leftContext: 'first line\r\nsecond line',
          rightContext: '',
          reliable: true,
        },
      });
  });

  it('preserves an exact trailing-control match before using the PDFium fallback', () => {
    const hitPage = {
      ...page(Rotation.Degree0),
      extractedText: 'same same\u0004',
      textRects: [{
        content: 'same\u0004',
        rect: { origin: { x: 20, y: 30 }, size: { width: 40, height: 12 } },
      }],
    };

    expect(createCaretAnchorAtPoint({ page: hitPage, point: { x: 20, y: 36 } }))
      .toMatchObject({
        ok: true,
        anchor: {
          leftContext: 'same ',
          rightContext: 'same\u0004',
          reliable: true,
        },
      });
  });

  it.each([
    ['ambiguous alignment', {
      extractedText: 'same same',
      textRects: [{ content: 'same', rect: naturalRect }],
      point: { x: naturalRect.origin.x, y: naturalRect.origin.y + 4 },
      diagnostic: 'caret-text-rect-alignment-nonunique',
    }],
    ['overlapping mapped rects', {
      extractedText: 'ab',
      textRects: [
        { content: 'a', rect: naturalRect },
        { content: 'b', rect: naturalRect },
      ],
      point: { x: naturalRect.origin.x, y: naturalRect.origin.y + 4 },
      diagnostic: 'caret-text-rects-overlap',
    }],
    ['out of tolerance', {
      extractedText: 'a',
      textRects: [{ content: 'a', rect: naturalRect }],
      point: { x: 400, y: 400 },
      diagnostic: 'caret-point-out-of-tolerance',
    }],
    ['unsupported reading order', {
      extractedText: 'ab',
      textRects: [
        { content: 'a', rect: { origin: { x: 80, y: 30 }, size: { width: 8, height: 12 } } },
        { content: 'b', rect: { origin: { x: 20, y: 30 }, size: { width: 8, height: 12 } } },
      ],
      point: { x: 80, y: 36 },
      diagnostic: 'caret-reading-order-unsupported',
    }],
  ])('rejects %s with a typed diagnostic', (_name, fixture) => {
    expect(createCaretAnchorAtPoint({
      page: { ...page(Rotation.Degree0), extractedText: fixture.extractedText, textRects: fixture.textRects },
      point: fixture.point,
    })).toMatchObject({ ok: false, diagnostic: fixture.diagnostic });
  });

  it('rejects tied edge candidates instead of choosing arbitrarily', () => {
    const hitPage = {
      ...page(Rotation.Degree0),
      extractedText: 'aabb',
      textRects: [
        { content: 'aa', rect: { origin: { x: 20, y: 24 }, size: { width: 8, height: 12 } } },
        { content: 'bb', rect: { origin: { x: 20, y: 36 }, size: { width: 8, height: 12 } } },
      ],
    };
    expect(createCaretAnchorAtPoint({ page: hitPage, point: { x: 28, y: 36 } }))
      .toMatchObject({ ok: false, diagnostic: 'caret-candidate-tied' });
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
        segmentRects: [{ x: 24, y: 36 }],
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
