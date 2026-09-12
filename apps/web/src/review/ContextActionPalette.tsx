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

export type ContextPlacement = ViewerClientPlacement;

export interface ContextActionPaletteProps {
  readonly placement: ContextPlacement;
  readonly hidden?: boolean;
  onCopy?(): void;
  onReplace?(): void;
  onDelete?(): void;
  onHighlight?(): void;
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
    const place = () => {
      const bounds = host.getBoundingClientRect();
      const stageStyle = stage ? getComputedStyle(stage) : null;
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const left = Math.max(0, viewportLeft - bounds.left) + 12;
      const topEdge = Math.max(0, viewportTop - bounds.top) + 12;
      const windowRight = Math.min(bounds.width, viewportRight - bounds.left) - 12;
      const windowBottom = Math.min(bounds.height, viewportBottom - bounds.top) - 12;
      const width = element.getBoundingClientRect().width;
      const height = element.getBoundingClientRect().height;
      const trayRight = stage?.dataset.rightOverlay === 'true' ? parseFloat(stageStyle!.getPropertyValue('--review-overlay-right-start')) - 12 : windowRight;
      const trayBottom = stage?.dataset.bottomOverlay === 'true' ? parseFloat(stageStyle!.getPropertyValue('--review-overlay-bottom-start')) - 12 : windowBottom;
      // The actual visible window is the hard boundary, even when a host or
      // layout viewport extends beyond it during browser zoom or scrolling.
      const right = trayRight - left >= width ? Math.min(windowRight, trayRight) : windowRight;
      const bottom = trayBottom - topEdge >= height ? Math.min(windowBottom, trayBottom) : windowBottom;
      const anchorX = props.placement.left - bounds.left;
      const anchorY = props.placement.top - bounds.top;
      const source = props.placement.selectionBounds;
      const selection = source === undefined
        ? { left: anchorX, right: anchorX, top: anchorY, bottom: anchorY, width: 0, height: 0 }
        : { ...source, left: source.left - bounds.left, right: source.right - bounds.left,
          top: source.top - bounds.top, bottom: source.bottom - bounds.top };
      const position = chooseContextActionPlacement({
        selection, available: { left, top: topEdge, right, bottom, width: right - left, height: bottom - topEdge },
        width, height,
      });
      const next = { position: 'absolute' as const, ...position, transform: 'none' };
      setBoundedStyle((current) => current?.left === next.left && current?.top === next.top ? current : next);
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const resize = new ResizeObserver(place);
    resize.observe(host); resize.observe(element);
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
