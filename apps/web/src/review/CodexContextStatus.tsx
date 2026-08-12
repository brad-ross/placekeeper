import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface CodexContextStatusProps {
  readonly status: LiveContextBindingStatus;
}

/** Passive browser feedback for a task-scoped Codex launch. */
export function CodexContextStatus({ status }: CodexContextStatusProps) {
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

  return (
    <div
      className={`codex-context-status codex-context-status--${visualStatus}`}
      data-codex-context={visualStatus}
      aria-label={accessibleLabel}
      tabIndex={0}
    >
      <ReviewIcon name="agent" size={16} />
      <span className="codex-context-status__tooltip" role="tooltip">
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
