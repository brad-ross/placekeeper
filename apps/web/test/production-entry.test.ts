import { describe, expect, it } from 'vitest';

import { terminalRecoveryLocationFragment } from '../src/production-entry.js';

describe('terminal readable-view recovery', () => {
  it('preserves canonical page, item, and durable destination fragments', () => {
    expect(terminalRecoveryLocationFragment('#v=1&page=3')).toBe('v=1&page=3');
    expect(terminalRecoveryLocationFragment(
      '#v=1&page=4&item=00000000-0000-4000-8000-000000000044',
    )).toBe('v=1&page=4&item=00000000-0000-4000-8000-000000000044');
    expect(terminalRecoveryLocationFragment(
      '#v=2&page=7&mode=xyz&params=12,640,1.25',
    )).toBe('v=2&page=7&mode=xyz&params=12,640,1.25');
  });

  it('converges malformed stale-route fragments to canonical page 1', () => {
    expect(terminalRecoveryLocationFragment('#unsafe')).toBe('v=1&page=1');
  });
});
