export type AnnotationPresentation = 'right' | 'bottom';

export interface ViewerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ViewerPosition {
  left: number;
  top: number;
}

export interface ViewerRunway {
  right: number;
  bottom: number;
}

export interface OccupiedViewerSurface {
  readonly presentation: AnnotationPresentation;
  readonly bounds: ViewerRect | null;
}

export function occupiedRunway(input: {
  readonly stage: ViewerRect;
  readonly surfaces: readonly OccupiedViewerSurface[];
}): ViewerRunway {
  const runway: ViewerRunway = { right: 0, bottom: 0 };
  for (const surface of input.surfaces) {
    if (!surface.bounds) continue;
    const intersection = intersectViewerRects(input.stage, surface.bounds);
    if (!intersection) continue;
    if (surface.presentation === 'right') {
      runway.right = Math.max(runway.right, intersection.right - intersection.left);
    } else {
      runway.bottom = Math.max(runway.bottom, intersection.bottom - intersection.top);
    }
  }
  return runway;
}

export class LatestFrameRequest<T> {
  private handle: number | null = null;
  private latest: T | undefined;

  constructor(private readonly options: {
    readonly schedule: (callback: () => void) => number;
    readonly cancel: (handle: number) => void;
    readonly commit: (value: T) => void;
  }) {}

  publish(value: T): void {
    this.latest = value;
    if (this.handle !== null) return;
    this.handle = this.options.schedule(() => {
      this.handle = null;
      const latest = this.latest;
      this.latest = undefined;
      if (latest !== undefined) this.options.commit(latest);
    });
  }

  cancel(): void {
    if (this.handle !== null) this.options.cancel(this.handle);
    this.handle = null;
    this.latest = undefined;
  }
}

export interface ViewerFramingTarget {
  pageIndex?: number;
  reviewId?: string;
}

export interface ViewerFramingSnapshot {
  readonly ready: boolean;
  readonly documentId?: string;
  readonly viewport?: ViewerRect;
  readonly page?: ViewerRect;
  readonly target?: ViewerRect;
  readonly scroll: ViewerPosition;
  readonly maximum: ViewerPosition;
}

export type ViewerFramingEvent = { readonly type: 'zoom' };

export interface ViewerFramingControls {
  snapshot(target?: ViewerFramingTarget): ViewerFramingSnapshot;
  setRunway(runway: ViewerRunway): Promise<ViewerFramingSnapshot>;
  scrollTo(position: ViewerPosition, behavior?: ScrollBehavior): void;
  subscribe(listener: (event: ViewerFramingEvent) => void): () => void;
  dispose(): void;
}

export interface FramingSessionToken {
  documentGeneration: number;
  sessionGeneration: number;
}

export interface FramingSessionSnapshot extends FramingSessionToken {
  documentId: string;
  presentation: AnnotationPresentation;
  userRevision: number;
}

const DEFAULT_MIN_READING_WIDTH = 30 * 16;
const DEFAULT_PRESENTATION_HYSTERESIS = 24;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function unionViewerRects(rects: readonly ViewerRect[]): ViewerRect | null {
  const valid = rects.filter((rect) => (
    Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom)
    && rect.right >= rect.left
    && rect.bottom >= rect.top
  ));
  if (valid.length === 0) return null;

  return valid.reduce<ViewerRect>((union, rect) => ({
    left: Math.min(union.left, rect.left),
    top: Math.min(union.top, rect.top),
    right: Math.max(union.right, rect.right),
    bottom: Math.max(union.bottom, rect.bottom),
  }), { ...valid[0]! });
}

export function intersectViewerRects(first: ViewerRect, second: ViewerRect): ViewerRect | null {
  const intersection = {
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  };
  return intersection.right >= intersection.left && intersection.bottom >= intersection.top
    ? intersection
    : null;
}

/**
 * Returns the smallest signed scroll correction that reveals an interval.
 * When the interval is larger than the viewport, it aligns the nearer edge so
 * users can still reach the complete target by scrolling.
 */
export function revealDelta(
  target: { start: number; end: number },
  visible: { start: number; end: number },
  gutter = 0,
): number {
  const paddedStart = target.start - gutter;
  const paddedEnd = target.end + gutter;
  const startCorrection = paddedStart - visible.start;
  const endCorrection = paddedEnd - visible.end;

  if (startCorrection >= 0 && endCorrection <= 0) return 0;
  if (startCorrection < 0 && endCorrection > 0) {
    return Math.abs(startCorrection) <= Math.abs(endCorrection)
      ? startCorrection
      : endCorrection;
  }
  return startCorrection < 0 ? startCorrection : endCorrection;
}

export function chooseAnnotationPresentation(input: {
  stageWidth: number;
  sideWidth: number;
  previous: AnnotationPresentation;
  minReadingWidth?: number;
  hysteresis?: number;
}): AnnotationPresentation {
  const minReadingWidth = input.minReadingWidth ?? DEFAULT_MIN_READING_WIDTH;
  const hysteresis = input.hysteresis ?? DEFAULT_PRESENTATION_HYSTERESIS;
  const remainingReadingWidth = input.stageWidth - input.sideWidth;
  const returnThreshold = minReadingWidth + hysteresis;

  if (input.previous === 'bottom') {
    return remainingReadingWidth >= returnThreshold ? 'right' : 'bottom';
  }
  return remainingReadingWidth >= minReadingWidth ? 'right' : 'bottom';
}

export function restoreViewportPosition(input: {
  baseline: ViewerPosition;
  current: ViewerPosition;
  automatic: ViewerPosition;
  userRevision: number;
  userAxes?: { readonly left: boolean; readonly top: boolean };
  maximum: ViewerPosition;
}): ViewerPosition {
  const leftOwnedByUser = input.userAxes?.left ?? input.userRevision > 0;
  const topOwnedByUser = input.userAxes?.top ?? input.userRevision > 0;
  const candidate = {
    left: leftOwnedByUser || input.automatic.left === 0
      ? input.current.left
      : input.baseline.left,
    top: topOwnedByUser || input.automatic.top === 0
      ? input.current.top
      : input.baseline.top,
  };

  return {
    left: clamp(candidate.left, 0, Math.max(0, input.maximum.left)),
    top: clamp(candidate.top, 0, Math.max(0, input.maximum.top)),
  };
}

/**
 * Owns the identity of one asynchronous framing operation. DOM measurements
 * and animation frames must check their token before mutating the viewer.
 */
export class FramingSessionAuthority {
  private documentId: string | null = null;
  private documentGeneration = 0;
  private sessionGeneration = 0;
  private current: FramingSessionSnapshot | null = null;

  open(documentId: string, presentation: AnnotationPresentation): FramingSessionToken {
    const sameDocument = documentId === this.documentId;
    const userRevision = sameDocument ? this.current?.userRevision ?? 0 : 0;
    if (!sameDocument) {
      this.documentId = documentId;
      this.documentGeneration += 1;
    }
    this.sessionGeneration += 1;
    this.current = {
      documentId,
      presentation,
      documentGeneration: this.documentGeneration,
      sessionGeneration: this.sessionGeneration,
      userRevision,
    };
    return this.token(this.current);
  }

  isCurrent(token: FramingSessionToken): boolean {
    return this.current !== null
      && token.documentGeneration === this.current.documentGeneration
      && token.sessionGeneration === this.current.sessionGeneration;
  }

  markUserNavigation(): void {
    if (!this.current) return;
    this.current.userRevision += 1;
    this.supersede();
  }

  supersede(token?: FramingSessionToken): void {
    if (!this.current || (token && !this.isCurrent(token))) return;
    this.sessionGeneration += 1;
    this.current.sessionGeneration = this.sessionGeneration;
  }

  snapshot(): FramingSessionSnapshot | null {
    return this.current ? { ...this.current } : null;
  }

  invalidateDocument(documentId: string): void {
    if (documentId === this.documentId) return;
    this.documentId = documentId;
    this.documentGeneration += 1;
    this.current = null;
  }

  close(token?: FramingSessionToken): FramingSessionSnapshot | null {
    if (token && !this.isCurrent(token)) return null;
    const closed = this.snapshot();
    this.current = null;
    return closed;
  }

  private token(session: FramingSessionSnapshot): FramingSessionToken {
    return {
      documentGeneration: session.documentGeneration,
      sessionGeneration: session.sessionGeneration,
    };
  }
}
