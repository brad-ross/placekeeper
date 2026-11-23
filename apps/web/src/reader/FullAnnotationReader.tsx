import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';

import type { PdfTargetVisibility } from '../pdf/viewer-navigation.js';
import type { AnnotationReaderRecord } from './annotation-reader.js';
import { AnnotationQuoteInContext } from './AnnotationExcerpt.js';
import { annotationKindIcon } from './AnnotationMetadata.js';
import { ReaderIcon } from './ReaderIcon.js';
import { ReaderTooltipButton } from './ReaderTooltipButton.js';

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
  readonly onAddContext?: () => void;
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
    'kind' | 'contentLabel' | 'content' | 'sourceText' | 'sourceTreatment' | 'quoteText' | 'quoteContext'>;
  /**
   * `card` reads like an annotation card: the annotated text, set in its page
   * context, comes first and the full comment follows. `prior-source` keeps the
   * authored text first, for reconciliation details that show where an
   * annotation used to be.
   */
  readonly layout?: 'card' | 'prior-source';
  readonly before?: ReactNode;
  readonly after?: ReactNode;
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
      <ReaderIcon name={annotationKindIcon(record.kind)} size={16} />
    </span>
    <span
      className="annotation-item__page"
      {...(prior ? { title: priorPageLabel, 'aria-label': priorPageLabel } : {})}
    >{pageLabel}</span>
    {readonly ? <span className="full-annotation-reader__readonly">Read only</span> : null}
  </div>;
}

export function FullAnnotationReaderBody({ record, layout = 'card', before, after }: FullAnnotationReaderBodyProps) {
  const paragraphs = (text: string) => text.split(/\n\s*\n/u).map(
    (paragraph, index) => <p key={index}>{paragraph}</p>,
  );
  const content = record.content ? <>
    <h3 className="sr-only">{record.contentLabel}</h3>
    {paragraphs(record.content)}
  </> : null;

  if (layout === 'prior-source') {
    return <div className="full-annotation-reader__body" data-reader-layout={layout}>
      {before}
      {record.sourceText ? <div className="full-annotation-reader__source" data-source-treatment={record.sourceTreatment}>
        <h3 className="sr-only">{record.kind === 'delete' ? 'Deleted text' : 'Original text'}</h3>
        {paragraphs(record.sourceText)}
      </div> : null}
      {content}
      {record.quoteText ? <div className="full-annotation-reader__quote">
        <h3 className="sr-only">Highlighted text</h3>
        {paragraphs(record.quoteText)}
      </div> : null}
      {after}
    </div>;
  }

  const quoteOnly = record.content ? 'false' : 'true';
  const hasQuoteContext = record.quoteContext === undefined ? undefined : 'true';
  const sourceTreatment = record.sourceTreatment ?? 'plain';
  return <div className="full-annotation-reader__body" data-reader-layout={layout}>
    {before}
    {record.sourceText ? <div
      className="full-annotation-reader__source annotation-item__source"
      data-source-treatment={sourceTreatment}
      data-quote-only={quoteOnly}
      data-has-quote-context={hasQuoteContext}
    >
      <h3 className="sr-only">{record.kind === 'delete' ? 'Deleted text' : 'Original text'}</h3>
      <p><AnnotationQuoteInContext
        text={record.sourceText}
        kind={sourceTreatment === 'struck' ? 'struck' : 'plain'}
        {...(record.quoteContext ? { context: record.quoteContext } : {})}
      /></p>
    </div> : null}
    {record.quoteText ? <div
      className="full-annotation-reader__quote annotation-item__quote"
      data-quote-only={quoteOnly}
      data-has-quote-context={hasQuoteContext}
    >
      <h3 className="sr-only">Highlighted text</h3>
      <p><AnnotationQuoteInContext
        text={record.quoteText}
        kind="highlight"
        {...(record.quoteContext ? { context: record.quoteContext } : {})}
      /></p>
    </div> : null}
    {content}
    {after}
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
    <ReaderTooltipButton
      ref={backRef}
      type="button"
      className="full-annotation-reader__back"
      data-full-annotation-action="back"
      label="Back"
      tooltip="Back to annotations"
      onClick={(event) => onBack(event.detail === 0)}
    >
      <ReaderIcon name="arrow-left" size={16} />
    </ReaderTooltipButton>
    {onEdit === undefined ? null : (
      <ReaderTooltipButton
        ref={editRef}
        type="button"
        className="full-annotation-reader__edit"
        data-full-annotation-action="edit"
        label="Edit"
        tooltip="Edit annotation"
        onClick={(event) => onEdit(event.currentTarget)}
      >
        <ReaderIcon name="edit" size={16} />
      </ReaderTooltipButton>
    )}
    {onOpenReference === undefined ? null : (
      <ReaderTooltipButton
        type="button"
        className="full-annotation-reader__open-reference"
        data-full-annotation-action="open-reference"
        label="Open in References"
        tooltip="Open in References"
        onClick={onOpenReference}
      >
        <ReaderIcon name="references" size={16} />
      </ReaderTooltipButton>
    )}
    {onDelete === undefined ? null : (
      <ReaderTooltipButton
        ref={deleteRef}
        type="button"
        className="full-annotation-reader__delete"
        data-full-annotation-action="delete"
        label="Delete"
        tooltip="Delete annotation"
        onClick={(event) => { void onDelete(event.currentTarget); }}
      >
        <ReaderIcon name="remove" size={16} />
      </ReaderTooltipButton>
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
  onAddContext,
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
          {onAddContext === undefined ? null : <ReaderTooltipButton
            type="button"
            className="full-annotation-reader__add-context"
            data-full-annotation-action="add-context"
            label="Add annotation to chat"
            aria-haspopup="dialog"
            onClick={onAddContext}
          ><ReaderIcon name="agent" size={16} /></ReaderTooltipButton>}
          {onOpenReference === undefined ? null : <ReaderTooltipButton
            type="button"
            className="full-annotation-reader__open-reference"
            data-full-annotation-action="open-reference"
            label="Open in References"
            tooltip="Open in References"
            onClick={onOpenReference}
          ><ReaderIcon name="references" size={16} /></ReaderTooltipButton>}
          {showLocate ? <ReaderTooltipButton
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
          ><ReaderIcon name={sourceNavigation?.pending ? 'loading' : 'locate'} size={16} /></ReaderTooltipButton> : null}
          {onEdit === undefined || record.kind === 'delete' ? null : <ReaderTooltipButton
            type="button"
            className="full-annotation-reader__edit"
            data-full-annotation-action="edit"
            label="Edit"
            tooltip="Edit annotation"
            onClick={(event) => onEdit(event.currentTarget)}
          ><ReaderIcon name="edit" size={16} /></ReaderTooltipButton>}
          {onDelete === undefined ? null : <ReaderTooltipButton
            type="button"
            className="full-annotation-reader__delete"
            data-full-annotation-action="delete"
            label="Delete"
            tooltip="Delete annotation"
            onClick={(event) => { void onDelete(event.currentTarget); }}
          ><ReaderIcon name="remove" size={16} /></ReaderTooltipButton>}
        </div>
      </header>

      <FullAnnotationReaderBody record={record} />
    </section>
  );
}
