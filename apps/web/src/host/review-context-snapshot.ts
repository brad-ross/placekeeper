import { anchorEvidenceFromReviewItem, type ReviewStateView } from '../../../../packages/core/src/review-model.js';
import type { SelectionUpdate } from '../pdf/selection-state.js';

/** Document-derived strings are data. The host adapter supplies their trust boundary. */
export interface ReviewContextSnapshot {
  readonly documentGeneration: number;
  readonly reviewRevision: number;
  readonly title: string;
  readonly source: { readonly fileId: string; readonly digest: string };
  /** One-based page numbers; zero means the viewer is not ready. */
  readonly page: number;
  readonly pageCount: number;
  readonly selection: { readonly text: string; readonly pages: readonly number[] } | null;
  readonly activeAnnotationId?: string;
  readonly annotations: readonly { readonly id: string; readonly page: number; readonly kind: string; readonly text: string }[];
}

export function reviewContextSnapshot(input: {
  readonly state: ReviewStateView;
  readonly title: string;
  readonly page: number;
  readonly pageCount: number;
  readonly selection: SelectionUpdate;
  readonly selectionIsCurrent: boolean;
  readonly activeAnnotationId?: string;
}): ReviewContextSnapshot {
  const { state, selection } = input;
  return {
    documentGeneration: state.workflow.documentGeneration,
    reviewRevision: state.revision,
    title: input.title,
    source: { fileId: state.source.fileId, digest: state.source.digest },
    page: input.page,
    pageCount: input.pageCount,
    selection: input.selectionIsCurrent && selection.kind === 'reliable'
      ? { text: selection.anchor.quote, pages: (selection.anchor.pages ?? [selection.anchor]).map(page => page.pageIndex + 1) }
      : null,
    ...(input.activeAnnotationId === undefined ? {} : { activeAnnotationId: input.activeAnnotationId }),
    annotations: state.items.map(item => {
      const anchor = anchorEvidenceFromReviewItem(item);
      const comment = item.payload[item.kind === 'replace' || item.kind === 'insert' ? 'proposedText' : 'comment'];
      const quote = anchor.kind === 'selection' ? anchor.quote : '';
      return { id: item.id, page: item.pageIndex + 1, kind: item.kind,
        text: [quote, typeof comment === 'string' ? comment : ''].filter(Boolean).join('\n') };
    }),
  };
}

