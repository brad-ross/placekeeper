import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HostResourceAdapter } from '../src/host-resource-adapter.js';
const ticket='t'.repeat(43),grant='g'.repeat(43),transfer='x'.repeat(43);
const pdf=Buffer.from('%PDF-1.7\nhost fixture\n%%EOF');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function fixture(){
 let notify:(event:any)=>void=()=>{};let readBytes:Buffer=pdf;
 const resources={read:vi.fn(async()=>({contents:[{uri:'opaque:x',blob:readBytes.toString('base64'),openaiMetadata:{writable:true,etag:'etag-1'}}]})),subscribe:vi.fn(async()=>({})),unsubscribe:vi.fn(async()=>({})),addUpdateHandler:vi.fn((handler:any)=>{notify=handler;return vi.fn();}),write:vi.fn(async()=>({outcome:'saved',etag:'etag-2'}))};
 let finished=0;
 const requests:any[]=[];
 const request=vi.fn(async(r:any):Promise<any>=>{requests.push(r);if(r.operation==='begin')return {status:'host-transfer',transfer,offset:0};if(r.operation==='chunk')return {status:'host-transfer',transfer,offset:Buffer.from(r.dataBase64,'base64').length+r.offset};if(r.operation==='finish')return ++finished===1?{status:'provisional',grant}:{status:'host-ready',generation:1};if(r.operation==='save')return {status:'host-save',intent:{id:'i'.repeat(43),generation:1,revision:1,stateDigest:'a'.repeat(64),sourceDigest:sha(pdf),sha256:sha(pdf),byteLength:pdf.length,ifMatch:'etag-1',purpose:'save'}};if(r.operation==='save-chunk')return {status:'host-chunk',dataBase64:pdf.toString('base64'),done:true};return {status:'host-status',outcome:'saved'};});
 const changed=vi.fn();const adapter=new HostResourceAdapter({resources:()=>resources as any,request:request as any,current:()=>true,onUpdate:changed,digest:async b=>sha(b)});
 return {adapter,resources,request,requests,changed,notify:()=>notify({params:{uri:'opaque:x'}}),setBytes:(bytes:Buffer)=>{readBytes=bytes;}};
}
it('reads opaque host resources and imports exact bounded chunks without a filesystem path',async()=>{
 const f=fixture();expect(await f.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}})).toEqual({status:'provisional',grant});
 expect(f.resources.read).toHaveBeenCalledWith({uri:'opaque:x',representation:'blob'},{signal:expect.any(AbortSignal)});
 expect(f.requests[0]).toMatchObject({operation:'begin',ticket,sha256:sha(pdf),byteLength:pdf.length,writable:true,etag:'etag-1'});
 expect(Buffer.from(f.requests[1].dataBase64,'base64')).toEqual(pdf);
 f.notify();expect(f.changed).toHaveBeenCalledOnce();await f.adapter.dispose();
});
it('does not admit a canceled or empty host read',async()=>{
 const f=fixture();let resolve!:(v:any)=>void;f.resources.read.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const opening=f.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 await Promise.resolve();await f.adapter.dispose();resolve({contents:[{uri:'opaque:x',blob:pdf.toString('base64')}]});await expect(opening).rejects.toThrow();expect(f.requests).toEqual([]);
 const empty=fixture();empty.setBytes(Buffer.alloc(0));await expect(empty.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}})).rejects.toThrow();expect(empty.requests).toEqual([]);
});
it('writes only exact verified service intent bytes with the required ETag',async()=>{
 const f=fixture();await f.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 expect(await f.adapter.save(grant)).toMatchObject({status:'host-status',outcome:'saved'});
 expect(f.resources.write).toHaveBeenCalledWith('opaque:x',{blob:pdf.toString('base64'),ifMatch:'etag-1'});
 expect(f.requests.at(-1)).toMatchObject({operation:'receipt',intentId:'i'.repeat(43),outcome:'saved',etag:'etag-2'});
});
it('reports conflicts and rereads unknown writes without repeating them',async()=>{
 const f=fixture();await f.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 f.resources.write.mockResolvedValueOnce({outcome:'conflict',etag:'new'} as any);
 await f.adapter.save(grant);expect(f.requests.at(-1)).toMatchObject({operation:'receipt',outcome:'conflict',etag:'new'});
 f.resources.write.mockRejectedValueOnce(Error('lost response'));await f.adapter.save(grant);
 expect(f.requests.some(r=>r.operation==='receipt'&&r.outcome==='unknown')).toBe(true);
 expect(f.resources.read).toHaveBeenCalledTimes(2);expect(f.resources.write).toHaveBeenCalledTimes(2);
});
it('cleans up a subscription that arrives after disposal',async()=>{
 const f=fixture();let resolve!:(value:any)=>void;f.resources.subscribe.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const opening=f.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 await vi.waitFor(()=>expect(f.resources.subscribe).toHaveBeenCalledOnce());
 await f.adapter.dispose();resolve({});await expect(opening).rejects.toThrow();expect(f.resources.unsubscribe).toHaveBeenCalledWith({uri:'opaque:x'});
});
it('exports a verified reviewed copy explicitly without writing to the host or acknowledging Saved',async()=>{
 const f=fixture(),downloadFile=vi.fn(async()=>({}));
 const adapter=new HostResourceAdapter({resources:()=>f.resources as any,request:async(r:any)=>{
  if(r.operation==='export')return {status:'host-save',intent:{id:'e'.repeat(43),purpose:'export',generation:1,revision:2,sourceDigest:sha(pdf),stateDigest:'a'.repeat(64),sha256:sha(pdf),byteLength:pdf.length,ifMatch:''}};
  return f.request(r) as any;
 },current:()=>true,onUpdate:()=>{},digest:async b=>sha(b),downloadFile});
 await adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 expect(await adapter.export(grant,{expectedRevision:2,documentGeneration:1})).toMatchObject({kind:'reviewed-copy',revision:2,path:'x-reviewed.pdf'});
 expect(downloadFile).toHaveBeenCalledWith({contents:[{type:"resource",resource:{uri:"file:///x-reviewed.pdf",mimeType:"application/pdf",blob:pdf.toString("base64")}}]},expect.objectContaining({timeout:300000}));expect(f.resources.write).not.toHaveBeenCalled();expect(f.requests.some(r=>r.operation==='receipt')).toBe(false);
 await adapter.dispose();
});
it('rejects a malformed grant refresh result instead of accepting a stale source',async()=>{
 const f=fixture();await f.adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 f.request.mockResolvedValueOnce({status:'host-transfer',transfer,offset:0}).mockResolvedValueOnce({status:'host-transfer',transfer,offset:pdf.length}).mockResolvedValueOnce({status:'chooser'});
 await expect(f.adapter.refresh(grant)).rejects.toThrow('invalid source admission result');
 await f.adapter.dispose();
});

it.each(['denied', 'failed', 'unavailable'])('does not report a reviewed copy when the host download is %s',async(outcome)=>{
 const f=fixture();
 const adapter=new HostResourceAdapter({resources:()=>f.resources as any,request:async(r:any)=>{
  if(r.operation==='export')return {status:'host-save',intent:{id:'e'.repeat(43),purpose:'export',generation:1,revision:2,sourceDigest:sha(pdf),stateDigest:'a'.repeat(64),sha256:sha(pdf),byteLength:pdf.length,ifMatch:''}};
  return f.request(r) as any;
 },current:()=>true,onUpdate:()=>{},digest:async b=>sha(b),...(outcome==='unavailable'?{}:{downloadFile:async()=>{if(outcome==='failed')throw Error('download failed');return {isError:true};}})});
 await adapter.open({status:'host-resource',ticket,file:{name:'x.pdf',resourceUri:'opaque:x'}});
 if(outcome==='denied')await expect(adapter.export(grant,{expectedRevision:2,documentGeneration:1})).resolves.toEqual({kind:'cancelled'});
 else await expect(adapter.export(grant,{expectedRevision:2,documentGeneration:1})).rejects.toThrow(/download/i);
 expect(f.resources.write).not.toHaveBeenCalled();
 await adapter.dispose();
});
