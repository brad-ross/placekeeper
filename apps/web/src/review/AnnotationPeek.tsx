import type { CSSProperties } from 'react';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import {
  AnnotationRowContent,
  type AnnotationListContent,
} from './AnnotationList.js';
import { annotationKindLabel } from './AnnotationMetadata.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import type { AnnotationReaderRecord } from './annotation-reader.js';

export interface AnnotationPeekProps {
  item: ReviewItem;
  presentation?: AnnotationListContent;
  kind?: string;
  pageNumber?: number;
  lastPageNumber?: number;
  readerRecord?: AnnotationReaderRecord | null;
  origin?: 'owned' | 'source';
  readOnly?: boolean;
  selected?: boolean;
  onHoldChange(held: boolean): void;
  copyLink?: CopyLinkControlProps;
  onNavigate?(): void;
  onOpenReference?(): void;
  showSourceReturn?: boolean;
  onReadFull?(record: AnnotationReaderRecord, trigger: HTMLButtonElement): void;
  onReaderOverflowChange?(record: AnnotationReaderRecord, overflowing: boolean): void;
  onEdit?(trigger: HTMLButtonElement): void;
  onDelete?(): void;
  surfaceRef?(node: HTMLElement | null): void;
  className?: string;
  style?: CSSProperties;
  inspectionToken?: number;
  referenceTabIdentity?: string;
  placementKind?: string;
}

export function AnnotationPeek({
  item,
  presentation,
  kind: suppliedKind,
  pageNumber,
  lastPageNumber,
  readerRecord,
  origin = 'owned',
  readOnly = false,
  selected = false,
  onHoldChange,
  copyLink,
  onNavigate,
  onOpenReference,
  showSourceReturn = false,
  onReadFull,
  onReaderOverflowChange,
  onEdit,
  onDelete,
  surfaceRef,
  className,
  style,
  inspectionToken,
  referenceTabIdentity,
  placementKind,
}: AnnotationPeekProps) {
  const displayedKind = suppliedKind ?? item.kind;
  const kindLabel = annotationKindLabel(displayedKind);
  return (
    <aside
      ref={surfaceRef}
      className={`annotation-peek${className ? ` ${className}` : ''}`}
      data-annotation-peek={item.id}
      data-annotation-origin={origin}
      data-annotation-kind={displayedKind}
      data-annotation-state={selected ? 'selected' : 'preview'}
      data-peek-selected={selected ? 'true' : 'false'}
      data-source-return={showSourceReturn ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      data-reference-annotation-inspection={inspectionToken}
      data-reference-tab-identity={referenceTabIdentity}
      data-placement={placementKind}
      aria-label={`${kindLabel} annotation preview`}
      style={style}
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
    >
      <AnnotationRowContent
        item={item}
        {...(presentation === undefined ? {} : { presentation })}
        {...(suppliedKind === undefined ? {} : { kind: suppliedKind })}
        {...(pageNumber === undefined ? {} : { pageNumber })}
        {...(lastPageNumber === undefined ? {} : { lastPageNumber })}
        {...(readerRecord === undefined ? {} : { readerRecord })}
        showSourceReturn={showSourceReturn}
        {...(selected && copyLink ? { copyLink } : {})}
        {...(onNavigate ? { onNavigate } : {})}
        {...(onOpenReference ? { onOpenReference } : {})}
        {...(onReadFull ? { onReadFull } : {})}
        {...(onReaderOverflowChange ? { onReaderOverflowChange } : {})}
        {...(selected && onEdit ? { onEdit } : {})}
        {...(selected && onDelete ? { onDelete } : {})}
      />
    </aside>
  );
}

export interface AnnotationRecordPeekProps extends Omit<AnnotationPeekProps,
  'item' | 'presentation' | 'kind' | 'pageNumber' | 'lastPageNumber' | 'readerRecord' | 'origin' | 'readOnly'> {
  readonly record: AnnotationReaderRecord;
  readonly item?: ReviewItem;
}

/** Render any resolved annotation record through the same compact card used by Main PDF peeks. */
export function AnnotationRecordPeek({ record, item, ...props }: AnnotationRecordPeekProps) {
  const projectedItem: ReviewItem = item ?? {
    id: record.identity.origin === 'owned'
      ? record.identity.itemId
      : record.identity.annotationKey,
    kind: 'highlight',
    pageIndex: record.pageNumber - 1,
    createdAt: '',
    updatedAt: '',
    payload: { comment: record.content },
  };
  return <AnnotationPeek
    {...props}
    item={projectedItem}
    presentation={record}
    {...(record.origin === 'owned' && item !== undefined ? {} : { kind: record.kind })}
    pageNumber={record.pageNumber}
    {...(record.lastPageNumber === undefined ? {} : { lastPageNumber: record.lastPageNumber })}
    readerRecord={record}
    origin={record.origin}
    readOnly={record.origin === 'source'}
  />;
}
