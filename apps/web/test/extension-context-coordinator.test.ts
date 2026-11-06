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
 const previous = setup(); previous.coordinator.setAttachment({ id: 'notes', title: 'Annotations', text: 'removed notes' }); previous.coordinator.publish(snapshot()); await tick();
 previous.coordinator.reconcile(null); previous.coordinator.dispose();
 const remount = setup(null); remount.coordinator.publish(snapshot(2));
 previous.ack('predecessor-late'); await tick(); expect(previous.calls).toHaveLength(1);
 remount.coordinator.reconcile({ updateId: 'predecessor-late', content: previous.calls[0].content }); await tick();
 expect(remount.calls).toHaveLength(1); expect(remount.calls[0].content).toEqual([]); expect(remount.coordinator.status).toBe('paused');
 remount.ack('cleared'); await tick(); remount.coordinator.publish(snapshot(3)); await tick();
 expect(remount.calls).toHaveLength(1); expect(remount.coordinator.attachments).toEqual([]);
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

it('keeps independently named groups through background updates and partial removal', async () => {
 const f = setup(); f.coordinator.setAttachment({ id: 'one', title: 'First selection', text: 'first' }); f.coordinator.setAttachment({ id: 'two', title: 'Chosen notes', text: 'second' }); f.coordinator.publish(snapshot()); await tick();
 expect(f.calls[0].content.filter((b: any) => b._meta?.['openai/group']).map((b: any) => b._meta['openai/group'].title)).toEqual(['First selection', 'Chosen notes']);
 f.ack(); await tick(); f.coordinator.reconcile({ updateId: 'partial', content: f.calls[0].content.filter((b: any) => b._meta?.['openai/group']?.title !== 'First selection') }); f.coordinator.publish(snapshot(4)); await tick();
 expect(f.coordinator.attachments).toEqual(['two']); expect(JSON.stringify(f.calls.at(-1))).toContain('Chosen notes'); expect(JSON.stringify(f.calls.at(-1))).not.toContain('First selection');
});
it('retains partial group removal through disposal, host-state remount and a late predecessor publication', async () => {
 const foreign = { type: 'resource', resource: { uri: 'other-app:///attachment', mimeType: 'text/plain', text: 'Unrelated context' }, _meta: { 'openai/group': { title: 'Other app' } } };
 const structuredContent = { unrelated: { selected: 'keep' } };
 const previous = setup({ updateId: 'initial', content: [foreign], structuredContent });
 previous.coordinator.enableBackground();
 previous.coordinator.setAttachment({ id: 'removed', title: 'Annotations to remove', text: 'removed evidence' });
 previous.coordinator.setAttachment({ id: 'retained', title: 'Annotations to keep', text: 'retained evidence' });
 previous.coordinator.publish(snapshot()); await tick();
 const predecessor = previous.calls[0];
 const retained = { updateId: 'user-removal', ...predecessor, content: predecessor.content.filter((block: any) => block._meta?.['openai/group']?.title !== 'Annotations to remove') };
 previous.coordinator.reconcile(retained);
 expect(previous.coordinator.attachments).toEqual(['retained']);
 previous.coordinator.dispose();

 const remount = setup(retained); remount.coordinator.publish(snapshot(2)); await tick();
 expect(remount.calls).toHaveLength(1);
 expect(remount.calls[0].content.filter((block: any) => block._meta?.['openai/group']).map((block: any) => block._meta['openai/group'].title)).toEqual(['Other app', 'Annotations to keep']);
 expect(remount.calls[0].content[0]).toEqual(foreign); expect(remount.calls[0].structuredContent).toEqual(structuredContent);
 remount.ack('remounted'); await tick();

 previous.ack('late-predecessor'); await tick(); expect(previous.calls).toHaveLength(1);
 remount.coordinator.reconcile({ updateId: 'late-predecessor', ...predecessor }); await tick();
 expect(remount.calls).toHaveLength(2);
 expect(JSON.stringify(remount.calls[1])).not.toContain('removed evidence');
 expect(remount.calls[1].content).toEqual(remount.calls[0].content);
 expect(remount.calls[1].structuredContent).toEqual(structuredContent);
 remount.ack('corrected'); await tick(); remount.coordinator.publish(snapshot(3)); await tick();
 expect(remount.coordinator.attachments).toEqual(['retained']);
 expect(remount.calls.at(-1).content.find((block: any) => block.resource?.uri === backgroundContextUri).resource.text).toContain('"page":3');
 expect(JSON.stringify(remount.calls.at(-1))).not.toContain('removed evidence');
});
it('labels bounded explicit attachment excerpts while retaining complete draft text in its caller', async () => {
 const f = setup(); const text = 'e'.repeat(9000); f.coordinator.setAttachment({ id: 'large', title: 'Full discussion', text }); await tick();
 const body = f.calls[0].content[0].resource.text; expect(body.length).toBeLessThan(6200); expect(body).toContain('5600 of 9000'); expect(body).toContain('Full text is in the editable or copyable discussion draft'); expect(text).toHaveLength(9000);
});

it('keeps large captured snapshot attachments valid and truthfully bounded without referring to a nonexistent draft', async () => {
 const f=setup();
 const text=JSON.stringify({kind:'untrusted-document-snapshot',title:'Large.pdf',capturedAt:'2026-11-05T12:00:00Z',generation:2,revision:4,sourceDigest:'digest',summary:'S'.repeat(8000),annotations:Array.from({length:100},(_,i)=>({page:i+1,text:'A'.repeat(2000)})),truncated:false});
 f.coordinator.setAttachment({kind:'snapshot',id:'snapshot',title:'Large.pdf',text});await tick();
 const published=f.calls[0].content[0].resource.text;
 expect(published).not.toContain('discussion draft');
 const body=JSON.parse(published.split('\n').at(-1));
 expect(body).toMatchObject({kind:'untrusted-document-snapshot',generation:2,revision:4,capturedAt:'2026-11-05T12:00:00Z',sourceDigest:'digest',truncated:true,attachmentTruncation:{originalCharacters:text.length}});
 expect(JSON.stringify(body).length).toBeLessThanOrEqual(6000);
 expect(body.summary.length).toBeGreaterThan(0);
 expect(body.annotations.length).toBeGreaterThan(0);
});

it('bounds escaped snapshot content by encoded size and keeps a small snapshot intact', async () => {
 const small=setup(), text=JSON.stringify({kind:'untrusted-document-snapshot',summary:'Exact captured text',revision:2});
 small.coordinator.setAttachment({kind:'snapshot',id:'small',title:'Small',text});await tick();
 expect(small.calls[0].content[0].resource.text.split('\n').at(-1)).toBe(text);
 const large=setup();large.coordinator.setAttachment({kind:'snapshot',id:'escaped',title:'Escaped',text:JSON.stringify({summary:'\u0000'.repeat(8000),annotations:[{page:1,text:'\u0001'.repeat(2000)}]})});await tick();
 const body=large.calls[0].content[0].resource.text.split('\n').at(-1);
 expect(body.length).toBeLessThanOrEqual(6000);expect(JSON.parse(body).truncated).toBe(true);
});
