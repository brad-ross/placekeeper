import { useLayoutEffect, useRef } from 'react';

import type { AnnotationReaderRecord } from './annotation-reader.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface FullAnnotationReaderProps {
  readonly record: AnnotationReaderRecord;
  readonly onBack: () => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
  readonly entryFocus?: 'heading' | 'edit';
}

export function FullAnnotationReader({
  record,
  onBack,
  onEdit,
  entryFocus = 'heading',
}: FullAnnotationReaderProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    (entryFocus === 'edit' ? editRef.current : headingRef.current)?.focus({ preventScroll: true });
  }, [record.identity.origin === 'owned'
    ? record.identity.itemId
    : `${record.identity.documentGeneration}:${record.identity.discoveryGeneration}:${record.identity.annotationKey}`,
  entryFocus]);

  const heading = `Full annotation — ${record.typeLabel}, page ${record.pageNumber}`;

  return (
    <section
      className="full-annotation-reader"
      data-full-annotation-reader="true"
      data-annotation-origin={record.origin}
      aria-labelledby="full-annotation-reader-heading"
    >
      <header className="full-annotation-reader__header">
        <button
          type="button"
          className="full-annotation-reader__back"
          title="Back to annotations"
          onClick={onBack}
        >
          <ReviewIcon name="arrow-left" size={15} />
          <span>Back</span>
        </button>
        <h2
          ref={headingRef}
          id="full-annotation-reader-heading"
          tabIndex={-1}
        >
          {heading}
        </h2>
        {record.mutable && onEdit !== undefined ? (
          <button
            ref={editRef}
            type="button"
            className="full-annotation-reader__edit"
            title="Edit annotation"
            onClick={(event) => onEdit(event.currentTarget)}
          >
            <ReviewIcon name="edit" size={15} />
            <span>Edit</span>
          </button>
        ) : null}
      </header>

      <div className="full-annotation-reader__metadata" aria-label="Annotation details">
        <span>{record.typeLabel}</span>
        <span>Page {record.pageNumber}</span>
        {record.sectionLabel === undefined ? null : <span>{record.sectionLabel}</span>}
        {record.origin === 'source' && record.author !== undefined ? (
          <span>Author: {record.author}</span>
        ) : null}
        {record.mutable ? null : <span className="full-annotation-reader__readonly">Read only</span>}
      </div>

      <div className="full-annotation-reader__body">
        <h3>{record.contentLabel}</h3>
        <p>{record.content}</p>
      </div>
    </section>
  );
}
