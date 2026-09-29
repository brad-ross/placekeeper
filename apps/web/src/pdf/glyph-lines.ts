import type { PdfGlyphObject, Rect } from '@embedpdf/models';

/** One merged run of glyphs that share a line, in engine character order. */
export interface GlyphLineSegment {
  readonly rect: Rect;
  /** First glyph (character) index covered by this segment. */
  readonly start: number;
  /** One past the last glyph (character) index covered by this segment. */
  readonly end: number;
}

export interface GlyphLineOffset {
  readonly x: number;
  readonly y: number;
}

const NO_OFFSET: GlyphLineOffset = { x: 0, y: 0 };

function drawableGlyph(glyph: PdfGlyphObject): boolean {
  return !(
    glyph.isEmpty
    || glyph.isSpace
    || !Number.isFinite(glyph.origin.x)
    || !Number.isFinite(glyph.origin.y)
    || !Number.isFinite(glyph.size.width)
    || !Number.isFinite(glyph.size.height)
    || glyph.size.width <= 0
    || glyph.size.height <= 0
  );
}

/**
 * Merges consecutive drawable glyphs in `[start, end)` into line segments.
 * Glyphs join a segment when their vertical centers lie within one line
 * height and the horizontal gap stays within 1.5 line heights. `offset` is
 * added to every glyph origin before merging.
 */
export function mergeGlyphLineSegments(
  glyphs: readonly PdfGlyphObject[],
  start: number = 0,
  end: number = glyphs.length,
  offset: GlyphLineOffset = NO_OFFSET,
): GlyphLineSegment[] {
  const lines: GlyphLineSegment[] = [];
  const from = Math.max(0, start);
  const to = Math.min(glyphs.length, end);
  for (let index = from; index < to; index += 1) {
    // The engine leaves holes for characters it generates without a glyph
    // (for example the space it inserts before a far-right equation number).
    const glyph = glyphs[index];
    if (glyph === undefined || !drawableGlyph(glyph)) continue;
    const rect: Rect = {
      origin: { x: glyph.origin.x + offset.x, y: glyph.origin.y + offset.y },
      size: { ...glyph.size },
    };
    const previousLine = lines.at(-1);
    if (!previousLine) {
      lines.push({ rect, start: index, end: index + 1 });
      continue;
    }
    const previous = previousLine.rect;
    const previousCenter = previous.origin.y + previous.size.height / 2;
    const rectCenter = rect.origin.y + rect.size.height / 2;
    const sameLine = Math.abs(previousCenter - rectCenter)
      <= Math.max(previous.size.height, rect.size.height);
    const horizontalGap = Math.max(
      0,
      Math.max(previous.origin.x, rect.origin.x)
        - Math.min(
          previous.origin.x + previous.size.width,
          rect.origin.x + rect.size.width,
        ),
    );
    if (!sameLine || horizontalGap > Math.max(previous.size.height, rect.size.height) * 1.5) {
      lines.push({ rect, start: index, end: index + 1 });
      continue;
    }
    const left = Math.min(previous.origin.x, rect.origin.x);
    const top = Math.min(previous.origin.y, rect.origin.y);
    const right = Math.max(
      previous.origin.x + previous.size.width,
      rect.origin.x + rect.size.width,
    );
    const bottom = Math.max(
      previous.origin.y + previous.size.height,
      rect.origin.y + rect.size.height,
    );
    lines[lines.length - 1] = {
      rect: {
        origin: { x: left, y: top },
        size: { width: right - left, height: bottom - top },
      },
      start: previousLine.start,
      end: index + 1,
    };
  }
  return lines;
}

/** Line rectangles for glyphs in `[start, end)`, as search highlights use them. */
export function mergeGlyphLineRects(
  glyphs: readonly PdfGlyphObject[],
  start: number,
  end: number,
  offset: GlyphLineOffset = NO_OFFSET,
): Rect[] {
  return mergeGlyphLineSegments(glyphs, start, end, offset).map(({ rect }) => rect);
}

/** Fails closed when any non-space glyph has unusable geometry. */
export function hasReliableGlyphGeometry(glyphs: readonly PdfGlyphObject[]): boolean {
  return glyphs.every((glyph) => (
    glyph.isEmpty
    || glyph.isSpace
    || (
      Number.isFinite(glyph.origin.x)
      && Number.isFinite(glyph.origin.y)
      && Number.isFinite(glyph.size.width)
      && Number.isFinite(glyph.size.height)
      && glyph.size.width > 0
      && glyph.size.height > 0
    )
  ));
}
