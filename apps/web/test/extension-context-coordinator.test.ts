import { expect, it, vi } from 'vitest';
import type { DocumentContextMember, DocumentContextPublicationStatus } from '../src/host/document-in-context.js';
import { ExtensionContextCoordinator, backgroundContextUri } from '../src/host/extension-context-coordinator.js';
import type { ReviewContextSnapshot } from '../src/host/review-context-snapshot.js';
const snapshot = (page = 1, generation = 1): ReviewContextSnapshot => ({ documentGeneration: generation, reviewRevision: 2, title: 'PDF', source: { fileId: '/private/secret.pdf', digest: 'digest' }, page, pageCount: 10, selection: null, annotations: [] });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup(initial?: any, freshInvocation = initial === undefined, onDocumentStatus?: (member: DocumentContextMember, status: DocumentContextPublicationStatus) => void, options: NonNullable<ConstructorParameters<typeof ExtensionContextCoordinator>[2]> = {}) {
 let resolve!: (value: any) => void;
 let reject!: (reason: Error) => void;
 const calls: any[] = [];
 const api = { getCurrent: () => initial, update: vi.fn((value: any) => { calls.push(value); return new Promise<any>((done, fail) => { resolve = done; reject = fail; }); }) };
 const coordinator = new ExtensionContextCoordinator(api, undefined, {
   ...options, freshInvocation, ...(onDocumentStatus === undefined ? {} : { onDocumentStatus }),
 });
 return { coordinator, calls, ack: (updateId = 'ack') => resolve({ updateId }), reject: () => reject(Error('offline')), noAck: () => resolve(null) };
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
it('clear all pauses pending background and later review and selection updates', async () => {
 const f = setup(); f.coordinator.publish(snapshot()); await tick(); f.coordinator.reconcile(null); f.ack('late'); await tick();
 expect(f.calls.at(-1).content).toEqual([]); f.ack(); await tick();
 f.coordinator.publish({ ...snapshot(4), selection: { text: 'New selection', pages: [4] } }); await tick();
 expect(f.coordinator.status).toBe('paused'); expect(f.calls).toHaveLength(2);
});
it('keeps a remount paused when initial context lacks the background group', async () => {
 const unknown = { type: 'text', text: 'another attachment' };
 const f = setup({ updateId: 'existing', content: [unknown] }); f.coordinator.publish(snapshot()); await tick(); expect(f.calls).toHaveLength(0);
 expect(f.coordinator.status).toBe('paused');
 const remount = setup(null); remount.coordinator.publish(snapshot()); await tick(); expect(remount.calls).toHaveLength(0); expect(remount.coordinator.status).toBe('paused');
});
it('reports unsupported context when the host provides no capability', () => {
 const unavailable = new ExtensionContextCoordinator(undefined); unavailable.publish(snapshot()); expect(unavailable.status).toBe('unsupported');
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
it('automatically shares bounded selection and review evidence', async () => {
 const f = setup(); f.coordinator.publish({ ...snapshot(), selection: { text: 'x'.repeat(10000), pages: [1,2,3,4,5,6,7,8,9] }, annotations: Array.from({length: 100}, (_, i) => ({ id: String(i), page: 1, kind: 'note', text: 'y'.repeat(1000) })) }); await tick();
 const body = JSON.parse(f.calls[0].content[0].resource.text.split('\n').at(-1));
 expect(body.selection.text).toHaveLength(1600); expect(body.selection.pages).toHaveLength(8); expect(body.annotations).toHaveLength(20); expect(body.annotations[0].text).toHaveLength(240); expect(body.totalAnnotations).toBe(100); expect(body.truncated).toBe(true);
 f.ack(); await tick(); f.coordinator.publish(snapshot()); await tick(); expect(f.calls.at(-1).content[0].resource.text).toContain('"selection":null');
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
 const previous = setup({ updateId: 'initial', content: [foreign], structuredContent }, true);
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
it('labels bounded explicit attachment excerpts without claiming omitted content is available', async () => {
 const f = setup(); const text = 'e'.repeat(9000); f.coordinator.setAttachment({ id: 'large', title: 'Full discussion', text }); await tick();
 const body = f.calls[0].content[0].resource.text; expect(body.length).toBeLessThan(6200); expect(body).toContain('5600 of 9000'); expect(body).toContain('Omitted content is not attached'); expect(text).toHaveLength(9000);
});

it('explicit inclusion waits for host acknowledgement and rejects failed delivery',async()=>{
 const f=setup();let complete=false;const attaching=f.coordinator.includeAttachment({id:'note',title:'Note',text:'evidence'}).then(()=>{complete=true;});
 await tick();expect(complete).toBe(false);f.ack('included');await attaching;expect(complete).toBe(true);
 const broken=new ExtensionContextCoordinator({getCurrent:()=>null,update:async()=>{throw Error('offline');}});
 await expect(broken.includeAttachment({id:'note',title:'Note',text:'evidence'})).rejects.toThrow('could not be attached');
});
it('explicit inclusion does not report success after host removal or disposal',async()=>{
 const f=setup();const attaching=f.coordinator.includeAttachment({id:'note',title:'Note',text:'evidence'});const rejection=expect(attaching).rejects.toThrow();await tick();f.coordinator.reconcile(null);f.ack('late');await rejection;
 const g=setup();const pending=g.coordinator.includeAttachment({id:'note',title:'Note',text:'evidence'});const disposed=expect(pending).rejects.toThrow();g.coordinator.dispose();await disposed;
});

it('discards a rejected explicit note before publishing a queued background update', async () => {
 const f = setup();
 f.coordinator.publish(snapshot()); await tick(); f.ack('initial'); await tick();
 const note = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'unsent note' });
 const rejection = expect(note).rejects.toThrow('could not be attached');
 await tick();
 expect(JSON.stringify(f.calls.at(-1))).toContain('unsent note');
 f.coordinator.publish(snapshot(2));
 f.reject(); await rejection; await tick();
 expect(f.coordinator.attachments).toEqual([]);
 expect(f.calls.at(-1).content[0].resource.text).toContain('"page":2');
 expect(JSON.stringify(f.calls.at(-1))).not.toContain('unsent note');
});

it('restores the confirmed note after edits fail, including a null acknowledgement', async () => {
 const f = setup();
 const original = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'confirmed note' });
 await tick(); f.ack('original'); await original;
 const edit = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'failed edit' });
 const rejection = expect(edit).rejects.toThrow('could not be attached');
 await tick(); f.noAck(); await rejection;
 f.coordinator.publish(snapshot(2)); await tick();
 expect(f.coordinator.attachments).toEqual(['note']);
 expect(JSON.stringify(f.calls.at(-1))).toContain('confirmed note');
 expect(JSON.stringify(f.calls.at(-1))).not.toContain('failed edit');
});

it('preserves a newer staged edit when the previous update rejects', async () => {
 const f = setup();
 const previous = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'previous edit' });
 const rejection = expect(previous).rejects.toThrow('could not be attached');
 await tick();
 const newer = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'newer edit' });
 f.reject(); await rejection; await tick();
 expect(JSON.stringify(f.calls.at(-1))).toContain('newer edit');
 f.ack('newer'); await newer;
});

it('does not restore a confirmed note after the host removes it during a failed edit', async () => {
 const f = setup();
 const original = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'confirmed note' });
 await tick(); f.ack('original'); await original;
 const edit = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'failed edit' });
 const rejection = expect(edit).rejects.toThrow('could not be attached');
 await tick(); f.coordinator.reconcile(null); f.reject(); await rejection; await tick();
 expect(f.coordinator.attachments).toEqual([]);
 expect(f.calls.at(-1).content).toEqual([]);
});

it('rebuilds a prepared write when the host updates before publication starts', async () => {
 let ready!: () => void;
 const beforeUpdate = vi.fn(() => new Promise<void>(resolve => { ready = resolve; }));
 const background = { type: 'resource' as const, resource: { uri: backgroundContextUri, mimeType: 'text/plain', text: 'Previous background' } };
 const foreign = { type: 'text' as const, text: 'New foreign context' };
 const update = vi.fn(async (_value: unknown) => ({ updateId: 'published' }));
 const coordinator = new ExtensionContextCoordinator({
   getCurrent: () => ({ updateId: 'initial', content: [background] }), update,
 }, undefined, { beforeUpdate });
 const note = coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'new note' });
 await tick();
 expect(update).not.toHaveBeenCalled();
 coordinator.reconcile({ updateId: 'foreign-change', content: [background, foreign] });
 ready(); await tick();
 expect(update).not.toHaveBeenCalled();
 ready(); await note;
 expect(update).toHaveBeenCalledOnce();
 expect(JSON.stringify(update.mock.calls[0])).toContain('New foreign context');
 expect(JSON.stringify(update.mock.calls[0])).toContain('new note');
});

it('does not transmit a prepared note after the host clears context', async () => {
 let ready!: () => void;
 const beforeUpdate = () => new Promise<void>(resolve => { ready = resolve; });
 const update = vi.fn(async (_value: unknown) => ({ updateId: 'published' }));
 const coordinator = new ExtensionContextCoordinator({ getCurrent: () => undefined, update }, undefined, { freshInvocation: true, beforeUpdate });
 const note = coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'cleared note' });
 const rejection = expect(note).rejects.toThrow('could not be attached');
 await tick();
 coordinator.reconcile(null);
 ready(); await rejection; await tick();
 expect(update).not.toHaveBeenCalled();
});

it('retains a submitted note when a host notification only shows previously known groups', async () => {
 const f = setup();
 f.coordinator.publish(snapshot()); await tick(); f.ack('initial'); await tick();
 const note = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'pending note' });
 await tick();
 const foreign = { type: 'text', text: 'Updated foreign context' };
 f.coordinator.reconcile({ updateId: 'foreign-change', content: [...f.calls[0].content, foreign] });
 f.ack('included'); await note; await tick();
 expect(f.coordinator.attachments).toEqual(['note']);
 expect(f.calls.at(-1).content[0]).toEqual(foreign);
 expect(JSON.stringify(f.calls.at(-1))).toContain('pending note');
});

const documentMember = (generation = 1) => ({
 sourceKey: 'admitted-source', generation, digest: `digest-${generation}`, title: 'Complete paper',
 blob: btoa(`%PDF-1.7\ncomplete version ${generation}\n%%EOF`),
});
const pdfBlocks = (payload: { content: any[] }) => payload.content.filter(block => block.resource?.mimeType === 'application/pdf');

it('acknowledges only the current PDF and retains its status during review-only writes', async () => {
 const onDocumentStatus = vi.fn();
 const f = setup(undefined, true, onDocumentStatus);
 f.coordinator.publish(snapshot());
 await tick(); f.ack('background'); await tick();
 expect(onDocumentStatus).not.toHaveBeenCalled();

 const first = documentMember();
 f.coordinator.setDocument(first);
 await tick();
 const second = documentMember(2);
 f.coordinator.setDocument(second);
 f.ack('old-pdf'); await tick();
 expect(onDocumentStatus.mock.calls).toEqual([[first, 'publishing'], [second, 'publishing']]);
 expect(pdfBlocks(f.calls.at(-1))).toHaveLength(1);
 expect(pdfBlocks(f.calls.at(-1))[0].resource.blob).toBe(second.blob);
 f.ack('current-pdf'); await tick();
 expect(onDocumentStatus).toHaveBeenLastCalledWith(second, 'available');

 f.coordinator.publish(snapshot(4, 2));
 await tick();
 expect(pdfBlocks(f.calls.at(-1))[0]).toBe(pdfBlocks(f.calls.at(-2))[0]);
 f.reject(); await tick();
 expect(onDocumentStatus).toHaveBeenCalledTimes(3);
});

it('replaces a declined PDF without disturbing captured or foreign context', async () => {
 const foreign = { type: 'text', text: 'keep foreign context' };
 const structuredContent = { keep: 'foreign data' };
 const onDocumentStatus = vi.fn();
 const f = setup({ updateId: 'foreign', content: [foreign], structuredContent }, true, onDocumentStatus);
 f.coordinator.publish(snapshot());
 f.coordinator.setDocument(documentMember());
 await tick(); f.ack('first'); await tick();

 const current = documentMember(2);
 f.coordinator.setDocument(current);
 const captured = f.coordinator.includeAttachment({ id: 'note', title: 'Note', text: 'keep captured context' });
 await tick(); f.ack(''); await tick();
 expect(onDocumentStatus).toHaveBeenLastCalledWith(current, 'unavailable');
 const cleaned = f.calls.at(-1);
 expect(pdfBlocks(cleaned)).toEqual([]);
 expect(cleaned.content[0]).toEqual(foreign);
 expect(cleaned.structuredContent).toEqual(structuredContent);
 expect(JSON.stringify(cleaned)).toContain('keep captured context');
 f.ack('cleaned'); await captured;
 expect(f.coordinator.status).toBe('available');
});

it('cancels a pending replacement on host removal and ignores its stale echo', async () => {
 const onDocumentStatus = vi.fn();
 const f = setup(undefined, true, onDocumentStatus);
 f.coordinator.publish(snapshot());
 f.coordinator.setDocument(documentMember());
 await tick(); f.ack('first'); await tick();
 const current = documentMember(2);
 f.coordinator.setDocument(current);
 await tick();
 const submitted = f.calls.at(-1);
 f.coordinator.reconcile({ updateId: 'removed', ...submitted, content: submitted.content.filter((block: any) => block.resource.mimeType !== 'application/pdf') });
 f.ack('removed'); await tick();
 expect(onDocumentStatus).toHaveBeenLastCalledWith(current, 'removed');
 expect(pdfBlocks(f.calls.at(-1))).toEqual([]);
 f.ack('cleaned'); await tick();
 f.coordinator.reconcile({ updateId: 'removed', ...submitted });
 f.coordinator.publish(snapshot(4));
 await tick();
 expect(pdfBlocks(f.calls.at(-1))).toEqual([]);
 expect(onDocumentStatus).toHaveBeenCalledTimes(4);
});

it('clears a lingering managed PDF on remount while retaining other host groups', async () => {
 const previous = setup();
 previous.coordinator.publish(snapshot());
 previous.coordinator.setDocument(documentMember());
 await tick();
 const onDocumentStatus = vi.fn();
 const foreignPdf = { type: 'resource', resource: { uri: 'other:///paper.pdf', mimeType: 'application/pdf', blob: documentMember().blob } };
 const remount = setup({ updateId: 'lingering', content: [...previous.calls[0].content, foreignPdf] }, false, onDocumentStatus);
 await tick();
 expect(pdfBlocks(remount.calls[0])).toEqual([foreignPdf]);
 expect(remount.calls[0].content).toContainEqual(previous.calls[0].content[0]);
 expect(onDocumentStatus).not.toHaveBeenCalled();
});

it('cancels the first PDF when a host notification confirms its write with the PDF removed', async () => {
 const onDocumentStatus = vi.fn();
 const f = setup(undefined, true, onDocumentStatus);
 const member = documentMember();
 f.coordinator.setDocument(member);
 f.coordinator.publish(snapshot());
 await tick();
 const submitted = f.calls[0];
 f.coordinator.reconcile({ updateId: 'removed-first-pdf', ...submitted, content: [submitted.content[0]] });
 f.ack('removed-first-pdf'); await tick();
 expect(onDocumentStatus.mock.calls).toEqual([[member, 'publishing'], [member, 'removed']]);
 expect(pdfBlocks(f.calls.at(-1))).toEqual([]);
});

it('omits an accepted PDF once its submission guard finds it no longer current', async () => {
 const onDocumentStatus = vi.fn();
 const f = setup(undefined, true, onDocumentStatus);
 const beforeSubmit = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('stale document'));
 const member = { ...documentMember(), beforeSubmit };
 f.coordinator.setDocument(member);
 await tick(); f.ack('first-pdf'); await tick();
 expect(onDocumentStatus).toHaveBeenLastCalledWith(member, 'available');

 f.coordinator.publish(snapshot(2));
 await tick();
 expect(beforeSubmit).toHaveBeenCalledTimes(2);
 expect(f.calls).toHaveLength(2);
 expect(pdfBlocks(f.calls.at(-1))).toEqual([]);
 expect(onDocumentStatus).toHaveBeenLastCalledWith(member, 'unavailable');
});

it('uses a matching receipt to recognize PDF removal among previously accepted groups', async () => {
 const observer = vi.fn();
 const f = setup(undefined, true, observer);
 f.coordinator.publish(snapshot());
 await tick(); f.ack('background'); await tick();
 const member = documentMember();
 f.coordinator.setDocument(member);
 await tick();
 const submission = f.calls[1];
 f.coordinator.reconcile({ ...f.calls[0], updateId: 'unrelated' });
 f.coordinator.reconcile({ ...f.calls[0], updateId: 'pdf-removed' });
 f.ack('pdf-removed'); await tick();
 expect(observer.mock.calls).toEqual([[member, 'publishing'], [member, 'removed']]);
 f.coordinator.reconcile({ ...submission, updateId: 'pdf-removed' });
 f.coordinator.publish(snapshot(2));
 await tick();
 expect(pdfBlocks(f.calls.at(-1))).toEqual([]);
});

it.each([false, true])('distinguishes an empty replacement echo from host clear-all during refresh (clear: %s)', async hostCleared => {
 const onContextCleared = vi.fn();
 const f = setup(undefined, true, undefined, { onContextCleared });
 f.coordinator.setDocument(documentMember());
 await tick(); f.ack('initial-pdf'); await tick();
 f.coordinator.clearDocument();
 await tick();
 expect(f.calls.at(-1).content).toEqual([]);
 f.coordinator.reconcile({ updateId: 'own-empty', ...f.calls.at(-1) });
 expect(onContextCleared).not.toHaveBeenCalled();
 if (hostCleared) f.coordinator.reconcile({ updateId: 'host-cleared', content: [] });
 f.ack('own-empty'); await tick();
 expect(onContextCleared).toHaveBeenCalledTimes(hostCleared ? 1 : 0);
 f.coordinator.reconcile({ updateId: 'own-empty', ...f.calls.at(-1) });
 expect(onContextCleared).toHaveBeenCalledTimes(hostCleared ? 1 : 0);
});

it.each(['remount', 'accepted', 'in flight'] as const)('retries PDF-only cleanup after a missing receipt (%s)', async stage => {
 const stalePdf = { type: 'resource', resource: {
   uri: 'placekeeper-context:///document/stale', mimeType: 'application/pdf', blob: documentMember().blob,
 } };
 const f = setup(stage === 'remount' ? { updateId: 'stale', content: [stalePdf] } : undefined);
 if (stage !== 'remount') {
   f.coordinator.setDocument(documentMember());
   await tick();
   if (stage === 'accepted') { f.ack('accepted'); await tick(); }
   f.coordinator.clearDocument();
   if (stage === 'in flight') f.noAck();
 }
 await tick();
 expect(f.calls.at(-1).content).toEqual([]);
 f.noAck(); await tick();
 expect(f.coordinator.status).toBe('unavailable');
 const calls = f.calls.length;
 f.coordinator.retry();
 await tick();
 expect(f.calls).toHaveLength(calls + 1);
 expect(f.calls.at(-1).content).toEqual([]);
 f.ack('removed'); await tick();
 expect(f.coordinator.status).toBe('paused');
});

it.each(['accepted', 'in flight'] as const)('serializes shutdown cleanup with %s PDF and preserves confirmed groups', async stage => {
 const beforeUpdate = vi.fn(async () => {});
 const foreign = { type: 'text', text: 'foreign' };
 const structuredContent = { keep: true };
 const f = setup({ updateId: 'foreign', content: [foreign], structuredContent }, true, undefined, { beforeUpdate });
 f.coordinator.publish(snapshot());
 f.coordinator.setAttachment({ id: 'saved', title: 'Saved', text: 'Saved note' });
 f.coordinator.setDocument(documentMember());
 await tick();
 if (stage === 'accepted') { f.ack('pdf'); await tick(); }
 f.coordinator.setAttachment({ id: 'queued', title: 'Queued', text: 'Queued note' });
 const stopping = f.coordinator.shutdown();
 if (stage === 'in flight') {
   await tick();
   expect(f.calls).toHaveLength(1);
   f.ack('pdf');
 }
 await tick();
 expect(f.calls).toHaveLength(2);
 expect(f.calls[1]).toEqual({ content: f.calls[0].content.filter((block: any) => block.resource?.mimeType !== 'application/pdf'), structuredContent });
 expect(beforeUpdate).toHaveBeenCalledOnce();
 f.ack('shutdown');
 await stopping;
 f.coordinator.publish(snapshot(2));
 await tick();
 expect(f.calls).toHaveLength(2);
});

it.each(['submitted PDF', 'cleanup'] as const)('bounds shutdown when the host never settles the %s', async stalled => {
 vi.useFakeTimers();
 try {
   const f = setup();
   f.coordinator.setDocument(documentMember());
   await tick();
   if (stalled === 'cleanup') { f.ack('pdf'); await tick(); }
   const stopping = f.coordinator.shutdown();
   await vi.runAllTimersAsync();
   await stopping;
   expect(f.calls).toHaveLength(stalled === 'cleanup' ? 2 : 1);
   f.ack('late');
   await tick();
   expect(f.calls).toHaveLength(stalled === 'cleanup' ? 2 : 1);
 } finally {
   vi.useRealTimers();
 }
});

it.each(['same-source', 'preparing', 'different-source'] as const)('honors a matching removal after the submitted PDF was superseded (%s)', async stage => {
 const observer = vi.fn();
 const f = setup(undefined, true, observer);
 f.coordinator.publish(snapshot());
 await tick(); f.ack('background'); await tick();
 const first = documentMember();
 f.coordinator.setDocument(first);
 await tick();
 f.coordinator.clearDocument();
 const next = { ...documentMember(2), sourceKey: stage === 'different-source' ? 'new-source' : first.sourceKey };
 if (stage !== 'preparing') f.coordinator.setDocument(next);

 f.coordinator.reconcile({ ...f.calls[0], updateId: 'first-removed' });
 f.ack('first-removed'); await tick();

 expect(observer).toHaveBeenLastCalledWith(first, 'removed');
 const remaining = pdfBlocks(f.calls.at(-1));
 if (stage === 'different-source') {
   expect(remaining).toHaveLength(1);
   expect(remaining[0].resource.blob).toBe(next.blob);
 } else expect(remaining).toEqual([]);
});
