import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import {
  DEFAULT_SELECTION_CONTEXT_CHARACTERS,
  leadingContext,
  normalizeExcerptText,
  trailingContext,
} from '../pdf/context-excerpt.js';

function payloadString(item: ReviewItem, field: string): string {
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
export function annotationQuoteContext(item: ReviewItem): QuoteContext | undefined {
  const prefix = payloadString(item, 'prefix');
  const suffix = payloadString(item, 'suffix');
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

export function annotationContent(item: ReviewItem): AnnotationContent {
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
    case 'pdfAnnotation': return { content: comment };
    case 'pageNote': return { content: comment || quote };
  }
}
