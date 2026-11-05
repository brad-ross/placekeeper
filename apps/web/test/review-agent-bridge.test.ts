import { describe, expect, it } from 'vitest';
import { createReviewState } from '../../../packages/core/src/review-model.js';
import { reviewAgentSnapshot, reviewAgentSearchResult } from '../src/host/review-agent-bridge.js';
import { initialPdfSearchState } from '../src/pdf/pdf-search-model.js';

describe('review agent context', () => {
  it('publishes accepted annotation text and one-based selection pages without source paths', () => {
    const state = createReviewState({ sessionId: 'review', source: { fileId: 'file', digest: 'digest', byteLength: 10 } });
    const snapshot = reviewAgentSnapshot({
      state: { ...state, revision: 4, items: [{ id: 'note', kind: 'pageNote', pageIndex: 2, payload: { comment: 'Check this claim', position: { x: 72, y: 92, width: 20, height: 20 } }, createdAt: '', updatedAt: '' }] },
      title: 'Paper', page: 3, pageCount: 8,
      selection: { kind: 'reliable', generation: 2, anchor: { reliable: true, pageIndex: 1, quote: 'Selected text', prefix: '', suffix: '', rect: { x: 0, y: 0, width: 1, height: 1 }, segmentRects: [] } },
      selectionIsCurrent: true, activeAnnotationId: 'note',
    });
    expect(snapshot).toMatchObject({ reviewRevision: 4, page: 3, source: { fileId: 'file', digest: 'digest' }, selection: { text: 'Selected text', pages: [2] }, annotations: [{ id: 'note', page: 3, kind: 'pageNote', text: 'Check this claim' }], activeAnnotationId: 'note' });
    expect(snapshot.source).not.toHaveProperty('path');
  });

  it('does not share a selection after its document or reference surface is replaced', () => {
    const state = createReviewState({ sessionId: 'review', source: { fileId: 'file', digest: 'digest', byteLength: 10 } });
    const snapshot = reviewAgentSnapshot({ state, title: 'Paper', page: 1, pageCount: 3, selection: { kind: 'pending', generation: 1 }, selectionIsCurrent: false });
    expect(snapshot.selection).toBeNull();
  });

  it('reports incomplete coverage and bounded results without claiming a full search', () => {
    const results = Array.from({ length: 105 }, (_, index) => ({ id: String(index), pageIndex: 1, charIndex: index, charCount: 1, navigationPoint: { x: 0, y: 0 }, rects: [], excerpt: 'match', excerptMatch: { start: 0, length: 5 }, kind: 'exact' as const, matchedForm: 'match' }));
    const result = reviewAgentSearchResult({ ...initialPdfSearchState(4), status: 'partial', message: 'One page could not be read', coverage: { totalPages: 4, searchedPages: 3, unsearchablePages: [2], limitedPages: [3] }, groups: [{ id: 'exact', label: 'Exact', results }] }, 9);
    expect(result).toMatchObject({ documentGeneration: 9, status: 'partial', totalResults: 105, truncated: true, coverage: { searchedPages: 3, unsearchablePages: [3], limitedPages: [4] } });
    expect(result.results).toHaveLength(100);
    expect(result.results[0]).toEqual({ id: '0', page: 2, excerpt: 'match', matchKind: 'exact' });
  });
});
