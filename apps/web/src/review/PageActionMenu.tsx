import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

import type { ContextPlacement } from './ContextActionPalette.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';
import { shortcutForReviewAction } from './review-actions.js';

export interface PageActionMenuProps {
  readonly placement: ContextPlacement;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  onGoToSource?(): void;
  onAddPageNote(): void;
  onDismiss(): void;
}

const VIEWPORT_MARGIN = 8;

/** Keeps a fixed menu opened at a point fully inside the viewport. */
export function clampMenuToViewport(
  point: { readonly left: number; readonly top: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { left: number; top: number } {
  const maxLeft = viewport.width - size.width - VIEWPORT_MARGIN;
  const maxTop = viewport.height - size.height - VIEWPORT_MARGIN;
  return {
    left: Math.max(VIEWPORT_MARGIN, Math.min(point.left, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(point.top, maxTop)),
  };
}

export function PageActionMenu(props: PageActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.placement.left, top: props.placement.top });
  // A menu opened near the window's bottom or right edge moves inside it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const point = { left: props.placement.left, top: props.placement.top };
    if (!menu) {
      setPosition(point);
      return;
    }
    // Measure from the rendered box, which may sit offset from its style position.
    const bounds = menu.getBoundingClientRect();
    const offset = { left: bounds.left - position.left, top: bounds.top - position.top };
    const clamped = clampMenuToViewport(
      { left: point.left + offset.left, top: point.top + offset.top },
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition({ left: clamped.left - offset.left, top: clamped.top - offset.top });
  // Position is read only to learn the CSS offset; the placement drives this.
  }, [props.placement.left, props.placement.top]);
  const style: CSSProperties = position;
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
      <ReviewTooltipButton
        ref={props.triggerRef}
        type="button"
        role="menuitem"
        className="review-action-button review-action-button--icon"
        label="Add Page Note"
        tooltip="Page Note"
        autoFocus={props.onGoToSource === undefined}
        aria-keyshortcuts={shortcutForReviewAction('pageNote')}
        onClick={props.onAddPageNote}
      >
        <ReviewIcon name="note" />
      </ReviewTooltipButton>
    </div>
  );
}
