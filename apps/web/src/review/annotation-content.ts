import type { ReviewItem } from '../../../../packages/core/src/review-model.js';

function payloadString(item: ReviewItem, field: string): string {
  const value = item.payload[field];
  return typeof value === 'string' ? value : '';
}

export interface AnnotationContent {
  readonly content: string;
  readonly sourceText?: string;
  readonly sourceTreatment?: 'plain' | 'struck';
  readonly quoteText?: string;
}

export function annotationContent(item: ReviewItem): AnnotationContent {
  const quote = payloadString(item, 'quote');
  const proposedText = payloadString(item, 'proposedText');
  const comment = payloadString(item, 'comment');
  switch (item.kind) {
    case 'replace':
      return { content: proposedText, ...(quote ? { sourceText: quote, sourceTreatment: 'struck' as const } : {}) };
    case 'delete':
      return { content: '', ...(quote ? { sourceText: quote, sourceTreatment: 'struck' as const } : {}) };
    case 'highlight': return {
      content: comment,
      ...(quote ? { quoteText: quote } : {}),
    };
    case 'insert': return { content: proposedText || quote };
    case 'pageNote': return { content: comment || quote };
  }
}
