import type { PdfGlyphObject, Rect } from '@embedpdf/models';

import { DEFAULT_SELECTION_CONTEXT_CHARACTERS, EXCERPT_INVISIBLE } from './context-excerpt.js';

/**
 * Page text covered by a text markup annotation (highlight, underline,
 * squiggly or strikeout) that another app wrote into the PDF. Such
 * annotations store only where they sit on the page, so the words are
 * recovered from the glyphs their segments cover.
 */
export interface MarkedText {
  readonly quote: string;
  /** Page text just before the quote, as kept for Placekeeper's own anchors. */
  readonly prefix: string;
  /** Page text just after the quote. */
  readonly suffix: string;
}

export const TEXT_MARKUP_SUBTYPES: ReadonlySet<string> = new Set([
  'highlight',
  'underline',
  'squiggly',
  'strikeout',
]);

export function isTextMarkupSubtype(subtype: string): boolean {
  return TEXT_MARKUP_SUBTYPES.has(subtype.toLowerCase());
}

/** Portion of a glyph's height its center may sit outside a segment and still count. */
const VERTICAL_TOLERANCE = 0.25;

function glyphIsMarked(glyph: PdfGlyphObject, segments: readonly Rect[]): boolean {
  if (glyph.isEmpty) return false;
  const { origin, size } = glyph;
  if (![origin.x, origin.y, size.width, size.height].every(Number.isFinite)) return false;
  if (size.width <= 0 || size.height <= 0) return false;
  const centerX = origin.x + size.width / 2;
  const centerY = origin.y + size.height / 2;
  const slack = size.height * VERTICAL_TOLERANCE;
  return segments.some(({ origin: at, size: extent }) =>
    centerX >= at.x && centerX <= at.x + extent.width
    && centerY >= at.y - slack && centerY <= at.y + extent.height + slack);
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

/**
 * Recovers the text under `segments` from a page's text and glyphs, which
 * share character indexes. Spaces the engine inserts between marked words
 * are kept; unmarked text between two marked runs (another column, say) is
 * left out and replaced by a single space. Returns undefined when no glyph
 * falls inside the segments.
 */
export function markedTextFromGlyphs(
  text: string,
  glyphs: readonly PdfGlyphObject[],
  segments: readonly Rect[],
  contextCharacters = DEFAULT_SELECTION_CONTEXT_CHARACTERS,
): MarkedText | undefined {
  if (segments.length === 0) return undefined;
  const length = Math.min(text.length, glyphs.length);
  const marked: boolean[] = [];
  let first = -1;
  let last = -1;
  for (let index = 0; index < length; index += 1) {
    const glyph = glyphs[index];
    const isMarked = glyph !== undefined && !glyph.isSpace && glyphIsMarked(glyph, segments);
    marked.push(isMarked);
    if (isMarked) {
      if (first < 0) first = index;
      last = index;
    }
  }
  if (first < 0) return undefined;

  let quote = '';
  let pendingGap = false;
  for (let index = first; index <= last; index += 1) {
    const character = text[index]!;
    if (marked[index]) {
      if (pendingGap && !isWhitespace(quote.at(-1))) quote += ' ';
      pendingGap = false;
      quote += character;
    } else if (!EXCERPT_INVISIBLE.test(character)) {
      // PDFium marks a hyphen at a line break with an invisible character;
      // the word continues on the next line without a gap.
      pendingGap = true;
    }
  }
  quote = quote.trim();
  if (quote === '') return undefined;
  return {
    quote,
    prefix: text.slice(Math.max(0, first - contextCharacters), first),
    suffix: text.slice(last + 1, last + 1 + contextCharacters),
  };
}
