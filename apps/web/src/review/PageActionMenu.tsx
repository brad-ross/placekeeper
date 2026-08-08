import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';

import type { ContextPlacement } from './ContextActionPalette.js';
import { shortcutForReviewAction } from './review-actions.js';

export interface PageActionMenuProps {
  readonly placement: ContextPlacement;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  onAddPageNote(): void;
  onDismiss(): void;
}

export function PageActionMenu(props: PageActionMenuProps) {
  const style: CSSProperties = { left: props.placement.left, top: props.placement.top };
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) props.onDismiss();
    };
    document.addEventListener('pointerup', dismissOutside);
    return () => document.removeEventListener('pointerup', dismissOutside);
  }, [props.onDismiss]);
  return (
    <div ref={menuRef} role="menu" aria-label="Page actions" className="review-page-menu" data-review-contextual-ui style={style}>
      <button
        ref={props.triggerRef}
        type="button"
        role="menuitem"
        autoFocus
        aria-keyshortcuts={shortcutForReviewAction('pageNote')}
        onClick={props.onAddPageNote}
      >
        Add Page Note
      </button>
    </div>
  );
}
