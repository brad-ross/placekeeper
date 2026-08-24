import type { Ref } from 'react';

import type { AnnotationReaderRecord } from './annotation-reader.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface FullAnnotationReaderProps {
  readonly record: AnnotationReaderRecord;
  readonly onBack: () => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
}

export interface FullAnnotationReaderActionsProps {
  readonly onBack: () => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
  readonly backRef?: Ref<HTMLButtonElement>;
  readonly editRef?: Ref<HTMLButtonElement>;
}

export function FullAnnotationReaderActions({
  onBack,
  onEdit,
  backRef,
  editRef,
}: FullAnnotationReaderActionsProps) {
  return (
    <div className="full-annotation-reader__actions" aria-label="Full annotation actions">
      <button
        ref={backRef}
        type="button"
        className="full-annotation-reader__back"
        data-full-annotation-action="back"
        aria-label="Back"
        title="Back to annotations"
        onClick={onBack}
      >
        <ReviewIcon name="arrow-left" size={15} />
      </button>
      {onEdit === undefined ? null : (
        <button
          ref={editRef}
          type="button"
          className="full-annotation-reader__edit"
          data-full-annotation-action="edit"
          aria-label="Edit"
          title="Edit annotation"
          onClick={(event) => onEdit(event.currentTarget)}
        >
          <ReviewIcon name="edit" size={15} />
        </button>
      )}
    </div>
  );
}

export function FullAnnotationReader({ record, onBack, onEdit }: FullAnnotationReaderProps) {
  return (
    <section
      className="full-annotation-reader"
      data-full-annotation-reader="true"
      data-annotation-origin={record.origin}
      aria-label={`Full ${record.typeLabel} annotation on page ${record.pageNumber}`}
    >
      <div className="full-annotation-reader__metadata-bar">
        <div
          className="full-annotation-reader__metadata annotation-item__meta"
          aria-label="Annotation details"
        >
          <strong>{record.typeLabel}</strong>
          <span className="annotation-item__separator">·</span>
          <span className="annotation-item__page">{record.pageNumber}</span>
          {record.sectionLabel === undefined ? null : (
            <>
              <span className="annotation-item__separator">·</span>
              <span className="annotation-item__section" title={record.sectionLabel}>
                {record.sectionLabel}
              </span>
            </>
          )}
        </div>
        <FullAnnotationReaderActions
          onBack={onBack}
          {...(onEdit === undefined ? {} : { onEdit })}
        />
      </div>

      {record.origin === 'source' ? (
        <div className="full-annotation-reader__provenance">
          {record.author === undefined ? null : <span>Author: {record.author}</span>}
          <span>Read only</span>
        </div>
      ) : null}

      <div className="full-annotation-reader__body">
        <h3>{record.contentLabel}</h3>
        <p>{record.content}</p>
      </div>
    </section>
  );
}
