import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

import type { ReviewStateSummaryV1 } from '../../../../packages/core/src/live-context.js';
import type { GenerationRefreshStatus } from '../generation-status.js';
import { compositeFocusIndex, enabledMenuItems } from './menu-focus.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface ReviewExportPresentation {
  readonly canExport: boolean;
  readonly requiresStaleConfirmation: boolean;
  readonly annotationBlocked: boolean;
  readonly message: string;
}

export function reviewExportPresentation(input: {
  readonly refreshStatus: GenerationRefreshStatus;
  readonly summary: ReviewStateSummaryV1;
}): ReviewExportPresentation {
  if (input.refreshStatus === 'reconciling') {
    return {
      canExport: false,
      requiresStaleConfirmation: false,
      annotationBlocked: false,
      message: 'Export becomes available after document reconciliation finishes.',
    };
  }
  const unresolvedItems = input.summary.reconciliation.unresolvedItemIds.length;
  const pendingDrafts = input.summary.reconciliation.pendingDraftIds.length;
  if (unresolvedItems > 0 || pendingDrafts > 0) {
    const parts = [
      unresolvedItems > 0
        ? `${unresolvedItems} Review Item${unresolvedItems === 1 ? '' : 's'}`
        : '',
      pendingDrafts > 0
        ? `${pendingDrafts} pending draft${pendingDrafts === 1 ? '' : 's'}`
        : '',
    ].filter(Boolean);
    return {
      canExport: false,
      requiresStaleConfirmation: false,
      annotationBlocked: true,
      message: `Resolve ${parts.join(' and ')} before export.`,
    };
  }
  if (input.summary.export.requiresStaleConfirmation || input.refreshStatus === 'failed') {
    return {
      canExport: true,
      requiresStaleConfirmation: true,
      annotationBlocked: false,
      message: 'The last successful PDF may be stale. Confirm before exporting this generation.',
    };
  }
  return {
    canExport: input.summary.export.eligible,
    requiresStaleConfirmation: false,
    annotationBlocked: false,
    message: input.summary.export.eligible
      ? 'All Review Items are reconciled. The latest generation is ready to export.'
      : 'Reviewed PDF export is not available yet.',
  };
}

export interface DocumentActionsMenuProps {
  readonly documentTitle: string;
  readonly savedLabel: string;
  readonly savePhase?: 'clean' | 'saving' | 'not-saved';
  readonly presentation: ReviewExportPresentation;
  readonly onExport: (confirmPossiblyStale?: true) => Promise<unknown>;
  readonly onOpenAnnotations?: () => void;
  readonly defaultOpen?: boolean;
}

type ExportOutcome = 'idle' | 'pending' | 'success' | 'failure';

export function DocumentActionsMenu({
  documentTitle,
  savedLabel,
  savePhase = 'clean',
  presentation,
  onExport,
  onOpenAnnotations,
  defaultOpen = false,
}: DocumentActionsMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [staleConfirmation, setStaleConfirmation] = useState(false);
  const [outcome, setOutcome] = useState<ExportOutcome>('idle');
  const generatedId = useId().replaceAll(':', '');
  const menuId = `document-actions-menu-${generatedId}`;
  const reasonId = `document-export-reason-${generatedId}`;
  const resultId = `document-export-result-${generatedId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLButtonElement>(null);
  const pending = outcome === 'pending';

  const closeAndRestore = () => {
    if (pending) return;
    setOpen(false);
    setStaleConfirmation(false);
    setOutcome('idle');
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const closeForAction = () => {
    if (pending) return;
    setOpen(false);
    setStaleConfirmation(false);
    setOutcome('idle');
  };

  useLayoutEffect(() => {
    if (!open) return;
    const target = staleConfirmation ? confirmationRef.current : exportRef.current;
    target?.focus({ preventScroll: true });
  }, [open, staleConfirmation]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      closeAndRestore();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, pending]);

  const exportReviewedPdf = async (confirmPossiblyStale?: true) => {
    if (pending) return;
    setOutcome('pending');
    try {
      await onExport(confirmPossiblyStale);
      setStaleConfirmation(false);
      setOutcome('success');
    } catch {
      setStaleConfirmation(false);
      setOutcome('failure');
    }
    requestAnimationFrame(() => exportRef.current?.focus({ preventScroll: true }));
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestore();
      return;
    }
    const items = enabledMenuItems(event.currentTarget);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0) return;
    const nextIndex = compositeFocusIndex(currentIndex, items.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!open || pending) return;
    // WebKit can dispatch a null relatedTarget while clicking a control inside
    // the menu. The pointerdown listener remains the authority for outside
    // dismissal in that case, so do not unmount before the control's click runs.
    if (event.relatedTarget === null) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOpen(false);
    setStaleConfirmation(false);
    setOutcome('idle');
  };

  const resultMessage = outcome === 'pending'
    ? 'Exporting reviewed PDF…'
    : outcome === 'success'
      ? 'Reviewed PDF exported.'
      : outcome === 'failure'
        ? 'Export failed safely. Try again.'
        : '';
  const exportUnavailable = !presentation.canExport || pending;

  return <div
    ref={rootRef}
    className="document-actions"
    data-document-actions
    data-document-actions-open={open ? 'true' : undefined}
    onBlur={onBlur}
  >
    <button
      ref={triggerRef}
      type="button"
      className="review-chrome__save-identity document-actions__trigger"
      data-document-actions-trigger
      aria-label={`${documentTitle}, ${savedLabel}. Open document actions`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      title="Open document actions"
      onClick={() => {
        if (open) closeAndRestore();
        else setOpen(true);
      }}
    >
      <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />
      <strong>{documentTitle}</strong>
      <ReviewIcon name="chevron-down" size={14} />
      <span className="sr-only" data-review-saved-status>{savedLabel}</span>
    </button>
    {open ? <div
      id={menuId}
      className="document-actions__menu"
      role="menu"
      aria-label={`Actions for ${documentTitle}`}
      data-export-eligibility={presentation.canExport ? 'eligible' : 'blocked'}
      onKeyDown={onMenuKeyDown}
    >
      {staleConfirmation ? <>
        <p className="document-actions__heading">Export the last successful PDF?</p>
        <p id={reasonId} className="document-actions__message">{presentation.message}</p>
        <div className="document-actions__confirmation" role="group" aria-label="Confirm possibly stale export">
          <button
            ref={confirmationRef}
            type="button"
            role="menuitem"
            aria-disabled={pending}
            onClick={() => {
              if (pending) return;
              setStaleConfirmation(false);
              queueMicrotask(() => exportRef.current?.focus({ preventScroll: true }));
            }}
          ><ReviewIcon name="close" size={15} /><span>Cancel</span></button>
          <button
            type="button"
            role="menuitem"
            aria-disabled={pending}
            onClick={() => void exportReviewedPdf(true)}
          ><ReviewIcon name="download" size={15} /><span>Confirm export</span></button>
        </div>
        {resultMessage ? <p
          id={resultId}
          className="document-actions__result"
          role="status"
          aria-live="polite"
          data-export-result={outcome}
        >{resultMessage}</p> : null}
      </> : <>
        <button
          ref={exportRef}
          type="button"
          role="menuitem"
          className="document-actions__export"
          aria-disabled={exportUnavailable}
          aria-describedby={`${reasonId}${resultMessage ? ` ${resultId}` : ''}`}
          onClick={() => {
            if (exportUnavailable) return;
            if (presentation.requiresStaleConfirmation) {
              setStaleConfirmation(true);
              return;
            }
            void exportReviewedPdf();
          }}
        >
          <ReviewIcon
            name={pending ? 'loading' : outcome === 'success' ? 'check' : 'download'}
            size={15}
            className={pending ? 'review-icon document-actions__loading' : 'review-icon'}
          />
          <span>{outcome === 'failure' ? 'Retry export' : 'Export reviewed PDF'}</span>
        </button>
        <p id={reasonId} className="document-actions__message">{presentation.message}</p>
        {presentation.annotationBlocked && onOpenAnnotations ? <button
          type="button"
          role="menuitem"
          className="document-actions__annotations-link"
          onClick={() => {
            closeForAction();
            requestAnimationFrame(onOpenAnnotations);
          }}
        ><ReviewIcon name="annotations" size={15} /><span>Open Annotations</span></button> : null}
        {resultMessage ? <p
          id={resultId}
          className="document-actions__result"
          role="status"
          aria-live="polite"
          data-export-result={outcome}
        >{resultMessage}</p> : null}
      </>}
    </div> : null}
  </div>;
}
