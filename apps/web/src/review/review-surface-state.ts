import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationAction,
  type ReferenceNavigationState,
  type WorkspaceMode,
} from './reference-navigation-state.js';

export type ReviewBaseSurface = 'reading' | 'workspace' | 'finish';
export type ReviewNestedLayer = 'none' | 'composer';
export type ReviewTransientSurface = 'none' | 'selection-actions' | 'insert-action' | 'page-menu' | 'page-note-cursor';

export interface ReviewSurfaceState {
  readonly baseSurface: ReviewBaseSurface;
  readonly nestedLayer: ReviewNestedLayer;
  readonly transientSurface: ReviewTransientSurface;
  readonly navigation: ReferenceNavigationState;
}

export type ReviewSurfaceAction =
  | { readonly type: 'open-base'; readonly surface: ReviewBaseSurface }
  | { readonly type: 'open-workspace'; readonly mode?: WorkspaceMode }
  | { readonly type: 'hide-workspace'; readonly focusReturnToken: string }
  | { readonly type: 'reference-navigation'; readonly action: ReferenceNavigationAction }
  | { readonly type: 'replace-document'; readonly documentGeneration: number }
  | { readonly type: 'open-nested' }
  | { readonly type: 'close-nested' }
  | { readonly type: 'open-transient'; readonly surface: Exclude<ReviewTransientSurface, 'none'> }
  | { readonly type: 'close-transient' }
  | { readonly type: 'escape' };

export function createReviewSurfaceState(documentGeneration: number): ReviewSurfaceState {
  return {
    baseSurface: 'reading',
    nestedLayer: 'none',
    transientSurface: 'none',
    navigation: createReferenceNavigationState(documentGeneration),
  };
}

export const INITIAL_REVIEW_SURFACE_STATE: ReviewSurfaceState = Object.freeze(
  createReviewSurfaceState(0),
);

export function reduceReviewSurface(
  state: ReviewSurfaceState,
  action: ReviewSurfaceAction,
): ReviewSurfaceState {
  switch (action.type) {
    case 'open-base':
      return state.baseSurface === action.surface
        ? state
        : { ...state, baseSurface: action.surface, transientSurface: 'none' };
    case 'open-workspace': {
      const navigation = action.mode === undefined
        ? state.navigation
        : reduceReferenceNavigation(state.navigation, {
            type: 'select-workspace-mode',
            mode: action.mode,
          });
      if (
        state.baseSurface === 'workspace'
        && state.transientSurface === 'none'
        && navigation === state.navigation
      ) return state;
      return {
        ...state,
        baseSurface: 'workspace',
        transientSurface: 'none',
        navigation,
      };
    }
    case 'hide-workspace': {
      const navigation = reduceReferenceNavigation(state.navigation, {
        type: 'hide-workspace',
        focusReturnToken: action.focusReturnToken,
      });
      if (state.baseSurface === 'reading' && navigation === state.navigation) return state;
      return { ...state, baseSurface: 'reading', transientSurface: 'none', navigation };
    }
    case 'reference-navigation': {
      const previousTabCount = state.navigation.tabs.length;
      const navigation = reduceReferenceNavigation(state.navigation, action.action);
      if (navigation === state.navigation) return state;

      let baseSurface = state.baseSurface;
      if (action.action.type === 'open-reference') baseSurface = 'workspace';
      if (
        action.action.type === 'complete-send-to-main'
        && action.action.success
      ) baseSurface = 'reading';
      if (action.action.type === 'replace-document') baseSurface = 'reading';
      if (
        action.action.type === 'close-reference'
        && previousTabCount > 0
        && navigation.tabs.length === 0
      ) baseSurface = 'reading';

      return { ...state, baseSurface, navigation };
    }
    case 'replace-document':
      return {
        ...state,
        baseSurface: 'reading',
        transientSurface: 'none',
        navigation: createReferenceNavigationState(action.documentGeneration),
      };
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
      if (state.baseSurface !== 'reading') return { ...state, baseSurface: 'reading' };
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
