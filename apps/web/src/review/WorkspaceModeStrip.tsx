import type { FocusEvent, KeyboardEvent } from 'react';

import type { WorkspaceMode } from './reference-navigation-state.js';
import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';

const MODE_PRESENTATION: Readonly<Record<WorkspaceMode, {
  readonly label: string;
  readonly icon: ReviewIconName;
}>> = {
  outline: { label: 'Outline', icon: 'outline' },
  search: { label: 'Search', icon: 'search' },
  annotations: { label: 'Annotations', icon: 'annotations' },
  references: { label: 'References', icon: 'references' },
};

export interface WorkspaceDockAction {
  readonly destination: 'bottom' | 'right';
  readonly onClick: () => void;
  readonly onFocus?: (event: FocusEvent<HTMLButtonElement>) => void;
  readonly onBlur?: (event: FocusEvent<HTMLButtonElement>) => void;
}

export interface WorkspaceModeStripProps<Mode extends WorkspaceMode> {
  readonly modes: readonly Mode[];
  readonly selectedMode: Mode;
  readonly onModeChange: (mode: Mode) => void;
  readonly onModeKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onModeRef: (mode: Mode, element: HTMLButtonElement | null) => void;
  readonly onModeFocus?: (
    mode: Mode,
    event: FocusEvent<HTMLButtonElement>,
  ) => void;
  readonly onModeBlur?: (
    mode: Mode,
    event: FocusEvent<HTMLButtonElement>,
  ) => void;
  readonly dockAction?: WorkspaceDockAction;
}

export function WorkspaceModeStrip<Mode extends WorkspaceMode>({
  modes,
  selectedMode,
  onModeChange,
  onModeKeyDown,
  onModeRef,
  onModeFocus,
  onModeBlur,
  dockAction,
}: WorkspaceModeStripProps<Mode>) {
  return (
    <div className="review-workspace__activity-strip">
      <div
        className="review-workspace__tabs"
        role="tablist"
        aria-label="Workspace modes"
        data-workspace-mode-count={modes.length}
      >
        {modes.map((mode) => {
          const selected = mode === selectedMode;
          const presentation = MODE_PRESENTATION[mode];
          return (
            <button
              key={mode}
              ref={(element) => onModeRef(mode, element)}
              id={`workspace-mode-${mode}`}
              className="review-workspace__mode-tab"
              type="button"
              role="tab"
              data-workspace-mode={mode}
              aria-label={presentation.label}
              aria-selected={selected}
              aria-controls={`workspace-panel-${mode}`}
              title={`Show ${presentation.label}`}
              tabIndex={selected ? 0 : -1}
              onKeyDown={onModeKeyDown}
              onFocus={(event) => onModeFocus?.(mode, event)}
              onBlur={(event) => onModeBlur?.(mode, event)}
              onClick={() => onModeChange(mode)}
            >
              <ReviewIcon name={presentation.icon} size={15} />
              {selected ? (
                <span
                  className="review-workspace__mode-label"
                  data-workspace-mode-label={mode}
                  aria-hidden="true"
                >
                  {presentation.label}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {dockAction ? (
        <button
          type="button"
          className="review-workspace__move review-workspace__move--activity"
          data-reference-move={dockAction.destination}
          aria-label={`Move References to ${dockAction.destination}`}
          title={`Move References to ${dockAction.destination}`}
          onClick={dockAction.onClick}
          onFocus={dockAction.onFocus}
          onBlur={dockAction.onBlur}
        >
          <ReviewIcon
            name={dockAction.destination === 'bottom' ? 'chevron-down' : 'chevron-right'}
            size={14}
          />
        </button>
      ) : null}
    </div>
  );
}
