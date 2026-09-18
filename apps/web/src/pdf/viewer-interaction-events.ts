import type { Position, Rotation, Size } from '@embedpdf/models';

import type { CaretAnchor, PdfSpaceRect } from './selection-anchor.js';
import type { ReliabilityDiagnostic } from './text-reliability.js';
import { restorePagePoint } from './selection-anchor.js';
import type { PdfNavigationMetadata } from './pdf-navigation-metadata.js';
import type { PdfNavigationTarget } from './pdf-navigation-target.js';
import type { PdfViewerScope } from './viewer-document-ids.js';
import type { PdfAnnotationSurface } from './annotation-surface.js';

/** Stable relationship target for the one active link-action menu. */
export const PDF_LINK_ACTION_MENU_ID = 'pdf-link-action-menu';
export const PDF_LINK_INTERACTION_ATTRIBUTE = 'data-pdf-link-control';

export interface ViewerClientPlacement {
  readonly selectionBounds?: ViewerFixedClientRect;
  readonly left: number;
  readonly top: number;
  readonly width?: number;
  readonly height?: number;
  readonly suggestTop?: boolean;
  readonly rotation?: Rotation;
}

export interface ViewerFixedClientRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export type ViewerPdfLinkSourceScope = PdfViewerScope;

export function scopeViewerInteraction(
  event: ViewerInteractionEvent,
  surface: PdfAnnotationSurface,
): ViewerInteractionEvent {
  return { ...event, surface };
}

export interface ViewerPdfLinkInvocation {
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly sourcePageIndex: number;
  readonly target: PdfNavigationTarget;
  readonly metadata: PdfNavigationMetadata;
  /** Transient focus return target. It must never enter durable application state. */
  readonly opener: HTMLButtonElement;
  /** Fixed activation-time geometry for chooser placement. */
  readonly clientRect: ViewerFixedClientRect;
}

export interface ViewerPdfLinkUnavailable {
  readonly sourceScope: ViewerPdfLinkSourceScope;
  readonly sourcePageIndex: number;
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
  readonly pageIndex?: number;
  readonly placement?: ViewerClientPlacement;
}

export interface ViewerSourceMarkInteraction {
  readonly annotationKey: string;
  readonly phase: 'enter' | 'leave' | 'focus' | 'blur' | 'activate';
  readonly pageIndex: number;
  readonly placement?: ViewerClientPlacement;
}

export type ViewerInteractionEvent = (
  | { readonly type: 'readiness'; readonly ready: boolean; readonly reason?: string }
  | { readonly type: 'page'; readonly currentPage: number; readonly totalPages: number }
  | { readonly type: 'zoom'; readonly zoomPercent: number }
  | { readonly type: 'scroll' }
  | { readonly type: 'selection-placement'; readonly value: ViewerSelectionPlacement | null }
  | { readonly type: 'caret'; readonly value: ViewerCaretUpdate }
  | { readonly type: 'page-menu'; readonly value: ViewerPageMenuInvocation | null }
  | {
      readonly type: 'reverse-synctex';
      readonly value: {
        readonly pageIndex: number;
        readonly point: { readonly x: number; readonly y: number };
      };
    }
  | { readonly type: 'page-note-cursor'; readonly value: ViewerPagePoint | null }
  | { readonly type: 'page-note-commit'; readonly value: ViewerPagePoint }
  | { readonly type: 'owned-mark'; readonly value: ViewerOwnedMarkInteraction }
  | { readonly type: 'owned-mark-clear' }
  | { readonly type: 'source-mark'; readonly value: ViewerSourceMarkInteraction }
  | { readonly type: 'pdf-link'; readonly value: ViewerPdfLinkInvocation }
  | { readonly type: 'pdf-link-unavailable'; readonly value: ViewerPdfLinkUnavailable }
) & { readonly surface?: PdfAnnotationSurface };

export type ViewerInteractionListener = (event: ViewerInteractionEvent) => void;

export function isContextPointerGesture(event: {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly pointerType: string;
}): boolean {
  return event.button === 2 || (event.pointerType === 'mouse' && event.ctrlKey);
}

// EmbedPDF deliberately exposes an engine-neutral pointer event that omits the DOM
// `button` field. The page wrapper records it during capture so neutral handlers can
// still distinguish primary activation from a secondary-button context gesture.
const pointerButtonByTarget = new WeakMap<object, number>();
export const VIEWER_POINTER_BUTTON_NONE = -1;

export function fixedViewerClientRect(rect: Pick<DOMRectReadOnly,
  'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>): ViewerFixedClientRect {
  return Object.freeze({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  });
}

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

export function isReverseSyncTexPointerGesture(
  event: { readonly button: number; readonly ctrlKey: boolean; readonly metaKey: boolean },
  platform = globalThis.navigator?.platform ?? '',
): boolean {
  if (event.button !== 0) return false;
  return /^Mac/iu.test(platform) ? event.metaKey : event.ctrlKey;
}

interface PendingReverseSyncTexPointer {
  readonly clientX: number;
  readonly clientY: number;
  dragged: boolean;
}

/** Tracks modifier-clicks through capture and rejects drags before reverse SyncTeX. */
export class ReverseSyncTexPointerGesture {
  readonly #pending = new Map<number, PendingReverseSyncTexPointer>();

  constructor(readonly movementThreshold = 5) {}

  pointerDown(pointerId: number, clientX: number, clientY: number): void {
    this.#pending.set(pointerId, { clientX, clientY, dragged: false });
  }

  has(pointerId: number): boolean {
    return this.#pending.has(pointerId);
  }

  pointerMove(pointerId: number, clientX: number, clientY: number): void {
    const pending = this.#pending.get(pointerId);
    if (pending === undefined || pending.dragged) return;
    if (Math.hypot(clientX - pending.clientX, clientY - pending.clientY) > this.movementThreshold) {
      pending.dragged = true;
    }
  }

  pointerUp(pointerId: number, clientX: number, clientY: number): { readonly activate: boolean } | undefined {
    this.pointerMove(pointerId, clientX, clientY);
    const pending = this.#pending.get(pointerId);
    if (pending === undefined) return undefined;
    this.#pending.delete(pointerId);
    return { activate: !pending.dragged };
  }

  cancel(pointerId: number): void {
    this.#pending.delete(pointerId);
  }
}

export interface ViewerPrimaryClick {
  readonly pagePoint: Position;
  readonly clientPoint: Position;
  readonly hadSelectionAtPress: boolean;
}

interface PendingPrimaryClick extends ViewerPrimaryClick {
  readonly pointerId: number;
  dragged: boolean;
}

/** Preserves the press location for click-like gestures while rejecting real drags. */
export class ViewerPrimaryClickGesture {
  #pending: PendingPrimaryClick | null = null;

  constructor(readonly movementThreshold = 5) {}

  pointerDown(
    pointerId: number,
    button: number | undefined,
    pagePoint: Position,
    clientPoint: Position,
    hadSelectionAtPress = false,
  ): void {
    this.#pending = button === 0
      ? { pointerId, pagePoint, clientPoint, hadSelectionAtPress, dragged: false }
      : null;
  }

  pointerMove(pointerId: number, clientX: number, clientY: number): void {
    const pending = this.#pending;
    if (!pending || pending.pointerId !== pointerId || pending.dragged) return;
    if (Math.hypot(
      clientX - pending.clientPoint.x,
      clientY - pending.clientPoint.y,
    ) > this.movementThreshold) pending.dragged = true;
  }

  pointerUp(
    pointerId: number,
    button: number | undefined,
    clientX: number,
    clientY: number,
  ): ViewerPrimaryClick | undefined {
    this.pointerMove(pointerId, clientX, clientY);
    const pending = this.#pending;
    this.#pending = null;
    if (button !== 0 || !pending || pending.pointerId !== pointerId || pending.dragged) {
      return undefined;
    }
    return {
      pagePoint: pending.pagePoint,
      clientPoint: pending.clientPoint,
      hadSelectionAtPress: pending.hadSelectionAtPress,
    };
  }

  cancel(): void {
    this.#pending = null;
  }
}

export interface PageEventGeometry {
  readonly pageSize: Size;
  readonly rotation: Rotation;
  readonly scale: number;
  readonly elementLeft: number;
  readonly elementTop: number;
}

/** Normalizes a DOM page event into natural, unscaled, crop-relative page space. */
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
    '[data-source-link-layer]',
    `[${PDF_LINK_INTERACTION_ATTRIBUTE}]`,
    '[data-review-contextual-ui]',
    '[data-review-editor]',
    'input',
    'textarea',
    '[contenteditable="true"]',
  ].join(',')) !== null;
}
