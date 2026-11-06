import type { DocumentContextController } from './document-in-context.js';
import type { PdfSearchState } from '../pdf/pdf-search-model.js';

export { reviewContextSnapshot as reviewAgentSnapshot } from './review-context-snapshot.js';
export type { ReviewContextSnapshot as ReviewAgentSnapshot } from './review-context-snapshot.js';
import type { ReviewContextSnapshot as ReviewAgentSnapshot } from './review-context-snapshot.js';

export type ReviewAgentTarget =
  | { readonly page: number; readonly documentGeneration: number }
  | { readonly resultId: string; readonly documentGeneration: number }
  | { readonly annotationId: string; readonly documentGeneration: number };

export interface ReviewAgentActions {
  snapshot(): ReviewAgentSnapshot;
  search(query: string): Promise<ReturnType<typeof reviewAgentSearchResult>>;
  navigate(target: ReviewAgentTarget): Promise<boolean>;
}

export type ReviewAgentContextInput = (
  | { readonly kind: 'selection'; readonly snapshot: ReviewAgentSnapshot }
  | { readonly kind: 'annotations'; readonly snapshot: ReviewAgentSnapshot; readonly annotationIds: readonly string[] }
) & { readonly note?: string };

export const MAX_REVIEW_CONTEXT_NOTE_LENGTH = 2000;

export interface ReviewAgentBridge {
  readonly documentContext?: DocumentContextController;
  attach(actions: ReviewAgentActions): () => void;
  /** Publish the captured evidence and optional user note as chat context. */
  addContext?(input: ReviewAgentContextInput): Promise<void>;
}

/** The reader retains every match for navigation; chat receives a bounded page with coverage. */
export function reviewAgentSearchResult(state: PdfSearchState, documentGeneration: number) {
  const results = state.groups.flatMap(group => group.results);
  return {
    documentGeneration,
    status: state.status,
    coverage: { ...state.coverage,
      unsearchablePages: state.coverage.unsearchablePages.map(page => page + 1),
      limitedPages: state.coverage.limitedPages.map(page => page + 1) },
    results: results.slice(0, 100).map(result => ({ id: result.id, page: result.pageIndex + 1, excerpt: result.excerpt.slice(0, 512), matchKind: result.kind })),
    totalResults: results.length,
    truncated: results.length > 100 || results.some(result => result.excerpt.length > 512),
    message: state.message,
  };
}
