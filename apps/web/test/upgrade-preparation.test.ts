import { expect, it } from 'vitest';
import { ReviewUpgradePreparation } from '../src/host/upgrade-preparation.js';
import type { UpgradeReviewStatus } from '../../../packages/core/src/upgrade-review-protocol.js';

it('flushes current input after freezing, keeps the view open until commit, and unfreezes a declined or canceled attempt', async () => {
  const attemptId = 'a'.repeat(43);
  let status: UpgradeReviewStatus = { phase: 'preview', attemptId };
  let text = 'typed immediately before acceptance'; let durable = ''; let frozen = false; let closed = 0;
  const view = new ReviewUpgradePreparation({
    poll: async () => status,
    settle: async request => { expect(request).toEqual({ attemptId }); expect(durable).toBe(text); return status; },
    protectInput: async () => { expect(frozen).toBe(true); durable = text; },
    frozen: value => { frozen = value; }, close: async () => { closed++; },
  });
  await view.tick(); expect(frozen).toBe(false); expect(durable).toBe('');
  status = { phase: 'preparing', attemptId }; await view.tick();
  expect(durable).toBe(text); expect(closed).toBe(0);
  status = { phase: 'canceled', attemptId, reason: 'Peer could not save' }; await view.tick();
  expect(frozen).toBe(false); expect(closed).toBe(0);
  text = 'new input'; status = { phase: 'preparing', attemptId }; await view.tick();
  status = { phase: 'ready', attemptId }; await view.tick(); expect(closed).toBe(0);
  status = { phase: 'committed', attemptId }; await view.tick(); expect(closed).toBe(1);
});

it('does not acknowledge or close a retired frame after its delayed flush completes', async () => {
  const flush = Promise.withResolvers<void>(); let acknowledgements = 0; let closed = 0;
  const view = new ReviewUpgradePreparation({
    poll: async () => ({ phase: 'preparing', attemptId: 'b'.repeat(43) }),
    settle: async () => { acknowledgements++; return { phase: 'committed', attemptId: 'b'.repeat(43) }; },
    protectInput: () => flush.promise, frozen: () => {}, close: async () => { closed++; },
  });
  const tick = view.tick(); await Promise.resolve();
  view.stop(); flush.resolve(); await tick;
  expect(acknowledgements).toBe(0); expect(closed).toBe(0);
});

it('reports failed input protection to the service and keeps the failed view open', async () => {
  const attemptId = 'c'.repeat(43); let frozen = false; let closed = 0;
  const view = new ReviewUpgradePreparation({
    poll: async () => ({ phase: 'preparing', attemptId }),
    settle: async request => { expect(request).toEqual({ attemptId, error: 'disk full' }); return { phase: 'canceled', attemptId }; },
    protectInput: async () => { throw new Error('disk full'); }, frozen: value => { frozen = value; }, close: async () => { closed++; },
  });
  await view.tick(); expect(frozen).toBe(false); expect(closed).toBe(0);
});

it('drops native and host command tokens observed while frozen instead of replaying them after cancellation', async () => {
  const { UpgradeCommandGate } = await import('../src/host/upgrade-preparation.js');
  const gate = new UpgradeCommandGate();
  const native = { id: 'undo' as const, token: 4 };
  expect(gate.filter(native, false, 'native')).toEqual(native);
  expect(gate.filter({ ...native, token: 5 }, true, 'native')).toBeUndefined();
  expect(gate.filter({ ...native, token: 5 }, false, 'native')).toBeUndefined();
  expect(gate.filter({ ...native, token: 4 }, false, 'native')).toBeUndefined();
  expect(gate.filter({ ...native, token: 6 }, false, 'native')).toEqual({ ...native, token: 6 });
  expect(gate.filter({ ...native, token: 1 }, true, 'host')).toBeUndefined();
  expect(gate.filter({ ...native, token: 1 }, false, 'host')).toBeUndefined();
  expect(gate.filter({ ...native, token: 2 }, false, 'host')).toEqual({ ...native, token: 2 });
});
