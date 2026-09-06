import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewItem } from '../../../packages/core/src/review-model.js';
import { AnnotationRowContent, annotationListContent } from '../src/review/AnnotationList.js';
import {
  FullAnnotationReader,
  shouldRestoreFullAnnotationReaderFocus,
} from '../src/review/FullAnnotationReader.js';
import { projectExistingAnnotationReader, projectOwnedAnnotationReader } from '../src/review/annotation-reader.js';

const replacement: ReviewItem = {
  id: 'replace-1',
  kind: 'replace',
  pageIndex: 3,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  payload: { quote: 'imprecise source', proposedText: 'precise replacement' },
};

describe('annotation row and reader presentation', () => {
  it('restores reader focus only when the disappearing locate action held it', () => {
    expect(shouldRestoreFullAnnotationReaderFocus(true, false, true)).toBe(true);
    expect(shouldRestoreFullAnnotationReaderFocus(true, false, false)).toBe(false);
    expect(shouldRestoreFullAnnotationReaderFocus(true, true, true)).toBe(false);
    expect(shouldRestoreFullAnnotationReaderFocus(false, false, true)).toBe(false);
  });

  it('keeps replacement source and proposal distinct in the shared row content', () => {
    expect(annotationListContent(replacement)).toEqual({
      sourceText: 'imprecise source',
      sourceTreatment: 'struck',
      content: 'precise replacement',
    });
    const html = renderToStaticMarkup(<AnnotationRowContent
      item={replacement}
      onNavigate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />);
    expect(html).toContain('data-source-treatment="struck"');
    expect(html).toContain('imprecise source');
    expect(html).toContain('precise replacement');
    expect(html).not.toContain('>Replace</strong>');
  });

  it('uses a compact type/page header and complete body for owned records', () => {
    const record = projectOwnedAnnotationReader(replacement)!;
    const html = renderToStaticMarkup(<FullAnnotationReader record={record} onBack={vi.fn()} onEdit={vi.fn()} />);
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('annotation-item__page">4</span>');
    expect(html).toContain('precise replacement');
    expect(html).not.toContain('Read only');
    expect(html).not.toContain('full-annotation-reader__provenance');
  });

  it('keeps imported provenance inline and never exposes edit', () => {
    const record = projectExistingAnnotationReader({
      id: 'source-1', subtype: 'Highlight', pageIndex: 4,
      rect: { x: 1, y: 2, width: 3, height: 4 }, contents: 'Complete imported note.',
      author: 'Reviewer', flags: [], appearanceModes: [], supportedAppearance: true,
    }, { documentGeneration: 2, discoveryGeneration: 3 })!;
    const html = renderToStaticMarkup(<FullAnnotationReader record={record} onBack={vi.fn()} />);
    expect(html).toContain('Read only');
    expect(html).toContain('Complete imported note.');
    expect(html).not.toContain('data-full-annotation-action="edit"');
    expect(html).not.toContain('From this PDF');
  });
});
