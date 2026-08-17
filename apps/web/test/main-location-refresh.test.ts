import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTrailingTaskScheduler,
  waitForReviewNavigationReady,
} from '../src/review/main-location-refresh.js';

afterEach(() => vi.useRealTimers());

describe('main location refresh scheduling', () => {
  it('captures only the trailing location from a burst and supports cancellation', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const scheduler = createTrailingTaskScheduler(refresh, 80);

    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(40);
    scheduler.schedule();
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(79);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();

    scheduler.schedule();
    scheduler.cancel();
    await vi.advanceTimersByTimeAsync(80);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('flushes a pending capture synchronously and clears its timer', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const scheduler = createTrailingTaskScheduler(refresh, 80);

    scheduler.schedule();
    scheduler.flush();
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(80);
    expect(refresh).toHaveBeenCalledOnce();
    scheduler.flush();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps waiting past a fixed frame budget until navigation is actually ready', async () => {
    let attempts = 0;
    const ready = await waitForReviewNavigationReady({
      isCurrent: () => true,
      isReady: () => attempts > 120,
      wait: async () => { attempts += 1; },
    });

    expect(ready).toBe(true);
    expect(attempts).toBe(121);
  });

  it('stops waiting when the document generation is no longer current', async () => {
    let current = true;
    const ready = await waitForReviewNavigationReady({
      isCurrent: () => current,
      isReady: () => false,
      wait: async () => { current = false; },
    });

    expect(ready).toBe(false);
  });
});
