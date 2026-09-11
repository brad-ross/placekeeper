import type { ReferenceReturnPresentationState } from './navigation-coordinator.js';
import type { ReferenceWorkspaceLayoutState } from './reference-workspace-layout.js';
import type { ReferenceNavigationState } from './reference-navigation-state.js';
export function referenceFocusRailSurface(
  layout: ReferenceWorkspaceLayoutState,
  hasRemainingReferences: boolean,
): 'bottom' | 'right' {
  if (layout.regime === 'narrow') return 'bottom';
  return hasRemainingReferences && layout.referenceDock === 'bottom' ? 'bottom' : 'right';
}

export function referencePdfIsVisible(
  layout: ReferenceWorkspaceLayoutState,
  navigation: ReferenceNavigationState,
): boolean {
  if (navigation.activeTabIdentity === null) return false;
  if (layout.regime === 'narrow') {
    return layout.narrowOpen && layout.narrowSurface === 'references';
  }
  return layout.referenceDock === 'bottom'
    ? layout.bottomReferencesOpen
    : layout.rightWorkspaceOpen && navigation.workspace.lastMode === 'references';
}

export function referenceReturnForActiveTab(
  scope: Pick<ReferenceNavigationState, 'activeTabIdentity' | 'documentGeneration'>,
  presentation: ReferenceReturnPresentationState | null,
): ReferenceReturnPresentationState | null {
  return presentation !== null
    && presentation.available
    && presentation.tabIdentity === scope.activeTabIdentity
    && presentation.documentGeneration === scope.documentGeneration
    ? presentation
    : null;
}
