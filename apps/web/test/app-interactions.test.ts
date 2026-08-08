import { Rotation } from '@embedpdf/models';
import { describe, expect, it, vi } from 'vitest';

import {
  clampPageNotePoint,
  publishViewerCaretRead,
} from '../src/app/App.js';
import { combinePageRotation } from '../src/pdf/owned-overlay.js';
import type { ViewerInteractionEvent } from '../src/pdf/viewer-interaction-events.js';

const unavailableCaret = {
  ok: false as const,
  userMessage: 'unavailable',
  diagnostic: 'caret-point-out-of-tolerance' as const,
};

describe('App interaction boundaries', () => {
  it('combines intrinsic page rotation with document rotation for contextual geometry', () => {
    expect(combinePageRotation(Rotation.Degree90, Rotation.Degree180))
      .toBe(Rotation.Degree270);
  });

  it('clamps Page Note placement inside the crop box with room for the marker', () => {
    const page = {
      size: { width: 600, height: 800 },
      boxes: {
        media: { left: 0, top: 0, right: 700, bottom: 1000 },
        crop: { left: 100, top: 200, right: 700, bottom: 1000 },
      },
    };
    expect(clampPageNotePoint({ x: 50, y: 1_100 }, page, 18)).toEqual({
      x: 118,
      y: 982,
    });
  });

  it('centers the Page Note marker when the crop is smaller than its required inset', () => {
    const page = {
      size: { width: 4, height: 2 },
      boxes: {
        media: { left: 0, top: 0, right: 10, bottom: 8 },
        crop: { left: 2, top: 1, right: 6, bottom: 3 },
      },
    };
    expect(clampPageNotePoint({ x: -10, y: 50 }, page, 18)).toEqual({ x: 4, y: 2 });
  });

  it('drops a deferred caret read after its viewer generation becomes stale', async () => {
    let resolveRead: ((result: typeof unavailableCaret) => void) | undefined;
    const read = new Promise<typeof unavailableCaret>((resolve) => {
      resolveRead = resolve;
    });
    let current = true;
    const emit = vi.fn<(event: ViewerInteractionEvent) => void>();
    const pending = publishViewerCaretRead({
      read,
      isCurrent: () => current,
      placement: { left: 10, top: 20, suggestTop: true },
      emit,
    });

    current = false;
    resolveRead?.(unavailableCaret);
    await pending;

    expect(emit).not.toHaveBeenCalled();
  });

  it('clears stale caret state with a typed diagnostic when the engine read rejects', async () => {
    const emit = vi.fn<(event: ViewerInteractionEvent) => void>();
    await publishViewerCaretRead({
      read: Promise.reject(new Error('engine unavailable')),
      isCurrent: () => true,
      placement: { left: 10, top: 20, suggestTop: true },
      emit,
    });

    expect(emit).toHaveBeenCalledWith({
      type: 'caret',
      value: {
        anchor: null,
        placement: null,
        diagnostic: 'caret-read-unavailable',
      },
    });
  });
});
