import { expect, it } from 'vitest';
import { WindowRetirementBarrier } from '../src/window-retirement.js';
function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}
it('keeps final quit behind helper detach and the final lifecycle activity acknowledgement', async () => {
    const detach = deferred(), activityAcknowledged = deferred();
    const barrier = new WindowRetirementBarrier();
    const events = ['window destroyed'];
    const tracked = barrier.track(detach.promise.then(async () => { events.push('helper detached'); await activityAcknowledged.promise; events.push('activity acknowledged'); }));
    const quit = barrier.wait().then(() => { events.push('lifecycle pipe ended'); });
    expect(barrier.hasPending).toBe(true);
    detach.resolve(); await detach.promise; await Promise.resolve();
    expect(events).toEqual(['window destroyed', 'helper detached']);
    expect(barrier.hasPending).toBe(true);
    activityAcknowledged.resolve(); await tracked; await quit;
    expect(events).toEqual(['window destroyed', 'helper detached', 'activity acknowledged', 'lifecycle pipe ended']);
    expect(barrier.hasPending).toBe(false);
});
it('waits for another window retirement admitted while earlier detach is pending', async () => {
    const first = deferred(), second = deferred();
    const barrier = new WindowRetirementBarrier();
    void barrier.track(first.promise);
    let quit = false;
    const finished = barrier.wait().then(() => { quit = true; });
    const trackedSecond = barrier.track(second.promise);
    first.resolve(); await first.promise; await Promise.resolve();
    expect(quit).toBe(false);
    second.resolve(); await trackedSecond; await finished;
    expect(quit).toBe(true);
});
it('reports detach failure instead of claiming an orderly lifecycle shutdown', async () => {
    const detach = deferred();
    const barrier = new WindowRetirementBarrier();
    const tracked = barrier.track(detach.promise);
    const waiting = barrier.wait();
    const trackedFailure = expect(tracked).rejects.toThrow('detach unavailable');
    const waitingFailure = expect(waiting).rejects.toThrow('detach unavailable');
    detach.reject(new Error('detach unavailable'));
    await Promise.all([trackedFailure, waitingFailure]);
    expect(barrier.hasPending).toBe(false);
});
