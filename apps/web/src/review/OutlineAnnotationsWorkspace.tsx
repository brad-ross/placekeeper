import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import type { AnnotationPresentation } from '../pdf/viewer-framing.js';
import type { PdfDestinationCopyLink } from './copy-link-model.js';
import { horizontalTabFocusIndex } from './menu-focus.js';
import { useOutlineExpansionController } from './OutlineExpansionController.js';
import { OutlineNavigator } from './OutlineNavigator.js';
import type { WorkspaceMode } from './reference-navigation-state.js';
import type { RightWorkspaceMode } from './reference-workspace-layout.js';
import { WorkspaceModeStrip } from './WorkspaceModeStrip.js';

export interface OutlineAnnotationsWorkspaceProps {
  readonly workspaceRef?: Ref<HTMLElement>;
  readonly open: boolean;
  /** The workspace keeps its live state while the composer temporarily occupies its edge. */
  readonly authoringTakeover?: boolean;
  readonly mode: WorkspaceMode;
  readonly modes: readonly RightWorkspaceMode[];
  readonly presentation: AnnotationPresentation;
  readonly headerVariant: 'tools' | 'shared';
  readonly outline: PdfOutlineDiscovery;
  readonly currentOutlineItemId: string | null;
  readonly annotations: ReactNode;
  readonly search?: ReactNode;
  readonly headerAction?: ReactNode;
  readonly onModeChange: (mode: RightWorkspaceMode) => void;
  readonly onOutlineActivate: (item: PdfOutlineItem) => void;
  readonly onOutlineReference: (item: PdfOutlineItem) => void;
  readonly copyLinkForOutlineItem?: (item: PdfOutlineItem) => PdfDestinationCopyLink | undefined;
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
  authoringTakeover = false,
  mode,
  modes,
  presentation,
  headerVariant,
  outline,
  currentOutlineItemId,
  annotations,
  search,
  headerAction,
  onModeChange,
  onOutlineActivate,
  onOutlineReference,
  copyLinkForOutlineItem,
  onModeFocusTokenChange,
}: OutlineAnnotationsWorkspaceProps) {
  const outlineExpansion = useOutlineExpansionController();
  const outlineAvailable = modes.includes('outline');
  const annotationsAvailable = modes.includes('annotations');
  const toolModes = modes;
  const effectiveMode: WorkspaceMode = mode !== 'references' && !modes.includes(mode)
    ? modes[0] ?? 'search'
    : mode;
  const effectiveToolMode: RightWorkspaceMode = effectiveMode === 'references'
    ? modes[0] ?? 'search'
    : effectiveMode;
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
    const panel = panelRefs.current.get(effectiveMode);
    const timeout = setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && panel?.contains(active)) return;
      focusWithoutScroll(target);
    }, 0);
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
      data-authoring-takeover={authoringTakeover ? 'true' : undefined}
      data-tools-workspace-shared={headerVariant === 'shared' ? 'true' : 'false'}
      data-workspace-presentation={presentation}
      aria-label={outlineAvailable
        ? annotationsAvailable ? 'Outline, search, and annotations' : 'Outline and search'
        : annotationsAvailable ? 'Search and annotations' : 'Search'}
      aria-hidden={!open || authoringTakeover}
      inert={!open || authoringTakeover}
    >
      {headerVariant === 'tools' ? (
        <header className="review-workspace__header">
          <WorkspaceModeStrip
            modes={toolModes}
            selectedMode={effectiveToolMode}
            onModeChange={onModeChange}
            onModeKeyDown={moveModeFocus}
            onModeRef={(toolMode, element) => {
              if (element) tabRefs.current.set(toolMode, element);
              else tabRefs.current.delete(toolMode);
            }}
          />
          {headerAction}
        </header>
      ) : null}

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('search', element);
          else panelRefs.current.delete('search');
        }}
        id="workspace-panel-search"
        className="review-workspace__panel review-workspace__panel--search"
        role="tabpanel"
        aria-labelledby="workspace-mode-search"
        tabIndex={-1}
        hidden={effectiveMode !== 'search'}
        inert={effectiveMode !== 'search'}
        onFocusCapture={(event) => rememberFocus('search', event.target)}
      >
        {search}
      </section>

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
          expandedItemIds={outlineExpansion.expandedItemIds}
          onExpandedItemIdsChange={outlineExpansion.setExpandedItemIds}
          {...(copyLinkForOutlineItem === undefined ? {} : { copyLinkForItem: copyLinkForOutlineItem })}
          onFocusTokenChange={(token) => onModeFocusTokenChange?.('outline', token)}
        />
      </section> : null}

      {annotationsAvailable ? <section
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
      </section> : null}
    </aside>
  );
}
