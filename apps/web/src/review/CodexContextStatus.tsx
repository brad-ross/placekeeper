import type { LiveContextBindingStatus } from '../../../../packages/core/src/live-context.js';

export interface CodexContextStatusProps {
  readonly status: LiveContextBindingStatus;
}

/** Passive browser feedback for a task-scoped Codex launch. */
export function CodexContextStatus({ status }: CodexContextStatusProps) {
  if (status.status === 'current') {
    return (
      <div
        className="codex-context-status codex-context-status--current"
        data-codex-context="current"
        aria-label={`Codex context current at review revision ${status.identity.reviewRevision}`}
      >
        <span className="codex-context-status__dot" aria-hidden="true" />
        <span>Context current</span>
      </div>
    );
  }

  if (status.status === 'pending' || status.status === 'refreshing') {
    return (
      <div
        className="codex-context-status codex-context-status--connecting"
        data-codex-context="connecting"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="codex-context-status__dot" aria-hidden="true" />
        <span>Context connecting</span>
      </div>
    );
  }

  return (
    <div
      className="codex-context-status codex-context-status--unavailable"
      data-codex-context="unavailable"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="codex-context-status__dot" aria-hidden="true" />
      <span>
        <strong>Live PDF context is unavailable.</strong>{' '}
        Ask Codex to reopen this PDF.
      </span>
    </div>
  );
}
