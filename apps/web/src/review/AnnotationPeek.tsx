import type { ReviewItem } from '../../../../packages/core/src/review-model.js';

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
}

export function AnnotationPeek({ item, onHoldChange }: AnnotationPeekProps) {
  return (
    <aside
      className="annotation-peek"
      data-annotation-peek={item.id}
      data-annotation-origin="owned"
      data-annotation-kind={item.kind}
      data-annotation-state="preview"
      aria-label={`${item.kind} annotation preview`}
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
    >
      <p className="annotation-peek__meta"><strong>{item.kind}</strong></p>
      <p className="annotation-peek__excerpt">{meaningfulPayload(item)}</p>
    </aside>
  );
}
