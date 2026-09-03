import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { annotationKindLabel } from './AnnotationMetadata.js';
import { CopyLinkControl, type CopyLinkControlProps } from './CopyLinkControl.js';
import { reviewItemPageRange } from './annotation-projection.js';

function meaningfulPayload(item: ReviewItem): string {
  for (const field of ['proposedText', 'comment', 'quote', 'nearbyText']) {
    const value = item.payload[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'No additional text';
}

export interface AnnotationPeekProps {
  item: ReviewItem;
  onHoldChange(held: boolean): void;
  copyLink?: CopyLinkControlProps;
}

export function AnnotationPeek({ item, onHoldChange, copyLink }: AnnotationPeekProps) {
  const kindLabel = annotationKindLabel(item.kind);
  const { firstPageIndex, lastPageIndex } = reviewItemPageRange(item);
  const pageDescription = firstPageIndex === lastPageIndex
    ? `page ${firstPageIndex + 1}`
    : `pages ${firstPageIndex + 1}–${lastPageIndex + 1}`;
  return (
    <aside
      className="annotation-peek"
      data-annotation-peek={item.id}
      data-annotation-origin="owned"
      data-annotation-kind={item.kind}
      data-annotation-state="preview"
      aria-label={`${kindLabel} annotation preview`}
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
    >
      <p className="annotation-peek__meta"><strong>{kindLabel}</strong></p>
      <p className="annotation-peek__excerpt">{meaningfulPayload(item)}</p>
      {copyLink === undefined ? null : (
        <CopyLinkControl
          {...copyLink}
          variant="annotation"
          ariaLabel={`Copy link to ${kindLabel} annotation on ${pageDescription}`}
          title={copyLink.disabled
            ? 'Save annotation before copying its link'
            : 'Copy annotation link'}
        />
      )}
    </aside>
  );
}
