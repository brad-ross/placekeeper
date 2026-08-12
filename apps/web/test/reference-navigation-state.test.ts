import { PdfZoomMode } from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import type { PdfNavigationTarget } from '../src/pdf/pdf-navigation-target.js';
import type { PdfViewerLocation } from '../src/pdf/viewer-navigation.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationState,
} from '../src/review/reference-navigation-state.js';

function target(identity: string, pageIndex: number): PdfNavigationTarget {
  return {
    documentGeneration: 4,
    pageIndex,
    zoom: { mode: PdfZoomMode.XYZ, params: [0, pageIndex * 100, 0] },
    identity,
  };
}

function location(pageIndex: number, y = 0, zoom = 1): PdfViewerLocation {
  return {
    pageIndex,
    anchor: { x: 0, y },
    alignment: { xPercent: 0, yPercent: 0 },
    zoom,
  };
}

function open(
  state: ReferenceNavigationState,
  destination: PdfNavigationTarget,
  settledLocation: PdfViewerLocation,
): ReferenceNavigationState {
  return reduceReferenceNavigation(state, {
    type: 'open-reference',
    target: destination,
    settledLocation,
  });
}

function switchTo(
  state: ReferenceNavigationState,
  identity: string,
  token: number,
  outgoingLocation: PdfViewerLocation,
  settledLocation: PdfViewerLocation,
): ReferenceNavigationState {
  const requested = reduceReferenceNavigation(state, {
    type: 'request-reference-switch',
    token,
    targetIdentity: identity,
    outgoingLocation,
  });
  return reduceReferenceNavigation(requested, {
    type: 'complete-reference-switch',
    token,
    documentGeneration: 4,
    success: true,
    settledLocation,
  });
}

describe('reference tab state', () => {
  it('cancels every pending transaction without changing durable navigation state', () => {
    let state = open(createReferenceNavigationState(4), target('a', 0), location(0));
    state = open(state, target('b', 1), location(1));
    state = reduceReferenceNavigation(state, {
      type: 'request-reference-switch', token: 1, targetIdentity: 'a', outgoingLocation: location(1, 10),
    });
    state = reduceReferenceNavigation(state, {
      type: 'request-send-to-main', token: 2, currentMainLocation: location(4),
    });
    state = reduceReferenceNavigation(state, {
      type: 'request-main-jump', token: 3, currentLocation: location(4), destination: location(5),
    });
    const durable = {
      tabs: state.tabs,
      activeTabIdentity: state.activeTabIdentity,
      mainHistory: state.mainHistory,
      workspace: state.workspace,
    };

    const cancelled = reduceReferenceNavigation(state, { type: 'cancel-pending-navigation' });
    expect(cancelled).toMatchObject({
      pendingReferenceSwitch: null,
      pendingSendToMain: null,
      pendingMainNavigation: null,
      ...durable,
    });
    expect(reduceReferenceNavigation(cancelled, { type: 'cancel-pending-navigation' })).toBe(cancelled);
  });

  it('deduplicates canonical aliases without replacing the original target or its live snapshot', () => {
    const original = target('same-target', 1);
    const alias = { ...original, zoom: { ...original.zoom, params: [...original.zoom.params] } };
    let state = open(createReferenceNavigationState(4), original, location(1, 10));
    state = reduceReferenceNavigation(state, {
      type: 'refresh-active-reference',
      settledLocation: location(1, 80, 1.5),
    });
    state = open(state, alias, location(1, 999));

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.originalTarget).toBe(original);
    expect(state.tabs[0]?.settledLocation).toEqual(location(1, 80, 1.5));
    expect(state.activeTabIdentity).toBe('same-target');
  });

  it('keeps distinct semantic identities on the same page as distinct tabs', () => {
    let state = open(createReferenceNavigationState(4), target('upper', 2), location(2, 20));
    state = open(state, target('lower', 2), location(2, 400));

    expect(state.tabs.map((tab) => tab.identity)).toEqual(['upper', 'lower']);
    expect(state.activeTabIdentity).toBe('lower');
  });

  it('saves the outgoing live view and rejects stale rapid-switch completions', () => {
    let state = open(createReferenceNavigationState(4), target('a', 0), location(0));
    state = open(state, target('b', 1), location(1));
    state = open(state, target('c', 2), location(2));
    state = switchTo(state, 'a', 1, location(2, 25), location(0, 10));

    state = reduceReferenceNavigation(state, {
      type: 'request-reference-switch',
      token: 11,
      targetIdentity: 'b',
      outgoingLocation: location(0, 40),
    });
    state = reduceReferenceNavigation(state, {
      type: 'request-reference-switch',
      token: 12,
      targetIdentity: 'c',
      outgoingLocation: location(0, 60),
    });
    const stale = reduceReferenceNavigation(state, {
      type: 'complete-reference-switch',
      token: 11,
      documentGeneration: 4,
      success: true,
      settledLocation: location(1, 100),
    });

    expect(stale).toBe(state);
    expect(stale.activeTabIdentity).toBe('a');
    expect(stale.tabs.find((tab) => tab.identity === 'a')?.settledLocation).toEqual(location(0, 60));

    const settled = reduceReferenceNavigation(stale, {
      type: 'complete-reference-switch',
      token: 12,
      documentGeneration: 4,
      success: true,
      settledLocation: location(2, 120, 1.25),
    });
    expect(settled.activeTabIdentity).toBe('c');
    expect(settled.tabs.find((tab) => tab.identity === 'c')?.settledLocation)
      .toEqual(location(2, 120, 1.25));
  });

  it('closes inactive tabs without moving selection and chooses right else left for the active tab', () => {
    let state = open(createReferenceNavigationState(4), target('a', 0), location(0));
    state = open(state, target('b', 1), location(1));
    state = open(state, target('c', 2), location(2));
    state = switchTo(state, 'b', 2, location(2), location(1));

    state = reduceReferenceNavigation(state, {
      type: 'close-reference',
      targetIdentity: 'a',
      focusReturnToken: 'reference-link:a',
    });
    expect(state.activeTabIdentity).toBe('b');

    state = reduceReferenceNavigation(state, {
      type: 'close-reference',
      targetIdentity: 'b',
      focusReturnToken: 'reference-link:b',
    });
    expect(state.activeTabIdentity).toBe('c');

    state = open(state, target('d', 3), location(3));
    state = reduceReferenceNavigation(state, {
      type: 'close-reference',
      targetIdentity: 'd',
      focusReturnToken: 'reference-link:d',
    });
    expect(state.activeTabIdentity).toBe('c');

    state = reduceReferenceNavigation(state, {
      type: 'close-reference',
      targetIdentity: 'c',
      focusReturnToken: 'reference-link:c',
    });
    expect(state.tabs).toEqual([]);
    expect(state.activeTabIdentity).toBeNull();
    expect(state.workspace.returnFocusToken).toBe('reference-link:c');
  });

  it('consumes only the promoted tab on verified success and keeps a hidden successor', () => {
    let state = open(createReferenceNavigationState(4), target('a', 0), location(0, 10));
    state = open(state, target('b', 1), location(1, 20));
    state = open(state, target('c', 2), location(2, 30));
    state = switchTo(state, 'b', 3, location(2, 35), location(1, 25));
    state = reduceReferenceNavigation(state, { type: 'refresh-main-location', location: location(8, 5) });

    const requested = reduceReferenceNavigation(state, {
      type: 'request-send-to-main',
      token: 20,
      currentMainLocation: location(8, 15),
    });
    const failed = reduceReferenceNavigation(requested, {
      type: 'complete-send-to-main',
      token: 20,
      documentGeneration: 4,
      success: false,
    });
    expect(failed.tabs.map((tab) => tab.identity)).toEqual(['a', 'b', 'c']);
    expect(failed.activeTabIdentity).toBe('b');

    const requestedAgain = reduceReferenceNavigation(failed, {
      type: 'request-send-to-main',
      token: 21,
      currentMainLocation: location(8, 20),
    });
    const stale = reduceReferenceNavigation(requestedAgain, {
      type: 'complete-send-to-main',
      token: 20,
      documentGeneration: 4,
      success: true,
      settledLocation: location(1, 25),
    });
    expect(stale).toBe(requestedAgain);

    const promoted = reduceReferenceNavigation(stale, {
      type: 'complete-send-to-main',
      token: 21,
      documentGeneration: 4,
      success: true,
      settledLocation: location(1, 27, 1.1),
    });
    expect(promoted.tabs.map((tab) => tab.identity)).toEqual(['a', 'c']);
    expect(promoted.activeTabIdentity).toBe('c');
    expect(promoted.workspace.lastMode).toBe('references');
    expect(promoted.mainHistory.entries).toEqual([location(8, 20), location(1, 27, 1.1)]);

    let final = open(createReferenceNavigationState(4), target('only', 3), location(3));
    final = reduceReferenceNavigation(final, {
      type: 'request-send-to-main', token: 22, currentMainLocation: location(0),
    });
    final = reduceReferenceNavigation(final, {
      type: 'complete-send-to-main',
      token: 22,
      documentGeneration: 4,
      success: true,
      settledLocation: location(3, 5),
    });
    expect(final).toMatchObject({
      tabs: [],
      activeTabIdentity: null,
      pendingReferenceSwitch: null,
      pendingSendToMain: null,
    });
  });
});

describe('retained workspace memory', () => {
  it('preserves the last mode and independent logical scroll/focus tokens while hidden', () => {
    let state = createReferenceNavigationState(4);
    state = reduceReferenceNavigation(state, { type: 'select-workspace-mode', mode: 'annotations' });
    state = reduceReferenceNavigation(state, {
      type: 'remember-workspace-view',
      mode: 'annotations',
      logicalScrollToken: 'annotation:item-7',
      logicalFocusToken: 'annotation:edit-7',
    });
    state = reduceReferenceNavigation(state, {
      type: 'remember-workspace-view',
      mode: 'outline',
      logicalScrollToken: 'outline:section-3',
      logicalFocusToken: 'outline:row-3',
    });
    state = reduceReferenceNavigation(state, {
      type: 'hide-workspace',
      focusReturnToken: 'toolbar:workspace',
    });

    expect(state.workspace).toEqual({
      lastMode: 'annotations',
      returnFocusToken: 'toolbar:workspace',
      modes: {
        outline: { logicalScrollToken: 'outline:section-3', logicalFocusToken: 'outline:row-3' },
        references: { logicalScrollToken: null, logicalFocusToken: null },
        search: { logicalScrollToken: null, logicalFocusToken: null },
        annotations: { logicalScrollToken: 'annotation:item-7', logicalFocusToken: 'annotation:edit-7' },
      },
    });
  });

  it('restores an empty References mode without switching to another mode', () => {
    let state = createReferenceNavigationState(4);
    state = reduceReferenceNavigation(state, { type: 'select-workspace-mode', mode: 'references' });
    state = reduceReferenceNavigation(state, {
      type: 'hide-workspace',
      focusReturnToken: 'toolbar:workspace',
    });

    expect(state.tabs).toEqual([]);
    expect(state.workspace.lastMode).toBe('references');
  });
});

describe('main viewer history', () => {
  it('can retain distinct semantic occurrences that resolve to the same viewer location', () => {
    const current = location(0);
    let state = reduceReferenceNavigation(createReferenceNavigationState(4), {
      type: 'refresh-main-location',
      location: current,
    });
    state = reduceReferenceNavigation(state, {
      type: 'request-main-jump',
      token: 1,
      currentLocation: current,
      destination: current,
      force: true,
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-main-jump', token: 1, documentGeneration: 4, success: true,
      settledLocation: current,
    });

    expect(state.mainHistory.entries).toHaveLength(2);
    expect(state.mainHistory.index).toBe(1);
  });

  it('initializes and refreshes the live current entry without pushing', () => {
    const initial = createReferenceNavigationState(4);
    const initialized = reduceReferenceNavigation(initial, {
      type: 'refresh-main-location',
      location: location(0),
    });
    const refreshed = reduceReferenceNavigation(initialized, {
      type: 'refresh-main-location',
      location: location(0, 35, 1.5),
    });

    expect(initialized.mainHistory).toMatchObject({ entries: [location(0)], index: 0 });
    expect(refreshed.mainHistory).toMatchObject({ entries: [location(0, 35, 1.5)], index: 0 });
  });

  it('does not mutate history for no-op or failed jumps, and appends only verified destinations', () => {
    let state = reduceReferenceNavigation(createReferenceNavigationState(4), {
      type: 'refresh-main-location',
      location: location(0),
    });
    const noOp = reduceReferenceNavigation(state, {
      type: 'request-main-jump',
      token: 30,
      currentLocation: location(0, 10),
      destination: location(0, 10),
    });
    expect(noOp).toBe(state);

    const requested = reduceReferenceNavigation(state, {
      type: 'request-main-jump',
      token: 31,
      currentLocation: location(0, 20),
      destination: location(1, 40),
    });
    const failed = reduceReferenceNavigation(requested, {
      type: 'complete-main-jump',
      token: 31,
      documentGeneration: 4,
      success: false,
    });
    expect(requested.mainHistory).toBe(state.mainHistory);
    expect(failed.mainHistory).toBe(state.mainHistory);

    state = reduceReferenceNavigation(failed, {
      type: 'request-main-jump',
      token: 32,
      currentLocation: location(0, 25),
      destination: location(1, 50, 1.2),
    });
    const staleToken = reduceReferenceNavigation(state, {
      type: 'complete-main-jump', token: 31, documentGeneration: 4, success: true,
    });
    const staleGeneration = reduceReferenceNavigation(state, {
      type: 'complete-main-jump', token: 32, documentGeneration: 3, success: true,
    });
    expect(staleToken).toBe(state);
    expect(staleGeneration).toBe(state);
    state = reduceReferenceNavigation(state, {
      type: 'complete-main-jump',
      token: 32,
      documentGeneration: 4,
      success: true,
    });
    expect(state.mainHistory).toMatchObject({
      entries: [location(0, 25), location(1, 50, 1.2)],
      index: 1,
    });
  });

  it('refreshes before Back/Forward, respects ends, and truncates a forward branch', () => {
    let state = reduceReferenceNavigation(createReferenceNavigationState(4), {
      type: 'refresh-main-location',
      location: location(0),
    });
    for (const [token, current, destination] of [
      [40, location(0, 10), location(1, 20)],
      [41, location(1, 30), location(2, 40)],
    ] as const) {
      state = reduceReferenceNavigation(state, {
        type: 'request-main-jump', token, currentLocation: current, destination,
      });
      state = reduceReferenceNavigation(state, {
        type: 'complete-main-jump', token, documentGeneration: 4, success: true,
      });
    }

    state = reduceReferenceNavigation(state, {
      type: 'request-history-back', token: 42, currentLocation: location(2, 45),
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-history-navigation', token: 42, documentGeneration: 4, success: true,
    });
    expect(state.mainHistory.index).toBe(1);
    expect(state.mainHistory.entries[2]).toEqual(location(2, 45));

    state = reduceReferenceNavigation(state, {
      type: 'request-history-back', token: 43, currentLocation: location(1, 35),
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-history-navigation', token: 43, documentGeneration: 4, success: true,
    });
    expect(state.mainHistory.index).toBe(0);
    expect(reduceReferenceNavigation(state, {
      type: 'request-history-back', token: 44, currentLocation: location(0, 15),
    })).toBe(state);

    state = reduceReferenceNavigation(state, {
      type: 'request-history-forward', token: 45, currentLocation: location(0, 15),
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-history-navigation', token: 45, documentGeneration: 4, success: true,
    });
    expect(state.mainHistory.index).toBe(1);

    state = reduceReferenceNavigation(state, {
      type: 'request-main-jump',
      token: 46,
      currentLocation: location(1, 37),
      destination: location(9, 90),
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-main-jump', token: 46, documentGeneration: 4, success: true,
    });
    expect(state.mainHistory).toMatchObject({
      entries: [location(0, 15), location(1, 37), location(9, 90)],
      index: 2,
    });
    expect(state.mainHistory.entries).not.toContainEqual(location(2, 45));
    expect(reduceReferenceNavigation(state, {
      type: 'request-history-forward', token: 47, currentLocation: location(9, 95),
    })).toBe(state);
  });

  it('moves history without recreating reference tabs consumed by send-to-main', () => {
    let state = open(createReferenceNavigationState(4), target('only', 2), location(2));
    state = reduceReferenceNavigation(state, {
      type: 'refresh-main-location', location: location(0),
    });
    state = reduceReferenceNavigation(state, {
      type: 'request-send-to-main', token: 50, currentMainLocation: location(0, 5),
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-send-to-main',
      token: 50,
      documentGeneration: 4,
      success: true,
      settledLocation: location(2, 10),
    });
    state = reduceReferenceNavigation(state, {
      type: 'request-history-back', token: 51, currentLocation: location(2, 15),
    });
    state = reduceReferenceNavigation(state, {
      type: 'complete-history-navigation', token: 51, documentGeneration: 4, success: true,
    });

    expect(state.mainHistory.index).toBe(0);
    expect(state.tabs).toEqual([]);
    expect(state.activeTabIdentity).toBeNull();
  });
});
