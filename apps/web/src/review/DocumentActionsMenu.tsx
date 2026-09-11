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
import { enabledMenuItems, menuRovingFocusIndex } from './menu-focus.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

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
  if (!input.summary.reconciliation.complete) {
    const attentionCount = unresolvedItems + pendingDrafts;
    const message = attentionCount === 0
      ? 'Annotations to resolve.'
      : `${attentionCount} annotation${attentionCount === 1 ? '' : 's'} to resolve.`;
    return {
      canExport: false,
      requiresStaleConfirmation: false,
      annotationBlocked: true,
      message,
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
    message: input.summary.export.eligible ? '' : 'Reviewed PDF export is not available yet.',
  };
}

export interface DocumentActionsMenuProps {
  readonly documentTitle: string;
  readonly savedLabel: string;
  readonly showSaveStatusDot?: boolean;
  readonly savePhase?: 'clean' | 'saving' | 'not-saved';
  readonly presentation: ReviewExportPresentation;
  readonly onExport: (confirmPossiblyStale?: true) => Promise<ReviewExportResult | void>;
  readonly onOpenAnnotations?: () => void;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly requestToken?: number;
  readonly onRequestHandled?: (token: number) => void;
}

type ExportOutcome = 'idle' | 'pending' | 'success' | 'failure';

export interface ReviewExportResult {
  readonly kind?: string;
  readonly warning?: string;
}

function exportMessageFromResult(result: ReviewExportResult | void): string {
  if (result?.warning !== undefined && result.warning.trim() !== '') return result.warning;
  return 'Reviewed PDF exported.';
}

const EXPORT_OUTCOME_MESSAGES: Readonly<Record<ExportOutcome, string>> = {
  idle: '',
  pending: '',
  success: 'Reviewed PDF exported.',
  failure: 'Export failed. Your review is still available; try again.',
};

export function DocumentActionsMenu({
  showSaveStatusDot = true,
  documentTitle,
  savedLabel,
  savePhase = 'clean',
  presentation,
  onExport,
  onOpenAnnotations,
  open: controlledOpen,
  onOpenChange,
  onPendingChange,
  requestToken,
  onRequestHandled,
}: DocumentActionsMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [staleConfirmation, setStaleConfirmation] = useState(false);
  const [outcome, setOutcome] = useState<ExportOutcome>('idle');
  const [exportDetail, setExportDetail] = useState('');
  const generatedId = useId().replaceAll(':', '');
  const menuId = `document-actions-menu-${generatedId}`;
  const reasonId = `document-export-reason-${generatedId}`;
  const resultId = `document-export-result-${generatedId}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const annotationActionRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const handledRequestTokenRef = useRef(0);
  const pending = outcome === 'pending';

  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const closeAndRestore = (restoreFocus = true) => {
    if (pending) return;
    setOpen(false);
    setStaleConfirmation(false);
    setOutcome('idle');
    setExportDetail('');
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const closeForAction = () => {
    if (pending) return;
    setOpen(false);
    setStaleConfirmation(false);
    setOutcome('idle');
    setExportDetail('');
  };

  useLayoutEffect(() => {
    if (!open) return;
    const target = staleConfirmation
      ? confirmationRef.current
      : presentation.canExport
        ? exportRef.current
        : annotationActionRef.current ?? exportRef.current;
    target?.focus({ preventScroll: true });
  }, [open, presentation.canExport, staleConfirmation]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      const switchingTopBarMenu = event.target instanceof Element
        && event.target.closest('[data-review-chrome-group]') !== null;
      closeAndRestore(!switchingTopBarMenu);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, pending]);

  useEffect(() => {
    if (open || pending) return;
    setStaleConfirmation(false);
    setOutcome('idle');
    setExportDetail('');
  }, [open, pending]);

  const exportReviewedPdf = async (confirmPossiblyStale?: true) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setOutcome('pending');
    setExportDetail('');
    onPendingChange?.(true);
    try {
      const result = await onExport(confirmPossiblyStale);
      setStaleConfirmation(false);
      setExportDetail(result?.kind === 'cancelled' ? '' : exportMessageFromResult(result));
      setOutcome(result?.kind === 'cancelled' ? 'idle' : 'success');
    } catch {
      setStaleConfirmation(false);
      setOutcome('failure');
    } finally {
      pendingRef.current = false;
      onPendingChange?.(false);
    }
    requestAnimationFrame(() => exportRef.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    const token = requestToken ?? 0;
    if (token <= 0 || token === handledRequestTokenRef.current) return;
    handledRequestTokenRef.current = token;
    onRequestHandled?.(token);
    setOpen(true);
    if (pendingRef.current) return;
    setOutcome('idle');
    setExportDetail('');
    if (!presentation.canExport) {
      setStaleConfirmation(false);
      return;
    }
    if (presentation.requiresStaleConfirmation) {
      setStaleConfirmation(true);
      return;
    }
    setStaleConfirmation(false);
    void exportReviewedPdf();
  }, [requestToken]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestore();
      return;
    }
    const items = enabledMenuItems(event.currentTarget);
    const nextIndex = menuRovingFocusIndex({
      items,
      activeElement: document.activeElement,
      eventTarget: event.target,
      key: event.key,
    });
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

  const resultMessage = exportDetail || EXPORT_OUTCOME_MESSAGES[outcome];
  const exportUnavailable = !presentation.canExport || pending;
  const annotationAttentionVisible = presentation.annotationBlocked && onOpenAnnotations !== undefined;
  const reasonVisible = presentation.message !== '' && !annotationAttentionVisible;
  const exportDescriptionIds = [
    presentation.message === '' ? '' : reasonId,
    resultMessage ? resultId : '',
  ].filter(Boolean).join(' ');
  const exportLabel = pending ? 'Exporting…' : outcome === 'failure' ? 'Retry export' : 'Export';

  return <div
    ref={rootRef}
    className="document-actions"
    data-document-actions
    data-document-actions-open={open ? 'true' : undefined}
    onBlur={onBlur}
  >
    <ReviewTooltipButton
      label={`${documentTitle}, ${savedLabel}. Open document actions`}
      tooltip={`${documentTitle} — Save options`}
      ref={triggerRef}
      type="button"
      className="review-chrome__save-identity document-actions__trigger"
      data-document-actions-trigger
      aria-label={`${documentTitle}, ${savedLabel}. Open document actions`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={menuId}
      onClick={() => {
        if (open) closeAndRestore();
        else setOpen(true);
      }}
    >
      <ReviewIcon name="file" size={16} />
      <span className="review-chrome__filename">{documentTitle}</span>
      {!showSaveStatusDot || savePhase === 'clean' ? null : <span className="review-chrome__save-dot" data-save-phase={savePhase} aria-hidden="true" />}
      <span className="sr-only" data-review-saved-status>{savedLabel}</span>
    </ReviewTooltipButton>
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
            title="Cancel export confirmation"
            aria-disabled={pending}
            onClick={() => {
              if (pending) return;
              setStaleConfirmation(false);
              queueMicrotask(() => exportRef.current?.focus({ preventScroll: true }));
            }}
          ><ReviewIcon name="close" /><span>Cancel</span></button>
          <button
            type="button"
            role="menuitem"
            title="Confirm export"
            aria-disabled={pending}
            onClick={() => void exportReviewedPdf(true)}
          ><ReviewIcon name="download" /><span>Confirm export</span></button>
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
          title={exportLabel}
          className="document-actions__export"
          aria-disabled={exportUnavailable}
          {...(exportDescriptionIds === '' ? {} : { 'aria-describedby': exportDescriptionIds })}
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

            className={pending ? 'review-icon document-actions__loading' : 'review-icon'}
          />
          <span>{exportLabel}</span>
        </button>
        {annotationAttentionVisible ? <div
          className="document-actions__attention"
          data-document-actions-attention
        >
          <p id={reasonId} className="document-actions__attention-label">
            <ReviewIcon name="warning" />
            <span>{presentation.message}</span>
          </p>
          <button
            ref={annotationActionRef}
            type="button"
            role="menuitem"
            title="Open Annotations"
            className="review-button review-button--secondary document-actions__annotations-link"
            onClick={() => {
              closeForAction();
              requestAnimationFrame(onOpenAnnotations);
            }}
          ><ReviewIcon name="annotations" /><span>Open Annotations</span></button>
        </div> : reasonVisible ? <p id={reasonId} className="document-actions__message">
          {presentation.message}
        </p> : null}
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
