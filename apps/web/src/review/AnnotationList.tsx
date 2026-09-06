import { useLayoutEffect, useRef, useState } from 'react';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { documentOrderedItems, reviewItemPageRange } from './annotation-projection.js';
import {
  AnnotationMetadata,
  annotationAccessibleLabel,
  annotationKindLabel,
} from './AnnotationMetadata.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import { ReviewIcon } from './ReviewIcon.js';
import { AnnotationExcerpt } from './AnnotationExcerpt.js';
import {
  projectOwnedAnnotationReader,
  type AnnotationReaderRecord,
} from './annotation-reader.js';
import { RowActionGroup, type RowAction } from './RowActionGroup.js';

export interface AnnotationListProps {
  items: readonly ReviewItem[];
  activeId?: string;
  correspondingId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  onNavigate(item: ReviewItem): void;
  onReadFull?(record: AnnotationReaderRecord, trigger: HTMLButtonElement): void;
  onReaderOverflowChange?(record: AnnotationReaderRecord, overflowing: boolean): void;
  onCorrespondenceChange?(id: string | undefined): void;
  copyLinkForItem?(item: ReviewItem): CopyLinkControlProps | undefined;
  onEdit(item: ReviewItem, trigger: HTMLButtonElement): void;
  onDelete(item: ReviewItem): Promise<void> | void;
}

function payloadString(item: ReviewItem, field: string): string {
  const value = item.payload[field];
  return typeof value === 'string' ? value : '';
}

export interface AnnotationListContent {
  readonly content: string;
  readonly sourceText?: string;
  readonly sourceTreatment?: 'plain' | 'struck';
}

export function annotationListContent(item: ReviewItem): AnnotationListContent {
  const quote = payloadString(item, 'quote');
  const proposedText = payloadString(item, 'proposedText');
  const comment = payloadString(item, 'comment');
  switch (item.kind) {
    case 'replace':
      return { content: proposedText, ...(quote ? { sourceText: quote, sourceTreatment: 'struck' as const } : {}) };
    case 'delete':
      return { content: '', ...(quote ? { sourceText: quote, sourceTreatment: 'struck' as const } : {}) };
    case 'highlight': return { content: comment || quote };
    case 'insert': return { content: proposedText || quote };
    case 'pageNote': return { content: comment || quote };
  }
}

function annotationState(active: boolean, corresponding: boolean): string {
  if (active && corresponding) return 'active-corresponding';
  if (active) return 'active';
  if (corresponding) return 'corresponding';
  return 'default';
}

export interface AnnotationRowContentProps {
  readonly item: ReviewItem;
  readonly copyLink?: CopyLinkControlProps;
  readonly readerRecord?: AnnotationReaderRecord | null;
  readonly navigationRef?: (node: HTMLButtonElement | null) => void;
  readonly onNavigate?: () => void;
  readonly onReadFull?: (record: AnnotationReaderRecord, trigger: HTMLButtonElement) => void;
  readonly onReaderOverflowChange?: (record: AnnotationReaderRecord, overflowing: boolean) => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
  readonly onDelete?: () => void;
  readonly onDismiss?: () => void;
}

export function AnnotationRowContent({
  item,
  copyLink,
  readerRecord = projectOwnedAnnotationReader(item),
  navigationRef,
  onNavigate,
  onReadFull,
  onReaderOverflowChange,
  onEdit,
  onDelete,
  onDismiss,
}: AnnotationRowContentProps) {
  const presentation = annotationListContent(item);
  const text = [presentation.sourceText, presentation.content].filter(Boolean).join(' ');
  const { firstPageIndex, lastPageIndex } = readerRecord === null
    ? reviewItemPageRange(item)
    : {
        firstPageIndex: readerRecord.pageNumber - 1,
        lastPageIndex: (readerRecord.lastPageNumber ?? readerRecord.pageNumber) - 1,
      };
  const pageNumber = firstPageIndex + 1;
  const lastPageNumber = lastPageIndex + 1;
  const kindLabel = annotationKindLabel(item.kind);
  const pageDescription = pageNumber === lastPageNumber
    ? `page ${pageNumber}`
    : `pages ${pageNumber}–${lastPageNumber}`;
  const actions: RowAction[] = [];
  if (onEdit && item.kind !== 'delete') actions.push({
    id: 'edit', kind: 'command', icon: 'edit',
    label: `Edit ${kindLabel} annotation on ${pageDescription}`,
    title: 'Edit annotation', onInvoke: onEdit,
  });
  if (onDelete) actions.push({
    id: 'delete', kind: 'command', icon: 'remove',
    label: `Remove ${kindLabel} annotation on ${pageDescription}`,
    title: 'Delete annotation', onInvoke: onDelete,
  });
  if (copyLink) actions.push({
    id: 'copy-link', kind: 'copy-link',
    label: `Copy link to ${kindLabel} annotation on ${pageDescription}`,
    title: copyLink.disabled ? 'Save annotation before copying its link' : 'Copy annotation link',
    copyLink,
  });
  if (onDismiss) actions.push({
    id: 'close', kind: 'command', icon: 'close',
    label: 'Close annotation preview', title: 'Close', onInvoke: onDismiss,
  });

  return <div className="annotation-item__content">
    {onNavigate ? <button
      ref={navigationRef}
      type="button"
      className="annotation-item__navigation"
      aria-label={annotationAccessibleLabel({
        kind: item.kind,
        pageNumber,
        lastPageNumber,
        ...(text ? { excerpt: text } : {}),
      })}
      title={`Go to ${kindLabel} annotation on ${pageDescription}`}
      onClick={onNavigate}
    /> : null}
    <div className="annotation-item__title-row">
      <AnnotationMetadata kind={item.kind} pageNumber={pageNumber} lastPageNumber={lastPageNumber} />
      <RowActionGroup actions={actions} rowLabel={`${kindLabel} annotation on ${pageDescription}`} />
    </div>
    <div className="annotation-item__body-row">
      {text ? <AnnotationExcerpt
        content={presentation.content}
        {...(presentation.sourceText ? { sourceText: presentation.sourceText } : {})}
        {...(presentation.sourceTreatment ? { sourceTreatment: presentation.sourceTreatment } : {})}
        readerRecord={readerRecord}
        {...(onReadFull ? { onReadFull } : {})}
        {...(onReaderOverflowChange ? { onOverflowChange: onReaderOverflowChange } : {})}
      /> : <span />}
    </div>
  </div>;
}

export function AnnotationList({
  items,
  activeId,
  correspondingId,
  activationRequest,
  onNavigate,
  onReadFull,
  onReaderOverflowChange,
  onCorrespondenceChange,
  copyLinkForItem,
  onEdit,
  onDelete,
}: AnnotationListProps) {
  const ordered = documentOrderedItems(items);
  const listRef = useRef<HTMLOListElement>(null);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const [direction, setDirection] = useState<'above' | 'below'>();

  useLayoutEffect(() => {
    if (!correspondingId) {
      setDirection(undefined);
      return;
    }
    const row = rowRefs.current.get(correspondingId);
    const viewport = listRef.current?.closest<HTMLElement>('[data-annotation-scroll-viewport], .review-workspace');
    if (!row || !viewport) return;
    const rowBounds = row.getBoundingClientRect();
    const viewportBounds = viewport.getBoundingClientRect();
    setDirection(rowBounds.bottom < viewportBounds.top
      ? 'above'
      : rowBounds.top > viewportBounds.bottom
        ? 'below'
        : undefined);
  }, [correspondingId, items]);

  useLayoutEffect(() => {
    if (!activationRequest) return;
    const row = rowRefs.current.get(activationRequest.id);
    const entry = entryRefs.current.get(activationRequest.id);
    if (row && entry) {
      const viewport = listRef.current?.closest<HTMLElement>('[data-annotation-scroll-viewport], .review-workspace');
      if (viewport) {
        const rowBounds = row.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        if (rowBounds.top < viewportBounds.top) {
          viewport.scrollTop += rowBounds.top - viewportBounds.top;
        } else if (rowBounds.bottom > viewportBounds.bottom) {
          viewport.scrollTop += rowBounds.bottom - viewportBounds.bottom;
        }
      }
      entry.focus({ preventScroll: true });
    } else {
      listRef.current?.focus({ preventScroll: true });
    }
  }, [activationRequest?.id, activationRequest?.token]);

  const remove = async (item: ReviewItem) => {
    const index = ordered.findIndex(({ id }) => id === item.id);
    const nextId = ordered[index + 1]?.id;
    const previousId = ordered[index - 1]?.id;
    await onDelete(item);
    queueMicrotask(() => {
      if (nextId) entryRefs.current.get(nextId)?.focus();
      else if (previousId) entryRefs.current.get(previousId)?.focus();
      else listRef.current?.focus();
    });
  };

  return (
    <section
      className="annotation-drawer__owned"
      data-annotation-origin="owned"
      data-workspace-focus-token="annotations:section"
      aria-label="Owned annotations"
      tabIndex={-1}
    >
      {direction ? (
        <p className="annotation-direction-cue" data-correspondence-direction={direction}>
          <ReviewIcon name="chevron-right" className="review-icon annotation-direction-cue__icon" />
          <span>Matching annotation {direction}</span>
        </p>
      ) : null}
      <ol ref={listRef} tabIndex={-1} aria-label="Annotations in document order">
        {ordered.map((item) => {
          const active = activeId === item.id;
          const corresponding = correspondingId === item.id;
          const copyLink = copyLinkForItem?.(item);
          const readerRecord = projectOwnedAnnotationReader(item);
          return (
            <li
              key={item.id}
              ref={(node) => {
                if (node) rowRefs.current.set(item.id, node);
                else rowRefs.current.delete(item.id);
              }}
              data-review-item={item.id}
              data-annotation-origin="owned"
              data-annotation-kind={item.kind}
              data-annotation-state={annotationState(active, corresponding)}
              data-active={active ? 'true' : 'false'}
              data-corresponding={corresponding ? 'true' : 'false'}
              data-item-copy-link={copyLink === undefined ? 'false' : 'true'}
              onPointerEnter={() => onCorrespondenceChange?.(item.id)}
              onPointerLeave={(event) => {
                const focusedElement = document.activeElement;
                const copyControlFocused = focusedElement instanceof Element
                  && focusedElement.closest('.copy-link-control') !== null;
                if (!event.currentTarget.contains(focusedElement) || copyControlFocused) {
                  onCorrespondenceChange?.(undefined);
                }
              }}
              onFocusCapture={(event) => {
                const copyControlFocused = event.target instanceof Element
                  && event.target.closest('.copy-link-control') !== null;
                onCorrespondenceChange?.(copyControlFocused ? undefined : item.id);
              }}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) onCorrespondenceChange?.(undefined);
              }}
            >
              <AnnotationRowContent
                item={item}
                {...(copyLink ? { copyLink } : {})}
                readerRecord={readerRecord}
                navigationRef={(node) => {
                  if (node) entryRefs.current.set(item.id, node);
                  else entryRefs.current.delete(item.id);
                }}
                onNavigate={() => onNavigate(item)}
                {...(onReadFull ? { onReadFull } : {})}
                {...(onReaderOverflowChange ? { onReaderOverflowChange } : {})}
                onEdit={(trigger) => onEdit(item, trigger)}
                onDelete={() => void remove(item)}
              />
            </li>
          );
        })}
      </ol>
      {ordered.length === 0 ? <p className="annotation-empty" data-annotation-status="empty">Select text in the PDF to add an annotation.</p> : null}
    </section>
  );
}
