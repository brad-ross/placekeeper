import { describe, expect, it } from 'vitest';

import {
  acceptSelectionUpdate,
  INITIAL_SELECTION_UPDATE,
  reliableSelection,
  SelectionReadAuthority,
  selectionReadinessMessage,
  terminalSelectionUpdate,
  type SelectionUpdate,
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
