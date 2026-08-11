import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type Ref,
} from 'react';

import type { AnnotationPresentation } from '../pdf/viewer-framing.js';
import {
  referenceTabSuccessorIdentity,
  type WorkspaceMode,
} from './reference-navigation-state.js';
import { compositeFocusIndex, horizontalTabFocusIndex } from './LinkActionPopover.js';
import { ReviewIcon } from './ReviewIcon.js';

const WORKSPACE_MODES: readonly WorkspaceMode[] = ['outline', 'annotations', 'references'];
const MODE_LABELS: Readonly<Record<WorkspaceMode, string>> = {
  outline: 'Outline',
  references: 'References',
  annotations: 'Annotations',
};
type ReferenceTabOrientation = 'horizontal' | 'vertical';

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
  readonly announcement?: string;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  readonly onReferenceTabActivate: (identity: string) => void;
  readonly onReferenceTabClose: (identity: string) => void;
  readonly onSendToMain: (identity: string) => void;
  readonly onRetryReference: () => void;
  readonly modes?: readonly WorkspaceMode[];
  readonly headerVariant?: 'tabs' | 'references';
  readonly onMoveReferencesRight?: () => void;
  readonly onMoveReferencesBottom?: () => void;
  readonly onReferenceViewportHost: (element: HTMLDivElement | null) => void;
  readonly onModeFocusTokenChange?: (mode: WorkspaceMode, token: string) => void;
}

function focusWithoutScroll(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true });
}

export function referenceTabFocusIndex(
  currentIndex: number,
  count: number,
  key: string,
  orientation: ReferenceTabOrientation,
): number | null {
  return orientation === 'horizontal'
    ? horizontalTabFocusIndex(currentIndex, count, key)
    : compositeFocusIndex(currentIndex, count, key);
}

export function chooseWorkspaceModeFocusTarget(input: {
  readonly mode: WorkspaceMode;
  readonly pendingStatus: PendingReferencePanel['status'] | null;
  readonly remembered: HTMLElement | null;
  readonly panel: HTMLElement | null;
  readonly retry: HTMLElement | null;
  readonly activeReference: HTMLElement | null;
  readonly emptyReference: HTMLElement | null;
}): HTMLElement | null {
  if (input.mode === 'references') {
    if (input.pendingStatus === 'error') return input.retry;
    if (input.pendingStatus === 'loading') return input.panel;
    // Once the final tab is gone, a connected panel remembered from an older
    // transient focus is less specific than the current empty-state target.
    if (input.emptyReference !== null) return input.emptyReference;
  }
  if (input.remembered?.isConnected) return input.remembered;
  if (input.mode === 'references') return input.activeReference ?? input.emptyReference;
  return input.panel;
}

export function ReferenceWorkspace({
  open,
  workspaceRef,
  mode,
  presentation,
  tabs,
  activeTabIdentity,
  pendingReference = null,
  announcement = '',
  onModeChange,
  onReferenceTabActivate,
  onReferenceTabClose,
  onSendToMain,
  onRetryReference,
  modes = WORKSPACE_MODES,
  headerVariant = 'tabs',
  onMoveReferencesRight,
  onMoveReferencesBottom,
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
  const previous = useRef<{
    open: boolean;
    mode: WorkspaceMode;
    pendingStatus: PendingReferencePanel['status'] | null;
  }>({ open: false, mode, pendingStatus: null });
  const previousActiveReference = useRef<string | null>(null);
  const referenceTabOrientation: ReferenceTabOrientation = presentation === 'bottom'
    && headerVariant === 'references'
    ? 'vertical'
    : 'horizontal';
  const showReferenceTabs = tabs.length > 0;

  const modeFallback = (targetMode: WorkspaceMode): HTMLElement | null => (
    chooseWorkspaceModeFocusTarget({
      mode: targetMode,
      pendingStatus: pendingReference?.status ?? null,
      remembered: modeFocusMemory.current.get(targetMode) ?? null,
      panel: panelRefs.current.get(targetMode) ?? null,
      retry: retryReferenceRef.current,
      activeReference: activeTabIdentity
        ? referenceTabRefs.current.get(activeTabIdentity) ?? null
        : null,
      emptyReference: emptyReferenceRef.current,
    })
  );

  useLayoutEffect(() => {
    const was = previous.current;
    const pendingStatus = pendingReference?.status ?? null;
    previous.current = { open, mode, pendingStatus };
    const retryBecameAvailable = open
      && mode === 'references'
      && pendingStatus === 'error'
      && was.pendingStatus !== 'error';
    if (!open || (was.open && was.mode === mode && !retryBecameAvailable)) return;
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
    const currentIndex = modes.indexOf(event.currentTarget.dataset.workspaceMode as WorkspaceMode);
    const nextIndex = horizontalTabFocusIndex(currentIndex, modes.length, event.key);
    if (nextIndex !== null) {
      event.preventDefault();
      focusWithoutScroll(modeTabRefs.current.get(modes[nextIndex]!));
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && currentIndex >= 0) {
      event.preventDefault();
      onModeChange(modes[currentIndex]!);
    }
  };

  const moveReferenceFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = tabs.findIndex(({ identity }) => identity === event.currentTarget.dataset.referenceTab);
    if (event.key === 'Delete') {
      event.preventDefault();
      const identity = tabs[currentIndex]?.identity;
      if (identity) {
        closeFocusIdentity.current = referenceTabSuccessorIdentity(tabs, currentIndex);
        onReferenceTabClose(identity);
      }
      return;
    }
    const nextIndex = referenceTabFocusIndex(
      currentIndex,
      tabs.length,
      event.key,
      referenceTabOrientation,
    );
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
      aria-label={headerVariant === 'references' ? 'References' : 'Review workspace'}
      aria-hidden={!open}
      inert={!open}
    >
      <header className="review-workspace__header">
        {headerVariant === 'references' ? (
          <strong id="references-workspace-title" className="review-workspace__title">References</strong>
        ) : null}
        {headerVariant === 'tabs' ? (
        <div className="review-workspace__tabs" role="tablist" aria-label="Workspace modes">
          {modes.map((workspaceMode) => {
            const selected = workspaceMode === mode;
            const hasMoveControl = workspaceMode === 'references' && Boolean(onMoveReferencesBottom);
            return (
              <span
                key={workspaceMode}
                className={`review-workspace__tab-segment${
                  hasMoveControl ? ' review-workspace__tab-segment--compound' : ''
                }`}
                data-workspace-tab-segment={workspaceMode}
                data-workspace-tab-selected={selected ? 'true' : 'false'}
                role="presentation"
              >
              <button
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
                {hasMoveControl ? (
                  <span className="sr-only">{MODE_LABELS[workspaceMode]}</span>
                ) : MODE_LABELS[workspaceMode]}
              </button>
              {hasMoveControl ? (
                <span className="review-workspace__tab-label" aria-hidden="true">
                  {MODE_LABELS[workspaceMode]}
                </span>
              ) : null}
              {hasMoveControl ? (
                <button
                  type="button"
                  className="review-workspace__move review-workspace__move--tab"
                  data-reference-move="bottom"
                  aria-label="Move References to bottom"
                  title="Move References to bottom"
                  onClick={onMoveReferencesBottom}
                >
                  <ReviewIcon name="chevron-down" size={14} />
                </button>
              ) : null}
              </span>
            );
          })}
        </div>
        ) : null}
        {headerVariant === 'references' && onMoveReferencesRight ? (
          <button
            type="button"
            className="review-workspace__move review-workspace__move--header"
            data-reference-move="right"
            aria-label="Move References to right"
            title="Move References to right"
            onClick={onMoveReferencesRight}
          >
            <ReviewIcon name="chevron-right" size={14} />
          </button>
        ) : null}
      </header>

      <section
        ref={(element) => {
          if (element) panelRefs.current.set('references', element);
          else panelRefs.current.delete('references');
        }}
        id="workspace-panel-references"
        className="review-workspace__panel review-workspace__panel--references"
        data-reference-tabs-orientation={referenceTabOrientation}
        data-reference-panel-layout={showReferenceTabs ? 'split' : 'full'}
        role="tabpanel"
        aria-labelledby={headerVariant === 'references'
          ? 'references-workspace-title'
          : 'workspace-mode-references'}
        tabIndex={-1}
        hidden={mode !== 'references' || !modes.includes('references')}
        inert={mode !== 'references' || !modes.includes('references')}
        onFocusCapture={(event) => rememberPanelFocus('references', event.target)}
      >
        {showReferenceTabs ? (
          <div
            className="reference-tabs"
            role="tablist"
            aria-label="Open references"
            aria-orientation={referenceTabOrientation}
            data-reference-tabs-orientation={referenceTabOrientation}
          >
            {tabs.map((tab, index) => {
              const selected = tab.identity === activeTabIdentity;
              const showActions = selected && pendingReference === null;
              const destinationLabel = tab.label === tab.pageContext
                ? tab.label
                : `${tab.label}, ${tab.pageContext}`;
              return (
                <span
                  key={tab.identity}
                  className={`reference-tab-segment${
                    showActions ? ' reference-tab-segment--compound' : ''
                  }`}
                  data-reference-tab-segment={tab.identity}
                  data-reference-tab-selected={selected ? 'true' : 'false'}
                  role="presentation"
                >
                  <button
                    ref={(element) => {
                      if (element) referenceTabRefs.current.set(tab.identity, element);
                      else referenceTabRefs.current.delete(tab.identity);
                    }}
                    id={`reference-tab-${index}`}
                    className="reference-tab-segment__selector"
                    type="button"
                    role="tab"
                    data-reference-tab={tab.identity}
                    data-workspace-focus-token={`reference:${tab.identity}`}
                    aria-label={destinationLabel}
                    aria-selected={selected}
                    aria-controls="active-reference-panel"
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={moveReferenceFocus}
                    onClick={() => onReferenceTabActivate(tab.identity)}
                  >
                    <span>{tab.label}</span>
                    {tab.label === tab.pageContext ? null : <small>{tab.pageContext}</small>}
                  </button>
                  {showActions ? (
                    <button
                      type="button"
                      className="reference-tab-segment__action"
                      data-reference-tab-action="send"
                      data-workspace-focus-token={`reference-send:${tab.identity}`}
                      aria-label="Send to main"
                      title="Send to main"
                      onClick={() => onSendToMain(tab.identity)}
                    >
                      <ReviewIcon name="main" />
                    </button>
                  ) : null}
                  {showActions ? (
                    <button
                      type="button"
                      className="reference-tab-segment__action"
                      data-reference-tab-action="close"
                      data-workspace-focus-token={`reference-close:${tab.identity}`}
                      aria-label="Close active reference"
                      title="Close active reference"
                      onClick={() => onReferenceTabClose(tab.identity)}
                    >
                      <ReviewIcon name="close" />
                    </button>
                  ) : null}
                </span>
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

    </aside>
    <p className="sr-only review-workspace__status" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
    </>
  );
}
