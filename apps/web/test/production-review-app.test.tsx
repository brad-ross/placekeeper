import { renderToStaticMarkup } from "react-dom/server";
import { PdfZoomMode } from "@embedpdf/models";
import { describe, expect, it, vi } from "vitest";

import type { ProductionScope } from "../src/host/session-contracts.js";
import { createReviewState } from "../../../packages/core/src/review-model.js";
import { createReviewStateSummary } from "../../../packages/core/src/live-context.js";
import {
  applyHostForwardSyncTex,
  ReverseSyncTexRequestCoordinator,
  reverseSyncTexError,
  reverseSyncTexAtCurrentLocation,
  runHostForwardSyncTexRequest,
  forwardSyncTexCompletionIsCurrent,
  forwardSyncTexRequestReady,
} from "../src/host/synctex-navigation.js";
import { initiallyPortableItemIds } from "../src/save/portable-checkpoint.js";
import { canonicalStateSupersedes, firstUnresolvedReviewItemId } from "../src/review/canonical-state.js";
import {
  annotationReferenceRequest,
  authoringReferenceTarget,
  frozenReferenceRecovery,
  pdfAnnotationSurfaceIsCurrent,
  ProductionReviewApp,
} from "../src/app/ProductionReviewApp.js";
import { referenceReturnForActiveTab } from "../src/review/reference-presentation.js";
import {
  viewerAssetUrlsEqual,
  viewerResourcePoliciesEqual,
} from "../src/host/viewer-resource-equivalence.js";
import { visibleCodexContext, updateProductionScope } from "../src/host/context-projection.js";
import { SaveDestinationDialog } from "../src/save/SaveDestinationDialog.js";
import {
  canDeriveAnnotationOutlineLabels,
  deriveAnnotationOutlineLabels,
  reviewItemNavigationTarget,
} from "../src/review/annotation-outline-context.js";
import {
  buildReattachmentCommand,
  reconciliationCommandRejectionMessage,
  reconciliationFocusKeyAfterRemoval,
  reattachmentCandidateFor,
  reattachmentGenerationIsCurrent,
  reattachmentTitle,
  ReconciliationWorkspace,
} from "../src/review/ReconciliationWorkspace.js";
import {
  reviewExportPresentation,
} from "../src/review/DocumentActionsMenu.js";
import { MemoryReviewLocationHistory } from "../src/review/review-location-history.js";

describe('scope polling identity', () => {
  const scope: ProductionScope = {
    documentTitle: 'paper.pdf',
    sourceDisposition: 'local',
    sourceDisplayName: 'Paper',
    sourceRootPath: '/papers',
    launchSurface: 'codex',
    codexContext: {
      status: 'current',
      identity: {
        placekeeperSessionId: 'session',
        documentGeneration: 1,
        source: { fileId: 'file', digest: 'a'.repeat(64), byteLength: 12 },
        reviewRevision: 0,
        stateDigest: 'b'.repeat(64),
      },
      leaseExpiresAt: '2026-09-07T13:00:00.000Z',
    },
  };

  it('retains the current object for equivalent independently decoded poll responses', () => {
    const decoded = JSON.parse(JSON.stringify(scope)) as ProductionScope;
    expect(updateProductionScope(scope, decoded)).toBe(scope);
    const { documentTitle, ...rest } = decoded;
    expect(updateProductionScope(scope, { ...rest, documentTitle })).toBe(scope);
  });

  it('publishes unknown fields when their JSON shape changes', () => {
    const current = { ...scope, future: [] };
    const next = { ...scope, future: {} };
    expect(updateProductionScope(current, next)).toBe(next);
  });

  it.each([
    { documentTitle: 'next.pdf' },
    { sourceDisposition: 'remote-temporary' as const },
    { sourceDisplayName: 'Next paper' },
    { sourceRootPath: '/other' },
    { launchSurface: 'browser' as const },
    { persistenceMode: 'export-only' as const },
    { reconnectPending: true as const },
    { codexContext: { status: 'unbound' as const } },
  ])('publishes a changed scope field: %j', (change) => {
    const next = { ...scope, ...change };
    expect(updateProductionScope(scope, next)).toBe(next);
  });

  it('publishes renewed leases, identity changes, and removed context', () => {
    if (scope.codexContext?.status !== 'current') throw new Error('Expected current fixture');
    const context = scope.codexContext;
    const identity = context.identity;
    const contexts = [
      { ...context, leaseExpiresAt: '2026-09-07T13:01:00.000Z' },
      ...[
        { placekeeperSessionId: 'other' },
        { documentGeneration: 2 },
        { reviewRevision: 1 },
        { stateDigest: 'c'.repeat(64) },
        { source: { ...identity.source, digest: 'd'.repeat(64) } },
        { source: { ...identity.source, fileId: 'other' } },
        { source: { ...identity.source, byteLength: 13 } },
      ].map((change) => ({ ...context, identity: { ...identity, ...change } })),
    ];
    for (const codexContext of contexts) {
      const next = { ...scope, codexContext };
      expect(updateProductionScope(scope, next)).toBe(next);
    }
    const { codexContext: _context, ...withoutContext } = scope;
    expect(updateProductionScope(scope, withoutContext)).toBe(withoutContext);
  });

  it('retains pending/refreshing/unavailable identities but publishes every changed lease or status detail', () => {
    if (scope.codexContext?.status !== 'current') throw new Error('Expected current fixture');
    const lastVerified = scope.codexContext.identity;
    type Context = NonNullable<ProductionScope['codexContext']>;
    const pending = { status: 'pending' as const, placekeeperSessionId: 'session', documentGeneration: 1, expiresAt: '2026-09-07T13:00:00.000Z' };
    const refreshing = { status: 'refreshing' as const, placekeeperSessionId: 'session', documentGeneration: 1, lastVerified };
    const unavailable = { status: 'unavailable' as const, reason: 'expired' as const, lastVerified };
    const cases: readonly (readonly [Context, readonly Context[]])[] = [
      [pending, [
        { ...pending, placekeeperSessionId: 'other' },
        { ...pending, documentGeneration: 2 },
        { ...pending, expiresAt: '2026-09-07T13:01:00.000Z' },
      ]],
      [refreshing, [
        { ...refreshing, placekeeperSessionId: 'other' },
        { ...refreshing, documentGeneration: 2 },
        { ...refreshing, lastVerified: { ...lastVerified, reviewRevision: 1 } },
        { status: 'refreshing', placekeeperSessionId: 'session', documentGeneration: 1 },
      ]],
      [unavailable, [
        { ...unavailable, reason: 'unauthorized' },
        { ...unavailable, lastVerified: { ...lastVerified, reviewRevision: 1 } },
        { status: 'unavailable', reason: 'expired' },
      ]],
      [{ status: 'unbound' }, [pending]],
    ];
    for (const [codexContext, changedContexts] of cases) {
      const current = { ...scope, codexContext };
      expect(updateProductionScope(current, JSON.parse(JSON.stringify(current)))).toBe(current);
      for (const changedContext of changedContexts) {
        const next = { ...scope, codexContext: changedContext };
        expect(updateProductionScope(current, next)).toBe(next);
      }
    }
  });
});

describe("one production review tree", () => {
  it('routes annotation reference requests through canonical geometry and rejects stale source identity', () => {
    const item = {
      id: 'owned-a', kind: 'pageNote' as const, pageIndex: 2,
      createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
      payload: { position: { x: 24, y: 80, width: 12, height: 12 }, comment: 'Note' },
    };
    const existing = {
      id: 'native-a', subtype: 'Text', pageIndex: 3,
      rect: { x: 30, y: 90, width: 10, height: 10 }, contents: 'Imported', author: '',
      flags: [], appearanceModes: [], supportedAppearance: true,
    };
    const sources = {
      items: [item],
      existingAnnotations: { status: 'ready' as const, generation: 6, items: [existing] },
      documentGeneration: 4,
      pageCount: 8,
    };
    const owned = annotationReferenceRequest({ origin: 'owned', itemId: item.id }, sources);
    expect(owned).toMatchObject({
      pageIndex: 2,
      target: { documentGeneration: 4, pageIndex: 2 },
      metadata: { pageContext: 'Page 3' },
    });
    expect(owned?.target.zoom.params).toEqual([24, 80, 0]);
    expect(annotationReferenceRequest({
      origin: 'source', annotationKey: '3:native-a', documentGeneration: 4,
      discoveryGeneration: 6,
    }, sources)?.target.zoom.params).toEqual([30, 90, 0]);
    expect(annotationReferenceRequest({
      origin: 'source', annotationKey: '3:native-a', documentGeneration: 4,
      discoveryGeneration: 5,
    }, sources)).toBeNull();
  });

  it('scopes transient annotation evidence and deeply freezes reference recovery', () => {
    expect(pdfAnnotationSurfaceIsCurrent(
      { kind: 'reference', documentGeneration: 4, tabIdentity: 'tab-a' },
      { documentGeneration: 4, activeReferenceTabIdentity: 'tab-a', referenceVisible: true },
    )).toBe(true);
    expect(pdfAnnotationSurfaceIsCurrent(
      { kind: 'reference', documentGeneration: 4, tabIdentity: 'tab-b' },
      { documentGeneration: 4, activeReferenceTabIdentity: 'tab-a', referenceVisible: true },
    )).toBe(false);
    expect(pdfAnnotationSurfaceIsCurrent(
      { kind: 'reference', documentGeneration: 4, tabIdentity: 'tab-a' },
      { documentGeneration: 4, activeReferenceTabIdentity: 'tab-a', referenceVisible: false },
    )).toBe(false);
    expect(pdfAnnotationSurfaceIsCurrent(undefined, {
      documentGeneration: 4, activeReferenceTabIdentity: 'tab-a', referenceVisible: true,
    })).toBe(true);

    const target = {
      documentGeneration: 4, pageIndex: 2,
      zoom: { mode: PdfZoomMode.XYZ, params: [24, 80, 0] }, identity: 'canonical',
    };
    const recovery = frozenReferenceRecovery({
      identity: 'tab-a', originalTarget: target, label: 'Note', pageContext: 'Page 3',
    });
    target.zoom.params[0] = 999;
    expect(recovery.target.zoom.params).toEqual([24, 80, 0]);
    expect(Object.isFrozen(recovery)).toBe(true);
    expect(Object.isFrozen(recovery.target.zoom.params)).toBe(true);
  });

  it('returns a Reference draft to its frozen page-14 anchor rather than the tab opening target', () => {
    const authority = { sourceIdentity: 'file:digest', documentGeneration: 4 };
    const openedOnPageOne = {
      documentGeneration: 4, pageIndex: 0,
      zoom: { mode: PdfZoomMode.XYZ, params: [0, 0, 0] }, identity: 'page-1',
    };
    const anchor = {
      token: 8,
      authority,
      pageIndex: 13,
      point: { x: 44, y: 180 },
      surface: { kind: 'reference' as const, documentGeneration: 4, tabIdentity: 'tab-a' },
      referenceRecovery: {
        target: openedOnPageOne,
        tabIdentity: 'tab-a',
        label: 'Original reference',
        pageContext: 'Page 1',
      },
    };

    const target = authoringReferenceTarget(anchor, authority, 20);
    expect(target).toMatchObject({ documentGeneration: 4, pageIndex: 13 });
    expect(target?.zoom.params).toEqual([44, 180, 0]);
    expect(openedOnPageOne.pageIndex).toBe(0);
    expect(authoringReferenceTarget(anchor, {
      sourceIdentity: 'replacement:digest', documentGeneration: 5,
    }, 20)).toBeNull();
  });

  it('keeps equivalent runtime viewer authority stable across review-state snapshots', () => {
    expect(viewerAssetUrlsEqual(
      {
        pdfiumWasm: '/assets/pdfium.wasm',
        workerUrl: '/assets/pdfium-worker.js',
        documentUrl: '/document.pdf',
        requestHeaders: { authorization: 'Bearer test', 'x-scope': 'review' },
      },
      {
        pdfiumWasm: '/assets/pdfium.wasm',
        workerUrl: '/assets/pdfium-worker.js',
        documentUrl: '/document.pdf',
        requestHeaders: { 'x-scope': 'review', authorization: 'Bearer test' },
      },
    )).toBe(true);
    expect(viewerAssetUrlsEqual(
      { pdfiumWasm: '/assets/pdfium.wasm', documentUrl: '/document.pdf' },
      { pdfiumWasm: '/assets/pdfium.wasm', documentUrl: '/next.pdf' },
    )).toBe(false);
    expect(viewerAssetUrlsEqual(
      {
        pdfiumWasm: '/assets/pdfium.wasm',
        workerUrl: '/assets/pdfium-worker.js',
        documentUrl: '/document.pdf',
        requestHeaders: { authorization: 'Bearer first' },
      },
      {
        pdfiumWasm: '/assets/pdfium.wasm',
        workerUrl: '/assets/pdfium-worker.js',
        documentUrl: '/document.pdf',
        requestHeaders: { authorization: 'Bearer second' },
      },
    )).toBe(false);
    expect(viewerAssetUrlsEqual(
      {
        pdfiumWasm: '/assets/pdfium.wasm',
        workerUrl: '/assets/pdfium-worker.js',
        documentUrl: '/document.pdf',
      },
      {
        pdfiumWasm: '/assets/pdfium.wasm',
        workerUrl: '/assets/next-worker.js',
        documentUrl: '/document.pdf',
      },
    )).toBe(false);
    expect(viewerResourcePoliciesEqual(
      { host: 'browser', origin: 'http://127.0.0.1:4000' },
      { host: 'browser', origin: 'http://127.0.0.1:4000' },
    )).toBe(true);
    expect(viewerResourcePoliciesEqual(
      { host: 'vscode', issued: new Set(['/document.pdf', '/assets/pdfium.wasm']) },
      { host: 'vscode', issued: new Set(['/assets/pdfium.wasm', '/document.pdf']) },
    )).toBe(true);
    expect(viewerResourcePoliciesEqual(
      { host: 'browser', origin: 'http://127.0.0.1:4000' },
      {
        host: 'macos',
        resources: {
          document: '/document.pdf',
          pdfiumWasm: '/assets/pdfium.wasm',
          worker: '/assets/pdfium-worker.js',
        },
      },
    )).toBe(false);
    expect(viewerResourcePoliciesEqual(
      {
        host: 'chrome',
        extensionOrigin: 'chrome-extension://placekeeper',
        resources: {
          document: '/document.pdf',
          pdfiumWasm: '/assets/pdfium.wasm',
          worker: '/assets/pdfium-worker.js',
        },
      },
      {
        host: 'chrome',
        extensionOrigin: 'chrome-extension://placekeeper',
        resources: {
          document: '/next.pdf',
          pdfiumWasm: '/assets/pdfium.wasm',
          worker: '/assets/pdfium-worker.js',
        },
      },
    )).toBe(false);
    expect(viewerResourcePoliciesEqual(
      {
        host: 'macos',
        resources: {
          document: '/document.pdf',
          pdfiumWasm: '/assets/pdfium.wasm',
          worker: '/assets/pdfium-worker.js',
        },
      },
      {
        host: 'macos',
        resources: {
          document: '/document.pdf',
          pdfiumWasm: '/assets/pdfium.wasm',
          worker: '/assets/next-worker.js',
        },
      },
    )).toBe(false);
    expect(viewerResourcePoliciesEqual(
      { host: 'vscode', issued: new Set(['/document.pdf', '/assets/pdfium.wasm']) },
      { host: 'vscode', issued: new Set(['/assets/pdfium.wasm']) },
    )).toBe(false);
  });

  it('navigates a cross-page item once through its canonical first segment', () => {
    expect(reviewItemNavigationTarget({
      id: 'cross-page',
      kind: 'highlight',
      pageIndex: 2,
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
      payload: {
        quote: 'first\nlast',
        prefix: '',
        suffix: '',
        rect: { x: 20, y: 80, width: 40, height: 12 },
        segmentRects: [{ x: 20, y: 80, width: 40, height: 12 }],
        pages: [
          {
            pageIndex: 2,
            quote: 'first',
            prefix: '',
            suffix: '',
            rect: { x: 20, y: 80, width: 40, height: 12 },
            segmentRects: [{ x: 20, y: 80, width: 40, height: 12 }],
          },
          {
            pageIndex: 3,
            quote: 'last',
            prefix: '',
            suffix: '',
            rect: { x: 12, y: 16, width: 32, height: 12 },
            segmentRects: [{ x: 12, y: 16, width: 32, height: 12 }],
          },
        ],
        pageBoundaries: [{ afterPageIndex: 2, separator: '\n' }],
        reliable: true,
        comment: '',
      },
    })).toEqual({ pageIndex: 2, point: { x: 20, y: 80 } });
  });

  it("chooses the next, previous, or section fallback after attention rows disappear", () => {
    const keys = ["first", "middle", "final"];
    expect(reconciliationFocusKeyAfterRemoval(keys, "first")).toBe("middle");
    expect(reconciliationFocusKeyAfterRemoval(keys, "middle")).toBe("final");
    expect(reconciliationFocusKeyAfterRemoval(keys, "final")).toBe("middle");
    expect(reconciliationFocusKeyAfterRemoval(["only"], "only")).toBeNull();
  });

  it("defers a host forward SyncTeX request until its PDF generation and restoration are ready", () => {
    expect(forwardSyncTexRequestReady({
      requestGeneration: 4,
      documentGeneration: 3,
      navigationReadyGeneration: 3,
      documentReadyGeneration: 3,
      locationRestoreStatus: "idle",
    })).toBe(false);
    expect(forwardSyncTexRequestReady({
      requestGeneration: 4,
      documentGeneration: 4,
      navigationReadyGeneration: 4,
      documentReadyGeneration: 4,
      locationRestoreStatus: "restoring",
    })).toBe(false);
    expect(forwardSyncTexRequestReady({
      requestGeneration: 4,
      documentGeneration: 4,
      navigationReadyGeneration: 4,
      documentReadyGeneration: 4,
      locationRestoreStatus: "idle",
    })).toBe(true);
    expect(forwardSyncTexRequestReady({
      requestGeneration: 4,
      documentGeneration: 4,
      navigationReadyGeneration: 4,
      documentReadyGeneration: 4,
      locationRestoreStatus: "fallback",
    })).toBe(true);
  });

  it("ignores a forward SyncTeX completion after its request, generation, or navigation is superseded", () => {
    const current = {
      requestToken: 2,
      latestRequestToken: 2,
      requestGeneration: 4,
      documentGeneration: 4,
      navigationMatches: true,
    };
    expect(forwardSyncTexCompletionIsCurrent(current)).toBe(true);
    expect(forwardSyncTexCompletionIsCurrent({ ...current, latestRequestToken: 3 })).toBe(false);
    expect(forwardSyncTexCompletionIsCurrent({ ...current, documentGeneration: 5 })).toBe(false);
    expect(forwardSyncTexCompletionIsCurrent({ ...current, navigationMatches: false })).toBe(false);
  });

  it("publishes only the current forward SyncTeX completion and converts rejection to failure", async () => {
    let resolveApply!: (applied: boolean) => void;
    const applyLocation = vi.fn(() => new Promise<boolean>((resolve) => { resolveApply = resolve; }));
    const navigation = {
      captureLocation: vi.fn(() => ({
        pageIndex: 0,
        anchor: { x: 0, y: 0 },
        alignment: { xPercent: 50, yPercent: 50 },
        zoom: 1,
      })),
      applyLocation,
      focusAtDestination: vi.fn(),
    };
    const publishResult = vi.fn();
    let current = true;
    const request = runHostForwardSyncTexRequest(
      navigation,
      { pageIndex: 2, point: { x: 72, y: 144 } },
      () => current,
      publishResult,
    );
    current = false;
    resolveApply(false);
    await request;
    expect(publishResult).not.toHaveBeenCalled();

    await runHostForwardSyncTexRequest(
      { ...navigation, applyLocation: vi.fn(async () => { throw new Error("viewer replaced"); }) },
      { pageIndex: 2, point: { x: 72, y: 144 } },
      () => true,
      publishResult,
    );
    expect(publishResult).toHaveBeenCalledWith(false);
  });

  it("centers a trusted forward SyncTeX point without changing the current zoom", async () => {
    const applyLocation = vi.fn(async () => true);
    const focusAtDestination = vi.fn(() => true);
    const navigation = {
      captureLocation: vi.fn(() => ({
        pageIndex: 0,
        anchor: { x: 0, y: 0 },
        alignment: { xPercent: 10, yPercent: 20 },
        zoom: 1.25,
      })),
      applyLocation,
      focusAtDestination,
    };

    await expect(applyHostForwardSyncTex(navigation, {
      pageIndex: 2,
      point: { x: 72, y: 144 },
    })).resolves.toBe(true);
    expect(applyLocation).toHaveBeenCalledWith({
      pageIndex: 2,
      anchor: { x: 72, y: 144 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1.25,
    });
    expect(focusAtDestination).toHaveBeenCalledWith(2);
    await expect(applyHostForwardSyncTex(navigation, {
      pageIndex: -1,
      point: { x: 72, y: 144 },
    })).resolves.toBe(false);
  });

  it("starts reverse SyncTeX from the current visible PDF anchor", async () => {
    const reverseSyncTex = vi.fn(async () => ({ status: "ok" }));
    const navigation = {
      captureLocation: vi.fn(() => ({
        pageIndex: 2,
        anchor: { x: 72, y: 144 },
        alignment: { xPercent: 50, yPercent: 50 },
        zoom: 1.25,
      })),
    };

    await expect(reverseSyncTexAtCurrentLocation(navigation, reverseSyncTex)).resolves.toBe(true);
    expect(reverseSyncTex).toHaveBeenCalledWith({
      pageIndex: 2,
      point: { x: 72, y: 144 },
    });
    await expect(reverseSyncTexAtCurrentLocation(
      { captureLocation: () => null },
      reverseSyncTex,
    )).resolves.toBe(false);
    await expect(reverseSyncTexAtCurrentLocation(
      navigation,
      async () => ({ status: "missing" }),
    )).resolves.toBe(false);
  });

  it("keeps a newer successful reverse SyncTeX result when an older request fails later", async () => {
    const coordinator = new ReverseSyncTexRequestCoordinator();
    const errors: Array<string | null> = [];
    let resolveOlder: ((value: unknown) => void) | undefined;
    const older = coordinator.run(
      () => new Promise((resolve) => { resolveOlder = resolve; }),
      { pageIndex: 0, point: { x: 10, y: 20 } },
      (error) => errors.push(error),
    );
    await coordinator.run(
      async () => ({ status: 'ok' }),
      { pageIndex: 1, point: { x: 30, y: 40 } },
      (error) => errors.push(error),
    );
    resolveOlder?.({ status: 'missing' });
    await older;

    expect(errors.at(-1)).toBeNull();
  });

  it("explains actionable reverse SyncTeX failures", () => {
    expect(reverseSyncTexError({ status: 'missing' })).toContain('Rebuild');
    expect(reverseSyncTexError({ status: 'stale' })).toContain('stale');
    expect(reverseSyncTexError({ status: 'unavailable-tool' })).toContain('unavailable');
    expect(reverseSyncTexError({ status: 'failed', reason: 'workspace-untrusted' })).toContain('Trust');
    expect(reverseSyncTexError({ status: 'ok' })).toBeNull();
  });

  it("routes the VS Code reattach command to the first canonical unresolved item", () => {
    const resolved = { id: "resolved", reconciliation: { disposition: { kind: "resolved" } } };
    const ambiguous = { id: "ambiguous", reconciliation: { disposition: { kind: "ambiguous" } } };
    const missing = { id: "missing", reconciliation: { disposition: { kind: "missing" } } };
    expect(firstUnresolvedReviewItemId([resolved, ambiguous, missing])).toBe("ambiguous");
    expect(firstUnresolvedReviewItemId([resolved])).toBeUndefined();
  });

  it("adopts same-generation canonical freshness without requiring a review revision", () => {
    const current = { revision: 2, workflow: { documentGeneration: 3, freshness: "current" as const } };
    const stale = { revision: 2, workflow: { documentGeneration: 3, freshness: "possibly-stale" as const } };
    expect(canonicalStateSupersedes(current, stale)).toBe(true);
    expect(canonicalStateSupersedes(stale, current)).toBe(false);
    expect(canonicalStateSupersedes(current, current)).toBe(false);
  });
  it("renders canonical unresolved work, frozen drafts, freshness, and export gates", () => {
    const base = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000071",
      source: { fileId: "00000000-0000-4000-8000-000000000072", digest: "d".repeat(64), byteLength: 10 },
      workflowMode: "generated-output",
      documentGeneration: 4,
    });
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "old sentence",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 2, width: 30, height: 8 },
      segmentRects: [{ x: 1, y: 2, width: 30, height: 8 }],
    };
    const state = {
      ...base,
      workflow: { ...base.workflow, freshness: "possibly-stale" as const },
      items: [{
        id: "00000000-0000-4000-8000-000000000073",
        kind: "replace" as const,
        pageIndex: 0,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        payload: { ...anchor, reliable: true, proposedText: "new sentence" },
        reconciliation: {
          schemaVersion: 1 as const,
          ownerViewId: "view-1",
          baseGeneration: 3,
          revision: 2,
          anchor,
          disposition: { kind: "ambiguous" as const, reason: "two matching passages" },
          previousAnchors: [],
        },
      }],
      pendingDrafts: [{
        id: "00000000-0000-4000-8000-000000000074",
        ownerViewId: "view-1",
        baseGeneration: 3,
        revision: 1,
        kind: "replace" as const,
        pageIndex: 0,
        text: "unfinished wording",
        anchor,
        disposition: { kind: "missing" as const, reason: "draft-frozen-on-predecessor-generation" },
        status: "frozen" as const,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }],
    };

    const html = renderToStaticMarkup(<ReconciliationWorkspace
      state={state}
      selectionUpdate={{ kind: "cleared", generation: 1 }}
      caretAnchor={null}
      refreshStatus="idle"
      onCommand={vi.fn()}
    />);

    expect(html).toContain('data-reconciliation-workspace');
    expect(html).toContain("Needs attention");
    expect(html).toContain("new sentence");
    expect(html).toContain("unfinished wording");
    expect(html).toContain("Multiple matches");
    expect(html).toContain("Needs new location");
    expect(html).not.toContain('data-reconciliation-action="reattach"');
    expect(html).toContain('data-reconciliation-action="discard"');
    expect(html).toContain('aria-label="Reattach previous Replace annotation on page 1"');
    expect(html).not.toContain("Ambiguous anchor");
    expect(html).not.toContain("Frozen draft");
    expect(html).not.toContain("two matching passages");
    expect(html).not.toContain(">Apply</button>");
    expect(html).not.toContain("Generation 4 is possibly stale");
    expect(html).not.toContain("Export reviewed PDF");
  });

  it("builds revision-fenced reattachment commands without changing semantic identity", () => {
    const anchor = {
      kind: "selection" as const,
      pageIndex: 2,
      quote: "replacement target",
      prefix: "left",
      suffix: "right",
      rect: { x: 2, y: 3, width: 40, height: 9 },
      segmentRects: [{ x: 2, y: 3, width: 40, height: 9 }],
    };
    expect(buildReattachmentCommand({
      target: { kind: "item", id: "item-1", revision: 5, ownerViewId: "view-1" },
      stateRevision: 9,
      documentGeneration: 7,
      anchor,
      updatedAt: "2026-08-27T01:00:00.000Z",
    })).toMatchObject({
      type: "reattach",
      expectedRevision: 9,
      id: "item-1",
      expectedReconciliationRevision: 5,
      ownerViewId: "view-1",
      anchor,
    });

    const draft = {
      id: "draft-1",
      ownerViewId: "view-1",
      baseGeneration: 6,
      revision: 3,
      kind: "replace" as const,
      pageIndex: 0,
      text: "do not lose this text",
      anchor,
      disposition: { kind: "missing" as const, reason: "predecessor" },
      status: "frozen" as const,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(buildReattachmentCommand({
      target: { kind: "draft", draft },
      stateRevision: 9,
      documentGeneration: 7,
      anchor,
      updatedAt: "2026-08-27T01:00:00.000Z",
    })).toMatchObject({
      type: "put-draft",
      expectedRevision: 9,
      expectedDraftRevision: 3,
      draft: {
        id: "draft-1",
        text: "do not lose this text",
        baseGeneration: 7,
        status: "protected",
        disposition: { kind: "resolved", generation: 7 },
      },
    });
    expect(reattachmentGenerationIsCurrent(7, 8)).toBe(false);
  });

  it("keeps invalid or ambiguous replacement evidence unconfirmable", () => {
    expect(reattachmentCandidateFor("selection", {
      kind: "unreliable",
      generation: 4,
      userMessage: "The selection matches more than one passage.",
      diagnostic: "selection-quote-not-unique",
    }, null)).toEqual({
      anchor: null,
      message: "The selection matches more than one passage.",
    });
    expect(reattachmentCandidateFor("caret", { kind: "cleared", generation: 4 }, null).anchor).toBeNull();
    expect(reconciliationCommandRejectionMessage({
      accepted: false,
      message: "Another review window changed this draft.",
    })).toBe("Another review window changed this draft.");
    expect(reconciliationCommandRejectionMessage({})).toBeNull();
  });

  it("names each focused reattachment task with its annotation intent", () => {
    expect(([
      "highlight",
      "delete",
      "insert",
      "replace",
      "pageNote",
    ] as const).map(reattachmentTitle)).toEqual([
      "Reattach highlight",
      "Reattach deletion",
      "Reattach insertion",
      "Reattach replacement",
      "Reattach page note",
    ]);
  });

  it("explains reconciling, unresolved, stale-confirmation, and eligible export states", () => {
    const summary = (unresolvedItems: number, pendingDrafts: number, freshness: "current" | "possibly-stale") => ({
      ...createReviewStateSummary({
        ...createReviewState({
          sessionId: "00000000-0000-4000-8000-000000000099",
          source: { fileId: "00000000-0000-4000-8000-000000000098", digest: "f".repeat(64), byteLength: 1 },
          workflowMode: "generated-output",
          documentGeneration: 1,
        }),
        workflow: {
          ...createReviewState({
            sessionId: "00000000-0000-4000-8000-000000000099",
            source: { fileId: "00000000-0000-4000-8000-000000000098", digest: "f".repeat(64), byteLength: 1 },
            workflowMode: "generated-output",
            documentGeneration: 1,
          }).workflow,
          freshness,
        },
      }),
      reconciliation: {
        complete: unresolvedItems === 0 && pendingDrafts === 0,
        dispositionDigest: "0".repeat(64),
        unresolvedItemIds: Array.from({ length: unresolvedItems }, (_, index) => `item-${index}`),
        pendingDraftIds: Array.from({ length: pendingDrafts }, (_, index) => `draft-${index}`),
      },
      export: unresolvedItems > 0 || pendingDrafts > 0
        ? { eligible: false as const, requiresStaleConfirmation: false as const, reasons: [unresolvedItems > 0 ? "unresolved-items" as const : "pending-drafts" as const] }
        : freshness === "possibly-stale"
          ? { eligible: false as const, requiresStaleConfirmation: true as const, reasons: ["possibly-stale" as const] }
          : { eligible: true as const, requiresStaleConfirmation: false as const },
    });
    expect(reviewExportPresentation({
      refreshStatus: "reconciling",
      summary: summary(0, 0, "current"),
    }).message).toContain("reconciliation finishes");
    expect(reviewExportPresentation({
      refreshStatus: "idle",
      summary: summary(2, 0, "current"),
    }).message).toBe("2 annotations to resolve.");
    expect(reviewExportPresentation({
      refreshStatus: "idle",
      summary: summary(0, 0, "possibly-stale"),
    })).toMatchObject({ canExport: true, requiresStaleConfirmation: true });
    expect(reviewExportPresentation({
      refreshStatus: "idle",
      summary: summary(0, 0, "current"),
    })).toMatchObject({ canExport: true, requiresStaleConfirmation: false });
  });

  it("integrates generated-output reconciliation and export without automatic-save controls", () => {
    const state = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000081",
      source: { fileId: "00000000-0000-4000-8000-000000000082", digest: "e".repeat(64), byteLength: 20 },
      workflowMode: "generated-output",
      documentGeneration: 8,
    });
    const renderSurface = (launchSurface: "browser" | "vscode") => renderToStaticMarkup(
      <ProductionReviewApp
        session={{ sessionId: state.sessionId }}
        initialState={state}
        scope={{ documentTitle: "paper.pdf", launchSurface }}
        api={{
          command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
          chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
          exportReviewedCopy: vi.fn(), scope: vi.fn(),
        }}
        viewer={<div>Generation 8 viewer</div>}
      />,
    );
    const html = renderSurface("vscode");
    const browserHtml = renderSurface("browser");

    expect(html).toContain("Generation 8 viewer");
    expect(html).toContain('data-launch-surface="vscode"');
    expect(html).not.toContain('data-reconciliation-workspace');
    expect(html).toContain('aria-label="Annotations"');
    expect(html).toContain('data-existing-annotations-state="loading"');
    expect(html).toContain('data-annotation-status="loading"');
    expect(html).not.toContain('Select text in the PDF to add an annotation.');
    expect(html).toContain('data-document-actions-trigger');
    expect(html).toContain('aria-haspopup="menu"');
    const titleTrigger = html.slice(
      html.lastIndexOf('<button', html.indexOf('data-document-actions-trigger')),
      html.indexOf('</button>', html.indexOf('data-document-actions-trigger')),
    );
    expect(titleTrigger).not.toContain('lucide-chevron-down');
    expect(html).not.toContain('class="reconciliation-workspace__footer"');
    expect(html).toContain("Protected review state");
    expect(html).not.toContain("Open automatic save options");
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(browserHtml).toContain('data-launch-surface="browser"');
    expect(browserHtml).toContain('data-document-actions-trigger');
    expect(browserHtml).toContain('aria-haspopup="menu"');
  });

  it("omits an empty attention section during rebuild progress and failure", () => {
    const state = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000091",
      source: { fileId: "00000000-0000-4000-8000-000000000092", digest: "d".repeat(64), byteLength: 1 },
      workflowMode: "generated-output",
      documentGeneration: 2,
    });

    for (const refreshStatus of ["reconciling", "failed"] as const) {
      const html = renderToStaticMarkup(<ReconciliationWorkspace
        state={state}
        selectionUpdate={{ kind: "cleared", generation: 2 }}
        caretAnchor={null}
        refreshStatus={refreshStatus}
        onCommand={vi.fn()}
      />);
      expect(html).not.toContain("Needs attention");
      expect(html).not.toContain("reconciliation-workspace");
    }
  });

  it("exposes Reference return state only for the current tab and document generation", () => {
    const presentation = {
      tabIdentity: "reference-a",
      documentGeneration: 4,
      available: true,
      pending: true,
    } as const;
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 4,
    }, presentation)).toBe(presentation);
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-b",
      documentGeneration: 4,
    }, presentation)).toBeNull();
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 5,
    }, presentation)).toBeNull();
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 4,
    }, null)).toBeNull();
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 4,
    }, { ...presentation, available: false })).toBeNull();
  });

  it("keeps clean imported review items portable without an active save destination", () => {
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000031",
        source: { fileId: "00000000-0000-4000-8000-000000000032", digest: "a".repeat(64), byteLength: 12 },
      }),
      revision: 1,
      items: [{
        id: "00000000-0000-4000-8000-000000000033",
        kind: "pageNote" as const,
        pageIndex: 0,
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Imported" },
      }],
    };
    expect(initiallyPortableItemIds(state, {
      destination: { phase: "none", generation: 0 },
      sync: { phase: "clean", desiredRevision: 1, savedRevision: 1 },
    })).toEqual(new Set(["00000000-0000-4000-8000-000000000033"]));
  });

  it("derives owned and source subsection labels from safe document geometry", () => {
    const outlineTarget = {
      documentGeneration: 4,
      pageIndex: 0,
      zoom: { mode: PdfZoomMode.XYZ, params: [172, 1500, 1] },
      identity: JSON.stringify([4, 0, PdfZoomMode.XYZ, 172, 1500, 1]),
    };
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: 4,
      outline: {
        status: "loaded-tree",
        documentGeneration: 4,
        items: [{
          id: "outline-methods",
          label: "Methods and data",
          pageContext: "Page 1",
          target: outlineTarget,
          children: [],
        }],
      },
      pages: [{
        size: { width: 600, height: 800 },
        crop: { left: 100, top: 200, bottom: 1000 },
      }],
      owned: [{
        id: "owned-note",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: 172, y: 600, width: 10, height: 10 }, comment: "Check" },
      }],
      source: [{
        id: "source-note",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: 172, y: 320, width: 10, height: 10 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.get("owned-note")).toBe("Methods and data");
    expect(labels.source.get("0:source-note")).toBe("Methods and data");
  });

  it.each([
    [{ status: "loading" as const, documentGeneration: 4 }, 4],
    [{ status: "loaded-empty" as const, documentGeneration: 4 }, 4],
    [{ status: "unavailable" as const, documentGeneration: 4 }, 4],
    [{
      status: "loaded-tree" as const,
      documentGeneration: 3,
      items: [{
        id: "stale-outline",
        label: "Stale outline",
        pageContext: "Page 1",
        target: {
          documentGeneration: 4,
          pageIndex: 0,
          zoom: { mode: PdfZoomMode.FitPage, params: [] },
          identity: "otherwise-safe-target",
        },
        children: [],
      }],
    }, 4],
  ])("omits subsection labels for incomplete or stale outline discovery", (outline, generation) => {
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: generation,
      outline,
      pages: [{ size: { width: 600, height: 800 }, crop: { left: 0, top: 0, bottom: 0 } }],
      owned: [{
        id: "valid-owned",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: 10, y: 100, width: 1, height: 1 }, comment: "Check" },
      }],
      source: [{
        id: "valid-source",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: 10, y: 100, width: 1, height: 1 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.size).toBe(0);
    expect(labels.source.size).toBe(0);
  });

  it("fails closed for unsafe outline evidence with otherwise valid annotations", () => {
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: 4,
      outline: {
        status: "loaded-tree",
        documentGeneration: 4,
        items: [{
          id: "unsafe",
          label: "Unsafe",
          pageContext: "Page 1",
          target: {
            documentGeneration: 3,
            pageIndex: 0,
            zoom: { mode: PdfZoomMode.FitPage, params: [] },
            identity: "stale-target",
          },
          children: [],
        }],
      },
      pages: [{ size: { width: 600, height: 800 }, crop: { left: 0, top: 0, bottom: 0 } }],
      owned: [{
        id: "valid-owned",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: 10, y: 100, width: 1, height: 1 }, comment: "Check" },
      }],
      source: [{
        id: "valid-source",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: 10, y: 100, width: 1, height: 1 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.size).toBe(0);
    expect(labels.source.size).toBe(0);
  });

  it("omits labels for invalid annotation geometry with a safe outline", () => {
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: 4,
      outline: {
        status: "loaded-tree",
        documentGeneration: 4,
        items: [{
          id: "safe",
          label: "Safe",
          pageContext: "Page 1",
          target: {
            documentGeneration: 4,
            pageIndex: 0,
            zoom: { mode: PdfZoomMode.FitPage, params: [] },
            identity: "safe-target",
          },
          children: [],
        }],
      },
      pages: [{ size: { width: 600, height: 800 }, crop: { left: 0, top: 0, bottom: 0 } }],
      owned: [{
        id: "invalid-owned",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: Number.NaN, y: 1, width: 1, height: 1 }, comment: "Check" },
      }],
      source: [{
        id: "invalid-source",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: Number.NaN, y: 1, width: 1, height: 1 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.size).toBe(0);
    expect(labels.source.size).toBe(0);
  });

  it("suppresses labels until source identity and navigation generation are current", () => {
    const current = {
      sourceIdentity: "new-source",
      activeSourceIdentity: "new-source",
      navigationGeneration: 5,
      outlineGeneration: 5,
    };
    expect(canDeriveAnnotationOutlineLabels(current)).toBe(true);
    expect(canDeriveAnnotationOutlineLabels({
      ...current,
      activeSourceIdentity: "old-source",
    })).toBe(false);
    expect(canDeriveAnnotationOutlineLabels({
      ...current,
      navigationGeneration: 4,
    })).toBe(false);
  });

  it("keeps the ordinary-browser review free of Codex controls or ambient status", () => {
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000001",
        source: { fileId: "00000000-0000-4000-8000-000000000002", digest: "a".repeat(64), byteLength: 12 },
        sourceRootId: "00000000-0000-4000-8000-000000000003",
      }),
      revision: 1,
      items: [{
        id: "00000000-0000-4000-8000-000000000004", kind: "pageNote" as const, pageIndex: 0,
        createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Fix" },
      }],
    };
    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{ documentTitle: "paper.pdf", sourceRootPath: "/tmp/source" }}
      api={{
        command: vi.fn(),
        saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        scope: vi.fn(),
      }}
      viewer={<div role="application">Real shared PDF viewer</div>}
    />);
    expect(html).toContain("Real shared PDF viewer");
    expect(html).not.toContain("aria-label=\"Actions\"");
    expect(html).not.toContain('aria-label="Edit history"');
    expect(html).toContain('aria-label="Document navigation"');
    expect(html).toContain('aria-label="Current page unavailable"');
    expect(html).toContain('aria-label="PDF zoom"');
    expect(html).toContain('aria-label="Zoom unavailable"');
    expect(html).toContain("paper.pdf, not saved. Open automatic save options");
    expect(html).toContain('data-save-phase="not-saved"');
    expect(html).toContain("Not saved");
    expect(html).not.toContain("Codex");
    expect(html).not.toContain('data-codex-context');
    expect(html).toContain('data-review-item="00000000-0000-4000-8000-000000000004"');
    expect(html).not.toContain("Finish review");
    expect(html).not.toContain("Discard review");
    expect(html).not.toContain("Human delivery");
    expect(html).toContain('data-annotation-drawer');
    expect(html).toContain('Existing annotations are loading');
    expect(html).toContain('data-reference-layout="wide-closed"');
    expect(html).toContain('data-workspace-edge-rail="right"');
    expect(html).not.toContain('data-workspace-edge-rail="bottom"');
    expect(html).toContain('data-workspace-mode="search"');
    expect(html).toContain('aria-label="Search this PDF"');
    expect(html).not.toContain('>Workspace</button>');
    expect(html).not.toContain("delivery-layout");
    expect(html.match(/Real shared PDF viewer/g)).toHaveLength(1);
    expect(html).not.toContain("Submit task");
    expect(html).not.toContain('aria-modal="true" aria-labelledby="finish-review-heading"');
  });

  it("omits the redundant document link from Chrome while retaining it on app-hosted surfaces", () => {
    const state = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000101",
      source: { fileId: "00000000-0000-4000-8000-000000000102", digest: "a".repeat(64), byteLength: 12 },
    });
    const api = {
      command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
      chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
      scope: vi.fn(),
    };
    const renderSurface = (launchSurface: "browser" | "chrome") => renderToStaticMarkup(
      <ProductionReviewApp
        session={{ sessionId: state.sessionId }}
        initialState={state}
        scope={{ documentTitle: "paper.pdf", launchSurface }}
        api={api}
        copyLinkBase="placekeeper:///tmp/paper.pdf"
        locationHistory={new MemoryReviewLocationHistory()}
        viewer={<div>Viewer</div>}
      />,
    );

    expect(renderSurface("browser")).toContain('data-review-copy-link');
    expect(renderSurface("chrome")).not.toContain('data-review-copy-link');
  });

  it('shows actionable save failure only for an established local save destination', () => {
    const state = createReviewState({
      sessionId: '00000000-0000-4000-8000-000000000101',
      source: { fileId: '00000000-0000-4000-8000-000000000102', digest: 'a'.repeat(64), byteLength: 12 },
    });
    const api = {
      command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
      chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(), scope: vi.fn(),
    };
    const renderFailure = (phase: 'clean' | 'saving' | 'not-saved', configured = true, exportOnly = false) =>
      renderToStaticMarkup(<ProductionReviewApp
        session={{ sessionId: state.sessionId }} initialState={state} api={api}
        scope={{ documentTitle: 'paper.pdf', ...(exportOnly ? { persistenceMode: 'export-only' as const } : {}) }}
        initialSaveStatus={{
          destination: configured
            ? { phase: 'active', generation: 1, kind: 'copy', targetPath: '/tmp/paper-annotated.pdf' }
            : { phase: 'none', generation: 0 },
          sync: { phase, desiredRevision: 1, savedRevision: 0 },
        }}
        viewer={<div>Viewer</div>}
      />);
    const failed = renderFailure('not-saved');
    expect(failed).toContain('class="review-toast review-toast--error review-save-notice" role="alert"');
    expect(failed).toContain('Couldn’t save your latest annotations.');
    expect(failed).toContain('>Retry</button>');
    expect(failed).toContain('>Save a copy…</button>');
    expect(renderFailure('clean')).not.toContain('review-save-notice');
    expect(renderFailure('saving')).not.toContain('review-save-notice');
    expect(renderFailure('not-saved', false)).not.toContain('review-save-notice');
    expect(renderFailure('not-saved', true, true)).not.toContain('review-save-notice');
  });

  it("shows passive status only for a trusted Codex launch scope", () => {
    const state = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000011",
      source: { fileId: "00000000-0000-4000-8000-000000000012", digest: "a".repeat(64), byteLength: 12 },
    });
    const api = {
      command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
      chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
      scope: vi.fn(),
    };
    const codex = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{
        documentTitle: "paper.pdf",
        launchSurface: "codex",
        codexContext: { status: "refreshing", placekeeperSessionId: state.sessionId, documentGeneration: 1 },
      }}
      api={api}
      viewer={<div>Viewer</div>}
    />);
    const finder = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{ documentTitle: "paper.pdf", launchSurface: "finder" }}
      api={api}
      viewer={<div>Viewer</div>}
    />);

    expect(codex).toContain('data-codex-context="connecting"');
    expect(codex).toContain("lucide-bot");
    expect(codex).toContain("Agent context updating");
    expect(codex).not.toContain("button>Codex");
    expect(finder).not.toContain('data-codex-context');
    expect(finder).not.toContain("Codex");
  });

  it("renders a previously current Codex identity as refreshing as soon as local review state advances", () => {
    const initial = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000021",
      source: { fileId: "00000000-0000-4000-8000-000000000022", digest: "a".repeat(64), byteLength: 12 },
    });
    const advanced = { ...initial, revision: 1 };
    const current = {
      status: "current" as const,
      identity: {
        placekeeperSessionId: initial.sessionId,
        documentGeneration: 1,
        source: initial.source,
        reviewRevision: 0,
        stateDigest: "b".repeat(64),
      },
      leaseExpiresAt: "2026-08-12T13:00:00.000Z",
    };
    expect(visibleCodexContext(current, advanced)).toMatchObject({
      status: "refreshing",
      lastVerified: { reviewRevision: 0 },
    });

    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: advanced.sessionId, credential: "secret" }}
      initialState={advanced}
      scope={{ documentTitle: "paper.pdf", launchSurface: "codex", codexContext: current }}
      api={{
        command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        scope: vi.fn(),
      }}
      viewer={<div>Viewer</div>}
    />);
    expect(html).toContain('data-codex-context="connecting"');
    expect(html).not.toContain('data-codex-context="current"');
  });

  it("uses one clear automatic-save choice surface with the original first", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ sourceDisposition: "local", filename: "paper-annotated.pdf", folder: "/tmp" }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("Choose where to save annotations");
    expect(html).toContain('class="save-destination-dialog review-choice-dialog compact-editorial-modal"');
    expect(html).toContain('compact-editorial-modal__header');
    expect(html).toContain('compact-editorial-modal__body');
    expect(html).toContain('compact-editorial-modal__footer');
    expect(html.indexOf("Modify the original PDF")).toBeLessThan(html.indexOf("Save to a new copy"));
    expect(html).toContain("Save");
    expect(html).not.toContain('class="lucide lucide-x review-icon"');
    expect(html).not.toContain('class="lucide lucide-check review-icon"');
    expect(html).toContain("You can change this later by clicking the filename.");
    expect(html).not.toContain("Keep annotations in the file you opened.");
    expect(html).not.toContain("Keep the original unchanged.");
  });

  it("asks remote browser PDFs for a fresh name and location without exposing an original", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      sourceDisposition="remote-temporary"
      proposal={{ sourceDisposition: "remote-temporary" }}
      protectedRecovery
      onChooseLocation={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("Protected Recovery");
    expect(html).toContain("Your annotation is protected while you choose where to save it.");
    expect(html).not.toContain("Modify the original PDF");
    expect(html).toContain("PDF name");
    expect(html).toContain("Choose a location…");
    expect(html).not.toContain("Private paper.pdf");
    expect(html).not.toContain("recovery/");
  });

  it("shows a cancelled remote annotation as Protected Recovery with Save available to retry", () => {
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000041",
        source: {
          fileId: "00000000-0000-4000-8000-000000000042",
          digest: "d".repeat(64),
          byteLength: 12,
        },
      }),
      revision: 1,
      items: [{
        id: "00000000-0000-4000-8000-000000000043",
        kind: "pageNote" as const,
        pageIndex: 0,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Protected" },
      }],
    };
    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      initialSaveStatus={{
        destination: { phase: "none", generation: 0 },
        sync: {
          phase: "not-saved",
          desiredRevision: 1,
          savedRevision: 0,
          failure: "destination-unconfigured",
        },
      }}
      scope={{
        documentTitle: "Private paper.pdf",
        sourceDisposition: "remote-temporary",
        sourceDisplayName: "Private paper.pdf",
        launchSurface: "browser",
      }}
      api={{
        command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        scope: vi.fn(),
      }}
      viewer={<div>Viewer</div>}
    />);

    expect(html).toContain("Protected Recovery");
    expect(html).toContain("Private paper.pdf, protected recovery, choose where to save");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-review-item="00000000-0000-4000-8000-000000000043"');
    expect(html).not.toContain("Codex");
  });

  it("keeps recovery actions in the same automatic-save surface", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ sourceDisposition: "local", filename: "paper-annotated.pdf", folder: "/tmp" }}
      recoveryTarget="paper-annotated.pdf"
      onRetry={vi.fn()}
      onLocate={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("This PDF isn’t up to date");
    expect(html).toContain("Your latest annotations are protected.");
    expect(html).toContain(">Retry</span>");
    expect(html).toContain("Locate PDF…");
    expect(html).toContain('class="lucide lucide-redo2 lucide-redo-2 review-icon"');
    expect(html).toContain('class="lucide lucide-locate-fixed review-icon"');
  });

  it("routes invalid geometry back to annotation correction instead of generic retry", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ sourceDisposition: "local", filename: "paper-annotated.pdf", folder: "/tmp" }}
      recoveryTarget="paper-annotated.pdf"
      recoveryFailure="invalid-annotation-geometry"
      onRetry={vi.fn()}
      onLocate={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("An annotation is outside the page");
    expect(html).toContain("Return to annotations");
    expect(html).toContain('class="lucide lucide-arrow-left review-icon"');
    expect(html).not.toContain(">Retry</button>");
  });
});
