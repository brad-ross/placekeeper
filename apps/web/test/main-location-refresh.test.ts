import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTrailingTaskScheduler } from '../src/review/main-location-refresh.js';

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
});
