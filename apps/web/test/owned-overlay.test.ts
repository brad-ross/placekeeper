import { Rotation } from "@embedpdf/models";
import { describe, expect, it } from "vitest";

import { ownedMarkStyle, positionOwnedRect } from "../src/pdf/owned-overlay.js";
import { buildAnnotationRenderingState } from '../src/pdf/PdfAnnotationLayers.js';

import { textCenterFraction, textMarkGeometry } from '../src/pdf/text-mark-geometry.js';

describe("owned annotation overlay geometry", () => {
  it('shares frozen native-source suppression and residual reader marks across viewers', () => {
    const native = {
      id: 'owned-native',
      pageIndex: 2,
      sourceId: 'pdf-17',
      readerStyle: {},
    } as const;
    const residual = {
      id: 'pdf-23', subtype: 'Highlight', pageIndex: 3,
      rect: { x: 10, y: 20, width: 30, height: 12 }, contents: 'Source note',
      author: 'Reviewer', flags: [], appearanceModes: [], supportedAppearance: true,
      readerStyle: {},
    } as const;
    const owned = [{
      id: 'owned-native', reviewItemId: 'review-17', kind: 'pdfAnnotation', pageIndex: 2,
      rect: { x: 1, y: 2, width: 3, height: 4 }, contents: 'Editable note',
      author: 'Reviewer', createdAt: '2026-09-17T00:00:00.000Z',
      modifiedAt: '2026-09-17T00:00:00.000Z',
    }] as const;

    const visible = buildAnnotationRenderingState(owned, [native], [residual]);
    expect(visible.hiddenSourceKeys).toEqual(new Set());
    expect(visible.sourceMarks.get('2:pdf-17')).toMatchObject({
      contents: 'Editable note', ownedAnnotationId: 'review-17', pageIndex: 2,
    });
    expect(visible.sourceMarks.get('3:pdf-23')).toMatchObject({
      contents: 'Source note', annotationKey: '3:pdf-23', pageIndex: 3,
    });
    expect(visible.residualSourceFocusMarks).toEqual([expect.objectContaining({
      id: 'pdf-23', pageIndex: 3, contents: 'Source note',
    })]);

    const afterDelete = buildAnnotationRenderingState([], [native], [residual]);
    expect(afterDelete.hiddenSourceKeys).toEqual(new Set(['2:pdf-17']));
    expect(afterDelete.sourceMarks.has('2:pdf-17')).toBe(false);
    expect(afterDelete.sourceMarks.has('3:pdf-23')).toBe(true);

    const overlappingSource = {
      ...residual,
      id: 'pdf-17',
      pageIndex: 2,
      contents: 'Frozen native source copy',
    } as const;
    const overlapVisible = buildAnnotationRenderingState(owned, [native], [overlappingSource]);
    expect(overlapVisible.residualSourceFocusMarks).toEqual([]);
    const overlapAfterDelete = buildAnnotationRenderingState([], [native], [overlappingSource]);
    expect(overlapAfterDelete.hiddenSourceKeys).toEqual(new Set(['2:pdf-17']));
    expect(overlapAfterDelete.residualSourceFocusMarks).toEqual([]);
  });

  it("treats owned geometry as crop-relative and applies rotation plus zoom exactly once", () => {
    const positioned = positionOwnedRect(
      {
        index: 0,
        objectNumber: 1,
        size: { width: 600, height: 800 },
        rotation: Rotation.Degree90,
        boxes: {
          media: { left: 0, top: 0, right: 700, bottom: 1000 },
          crop: { left: 100, top: 200, right: 700, bottom: 1000 },
        },
      },
      {
        pageIndex: 0, pageNumber: 1, x: 0, y: 0,
        width: 1200, height: 1600, rotatedWidth: 1600, rotatedHeight: 1200,
        elevated: false,
      },
      Rotation.Degree0,
      { x: 10, y: 20, width: 30, height: 40 },
    );
    expect(positioned).toEqual({
      origin: { x: 1480, y: 20 },
      size: { width: 80, height: 60 },
    });
  });

  it("combines page and document rotation", () => {
    const positioned = positionOwnedRect(
      { index: 0, objectNumber: 1, size: { width: 100, height: 200 }, rotation: Rotation.Degree90 },
      { pageIndex: 0, pageNumber: 1, x: 0, y: 0, width: 100, height: 200, rotatedWidth: 100, rotatedHeight: 200, elevated: false },
      Rotation.Degree180,
      { x: 10, y: 20, width: 30, height: 40 },
    );
    expect(positioned).toEqual({ origin: { x: 20, y: 60 }, size: { width: 40, height: 30 } });
  });
});


describe('annotation mark baseline orientation', () => {
  it.each([Rotation.Degree0, Rotation.Degree90, Rotation.Degree180, Rotation.Degree270])(
    'keeps the PDF anchor center while rotating its strike-through and underline at %s', (rotation) => {
      const page = { index: 0, objectNumber: 1, size: { width: 600, height: 800 }, rotation };
      const layout = { pageIndex: 0, pageNumber: 1, x: 0, y: 0, width: 1200, height: 1600,
        rotatedWidth: rotation % 2 === 0 ? 1200 : 1600,
        rotatedHeight: rotation % 2 === 0 ? 1600 : 1200, elevated: false };
      const rect = { x: 70, y: 130, width: 180, height: 16 };
      const bounds = positionOwnedRect(page, layout, Rotation.Degree0, rect);
      const style = ownedMarkStyle(page, layout, Rotation.Degree0, rect);
      expect(style).toMatchObject({
        left: bounds.origin.x + bounds.size.width / 2,
        top: bounds.origin.y + bounds.size.height / 2,
        width: 360, height: 32,
        transform: `translate(-50%, -50%) rotate(${rotation * 90}deg)`,
      });
    },
  );
});

it('centers strikethroughs in visible glyphs rather than padded highlight bounds', () => {
  const rect = { x: 10, y: 10, width: 100, height: 30 };
  const glyphs = [
    { isEmpty: false, isSpace: false, origin: { x: 20, y: 12 }, size: { width: 10, height: 10 } },
    { isEmpty: false, isSpace: false, origin: { x: 35, y: 14 }, size: { width: 10, height: 8 } },
    { isEmpty: false, isSpace: true, origin: { x: 50, y: 10 }, size: { width: 10, height: 30 } },
    { isEmpty: false, isSpace: false, origin: { x: 20, y: 50 }, size: { width: 10, height: 10 } },
  ];
  expect(textCenterFraction(rect, glyphs)).toBeCloseTo(7 / 30);
  expect(textCenterFraction(rect, [])).toBeUndefined();
});

it('uses tight ink bounds instead of font ascent and descent for the visual text center', () => {
  expect(textCenterFraction({ x: 10, y: 10, width: 100, height: 30 }, [{
    origin: { x: 20, y: 10 }, size: { width: 10, height: 30 },
    tightOrigin: { x: 21, y: 20 }, tightSize: { width: 8, height: 8 },
  }])).toBeCloseTo(14 / 30);
});

it('keeps a narrow ascender or descender from shifting the dominant text body', () => {
  const glyph = (y: number, height: number, width: number) => ({ origin: { x: 20, y }, size: { width, height } });
  expect(textCenterFraction({ x: 10, y: 0, width: 100, height: 30 }, [
    glyph(8, 10, 10), glyph(8, 10, 10), glyph(2, 16, 3), glyph(8, 17, 3),
  ])).toBeCloseTo(13 / 30);
});

it('shares centered paint bounds and strike alignment across text annotation styles', () => {
  const rect = { x: 20, y: 10, width: 100, height: 20 };
  for (const scale of [.5, 1, 2]) {
    const geometry = textMarkGeometry(rect, rect.height * scale, .6);
    expect(geometry.height).toBeCloseTo(23 * scale);
    expect(geometry.offset).toBeCloseTo(1.25 * scale);
    expect(parseFloat(geometry.strikePosition)).toBeCloseTo((.5 + .75 / 23) * 100);
    // The shared optical lift must not move the strike off the letter-body center.
    const center = rect.y * scale + rect.height * scale / 2 + geometry.offset;
    expect(center - geometry.height / 2 + geometry.height * parseFloat(geometry.strikePosition) / 100).toBeCloseTo(22 * scale);
  }
});
