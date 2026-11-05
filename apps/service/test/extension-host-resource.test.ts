import { PDFDocument } from 'pdf-lib';
import { createEmbedPdfWriter, readEditableReviewItems } from '../../../packages/pdf-backends/src/embedpdf-adapter.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionBroker } from '../src/sessions/session-broker.js';
import { ExtensionRuntimeManager } from '../src/codex/extension-runtime.js';
import { CodexServiceRuntimeBackend } from '../src/codex/codex-runtime-backend.js';
import { PdfSaveCoordinator } from '../src/saving/pdf-save-coordinator.js';
import { ExportCoordinator } from '../src/export/export-coordinator.js';
import { HostResourcePersistence } from '../src/codex/host-resource-persistence.js';
import { HOST_RESOURCE_CHUNK_BYTES } from '../../../packages/core/src/host-resource-protocol.js';
import { writePrivateFile } from '../src/platform/private-storage.js';
import { DraftSnapshotStore } from '../src/recovery/draft-snapshot.js';
import type { PdfWriter } from '../../../packages/core/src/pdf-writer.js';
import { addPageNote } from '../../../packages/core/src/review-commands.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: {writer?:PdfWriter;realVerification?:boolean} = {}) {
 const root=await mkdtemp(join(tmpdir(),'placekeeper-host-resource-'));
 const broker=new SessionBroker({recoveryRoot:join(root,'recovery'),portableReader:async()=>[],rewriteAssessor:async()=>({eligible:true}),browserSourceInspector:async()=>({rewriteEligibility:{eligible:true},importedItems:[]}),inspectGeneration:async()=>({pageCount:1,pages:[{pageIndex:0,text:'paper'}]})});
 const writer=options.writer??{write:async()=>{throw Error('unexpected local write');}};
 const saving=new PdfSaveCoordinator({broker,writer,...(options.realVerification?{}:{verify:async({annotations}:{annotations:readonly {id:string}[]})=>({pageCount:1,annotationIds:annotations.map(a=>a.id)})})});
 const backend=new CodexServiceRuntimeBackend({broker,saving,exporting:new ExportCoordinator({writer,capabilities:broker.capabilities})});
 const manager=new ExtensionRuntimeManager(broker,{backend});
 cleanups.push(async()=>{await manager.close();await saving.drain();await broker.quiesceForShutdown();await rm(root,{recursive:true,force:true});});
 return {root,broker,manager};
}
const bytes=Buffer.from('%PDF-1.7\nopaque fixture\n%%EOF');
async function upload(manager:ExtensionRuntimeManager, authority:{ticket:string}|{grant:string}, input=bytes, writable=false, etag='v1') {
 const sha256=createHash('sha256').update(input).digest('hex');
 const start:any=await manager.dispatch({action:'host-resource',operation:'begin',...authority,byteLength:input.length,sha256,writable,etag});
 expect(start.status).toBe('host-transfer');
 expect(await manager.dispatch({action:'host-resource',operation:'chunk',transfer:start.transfer,offset:0,dataBase64:input.toString('base64')})).toMatchObject({status:'host-transfer',offset:input.length});
 return manager.dispatch({action:'host-resource',operation:'finish',transfer:start.transfer});
}
it('admits opaque bytes into protected canonical review without paths or task bindings',async()=>{
 const f=await fixture();
 const admission:any=await f.manager.dispatch({action:'host-open',file:{name:'opaque.pdf',resourceUri:'host://not/a/path'}});
 expect(admission).toMatchObject({status:'host-resource',file:{resourceUri:'host://not/a/path'}});
 expect(admission.ticket).toEqual(expect.any(String));
 const opened:any=await upload(f.manager,{ticket:admission.ticket});
 expect(opened.status).toBe('provisional');
 const active:any=await f.manager.resume(opened.grant,randomUUID(),'activate');
 expect(active.status).toBe('active');
 const watermark:any=await f.manager.handle({protocolVersion:1,authority:'presentation',requestId:randomUUID(),runtimeId:active.presentation.runtimeId,attemptId:active.presentation.attemptId,generation:1,capability:active.presentation.presentationCapability,method:'watermark',payload:{}});
 expect(watermark.status).toBe('ok');
 const sessionId=watermark.payload.sessionId;
 await f.broker.acceptMutation(sessionId,addPageNote(f.broker.state(sessionId)!,0,{x:20,y:20,width:20,height:20},'protected'));
 const recovered=await new DraftSnapshotStore(join(f.root,'recovery',sessionId)).recover();
 expect(recovered?.state.items).toHaveLength(1);
 expect(recovered?.source.disposition).toBe('remote-temporary');
 expect(f.broker.taskBindings.activityCount()).toBe(0);
 expect(f.broker.credentials.pendingBootstrapCount()).toBe(0);
 expect(JSON.stringify(active)).not.toContain(f.root);
});
it('rejects empty, corrupt and oversized transfers before admission',async()=>{
 const f=await fixture(); const a:any=await f.manager.dispatch({action:'host-open',file:{name:'x.pdf',resourceUri:'opaque:x'}});
 for(const byteLength of [0,64*1024*1024+1]) expect(await f.manager.dispatch({action:'host-resource',operation:'begin',ticket:a.ticket,byteLength,sha256:'a'.repeat(64),writable:false})).toEqual({status:'unavailable'});
 const s:any=await f.manager.dispatch({action:'host-resource',operation:'begin',ticket:a.ticket,byteLength:bytes.length,sha256:'a'.repeat(64),writable:false});
 await f.manager.dispatch({action:'host-resource',operation:'chunk',transfer:s.transfer,offset:0,dataBase64:bytes.toString('base64')});
 expect(await f.manager.dispatch({action:'host-resource',operation:'finish',transfer:s.transfer})).toEqual({status:'unavailable'});
});

async function openHost(f:Awaited<ReturnType<typeof fixture>>,writable=false) {
 const descriptor:any=await f.manager.dispatch({action:'host-open',file:{name:'host.pdf',resourceUri:'opaque:fixture'}});
 const provisional:any=await upload(f.manager,{ticket:descriptor.ticket},bytes,writable);
 const active:any=await f.manager.resume(provisional.grant,randomUUID(),'activate');
 const call=(method:string,payload:unknown={},requestId=randomUUID())=>f.manager.handle({protocolVersion:1,authority:'presentation',requestId,runtimeId:active.presentation.runtimeId,attemptId:active.presentation.attemptId,generation:active.presentation.generation,capability:active.presentation.presentationCapability,method,payload});
 const watermark:any=await call('watermark');return {active,call,sessionId:watermark.payload.sessionId};
}
function writerFixture(){
 const write=vi.fn(async(request:any)=>{const pdfBytes=Buffer.from('%PDF-1.7\n'+JSON.stringify(request.annotations)+'\n%%EOF');return {pdfBytes,evidence:{backend:'embedpdf' as const,backendVersion:'test',originalSha256:request.sourceSha256,outputSha256:createHash('sha256').update(pdfBytes).digest('hex'),pageCount:1,structurallyValid:true,preexistingAnnotationIds:[],annotations:request.annotations.map((a:any)=>({id:a.id,subtype:'text',contents:a.contents,author:a.author,flags:['print'],hasNormalAppearance:true}))}};});return {write};
}
it('commits a host update as a successor generation while preserving predecessor bytes',async()=>{
 const f=await fixture(),h=await openHost(f);
 const source=f.broker.nativeAdmissionScope(h.sessionId)!.canonicalSourcePath;
 await f.broker.acceptMutation(h.sessionId,addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'retain me'));
 const updated=Buffer.from('%PDF-1.7\nsuccessor host PDF\n%%EOF');
 expect(await upload(f.manager,{grant:h.active.grant},updated)).toMatchObject({status:'host-ready',generation:2});
 expect(await readFile(source)).toEqual(bytes);
 expect(await f.broker.documentBytes(h.sessionId)).toEqual(updated);
 expect(f.broker.state(h.sessionId)!.items[0]?.payload.comment).toBe('retain me');
 expect(await h.call('watermark')).toMatchObject({status:'denied'});
 const resumed:any=await f.manager.resume(h.active.grant,randomUUID());expect(resumed.presentation.generation).toBe(2);
});
it('persists accepted command before acknowledgement and never creates a duplicate write for its retry',async()=>{
 const writer=writerFixture(),f=await fixture({writer}),h=await openHost(f,true);
 const command=addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'durable command'),id=randomUUID();
 const result:any=await h.call('command',command,id);expect(result.status).toBe('ok');
 expect((await new DraftSnapshotStore(join(f.root,'recovery',h.sessionId)).recover())?.state.items).toHaveLength(1);
 expect(await h.call('command',command,id)).toEqual(result);expect(f.broker.state(h.sessionId)!.revision).toBe(1);
 const saves:any[]=await Promise.all([f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant}),f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant})]);
 expect(saves[0].status).toBe('host-save');expect(saves[1]).toEqual({status:'host-status',outcome:'unknown'});expect(writer.write).toHaveBeenCalledOnce();
 const intent=saves[0].intent;const durable=JSON.parse(await readFile(join(f.root,'recovery',h.sessionId,'host-resource.json'),'utf8'));
 expect(durable.pending).toEqual(intent);expect(intent).toMatchObject({generation:1,revision:1,ifMatch:'v1',sourceDigest:createHash('sha256').update(bytes).digest('hex')});
 const receipt={action:'host-resource',operation:'receipt',grant:h.active.grant,intentId:intent.id,outcome:'saved',etag:'v2'};
 expect(await f.manager.dispatch(receipt)).toEqual({status:'host-status',outcome:'saved'});expect(await f.manager.dispatch(receipt)).toEqual({status:'host-status',outcome:'saved'});
 expect(f.broker.saveStatus(h.sessionId)).toMatchObject({destination:{phase:'host',writable:true},sync:{phase:'clean',savedRevision:1}});
 expect(await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant})).toEqual({status:'host-status',outcome:'saved'});
 expect(writer.write).toHaveBeenCalledOnce();
});
it('conflicts preserve canonical work and expose save failure at the same review revision',async()=>{
 const writer=writerFixture(),f=await fixture({writer}),h=await openHost(f,true);
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'conflicted'));
 const before:any=await h.call('watermark');const saved:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant});
 expect(await f.manager.dispatch({action:'host-resource',operation:'receipt',grant:h.active.grant,intentId:saved.intent.id,outcome:'conflict',etag:'new'})).toEqual({status:'host-status',outcome:'conflict'});
 const after:any=await h.call('watermark');expect(after.payload.reviewRevision).toBe(before.payload.reviewRevision);expect(after.payload.watermark).toBeGreaterThan(before.payload.watermark);
 expect(await h.call('saveStatus')).toMatchObject({status:'ok',payload:{destination:{phase:'host'},sync:{phase:'not-saved',failure:'host-conflict'}}});
 expect(f.broker.state(h.sessionId)?.items).toHaveLength(1);
});
it('unknown outcome rereads classify the exact saved bytes without another write',async()=>{
 const writer=writerFixture(),f=await fixture({writer}),h=await openHost(f,true);
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'uncertain'));
 const saved:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant});
 const output=await readFile(join(f.root,'recovery',h.sessionId,`host-save-${saved.intent.id}.pdf`));
 await f.manager.dispatch({action:'host-resource',operation:'receipt',grant:h.active.grant,intentId:saved.intent.id,outcome:'unknown'});
 expect(await upload(f.manager,{grant:h.active.grant},output,false,'v2')).toMatchObject({status:'host-ready',generation:1});
 expect(f.broker.saveStatus(h.sessionId)).toMatchObject({destination:{phase:'host',writable:false},sync:{phase:'clean'}});
 expect((await readdir(join(f.root,'recovery',h.sessionId))).filter(p=>p.startsWith('host-save-'))).toEqual([]);
 expect(writer.write).toHaveBeenCalledOnce();
});
it('a reread of unchanged host bytes retires an uncertain intent before a fresh conditional retry',async()=>{
 const writer=writerFixture(),f=await fixture({writer}),h=await openHost(f,true);
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'retry'));
 const first:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant});
 await upload(f.manager,{grant:h.active.grant},bytes,true,'new-etag');
 const second:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant});
 expect(second.intent.id).not.toBe(first.intent.id);expect(second.intent.ifMatch).toBe('new-etag');
 expect((await readdir(join(f.root,'recovery',h.sessionId))).filter(p=>p.startsWith('host-save-'))).toEqual([`host-save-${second.intent.id}.pdf`]);
});
it('read-only review offers explicit verified export without marking protected work as Saved',async()=>{
 const writer=writerFixture(),f=await fixture({writer}),h=await openHost(f);
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'export this'));
 expect(await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant})).toEqual({status:'host-status',outcome:'read-only'});
 expect(writer.write).not.toHaveBeenCalled();
 const exported:any=await f.manager.dispatch({action:'host-resource',operation:'export',grant:h.active.grant,expectedRevision:1,generation:1});
 expect(exported).toMatchObject({status:'host-save',intent:{purpose:'export',revision:1,ifMatch:''}});
 expect(f.broker.saveStatus(h.sessionId)?.sync).toMatchObject({phase:'not-saved',failure:'host-read-only'});
 expect(await f.manager.dispatch({action:'host-resource',operation:'receipt',grant:h.active.grant,intentId:exported.intent.id,outcome:'saved',etag:'fake'})).toEqual({status:'unavailable'});
});
it('opening a host URI in a second app offers an explicit read-only fork instead of sharing authority',async()=>{
 const f=await fixture(),h=await openHost(f,true);
 const descriptor:any=await f.manager.dispatch({action:'host-open',file:{name:'host.pdf',resourceUri:'opaque:fixture'}});
 const busy:any=await upload(f.manager,{ticket:descriptor.ticket},bytes,true);
 expect(busy).toMatchObject({status:'busy',canResume:false});expect(JSON.stringify(busy)).not.toContain(h.active.grant);
 const fork:any=await f.manager.choose({action:'choose',recoveryToken:busy.recoveryToken,choice:'fork',operationId:randomUUID()});
 expect(fork.status).toBe('provisional');
 const active:any=await f.manager.resume(fork.grant,randomUUID(),'activate');expect(active.status).toBe('active');
 expect(await f.manager.dispatch({action:'host-resource',operation:'save',grant:active.grant})).toEqual({status:'host-status',outcome:'read-only'});
 expect(await h.call('watermark')).toMatchObject({status:'ok'});
});

it('serializes and verifies a real reviewed PDF before issuing a conditional host save',async()=>{
 const writer=await createEmbedPdfWriter(),f=await fixture({writer,realVerification:true});
 const document=await PDFDocument.create();document.addPage([400,500]);const original=Buffer.from(await document.save());
 const descriptor:any=await f.manager.dispatch({action:'host-open',file:{name:'real.pdf',resourceUri:'opaque:real-pdf'}});
 const provisional:any=await upload(f.manager,{ticket:descriptor.ticket},original,true);
 const active:any=await f.manager.resume(provisional.grant,randomUUID(),'activate');
 const watermark:any=await f.manager.handle({protocolVersion:1,authority:'presentation',requestId:randomUUID(),runtimeId:active.presentation.runtimeId,attemptId:active.presentation.attemptId,generation:1,capability:active.presentation.presentationCapability,method:'watermark',payload:{}});
 const id=watermark.payload.sessionId;
 await f.broker.acceptMutation(id,addPageNote(f.broker.state(id)!,0,{x:20,y:20,width:20,height:20},'actual PDF annotation'));
 const saved:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:active.grant});expect(saved.status).toBe('host-save');
 const pdf=await readFile(join(f.root,'recovery',id,`host-save-${saved.intent.id}.pdf`));
 expect(createHash('sha256').update(pdf).digest('hex')).toBe(saved.intent.sha256);
 const annotations=await readEditableReviewItems(pdf);expect(annotations).toHaveLength(1);expect(JSON.stringify(annotations)).toContain('actual PDF annotation');
});
it('reopens protected host work after restart through an explicit recovery choice',async()=>{
 const f=await fixture(),h=await openHost(f);
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'survive restart'));
 const updated=Buffer.from('%PDF-1.7\nupdated before restart\n%%EOF');
 await upload(f.manager,{grant:h.active.grant},updated);
 expect((await new DraftSnapshotStore(join(f.root,'recovery',h.sessionId)).recover())?.source).toMatchObject({disposition:'remote-temporary'});
 await f.manager.close();await f.broker.quiesceForShutdown();
 expect((await new DraftSnapshotStore(join(f.root,'recovery',h.sessionId)).recover())?.state.workflow.documentGeneration).toBe(2);
 const broker=new SessionBroker({recoveryRoot:join(f.root,'recovery'),portableReader:async()=>[],rewriteAssessor:async()=>({eligible:true}),browserSourceInspector:async()=>({rewriteEligibility:{eligible:true},importedItems:[]}),inspectGeneration:async()=>({pageCount:1,pages:[{pageIndex:0,text:'paper'}]})});
 const writer=writerFixture(),saving=new PdfSaveCoordinator({broker,writer,verify:async({annotations})=>({pageCount:1,annotationIds:annotations.map(a=>a.id)})});
 const backend=new CodexServiceRuntimeBackend({broker,saving,exporting:new ExportCoordinator({writer,capabilities:broker.capabilities})});
 const manager=new ExtensionRuntimeManager(broker,{backend});
 cleanups.push(async()=>{await manager.close();await saving.drain();await broker.quiesceForShutdown();});
 const descriptor:any=await manager.dispatch({action:'host-open',file:{name:'host.pdf',resourceUri:'opaque:fixture'}});
 const offered:any=await upload(manager,{ticket:descriptor.ticket},updated);expect(offered).toMatchObject({status:'busy',canResume:true});
 const selected:any=await manager.choose({action:'choose',recoveryToken:offered.recoveryToken,choice:'resume',operationId:randomUUID()});expect(selected.status).toBe('provisional');
 expect(await upload(manager,{grant:selected.grant},updated)).toMatchObject({status:'host-ready',generation:2});
 const active:any=await manager.resume(selected.grant,randomUUID(),'activate');expect(active.status).toBe('active');
 expect(broker.state(h.sessionId)?.items[0]?.payload.comment).toBe('survive restart');expect(await broker.documentBytes(h.sessionId)).toEqual(updated);
});
it('fences in-progress transfers when their app grant rotates',async()=>{
 const f=await fixture(),h=await openHost(f);
 const started:any=await f.manager.dispatch({action:'host-resource',operation:'begin',grant:h.active.grant,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),writable:false});
 const resumed:any=await f.manager.resume(h.active.grant,randomUUID());expect(resumed.status).toBe('active');
 expect(await f.manager.dispatch({action:'host-resource',operation:'chunk',transfer:started.transfer,offset:0,dataBase64:bytes.toString('base64')})).toEqual({status:'unavailable'});
 expect(await f.manager.dispatch({action:'host-resource',operation:'finish',transfer:started.transfer})).toEqual({status:'unavailable'});
 expect(f.broker.state(h.sessionId)?.workflow.documentGeneration).toBe(1);
});
it('host grants cannot enter the local destination or filesystem-export routes',async()=>{
 const f=await fixture(),h=await openHost(f,true);
 for(const method of ['chooseOriginal','chooseFolder','retrySave','locateSave','exportReviewedCopy'])expect(await h.call(method)).toMatchObject({status:'denied'});
 expect(f.broker.saveStatus(h.sessionId)?.destination).toMatchObject({phase:'host'});
});
it('a receipt for older work cannot mark a newer semantic revision Saved even when its marks match',async()=>{
 const writer=writerFixture(),f=await fixture({writer}),h=await openHost(f,true);
 const command=addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'same marks');
 await h.call('command',command);
 const saved:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant});
 if(command.type!=='add')throw Error('Expected add command');
 expect(await h.call('command',{type:'remove',expectedRevision:1,id:command.item.id})).toMatchObject({status:'ok'});
 expect(await h.call('command',{...command,expectedRevision:2})).toMatchObject({status:'ok'});
 const output=await readFile(join(f.root,'recovery',h.sessionId,`host-save-${saved.intent.id}.pdf`));
 await f.manager.dispatch({action:'host-resource',operation:'receipt',grant:h.active.grant,intentId:saved.intent.id,outcome:'saved',etag:'v2'});
 expect(f.broker.saveStatus(h.sessionId)?.sync).toMatchObject({phase:'saving',desiredRevision:3,savedRevision:1});
 await upload(f.manager,{grant:h.active.grant},output,true,'v2');
 expect(f.broker.saveStatus(h.sessionId)?.sync).toMatchObject({phase:'saving',desiredRevision:3,savedRevision:1});
});


it.each(['pending', 'exported'] as const)('streams %s host-save bytes in bounded chunks with an exact final marker', async (slot) => {
 const f = await fixture(), h = await openHost(f, true);
 const persistence = new HostResourcePersistence(f.broker, { materializeImportedSave: vi.fn() });
 const directory = join(f.root, 'recovery', h.sessionId), statePath = join(directory, 'host-resource.json');
 const state = JSON.parse(await readFile(statePath, 'utf8'));
 const output = Buffer.alloc(HOST_RESOURCE_CHUNK_BYTES * 2 + 17, 0xa5);
 output.set(Buffer.from('final saved bytes'), output.length - 17);
 const intent = { id: 'bounded_chunk_intent', generation: 1, revision: 0, stateDigest: 'a'.repeat(64), sourceDigest: state.digest, sha256: createHash('sha256').update(output).digest('hex'), byteLength: output.length, ifMatch: slot === 'pending' ? 'v1' : '', purpose: slot === 'pending' ? 'save' : 'export' };
 await writePrivateFile(join(directory, `host-save-${intent.id}.pdf`), output);
 await writeFile(statePath, JSON.stringify({ ...state, [slot]: intent }));
 const allocations = vi.spyOn(Buffer, 'alloc');
 const received: Buffer[] = [];
 try {
  for (let offset = 0; offset < output.length; offset += HOST_RESOURCE_CHUNK_BYTES) {
   const result = await persistence.saveChunk(h.sessionId, intent.id, offset);
   if (result.status !== 'host-chunk') throw Error('Expected host chunk');
   const chunk = Buffer.from(result.dataBase64, 'base64');
   expect(chunk.length).toBe(Math.min(HOST_RESOURCE_CHUNK_BYTES, output.length - offset));
   expect(result.done).toBe(offset + chunk.length === output.length);
   received.push(chunk);
  }
  expect(allocations.mock.calls.every(([size]) => size <= HOST_RESOURCE_CHUNK_BYTES)).toBe(true);
  expect(Buffer.concat(received)).toEqual(output);
  await expect(persistence.saveChunk(h.sessionId, intent.id, output.length)).rejects.toThrow('Host intent unavailable');
 } finally { allocations.mockRestore(); }
});
