import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ViewerClientPlacement, ViewerFixedClientRect } from '../pdf/viewer-interaction-events.js';

import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';
import { reviewActions } from './review-actions.js';

type ContextActionKind = 'copy' | 'replace' | 'delete' | 'highlight';

const copyAction = {
  kind: 'copy',
  label: 'Copy',
  shortcut: 'Meta+C Control+C',
} as const;

interface ContextActionButtonProps {
  readonly kind: ContextActionKind;
  readonly iconOnly?: boolean;
  readonly onAction: (() => void) | undefined;
}

function ContextActionButton({ kind, iconOnly = false, onAction }: ContextActionButtonProps) {
  const action = kind === 'copy'
    ? copyAction
    : reviewActions.find((candidate) => candidate.kind === kind)!;
  return (
    <ReviewTooltipButton
      type="button"
      className={`review-action-button${iconOnly ? ' review-action-button--icon' : ''}`}
      label={action.label}
      aria-keyshortcuts={action.shortcut}
      onClick={(event) => {
        event.currentTarget.focus({ preventScroll: true });
        onAction?.();
      }}
    >
      <ReviewIcon name={kind} />
      {iconOnly ? null : action.label}
    </ReviewTooltipButton>
  );
}

export type ContextPlacement = ViewerClientPlacement & {
  readonly surface?: 'main' | 'reference';
};

export interface ContextActionPaletteProps {
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
  onCopy?(): void;
  onReplace?(): void;
  onDelete?(): void;
  onHighlight?(): void;
}

export function chooseContextActionAvailableRect(input: {
  readonly host: ViewerFixedClientRect;
  readonly viewport: ViewerFixedClientRect;
  readonly referenceViewport?: ViewerFixedClientRect;
  readonly surface?: ContextPlacement['surface'];
  readonly overlayRight: number;
  readonly overlayBottom: number;
}): ViewerFixedClientRect {
  const inset = 12;
  const { host, viewport, referenceViewport } = input;
  const windowLeft = Math.max(0, viewport.left - host.left) + inset;
  const windowTop = Math.max(0, viewport.top - host.top) + inset;
  const windowRight = Math.min(host.width, viewport.right - host.left) - inset;
  const windowBottom = Math.min(host.height, viewport.bottom - host.top) - inset;
  const useReferenceViewport = input.surface === 'reference' && referenceViewport !== undefined;
  const left = useReferenceViewport
    ? Math.max(windowLeft, referenceViewport.left - host.left + inset)
    : windowLeft;
  const top = useReferenceViewport
    ? Math.max(windowTop, referenceViewport.top - host.top + inset)
    : windowTop;
  const right = useReferenceViewport
    ? Math.min(windowRight, referenceViewport.right - host.left - inset)
    : Math.min(windowRight, input.overlayRight);
  const bottom = useReferenceViewport
    ? Math.min(windowBottom, referenceViewport.bottom - host.top - inset)
    : Math.min(windowBottom, input.overlayBottom);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function chooseContextActionPlacement(input: {
  readonly selection: ViewerFixedClientRect;
  readonly available: ViewerFixedClientRect;
  readonly width: number;
  readonly height: number;
}): { left: number; top: number } {
  const { selection, available, width, height } = input;
  const gap = 7;
  const left = Math.max(available.left, Math.min(
    (selection.left + selection.right - width) / 2, available.right - width,
  ));
  const above = selection.top - gap - height;
  const below = selection.bottom + gap;
  if (above >= available.top) return { left, top: Math.min(above, available.bottom - height) };
  if (below + height <= available.bottom) return { left, top: Math.max(available.top, below) };
  const top = Math.max(available.top, Math.min(selection.top, available.bottom - height));
  if (selection.right + gap + width <= available.right) return { left: selection.right + gap, top };
  if (selection.left - gap - width >= available.left) return { left: selection.left - gap - width, top };
  // A selection can fill the entire visible reading area. Keep its actions
  // reachable at the edge when no non-overlapping placement exists.
  return { left, top: available.top };
}

export function ContextActionPalette(props: ContextActionPaletteProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const [boundedStyle, setBoundedStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const element = elementRef.current;
    const host = element?.closest<HTMLElement>('.review-contextual-host');
    const stage = element?.closest<HTMLElement>('[data-review-stage]');
    if (!element || !host) return;
    const referenceViewportElement = props.placement.surface === 'reference'
      ? stage?.querySelector<HTMLElement>(
        '.reference-panel__viewport:not([data-reference-viewport-concealed="true"])',
      )
      : undefined;
    const place = () => {
      const bounds = host.getBoundingClientRect();
      const stageStyle = stage ? getComputedStyle(stage) : null;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const width = element.getBoundingClientRect().width;
      const height = element.getBoundingClientRect().height;
      const hostRight = Math.min(bounds.width, viewportRight - bounds.left) - 12;
      const hostBottom = Math.min(bounds.height, viewportBottom - bounds.top) - 12;
      const trayRight = stage?.dataset.rightOverlay === 'true' ? parseFloat(stageStyle!.getPropertyValue('--review-overlay-right-start')) - 12 : hostRight;
      const trayBottom = stage?.dataset.bottomOverlay === 'true' ? parseFloat(stageStyle!.getPropertyValue('--review-overlay-bottom-start')) - 12 : hostBottom;
      // The actual visible window is the hard boundary, even when a host or
      // layout viewport extends beyond it during browser zoom or scrolling.
      const referenceViewport = referenceViewportElement?.getBoundingClientRect();
      const available = chooseContextActionAvailableRect({
        host: bounds,
        viewport: {
          left: viewportLeft,
          top: viewportTop,
          right: viewportRight,
          bottom: viewportBottom,
          width: viewportRight - viewportLeft,
          height: viewportBottom - viewportTop,
        },
        ...(referenceViewport === undefined ? {} : { referenceViewport }),
        ...(props.placement.surface === undefined ? {} : { surface: props.placement.surface }),
        overlayRight: trayRight,
        overlayBottom: trayBottom,
      });
      const right = props.placement.surface === 'reference'
        ? available.right
        : available.right - available.left >= width ? available.right : hostRight;
      const bottom = props.placement.surface === 'reference'
        ? available.bottom
        : available.bottom - available.top >= height ? available.bottom : hostBottom;
      const availableWidth = Math.max(0, right - available.left);
      const availableHeight = Math.max(0, bottom - available.top);
      const placementWidth = props.placement.surface === 'reference'
        ? Math.min(width, availableWidth)
        : width;
      const placementHeight = props.placement.surface === 'reference'
        ? Math.min(height, availableHeight)
        : height;
      const anchorX = props.placement.left - bounds.left;
      const anchorY = props.placement.top - bounds.top;
      const source = props.placement.selectionBounds;
      const selection = source === undefined
        ? { left: anchorX, right: anchorX, top: anchorY, bottom: anchorY, width: 0, height: 0 }
        : { ...source, left: source.left - bounds.left, right: source.right - bounds.left,
          top: source.top - bounds.top, bottom: source.bottom - bounds.top };
      const position = chooseContextActionPlacement({
        selection,
        available: {
          ...available,
          right,
          bottom,
          width: availableWidth,
          height: availableHeight,
        },
        width: placementWidth,
        height: placementHeight,
      });
      const next: CSSProperties = {
        position: 'absolute',
        ...position,
        transform: 'none',
        ...(props.placement.surface === 'reference' ? {
          maxWidth: availableWidth,
          maxHeight: availableHeight,
          overflow: 'auto',
        } : {}),
      };
      setBoundedStyle((current) => current?.left === next.left
        && current?.top === next.top
        && current?.maxWidth === next.maxWidth
        && current?.maxHeight === next.maxHeight
        ? current : next);
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const resize = new ResizeObserver(place);
    resize.observe(host); resize.observe(element);
    if (referenceViewportElement) resize.observe(referenceViewportElement);
    const mutation = new MutationObserver(place);
    if (stage) mutation.observe(stage, { attributes: true, attributeFilter: ['style', 'data-right-overlay', 'data-bottom-overlay'] });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      resize.disconnect(); mutation.disconnect();
    };
  }, [props.placement, props.hidden]);
  const style: CSSProperties = {
    position: 'absolute',
    left: props.placement.left,
    top: props.placement.top,
    transform: props.placement.suggestTop ? 'translate(-50%, calc(-100% - .45rem))' : 'translate(-50%, .45rem)',
  };
  return (
    <div
      ref={elementRef}
      role="toolbar"
      aria-label="Selection review actions"
      className="review-context-palette"
      data-review-contextual-ui
      hidden={props.hidden}
      inert={props.hidden}
      style={boundedStyle ?? style}
    >
      <ContextActionButton kind="replace" iconOnly onAction={props.onReplace} />
      <ContextActionButton kind="delete" iconOnly onAction={props.onDelete} />
      <ContextActionButton kind="highlight" iconOnly onAction={props.onHighlight} />
      {props.onCopy ? <ContextActionButton kind="copy" iconOnly onAction={props.onCopy} /> : null}
    </div>
  );
}

export interface InsertionCaretProps {
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
}

export function InsertionCaret({ placement, hidden }: InsertionCaretProps) {
  const rotation = placement.rotation ?? 0;
  const width = rotation % 2 === 0 ? placement.width : placement.height;
  const height = rotation % 2 === 0 ? placement.height : placement.width;
  const style: CSSProperties = {
    left: placement.left,
    top: placement.top,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    transform: `translate(-50%, -50%) rotate(${rotation * 90}deg)`,
  };
  return (
    <span
      aria-hidden="true"
      className="review-insertion-caret"
      data-review-insertion-caret
      hidden={hidden}
      style={style}
    />
  );
}
