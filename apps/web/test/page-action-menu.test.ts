import { describe, expect, it } from 'vitest';

import { clampMenuToViewport } from '../src/review/PageActionMenu.js';

describe('page action menu placement', () => {
  const size = { width: 44, height: 44 };
  const viewport = { width: 1280, height: 720 };

  it('opens at the pointer when the menu fits', () => {
    expect(clampMenuToViewport({ left: 400, top: 300 }, size, viewport)).toEqual({ left: 400, top: 300 });
  });

  it('moves a menu opened near the bottom or right edge fully inside the window', () => {
    expect(clampMenuToViewport({ left: 1270, top: 710 }, size, viewport)).toEqual({ left: 1228, top: 668 });
  });

  it('keeps the menu off the top and left edges', () => {
    expect(clampMenuToViewport({ left: -20, top: 2 }, size, viewport)).toEqual({ left: 8, top: 8 });
  });
});
