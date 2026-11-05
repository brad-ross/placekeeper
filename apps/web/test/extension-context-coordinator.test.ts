import { expect, it, vi } from 'vitest';
import { ExtensionContextCoordinator, backgroundContextUri } from '../src/host/extension-context-coordinator.js';
import type { ReviewContextSnapshot } from '../src/host/review-context-snapshot.js';
const snapshot = (page = 1, generation = 1): ReviewContextSnapshot => ({ documentGeneration: generation, reviewRevision: 2, title: 'PDF', source: { fileId: '/private/secret.pdf', digest: 'digest' }, page, pageCount: 10, selection: null, annotations: [] });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup(initial?: any) {
 let resolve!: (value: any) => void;
 const calls: any[] = [];
 const api = { getCurrent: () => initial, update: vi.fn((value: any) => { calls.push(value); return new Promise<any>(done => { resolve = done; }); }) };
 const coordinator = new ExtensionContextCoordinator(api, undefined, { freshInvocation: initial === undefined });
 return { coordinator, calls, ack: (updateId = 'ack') => resolve({ updateId }) };
}
it('coalesces rapid pages and bounds untrusted accepted snapshots without source paths', async () => {
 const f = setup(); f.coordinator.publish(snapshot()); f.coordinator.publish(snapshot(2)); f.coordinator.publish(snapshot(3, 2)); await tick();
 expect(f.calls).toHaveLength(1); expect(f.calls[0].content[0].resource.text).toContain('"page":3'); expect(JSON.stringify(f.calls[0])).not.toContain('/private');
 expect(JSON.stringify(f.calls[0])).toContain('Untrusted'); f.ack(); await tick(); expect(f.coordinator.status).toBe('available');
});
it('host removal wins over an in-flight acknowledgement and later navigation', async () => {
 const f = setup(); f.coordinator.setAttachment({ id: 'notes', title: 'Notes', text: 'one' }); f.coordinator.publish(snapshot()); await tick();
 f.coordinator.reconcile({ updateId: 'removed', content: f.calls[0].content.filter((block: any) => block.resource?.uri === backgroundContextUri) });
 f.coordinator.publish(snapshot(2)); f.ack('old'); await tick();
 expect(f.calls).toHaveLength(2); expect(JSON.stringify(f.calls[1])).not.toContain('one');
 f.ack('new'); await tick(); expect(f.coordinator.status).toBe('available');
});
it('clear all pauses pending background, including same-instance reader remount', async () => {
 const f = setup(); f.coordinator.publish(snapshot()); await tick(); f.coordinator.reconcile(null); f.ack('late'); await tick();
 f.coordinator.publish(snapshot(4)); await tick(); expect(f.coordinator.status).toBe('paused');
 expect(f.calls.at(-1).content).toEqual([]); f.ack(); await tick();
 f.coordinator.enableBackground(); await tick(); expect(f.calls.at(-1).content[0].resource.text).toContain('"page":4');
});
it('reconciles initial context before publishing and preserves unknown host blocks', async () => {
 const unknown = { type: 'text', text: 'another attachment' };
 const f = setup({ updateId: 'existing', content: [unknown] }); f.coordinator.publish(snapshot()); await tick(); expect(f.calls).toHaveLength(0);
 f.coordinator.enableBackground(); await tick(); expect(f.calls[0].content[0]).toEqual(unknown);
 const remount = setup(null); remount.coordinator.publish(snapshot()); await tick(); expect(remount.calls).toHaveLength(0); expect(remount.coordinator.status).toBe('paused');
});
it('reports unavailable capability and preferences do not undo local removal intent', async () => {
 const unavailable = new ExtensionContextCoordinator(undefined); unavailable.publish(snapshot()); expect(unavailable.status).toBe('unsupported');
 const f = setup(); f.coordinator.publish(snapshot()); await tick(); f.coordinator.reconcile(null); f.coordinator.setPreferences({ backgroundContext: true, selectionSharing: true }); f.ack(); await tick(); expect(f.coordinator.status).toBe('paused');
});

it('recognizes removal with an unchanged host update ID and ignores its later stale echo', async () => {
 const f = setup(); f.coordinator.setAttachment({ id: 'notes', title: 'Notes', text: 'do not restore' }); f.coordinator.publish(snapshot()); await tick();
 const original = f.calls[0]; f.ack('same-id'); await tick();
 f.coordinator.reconcile({ updateId: 'same-id', content: original.content.filter((block: any) => block.resource?.uri === backgroundContextUri) });
 await tick(); f.ack('new-id'); await tick();
 f.coordinator.reconcile({ updateId: 'same-id', ...original }); f.coordinator.publish(snapshot(4)); await tick();
 expect(JSON.stringify(f.calls.at(-1))).not.toContain('do not restore'); expect(f.coordinator.attachments).toEqual([]);
});
it('keeps a previously published app paused when initial host state is unavailable', async () => {
 const update = vi.fn(); const coordinator = new ExtensionContextCoordinator({ getCurrent: () => undefined, update });
 coordinator.publish(snapshot()); await tick(); expect(update).not.toHaveBeenCalled(); expect(coordinator.status).toBe('paused');
});
it('bounds selection and review evidence and honors selection preferences separately', async () => {
 const f = setup(); f.coordinator.publish({ ...snapshot(), selection: { text: 'x'.repeat(10000), pages: [1,2,3,4,5,6,7,8,9] }, annotations: Array.from({length: 100}, (_, i) => ({ id: String(i), page: 1, kind: 'note', text: 'y'.repeat(1000) })) }); await tick();
 const body = JSON.parse(f.calls[0].content[0].resource.text.split('\n').at(-1));
 expect(body.selection.text).toHaveLength(1600); expect(body.selection.pages).toHaveLength(8); expect(body.annotations).toHaveLength(20); expect(body.annotations[0].text).toHaveLength(240); expect(body.totalAnnotations).toBe(100); expect(body.truncated).toBe(true);
 f.ack(); await tick(); f.coordinator.setPreferences({ backgroundContext: true, selectionSharing: false }); await tick(); expect(f.calls.at(-1).content[0].resource.text).toContain('"selection":null');
});
it('removes a late predecessor publication after remount instead of restoring cleared groups', async () => {
 const previous = setup(); previous.coordinator.publish(snapshot()); await tick();
 const remount = setup(null); remount.coordinator.publish(snapshot(2));
 remount.coordinator.reconcile({ updateId: 'predecessor-late', content: previous.calls[0].content }); await tick();
 expect(remount.calls).toHaveLength(1); expect(remount.calls[0].content).toEqual([]); expect(remount.coordinator.status).toBe('paused');
});
it('a proven fresh invocation applies default sharing alongside unrelated host context', async () => {
 const foreign = { type: 'text' as const, text: 'Keep this attachment' };
 const update = vi.fn(async (_params: any) => ({ updateId: 'fresh' }));
 const coordinator = new ExtensionContextCoordinator({ getCurrent: () => ({ updateId: 'foreign', content: [foreign] }), update }, undefined, { freshInvocation: true });
 coordinator.publish(snapshot()); await tick();
 expect(update).toHaveBeenCalledOnce(); expect(update.mock.calls[0]![0].content[0]).toEqual(foreign); expect(update.mock.calls[0]![0].content[1].resource.uri).toBe(backgroundContextUri);
});
it('retries one failed same-state publication on an explicit recovery wake without restoring removed groups', async () => {
 const update = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ updateId: 'recovered' });
 const coordinator = new ExtensionContextCoordinator({ getCurrent: () => undefined, update }, undefined, { freshInvocation: true });
 coordinator.publish(snapshot()); await tick(); expect(coordinator.status).toBe('unavailable');
 coordinator.publish(snapshot()); await tick(); expect(update).toHaveBeenCalledTimes(1);
 coordinator.retry(); coordinator.retry(); await tick(); expect(update).toHaveBeenCalledTimes(2); expect(coordinator.status).toBe('available');
 expect(update.mock.calls[1]?.[0].content[0].resource.text).toContain('"documentDigest":"digest"');
 coordinator.reconcile(null); await tick(); coordinator.retry(); await tick(); expect(update.mock.calls.at(-1)?.[0].content).toEqual([]);
});
