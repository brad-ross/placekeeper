import type { PdfNavigationTarget } from '../pdf/pdf-navigation-target.js';
import {
  samePdfViewerLocation,
  type PdfViewerLocation,
} from '../pdf/viewer-navigation.js';

export type WorkspaceMode = 'outline' | 'search' | 'references' | 'annotations';

export interface WorkspaceModeMemory {
  readonly logicalScrollToken: string | null;
  readonly logicalFocusToken: string | null;
}

export interface WorkspaceMemory {
  readonly lastMode: WorkspaceMode;
  readonly returnFocusToken: string | null;
  readonly modes: Readonly<Record<WorkspaceMode, WorkspaceModeMemory>>;
}

export interface ReferenceTab {
  readonly identity: string;
  /** The canonical target that first created this durable tab. */
  readonly originalTarget: PdfNavigationTarget;
  /** The most recently settled, fully restorable view for this tab. */
  readonly settledLocation: PdfViewerLocation;
  readonly label?: string;
  readonly pageContext?: string;
}

export interface MainViewerHistory {
  readonly entries: readonly PdfViewerLocation[];
  readonly index: number;
}

interface PendingReferenceSwitch {
  readonly token: number;
  readonly targetIdentity: string;
}

interface PendingSendToMain {
  readonly token: number;
  readonly sourceTabIdentity: string;
  readonly currentMainLocation: PdfViewerLocation;
}

interface PendingMainJump {
  readonly kind: 'jump';
  readonly token: number;
  readonly currentLocation: PdfViewerLocation;
  readonly destination: PdfViewerLocation;
}

interface PendingHistoryTraversal {
  readonly kind: 'back' | 'forward';
  readonly token: number;
  readonly currentLocation: PdfViewerLocation;
  readonly destinationIndex: number;
}

type PendingMainNavigation = PendingMainJump | PendingHistoryTraversal;

export interface ReferenceNavigationState {
  readonly documentGeneration: number;
  readonly tabs: readonly ReferenceTab[];
  /** Selection is retained while the workspace is hidden. */
  readonly activeTabIdentity: string | null;
  readonly pendingReferenceSwitch: PendingReferenceSwitch | null;
  readonly pendingSendToMain: PendingSendToMain | null;
  readonly pendingMainNavigation: PendingMainNavigation | null;
  readonly workspace: WorkspaceMemory;
  readonly mainHistory: MainViewerHistory;
}

type CompletionFailure = {
  readonly success: false;
};

type SwitchCompletionSuccess = {
  readonly success: true;
  readonly settledLocation: PdfViewerLocation;
};

type SendCompletionSuccess = {
  readonly success: true;
  readonly settledLocation: PdfViewerLocation;
};

export type ReferenceNavigationAction =
  | { readonly type: 'cancel-pending-navigation' }
  | {
      readonly type: 'open-reference';
      readonly target: PdfNavigationTarget;
      readonly settledLocation: PdfViewerLocation;
      readonly label?: string;
      readonly pageContext?: string;
    }
  | { readonly type: 'refresh-active-reference'; readonly settledLocation: PdfViewerLocation }
  | {
      readonly type: 'request-reference-switch';
      readonly token: number;
      readonly targetIdentity: string;
      readonly outgoingLocation: PdfViewerLocation;
    }
  | ({
      readonly type: 'complete-reference-switch';
      readonly token: number;
      readonly documentGeneration: number;
    } & (CompletionFailure | SwitchCompletionSuccess))
  | {
      readonly type: 'close-reference';
      readonly targetIdentity: string;
      readonly focusReturnToken: string;
    }
  | { readonly type: 'select-workspace-mode'; readonly mode: WorkspaceMode }
  | {
      readonly type: 'remember-workspace-view';
      readonly mode: WorkspaceMode;
      readonly logicalScrollToken: string | null;
      readonly logicalFocusToken: string | null;
    }
  | { readonly type: 'hide-workspace'; readonly focusReturnToken: string }
  | { readonly type: 'refresh-main-location'; readonly location: PdfViewerLocation }
  | {
      readonly type: 'request-main-jump';
      readonly token: number;
      readonly currentLocation: PdfViewerLocation;
      readonly destination: PdfViewerLocation;
      readonly force?: boolean;
    }
  | ({
      readonly type: 'complete-main-jump';
      readonly token: number;
      readonly documentGeneration: number;
    } & (CompletionFailure | {
      readonly success: true;
      /** The verified settled location wins over the preflight resolution. */
      readonly settledLocation?: PdfViewerLocation;
    }))
  | {
      readonly type: 'request-history-back' | 'request-history-forward';
      readonly token: number;
      readonly currentLocation: PdfViewerLocation;
    }
  | ({
      readonly type: 'complete-history-navigation';
      readonly token: number;
      readonly documentGeneration: number;
    } & (CompletionFailure | { readonly success: true }))
  | {
      readonly type: 'request-send-to-main';
      readonly token: number;
      readonly currentMainLocation: PdfViewerLocation;
    }
  | ({
      readonly type: 'complete-send-to-main';
      readonly token: number;
      readonly documentGeneration: number;
    } & (CompletionFailure | SendCompletionSuccess))
  | { readonly type: 'replace-document'; readonly documentGeneration: number };

const EMPTY_MODE_MEMORY: WorkspaceModeMemory = Object.freeze({
  logicalScrollToken: null,
  logicalFocusToken: null,
});

function createWorkspaceMemory(): WorkspaceMemory {
  return {
    lastMode: 'outline',
    returnFocusToken: null,
    modes: {
      outline: EMPTY_MODE_MEMORY,
      search: EMPTY_MODE_MEMORY,
      references: EMPTY_MODE_MEMORY,
      annotations: EMPTY_MODE_MEMORY,
    },
  };
}

export function createReferenceNavigationState(
  documentGeneration: number,
): ReferenceNavigationState {
  return {
    documentGeneration,
    tabs: [],
    activeTabIdentity: null,
    pendingReferenceSwitch: null,
    pendingSendToMain: null,
    pendingMainNavigation: null,
    workspace: createWorkspaceMemory(),
    mainHistory: { entries: [], index: -1 },
  };
}

function exactlySameLocation(
  first: PdfViewerLocation,
  second: PdfViewerLocation,
): boolean {
  return samePdfViewerLocation(first, second, {
    anchor: 0,
    alignment: 0,
    zoom: 0,
  });
}

function replaceTabLocation(
  tabs: readonly ReferenceTab[],
  identity: string,
  settledLocation: PdfViewerLocation,
): readonly ReferenceTab[] {
  const index = tabs.findIndex((tab) => tab.identity === identity);
  if (index < 0) return tabs;
  const current = tabs[index]!;
  if (exactlySameLocation(current.settledLocation, settledLocation)) return tabs;
  const next = [...tabs];
  next[index] = { ...current, settledLocation };
  return next;
}

function updateCurrentHistoryEntry(
  history: MainViewerHistory,
  location: PdfViewerLocation,
): MainViewerHistory {
  if (history.index < 0) return { entries: [location], index: 0 };
  const current = history.entries[history.index];
  if (current !== undefined && exactlySameLocation(current, location)) return history;
  const entries = [...history.entries];
  entries[history.index] = location;
  return { entries, index: history.index };
}

function appendHistoryDestination(
  history: MainViewerHistory,
  currentLocation: PdfViewerLocation,
  destination: PdfViewerLocation,
): MainViewerHistory {
  if (history.index < 0) return { entries: [currentLocation, destination], index: 1 };
  const entries = history.entries.slice(0, history.index + 1);
  entries[history.index] = currentLocation;
  entries.push(destination);
  return { entries, index: entries.length - 1 };
}

export function referenceTabSuccessorIdentity(
  tabs: readonly { readonly identity: string }[],
  removedIndex: number,
): string | null {
  return tabs[removedIndex + 1]?.identity ?? tabs[removedIndex - 1]?.identity ?? null;
}

function withoutTab(
  state: ReferenceNavigationState,
  targetIdentity: string,
): Pick<ReferenceNavigationState, 'tabs' | 'activeTabIdentity'> | null {
  const removedIndex = state.tabs.findIndex((tab) => tab.identity === targetIdentity);
  if (removedIndex < 0) return null;
  const tabs = state.tabs.filter((tab) => tab.identity !== targetIdentity);
  return {
    tabs,
    activeTabIdentity: state.activeTabIdentity === targetIdentity
      ? referenceTabSuccessorIdentity(state.tabs, removedIndex)
      : state.activeTabIdentity,
  };
}

function completionIsCurrent(
  state: ReferenceNavigationState,
  completion: { readonly documentGeneration: number },
): boolean {
  return completion.documentGeneration === state.documentGeneration;
}

export function reduceReferenceNavigation(
  state: ReferenceNavigationState,
  action: ReferenceNavigationAction,
): ReferenceNavigationState {
  switch (action.type) {
    case 'cancel-pending-navigation':
      if (
        state.pendingReferenceSwitch === null
        && state.pendingSendToMain === null
        && state.pendingMainNavigation === null
      ) return state;
      return {
        ...state,
        pendingReferenceSwitch: null,
        pendingSendToMain: null,
        pendingMainNavigation: null,
      };
    case 'open-reference': {
      if (action.target.documentGeneration !== state.documentGeneration) return state;
      const existing = state.tabs.find((tab) => tab.identity === action.target.identity);
      if (existing) {
        if (
          state.activeTabIdentity === existing.identity
          && state.workspace.lastMode === 'references'
          && state.pendingReferenceSwitch === null
        ) return state;
        return {
          ...state,
          activeTabIdentity: existing.identity,
          pendingReferenceSwitch: null,
          workspace: { ...state.workspace, lastMode: 'references' },
        };
      }
      const tab: ReferenceTab = {
        identity: action.target.identity,
        originalTarget: action.target,
        settledLocation: action.settledLocation,
        ...(action.label === undefined ? {} : { label: action.label }),
        ...(action.pageContext === undefined ? {} : { pageContext: action.pageContext }),
      };
      return {
        ...state,
        tabs: [...state.tabs, tab],
        activeTabIdentity: tab.identity,
        pendingReferenceSwitch: null,
        workspace: { ...state.workspace, lastMode: 'references' },
      };
    }
    case 'refresh-active-reference': {
      if (state.activeTabIdentity === null) return state;
      const tabs = replaceTabLocation(
        state.tabs,
        state.activeTabIdentity,
        action.settledLocation,
      );
      return tabs === state.tabs ? state : { ...state, tabs };
    }
    case 'request-reference-switch': {
      if (!state.tabs.some((tab) => tab.identity === action.targetIdentity)) return state;
      if (state.activeTabIdentity === action.targetIdentity) {
        const tabs = replaceTabLocation(state.tabs, action.targetIdentity, action.outgoingLocation);
        return tabs === state.tabs ? state : { ...state, tabs, pendingReferenceSwitch: null };
      }
      const tabs = state.activeTabIdentity === null
        ? state.tabs
        : replaceTabLocation(state.tabs, state.activeTabIdentity, action.outgoingLocation);
      return {
        ...state,
        tabs,
        pendingReferenceSwitch: { token: action.token, targetIdentity: action.targetIdentity },
      };
    }
    case 'complete-reference-switch': {
      const pending = state.pendingReferenceSwitch;
      if (
        pending === null
        || pending.token !== action.token
        || !completionIsCurrent(state, action)
      ) return state;
      if (!action.success) return { ...state, pendingReferenceSwitch: null };
      if (!state.tabs.some((tab) => tab.identity === pending.targetIdentity)) {
        return { ...state, pendingReferenceSwitch: null };
      }
      return {
        ...state,
        tabs: replaceTabLocation(state.tabs, pending.targetIdentity, action.settledLocation),
        activeTabIdentity: pending.targetIdentity,
        pendingReferenceSwitch: null,
      };
    }
    case 'close-reference': {
      const remaining = withoutTab(state, action.targetIdentity);
      if (remaining === null) return state;
      const finalClose = remaining.tabs.length === 0;
      return {
        ...state,
        ...remaining,
        pendingReferenceSwitch: finalClose
          || state.pendingReferenceSwitch?.targetIdentity === action.targetIdentity
          ? null
          : state.pendingReferenceSwitch,
        pendingSendToMain: finalClose
          || state.pendingSendToMain?.sourceTabIdentity === action.targetIdentity
          ? null
          : state.pendingSendToMain,
        workspace: finalClose
          ? { ...state.workspace, returnFocusToken: action.focusReturnToken }
          : state.workspace,
      };
    }
    case 'select-workspace-mode':
      return state.workspace.lastMode === action.mode
        ? state
        : { ...state, workspace: { ...state.workspace, lastMode: action.mode } };
    case 'remember-workspace-view': {
      const current = state.workspace.modes[action.mode];
      if (
        current.logicalScrollToken === action.logicalScrollToken
        && current.logicalFocusToken === action.logicalFocusToken
      ) return state;
      return {
        ...state,
        workspace: {
          ...state.workspace,
          modes: {
            ...state.workspace.modes,
            [action.mode]: {
              logicalScrollToken: action.logicalScrollToken,
              logicalFocusToken: action.logicalFocusToken,
            },
          },
        },
      };
    }
    case 'hide-workspace':
      return state.workspace.returnFocusToken === action.focusReturnToken
        ? state
        : {
            ...state,
            workspace: { ...state.workspace, returnFocusToken: action.focusReturnToken },
          };
    case 'refresh-main-location': {
      const mainHistory = updateCurrentHistoryEntry(state.mainHistory, action.location);
      return mainHistory === state.mainHistory ? state : { ...state, mainHistory };
    }
    case 'request-main-jump':
      if (!action.force && samePdfViewerLocation(action.currentLocation, action.destination)) return state;
      return {
        ...state,
        pendingMainNavigation: {
          kind: 'jump',
          token: action.token,
          currentLocation: action.currentLocation,
          destination: action.destination,
        },
      };
    case 'complete-main-jump': {
      const pending = state.pendingMainNavigation;
      if (
        pending?.kind !== 'jump'
        || pending.token !== action.token
        || !completionIsCurrent(state, action)
      ) return state;
      if (!action.success) return { ...state, pendingMainNavigation: null };
      return {
        ...state,
        pendingMainNavigation: null,
        mainHistory: appendHistoryDestination(
          state.mainHistory,
          pending.currentLocation,
          action.settledLocation ?? pending.destination,
        ),
      };
    }
    case 'request-history-back':
    case 'request-history-forward': {
      const offset = action.type === 'request-history-back' ? -1 : 1;
      const destinationIndex = state.mainHistory.index + offset;
      if (destinationIndex < 0 || destinationIndex >= state.mainHistory.entries.length) return state;
      return {
        ...state,
        pendingMainNavigation: {
          kind: action.type === 'request-history-back' ? 'back' : 'forward',
          token: action.token,
          currentLocation: action.currentLocation,
          destinationIndex,
        },
      };
    }
    case 'complete-history-navigation': {
      const pending = state.pendingMainNavigation;
      if (
        pending === null
        || pending.kind === 'jump'
        || pending.token !== action.token
        || !completionIsCurrent(state, action)
      ) return state;
      if (!action.success) return { ...state, pendingMainNavigation: null };
      const refreshed = updateCurrentHistoryEntry(state.mainHistory, pending.currentLocation);
      return {
        ...state,
        pendingMainNavigation: null,
        mainHistory: { entries: refreshed.entries, index: pending.destinationIndex },
      };
    }
    case 'request-send-to-main': {
      if (state.activeTabIdentity === null) return state;
      return {
        ...state,
        pendingSendToMain: {
          token: action.token,
          sourceTabIdentity: state.activeTabIdentity,
          currentMainLocation: action.currentMainLocation,
        },
        workspace: state.workspace.lastMode === 'references'
          ? state.workspace
          : { ...state.workspace, lastMode: 'references' },
      };
    }
    case 'complete-send-to-main': {
      const pending = state.pendingSendToMain;
      if (
        pending === null
        || pending.token !== action.token
        || !completionIsCurrent(state, action)
      ) return state;
      if (!action.success) return { ...state, pendingSendToMain: null };
      const remaining = withoutTab(state, pending.sourceTabIdentity);
      if (remaining === null) return { ...state, pendingSendToMain: null };
      return {
        ...state,
        ...remaining,
        pendingReferenceSwitch: remaining.tabs.length === 0 ? null : state.pendingReferenceSwitch,
        pendingSendToMain: null,
        mainHistory: samePdfViewerLocation(pending.currentMainLocation, action.settledLocation)
          ? state.mainHistory
          : appendHistoryDestination(
              state.mainHistory,
              pending.currentMainLocation,
              action.settledLocation,
            ),
      };
    }
    case 'replace-document':
      return createReferenceNavigationState(action.documentGeneration);
  }
}
