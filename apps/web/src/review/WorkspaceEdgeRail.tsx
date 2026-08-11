import type { Ref } from 'react';

import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';

export type WorkspaceEdgeRailSurface = 'right' | 'bottom';

export interface WorkspaceEdgeRailProps {
  readonly surface: WorkspaceEdgeRailSurface;
  readonly open: boolean;
  readonly controls: string;
  readonly onToggle: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

function railIcon(surface: WorkspaceEdgeRailSurface, open: boolean): ReviewIconName {
  if (surface === 'right') return open ? 'chevron-right' : 'chevron-left';
  return open ? 'chevron-down' : 'chevron-up';
}

function railLabel(surface: WorkspaceEdgeRailSurface, open: boolean): string {
  const target = surface === 'right' ? 'right workspace' : 'References tray';
  return `${open ? 'Close' : 'Open'} ${target}`;
}

export function WorkspaceEdgeRail({
  surface,
  open,
  controls,
  onToggle,
  buttonRef,
}: WorkspaceEdgeRailProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="workspace-edge-rail"
      data-workspace-edge-rail={surface}
      data-edge-rail-open={open ? 'true' : 'false'}
      aria-label={railLabel(surface, open)}
      aria-expanded={open}
      aria-controls={controls}
      onClick={(event) => {
        const button = event.currentTarget;
        onToggle();
        if (open) requestAnimationFrame(() => button.focus({ preventScroll: true }));
      }}
    >
      <span className="workspace-edge-rail__glyph">
        <ReviewIcon name={railIcon(surface, open)} size={14} />
      </span>
    </button>
  );
}
