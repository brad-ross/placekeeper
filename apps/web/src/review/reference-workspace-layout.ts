import { chooseAnnotationPresentation } from '../pdf/viewer-framing.js';
import type { WorkspaceMode } from './reference-navigation-state.js';

export type ReferenceDock = 'right' | 'bottom';
export type WorkspaceLayoutRegime = 'wide' | 'narrow';
export type WorkspaceSurface = 'right' | 'references';
export type RightWorkspaceMode = Exclude<WorkspaceMode, 'references'>;

export const RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN = 'rail:right-workspace';
export const BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN = 'rail:bottom-references';

export const DEFAULT_RIGHT_WORKSPACE_WIDTH = 24 * 16;
export const DEFAULT_BOTTOM_REFERENCE_HEIGHT_RATIO = 0.43;
export const MIN_RIGHT_REFERENCE_WIDTH = 18 * 16;
export const MIN_BOTTOM_REFERENCE_HEIGHT = 12 * 16;
export const MIN_MAIN_READING_WIDTH = 30 * 16;
export const MIN_MAIN_READING_HEIGHT = 12 * 16;

export interface ReferenceWorkspaceLayoutState {
  readonly regime: WorkspaceLayoutRegime;
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly referenceDock: ReferenceDock;
  readonly rightWorkspaceOpen: boolean;
  readonly bottomReferencesOpen: boolean;
  readonly narrowOpen: boolean;
  readonly narrowSurface: WorkspaceSurface;
  readonly lastFocusedSurface: WorkspaceSurface | null;
  readonly rightReferenceWidth: number;
  readonly bottomReferenceHeight: number;
}

export type ReferenceWorkspaceLayoutAction =
  | { readonly type: 'set-stage-size'; readonly width: number; readonly height: number }
  | { readonly type: 'set-regime'; readonly regime: WorkspaceLayoutRegime }
  | { readonly type: 'show-right-workspace' }
  | { readonly type: 'hide-right-workspace' }
  | { readonly type: 'toggle-right-workspace' }
  | { readonly type: 'show-references' }
  | { readonly type: 'hide-references' }
  | { readonly type: 'hide-references-after-send'; readonly activeMode: WorkspaceMode }
  | { readonly type: 'toggle-references' }
  | { readonly type: 'toggle-narrow-workspace' }
  | { readonly type: 'move-references-right' }
  | { readonly type: 'move-references-bottom' }
  | { readonly type: 'focus-surface'; readonly surface: WorkspaceSurface }
  | { readonly type: 'resize-right-references'; readonly size: number }
  | { readonly type: 'resize-bottom-references'; readonly size: number }
  | { readonly type: 'replace-document' };

export type EffectiveReferenceWorkspaceLayout =
  | {
    readonly kind: 'narrow-unified';
    readonly open: boolean;
    readonly activeMode: WorkspaceMode;
    readonly bottomHeight: number;
    readonly referenceResizable: boolean;
  }
  | {
    readonly kind: 'wide-closed' | 'wide-right' | 'wide-bottom' | 'wide-split';
    readonly referenceDock: ReferenceDock;
    readonly rightWorkspaceOpen: boolean;
    readonly bottomReferencesOpen: boolean;
    readonly rightWidth: number;
    readonly bottomHeight: number;
    readonly referenceResizable: boolean;
  };

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function clampRightReferenceWidth(size: number, stageWidth: number): number {
  const maximum = Math.max(0, finiteNonNegative(stageWidth) - MIN_MAIN_READING_WIDTH);
  return Math.min(Math.max(finiteNonNegative(size), MIN_RIGHT_REFERENCE_WIDTH), maximum);
}

export function clampBottomReferenceHeight(size: number, stageHeight: number): number {
  const maximum = Math.max(0, finiteNonNegative(stageHeight) - MIN_MAIN_READING_HEIGHT);
  return Math.min(Math.max(finiteNonNegative(size), MIN_BOTTOM_REFERENCE_HEIGHT), maximum);
}

function regimeForWidth(width: number): WorkspaceLayoutRegime {
  return chooseAnnotationPresentation({
    stageWidth: finiteNonNegative(width),
    sideWidth: DEFAULT_RIGHT_WORKSPACE_WIDTH,
    previous: 'right',
  }) === 'right' ? 'wide' : 'narrow';
}

export function createReferenceWorkspaceLayout(stage: {
  readonly width: number;
  readonly height: number;
}): ReferenceWorkspaceLayoutState {
  const width = finiteNonNegative(stage.width);
  const height = finiteNonNegative(stage.height);
  const regime = regimeForWidth(width);
  return {
    regime,
    stageWidth: width,
    stageHeight: height,
    referenceDock: 'bottom',
    rightWorkspaceOpen: false,
    bottomReferencesOpen: false,
    narrowOpen: false,
    narrowSurface: 'right',
    lastFocusedSurface: null,
    rightReferenceWidth: clampRightReferenceWidth(DEFAULT_RIGHT_WORKSPACE_WIDTH, width),
    bottomReferenceHeight: clampBottomReferenceHeight(
      height * DEFAULT_BOTTOM_REFERENCE_HEIGHT_RATIO,
      height,
    ),
  };
}

function narrowSurfaceForWideState(state: ReferenceWorkspaceLayoutState): WorkspaceSurface {
  if (state.rightWorkspaceOpen && state.bottomReferencesOpen) {
    return state.lastFocusedSurface ?? 'right';
  }
  if (state.bottomReferencesOpen) return 'references';
  if (
    state.referenceDock === 'right'
    && state.rightWorkspaceOpen
    && state.lastFocusedSurface === 'references'
  ) return 'references';
  return 'right';
}

export function reduceReferenceWorkspaceLayout(
  state: ReferenceWorkspaceLayoutState,
  action: ReferenceWorkspaceLayoutAction,
): ReferenceWorkspaceLayoutState {
  switch (action.type) {
    case 'set-stage-size': {
      const stageWidth = finiteNonNegative(action.width);
      const stageHeight = finiteNonNegative(action.height);
      if (stageWidth === state.stageWidth && stageHeight === state.stageHeight) return state;
      return {
        ...state,
        stageWidth,
        stageHeight,
      };
    }
    case 'set-regime':
      if (action.regime === state.regime) return state;
      if (action.regime === 'narrow') {
        return {
          ...state,
          regime: 'narrow',
          narrowOpen: state.rightWorkspaceOpen || state.bottomReferencesOpen,
          narrowSurface: narrowSurfaceForWideState(state),
        };
      }
      return { ...state, regime: 'wide' };
    case 'show-right-workspace':
      return {
        ...state,
        rightWorkspaceOpen: true,
        narrowOpen: state.regime === 'narrow' ? true : state.narrowOpen,
        narrowSurface: state.regime === 'narrow' ? 'right' : state.narrowSurface,
      };
    case 'hide-right-workspace':
      if (state.regime === 'narrow') return { ...state, narrowOpen: false };
      return { ...state, rightWorkspaceOpen: false };
    case 'toggle-right-workspace':
      if (state.regime === 'narrow') {
        return { ...state, narrowOpen: !state.narrowOpen, narrowSurface: 'right' };
      }
      return { ...state, rightWorkspaceOpen: !state.rightWorkspaceOpen };
    case 'show-references':
      return state.referenceDock === 'right'
        ? {
            ...state, rightWorkspaceOpen: true, lastFocusedSurface: 'references',
            narrowOpen: state.regime === 'narrow' ? true : state.narrowOpen,
            narrowSurface: state.regime === 'narrow' ? 'references' : state.narrowSurface,
          }
        : {
            ...state, bottomReferencesOpen: true, lastFocusedSurface: 'references',
            narrowOpen: state.regime === 'narrow' ? true : state.narrowOpen,
            narrowSurface: state.regime === 'narrow' ? 'references' : state.narrowSurface,
          };
    case 'hide-references':
      if (state.regime === 'narrow') {
        const showRememberedRight = state.referenceDock === 'bottom' && state.rightWorkspaceOpen;
        const nextState = {
          ...state,
          rightWorkspaceOpen: state.referenceDock === 'right'
            ? false
            : state.rightWorkspaceOpen,
          bottomReferencesOpen: state.referenceDock === 'bottom'
            ? false
            : state.bottomReferencesOpen,
          narrowOpen: showRememberedRight,
          narrowSurface: showRememberedRight ? 'right' : state.narrowSurface,
        };
        if (
          nextState.rightWorkspaceOpen === state.rightWorkspaceOpen
          && nextState.bottomReferencesOpen === state.bottomReferencesOpen
          && nextState.narrowOpen === state.narrowOpen
          && nextState.narrowSurface === state.narrowSurface
        ) return state;
        return nextState;
      }
      if (state.referenceDock === 'right') {
        if (!state.rightWorkspaceOpen) return state;
        return { ...state, rightWorkspaceOpen: false };
      }
      if (!state.bottomReferencesOpen) return state;
      return {
        ...state,
        bottomReferencesOpen: false,
      };
    case 'hide-references-after-send':
      if (
        (state.regime === 'narrow' || state.referenceDock === 'right')
        && action.activeMode !== 'references'
      ) return state;
      return reduceReferenceWorkspaceLayout(state, { type: 'hide-references' });
    case 'toggle-references':
      if (state.regime === 'narrow') {
        return state.narrowOpen && state.narrowSurface === 'references'
          ? reduceReferenceWorkspaceLayout(state, { type: 'hide-references' })
          : reduceReferenceWorkspaceLayout(state, { type: 'show-references' });
      }
      return state.referenceDock === 'right'
        ? { ...state, rightWorkspaceOpen: !state.rightWorkspaceOpen }
        : { ...state, bottomReferencesOpen: !state.bottomReferencesOpen };
    case 'toggle-narrow-workspace':
      return {
        ...state,
        narrowOpen: !state.narrowOpen,
        narrowSurface: state.narrowOpen
          ? state.narrowSurface
          : state.lastFocusedSurface ?? 'right',
      };
    case 'move-references-right':
      return {
        ...state,
        referenceDock: 'right',
        rightWorkspaceOpen: true,
        bottomReferencesOpen: false,
        narrowOpen: state.regime === 'narrow' ? true : state.narrowOpen,
        narrowSurface: 'references',
        lastFocusedSurface: 'references',
      };
    case 'move-references-bottom':
      return {
        ...state,
        referenceDock: 'bottom',
        rightWorkspaceOpen: false,
        bottomReferencesOpen: true,
        narrowOpen: state.regime === 'narrow' ? true : state.narrowOpen,
        narrowSurface: 'references',
        lastFocusedSurface: 'references',
      };
    case 'focus-surface': {
      const narrowSurface = state.regime === 'narrow' ? action.surface : state.narrowSurface;
      if (state.lastFocusedSurface === action.surface && state.narrowSurface === narrowSurface) {
        return state;
      }
      return {
        ...state,
        lastFocusedSurface: action.surface,
        narrowSurface,
      };
    }
    case 'resize-right-references': {
      const rightReferenceWidth = clampRightReferenceWidth(action.size, state.stageWidth);
      if (rightReferenceWidth === state.rightReferenceWidth) return state;
      return {
        ...state,
        rightReferenceWidth,
      };
    }
    case 'resize-bottom-references': {
      const bottomReferenceHeight = clampBottomReferenceHeight(action.size, state.stageHeight);
      if (bottomReferenceHeight === state.bottomReferenceHeight) return state;
      return {
        ...state,
        bottomReferenceHeight,
      };
    }
    case 'replace-document':
      return {
        ...state,
        rightWorkspaceOpen: false,
        bottomReferencesOpen: false,
        narrowOpen: false,
      };
  }
}

export function deriveReferenceWorkspaceLayout(
  state: ReferenceWorkspaceLayoutState,
  rightMode: RightWorkspaceMode,
  wideMode: WorkspaceMode = rightMode,
): EffectiveReferenceWorkspaceLayout {
  if (state.regime === 'narrow') {
    const activeMode: WorkspaceMode = state.narrowSurface === 'references'
      ? 'references'
      : state.lastFocusedSurface === null ? 'outline' : rightMode;
    const referenceActive = activeMode === 'references';
    return {
      kind: 'narrow-unified',
      open: state.narrowOpen,
      activeMode,
      bottomHeight: referenceActive
        ? clampBottomReferenceHeight(state.bottomReferenceHeight, state.stageHeight)
        : clampBottomReferenceHeight(
          state.stageHeight * DEFAULT_BOTTOM_REFERENCE_HEIGHT_RATIO,
          state.stageHeight,
        ),
      referenceResizable: referenceActive,
    };
  }

  const bottomOpen = state.referenceDock === 'bottom' && state.bottomReferencesOpen;
  const rightOpen = state.rightWorkspaceOpen;
  const referenceRightActive = state.referenceDock === 'right'
    && rightOpen
    && wideMode === 'references';
  const kind = rightOpen && bottomOpen
    ? 'wide-split'
    : rightOpen
      ? 'wide-right'
      : bottomOpen
        ? 'wide-bottom'
        : 'wide-closed';
  return {
    kind,
    referenceDock: state.referenceDock,
    rightWorkspaceOpen: rightOpen,
    bottomReferencesOpen: bottomOpen,
    rightWidth: referenceRightActive
      ? clampRightReferenceWidth(state.rightReferenceWidth, state.stageWidth)
      : Math.min(DEFAULT_RIGHT_WORKSPACE_WIDTH, state.stageWidth),
    bottomHeight: bottomOpen
      ? clampBottomReferenceHeight(state.bottomReferenceHeight, state.stageHeight)
      : 0,
    referenceResizable: referenceRightActive || bottomOpen,
  };
}
