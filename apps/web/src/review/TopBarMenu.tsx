import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import {
  placeLinkActionPopover,
  visibleReviewViewport,
  type LinkActionPopoverPlacement,
} from './LinkActionPopover.js';
import { enabledMenuItems, menuRovingFocusIndex } from './menu-focus.js';

export type TopBarMenuDismissReason = 'escape' | 'outside' | 'tab' | 'anchor-invalidated';

export interface TopBarMenuProps {
  readonly open: boolean;
  readonly menuId: string;
  readonly label: string;
  readonly openerRef: RefObject<HTMLElement | null>;
  readonly onDismiss: (reason: TopBarMenuDismissReason) => void;
  readonly focusFallback?: () => HTMLElement | null;
  readonly focusOnOpen?: boolean;
  readonly hoverOpen?: boolean;
  readonly hoverRegionRef?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

export function TopBarMenu({
  open,
  menuId,
  label,
  openerRef,
  onDismiss,
  focusFallback,
  focusOnOpen = true,
  hoverOpen = false,
  hoverRegionRef,
  children,
}: TopBarMenuProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dismissingRef = useRef(false);
  const openerPointerRef = useRef(false);
  const onDismissRef = useRef(onDismiss);
  const focusFallbackRef = useRef(focusFallback);
  const [placement, setPlacement] = useState<LinkActionPopoverPlacement | null>(null);
  onDismissRef.current = onDismiss;
  focusFallbackRef.current = focusFallback;

  const restoreOpenerFocus = useCallback(() => {
    requestAnimationFrame(() => {
      const opener = openerRef.current;
      const target = opener?.isConnected ? opener : focusFallbackRef.current?.();
      target?.focus({ preventScroll: true });
    });
  }, [openerRef]);

  const dismiss = useCallback((reason: TopBarMenuDismissReason, restoreFocus = true) => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    onDismissRef.current(reason);
    if (restoreFocus && reason !== 'tab') restoreOpenerFocus();
  }, [restoreOpenerFocus]);

  useLayoutEffect(() => {
    dismissingRef.current = false;
    openerPointerRef.current = false;
    setPlacement(null);
    if (!open) return;
    const surface = surfaceRef.current;
    const opener = openerRef.current;
    if (!surface || !opener?.isConnected) {
      dismiss('anchor-invalidated');
      return;
    }

    const update = () => {
      const currentOpener = openerRef.current;
      if (!currentOpener?.isConnected) {
        dismiss('anchor-invalidated');
        return;
      }
      const anchor = currentOpener.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      const next = placeLinkActionPopover({
        anchor,
        menu: { width: bounds.width, height: bounds.height },
        viewport: visibleReviewViewport(),
        alignment: 'end',
      });
      setPlacement((current) => current?.left === next.left
        && current.top === next.top
        && current.placement === next.placement
        ? current
        : next);
    };

    const popover = surface as HTMLDivElement & { showPopover?: () => void };
    try {
      popover.showPopover?.();
    } catch {
      // Fixed positioning remains usable when the Popover API is unavailable.
    }
    update();
    if (!hoverOpen) {
      if (focusOnOpen) (enabledMenuItems(surface)[0] ?? surface).focus({ preventScroll: true });
      else opener.focus({ preventScroll: true });
    }

    let hoverDismissTimer: ReturnType<typeof setTimeout> | undefined;
    const clearHoverDismiss = () => clearTimeout(hoverDismissTimer);
    const hoverPointer = (event: PointerEvent) => {
      if (!hoverOpen || event.pointerType !== 'mouse') return;
      const target = event.target;
      if (target instanceof Node && (surface.contains(target)
        || (hoverRegionRef?.current ?? opener).contains(target))) {
        clearHoverDismiss();
        hoverDismissTimer = undefined;
      } else if (hoverDismissTimer === undefined) {
        // Allow crossing the small gap between the trigger and its portal.
        hoverDismissTimer = setTimeout(() => dismiss('outside', false), 140);
      }
    };
    const leaveDocument = (event: PointerEvent) => {
      if (!hoverOpen || event.pointerType !== 'mouse' || event.relatedTarget !== null) return;
      clearHoverDismiss();
      hoverDismissTimer = setTimeout(() => dismiss('outside', false), 140);
    };

    let updateFrame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(updateFrame);
      updateFrame = requestAnimationFrame(update);
    };
    const outsidePointer = (event: PointerEvent) => {
      openerPointerRef.current = event.target instanceof Node
        && openerRef.current?.contains(event.target) === true;
      if (event.target instanceof Node && surface.contains(event.target)) return;
      if (event.target instanceof Node && openerRef.current?.contains(event.target)) return;
      if (event.target instanceof Node && hoverRegionRef?.current?.contains(event.target)) return;
      const switchingTopBarMenu = event.target instanceof Element
        && event.target.closest('[data-review-chrome-group], [data-document-actions-trigger]') !== null;
      dismiss('outside', !hoverOpen && !switchingTopBarMenu);
    };
    const openerKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.target instanceof Node) || !opener.contains(event.target) || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss('escape');
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = enabledMenuItems(surface);
        (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus({ preventScroll: true });
      } else if (event.key === 'Tab') dismiss('tab', false);
    };
    const connectionObserver = new MutationObserver(() => {
      if (!openerRef.current?.isConnected) {
        dismiss('anchor-invalidated');
        return;
      }
      scheduleUpdate();
    });
    const boundsObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleUpdate);
    const chrome = opener.closest('[data-review-chrome]');
    if (chrome) connectionObserver.observe(chrome, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    boundsObserver?.observe(surface);
    boundsObserver?.observe(opener);
    if (chrome) boundsObserver?.observe(chrome);
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('pointermove', hoverPointer, true);
    document.addEventListener('pointerout', leaveDocument, true);
    document.addEventListener('keydown', openerKeyDown, true);
    window.addEventListener('resize', scheduleUpdate);
    globalThis.visualViewport?.addEventListener('resize', scheduleUpdate);
    globalThis.visualViewport?.addEventListener('scroll', scheduleUpdate);
    return () => {
      cancelAnimationFrame(updateFrame);
      clearHoverDismiss();
      connectionObserver.disconnect();
      boundsObserver?.disconnect();
      document.removeEventListener('pointerdown', outsidePointer, true);
      document.removeEventListener('pointermove', hoverPointer, true);
      document.removeEventListener('pointerout', leaveDocument, true);
      document.removeEventListener('keydown', openerKeyDown, true);
      window.removeEventListener('resize', scheduleUpdate);
      globalThis.visualViewport?.removeEventListener('resize', scheduleUpdate);
      globalThis.visualViewport?.removeEventListener('scroll', scheduleUpdate);
    };
  }, [dismiss, open, openerRef, focusOnOpen, hoverOpen, hoverRegionRef]);

  if (!open || typeof document === 'undefined') return null;

  const opener = openerRef.current;
  const initialAnchor = opener?.getBoundingClientRect();
  const style = {
    position: 'fixed',
    left: `${placement?.left ?? initialAnchor?.left ?? 12}px`,
    top: `${placement?.top ?? (initialAnchor?.bottom ?? 4) + 8}px`,
  } as CSSProperties;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    openerPointerRef.current = false;
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      dismiss('escape');
      return;
    }
    const items = enabledMenuItems(event.currentTarget);
    const nextIndex = menuRovingFocusIndex({
      items,
      activeElement: document.activeElement,
      eventTarget: event.target,
      key: event.key,
    });
    if (nextIndex === null) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // WebKit may report null while a pointer activation is still resolving.
    if (event.relatedTarget === null) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    // Let the opener's click toggle the menu. Dismissing on pointer-induced
    // blur would close it before that click and immediately reopen it.
    if (openerPointerRef.current && event.relatedTarget instanceof Node
      && openerRef.current?.contains(event.relatedTarget)) return;
    dismiss('tab');
  };

  return createPortal(
    <div
      ref={surfaceRef}
      id={menuId}
      className="document-actions__menu top-bar-menu__surface"
      data-top-bar-menu
      data-placement={placement?.placement ?? 'below'}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      popover="manual"
      style={style}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {children}
    </div>,
    document.body,
  );
}
