import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { AnnotationRowContent } from './AnnotationList.js';
import { annotationKindLabel } from './AnnotationMetadata.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import type { AnnotationReaderRecord } from './annotation-reader.js';

export interface AnnotationPeekProps {
  item: ReviewItem;
  onHoldChange(held: boolean): void;
  copyLink?: CopyLinkControlProps;
  onNavigate?(): void;
  onReadFull?(record: AnnotationReaderRecord, trigger: HTMLButtonElement): void;
  onEdit?(trigger: HTMLButtonElement): void;
  onDelete?(): void;
  onDismiss?(): void;
}

export function AnnotationPeek({
  item,
  onHoldChange,
  copyLink,
  onNavigate,
  onReadFull,
  onEdit,
  onDelete,
  onDismiss,
}: AnnotationPeekProps) {
  const kindLabel = annotationKindLabel(item.kind);
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
      <AnnotationRowContent
        item={item}
        {...(copyLink ? { copyLink } : {})}
        {...(onNavigate ? { onNavigate } : {})}
        {...(onReadFull ? { onReadFull } : {})}
        {...(onEdit ? { onEdit } : {})}
        {...(onDelete ? { onDelete } : {})}
        {...(onDismiss ? { onDismiss } : {})}
      />
    </aside>
  );
}
