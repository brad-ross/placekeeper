import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewItem } from '../../../packages/core/src/review-model.js';
import {
  AnnotationList,
  AnnotationRowContent,
  annotationListContent,
  combinedDocumentOrderedAnnotations,
} from '../src/review/AnnotationList.js';
import { AnnotationPeek, AnnotationRecordPeek } from '../src/review/AnnotationPeek.js';
import { ContextActionPalette } from '../src/review/ContextActionPalette.js';
import {
  FullAnnotationReader,
  shouldRestoreFullAnnotationReaderFocus,
} from '../src/review/FullAnnotationReader.js';
import { ReviewIcon } from '../src/review/ReviewIcon.js';
import { projectExistingAnnotationReader, projectOwnedAnnotationReader } from '../src/review/annotation-reader.js';

const replacement: ReviewItem = {
  id: 'replace-1',
  kind: 'replace',
  pageIndex: 3,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  payload: { quote: 'imprecise source', proposedText: 'precise replacement' },
};

const highlightWithComment: ReviewItem = {
  ...replacement,
  id: 'highlight-with-comment',
  kind: 'highlight',
  payload: { comment: 'Explain why this identifies the coefficient.', quote: 'Local variation identifies demand.' },
};

const highlightWithoutComment: ReviewItem = {
  ...replacement,
  id: 'highlight-without-comment',
  kind: 'highlight',
  payload: { quote: 'Local variation identifies demand.' },
};

describe('annotation row and reader presentation', () => {
  it('interleaves owned and source-PDF rows by page and geometry', () => {
    const owned = {
      ...replacement,
      id: 'owned-middle',
      pageIndex: 0,
      payload: { quote: 'Owned middle', proposedText: 'Owned middle', rect: { x: 10, y: 50, width: 20, height: 10 } },
    };
    const source = (id: string, pageIndex: number, y: number) => ({
      id, subtype: 'Highlight', pageIndex,
      rect: { x: 10, y, width: 20, height: 10 }, contents: id,
      author: '', flags: [], appearanceModes: [], supportedAppearance: true,
    });
    const discovery = {
      status: 'ready' as const,
      generation: 7,
      items: [source('source-last', 1, 10), source('source-first', 0, 20)],
    };

    expect(combinedDocumentOrderedAnnotations([owned], discovery).map((entry) =>
      entry.origin === 'owned' ? entry.item.id : entry.annotation.id,
    )).toEqual(['source-first', 'owned-middle', 'source-last']);
  });

  it('renders a source-PDF row in the shared list with immutable identity and no actions', () => {
    const html = renderToStaticMarkup(<AnnotationList
      items={[]}
      existingAnnotations={{
        status: 'ready', generation: 3,
        items: [{
          id: 'source-1', subtype: 'Highlight', pageIndex: 4,
          rect: { x: 1, y: 2, width: 3, height: 4 }, contents: 'Imported note.',
          author: 'Reviewer', flags: [], appearanceModes: [], supportedAppearance: true,
        }],
      }}
      documentGeneration={2}
      activeExistingAnnotationKey="4:source-1"
      onNavigate={() => undefined}
      onNavigateExisting={() => undefined}
      onEdit={() => undefined}
      onDelete={() => undefined}
    />);

    expect(html.match(/<ol/gu)).toHaveLength(1);
    expect(html).toContain('aria-label="Annotations in document order"');
    expect(html).toContain('data-existing-annotation-key="4:source-1"');
    expect(html).toContain('data-annotation-origin="source"');
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain('Imported note.');
    expect(html).not.toContain('row-action-group');
    expect(html).not.toContain('From this PDF');
  });

  it('offers Open in References for owned and read-only source rows without broadening edit permissions', () => {
    const ownedHtml = renderToStaticMarkup(<AnnotationList
      items={[replacement]}
      onNavigate={vi.fn()}
      onOpenReference={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />);
    const sourceHtml = renderToStaticMarkup(<AnnotationList
      items={[]}
      existingAnnotations={{
        status: 'ready', generation: 3,
        items: [{
          id: 'source-nav', subtype: 'Highlight', pageIndex: 4,
          rect: { x: 1, y: 2, width: 3, height: 4 }, contents: '',
          author: '', flags: [], appearanceModes: [], supportedAppearance: true,
        }],
      }}
      documentGeneration={2}
      onNavigate={vi.fn()}
      onOpenExistingReference={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />);

    expect(ownedHtml).toContain('data-row-action="open-reference"');
    expect(ownedHtml).toContain('aria-label="Open in References"');
    expect(sourceHtml).toContain('data-row-action="open-reference"');
    expect(sourceHtml).toContain('aria-label="Open in References"');
    expect(sourceHtml).not.toContain('data-row-action="edit"');
    expect(sourceHtml).not.toContain('data-row-action="delete"');
  });

  it('threads Open in References through peeks and full readers', () => {
    const peek = renderToStaticMarkup(<AnnotationPeek
      item={replacement}
      onHoldChange={vi.fn()}
      onOpenReference={vi.fn()}
    />);
    const full = renderToStaticMarkup(<FullAnnotationReader
      record={projectOwnedAnnotationReader(replacement)!}
      onBack={vi.fn()}
      onOpenReference={vi.fn()}
    />);

    expect(peek).toContain('data-row-action="open-reference"');
    expect(full).toContain('data-full-annotation-action="open-reference"');
    expect(full).toContain('aria-label="Open in References"');
  });

  it('projects a read-only source record through the shared peek card', () => {
    const record = projectExistingAnnotationReader({
      id: 'source-peek', subtype: 'Highlight', pageIndex: 4,
      rect: { x: 1, y: 2, width: 3, height: 4 }, contents: 'Complete imported note.',
      author: 'Reviewer', flags: [], appearanceModes: [], supportedAppearance: true,
    }, { documentGeneration: 2, discoveryGeneration: 3 })!;
    const html = renderToStaticMarkup(<AnnotationRecordPeek
      record={record}
      selected
      onHoldChange={vi.fn()}
      onOpenReference={vi.fn()}
    />);

    expect(html).toContain('data-annotation-origin="source"');
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain('data-annotation-kind="Highlight"');
    expect(html).toContain('data-row-action="open-reference"');
    expect(html).toContain('Complete imported note.');
    expect(html).not.toContain('data-row-action="edit"');
    expect(html).not.toContain('data-row-action="delete"');
    expect(html).not.toContain('aria-label="Back"');
  });

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
    expect(html).toContain('data-annotation-metadata-layout="row-head"');
    expect(html).toContain('imprecise source');
    expect(html).toContain('precise replacement');
    expect(html).not.toContain('>Replace</strong>');
  });

  it('renders a highlight comment followed by its supporting quote in rows and peeks', () => {
    expect(annotationListContent(highlightWithComment)).toEqual({
      content: 'Explain why this identifies the coefficient.',
      quoteText: 'Local variation identifies demand.',
    });
    const rowHtml = renderToStaticMarkup(<AnnotationRowContent item={highlightWithComment} />);
    expect(rowHtml.indexOf('Explain why this identifies the coefficient.'))
      .toBeLessThan(rowHtml.indexOf('Local variation identifies demand.'));
    expect(rowHtml).toContain('class="annotation-item__quote" data-quote-only="false"');

    const peekHtml = renderToStaticMarkup(<AnnotationPeek
      item={highlightWithComment}
      onHoldChange={vi.fn()}
    />);
    expect(peekHtml).toContain('class="annotation-item__quote"');

    const reader = projectOwnedAnnotationReader(highlightWithComment)!;
    expect(reader.content).toBe('Explain why this identifies the coefficient.');
    expect(reader.content).not.toContain('Local variation identifies demand.');
  });

  it('keeps Main native annotation subtype metadata when no peek override is supplied', () => {
    const nativeHighlight: ReviewItem = {
      ...replacement,
      id: 'native-highlight',
      kind: 'pdfAnnotation',
      payload: { subtype: 'Highlight', comment: 'Native highlight comment.' },
    };
    const html = renderToStaticMarkup(<AnnotationPeek
      item={nativeHighlight}
      selected
      onHoldChange={vi.fn()}
      onEdit={vi.fn()}
    />);

    expect(html).toContain('title="Highlight"');
    expect(html).toContain('aria-label="Edit Highlight annotation on page 4"');
    expect(html).not.toContain('Edit PDF annotation annotation');

    const referenceHtml = renderToStaticMarkup(<AnnotationRecordPeek
      record={projectOwnedAnnotationReader(nativeHighlight)!}
      item={nativeHighlight}
      selected
      onHoldChange={vi.fn()}
      onEdit={vi.fn()}
    />);
    expect(referenceHtml).toContain('title="Highlight"');
    expect(referenceHtml).toContain('aria-label="Edit Highlight annotation on page 4"');
  });

  it('uses a quote-only treatment for highlights without an authored comment', () => {
    expect(annotationListContent(highlightWithoutComment)).toEqual({
      content: '',
      quoteText: 'Local variation identifies demand.',
    });
    const html = renderToStaticMarkup(<AnnotationRowContent item={highlightWithoutComment} />);
    expect(html).toContain('class="annotation-item__quote" data-quote-only="true"');
    expect(html).toContain('data-full-annotation-eligible="false"');
    expect(projectOwnedAnnotationReader(highlightWithoutComment)?.quoteText).toBe('Local variation identifies demand.');
  });

  it('uses a compact type/page header and complete body for owned records', () => {
    const record = projectOwnedAnnotationReader(replacement)!;
    const html = renderToStaticMarkup(<FullAnnotationReader
      record={record}
      onBack={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />);
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('annotation-item__page">4</span>');
    expect(html).toContain('precise replacement');
    expect(html).not.toContain('Read only');
    expect(html).not.toContain('full-annotation-reader__provenance');
    expect(html.indexOf('data-full-annotation-action="edit"'))
      .toBeLessThan(html.indexOf('data-full-annotation-action="delete"'));
    expect(html).toMatch(/data-full-annotation-action="delete"[\s\S]*?lucide-trash-2/u);
    expect(html.match(/width="16" height="16"/gu)).toHaveLength(4);
  });

  it('keeps imported provenance inline and never exposes edit', () => {
    const record = projectExistingAnnotationReader({
      id: 'source-1', subtype: 'Highlight', pageIndex: 4,
      rect: { x: 1, y: 2, width: 3, height: 4 }, contents: 'Complete imported note.',
      author: 'Reviewer', flags: [], appearanceModes: [], supportedAppearance: true,
    }, { documentGeneration: 2, discoveryGeneration: 3 })!;
    const html = renderToStaticMarkup(<FullAnnotationReader
      record={record}
      onBack={vi.fn()}
      onOpenReference={vi.fn()}
    />);
    expect(html).toContain('Read only');
    expect(html).toContain('Complete imported note.');
    expect(html).toContain('data-full-annotation-action="open-reference"');
    expect(html).not.toContain('data-full-annotation-action="edit"');
    expect(html).not.toContain('data-full-annotation-action="delete"');
    expect(html).not.toContain('From this PDF');
  });

  it('preserves paragraph breaks as separate blocks in the full reader', () => {
    const record = { ...projectOwnedAnnotationReader(replacement)!, content: 'First paragraph.\n\nSecond paragraph.' };
    const html = renderToStaticMarkup(<FullAnnotationReader record={record} onBack={vi.fn()} />);
    expect(html).toContain('<p>First paragraph.</p><p>Second paragraph.</p>');
  });

  it('uses a trash can for annotation deletion while retaining the zoom minus glyph', () => {
    const palette = renderToStaticMarkup(<ContextActionPalette
      placement={{ left: 10, top: 20 }}
      onDelete={vi.fn()}
    />);
    expect(palette).toMatch(/aria-label="Delete"[\s\S]*?lucide-trash-2/u);
    expect(palette).not.toMatch(/aria-label="Delete"[\s\S]*?lucide-minus/u);

    const deletion: ReviewItem = {
      ...replacement,
      id: 'delete-1',
      kind: 'delete',
      payload: { quote: 'remove this text' },
    };
    const row = renderToStaticMarkup(<AnnotationRowContent item={deletion} />);
    expect(row).toContain('data-annotation-kind-icon="delete"');
    expect(row).toContain('lucide-trash-2');
    expect(renderToStaticMarkup(<ReviewIcon name="minus" />)).toContain('lucide-minus');
  });
});

it.each([
  replacement,
  highlightWithComment,
  highlightWithoutComment,
  { ...replacement, kind: 'delete' as const, payload: { quote: 'Deleted original passage.' } },
])('full $kind reader retains the complete source passage', (item) => {
  const record = projectOwnedAnnotationReader(item);
  expect(record).not.toBeNull();
  const html = renderToStaticMarkup(<FullAnnotationReader record={record!} onBack={vi.fn()} />);
  expect(html).toContain(item.payload.quote);
});
