import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';

import type { ContextPlacement } from './ContextActionPalette.js';
import { ReviewIcon } from './ReviewIcon.js';
import { shortcutForReviewAction } from './review-actions.js';

export interface PageActionMenuProps {
  readonly placement: ContextPlacement;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  onGoToSource?(): void;
  onAddPageNote(): void;
  onDismiss(): void;
}

export function PageActionMenu(props: PageActionMenuProps) {
  const style: CSSProperties = { left: props.placement.left, top: props.placement.top };
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      // Chromium dispatches `contextmenu` before the secondary pointerup. Ignore
      // that trailing event so the gesture which opens the menu cannot also
      // dismiss it; primary outside-click and touch dismissal remain intact.
      if (event.button !== 0) return;
      if (!menuRef.current?.contains(event.target as Node)) props.onDismiss();
    };
    document.addEventListener('pointerup', dismissOutside);
    return () => document.removeEventListener('pointerup', dismissOutside);
  }, [props.onDismiss]);
  return (
    <div ref={menuRef} role="menu" aria-label="Page actions" className="review-page-menu" data-review-contextual-ui style={style}>
      {props.onGoToSource ? (
        <button
          type="button"
          role="menuitem"
          autoFocus
          title="Go to LaTeX Source"
          onClick={props.onGoToSource}
        >
          <ReviewIcon name="locate" />Go to Source
        </button>
      ) : null}
      <button
        ref={props.triggerRef}
        type="button"
        role="menuitem"
        autoFocus={props.onGoToSource === undefined}
        aria-keyshortcuts={shortcutForReviewAction('pageNote')}
        title="Add Page Note"
        onClick={props.onAddPageNote}
      >
        <ReviewIcon name="note" />Add Page Note
      </button>
    </div>
  );
}
