import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import type { AnnotationPresentation } from '../pdf/viewer-framing.js';
import type { WorkspaceMode } from './reference-navigation-state.js';
import { horizontalTabFocusIndex } from './LinkActionPopover.js';
import { OutlineNavigator } from './OutlineNavigator.js';
import { ReviewIcon } from './ReviewIcon.js';

const WORKSPACE_MODES: readonly WorkspaceMode[] = ['outline', 'references', 'annotations'];
const MODE_LABELS: Readonly<Record<WorkspaceMode, string>> = {
  outline: 'Outline',
  references: 'References',
  annotations: 'Annotations',
};

export interface ReferenceWorkspaceTab {
  readonly identity: string;
  readonly label: string;
  readonly pageContext: string;
}

export type PendingReferencePanel =
  | {
    readonly status: 'loading';
    readonly label: string;
    readonly pageContext: string;
  }
  | {
    readonly status: 'error';
    readonly label: string;
    readonly pageContext: string;
  };

export interface ReferenceWorkspaceProps {
  readonly open: boolean;
  readonly workspaceRef?: Ref<HTMLElement>;
  readonly mode: WorkspaceMode;
  readonly presentation: AnnotationPresentation;
  readonly tabs: readonly ReferenceWorkspaceTab[];
  readonly activeTabIdentity: string | null;
  readonly pendingReference?: PendingReferencePanel | null;
  readonly outline: PdfOutlineDiscovery;
  readonly currentOutlineItemId?: string | null;
  readonly annotations: ReactNode;
  readonly announcement?: string;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  readonly onReferenceTabActivate: (identity: string) => void;
  readonly onReferenceTabClose: (identity: string) => void;
  readonly onSendToMain: (identity: string) => void;
  readonly onRetryReference: () => void;
  readonly onOutlineActivate: (item: PdfOutlineItem, control: HTMLButtonElement) => void;
  readonly onDismiss: () => void;
  readonly onReferenceViewportHost: (element: HTMLDivElement | null) => void;
  readonly onModeFocusTokenChange?: (mode: WorkspaceMode, token: string) => void;
}

function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

export function ReferenceWorkspace({
  open,
  workspaceRef,
  mode,
  presentation,
  tabs,
  activeTabIdentity,
  pendingReference = null,
  outline,
  currentOutlineItemId = null,
  annotations,
  announcement = '',
  onModeChange,
  onReferenceTabActivate,
  onReferenceTabClose,
  onSendToMain,
  onRetryReference,
  onOutlineActivate,
  onDismiss,
  onReferenceViewportHost,
  onModeFocusTokenChange,
}: ReferenceWorkspaceProps) {
  const modeTabRefs = useRef(new Map<WorkspaceMode, HTMLButtonElement>());
  const panelRefs = useRef(new Map<WorkspaceMode, HTMLElement>());
  const modeFocusMemory = useRef(new Map<WorkspaceMode, HTMLElement>());
  const referenceTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const emptyReferenceRef = useRef<HTMLDivElement>(null);
  const retryReferenceRef = useRef<HTMLButtonElement>(null);
  const closeFocusIdentity = useRef<string | null>(null);
  const previous = useRef({ open: false, mode });
  const previousActiveReference = useRef<string | null>(null);

  const modeFallback = (targetMode: WorkspaceMode): HTMLElement | null => {
    const remembered = modeFocusMemory.current.get(targetMode);
    if (remembered?.isConnected) return remembered;
    if (targetMode === 'references') {
      if (pendingReference?.status === 'error') return retryReferenceRef.current;
      if (activeTabIdentity) return referenceTabRefs.current.get(activeTabIdentity) ?? null;
      return emptyReferenceRef.current;
    }
    return panelRefs.current.get(targetMode) ?? null;
  };

  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = { open, mode };
    if (!open || (was.open && was.mode === mode)) return;
    requestAnimationFrame(() => focusWithoutScroll(modeFallback(mode)));
  }, [open, mode, activeTabIdentity, pendingReference?.status]);

  useLayoutEffect(() => {
    const changed = previousActiveReference.current !== activeTabIdentity;
    previousActiveReference.current = activeTabIdentity;
    if (!changed || !open || mode !== 'references' || activeTabIdentity === null) return;
    requestAnimationFrame(() => focusWithoutScroll(referenceTabRefs.current.get(activeTabIdentity)));
  }, [activeTabIdentity, mode, open]);

  useLayoutEffect(() => {
    const identity = closeFocusIdentity.current;
    if (identity === null) return;
    const target = referenceTabRefs.current.get(identity);
    if (!target) return;
    closeFocusIdentity.current = null;
    requestAnimationFrame(() => focusWithoutScroll(target));
  }, [tabs]);

  const moveModeFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = WORKSPACE_MODES.indexOf(event.currentTarget.dataset.workspaceMode as WorkspaceMode);
    const nextIndex = horizontalTabFocusIndex(currentIndex, WORKSPACE_MODES.length, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusWithoutScroll(modeTabRefs.current.get(WORKSPACE_MODES[nextIndex]!));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
      event.preventDefault();
      onModeChange(WORKSPACE_MODES[currentIndex]!);
    }
  };

  const moveReferenceFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = tabs.findIndex(({ identity }) => identity === event.currentTarget.dataset.referenceTab);
    if (event.key === 'Delete') {
      event.preventDefault();
      const identity = tabs[currentIndex]?.identity;
      if (identity) {
        closeFocusIdentity.current = tabs[currentIndex + 1]?.identity
          ?? tabs[currentIndex - 1]?.identity
          ?? null;
        onReferenceTabClose(identity);
      }
      return;
    }
    const nextIndex = horizontalTabFocusIndex(currentIndex, tabs.length, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusWithoutScroll(referenceTabRefs.current.get(tabs[nextIndex]!.identity));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
      event.preventDefault();
      onReferenceTabActivate(tabs[currentIndex]!.identity);
    }
  };

  const activeTab = tabs.find(({ identity }) => identity === activeTabIdentity) ?? null;
  const rememberPanelFocus = (targetMode: WorkspaceMode, target: EventTarget) => {
    if (!(target instanceof HTMLElement)) return;
    modeFocusMemory.current.set(targetMode, target);
    const token = target.dataset.workspaceFocusToken
      ?? target.dataset.ownedFocusId
      ?? target.dataset.referenceTab;
    if (token) onModeFocusTokenChange?.(targetMode, token);
  };

  return (
    <>
    <aside
      ref={workspaceRef}
      id="review-workspace"
      className="review-workspace"
      data-review-workspace
      data-annotation-drawer
      data-workspace-presentation={presentation}
      data-annotation-presentation={presentation}
      data-workspace-open={open ? 'true' : 'false'}
      data-list-open={open ? 'true' : 'false'}
      aria-label="Review workspace"
      aria-hidden={!open}
      inert={!open}
    >
      <header className="review-workspace__header">
        <div className="review-workspace__tabs" role="tablist" aria-label="Workspace modes">
          {WORKSPACE_MODES.map((workspaceMode) => {
            const selected = workspaceMode === mode;
            return (
              <button
                key={workspaceMode}
                ref={(element) => {
                  if (element) modeTabRefs.current.set(workspaceMode, element);
                  else modeTabRefs.current.delete(workspaceMode);
                }}
                id={`workspace-mode-${workspaceMode}`}
                type="button"
                role="tab"
                data-workspace-mode={workspaceMode}
                aria-selected={selected}
                aria-controls={`workspace-panel-${workspaceMode}`}
                tabIndex={selected ? 0 : -1}
                onKeyDown={moveModeFocus}
                onClick={() => onModeChange(workspaceMode)}
              >
                {MODE_LABELS[workspaceMode]}
              </button>
            );
          })}
        </div>
        <button type="button" className="review-workspace__close" aria-label="Close workspace" onClick={onDismiss}>
          <ReviewIcon name="close" />
        </button>
      </header>

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
        onFocusCapture={(event) => rememberPanelFocus('outline', event.target)}
      >
        <OutlineNavigator
          discovery={outline}
          currentItemId={currentOutlineItemId}
          onActivate={onOutlineActivate}
          onFocusTokenChange={(token) => onModeFocusTokenChange?.('outline', token)}
        />
      </section>

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('references', element);
          else panelRefs.current.delete('references');
        }}
        id="workspace-panel-references"
        className="review-workspace__panel review-workspace__panel--references"
        role="tabpanel"
        aria-labelledby="workspace-mode-references"
        tabIndex={-1}
        hidden={mode !== 'references'}
        inert={mode !== 'references'}
        onFocusCapture={(event) => rememberPanelFocus('references', event.target)}
      >
        {tabs.length > 0 ? (
          <div className="reference-tabs" role="tablist" aria-label="Open references">
            {tabs.map((tab, index) => {
              const selected = tab.identity === activeTabIdentity;
              return (
                <button
                  key={tab.identity}
                  ref={(element) => {
                    if (element) referenceTabRefs.current.set(tab.identity, element);
                    else referenceTabRefs.current.delete(tab.identity);
                  }}
                  id={`reference-tab-${index}`}
                  type="button"
                  role="tab"
                  data-reference-tab={tab.identity}
                  data-workspace-focus-token={`reference:${tab.identity}`}
                  aria-selected={selected}
                  aria-controls="active-reference-panel"
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={moveReferenceFocus}
                  onClick={() => onReferenceTabActivate(tab.identity)}
                >
                  <span>{tab.label}</span>
                  {tab.label === tab.pageContext ? null : <small>{tab.pageContext}</small>}
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          id="active-reference-panel"
          className="reference-panel"
          role="tabpanel"
          aria-label={activeTab === null ? 'Reference destination' : undefined}
          aria-labelledby={activeTab ? `reference-tab-${tabs.indexOf(activeTab)}` : undefined}
          aria-busy={pendingReference?.status === 'loading' ? true : undefined}
        >
          {activeTab && pendingReference === null ? (
            <header className="reference-panel__actions">
              <div>
                <strong>{activeTab.label}</strong>
                {activeTab.label === activeTab.pageContext ? null : <span>{activeTab.pageContext}</span>}
              </div>
              <button
                type="button"
                data-workspace-focus-token={`reference-close:${activeTab.identity}`}
                aria-label="Close active reference"
                onClick={() => onReferenceTabClose(activeTab.identity)}
              >
                <ReviewIcon name="close" />
                <span>Close</span>
              </button>
              <button
                type="button"
                data-workspace-focus-token={`reference-send:${activeTab.identity}`}
                onClick={() => onSendToMain(activeTab.identity)}
              >
                Send to main
              </button>
            </header>
          ) : null}

          {pendingReference ? (
            <div className="reference-panel__pending" data-reference-pending={pendingReference.status}>
              <p><strong>{pendingReference.label}</strong><span>{pendingReference.pageContext}</span></p>
              {pendingReference.status === 'loading' ? (
                <p className="workspace-state"><ReviewIcon name="loading" />Opening reference…</p>
              ) : (
                <div className="workspace-state" data-reference-state="error">
                  <p>Reference unavailable.</p>
                  <button
                    ref={retryReferenceRef}
                    type="button"
                    data-workspace-focus-token="references:retry"
                    onClick={onRetryReference}
                  >
                    Retry reference
                  </button>
                </div>
              )}
            </div>
          ) : null}

          {!activeTab && pendingReference === null ? (
            <div
              ref={emptyReferenceRef}
              className="workspace-state reference-panel__empty"
              data-reference-empty
              data-workspace-focus-token="references:empty"
              tabIndex={-1}
            >
              <strong>No references open.</strong>
              <span>An internal PDF link can open a reference here.</span>
            </div>
          ) : null}

          <div
            ref={onReferenceViewportHost}
            className="reference-panel__viewport"
            data-reference-viewport-host
            hidden={pendingReference?.status === 'error' || (activeTab === null && pendingReference === null)}
            inert={pendingReference?.status === 'error' || (activeTab === null && pendingReference === null)}
          />
        </div>
      </section>

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('annotations', element);
          else panelRefs.current.delete('annotations');
        }}
        id="workspace-panel-annotations"
        className="review-workspace__panel review-workspace__panel--annotations"
        data-annotation-scroll-viewport
        role="tabpanel"
        aria-labelledby="workspace-mode-annotations"
        tabIndex={-1}
        hidden={mode !== 'annotations'}
        inert={mode !== 'annotations'}
        onFocusCapture={(event) => rememberPanelFocus('annotations', event.target)}
      >
        {annotations}
      </section>

    </aside>
    <p className="sr-only review-workspace__status" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
    </>
  );
}
