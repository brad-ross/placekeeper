import { PdfActionType, PdfZoomMode } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  PdfOutlineDiscoveryAuthority,
  discoverPdfOutline,
} from '../src/pdf/pdf-outline.js';

const destination = (pageIndex: number) => ({
  type: 'destination' as const,
  destination: {
    pageIndex,
    zoom: { mode: PdfZoomMode.Unknown as const },
    view: [],
  },
});

describe('embedded PDF outline discovery', () => {
  it('classifies nested bookmarks, neutralizes hostile labels, and keeps unsafe groups inert', async () => {
    const result = await discoverPdfOutline({
      bookmarks: [{
        title: '\u202e<Parent>',
        target: { type: 'action', action: { type: PdfActionType.URI, uri: 'https://example.invalid' } },
        children: [{ title: '<Safe\u0000 child>', target: destination(2) }],
      }],
      documentGeneration: 7,
      pageCount: 4,
    });

    expect(result).toEqual({
      status: 'loaded-tree', documentGeneration: 7,
      items: [{
        id: 'outline-0', label: 'Parent', pageContext: null, target: null,
        children: [{
          id: 'outline-0-0', label: 'Safe child', pageContext: 'Page 3',
          target: expect.objectContaining({ documentGeneration: 7, pageIndex: 2 }), children: [],
        }],
      }],
    });
  });

  it('publishes empty/unavailable and ignores stale generations', () => {
    const authority = new PdfOutlineDiscoveryAuthority();
    const first = authority.begin(1);
    const second = authority.begin(2);

    expect(authority.loaded(first, [])).toBeNull();
    expect(authority.loaded(second, [])).toEqual({ status: 'loaded-empty', documentGeneration: 2 });
    const third = authority.begin(3);
    expect(authority.unavailable(third)).toEqual({ status: 'unavailable', documentGeneration: 3 });
  });
});
