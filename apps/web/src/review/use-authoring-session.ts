import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { addHighlight, addInsert, addPageNote, addReplace, editReviewItem } from '../../../../packages/core/src/review-commands.js';
import type { ReviewCommand, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { ReviewShellAuthoringModel } from './authoring-model.js';
import type { RejectedReviewCommand } from './review-command-result.js';
import { isVisibleFocusTarget } from './focus-target.js';
import {
  authoringAuthorityFor, authoringAuthorityMatches, authoringAnchorSnapshot,
  authoringPreviewAnnotations, authoringSessionIsCurrent, canStartAuthoringSession,
  beginReviewInteraction, createAuthoringSession, pendingDraftForAuthoring, mutableField, initialAuthoringValue,
  type AuthoringAuthority, type AuthoringOriginKind, type AuthoringSession,
  type AuthoringOrigin, type AuthoringSource, type AuthoringWorkspaceSnapshot,
  type ReviewInteractionHandle, type ReviewInteractionReceipt,
} from './authoring-session.js';

function cssAttributeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

export function referenceAnnotationTargetSelector(tabIdentity: string, reviewId: string): string {
  return `[data-annotation-surface="reference"][data-reference-tab-identity="${cssAttributeValue(tabIdentity)}"] ${ownedAnnotationFragmentSelector(reviewId)}`;
}

/** Selects visible geometry for both projected owned marks and owned native PDF fragments. */
export function ownedAnnotationFragmentSelector(reviewId: string): string {
  return `:is([data-owned-mark], [data-source-reader-mark], [data-owned-native-geometry])[data-review-id="${cssAttributeValue(reviewId)}"]`;
}

export function referenceAnnotationScrollportSelector(tabIdentity: string): string {
  return `[data-reference-pdf-viewport][data-reference-tab-identity="${cssAttributeValue(tabIdentity)}"] [data-viewer-framing-viewport]`;
}

export type AuthoringSessionInvalidReason = 'document' | 'edit-target';

export function authoringSessionInvalidReason(
  session: AuthoringSession,
  currentAuthority: AuthoringAuthority,
  items: readonly ReviewState['items'][number][],
): AuthoringSessionInvalidReason | null {
  if (!authoringSessionIsCurrent(session, currentAuthority)) return 'document';
  if (session.source.kind === 'edit') {
    const editedItemId = session.source.item.id;
    if (!items.some(({ id }) => id === editedItemId)) return 'edit-target';
  }
  return null;
}

export function authoringCommandDisposition(
  result: ReviewState | RejectedReviewCommand,
): 'accepted' | 'rejected' | 'persistence-pending' {
  if (!('accepted' in result)) return 'accepted';
  return result.reason === 'persistence-pending' ? 'persistence-pending' : 'rejected';
}

export interface AuthoringPendingPersistence {
  readonly token: number;
  readonly revision: number;
}

export function authoringPersistencePendingFor(
  session: AuthoringSession,
  pending: AuthoringPendingPersistence | null,
): boolean {
  return pending?.token === session.token;
}

export function authoringPersistenceCanClose(input: {
  readonly session: AuthoringSession;
  readonly pending: AuthoringPendingPersistence | null;
  readonly currentAuthority: AuthoringAuthority;
  readonly items: readonly ReviewState['items'][number][];
  readonly forcedInvalidToken: number | null;
  readonly persistedRevision: number | undefined;
}): boolean {
  const pending = input.pending;
  return pending !== null
    && authoringPersistencePendingFor(input.session, pending)
    && input.forcedInvalidToken !== input.session.token
    && authoringSessionInvalidReason(input.session, input.currentAuthority, input.items) === null
    && input.persistedRevision !== undefined
    && input.persistedRevision >= pending.revision;
}

/** Returns the response token only while it still owns the mounted editor. */
export function staleAuthoringSessionToken(
  current: AuthoringSession | null,
  responseToken: number,
): number | null {
  return current?.token === responseToken ? responseToken : null;
}

export function authoringSaveDisposition(input: {
  readonly terminalRetryPending: boolean;
  readonly invalidReason: AuthoringSessionInvalidReason | null;
  readonly persistencePending: boolean;
}): 'retry-terminal' | 'blocked' | 'submit' {
  if (input.terminalRetryPending) return 'retry-terminal';
  if (input.invalidReason !== null || input.persistencePending) return 'blocked';
  return 'submit';
}

export function interactionReceiptRequiresPersistence(input: {
  readonly outcome: 'applied' | 'discarded';
  readonly persistenceRequired: boolean;
}): boolean {
  return input.outcome === 'applied' && input.persistenceRequired;
}

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

interface PendingCanonicalFinalization {
  readonly session: AuthoringSession;
  readonly receipt: ReviewInteractionReceipt;
  readonly outcome: 'applied' | 'discarded';
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PendingReaderRestoration {
  readonly token: number;
  readonly session: AuthoringSession;
}

const canonicalFinalizationPendingNoticeMs = 5_000;

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

/** A finalization receipt may paint from its exact revision or authoritative session successor. */
export function canonicalStateForFinalizedInteraction(
  state: ReviewState,
  documentGeneration: number,
  receipt: ReviewInteractionReceipt,
  authority: AuthoringAuthority,
): ReviewState | undefined {
  if (state.sessionId !== authority.sessionId) return undefined;
  const canonicalGeneration = state.workflow.documentGeneration;
  // The finalized receipt authorizes an already-published successor even when
  // the viewer-generation observer has not caught up with canonical state yet.
  if (canonicalGeneration > receipt.generation) return state;
  if (
    canonicalGeneration !== receipt.generation
    || documentGeneration !== receipt.generation
    || state.revision < receipt.reviewRevision
  ) {
    return undefined;
  }
  return authoringAuthorityFor(state, documentGeneration).sourceIdentity === authority.sourceIdentity
    ? state
    : undefined;
}

export function consumeFinalizedInteractionState(input: {
  readonly state: ReviewState;
  readonly documentGeneration: number;
  readonly receipt: ReviewInteractionReceipt;
  readonly authority: AuthoringAuthority;
  readonly outcome: 'applied' | 'discarded';
  readonly announce: (message: string) => void;
  readonly close: (reason: 'accepted' | 'cancelled' | 'source-replaced', state?: ReviewState) => void;
}): boolean {
  const canonical = canonicalStateForFinalizedInteraction(
    input.state,
    input.documentGeneration,
    input.receipt,
    input.authority,
  );
  if (canonical !== undefined) {
    input.close(input.outcome === 'applied' ? 'accepted' : 'cancelled', canonical);
    return true;
  }
  if (input.state.sessionId !== input.authority.sessionId) {
    input.announce(input.outcome === 'applied'
      ? 'The annotation was saved before the document changed.'
      : 'The cancellation was saved before the document changed.');
    input.close('source-replaced');
    return true;
  }
  return false;
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
  const [forcedInvalidToken, setForcedInvalidToken] = useState<number | null>(null);
  const [pendingPersistence, setPendingPersistence] = useState<AuthoringPendingPersistence | null>(null);
  const pendingPersistenceRef = useRef<AuthoringPendingPersistence | null>(null);
  const [authoringTerminalPending, setAuthoringTerminalPending] = useState<{
    readonly token: number;
    readonly delayed: boolean;
  } | null>(null);
  const authoringSessionRef = useRef<AuthoringSession | null>(null);
  const authoringSessionTokenRef = useRef(0);
  const authoringValueRef = useRef<{ readonly token: number; value: string } | null>(null);
  const authoringEditorRef = useRef<HTMLTextAreaElement>(null);
  const saveOptionsWasOpenRef = useRef(saveOptionsOpen ?? false);
  const [authoringSurfaceElement, setAuthoringSurfaceElement] = useState<HTMLElement | null>(null);
  const legacyAuthoringOwnerViewIdRef = useRef(crypto.randomUUID());
  const authoringAdmissionPendingRef = useRef(false);
  const focusRestoreTokenRef = useRef(0);
  const pendingReaderRestorationRef = useRef<PendingReaderRestoration | null>(null);
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
  const pendingCanonicalFinalizationRef = useRef<PendingCanonicalFinalization | null>(null);
  const mountedRef = useRef(true);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const currentAuthoringAuthority = authoringAuthorityFor(
    state,
    documentGeneration,
  );
  const currentAuthoringAuthorityRef = useRef(currentAuthoringAuthority);
  currentAuthoringAuthorityRef.current = currentAuthoringAuthority;
  const authoringInvalidReason: AuthoringSessionInvalidReason | null = authoringSession === null
    ? null
    : forcedInvalidToken === authoringSession.token
      ? 'document'
      : authoringSessionInvalidReason(authoringSession, currentAuthoringAuthority, state.items);
  const retryPendingAcknowledgements = () => pendingAcknowledgementsRef.current.drain();
  useEffect(() => {
    void retryPendingAcknowledgements();
  }, [authoring.interactionLifecycle, currentAuthoringAuthority.documentGeneration]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingAcknowledgementsRef.current.dispose();
      const pendingCanonical = pendingCanonicalFinalizationRef.current;
      if (pendingCanonical !== null) {
        clearTimeout(pendingCanonical.timeout);
        pendingCanonical.resolve();
        pendingCanonicalFinalizationRef.current = null;
      }
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
      authoringSession === null || authoringInvalidReason !== null
        ? null
        : authoringPreviewAnnotations(authoringSession, initialAuthoringValue(authoringSession)),
    );
    return () => authoring.onAuthoringPreviewChange?.(null);
  }, [authoringSession, authoringInvalidReason, authoring.onAuthoringPreviewChange]);
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
      readonly onPersistencePending?: (revision: number) => void;
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
      const disposition = authoringCommandDisposition(result);
      const accepted = disposition === 'accepted';
      const next = accepted ? result as ReviewState : (result as RejectedReviewCommand).state;
      acknowledgedRef.current = next;
      setAnnouncement(accepted
        ? `Review revision ${next.revision} saved.`
        : disposition === 'persistence-pending'
          ? 'The annotation is waiting to be saved to the PDF.'
          : (result as RejectedReviewCommand).message);
      if (accepted) options?.onAccepted?.();
      if (disposition === 'persistence-pending') options?.onPersistencePending?.(next.revision);
      return next;
    });
    commandTailRef.current = result.catch(() => acknowledgedRef.current);
    return result;
  };
  const beginAuthoring = async (
    source: AuthoringSource,
    originKind: AuthoringOriginKind,
    trigger: HTMLElement | null,
    originContext?: Pick<AuthoringOrigin, 'surface' | 'referenceRecovery'>,
  ): Promise<boolean> => {
    if (authoringAdmissionPendingRef.current || !canStartAuthoringSession(authoringSessionRef.current)) return false;
    authoringAdmissionPendingRef.current = true;
    const token = ++authoringSessionTokenRef.current;
    const authority = currentAuthoringAuthorityRef.current;
    // Freeze the durable draft identity before admission so every reconnect
    // replays the same exact authoring presence binding.
    const draftId = crypto.randomUUID();
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
          1,
          draftId,
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
      draftId,
      authority,
      source,
      origin: {
        kind: originKind,
        trigger,
        ...(originContext?.surface === undefined ? {} : { surface: originContext.surface }),
        ...(originContext?.referenceRecovery === undefined
          ? {}
          : { referenceRecovery: originContext.referenceRecovery }),
      },
      workspace: snapshotAuthoringWorkspace(),
      ...(interaction === undefined ? {} : { interaction }),
    });
    authoringValueRef.current = { token: session.token, value: initialAuthoringValue(session) };
    authoringSessionRef.current = session;
    setForcedInvalidToken(null);
    pendingPersistenceRef.current = null;
    setPendingPersistence(null);
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
    const pendingCanonical = pendingCanonicalFinalizationRef.current;
    if (pendingCanonical?.session.token === token) {
      clearTimeout(pendingCanonical.timeout);
      pendingCanonical.resolve();
      pendingCanonicalFinalizationRef.current = null;
    }
    setAuthoringTerminalPending((pending) => pending?.token === token ? null : pending);
    focusRestoreTokenRef.current += 1;
    const focusRestoreToken = focusRestoreTokenRef.current;
    pendingReaderRestorationRef.current = null;
    pendingFinalizationRef.current = null;
    authoringSessionRef.current = null;
    setForcedInvalidToken(null);
    pendingPersistenceRef.current = null;
    setPendingPersistence(null);
    authoringValueRef.current = null;
    authoring.onAuthoringActiveChange?.(false);
    authoring.onAuthoringPreviewChange?.(null);
    setAuthoringSession(null);
    clearInputDraft();
    closeNestedSurface();
    if (current.source.kind === 'pageNote') authoring.onPageNoteComposerComplete?.();
    if (restoreReaderAfterAuthoring(current, reason, acceptedState)) return;
    if (reason === 'source-replaced') return;
    if (current.origin.surface?.kind === 'reference') {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (
          focusRestoreTokenRef.current !== focusRestoreToken
          || authoringSessionRef.current !== null
        ) return;
        const shell = shellRef.current;
        if (shell === null) return;
        const origin = isVisibleFocusTarget(current.origin.trigger) ? current.origin.trigger : null;
        const currentReference = shell.querySelector<HTMLElement>(
          '[data-reference-tab][aria-selected="true"], [data-reference-pdf-viewport] [data-page-index]',
        );
        const currentControl = shell.querySelector<HTMLElement>(
          '.review-workspace:not([aria-hidden="true"]) [role="tab"][aria-selected="true"], [role="application"]',
        );
        (origin ?? currentReference ?? currentControl)?.focus({ preventScroll: true });
      }));
      return;
    }
    setActiveItem(current.workspace.activeItemId);
    pendingReaderRestorationRef.current = { token: focusRestoreToken, session: current };
  };
  const settleCanonicalAuthoring = (
    session: AuthoringSession,
    receipt: ReviewInteractionReceipt,
    outcome: 'applied' | 'discarded',
    canonical: ReviewState,
  ) => {
    if (interactionReceiptRequiresPersistence({
      outcome,
      persistenceRequired: authoring.interactionPersistenceRequired === true,
    })) {
      const pendingCanonical = pendingCanonicalFinalizationRef.current;
      if (pendingCanonical?.session.token === session.token) {
        clearTimeout(pendingCanonical.timeout);
        pendingCanonical.resolve();
        pendingCanonicalFinalizationRef.current = null;
      }
      setAuthoringTerminalPending((pending) => pending?.token === session.token ? null : pending);
      if (canonical.revision >= acknowledgedRef.current.revision) acknowledgedRef.current = canonical;
      const pendingPersistence = { token: session.token, revision: receipt.reviewRevision };
      pendingPersistenceRef.current = pendingPersistence;
      setPendingPersistence(pendingPersistence);
      return;
    }
    closeAuthoringSession(
      session.token,
      outcome === 'applied' ? 'accepted' : 'cancelled',
      canonical,
    );
  };
  const invalidateAuthoringSession = (token: number) => {
    const invalidToken = staleAuthoringSessionToken(authoringSessionRef.current, token);
    if (invalidToken === null) return;
    setForcedInvalidToken(invalidToken);
    setAnnouncement('This draft belongs to the previous document. Copy your draft or cancel it.');
  };

  useLayoutEffect(() => {
    const pending = pendingReaderRestorationRef.current;
    if (
      pending === null
      || pending.token !== focusRestoreTokenRef.current
      || authoringSessionRef.current !== null
    ) return;
    pendingReaderRestorationRef.current = null;
    const shell = shellRef.current;
    if (shell === null) return;
    const { session } = pending;
    const viewport = shell.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
    if (viewport !== null) viewport.scrollTop = session.workspace.annotationScrollTop;
    const originTrigger = session.origin.trigger;
    const restoredItem = session.workspace.activeItemId === undefined
      ? null
      : [...shell.querySelectorAll<HTMLElement>('[data-review-item]')]
        .find((element) => element.dataset.reviewItem === session.workspace.activeItemId);
    const restoredPeek = session.workspace.activeItemId === undefined ? null
      : [...shell.querySelectorAll<HTMLElement>('[data-annotation-peek]')]
        .find((element) => element.dataset.annotationPeek === session.workspace.activeItemId);
    const target = originTrigger?.isConnected === true
      ? originTrigger
      : session.origin.kind === 'tray-edit'
        ? (restoredPeek ?? restoredItem)?.querySelector<HTMLElement>('[data-row-action="edit"]')
        : session.origin.kind === 'reader-edit'
          ? restoredItem?.querySelector<HTMLElement>('.annotation-item__navigation')
        : null;
    const workspaceFallback = session.workspace.open
      ? shell.querySelector<HTMLElement>(`#workspace-panel-${session.workspace.mode}`)
      : null;
    (target
      ?? workspaceFallback
      ?? shell.querySelector<HTMLElement>(
        '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
      ))?.focus({ preventScroll: true });
  }, [authoringSession]);

  useLayoutEffect(() => {
    const pending = pendingCanonicalFinalizationRef.current;
    if (pending === null) return;
    const canonical = canonicalStateForFinalizedInteraction(
      state,
      documentGeneration,
      pending.receipt,
      pending.session.authority,
    );
    if (canonical === undefined) return;
    settleCanonicalAuthoring(pending.session, pending.receipt, pending.outcome, canonical);
  }, [state, documentGeneration]);
  const dismissAuthoring = async (session: AuthoringSession) => {
    if (
      authoring.authoringAnchorNavigation?.token === session.token
      && authoring.authoringAnchorNavigation.pending
    ) await authoring.authoringAnchorNavigation.onCancelReturn?.();
    if (authoringPersistencePendingFor(session, pendingPersistenceRef.current)) {
      closeAuthoringSession(session.token, 'cancelled');
      return;
    }
    const invalidReason: AuthoringSessionInvalidReason | null = forcedInvalidToken === session.token
      ? 'document'
      : authoringSessionInvalidReason(
        session,
        currentAuthoringAuthorityRef.current,
        latestStateRef.current.items,
      );
    const terminalOwnsSession = terminalAttemptRef.current?.session.token === session.token
      || pendingCanonicalFinalizationRef.current?.session.token === session.token;
    if (invalidReason !== null && !terminalOwnsSession) {
      if (invalidReason === 'edit-target') {
        try {
          await discardProtectedAuthoringDraft(session);
        } catch (error) {
          setAnnouncement(error instanceof Error
            ? error.message
            : 'The protected annotation draft could not be discarded.');
          return;
        }
      }
      if (
        session.interaction !== undefined
        && releasedInvalidInteractionTokenRef.current !== session.token
      ) {
        releasedInvalidInteractionTokenRef.current = session.token;
        await session.interaction.release().catch(() => undefined);
      }
      closeAuthoringSession(session.token, 'cancelled');
      return;
    }
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

  const announcedInvalidRef = useRef<string | null>(null);
  const releasedInvalidInteractionTokenRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const current = authoringSessionRef.current;
    if (current === null || authoringInvalidReason === null) {
      announcedInvalidRef.current = null;
      return;
    }
    const pending = pendingCanonicalFinalizationRef.current;
    if (pending?.session.token === current.token) {
      const canonical = canonicalStateForFinalizedInteraction(
        state,
        documentGeneration,
        pending.receipt,
        pending.session.authority,
      );
      if (canonical !== undefined) {
        settleCanonicalAuthoring(current, pending.receipt, pending.outcome, canonical);
      } else if (state.sessionId !== pending.session.authority.sessionId) {
        setAnnouncement(pending.outcome === 'applied'
          ? 'The annotation was saved before the document changed.'
          : 'The cancellation was saved before the document changed.');
        closeAuthoringSession(current.token, 'source-replaced');
      }
      return;
    }
    if (terminalAttemptRef.current?.session.token === current.token) return;
    const invalidKey = `${current.token}:${authoringInvalidReason}`;
    if (announcedInvalidRef.current === invalidKey) return;
    announcedInvalidRef.current = invalidKey;
    if (
      authoring.authoringAnchorNavigation?.token === current.token
      && authoring.authoringAnchorNavigation.pending
    ) authoring.authoringAnchorNavigation.onCancelReturn?.();
    const retainInvalidDraft = current.origin.surface?.kind === 'reference'
      || current.interaction === undefined;
    if (!retainInvalidDraft) {
      setAnnouncement(authoringInvalidReason === 'edit-target'
        ? 'This annotation is no longer available and the edit was not applied.'
        : 'This draft belonged to the previous document and was not applied.');
      releasedInvalidInteractionTokenRef.current = current.token;
      void releaseDeletedAuthoringInteraction(current.interaction, () => {
        closeAuthoringSession(current.token, 'source-replaced');
      });
      return;
    }
    setAnnouncement(authoringInvalidReason === 'edit-target'
      ? 'This annotation is no longer available. Copy your draft or cancel it.'
      : 'This draft belongs to the previous document. Copy your draft or cancel it.');
    if (
      current.interaction !== undefined
      && releasedInvalidInteractionTokenRef.current !== current.token
    ) {
      releasedInvalidInteractionTokenRef.current = current.token;
      void current.interaction.release().catch(() => undefined);
    }
  }, [authoringInvalidReason, authoringTerminalPending, documentGeneration, state]);

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
    setForcedInvalidToken(current.token);
    setAnnouncement('This draft belongs to the previous document. Copy your draft or cancel it.');
  }, [authoring.authoringSessionResolution?.token]);
  useEffect(() => {
    const current = authoringSessionRef.current;
    if (current === null || !authoringPersistenceCanClose({
      session: current,
      pending: pendingPersistence,
      currentAuthority: currentAuthoringAuthorityRef.current,
      items: state.items,
      forcedInvalidToken,
      persistedRevision: authoring.persistedRevision,
    })) return;
    closeAuthoringSession(current.token, 'accepted', acknowledgedRef.current);
  }, [authoring.persistedRevision, forcedInvalidToken, pendingPersistence, state.items]);
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
      onPersistencePending: (revision) => {
        const pending = { token: session.token, revision };
        pendingPersistenceRef.current = pending;
        setPendingPersistence(pending);
      },
      onStale: () => invalidateAuthoringSession(session.token),
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
      onStale: () => invalidateAuthoringSession(session.token),
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
    const pendingCanonical = pendingCanonicalFinalizationRef.current;
    if (pendingCanonical?.session.token === session.token) {
      await pendingCanonical.settled;
      return;
    }
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
    const existing = pendingCanonicalFinalizationRef.current;
    if (existing?.session.token === session.token) {
      await existing.settled;
      return;
    }
    if (outcome === 'applied') onAccepted?.();
    if (terminalAttemptRef.current?.session.token === session.token) terminalAttemptRef.current = null;
    const stateSettled = consumeFinalizedInteractionState({
      state: latestStateRef.current,
      documentGeneration: currentAuthoringAuthorityRef.current.documentGeneration,
      receipt,
      authority: session.authority,
      outcome,
      announce: setAnnouncement,
      close: (reason, canonical) => {
        if (canonical !== undefined && reason !== 'source-replaced') {
          settleCanonicalAuthoring(session, receipt, outcome, canonical);
          return;
        }
        closeAuthoringSession(session.token, reason, canonical);
      },
    });
    if (!stateSettled) {
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
      const timeout = setTimeout(() => {
        const pending = pendingCanonicalFinalizationRef.current;
        if (pending?.session.token !== session.token) return;
        setAnnouncement(outcome === 'applied'
          ? 'The annotation was saved. Placekeeper is still retrying the latest review state.'
          : 'The cancellation was saved. Placekeeper is still retrying the latest review state.');
        setAuthoringTerminalPending({ token: session.token, delayed: true });
      }, canonicalFinalizationPendingNoticeMs);
      setAuthoringTerminalPending({ token: session.token, delayed: false });
      pendingCanonicalFinalizationRef.current = {
        session,
        receipt,
        outcome,
        settled,
        resolve: resolveSettled,
        timeout,
      };
    }
    pendingAcknowledgementsRef.current.enqueue(interaction, receipt);
    const acknowledgement = retryPendingAcknowledgements();
    const pending = pendingCanonicalFinalizationRef.current;
    if (pending?.session.token === session.token) {
      await Promise.all([acknowledgement, pending.settled]);
    } else {
      await acknowledgement;
    }
    if (pendingAcknowledgementsRef.current.has(receipt.interactionToken)) {
      setAnnouncement('The annotation was saved, but its completion receipt will be retried after reconnect.');
    }
  }

  useEffect(() => authoring.subscribeInteractionReconnect?.(async ({ generation }) => {
    const current = authoringSessionRef.current;
    if (current?.interaction === undefined) return;
    if (authoringPersistencePendingFor(current, pendingPersistenceRef.current)) {
      await retryPendingAcknowledgements();
      return;
    }
    if (pendingCanonicalFinalizationRef.current?.session.token === current.token) {
      await retryPendingAcknowledgements();
      return;
    }
    const settleInvalidAfterRelease = () => {
      const invalidToken = staleAuthoringSessionToken(authoringSessionRef.current, current.token);
      if (invalidToken === null) return;
      releasedInvalidInteractionTokenRef.current = invalidToken;
      if (current.origin.surface?.kind === 'reference') {
        setForcedInvalidToken(invalidToken);
        return;
      }
      closeAuthoringSession(current.token, 'source-replaced');
    };
    if (current.authority.documentGeneration !== generation) {
      setAnnouncement('The PDF changed while the annotation connection was recovering. The protected draft was not applied.');
      await releaseDeletedAuthoringInteraction(current.interaction, settleInvalidAfterRelease);
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
      await releaseDeletedAuthoringInteraction(current.interaction, settleInvalidAfterRelease);
    }
  }), [authoring.subscribeInteractionReconnect]);

  const saveAuthoring = async (session: AuthoringSession, value: string) => {
    const pendingTerminalAttempt = terminalAttemptRef.current;
    const terminalAttempt = pendingTerminalAttempt?.session.token === session.token
      ? pendingTerminalAttempt
      : null;
    const invalidReason = forcedInvalidToken === session.token
      ? 'document'
      : authoringSessionInvalidReason(
        session,
        currentAuthoringAuthorityRef.current,
        state.items,
      );
    const persistencePending = authoringPersistencePendingFor(
      session,
      pendingPersistenceRef.current,
    );
    const disposition = authoringSaveDisposition({
      terminalRetryPending: terminalAttempt !== null,
      invalidReason,
      persistencePending,
    });
    if (disposition === 'retry-terminal' && terminalAttempt !== null) {
      try {
        await finalizeProtectedAuthoring(session, terminalAttempt.outcome);
      } catch (error) {
        setAnnouncement(error instanceof Error ? error.message : 'The annotation could not be saved.');
      }
      return;
    }
    if (persistencePending) {
      setAnnouncement('This annotation is already waiting to be saved to the PDF. Use Retry in the save alert.');
      return;
    }
    if (invalidReason !== null) {
      setAnnouncement('This draft cannot be saved. Copy your draft or cancel it.');
      return;
    }
    const source = session.source;
    if (session.interaction !== undefined) {
      try {
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

  const authoringTerminalRetryPending = authoringSession !== null
    && terminalAttemptRef.current?.session.token === authoringSession.token;
  const authoringPersistencePending = authoringSession !== null
    && authoringPersistencePendingFor(authoringSession, pendingPersistence);
  const authoringSaveDisabled = authoringSaveDisposition({
    terminalRetryPending: authoringTerminalRetryPending,
    invalidReason: authoringInvalidReason,
    persistencePending: authoringPersistencePending,
  }) === 'blocked';

  return {
    authoringSession,
    authoringTerminalPending: authoringSession !== null
      && authoringTerminalPending?.token === authoringSession.token
      ? authoringTerminalPending
      : null,
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
    authoringInvalidReason,
    authoringPersistencePending,
    authoringTerminalRetryPending,
    authoringSaveDisabled,
  };
}
