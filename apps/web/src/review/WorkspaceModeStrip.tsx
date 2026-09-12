import { createContext, useContext, type FocusEvent, type KeyboardEvent } from 'react';

import type { WorkspaceMode } from './reference-navigation-state.js';
import { ReviewIcon, type ReviewIconName } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

/** Optional host restriction; unavailable modes retain the production tab appearance. */
export const WorkspaceModeAvailability = createContext<readonly WorkspaceMode[] | null>(null);
export const WorkspaceInitialReferenceDock = createContext<'bottom' | 'right'>('bottom');
/** Host-requested presentation changes use the reader's normal layout transitions. */
export const WorkspacePresentation = createContext<{ mode: WorkspaceMode; open: boolean; referenceDock?: 'bottom' | 'right'; sampleReference?: { page: number; label: string; pdfY?: number }; bottomHeight?: number; initialLocation?: { pageIndex: number; top: number } } | null>(null);

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
  readonly disabled?: boolean;
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
  readonly quietSingleMode?: boolean;
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
  quietSingleMode = false,
}: WorkspaceModeStripProps<Mode>) {
  const availableModes = useContext(WorkspaceModeAvailability);
  const dockAttached = selectedMode === 'references' && dockAction !== undefined;

  return (
    <div className={`review-workspace__activity-strip${
      dockAttached ? ' review-workspace__activity-strip--compound' : ''
    }${quietSingleMode ? ' review-workspace__activity-strip--title' : ''
    }`}>
      <div
        className="review-workspace__tabs"
        role="tablist"
        aria-label="Workspace modes"
        data-workspace-mode-count={modes.length}
      >
        {modes.map((mode) => {
          const selected = mode === selectedMode;
          const unavailable = availableModes !== null && !availableModes.includes(mode);
          const presentation = MODE_PRESENTATION[mode];
          const compound = dockAttached && mode === 'references';
          return (
            <span
              key={mode}
              className={`review-workspace__mode-segment${
                compound ? ' review-workspace__mode-segment--compound' : ''
              }`}
              data-workspace-mode-selected={selected ? 'true' : 'false'}
              role="presentation"
            >
              <ReviewTooltipButton
                label={presentation.label}
                ref={(element) => onModeRef(mode, element)}
                id={`workspace-mode-${mode}`}
                className="review-workspace__mode-tab"
                type="button"
                role="tab"
                data-workspace-mode={mode}
                aria-label={presentation.label}
                aria-selected={selected}
                aria-controls={`workspace-panel-${mode}`}
                aria-disabled={unavailable || undefined}
                tabIndex={selected ? 0 : -1}
                onKeyDown={(event) => {
                  if (availableModes === null) return onModeKeyDown(event);
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const enabled = modes.filter((candidate) => availableModes.includes(candidate));
                  const index = enabled.indexOf(mode);
                  const next = event.key === 'Home' ? enabled[0]
                    : event.key === 'End' ? enabled.at(-1)
                      : enabled[(index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
                  if (next !== undefined) onModeChange(next);
                }}
                onFocus={(event) => onModeFocus?.(mode, event)}
                onBlur={(event) => onModeBlur?.(mode, event)}
                onClick={() => {
                  if (!unavailable) onModeChange(mode);
                }}
              >
                <ReviewIcon name={presentation.icon} />
                {selected ? (
                  <span
                    className="review-workspace__mode-label"
                    data-workspace-mode-label={mode}
                    aria-hidden="true"
                  >
                    {presentation.label}
                  </span>
                ) : null}
              </ReviewTooltipButton>
            </span>
          );
        })}
      </div>
      {dockAttached ? (
        <ReviewTooltipButton
          label={`Move References to ${dockAction.destination}`}
          type="button"
          className="review-workspace__move review-workspace__move--activity review-workspace__move--header-action"
          data-reference-move={dockAction.destination}
          disabled={dockAction.disabled}
          aria-label={`Move References to ${dockAction.destination}`}
          onClick={dockAction.onClick}
          onFocus={dockAction.onFocus}
          onBlur={dockAction.onBlur}
        >
          <ReviewIcon
            name={dockAction.destination === 'bottom' ? 'panel-bottom' : 'panel-right'}
            size={16}
          />
        </ReviewTooltipButton>
      ) : null}
    </div>
  );
}
