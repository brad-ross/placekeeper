import { describe, expect, it, vi } from 'vitest';

import {
  acceptCopySelectionUpdate,
  acceptSelectionUpdate,
  applyPdfCopyCommand,
  copySelectionUpdateFromEvidence,
  nativeCopyHasPrecedence,
  resolvePdfCopyCommand,
  INITIAL_SELECTION_UPDATE,
  reliableSelection,
  SelectionReadAuthority,
  selectionReadinessMessage,
  terminalSelectionUpdate,
  type SelectionUpdate,
  type CopySelectionUpdate,
} from '../src/pdf/selection-state.js';

const anchor = {
  pageIndex: 0,
  quote: 'unique equilibrium',
  prefix: 'text: ',
  suffix: ' clearly',
  rect: { x: 72, y: 88, width: 120, height: 14 },
  segmentRects: [{ x: 72, y: 88, width: 120, height: 14 }],
  reliable: true as const,
};

describe('selection update authority', () => {
  it('invalidates an in-flight capture across a viewer lifecycle boundary', () => {
    const authority = new SelectionReadAuthority();
    const pending = authority.begin('old-document');
    expect(pending.started).toBe(true);
    expect(authority.finish('old-document')).toBe(pending.generation);

    const cleared = authority.invalidate();

    expect(cleared).toEqual({ kind: 'cleared', generation: pending.generation + 1 });
    expect(authority.isCurrent(pending.generation)).toBe(false);
  });

  it('publishes pending and accepts only the matching terminal generation', () => {
    const pending: SelectionUpdate = { kind: 'pending', generation: 4 };
    const reliable = terminalSelectionUpdate(4, { ok: true, anchor });

    expect(acceptSelectionUpdate(INITIAL_SELECTION_UPDATE, pending)).toEqual(pending);
    expect(acceptSelectionUpdate(pending, reliable)).toEqual(reliable);
    expect(reliableSelection(reliable)).toEqual(anchor);
    expect(selectionReadinessMessage(pending)).toContain('Reading');
  });

  it('rejects obsolete and post-terminal updates so stale anchors cannot regain authority', () => {
    const pending: SelectionUpdate = { kind: 'pending', generation: 8 };
    const unreliable = terminalSelectionUpdate(8, {
      ok: false,
      userMessage: 'Reselect reliable text.',
      diagnostic: 'selection-text-geometry-mismatch',
    });

    expect(acceptSelectionUpdate(pending, { kind: 'reliable', generation: 7, anchor })).toEqual(pending);
    expect(acceptSelectionUpdate(unreliable, { kind: 'pending', generation: 8 })).toEqual(unreliable);
    expect(reliableSelection(unreliable)).toBeNull();
    expect(selectionReadinessMessage(unreliable)).toBe('Reselect reliable text.');
    expect(acceptSelectionUpdate(unreliable, { kind: 'cleared', generation: 9 })).toEqual({
      kind: 'cleared',
      generation: 9,
    });
  });
});

const mainSurface = { kind: 'main' as const, documentGeneration: 3 };
const referenceSurface = {
  kind: 'reference' as const,
  documentGeneration: 3,
  tabIdentity: 'reference-a',
};

function readyCopy(
  surface: typeof mainSurface | typeof referenceSurface,
  generation: number,
  text = 'first page\nsecond page',
  pageCount = 2,
): CopySelectionUpdate {
  return {
    kind: 'ready',
    surface,
    generation,
    text,
    pageCount,
  };
}

describe('PDF copy selection state', () => {
  it('keeps editable targets and ordinary DOM selections on the native path', () => {
    expect(nativeCopyHasPrecedence({
      editableTarget: true,
      domSelectionCollapsed: true,
      domSelectionText: '',
    })).toBe(true);
    expect(nativeCopyHasPrecedence({
      editableTarget: false,
      domSelectionCollapsed: false,
      domSelectionText: 'interface text',
    })).toBe(true);
    expect(nativeCopyHasPrecedence({
      editableTarget: false,
      domSelectionCollapsed: true,
      domSelectionText: '',
    })).toBe(false);
  });

  it('publishes complete document-ordered text independently of annotation reliability', () => {
    expect(copySelectionUpdateFromEvidence(mainSurface, 4, {
      stable: true,
      selection: {
        start: { page: 0, index: 10 },
        end: { page: 1, index: 12 },
      },
      pageCount: 2,
      text: ['end of first', 'start of second'],
    })).toEqual(readyCopy(mainSurface, 4, 'end of first\nstart of second'));
  });

  it('rejects stale document, selection, and reference-tab resolutions', () => {
    const pending: CopySelectionUpdate = {
      kind: 'pending', surface: referenceSurface, generation: 8,
    };
    expect(acceptCopySelectionUpdate(pending, readyCopy(referenceSurface, 7)))
      .toEqual(pending);
    expect(acceptCopySelectionUpdate(pending, readyCopy({
      ...referenceSurface, tabIdentity: 'reference-b',
    }, 8))).toEqual(pending);
    expect(acceptCopySelectionUpdate(pending, readyCopy({
      ...referenceSurface, documentGeneration: 2,
    }, 8))).toEqual(pending);
    expect(acceptCopySelectionUpdate(pending, readyCopy(referenceSurface, 8)))
      .toEqual(readyCopy(referenceSurface, 8));

    const unavailable: CopySelectionUpdate = {
      kind: 'unavailable', surface: referenceSurface, generation: 9,
    };
    expect(acceptCopySelectionUpdate(unavailable, readyCopy(referenceSurface, 9, 'stale')))
      .toEqual(unavailable);
    expect(acceptCopySelectionUpdate(unavailable, {
      kind: 'pending', surface: referenceSurface, generation: 10,
    })).toEqual({ kind: 'pending', surface: referenceSurface, generation: 10 });

    const switched: CopySelectionUpdate = {
      kind: 'cleared',
      surface: { ...referenceSurface, tabIdentity: 'reference-b' },
      generation: 10,
    };
    expect(acceptCopySelectionUpdate(switched, readyCopy(referenceSurface, 11, 'late tab')))
      .toEqual(switched);
  });

  it('publishes unavailable when the semantic text read no longer matches its selection', () => {
    expect(copySelectionUpdateFromEvidence(mainSurface, 5, {
      stable: false,
      selection: { start: { page: 0 }, end: { page: 0 } },
      pageCount: 1,
      text: ['obsolete text'],
    })).toEqual({ kind: 'unavailable', surface: mainSurface, generation: 5 });
  });

  it('routes native targets before focused PDF copy and rejects pending, unavailable, and 13 pages whole', () => {
    const snapshots = {
      main: readyCopy(mainSurface, 4, 'main text'),
      reference: readyCopy(referenceSurface, 9, 'reference text'),
    };

    expect(resolvePdfCopyCommand({
      nativeCopyHasPrecedence: true, owner: 'reference', snapshots,
    })).toEqual({ kind: 'native' });
    expect(resolvePdfCopyCommand({
      nativeCopyHasPrecedence: false, owner: 'reference', snapshots,
    })).toEqual({ kind: 'copy', text: 'reference text' });
    expect(resolvePdfCopyCommand({
      nativeCopyHasPrecedence: false,
      owner: 'main',
      snapshots: {
        ...snapshots,
        main: { kind: 'pending', surface: mainSurface, generation: 5 },
      },
    })).toEqual({ kind: 'pending' });
    expect(resolvePdfCopyCommand({
      nativeCopyHasPrecedence: false,
      owner: 'main',
      snapshots: {
        ...snapshots,
        main: { kind: 'unavailable', surface: mainSurface, generation: 5 },
      },
    })).toEqual({ kind: 'unavailable' });
    expect(resolvePdfCopyCommand({
      nativeCopyHasPrecedence: false,
      owner: 'main',
      snapshots: { ...snapshots, main: readyCopy(mainSurface, 5, 'all pages', 12) },
    })).toEqual({ kind: 'copy', text: 'all pages' });
    expect(resolvePdfCopyCommand({
      nativeCopyHasPrecedence: false,
      owner: 'main',
      snapshots: { ...snapshots, main: readyCopy(mainSurface, 6, 'must not copy', 13) },
    })).toEqual({ kind: 'over-limit' });
  });

  it('prevents handled PDF copy attempts while mutating the clipboard only for ready text', () => {
    const clipboard = { setData: vi.fn() };
    const preventDefault = vi.fn();
    const onPending = vi.fn();
    const onError = vi.fn();
    const event = { clipboardData: clipboard, preventDefault };

    applyPdfCopyCommand({ kind: 'copy', text: 'plain PDF text' }, event, {
      onPending,
      onError,
    });
    expect(clipboard.setData).toHaveBeenCalledWith('text/plain', 'plain PDF text');
    expect(preventDefault).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    applyPdfCopyCommand({ kind: 'pending' }, event, { onPending, onError });
    expect(onPending).toHaveBeenCalledOnce();
    expect(clipboard.setData).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    applyPdfCopyCommand({ kind: 'unavailable' }, event, { onPending, onError });
    applyPdfCopyCommand({ kind: 'over-limit' }, event, { onPending, onError });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(clipboard.setData).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});
