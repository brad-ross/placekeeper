export type ReviewBaseSurface = 'reading' | 'annotations' | 'finish';
export type ReviewNestedLayer = 'none' | 'composer';

export interface ReviewSurfaceState {
  readonly baseSurface: ReviewBaseSurface;
  readonly nestedLayer: ReviewNestedLayer;
}

export type ReviewSurfaceAction =
  | { readonly type: 'open-base'; readonly surface: ReviewBaseSurface }
  | { readonly type: 'open-nested' }
  | { readonly type: 'close-nested' }
  | { readonly type: 'escape' };

export const INITIAL_REVIEW_SURFACE_STATE: ReviewSurfaceState = Object.freeze({
  baseSurface: 'reading',
  nestedLayer: 'none',
});

export function reduceReviewSurface(
  state: ReviewSurfaceState,
  action: ReviewSurfaceAction,
): ReviewSurfaceState {
  switch (action.type) {
    case 'open-base':
      return state.baseSurface === action.surface
        ? state
        : { ...state, baseSurface: action.surface };
    case 'open-nested':
      return state.nestedLayer === 'composer'
        ? state
        : { ...state, nestedLayer: 'composer' };
    case 'close-nested':
      return state.nestedLayer === 'none'
        ? state
        : { ...state, nestedLayer: 'none' };
    case 'escape':
      if (state.nestedLayer !== 'none') return { ...state, nestedLayer: 'none' };
      if (state.baseSurface !== 'reading') return INITIAL_REVIEW_SURFACE_STATE;
      return state;
  }
}
