import type { ReviewBaseSurface, ReviewSurfaceAction } from './review-surface-state.js';
import type { WorkspaceMode } from './reference-navigation-state.js';
import { BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN } from './reference-workspace-layout.js';

export function controlledWorkspaceSurfaceAction(input: {
  readonly open: boolean;
  readonly baseSurface: ReviewBaseSurface;
  readonly transientSurface: 'none' | 'selection-actions' | 'insert-action' | 'page-menu' | 'page-note-cursor';
  readonly mode: WorkspaceMode;
}): ReviewSurfaceAction | null {
  if (input.open) {
    return input.baseSurface !== 'workspace' || input.transientSurface !== 'none'
      ? { type: 'open-workspace', mode: input.mode }
      : null;
  }
  return input.baseSurface === 'workspace'
    ? { type: 'hide-workspace', focusReturnToken: BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN }
    : null;
}
