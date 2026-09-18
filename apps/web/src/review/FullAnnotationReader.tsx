import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';

import type { PdfTargetVisibility } from '../pdf/viewer-navigation.js';
import type { AnnotationReaderRecord } from './annotation-reader.js';
import { annotationKindIcon } from './AnnotationMetadata.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

export interface FullAnnotationReaderSourceNavigation {
  readonly visibility: PdfTargetVisibility;
  readonly pending: boolean;
  readonly onReturn: () => void;
}

export interface FullAnnotationReaderProps {
  readonly record: AnnotationReaderRecord;
  readonly onBack: (restoreRowFocus?: boolean) => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
  readonly onDelete?: (trigger: HTMLButtonElement) => void | Promise<void>;
  readonly onOpenReference?: () => void;
  readonly sourceNavigation?: FullAnnotationReaderSourceNavigation;
}

export interface FullAnnotationReaderActionsProps {
  readonly onBack: (restoreRowFocus?: boolean) => void;
  readonly onEdit?: (trigger: HTMLButtonElement) => void;
  readonly onDelete?: (trigger: HTMLButtonElement) => void | Promise<void>;
  readonly onOpenReference?: () => void;
  readonly backRef?: Ref<HTMLButtonElement>;
  readonly editRef?: Ref<HTMLButtonElement>;
  readonly deleteRef?: Ref<HTMLButtonElement>;
}

export interface FullAnnotationReaderBodyProps {
  readonly record: Pick<AnnotationReaderRecord,
    'kind' | 'contentLabel' | 'content' | 'sourceText' | 'sourceTreatment' | 'quoteText'>;
  readonly before?: ReactNode;
}

export interface FullAnnotationReaderMetadataProps {
  readonly record: Pick<AnnotationReaderRecord,
    'kind' | 'typeLabel' | 'pageNumber' | 'lastPageNumber'>;
  readonly prior?: boolean;
  readonly readonly?: boolean;
}

export function FullAnnotationReaderMetadata({
  record,
  prior = false,
  readonly = false,
}: FullAnnotationReaderMetadataProps) {
  const pageLabel = record.lastPageNumber === undefined
    ? `${record.pageNumber}`
    : `${record.pageNumber}–${record.lastPageNumber}`;
  const priorPageLabel = record.lastPageNumber === undefined
    ? `Previously page ${record.pageNumber}`
    : `Previously pages ${record.pageNumber}–${record.lastPageNumber}`;
  return <div className="full-annotation-reader__metadata annotation-item__meta" aria-label="Annotation details">
    <span className="annotation-item__kind-icon" title={record.typeLabel}>
      <ReviewIcon name={annotationKindIcon(record.kind)} size={16} />
    </span>
    <span
      className="annotation-item__page"
      {...(prior ? { title: priorPageLabel, 'aria-label': priorPageLabel } : {})}
    >{pageLabel}</span>
    {readonly ? <span className="full-annotation-reader__readonly">Read only</span> : null}
  </div>;
}

export function FullAnnotationReaderBody({ record, before }: FullAnnotationReaderBodyProps) {
  const paragraphs = (text: string) => text.split(/\n\s*\n/u).map(
    (paragraph, index) => <p key={index}>{paragraph}</p>,
  );
  return <div className="full-annotation-reader__body">
    {before}
    {record.sourceText ? <div className="full-annotation-reader__source" data-source-treatment={record.sourceTreatment}>
      <h3 className="sr-only">{record.kind === 'delete' ? 'Deleted text' : 'Original text'}</h3>
      {paragraphs(record.sourceText)}
    </div> : null}
    {record.content ? <>
      <h3 className="sr-only">{record.contentLabel}</h3>
      {paragraphs(record.content)}
    </> : null}
    {record.quoteText ? <div className="full-annotation-reader__quote">
      <h3 className="sr-only">Highlighted text</h3>
      {paragraphs(record.quoteText)}
    </div> : null}
  </div>;
}

export function shouldRestoreFullAnnotationReaderFocus(
  locateWasShown: boolean,
  locateIsShown: boolean,
  locateHeldFocus: boolean,
): boolean {
  return locateWasShown && !locateIsShown && locateHeldFocus;
}

export function FullAnnotationReaderActions({
  onBack,
  onEdit,
  onDelete,
  onOpenReference,
  backRef,
  editRef,
  deleteRef,
}: FullAnnotationReaderActionsProps) {
  return <>
    <ReviewTooltipButton
      ref={backRef}
      type="button"
      className="full-annotation-reader__back"
      data-full-annotation-action="back"
      label="Back"
      tooltip="Back to annotations"
      onClick={(event) => onBack(event.detail === 0)}
    >
      <ReviewIcon name="arrow-left" size={16} />
    </ReviewTooltipButton>
    {onEdit === undefined ? null : (
      <ReviewTooltipButton
        ref={editRef}
        type="button"
        className="full-annotation-reader__edit"
        data-full-annotation-action="edit"
        label="Edit"
        tooltip="Edit annotation"
        onClick={(event) => onEdit(event.currentTarget)}
      >
        <ReviewIcon name="edit" size={16} />
      </ReviewTooltipButton>
    )}
    {onOpenReference === undefined ? null : (
      <ReviewTooltipButton
        type="button"
        className="full-annotation-reader__open-reference"
        data-full-annotation-action="open-reference"
        label="Open in References"
        tooltip="Open in References"
        onClick={onOpenReference}
      >
        <ReviewIcon name="references" size={16} />
      </ReviewTooltipButton>
    )}
    {onDelete === undefined ? null : (
      <ReviewTooltipButton
        ref={deleteRef}
        type="button"
        className="full-annotation-reader__delete"
        data-full-annotation-action="delete"
        label="Delete"
        tooltip="Delete annotation"
        onClick={(event) => { void onDelete(event.currentTarget); }}
      >
        <ReviewIcon name="remove" size={16} />
      </ReviewTooltipButton>
    )}
  </>;
}

export function FullAnnotationReader({
  record,
  onBack,
  onEdit,
  onDelete,
  onOpenReference,
  sourceNavigation,
}: FullAnnotationReaderProps) {
  const pageDescription = record.lastPageNumber === undefined
    ? `page ${record.pageNumber}`
    : `pages ${record.pageNumber}–${record.lastPageNumber}`;
  const showLocate = sourceNavigation?.visibility === 'outside' || sourceNavigation?.pending === true;
  const backRef = useRef<HTMLButtonElement>(null);
  const locateHeldFocus = useRef(false);
  const previousShowLocate = useRef(showLocate);
  useLayoutEffect(() => {
    if (shouldRestoreFullAnnotationReaderFocus(
      previousShowLocate.current,
      showLocate,
      locateHeldFocus.current,
    )) {
      backRef.current?.focus({ preventScroll: true });
    }
    if (!showLocate) locateHeldFocus.current = false;
    previousShowLocate.current = showLocate;
  }, [showLocate]);
  return (
    <section
      className="full-annotation-reader"
      data-full-annotation-reader="true"
      data-annotation-origin={record.origin}
      aria-label={`Full ${record.typeLabel} annotation on ${pageDescription}`}
    >
      <header className="full-annotation-reader__metadata-bar">
        <div className="full-annotation-reader__actions" aria-label="Full annotation actions">
          <FullAnnotationReaderActions onBack={onBack} backRef={backRef} />
        </div>
        <FullAnnotationReaderMetadata record={record} readonly={record.origin === 'source'} />
        <div className="full-annotation-reader__header-actions">
          {onOpenReference === undefined ? null : <ReviewTooltipButton
            type="button"
            className="full-annotation-reader__open-reference"
            data-full-annotation-action="open-reference"
            label="Open in References"
            tooltip="Open in References"
            onClick={onOpenReference}
          ><ReviewIcon name="references" size={16} /></ReviewTooltipButton>}
          {showLocate ? <ReviewTooltipButton
            type="button"
            className="full-annotation-reader__locate"
            data-full-annotation-action="locate"
            label={sourceNavigation?.pending ? 'Returning to annotation in PDF' : 'Back to annotation in PDF'}
            disabled={sourceNavigation?.pending}
            onFocus={() => { locateHeldFocus.current = true; }}
            onBlur={() => { locateHeldFocus.current = false; }}
            onClick={() => {
              locateHeldFocus.current = true;
              sourceNavigation?.onReturn();
            }}
          ><ReviewIcon name={sourceNavigation?.pending ? 'loading' : 'locate'} size={16} /></ReviewTooltipButton> : null}
          {onEdit === undefined || record.kind === 'delete' ? null : <ReviewTooltipButton
            type="button"
            className="full-annotation-reader__edit"
            data-full-annotation-action="edit"
            label="Edit"
            tooltip="Edit annotation"
            onClick={(event) => onEdit(event.currentTarget)}
          ><ReviewIcon name="edit" size={16} /></ReviewTooltipButton>}
          {onDelete === undefined ? null : <ReviewTooltipButton
            type="button"
            className="full-annotation-reader__delete"
            data-full-annotation-action="delete"
            label="Delete"
            tooltip="Delete annotation"
            onClick={(event) => { void onDelete(event.currentTarget); }}
          ><ReviewIcon name="remove" size={16} /></ReviewTooltipButton>}
        </div>
      </header>

      <FullAnnotationReaderBody record={record} />
    </section>
  );
}
