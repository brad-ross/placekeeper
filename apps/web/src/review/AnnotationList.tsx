import { useLayoutEffect, useRef, useState } from 'react';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { documentOrderedItems } from './annotation-projection.js';

export interface AnnotationListProps {
  items: readonly ReviewItem[];
  activeId?: string;
  correspondingId?: string;
  activationRequest?: { readonly id: string; readonly token: number };
  onNavigate(item: ReviewItem): void;
  onCorrespondenceChange?(id: string | undefined): void;
  onEdit(item: ReviewItem, trigger: HTMLButtonElement): void;
  onDelete(item: ReviewItem): Promise<void> | void;
  onClose?(): void;
}

function payloadText(item: ReviewItem): string {
  const fields = ['proposedText', 'comment', 'quote'];
  return fields.map((field) => item.payload[field]).find((value): value is string => typeof value === 'string') ?? '';
}

export function AnnotationList({
  items,
  activeId,
  correspondingId,
  activationRequest,
  onNavigate,
  onCorrespondenceChange,
  onEdit,
  onDelete,
  onClose,
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
    const viewport = listRef.current?.closest<HTMLElement>('.review-list');
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
      row.scrollIntoView({ block: 'nearest' });
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
    <section className="annotation-drawer__owned" aria-label="Owned annotations">
      <header className="annotation-drawer__header">
        <div>
          <p className="annotation-drawer__eyebrow">Review comments</p>
          <h2>Annotations <span className="annotation-drawer__count">{ordered.length}</span></h2>
        </div>
        {onClose ? (
          <button type="button" className="annotation-drawer__close" aria-label="Close annotations" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        ) : null}
      </header>
      {direction ? (
        <p className="annotation-direction-cue" data-correspondence-direction={direction}>
          Matching annotation {direction}
        </p>
      ) : null}
      <ol ref={listRef} tabIndex={-1} aria-label="Annotations in document order">
        {ordered.map((item) => {
          const text = payloadText(item);
          return (
            <li
              key={item.id}
              ref={(node) => {
                if (node) rowRefs.current.set(item.id, node);
                else rowRefs.current.delete(item.id);
              }}
              data-review-item={item.id}
              data-active={activeId === item.id ? 'true' : 'false'}
              data-corresponding={correspondingId === item.id ? 'true' : 'false'}
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
                aria-label={`${item.kind} · Page ${item.pageIndex + 1}${text ? ` · ${text}` : ''}`}
                onClick={() => onNavigate(item)}
              >
                <span className="annotation-item__meta">
                  <strong>{item.kind}</strong><span>Page {item.pageIndex + 1}</span>
                </span>
                {text ? <span className="annotation-item__excerpt">{text}</span> : null}
              </button>
              {item.kind === 'delete' ? null : (
                <button type="button" className="annotation-item__action" aria-label={`Edit ${item.kind} on page ${item.pageIndex + 1}`} onClick={(event) => onEdit(item, event.currentTarget)}>Edit</button>
              )}
              <button type="button" className="annotation-item__action annotation-item__delete" aria-label={`Delete ${item.kind} on page ${item.pageIndex + 1}`} onClick={() => void remove(item)}>Delete</button>
            </li>
          );
        })}
      </ol>
      {ordered.length === 0 ? <p>No annotations yet.</p> : null}
    </section>
  );
}
