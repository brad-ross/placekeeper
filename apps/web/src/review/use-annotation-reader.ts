import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isVisibleFocusTarget } from './focus-target.js';
import type { ReviewItem, ReviewState } from '../../../../packages/core/src/review-model.js';
import { existingAnnotationKey, type ExistingAnnotation, type ExistingAnnotationsDiscovery } from '../pdf/existing-annotations.js';
import type { PdfViewerNavigation } from '../pdf/viewer-navigation-adapter.js';
import type { PdfTargetVisibility } from '../pdf/viewer-navigation.js';
import { authoringAuthorityMatches, type AuthoringAuthority, type AuthoringSession } from './authoring-session.js';
import { annotationReaderIdentityMatches, resolveAnnotationReader, type AnnotationReaderIdentity, type AnnotationReaderRecord } from './annotation-reader.js';
import { reviewItemNavigationTarget } from './annotation-outline-context.js';

interface FullAnnotationReaderSession {
  readonly identity: AnnotationReaderIdentity;
  readonly authority: AuthoringAuthority;
  readonly annotationScrollTop: number;
  readonly origin: 'list' | 'peek';
  readonly previousActiveItemId?: string;
  readonly entryFocus?: 'back' | 'edit';
}

interface AnnotationReaderOptions {
  state: ReviewState;
  items: readonly ReviewItem[];
  existingAnnotations: ExistingAnnotationsDiscovery;
  documentGeneration: number;
  currentAuthoringAuthority: AuthoringAuthority;
  currentAuthoringAuthorityRef: RefObject<AuthoringAuthority>;
  authoringSession: AuthoringSession | null;
  authoringSessionRef: RefObject<AuthoringSession | null>;
  shellRef: RefObject<HTMLElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  viewerNavigation: PdfViewerNavigation | undefined;
  annotationsVisible: boolean;
  anyWorkspaceOpen: boolean;
  peekItemId: string | undefined;
  activeItemId: string | undefined;
  setPeekItemId(id: string | undefined): void;
  setActiveItem(id: string | undefined): void;
  setActiveExistingAnnotationKey(key: string | undefined): void;
  markUserIntent(): void;
  onNavigate: ((item: ReviewItem) => void) | undefined;
  onNavigateExisting: ((item: ExistingAnnotation) => void) | undefined;
}

/** Owns reader identity, overflow-driven resumption, and cancellable list restoration. */
export function useAnnotationReader({
  state, items, existingAnnotations, documentGeneration, currentAuthoringAuthority,
  currentAuthoringAuthorityRef, authoringSession, authoringSessionRef,
  shellRef, stageRef, viewerNavigation, annotationsVisible, anyWorkspaceOpen,
  peekItemId, activeItemId, setPeekItemId, setActiveItem, setActiveExistingAnnotationKey,
  markUserIntent, onNavigate, onNavigateExisting,
}: AnnotationReaderOptions) {
  const [annotationReaderSession, setAnnotationReaderSession] = useState<FullAnnotationReaderSession | null>(null);
  const [readerNavigationRevision, setReaderNavigationRevision] = useState(0);
  const [readerNavigationPending, setReaderNavigationPending] = useState(false);
  const pendingReaderResumeRef = useRef<FullAnnotationReaderSession | null>(null);
  const pendingMarkReaderRequestRef = useRef<{ readonly id: string; readonly token: number } | null>(null);
  const ownedReaderOverflowRef = useRef(new Map<string, boolean>());
  const annotationRestorationTokenRef = useRef(0);
  const annotationRestorationFramesRef = useRef(new Set<number>());
  const cancelAnnotationRestoration = useCallback(() => {
    annotationRestorationTokenRef.current += 1;
    for (const frame of annotationRestorationFramesRef.current) cancelAnimationFrame(frame);
    annotationRestorationFramesRef.current.clear();
  }, []);

  useEffect(() => cancelAnnotationRestoration, [cancelAnnotationRestoration]);

  const annotationReaderRecord = annotationReaderSession === null
    || !authoringAuthorityMatches(annotationReaderSession.authority, currentAuthoringAuthority)
    ? null
    : resolveAnnotationReader(annotationReaderSession.identity, {
        ownedItems: items,
        existingAnnotations,
        documentGeneration,
      });
  const annotationReaderOwnedItemId = annotationReaderRecord?.identity.origin === 'owned'
    ? annotationReaderRecord.identity.itemId
    : undefined;
  const annotationReaderOpen = annotationReaderRecord !== null;
  const annotationReaderIdentity = annotationReaderRecord?.identity;
  const annotationSourceIdentity = annotationReaderIdentity ?? (
    !annotationsVisible && peekItemId !== undefined
      ? { origin: 'owned' as const, itemId: peekItemId }
      : undefined
  );
  const annotationReaderTarget = annotationSourceIdentity === undefined
    ? null
    : annotationSourceIdentity.origin === 'owned'
      ? (() => {
          const item = items.find(
            ({ id }) => id === annotationSourceIdentity.itemId,
          );
          return item === undefined ? null : reviewItemNavigationTarget(item);
        })()
      : existingAnnotations.status === 'ready'
        ? (() => {
            const annotation = existingAnnotations.items.find(
              (candidate) => existingAnnotationKey(candidate)
                === annotationSourceIdentity.annotationKey,
            );
            return annotation === undefined
              ? null
              : { pageIndex: annotation.pageIndex, point: { x: annotation.rect.x, y: annotation.rect.y } };
          })()
        : null;
  void readerNavigationRevision;
  const annotationReaderVisibility: PdfTargetVisibility = annotationReaderTarget === null
    || viewerNavigation === undefined
    ? 'unavailable'
    : viewerNavigation.pointVisibility(
        annotationReaderTarget.pageIndex,
        annotationReaderTarget.point,
      );
  const restoreAnnotationList = useCallback((
    session: FullAnnotationReaderSession,
    options?: {
      readonly activeItemId?: string;
      readonly preferRowTarget?: boolean;
      readonly restoreRowFocus?: boolean;
    },
  ) => {
    const { identity } = session;
    const sourceDocumentChanged = !authoringAuthorityMatches(
      session.authority,
      currentAuthoringAuthority,
    );
    const sourceDiscoveryChanged = identity.origin === 'source' && (
      identity.documentGeneration !== documentGeneration
      || existingAnnotations.status !== 'ready'
      || identity.discoveryGeneration !== existingAnnotations.generation
    );
    const staleAuthority = sourceDocumentChanged || sourceDiscoveryChanged;
    pendingReaderResumeRef.current = null;
    cancelAnnotationRestoration();
    const restorationToken = annotationRestorationTokenRef.current;
    const scheduleRestoration = (callback: () => void) => {
      const frame = requestAnimationFrame(() => {
        annotationRestorationFramesRef.current.delete(frame);
        if (annotationRestorationTokenRef.current === restorationToken) callback();
      });
      annotationRestorationFramesRef.current.add(frame);
    };
    if (session.origin === 'peek') {
      setAnnotationReaderSession(null);
      if (staleAuthority || identity.origin !== 'owned') {
        setPeekItemId(undefined);
        setActiveItem(undefined);
      } else {
        setPeekItemId(identity.itemId);
        setActiveItem(options?.activeItemId ?? identity.itemId);
      }
      scheduleRestoration(() => scheduleRestoration(() => {
        shellRef.current
          ?.querySelector<HTMLElement>('[data-annotation-peek] [data-read-full-annotation="true"]')
          ?.focus({ preventScroll: true });
      }));
      return;
    }
    setAnnotationReaderSession(null);
    if (staleAuthority) {
      setActiveItem(undefined);
    } else {
      const requestedActiveItemId = options?.activeItemId ?? session.previousActiveItemId;
      const validActiveItemId = requestedActiveItemId !== undefined
        && items.some(({ id }) => id === requestedActiveItemId)
        ? requestedActiveItemId
        : undefined;
      setActiveItem(validActiveItemId);
    }
    scheduleRestoration(() => scheduleRestoration(() => {
      const shell = shellRef.current;
      if (shell === null) return;
      const viewport = shell.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
      if (!staleAuthority && viewport !== null) viewport.scrollTop = session.annotationScrollTop;

      const row = staleAuthority
        ? undefined
        : identity.origin === 'owned'
          ? [...shell.querySelectorAll<HTMLElement>('[data-review-item]')]
            .find((element) => element.dataset.reviewItem === identity.itemId)
          : [...shell.querySelectorAll<HTMLElement>('[data-existing-annotation-key]')]
            .find((element) => element.dataset.existingAnnotationKey === identity.annotationKey);
      const openingMore = row?.querySelector<HTMLElement>('[data-read-full-annotation="true"]');
      const rowTarget = row?.querySelector<HTMLElement>('.annotation-item__navigation');
      const workspaceFallback = shell.querySelector<HTMLElement>('#workspace-panel-annotations');
      const pdfFallback = shell.querySelector<HTMLElement>(
        '.pdf-workspace:not(.pdf-workspace--reference) [data-page-index], [role="application"]',
      );
      const restorableMore = !options?.preferRowTarget && isVisibleFocusTarget(openingMore)
        ? openingMore
        : null;
      const focusTarget = options?.restoreRowFocus === false
        ? workspaceFallback ?? pdfFallback
        : restorableMore ?? rowTarget ?? workspaceFallback ?? pdfFallback;
      focusTarget?.focus({ preventScroll: true });
      if (!staleAuthority && viewport !== null) {
        viewport.scrollTop = session.annotationScrollTop;
        scheduleRestoration(() => {
          viewport.scrollTop = session.annotationScrollTop;
          if (options?.preferRowTarget || document.activeElement !== rowTarget) return;
          const settledMore = row?.querySelector<HTMLElement>('[data-read-full-annotation="true"]');
          if (isVisibleFocusTarget(settledMore)) settledMore.focus({ preventScroll: true });
        });
      }
    }));
  }, [
    cancelAnnotationRestoration,
    currentAuthoringAuthority.documentGeneration,
    currentAuthoringAuthority.sourceIdentity,
    existingAnnotations,
    documentGeneration,
    items,
  ]);

  useLayoutEffect(() => {
    if (annotationReaderSession === null || !annotationReaderOpen) return;
    const viewport = shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]');
    if (viewport) viewport.scrollTop = 0;
  }, [annotationReaderOpen, annotationReaderSession]);

  useLayoutEffect(() => {
    if (annotationReaderTarget === null) return;
    const stage = stageRef.current;
    if (stage === null) return;
    let frame = 0;
    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setReaderNavigationRevision((revision) => revision + 1);
      });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(stage);
    const schedulePdfScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.matches('[data-viewer-framing-viewport]')) schedule();
    };
    stage.addEventListener('scroll', schedulePdfScroll, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      stage.removeEventListener('scroll', schedulePdfScroll, true);
      window.removeEventListener('resize', schedule);
    };
  }, [annotationReaderTarget?.pageIndex, annotationReaderTarget?.point.x,
    annotationReaderTarget?.point.y, viewerNavigation, stageRef]);

  useEffect(() => {
    if (!readerNavigationPending || annotationReaderVisibility !== 'visible') return;
    setReaderNavigationPending(false);
  }, [annotationReaderVisibility, readerNavigationPending]);

  useEffect(() => {
    setReaderNavigationPending(false);
  }, [annotationReaderSession?.identity]);

  useLayoutEffect(() => {
    if (annotationReaderSession === null || !annotationReaderOpen) return;
    const action = annotationReaderSession.entryFocus ?? 'back';
    shellRef.current
      ?.querySelector<HTMLElement>(`[data-full-annotation-action="${action}"]`)
      ?.focus({ preventScroll: true });
  }, [annotationReaderOpen, annotationReaderSession]);

  const openOwnedAnnotationReader = (
    record: AnnotationReaderRecord,
    _trigger: HTMLButtonElement | null,
    origin: FullAnnotationReaderSession['origin'] = 'list',
  ) => {
    if (authoringSessionRef.current !== null || record.identity.origin !== 'owned') return;
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    const { identity } = record;
    const item = items.find(({ id }) => id === identity.itemId);
    if (item === undefined) return;
    const annotationScrollTop = shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]')
      ?.scrollTop ?? 0;
    const previousActiveItemId = activeItemId;
    setActiveItem(item.id);
    setAnnotationReaderSession({
      identity,
      authority: currentAuthoringAuthorityRef.current,
      annotationScrollTop,
      origin,
      ...(previousActiveItemId === undefined ? {} : { previousActiveItemId }),
    });
  };

  const openExistingAnnotationReader = (
    annotation: ExistingAnnotation,
    record: AnnotationReaderRecord,
    _trigger: HTMLButtonElement,
  ) => {
    if (authoringSessionRef.current !== null || record.identity.origin !== 'source') return;
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    const annotationScrollTop = shellRef.current
      ?.querySelector<HTMLElement>('[data-annotation-scroll-viewport]')
      ?.scrollTop ?? 0;
    const previousActiveItemId = activeItemId;
    setActiveItem(undefined);
    setActiveExistingAnnotationKey(existingAnnotationKey(annotation));
    setAnnotationReaderSession({
      identity: record.identity,
      authority: currentAuthoringAuthorityRef.current,
      annotationScrollTop,
      origin: 'list',
      ...(previousActiveItemId === undefined ? {} : { previousActiveItemId }),
    });
  };

  const closeAnnotationReader = (session: FullAnnotationReaderSession, restoreRowFocus = true) => {
    if (session.origin === 'list') {
      restoreAnnotationList(session, { restoreRowFocus });
      return;
    }
    cancelAnnotationRestoration();
    pendingReaderResumeRef.current = null;
    pendingMarkReaderRequestRef.current = null;
    setAnnotationReaderSession(null);
    if (restoreRowFocus) requestAnimationFrame(() => {
      shellRef.current
        ?.querySelector<HTMLElement>('[data-annotation-peek] [data-read-full-annotation="true"]')
        ?.focus({ preventScroll: true });
    });
  };

  const returnReaderToAnnotation = () => {
    if (
      annotationReaderRecord === null
      || annotationReaderTarget === null
      || readerNavigationPending
    ) return;
    const identity = annotationReaderRecord.identity;
    markUserIntent();
    setReaderNavigationPending(true);
    if (identity.origin === 'owned') {
      const item = items.find(
        ({ id }) => id === identity.itemId,
      );
      if (item === undefined) {
        setReaderNavigationPending(false);
        return;
      }
      setActiveItem(item.id);
      onNavigate?.(item);
    } else if (existingAnnotations.status === 'ready') {
      const annotation = existingAnnotations.items.find(
        (candidate) => existingAnnotationKey(candidate)
          === identity.annotationKey,
      );
      if (annotation === undefined) {
        setReaderNavigationPending(false);
        return;
      }
      onNavigateExisting?.(annotation);
    }
    window.setTimeout(() => {
      setReaderNavigationPending(false);
      setReaderNavigationRevision((revision) => revision + 1);
    }, 2000);
  };

  const annotationReaderSourceNavigation = annotationReaderRecord === null
    ? undefined
    : {
        visibility: annotationReaderVisibility,
        pending: readerNavigationPending,
        onReturn: returnReaderToAnnotation,
      };

  useEffect(() => {
    if (
      authoringSessionRef.current === null
      && annotationReaderSession !== null
      && annotationReaderRecord === null
    ) {
      restoreAnnotationList(annotationReaderSession);
    }
  }, [annotationReaderRecord, annotationReaderSession, authoringSession, restoreAnnotationList]);

  const settlePendingReaderResume = (
    record: AnnotationReaderRecord,
    overflowing: boolean,
  ) => {
    const pending = pendingReaderResumeRef.current;
    if (pending === null || !annotationReaderIdentityMatches(pending.identity, record.identity)) return;
    pendingReaderResumeRef.current = null;
    if (!overflowing) {
      restoreAnnotationList(pending, {
        ...(pending.identity.origin === 'owned' ? { activeItemId: pending.identity.itemId } : {}),
        preferRowTarget: true,
      });
      return;
    }
    cancelAnnotationRestoration();
    setAnnotationReaderSession({ ...pending, entryFocus: 'edit' });
  };

  const settleOwnedReaderOverflow = (
    record: AnnotationReaderRecord,
    overflowing: boolean,
  ) => {
    settlePendingReaderResume(record, overflowing);
    if (record.identity.origin === 'owned') {
      ownedReaderOverflowRef.current.set(record.identity.itemId, overflowing);
    }
    const pending = pendingMarkReaderRequestRef.current;
    if (
      pending === null
      || record.identity.origin !== 'owned'
      || record.identity.itemId !== pending.id
    ) return;
    pendingMarkReaderRequestRef.current = null;
    if (!overflowing) return;
    openOwnedAnnotationReader(
      record,
      null,
      anyWorkspaceOpen ? 'list' : 'peek',
    );
  };

  const restoreReaderAfterAuthoring = (
    current: AuthoringSession,
    reason: 'accepted' | 'cancelled' | 'source-replaced',
    acceptedState?: ReviewState,
  ): boolean => {
    const readerOrigin = current.origin.kind === 'reader-edit' ? annotationReaderSession : null;
    if (reason === 'source-replaced') {
      if (readerOrigin !== null) {
        if (!authoringAuthorityMatches(readerOrigin.authority, currentAuthoringAuthorityRef.current)) {
          setActiveItem(undefined);
        }
        restoreAnnotationList(readerOrigin, { preferRowTarget: true });
      }
      return true;
    }
    if (readerOrigin !== null) {
      const nextReaderRecord = resolveAnnotationReader(readerOrigin.identity, {
        ownedItems: (acceptedState ?? state).items,
        existingAnnotations,
        documentGeneration,
      });
      if (nextReaderRecord === null) {
        const readerItemId = readerOrigin.identity.origin === 'owned'
          ? readerOrigin.identity.itemId
          : undefined;
        const readerItemStillExists = readerItemId !== undefined
          && (acceptedState ?? state).items.some(({ id }) => id === readerItemId);
        restoreAnnotationList(readerOrigin, {
          ...(readerItemStillExists ? { activeItemId: readerItemId } : {}),
          preferRowTarget: true,
        });
        return true;
      }
      if (reason === 'accepted') {
        pendingReaderResumeRef.current = readerOrigin;
        cancelAnnotationRestoration();
        setAnnotationReaderSession(null);
        if (readerOrigin.identity.origin === 'owned') {
          setActiveItem(readerOrigin.identity.itemId);
        }
        return true;
      }
    }
    return false;
  };

  const cancelReaderResume = () => { pendingReaderResumeRef.current = null; };
  const hideAnnotationReader = () => { setAnnotationReaderSession(null); };
  const deferMarkReaderRequest = (request: { readonly id: string; readonly token: number } | null) => {
    pendingMarkReaderRequestRef.current = request;
  };
  const knownOwnedReaderOverflow = (id: string) => ownedReaderOverflowRef.current.get(id);
  const forgetOwnedReaderOverflow = (id: string) => { ownedReaderOverflowRef.current.delete(id); };

  return {
    restoreReaderAfterAuthoring,
    annotationReaderSession,
    hideAnnotationReader,
    annotationReaderRecord,
    annotationReaderOwnedItemId,
    annotationReaderVisibility,
    annotationReaderSourceNavigation,
    cancelReaderResume,
    deferMarkReaderRequest,
    knownOwnedReaderOverflow,
    forgetOwnedReaderOverflow,
    cancelAnnotationRestoration,
    restoreAnnotationList,
    openOwnedAnnotationReader,
    openExistingAnnotationReader,
    closeAnnotationReader,
    settleOwnedReaderOverflow,
    settlePendingReaderResume,
  };
}
