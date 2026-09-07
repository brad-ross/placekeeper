import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import { ReviewIcon } from './ReviewIcon.js';
import { placeLinkActionPopover, visibleReviewViewport } from './LinkActionPopover.js';

export interface CodexContextStatusProps {
  readonly status: LiveContextBindingStatus;
}

/** Passive browser feedback for a task-scoped Codex launch. */
export function CodexContextStatus({ status }: CodexContextStatusProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const current = status.status === 'current';
  const connecting = status.status === 'pending' || status.status === 'refreshing';
  const visualStatus = current ? 'current' : connecting ? 'connecting' : 'unavailable';
  const title = current
    ? 'Agent context current'
    : status.status === 'refreshing'
      ? 'Agent context updating'
      : connecting
        ? 'Agent context connecting'
        : 'Agent context unavailable';
  const detail = current
    ? 'PDF content and annotations are synced with the connected agent.'
    : status.status === 'refreshing'
      ? 'Syncing your latest annotation changes with the connected agent.'
      : connecting
        ? 'Connecting this PDF to your agent.'
        : 'Reopen this PDF from your agent to restore live context.';
  const accessibleLabel = current
    ? `${title} at review revision ${status.identity.reviewRevision}`
    : `${title}. ${detail}`;

  const positionTooltip = () => {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;
    const bounds = tooltip.getBoundingClientRect();
    const next = placeLinkActionPopover({
      anchor: anchor.getBoundingClientRect(),
      menu: { width: bounds.width, height: bounds.height },
      viewport: visibleReviewViewport(),
      gap: 6,
      margin: 6,
    });
    setPlacement((previous) => previous.left === next.left && previous.top === next.top
      ? previous : { left: next.left, top: next.top });
  };

  useLayoutEffect(() => {
    positionTooltip();
    window.addEventListener('resize', positionTooltip);
    window.visualViewport?.addEventListener('resize', positionTooltip);
    return () => {
      window.removeEventListener('resize', positionTooltip);
      window.visualViewport?.removeEventListener('resize', positionTooltip);
    };
  }, [title, detail]);

  return (
    <div
      ref={anchorRef}
      className={`codex-context-status codex-context-status--${visualStatus}`}
      data-codex-context={visualStatus}
      aria-label={accessibleLabel}
      tabIndex={0}
      onPointerEnter={positionTooltip}
      onFocus={positionTooltip}
    >
      <ReviewIcon name="agent" size={16} />
      <span ref={tooltipRef} className="codex-context-status__tooltip" role="tooltip" style={placement}>
        <strong className="codex-context-status__tooltip-title">
          <span className="codex-context-status__tooltip-dot" aria-hidden="true" />
          {title}
        </strong>
        <span className="codex-context-status__tooltip-detail">{detail}</span>
      </span>
      {!current ? (
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {accessibleLabel}
        </span>
      ) : null}
    </div>
  );
}
