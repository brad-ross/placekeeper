import { PdfZoomMode } from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import type { PdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';
import { createPdfNavigationMetadata } from '../src/pdf/pdf-navigation-metadata.js';
import type { ViewerPdfLinkInvocation } from '../src/pdf/viewer-interaction-events.js';
import type { ReferenceDocumentController } from '../src/pdf/reference-document.js';
import type { PdfViewerNavigation } from '../src/pdf/viewer-navigation-adapter.js';
import type { PdfViewerLocation } from '../src/pdf/viewer-navigation.js';
import {
  NavigationCoordinator,
  resolveCurrentOutlineItemId,
  type NavigationCoordinatorDependencies,
} from '../src/review/navigation-coordinator.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function navigation(initial = location(0)) {
  let current = initial;
  return {
    controls: {
      captureLocation: vi.fn(() => current),
      resolveTarget: vi.fn((value: PdfNavigationTarget) => location(value.pageIndex)),
      applyTarget: vi.fn(async (value: PdfNavigationTarget) => {
        current = location(value.pageIndex);
        return true;
      }),
      applyLocation: vi.fn(async (value: PdfViewerLocation) => {
        current = value;
        return true;
      }),
      cancelPendingNavigation: vi.fn(),
      replaceDocument: vi.fn(),
      focusAtDestination: vi.fn(() => true),
      dispose: vi.fn(),
    } satisfies PdfViewerNavigation,
    set(value: PdfViewerLocation) { current = value; },
  };
}

function harness() {
  let state: ReferenceNavigationState = createReferenceNavigationState(1);
  let workspaceOpen = false;
  let pending: Parameters<NavigationCoordinatorDependencies['setPendingReference']>[0] = null;
  let announcement = '';
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
    dispatch: (action) => { state = reduceReferenceNavigation(state, action); },
    getMainNavigation: () => main.controls,
    getReferenceNavigation: () => reference.controls,
    waitForReferenceNavigation: async () => reference.controls,
    getReferenceController: () => controller,
    setWorkspaceOpen: (open) => { workspaceOpen = open; },
    settleWorkspace: vi.fn(async () => undefined),
    setPendingReference: (value) => { pending = value; },
    setLinkActionRequest: vi.fn(),
    setAnnouncement: (value) => { announcement = value; },
    focusReferenceTab: vi.fn(() => true),
    focusWorkspaceControl: vi.fn(() => true),
    getOutlineDiscovery: () => ({ status: 'loaded-empty', documentGeneration: state.documentGeneration }),
    setCurrentOutlineItemId: vi.fn(),
  };
  return {
    coordinator: new NavigationCoordinator(dependencies),
    dependencies,
    main,
    reference,
    controller,
    state: () => state,
    workspaceOpen: () => workspaceOpen,
    pending: () => pending,
    announcement: () => announcement,
  };
}

describe('document-scoped navigation coordinator', () => {
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
    expect(run.state().pendingMainNavigation).not.toBeNull();

    const newest: ViewerPdfLinkInvocation = {
      sourceScope: 'reference',
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
    vi.mocked(run.dependencies.settleWorkspace).mockReturnValueOnce(settled.promise);

    const jump = run.coordinator.navigateMainTarget(target(3), 'direct');
    await Promise.resolve();
    await Promise.resolve();
    expect(run.state().pendingMainNavigation).toBeNull();
    expect(run.state().mainHistory.entries.map(({ pageIndex }) => pageIndex)).toEqual([0, 3]);

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
    expect(run.workspaceOpen()).toBe(true);
    expect(run.pending()).toMatchObject({ status: 'loading', label: 'Equation (4)' });
    expect(run.state().tabs).toEqual([]);

    opened.resolve(true);
    expect(await operation).toBe(true);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(3).identity]);
    expect(run.pending()).toBeNull();
    expect(run.dependencies.focusReferenceTab).toHaveBeenCalledWith(target(3).identity);
    expect(run.announcement()).toContain('Equation (4)');
  });

  it('routes the newest main/reference viewer link through the chooser and real reducer', async () => {
    const run = harness();
    const request = (pageIndex: number, sourceScope: 'main' | 'reference'): ViewerPdfLinkInvocation => ({
      sourceScope,
      sourcePageIndex: 0,
      target: target(pageIndex),
      metadata: createPdfNavigationMetadata({ contents: `Target ${pageIndex}`, pageIndex }),
      opener: {} as HTMLButtonElement,
      clientRect: { left: 1, top: 1, right: 2, bottom: 2, width: 1, height: 1 },
    });
    const first = request(2, 'main');
    const newest = request(5, 'reference');
    expect(run.coordinator.requestLink(first)).toBe(true);
    expect(run.coordinator.requestLink(newest)).toBe(true);
    expect(run.dependencies.setLinkActionRequest).toHaveBeenLastCalledWith(newest);
    expect(await run.coordinator.chooseLink('references', first)).toBe(false);
    expect(await run.coordinator.chooseLink('references', newest)).toBe(true);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(5).identity]);
    expect(run.workspaceOpen()).toBe(true);
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
    expect(await run.coordinator.retryReference()).toBe(true);
    expect(run.controller.retry).not.toHaveBeenCalled();
    expect(run.reference.controls.applyTarget).toHaveBeenCalledTimes(2);
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
    expect(run.workspaceOpen()).toBe(false);
    expect(run.controller.close).toHaveBeenCalled();
    expect(run.dependencies.focusWorkspaceControl).toHaveBeenCalled();
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
    expect(run.workspaceOpen()).toBe(false);
    const reopened = run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    expect(run.workspaceOpen()).toBe(true);
    closed.resolve();

    expect(await staleClose).toBe(false);
    expect(await reopened).toBe(true);
    expect(run.state().tabs.map(({ identity }) => identity)).toEqual([target(2).identity]);
    expect(run.workspaceOpen()).toBe(true);
  });

  it('uses the live scrolled reference for Send and consumes only after main success', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const scrolled = location(7, 180, 1.6);
    run.reference.set(scrolled);
    run.main.set(location(1, 45, 1.1));

    expect(await run.coordinator.sendToMain(target(2).identity)).toBe(true);
    expect(run.main.controls.applyLocation).toHaveBeenCalledWith(scrolled);
    expect(run.state().tabs).toEqual([]);
    expect(run.state().mainHistory.entries).toEqual([location(1, 45, 1.1), scrolled]);
    expect(run.workspaceOpen()).toBe(false);
  });

  it('restores the surviving active tab when References reopens after Send', async () => {
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
    expect(run.workspaceOpen()).toBe(false);

    expect(await run.coordinator.openReferencesWorkspace()).toBe(true);
    expect(run.reference.controls.applyLocation).toHaveBeenLastCalledWith(surviving);
    expect(run.state().tabs[0]!.settledLocation).toEqual(surviving);
    expect(run.workspaceOpen()).toBe(true);
  });

  it('preserves the live active reference when an ordinary hidden workspace reopens', async () => {
    const run = harness();
    await run.coordinator.openReference(target(2), { label: 'A', pageContext: 'Page 3' });
    const live = location(6, 140, 1.45);
    run.reference.set(live);
    run.dependencies.setWorkspaceOpen(false);
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
  });

  it('treats semantic no-op direct and outline targets as successful without history', async () => {
    const run = harness();
    run.dependencies.setWorkspaceOpen(true);
    expect(await run.coordinator.navigateMainTarget(target(0), 'direct')).toBe(true);
    expect(run.state().mainHistory.entries).toEqual([]);
    expect(run.workspaceOpen()).toBe(false);
    expect(run.main.controls.focusAtDestination).toHaveBeenCalledWith(0);

    run.dependencies.setWorkspaceOpen(true);
    vi.mocked(run.main.controls.focusAtDestination).mockClear();
    expect(await run.coordinator.navigateMainTarget(target(0), 'outline')).toBe(true);
    expect(run.state().mainHistory.entries).toEqual([]);
    expect(run.workspaceOpen()).toBe(true);
    expect(run.main.controls.focusAtDestination).not.toHaveBeenCalled();
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
    expect(run.dependencies.focusReferenceTab).not.toHaveBeenCalled();
  });
});

describe('current outline destination', () => {
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
});
