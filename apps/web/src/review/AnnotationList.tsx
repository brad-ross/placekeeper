import { useRef } from 'react';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';
import { documentOrderedItems } from './annotation-projection.js';

export interface AnnotationListProps {
  items: readonly ReviewItem[];
  activeId?: string;
  onNavigate(item: ReviewItem): void;
  onEdit(item: ReviewItem, trigger: HTMLButtonElement): void;
  onDelete(item: ReviewItem): Promise<void> | void;
}

function payloadText(item: ReviewItem): string {
  const fields = ['proposedText', 'comment', 'quote'];
  return fields.map((field) => item.payload[field]).find((value): value is string => typeof value === 'string') ?? '';
}

export function AnnotationList({ items, activeId, onNavigate, onEdit, onDelete }: AnnotationListProps) {
  const ordered = documentOrderedItems(items);
  const listRef = useRef<HTMLOListElement>(null);
  const entryRefs = useRef(new Map<string, HTMLButtonElement>());

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
    <aside id="review-annotation-list" aria-label="Review annotations">
      <h2>Annotations</h2>
      <ol ref={listRef} tabIndex={-1} aria-label="Annotations in document order">
        {ordered.map((item) => (
          <li key={item.id} data-review-item={item.id} data-active={activeId === item.id ? 'true' : 'false'}>
            <button
              ref={(node) => {
                if (node) entryRefs.current.set(item.id, node);
                else entryRefs.current.delete(item.id);
              }}
              type="button"
              onClick={() => onNavigate(item)}
            >
              {item.kind} · Page {item.pageIndex + 1}{payloadText(item) ? ` · ${payloadText(item)}` : ''}
            </button>
            {item.kind === 'delete' ? null : (
              <button type="button" aria-label={`Edit ${item.kind} on page ${item.pageIndex + 1}`} onClick={(event) => onEdit(item, event.currentTarget)}>Edit</button>
            )}
            <button type="button" aria-label={`Delete ${item.kind} on page ${item.pageIndex + 1}`} onClick={() => void remove(item)}>Delete</button>
          </li>
        ))}
      </ol>
      {ordered.length === 0 ? <p>No annotations yet.</p> : null}
    </aside>
  );
}
