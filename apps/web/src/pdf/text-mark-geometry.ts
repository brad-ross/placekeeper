import type { PdfGlyphObject } from '@embedpdf/models';
import type { PdfRect } from '../../../../packages/core/src/pdf-writer.js';

export function textCenterFraction(rect: PdfRect, glyphs: readonly Pick<PdfGlyphObject, 'isEmpty' | 'isSpace' | 'origin' | 'size' | 'tightOrigin' | 'tightSize'>[]): number | undefined {
  const intersecting = glyphs.filter((glyph) => !glyph.isEmpty && !glyph.isSpace
    && glyph.size.width > 0 && glyph.size.height > 0
    && glyph.origin.x + glyph.size.width > rect.x && glyph.origin.x < rect.x + rect.width
    && glyph.origin.y + glyph.size.height > rect.y && glyph.origin.y < rect.y + rect.height);
  if (!intersecting.length || rect.height <= 0) return undefined;
  // Loose character boxes include font ascent/descent padding. Use ink bounds for visual centering.
  const ink = intersecting.map((glyph) => glyph.tightOrigin && glyph.tightSize
    && glyph.tightSize.width > 0 && glyph.tightSize.height > 0
    ? { origin: glyph.tightOrigin, size: glyph.tightSize } : glyph);
  // A width-weighted median follows the dominant letter body rather than letting
  // a single ascender, descender, or punctuation mark move the whole passage.
  const centers = ink.map((glyph) => ({
    center: glyph.origin.y + glyph.size.height / 2, weight: glyph.size.width,
  })).sort((a, b) => a.center - b.center);
  const halfway = centers.reduce((sum, glyph) => sum + glyph.weight, 0) / 2;
  let accumulated = 0;
  const center = centers.find((glyph) => { accumulated += glyph.weight; return accumulated >= halfway; })!.center;
  return Math.max(0, Math.min(1, (center - rect.y) / rect.height));
}

/** Shared text-mark paint geometry. Annotation kind and comment content do not affect it. */
export function textMarkGeometry(rect: PdfRect, scaledHeight: number, centerFraction = .5) {
  const scale = rect.height > 0 ? scaledHeight / rect.height : 1;
  const height = scaledHeight + 3 * scale;
  // Balance the padded wash optically without moving the strike off the glyph center.
  const opticalLift = .75 * scale;
  return {
    height,
    offset: (centerFraction - .5) * scaledHeight - opticalLift,
    strikePosition: `${(0.5 + opticalLift / height) * 100}%`,
  } as const;
}
