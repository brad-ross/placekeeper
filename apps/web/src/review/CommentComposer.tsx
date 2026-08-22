import { useEffect, useId, useRef, useState, type RefObject } from 'react';

import { trapDialogFocus } from '../app/dialog-focus.js';
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
  onSkip?(): void | Promise<void>;
  onDismiss(): void;
}

export function CommentComposer({
  title,
  initialValue = '',
  optional = false,
  allowWhitespace = false,
  fieldLabel = optional ? 'Comment (optional)' : 'Comment',
  saveLabel = 'Save',
  triggerRef,
  onSave,
  onSkip,
  onDismiss,
}: CommentComposerProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialValue);
  const canSave = optional || (allowWhitespace ? value.length > 0 : value.trim().length > 0);
  const canSkip = optional && onSkip !== undefined;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
    return () => {
      requestAnimationFrame(() => triggerRef?.current?.focus());
    };
  }, [triggerRef]);

  return (
    <div className="comment-composer-backdrop" data-comment-composer-backdrop>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="comment-composer compact-editorial-modal"
        data-comment-composer
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
            return;
          }
          trapDialogFocus(event);
        }}
      >
        <header className="comment-composer__header compact-editorial-modal__header">
          <h2 id={titleId}>{title}</h2>
        </header>
        <div className="compact-editorial-modal__body">
          <label className="comment-composer__field">
            <span className="sr-only">{fieldLabel}</span>
            <textarea
              className="comment-composer__input"
              ref={inputRef}
              title={fieldLabel}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSave) {
                  void onSave(value);
                }
              }}
            />
          </label>
        </div>
        <footer className="comment-composer__actions compact-editorial-modal__footer">
          <button
            className="review-button review-button--secondary"
            type="button"
            title="Cancel"
            onClick={onDismiss}
          >
            <ReviewIcon name="close" />
            <span>Cancel</span>
          </button>
          {canSkip ? (
            <button
              className="review-button review-button--secondary"
              type="button"
              title="Keep highlight without comment"
              onClick={() => void onSkip()}
            >
              <ReviewIcon name="arrow-right" />
              <span>Keep</span>
            </button>
          ) : null}
          <button
            className="review-button review-button--primary"
            type="button"
            title={saveLabel}
            disabled={!canSave}
            onClick={() => void onSave(value)}
          >
            <ReviewIcon name="check" />
            <span>{saveLabel}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
