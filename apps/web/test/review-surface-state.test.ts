import { PdfZoomMode } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  createReviewSurfaceState,
  INITIAL_REVIEW_SURFACE_STATE,
  PageNotePlacementAuthority,
  reduceReviewSurface,
} from '../src/review/review-surface-state.js';

describe('review presentation state', () => {
  it('keeps one exclusive base surface and an orthogonal nested layer', () => {
    const annotations = reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
      type: 'open-workspace',
      mode: 'annotations',
    });
    const nested = reduceReviewSurface(annotations, { type: 'open-nested' });

    expect(annotations).toMatchObject({ baseSurface: 'workspace', nestedLayer: 'none', transientSurface: 'none' });
    expect(annotations.navigation.workspace.lastMode).toBe('annotations');
    expect(nested).toMatchObject({ baseSurface: 'workspace', nestedLayer: 'composer', transientSurface: 'none' });
  });

  it('unwinds Escape from nested layer to reading', () => {
    const open = {
      ...createReviewSurfaceState(0),
      baseSurface: 'workspace',
      nestedLayer: 'composer',
    } as const;
    const withoutNested = reduceReviewSurface(open, { type: 'escape' });
    const reading = reduceReviewSurface(withoutNested, { type: 'escape' });

    expect(withoutNested).toMatchObject({ baseSurface: 'workspace', nestedLayer: 'none', transientSurface: 'none' });
    expect(reading).toEqual(INITIAL_REVIEW_SURFACE_STATE);
    expect(reduceReviewSurface(reading, { type: 'escape' })).toBe(reading);
  });

  it('keeps contextual surfaces exclusive and lets Escape unwind the topmost one', () => {
    const selection = reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, {
      type: 'open-transient',
      surface: 'selection-actions',
    });
    const menu = reduceReviewSurface(selection, { type: 'open-transient', surface: 'page-menu' });

    expect(selection.transientSurface).toBe('selection-actions');
    expect(menu.transientSurface).toBe('page-menu');
    expect(reduceReviewSurface(menu, { type: 'escape' })).toEqual(INITIAL_REVIEW_SURFACE_STATE);
  });

  it('retains workspace mode memory across hide/reopen, including empty References', () => {
    let state = reduceReviewSurface(createReviewSurfaceState(4), {
      type: 'open-workspace',
      mode: 'references',
    });
    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: {
        type: 'remember-workspace-view',
        mode: 'references',
        logicalScrollToken: 'reference:row-4',
        logicalFocusToken: 'reference:link-4',
      },
    });
    state = reduceReviewSurface(state, { type: 'hide-workspace', focusReturnToken: 'toolbar:workspace' });
    expect(state.baseSurface).toBe('reading');

    state = reduceReviewSurface(state, { type: 'open-workspace' });
    expect(state.baseSurface).toBe('workspace');
    expect(state.navigation.tabs).toEqual([]);
    expect(state.navigation.workspace.lastMode).toBe('references');
    expect(state.navigation.workspace.modes.references).toEqual({
      logicalScrollToken: 'reference:row-4',
      logicalFocusToken: 'reference:link-4',
    });
  });

  it('preserves the workspace through a failed send and hides only after verified success', () => {
    const target = {
      documentGeneration: 4,
      pageIndex: 1,
      zoom: { mode: PdfZoomMode.FitPage, params: [] },
      identity: 'reference-1',
    } as const;
    const settledLocation = {
      pageIndex: 1,
      anchor: { x: 0, y: 0 },
      alignment: { xPercent: 0, yPercent: 0 },
      zoom: 1,
    } as const;
    const mainLocation = {
      ...settledLocation,
      pageIndex: 0,
    } as const;
    let state = reduceReviewSurface(createReviewSurfaceState(4), {
      type: 'reference-navigation',
      action: { type: 'open-reference', target, settledLocation },
    });
    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: {
        type: 'remember-workspace-view',
        mode: 'references',
        logicalScrollToken: 'reference:row-1',
        logicalFocusToken: 'reference:link-1',
      },
    });
    expect(state.baseSurface).toBe('workspace');

    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: { type: 'request-send-to-main', token: 1, currentMainLocation: mainLocation },
    });
    expect(state.baseSurface).toBe('workspace');
    const requested = state;
    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: { type: 'complete-send-to-main', token: 1, documentGeneration: 4, success: false },
    });
    expect(state.baseSurface).toBe('workspace');
    expect(state.navigation.tabs).toHaveLength(1);
    expect(state.navigation.tabs).toBe(requested.navigation.tabs);
    expect(state.navigation.activeTabIdentity).toBe('reference-1');
    expect(state.navigation.mainHistory).toBe(requested.navigation.mainHistory);
    expect(state.navigation.workspace.modes.references.logicalFocusToken).toBe('reference:link-1');

    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: { type: 'request-send-to-main', token: 2, currentMainLocation: mainLocation },
    });
    expect(state.baseSurface).toBe('workspace');
    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: {
        type: 'complete-send-to-main',
        token: 2,
        documentGeneration: 4,
        success: true,
        settledLocation,
      },
    });
    expect(state.baseSurface).toBe('reading');
    expect(state.navigation.tabs).toEqual([]);
    expect(state.navigation.mainHistory.entries).toEqual([mainLocation, settledLocation]);
  });

  it('resets current-document navigation atomically without changing nested/transient semantics', () => {
    let state = reduceReviewSurface(createReviewSurfaceState(4), { type: 'open-nested' });
    state = reduceReviewSurface(state, { type: 'open-transient', surface: 'page-menu' });
    state = reduceReviewSurface(state, { type: 'open-workspace', mode: 'references' });
    state = reduceReviewSurface(state, {
      type: 'reference-navigation',
      action: {
        type: 'open-reference',
        target: {
          documentGeneration: 4,
          pageIndex: 1,
          zoom: { mode: PdfZoomMode.FitPage, params: [] },
          identity: 'old-document-reference',
        },
        settledLocation: {
          pageIndex: 1,
          anchor: { x: 0, y: 0 },
          alignment: { xPercent: 0, yPercent: 0 },
          zoom: 1,
        },
      },
    });
    state = reduceReviewSurface(state, { type: 'open-transient', surface: 'page-menu' });

    const reset = reduceReviewSurface(state, { type: 'replace-document', documentGeneration: 9 });
    expect(reset).toMatchObject({
      baseSurface: 'reading',
      nestedLayer: 'composer',
      transientSurface: 'none',
      navigation: {
        documentGeneration: 9,
        tabs: [],
        activeTabIdentity: null,
        mainHistory: { entries: [], index: -1 },
        workspace: { lastMode: 'outline', returnFocusToken: null },
      },
    });
  });

  it('consumes context placement once and invalidates it with its invocation', () => {
    const authority = new PageNotePlacementAuthority();
    const point = { documentId: 'doc', pageIndex: 2, viewportGeneration: 4, x: 30, y: 40 };
    authority.setContextPoint('menu-1', point);

    expect(authority.consumeContextPoint('menu-2')).toBeNull();
    expect(authority.consumeContextPoint('menu-1')).toEqual(point);
    expect(authority.consumeContextPoint('menu-1')).toBeNull();
  });

  it('binds keyboard placement to document/page/viewport generation and consumes it once', () => {
    const authority = new PageNotePlacementAuthority();
    const point = { documentId: 'doc', pageIndex: 1, viewportGeneration: 8, x: 50, y: 60 };
    authority.setKeyboardCursor(point);

    expect(authority.consumeKeyboardCursor({ documentId: 'doc', pageIndex: 1, viewportGeneration: 7 })).toBeNull();
    expect(authority.consumeKeyboardCursor({ documentId: 'doc', pageIndex: 1, viewportGeneration: 8 })).toEqual(point);
    expect(authority.consumeKeyboardCursor({ documentId: 'doc', pageIndex: 1, viewportGeneration: 8 })).toBeNull();
  });
});
