import type { Position, Rotation, Size } from '@embedpdf/models';

import type { CaretAnchor, PdfSpaceRect } from './selection-anchor.js';
import type { ReliabilityDiagnostic } from './text-reliability.js';
import { restorePagePoint } from './selection-anchor.js';

export interface ViewerClientPlacement {
  readonly left: number;
  readonly top: number;
  readonly suggestTop?: boolean;
}

export interface ViewerPagePoint {
  readonly documentId: string;
  readonly pageIndex: number;
  readonly viewportGeneration: number;
  readonly x: number;
  readonly y: number;
}

export interface ViewerPageMenuInvocation {
  readonly invocationId: string;
  readonly point: ViewerPagePoint;
  readonly placement: ViewerClientPlacement;
}

export interface ViewerCaretUpdate {
  readonly anchor: CaretAnchor | null;
  readonly placement: ViewerClientPlacement | null;
  readonly diagnostic?: ReliabilityDiagnostic;
}

export interface ViewerSelectionPlacement {
  readonly pageIndex: number;
  readonly rect: PdfSpaceRect;
  readonly placement: ViewerClientPlacement;
}

export interface ViewerOwnedMarkInteraction {
  readonly id: string;
  readonly phase: 'enter' | 'leave' | 'focus' | 'blur' | 'activate';
}

export type ViewerInteractionEvent =
  | { readonly type: 'readiness'; readonly ready: boolean; readonly reason?: string }
  | { readonly type: 'page'; readonly currentPage: number; readonly totalPages: number }
  | { readonly type: 'zoom'; readonly zoomPercent: number }
  | { readonly type: 'scroll' }
  | { readonly type: 'selection-placement'; readonly value: ViewerSelectionPlacement | null }
  | { readonly type: 'caret'; readonly value: ViewerCaretUpdate }
  | { readonly type: 'page-menu'; readonly value: ViewerPageMenuInvocation | null }
  | { readonly type: 'page-note-cursor'; readonly value: ViewerPagePoint | null }
  | { readonly type: 'page-note-commit'; readonly value: ViewerPagePoint }
  | { readonly type: 'owned-mark'; readonly value: ViewerOwnedMarkInteraction };

export type ViewerInteractionListener = (event: ViewerInteractionEvent) => void;

// EmbedPDF deliberately exposes an engine-neutral pointer event that omits the DOM
// `button` field. The page wrapper records it during capture so neutral handlers can
// still distinguish primary activation from a secondary-button context gesture.
const pointerButtonByTarget = new WeakMap<object, number>();
export const VIEWER_POINTER_BUTTON_NONE = -1;

export function dispatchNeutralViewerPointerUp(target: EventTarget, event: {
  readonly altKey: boolean;
  readonly clientX: number;
  readonly clientY: number;
  readonly ctrlKey: boolean;
  readonly isPrimary: boolean;
  readonly metaKey: boolean;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly shiftKey: boolean;
}): void {
  target.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    composed: true,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: event.isPrimary,
    button: VIEWER_POINTER_BUTTON_NONE,
    buttons: 0,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  }));
}

export function recordViewerPointerButton(target: object, button: number): void {
  pointerButtonByTarget.set(target, button);
}

export function viewerPointerButton(event: { readonly currentTarget: unknown }): number | undefined {
  const { currentTarget } = event;
  if ((typeof currentTarget !== 'object' && typeof currentTarget !== 'function') || currentTarget === null) {
    return undefined;
  }
  return pointerButtonByTarget.get(currentTarget);
}

export interface PageEventGeometry {
  readonly pageSize: Size;
  readonly rotation: Rotation;
  readonly scale: number;
  readonly elementLeft: number;
  readonly elementTop: number;
}

/** Normalizes a DOM page event into natural, unscaled, pre-crop page space. */
export function normalizePageClientPoint(
  point: Position,
  geometry: PageEventGeometry,
): Position | null {
  if (!Number.isFinite(geometry.scale) || geometry.scale <= 0) return null;
  const restored = restorePagePoint(
    geometry.pageSize,
    { x: point.x - geometry.elementLeft, y: point.y - geometry.elementTop },
    geometry.rotation,
    geometry.scale,
  );
  const epsilon = 0.001;
  if (
    !Number.isFinite(restored.x) || !Number.isFinite(restored.y) ||
    restored.x < -epsilon || restored.y < -epsilon ||
    restored.x > geometry.pageSize.width + epsilon ||
    restored.y > geometry.pageSize.height + epsilon
  ) return null;
  return restored;
}

export function isUnsafePageContextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target.closest([
    '[data-owned-mark]',
    '[data-owned-annotation-layer]',
    '[data-source-annotation-layer]',
    '[data-review-contextual-ui]',
    '[data-review-editor]',
    'input',
    'textarea',
    '[contenteditable="true"]',
  ].join(',')) !== null;
}
