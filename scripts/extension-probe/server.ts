import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { getResourcePath, OpenAIFileEntrypointInputSchema, OpenAIUiToolMetadataSchema, OpenAIUiResourceMetadataSchema } from '@openai/mcp-extensions';

export const PROBE_URI = 'ui://placekeeper-extension-probe/probe.html';
const events = new Set(['mount','heartbeat','resource-read','resource-updated','subscribe','host-context','context-published','tool-invoked','error','reload-requested']);
const detailKeys = new Set(['resources','modelContext','message','files','webMcp','pdf','bytes','writable','etag','hasContext','fullscreen','hidden','subscribed']);
export type ProbeEvent = { at:string; event:string; invocation?:string; mountId?:string; details?:Record<string,boolean|number> };

/** Standalone qualification server: never connected to production review authority. */
export function createProbeServer(html:string, record:(event:ProbeEvent)=>void):Server {
  const server = new Server({name:'placekeeper-extension-probe',version:'0.0.1'}, {capabilities:{tools:{},resources:{}}});
  const grants = new Map<string,{invocation:string;expires:number}>();
  const log = (event:Omit<ProbeEvent,'at'>) => record({at:new Date().toISOString(),...event});
  const reject = () => ({isError:true,content:[{type:'text' as const,text:'Invalid or expired qualification request. Reopen the probe.'}]});
  const ui = {resourceUri:PROBE_URI,visibility:['app']};
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
    {name:'open_probe_pdf',title:'Placekeeper Extension Probe',description:'Read a disposable PDF in the Placekeeper extension compatibility probe.',inputSchema:{type:'object',required:['file'],properties:{file:{type:'object',required:['name','resourceUri'],properties:{name:{type:'string'},resourceUri:{type:'string'}}}}},_meta:{ui,'openai/ui':OpenAIUiToolMetadataSchema.parse({entrypoints:[{type:'file',extensions:['.pdf']}]})}},
    {name:'open_probe',title:'Placekeeper Extension Probe',description:'Open the Placekeeper extension compatibility probe.',inputSchema:{type:'object',properties:{},additionalProperties:false},_meta:{ui,'openai/ui':OpenAIUiToolMetadataSchema.parse({entrypoints:[{type:'thread'}]})}},
    {name:'probe_observe',description:'Private qualification observations; no review or document access.',inputSchema:{type:'object',required:['nonce','event','mountId'],properties:{nonce:{type:'string'},event:{type:'string'},mountId:{type:'string'},details:{type:'object'}}},_meta:{ui:{visibility:['app']}}},
  ]}));
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:PROBE_URI,name:'Extension probe',mimeType:RESOURCE_MIME_TYPE}]}));
  server.setRequestHandler(ReadResourceRequestSchema,async({params})=>{
    if(params.uri!==PROBE_URI) throw new Error('Unknown resource');
    return {contents:[{uri:PROBE_URI,mimeType:RESOURCE_MIME_TYPE,text:html,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}},'openai/ui':OpenAIUiResourceMetadataSchema.parse({availableDisplayModes:['fullscreen'],preferredDisplayMode:'fullscreen'})}}]};
  });
  server.setRequestHandler(CallToolRequestSchema,async({params})=>{
    const args=params.arguments ?? {};
    if(params.name==='open_probe' || params.name==='open_probe_pdf') {
      const file=params.name==='open_probe_pdf' ? OpenAIFileEntrypointInputSchema.safeParse(args) : undefined;
      if(file && (!file.success || !file.data.file.resourceUri)) return reject();
      for(const [key,value] of grants) if(value.expires<Date.now()) grants.delete(key);
      if(grants.size>=100) return reject();
      const nonce=randomUUID(),invocation=randomUUID();
      grants.set(nonce,{invocation,expires:Date.now()+60*60*1000});
      let localPath=false;
      try {localPath=!!getResourcePath(params._meta);} catch { /* Observe presence only. */ }
      log({event:'entrypoint',invocation,details:{file:!!file,localPath}});
      return {content:[],_meta:{'placekeeper/probe':{nonce,invocation,...(file?.success?{file:file.data.file}:{})}}};
    }
    if(params.name!=='probe_observe' || typeof args.nonce!=='string') return reject();
    const grant=grants.get(args.nonce);
    if(!grant || grant.expires<Date.now() || typeof args.event!=='string' || !events.has(args.event) || typeof args.mountId!=='string' || !/^[a-zA-Z0-9-]{1,64}$/.test(args.mountId)) return reject();
    const details:Record<string,boolean|number>={};
    if(args.details && typeof args.details==='object') for(const [key,value] of Object.entries(args.details)) {
      if(detailKeys.has(key) && (typeof value==='boolean' || typeof value==='number' && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER)) details[key]=value;
    }
    log({event:args.event,invocation:grant.invocation,mountId:args.mountId,details});
    return {content:[],_meta:{'placekeeper/probe-observed':true}};
  });
  return server;
}
