import { it, expect, vi } from 'vitest';
import { FocusedLaunchNavigation } from '../src/host/electron-focused-navigation.js';
import { MemoryReviewLocationHistory } from '../src/review/review-location-history.js';
it('focused activation waits shared navigation and paint rather than acknowledging the old page', async () => {
    const history = new MemoryReviewLocationHistory();
    let settle!: (value: boolean) => void;
    const requested: unknown[] = [];
    history.start(async () => { requested.push(history.read()); return new Promise<boolean>(resolve => { settle = resolve; }); });
    const visible = vi.fn(async () => {});
    const painted = vi.fn(async () => {});
    const controller = new FocusedLaunchNavigation({ navigate: location => history.navigate(location), painted, visible, failed: async () => {} });
    const pending = controller.apply({ type: 'confirm-visible', generation: 1, token: 'current', location: { kind: 'page', page: 4 } });
    await Promise.resolve();
    expect(requested).toEqual([{ kind: 'page', page: 4 }]);
    expect(visible).not.toHaveBeenCalled(); expect(painted).not.toHaveBeenCalled();
    settle(true); await pending;
    expect(visible).toHaveBeenCalledWith(1, 'current');
    expect(history.snapshot()).toEqual({ canBack: true, canForward: false });
});
it('superseded or retired focused navigation cannot authorize the next launch', async () => {
    const completions: Array<() => void> = [];
    const visible = vi.fn(async () => {});
    const controller = new FocusedLaunchNavigation({ navigate: () => new Promise(resolve => completions.push(resolve)), painted: async () => {}, visible, failed: async () => {} });
    const old = controller.apply({ type: 'confirm-visible', generation: 1, token: 'old', location: { kind: 'page', page: 2 } });
    const current = controller.apply({ type: 'confirm-visible', generation: 1, token: 'new', location: { kind: 'page', page: 3 } });
    completions[0]!(); await old; expect(visible).not.toHaveBeenCalled();
    controller.dispose(); completions[1]!(); await current; expect(visible).not.toHaveBeenCalled();
});
it('a stale or failed shared restore fails focused activation without retiring the reader', async () => {
    const history = new MemoryReviewLocationHistory(); history.start(async () => false);
    const failed = vi.fn(async () => {}); const visible = vi.fn(async () => {});
    const controller = new FocusedLaunchNavigation({ navigate: location => history.navigate(location), painted: async () => {}, visible, failed });
    await expect(controller.apply({ type: 'confirm-visible', generation: 1, token: 'failed', location: { kind: 'page', page: 2 } })).rejects.toThrow('superseded');
    expect(failed).toHaveBeenCalledWith('failed'); expect(visible).not.toHaveBeenCalled();
});
