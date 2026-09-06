import type { Ref } from 'react';

import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

export type WorkspaceEdgeRailSurface = 'right' | 'bottom';

export interface WorkspaceEdgeRailProps {
  readonly surface: WorkspaceEdgeRailSurface;
  readonly target: 'workspace' | 'References';
  readonly open: boolean;
  readonly controls: string;
  readonly onToggle: () => void;
  readonly buttonRef?: Ref<HTMLButtonElement>;
}

function railIcon(surface: WorkspaceEdgeRailSurface, open: boolean): ReviewIconName {
  if (surface === 'right') return open ? 'chevron-right' : 'chevron-left';
  return open ? 'chevron-down' : 'chevron-up';
}

function railLabel(target: WorkspaceEdgeRailProps['target'], open: boolean): string {
  return `${open ? 'Hide' : 'Show'} ${target}`;
}

export function WorkspaceEdgeRail({
  surface,
  target,
  open,
  controls,
  onToggle,
  buttonRef,
}: WorkspaceEdgeRailProps) {
  return (
    <ReviewTooltipButton
      label={railLabel(target, open)}
      ref={buttonRef}
      type="button"
      className="workspace-edge-rail"
      data-workspace-edge-rail={surface}
      data-edge-rail-open={open ? 'true' : 'false'}
      aria-label={railLabel(target, open)}
      aria-expanded={open}
      aria-controls={controls}
      onClick={(event) => {
        const button = event.currentTarget;
        onToggle();
        if (open) requestAnimationFrame(() => button.focus({ preventScroll: true }));
      }}
    >
      <span className="workspace-edge-rail__glyph">
        <ReviewIcon name={railIcon(surface, open)} />
      </span>
    </ReviewTooltipButton>
  );
}
