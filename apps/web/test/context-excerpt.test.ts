import { describe, expect, it } from 'vitest';

import {
  leadingContext,
  normalizeExcerptText,
  trailingContext,
} from '../src/pdf/context-excerpt.js';
import { annotationContent } from '../src/review/annotation-content.js';
import type { ReviewItem } from '../../../packages/core/src/review-model.js';

describe('context excerpts', () => {
  it('drops a cut partial word before the match and marks the cut', () => {
    expect(leadingContext('atterns are often insufficient to identify all ', true))
      .toBe('…are often insufficient to identify all ');
  });

  it('drops a cut partial word after the match and marks the cut', () => {
    expect(trailingContext(' outcome means with respect to a co', true))
      .toBe(' outcome means with respect to a…');
  });

  it('leaves uncut context alone apart from outer whitespace', () => {
    expect(leadingContext('  A stable ', false)).toBe('A stable ');
    expect(trailingContext(' follows.  ', false)).toBe(' follows.');
  });

  it('keeps a single unbroken run, which belongs to the matched word', () => {
    expect(leadingContext('super', true)).toBe('…super');
    expect(trailingContext('-specific', true)).toBe('-specific…');
  });

  it('still marks a cut that falls exactly on a word boundary', () => {
    expect(leadingContext('word ', true)).toBe('… ');
    expect(trailingContext(' word', true)).toBe(' …');
  });

  it('shortens long context to whole words within the limit', () => {
    expect(leadingContext('one two three four five ', false, 12)).toBe('…four five ');
    expect(trailingContext(' one two three four five', false, 12)).toBe(' one two…');
  });

  it('drops trailing separators before the ellipsis', () => {
    expect(trailingContext(' Kline, 2024; Bonhomme', true)).toBe(' Kline, 2024…');
  });

  it('normalizes whitespace and line-break hyphen markers', () => {
    expect(normalizeExcerptText('perturba￾tion\n  theory')).toBe('perturbation theory');
  });
});

describe('annotation quote context', () => {
  const item = (payload: ReviewItem['payload'], kind: ReviewItem['kind'] = 'highlight'): ReviewItem => ({
    id: 'a', kind, pageIndex: 0, createdAt: '', updatedAt: '', payload,
  });

  it('adds whole-word context around a highlight quote', () => {
    const content = annotationContent(item({
      quote: 'from',
      comment: 'Is this testable?',
      // 48 characters, as captured by a selection anchor: cut on both sides.
      prefix: 'ear how to efficiently combine the information ',
      suffix: ' each.  Our approach addresses both challenges b',
    }));
    expect(content.quoteText).toBe('from');
    expect(content.quoteContext).toEqual({
      before: '…combine the information ',
      after: ' each. Our approach addresses both…',
    });
  });

  it('omits the leading ellipsis when the prefix reaches the start of the page', () => {
    const content = annotationContent(item({ quote: 'Agarwal', prefix: '', suffix: ' et al.' }));
    expect(content.quoteContext).toEqual({ before: '', after: ' et al.' });
  });

  it('adds context to struck source text and nothing without an anchor', () => {
    expect(annotationContent(item({ quote: 'x', prefix: 'a ', suffix: ' b' }, 'delete')).quoteContext)
      .toEqual({ before: 'a ', after: ' b' });
    expect(annotationContent(item({ comment: 'note' }, 'pageNote')).quoteContext).toBeUndefined();
  });
});
