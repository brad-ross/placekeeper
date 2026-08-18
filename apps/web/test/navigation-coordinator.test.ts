import { PdfZoomMode } from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import type { PlacekeeperLinkLocation } from '../../../packages/core/src/placekeeper-link.js';
import type { PdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';
import { createPdfNavigationMetadata } from '../src/pdf/pdf-navigation-metadata.js';
import type { ViewerPdfLinkInvocation } from '../src/pdf/viewer-interaction-events.js';
import type { ReferenceDocumentController } from '../src/pdf/reference-document.js';
import type { PdfViewerNavigation } from '../src/pdf/viewer-navigation-adapter.js';
import type { PdfViewerLocation } from '../src/pdf/viewer-navigation.js';
import {
  createOutlineContainmentResolver,
  NavigationCoordinator,
  resolveContainingOutlineItem,
  resolveCurrentOutlineItemId,
  type ReferenceReturnPresentationState,
  type OutlineTargetOrderLocation,
  type NavigationCoordinatorDependencies,
} from '../src/review/navigation-coordinator.js';
import type { ReviewLocationHistoryPort } from '../src/review/review-location-history.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationAction,
  type ReferenceNavigationState,
} from '../src/review/reference-navigation-state.js';

const location = (pageIndex: number, y = 10, zoom = 1): PdfViewerLocation => ({
  pageIndex,
  anchor: { x: 12, y },
  alignment: { xPercent: 50, yPercent: 35 },
  zoom,
});

const target = (pageIndex: number, generation = 1): PdfNavigationTarget => ({
  documentGeneration: generation,
  pageIndex,
  zoom: { mode: PdfZoomMode.XYZ, params: [12, 700 - pageIndex * 10, 1] },
  identity: JSON.stringify([generation, pageIndex, PdfZoomMode.XYZ, 12, 700 - pageIndex * 10, 1]),
});

const linkRequest = (
  pageIndex: number,
  sourceScope: 'main' | 'reference' = 'reference',
): ViewerPdfLinkInvocation => ({
  sourceScope,
  sourcePageIndex: 0,
  target: target(pageIndex),
  metadata: createPdfNavigationMetadata({ contents: `Target ${pageIndex}`, pageIndex }),
  opener: { isConnected: true, focus: vi.fn() } as unknown as HTMLButtonElement,
  clientRect: { left: 1, top: 1, right: 2, bottom: 2, width: 1, height: 1 },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function navigation(initial = location(0)) {
  let current = initial;
  return {
    controls: {
      captureLocation: vi.fn<() => PdfViewerLocation | null>(() => current),
      captureDocumentOrderPages: vi.fn(() => []),
      resolveTarget: vi.fn((value: PdfNavigationTarget) => location(value.pageIndex)),
      targetVisibility: vi.fn<PdfViewerNavigation['targetVisibility']>(() => 'visible'),
      applyTarget: vi.fn(async (value: PdfNavigationTarget) => {
        current = location(value.pageIndex);
        return true;
      }),
      applyLocation: vi.fn(async (value: PdfViewerLocation) => {
        current = value;
        return true;
      }),
      fitToWidth: vi.fn(async () => true),
      fitToWidthReady: vi.fn(() => true),
      cancelPendingNavigation: vi.fn(),
      replaceDocument: vi.fn(),
      focusAtDestination: vi.fn(() => true),
      dispose: vi.fn(),
    } satisfies PdfViewerNavigation,
    set(value: PdfViewerLocation) { current = value; },
  };
}

function locationHistory(initial: PlacekeeperLinkLocation = { kind: 'page', page: 1 }) {
  let current = initial;
  let onPop: (direction: 'back' | 'forward' | 'unknown') => void = () => undefined;
  let snapshot = { canBack: false, canForward: false };
  const history: ReviewLocationHistoryPort = {
    start: vi.fn((listener) => { onPop = listener; }),
    read: vi.fn(() => current),
    replace: vi.fn((location) => { current = location; }),
    push: vi.fn((location) => {
      current = location;
      snapshot = { canBack: true, canForward: false };
    }),
    back: vi.fn(() => snapshot.canBack),
    forward: vi.fn(() => snapshot.canForward),
    snapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener) => {
      listener(snapshot);
      return () => undefined;
    }),
    dispose: vi.fn(),
  };
  return {
    history,
    set(location: PlacekeeperLinkLocation) { current = location; },
    pop(location: PlacekeeperLinkLocation) {
      current = location;
      onPop('unknown');
    },
    failRead() { vi.mocked(history.read).mockImplementation(() => { throw new Error('invalid'); }); },
  };
}

function harness(options: {
  readonly sharedReferenceSurface?: boolean;
  readonly locationHistory?: ReturnType<typeof locationHistory>;
  readonly portableItems?: ReadonlyMap<string, { readonly pageIndex: number; readonly point: { readonly x: number; readonly y: number } | null }>;
} = {}) {
  let state: ReferenceNavigationState = createReferenceNavigationState(1);
  let referencesOpen = false;
  let pending: Parameters<NavigationCoordinatorDependencies['setPendingReference']>[0] = null;
  let referenceReturn: ReferenceReturnPresentationState | null = null;
  let announcement = '';
  const setAnnouncement = vi.fn((value: string) => { announcement = value; });
  const dispatch = vi.fn((action: ReferenceNavigationAction) => {
    state = reduceReferenceNavigation(state, action);
  });
  const main = navigation(location(0));
  const reference = navigation(location(2));
  const controller: ReferenceDocumentController = {
    open: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    replaceDocument: vi.fn(async () => undefined),
    snapshot: vi.fn(() => ({ documentGeneration: 1, status: 'idle' as const })),
  };
  const dependencies: NavigationCoordinatorDependencies = {
    getState: () => state,
    dispatch,
    getMainNavigation: () => main.controls,
    getReferenceNavigation: () => reference.controls,
    waitForReferenceNavigation: async () => reference.controls,
    getReferenceController: () => controller,
    commitMainFramingPosition: vi.fn(),
    layout: {
      revealReferences: vi.fn(() => { referencesOpen = true; }),
      hideReferences: vi.fn(() => { referencesOpen = false; }),
      hideReferencesAfterSend: vi.fn(() => {
        if (!options.sharedReferenceSurface || state.workspace.lastMode === 'references') {
          referencesOpen = false;
        }
      }),
      settle: vi.fn(async () => undefined),
      focusReferenceRail: vi.fn(() => true),
      referenceRailFocusToken: vi.fn(() => 'rail:bottom-references'),
    },
    setPendingReference: (value) => { pending = value; },
    getReferenceReturnState: () => referenceReturn,
    setReferenceReturnState: (value) => { referenceReturn = value; },
    resetReferenceManualScrollIntent: vi.fn(),
    setLinkActionRequest: vi.fn(),
    setAnnouncement,
    focusReferenceTab: vi.fn(() => true),
    getOutlineDiscovery: () => ({ status: 'loaded-empty', documentGeneration: state.documentGeneration }),
    setCurrentOutlineItemId: vi.fn(),
    ...(options.locationHistory === undefined ? {} : {
      locationHistory: options.locationHistory.history,
      resolvePortableItem: (itemId: string) => options.portableItems?.get(itemId) ?? null,
    }),
  };
  return {
    coordinator: new NavigationCoordinator(dependencies),
    dependencies,
    main,
    reference,
    controller,
    state: () => state,
    referencesOpen: () => referencesOpen,
    reopenReferences: () => { referencesOpen = true; },
    pending: () => pending,
    referenceReturn: () => referenceReturn,
    announcement: () => announcement,
  };
}

describe('document-scoped navigation coordinator', () => {
  it('restores distinct initial pages, leaves the current page stable, and converges invalid hashes', async () => {
    const validLocation = locationHistory({ kind: 'page', page: 4 });
    const valid = harness({ locationHistory: validLocation });
    valid.coordinator.startLocationHistory();

    expect(await valid.coordinator.restoreCurrentLocation()).toBe(true);
    expect(valid.main.controls.applyLocation).toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 3 }));
    expect(validLocation.history.replace).not.toHaveBeenCalled();

    const alreadyCurrentLocation = locationHistory();
    const alreadyCurrent = harness({ locationHistory: alreadyCurrentLocation });
    alreadyCurrent.coordinator.startLocationHistory();
    expect(await alreadyCurrent.coordinator.restoreCurrentLocation()).toBe(true);
    expect(alreadyCurrent.main.controls.applyLocation).not.toHaveBeenCalled();

    const invalidLocation = locationHistory();
    invalidLocation.failRead();
    const invalid = harness({ locationHistory: invalidLocation });
    invalid.coordinator.startLocationHistory();
    expect(await invalid.coordinator.restoreCurrentLocation()).toBe(true);
    expect(invalidLocation.history.replace).toHaveBeenCalledWith({ kind: 'page', page: 1 });
    expect(invalid.announcement()).toContain('page 1');
  });

  it('restores a portable item exactly and falls back to its encoded page when missing', async () => {
    const itemId = '00000000-0000-4000-8000-000000000044';
    const exactLocation = locationHistory({ kind: 'item', page: 5, itemId });
    const exact = harness({
      locationHistory: exactLocation,
      portableItems: new Map([[itemId, { pageIndex: 4, point: { x: 12, y: 160 } }]]),
    });
    exact.coordinator.startLocationHistory();
    expect(await exact.coordinator.restoreCurrentLocation()).toBe(true);
    expect(exact.main.controls.applyLocation).toHaveBeenCalledWith(location(4, 160));
    expect(exactLocation.history.replace).not.toHaveBeenCalled();

    const missingLocation = locationHistory({ kind: 'item', page: 5, itemId });
    const missing = harness({ locationHistory: missingLocation });
    missing.coordinator.startLocationHistory();
    expect(await missing.coordinator.restoreCurrentLocation()).toBe(true);
    expect(missingLocation.history.replace).toHaveBeenCalledWith({ kind: 'page', page: 5 });
    expect(missing.announcement()).toContain('exact item');
  });

  it('uses exact live locations for directed browser history and page fragments as fallback', async () => {
    const browser = locationHistory();
    const live = harness({ locationHistory: browser });
    live.coordinator.startLocationHistory();
    expect(await live.coordinator.restoreCurrentLocation()).toBe(true);
    expect(await live.coordinator.navigateMainTarget(target(2), 'outline')).toBe(true);

    browser.set({ kind: 'page', page: 1 });
    vi.mocked(live.main.controls.applyLocation).mockClear();
    expect(await live.coordinator.restoreCurrentLocation('back')).toBe(true);
    expect(live.main.controls.applyLocation).toHaveBeenLastCalledWith(location(0));

    browser.set({ kind: 'page', page: 3 });
    vi.mocked(live.main.controls.applyLocation).mockClear();
    expect(await live.coordinator.restoreCurrentLocation('forward')).toBe(true);
    expect(live.main.controls.applyLocation).toHaveBeenLastCalledWith(location(2));
    expect(browser.history.push).toHaveBeenCalledOnce();

    browser.failRead();
    vi.mocked(live.main.controls.applyLocation).mockClear();
    expect(await live.coordinator.restoreCurrentLocation('back')).toBe(true);
    expect(live.main.controls.applyLocation).toHaveBeenLastCalledWith(expect.objectContaining({
      pageIndex: 0,
      anchor: { x: 0, y: 0 },
      alignment: { xPercent: 0, yPercent: 0 },
    }));
    expect(live.announcement()).toContain('page 1');

    const reloadedBrowser = locationHistory({ kind: 'page', page: 3 });
    const reloaded = harness({ locationHistory: reloadedBrowser });
    reloaded.coordinator.startLocationHistory();
    expect(await reloaded.coordinator.restoreCurrentLocation('forward')).toBe(true);
    expect(reloaded.main.controls.applyLocation).toHaveBeenLastCalledWith(expect.objectContaining({
      pageIndex: 2,
      anchor: { x: 0, y: 0 },
      alignment: { xPercent: 0, yPercent: 0 },
    }));
  });

  it('pushes successful explicit jumps once and never pushes failed or semantic no-op jumps', async () => {
    const browser = locationHistory();
    const run = harness({ locationHistory: browser });
    run.coordinator.startLocationHistory();

    expect(await run.coordinator.navigateMainTarget(target(3), 'direct')).toBe(true);
    expect(browser.history.push).toHaveBeenCalledOnce();
    expect(browser.history.push).toHaveBeenLastCalledWith({ kind: 'page', page: 4 });

    expect(await run.coordinator.navigateMainTarget(target(3), 'outline')).toBe(true);
    expect(browser.history.push).toHaveBeenCalledOnce();

    vi.mocked(run.main.controls.applyTarget).mockResolvedValueOnce(false);
    expect(await run.coordinator.navigateMainTarget(target(6), 'direct')).toBe(false);
    expect(browser.history.push).toHaveBeenCalledOnce();
  });

  it('keeps an item fragment through zoom settling and clears it only after moving away', async () => {
    const itemId = '00000000-0000-4000-8000-000000000055';
    const browser = locationHistory();
    const run = harness({ locationHistory: browser });
    run.coordinator.startLocationHistory();
    expect(await run.coordinator.restoreCurrentLocation()).toBe(true);

    expect(await run.coordinator.navigateMainAnnotation({
      pageIndex: 3,
      point: { x: 12, y: 160 },
      portableItemId: itemId,
    })).toBe(true);
    expect(browser.history.push).toHaveBeenLastCalledWith({ kind: 'item', page: 4, itemId });

    run.main.set(location(3, 160, 1.8));
    run.coordinator.refreshMainLocation();
    expect(browser.history.replace).not.toHaveBeenCalled();

    run.main.set(location(3, 220, 1.8));
    run.coordinator.refreshMainLocation();
    expect(browser.history.replace).toHaveBeenLastCalledWith({ kind: 'page', page: 4 });
  });

  it('downgrades a current item link when saving is no longer clean and explains page fallback', async () => {
    const itemId = '00000000-0000-4000-8000-000000000066';
    const browser = locationHistory({ kind: 'item', page: 3, itemId });
    const run = harness({ locationHistory: browser });
    run.coordinator.startLocationHistory();
    run.coordinator.downgradeCurrentItemLocation();
    expect(browser.history.replace).toHaveBeenCalledWith({ kind: 'page', page: 3 });

    expect(await run.coordinator.navigateMainAnnotation({
      pageIndex: 2,
      point: { x: 12, y: 160 },
      linkFallbackNotice: 'The shareable link uses this page until the item is saved.',
    })).toBe(true);
    expect(browser.history.push).toHaveBeenCalledWith({ kind: 'page', page: 3 });
    expect(run.announcement()).toContain('until the item is saved');
  });

  it('lets popstate supersede stale work and restores without recursively writing history', async () => {
    const browser = locationHistory();
    const run = harness({ locationHistory: browser });
    run.coordinator.startLocationHistory();
    const apply = deferred<boolean>();
    vi.mocked(run.main.controls.applyTarget).mockImplementationOnce(() => apply.promise);
    const stale = run.coordinator.navigateMainTarget(target(5), 'direct');
    await vi.waitFor(() => expect(run.main.controls.applyTarget).toHaveBeenCalled());

    browser.pop({ kind: 'page', page: 2 });
    await vi.waitFor(() => expect(run.main.controls.applyLocation)
      .toHaveBeenCalledWith(expect.objectContaining({ pageIndex: 1 })));
    apply.resolve(true);
    expect(await stale).toBe(false);
    expect(browser.history.push).not.toHaveBeenCalled();
    expect(browser.history.replace).not.toHaveBeenCalled();
  });

  it('cancels the reducer transaction before a newer link supersedes deferred viewer work', async () => {
    const run = harness();
    const applied = deferred<boolean>();
    let cancelled = false;
    vi.mocked(run.main.controls.cancelPendingNavigation).mockImplementation(() => {
      cancelled = true;
    });
    vi.mocked(run.main.controls.applyTarget).mockImplementationOnce(async () => {
      await applied.promise;
      if (!cancelled) run.main.set(location(3));
      return !cancelled;
    });
    const stale = run.coordinator.navigateMainTarget(target(3), 'direct');
    await vi.waitFor(() => expect(run.state().pendingMainNavigation).not.toBeNull());

    const newest: ViewerPdfLinkInvocation = {
      sourceScope: 'main',
      sourcePageIndex: 2,
      target: target(5),
      metadata: createPdfNavigationMetadata({ contents: 'Newest', pageIndex: 5 }),
      opener: {} as HTMLButtonElement,
      clientRect: { left: 1, top: 1, right: 2, bottom: 2, width: 1, height: 1 },
    };
    expect(run.coordinator.requestLink(newest)).toBe(true);
    expect(run.state().pendingMainNavigation).toBeNull();
    expect(run.main.controls.cancelPendingNavigation).toHaveBeenCalled();
    expect(run.reference.controls.cancelPendingNavigation).toHaveBeenCalled();

    applied.resolve(true);
    expect(await stale).toBe(false);
    expect(run.main.controls.captureLocation()?.pageIndex).toBe(0);
    expect(run.state().pendingMainNavigation).toBeNull();
    expect(run.state().mainHistory.entries).toEqual([]);
  });

  it('clears a superseded pending reference request and loading panel', async () => {
    const run = harness();
    const opened = deferred<boolean>();
    vi.mocked(run.controller.open).mockReturnValueOnce(opened.promise);

    const stale = run.coordinator.openReference(target(3), {
      label: 'Pending proof', pageContext: 'Page 4',
    });
    expect(run.pending()).toMatchObject({ status: 'loading' });

    expect(await run.coordinator.switchReference('missing')).toBe(false);
    expect(run.pending()).toBeNull();
    opened.resolve(true);
    expect(await stale).toBe(false);
  });

  it('keeps a verified main jump committed when newer work arrives during workspace settlement', async () => {
    const run = harness();
    const settled = deferred<void>();
    vi.mocked(run.dependencies.layout.settle).mockReturnValueOnce(settled.promise);

    const jump = run.coordinator.navigateMainTarget(target(3), 'direct');
    await vi.waitFor(() => {
      expect(run.state().pendingMainNavigation).toBeNull();
      expect(run.state().mainHistory.entries.map(({ pageIndex }) => pageIndex)).toEqual([0, 3]);
      expect(run.dependencies.layout.settle).toHaveBeenCalledOnce();
    });

    run.coordinator.unavailableDestination();
    settled.resolve();
    expect(await jump).toBe(true);
    expect(run.state().mainHistory.entries.map(({ pageIndex }) => pageIndex)).toEqual([0, 3]);
    expect(run.main.controls.focusAtDestination).not.toHaveBeenCalled();
  });

  it('promotes a reference only after clone open and verified target application', async () => {
    const run = harness();
    const opened = deferred<boolean>();
    vi.mocked(run.controller.open).mockReturnValueOnce(opened.promise);

    const operation = run.coordinator.openReference(target(3), {
      label: 'Equation (4)', pageContext: 'Page 4',
    });
    expect(run.referencesOpen()).toBe(true);
    expect(run.pending()).toMatchObject({ status: 'loading', label: 'Equation (4)' });
    expect(run.state().tabs).toEqual([]);

    opened.resolve(true);
    expect(await operation).toBe(true);
    expect(run.dependencies.layout.settle).toHaveBeenCalledOnce();
    expect(run.reference.controls.applyTarget)
      .toHaveBeenCalledWith(target(3), 'reference-fit-width');
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(3).identity]);
    expect(run.pending()).toBeNull();
    expect(run.dependencies.focusReferenceTab).toHaveBeenCalledWith(target(3).identity);
    expect(run.announcement()).toContain('Equation (4)');
  });

  it('does not apply a stale reference target after layout settlement is superseded', async () => {
    const run = harness();
    const settled = deferred<void>();
    vi.mocked(run.dependencies.layout.settle).mockReturnValueOnce(settled.promise);

    const stale = run.coordinator.openReference(target(3), {
      label: 'Pending proof', pageContext: 'Page 4',
    });
    await vi.waitFor(() => expect(run.dependencies.layout.settle).toHaveBeenCalledOnce());
    run.coordinator.unavailableDestination();
    settled.resolve();

    expect(await stale).toBe(false);
    expect(run.reference.controls.applyTarget).not.toHaveBeenCalled();
    expect(run.state().tabs).toEqual([]);
  });

  it('routes the newest main/reference viewer link through the chooser and real reducer', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), {
      label: 'Source reference', pageContext: 'Page 3',
    });
    const first = linkRequest(2, 'main');
    const newest = linkRequest(5, 'reference');
    expect(run.coordinator.requestLink(first)).toBe(true);
    expect(run.coordinator.requestLink(newest)).toBe(true);
    expect(run.dependencies.setLinkActionRequest).toHaveBeenLastCalledWith(newest);
    expect(await run.coordinator.chooseLink('references', first)).toBe(false);
    expect(await run.coordinator.chooseLink('references', newest)).toBe(true);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([
      target(2).identity,
      target(5).identity,
    ]);
    expect(run.referencesOpen()).toBe(true);
  });

  it('rejects a reference link while the first durable tab is still loading', async () => {
    const run = harness();
    const opened = deferred<boolean>();
    vi.mocked(run.controller.open).mockReturnValueOnce(opened.promise);
    const opening = run.coordinator.openReference(target(2), {
      label: 'Pending source', pageContext: 'Page 3',
    });
    expect(run.pending()).toMatchObject({ status: 'loading' });

    expect(run.coordinator.requestLink(linkRequest(5))).toBe(false);
    expect(run.dependencies.setLinkActionRequest).toHaveBeenLastCalledWith(null);
    expect(run.announcement()).toBe('This PDF link cannot be opened safely.');

    opened.resolve(true);
    expect(await opening).toBe(false);
    expect(run.state().tabs).toEqual([]);
  });

  it('rejects a reference link while the shared viewer is opening another tab', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), {
      label: 'Stable source', pageContext: 'Page 3',
    });
    const opened = deferred<boolean>();
    vi.mocked(run.controller.open).mockReturnValueOnce(opened.promise);
    const opening = run.coordinator.openReference(target(4), {
      label: 'Incoming reference', pageContext: 'Page 5',
    });
    expect(run.pending()).toMatchObject({ status: 'loading' });

    expect(run.coordinator.requestLink(linkRequest(6))).toBe(false);
    expect(run.dependencies.setLinkActionRequest).toHaveBeenLastCalledWith(null);
    expect(run.state().activeTabIdentity).toBe(target(2).identity);

    opened.resolve(true);
    expect(await opening).toBe(false);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(2).identity]);
  });

  it('follows a reference link in the active tab without changing main state or tab identity', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), {
      label: 'Primary result', pageContext: 'Page 2',
    });
    const before = run.state();
    const sourceTab = before.tabs[0]!;
    const mainLocation = run.main.controls.captureLocation();
    const request = linkRequest(5);
    vi.mocked(run.main.controls.applyTarget).mockClear();
    vi.mocked(run.main.controls.applyLocation).mockClear();

    expect(run.coordinator.requestLink(request)).toBe(true);
    expect(await run.coordinator.chooseLink('same-reference', request)).toBe(true);

    const after = run.state();
    expect(after.tabs).toHaveLength(1);
    expect(after.activeTabIdentity).toBe(sourceTab.identity);
    expect(after.tabs[0]).toMatchObject({
      identity: sourceTab.identity,
      originalTarget: sourceTab.originalTarget,
      label: sourceTab.label,
      pageContext: sourceTab.pageContext,
      settledLocation: location(5),
    });
    expect(after.mainHistory).toEqual(before.mainHistory);
    expect(run.main.controls.captureLocation()).toEqual(mainLocation);
    expect(run.main.controls.applyTarget).not.toHaveBeenCalled();
    expect(run.main.controls.applyLocation).not.toHaveBeenCalled();
    expect(run.reference.controls.applyTarget).toHaveBeenCalledWith(request.target);
    expect(run.reference.controls.focusAtDestination).toHaveBeenCalledWith(5);
  });

  it('rejects same-reference choices from main or after the active tab changes', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const mainRequest = linkRequest(4, 'main');
    expect(run.coordinator.requestLink(mainRequest)).toBe(true);
    expect(await run.coordinator.chooseLink('same-reference', mainRequest)).toBe(false);

    await run.coordinator.openReference(target(4), { label: 'B', pageContext: 'Page 5' });
    const referenceRequest = linkRequest(6);
    expect(run.coordinator.requestLink(referenceRequest)).toBe(true);
    await run.coordinator.switchReference(target(2).identity);
    vi.mocked(run.reference.controls.applyTarget).mockClear();

    expect(await run.coordinator.chooseLink('same-reference', referenceRequest)).toBe(false);
    expect(run.state().activeTabIdentity).toBe(target(2).identity);
    expect(run.reference.controls.applyTarget).not.toHaveBeenCalled();
  });

  it('restores the reference origin when post-apply settlement capture fails', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), {
      label: 'Primary result', pageContext: 'Page 2',
    });
    const origin = location(2);
    const before = run.state();
    const request = linkRequest(5);
    vi.mocked(run.reference.controls.captureLocation)
      .mockReturnValueOnce(origin)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(origin);

    expect(run.coordinator.requestLink(request)).toBe(true);
    expect(await run.coordinator.chooseLink('same-reference', request)).toBe(false);

    expect(run.reference.controls.applyLocation).toHaveBeenCalledWith(origin);
    expect(run.state()).toEqual(before);
    expect(run.announcement()).toBe('Reference unavailable. Retry when ready.');
  });

  it('leaves tab state untouched when the post-apply origin restore fails', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), {
      label: 'Primary result', pageContext: 'Page 2',
    });
    const origin = location(2);
    const before = run.state();
    const request = linkRequest(5);
    vi.mocked(run.reference.controls.captureLocation)
      .mockReturnValueOnce(origin)
      .mockReturnValueOnce(null);
    vi.mocked(run.reference.controls.applyLocation).mockResolvedValueOnce(false);

    expect(run.coordinator.requestLink(request)).toBe(true);
    expect(await run.coordinator.chooseLink('same-reference', request)).toBe(false);

    expect(run.reference.controls.applyLocation).toHaveBeenCalledWith(origin);
    expect(run.state()).toEqual(before);
    expect(run.announcement()).toBe('Reference unavailable. Retry when ready.');
  });

  it('does not commit deferred same-reference work after a newer operation supersedes it', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), {
      label: 'Primary result', pageContext: 'Page 2',
    });
    const before = run.state();
    const applied = deferred<boolean>();
    vi.mocked(run.reference.controls.applyTarget).mockReturnValueOnce(applied.promise);
    const request = linkRequest(5);

    expect(run.coordinator.requestLink(request)).toBe(true);
    const following = run.coordinator.chooseLink('same-reference', request);
    await Promise.resolve();
    run.coordinator.unavailableDestination();
    applied.resolve(true);

    expect(await following).toBe(false);
    expect(run.state()).toEqual(before);
    expect(run.reference.controls.focusAtDestination).not.toHaveBeenCalledWith(5);
  });

  it('keeps durable state on failure and retries only a stable failed reference', async () => {
    const run = harness();
    vi.mocked(run.controller.open).mockResolvedValueOnce(false);
    expect(await run.coordinator.openReference(target(4), {
      label: 'Proof', pageContext: 'Page 5',
    })).toBe(false);
    expect(run.state().tabs).toEqual([]);
    expect(run.pending()).toMatchObject({ status: 'error', label: 'Proof' });
    expect(run.announcement()).toBe('Reference unavailable. Retry when ready.');

    vi.mocked(run.controller.snapshot).mockReturnValue({ documentGeneration: 1, status: 'failed' });
    expect(await run.coordinator.retryReference()).toBe(true);
    expect(run.controller.retry).toHaveBeenCalledTimes(1);
    expect(run.state().tabs).toHaveLength(1);
  });

  it('retries a failed destination apply on an already loaded clone without retrying the document', async () => {
    const run = harness();
    vi.mocked(run.reference.controls.applyTarget)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(run.controller.snapshot).mockReturnValue({ documentGeneration: 1, status: 'loaded' });
    expect(await run.coordinator.openReference(target(4), {
      label: 'Proof', pageContext: 'Page 5',
    })).toBe(false);
    const settled = deferred<void>();
    vi.mocked(run.dependencies.layout.settle).mockReturnValueOnce(settled.promise);
    const retry = run.coordinator.retryReference();
    await Promise.resolve();
    await Promise.resolve();
    expect(run.reference.controls.applyTarget).toHaveBeenCalledTimes(1);
    settled.resolve();
    expect(await retry).toBe(true);
    expect(run.controller.retry).not.toHaveBeenCalled();
    expect(run.reference.controls.applyTarget).toHaveBeenCalledTimes(2);
    expect(run.reference.controls.applyTarget)
      .toHaveBeenNthCalledWith(1, target(4), 'reference-fit-width');
    expect(run.reference.controls.applyTarget)
      .toHaveBeenNthCalledWith(2, target(4), 'reference-fit-width');
  });

  it('deduplicates a canonical target and restores an existing tab snapshot', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'Lemma', pageContext: 'Page 3' });
    run.reference.set(location(6, 80, 1.4));
    await run.coordinator.openReference(target(5), { label: 'Table 2', pageContext: 'Page 6' });
    run.reference.set(location(8, 120, 1.7));

    expect(await run.coordinator.openReference(target(2), {
      label: 'Lemma', pageContext: 'Page 3',
    })).toBe(true);
    expect(run.state().tabs).toHaveLength(2);
    expect(run.state().activeTabIdentity).toBe(target(2).identity);
    expect(run.reference.controls.applyLocation).toHaveBeenLastCalledWith(location(6, 80, 1.4));
    expect(run.reference.controls.applyTarget).toHaveBeenCalledTimes(2);
  });

  it('restores the selected Main search result once while opening a reference', async () => {
    const run = harness();
    const selectedMainTarget = target(5);

    expect(await run.coordinator.openReference(
      target(2),
      { label: 'Search result', pageContext: 'Page 3' },
      selectedMainTarget,
    )).toBe(true);

    expect(run.main.controls.applyTarget).toHaveBeenCalledOnce();
    expect(run.main.controls.applyTarget).toHaveBeenCalledWith(selectedMainTarget);
    expect(vi.mocked(run.controller.open).mock.invocationCallOrder.at(-1))
      .toBeLessThan(vi.mocked(run.main.controls.applyTarget).mock.invocationCallOrder.at(-1)!);
  });

  it('restores the selected Main search result once when reference opening fails', async () => {
    const run = harness();
    const selectedMainTarget = target(5);
    vi.mocked(run.controller.open).mockResolvedValueOnce(false);

    expect(await run.coordinator.openReference(
      target(2),
      { label: 'Search result', pageContext: 'Page 3' },
      selectedMainTarget,
    )).toBe(false);

    expect(run.main.controls.applyTarget).toHaveBeenCalledOnce();
    expect(run.main.controls.applyTarget).toHaveBeenCalledWith(selectedMainTarget);
    expect(run.pending()).toMatchObject({ status: 'error', label: 'Search result' });
  });

  it('waits for dock layout settlement before restoring another reference tab', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    await run.coordinator.openReference(target(5), { label: 'B', pageContext: 'Page 6' });
    const settled = deferred<void>();
    vi.mocked(run.dependencies.layout.settle).mockReturnValueOnce(settled.promise);
    vi.mocked(run.reference.controls.applyLocation).mockClear();

    const switching = run.coordinator.switchReference(target(2).identity);
    await Promise.resolve();
    expect(run.reference.controls.applyLocation).not.toHaveBeenCalled();

    settled.resolve();
    expect(await switching).toBe(true);
    expect(run.state().activeTabIdentity).toBe(target(2).identity);
  });

  it('falls back to the canonical target when a saved tab view cannot be restored after reflow', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    await run.coordinator.openReference(target(5), { label: 'B', pageContext: 'Page 6' });
    vi.mocked(run.reference.controls.applyLocation).mockResolvedValueOnce(false);
    vi.mocked(run.reference.controls.applyTarget).mockClear();

    expect(await run.coordinator.switchReference(target(2).identity)).toBe(true);

    expect(run.reference.controls.applyLocation).toHaveBeenLastCalledWith(location(2));
    expect(run.reference.controls.applyTarget)
      .toHaveBeenCalledWith(target(2), 'reference-fit-width');
    expect(run.state().activeTabIdentity).toBe(target(2).identity);
    expect(run.announcement()).toBe('Reference active.');
  });

  it('publishes identity-scoped return availability only after manual Reference drift', async () => {
    const run = harness();
    const original = target(2);
    await run.coordinator.openReference(original, { label: 'A', pageContext: 'Page 3' });

    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('outside');
    run.coordinator.observeReferenceManualScroll();
    expect(run.referenceReturn()).toEqual({
      tabIdentity: original.identity,
      documentGeneration: 1,
      available: true,
      pending: false,
    });

    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('unavailable');
    run.coordinator.observeReferenceManualScroll();
    expect(run.referenceReturn()?.available).toBe(true);

    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('visible');
    run.coordinator.observeReferenceManualScroll();
    expect(run.referenceReturn()).toBeNull();
  });

  it('returns to the immutable Reference origin without touching Main routing or history', async () => {
    const browser = locationHistory();
    const run = harness({ locationHistory: browser });
    const original = target(2);
    await run.coordinator.openReference(original, { label: 'A', pageContext: 'Page 3' });
    run.reference.set(location(8, 160, 1.7));
    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('outside');
    run.coordinator.observeReferenceManualScroll();
    vi.mocked(run.reference.controls.applyTarget).mockClear();
    vi.mocked(run.main.controls.applyTarget).mockClear();
    vi.mocked(run.main.controls.applyLocation).mockClear();
    vi.mocked(run.main.controls.cancelPendingNavigation).mockClear();
    vi.mocked(run.dependencies.dispatch).mockClear();
    vi.mocked(run.dependencies.setAnnouncement).mockClear();

    expect(await run.coordinator.returnToReference(original.identity)).toBe(true);

    expect(run.reference.controls.applyTarget)
      .toHaveBeenCalledWith(original, 'reference-fit-width');
    expect(run.state().tabs[0]?.originalTarget).toEqual(original);
    expect(run.state().tabs[0]?.settledLocation).toEqual(location(2));
    expect(run.dependencies.dispatch).toHaveBeenCalledOnce();
    expect(run.dependencies.dispatch).toHaveBeenCalledWith({
      type: 'refresh-active-reference',
      settledLocation: location(2),
    });
    expect(run.referenceReturn()).toBeNull();
    expect(run.announcement()).toBe('Returned to reference.');
    expect(run.reference.controls.focusAtDestination).toHaveBeenLastCalledWith(2);
    expect(vi.mocked(run.dependencies.setAnnouncement).mock.invocationCallOrder.at(-1))
      .toBeLessThan(vi.mocked(run.reference.controls.focusAtDestination).mock.invocationCallOrder.at(-1)!);
    expect(run.main.controls.applyTarget).not.toHaveBeenCalled();
    expect(run.main.controls.applyLocation).not.toHaveBeenCalled();
    expect(run.main.controls.cancelPendingNavigation).not.toHaveBeenCalled();
    expect(browser.history.push).not.toHaveBeenCalled();
    expect(browser.history.replace).not.toHaveBeenCalled();
  });

  it('keeps a failed return retryable and rejects repeat activation while pending', async () => {
    const run = harness();
    const original = target(2);
    await run.coordinator.openReference(original, { label: 'A', pageContext: 'Page 3' });
    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('outside');
    run.coordinator.observeReferenceManualScroll();
    const applied = deferred<boolean>();
    vi.mocked(run.reference.controls.applyTarget).mockReturnValueOnce(applied.promise);

    const returning = run.coordinator.returnToReference(original.identity);
    await Promise.resolve();
    expect(run.referenceReturn()).toEqual(expect.objectContaining({
      tabIdentity: original.identity,
      available: true,
      pending: true,
    }));
    expect(await run.coordinator.returnToReference(original.identity)).toBe(false);
    applied.resolve(false);
    expect(await returning).toBe(false);

    expect(run.referenceReturn()).toEqual(expect.objectContaining({
      tabIdentity: original.identity,
      available: true,
      pending: false,
    }));
    expect(run.announcement()).toBe('Reference unavailable. Retry when ready.');
    expect(run.state().tabs[0]?.settledLocation).toEqual(location(2));
  });

  it('drops stale return completion after a Reference lifecycle change', async () => {
    const run = harness();
    const first = target(2);
    const second = target(5);
    await run.coordinator.openReference(first, { label: 'A', pageContext: 'Page 3' });
    await run.coordinator.openReference(second, { label: 'B', pageContext: 'Page 6' });
    await run.coordinator.switchReference(first.identity);
    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('outside');
    run.coordinator.observeReferenceManualScroll();
    const applied = deferred<boolean>();
    vi.mocked(run.reference.controls.applyTarget).mockReturnValueOnce(applied.promise);
    const returning = run.coordinator.returnToReference(first.identity);
    await Promise.resolve();

    expect(await run.coordinator.switchReference(second.identity)).toBe(true);
    applied.resolve(true);
    expect(await returning).toBe(false);
    expect(run.referenceReturn()).toBeNull();
    expect(run.announcement()).toBe('Reference active.');
    expect(run.state().activeTabIdentity).toBe(second.identity);
    expect(run.state().tabs.find(({ identity }) => identity === first.identity)?.settledLocation)
      .toEqual(location(2));
  });

  it('drops return completion when the Reference navigation adapter is disposed', async () => {
    const run = harness();
    const original = target(2);
    await run.coordinator.openReference(original, { label: 'A', pageContext: 'Page 3' });
    vi.mocked(run.reference.controls.targetVisibility).mockReturnValue('outside');
    run.coordinator.observeReferenceManualScroll();
    const applied = deferred<boolean>();
    vi.mocked(run.reference.controls.applyTarget).mockReturnValueOnce(applied.promise);
    vi.mocked(run.dependencies.dispatch).mockClear();
    vi.mocked(run.dependencies.setAnnouncement).mockClear();

    const returning = run.coordinator.returnToReference(original.identity);
    await Promise.resolve();
    vi.spyOn(run.dependencies, 'getReferenceNavigation').mockReturnValue(null);
    run.coordinator.referenceNavigationUnavailable();
    applied.resolve(true);

    expect(await returning).toBe(false);
    expect(run.referenceReturn()).toBeNull();
    expect(run.dependencies.dispatch).not.toHaveBeenCalled();
    expect(run.dependencies.setAnnouncement).not.toHaveBeenCalled();
  });

  it('lets only the newest rapid reference operation commit', async () => {
    const run = harness();
    const first = deferred<boolean>();
    vi.mocked(run.controller.open)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(true);

    const stale = run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const current = run.coordinator.openReference(target(5), { label: 'B', pageContext: 'Page 6' });
    first.resolve(true);
    expect(await stale).toBe(false);
    expect(await current).toBe(true);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(5).identity]);
    expect(run.announcement()).toContain('B');
  });

  it('saves and restores tab snapshots and closes active, inactive, and final tabs', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    run.reference.set(location(7, 70, 1.25));
    await run.coordinator.openReference(target(4), { label: 'B', pageContext: 'Page 5' });
    expect(run.state().tabs[0]?.settledLocation).toEqual(location(7, 70, 1.25));

    expect(await run.coordinator.closeReference(target(2).identity)).toBe(true);
    expect(run.state().activeTabIdentity).toBe(target(4).identity);
    expect(await run.coordinator.closeReference(target(4).identity)).toBe(true);
    expect(run.state().tabs).toEqual([]);
    expect(run.referencesOpen()).toBe(false);
    expect(run.controller.close).toHaveBeenCalled();
    expect(run.dependencies.layout.focusReferenceRail).toHaveBeenCalled();
    expect(run.state().workspace.returnFocusToken).toBe('rail:bottom-references');
  });

  it('commits final logical close before a newer same-target open waits for physical close', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const closed = deferred<void>();
    vi.mocked(run.controller.close).mockReturnValueOnce(closed.promise);
    vi.mocked(run.controller.open).mockImplementationOnce(async () => {
      await closed.promise;
      return true;
    });

    const staleClose = run.coordinator.closeReference(target(2).identity);
    expect(run.state().tabs).toEqual([]);
    expect(run.referencesOpen()).toBe(false);
    const reopened = run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    expect(run.referencesOpen()).toBe(true);
    closed.resolve();

    expect(await staleClose).toBe(false);
    expect(await reopened).toBe(true);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(2).identity]);
    expect(run.referencesOpen()).toBe(true);
  });

  it('uses the live scrolled reference for Send and consumes only after main success', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const scrolled = location(7, 180, 1.6);
    run.reference.set(scrolled);
    run.main.set(location(1, 45, 1.1));

    expect(await run.coordinator.sendToMain(target(2).identity)).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenCalledWith(scrolled);
    expect(run.main.controls.applyLocation).toHaveBeenCalledOnce();
    expect(run.dependencies.commitMainFramingPosition).toHaveBeenCalledOnce();
    expect(run.state().tabs).toEqual([]);
    expect(run.state().mainHistory.entries).toEqual([location(1, 45, 1.1), scrolled]);
    expect(run.referencesOpen()).toBe(false);
    expect(run.dependencies.layout.hideReferences).toHaveBeenCalledOnce();
    expect(run.dependencies.layout.hideReferencesAfterSend).toHaveBeenCalledOnce();
    expect(vi.mocked(run.dependencies.commitMainFramingPosition).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(run.dependencies.layout.hideReferencesAfterSend).mock.invocationCallOrder[0]!);
    expect(vi.mocked(run.dependencies.layout.settle).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(run.main.controls.applyLocation).mock.invocationCallOrder.at(-1)!);
    expect(run.controller.close).toHaveBeenCalledOnce();
    expect(vi.mocked(run.main.controls.applyLocation).mock.invocationCallOrder.at(-1))
      .toBeLessThan(vi.mocked(run.controller.close).mock.invocationCallOrder.at(-1)!);
    expect(run.dependencies.layout.focusReferenceRail).not.toHaveBeenCalled();
  });

  it('consumes the sent tab when Main applies before its layout can be recaptured', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const destination = location(7, 180, 1.6);
    const origin = location(1, 45, 1.1);
    run.reference.set(destination);
    run.main.set(origin);
    vi.mocked(run.main.controls.captureLocation)
      .mockReturnValueOnce(origin)
      .mockReturnValueOnce(null);

    expect(await run.coordinator.sendToMain(target(2).identity)).toBe(true);
    expect(run.state().tabs).toEqual([]);
    expect(run.state().mainHistory.entries).toEqual([origin, destination]);
    expect(run.referencesOpen()).toBe(false);
  });

  it('preserves Search reopened while a final Send settles on the shared surface', async () => {
    const run = harness({ sharedReferenceSurface: true });
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const applied = deferred<boolean>();
    vi.mocked(run.main.controls.applyLocation).mockImplementationOnce(async () => applied.promise);

    const sending = run.coordinator.sendToMain(target(2).identity);
    expect(run.referencesOpen()).toBe(false);
    run.dependencies.dispatch({ type: 'select-workspace-mode', mode: 'search' });
    run.reopenReferences();
    run.main.set(location(2));
    applied.resolve(true);

    expect(await sending).toBe(true);
    expect(run.referencesOpen()).toBe(true);
    expect(run.dependencies.layout.hideReferencesAfterSend).toHaveBeenCalledOnce();
  });

  it('restores the final Reference tray when Send cannot settle in the revealed main layout', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    vi.mocked(run.main.controls.applyLocation).mockResolvedValueOnce(false);

    expect(await run.coordinator.sendToMain(target(2).identity)).toBe(false);

    expect(run.state().tabs).toHaveLength(1);
    expect(run.referencesOpen()).toBe(true);
    expect(run.dependencies.layout.hideReferences).toHaveBeenCalledOnce();
    expect(run.dependencies.layout.revealReferences).toHaveBeenCalled();
    expect(run.controller.close).not.toHaveBeenCalled();
    expect(run.dependencies.commitMainFramingPosition).not.toHaveBeenCalled();
    expect(run.announcement()).toBe('Destination unavailable. The current location was preserved.');
  });

  it('keeps References open and restores the surviving active tab after Send', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const surviving = run.state().tabs[0]!.settledLocation;
    await run.coordinator.openReference(target(4), { label: 'B', pageContext: 'Page 5' });
    const consumedLive = location(8, 180, 1.6);
    run.reference.set(consumedLive);
    run.main.set(location(1, 45, 1.1));

    expect(await run.coordinator.sendToMain(target(4).identity)).toBe(true);
    expect(run.state().activeTabIdentity).toBe(target(2).identity);
    expect(run.state().tabs[0]!.settledLocation).toEqual(surviving);
    expect(run.referencesOpen()).toBe(true);
    expect(run.reference.controls.applyLocation).toHaveBeenLastCalledWith(surviving);
    expect(run.state().tabs[0]!.settledLocation).toEqual(surviving);
    expect(run.dependencies.layout.hideReferences).not.toHaveBeenCalled();
    expect(run.controller.close).not.toHaveBeenCalled();
    expect(run.dependencies.focusReferenceTab).toHaveBeenLastCalledWith(target(2).identity);
  });

  it('preserves the live active reference when an ordinary hidden workspace reopens', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const live = location(6, 140, 1.45);
    run.reference.set(live);
    run.dependencies.layout.hideReferences();
    vi.mocked(run.reference.controls.applyLocation).mockClear();

    expect(await run.coordinator.openReferencesWorkspace()).toBe(true);
    expect(run.reference.controls.applyLocation).not.toHaveBeenCalled();
    expect(run.state().tabs[0]!.settledLocation).toEqual(live);
  });

  it('does not overwrite a Send-selected successor when another reference opens first', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const surviving = run.state().tabs[0]!.settledLocation;
    await run.coordinator.openReference(target(4), { label: 'B', pageContext: 'Page 5' });
    run.reference.set(location(8, 180, 1.6));
    run.main.set(location(1, 45, 1.1));

    expect(await run.coordinator.sendToMain(target(4).identity)).toBe(true);
    expect(await run.coordinator.openReference(target(6), {
      label: 'C', pageContext: 'Page 7',
    })).toBe(true);
    expect(run.state().tabs.find(({ identity }) => identity === target(2).identity)?.settledLocation)
      .toEqual(surviving);
  });

  it('records direct jumps, exact traversal, live refresh, and forward-branch truncation', async () => {
    const run = harness();
    expect(await run.coordinator.navigateMainTarget(target(2), 'direct')).toBe(true);
    run.main.set(location(3, 90, 1.3));
    run.coordinator.refreshMainLocation();
    expect(await run.coordinator.navigateMainTarget(target(5), 'outline')).toBe(true);
    expect(await run.coordinator.historyBack()).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenLastCalledWith(location(3, 90, 1.3));
    expect(await run.coordinator.navigateMainTarget(target(7), 'direct')).toBe(true);
    expect(run.state().mainHistory.entries.map(({ pageIndex }) => pageIndex)).toEqual([0, 3, 7]);
    expect(run.state().mainHistory.index).toBe(2);
    expect(await run.coordinator.historyForward()).toBe(false);
    expect(run.main.controls.applyTarget).toHaveBeenCalledWith(target(2));
    expect(run.main.controls.applyTarget).toHaveBeenCalledWith(target(5));
  });

  it('records annotation jumps for backward and forward traversal', async () => {
    const run = harness();
    const annotation = location(4, 160, 1);

    expect(await run.coordinator.navigateMainAnnotation({
      pageIndex: annotation.pageIndex,
      point: annotation.anchor,
    })).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenCalledWith(annotation);
    expect(run.state().mainHistory.entries.map(({ pageIndex }) => pageIndex)).toEqual([0, 4]);
    expect(run.state().mainHistory.index).toBe(1);

    expect(await run.coordinator.historyBack()).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenLastCalledWith(location(0));
    expect(await run.coordinator.historyForward()).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenLastCalledWith(annotation);
  });

  it('does not add a duplicate history stop when a repeated annotation settles in place', async () => {
    const run = harness();
    const original = location(0);
    const annotation = location(4, 160, 1);
    const settled = {
      ...annotation,
      anchor: { x: 12, y: 220 },
      alignment: { xPercent: 50, yPercent: 50 },
    };
    vi.mocked(run.main.controls.applyLocation).mockImplementation(async () => {
      run.main.set(settled);
      return true;
    });

    const navigate = () => run.coordinator.navigateMainAnnotation({
      pageIndex: annotation.pageIndex,
      point: annotation.anchor,
    });
    expect(await navigate()).toBe(true);
    expect(run.state().mainHistory).toEqual({ entries: [original, settled], index: 1 });

    expect(await navigate()).toBe(true);
    expect(run.state().mainHistory).toEqual({ entries: [original, settled], index: 1 });
    expect(run.main.controls.applyLocation).toHaveBeenCalledTimes(2);

    expect(await run.coordinator.historyBack()).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenLastCalledWith(original);
  });

  it('preserves the original history location across rapid annotation jumps', async () => {
    const run = harness();
    const original = location(0, 75, 1.2);
    const firstAnnotation = location(3, 140, 1.2);
    const secondAnnotation = location(5, 220, 1.2);
    const firstApply = deferred<boolean>();
    let pendingRollback: Promise<void> | null = null;
    run.main.set(original);
    vi.mocked(run.main.controls.cancelPendingNavigation).mockImplementation(
      () => pendingRollback ?? Promise.resolve(),
    );
    vi.mocked(run.main.controls.applyLocation)
      .mockImplementationOnce(async (value) => {
        run.main.set(value);
        return firstApply.promise;
      })
      .mockImplementationOnce(async (value) => {
        run.main.set(value);
        return true;
      });

    const firstJump = run.coordinator.navigateMainAnnotation({
      pageIndex: firstAnnotation.pageIndex,
      point: firstAnnotation.anchor,
    });
    await vi.waitFor(() => {
      expect(run.main.controls.applyLocation).toHaveBeenCalledWith(firstAnnotation);
    });

    const rollback = deferred<void>();
    pendingRollback = rollback.promise;
    const secondJump = run.coordinator.navigateMainAnnotation({
      pageIndex: secondAnnotation.pageIndex,
      point: secondAnnotation.anchor,
    });
    await Promise.resolve();
    expect(run.main.controls.applyLocation).toHaveBeenCalledTimes(1);

    run.main.set(original);
    pendingRollback = null;
    rollback.resolve();
    expect(await secondJump).toBe(true);
    firstApply.resolve(true);
    expect(await firstJump).toBe(false);

    expect(run.state().mainHistory.entries).toEqual([original, secondAnnotation]);
    expect(await run.coordinator.historyBack()).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenLastCalledWith(original);
  });

  it('waits for annotation rollback before capturing a successor target origin', async () => {
    const run = harness();
    const original = location(0, 75, 1.2);
    const annotation = location(3, 140, 1.2);
    const successor = target(5);
    const firstApply = deferred<boolean>();
    let pendingRollback: Promise<void> | null = null;
    run.main.set(original);
    vi.mocked(run.main.controls.cancelPendingNavigation).mockImplementation(
      () => pendingRollback ?? Promise.resolve(),
    );
    vi.mocked(run.main.controls.applyLocation).mockImplementationOnce(async (value) => {
      run.main.set(value);
      return firstApply.promise;
    });
    vi.mocked(run.main.controls.applyTarget).mockImplementationOnce(async (value) => {
      if (pendingRollback !== null) await pendingRollback;
      run.main.set(location(value.pageIndex));
      return true;
    });

    const firstJump = run.coordinator.navigateMainAnnotation({
      pageIndex: annotation.pageIndex,
      point: annotation.anchor,
    });
    await vi.waitFor(() => {
      expect(run.main.controls.applyLocation).toHaveBeenCalledWith(annotation);
    });

    const rollback = deferred<void>();
    pendingRollback = rollback.promise;
    const successorJump = run.coordinator.navigateMainTarget(successor, 'outline');
    await Promise.resolve();
    expect(run.main.controls.applyTarget).not.toHaveBeenCalled();

    run.main.set(original);
    pendingRollback = null;
    rollback.resolve();
    expect(await successorJump).toBe(true);
    firstApply.resolve(true);
    expect(await firstJump).toBe(false);

    expect(run.state().mainHistory.entries).toEqual([original, location(successor.pageIndex)]);
    expect(await run.coordinator.historyBack()).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenLastCalledWith(original);
  });

  it('treats semantic no-op direct and outline targets as successful without history', async () => {
    const run = harness();
    run.dependencies.layout.revealReferences();
    expect(await run.coordinator.navigateMainTarget(target(0), 'direct')).toBe(true);
    expect(run.state().mainHistory.entries).toEqual([]);
    expect(run.referencesOpen()).toBe(false);
    expect(run.main.controls.focusAtDestination).toHaveBeenCalledWith(0);

    run.dependencies.layout.revealReferences();
    vi.mocked(run.main.controls.focusAtDestination).mockClear();
    expect(await run.coordinator.navigateMainTarget(target(0), 'outline')).toBe(true);
    expect(run.state().mainHistory.entries).toEqual([]);
    expect(run.referencesOpen()).toBe(true);
    expect(run.main.controls.focusAtDestination).not.toHaveBeenCalled();
  });

  it('records distinct search occurrences even when viewer tolerances resolve them alike', async () => {
    const run = harness();
    const first = { ...target(0), identity: 'search:first' };
    const second = { ...target(0), identity: 'search:second' };

    expect(await run.coordinator.navigateMainTarget(first, 'search')).toBe(true);
    expect(await run.coordinator.navigateMainTarget(second, 'search')).toBe(true);

    expect(run.state().mainHistory.entries).toHaveLength(3);
    expect(run.state().mainHistory.index).toBe(2);
  });

  it('records a distinct search occurrence when boundary clamping settles in place', async () => {
    const run = harness();
    const original = location(0);
    const occurrence = { ...target(1), identity: 'search:clamped' };
    vi.mocked(run.main.controls.applyTarget).mockImplementationOnce(async () => {
      run.main.set(original);
      return true;
    });

    expect(await run.coordinator.navigateMainTarget(occurrence, 'search')).toBe(true);

    expect(run.state().mainHistory).toEqual({ entries: [original, original], index: 1 });
  });

  it('invalidates clone, viewer, focus, status, and late callbacks on document replacement', async () => {
    const run = harness();
    const opened = deferred<boolean>();
    vi.mocked(run.controller.open).mockReturnValueOnce(opened.promise);
    const stale = run.coordinator.openReference(target(3), { label: 'Old', pageContext: 'Page 4' });

    run.coordinator.replaceDocument(2);
    opened.resolve(true);
    expect(await stale).toBe(false);
    expect(run.state()).toEqual(createReferenceNavigationState(2));
    expect(run.main.controls.replaceDocument).toHaveBeenCalledWith(2);
    expect(run.reference.controls.replaceDocument).toHaveBeenCalledWith(2);
    expect(run.controller.replaceDocument).toHaveBeenCalledWith(2);
    expect(run.pending()).toBeNull();
    expect(run.announcement()).toBe('');
    expect(run.dependencies.layout.hideReferences).toHaveBeenCalled();
    expect(run.dependencies.focusReferenceTab).not.toHaveBeenCalled();
  });
});

describe('current outline destination', () => {
  it('prepares target ordering once for repeated containment lookups', () => {
    const first = target(1);
    const second = target(2);
    const resolveTarget = vi.fn((candidate: PdfNavigationTarget): OutlineTargetOrderLocation => ({
      pageIndex: candidate.pageIndex,
      anchor: { x: 0, y: 0 },
      precision: 'exact',
    }));
    const resolve = createOutlineContainmentResolver({
      discovery: {
        status: 'loaded-tree',
        documentGeneration: 1,
        items: [
          { id: 'first', label: 'First', pageContext: 'Page 2', target: first, children: [] },
          { id: 'second', label: 'Second', pageContext: 'Page 3', target: second, children: [] },
        ],
      },
      resolveTarget,
    });

    expect(resolve({ pageIndex: 1, anchor: { x: 10, y: 20 } })?.id).toBe('first');
    expect(resolve({ pageIndex: 2, anchor: { x: 10, y: 20 } })?.id).toBe('second');
    expect(resolveTarget).toHaveBeenCalledTimes(2);
  });

  it('fails closed when any targeted bookmark cannot be safely ordered', () => {
    const safe = target(1);
    const unsafe = target(2);
    expect(resolveCurrentOutlineItemId({
      discovery: {
        status: 'loaded-tree',
        documentGeneration: 1,
        items: [
          { id: 'safe', label: 'Safe', pageContext: 'Page 2', target: safe, children: [] },
          { id: 'unsafe', label: 'Unsafe', pageContext: 'Page 3', target: unsafe, children: [] },
        ],
      },
      currentLocation: location(5),
      resolveTarget: (candidate) => candidate === safe ? location(1) : null,
    })).toBeNull();
  });

  it('prefers deeper and then later document order for equal locations', () => {
    const shared = location(1, 20);
    const deepestEarlier = target(1);
    const deepestLater = target(2);
    expect(resolveCurrentOutlineItemId({
      discovery: {
        status: 'loaded-tree',
        documentGeneration: 1,
        items: [{
          id: 'root', label: 'Root', pageContext: 'Page 2', target: target(0), children: [
            {
              id: 'branch', label: 'Branch', pageContext: 'Page 2', target: target(3), children: [
                { id: 'deep-earlier', label: 'Earlier', pageContext: 'Page 2', target: deepestEarlier, children: [] },
                { id: 'deep-later', label: 'Later', pageContext: 'Page 3', target: deepestLater, children: [] },
              ],
            },
            { id: 'shallow-later', label: 'Shallow', pageContext: 'Page 4', target: target(4), children: [] },
          ],
        }],
      },
      currentLocation: location(5),
      resolveTarget: () => shared,
    })).toBe('deep-later');
  });

  it('uses exact children after their authored position and page-level ancestors before it', () => {
    const parent = target(2);
    const child = target(2);
    const discovery = {
      status: 'loaded-tree' as const,
      documentGeneration: 1,
      items: [{
        id: 'parent', label: 'Parent', pageContext: 'Page 3', target: parent, children: [
          { id: 'child', label: 'Child', pageContext: 'Page 3', target: child, children: [] },
        ],
      }],
    };
    const resolveTarget = (candidate: PdfNavigationTarget): OutlineTargetOrderLocation => (
      candidate === parent
        ? { pageIndex: 2, anchor: { x: 0, y: 0 }, precision: 'page' }
        : { pageIndex: 2, anchor: { x: 72, y: 400 }, precision: 'exact' }
    );

    expect(resolveContainingOutlineItem({
      discovery,
      currentLocation: { pageIndex: 2, anchor: { x: 72, y: 300 } },
      resolveTarget,
    })?.id).toBe('parent');
    expect(resolveContainingOutlineItem({
      discovery,
      currentLocation: { pageIndex: 2, anchor: { x: 72, y: 500 } },
      resolveTarget,
    })?.id).toBe('child');
  });

  it('accepts a page-level ancestor chain but fails closed on same-page siblings', () => {
    const root = target(1);
    const branch = target(1);
    const sibling = target(1);
    const location: OutlineTargetOrderLocation = {
      pageIndex: 1,
      anchor: { x: 0, y: 0 },
      precision: 'page',
    };
    const chain = {
      status: 'loaded-tree' as const,
      documentGeneration: 1,
      items: [{
        id: 'root', label: 'Root', pageContext: 'Page 2', target: root, children: [
          { id: 'branch', label: 'Branch', pageContext: 'Page 2', target: branch, children: [] },
        ],
      }],
    };
    expect(resolveContainingOutlineItem({
      discovery: chain,
      currentLocation: { pageIndex: 1, anchor: { x: 10, y: 10 } },
      resolveTarget: () => location,
    })?.id).toBe('branch');

    expect(resolveContainingOutlineItem({
      discovery: {
        ...chain,
        items: [...chain.items, {
          id: 'sibling', label: 'Sibling', pageContext: 'Page 2', target: sibling, children: [],
        }],
      },
      currentLocation: { pageIndex: 1, anchor: { x: 10, y: 10 } },
      resolveTarget: () => location,
    })).toBeNull();
  });

  it('fails the whole derivation when page-level siblings precede an exact target', () => {
    const first = target(1);
    const second = target(1);
    const exact = target(1);
    const resolve = createOutlineContainmentResolver({
      discovery: {
        status: 'loaded-tree',
        documentGeneration: 1,
        items: [
          { id: 'first', label: 'First', pageContext: 'Page 2', target: first, children: [] },
          { id: 'second', label: 'Second', pageContext: 'Page 2', target: second, children: [] },
          { id: 'exact', label: 'Exact', pageContext: 'Page 2', target: exact, children: [] },
        ],
      },
      resolveTarget: (candidate): OutlineTargetOrderLocation => candidate === exact
        ? { pageIndex: 1, anchor: { x: 10, y: 100 }, precision: 'exact' }
        : { pageIndex: 1, anchor: { x: 0, y: 0 }, precision: 'page' },
    });

    expect(resolve({ pageIndex: 1, anchor: { x: 10, y: 200 } })).toBeNull();
  });
});
