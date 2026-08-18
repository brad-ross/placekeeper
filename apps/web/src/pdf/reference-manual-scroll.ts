import { REFERENCE_PDF_DOCUMENT_ID } from './viewer-document-ids.js';

export type ReferenceScrollIntentInput =
  | { readonly kind: 'wheel'; readonly ctrlKey?: boolean; readonly metaKey?: boolean }
  | {
      readonly kind: 'key';
      readonly key: string;
      readonly altKey: boolean;
      readonly ctrlKey: boolean;
      readonly metaKey: boolean;
    }
  | {
      readonly kind: 'pointer';
      readonly phase: 'down' | 'move';
      readonly pointerType: string;
      readonly button: number;
      readonly buttons: number;
      readonly clientX: number;
      readonly clientY: number;
    };

interface ReferenceScrollViewportMetrics {
  readonly clientLeft: number;
  readonly clientTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;
}

export interface ReferenceScrollSource {
  onScroll(listener: (event: { readonly documentId: string }) => void): () => void;
}

export interface ReferenceScrollPosition {
  readonly left: number;
  readonly top: number;
}

const REFERENCE_SCROLL_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
  'Spacebar',
]);

/** Classifies only inputs that can manually scroll the portaled Reference viewport. */
export function isReferenceScrollIntent(
  input: ReferenceScrollIntentInput,
  viewport?: ReferenceScrollViewportMetrics | null,
): boolean {
  if (input.kind === 'wheel') return input.ctrlKey !== true && input.metaKey !== true;
  if (input.kind === 'key') {
    return !input.altKey
      && !input.ctrlKey
      && !input.metaKey
      && REFERENCE_SCROLL_KEYS.has(input.key);
  }
  if (input.buttons === 0 || (input.phase === 'down' && input.button !== 0)) return false;
  if (input.pointerType !== 'mouse') return input.phase === 'move';
  if (viewport === null || viewport === undefined) return false;
  const bounds = viewport.getBoundingClientRect();
  const clientLeft = bounds.left + viewport.clientLeft;
  const clientTop = bounds.top + viewport.clientTop;
  const clientRight = clientLeft + viewport.clientWidth;
  const clientBottom = clientTop + viewport.clientHeight;
  const overScrollbar = input.clientX < clientLeft
    || input.clientX >= clientRight
    || input.clientY < clientTop
    || input.clientY >= clientBottom;
  return overScrollbar
    && input.clientX >= bounds.left
    && input.clientX <= bounds.right
    && input.clientY >= bounds.top
    && input.clientY <= bounds.bottom;
}

/** Pairs Reference-only user intent with the next Reference scroll notification. */
export class ReferenceManualScrollObserver {
  private baseline: ReferenceScrollPosition | null = null;
  private armGeneration = 0;
  private cancellationGeneration = 0;

  constructor(
    private readonly scheduleExpiry: (expire: () => void) => void = (expire) => {
      setTimeout(expire, 250);
    },
  ) {}

  arm(position: ReferenceScrollPosition): void {
    this.baseline = position;
    const generation = ++this.armGeneration;
    this.scheduleExpiry(() => {
      if (generation === this.armGeneration) this.baseline = null;
    });
  }

  observeScroll(documentId: string, position: ReferenceScrollPosition | null): boolean {
    return this.takeScrollObservation(documentId)?.(position) ?? false;
  }

  takeScrollObservation(
    documentId: string,
  ): ((position: ReferenceScrollPosition | null) => boolean) | null {
    if (documentId !== REFERENCE_PDF_DOCUMENT_ID || this.baseline === null) return null;
    const baseline = this.baseline;
    const cancellationGeneration = this.cancellationGeneration;
    this.baseline = null;
    return (position) => cancellationGeneration === this.cancellationGeneration
      && position !== null
      && (position.left !== baseline.left || position.top !== baseline.top);
  }

  clear(): void {
    this.baseline = null;
    this.armGeneration += 1;
    this.cancellationGeneration += 1;
  }
}

export function subscribeToReferenceManualScroll(
  source: ReferenceScrollSource,
  observer: ReferenceManualScrollObserver,
  readPosition: () => ReferenceScrollPosition | null,
  publish: () => void,
  scheduleObservation: (observe: () => void) => void = (observe) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => observe());
      return;
    }
    setTimeout(observe, 0);
  },
): () => void {
  return source.onScroll(({ documentId }) => {
    const observation = observer.takeScrollObservation(documentId);
    if (observation === null) return;
    scheduleObservation(() => {
      if (observation(readPosition())) publish();
    });
  });
}
