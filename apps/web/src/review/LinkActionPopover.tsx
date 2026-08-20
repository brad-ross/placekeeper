import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';

import type {
  ViewerFixedClientRect,
  ViewerPdfLinkInvocation,
  ViewerPdfLinkSourceScope,
} from '../pdf/viewer-interaction-events.js';
import { PDF_LINK_ACTION_MENU_ID } from '../pdf/viewer-interaction-events.js';
import { CopyLinkControl, type CopyLinkControlProps } from './CopyLinkControl.js';
import { compositeFocusIndex, enabledMenuItems } from './menu-focus.js';
import { ReviewIcon } from './ReviewIcon.js';

export type LinkActionChoice = 'references' | 'main' | 'same-reference';
export type LinkActionDismissReason = 'escape' | 'outside' | 'tab' | 'anchor-invalidated';

export function linkActionDismissRestoresFocus(reason: LinkActionDismissReason): boolean {
  // Tab owns its native sequential focus movement. The other dismissal paths
  // retain the explicit return-to-source behavior of the PDF-link chooser.
  return reason !== 'tab';
}

export interface LinkActionPopoverProps {
  readonly request: ViewerPdfLinkInvocation | null;
  readonly onChoose: (choice: LinkActionChoice, request: ViewerPdfLinkInvocation) => void;
  readonly onDismiss: (
    request: ViewerPdfLinkInvocation,
    reason: LinkActionDismissReason,
  ) => void;
  readonly copyLink?: CopyLinkControlProps;
  /** Resolves a stable focus surface when the source link has been virtualized. */
  readonly sourceFocusFallback?: (source: ViewerPdfLinkSourceScope) => HTMLElement | null;
}

interface ViewportRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface LinkActionPopoverPlacementInput {
  readonly anchor: ViewerFixedClientRect;
  readonly menu: { readonly width: number; readonly height: number };
  readonly viewport: ViewportRect;
  readonly gap?: number;
  readonly margin?: number;
}

export interface LinkActionPopoverPlacement {
  readonly left: number;
  readonly top: number;
  readonly placement: 'above' | 'below';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function placeLinkActionPopover({
  anchor,
  menu,
  viewport,
  gap = 8,
  margin = 12,
}: LinkActionPopoverPlacementInput): LinkActionPopoverPlacement {
  const minimumLeft = viewport.left + margin;
  const maximumLeft = viewport.right - margin - menu.width;
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - menu.height;
  const fitsBelow = belowTop + menu.height <= viewport.bottom - margin;
  const placement = fitsBelow || aboveTop < viewport.top + margin ? 'below' : 'above';
  return {
    left: clamp(anchor.left, minimumLeft, maximumLeft),
    top: clamp(
      placement === 'below' ? belowTop : aboveTop,
      viewport.top + margin,
      viewport.bottom - margin - menu.height,
    ),
    placement,
  };
}

export function setLinkActionOpenerExpanded(
  opener: HTMLButtonElement,
  expanded: boolean,
): void {
  opener.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

export function LinkActionMenuContent({
  label,
  pageContext,
  sourceScope,
  firstItemRef,
  copyLink,
  onChoose,
  onKeyDown,
  onBlur,
}: {
  readonly label: string;
  readonly pageContext: string;
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly firstItemRef: Ref<HTMLButtonElement>;
  readonly copyLink?: CopyLinkControlProps;
  readonly onChoose: (choice: LinkActionChoice) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onBlur: (event: FocusEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      id={PDF_LINK_ACTION_MENU_ID}
      className="link-action-popover__surface"
      role="menu"
      aria-label={`Open ${label}, ${pageContext}`}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={firstItemRef}
        type="button"
        role="menuitem"
        aria-label="Open in References"
        title="Open in References"
        onClick={() => onChoose('references')}
      >
        <ReviewIcon name="references" />
      </button>
      {sourceScope === 'reference' ? (
        <button
          type="button"
          role="menuitem"
          aria-label="Follow in this tab"
          title="Follow in this tab"
          onClick={() => onChoose('same-reference')}
        >
          <ReviewIcon name="arrow-right" />
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        aria-label="Open in main document"
        title="Open in main document"
        onClick={() => onChoose('main')}
      >
        <ReviewIcon name={sourceScope === 'main' ? 'arrow-right' : 'main'} />
      </button>
      {copyLink === undefined ? null : (
        <CopyLinkControl
          {...copyLink}
          variant="popover"
          presentation="icon-only"
          buttonRole="menuitem"
          feedbackPlacement="inline"
        />
      )}
    </div>
  );
}

function completeFocusableSurface(surface: HTMLElement): readonly HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>([
    'button:not(:disabled)',
    'input:not(:disabled)',
    '[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))];
}

function visibleViewport(): ViewportRect {
  const viewport = globalThis.visualViewport;
  if (viewport) {
    return {
      left: viewport.offsetLeft,
      top: viewport.offsetTop,
      right: viewport.offsetLeft + viewport.width,
      bottom: viewport.offsetTop + viewport.height,
    };
  }
  return {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth,
    bottom: document.documentElement.clientHeight,
  };
}

function rectStillAnchored(request: ViewerPdfLinkInvocation): boolean {
  if (!request.opener.isConnected) return false;
  const current = request.opener.getBoundingClientRect();
  const expected = request.clientRect;
  return Math.abs(current.left - expected.left) <= 1
    && Math.abs(current.top - expected.top) <= 1
    && Math.abs(current.width - expected.width) <= 1
    && Math.abs(current.height - expected.height) <= 1;
}

export function LinkActionPopover({
  request,
  onChoose,
  onDismiss,
  copyLink,
  sourceFocusFallback,
}: LinkActionPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const dismissingRef = useRef(false);
  const onChooseRef = useRef(onChoose);
  const onDismissRef = useRef(onDismiss);
  const sourceFocusFallbackRef = useRef(sourceFocusFallback);
  onChooseRef.current = onChoose;
  onDismissRef.current = onDismiss;
  sourceFocusFallbackRef.current = sourceFocusFallback;
  const [placement, setPlacement] = useState<LinkActionPopoverPlacement | null>(null);

  const restoreCancelFocus = useCallback((activeRequest: ViewerPdfLinkInvocation) => {
    requestAnimationFrame(() => {
      const target = activeRequest.opener.isConnected
        ? activeRequest.opener
        : sourceFocusFallbackRef.current?.(activeRequest.sourceScope);
      target?.focus({ preventScroll: true });
    });
  }, []);

  const dismiss = useCallback((reason: LinkActionDismissReason) => {
    if (!request || dismissingRef.current) return;
    dismissingRef.current = true;
    setLinkActionOpenerExpanded(request.opener, false);
    onDismissRef.current(request, reason);
    if (linkActionDismissRestoresFocus(reason)) restoreCancelFocus(request);
  }, [request, restoreCancelFocus]);

  useLayoutEffect(() => {
    dismissingRef.current = false;
    setPlacement(null);
    if (!request) return;
    const popover = popoverRef.current;
    if (!popover) return;
    setLinkActionOpenerExpanded(request.opener, true);

    const update = () => {
      if (!rectStillAnchored(request)) {
        dismiss('anchor-invalidated');
        return;
      }
      const bounds = popover.getBoundingClientRect();
      const nextPlacement = placeLinkActionPopover({
        anchor: request.clientRect,
        menu: { width: bounds.width, height: bounds.height },
        viewport: visibleViewport(),
      });
      setPlacement((current) => current?.left === nextPlacement.left
        && current.top === nextPlacement.top
        && current.placement === nextPlacement.placement
        ? current
        : nextPlacement);
    };
    const popoverApi = popover as HTMLDivElement & { showPopover?: () => void };
    try {
      popoverApi.showPopover?.();
    } catch {
      // A fixed-position fallback remains usable where the Popover API is absent.
    }
    update();
    firstItemRef.current?.focus({ preventScroll: true });

    const viewport = globalThis.visualViewport;
    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !popover.contains(event.target)) dismiss('outside');
    };
    const invalidateAnchor = (event: Event) => {
      if (event.target instanceof Node && popover.contains(event.target)) return;
      dismiss('anchor-invalidated');
    };
    let updateFrame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(updateFrame);
      updateFrame = requestAnimationFrame(update);
    };
    const observeConnection = new MutationObserver((records) => {
      if (!rectStillAnchored(request)) {
        dismiss('anchor-invalidated');
        return;
      }
      if (records.some(({ target }) => popover.contains(target))) scheduleUpdate();
    });
    observeConnection.observe(document.body, { attributes: true, childList: true, subtree: true });
    const observeBounds = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleUpdate);
    observeBounds?.observe(popover);
    document.addEventListener('pointerdown', outsidePointer, true);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', invalidateAnchor, true);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', invalidateAnchor);
    return () => {
      setLinkActionOpenerExpanded(request.opener, false);
      cancelAnimationFrame(updateFrame);
      observeConnection.disconnect();
      observeBounds?.disconnect();
      document.removeEventListener('pointerdown', outsidePointer, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', invalidateAnchor, true);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', invalidateAnchor);
    };
  }, [dismiss, request]);

  if (!request || typeof document === 'undefined') return null;
  const choose = (choice: LinkActionChoice) => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    setLinkActionOpenerExpanded(request.opener, false);
    onChooseRef.current(choice, request);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss('escape');
      return;
    }
    if (event.key === 'Tab') {
      const focusable = completeFocusableSurface(event.currentTarget);
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const leaving = event.shiftKey ? activeIndex <= 0 : activeIndex === focusable.length - 1;
      if (leaving) {
        dismiss('tab');
      } else {
        event.preventDefault();
        focusable[activeIndex + (event.shiftKey ? -1 : 1)]?.focus({ preventScroll: true });
      }
      return;
    }
    const items = enabledMenuItems(event.currentTarget);
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (activeIndex < 0) return;
    const nextIndex = compositeFocusIndex(activeIndex, items.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
      dismiss('tab');
    }
  };
  const style = {
    '--link-action-left': `${placement?.left ?? request.clientRect.left}px`,
    '--link-action-top': `${placement?.top ?? request.clientRect.bottom + 8}px`,
  } as CSSProperties;

  return createPortal(
    <div
      ref={popoverRef}
      className="link-action-popover"
      data-link-action-popover
      data-placement={placement?.placement ?? 'below'}
      popover="manual"
      style={style}
    >
      <LinkActionMenuContent
        label={request.metadata.label}
        pageContext={request.metadata.pageContext}
        sourceScope={request.sourceScope}
        firstItemRef={firstItemRef}
        {...(copyLink === undefined ? {} : { copyLink })}
        onChoose={choose}
        onKeyDown={keyDown}
        onBlur={blur}
      />
    </div>,
    document.body,
  );
}
