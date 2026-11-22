import { ReaderIcon } from './ReaderIcon.js';
import { ReaderTooltipButton } from './ReaderTooltipButton.js';

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
    <ReaderTooltipButton
      label={label}
      type="button"
      className="reader-workspace__move reader-workspace__move--activity reader-workspace__move--header-action reader-workspace__outline-toggle"
      data-outline-expansion-toggle={restorePending ? 'restore' : 'collapse'}
      aria-label={label}
      aria-pressed={restorePending}
      disabled={disabled}
      onClick={onToggle}
    >
      <ReaderIcon name={restorePending ? 'unfold-vertical' : 'fold-vertical'} />
    </ReaderTooltipButton>
  );
}
