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
  onActivate(): void;
  onDismiss(): void;
  onHoldChange(held: boolean): void;
}

export function AnnotationPeek({ item, onActivate, onDismiss, onHoldChange }: AnnotationPeekProps) {
  return (
    <aside
      className="annotation-peek"
      data-annotation-peek={item.id}
      aria-label={`${item.kind} annotation preview`}
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
      onFocusCapture={() => onHoldChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onHoldChange(false);
      }}
    >
      <p><strong>{item.kind}</strong> · Page {item.pageIndex + 1}</p>
      <p>{meaningfulPayload(item)}</p>
      <div>
        <button type="button" onClick={onActivate}>Open annotation</button>
        <button type="button" aria-label="Dismiss annotation preview" onClick={onDismiss}>×</button>
      </div>
    </aside>
  );
}
