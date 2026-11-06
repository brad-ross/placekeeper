import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ReviewIcon } from './ReviewIcon.js';
import { MAX_REVIEW_CONTEXT_NOTE_LENGTH } from '../host/review-agent-bridge.js';

interface ContextNoteComposerProps {
  readonly kind: 'selection' | 'annotations';
  readonly excerpt: string;
  readonly note: string;
  readonly onNoteChange: (note: string) => void;
  readonly onCancel: () => void;
  readonly onAdd: () => Promise<void>;
}

export function ContextNoteComposer({ kind, excerpt, note, onNoteChange, onCancel, onAdd }: ContextNoteComposerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const titleId = useId();
  const noteId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    noteRef.current?.focus();
    return () => dialog?.close();
  }, []);

  return <dialog
    ref={dialogRef}
    className="context-note-composer"
    aria-labelledby={titleId}
    onKeyDown={(event) => event.stopPropagation()}
    onCancel={(event) => {
      event.preventDefault();
      if (!submitting.current) onCancel();
    }}
  >
    <form className="comment-composer compact-editorial-modal" onSubmit={async (event) => {
      event.preventDefault();
      if (submitting.current) return;
      submitting.current = true;
      setPending(true);
      setFailed(false);
      try {
        await onAdd();
      } catch {
        setFailed(true);
      } finally {
        submitting.current = false;
        setPending(false);
      }
    }}>
      <header className="comment-composer__header compact-editorial-modal__header">
        <h2 id={titleId}><ReviewIcon name="agent" size={16} /><span>Add {kind === 'selection' ? 'selection' : 'annotation'} to chat</span></h2>
      </header>
      <div className="comment-composer__body compact-editorial-modal__body">
        {excerpt === '' ? null : <p className="context-note-composer__excerpt">{excerpt}</p>}
        <label className="comment-composer__field" htmlFor={noteId}>
          <span className="sr-only">Note (optional)</span>
          <textarea
            className="comment-composer__input"
            placeholder="Add a note…"
            id={noteId}
            ref={noteRef}
            value={note}
            rows={3}
            maxLength={MAX_REVIEW_CONTEXT_NOTE_LENGTH}
            readOnly={pending}
            onChange={(event) => onNoteChange(event.currentTarget.value)}
          />
        </label>
        {failed ? <p role="alert">Could not add context to chat. Try again.</p> : null}
        <div className="comment-composer__actions">
          <button type="button" className="review-button review-button--secondary" disabled={pending} onClick={onCancel}>Cancel</button>
          <button type="submit" className="review-button review-button--primary" disabled={pending}>
            {pending ? 'Adding…' : 'Add to chat'}
          </button>
        </div>
      </div>
    </form>
  </dialog>;
}
