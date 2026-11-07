/**
 * Short passages of PDF text shown around a search match or an annotation's
 * quote. Context cut from a longer passage starts and ends on whole words and
 * says so with an ellipsis, rather than beginning mid-word ("atterns are…").
 */

export const EXCERPT_ELLIPSIS = '…';

/** Characters of page text a selection anchor keeps on each side of its quote. */
export const DEFAULT_SELECTION_CONTEXT_CHARACTERS = 48;

/**
 * PDFium marks a hyphen at a line break with U+FFFE; with soft hyphens and
 * stray control glyphs it would render as a box, so excerpts drop them and
 * rejoin the word.
 */
export const EXCERPT_INVISIBLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f­￾￿]/u;

/** Drops invisible glyphs and collapses whitespace runs to single spaces. */
export function normalizeExcerptText(text: string): string {
  let normalized = '';
  let previousWasWhitespace = false;
  for (const character of text) {
    if (EXCERPT_INVISIBLE.test(character)) continue;
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) normalized += ' ';
      previousWasWhitespace = true;
    } else {
      normalized += character;
      previousWasWhitespace = false;
    }
  }
  return normalized;
}

/**
 * Context that runs up to a match or quote. When `truncated`, the text was cut
 * from a longer passage, so a partial first word is dropped and an ellipsis
 * marks the cut. Whitespace touching the match is preserved.
 */
export function leadingContext(text: string, truncated: boolean, maxLength = Infinity): string {
  let context = text;
  let cut = truncated;
  if (context.length > maxLength) {
    context = context.slice(context.length - maxLength);
    cut = true;
  }
  if (!cut) return context.trimStart();
  const firstSpace = context.search(/\s/u);
  // A single unbroken run is part of the word that holds the match; keep it.
  if (firstSpace > 0) context = context.slice(firstSpace);
  const trimmed = context.trimStart();
  return trimmed.length === 0 ? `${EXCERPT_ELLIPSIS}${context}` : `${EXCERPT_ELLIPSIS}${trimmed}`;
}

/** The mirror of {@link leadingContext} for context after a match or quote. */
export function trailingContext(text: string, truncated: boolean, maxLength = Infinity): string {
  let context = text;
  let cut = truncated;
  if (context.length > maxLength) {
    context = context.slice(0, maxLength);
    cut = true;
  }
  if (!cut) return context.trimEnd();
  const lastSpace = Math.max(context.lastIndexOf(' '), context.lastIndexOf('\n'), context.lastIndexOf('\t'));
  if (lastSpace >= 0 && lastSpace < context.length - 1) context = context.slice(0, lastSpace + 1);
  const trimmed = context.trimEnd();
  return trimmed.length === 0 ? `${context}${EXCERPT_ELLIPSIS}` : `${trimmed.replace(/[\s,;:]+$/u, '')}${EXCERPT_ELLIPSIS}`;
}
