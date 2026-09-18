import { describe, expect, it } from 'vitest';

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
