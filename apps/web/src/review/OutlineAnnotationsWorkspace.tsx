import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import type { AnnotationPresentation } from '../pdf/viewer-framing.js';
import { horizontalTabFocusIndex } from './LinkActionPopover.js';
import { OutlineNavigator } from './OutlineNavigator.js';
import type { WorkspaceMode } from './reference-navigation-state.js';
import type { RightWorkspaceMode } from './reference-workspace-layout.js';

const TOOL_MODES: readonly RightWorkspaceMode[] = ['outline', 'annotations'];
const ANNOTATION_ONLY_MODES: readonly RightWorkspaceMode[] = ['annotations'];
const TOOL_LABELS: Readonly<Record<RightWorkspaceMode, string>> = {
  outline: 'Outline',
  annotations: 'Annotations',
};

export interface OutlineAnnotationsWorkspaceProps {
  readonly workspaceRef?: Ref<HTMLElement>;
  readonly open: boolean;
  readonly mode: WorkspaceMode;
  readonly presentation: AnnotationPresentation;
  readonly headerVariant: 'tools' | 'shared';
  readonly outline: PdfOutlineDiscovery;
  readonly currentOutlineItemId: string | null;
  readonly annotations: ReactNode;
  readonly onModeChange: (mode: RightWorkspaceMode) => void;
  readonly onOutlineActivate: (item: PdfOutlineItem) => void;
  readonly onOutlineReference: (item: PdfOutlineItem) => void;
  readonly onModeFocusTokenChange?: (mode: RightWorkspaceMode, token: string) => void;
}

function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

export function chooseToolModeFocusTarget(
  remembered: HTMLElement | null | undefined,
  panel: HTMLElement | null | undefined,
): HTMLElement | null | undefined {
  return remembered?.isConnected ? remembered : panel;
}

export function OutlineAnnotationsWorkspace({
  workspaceRef,
  open,
  mode,
  presentation,
  headerVariant,
  outline,
  currentOutlineItemId,
  annotations,
  onModeChange,
  onOutlineActivate,
  onOutlineReference,
  onModeFocusTokenChange,
}: OutlineAnnotationsWorkspaceProps) {
  const outlineAvailable = outline.status !== 'loaded-empty';
  const toolModes = outlineAvailable ? TOOL_MODES : ANNOTATION_ONLY_MODES;
  const effectiveMode: WorkspaceMode = mode === 'outline' && !outlineAvailable
    ? 'annotations'
    : mode;
  const tabRefs = useRef(new Map<RightWorkspaceMode, HTMLButtonElement>());
  const panelRefs = useRef(new Map<RightWorkspaceMode, HTMLElement>());
  const focusMemory = useRef(new Map<RightWorkspaceMode, HTMLElement>());
  const previous = useRef({ open: false, mode: effectiveMode });

  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = { open, mode: effectiveMode };
    if (!open || effectiveMode === 'references' || (was.open && was.mode === effectiveMode)) return;
    const target = chooseToolModeFocusTarget(
      focusMemory.current.get(effectiveMode),
      panelRefs.current.get(effectiveMode),
    );
    const timeout = setTimeout(() => focusWithoutScroll(target), 0);
    return () => clearTimeout(timeout);
  }, [effectiveMode, open]);

  const moveModeFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = toolModes.indexOf(
      event.currentTarget.dataset.workspaceMode as RightWorkspaceMode,
    );
    const nextIndex = horizontalTabFocusIndex(currentIndex, toolModes.length, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusWithoutScroll(tabRefs.current.get(toolModes[nextIndex]!));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
      event.preventDefault();
      onModeChange(toolModes[currentIndex]!);
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
      ref={workspaceRef}
      id="review-tools-workspace"
      className="review-tools-workspace"
      data-tools-workspace-open={open ? 'true' : 'false'}
      data-tools-workspace-shared={headerVariant === 'shared' ? 'true' : 'false'}
      data-workspace-presentation={presentation}
      aria-label={outlineAvailable ? 'Outline and annotations' : 'Annotations'}
      aria-hidden={!open}
      inert={!open}
    >
      {headerVariant === 'tools' ? (
        <header className="review-workspace__header">
          <div
            className="review-workspace__tabs"
            role="tablist"
            aria-label="Workspace modes"
            data-workspace-mode-count={toolModes.length}
            style={{ gridTemplateColumns: `repeat(${toolModes.length}, minmax(0, 1fr))` }}
          >
            {toolModes.map((toolMode) => (
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
                aria-selected={effectiveMode === toolMode}
                aria-controls={`workspace-panel-${toolMode}`}
                tabIndex={effectiveMode === toolMode ? 0 : -1}
                onKeyDown={moveModeFocus}
                onClick={() => onModeChange(toolMode)}
              >
                {TOOL_LABELS[toolMode]}
              </button>
            ))}
          </div>
        </header>
      ) : null}

      {outlineAvailable ? <section
        ref={(element) => {
          if (element) panelRefs.current.set('outline', element);
          else panelRefs.current.delete('outline');
        }}
        id="workspace-panel-outline"
        className="review-workspace__panel"
        role="tabpanel"
        aria-labelledby="workspace-mode-outline"
        tabIndex={-1}
        hidden={effectiveMode !== 'outline'}
        inert={effectiveMode !== 'outline'}
        onFocusCapture={(event) => rememberFocus('outline', event.target)}
      >
        <OutlineNavigator
          discovery={outline}
          currentItemId={currentOutlineItemId}
          onActivate={onOutlineActivate}
          onOpenReference={onOutlineReference}
          onFocusTokenChange={(token) => onModeFocusTokenChange?.('outline', token)}
        />
      </section> : null}

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('annotations', element);
          else panelRefs.current.delete('annotations');
        }}
        id="workspace-panel-annotations"
        className="review-workspace__panel"
        data-annotation-scroll-viewport
        role="tabpanel"
        aria-labelledby="workspace-mode-annotations"
        tabIndex={-1}
        hidden={effectiveMode !== 'annotations'}
        inert={effectiveMode !== 'annotations'}
        onFocusCapture={(event) => rememberFocus('annotations', event.target)}
      >
        {annotations}
      </section>
    </aside>
  );
}
