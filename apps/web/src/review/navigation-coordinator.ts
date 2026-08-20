import type { PdfNavigationMetadata } from '../pdf/pdf-navigation-metadata.js';
import {
  pdfNavigationTargetFromPlacekeeperLocation,
  type PdfNavigationTarget,
} from '../pdf/pdf-navigation-target.js';
import type { PdfOutlineDiscovery, PdfOutlineItem } from '../pdf/pdf-outline.js';
import type { ReferenceDocumentController } from '../pdf/reference-document.js';
import type {
  ViewerPdfLinkInvocation,
  ViewerPdfLinkUnavailable,
} from '../pdf/viewer-interaction-events.js';
import type {
  PdfDocumentOrderLocation,
  PdfOutlineTargetOrderLocation,
} from '../pdf/document-order-location.js';
import type { PdfViewerNavigation } from '../pdf/viewer-navigation-adapter.js';
import {
  isPdfViewerLocation,
  samePdfViewerLocation,
  type PdfNaturalPoint,
  type PdfViewerLocation,
} from '../pdf/viewer-navigation.js';
import type { LinkActionChoice } from './LinkActionPopover.js';
import type {
  PendingReferencePanel,
  ReferenceReturnControlState,
} from './ReferenceWorkspace.js';
import type { PlacekeeperLinkLocation } from '../../../../packages/core/src/placekeeper-link.js';
import type { ReviewLocationHistoryPort } from './review-location-history.js';
import type {
  ReferenceNavigationAction,
  ReferenceNavigationState,
} from './reference-navigation-state.js';
import { referenceTabSuccessorIdentity } from './reference-navigation-state.js';

export interface NavigationDestinationMetadata {
  readonly label: string;
  readonly pageContext: string;
}

interface Operation {
  readonly token: number;
  readonly documentGeneration: number;
}

interface PendingReferenceRequest {
  readonly target: PdfNavigationTarget;
  readonly metadata: NavigationDestinationMetadata;
  readonly documentGeneration: number;
}

/** Transient, active-viewer presentation state; never part of durable review navigation. */
export interface ReferenceReturnPresentationState extends ReferenceReturnControlState {
  readonly documentGeneration: number;
}

export interface NavigationCoordinatorDependencies {
  readonly getState: () => ReferenceNavigationState;
  readonly dispatch: (action: ReferenceNavigationAction) => void;
  readonly getMainNavigation: () => PdfViewerNavigation | null;
  readonly getReferenceNavigation: () => PdfViewerNavigation | null;
  readonly waitForReferenceNavigation: () => Promise<PdfViewerNavigation | null>;
  readonly getReferenceController: () => ReferenceDocumentController | null;
  readonly commitMainFramingPosition: () => void;
  readonly layout: {
    readonly revealReferences: () => void;
    readonly hideReferences: () => void;
    readonly hideReferencesAfterSend: () => void;
    readonly settle: () => Promise<void>;
    readonly focusReferenceRail: () => boolean;
    readonly referenceRailFocusToken: () => string;
  };
  readonly setPendingReference: (pending: PendingReferencePanel | null) => void;
  readonly getReferenceReturnState: () => ReferenceReturnPresentationState | null;
  readonly setReferenceReturnState: (state: ReferenceReturnPresentationState | null) => void;
  readonly resetReferenceManualScrollIntent: () => void;
  readonly setLinkActionRequest: (request: ViewerPdfLinkInvocation | null) => void;
  readonly setAnnouncement: (announcement: string) => void;
  readonly focusReferenceTab: (identity: string) => boolean;
  readonly getOutlineDiscovery: () => PdfOutlineDiscovery;
  readonly setCurrentOutlineItemId: (identity: string | null) => void;
  /** Active document page count used to rehydrate generation-free destinations. */
  readonly getPageCount: () => number;
  readonly locationHistory?: ReviewLocationHistoryPort;
  readonly resolvePortableItem?: (itemId: string) => {
    readonly pageIndex: number;
    readonly point: PdfNaturalPoint | null;
  } | null;
}

function metadataFromLink(metadata: PdfNavigationMetadata): NavigationDestinationMetadata {
  return { label: metadata.label, pageContext: metadata.pageContext };
}

function locationOrder(location: PdfDocumentOrderLocation): readonly number[] | null {
  const values = [
    location.pageIndex,
    location.anchor.y,
    location.anchor.x,
  ];
  return values.every(Number.isFinite) ? values : null;
}

export type OutlineTargetOrderLocation = PdfOutlineTargetOrderLocation;

interface OrderedOutlineItem {
  readonly item: PdfOutlineItem;
  readonly location: OutlineTargetOrderLocation;
  readonly order: readonly number[];
  readonly depth: number;
  readonly documentOrder: number;
}

export type OutlineContainmentResolver = (
  currentLocation: PdfDocumentOrderLocation,
) => PdfOutlineItem | null;

function pathContains(ancestor: readonly number[], descendant: readonly number[]): boolean {
  return ancestor.length <= descendant.length
    && ancestor.every((entry, index) => descendant[index] === entry);
}

/** Prepares one fail-closed spatial index for repeated annotation lookups. */
export function createOutlineContainmentResolver(input: {
  readonly discovery: PdfOutlineDiscovery;
  readonly resolveTarget: (target: PdfNavigationTarget) => OutlineTargetOrderLocation | null;
}): OutlineContainmentResolver {
  if (input.discovery.status !== 'loaded-tree') return () => null;
  const orderedItems: OrderedOutlineItem[] = [];
  const deepestPageLevelPath = new Map<number, readonly number[]>();
  const ambiguousPageLevels = new Set<number>();
  let documentOrder = 0;
  let unsafeTarget = false;
  const visit = (items: readonly PdfOutlineItem[], depth: number, parentPath: readonly number[]) => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const itemOrder = documentOrder++;
      const itemPath = [...parentPath, index];
      if (item.target !== null) {
        const location = input.resolveTarget(item.target);
        const order = location === null ? null : locationOrder(location);
        if (order === null) {
          unsafeTarget = true;
        } else if (location !== null) {
          orderedItems.push({ item, location, order, depth, documentOrder: itemOrder });
          if (location.precision === 'page' && !ambiguousPageLevels.has(location.pageIndex)) {
            const deepestPath = deepestPageLevelPath.get(location.pageIndex);
            if (deepestPath === undefined || pathContains(deepestPath, itemPath)) {
              deepestPageLevelPath.set(location.pageIndex, itemPath);
            } else if (!pathContains(itemPath, deepestPath)) {
              ambiguousPageLevels.add(location.pageIndex);
            }
          }
        }
      }
      visit(item.children, depth + 1, itemPath);
    }
  };
  visit(input.discovery.items, 0, []);
  if (unsafeTarget || ambiguousPageLevels.size > 0) return () => null;
  orderedItems.sort((left, right) => (
    compareOrder(left.order, right.order)
    || left.depth - right.depth
    || left.documentOrder - right.documentOrder
  ));

  return (currentLocation) => {
    const currentOrder = locationOrder(currentLocation);
    if (currentOrder === null) return null;
    let low = 0;
    let high = orderedItems.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (compareOrder(orderedItems[middle]!.order, currentOrder) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const best = orderedItems[low - 1];
    if (best === undefined) return null;
    return best.item;
  };
}

/**
 * Finds the deepest safely orderable outline item containing a document
 * location. Page-level targets may tie only when their outline paths form one
 * ancestor chain; unrelated same-page targets are structurally ambiguous.
 */
export function resolveContainingOutlineItem(input: {
  readonly discovery: PdfOutlineDiscovery;
  readonly currentLocation: PdfDocumentOrderLocation;
  readonly resolveTarget: (target: PdfNavigationTarget) => OutlineTargetOrderLocation | null;
}): PdfOutlineItem | null {
  return createOutlineContainmentResolver(input)(input.currentLocation);
}

function compareOrder(first: readonly number[], second: readonly number[]): number {
  for (let index = 0; index < Math.min(first.length, second.length); index += 1) {
    const difference = first[index]! - second[index]!;
    if (difference !== 0) return difference;
  }
  return first.length - second.length;
}

/**
 * Finds the deepest safely orderable bookmark at or before the settled main
 * anchor. If a targeted bookmark cannot be ordered, the result fails closed.
 */
export function resolveCurrentOutlineItemId(input: {
  readonly discovery: PdfOutlineDiscovery;
  readonly currentLocation: PdfViewerLocation;
  readonly resolveTarget: (target: PdfNavigationTarget) => PdfViewerLocation | null;
}): string | null {
  return resolveContainingOutlineItem({
    discovery: input.discovery,
    currentLocation: input.currentLocation,
    resolveTarget: (target) => {
      const location = input.resolveTarget(target);
      return location === null ? null : { ...location, precision: 'exact' };
    },
  })?.id ?? null;
}

const REFERENCE_FAILURE = 'Reference unavailable. Retry when ready.';
const MAIN_FAILURE = 'Destination unavailable. The current location was preserved.';
const HISTORY_FAILURE = 'Document history destination unavailable.';
const LINK_UNAVAILABLE = 'This PDF link cannot be opened safely.';
const INVALID_LOCATION_NOTICE = 'The linked location was invalid. Opened page 1.';
const MISSING_ITEM_NOTICE = 'The exact item is unavailable. Opened its page instead.';

function missingDestinationNotice(page: number): string {
  return `The exact destination is unavailable. Opened page ${page} instead.`;
}

interface SemanticAnchor {
  readonly pageIndex: number;
  readonly anchor: PdfNaturalPoint;
}

interface SemanticItemLocation extends SemanticAnchor {
  readonly itemId: string;
}

function sameSemanticAnchor(location: PdfViewerLocation, semantic: SemanticAnchor): boolean {
  return location.pageIndex === semantic.pageIndex
    && Math.abs(location.anchor.x - semantic.anchor.x) <= 0.01
    && Math.abs(location.anchor.y - semantic.anchor.y) <= 0.01;
}

/**
 * The sole transaction authority for current-document viewer navigation.
 * Reducer mutations, visibility, focus, and announcements happen only while
 * both the operation token and document generation remain current.
 */
export class NavigationCoordinator {
  private operationToken = 0;
  private documentGeneration: number;
  private lastSearchTargetIdentity: string | null = null;
  private pendingReference: PendingReferenceRequest | null = null;
  private linkRequest: ViewerPdfLinkInvocation | null = null;
  private linkRequestSourceTabIdentity: string | null = null;
  /** A Send-selected successor whose saved view is not currently rendered. */
  private referenceRestoreIdentity: string | null = null;
  private semanticItemLocation: SemanticItemLocation | null = null;
  private semanticDestinationLocation: SemanticAnchor | null = null;
  private locationHistoryStarted = false;
  private locationRestored: boolean;
  private disposed = false;

  constructor(private readonly dependencies: NavigationCoordinatorDependencies) {
    this.documentGeneration = dependencies.getState().documentGeneration;
    this.locationRestored = dependencies.locationHistory === undefined;
  }

  startLocationHistory(): void {
    if (this.locationHistoryStarted || this.dependencies.locationHistory === undefined) return;
    this.locationHistoryStarted = true;
    this.dependencies.locationHistory.start((direction) => {
      void this.restoreCurrentLocation(direction);
    });
  }

  async restoreCurrentLocation(
    historyDirection?: 'back' | 'forward' | 'unknown',
  ): Promise<boolean> {
    const history = this.dependencies.locationHistory;
    if (history === undefined) return false;
    let target: PlacekeeperLinkLocation;
    let notice = '';
    try {
      target = history.read();
    } catch {
      target = { kind: 'page', page: 1 };
      history.replace(target);
      notice = INVALID_LOCATION_NOTICE;
    }
    if (target.kind === 'destination') {
      const restore = await this.restoreDestinationLocation(target);
      if (restore === 'restored') {
        this.locationRestored = true;
        this.announceHistoryRestore(historyDirection, target);
        return true;
      }
      if (restore === 'stale') return false;
      const pageCount = this.dependencies.getPageCount();
      const fallbackPage = Number.isSafeInteger(pageCount)
        && pageCount > 0
        && target.page <= pageCount
        ? target.page
        : 1;
      target = { kind: 'page', page: fallbackPage };
      history.replace(target);
      notice = missingDestinationNotice(fallbackPage);
    }
    if (target.kind === 'item') {
      const item = this.dependencies.resolvePortableItem?.(target.itemId) ?? null;
      if (item !== null) {
        const restored = await this.restoreLinkedLocation(target, item);
        if (restored) {
          this.locationRestored = true;
          this.announceHistoryRestore(historyDirection, target);
          return true;
        }
      }
      target = { kind: 'page', page: target.page };
      history.replace(target);
      notice = MISSING_ITEM_NOTICE;
    }
    // A live mount can retain exact geometry behind its readable page entry.
    // Reloaded or mismatched history has no such authority and falls through
    // to the coarse page/item fragment below.
    if (
      notice === ''
      && target.kind === 'page'
      && (historyDirection === 'back' || historyDirection === 'forward')
    ) {
      const state = this.dependencies.getState();
      const offset = historyDirection === 'back' ? -1 : 1;
      const liveDestination = state.mainHistory.entries[state.mainHistory.index + offset];
      if (liveDestination?.pageIndex === target.page - 1) {
        const restored = await this.traverseHistory(historyDirection);
        if (restored) {
          this.locationRestored = true;
          return true;
        }
      }
    }
    // A fresh viewer already starts on page 1. Reapplying that default after
    // mount would create a late scroll jump while the surface is interactive.
    if (
      historyDirection === undefined
      && target.kind === 'page'
      && target.page === 1
    ) {
      this.locationRestored = true;
      this.refreshCurrentOutline();
      if (notice) this.dependencies.setAnnouncement(notice);
      return true;
    }
    const restored = await this.restoreLinkedLocation(target, null);
    this.locationRestored = true;
    if (notice) this.dependencies.setAnnouncement(notice);
    else this.announceHistoryRestore(historyDirection, target);
    return restored;
  }

  requestLink(request: ViewerPdfLinkInvocation): boolean {
    const state = this.dependencies.getState();
    const sourceTabIdentity = request.sourceScope === 'reference'
      && this.pendingReference === null
      && state.pendingReferenceSwitch === null
      && this.referenceRestoreIdentity === null
      && state.activeTabIdentity !== null
      && state.tabs.some((tab) => tab.identity === state.activeTabIdentity)
      ? state.activeTabIdentity
      : null;
    this.supersede();
    if (
      !this.generationMatches(request.target.documentGeneration)
      || (request.sourceScope === 'reference' && sourceTabIdentity === null)
    ) {
      this.linkRequest = null;
      this.linkRequestSourceTabIdentity = null;
      this.dependencies.setLinkActionRequest(null);
      this.dependencies.setAnnouncement(LINK_UNAVAILABLE);
      return false;
    }
    this.pendingReference = null;
    this.dependencies.setPendingReference(null);
    this.linkRequest = request;
    this.linkRequestSourceTabIdentity = sourceTabIdentity;
    this.dependencies.setLinkActionRequest(request);
    return true;
  }

  unavailableLink(_unavailable?: ViewerPdfLinkUnavailable): void {
    this.supersede();
    this.pendingReference = null;
    this.dependencies.setPendingReference(null);
    this.dependencies.setAnnouncement(LINK_UNAVAILABLE);
  }

  unavailableDestination(): void {
    this.supersede();
    this.dependencies.setAnnouncement(MAIN_FAILURE);
  }

  dismissLink(request: ViewerPdfLinkInvocation): void {
    if (this.linkRequest !== request) return;
    this.clearLinkRequest();
  }

  async chooseLink(choice: LinkActionChoice, request: ViewerPdfLinkInvocation): Promise<boolean> {
    if (this.linkRequest !== request || !this.generationMatches(request.target.documentGeneration)) {
      return false;
    }
    const sourceTabIdentity = this.linkRequestSourceTabIdentity;
    this.clearLinkRequest();
    let choiceOperation: Promise<boolean>;
    switch (choice) {
      case 'references':
        choiceOperation = this.openReference(
          request.target,
          metadataFromLink(request.metadata),
        );
        break;
      case 'main':
        choiceOperation = this.navigateMainTarget(request.target, 'direct');
        break;
      case 'same-reference':
        choiceOperation = request.sourceScope === 'reference' && sourceTabIdentity !== null
          ? this.navigateReferenceTarget(request.target, sourceTabIdentity)
          : Promise.resolve(false);
        break;
    }
    const choiceOperationToken = this.operationToken;
    const succeeded = await choiceOperation;
    if (
      !succeeded
      && choice !== 'references'
      && this.operationToken === choiceOperationToken
      && this.generationMatches(request.target.documentGeneration)
      && request.opener.isConnected
    ) {
      request.opener.focus({ preventScroll: true });
    }
    return succeeded;
  }

  private async navigateReferenceTarget(
    target: PdfNavigationTarget,
    sourceTabIdentity: string,
  ): Promise<boolean> {
    const operation = this.begin(target.documentGeneration);
    if (operation === null) return false;
    this.clearReferenceReturnState();
    const state = this.dependencies.getState();
    if (
      state.activeTabIdentity !== sourceTabIdentity
      || !state.tabs.some((tab) => tab.identity === sourceTabIdentity)
    ) return false;

    const navigation = this.dependencies.getReferenceNavigation();
    const origin = navigation?.captureLocation() ?? null;
    if (!navigation || origin === null) {
      this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    this.dependencies.resetReferenceManualScrollIntent();
    const applied = await navigation.applyTarget(target);
    this.dependencies.resetReferenceManualScrollIntent();
    if (!this.isCurrent(operation)) return false;
    if (!applied) {
      this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    const settledLocation = navigation.captureLocation();
    if (settledLocation === null) {
      this.dependencies.resetReferenceManualScrollIntent();
      const restored = await navigation.applyLocation(origin);
      this.dependencies.resetReferenceManualScrollIntent();
      if (!this.isCurrent(operation)) return false;
      const restoredLocation = restored ? navigation.captureLocation() : null;
      if (
        restoredLocation === null
        || !samePdfViewerLocation(origin, restoredLocation, {
          anchor: 0,
          alignment: 0,
          zoom: 0,
        })
      ) {
        this.dependencies.setAnnouncement(REFERENCE_FAILURE);
        return false;
      }
      this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    const currentState = this.dependencies.getState();
    if (
      currentState.activeTabIdentity !== sourceTabIdentity
      || !currentState.tabs.some((tab) => tab.identity === sourceTabIdentity)
    ) return false;
    this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation });
    navigation.focusAtDestination(settledLocation.pageIndex);
    this.dependencies.setAnnouncement('Reference destination opened.');
    return true;
  }

  /** Re-evaluates the active origin only after user intent is paired with a Reference scroll. */
  observeReferenceManualScroll(): void {
    this.updateReferenceReturnAvailability(true);
  }

  /** Rechecks an already-established affordance after layout without creating manual intent. */
  async refreshReferenceReturnAvailability(): Promise<void> {
    const current = this.dependencies.getReferenceReturnState();
    if (current?.available !== true || current.pending) return;
    await this.dependencies.layout.settle();
    const state = this.dependencies.getState();
    const latest = this.dependencies.getReferenceReturnState();
    if (
      latest?.available !== true
      || latest.pending
      || latest.tabIdentity !== current.tabIdentity
      || latest.documentGeneration !== current.documentGeneration
      || state.activeTabIdentity !== current.tabIdentity
      || state.documentGeneration !== current.documentGeneration
    ) return;
    this.updateReferenceReturnAvailability(false);
  }

  /** Clears transient state when the reusable Reference navigation adapter is disposed. */
  referenceNavigationUnavailable(): void {
    this.dependencies.resetReferenceManualScrollIntent();
    this.clearReferenceReturnState();
  }

  async returnToReference(tabIdentity: string): Promise<boolean> {
    const state = this.dependencies.getState();
    const tab = state.activeTabIdentity === tabIdentity
      ? state.tabs.find((candidate) => candidate.identity === tabIdentity) ?? null
      : null;
    const presentation = this.dependencies.getReferenceReturnState();
    if (
      tab === null
      || tab.originalTarget.documentGeneration !== state.documentGeneration
      || presentation === null
      || presentation.tabIdentity !== tabIdentity
      || presentation.documentGeneration !== state.documentGeneration
      || !presentation.available
      || presentation.pending
    ) return false;

    const operation = this.beginReferenceReturn(state.documentGeneration);
    if (operation === null) return false;
    const navigation = this.dependencies.getReferenceNavigation();
    if (navigation === null) return this.failReferenceReturn(operation, presentation);
    this.dependencies.setReferenceReturnState({ ...presentation, pending: true });
    const settledLocation = await this.applyReferenceTargetAfterLayout(
      operation,
      navigation,
      tab.originalTarget,
    );
    if (!this.isCurrent(operation)) return false;
    if (this.dependencies.getReferenceNavigation() !== navigation) return false;
    const current = this.dependencies.getState();
    const currentTab = current.activeTabIdentity === tabIdentity
      ? current.tabs.find((candidate) => candidate.identity === tabIdentity) ?? null
      : null;
    if (
      settledLocation === null
      || currentTab === null
      || currentTab.originalTarget.identity !== tab.originalTarget.identity
      || current.documentGeneration !== operation.documentGeneration
    ) return this.failReferenceReturn(operation, presentation);

    this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation });
    this.dependencies.setReferenceReturnState(null);
    this.dependencies.setAnnouncement('Returned to reference.');
    navigation.focusAtDestination(settledLocation.pageIndex);
    return true;
  }

  async openReference(
    target: PdfNavigationTarget,
    metadata: NavigationDestinationMetadata,
    preservedMainTarget?: PdfNavigationTarget | null,
  ): Promise<boolean> {
    const operation = this.begin(target.documentGeneration);
    if (operation === null) return false;
    this.clearReferenceReturnState();
    const state = this.dependencies.getState();
    const existing = state.tabs.find((tab) => tab.identity === target.identity);
    const preserveMain = preservedMainTarget !== undefined;
    const main = preserveMain ? this.dependencies.getMainNavigation() : undefined;
    const mainLocation = main?.captureLocation() ?? null;
    const restoreMainLocation = async () => {
      if (!preserveMain) return true;
      if (main && preservedMainTarget !== null) return main.applyTarget(preservedMainTarget);
      const shifted = main?.captureLocation() ?? null;
      return !main
        || !mainLocation
        || samePdfViewerLocation(mainLocation, shifted)
        || main.applyLocation(mainLocation);
    };
    const failPreservingMain = async () => {
      if (preserveMain) {
        await this.dependencies.layout.settle();
        if (!this.isCurrent(operation)) return false;
        await restoreMainLocation();
        if (!this.isCurrent(operation)) return false;
      }
      return this.failReference(operation);
    };
    if (!existing && preserveMain) {
      this.pendingReference = {
        target,
        metadata,
        documentGeneration: operation.documentGeneration,
      };
      this.dependencies.setPendingReference({ status: 'loading', ...metadata });
    }

    this.dependencies.dispatch({ type: 'select-workspace-mode', mode: 'references' });
    this.dependencies.layout.revealReferences();
    if (existing) {
      this.pendingReference = null;
      this.dependencies.setPendingReference(null);
      if (!preserveMain) {
        await this.dependencies.layout.settle();
        if (!this.isCurrent(operation)) return false;
      }
      if (!await this.restoreReferenceTab(operation, existing.identity, false)) return false;
      if (!this.isCurrent(operation)) return false;
      if (preserveMain) {
        await this.dependencies.layout.settle();
        if (!this.isCurrent(operation)) return false;
        if (!await restoreMainLocation() || !this.isCurrent(operation)) return false;
      }
      this.dependencies.focusReferenceTab(existing.identity);
      this.dependencies.setAnnouncement(`Reference active: ${metadata.label}.`);
      return true;
    }

    if (!preserveMain) {
      this.pendingReference = {
        target,
        metadata,
        documentGeneration: operation.documentGeneration,
      };
      this.dependencies.setPendingReference({ status: 'loading', ...metadata });
    }

    if (
      state.activeTabIdentity !== null
      && this.referenceRestoreIdentity !== state.activeTabIdentity
    ) {
      const outgoingLocation = this.dependencies.getReferenceNavigation()?.captureLocation() ?? null;
      if (outgoingLocation !== null) {
        this.dependencies.dispatch({
          type: 'refresh-active-reference',
          settledLocation: outgoingLocation,
        });
      }
    }

    const opened = await this.dependencies.getReferenceController()?.open() ?? false;
    if (!this.isCurrent(operation)) return false;
    if (!opened) return failPreservingMain();
    const navigation = this.dependencies.getReferenceNavigation()
      ?? await this.dependencies.waitForReferenceNavigation();
    if (!this.isCurrent(operation)) return false;
    if (!navigation) return failPreservingMain();
    const settledLocation = await this.applyReferenceTargetAfterLayout(
      operation,
      navigation,
      target,
    );
    if (settledLocation === null) return failPreservingMain();

    this.dependencies.dispatch({
      type: 'open-reference',
      target,
      settledLocation,
      label: metadata.label,
      pageContext: metadata.pageContext,
    });
    // Reference mounting can settle the shared runway more than once. Restore
    // Main only after the tab and its final layout are committed so the viewer
    // does not visibly chase the same search target through each intermediate frame.
    if (preserveMain) {
      await this.dependencies.layout.settle();
      if (!this.isCurrent(operation)) return false;
      if (!await restoreMainLocation() || !this.isCurrent(operation)) return false;
    }
    this.pendingReference = null;
    this.referenceRestoreIdentity = null;
    this.dependencies.setPendingReference(null);
    this.dependencies.focusReferenceTab(target.identity);
    this.dependencies.setAnnouncement(`Reference opened: ${metadata.label}.`);
    this.refreshCurrentOutline();
    return true;
  }

  async retryReference(): Promise<boolean> {
    const pending = this.pendingReference;
    const controller = this.dependencies.getReferenceController();
    if (
      pending === null
      || controller === null
      || pending.documentGeneration !== this.documentGeneration
      || controller.snapshot().documentGeneration !== this.documentGeneration
    ) return false;
    const status = controller.snapshot().status;
    if (status !== 'failed' && status !== 'loaded') return false;
    const operation = this.begin(pending.documentGeneration, true);
    if (operation === null) return false;
    this.clearReferenceReturnState();
    this.dependencies.setPendingReference({ status: 'loading', ...pending.metadata });
    const opened = status === 'failed' ? await controller.retry() : true;
    if (!this.isCurrent(operation)) return false;
    if (!opened) return this.failReference(operation);
    const navigation = this.dependencies.getReferenceNavigation()
      ?? await this.dependencies.waitForReferenceNavigation();
    if (!this.isCurrent(operation)) return false;
    if (!navigation) return this.failReference(operation);
    const settledLocation = await this.applyReferenceTargetAfterLayout(
      operation,
      navigation,
      pending.target,
    );
    if (settledLocation === null) return this.failReference(operation);
    this.dependencies.dispatch({
      type: 'open-reference',
      target: pending.target,
      settledLocation,
      label: pending.metadata.label,
      pageContext: pending.metadata.pageContext,
    });
    this.pendingReference = null;
    this.referenceRestoreIdentity = null;
    this.dependencies.setPendingReference(null);
    this.dependencies.focusReferenceTab(pending.target.identity);
    this.dependencies.setAnnouncement(`Reference opened: ${pending.metadata.label}.`);
    return true;
  }

  async switchReference(identity: string): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    this.clearReferenceReturnState();
    await this.dependencies.layout.settle();
    if (!this.isCurrent(operation)) return false;
    return this.restoreReferenceTab(operation, identity);
  }

  async openReferencesWorkspace(): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    this.clearReferenceReturnState();
    this.dependencies.dispatch({ type: 'select-workspace-mode', mode: 'references' });
    this.dependencies.layout.revealReferences();
    await this.dependencies.layout.settle();
    if (!this.isCurrent(operation)) return false;

    const state = this.dependencies.getState();
    const identity = state.activeTabIdentity;
    const tab = identity === null
      ? null
      : state.tabs.find((candidate) => candidate.identity === identity) ?? null;
    if (tab === null) return true;
    const navigation = this.dependencies.getReferenceNavigation();
    const live = navigation?.captureLocation() ?? null;
    if (!navigation || live === null) {
      this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    if (this.referenceRestoreIdentity === tab.identity) {
      this.dependencies.resetReferenceManualScrollIntent();
      const applied = await navigation.applyLocation(tab.settledLocation);
      this.dependencies.resetReferenceManualScrollIntent();
      if (!this.isCurrent(operation)) return false;
      const settled = applied ? navigation.captureLocation() : null;
      if (!applied || settled === null) {
        this.dependencies.setAnnouncement(REFERENCE_FAILURE);
        return false;
      }
      this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation: settled });
      this.referenceRestoreIdentity = null;
    } else {
      this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation: live });
    }
    this.dependencies.focusReferenceTab(tab.identity);
    this.dependencies.setAnnouncement('References workspace opened.');
    return true;
  }

  async closeReference(identity: string): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    this.clearReferenceReturnState();
    const state = this.dependencies.getState();
    const index = state.tabs.findIndex((tab) => tab.identity === identity);
    if (index < 0) return false;
    if (state.activeTabIdentity !== identity) {
      this.dependencies.dispatch({
        type: 'close-reference',
        targetIdentity: identity,
        focusReturnToken: this.dependencies.layout.referenceRailFocusToken(),
      });
      this.dependencies.setAnnouncement('Reference closed.');
      return true;
    }

    const successorIdentity = referenceTabSuccessorIdentity(state.tabs, index);
    if (successorIdentity !== null) {
      if (!await this.restoreReferenceTab(operation, successorIdentity, false)) return false;
      if (!this.isCurrent(operation)) return false;
      this.dependencies.dispatch({
        type: 'close-reference',
        targetIdentity: identity,
        focusReturnToken: this.dependencies.layout.referenceRailFocusToken(),
      });
      this.dependencies.focusReferenceTab(successorIdentity);
      this.dependencies.setAnnouncement('Reference closed. Adjacent reference active.');
      return true;
    }

    this.dependencies.dispatch({
      type: 'close-reference',
      targetIdentity: identity,
      focusReturnToken: this.dependencies.layout.referenceRailFocusToken(),
    });
    this.dependencies.layout.hideReferences();
    await this.dependencies.getReferenceController()?.close();
    if (!this.isCurrent(operation)) return false;
    await this.dependencies.layout.settle();
    if (!this.isCurrent(operation)) return false;
    this.dependencies.layout.focusReferenceRail();
    this.dependencies.setAnnouncement('Final reference closed.');
    return true;
  }

  async sendToMain(identity: string): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    this.clearReferenceReturnState();
    const state = this.dependencies.getState();
    if (state.activeTabIdentity !== identity) return false;
    const reference = this.dependencies.getReferenceNavigation();
    const main = this.dependencies.getMainNavigation();
    const referenceLocation = reference?.captureLocation() ?? null;
    const mainLocation = main?.captureLocation() ?? null;
    if (!reference || !main || referenceLocation === null || mainLocation === null) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation: referenceLocation });
    this.dependencies.dispatch({
      type: 'request-send-to-main',
      token: operation.token,
      currentMainLocation: mainLocation,
    });
    const finalReference = state.tabs.length === 1;
    if (finalReference) {
      this.dependencies.layout.hideReferences();
      await this.dependencies.layout.settle();
      if (!this.isCurrent(operation)) return false;
    }
    const applied = await main.applyLocation(referenceLocation);
    if (!this.isCurrent(operation)) return false;
    // applyLocation only succeeds after the destination is verified. During
    // the accompanying tray reflow, a fresh geometry capture can still be
    // transiently unavailable; keep the verified destination authoritative
    // so a visibly completed Send cannot leave its source tab behind.
    const settledLocation = applied ? main.captureLocation() ?? referenceLocation : null;
    if (!applied || settledLocation === null) {
      this.dependencies.dispatch({
        type: 'complete-send-to-main',
        token: operation.token,
        documentGeneration: operation.documentGeneration,
        success: false,
      });
      if (finalReference) {
        this.dependencies.layout.revealReferences();
        await this.dependencies.layout.settle();
        if (!this.isCurrent(operation)) return false;
      }
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }

    // Adopt the verified semantic destination as the workspace framing
    // baseline before consuming the source tab. This prevents an open Search
    // workspace from restoring its pre-send position during the ensuing reflow.
    this.dependencies.commitMainFramingPosition();
    this.dependencies.dispatch({
      type: 'complete-send-to-main',
      token: operation.token,
      documentGeneration: operation.documentGeneration,
      success: true,
      settledLocation,
    });
    if (finalReference) this.dependencies.layout.hideReferencesAfterSend();
    const survivingIdentity = this.dependencies.getState().activeTabIdentity;
    this.referenceRestoreIdentity = survivingIdentity;
    this.dependencies.setAnnouncement('Reference sent to the main document.');
    this.refreshCurrentOutline(settledLocation);
    this.projectExplicitLocation({ kind: 'page', page: settledLocation.pageIndex + 1 }, null);

    if (survivingIdentity !== null) {
      const restored = await this.restoreReferenceTab(operation, survivingIdentity, false);
      if (!this.isCurrent(operation)) return true;
      if (!restored) {
        this.dependencies.setAnnouncement(
          'Reference sent to the main document. Select the adjacent reference to retry it.',
        );
      }
      main.focusAtDestination(settledLocation.pageIndex);
      this.dependencies.focusReferenceTab(survivingIdentity);
      return true;
    }

    await Promise.all([
      this.dependencies.layout.settle(),
      this.dependencies.getReferenceController()?.close() ?? Promise.resolve(),
    ]);
    if (!this.isCurrent(operation)) return true;
    main.focusAtDestination(settledLocation.pageIndex);
    return true;
  }

  async navigateMainTarget(
    target: PdfNavigationTarget,
    kind: 'direct' | 'outline' | 'search',
  ): Promise<boolean> {
    const operation = this.begin(target.documentGeneration);
    if (operation === null) return false;
    const main = this.dependencies.getMainNavigation();
    if (!main) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    await main.cancelPendingNavigation();
    if (!this.isCurrent(operation)) return false;
    const currentLocation = main.captureLocation();
    const destination = main.resolveTarget(target);
    if (currentLocation === null || destination === null) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    const sameLocation = samePdfViewerLocation(currentLocation, destination);
    if (sameLocation && (kind !== 'search' || this.lastSearchTargetIdentity === target.identity)) {
      if (kind === 'direct' || kind === 'search') {
        this.dependencies.layout.hideReferences();
        await this.dependencies.layout.settle();
        if (this.isCurrent(operation)) main.focusAtDestination(destination.pageIndex);
      }
      if (this.isCurrent(operation)) {
        this.dependencies.setAnnouncement(
          kind === 'outline' ? 'Outline destination is already current.' : 'Main document destination is already current.',
        );
        this.refreshCurrentOutline(currentLocation);
      }
      return true;
    }
    const settledLocation = await this.applyMainJump(
      operation,
      main,
      currentLocation,
      destination,
      () => main.applyTarget(target),
      kind === 'search',
    );
    if (!this.isCurrent(operation)) return false;
    if (settledLocation === null) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    this.dependencies.setAnnouncement(
      kind === 'outline' ? 'Outline destination opened.' : 'Main document destination opened.',
    );
    this.projectExplicitLocation({ kind: 'page', page: settledLocation.pageIndex + 1 }, null);
    if (kind === 'search') this.lastSearchTargetIdentity = target.identity;
    this.refreshCurrentOutline(settledLocation);
    if (kind === 'direct' || kind === 'search') {
      this.dependencies.layout.hideReferences();
      await this.dependencies.layout.settle();
      if (this.isCurrent(operation)) main.focusAtDestination(settledLocation.pageIndex);
    }
    return true;
  }

  async navigateMainAnnotation(input: {
    readonly pageIndex: number;
    readonly point: PdfNaturalPoint | null;
    readonly portableItemId?: string;
    readonly linkFallbackNotice?: string;
  }): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    const main = this.dependencies.getMainNavigation();
    if (!main) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    await main.cancelPendingNavigation();
    if (!this.isCurrent(operation)) return false;
    const currentLocation = main.captureLocation();
    if (currentLocation === null) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    const anchor = input.point !== null
      && Number.isFinite(input.point.x)
      && Number.isFinite(input.point.y)
      && input.point.x >= 0
      && input.point.y >= 0
      ? input.point
      : { x: 0, y: 0 };
    const destination: PdfViewerLocation = {
      pageIndex: input.pageIndex,
      anchor,
      alignment: { xPercent: 50, yPercent: 35 },
      zoom: currentLocation.zoom,
    };
    if (!isPdfViewerLocation(destination)) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    if (samePdfViewerLocation(currentLocation, destination)) {
      main.focusAtDestination(destination.pageIndex);
      this.dependencies.setAnnouncement(input.linkFallbackNotice === undefined
        ? 'Annotation destination is already current.'
        : `Annotation destination is already current. ${input.linkFallbackNotice}`);
      this.refreshCurrentOutline(currentLocation);
      return true;
    }
    const settledLocation = await this.applyMainJump(
      operation,
      main,
      currentLocation,
      destination,
      () => main.applyLocation(destination),
    );
    if (!this.isCurrent(operation)) return false;
    if (settledLocation === null) {
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    main.focusAtDestination(settledLocation.pageIndex);
    this.dependencies.setAnnouncement(input.linkFallbackNotice === undefined
      ? 'Annotation destination opened.'
      : `Annotation destination opened. ${input.linkFallbackNotice}`);
    this.projectExplicitLocation(
      input.portableItemId === undefined
        ? { kind: 'page', page: settledLocation.pageIndex + 1 }
        : { kind: 'item', page: settledLocation.pageIndex + 1, itemId: input.portableItemId },
      input.portableItemId === undefined ? null : settledLocation,
    );
    this.refreshCurrentOutline(settledLocation);
    return true;
  }

  historyBack(): Promise<boolean> {
    if (this.dependencies.locationHistory !== undefined) {
      return Promise.resolve(this.dependencies.locationHistory.back());
    }
    return this.traverseHistory('back');
  }

  historyForward(): Promise<boolean> {
    if (this.dependencies.locationHistory !== undefined) {
      return Promise.resolve(this.dependencies.locationHistory.forward());
    }
    return this.traverseHistory('forward');
  }

  currentLinkLocation(): PlacekeeperLinkLocation {
    const fromHistory = this.safeHistoryLocation();
    if (fromHistory !== null) return fromHistory;
    const current = this.dependencies.getMainNavigation()?.captureLocation() ?? null;
    return { kind: 'page', page: current === null ? 1 : current.pageIndex + 1 };
  }

  downgradeCurrentItemLocation(): void {
    const current = this.safeHistoryLocation();
    if (current?.kind !== 'item') return;
    this.semanticItemLocation = null;
    this.dependencies.locationHistory?.replace({ kind: 'page', page: current.page });
  }

  refreshMainLocation(): void {
    const state = this.dependencies.getState();
    if (state.pendingMainNavigation !== null || state.pendingSendToMain !== null) return;
    const location = this.dependencies.getMainNavigation()?.captureLocation() ?? null;
    if (location === null || !this.generationMatches(state.documentGeneration)) return;
    this.dependencies.dispatch({ type: 'refresh-main-location', location });
    if (!this.locationRestored) {
      this.refreshCurrentOutline(location);
      return;
    }
    if (this.semanticItemLocation !== null && sameSemanticAnchor(location, this.semanticItemLocation)) {
      this.refreshCurrentOutline(location);
      return;
    }
    if (
      this.semanticDestinationLocation !== null
      && sameSemanticAnchor(location, this.semanticDestinationLocation)
    ) {
      this.refreshCurrentOutline(location);
      return;
    }
    this.semanticItemLocation = null;
    this.semanticDestinationLocation = null;
    const current = this.safeHistoryLocation();
    if (current?.kind !== 'page' || current.page !== location.pageIndex + 1) {
      this.dependencies.locationHistory?.replace({ kind: 'page', page: location.pageIndex + 1 });
    }
    this.refreshCurrentOutline(location);
  }

  refreshCurrentOutline(location?: PdfViewerLocation): void {
    const navigation = this.dependencies.getMainNavigation();
    const currentLocation = location ?? navigation?.captureLocation() ?? null;
    if (!navigation || currentLocation === null) {
      this.dependencies.setCurrentOutlineItemId(null);
      return;
    }
    this.dependencies.setCurrentOutlineItemId(resolveCurrentOutlineItemId({
      discovery: this.dependencies.getOutlineDiscovery(),
      currentLocation,
      resolveTarget: (target) => navigation.resolveTarget(target),
    }));
  }

  replaceDocument(documentGeneration: number): void {
    if (!Number.isSafeInteger(documentGeneration) || documentGeneration < 0) return;
    this.dependencies.resetReferenceManualScrollIntent();
    this.clearReferenceReturnState();
    this.operationToken += 1;
    this.documentGeneration = documentGeneration;
    this.lastSearchTargetIdentity = null;
    this.pendingReference = null;
    this.linkRequest = null;
    this.linkRequestSourceTabIdentity = null;
    this.referenceRestoreIdentity = null;
    this.semanticItemLocation = null;
    this.semanticDestinationLocation = null;
    this.locationRestored = this.dependencies.locationHistory === undefined;
    this.dependencies.getMainNavigation()?.replaceDocument(documentGeneration);
    this.dependencies.getReferenceNavigation()?.replaceDocument(documentGeneration);
    void this.dependencies.getReferenceController()?.replaceDocument(documentGeneration);
    this.dependencies.dispatch({ type: 'replace-document', documentGeneration });
    this.dependencies.setLinkActionRequest(null);
    this.dependencies.setPendingReference(null);
    this.dependencies.layout.hideReferences();
    this.dependencies.setCurrentOutlineItemId(null);
    this.dependencies.setAnnouncement('');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dependencies.resetReferenceManualScrollIntent();
    this.clearReferenceReturnState();
    this.operationToken += 1;
    this.pendingReference = null;
    this.linkRequest = null;
    this.linkRequestSourceTabIdentity = null;
    this.referenceRestoreIdentity = null;
    this.semanticItemLocation = null;
    this.semanticDestinationLocation = null;
    this.dependencies.locationHistory?.dispose();
    void this.dependencies.getReferenceController()?.close();
  }

  private async applyReferenceTargetAfterLayout(
    operation: Operation,
    navigation: PdfViewerNavigation,
    target: PdfNavigationTarget,
  ): Promise<PdfViewerLocation | null> {
    await this.dependencies.layout.settle();
    if (!this.isCurrent(operation)) return null;
    this.dependencies.resetReferenceManualScrollIntent();
    const applied = await navigation.applyTarget(target, 'reference-fit-width');
    this.dependencies.resetReferenceManualScrollIntent();
    if (!applied) return null;
    if (!this.isCurrent(operation)) return null;
    return navigation.captureLocation();
  }

  private async restoreReferenceTab(
    operation: Operation,
    identity: string,
    announce = true,
  ): Promise<boolean> {
    const state = this.dependencies.getState();
    const incoming = state.tabs.find((tab) => tab.identity === identity);
    const navigation = this.dependencies.getReferenceNavigation();
    const outgoingLocation = navigation?.captureLocation() ?? null;
    if (!incoming || !navigation || outgoingLocation === null) {
      if (announce && this.isCurrent(operation)) this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    if (state.activeTabIdentity === identity) {
      if (this.referenceRestoreIdentity === identity) {
        const settledLocation = await this.restoreReferenceLocation(
          operation,
          navigation,
          incoming,
        );
        if (settledLocation === null) {
          if (announce) this.dependencies.setAnnouncement(REFERENCE_FAILURE);
          return false;
        }
        this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation });
        this.referenceRestoreIdentity = null;
      } else {
        this.dependencies.dispatch({ type: 'refresh-active-reference', settledLocation: outgoingLocation });
      }
      if (announce) {
        this.dependencies.focusReferenceTab(identity);
        this.dependencies.setAnnouncement('Reference active.');
      }
      return true;
    }
    this.dependencies.dispatch({
      type: 'request-reference-switch',
      token: operation.token,
      targetIdentity: identity,
      outgoingLocation: this.referenceRestoreIdentity === state.activeTabIdentity
        ? state.tabs.find((tab) => tab.identity === state.activeTabIdentity)?.settledLocation
          ?? outgoingLocation
        : outgoingLocation,
    });
    const settledLocation = await this.restoreReferenceLocation(
      operation,
      navigation,
      incoming,
    );
    if (settledLocation === null) {
      this.dependencies.dispatch({
        type: 'complete-reference-switch',
        token: operation.token,
        documentGeneration: operation.documentGeneration,
        success: false,
      });
      if (announce) this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    this.dependencies.dispatch({
      type: 'complete-reference-switch',
      token: operation.token,
      documentGeneration: operation.documentGeneration,
      success: true,
      settledLocation,
    });
    this.referenceRestoreIdentity = null;
    if (announce) {
      this.dependencies.focusReferenceTab(identity);
      this.dependencies.setAnnouncement('Reference active.');
    }
    return true;
  }

  private async restoreReferenceLocation(
    operation: Operation,
    navigation: PdfViewerNavigation,
    tab: ReferenceNavigationState['tabs'][number],
  ): Promise<PdfViewerLocation | null> {
    this.dependencies.resetReferenceManualScrollIntent();
    let applied = await navigation.applyLocation(tab.settledLocation);
    this.dependencies.resetReferenceManualScrollIntent();
    if (!this.isCurrent(operation)) return null;
    if (!applied) {
      this.dependencies.resetReferenceManualScrollIntent();
      applied = await navigation.applyTarget(tab.originalTarget, 'reference-fit-width');
      this.dependencies.resetReferenceManualScrollIntent();
      if (!this.isCurrent(operation)) return null;
    }
    return applied ? navigation.captureLocation() : null;
  }

  private async traverseHistory(kind: 'back' | 'forward'): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    const state = this.dependencies.getState();
    const destinationIndex = state.mainHistory.index + (kind === 'back' ? -1 : 1);
    const destination = state.mainHistory.entries[destinationIndex];
    const main = this.dependencies.getMainNavigation();
    const currentLocation = main?.captureLocation() ?? null;
    if (!main || !destination || currentLocation === null) return false;
    this.dependencies.dispatch({
      type: kind === 'back' ? 'request-history-back' : 'request-history-forward',
      token: operation.token,
      currentLocation,
    });
    const applied = await main.applyLocation(destination);
    if (!this.isCurrent(operation)) return false;
    if (!applied || main.captureLocation() === null) {
      this.dependencies.dispatch({
        type: 'complete-history-navigation',
        token: operation.token,
        documentGeneration: operation.documentGeneration,
        success: false,
      });
      this.dependencies.setAnnouncement(HISTORY_FAILURE);
      return false;
    }
    this.dependencies.dispatch({
      type: 'complete-history-navigation',
      token: operation.token,
      documentGeneration: operation.documentGeneration,
      success: true,
    });
    main.focusAtDestination(destination.pageIndex);
    this.dependencies.setAnnouncement(kind === 'back'
      ? 'Moved back in document history.'
      : 'Moved forward in document history.');
    this.refreshCurrentOutline(destination);
    return true;
  }

  private async restoreLinkedLocation(
    target: PlacekeeperLinkLocation,
    item: { readonly pageIndex: number; readonly point: PdfNaturalPoint | null } | null,
  ): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
    const main = this.dependencies.getMainNavigation();
    if (main === null) return false;
    await main.cancelPendingNavigation();
    if (!this.isCurrent(operation)) return false;
    const current = main.captureLocation();
    if (current === null) return false;
    const pageIndex = item?.pageIndex ?? target.page - 1;
    const anchor = item?.point ?? { x: 0, y: 0 };
    const destination: PdfViewerLocation = {
      pageIndex,
      anchor,
      alignment: item === null ? { xPercent: 0, yPercent: 0 } : { xPercent: 50, yPercent: 35 },
      zoom: current.zoom,
    };
    if (!isPdfViewerLocation(destination)) return false;
    const applied = await main.applyLocation(destination);
    if (!this.isCurrent(operation)) return false;
    const settled = applied ? main.captureLocation() : null;
    if (settled === null) {
      const actual = main.captureLocation();
      if (actual !== null) {
        this.dependencies.locationHistory?.replace({ kind: 'page', page: actual.pageIndex + 1 });
      }
      this.semanticItemLocation = null;
      return false;
    }
    if (target.kind === 'item') {
      this.semanticItemLocation = {
        itemId: target.itemId,
        pageIndex: settled.pageIndex,
        anchor: settled.anchor,
      };
    } else {
      this.semanticItemLocation = null;
    }
    this.semanticDestinationLocation = null;
    main.focusAtDestination(settled.pageIndex);
    this.refreshCurrentOutline(settled);
    return true;
  }

  private async restoreDestinationLocation(
    location: Extract<PlacekeeperLinkLocation, { readonly kind: 'destination' }>,
  ): Promise<'restored' | 'unavailable' | 'stale'> {
    const operation = this.begin();
    if (operation === null) return 'stale';
    const main = this.dependencies.getMainNavigation();
    if (main === null) return 'unavailable';
    const target = pdfNavigationTargetFromPlacekeeperLocation(location, {
      documentGeneration: operation.documentGeneration,
      pageCount: this.dependencies.getPageCount(),
    });
    if (target === null) return 'unavailable';
    await main.cancelPendingNavigation();
    if (!this.isCurrent(operation)) return 'stale';
    const applied = await main.applyTarget(target);
    if (!this.isCurrent(operation)) return 'stale';
    const settled = applied ? main.captureLocation() : null;
    if (settled === null) {
      this.semanticDestinationLocation = null;
      return 'unavailable';
    }
    this.semanticItemLocation = null;
    this.semanticDestinationLocation = {
      pageIndex: settled.pageIndex,
      anchor: settled.anchor,
    };
    main.focusAtDestination(settled.pageIndex);
    this.refreshCurrentOutline(settled);
    return 'restored';
  }

  private projectExplicitLocation(
    location: PlacekeeperLinkLocation,
    settled: PdfViewerLocation | null,
  ): void {
    if (location.kind === 'item' && settled !== null) {
      this.semanticItemLocation = {
        itemId: location.itemId,
        pageIndex: settled.pageIndex,
        anchor: settled.anchor,
      };
    } else {
      this.semanticItemLocation = null;
    }
    this.semanticDestinationLocation = null;
    this.dependencies.locationHistory?.push(location);
  }

  private safeHistoryLocation(): PlacekeeperLinkLocation | null {
    try {
      return this.dependencies.locationHistory?.read() ?? null;
    } catch {
      return null;
    }
  }

  private announceHistoryRestore(
    direction: 'back' | 'forward' | 'unknown' | undefined,
    location: PlacekeeperLinkLocation,
  ): void {
    if (direction === undefined) return;
    if (direction === 'back') {
      this.dependencies.setAnnouncement('Moved back in document history.');
      return;
    }
    if (direction === 'forward') {
      this.dependencies.setAnnouncement('Moved forward in document history.');
      return;
    }
    this.dependencies.setAnnouncement(
      location.kind === 'item'
        ? `Restored linked item on page ${location.page}.`
        : location.kind === 'destination'
          ? `Restored exact destination on page ${location.page}.`
          : `Restored page ${location.page}.`,
    );
  }

  private async applyMainJump(
    operation: Operation,
    main: PdfViewerNavigation,
    currentLocation: PdfViewerLocation,
    destination: PdfViewerLocation,
    apply: () => Promise<boolean>,
    force = false,
  ): Promise<PdfViewerLocation | null> {
    this.dependencies.dispatch({
      type: 'request-main-jump',
      token: operation.token,
      currentLocation,
      destination,
      ...(force ? { force: true } : {}),
    });
    const applied = await apply();
    if (!this.isCurrent(operation)) return null;
    const settledLocation = applied ? main.captureLocation() : null;
    this.dependencies.dispatch({
      type: 'complete-main-jump',
      token: operation.token,
      documentGeneration: operation.documentGeneration,
      success: settledLocation !== null,
      ...(settledLocation === null ? {} : { settledLocation }),
    });
    return settledLocation;
  }

  private updateReferenceReturnAvailability(allowEstablish: boolean): void {
    const state = this.dependencies.getState();
    const identity = state.activeTabIdentity;
    const current = this.dependencies.getReferenceReturnState();
    const tab = identity === null
      ? null
      : state.tabs.find((candidate) => candidate.identity === identity) ?? null;
    const currentMatches = current !== null
      && current.tabIdentity === identity
      && current.documentGeneration === state.documentGeneration;
    if (
      tab === null
      || tab.originalTarget.documentGeneration !== state.documentGeneration
      || current?.pending === true
    ) {
      if (!currentMatches || tab === null) this.clearReferenceReturnState();
      return;
    }
    const navigation = this.dependencies.getReferenceNavigation();
    const visibility = navigation?.targetVisibility(tab.originalTarget) ?? 'unavailable';
    if (visibility === 'visible') {
      this.clearReferenceReturnState();
      return;
    }
    if (visibility === 'unavailable') {
      if (!currentMatches) this.clearReferenceReturnState();
      return;
    }
    if (!allowEstablish && !currentMatches) return;
    if (currentMatches && current.available && !current.pending) return;
    this.dependencies.setReferenceReturnState({
      tabIdentity: tab.identity,
      documentGeneration: state.documentGeneration,
      available: true,
      pending: false,
    });
  }

  private failReferenceReturn(
    operation: Operation,
    presentation: ReferenceReturnPresentationState,
  ): false {
    if (!this.isCurrent(operation)) return false;
    const state = this.dependencies.getState();
    if (
      state.activeTabIdentity === presentation.tabIdentity
      && state.documentGeneration === presentation.documentGeneration
      && state.tabs.some((tab) => tab.identity === presentation.tabIdentity)
    ) {
      this.dependencies.setReferenceReturnState({ ...presentation, pending: false });
      this.dependencies.setAnnouncement(REFERENCE_FAILURE);
    }
    return false;
  }

  private clearReferenceReturnState(): void {
    if (this.dependencies.getReferenceReturnState() !== null) {
      this.dependencies.setReferenceReturnState(null);
    }
  }

  private failReference(operation: Operation): false {
    if (!this.isCurrent(operation)) return false;
    const pending = this.pendingReference;
    if (pending !== null) {
      this.dependencies.setPendingReference({ status: 'error', ...pending.metadata });
    }
    this.dependencies.setAnnouncement(REFERENCE_FAILURE);
    return false;
  }

  private begin(
    documentGeneration = this.documentGeneration,
    preservePendingReference = false,
  ): Operation | null {
    if (!this.generationMatches(documentGeneration)) return null;
    this.dependencies.resetReferenceManualScrollIntent();
    this.clearLinkRequest();
    this.cancelPendingTransactions(preservePendingReference);
    return {
      token: ++this.operationToken,
      documentGeneration: this.documentGeneration,
    };
  }

  private beginReferenceReturn(documentGeneration: number): Operation | null {
    if (!this.generationMatches(documentGeneration)) return null;
    const state = this.dependencies.getState();
    if (
      state.pendingMainNavigation !== null
      || state.pendingReferenceSwitch !== null
      || state.pendingSendToMain !== null
    ) return null;
    this.dependencies.resetReferenceManualScrollIntent();
    this.dependencies.getReferenceNavigation()?.cancelPendingNavigation();
    return {
      token: ++this.operationToken,
      documentGeneration: this.documentGeneration,
    };
  }

  private supersede(): void {
    this.clearLinkRequest();
    this.cancelPendingTransactions();
    this.operationToken += 1;
  }

  private cancelPendingTransactions(preservePendingReference = false): void {
    this.dependencies.getMainNavigation()?.cancelPendingNavigation();
    this.dependencies.getReferenceNavigation()?.cancelPendingNavigation();
    this.dependencies.dispatch({ type: 'cancel-pending-navigation' });
    if (!preservePendingReference && this.pendingReference !== null) {
      this.pendingReference = null;
      this.dependencies.setPendingReference(null);
    }
  }

  private clearLinkRequest(): void {
    if (this.linkRequest === null && this.linkRequestSourceTabIdentity === null) return;
    this.linkRequest = null;
    this.linkRequestSourceTabIdentity = null;
    this.dependencies.setLinkActionRequest(null);
  }

  private generationMatches(documentGeneration: number): boolean {
    return !this.disposed
      && documentGeneration === this.documentGeneration
      && this.dependencies.getState().documentGeneration === this.documentGeneration;
  }

  private isCurrent(operation: Operation): boolean {
    return this.generationMatches(operation.documentGeneration)
      && operation.token === this.operationToken;
  }
}
