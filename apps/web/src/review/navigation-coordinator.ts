import type { PdfNavigationMetadata } from '../pdf/pdf-navigation-metadata.js';
import type { PdfNavigationTarget } from '../pdf/pdf-navigation-target.js';
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
  samePdfViewerLocation,
  type PdfViewerLocation,
} from '../pdf/viewer-navigation.js';
import type { LinkActionChoice } from './LinkActionPopover.js';
import type { PendingReferencePanel } from './ReferenceWorkspace.js';
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

export interface NavigationCoordinatorDependencies {
  readonly getState: () => ReferenceNavigationState;
  readonly dispatch: (action: ReferenceNavigationAction) => void;
  readonly getMainNavigation: () => PdfViewerNavigation | null;
  readonly getReferenceNavigation: () => PdfViewerNavigation | null;
  readonly waitForReferenceNavigation: () => Promise<PdfViewerNavigation | null>;
  readonly getReferenceController: () => ReferenceDocumentController | null;
  readonly layout: {
    readonly revealReferences: () => void;
    readonly hideReferences: () => void;
    readonly hideReferencesAfterSend: () => void;
    readonly settle: () => Promise<void>;
    readonly focusReferenceRail: () => boolean;
    readonly referenceRailFocusToken: () => string;
  };
  readonly setPendingReference: (pending: PendingReferencePanel | null) => void;
  readonly setLinkActionRequest: (request: ViewerPdfLinkInvocation | null) => void;
  readonly setAnnouncement: (announcement: string) => void;
  readonly focusReferenceTab: (identity: string) => boolean;
  readonly getOutlineDiscovery: () => PdfOutlineDiscovery;
  readonly setCurrentOutlineItemId: (identity: string | null) => void;
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
  private disposed = false;

  constructor(private readonly dependencies: NavigationCoordinatorDependencies) {
    this.documentGeneration = dependencies.getState().documentGeneration;
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
    const applied = await navigation.applyTarget(target);
    if (!this.isCurrent(operation)) return false;
    if (!applied) {
      this.dependencies.setAnnouncement(REFERENCE_FAILURE);
      return false;
    }
    const settledLocation = navigation.captureLocation();
    if (settledLocation === null) {
      const restored = await navigation.applyLocation(origin);
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

  async openReference(
    target: PdfNavigationTarget,
    metadata: NavigationDestinationMetadata,
    preservedMainTarget?: PdfNavigationTarget | null,
  ): Promise<boolean> {
    const operation = this.begin(target.documentGeneration);
    if (operation === null) return false;
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
    await this.dependencies.layout.settle();
    if (!this.isCurrent(operation)) return false;
    return this.restoreReferenceTab(operation, identity);
  }

  async openReferencesWorkspace(): Promise<boolean> {
    const operation = this.begin();
    if (operation === null) return false;
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
      const applied = await navigation.applyLocation(tab.settledLocation);
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

    this.dependencies.dispatch({
      type: 'complete-send-to-main',
      token: operation.token,
      documentGeneration: operation.documentGeneration,
      success: true,
      settledLocation,
    });
    // Applying the destination can recompose the workspace. Reassert the
    // final-reference postcondition after Main settles so the consumed
    // References surface cannot remain visible as an empty tray.
    if (finalReference) this.dependencies.layout.hideReferencesAfterSend();
    const survivingIdentity = this.dependencies.getState().activeTabIdentity;
    this.referenceRestoreIdentity = survivingIdentity;
    this.dependencies.setAnnouncement('Reference sent to the main document.');
    this.refreshCurrentOutline(settledLocation);

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
    const reapplied = await main.applyLocation(settledLocation);
    if (!this.isCurrent(operation)) return true;
    const finalLocation = reapplied ? main.captureLocation() : null;
    if (finalLocation === null) {
      this.dependencies.setAnnouncement(
        'Reference sent to the main document, but its view could not be restored after closing References.',
      );
      return true;
    }
    this.dependencies.dispatch({ type: 'refresh-main-location', location: finalLocation });
    main.focusAtDestination(finalLocation.pageIndex);
    return true;
  }

  async navigateMainTarget(
    target: PdfNavigationTarget,
    kind: 'direct' | 'outline' | 'search',
  ): Promise<boolean> {
    const operation = this.begin(target.documentGeneration);
    if (operation === null) return false;
    const main = this.dependencies.getMainNavigation();
    const currentLocation = main?.captureLocation() ?? null;
    const destination = main?.resolveTarget(target) ?? null;
    if (!main || currentLocation === null || destination === null) {
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
    this.dependencies.dispatch({
      type: 'request-main-jump',
      token: operation.token,
      currentLocation,
      destination,
      ...(sameLocation && kind === 'search' ? { force: true } : {}),
    });
    const applied = await main.applyTarget(target);
    if (!this.isCurrent(operation)) return false;
    const settledLocation = applied ? main.captureLocation() : null;
    if (!applied || settledLocation === null) {
      this.dependencies.dispatch({
        type: 'complete-main-jump',
        token: operation.token,
        documentGeneration: operation.documentGeneration,
        success: false,
      });
      this.dependencies.setAnnouncement(MAIN_FAILURE);
      return false;
    }
    this.dependencies.dispatch({
      type: 'complete-main-jump',
      token: operation.token,
      documentGeneration: operation.documentGeneration,
      success: true,
      settledLocation,
    });
    this.dependencies.setAnnouncement(
      kind === 'outline' ? 'Outline destination opened.' : 'Main document destination opened.',
    );
    if (kind === 'search') this.lastSearchTargetIdentity = target.identity;
    this.refreshCurrentOutline(settledLocation);
    if (kind === 'direct' || kind === 'search') {
      this.dependencies.layout.hideReferences();
      await this.dependencies.layout.settle();
      if (this.isCurrent(operation)) main.focusAtDestination(settledLocation.pageIndex);
    }
    return true;
  }

  historyBack(): Promise<boolean> {
    return this.traverseHistory('back');
  }

  historyForward(): Promise<boolean> {
    return this.traverseHistory('forward');
  }

  refreshMainLocation(): void {
    const state = this.dependencies.getState();
    if (state.pendingMainNavigation !== null || state.pendingSendToMain !== null) return;
    const location = this.dependencies.getMainNavigation()?.captureLocation() ?? null;
    if (location === null || !this.generationMatches(state.documentGeneration)) return;
    this.dependencies.dispatch({ type: 'refresh-main-location', location });
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
    this.operationToken += 1;
    this.documentGeneration = documentGeneration;
    this.lastSearchTargetIdentity = null;
    this.pendingReference = null;
    this.linkRequest = null;
    this.linkRequestSourceTabIdentity = null;
    this.referenceRestoreIdentity = null;
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
    this.operationToken += 1;
    this.pendingReference = null;
    this.linkRequest = null;
    this.linkRequestSourceTabIdentity = null;
    this.referenceRestoreIdentity = null;
    void this.dependencies.getReferenceController()?.close();
  }

  private async applyReferenceTargetAfterLayout(
    operation: Operation,
    navigation: PdfViewerNavigation,
    target: PdfNavigationTarget,
  ): Promise<PdfViewerLocation | null> {
    await this.dependencies.layout.settle();
    if (!this.isCurrent(operation)) return null;
    if (!await navigation.applyTarget(target, 'reference-fit-width')) return null;
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
    let applied = await navigation.applyLocation(tab.settledLocation);
    if (!this.isCurrent(operation)) return null;
    if (!applied) {
      applied = await navigation.applyTarget(tab.originalTarget, 'reference-fit-width');
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
    this.clearLinkRequest();
    this.cancelPendingTransactions(preservePendingReference);
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
