import {
  anchorEvidenceFromReviewItem,
  normalizeReviewSelectionAnchor,
  type ReviewItem,
  type ReviewSelectionPageEvidenceV1,
} from './review-model.js';

export const PORTABLE_ANNOTATION_MAX_BYTES = 32 * 1024;

export const PORTABLE_ANNOTATION_TOO_LARGE_MESSAGE =
  'This annotation contains too much text or geometry to preserve as editable metadata. Shorten it and try again.';

export interface SerializedPortableAnnotationChild {
  readonly pageIndex: number;
  readonly projectionIndex: number;
  readonly projectionCount: number;
  readonly projectionId: string;
  readonly custom: {
    readonly placekeeper: {
      readonly schemaVersion: 3;
      readonly owner: 'placekeeper';
      readonly itemId: string;
      readonly projectionId: string;
      readonly projectionIndex: number;
      readonly projectionCount: number;
      readonly item: ReviewItem;
      readonly projection: {
        readonly id: string;
        readonly pageIndex: number;
        readonly subtype: 'strikeOut' | 'highlight';
        readonly contents: string;
        readonly author: 'Placekeeper';
        readonly rect: ReviewSelectionPageEvidenceV1['rect'];
        readonly segmentRects: ReviewSelectionPageEvidenceV1['segmentRects'];
        readonly quote: string;
        readonly prefix: string;
        readonly suffix: string;
      };
    };
  };
  readonly serialized: string;
  readonly byteLength: number;
}

export class PortableAnnotationGroupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortableAnnotationGroupError';
  }
}

/**
 * Build the deterministic final metadata carried by every physical page child.
 * Writer/importer code and pre-acknowledgement validation share this exact contract.
 */
export function serializePortableAnnotationGroup(
  item: ReviewItem,
): readonly SerializedPortableAnnotationChild[] {
  const anchor = anchorEvidenceFromReviewItem(item);
  if (anchor.kind !== 'selection') return [];
  const canonical = normalizeReviewSelectionAnchor(anchor);
  const projectionCount = canonical.pages.length;
  const {
    prefix: _legacyPrefix,
    suffix: _legacySuffix,
    rect: _legacyRect,
    segmentRects: _legacySegmentRects,
    pages: _canonicalPages,
    ...canonicalPayload
  } = item.payload;
  const {
    reconciliation: _runtimeReconciliation,
    ...portableItem
  } = item;
  const canonicalItem: ReviewItem = {
    ...portableItem,
    payload: canonicalPayload,
  };
  const contents = item.kind === 'replace'
    ? String(item.payload.proposedText ?? '')
    : item.kind === 'highlight'
      ? String(item.payload.comment ?? '')
      : '';
  return canonical.pages.map((page, projectionIndex) => {
    const projectionId = projectionCount === 1
      ? item.id
      : `${item.id}:projection:${projectionIndex + 1}`;
    const custom = {
      placekeeper: {
        schemaVersion: 3 as const,
        owner: 'placekeeper' as const,
        itemId: item.id,
        projectionId,
        projectionIndex,
        projectionCount,
        item: canonicalItem,
        projection: {
          id: projectionId,
          pageIndex: page.pageIndex,
          subtype: item.kind === 'highlight' ? 'highlight' as const : 'strikeOut' as const,
          contents,
          author: 'Placekeeper' as const,
          rect: page.rect,
          segmentRects: page.segmentRects,
          quote: page.quote,
          prefix: page.prefix,
          suffix: page.suffix,
        },
      },
    };
    const serialized = JSON.stringify(custom);
    return {
      pageIndex: page.pageIndex,
      projectionIndex,
      projectionCount,
      projectionId,
      custom,
      serialized,
      byteLength: new TextEncoder().encode(serialized).byteLength,
    };
  });
}

export function assertPortableAnnotationGroupWritable(item: ReviewItem): void {
  if (
    serializePortableAnnotationGroup(item)
      .some(({ byteLength }) => byteLength > PORTABLE_ANNOTATION_MAX_BYTES)
  ) {
    throw new PortableAnnotationGroupError(PORTABLE_ANNOTATION_TOO_LARGE_MESSAGE);
  }
}
