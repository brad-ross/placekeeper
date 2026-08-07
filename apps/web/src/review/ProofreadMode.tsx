import { useId, type ReactNode } from 'react';

import {
  PAGE_TEXT_UNAVAILABLE_MESSAGE,
  SELECTION_UNAVAILABLE_MESSAGE,
} from '../pdf/text-reliability.js';

export interface ProofreadModeProps {
  active: boolean;
  onActiveChange: (active: boolean) => void;
  pageSemanticReliable: boolean;
  selectionSemanticReliable?: boolean;
  pageNoteSafe?: boolean;
  onPageNote?: () => void;
  children?: ReactNode;
}

export function ProofreadMode({
  active,
  onActiveChange,
  pageSemanticReliable,
  selectionSemanticReliable = true,
  pageNoteSafe = true,
  onPageNote,
  children,
}: ProofreadModeProps) {
  const statusId = useId();
  const pageMessage = !pageSemanticReliable ? PAGE_TEXT_UNAVAILABLE_MESSAGE : null;
  const selectionMessage =
    pageSemanticReliable && !selectionSemanticReliable ? SELECTION_UNAVAILABLE_MESSAGE : null;
  const semanticToolsEnabled = active && pageSemanticReliable && selectionSemanticReliable;

  return (
    <section aria-labelledby={statusId} data-proofread-active={active ? 'true' : 'false'}>
      <div role="toolbar" aria-label="Review modes">
        <button
          type="button"
          aria-pressed={active}
          onClick={() => onActiveChange(!active)}
        >
          Proofread mode
        </button>
        <button type="button" disabled={!pageNoteSafe} onClick={onPageNote}>
          Page Note
        </button>
      </div>
      <p id={statusId} role="status" aria-live="polite">
        {active ? 'Proofread mode is on.' : 'Proofread mode is off. Navigation and selection are read-only.'}
      </p>
      {pageMessage ? <p data-recovery-kind="page">{pageMessage}</p> : null}
      {selectionMessage ? <p data-recovery-kind="selection">{selectionMessage}</p> : null}
      <div data-semantic-tools-enabled={semanticToolsEnabled ? 'true' : 'false'}>{children}</div>
    </section>
  );
}

