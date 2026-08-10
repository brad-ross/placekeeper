import { describe, expect, it } from 'vitest';

import {
  MAX_PDF_NAVIGATION_LABEL_LENGTH,
  createPdfNavigationMetadata,
} from '../src/pdf/pdf-navigation-metadata.js';

const forbiddenControls = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

describe('PDF navigation metadata safety', () => {
  it('prefers safe contents, then subject, source text, and trusted page context', () => {
    expect(createPdfNavigationMetadata({ contents: ' Contents ', subject: 'Subject', sourceText: 'Source', pageIndex: 2 }))
      .toMatchObject({ label: 'Contents', authorLabel: 'Contents', pageContext: 'Page 3', source: 'contents' });
    expect(createPdfNavigationMetadata({ contents: '\u202e\n', subject: ' Subject ', sourceText: 'Source', pageIndex: 2 }))
      .toMatchObject({ label: 'Subject', authorLabel: 'Subject', pageContext: 'Page 3', source: 'subject' });
    expect(createPdfNavigationMetadata({ contents: null, subject: '', sourceText: ' Source text ', pageIndex: 2 }))
      .toMatchObject({ label: 'Source text', authorLabel: 'Source text', pageContext: 'Page 3', source: 'source-text' });
    expect(createPdfNavigationMetadata({ pageIndex: 2 }))
      .toEqual({ label: 'Page 3', authorLabel: null, pageContext: 'Page 3', source: 'page-context' });
  });

  it('neutralizes markup, controls, bidi overrides, and disruptive whitespace', () => {
    const metadata = createPdfNavigationMetadata({
      contents: '\u202e<img src=x onerror=alert(1)>\u0000\n\t  destination\u0085label',
      pageIndex: 0,
    });

    expect(metadata.authorLabel).toBe('img src=x onerror=alert(1) destination label');
    expect(metadata.label).not.toMatch(/[<>]/u);
    expect(metadata.label).not.toMatch(forbiddenControls);
    expect(metadata.label).not.toMatch(/\s{2,}/u);
  });

  it('bounds author display text by Unicode code point while keeping page context separate', () => {
    const metadata = createPdfNavigationMetadata({
      contents: `Reference ${'🙂'.repeat(MAX_PDF_NAVIGATION_LABEL_LENGTH)}`,
      pageIndex: 123_456,
      maxLabelLength: 24,
    });

    expect([...metadata.label]).toHaveLength(24);
    expect([...(metadata.authorLabel ?? '')]).toHaveLength(24);
    expect(metadata.label.endsWith('…')).toBe(true);
    expect(metadata.pageContext).toBe('Page 123457');
  });

  it('fails safely for invalid page context and length configuration', () => {
    expect(() => createPdfNavigationMetadata({ pageIndex: -1 })).toThrow(/page index/u);
    expect(() => createPdfNavigationMetadata({ pageIndex: 0, maxLabelLength: 0 })).toThrow(/label length/u);
  });
});
