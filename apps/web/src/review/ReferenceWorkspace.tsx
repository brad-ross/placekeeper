import {
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';

import type { AnnotationPresentation } from '../pdf/viewer-framing.js';
import {
  referenceTabSuccessorIdentity,
  WORKSPACE_MODES,
  type WorkspaceMode,
} from './reference-navigation-state.js';
import { compositeFocusIndex, horizontalTabFocusIndex } from './menu-focus.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';
import { WorkspaceModeStrip, type WorkspaceDockAction } from './WorkspaceModeStrip.js';

export { WORKSPACE_MODES } from './reference-navigation-state.js';
type ReferenceTabOrientation = 'horizontal' | 'vertical';

function focusMovedToConnectedTarget(event: FocusEvent<HTMLElement>): boolean {
  const nextTarget = event.relatedTarget;
  return nextTarget instanceof HTMLElement
    && nextTarget !== event.currentTarget.ownerDocument.body
    && nextTarget.isConnected;
}

export interface ReferenceWorkspaceTab {
  readonly identity: string;
  readonly label: string;
  readonly pageContext: string;
  readonly pageNumber?: number;
}

export interface ReferenceReturnControlState {
  readonly tabIdentity: string;
  readonly available: boolean;
  readonly pending: boolean;
}

type ReferenceReturnButtonProps = Pick<
  ReferenceReturnControlState,
  'tabIdentity' | 'pending'
> & {
  readonly buttonRef: Ref<HTMLButtonElement>;
  readonly onReturn: (identity: string) => void;
};

function ReferenceReturnButton({
  tabIdentity,
  pending,
  buttonRef,
  onReturn,
}: ReferenceReturnButtonProps) {
  return (
    <ReviewTooltipButton
      label="Return to reference"
      ref={buttonRef}
      type="button"
      className="reference-panel__return"
      data-reference-return={tabIdentity}
      aria-label="Return to reference"
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      onClick={(event) => {
        if (pending) {
          event.preventDefault();
          return;
        }
        onReturn(tabIdentity);
      }}
    >
      <ReviewIcon name="locate" />
    </ReviewTooltipButton>
  );
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
  /** The workspace keeps its live state while the composer temporarily occupies its edge. */
  readonly authoringTakeover?: boolean;
  readonly workspaceRef?: Ref<HTMLElement>;
  readonly mode: WorkspaceMode;
  readonly presentation: AnnotationPresentation;
  readonly tabs: readonly ReferenceWorkspaceTab[];
  readonly activeTabIdentity: string | null;
  readonly pendingReference?: PendingReferencePanel | null;
  readonly referenceReturn?: ReferenceReturnControlState | null;
  readonly announcement?: string;
  readonly onModeChange: (mode: WorkspaceMode) => void;
  readonly onReferenceTabActivate: (identity: string) => void;
  readonly onReferenceTabClose: (identity: string) => void;
  readonly onSendToMain: (identity: string) => void;
  readonly onRetryReference: () => void;
  readonly onReferenceReturn?: (identity: string) => void;
  readonly modes?: readonly WorkspaceMode[];
  readonly headerVariant?: 'tabs' | 'references';
  readonly headerAction?: ReactNode;
  readonly onHide?: () => void;
  readonly hideLabel?: string;
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
  authoringTakeover = false,
  workspaceRef,
  mode,
  presentation,
  tabs,
  activeTabIdentity,
  pendingReference = null,
  referenceReturn = null,
  announcement = '',
  onModeChange,
  onReferenceTabActivate,
  onReferenceTabClose,
  onSendToMain,
  onRetryReference,
  onReferenceReturn,
  modes = WORKSPACE_MODES,
  headerVariant = 'tabs',
  headerAction,
  onHide,
  hideLabel = 'Hide References',
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
  const referenceReturnRef = useRef<HTMLButtonElement>(null);
  const restoreReferenceReturnFocus = useRef(false);
  const closeFocusIdentity = useRef<string | null>(null);
  const focusedModeTab = useRef<{
    mode: WorkspaceMode;
    element: HTMLButtonElement;
  } | null>(null);
  const dockActionFocused = useRef(false);
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
  const reserveReferenceTabRail = referenceTabOrientation === 'vertical'
    && pendingReference?.status === 'loading';
  const modeListKey = modes.join(':');
  const onDockActionFocus = () => { dockActionFocused.current = true; };
  const onDockActionBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (focusMovedToConnectedTarget(event)) dockActionFocused.current = false;
  };
  const dockAction: WorkspaceDockAction | undefined = mode === 'references'
    ? presentation === 'right' && onMoveReferencesBottom
      ? {
          destination: 'bottom',
          disabled: pendingReference?.status === 'loading',
          onClick: onMoveReferencesBottom,
          onFocus: onDockActionFocus,
          onBlur: onDockActionBlur,
        }
      : presentation === 'bottom' && headerVariant === 'references' && onMoveReferencesRight
        ? {
            destination: 'right',
            disabled: pendingReference?.status === 'loading',
            onClick: onMoveReferencesRight,
            onFocus: onDockActionFocus,
            onBlur: onDockActionBlur,
          }
        : undefined
    : undefined;
  const dockActionVisible = dockAction !== undefined;
  const quietSingleMode = presentation === 'bottom'
    && headerVariant === 'references'
    && modes.length === 1
    && modes[0] === 'references';

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
    if (dockActionVisible || !dockActionFocused.current) return;
    dockActionFocused.current = false;
    const timeout = setTimeout(() => {
      focusWithoutScroll(modeTabRefs.current.get(mode) ?? modeFallback(mode));
    }, 0);
    return () => clearTimeout(timeout);
  }, [dockActionVisible, mode]);

  useLayoutEffect(() => {
    const removedFocus = focusedModeTab.current;
    if (!open || removedFocus === null || removedFocus.element.isConnected) return;
    focusedModeTab.current = null;
    const frame = requestAnimationFrame(() => {
      focusWithoutScroll(modeTabRefs.current.get(mode) ?? modeFallback(mode));
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, modeListKey, open]);

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

  useLayoutEffect(() => {
    if (referenceReturn?.pending || !restoreReferenceReturnFocus.current) return;
    restoreReferenceReturnFocus.current = false;
    const tab = activeTabIdentity ? referenceTabRefs.current.get(activeTabIdentity) : null;
    const active = (referenceReturnRef.current ?? tab)?.ownerDocument.activeElement;
    if (
      active instanceof HTMLElement
      && active !== active.ownerDocument.body
      && active.isConnected
    ) return;
    focusWithoutScroll(
      referenceReturnRef.current
        ?? tab,
    );
  }, [activeTabIdentity, referenceReturn?.available, referenceReturn?.pending]);

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
  const showReferenceReturn = open
    && mode === 'references'
    && pendingReference === null
    && activeTab !== null
    && referenceReturn?.available === true
    && referenceReturn.tabIdentity === activeTab.identity
    && onReferenceReturn !== undefined;
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
      data-workspace-header-variant={headerVariant}
      data-annotation-presentation={presentation}
      data-workspace-open={open ? 'true' : 'false'}
      data-list-open={open ? 'true' : 'false'}
      data-authoring-takeover={authoringTakeover ? 'true' : undefined}
      aria-label={headerVariant === 'references' ? 'References' : 'Review workspace'}
      aria-hidden={!open}
      inert={!open || authoringTakeover}
    >
      {modes.length > 0 ? <header className="review-workspace__header">
        {onHide ? <ReviewTooltipButton
          label={hideLabel}
          type="button"
          className="review-workspace__close"
          aria-expanded="true"
          aria-controls="review-workspace"
          onClick={onHide}
        ><ReviewIcon name={presentation === 'bottom' ? 'chevron-down' : 'chevron-right'} /></ReviewTooltipButton> : null}
        <WorkspaceModeStrip
          modes={modes}
          selectedMode={mode}
          onModeChange={onModeChange}
          onModeKeyDown={moveModeFocus}
          onModeRef={(workspaceMode, element) => {
            if (element) modeTabRefs.current.set(workspaceMode, element);
            else modeTabRefs.current.delete(workspaceMode);
          }}
          onModeFocus={(workspaceMode, event) => {
            focusedModeTab.current = { mode: workspaceMode, element: event.currentTarget };
          }}
          onModeBlur={(_workspaceMode, event) => {
            if (focusMovedToConnectedTarget(event)) focusedModeTab.current = null;
          }}
          quietSingleMode={quietSingleMode}
          {...(dockAction ? { dockAction } : {})}
        />
        {headerAction}
      </header> : null}

      {modes.includes('references') ? <section
        ref={(element) => {
          if (element) panelRefs.current.set('references', element);
          else panelRefs.current.delete('references');
        }}
        id="workspace-panel-references"
        className="review-workspace__panel review-workspace__panel--references"
        data-reference-tabs-orientation={referenceTabOrientation}
        data-reference-panel-layout={showReferenceTabs || reserveReferenceTabRail ? 'split' : 'full'}
        role="tabpanel"
        aria-labelledby="workspace-mode-references"
        tabIndex={-1}
        hidden={mode !== 'references'}
        inert={mode !== 'references'}
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
              const pageLabel = tab.pageNumber ?? tab.pageContext.replace(/^Page\s+/u, '');
              const pageOnlyLabel = tab.label === tab.pageContext;
              const pageTextClass = showActions
                ? 'reference-tab-segment__page-placeholder'
                : 'reference-tab-segment__page-label';
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
                  data-reference-page-swap={showActions ? 'true' : undefined}
                  role="presentation"
                >
                  {showActions ? <small className="reference-tab-segment__page" aria-hidden="true">
                    {pageLabel}
                  </small> : null}
                  <ReviewTooltipButton
                    label={destinationLabel}
                    tooltip={`Show ${destinationLabel}`}
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
                    <span
                      className={pageOnlyLabel ? pageTextClass : undefined}
                      aria-hidden={pageOnlyLabel && showActions ? true : undefined}
                    >{pageOnlyLabel ? pageLabel : tab.label}</span>
                    {pageOnlyLabel ? null : <small
                      className={pageTextClass}
                      aria-hidden={showActions ? true : undefined}
                    >{pageLabel}</small>}
                  </ReviewTooltipButton>
                  {showActions && showReferenceReturn ? (
                    <ReferenceReturnButton
                      tabIdentity={tab.identity}
                      pending={referenceReturn.pending}
                      buttonRef={referenceReturnRef}
                      onReturn={(identity) => {
                        restoreReferenceReturnFocus.current = referenceReturnRef.current?.matches(':focus')
                          ?? false;
                        onReferenceReturn(identity);
                      }}
                    />
                  ) : null}
                  {showActions ? (
                    <ReviewTooltipButton
                      label="Open in main document"
                      type="button"
                      className="reference-tab-segment__action"
                      data-reference-tab-action="send"
                      data-workspace-focus-token={`reference-send:${tab.identity}`}
                      aria-label="Open in main document"
                      onClick={() => onSendToMain(tab.identity)}
                    >
                      <ReviewIcon name="open-main" />
                    </ReviewTooltipButton>
                  ) : null}
                  {showActions ? (
                    <ReviewTooltipButton
                      label="Close active reference"
                      type="button"
                      className="reference-tab-segment__action"
                      data-reference-tab-action="close"
                      data-workspace-focus-token={`reference-close:${tab.identity}`}
                      aria-label="Close active reference"
                      onClick={() => onReferenceTabClose(tab.identity)}
                    >
                      <ReviewIcon name="close" />
                    </ReviewTooltipButton>
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
                    title="Retry opening reference"
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
      </section> : null}

    </aside>
    <p className="sr-only review-workspace__status" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
    </>
  );
}
