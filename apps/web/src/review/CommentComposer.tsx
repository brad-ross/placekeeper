import { useEffect, useId, useRef, useState, type RefObject } from 'react';

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
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="comment-composer">
      <h2 id={titleId}>{title}</h2>
      <label>
        {fieldLabel}
        <textarea
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
      <div>
        <button type="button" onClick={onDismiss}>{optional ? 'Keep without comment' : 'Cancel'}</button>
        <button type="button" disabled={!canSave} onClick={() => void onSave(value)}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
