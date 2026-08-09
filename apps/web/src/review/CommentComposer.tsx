import { useEffect, useId, useRef, useState, type RefObject } from 'react';

import { ReviewIcon } from './ReviewIcon.js';

export interface CommentComposerProps {
  title: string;
  initialValue?: string;
  optional?: boolean;
  allowWhitespace?: boolean;
  fieldLabel?: string;
  saveLabel?: string;
  triggerRef?: RefObject<{ focus(): void } | null>;
  onSave(value: string): void | Promise<void>;
  onDismiss(): void;
}

export function CommentComposer({
  title,
  initialValue = '',
  optional = false,
  allowWhitespace = false,
  fieldLabel = optional ? 'Comment (optional)' : 'Comment',
  saveLabel = 'Save comment',
  triggerRef,
  onSave,
  onDismiss,
}: CommentComposerProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialValue);
  const canSave = optional || (allowWhitespace ? value.length > 0 : value.trim().length > 0);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
    return () => {
      requestAnimationFrame(() => triggerRef?.current?.focus());
    };
  }, [triggerRef]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="comment-composer"
      data-comment-composer
    >
      <header className="comment-composer__header">
        <p className="comment-composer__eyebrow">Review note</p>
        <h2 id={titleId}>{title}</h2>
      </header>
      <label className="comment-composer__field">
        <span className="comment-composer__label">{fieldLabel}</span>
        <textarea
          className="comment-composer__input"
          ref={inputRef}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onDismiss();
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSave) {
              void onSave(value);
            }
          }}
        />
      </label>
      <div className="comment-composer__actions">
        <button className="review-button review-button--secondary" type="button" onClick={onDismiss}>
          {optional ? 'Keep without comment' : 'Cancel'}
        </button>
        <button
          className="review-button review-button--primary"
          type="button"
          disabled={!canSave}
          onClick={() => void onSave(value)}
        >
          <ReviewIcon name="check" />
          <span>{saveLabel}</span>
        </button>
      </div>
    </div>
  );
}
