import { ReviewIcon } from './ReviewIcon.js';

export interface OutlineExpansionToggleProps {
  readonly restorePending: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

export function OutlineExpansionToggle({
  restorePending,
  disabled,
  onToggle,
}: OutlineExpansionToggleProps) {
  const label = restorePending
    ? 'Restore previous outline expansion'
    : 'Collapse all outline entries';
  return (
    <button
      type="button"
      className="review-workspace__move review-workspace__move--activity review-workspace__move--header-action review-workspace__outline-toggle"
      data-outline-expansion-toggle={restorePending ? 'restore' : 'collapse'}
      aria-label={label}
      title={label}
      aria-pressed={restorePending}
      disabled={disabled}
      onClick={onToggle}
    >
      <ReviewIcon name={restorePending ? 'chevrons-up-down' : 'chevrons-down-up'} />
    </button>
  );
}
