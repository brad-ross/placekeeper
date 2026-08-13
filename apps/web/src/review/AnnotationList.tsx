import { useLayoutEffect, useRef, useState } from 'react';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { documentOrderedItems } from './annotation-projection.js';
import {
  AnnotationMetadata,
  annotationAccessibleLabel,
  annotationKindLabel,
} from './AnnotationMetadata.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface AnnotationListProps {
  items: readonly ReviewItem[];
  activeId?: string;
  correspondingId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  sectionLabels?: ReadonlyMap<string, string>;
  onNavigate(item: ReviewItem): void;
  onCorrespondenceChange?(id: string | undefined): void;
  onEdit(item: ReviewItem, trigger: HTMLButtonElement): void;
  onDelete(item: ReviewItem): Promise<void> | void;
}

function payloadText(item: ReviewItem): string {
  const fields = ['proposedText', 'comment', 'quote'];
  return fields.map((field) => item.payload[field]).find((value): value is string => typeof value === 'string') ?? '';
}

function annotationState(active: boolean, corresponding: boolean): string {
  if (active && corresponding) return 'active-corresponding';
  if (active) return 'active';
  if (corresponding) return 'corresponding';
  return 'default';
}

export function AnnotationList({
  items,
  activeId,
  correspondingId,
  activationRequest,
  sectionLabels,
  onNavigate,
  onCorrespondenceChange,
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
    <section className="annotation-drawer__owned" data-annotation-origin="owned" aria-label="Owned annotations">
      <header className="annotation-drawer__header">
        <h2>Annotations <span className="annotation-drawer__count">{ordered.length}</span></h2>
      </header>
      {direction ? (
        <p className="annotation-direction-cue" data-correspondence-direction={direction}>
          <ReviewIcon name="chevron-right" className="review-icon annotation-direction-cue__icon" />
          <span>Matching annotation {direction}</span>
        </p>
      ) : null}
      <ol ref={listRef} tabIndex={-1} aria-label="Annotations in document order">
        {ordered.map((item) => {
          const text = payloadText(item);
          const kindLabel = annotationKindLabel(item.kind);
          const active = activeId === item.id;
          const corresponding = correspondingId === item.id;
          const sectionLabel = sectionLabels?.get(item.id);
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
              onPointerEnter={() => onCorrespondenceChange?.(item.id)}
              onPointerLeave={() => onCorrespondenceChange?.(undefined)}
              onFocusCapture={() => onCorrespondenceChange?.(item.id)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) onCorrespondenceChange?.(undefined);
              }}
            >
              <button
                ref={(node) => {
                  if (node) entryRefs.current.set(item.id, node);
                  else entryRefs.current.delete(item.id);
                }}
                type="button"
                className="annotation-item__content"
                aria-label={annotationAccessibleLabel({
                  kind: item.kind,
                  pageNumber: item.pageIndex + 1,
                  ...(sectionLabel === undefined ? {} : { sectionLabel }),
                  ...(text ? { excerpt: text } : {}),
                })}
                title={`Go to ${kindLabel} annotation on page ${item.pageIndex + 1}`}
                onClick={() => onNavigate(item)}
              >
                <AnnotationMetadata
                  kind={item.kind}
                  pageNumber={item.pageIndex + 1}
                  {...(sectionLabel === undefined ? {} : { sectionLabel })}
                />
                {text ? <span className="annotation-item__excerpt">{text}</span> : null}
              </button>
              {item.kind === 'delete' ? null : (
                <button type="button" className="annotation-item__action" data-annotation-action="edit" aria-label={`Edit ${kindLabel} annotation on page ${item.pageIndex + 1}`} title="Edit annotation" onClick={(event) => onEdit(item, event.currentTarget)}>
                  <ReviewIcon name="edit" size={15} />
                </button>
              )}
              <button type="button" className="annotation-item__action annotation-item__delete" data-annotation-action="delete" aria-label={`Remove ${kindLabel} annotation on page ${item.pageIndex + 1}`} title="Delete annotation" onClick={() => void remove(item)}>
                <ReviewIcon name="delete" size={15} />
              </button>
            </li>
          );
        })}
      </ol>
      {ordered.length === 0 ? <p className="annotation-empty" data-annotation-status="empty">No annotations yet.</p> : null}
    </section>
  );
}
