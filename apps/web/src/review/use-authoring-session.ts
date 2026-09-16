import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { addHighlight, addInsert, addPageNote, addReplace, editReviewItem } from '../../../../packages/core/src/review-commands.js';
import type { ReviewCommand, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { ReviewShellAuthoringModel } from './authoring-model.js';
import {
  authoringAuthorityFor, authoringAuthorityMatches, authoringAnchorSnapshot,
  authoringPreviewAnnotations, authoringSessionIsCurrent, canStartAuthoringSession,
  beginReviewInteraction, createAuthoringSession, pendingDraftForAuthoring, mutableField, initialAuthoringValue,
  type AuthoringAuthority, type AuthoringOriginKind, type AuthoringSession,
  type AuthoringSource, type AuthoringWorkspaceSnapshot,
  type ReviewInteractionHandle, type ReviewInteractionReceipt,
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

interface PendingAcknowledgement {
  readonly interaction: ReviewInteractionHandle;
  readonly receipt: ReviewInteractionReceipt;
}

/** Retains every exact durable receipt until its own acknowledgement succeeds. */
export class AuthoringAcknowledgementQueue {
  readonly #pending = new Map<string, PendingAcknowledgement>();
  #drainTail: Promise<void> = Promise.resolve();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAttempt = 0;
  #disposed = false;

  enqueue(interaction: ReviewInteractionHandle, receipt: ReviewInteractionReceipt): void {
    this.#pending.set(receipt.interactionToken, { interaction, receipt });
  }

  has(interactionToken: string): boolean {
    return this.#pending.has(interactionToken);
  }

  drain(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const pass = this.#drainTail.then(async () => {
      if (this.#disposed) return;
      for (const [interactionToken, pending] of [...this.#pending]) {
        try {
          await pending.interaction.acknowledge(pending.receipt);
          if (this.#pending.get(interactionToken) === pending) {
            this.#pending.delete(interactionToken);
          }
        } catch {
          // The durable receipt remains authoritative and is retried after reconnect.
        }
      }
      if (this.#pending.size === 0) {
        this.#retryAttempt = 0;
        if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
        return;
      }
      if (this.#retryTimer !== null) return;
      const retryDelays = [100, 500, 2_000, 5_000] as const;
      const delay = retryDelays[Math.min(this.#retryAttempt, retryDelays.length - 1)]!;
      this.#retryAttempt += 1;
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        void this.drain();
      }, delay);
    });
    this.#drainTail = pass.catch(() => undefined);
    return pass;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }
}

/** A deleted edit may leave the UI only after its hold is released or durably queued for release. */
export async function releaseDeletedAuthoringInteraction(
  interaction: ReviewInteractionHandle | undefined,
  settle: () => void,
): Promise<void> {
  try {
    await interaction?.release();
  } catch {
    // The ordered transport retains the exact failed release for its next lifecycle request.
  } finally {
    settle();
  }
}

export async function finalizeReacquiredInteraction(
  interaction: ReviewInteractionHandle,
  outcome: 'applied' | 'discarded',
  draftId: string,
  expectedDraftRevision: number,
): Promise<ReviewInteractionReceipt> {
  const recovered = await interaction.reacquire();
  if (recovered !== undefined && recovered.outcome !== outcome) {
    throw new Error('The recovered annotation receipt does not match the pending completion.');
  }
  return recovered ?? interaction.finalize(outcome, draftId, expectedDraftRevision);
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
  const authoringValueRef = useRef<{ readonly token: number; value: string } | null>(null);
  const authoringEditorRef = useRef<HTMLTextAreaElement>(null);
  const saveOptionsWasOpenRef = useRef(saveOptionsOpen ?? false);
  const [authoringSurfaceElement, setAuthoringSurfaceElement] = useState<HTMLElement | null>(null);
  const legacyAuthoringOwnerViewIdRef = useRef(crypto.randomUUID());
  const authoringAdmissionPendingRef = useRef(false);
  const focusRestoreTokenRef = useRef(0);
  const pendingFinalizationRef = useRef<{
    readonly session: AuthoringSession;
    readonly value: string;
    readonly onAccepted?: () => void;
  } | null>(null);
  const pendingAcknowledgementsRef = useRef(new AuthoringAcknowledgementQueue());
  const terminalAttemptRef = useRef<{
    readonly session: AuthoringSession;
    readonly outcome: 'applied' | 'discarded';
    readonly draftId: string;
    readonly expectedDraftRevision: number;
    readonly onAccepted?: () => void;
  } | null>(null);
  const mountedRef = useRef(true);
  const currentAuthoringAuthority = authoringAuthorityFor(
    state,
    documentGeneration,
  );
  const currentAuthoringAuthorityRef = useRef(currentAuthoringAuthority);
  currentAuthoringAuthorityRef.current = currentAuthoringAuthority;
  const retryPendingAcknowledgements = () => pendingAcknowledgementsRef.current.drain();
  useEffect(() => {
    void retryPendingAcknowledgements();
  }, [authoring.interactionLifecycle, currentAuthoringAuthority.documentGeneration]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingAcknowledgementsRef.current.dispose();
      const current = authoringSessionRef.current;
      const terminal = terminalAttemptRef.current;
      if (current?.interaction === undefined) return;
      if (terminal === null || terminal.session.token !== current.token) {
        void current.interaction.release().catch(() => undefined);
        return;
      }
      void current.interaction.finalize(
        terminal.outcome,
        terminal.draftId,
        terminal.expectedDraftRevision,
      ).then((receipt) => current.interaction?.acknowledge(receipt)).catch(() => undefined);
    };
  }, []);
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
  const beginAuthoring = async (
    source: AuthoringSource,
    originKind: AuthoringOriginKind,
    trigger: HTMLElement | null,
  ): Promise<boolean> => {
    if (authoringAdmissionPendingRef.current || !canStartAuthoringSession(authoringSessionRef.current)) return false;
    authoringAdmissionPendingRef.current = true;
    const token = ++authoringSessionTokenRef.current;
    const authority = currentAuthoringAuthorityRef.current;
    let interaction;
    try {
      if (authoring.interactionLifecycleRequired && authoring.interactionLifecycle === undefined) {
        throw new Error('The annotation safety connection is still starting. Try again.');
      }
      if (authoring.interactionLifecycle !== undefined) {
        interaction = await beginReviewInteraction(
          authoring.interactionLifecycle,
          authority.documentGeneration,
          `authoring_${crypto.randomUUID()}`,
        );
        void retryPendingAcknowledgements();
      }
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : 'The annotation editor could not start safely.');
      authoringAdmissionPendingRef.current = false;
      return false;
    }
    if (!mountedRef.current) {
      await interaction?.release().catch(() => undefined);
      authoringAdmissionPendingRef.current = false;
      return false;
    }
    if (!authoringAuthorityMatches(authority, currentAuthoringAuthorityRef.current)) {
      await interaction?.release().catch(() => undefined);
      authoringAdmissionPendingRef.current = false;
      setAnnouncement('The PDF changed before the annotation editor could open.');
      return false;
    }
    prepareAuthoring();
    clearInputDraft();
    const session = createAuthoringSession({
      token,
      authority,
      source,
      origin: { kind: originKind, trigger },
      workspace: snapshotAuthoringWorkspace(),
      ...(interaction === undefined ? {} : { interaction }),
    });
    authoringValueRef.current = { token: session.token, value: initialAuthoringValue(session) };
    authoringSessionRef.current = session;
    authoringAdmissionPendingRef.current = false;
    authoring.onAuthoringActiveChange?.(true);
    setAuthoringSession(session);
    openNested();
    if (state.workflow.mode === 'generated-output' || interaction !== undefined) {
      void protectAuthoringDraft(session, initialAuthoringValue(session)).catch((error: unknown) => {
        setAnnouncement(error instanceof Error ? error.message : 'The protected draft could not be saved.');
      });
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
    focusRestoreTokenRef.current += 1;
    const focusRestoreToken = focusRestoreTokenRef.current;
    pendingFinalizationRef.current = null;
    authoringSessionRef.current = null;
    authoringValueRef.current = null;
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
      if (focusRestoreTokenRef.current !== focusRestoreToken) return;
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
    if (session.interaction !== undefined) {
      try {
        await finalizeProtectedAuthoring(session, 'discarded');
      } catch (error) {
        setAnnouncement(error instanceof Error ? error.message : 'The annotation cancellation was not saved.');
      }
      return;
    }
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
    if (terminalAttemptRef.current?.session.token === current.token) return;
    if (
      authoring.authoringAnchorNavigation?.token === current.token
      && authoring.authoringAnchorNavigation.pending
    ) authoring.authoringAnchorNavigation.onCancelReturn?.();
    setAnnouncement('This draft belonged to the previous document and was not applied.');
    void current.interaction?.release().catch(() => undefined);
    closeAuthoringSession(current.token, 'source-replaced');
  }, [currentAuthoringAuthority.documentGeneration, currentAuthoringAuthority.sourceIdentity]);

  useLayoutEffect(() => {
    const current = authoringSessionRef.current;
    if (current === null || current.source.kind !== 'edit') return;
    const editedItemId = current.source.item.id;
    if (state.items.some(({ id }) => id === editedItemId)) return;
    if (terminalAttemptRef.current?.session.token === current.token) return;
    setAnnouncement('This annotation is no longer available and the edit was not applied.');
    void releaseDeletedAuthoringInteraction(current.interaction, () => {
      closeAuthoringSession(current.token, 'source-replaced');
    });
  }, [state.items]);

  useEffect(() => {
    const resolution = authoring.authoringSessionResolution;
    const current = authoringSessionRef.current;
    if (resolution === undefined || current === null) return;
    if (current.interaction !== undefined) return;
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
  ): Promise<ReviewState> => {
    if (authoringValueRef.current?.token === session.token) authoringValueRef.current.value = value;
    return submit((state) => {
    const existing = state.pendingDrafts.find(({ id }) => id === session.draftId);
    const updatedAt = new Date().toISOString();
    return {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: existing?.revision ?? -1,
      draft: pendingDraftForAuthoring({
        session,
        ownerViewId: session.interaction?.ownerViewId ?? legacyAuthoringOwnerViewIdRef.current,
        text: value,
        revision: existing?.revision ?? 0,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
      }),
    };
    }, {
      authority: session.authority,
      onStale: () => closeAuthoringSession(session.token, 'source-replaced'),
    }).then((next) => {
      if (!next.pendingDrafts.some(({ id }) => id === session.draftId)) {
        throw new Error('The protected authoring draft was not acknowledged.');
      }
      return next;
    });
  };

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

  const finalizeProtectedAuthoring = async (
    session: AuthoringSession,
    outcome: 'applied' | 'discarded',
    onAccepted?: () => void,
  ): Promise<void> => {
    const interaction = session.interaction;
    if (interaction === undefined) throw new Error('The annotation interaction is unavailable.');
    let terminal = terminalAttemptRef.current;
    if (terminal === null) {
      await commandTailRef.current;
      const draft = acknowledgedRef.current.pendingDrafts.find(({ id }) => id === session.draftId);
      if (draft === undefined) throw new Error('The protected authoring draft is unavailable.');
      terminal = {
        session,
        outcome,
        draftId: draft.id,
        expectedDraftRevision: draft.revision,
        ...(onAccepted === undefined ? {} : { onAccepted }),
      };
      terminalAttemptRef.current = terminal;
    } else if (terminal.session.token !== session.token) {
      throw new Error('Another annotation completion is still pending.');
    }
    const receipt = await finalizeReacquiredInteraction(
      interaction,
      terminal.outcome,
      terminal.draftId,
      terminal.expectedDraftRevision,
    );
    await settleFinalizedInteraction(session, interaction, receipt, terminal.outcome, terminal.onAccepted);
  };

  async function settleFinalizedInteraction(
    session: AuthoringSession,
    interaction: ReviewInteractionHandle,
    receipt: ReviewInteractionReceipt,
    outcome: 'applied' | 'discarded',
    onAccepted?: () => void,
  ): Promise<void> {
    if (outcome === 'applied') onAccepted?.();
    if (terminalAttemptRef.current?.session.token === session.token) terminalAttemptRef.current = null;
    closeAuthoringSession(session.token, outcome === 'applied' ? 'accepted' : 'cancelled');
    pendingAcknowledgementsRef.current.enqueue(interaction, receipt);
    await retryPendingAcknowledgements();
    if (pendingAcknowledgementsRef.current.has(receipt.interactionToken)) {
      setAnnouncement('The annotation was saved, but its completion receipt will be retried after reconnect.');
    }
  }

  useEffect(() => authoring.subscribeInteractionReconnect?.(async ({ generation }) => {
    const current = authoringSessionRef.current;
    if (current?.interaction === undefined) return;
    const closeAfterRelease = () => closeAuthoringSession(current.token, 'source-replaced');
    if (current.authority.documentGeneration !== generation) {
      setAnnouncement('The PDF changed while the annotation connection was recovering. The protected draft was not applied.');
      await releaseDeletedAuthoringInteraction(current.interaction, closeAfterRelease);
      return;
    }
    try {
      const recovered = await current.interaction.reacquire();
      if (authoringSessionRef.current?.token !== current.token || recovered === undefined) return;
      const terminal = terminalAttemptRef.current;
      if (terminal !== null && terminal.session.token === current.token) {
        if (recovered.outcome !== terminal.outcome) {
          throw new Error('The recovered annotation receipt does not match the pending completion.');
        }
        await settleFinalizedInteraction(
          current,
          current.interaction,
          recovered,
          terminal.outcome,
          terminal.onAccepted,
        );
        return;
      }
      await settleFinalizedInteraction(
        current,
        current.interaction,
        recovered,
        recovered.outcome,
      );
    } catch (error) {
      if (authoringSessionRef.current?.token !== current.token) return;
      setAnnouncement(error instanceof Error
        ? error.message
        : 'The annotation connection could not be restored safely.');
      await releaseDeletedAuthoringInteraction(current.interaction, closeAfterRelease);
    }
  }), [authoring.subscribeInteractionReconnect]);

  const saveAuthoring = async (session: AuthoringSession, value: string) => {
    const source = session.source;
    if (session.interaction !== undefined) {
      try {
        if (terminalAttemptRef.current?.session.token === session.token) {
          await finalizeProtectedAuthoring(session, terminalAttemptRef.current.outcome);
          return;
        }
        await protectAuthoringDraft(session, value);
        if (authoring.interactionFinalizationReady === false) {
          pendingFinalizationRef.current = {
            session,
            value,
            ...(source.kind === 'replace' || source.kind === 'highlight'
              ? { onAccepted: () => consumeSelectionActions(source.selectionGeneration) }
              : {}),
          };
          authoring.onInteractionFinalizationPrerequisite?.();
          return;
        }
        await finalizeProtectedAuthoring(
          session,
          'applied',
          source.kind === 'replace' || source.kind === 'highlight'
            ? () => consumeSelectionActions(source.selectionGeneration)
            : undefined,
        );
      } catch (error) {
        setAnnouncement(error instanceof Error ? error.message : 'The annotation could not be saved.');
      }
      return;
    }
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

  useEffect(() => {
    const pending = pendingFinalizationRef.current;
    if (authoring.interactionFinalizationReady !== true || pending === null) return;
    pendingFinalizationRef.current = null;
    void finalizeProtectedAuthoring(pending.session, 'applied', pending.onAccepted).catch((error: unknown) => {
      pendingFinalizationRef.current = pending;
      setAnnouncement(error instanceof Error ? error.message : 'The annotation could not be saved.');
    });
  }, [authoring.interactionFinalizationReady]);

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
    currentAuthoringValue: (session: AuthoringSession) => authoringValueRef.current?.token === session.token
      ? authoringValueRef.current.value
      : initialAuthoringValue(session),
    saveAuthoring,
  };
}
