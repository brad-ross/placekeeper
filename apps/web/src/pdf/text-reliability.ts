export const PAGE_TEXT_UNAVAILABLE_MESSAGE =
  'Text editing is unavailable on this page. You can still navigate or add a Page Note.';

export const SELECTION_UNAVAILABLE_MESSAGE =
  'This selection cannot be anchored reliably. Adjust the selection or use Page Note.';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TextRect {
  content: string;
  rect: {
    origin: Point;
    size: Size;
  };
}

export interface PageText {
  extractedText: string;
  textRects: readonly TextRect[];
}

export type ReliabilityDiagnostic =
  | 'page-has-no-text'
  | 'page-geometry-invalid'
  | 'selection-crosses-pages'
  | 'selection-is-empty'
  | 'selection-quote-not-found'
  | 'selection-quote-not-unique'
  | 'selection-glyph-count-mismatch'
  | 'selection-geometry-invalid'
  | 'selection-geometry-out-of-bounds'
  | 'selection-text-geometry-mismatch'
  | 'selection-has-ambiguous-characters'
  | 'selection-reading-order-unsupported'
  | 'selection-reading-order-ambiguous'
  | 'caret-text-rect-alignment-nonunique'
  | 'caret-text-rects-overlap'
  | 'caret-reading-order-unsupported'
  | 'caret-point-inside-multichar-rect'
  | 'caret-point-out-of-tolerance'
  | 'caret-candidate-tied'
  | 'caret-read-unavailable';

export type ReliabilityResult =
  | { reliable: true }
  | {
      reliable: false;
      userMessage: string;
      diagnostic: ReliabilityDiagnostic;
    };

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isValidTextRect(rect: TextRect['rect']): boolean {
  return (
    Number.isFinite(rect.origin.x) &&
    Number.isFinite(rect.origin.y) &&
    isFinitePositive(rect.size.width) &&
    isFinitePositive(rect.size.height)
  );
}

export function assessPageTextReliability(page: PageText): ReliabilityResult {
  if (page.extractedText.length === 0 || page.textRects.length === 0) {
    return {
      reliable: false,
      userMessage: PAGE_TEXT_UNAVAILABLE_MESSAGE,
      diagnostic: 'page-has-no-text',
    };
  }

  if (page.textRects.some(({ rect }) => !isValidTextRect(rect))) {
    return {
      reliable: false,
      userMessage: PAGE_TEXT_UNAVAILABLE_MESSAGE,
      diagnostic: 'page-geometry-invalid',
    };
  }

  return { reliable: true };
}

function fail(diagnostic: ReliabilityDiagnostic): ReliabilityResult {
  return {
    reliable: false,
    userMessage: SELECTION_UNAVAILABLE_MESSAGE,
    diagnostic,
  };
}

function occurrenceCount(text: string, quote: string): number {
  let count = 0;
  let from = 0;
  while (from <= text.length - quote.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(quote.length, 1);
  }
  return count;
}

function hasUnsupportedReadingOrder(text: string): boolean {
  return /[\u0590-\u08ff\u2e80-\u9fff\uf900-\ufaff]/u.test(text);
}

function hasAmbiguousCharacters(text: string): boolean {
  return /[\u00ad\ufb00-\ufb06]/u.test(text);
}

function hasAmbiguousRectOrder(rects: readonly TextRect['rect'][]): boolean {
  const tolerance = 1;
  for (let index = 1; index < rects.length; index += 1) {
    const previous = rects[index - 1]!;
    const current = rects[index]!;
    if (current.origin.y + tolerance < previous.origin.y) return true;
    if (
      Math.abs(current.origin.y - previous.origin.y) <= tolerance &&
      current.origin.x + tolerance < previous.origin.x
    ) {
      return true;
    }
  }
  return false;
}

function intersects(a: TextRect['rect'], b: TextRect['rect']): boolean {
  return (
    a.origin.x < b.origin.x + b.size.width &&
    a.origin.x + a.size.width > b.origin.x &&
    a.origin.y < b.origin.y + b.size.height &&
    a.origin.y + a.size.height > b.origin.y
  );
}

function geometryTouchesText(input: SelectionReliabilityInput): boolean {
  return input.segmentRects.every((segment) =>
    input.page.textRects.some(({ rect }) => intersects(rect, segment)),
  );
}

export interface SelectionReliabilityInput {
  page: PageText;
  pageIndexes: readonly number[];
  quote: string;
  quoteStart?: number;
  glyphCount: number;
  segmentRects: readonly TextRect['rect'][];
}

export function assessSelectionReliability(input: SelectionReliabilityInput): ReliabilityResult {
  if (new Set(input.pageIndexes).size !== 1) return fail('selection-crosses-pages');
  if (input.quote.length === 0) return fail('selection-is-empty');

  const pageReliability = assessPageTextReliability(input.page);
  if (!pageReliability.reliable) return fail(pageReliability.diagnostic);

  if (input.quoteStart !== undefined) {
    if (
      !Number.isSafeInteger(input.quoteStart) ||
      input.quoteStart < 0 ||
      input.page.extractedText.slice(
        input.quoteStart,
        input.quoteStart + input.quote.length,
      ) !== input.quote
    ) {
      return fail('selection-text-geometry-mismatch');
    }
  } else {
    const occurrences = occurrenceCount(input.page.extractedText, input.quote);
    if (occurrences === 0) return fail('selection-quote-not-found');
    if (occurrences > 1) return fail('selection-quote-not-unique');
  }
  if (Array.from(input.quote).length !== input.glyphCount) {
    return fail('selection-glyph-count-mismatch');
  }
  if (input.segmentRects.length === 0 || input.segmentRects.some((rect) => !isValidTextRect(rect))) {
    return fail('selection-geometry-invalid');
  }
  if (hasAmbiguousCharacters(input.quote)) return fail('selection-has-ambiguous-characters');
  if (hasUnsupportedReadingOrder(input.quote)) return fail('selection-reading-order-unsupported');
  if (hasAmbiguousRectOrder(input.segmentRects)) return fail('selection-reading-order-ambiguous');
  // Text rectangles are often line- or run-sized, not exact selected substrings.
  // Exact quote/offset validation above establishes the text mapping; this check
  // independently ensures every selection segment lies over extracted text.
  if (!geometryTouchesText(input)) return fail('selection-text-geometry-mismatch');

  return { reliable: true };
}
