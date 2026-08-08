export type ReviewBaseSurface = 'reading' | 'annotations' | 'finish';
export type ReviewNestedLayer = 'none' | 'composer';
export type ReviewTransientSurface = 'none' | 'selection-actions' | 'insert-action' | 'page-menu' | 'page-note-cursor';

export interface ReviewSurfaceState {
  readonly baseSurface: ReviewBaseSurface;
  readonly nestedLayer: ReviewNestedLayer;
  readonly transientSurface: ReviewTransientSurface;
}

export type ReviewSurfaceAction =
  | { readonly type: 'open-base'; readonly surface: ReviewBaseSurface }
  | { readonly type: 'open-nested' }
  | { readonly type: 'close-nested' }
  | { readonly type: 'open-transient'; readonly surface: Exclude<ReviewTransientSurface, 'none'> }
  | { readonly type: 'close-transient' }
  | { readonly type: 'escape' };

export const INITIAL_REVIEW_SURFACE_STATE: ReviewSurfaceState = Object.freeze({
  baseSurface: 'reading',
  nestedLayer: 'none',
  transientSurface: 'none',
});

export function reduceReviewSurface(
  state: ReviewSurfaceState,
  action: ReviewSurfaceAction,
): ReviewSurfaceState {
  switch (action.type) {
    case 'open-base':
      return state.baseSurface === action.surface
        ? state
        : { ...state, baseSurface: action.surface, transientSurface: 'none' };
    case 'open-nested':
      return state.nestedLayer === 'composer'
        ? state
        : { ...state, nestedLayer: 'composer', transientSurface: 'none' };
    case 'close-nested':
      return state.nestedLayer === 'none'
        ? state
        : { ...state, nestedLayer: 'none' };
    case 'open-transient':
      return state.transientSurface === action.surface
        ? state
        : { ...state, transientSurface: action.surface };
    case 'close-transient':
      return state.transientSurface === 'none'
        ? state
        : { ...state, transientSurface: 'none' };
    case 'escape':
      if (state.nestedLayer !== 'none') return { ...state, nestedLayer: 'none' };
      if (state.transientSurface !== 'none') return { ...state, transientSurface: 'none' };
      if (state.baseSurface !== 'reading') return INITIAL_REVIEW_SURFACE_STATE;
      return state;
  }
}

export interface PagePlacementPoint {
  readonly documentId: string;
  readonly pageIndex: number;
  readonly viewportGeneration: number;
  readonly x: number;
  readonly y: number;
}

interface PageContextAuthority {
  readonly invocationId: string;
  readonly point: PagePlacementPoint;
}

/** Semantic placement authority intentionally lives outside the surface reducer. */
export class PageNotePlacementAuthority {
  #context: PageContextAuthority | null = null;
  #cursor: PagePlacementPoint | null = null;

  setContextPoint(invocationId: string, point: PagePlacementPoint): void {
    this.#context = { invocationId, point };
  }

  dismissContext(invocationId?: string): void {
    if (invocationId === undefined || this.#context?.invocationId === invocationId) this.#context = null;
  }

  consumeContextPoint(invocationId: string): PagePlacementPoint | null {
    if (this.#context?.invocationId !== invocationId) return null;
    const point = this.#context.point;
    this.#context = null;
    return point;
  }

  setKeyboardCursor(point: PagePlacementPoint): void {
    this.#cursor = point;
  }

  clearKeyboardCursor(): void {
    this.#cursor = null;
  }

  consumeKeyboardCursor(binding: Pick<PagePlacementPoint, 'documentId' | 'pageIndex' | 'viewportGeneration'>): PagePlacementPoint | null {
    const cursor = this.#cursor;
    if (
      cursor === null ||
      cursor.documentId !== binding.documentId ||
      cursor.pageIndex !== binding.pageIndex ||
      cursor.viewportGeneration !== binding.viewportGeneration
    ) return null;
    this.#cursor = null;
    return cursor;
  }

  clear(): void {
    this.#context = null;
    this.#cursor = null;
  }
}
