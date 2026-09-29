import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createReviewState, type ReviewState } from '../../../packages/core/src/review-model.js';
import { ReviewShell } from '../src/app/ReviewShell.js';
import type { DestinationBand } from '../src/review/navigation-coordinator.js';

import {
  ExistingAnnotationDiscoveryAuthority,
  existingAnnotationKey,
  inventoryExistingAnnotations,
  mergeExistingAnnotations,
} from '../src/pdf/existing-annotations.js';

function source(id: string, contents = id) {
  return {
    id,
    subtype: 'Highlight',
    pageIndex: 0,
    rect: { x: 1, y: 2, width: 3, height: 4 },
    contents,
  };
}

function link(id: string) {
  return { ...source(id), subtype: 'Link' };
}

describe('existing annotation discovery state', () => {
  it('excludes navigation links from the external annotation inventory', () => {
    const discovered = inventoryExistingAnnotations([source('highlight'), link('discovered-link')]);
    const explicitLink = {
      ...inventoryExistingAnnotations([source('explicit-shape')])[0]!,
      id: 'explicit-link',
      subtype: 'link',
    };
    const mergedDiscoveredLink = {
      ...explicitLink,
      id: 'merged-discovered-link',
      subtype: 'LINK',
    };

    expect(discovered.map(({ id }) => id)).toEqual(['highlight']);
    expect(
      mergeExistingAnnotations([...discovered, mergedDiscoveredLink], [explicitLink])
        .map(({ id }) => id),
    ).toEqual(['highlight']);
  });

  it('deduplicates discovered and explicit inventory without changing the DTO', () => {
    const explicit = inventoryExistingAnnotations([source('same', 'explicit'), source('explicit')]);
    const discovered = inventoryExistingAnnotations([source('same', 'discovered'), source('discovered')]);

    expect(mergeExistingAnnotations(discovered, explicit).map(({ id, contents }) => [id, contents])).toEqual([
      ['same', 'discovered'],
      ['discovered', 'discovered'],
      ['explicit', 'explicit'],
    ]);
  });

  it('excludes editable owned annotations while preserving foreign annotations', () => {
    const owned = inventoryExistingAnnotations([source('owned')])[0]!;
    const foreign = {
      ...inventoryExistingAnnotations([source('owned')])[0]!,
      pageIndex: 1,
      author: 'Placekeeper',
    };

    expect(mergeExistingAnnotations([owned, foreign], [], [owned]).map(existingAnnotationKey)).toEqual([
      '1:owned',
    ]);
  });

  it('matches generation-scoped native annotations by their source object ordinal', () => {
    const discovered = inventoryExistingAnnotations([{
      ...source('ephemeral-browser-id'),
      sourceId: 'source-name',
      sourceObjectPageIndex: 0,
      sourceObjectAnnotationIndex: 3,
    }]);
    const owned = [{
      id: 'service-generation-id',
      pageIndex: 0,
      sourceObjectPageIndex: 0,
      sourceObjectAnnotationIndex: 3,
    }];

    expect(mergeExistingAnnotations(discovered, [], owned)).toEqual([]);
  });

  it('keeps loading, populated, empty, and error distinct and ignores stale generations', () => {
    const authority = new ExistingAnnotationDiscoveryAuthority();
    const first = authority.begin('document-a');
    const retry = authority.begin('document-a');

    expect(authority.ready(first, inventoryExistingAnnotations([source('stale')]), [])).toBeNull();
    expect(authority.ready(retry, [], [])).toEqual({ status: 'empty', generation: retry.generation, items: [] });

    const replacement = authority.begin('document-b');
    expect(authority.error(retry, new Error('old failure'))).toBeNull();
    expect(authority.error(replacement, new Error('inventory failed'))).toEqual({
      status: 'error',
      generation: replacement.generation,
      message: 'inventory failed',
    });

    const populated = authority.begin('document-b');
    expect(authority.ready(populated, inventoryExistingAnnotations([source('kept')]), [])).toMatchObject({
      status: 'ready',
      generation: populated.generation,
      items: [{ id: 'kept' }],
    });
  });
});

describe('Destination Bands and annotation projections', () => {
  const band: DestinationBand = {
    documentGeneration: 1,
    targetIdentity: 'band-target-p14',
    pageIndex: 13,
    rects: [{ origin: { x: 72, y: 100 }, size: { width: 400, height: 12 } }],
  };
  const reviewState: ReviewState = {
    ...createReviewState({
      sessionId: 'band-session',
      source: { fileId: 'paper', digest: 'b'.repeat(64), byteLength: 10 },
    }),
    items: [{
      id: 'note-1', kind: 'pageNote', pageIndex: 2,
      createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
      payload: { comment: 'Reader note' },
    }],
  };
  const inventory = inventoryExistingAnnotations([source('reader-highlight'), link('citation-link')]);

  // Bands reach the shell only inside the rendered viewer, as they do in production.
  function annotationsList(bands: boolean): string {
    return renderToStaticMarkup(createElement(ReviewShell, {
      state: reviewState,
      save: {},
      selection: { selectionUpdate: { kind: 'cleared', generation: 0 } },
      authoring: { onCommand: async () => reviewState },
      viewer: {},
      existingAnnotations: { status: 'ready', generation: 1, items: inventory },
      workspace: { listOpen: true },
    }, createElement(
      'div',
      { 'data-annotation-surface': 'main' },
      'Main document',
      bands ? createElement('div', {
        'data-pdf-destination-band-layer': '',
        'data-destination-target': band.targetIdentity,
      }) : null,
    )));
  }

  it('Covers AE6. a present band adds nothing to the existing-annotation inventory or the Annotations list', () => {
    expect(inventory.map(({ id }) => id)).toEqual(['reader-highlight']);
    const withBands = annotationsList(true);
    expect(withBands).toContain('Reader note');
    // The band appears once, in the viewer, and nowhere in the Annotations list.
    expect(withBands.split('band-target-p14')).toHaveLength(2);
    expect(withBands.replace(
      /<div data-pdf-destination-band-layer="" data-destination-target="band-target-p14"><\/div>/u,
      '',
    )).toBe(annotationsList(false));
  });
});
