import type { DocumentContextState } from '../host/document-in-context.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

export interface DocumentContextButtonProps {
  readonly state: DocumentContextState;
  readonly onActivate: () => void;
}

function contextLabel(state: DocumentContextState): string {
  switch (state.status) {
    case 'idle':
      return 'Put document in context';
    case 'publishing':
      return 'Putting document in context…';
    case 'available':
      return 'Document in context';
    case 'unsupported':
    case 'unavailable':
      return `Document not in context. ${state.reason}${state.canActivate ? ' Try again' : ''}`;
  }
}

export function DocumentContextButton({ state, onActivate }: DocumentContextButtonProps) {
  const canActivate = (state.status === 'idle' || state.status === 'unavailable') && state.canActivate;
  const label = contextLabel(state);
  const visualStatus = state.status === 'publishing' ? 'connecting'
    : state.status === 'available' ? 'current'
      : state.status === 'idle' ? 'idle' : 'unavailable';

  return <>
    <ReviewTooltipButton
      type="button"
      className={`codex-context-status codex-context-status--${visualStatus} document-context-button`}
      data-document-context={state.status}
      label={label}
      aria-disabled={!canActivate || undefined}
      aria-busy={state.status === 'publishing' || undefined}
      keepTooltipOnKeyboardActivation
      onClick={canActivate ? onActivate : undefined}
    >
      <ReviewIcon name="agent" />
    </ReviewTooltipButton>
    <span className="sr-only" role="status" aria-atomic="true">
      {state.status === 'idle' ? '' : label}
    </span>
  </>;
}
