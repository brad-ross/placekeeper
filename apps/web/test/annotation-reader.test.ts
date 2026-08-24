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

describe('annotation reader authored-content projection', () => {
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

  it.each([
    owned('delete', { quote: 'A long source passage must remain navigation-only.' }),
    owned('highlight', { quote: 'A long highlighted source passage.' }),
    owned('highlight', { comment: '   ', quote: 'A long highlighted source passage.' }),
    owned('replace', { quote: 'Original text without proposed text.' }),
    owned('insert', { proposedText: 42, quote: 'Source anchor.' }),
    owned('pageNote', { comment: null, quote: 'Nearby source.' }),
  ])('rejects source-only or missing authored content for $kind', (item) => {
    expect(projectOwnedAnnotationReader(item)).toBeNull();
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
  });
});

describe('annotation reader identity resolution', () => {
  const ownedItem = owned('replace', {
    proposedText: 'Current replacement.',
    quote: 'Never expose this source text.',
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

  it('fails closed when an owned item disappears or loses authored content', () => {
    const identity: AnnotationReaderIdentity = { origin: 'owned', itemId: 'owned-live' };

    expect(resolveAnnotationReader(identity, { ...sources, ownedItems: [] })).toBeNull();
    expect(resolveAnnotationReader(identity, {
      ...sources,
      ownedItems: [{ ...ownedItem, payload: { quote: 'Source only.' } }],
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
});
