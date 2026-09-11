import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { addHighlight, addInsert, addPageNote, addReplace, editReviewItem } from '../../../../packages/core/src/review-commands.js';
import type { ReviewCommand, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { ReviewShellAuthoringModel } from './authoring-model.js';
import {
  authoringAuthorityFor, authoringAuthorityMatches, authoringAnchorSnapshot,
  authoringPreviewAnnotations, authoringSessionIsCurrent, canStartAuthoringSession,
  createAuthoringSession, pendingDraftForAuthoring, mutableField, initialAuthoringValue,
  type AuthoringAuthority, type AuthoringOriginKind, type AuthoringSession,
  type AuthoringSource, type AuthoringWorkspaceSnapshot,
} from './authoring-session.js';

interface AuthoringOptions {
  state: ReviewState;
  authoring: ReviewShellAuthoringModel;
  documentGeneration: number;
  saveOptionsOpen: boolean | undefined;
  shellRef: RefObject<HTMLElement | null>;
  setAnnouncement(message: string): void;
  setActiveItem(id: string | undefined): void;
  consumeSelectionActions(generation: number): void;
  snapshotAuthoringWorkspace(): AuthoringWorkspaceSnapshot;
  prepareAuthoring(): void;
  clearInputDraft(): void;
  openNested(): void;
  closeNestedSurface(): void;
  restoreReaderAfterAuthoring(session: AuthoringSession, reason: 'accepted' | 'cancelled' | 'source-replaced', state?: ReviewState): boolean;
}

/** Owns frozen authoring authority, protected drafts, and the acknowledged command tail.
 * Workspace and reader callbacks run only when an interaction starts or settles.
 */
export function useAuthoringSession({
  state, authoring, documentGeneration, saveOptionsOpen, shellRef, setAnnouncement,
  setActiveItem, consumeSelectionActions, snapshotAuthoringWorkspace, prepareAuthoring,
  clearInputDraft, openNested, closeNestedSurface, restoreReaderAfterAuthoring,
}: AuthoringOptions) {
  const [authoringSession, setAuthoringSession] = useState<AuthoringSession | null>(null);
  const authoringSessionRef = useRef<AuthoringSession | null>(null);
  const authoringSessionTokenRef = useRef(0);
  const authoringEditorRef = useRef<HTMLTextAreaElement>(null);
  const saveOptionsWasOpenRef = useRef(saveOptionsOpen ?? false);
  const [authoringSurfaceElement, setAuthoringSurfaceElement] = useState<HTMLElement | null>(null);
  const authoringOwnerViewIdRef = useRef(crypto.randomUUID());
  const currentAuthoringAuthority = authoringAuthorityFor(
    state,
    documentGeneration,
  );
  const currentAuthoringAuthorityRef = useRef(currentAuthoringAuthority);
  currentAuthoringAuthorityRef.current = currentAuthoringAuthority;
  useEffect(() => {
    authoring.onAuthoringAnchorChange?.(
      authoringSession === null ? null : authoringAnchorSnapshot(authoringSession),
    );
  }, [authoringSession, authoring.onAuthoringAnchorChange]);
  useEffect(() => {
    authoring.onAuthoringPreviewChange?.(
      authoringSession === null
        ? null
        : authoringPreviewAnnotations(authoringSession, initialAuthoringValue(authoringSession)),
    );
    return () => authoring.onAuthoringPreviewChange?.(null);
  }, [authoringSession, authoring.onAuthoringPreviewChange]);
  useEffect(() => {
    const wasOpen = saveOptionsWasOpenRef.current;
    const isOpen = saveOptionsOpen ?? false;
    saveOptionsWasOpenRef.current = isOpen;
    if (!wasOpen || isOpen || authoringSessionRef.current === null) return;
    requestAnimationFrame(() => authoringEditorRef.current?.focus({ preventScroll: true }));
  }, [saveOptionsOpen]);
  useLayoutEffect(() => {
    if (authoringSurfaceElement === null) {
      authoring.onAuthoringViewportChange?.(null);
      return;
    }
    let frame = 0;
    const publish = () => {
      frame = 0;
      const rect = authoringSurfaceElement.getBoundingClientRect();
      authoring.onAuthoringViewportChange?.({
        occlusion: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
      });
    };
    const schedulePublish = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(publish);
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedulePublish);
    observer?.observe(authoringSurfaceElement);
    window.addEventListener('resize', schedulePublish);
    window.addEventListener('scroll', schedulePublish, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedulePublish);
      window.removeEventListener('scroll', schedulePublish, true);
      authoring.onAuthoringViewportChange?.(null);
    };
  }, [authoringSurfaceElement, authoring.onAuthoringViewportChange]);
  const acknowledgedRef = useRef(state);
  const commandTailRef = useRef<Promise<ReviewState>>(Promise.resolve(state));
  const acknowledgedAuthority = authoringAuthorityFor(
    acknowledgedRef.current,
    documentGeneration,
  );
  if (!authoringAuthorityMatches(acknowledgedAuthority, currentAuthoringAuthority)) {
    acknowledgedRef.current = state;
    commandTailRef.current = Promise.resolve(state);
  } else if (state.revision >= acknowledgedRef.current.revision) {
    acknowledgedRef.current = state;
  }

  const submit = (
    build: (state: ReviewState) => ReviewCommand,
    options?: {
      readonly authority?: AuthoringAuthority;
      readonly onAccepted?: () => void;
      readonly onStale?: () => void;
    },
  ): Promise<ReviewState> => {
    const result = commandTailRef.current.then(async () => {
      if (
        options?.authority !== undefined
        && !authoringAuthorityMatches(options.authority, currentAuthoringAuthorityRef.current)
      ) {
        setAnnouncement('This draft belonged to the previous document and was not applied.');
        options.onStale?.();
        return acknowledgedRef.current;
      }
      const command = build(acknowledgedRef.current);
      const result = await authoring.onCommand(command, options?.authority);
      if (
        options?.authority !== undefined
        && !authoringAuthorityMatches(options.authority, currentAuthoringAuthorityRef.current)
      ) {
        setAnnouncement('This draft belonged to the previous document and was not applied.');
        options.onStale?.();
        return acknowledgedRef.current;
      }
      const accepted = !('accepted' in result);
      const next = accepted ? result : result.state;
      acknowledgedRef.current = next;
      setAnnouncement(accepted ? `Review revision ${next.revision} saved.` : result.message);
      if (accepted) options?.onAccepted?.();
      return next;
    });
    commandTailRef.current = result.catch(() => acknowledgedRef.current);
    return result;
  };
  const beginAuthoring = (
    source: AuthoringSource,
    originKind: AuthoringOriginKind,
    trigger: HTMLElement | null,
  ): boolean => {
    if (!canStartAuthoringSession(authoringSessionRef.current)) return false;
    prepareAuthoring();
    clearInputDraft();
    const session = createAuthoringSession({
      token: ++authoringSessionTokenRef.current,
      authority: currentAuthoringAuthorityRef.current,
      source,
      origin: { kind: originKind, trigger },
      workspace: snapshotAuthoringWorkspace(),
    });
    authoringSessionRef.current = session;
    authoring.onAuthoringActiveChange?.(true);
    setAuthoringSession(session);
    openNested();
    if (state.workflow.mode === 'generated-output') {
      void protectAuthoringDraft(session, initialAuthoringValue(session));
    }
    return true;
  };

  const closeAuthoringSession = (
    token: number,
    reason: 'accepted' | 'cancelled' | 'source-replaced',
    acceptedState?: ReviewState,
  ) => {
    const current = authoringSessionRef.current;
    if (current === null || current.token !== token) return;
    authoringSessionRef.current = null;
    authoring.onAuthoringActiveChange?.(false);
    authoring.onAuthoringPreviewChange?.(null);
    setAuthoringSession(null);
    clearInputDraft();
    closeNestedSurface();
    if (current.source.kind === 'pageNote') authoring.onPageNoteComposerComplete?.();
    if (restoreReaderAfterAuthoring(current, reason, acceptedState)) return;
    if (reason === 'source-replaced') return;
    setActiveItem(current.workspace.activeItemId);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const shell = shellRef.current;
      if (shell === null) return;
      const viewport = shell.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
      if (viewport !== null) viewport.scrollTop = current.workspace.annotationScrollTop;
      const originTrigger = current.origin.trigger;
      const restoredItem = current.workspace.activeItemId === undefined
        ? null
        : [...shell.querySelectorAll<HTMLElement>('[data-review-item]')]
          .find((element) => element.dataset.reviewItem === current.workspace.activeItemId);
      const restoredPeek = current.workspace.activeItemId === undefined ? null
        : [...shell.querySelectorAll<HTMLElement>('[data-annotation-peek]')]
          .find((element) => element.dataset.annotationPeek === current.workspace.activeItemId);
      const target = originTrigger?.isConnected === true
        ? originTrigger
        : current.origin.kind === 'tray-edit'
          ? (restoredPeek ?? restoredItem)?.querySelector<HTMLElement>('[data-row-action="edit"]')
          : current.origin.kind === 'reader-edit'
            ? restoredItem?.querySelector<HTMLElement>('.annotation-item__navigation')
          : null;
      const workspaceFallback = current.workspace.open
        ? shell.querySelector<HTMLElement>(`#workspace-panel-${current.workspace.mode}`)
        : null;
      (target
        ?? workspaceFallback
        ?? shell.querySelector<HTMLElement>(
          '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
        ))?.focus({ preventScroll: true });
    }));
  };
  const dismissAuthoring = async (session: AuthoringSession) => {
    if (
      authoring.authoringAnchorNavigation?.token === session.token
      && authoring.authoringAnchorNavigation.pending
    ) await authoring.authoringAnchorNavigation.onCancelReturn?.();
    if (state.workflow.mode === 'generated-output') {
      await discardProtectedAuthoringDraft(session);
    }
    closeAuthoringSession(session.token, 'cancelled');
  };
  const closeNested = async () => {
    const current = authoringSessionRef.current;
    if (current !== null) await dismissAuthoring(current);
  };

  useLayoutEffect(() => {
    const current = authoringSessionRef.current;
    if (
      current === null
      || authoringSessionIsCurrent(current, currentAuthoringAuthority)
    ) return;
    if (
      authoring.authoringAnchorNavigation?.token === current.token
      && authoring.authoringAnchorNavigation.pending
    ) authoring.authoringAnchorNavigation.onCancelReturn?.();
    setAnnouncement('This draft belonged to the previous document and was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [currentAuthoringAuthority.documentGeneration, currentAuthoringAuthority.sourceIdentity]);

  useLayoutEffect(() => {
    const current = authoringSessionRef.current;
    if (current === null || current.source.kind !== 'edit') return;
    const editedItemId = current.source.item.id;
    if (state.items.some(({ id }) => id === editedItemId)) return;
    setAnnouncement('This annotation is no longer available and the edit was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [state.items]);

  useEffect(() => {
    const resolution = authoring.authoringSessionResolution;
    const current = authoringSessionRef.current;
    if (resolution === undefined || current === null) return;
    if (resolution.outcome === 'accepted') {
      if (current.source.kind === 'replace' || current.source.kind === 'highlight') {
        consumeSelectionActions(current.source.selectionGeneration);
      }
      closeAuthoringSession(current.token, 'accepted');
      return;
    }
    setAnnouncement('This draft belonged to the previous document and was not applied.');
    closeAuthoringSession(current.token, 'source-replaced');
  }, [authoring.authoringSessionResolution?.token]);
  const submitAuthoring = async (
    session: AuthoringSession,
    build: (state: ReviewState) => ReviewCommand,
    onAccepted?: () => void,
  ) => {
    let accepted = false;
    const next = await submit(build, {
      authority: session.authority,
      onAccepted: () => {
        accepted = true;
        onAccepted?.();
      },
      onStale: () => closeAuthoringSession(session.token, 'source-replaced'),
    });
    if (accepted) closeAuthoringSession(session.token, 'accepted', next);
  };

  const protectAuthoringDraft = (
    session: AuthoringSession,
    value: string,
  ): Promise<ReviewState> => submit((state) => {
    const existing = state.pendingDrafts.find(({ id }) => id === session.draftId);
    const updatedAt = new Date().toISOString();
    return {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: existing?.revision ?? -1,
      draft: pendingDraftForAuthoring({
        session,
        ownerViewId: authoringOwnerViewIdRef.current,
        text: value,
        revision: existing?.revision ?? 0,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      }),
    };
  }, {
    authority: session.authority,
    onStale: () => closeAuthoringSession(session.token, 'source-replaced'),
  });

  const discardProtectedAuthoringDraft = async (session: AuthoringSession): Promise<void> => {
    await commandTailRef.current;
    const existing = acknowledgedRef.current.pendingDrafts.find(({ id }) => id === session.draftId);
    if (existing === undefined) return;
    await submit((state) => {
      const current = state.pendingDrafts.find(({ id }) => id === session.draftId);
      if (current === undefined) throw new Error('The protected authoring draft is unavailable.');
      return {
        type: 'discard-reconciliation',
        expectedRevision: state.revision,
        target: 'draft',
        id: current.id,
        expectedTargetRevision: current.revision,
        ownerViewId: current.ownerViewId,
        reason: 'cancelled-by-author-before-apply',
        discardedAt: new Date().toISOString(),
      };
    }, { authority: session.authority });
  };

  const applyProtectedAuthoring = async (
    session: AuthoringSession,
    value: string,
    onAccepted?: () => void,
  ) => {
    await protectAuthoringDraft(session, value);
    await submitAuthoring(session, (state) => {
      const draft = state.pendingDrafts.find(({ id }) => id === session.draftId);
      if (draft === undefined) throw new Error('The protected authoring draft is unavailable.');
      return {
        type: 'apply-draft',
        expectedRevision: state.revision,
        id: draft.id,
        expectedDraftRevision: draft.revision,
        ownerViewId: draft.ownerViewId,
        updatedAt: new Date().toISOString(),
      };
    }, onAccepted);
  };

  const saveAuthoring = async (session: AuthoringSession, value: string) => {
    const source = session.source;
    if (state.workflow.mode === 'generated-output') {
      await applyProtectedAuthoring(
        session,
        value,
        source.kind === 'replace' || source.kind === 'highlight'
          ? () => consumeSelectionActions(source.selectionGeneration)
          : undefined,
      );
      return;
    }
    if (source.kind === 'replace') {
      await submitAuthoring(
        session,
        (state) => addReplace(state, source.anchor, value),
        () => consumeSelectionActions(source.selectionGeneration),
      );
      return;
    }
    if (source.kind === 'insert') {
      await submitAuthoring(session, (state) => addInsert(state, source.anchor, value));
      return;
    }
    if (source.kind === 'highlight') {
      await submitAuthoring(
        session,
        (state) => addHighlight(state, source.anchor, value),
        () => consumeSelectionActions(source.selectionGeneration),
      );
      return;
    }
    if (source.kind === 'pageNote') {
      await submitAuthoring(session, (state) => addPageNote(
        state,
        source.pageIndex,
        source.position,
        value,
        undefined,
        source.nearbyText,
      ));
      return;
    }
    const field = mutableField(source.item);
    if (field === undefined) return;
    await submitAuthoring(
      session,
      (state) => editReviewItem(state, source.item.id, { [field]: value }),
    );
  };

  return {
    authoringSession,
    authoringSessionRef,
    authoringEditorRef,
    authoringSurfaceElement,
    setAuthoringSurfaceElement,
    currentAuthoringAuthority,
    currentAuthoringAuthorityRef,
    submit,
    beginAuthoring,
    dismissAuthoring,
    closeNested,
    protectAuthoringDraft,
    saveAuthoring,
  };
}
