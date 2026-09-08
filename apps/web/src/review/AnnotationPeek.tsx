import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { AnnotationRowContent } from './AnnotationList.js';
import { annotationKindLabel } from './AnnotationMetadata.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import type { AnnotationReaderRecord } from './annotation-reader.js';

export interface AnnotationPeekProps {
  item: ReviewItem;
  selected?: boolean;
  onHoldChange(held: boolean): void;
  copyLink?: CopyLinkControlProps;
  onNavigate?(): void;
  showSourceReturn?: boolean;
  onReadFull?(record: AnnotationReaderRecord, trigger: HTMLButtonElement): void;
  onReaderOverflowChange?(record: AnnotationReaderRecord, overflowing: boolean): void;
  onEdit?(trigger: HTMLButtonElement): void;
  onDelete?(): void;
}

export function AnnotationPeek({
  item,
  selected = false,
  onHoldChange,
  copyLink,
  onNavigate,
  showSourceReturn = false,
  onReadFull,
  onReaderOverflowChange,
  onEdit,
  onDelete,
}: AnnotationPeekProps) {
  const kindLabel = annotationKindLabel(item.kind);
  return (
    <aside
      className="annotation-peek"
      data-annotation-peek={item.id}
      data-annotation-origin="owned"
      data-annotation-kind={item.kind}
      data-annotation-state={selected ? 'selected' : 'preview'}
      data-peek-selected={selected ? 'true' : 'false'}
      data-source-return={showSourceReturn ? 'true' : undefined}
      aria-label={`${kindLabel} annotation preview`}
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
    >
      <AnnotationRowContent
        item={item}
        showSourceReturn={showSourceReturn}
        {...(selected && copyLink ? { copyLink } : {})}
        {...(onNavigate ? { onNavigate } : {})}
        {...(onReadFull ? { onReadFull } : {})}
        {...(onReaderOverflowChange ? { onReaderOverflowChange } : {})}
        {...(selected && onEdit ? { onEdit } : {})}
        {...(selected && onDelete ? { onDelete } : {})}
      />
    </aside>
  );
}
