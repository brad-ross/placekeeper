import { useId, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_ANNOTATION_NAME } from '../../../../packages/core/src/review-model.js';
import { trapDialogFocus } from '../app/dialog-focus.js';
import { AnnotationNameField } from './AnnotationNameField.js';
import { ReviewIcon } from '../review/ReviewIcon.js';

export function ExportAnnotationDialog(props: {
  readonly annotationName?: string | undefined;
  readonly pending: boolean;
  readonly error?: string | undefined;
  readonly onConfirm: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(props.annotationName ?? DEFAULT_ANNOTATION_NAME);
  const titleId = useId();
  const errorId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    firstRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <div className="save-destination-backdrop" data-export-annotation-backdrop>
    <section className="save-destination-dialog review-choice-dialog compact-editorial-modal"
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!props.pending) props.onCancel();
          return;
        }
        trapDialogFocus(event);
      }}>
      <header className="compact-editorial-modal__header"><h2 id={titleId}>Export reviewed PDF</h2></header>
      <div className="compact-editorial-modal__body">
        <AnnotationNameField value={name} onChange={setName} disabled={props.pending}
          error={props.error} errorId={errorId} inputRef={firstRef} />
      </div>
      <footer className="compact-editorial-modal__footer">
        <button className="review-button" type="button" title="Cancel export" disabled={props.pending} onClick={props.onCancel}><span>Cancel</span></button>
        <button className="review-button review-button--primary" type="button" title="Export annotated PDF" disabled={props.pending}
          onClick={() => props.onConfirm(name)}>
          {props.pending ? <ReviewIcon name="loading" /> : null}<span>Export</span>
        </button>
      </footer>
    </section>
  </div>;
}
