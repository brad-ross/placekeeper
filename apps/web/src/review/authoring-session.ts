import type {
  JsonValue,
  PendingReviewDraftV1,
  ReviewItem,
  ReviewState,
} from '../../../../packages/core/src/review-model.js';
import {
  anchorEvidenceFromReviewItem,
  canonicalReviewSelectionEvidence,
  normalizeReviewSelectionAnchor,
  reviewSelectionPayload,
} from '../../../../packages/core/src/review-model.js';
import {
  projectReviewItem,
  projectReviewItemProjections,
} from '../../../../packages/core/src/annotation-projection.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { ReviewRect } from '../../../../packages/core/src/review-commands.js';
import type { CaretAnchor, SelectionAnchor } from '../pdf/selection-anchor.js';
import type { PdfNaturalPoint } from '../pdf/viewer-navigation.js';
import type { WorkspaceMode } from './reference-navigation-state.js';

export type ReviewInteractionOutcome = 'applied' | 'discarded';

export interface ReviewInteractionReceipt {
  readonly status: 'finalized';
  readonly interactionToken: string;
  readonly generation: number;
  readonly outcome: ReviewInteractionOutcome;
  readonly reviewRevision: number;
  readonly sessionId?: string;
  readonly attachmentId?: string;
}

export interface ReviewInteractionTransport {
  beginInteraction(input: {
    readonly interactionToken: string;
    readonly order: number;
    readonly generation: number;
  }): Promise<unknown>;
  finalizeInteraction(input: {
    readonly interactionToken: string;
    readonly order: number;
    readonly outcome: ReviewInteractionOutcome;
    readonly draftId: string;
    readonly expectedDraftRevision: number;
  }): Promise<unknown>;
  releaseInteraction(input: { readonly interactionToken: string; readonly order: number }): Promise<unknown>;
  acknowledgeInteraction(input: { readonly interactionToken: string; readonly order: number }): Promise<unknown>;
}

export interface ReviewInteractionHandle {
  readonly interactionToken: string;
  readonly generation: number;
  readonly ownerViewId: string;
  reacquire(): Promise<ReviewInteractionReceipt | undefined>;
  finalize(outcome: ReviewInteractionOutcome, draftId: string, expectedDraftRevision: number): Promise<ReviewInteractionReceipt>;
  acknowledge(receipt: ReviewInteractionReceipt): Promise<void>;
  release(): Promise<void>;
}

export interface OrderedReviewInteractionTransport extends ReviewInteractionTransport {
  dispose(): void;
}

interface PendingInteractionRelease {
  readonly request: { readonly interactionToken: string; readonly order: number };
  readonly retainResult: boolean;
  readonly release: (request: { readonly interactionToken: string; readonly order: number }) => Promise<unknown>;
}

interface AttachmentInteractionOrderState {
  nextOrder: number;
  readonly ordersByToken: Map<string, Partial<Record<InteractionOrderPhase, number>>>;
  readonly pendingReleases: Map<string, PendingInteractionRelease>;
  readonly recoveredReleases: Map<string, unknown>;
  active: boolean;
  readonly waiters: Set<() => void>;
  leases: number;
  releaseRetryAttempt: number;
  releaseRetryTimer: ReturnType<typeof setTimeout> | null;
}

type InteractionOrderPhase = 'begin' | 'finalize' | 'release' | 'acknowledge';

const attachmentInteractionOrders = new WeakMap<object, AttachmentInteractionOrderState>();
const RELEASE_RETRY_DELAYS_MS = [25, 100, 250, 1_000] as const;
const MAX_RECOVERED_RELEASES = 128;

function wakeInteractionWaiters(state: AttachmentInteractionOrderState): void {
  for (const wake of state.waiters) wake();
  state.waiters.clear();
}

async function acquireInteractionLane(state: AttachmentInteractionOrderState): Promise<void> {
  while (state.active) {
    await new Promise<void>((resolve) => state.waiters.add(resolve));
  }
  state.active = true;
}

function rememberRecoveredRelease(
  state: AttachmentInteractionOrderState,
  interactionToken: string,
  result: unknown,
): void {
  state.recoveredReleases.set(interactionToken, result);
  while (state.recoveredReleases.size > MAX_RECOVERED_RELEASES) {
    const oldestToken = state.recoveredReleases.keys().next().value as string | undefined;
    if (oldestToken === undefined) break;
    state.recoveredReleases.delete(oldestToken);
    state.ordersByToken.delete(oldestToken);
  }
}

function cancelReleaseRetry(state: AttachmentInteractionOrderState): void {
  if (state.releaseRetryTimer !== null) clearTimeout(state.releaseRetryTimer);
  state.releaseRetryTimer = null;
  state.releaseRetryAttempt = 0;
}

async function drainPendingInteractionReleases(
  state: AttachmentInteractionOrderState,
  requestedReleaseToken?: string,
): Promise<unknown> {
  let requestedResult: unknown;
  for (const [pendingToken, pending] of state.pendingReleases) {
    const result = await pending.release(pending.request);
    const status = lifecycleRecord(result)?.status;
    if (status !== 'released' && status !== 'missing') {
      throw new Error('An abandoned annotation interaction could not be released safely.');
    }
    state.pendingReleases.delete(pendingToken);
    if (pending.retainResult) rememberRecoveredRelease(state, pendingToken, result);
    else state.ordersByToken.delete(pendingToken);
    if (pendingToken === requestedReleaseToken) requestedResult = result;
  }
  if (state.pendingReleases.size === 0) cancelReleaseRetry(state);
  return requestedResult;
}

function schedulePendingInteractionReleaseDrain(state: AttachmentInteractionOrderState): void {
  if (state.leases === 0 || state.pendingReleases.size === 0 || state.releaseRetryTimer !== null) return;
  const delay = RELEASE_RETRY_DELAYS_MS[Math.min(
    state.releaseRetryAttempt,
    RELEASE_RETRY_DELAYS_MS.length - 1,
  )]!;
  state.releaseRetryTimer = setTimeout(() => {
    state.releaseRetryTimer = null;
    void (async () => {
      if (state.leases === 0 || state.pendingReleases.size === 0) return;
      await acquireInteractionLane(state);
      try {
        if (state.leases === 0) return;
        await drainPendingInteractionReleases(state);
      } catch {
        state.releaseRetryAttempt += 1;
      } finally {
        state.active = false;
        wakeInteractionWaiters(state);
        schedulePendingInteractionReleaseDrain(state);
      }
    })();
  }, delay);
}

function retainPendingInteractionRelease(
  state: AttachmentInteractionOrderState,
  transport: ReviewInteractionTransport,
  request: { readonly interactionToken: string; readonly order: number },
  retainResult: boolean,
): void {
  state.pendingReleases.set(request.interactionToken, {
    request,
    retainResult,
    release: (pendingRequest) => transport.releaseInteraction(pendingRequest),
  });
  schedulePendingInteractionReleaseDrain(state);
}

/** Shares the attachment-wide monotonic order fence across every editor surface and remount. */
export function attachmentOrderedInteractionTransport(
  attachmentIdentity: object,
  transport: ReviewInteractionTransport,
): OrderedReviewInteractionTransport {
  let state = attachmentInteractionOrders.get(attachmentIdentity);
  if (state === undefined) {
    state = {
      nextOrder: 1,
      ordersByToken: new Map(),
      pendingReleases: new Map(),
      recoveredReleases: new Map(),
      active: false,
      waiters: new Set(),
      leases: 0,
      releaseRetryAttempt: 0,
      releaseRetryTimer: null,
    };
    attachmentInteractionOrders.set(attachmentIdentity, state);
  }
  const sharedState = state;
  sharedState.leases += 1;
  let disposed = false;
  const assertAttached = () => {
    if (disposed) throw new Error('The annotation interaction transport has been disposed.');
  };
  const order = (interactionToken: string, phase: InteractionOrderPhase) => {
    let tokenOrders = sharedState.ordersByToken.get(interactionToken);
    if (tokenOrders === undefined) {
      tokenOrders = {};
      sharedState.ordersByToken.set(interactionToken, tokenOrders);
    }
    let allocated = tokenOrders[phase];
    if (allocated === undefined) {
      allocated = sharedState.nextOrder;
      sharedState.nextOrder += 1;
      tokenOrders[phase] = allocated;
    }
    return allocated;
  };
  const terminal = (interactionToken: string, result: unknown) => {
    const status = lifecycleRecord(result)?.status;
    if (status === 'released' || status === 'missing') sharedState.ordersByToken.delete(interactionToken);
    return result;
  };
  const send = async <T>(
    interactionToken: string,
    phase: InteractionOrderPhase,
    invoke: (order: number) => Promise<T>,
  ): Promise<T> => {
    assertAttached();
    await acquireInteractionLane(sharedState);
    try {
      assertAttached();
      if (phase === 'release' && sharedState.recoveredReleases.has(interactionToken)) {
        const recovered = sharedState.recoveredReleases.get(interactionToken);
        sharedState.recoveredReleases.delete(interactionToken);
        sharedState.ordersByToken.delete(interactionToken);
        return recovered as T;
      }
      const recovered = await drainPendingInteractionReleases(
        sharedState,
        phase === 'release' ? interactionToken : undefined,
      );
      if (recovered !== undefined) {
        sharedState.recoveredReleases.delete(interactionToken);
        sharedState.ordersByToken.delete(interactionToken);
        return recovered as T;
      }
      return await invoke(order(interactionToken, phase));
    } finally {
      sharedState.active = false;
      wakeInteractionWaiters(sharedState);
    }
  };
  return {
    beginInteraction: async (input) => {
      assertAttached();
      await acquireInteractionLane(sharedState);
      try {
        assertAttached();
        await drainPendingInteractionReleases(sharedState);
        const replayingBegin = sharedState.ordersByToken.get(input.interactionToken)?.begin !== undefined;
        try {
          const result = await transport.beginInteraction({
            ...input,
            order: order(input.interactionToken, 'begin'),
          });
          if (lifecycleRecord(result)?.status !== 'accepted') sharedState.ordersByToken.delete(input.interactionToken);
          return result;
        } catch (error) {
          if (replayingBegin) throw error;
          const releaseOrder = order(input.interactionToken, 'release');
          const request = { interactionToken: input.interactionToken, order: releaseOrder };
          try {
            let released;
            try {
              released = await transport.releaseInteraction(request);
            } catch {
              released = await transport.releaseInteraction(request);
            }
            const status = lifecycleRecord(released)?.status;
            if (status === 'released' || status === 'missing') {
              sharedState.ordersByToken.delete(input.interactionToken);
            } else {
              retainPendingInteractionRelease(sharedState, transport, request, false);
            }
          } catch {
            retainPendingInteractionRelease(sharedState, transport, request, false);
          }
          throw error;
        }
      } finally {
        sharedState.active = false;
        wakeInteractionWaiters(sharedState);
      }
    },
    finalizeInteraction: (input) => send(input.interactionToken, 'finalize', (allocated) =>
      transport.finalizeInteraction({ ...input, order: allocated })),
    releaseInteraction: async (input) => terminal(input.interactionToken,
      await send(input.interactionToken, 'release', async (allocated) => {
        const request = { ...input, order: allocated };
        try {
          return await transport.releaseInteraction(request);
        } catch {
          try {
            return await transport.releaseInteraction(request);
          } catch (error) {
            retainPendingInteractionRelease(sharedState, transport, request, true);
            throw error;
          }
        }
      })),
    acknowledgeInteraction: async (input) => terminal(input.interactionToken,
      await send(input.interactionToken, 'acknowledge', (allocated) =>
        transport.acknowledgeInteraction({ ...input, order: allocated }))),
    dispose() {
      if (disposed) return;
      disposed = true;
      sharedState.leases -= 1;
      if (sharedState.leases !== 0) return;
      cancelReleaseRetry(sharedState);
      sharedState.pendingReleases.clear();
      sharedState.recoveredReleases.clear();
      sharedState.ordersByToken.clear();
      sharedState.active = false;
      wakeInteractionWaiters(sharedState);
      if (attachmentInteractionOrders.get(attachmentIdentity) === sharedState) {
        attachmentInteractionOrders.delete(attachmentIdentity);
      }
    },
  };
}

function lifecycleRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Starts one broker-owned interaction and retains an exact finalization request for retries. */
export async function beginReviewInteraction(
  transport: ReviewInteractionTransport,
  generation: number,
  interactionToken: string = crypto.randomUUID(),
  startingOrder = 1,
): Promise<ReviewInteractionHandle> {
  const beginRequest = { interactionToken, order: startingOrder, generation };
  const begun = lifecycleRecord(await transport.beginInteraction(beginRequest));
  if (begun?.status !== 'accepted' || begun.generation !== generation || typeof begun.ownerViewId !== 'string') {
    const current = typeof begun?.generation === 'number' ? ` Current generation: ${begun.generation}.` : '';
    throw new Error(`The annotation interaction could not start safely.${current}`);
  }
  let finalization: {
    readonly interactionToken: string;
    readonly order: number;
    readonly outcome: ReviewInteractionOutcome;
    readonly draftId: string;
    readonly expectedDraftRevision: number;
  } | null = null;
  let consumed = false;
  let acknowledgement: Promise<void> | null = null;
  let released = false;
  return {
    interactionToken,
    generation,
    ownerViewId: begun.ownerViewId,
    async reacquire() {
      const value = lifecycleRecord(await transport.beginInteraction(beginRequest));
      if (value?.status === 'accepted' && value.generation === generation && typeof value.ownerViewId === 'string') {
        return undefined;
      }
      if (value?.status === 'finalized' && value.interactionToken === interactionToken &&
        value.generation === generation && (value.outcome === 'applied' || value.outcome === 'discarded') &&
        typeof value.reviewRevision === 'number') {
        return value as unknown as ReviewInteractionReceipt;
      }
      const current = typeof value?.generation === 'number' ? ` Current generation: ${value.generation}.` : '';
      throw new Error(`The annotation interaction could not be reacquired safely.${current}`);
    },
    async finalize(outcome, draftId, expectedDraftRevision) {
      const requested = { interactionToken, order: startingOrder + 1, outcome, draftId, expectedDraftRevision };
      if (finalization === null) finalization = requested;
      else if (JSON.stringify(finalization) !== JSON.stringify(requested)) {
        throw new Error('An uncertain annotation completion must retry the exact finalization request.');
      }
      const value = lifecycleRecord(await transport.finalizeInteraction(finalization));
      if (value?.status !== 'finalized' || value.interactionToken !== interactionToken ||
        value.generation !== generation || value.outcome !== outcome ||
        typeof value.reviewRevision !== 'number') {
        throw new Error('The annotation completion was not durably acknowledged.');
      }
      return value as unknown as ReviewInteractionReceipt;
    },
    async acknowledge(receipt) {
      if (consumed) return;
      if (acknowledgement !== null) return acknowledgement;
      if (receipt.interactionToken !== interactionToken || receipt.generation !== generation) {
        throw new Error('The annotation receipt does not belong to this interaction.');
      }
      acknowledgement = (async () => {
        const value = lifecycleRecord(await transport.acknowledgeInteraction({ interactionToken, order: startingOrder + 2 }));
        if (value?.status !== 'released' && value?.status !== 'missing') {
          throw new Error('The annotation receipt could not be acknowledged.');
        }
        consumed = true;
      })();
      try {
        await acknowledgement;
      } catch (error) {
        acknowledgement = null;
        throw error;
      }
    },
    async release() {
      if (released || finalization !== null) return;
      const value = lifecycleRecord(await transport.releaseInteraction({ interactionToken, order: startingOrder + 1 }));
      if (value?.status !== 'released' && value?.status !== 'missing') {
        throw new Error('The annotation interaction could not be released safely.');
      }
      released = true;
    },
  };
}

export interface AuthoringAuthority {
  readonly sessionId: string;
  readonly sourceIdentity: string;
  readonly documentGeneration: number;
}

export interface AuthoringWorkspaceSnapshot {
  readonly open: boolean;
  readonly mode: WorkspaceMode;
  readonly activeItemId?: string;
  readonly annotationScrollTop: number;
}

export type AuthoringOriginKind =
  | 'typing'
  | 'selection'
  | 'caret'
  | 'page'
  | 'keyboard'
  | 'tray-edit'
  | 'reader-edit';

export interface AuthoringOrigin {
  readonly kind: AuthoringOriginKind;
  readonly trigger: HTMLElement | null;
}

export type AuthoringSource =
  | {
      readonly kind: 'replace';
      readonly anchor: SelectionAnchor;
      readonly initialValue: string;
      readonly selectionGeneration: number;
    }
  | {
      readonly kind: 'insert';
      readonly anchor: CaretAnchor;
      readonly initialValue: string;
    }
  | {
      readonly kind: 'highlight';
      readonly anchor: SelectionAnchor;
      readonly selectionGeneration: number;
    }
  | {
      readonly kind: 'pageNote';
      readonly pageIndex: number;
      readonly position: ReviewRect;
      readonly nearbyText?: string;
    }
  | {
      readonly kind: 'edit';
      readonly item: ReviewItem;
    };

export interface AuthoringSemantics {
  readonly title: string;
  readonly primaryLabel: 'Save' | 'Apply';
  readonly optional: boolean;
  readonly allowWhitespace: boolean;
}

export interface AuthoringSessionSeed {
  readonly token: number;
  readonly draftId?: string;
  readonly authority: AuthoringAuthority;
  readonly source: AuthoringSource;
  readonly origin: AuthoringOrigin;
  readonly workspace: AuthoringWorkspaceSnapshot;
  readonly interaction?: ReviewInteractionHandle;
}

export interface AuthoringSession {
  readonly token: number;
  readonly draftId: string;
  readonly authority: AuthoringAuthority;
  readonly source: AuthoringSource;
  readonly origin: AuthoringOrigin;
  readonly workspace: AuthoringWorkspaceSnapshot;
  readonly semantics: AuthoringSemantics;
  readonly interaction?: ReviewInteractionHandle;
}

export interface AuthoringAnchorSnapshot {
  readonly token: number;
  readonly authority: AuthoringAuthority;
  readonly pageIndex: number;
  readonly point: PdfNaturalPoint | null;
}

export function reviewSourceIdentity(
  state: Pick<ReviewState, 'sessionId' | 'source'>,
): string {
  return JSON.stringify([state.sessionId, state.source.fileId, state.source.digest]);
}

export function authoringAuthorityFor(
  state: Pick<ReviewState, 'sessionId' | 'source'>,
  documentGeneration: number,
): AuthoringAuthority {
  return Object.freeze({
    sessionId: state.sessionId,
    sourceIdentity: reviewSourceIdentity(state),
    documentGeneration,
  });
}

export function authoringAuthorityMatches(
  captured: AuthoringAuthority,
  current: AuthoringAuthority,
): boolean {
  return captured.sourceIdentity === current.sourceIdentity
    && captured.sessionId === current.sessionId
    && captured.documentGeneration === current.documentGeneration;
}

export function authoringSessionIsCurrent(
  session: Pick<AuthoringSession, 'authority'>,
  current: AuthoringAuthority,
): boolean {
  return authoringAuthorityMatches(session.authority, current);
}

function cloneRect(rect: ReviewRect): ReviewRect {
  return Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

function cloneSelectionAnchor(anchor: SelectionAnchor): SelectionAnchor {
  const canonical = normalizeReviewSelectionAnchor(anchor);
  return Object.freeze({
    pageIndex: canonical.pageIndex,
    quote: canonical.quote,
    prefix: canonical.prefix,
    suffix: canonical.suffix,
    rect: cloneRect(canonical.rect),
    segmentRects: Object.freeze(canonical.segmentRects.map(cloneRect)) as unknown as SelectionAnchor['segmentRects'],
    pages: Object.freeze(canonical.pages.map((page) => Object.freeze({
      ...page,
      rect: cloneRect(page.rect),
      segmentRects: Object.freeze(page.segmentRects.map(cloneRect)),
    }))),
    pageBoundaries: Object.freeze(canonical.pageBoundaries.map((boundary) => Object.freeze({ ...boundary }))),
    reliable: true,
  });
}

function cloneCaretAnchor(anchor: CaretAnchor): CaretAnchor {
  return Object.freeze({
    pageIndex: anchor.pageIndex,
    position: cloneRect(anchor.position),
    leftContext: anchor.leftContext,
    rightContext: anchor.rightContext,
    reliable: true,
  });
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson)) as unknown as JsonValue;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]),
    ));
  }
  return value;
}

function cloneReviewItem(item: ReviewItem): ReviewItem {
  return Object.freeze({
    ...item,
    payload: Object.freeze(Object.fromEntries(
      Object.entries(item.payload).map(([key, value]) => [key, cloneJson(value)]),
    )),
  });
}

function cloneSource(source: AuthoringSource): AuthoringSource {
  switch (source.kind) {
    case 'replace':
      return Object.freeze({
        ...source,
        anchor: cloneSelectionAnchor(source.anchor),
      });
    case 'insert':
      return Object.freeze({
        ...source,
        anchor: cloneCaretAnchor(source.anchor),
      });
    case 'highlight':
      return Object.freeze({
        ...source,
        anchor: cloneSelectionAnchor(source.anchor),
      });
    case 'pageNote':
      return Object.freeze({
        ...source,
        position: cloneRect(source.position),
      });
    case 'edit':
      return Object.freeze({
        ...source,
        item: cloneReviewItem(source.item),
      });
  }
}

function semanticsFor(source: AuthoringSource): AuthoringSemantics {
  if (source.kind === 'replace') {
    return Object.freeze({
      title: 'Replacement',
      primaryLabel: 'Apply',
      optional: false,
      allowWhitespace: true,
    });
  }
  if (source.kind === 'insert') {
    return Object.freeze({
      title: 'Insertion',
      primaryLabel: 'Apply',
      optional: false,
      allowWhitespace: true,
    });
  }
  if (source.kind === 'highlight') {
    return Object.freeze({
      title: 'Highlight Comment',
      primaryLabel: 'Save',
      optional: true,
      allowWhitespace: false,
    });
  }
  if (source.kind === 'pageNote') {
    return Object.freeze({
      title: 'Page Note',
      primaryLabel: 'Save',
      optional: false,
      allowWhitespace: false,
    });
  }
  const itemLabel = source.item.kind === 'pdfAnnotation' ? 'Comment' : source.item.kind === 'replace'
    ? 'Replacement'
    : source.item.kind === 'insert'
      ? 'Insertion'
      : source.item.kind === 'pageNote'
        ? 'Page Note'
        : source.item.kind === 'highlight'
          ? 'Highlight'
          : 'Deletion';
  return Object.freeze({
    title: `Edit ${itemLabel}`,
    primaryLabel: 'Apply',
    optional: source.item.kind === 'highlight' || source.item.kind === 'pdfAnnotation',
    allowWhitespace: source.item.kind === 'replace' || source.item.kind === 'insert',
  });
}

export function createAuthoringSession(seed: AuthoringSessionSeed): AuthoringSession {
  const source = cloneSource(seed.source);
  return Object.freeze({
    token: seed.token,
    draftId: seed.draftId ?? crypto.randomUUID(),
    authority: Object.freeze({ ...seed.authority }),
    source,
    origin: Object.freeze({ ...seed.origin }),
    workspace: Object.freeze({ ...seed.workspace }),
    semantics: semanticsFor(source),
    ...(seed.interaction === undefined ? {} : { interaction: seed.interaction }),
  });
}

export function pendingDraftForAuthoring(input: {
  readonly session: AuthoringSession;
  readonly ownerViewId: string;
  readonly text: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}): PendingReviewDraftV1 {
  const { session } = input;
  const source = session.source;
  const anchor = source.kind === 'replace' || source.kind === 'highlight'
    ? {
        kind: 'selection' as const,
        ...canonicalReviewSelectionEvidence(source.anchor),
      }
    : source.kind === 'insert'
      ? {
          kind: 'caret' as const,
          pageIndex: source.anchor.pageIndex,
          leftContext: source.anchor.leftContext,
          rightContext: source.anchor.rightContext,
          rect: source.anchor.position,
        }
      : source.kind === 'pageNote'
        ? {
            kind: 'page' as const,
            pageIndex: source.pageIndex,
            ...(source.nearbyText === undefined ? {} : { nearbyText: source.nearbyText }),
            rect: source.position,
          }
        : anchorEvidenceFromReviewItem(source.item);
  return Object.freeze({
    id: session.draftId,
    ownerViewId: input.ownerViewId,
    baseGeneration: session.authority.documentGeneration,
    revision: input.revision,
    kind: source.kind === 'edit' ? source.item.kind : source.kind,
    ...(source.kind === 'edit' ? { targetItemId: source.item.id } : {}),
    pageIndex: anchor.pageIndex,
    text: input.text,
    anchor,
    disposition: { kind: 'resolved' as const, generation: session.authority.documentGeneration },
    status: 'protected',
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
}

function payloadPoint(item: ReviewItem): PdfNaturalPoint | null {
  const value = item.payload[item.kind === 'insert' || item.kind === 'pageNote' || item.kind === 'pdfAnnotation'
    ? 'position'
    : 'rect'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = value.x;
  const y = value.y;
  return typeof x === 'number'
    && Number.isFinite(x)
    && x >= 0
    && typeof y === 'number'
    && Number.isFinite(y)
    && y >= 0
    ? Object.freeze({ x, y })
    : null;
}

/** Extracts the immutable page point used only for visibility and Return. */
export function authoringAnchorSnapshot(
  session: AuthoringSession,
): AuthoringAnchorSnapshot {
  const source = session.source;
  const pageIndex = source.kind === 'edit'
    ? source.item.pageIndex
    : source.kind === 'pageNote'
      ? source.pageIndex
      : source.anchor.pageIndex;
  const point = source.kind === 'replace' || source.kind === 'highlight'
    ? { x: source.anchor.rect.x, y: source.anchor.rect.y }
    : source.kind === 'insert'
      ? { x: source.anchor.position.x, y: source.anchor.position.y }
      : source.kind === 'pageNote'
        ? { x: source.position.x, y: source.position.y }
        : payloadPoint(source.item);
  return Object.freeze({
    token: session.token,
    authority: session.authority,
    pageIndex,
    point: point === null ? null : Object.freeze(point),
  });
}

export function canStartAuthoringSession(current: AuthoringSession | null): current is null {
  return current === null;
}

function selectionPayload(
  source: Extract<AuthoringSource, { readonly kind: 'replace' | 'highlight' }>,
): Record<string, JsonValue> {
  return { ...reviewSelectionPayload(source.anchor, { canonical: true }) };
}

function editableField(item: ReviewItem): 'proposedText' | 'comment' | null {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote' || item.kind === 'pdfAnnotation') return 'comment';
  return null;
}

function authoringPreviewItem(
  session: AuthoringSession,
  value: string,
): ReviewItem | null {
  const source = session.source;
  if (source.kind === 'edit') {
    const field = editableField(source.item);
    if (field === null) return null;
    return {
      ...source.item,
      payload: { ...source.item.payload, [field]: value },
    };
  }

  const timestamp = '1970-01-01T00:00:00.000Z';
  const base = {
    id: `authoring-preview:${session.token}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  const item: ReviewItem = source.kind === 'replace'
    ? {
        ...base,
        kind: 'replace',
        pageIndex: source.anchor.pageIndex,
        payload: { ...selectionPayload(source), proposedText: value },
      }
    : source.kind === 'insert'
      ? {
          ...base,
          kind: 'insert',
          pageIndex: source.anchor.pageIndex,
          payload: {
            position: { ...source.anchor.position },
            leftContext: source.anchor.leftContext,
            rightContext: source.anchor.rightContext,
            reliable: true,
            proposedText: value,
          },
        }
      : source.kind === 'highlight'
        ? {
            ...base,
            kind: 'highlight',
            pageIndex: source.anchor.pageIndex,
            payload: {
              ...selectionPayload(source),
              ...(value === '' ? {} : { comment: value }),
            },
          }
        : {
            ...base,
            kind: 'pageNote',
            pageIndex: source.pageIndex,
            payload: {
              position: { ...source.position },
              comment: value,
              ...(source.nearbyText === undefined || source.nearbyText === ''
                ? {}
                : { nearbyText: source.nearbyText }),
            },
          };
  return item;
}

/** Lead-page compatibility projection for callers that still consume one preview. */
export function authoringPreviewAnnotation(
  session: AuthoringSession,
  value: string,
): ReviewAnnotation | null {
  const item = authoringPreviewItem(session, value);
  return item === null ? null : projectReviewItem(item);
}

/** Page-local visual previews backed by one immutable authoring session and draft. */
export function authoringPreviewAnnotations(
  session: AuthoringSession,
  value: string,
): readonly ReviewAnnotation[] {
  const item = authoringPreviewItem(session, value);
  return item === null
    ? []
    : projectReviewItemProjections(item, undefined, { includePortableMetadata: false });
}

export function mutableField(item: ReviewItem): 'proposedText' | 'comment' | undefined {
  if (item.kind === 'replace' || item.kind === 'insert') return 'proposedText';
  if (item.kind === 'highlight' || item.kind === 'pageNote' || item.kind === 'pdfAnnotation') return 'comment';
  return undefined;
}

export function initialAuthoringValue(session: AuthoringSession): string {
  const source = session.source;
  if (source.kind === 'replace' || source.kind === 'insert') return source.initialValue;
  if (source.kind !== 'edit') return '';
  const field = mutableField(source.item);
  return field === undefined ? '' : String(source.item.payload[field] ?? '');
}
