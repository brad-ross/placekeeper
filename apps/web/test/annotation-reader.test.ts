import { describe, expect, it } from 'vitest';

import type { ReviewItem, ReviewItemKind } from '../../../packages/core/src/review-model.js';
import type { ExistingAnnotation } from '../src/pdf/existing-annotations.js';
import {
  projectExistingAnnotationReader,
  projectOwnedAnnotationReader,
  resolveAnnotationReader,
  type AnnotationReaderIdentity,
} from '../src/review/annotation-reader.js';

function owned(
  kind: ReviewItemKind,
  payload: ReviewItem['payload'],
  id = `owned-${kind}`,
): ReviewItem {
  return {
    id,
    kind,
    pageIndex: 2,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    payload,
  };
}

const existing: ExistingAnnotation = {
  id: 'existing-highlight',
  subtype: 'Highlight',
  pageIndex: 4,
  rect: { x: 1, y: 2, width: 3, height: 4 },
  contents: 'Imported reviewer feedback.',
  author: 'Ada Reviewer',
  flags: [],
  appearanceModes: [],
  supportedAppearance: true,
};

describe('annotation reader complete-content projection', () => {
  it.each([
    ['replace', { proposedText: 'Use the precise replacement.', quote: 'Source passage.' }, 'Replacement text'],
    ['insert', { proposedText: 'Add this sentence.', quote: 'Source anchor.' }, 'Insertion text'],
    ['highlight', { comment: 'Explain this inference.', quote: 'Highlighted source.' }, 'Comment'],
    ['pageNote', { comment: 'Revisit the structure of this page.', quote: 'Nearby source.' }, 'Page note'],
  ] satisfies readonly [ReviewItemKind, ReviewItem['payload'], string][]) (
    'projects authored %s content without source-text fallback',
    (kind, payload, contentLabel) => {
      const record = projectOwnedAnnotationReader(owned(kind, payload), 'Identification');

      expect(record).toMatchObject({
        identity: { origin: 'owned', itemId: `owned-${kind}` },
        origin: 'owned',
        kind,
        pageNumber: 3,
        sectionLabel: 'Identification',
        contentLabel,
        mutable: true,
      });
      expect(record?.content).toBe(kind === 'replace'
        ? 'Use the precise replacement.'
        : kind === 'insert'
          ? 'Add this sentence.'
          : kind === 'highlight'
            ? 'Explain this inference.'
            : 'Revisit the structure of this page.');
      expect(record?.content).not.toContain('Source');
    },
  );

  it('keeps native comments and locks in the shared card and reader projection', () => {
    const item = owned('pdfAnnotation', { comment: 'Native reviewer comment.', subtype: 'Highlight', contentsLocked: true });
    expect(projectOwnedAnnotationReader(item)).toMatchObject({
      content: 'Native reviewer comment.', contentLabel: 'Comment', typeLabel: 'Highlight', mutable: false,
    });
    expect(projectOwnedAnnotationReader(owned('pdfAnnotation', { comment: '', subtype: 'Highlight' }))).toBeNull();
  });

  it.each([
    owned('delete', { quote: 'A long deleted source passage.' }),
    owned('highlight', { quote: 'A long highlighted source passage.' }),
    owned('highlight', { comment: '   ', quote: 'A long highlighted source passage.' }),
    owned('replace', { quote: 'Original text without proposed text.' }),
    owned('insert', { proposedText: 42, quote: 'Source anchor.' }),
    owned('pageNote', { comment: null, quote: 'Nearby source.' }),
  ])('preserves source-only card content for $kind', (item) => {
    const record = projectOwnedAnnotationReader(item);
    expect(record).not.toBeNull();
    expect([record?.content, record?.sourceText, record?.quoteText]).toContain(item.payload.quote);
  });

  it.each(['delete', 'highlight', 'replace', 'insert', 'pageNote'] as const)('rejects empty %s content', (kind) => {
    expect(projectOwnedAnnotationReader(owned(kind, {}))).toBeNull();
  });

  it('projects imported contents and available author as read-only', () => {
    expect(projectExistingAnnotationReader(existing, {
      documentGeneration: 7,
      discoveryGeneration: 11,
      sectionLabel: 'Appendix',
    })).toEqual({
      identity: {
        origin: 'source',
        annotationKey: '4:existing-highlight',
        documentGeneration: 7,
        discoveryGeneration: 11,
      },
      origin: 'source',
      kind: 'Highlight',
      typeLabel: 'Highlight',
      pageNumber: 5,
      sectionLabel: 'Appendix',
      author: 'Ada Reviewer',
      contentLabel: 'Annotation contents',
      content: 'Imported reviewer feedback.',
      mutable: false,
    });
  });

  it('omits unavailable imported metadata and rejects empty contents', () => {
    const withoutMetadata: ExistingAnnotation = {
        id: 'no-author',
        subtype: 'Text',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        contents: 'A note.',
        author: '   ',
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      };
    const withoutContents: ExistingAnnotation = {
        id: 'no-contents',
        subtype: 'Highlight',
        pageIndex: 0,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        contents: '   ',
        author: '',
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      };

    expect(projectExistingAnnotationReader(withoutMetadata, {
      documentGeneration: 1,
      discoveryGeneration: 2,
    })).not.toHaveProperty('author');
    expect(projectExistingAnnotationReader(withoutMetadata, {
      documentGeneration: 1,
      discoveryGeneration: 2,
    })).not.toHaveProperty('sectionLabel');
    expect(projectExistingAnnotationReader(withoutContents, {
      documentGeneration: 1,
      discoveryGeneration: 2,
    })).toBeNull();
    expect(projectExistingAnnotationReader(withoutContents, {
      documentGeneration: 1,
      discoveryGeneration: 2,
      includeMetadataOnly: true,
    })).toMatchObject({
      origin: 'source',
      kind: 'Highlight',
      pageNumber: 1,
      content: '',
      mutable: false,
    });
  });
});

describe('annotation reader identity resolution', () => {
  const ownedItem = owned('replace', {
    proposedText: 'Current replacement.',
    quote: 'Original source text.',
  }, 'owned-live');

  const sources = {
    ownedItems: [ownedItem],
    existingAnnotations: {
      status: 'ready' as const,
      generation: 11,
      items: [existing],
    },
    documentGeneration: 7,
    ownedSectionLabels: new Map([['owned-live', 'Results']]),
    sourceSectionLabels: new Map([['4:existing-highlight', 'Appendix']]),
  };

  it('resolves identities against current data instead of retaining copied records', () => {
    const identity: AnnotationReaderIdentity = { origin: 'owned', itemId: 'owned-live' };

    expect(resolveAnnotationReader(identity, sources)).toMatchObject({
      content: 'Current replacement.',
      sectionLabel: 'Results',
    });
    expect(resolveAnnotationReader(identity, {
      ...sources,
      ownedItems: [{
        ...ownedItem,
        payload: { ...ownedItem.payload, proposedText: 'Accepted replacement.' },
      }],
    })).toMatchObject({ content: 'Accepted replacement.' });
  });

  it('fails closed when an owned item disappears or loses all content', () => {
    const identity: AnnotationReaderIdentity = { origin: 'owned', itemId: 'owned-live' };

    expect(resolveAnnotationReader(identity, { ...sources, ownedItems: [] })).toBeNull();
    expect(resolveAnnotationReader(identity, {
      ...sources,
      ownedItems: [{ ...ownedItem, payload: {} }],
    })).toBeNull();
  });

  it('resolves an imported identity only under its current document and discovery authority', () => {
    const identity: AnnotationReaderIdentity = {
      origin: 'source',
      annotationKey: '4:existing-highlight',
      documentGeneration: 7,
      discoveryGeneration: 11,
    };

    expect(resolveAnnotationReader(identity, sources)).toMatchObject({
      content: 'Imported reviewer feedback.',
      author: 'Ada Reviewer',
      sectionLabel: 'Appendix',
      mutable: false,
    });
    expect(resolveAnnotationReader(identity, { ...sources, documentGeneration: 8 })).toBeNull();
    expect(resolveAnnotationReader(identity, {
      ...sources,
      existingAnnotations: { ...sources.existingAnnotations, generation: 12 },
    })).toBeNull();
    expect(resolveAnnotationReader(identity, {
      ...sources,
      existingAnnotations: { status: 'loading', generation: 11 },
    })).toBeNull();
  });

  it('opts metadata-only source records into reference inspection without changing the default', () => {
    const metadataOnly = { ...existing, id: 'metadata-only', contents: '   ' };
    const identity: AnnotationReaderIdentity = {
      origin: 'source',
      annotationKey: '4:metadata-only',
      documentGeneration: 7,
      discoveryGeneration: 11,
    };
    const metadataSources = {
      ...sources,
      existingAnnotations: { ...sources.existingAnnotations, items: [metadataOnly] },
    };

    expect(resolveAnnotationReader(identity, metadataSources)).toBeNull();
    expect(resolveAnnotationReader(identity, {
      ...metadataSources,
      includeMetadataOnly: true,
    })).toMatchObject({ content: '', mutable: false, pageNumber: 5 });
  });
});
