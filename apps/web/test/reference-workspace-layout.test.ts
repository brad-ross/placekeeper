import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BOTTOM_REFERENCE_HEIGHT_RATIO,
  DEFAULT_RIGHT_WORKSPACE_WIDTH,
  MIN_BOTTOM_REFERENCE_HEIGHT,
  MIN_MAIN_READING_HEIGHT,
  MIN_MAIN_READING_WIDTH,
  MIN_RIGHT_REFERENCE_WIDTH,
  clampBottomReferenceHeight,
  clampRightReferenceWidth,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
} from '../src/review/reference-workspace-layout.js';

describe('reference workspace layout state', () => {
  it('starts with bottom preference, closed wide surfaces, and documented defaults', () => {
    const state = createReferenceWorkspaceLayout({ width: 1440, height: 900 });

    expect(state).toMatchObject({
      regime: 'wide',
      referenceDock: 'bottom',
      rightWorkspaceOpen: false,
      bottomReferencesOpen: false,
      narrowOpen: false,
      lastFocusedSurface: null,
      rightReferenceWidth: DEFAULT_RIGHT_WORKSPACE_WIDTH,
      bottomReferenceHeight: 900 * DEFAULT_BOTTOM_REFERENCE_HEIGHT_RATIO,
    });
  });

  it('moves References between docks with the required visibility transitions', () => {
    let state = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-references' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-right-workspace' });
    expect(deriveReferenceWorkspaceLayout(state, 'outline')).toMatchObject({
      kind: 'wide-split',
      rightWorkspaceOpen: true,
      bottomReferencesOpen: true,
    });

    state = reduceReferenceWorkspaceLayout(state, { type: 'move-references-right' });
    expect(state).toMatchObject({
      referenceDock: 'right',
      rightWorkspaceOpen: true,
      bottomReferencesOpen: false,
      lastFocusedSurface: 'references',
    });

    state = reduceReferenceWorkspaceLayout(state, { type: 'move-references-bottom' });
    expect(state).toMatchObject({
      referenceDock: 'bottom',
      rightWorkspaceOpen: false,
      bottomReferencesOpen: true,
      lastFocusedSurface: 'references',
    });
  });

  it('tracks focus recency without changing it for unrelated actions', () => {
    let state = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-references' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-right-workspace' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'focus-surface', surface: 'references' });
    const resized = reduceReferenceWorkspaceLayout(state, { type: 'resize-bottom-references', size: 500 });
    expect(resized.lastFocusedSurface).toBe('references');
  });

  it('projects wide state into narrow mode and restores the exact wide tuple', () => {
    let state = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-references' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-right-workspace' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'focus-surface', surface: 'references' });
    const wideTuple = {
      referenceDock: state.referenceDock,
      rightWorkspaceOpen: state.rightWorkspaceOpen,
      bottomReferencesOpen: state.bottomReferencesOpen,
    };

    state = reduceReferenceWorkspaceLayout(state, { type: 'set-regime', regime: 'narrow' });
    expect(deriveReferenceWorkspaceLayout(state, 'annotations')).toMatchObject({
      kind: 'narrow-unified',
      open: true,
      activeMode: 'references',
    });
    state = reduceReferenceWorkspaceLayout(state, { type: 'set-regime', regime: 'wide' });
    expect(state).toMatchObject(wideTuple);
  });

  it('opens a fresh narrow rail to Outline and remembers later narrow focus', () => {
    let state = createReferenceWorkspaceLayout({ width: 600, height: 800 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'toggle-narrow-workspace' });
    expect(deriveReferenceWorkspaceLayout(state, 'annotations')).toMatchObject({
      kind: 'narrow-unified',
      open: true,
      activeMode: 'outline',
    });

    state = reduceReferenceWorkspaceLayout(state, { type: 'focus-surface', surface: 'references' });
    expect(deriveReferenceWorkspaceLayout(state, 'annotations')).toMatchObject({
      activeMode: 'references',
    });
  });

  it('reveals narrow References and hides only References when wide tools are remembered', () => {
    let state = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-right-workspace' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'show-references' });
    state = reduceReferenceWorkspaceLayout(state, { type: 'set-regime', regime: 'narrow' });
    expect(deriveReferenceWorkspaceLayout(state, 'annotations')).toMatchObject({
      kind: 'narrow-unified', open: true, activeMode: 'references',
    });

    state = reduceReferenceWorkspaceLayout(state, { type: 'hide-references' });
    expect(deriveReferenceWorkspaceLayout(state, 'annotations')).toMatchObject({
      kind: 'narrow-unified', open: true, activeMode: 'annotations',
    });
    state = reduceReferenceWorkspaceLayout(state, { type: 'set-regime', regime: 'wide' });
    expect(deriveReferenceWorkspaceLayout(state, 'annotations')).toMatchObject({
      kind: 'wide-right', rightWorkspaceOpen: true, bottomReferencesOpen: false,
    });
  });

  it('uses reference height only for active narrow References', () => {
    let state = createReferenceWorkspaceLayout({ width: 600, height: 1000 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'resize-bottom-references', size: 520 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'toggle-narrow-workspace' });

    expect(deriveReferenceWorkspaceLayout(state, 'outline')).toMatchObject({
      activeMode: 'outline',
      bottomHeight: 430,
      referenceResizable: false,
    });
    state = reduceReferenceWorkspaceLayout(state, { type: 'focus-surface', surface: 'references' });
    expect(deriveReferenceWorkspaceLayout(state, 'outline')).toMatchObject({
      activeMode: 'references',
      bottomHeight: 520,
      referenceResizable: true,
    });
  });

  it('clamps each dock size while preserving a useful main region', () => {
    expect(clampRightReferenceWidth(100, 1400)).toBe(MIN_RIGHT_REFERENCE_WIDTH);
    expect(clampRightReferenceWidth(1000, 1400)).toBe(1400 - MIN_MAIN_READING_WIDTH);
    expect(clampRightReferenceWidth(400, 600)).toBe(600 - MIN_MAIN_READING_WIDTH);
    expect(clampBottomReferenceHeight(10, 900)).toBe(MIN_BOTTOM_REFERENCE_HEIGHT);
    expect(clampBottomReferenceHeight(1000, 900)).toBe(900 - MIN_MAIN_READING_HEIGHT);
  });

  it('closes transient surfaces on document replacement without erasing preferences', () => {
    let state = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'resize-right-references', size: 430 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'resize-bottom-references', size: 500 });
    state = reduceReferenceWorkspaceLayout(state, { type: 'move-references-right' });
    const replaced = reduceReferenceWorkspaceLayout(state, { type: 'replace-document' });

    expect(replaced).toMatchObject({
      referenceDock: 'right',
      rightReferenceWidth: 430,
      bottomReferenceHeight: 500,
      rightWorkspaceOpen: false,
      bottomReferencesOpen: false,
      narrowOpen: false,
    });
  });
});
