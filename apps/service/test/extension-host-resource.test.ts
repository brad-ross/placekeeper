import { PDFDocument } from 'pdf-lib';
import { createEmbedPdfWriter, readEditableReviewItems } from '../../../packages/pdf-backends/src/embedpdf-adapter.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile, realpath, mkdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionBroker } from '../src/sessions/session-broker.js';
import { ExtensionRuntimeManager } from '../src/codex/extension-runtime.js';
import { ExtensionRecentReviews } from '../src/codex/extension-recent-reviews.js';
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
async function fixture(options: {writer?:PdfWriter;realVerification?:boolean;now?:()=>number} = {}) {
 const root=await mkdtemp(join(tmpdir(),'placekeeper-host-resource-'));
 const broker=new SessionBroker({recoveryRoot:join(root,'recovery'),portableReader:async()=>[],rewriteAssessor:async()=>({eligible:true}),browserSourceInspector:async()=>({rewriteEligibility:{eligible:true},importedItems:[]}),inspectGeneration:async()=>({pageCount:1,pages:[{pageIndex:0,text:'paper'}]})});
 const writer=options.writer??{write:async()=>{throw Error('unexpected local write');}};
 const picker={chooseFolder:vi.fn(async ():Promise<string|undefined>=>root),locatePdf:vi.fn(async ():Promise<string|undefined>=>undefined)};
 const saving=new PdfSaveCoordinator({broker,writer,picker,...(options.realVerification?{}:{verify:async({annotations}:{annotations:readonly {id:string}[]})=>({pageCount:1,annotationIds:annotations.map(a=>a.id)})})});
 const exporting=new ExportCoordinator({writer,capabilities:broker.capabilities});
 const backend=new CodexServiceRuntimeBackend({broker,saving,exporting});
 const manager=new ExtensionRuntimeManager(broker,{backend,...(options.now?{now:options.now,panelLeaseMs:100,grantIdleMs:1000}:{})});
 cleanups.push(async()=>{await manager.close();await saving.drain();await broker.quiesceForShutdown();await rm(root,{recursive:true,force:true});});
 return {root,broker,manager,saving,picker,exporting};
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

async function openHost(f:Awaited<ReturnType<typeof fixture>>,writable=false,input=bytes,resourceUri='opaque:fixture') {
 const descriptor:any=await f.manager.dispatch({action:'host-open',file:{name:'host.pdf',resourceUri}});
 const provisional:any=await upload(f.manager,{ticket:descriptor.ticket},input,writable);
 const active:any=await f.manager.resume(provisional.grant,randomUUID(),'activate');
 const call=(method:string,payload:unknown={},requestId=randomUUID())=>f.manager.handle({protocolVersion:1,authority:'presentation',requestId,runtimeId:active.presentation.runtimeId,attemptId:active.presentation.attemptId,generation:active.presentation.generation,capability:active.presentation.presentationCapability,method,payload});
 const watermark:any=await call('watermark');return {active,call,sessionId:watermark.payload.sessionId};
}
function writerFixture(){
 const write=vi.fn(async(request:any)=>{const pdfBytes=Buffer.from('%PDF-1.7\n'+JSON.stringify(request.annotations)+'\n%%EOF');return {pdfBytes,evidence:{backend:'embedpdf' as const,backendVersion:'test',originalSha256:request.sourceSha256,outputSha256:createHash('sha256').update(pdfBytes).digest('hex'),pageCount:1,structurallyValid:true,preexistingAnnotationIds:[],annotations:request.annotations.map((a:any)=>({id:a.id,subtype:'text',contents:a.contents,author:a.author,flags:['print'],hasNormalAppearance:true}))}};});return {write};
}
it.each([false, true])('recovers disconnected host review with old authority retired (copy=%s)',async copy=>{
 let time=Date.now();const f=await fixture({writer:writerFixture(),now:()=>time}),h=await openHost(f,true);
 if(copy){const folder:any=await h.call('chooseFolder');await h.call('chooseCopy',{filename:'recover.pdf',folderSelectionId:folder.payload.selectionId});}
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'retained'));
 await f.saving.drain();
 const a:any=await f.manager.dispatch({action:'host-open',file:{name:'host.pdf',resourceUri:copy?'opaque:new-handle':'opaque:fixture'}});
 const pending=await upload(f.manager,{ticket:a.ticket},bytes,true);
 expect(pending).toMatchObject({status:'busy',canResume:false});
 expect(pending).not.toHaveProperty('canRecover');
 if(pending.status!=='busy')throw Error('Expected choice');
 time+=101;
 const offer=await f.manager.dispatch({action:'recheck',recoveryToken:pending.recoveryToken});
 expect(offer).toMatchObject({status:'busy',canResume:false,canRecover:true});
 if(offer.status!=='busy')throw Error('Expected refreshed choice');
 expect(offer.matchingCopy).toBe(copy?true:undefined);
 const chosen:any=await f.manager.dispatch({action:'choose',recoveryToken:offer.recoveryToken,choice:'recover',operationId:randomUUID()});
 expect(chosen.status).toBe('provisional');
 expect(await upload(f.manager,{grant:chosen.grant},bytes,true)).toMatchObject({status:'host-ready'});
 const recovered:any=await f.manager.resume(chosen.grant,randomUUID(),'activate');expect(recovered.status).toBe('active');
 expect(await f.manager.resume(h.active.grant,randomUUID())).toEqual({status:'unavailable'});
 expect(await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'stale'))).toMatchObject({status:'denied'});
 expect(f.broker.state(h.sessionId)?.items).toHaveLength(1);
 if(copy)expect(f.broker.saveStatus(h.sessionId)?.destination).toMatchObject({phase:'active',kind:'copy'});
});
it('resumes a recent host review through its retained host file after restart',async()=>{
 const f=await fixture({writer:writerFixture()}),h=await openHost(f);
 const folder:any=await h.call('chooseFolder');await h.call('chooseCopy',{filename:'recent-copy.pdf',folderSelectionId:folder.payload.selectionId});
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'recent protected'));
 await f.manager.dispatch({action:'reading-position',grant:h.active.grant,page:1});
 const list:any=await f.manager.dispatch({action:'recent-list'});expect(list.items).toHaveLength(1);expect(JSON.stringify(list)).not.toContain('opaque:fixture');
 await f.manager.close();await f.saving.drain();await f.broker.quiesceForShutdown();
 const broker=new SessionBroker({recoveryRoot:join(f.root,'recovery'),portableReader:async()=>[],rewriteAssessor:async()=>({eligible:true}),browserSourceInspector:async()=>({rewriteEligibility:{eligible:true},importedItems:[]}),inspectGeneration:async()=>({pageCount:1,pages:[{pageIndex:0,text:'paper'}]})});
 const writer=writerFixture(),saving=new PdfSaveCoordinator({broker,writer,verify:async({annotations})=>({pageCount:1,annotationIds:annotations.map(a=>a.id)})});
 const exporting=new ExportCoordinator({writer,capabilities:broker.capabilities});
 const manager=new ExtensionRuntimeManager(broker,{backend:new CodexServiceRuntimeBackend({broker,saving,exporting})});
 cleanups.push(async()=>{await manager.close();await saving.drain();await broker.quiesceForShutdown();});
 const offer:any=await manager.dispatch({action:'recent-open',id:list.items[0].id});expect(offer).toMatchObject({status:'busy',canResume:true});
 const selected:any=await manager.choose({action:'choose',recoveryToken:offer.recoveryToken,choice:'resume',operationId:randomUUID()});
 expect(selected).toMatchObject({status:'provisional',hostFile:{name:'host.pdf',resourceUri:'opaque:fixture'}});
 expect(await upload(manager,{grant:selected.grant})).toMatchObject({status:'host-ready'});
 const active:any=await manager.resume(selected.grant,randomUUID(),'activate');expect(active.status).toBe('active');
 expect(broker.state(h.sessionId)?.items[0]?.payload.comment).toBe('recent protected');
 expect(broker.saveStatus(h.sessionId)?.destination).toMatchObject({phase:'active',kind:'copy',targetPath:join(await realpath(f.root),'recent-copy.pdf')});
});
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
it.each([
 { copy: false, changedUri: false, changedCopy: false },
 { copy: true, changedUri: false, changedCopy: false },
 { copy: true, changedUri: true, changedCopy: false },
 { copy: true, changedUri: true, changedCopy: 'edited' },
 { copy: true, changedUri: true, changedCopy: 'redirected parent' },
])('reopens protected host work after restart (copy=$copy, changed URI=$changedUri, changed copy=$changedCopy)', async ({ copy, changedUri, changedCopy }) => {
 const f=await fixture({writer:writerFixture()}),h=await openHost(f);
 const copyFolder = join(f.root, 'copy-folder');
 const copyPath = join(copyFolder, 'restart-copy.pdf');
 if (copy) {
  await mkdir(copyFolder);
  f.picker.chooseFolder.mockResolvedValueOnce(copyFolder);
  const folder: any = await h.call('chooseFolder');
  expect(await h.call('chooseCopy', { filename: 'restart-copy.pdf', folderSelectionId: folder.payload.selectionId })).toMatchObject({ status: 'ok' });
 }
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'survive restart'));
 const updated=Buffer.from('%PDF-1.7\nupdated before restart\n%%EOF');
 await upload(f.manager,{grant:h.active.grant},updated);
 expect((await new DraftSnapshotStore(join(f.root,'recovery',h.sessionId)).recover())?.source).toMatchObject({disposition:'remote-temporary'});
 await f.manager.close();await f.saving.drain();await f.broker.quiesceForShutdown();
 let externalBytes: Buffer | undefined;
 if (changedCopy === 'edited') {
  externalBytes = Buffer.from('%PDF-1.7\nmodified externally while closed\n%%EOF');
  await writeFile(copyPath, externalBytes);
 } else if (changedCopy === 'redirected parent') {
  externalBytes = await readFile(copyPath);
  await rename(copyFolder, join(f.root, 'original-folder'));
  const otherFolder = join(f.root, 'other-folder');
  await mkdir(otherFolder);
  await writeFile(join(otherFolder, 'restart-copy.pdf'), externalBytes);
  await symlink(otherFolder, copyFolder, 'dir');
 }
 expect((await new DraftSnapshotStore(join(f.root,'recovery',h.sessionId)).recover())?.state.workflow.documentGeneration).toBe(2);
 const broker=new SessionBroker({recoveryRoot:join(f.root,'recovery'),portableReader:async()=>[],rewriteAssessor:async()=>({eligible:true}),browserSourceInspector:async()=>({rewriteEligibility:{eligible:true},importedItems:[]}),inspectGeneration:async()=>({pageCount:1,pages:[{pageIndex:0,text:'paper'}]})});
 const writer=writerFixture(),saving=new PdfSaveCoordinator({broker,writer,verify:async({annotations})=>({pageCount:1,annotationIds:annotations.map(a=>a.id)})});
 const exporting=new ExportCoordinator({writer,capabilities:broker.capabilities});
 const backend=new CodexServiceRuntimeBackend({broker,saving,exporting});
 const manager=new ExtensionRuntimeManager(broker,{backend});
 cleanups.push(async()=>{await manager.close();await saving.drain();await broker.quiesceForShutdown();});
 const descriptor:any=await manager.dispatch({action:'host-open',file:{name:'host.pdf',resourceUri:changedUri?'opaque:replacement-uri':'opaque:fixture'}});
 const offered:any=await upload(manager,{ticket:descriptor.ticket},updated);expect(offered).toMatchObject({status:'busy',canResume:true,...(changedUri?{matchingCopy:true}:{})});
 const selected:any=await manager.choose({action:'choose',recoveryToken:offered.recoveryToken,choice:'resume',operationId:randomUUID()});expect(selected.status).toBe('provisional');
 expect(await upload(manager,{grant:selected.grant},updated)).toMatchObject({status:'host-ready',generation:2});
 const active:any=await manager.resume(selected.grant,randomUUID(),'activate');expect(active.status).toBe('active');
 expect(broker.state(h.sessionId)?.items[0]?.payload.comment).toBe('survive restart');expect(await broker.documentBytes(h.sessionId)).toEqual(updated);
 if (copy) {
  const call = (method: string, payload: unknown = {}) => manager.handle({
   protocolVersion: 1, authority: 'presentation', requestId: randomUUID(),
   runtimeId: active.presentation.runtimeId, attemptId: active.presentation.attemptId,
   generation: active.presentation.generation, capability: active.presentation.presentationCapability, method, payload,
  });
  expect(broker.saveStatus(h.sessionId)?.destination).toMatchObject({ phase: 'active', targetPath: join(await realpath(f.root), 'copy-folder', 'restart-copy.pdf') });
  const changedStatus = { status: 'ok', payload: { sync: { phase: 'not-saved', failure: 'target-changed' } } };
  if (changedCopy) {
   expect(broker.saveStatus(h.sessionId)?.destination).not.toHaveProperty('capabilityId');
   expect(await call('saveStatus')).toMatchObject(changedStatus);
  }
  expect(await call('command', addPageNote(broker.state(h.sessionId)!, 0, { x: 20, y: 20, width: 20, height: 20 }, 'after restart'))).toMatchObject({ status: 'ok' });
  await saving.drain();
  if (changedCopy) {
   expect(await call('saveStatus')).toMatchObject(changedStatus);
   expect(await call('retrySave')).toMatchObject(changedStatus);
   expect(await readFile(copyPath)).toEqual(externalBytes);
   const durable = await new DraftSnapshotStore(join(f.root, 'recovery', h.sessionId)).recover();
   expect(durable?.state.items.map(item => item.payload.comment)).toEqual(['survive restart', 'after restart']);
  } else {
   expect((await readFile(copyPath)).toString()).toContain('after restart');
  }
 }
});
async function saveHostCopy(
 f: Awaited<ReturnType<typeof fixture>>,
 host: Awaited<ReturnType<typeof openHost>>,
 filename: string,
 comment: string,
) {
 const folder: any = await host.call('chooseFolder');
 expect(await host.call('chooseCopy', { filename, folderSelectionId: folder.payload.selectionId })).toMatchObject({ status: 'ok' });
 expect(await host.call('command', addPageNote(f.broker.state(host.sessionId)!, 0, { x: 20, y: 20, width: 20, height: 20 }, comment))).toMatchObject({ status: 'ok' });
 await f.saving.drain();
}

it('keeps ignored matching host files out of the original recent identity and uses the selected file for a fork', async () => {
 const f = await fixture({ writer: writerFixture() }), original = await openHost(f, true);
 await saveHostCopy(f, original, 'identity-copy.pdf', 'retained');
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:other' } });
 const ignored: any = await upload(f.manager, { ticket: descriptor.ticket }, bytes, true);
 expect(ignored).toMatchObject({ status: 'busy', matchingCopy: true });
 const resumed: any = await f.manager.resume(original.active.grant, randomUUID());
 expect(resumed.status).toBe('active');
 const list: any = await f.manager.dispatch({ action: 'recent-list' });
 await f.manager.revoke(resumed.grant);
 const recent: any = await f.manager.dispatch({ action: 'recent-open', id: list.items[0].id });
 const chosen: any = await f.manager.choose({ action: 'choose', recoveryToken: recent.recoveryToken, choice: 'resume', operationId: randomUUID() });
 expect(chosen).toMatchObject({ status: 'provisional', hostFile: { resourceUri: 'opaque:fixture' } });
 expect(await upload(f.manager, { grant: chosen.grant }, bytes, true)).toMatchObject({ status: 'host-ready' });
 expect((await f.manager.resume(chosen.grant, randomUUID(), 'activate')).status).toBe('active');
 const fork: any = await f.manager.choose({ action: 'choose', recoveryToken: ignored.recoveryToken, choice: 'fork', operationId: randomUUID() });
 expect(fork).toMatchObject({ status: 'provisional', hostFile: { resourceUri: 'opaque:other' } });
});

it('keeps admitted host identity when a stale recent entry is opened after an index write failure', async () => {
 const f = await fixture({ writer: writerFixture() }), original = await openHost(f, true);
 await saveHostCopy(f, original, 'identity-copy.pdf', 'retained');
 const list: any = await f.manager.dispatch({ action: 'recent-list' });
 await f.manager.revoke(original.active.grant);
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:adopted' } });
 const offered: any = await upload(f.manager, { ticket: descriptor.ticket }, bytes, true);
 const chosen: any = await f.manager.choose({ action: 'choose', recoveryToken: offered.recoveryToken, choice: 'resume', operationId: randomUUID() });
 expect(await upload(f.manager, { grant: chosen.grant }, bytes, true)).toMatchObject({ status: 'host-ready' });
 const remember = vi.spyOn(ExtensionRecentReviews.prototype, 'remember').mockRejectedValueOnce(Error('Index write unavailable'));
 let admitted: any;
 try { admitted = await f.manager.resume(chosen.grant, randomUUID(), 'activate'); }
 finally { remember.mockRestore(); }
 expect(admitted.status).toBe('active');
 expect((await f.manager.dispatch({ action: 'recent-open', id: list.items[0].id })).status).toBe('busy');
 const reconnected: any = await f.manager.resume(admitted.grant, randomUUID());
 expect(reconnected.status).toBe('active');
 await f.manager.revoke(reconnected.grant);
 const recent: any = await f.manager.dispatch({ action: 'recent-open', id: list.items[0].id });
 const selected: any = await f.manager.choose({ action: 'choose', recoveryToken: recent.recoveryToken, choice: 'resume', operationId: randomUUID() });
 expect(selected).toMatchObject({ status: 'provisional', hostFile: { resourceUri: 'opaque:adopted' } });
});

it('offers an explicit saved-copy choice after a new opaque URI and respects existing app ownership', async () => {
 const f = await fixture({ writer: writerFixture() });
 const original = await openHost(f, true);
 await saveHostCopy(f, original, 'local-review.pdf', 'before closing');
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:second' } });
 const busy: any = await upload(f.manager, { ticket: descriptor.ticket }, bytes, true);
 expect(busy).toEqual({ status: 'busy', canResume: false, recoveryToken: expect.any(String), matchingCopy: true });
 const choose = (offer: { recoveryToken: string }) => f.manager.choose({ action: 'choose', recoveryToken: offer.recoveryToken, choice: 'resume', operationId: randomUUID() });
 expect(await choose(busy)).toEqual({ status: 'unavailable' });
 expect(await original.call('watermark')).toMatchObject({ status: 'ok' });
 const priorExport: any = await f.manager.dispatch({ action: 'host-resource', operation: 'export', grant: original.active.grant, expectedRevision: f.broker.state(original.sessionId)!.revision, generation: 1 });
 expect(priorExport).toMatchObject({ status: 'host-save', intent: { purpose: 'export' } });

 expect(await f.manager.revoke(original.active.grant)).toBe(true);
 expect(await original.call('watermark')).toMatchObject({ status: 'denied' });
 const offered: any = await upload(f.manager, { ticket: descriptor.ticket }, bytes, true);
 expect(offered).toEqual({ status: 'busy', canResume: true, recoveryToken: expect.any(String), matchingCopy: true });
 const provisional: any = await choose(offered);
 expect(provisional).toMatchObject({ status: 'provisional' });
 expect(await f.manager.resume(provisional.grant, randomUUID(), 'activate')).toEqual({ status: 'unavailable' });
 expect(await f.manager.dispatch({ action: 'host-resource', operation: 'export', grant: provisional.grant, expectedRevision: f.broker.state(original.sessionId)!.revision, generation: 1 })).toEqual({ status: 'unavailable' });
 expect(await f.manager.dispatch({ action: 'host-resource', operation: 'save-chunk', grant: provisional.grant, intentId: priorExport.intent.id, offset: 0 })).toEqual({ status: 'unavailable' });
 const started: any = await f.manager.dispatch({ action: 'host-resource', operation: 'begin', grant: provisional.grant, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), writable: true, etag: 'v1' });
 expect(started.status).toBe('host-transfer');
 expect(await f.manager.dispatch({ action: 'host-resource', operation: 'chunk', transfer: started.transfer, offset: 0, dataBase64: bytes.toString('base64') })).toMatchObject({ status: 'host-transfer', offset: bytes.length });
 expect(await f.manager.resume(provisional.grant, randomUUID(), 'activate')).toEqual({ status: 'unavailable' });
 expect(await f.manager.dispatch({ action: 'host-resource', operation: 'finish', transfer: started.transfer })).toMatchObject({ status: 'host-ready', generation: 1 });
 const active: any = await f.manager.resume(provisional.grant, randomUUID(), 'activate');
 expect(active.status).toBe('active');
 expect(f.broker.state(original.sessionId)?.items[0]?.payload.comment).toBe('before closing');
 expect(await f.manager.dispatch({ action: 'host-resource', operation: 'save', grant: active.grant })).toEqual({ status: 'host-status', outcome: 'local-copy' });
 expect(await f.manager.handle({ protocolVersion: 1, authority: 'presentation', requestId: randomUUID(), runtimeId: active.presentation.runtimeId, attemptId: active.presentation.attemptId, generation: active.presentation.generation, capability: active.presentation.presentationCapability, method: 'command', payload: addPageNote(f.broker.state(original.sessionId)!, 0, { x: 20, y: 20, width: 20, height: 20 }, 'after reopening') })).toMatchObject({ status: 'ok' });
 await f.saving.drain();
 expect((await readFile(join(f.root, 'local-review.pdf'))).toString()).toContain('after reopening');
 const durable = await new DraftSnapshotStore(join(f.root, 'recovery', original.sessionId)).recover();
 expect(durable?.source).toMatchObject({ sourceIdentity: createHash('sha256').update('opaque:second').digest('hex') });
 await f.manager.revoke(active.grant);
 const changed = Buffer.from('%PDF-1.7\nchanged while closed\n%%EOF');
 const exact: any = await upload(f.manager, { ticket: descriptor.ticket }, changed, true);
 expect(exact).toEqual({ status: 'busy', canResume: true, recoveryToken: expect.any(String) });
 const exactChoice: any = await choose(exact);
 expect(exactChoice.status).toBe('provisional');
 expect(await upload(f.manager, { grant: exactChoice.grant }, changed, true)).toMatchObject({ status: 'host-ready', generation: 2 });
 expect(await f.manager.resume(exactChoice.grant, randomUUID(), 'activate')).toMatchObject({ status: 'active' });
 expect(f.broker.state(original.sessionId)?.items.map(item => item.payload.comment)).toContain('after reopening');
});

it('retires a recovery grant and reopens the selected host PDF when its reread differs', async () => {
 const f = await fixture({ writer: writerFixture() });
 const original = await openHost(f);
 await saveHostCopy(f, original, 'local-review.pdf', 'private prior work');
 await f.manager.revoke(original.active.grant);
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:changed' } });
 const offered: any = await upload(f.manager, { ticket: descriptor.ticket });
 const choice = { action: 'choose', choice: 'resume', recoveryToken: offered.recoveryToken, operationId: randomUUID() } as const;
 const provisional: any = await f.manager.choose(choice);
 expect(provisional.status).toBe('provisional');
 const changed = Buffer.from('%PDF-1.7\nchanged during recovery\n%%EOF');
 const replacement: any = await f.manager.dispatch({ action: 'host-resource', operation: 'begin', grant: provisional.grant, byteLength: changed.length, sha256: createHash('sha256').update(changed).digest('hex'), writable: false });
 expect(replacement).toEqual({ status: 'host-resource', ticket: expect.any(String), file: descriptor.file });
 expect(await f.manager.resume(provisional.grant, randomUUID(), 'activate')).toEqual({ status: 'unavailable' });
 expect(await f.manager.choose(choice)).toEqual(replacement);
 const independent: any = await upload(f.manager, { ticket: replacement.ticket }, changed);
 expect(independent.status).toBe('provisional');
 expect(f.broker.state(original.sessionId)?.items[0]?.payload.comment).toBe('private prior work');
});

it('does not adopt an opaque URI acquired by another review after the recovery offer', async () => {
 const f = await fixture({ writer: writerFixture() });
 const original = await openHost(f);
 await saveHostCopy(f, original, 'local-review.pdf', 'private prior work');
 await f.manager.revoke(original.active.grant);
 const resourceUri = 'opaque:claimed';
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri } });
 const offered: any = await upload(f.manager, { ticket: descriptor.ticket });
 const provisional: any = await f.manager.choose({ action: 'choose', choice: 'resume', recoveryToken: offered.recoveryToken, operationId: randomUUID() });
 expect(provisional.status).toBe('provisional');
 const differentBytes = Buffer.from('%PDF-1.7\nindependently acquired\n%%EOF');
 const other = await openHost(f, false, differentBytes, resourceUri);
 expect(other.sessionId).not.toBe(original.sessionId);
 expect(await upload(f.manager, { grant: provisional.grant })).toMatchObject({ status: 'host-ready', generation: 1 });
 expect(await f.manager.resume(provisional.grant, randomUUID(), 'activate')).toEqual({ status: 'unavailable' });
 expect(await other.call('watermark')).toMatchObject({ status: 'ok' });
});

it('does not select one saved-copy review when another matching sidecar cannot be read', async () => {
 const f = await fixture({ writer: writerFixture() });
 const first = await openHost(f);
 const second = await openHost(f, false, bytes, 'opaque:unreadable');
 await saveHostCopy(f, first, 'first.pdf', 'first private review');
 await saveHostCopy(f, second, 'second.pdf', 'second private review');
 await f.manager.revoke(first.active.grant);
 await f.manager.revoke(second.active.grant);
 await writeFile(join(f.root, 'recovery', second.sessionId, 'host-resource.json'), '{invalid JSON');
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:third' } });
 expect(await upload(f.manager, { ticket: descriptor.ticket })).toEqual({ status: 'unavailable' });
});

it('opens independently when byte-identical names match multiple saved-copy reviews', async () => {
 const f = await fixture({ writer: writerFixture() });
 const first = await openHost(f);
 const second = await openHost(f, false, bytes, 'opaque:another');
 await saveHostCopy(f, first, 'first.pdf', 'first private review');
 await saveHostCopy(f, second, 'second.pdf', 'second private review');
 await f.manager.revoke(first.active.grant);
 await f.manager.revoke(second.active.grant);
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:third' } });
 const independent: any = await upload(f.manager, { ticket: descriptor.ticket });
 expect(independent).toEqual({ status: 'provisional', grant: expect.any(String) });
 const active: any = await f.manager.resume(independent.grant, randomUUID(), 'activate');
 const watermark: any = await f.manager.handle({ protocolVersion: 1, authority: 'presentation', requestId: randomUUID(), runtimeId: active.presentation.runtimeId, attemptId: active.presentation.attemptId, generation: 1, capability: active.presentation.presentationCapability, method: 'watermark', payload: {} });
 expect(watermark.payload.sessionId).not.toBe(first.sessionId);
 expect(watermark.payload.sessionId).not.toBe(second.sessionId);
 expect(f.broker.state(watermark.payload.sessionId)?.items).toEqual([]);
});

it('does not readmit a live saved-copy destination changed after the recovery choice was offered', async () => {
 const f = await fixture({ writer: writerFixture() });
 const original = await openHost(f);
 await saveHostCopy(f, original, 'stale.pdf', 'prior work');
 await f.manager.revoke(original.active.grant);
 const descriptor: any = await f.manager.dispatch({ action: 'host-open', file: { name: 'host.pdf', resourceUri: 'opaque:changed-target' } });
 const offered: any = await upload(f.manager, { ticket: descriptor.ticket });
 expect(offered).toMatchObject({ status: 'busy', canResume: true, matchingCopy: true });
 await writeFile(join(f.root, 'stale.pdf'), 'modified externally');
 expect(await f.manager.choose({ action: 'choose', recoveryToken: offered.recoveryToken, choice: 'resume', operationId: randomUUID() })).toEqual({ status: 'unavailable' });
 expect(await readFile(join(f.root, 'stale.pdf'), 'utf8')).toBe('modified externally');
 expect(f.broker.state(original.sessionId)?.items[0]?.payload.comment).toBe('prior work');
});

it('fences in-progress transfers when their app grant rotates',async()=>{
 const f=await fixture(),h=await openHost(f);
 const started:any=await f.manager.dispatch({action:'host-resource',operation:'begin',grant:h.active.grant,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),writable:false});
 const resumed:any=await f.manager.resume(h.active.grant,randomUUID());expect(resumed.status).toBe('active');
 expect(await f.manager.dispatch({action:'host-resource',operation:'chunk',transfer:started.transfer,offset:0,dataBase64:bytes.toString('base64')})).toEqual({status:'unavailable'});
 expect(await f.manager.dispatch({action:'host-resource',operation:'finish',transfer:started.transfer})).toEqual({status:'unavailable'});
 expect(f.broker.state(h.sessionId)?.workflow.documentGeneration).toBe(1);
});
it('host grants cannot overwrite private sources or use filesystem export without a chosen copy',async()=>{
 const f=await fixture(),h=await openHost(f,true);
 for(const method of ['chooseOriginal','retrySave','locateSave','exportReviewedCopy'])expect(await h.call(method)).toMatchObject({status:'denied'});
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


it.each([false, true])('autosaves opaque PDFs to a chosen local copy and preserves that destination on refresh (writable=%s)', async writable => {
 const document=await PDFDocument.create();document.addPage([400,500]);const original=Buffer.from(await document.save());
 const writer=await createEmbedPdfWriter(),f=await fixture({writer,realVerification:true}),h=await openHost(f,writable,original);
 const source=f.broker.nativeAdmissionScope(h.sessionId)!.canonicalSourcePath;
 expect(await h.call('saveProposal')).toMatchObject({status:'ok',payload:{sourceDisposition:'remote-temporary',filename:'host-annotated.pdf'}});
 f.picker.chooseFolder.mockResolvedValueOnce(undefined);
 expect(await h.call('chooseFolder')).toMatchObject({status:'ok',payload:{cancelled:true}});
 expect(f.broker.saveStatus(h.sessionId)?.destination.phase).toBe('host');
 expect(await h.call('chooseCopy',{filename:'copy.pdf'})).toMatchObject({status:'denied'});
 const folder:any=await h.call('chooseFolder');
 expect(folder).toMatchObject({status:'ok',payload:{cancelled:false,folder:'Local folder'}});
 expect(await h.call('chooseCopy',{filename:'copy.pdf',folderSelectionId:folder.payload.selectionId})).toMatchObject({status:'ok',payload:{destination:{phase:'active',kind:'copy'}}});
 const genericExport=vi.spyOn(f.exporting,'exportReviewedCopy');
 expect(await h.call('exportReviewedCopy',{fence:{expectedRevision:f.broker.state(h.sessionId)!.revision,documentGeneration:1}})).toMatchObject({status:'denied'});
 expect(genericExport).not.toHaveBeenCalled();
 for(const comment of ['first copy note','second copy note']) {
  expect(await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},comment))).toMatchObject({status:'ok'});
  await f.saving.drain();
  expect(JSON.stringify(await readEditableReviewItems(await readFile(join(f.root,'copy.pdf'))))).toContain(comment);
  expect(f.broker.saveStatus(h.sessionId)?.sync.phase).toBe('clean');
  expect(await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant})).not.toHaveProperty('intent');
 }
 expect(await readFile(source)).toEqual(original);
 expect(await upload(f.manager,{grant:h.active.grant},original,writable)).toMatchObject({status:'host-ready'});
 expect(f.broker.saveStatus(h.sessionId)?.destination).toMatchObject({phase:'active',targetPath:await realpath(join(f.root,'copy.pdf'))});
 const durable=await new DraftSnapshotStore(join(f.root,'recovery',h.sessionId)).recover();
 expect(durable?.destination).toMatchObject({phase:'active',targetPath:await realpath(join(f.root,'copy.pdf'))});
 expect(durable?.state.items).toHaveLength(2);
 document.setTitle('changed original');const successor=Buffer.from(await document.save());
 expect(await upload(f.manager,{grant:h.active.grant},successor,writable)).toMatchObject({status:'host-ready',generation:2});
 expect(f.broker.saveStatus(h.sessionId)?.destination).toMatchObject({phase:'active',targetPath:await realpath(join(f.root,'copy.pdf'))});
 await f.saving.drain();
 expect(JSON.stringify(await readEditableReviewItems(await readFile(join(f.root,'copy.pdf'))))).toContain('second copy note');
});

it('a retired host write cannot mark a local copy saved or restore its host destination',async()=>{
 const f=await fixture({writer:writerFixture()}),h=await openHost(f,true);
 await h.call('command',addPageNote(f.broker.state(h.sessionId)!,0,{x:20,y:20,width:20,height:20},'keep this'));
 const saved:any=await f.manager.dispatch({action:'host-resource',operation:'save',grant:h.active.grant});
 const folder:any=await h.call('chooseFolder');
 expect(folder.status).toBe('ok');
 expect(await h.call('chooseCopy',{filename:'copy.pdf',folderSelectionId:folder.payload.selectionId})).toMatchObject({status:'ok'});
 await f.saving.drain();
 const before=f.broker.saveStatus(h.sessionId);
 expect(await f.manager.dispatch({action:'host-resource',operation:'receipt',grant:h.active.grant,intentId:saved.intent.id,outcome:'saved',etag:'late'})).toMatchObject({status:'unavailable'});
 expect(await f.manager.dispatch({action:'host-resource',operation:'save-chunk',grant:h.active.grant,intentId:saved.intent.id,offset:0})).toMatchObject({status:'unavailable'});
 await f.broker.configureImportedDestination(h.sessionId,true);
 expect(f.broker.saveStatus(h.sessionId)).toEqual(before);
 expect(await upload(f.manager,{grant:h.active.grant},bytes,true)).toMatchObject({status:'host-ready'});
 expect(f.broker.saveStatus(h.sessionId)).toEqual(before);
});
