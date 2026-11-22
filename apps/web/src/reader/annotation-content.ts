import type { Annotation } from '../../../../packages/core/src/document-model.js';
import type { ExistingAnnotation, ImportedMarkedText } from '../pdf/existing-annotations.js';
import type { MarkedText } from '../pdf/markup-text.js';
import {
  DEFAULT_SELECTION_CONTEXT_CHARACTERS,
  leadingContext,
  normalizeExcerptText,
  trailingContext,
} from '../pdf/context-excerpt.js';

function payloadString(item: Annotation, field: string): string {
  const value = item.payload[field];
  return typeof value === 'string' ? value : '';
}

/** Page text shown on each side of a quote in an annotation row. */
const QUOTE_CONTEXT_CHARACTERS = 36;

export interface QuoteContext {
  readonly before: string;
  readonly after: string;
}

export interface AnnotationContent {
  readonly content: string;
  readonly sourceText?: string;
  readonly sourceTreatment?: 'plain' | 'struck';
  readonly quoteText?: string;
  /** Surrounding page text for `quoteText` or `sourceText`, trimmed to whole words. */
  readonly quoteContext?: QuoteContext;
}

/**
 * A little of the page text around a selection quote. The anchor's prefix and
 * suffix are cut from the page at a fixed length, so a full-length one is
 * assumed to continue beyond what was kept.
 */
export function annotationQuoteContext(item: Annotation): QuoteContext | undefined {
  return quoteContextFrom(payloadString(item, 'prefix'), payloadString(item, 'suffix'));
}

function quoteContextFrom(prefix: string, suffix: string): QuoteContext | undefined {
  if (prefix.trim() === '' && suffix.trim() === '') return undefined;
  const before = leadingContext(
    normalizeExcerptText(prefix),
    prefix.length >= DEFAULT_SELECTION_CONTEXT_CHARACTERS,
    QUOTE_CONTEXT_CHARACTERS,
  );
  const after = trailingContext(
    normalizeExcerptText(suffix),
    suffix.length >= DEFAULT_SELECTION_CONTEXT_CHARACTERS,
    QUOTE_CONTEXT_CHARACTERS,
  );
  return before.trim() === '' && after.trim() === '' ? undefined : { before, after };
}

/**
 * Card and reader content for an annotation another app wrote into the PDF.
 * A highlight, underline or squiggly shows the words it marks like a
 * Placekeeper highlight; a strikeout shows them struck, like a deletion.
 */
export function existingAnnotationContent(
  annotation: Pick<ExistingAnnotation, 'subtype' | 'contents' | 'markedText'>,
): AnnotationContent {
  const { markedText } = annotation;
  if (markedText === undefined || markedText.quote.trim() === '') return { content: annotation.contents };
  const context = quoteContextFrom(markedText.prefix, markedText.suffix);
  const withContext = context === undefined ? {} : { quoteContext: context };
  return annotation.subtype.toLowerCase() === 'strikeout'
    ? { content: annotation.contents, sourceText: markedText.quote, sourceTreatment: 'struck', ...withContext }
    : { content: annotation.contents, quoteText: markedText.quote, ...withContext };
}

/** Viewer-only payload key for the words under an imported annotation. */
const DISPLAYED_MARKED_TEXT = 'displayedMarkedText';

function displayedMarkedText(item: Annotation): MarkedText | undefined {
  const value = item.payload[DISPLAYED_MARKED_TEXT];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { quote, prefix, suffix } = value as Record<string, unknown>;
  return typeof quote === 'string' && typeof prefix === 'string' && typeof suffix === 'string'
    ? { quote, prefix, suffix }
    : undefined;
}

/**
 * Adds the words under each imported PDF annotation to the items the review
 * surfaces display. Placekeeper imports another app's highlights as editable
 * annotations that record only their comment and position, so the words are
 * read from the page when the PDF opens. The text is display-only: it is
 * never part of a command or of saved review state.
 */
export function withImportedMarkedText(
  items: readonly Annotation[],
  imported: ImportedMarkedText | undefined,
): readonly Annotation[] {
  if (imported === undefined || imported.size === 0) return items;
  let changed = false;
  const displayed = items.map((item) => {
    const { sourceObjectPageIndex: page, sourceObjectAnnotationIndex: index } = item.payload;
    if (item.kind !== 'pdfAnnotation' || typeof page !== 'number' || typeof index !== 'number') return item;
    const markedText = imported.get(`${page}:${index}`);
    if (markedText === undefined) return item;
    changed = true;
    return { ...item, payload: { ...item.payload, [DISPLAYED_MARKED_TEXT]: { ...markedText } } };
  });
  return changed ? displayed : items;
}

export function annotationContent(item: Annotation): AnnotationContent {
  const quote = payloadString(item, 'quote');
  const proposedText = payloadString(item, 'proposedText');
  const comment = payloadString(item, 'comment');
  const context = quote ? annotationQuoteContext(item) : undefined;
  const withContext = context === undefined ? {} : { quoteContext: context };
  switch (item.kind) {
    case 'replace':
      return { content: proposedText, ...(quote ? { sourceText: quote, sourceTreatment: 'struck' as const, ...withContext } : {}) };
    case 'delete':
      return { content: '', ...(quote ? { sourceText: quote, sourceTreatment: 'struck' as const, ...withContext } : {}) };
    case 'highlight': return {
      content: comment,
      ...(quote ? { quoteText: quote, ...withContext } : {}),
    };
    case 'insert': return { content: proposedText || quote };
    case 'pdfAnnotation': {
      const markedText = displayedMarkedText(item);
      return existingAnnotationContent({
        subtype: payloadString(item, 'subtype'),
        contents: comment,
        ...(markedText === undefined ? {} : { markedText }),
      });
    }
    case 'pageNote': return { content: comment || quote };
  }
}
