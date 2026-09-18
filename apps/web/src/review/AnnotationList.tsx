import { nativePdfAnnotationSubtype, canEditPdfAnnotationComment, canDeletePdfAnnotation } from '../../../../packages/core/src/native-pdf-annotation.js';
import { annotationContent as annotationListContent, type AnnotationContent as AnnotationListContent } from './annotation-content.js';
export { annotationContent as annotationListContent } from './annotation-content.js';
export type { AnnotationContent as AnnotationListContent } from './annotation-content.js';
import { useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import {
  existingAnnotationKey,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from '../pdf/existing-annotations.js';
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
  projectExistingAnnotationReader,
  type AnnotationReaderRecord,
} from './annotation-reader.js';
import { RowActionGroup, type RowAction } from './RowActionGroup.js';

export interface AnnotationListProps {
  items: readonly ReviewItem[];
  activeId?: string;
  activeExistingAnnotationKey?: string;
  correspondingId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  onNavigate(item: ReviewItem): void;
  existingAnnotations?: ExistingAnnotationsDiscovery;
  documentGeneration?: number;
  onNavigateExisting?(item: ExistingAnnotation): void;
  onReadFullExisting?(
    annotation: ExistingAnnotation,
    record: AnnotationReaderRecord,
    trigger: HTMLButtonElement,
  ): void;
  onRetryExistingAnnotations?(): void;
  onReadFull?(record: AnnotationReaderRecord, trigger: HTMLButtonElement): void;
  onReaderOverflowChange?(record: AnnotationReaderRecord, overflowing: boolean): void;
  onReaderOverflowChangeExisting?(record: AnnotationReaderRecord, overflowing: boolean): void;
  onCorrespondenceChange?(id: string | undefined): void;
  copyLinkForItem?(item: ReviewItem): CopyLinkControlProps | undefined;
  onEdit(item: ReviewItem, trigger: HTMLButtonElement): void;
  onDelete(item: ReviewItem): Promise<void> | void;
  attention?: AnnotationAttentionPresentation;
}

export interface AnnotationAttentionPresentation {
  readonly count: number;
  readonly rows: ReactNode;
  readonly notice: ReactNode;
  readonly message: ReactNode;
  readonly editor: ReactElement | null;
  readonly ownedItemIds: readonly string[];
  readonly existingAnnotationKeys: readonly string[];
}

type AnnotationListEntry =
  | { readonly origin: 'owned'; readonly item: ReviewItem; readonly pageIndex: number; readonly x: number; readonly y: number; readonly stableIndex: number }
  | { readonly origin: 'source'; readonly annotation: ExistingAnnotation; readonly pageIndex: number; readonly x: number; readonly y: number; readonly stableIndex: number };

function entryFocusKey(entry: AnnotationListEntry): string {
  return entry.origin === 'owned'
    ? `owned:${entry.item.id}`
    : `source:${existingAnnotationKey(entry.annotation)}`;
}

function ownedCoordinate(item: ReviewItem, field: 'x' | 'y'): number {
  const candidate = item.reconciliation?.anchor.rect
    ?? (item.payload.rect && typeof item.payload.rect === 'object' && !Array.isArray(item.payload.rect) ? item.payload.rect : undefined)
    ?? (item.payload.position && typeof item.payload.position === 'object' && !Array.isArray(item.payload.position) ? item.payload.position : undefined);
  const value = candidate?.[field];
  return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER;
}

/** One stable reading order across editable and source-PDF annotations. */
export function combinedDocumentOrderedAnnotations(
  items: readonly ReviewItem[],
  existingAnnotations: ExistingAnnotationsDiscovery,
): AnnotationListEntry[] {
  const owned: AnnotationListEntry[] = documentOrderedItems(items).map((item, stableIndex) => ({
    origin: 'owned', item, pageIndex: reviewItemPageRange(item).firstPageIndex,
    x: ownedCoordinate(item, 'x'), y: ownedCoordinate(item, 'y'), stableIndex,
  }));
  const source: AnnotationListEntry[] = existingAnnotations.status === 'ready'
    ? existingAnnotations.items.map((annotation, stableIndex) => ({
        origin: 'source', annotation, pageIndex: annotation.pageIndex,
        x: annotation.rect.x, y: annotation.rect.y, stableIndex,
      }))
    : [];
  return [...owned, ...source].toSorted((left, right) =>
    left.pageIndex - right.pageIndex
    || left.y - right.y
    || left.x - right.x
    || left.origin.localeCompare(right.origin)
    || left.stableIndex - right.stableIndex,
  );
}


function annotationState(active: boolean, corresponding: boolean): string {
  if (active && corresponding) return 'active-corresponding';
  if (active) return 'active';
  if (corresponding) return 'corresponding';
  return 'default';
}

export interface AnnotationRowContentProps {
  readonly item: ReviewItem;
  readonly presentation?: AnnotationListContent;
  readonly kind?: string;
  readonly pageNumber?: number;
  readonly lastPageNumber?: number;
  readonly copyLink?: CopyLinkControlProps;
  readonly readerRecord?: AnnotationReaderRecord | null;
  readonly navigationRef?: (node: HTMLButtonElement | null) => void;
  readonly onNavigate?: () => void;
  readonly showSourceReturn?: boolean;
  readonly onReadFull?: (record: AnnotationReaderRecord, trigger: HTMLButtonElement) => void;
  readonly onReaderOverflowChange?: (record: AnnotationReaderRecord, overflowing: boolean) => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
  readonly onDelete?: () => void;
  readonly onDismiss?: () => void;
  readonly extraActions?: readonly RowAction[];
  readonly navigationLabel?: string;
  readonly navigationTitle?: string;
  readonly statusIcon?: 'warning';
  readonly statusIconLabel?: string;
  readonly navigationFocusToken?: string;
  readonly navigationExpanded?: boolean;
  readonly navigationControls?: string;
  readonly navigationDisabled?: boolean;
}

export function AnnotationRowContent({
  item,
  presentation: suppliedPresentation,
  kind: suppliedKind,
  pageNumber: suppliedPageNumber,
  lastPageNumber: suppliedLastPageNumber,
  copyLink,
  readerRecord = projectOwnedAnnotationReader(item),
  navigationRef,
  onNavigate,
  showSourceReturn = false,
  onReadFull,
  onReaderOverflowChange,
  onEdit,
  onDelete,
  onDismiss,
  extraActions = [],
  navigationLabel,
  navigationTitle,
  statusIcon,
  statusIconLabel,
  navigationFocusToken,
  navigationExpanded,
  navigationControls,
  navigationDisabled,
}: AnnotationRowContentProps) {
  const presentation = suppliedPresentation ?? annotationListContent(item);
  const text = [presentation.sourceText, presentation.content, presentation.quoteText].filter(Boolean).join(' ');
  const { firstPageIndex, lastPageIndex } = readerRecord === null
    ? reviewItemPageRange(item)
    : {
        firstPageIndex: readerRecord.pageNumber - 1,
        lastPageIndex: (readerRecord.lastPageNumber ?? readerRecord.pageNumber) - 1,
      };
  const pageNumber = suppliedPageNumber ?? firstPageIndex + 1;
  const lastPageNumber = suppliedLastPageNumber ?? (suppliedPageNumber ?? lastPageIndex + 1);
  const kind = suppliedKind ?? (nativePdfAnnotationSubtype(item) ?? item.kind);
  const kindLabel = annotationKindLabel(kind);
  const pageDescription = pageNumber === lastPageNumber
    ? `page ${pageNumber}`
    : `pages ${pageNumber}–${lastPageNumber}`;
  const actions: RowAction[] = [];
  if (showSourceReturn && onNavigate) actions.push({
    id: 'locate', kind: 'command', icon: 'locate',
    label: 'Back to annotation in PDF', title: 'Back to annotation in PDF', onInvoke: onNavigate,
  });
  if (onEdit && item.kind !== 'delete' && canEditPdfAnnotationComment(item)) actions.push({
    id: 'edit', kind: 'command', icon: 'edit',
    label: `Edit ${kindLabel} annotation on ${pageDescription}`,
    title: 'Edit annotation', onInvoke: onEdit,
  });
  if (copyLink) actions.push({
    id: 'copy-link', kind: 'copy-link',
    label: `Copy link to ${kindLabel} annotation on ${pageDescription}`,
    title: copyLink.disabled ? 'Save annotation before copying its link' : 'Copy annotation link',
    copyLink,
  });
  if (onDelete && canDeletePdfAnnotation(item)) actions.push({
    id: 'delete', kind: 'command', icon: 'remove',
    label: `Remove ${kindLabel} annotation on ${pageDescription}`,
    title: 'Delete annotation', onInvoke: onDelete,
  });
  if (onDismiss) actions.push({
    id: 'close', kind: 'command', icon: 'close',
    label: 'Close annotation preview', title: 'Close', onInvoke: onDismiss,
  });
  actions.push(...extraActions);

  return <div className="annotation-item__content">
    {onNavigate ? <button
      ref={navigationRef}
      type="button"
      className="annotation-item__navigation"
      data-workspace-focus-token={navigationFocusToken}
      aria-expanded={navigationExpanded}
      aria-controls={navigationControls}
      disabled={navigationDisabled}
      aria-label={navigationLabel ?? annotationAccessibleLabel({
        kind,
        pageNumber,
        lastPageNumber,
        ...(text ? { excerpt: text } : {}),
      })}
      title={navigationTitle ?? `Go to ${kindLabel} annotation on ${pageDescription}`}
      onClick={onNavigate}
    /> : null}
    <div className="annotation-item__title-row">
      <AnnotationMetadata
        kind={kind}
        pageNumber={pageNumber}
        lastPageNumber={lastPageNumber}
        rowHead
        {...(statusIcon ? { statusIcon } : {})}
        {...(statusIconLabel ? { statusIconLabel } : {})}
      />
      <RowActionGroup actions={actions} rowLabel={`${kindLabel} annotation on ${pageDescription}`} />
    </div>
    <div className="annotation-item__body-row">
      {text ? <AnnotationExcerpt
        content={presentation.content}
        {...(presentation.sourceText ? { sourceText: presentation.sourceText } : {})}
        {...(presentation.sourceTreatment ? { sourceTreatment: presentation.sourceTreatment } : {})}
        {...(presentation.quoteText ? { quoteText: presentation.quoteText } : {})}
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
  activeExistingAnnotationKey,
  correspondingId,
  activationRequest,
  onNavigate,
  existingAnnotations = { status: 'empty', generation: 0, items: [] },
  documentGeneration = 0,
  onNavigateExisting,
  onReadFullExisting,
  onRetryExistingAnnotations,
  onReadFull,
  onReaderOverflowChange,
  onReaderOverflowChangeExisting,
  onCorrespondenceChange,
  copyLinkForItem,
  onEdit,
  onDelete,
  attention,
}: AnnotationListProps) {
  const visibleItems = useMemo(() => {
    if (attention === undefined) return items;
    const excluded = new Set(attention.ownedItemIds);
    return items.filter((item) => !excluded.has(item.id));
  }, [attention?.ownedItemIds, items]);
  const visibleExistingAnnotations = useMemo<ExistingAnnotationsDiscovery>(() => {
    if (existingAnnotations.status !== 'ready' || attention === undefined) return existingAnnotations;
    const excluded = new Set(attention.existingAnnotationKeys);
    return {
      ...existingAnnotations,
      items: existingAnnotations.items.filter(
        (annotation) => !excluded.has(existingAnnotationKey(annotation)),
      ),
    };
  }, [attention?.existingAnnotationKeys, existingAnnotations]);
  const combined = useMemo(
    () => combinedDocumentOrderedAnnotations(visibleItems, visibleExistingAnnotations),
    [visibleItems, visibleExistingAnnotations],
  );
  const listRef = useRef<HTMLOListElement>(null);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  useLayoutEffect(() => {
    if (!activationRequest) return;
    const row = rowRefs.current.get(activationRequest.id);
    const entry = entryRefs.current.get(`owned:${activationRequest.id}`);
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
    const index = combined.findIndex((entry) => entry.origin === 'owned' && entry.item.id === item.id);
    const nextKey = combined[index + 1] === undefined ? undefined : entryFocusKey(combined[index + 1]!);
    const previousKey = combined[index - 1] === undefined ? undefined : entryFocusKey(combined[index - 1]!);
    await onDelete(item);
    queueMicrotask(() => {
      if (nextKey) entryRefs.current.get(nextKey)?.focus();
      else if (previousKey) entryRefs.current.get(previousKey)?.focus();
      else listRef.current?.focus();
    });
  };

  if (attention?.editor != null) {
    return (
      <section
        className="annotation-drawer__owned"
        data-annotation-origin="combined"
        data-existing-annotations-state={existingAnnotations.status}
        data-workspace-focus-token="annotations:section"
        aria-label="Annotations"
        tabIndex={-1}
      >
        {attention.editor}
      </section>
    );
  }

  return (
    <section
      className="annotation-drawer__owned"
      data-annotation-origin="combined"
      data-existing-annotations-state={existingAnnotations.status}
      data-workspace-focus-token="annotations:section"
      aria-label="Annotations"
      tabIndex={-1}
    >
      {attention?.notice}
      <ol ref={listRef} tabIndex={-1} aria-label="Annotations in document order">
        {attention?.rows}
        {combined.map((entry) => {
          if (entry.origin === 'source') {
            const { annotation } = entry;
            const key = existingAnnotationKey(annotation);
            const active = activeExistingAnnotationKey === key;
            const readerRecord = projectExistingAnnotationReader(annotation, {
              documentGeneration,
              discoveryGeneration: visibleExistingAnnotations.generation,
            });
            return <li
              key={`source:${key}`}
              data-existing-annotation={annotation.id}
              data-existing-annotation-key={key}
              data-annotation-origin="source"
              data-annotation-kind={annotation.subtype}
              data-annotation-state={active ? 'active-readonly' : 'readonly'}
              data-active={active ? 'true' : 'false'}
              data-readonly="true"
            >
              <AnnotationRowContent
                item={{
                  id: key,
                  kind: 'highlight',
                  pageIndex: annotation.pageIndex,
                  payload: { comment: annotation.contents },
                  createdAt: '', updatedAt: '',
                }}
                presentation={{ content: annotation.contents }}
                kind={annotation.subtype}
                pageNumber={annotation.pageIndex + 1}
                readerRecord={readerRecord}
                navigationRef={(node) => {
                  const focusKey = `source:${key}`;
                  if (node) entryRefs.current.set(focusKey, node);
                  else entryRefs.current.delete(focusKey);
                }}
                onNavigate={() => onNavigateExisting?.(annotation)}
                {...(onReadFullExisting && readerRecord ? {
                  onReadFull: (record, trigger) => onReadFullExisting(annotation, record, trigger),
                } : {})}
                {...(onReaderOverflowChangeExisting ? { onReaderOverflowChange: onReaderOverflowChangeExisting } : {})}
              />
            </li>;
          }
          const { item } = entry;
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
                  const focusKey = `owned:${item.id}`;
                  if (node) entryRefs.current.set(focusKey, node);
                  else entryRefs.current.delete(focusKey);
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
      {attention?.message}
      {existingAnnotations.status === 'loading' ? (
        <p className="annotation-status" data-annotation-status="loading" role="status">
          <ReviewIcon name="loading" className="review-icon annotation-status__icon" />
          <span>Existing annotations are loading…</span>
        </p>
      ) : null}
      {existingAnnotations.status === 'error' ? (
        <div className="annotation-status annotation-status--error" data-annotation-status="error" role="alert">
          <ReviewIcon name="alert" className="review-icon annotation-status__icon" />
          <p><strong>Existing annotations unavailable.</strong><span>{existingAnnotations.message}</span></p>
          <button type="button" title="Retry loading existing annotations" onClick={onRetryExistingAnnotations}>Retry</button>
        </div>
      ) : null}
      {(attention?.count ?? 0) === 0 && items.length === 0 && existingAnnotations.status === 'empty' ? <p className="annotation-empty" data-annotation-status="empty">Select text in the PDF to add an annotation.</p> : null}
    </section>
  );
}
