import { describe, expect, it, vi } from 'vitest';
import { callExtensionTool, extensionTools } from '../src/extension-server.js';
import { EXTENSION_META_KEY, EXTENSION_TOOL } from '../../../packages/core/src/extension-protocol.js';
import type { NativeServiceClient } from '../src/service-client.js';
const file={name:'test.pdf',resourceUri:'opaque:host-file'};
function fixture(){return {extension:vi.fn(async()=>({status:'provisional' as const,grant:'p'.repeat(43)}))} as unknown as NativeServiceClient;}
describe('extension entrypoint admission',()=>{
  it('takes a local path only from host metadata and keeps authority private',async()=>{
    const client=fixture();const result=await callExtensionTool(client,'open_pdf',{file,pdfPath:'/forged.pdf'},{'openai/resource':{path:'/authorized.pdf'}});
    expect(client.extension).toHaveBeenCalledWith({action:'open',pdfPath:'/authorized.pdf'});
    expect(result.content).toEqual([]);expect(result.structuredContent).toBeUndefined();expect(result._meta?.[EXTENSION_META_KEY]).toEqual({status:'provisional',grant:'p'.repeat(43)});
    expect(await callExtensionTool(client,EXTENSION_TOOL,{request:{action:'open',pdfPath:'/forged.pdf'}},undefined)).toMatchObject({isError:true});
    expect(client.extension).toHaveBeenCalledOnce();
  });
  it('preserves an opaque resource for the host adapter instead of interpreting it as a path',async()=>{
    const client=fixture();await callExtensionTool(client,'open_pdf',{file},undefined);expect(client.extension).toHaveBeenCalledWith({action:'host-open',file});
    expect(await callExtensionTool(client,EXTENSION_TOOL,{request:{action:'host-open',file}},undefined)).toMatchObject({isError:true});
  });
  it('opens a chooser without selecting another conversation’s active review',async()=>{
    const client=fixture();expect(await callExtensionTool(client,'open_placekeeper',{},undefined)).toMatchObject({_meta:{[EXTENSION_META_KEY]:{status:'chooser'}}});expect(client.extension).not.toHaveBeenCalled();
    expect(extensionTools.map(t=>t.name)).toEqual(['open_pdf','open_placekeeper',EXTENSION_TOOL]);
    expect(extensionTools[0]?._meta).toMatchObject({'openai/ui':{entrypoints:[{type:'file',extensions:['.pdf']}]}});
  });
});
