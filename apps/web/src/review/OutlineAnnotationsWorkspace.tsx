import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import type { AnnotationPresentation } from '../pdf/viewer-framing.js';
import { horizontalTabFocusIndex } from './LinkActionPopover.js';
import { OutlineNavigator } from './OutlineNavigator.js';
import type { WorkspaceMode } from './reference-navigation-state.js';
import type { RightWorkspaceMode } from './reference-workspace-layout.js';

const TOOL_MODES: readonly RightWorkspaceMode[] = ['outline', 'annotations'];
const TOOL_LABELS: Readonly<Record<RightWorkspaceMode, string>> = {
  outline: 'Outline',
  annotations: 'Annotations',
};

export interface OutlineAnnotationsWorkspaceProps {
  readonly open: boolean;
  readonly mode: WorkspaceMode;
  readonly presentation: AnnotationPresentation;
  readonly headerVariant: 'tools' | 'shared';
  readonly outline: PdfOutlineDiscovery;
  readonly currentOutlineItemId: string | null;
  readonly annotations: ReactNode;
  readonly onModeChange: (mode: RightWorkspaceMode) => void;
  readonly onOutlineActivate: (item: PdfOutlineItem) => void;
  readonly onModeFocusTokenChange?: (mode: RightWorkspaceMode, token: string) => void;
}

function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

export function OutlineAnnotationsWorkspace({
  open,
  mode,
  presentation,
  headerVariant,
  outline,
  currentOutlineItemId,
  annotations,
  onModeChange,
  onOutlineActivate,
  onModeFocusTokenChange,
}: OutlineAnnotationsWorkspaceProps) {
  const tabRefs = useRef(new Map<RightWorkspaceMode, HTMLButtonElement>());
  const panelRefs = useRef(new Map<RightWorkspaceMode, HTMLElement>());
  const focusMemory = useRef(new Map<RightWorkspaceMode, HTMLElement>());
  const previous = useRef({ open: false, mode });

  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = { open, mode };
    if (!open || mode === 'references' || (was.open && was.mode === mode)) return;
    const target = focusMemory.current.get(mode) ?? panelRefs.current.get(mode);
    requestAnimationFrame(() => focusWithoutScroll(target));
  }, [mode, open]);

  const moveModeFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = TOOL_MODES.indexOf(
      event.currentTarget.dataset.workspaceMode as RightWorkspaceMode,
    );
    const nextIndex = horizontalTabFocusIndex(currentIndex, TOOL_MODES.length, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusWithoutScroll(tabRefs.current.get(TOOL_MODES[nextIndex]!));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
      event.preventDefault();
      onModeChange(TOOL_MODES[currentIndex]!);
    }
  };

  const rememberFocus = (targetMode: RightWorkspaceMode, target: EventTarget) => {
    if (!(target instanceof HTMLElement)) return;
    focusMemory.current.set(targetMode, target);
    const token = target.dataset.workspaceFocusToken ?? target.dataset.ownedFocusId;
    if (token) onModeFocusTokenChange?.(targetMode, token);
  };

  return (
    <aside
      id="review-tools-workspace"
      className="review-tools-workspace"
      data-tools-workspace-open={open ? 'true' : 'false'}
      data-tools-workspace-shared={headerVariant === 'shared' ? 'true' : 'false'}
      data-workspace-presentation={presentation}
      aria-label="Outline and annotations"
      aria-hidden={!open}
      inert={!open}
    >
      {headerVariant === 'tools' ? (
        <header className="review-workspace__header">
          <div className="review-workspace__tabs" role="tablist" aria-label="Workspace modes">
            {TOOL_MODES.map((toolMode) => (
              <button
                key={toolMode}
                ref={(element) => {
                  if (element) tabRefs.current.set(toolMode, element);
                  else tabRefs.current.delete(toolMode);
                }}
                id={`workspace-mode-${toolMode}`}
                type="button"
                role="tab"
                data-workspace-mode={toolMode}
                aria-selected={mode === toolMode}
                aria-controls={`workspace-panel-${toolMode}`}
                tabIndex={mode === toolMode ? 0 : -1}
                onKeyDown={moveModeFocus}
                onClick={() => onModeChange(toolMode)}
              >
                {TOOL_LABELS[toolMode]}
              </button>
            ))}
          </div>
        </header>
      ) : null}

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('outline', element);
          else panelRefs.current.delete('outline');
        }}
        id="workspace-panel-outline"
        className="review-workspace__panel"
        role="tabpanel"
        aria-labelledby="workspace-mode-outline"
        tabIndex={-1}
        hidden={mode !== 'outline'}
        inert={mode !== 'outline'}
        onFocusCapture={(event) => rememberFocus('outline', event.target)}
      >
        <OutlineNavigator
          discovery={outline}
          currentItemId={currentOutlineItemId}
          onActivate={onOutlineActivate}
        />
      </section>

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('annotations', element);
          else panelRefs.current.delete('annotations');
        }}
        id="workspace-panel-annotations"
        className="review-workspace__panel"
        role="tabpanel"
        aria-labelledby="workspace-mode-annotations"
        tabIndex={-1}
        hidden={mode !== 'annotations'}
        inert={mode !== 'annotations'}
        onFocusCapture={(event) => rememberFocus('annotations', event.target)}
      >
        {annotations}
      </section>
    </aside>
  );
}
