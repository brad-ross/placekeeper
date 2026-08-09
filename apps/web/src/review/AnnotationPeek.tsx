import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { ReviewIcon } from './ReviewIcon.js';

function meaningfulPayload(item: ReviewItem): string {
  for (const field of ['proposedText', 'comment', 'quote', 'nearbyText']) {
    const value = item.payload[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return 'No additional text';
}

export interface AnnotationPeekProps {
  item: ReviewItem;
  onActivate(): void;
  onDismiss(): void;
  onHoldChange(held: boolean): void;
}

export function AnnotationPeek({ item, onActivate, onDismiss, onHoldChange }: AnnotationPeekProps) {
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
      onFocusCapture={() => onHoldChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHoldChange(false);
      }}
    >
      <p className="annotation-peek__meta"><strong>{item.kind}</strong><span aria-hidden="true"> · </span><span>Page {item.pageIndex + 1}</span></p>
      <p className="annotation-peek__excerpt">{meaningfulPayload(item)}</p>
      <div className="annotation-peek__actions">
        <button type="button" className="annotation-peek__open" onClick={onActivate}>Open annotation</button>
        <button type="button" className="annotation-peek__dismiss" aria-label="Dismiss annotation preview" onClick={onDismiss}>
          <ReviewIcon name="close" />
        </button>
      </div>
    </aside>
  );
}
