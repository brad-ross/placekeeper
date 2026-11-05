import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
const app=new App({name:'Placekeeper extension probe',version:'0.0.1'});
const ext=new OpenAIExtensions(app), mountId=crypto.randomUUID();
const view=document.querySelector<HTMLPreElement>('#report')!;
let grant:{nonce:string;invocation:string;file?:{name:string;resourceUri:string}}|undefined;
let connected=false,reading=false,subscribedUri:string|undefined;
let last:Record<string,unknown>={mountId,state:'Connecting'};
function show(update:Record<string,unknown>) {last={...last,...update};view.textContent=JSON.stringify(last,null,2);}
async function observe(event:string,details:Record<string,boolean|number>={}) {
  if(!grant || !connected) return;
  try {const result=await app.callServerTool({name:'probe_observe',arguments:{nonce:grant.nonce,event,mountId,details}},{timeout:8000});show({observationAccepted:!result.isError,lastEvent:event});}
  catch {show({observationAccepted:false,lastEvent:event});}
}
function capabilities(){return {resources:!!ext.resources,modelContext:!!ext.modelContext,message:!!ext.message,files:!!ext.files,webMcp:!!(document as Document & {modelContext?:unknown}).modelContext};}
async function readPdf(){
  if(!connected || reading || !grant?.file) return;
  if(!ext.resources){show({resourceRead:'Host did not advertise resource access'});return;}
  reading=true;const source=grant;
  try{
    const result=await ext.resources.read({uri:source.file!.resourceUri,representation:'blob'});
    if(source!==grant)return;
    const content=result.contents.find(c=>c.uri===source.file!.resourceUri && 'blob' in c);
    if(!content || !('blob' in content)){show({resourceRead:'No binary resource returned'});await observe('error');return;}
    const bytes=atob(content.blob),pdf=bytes.startsWith('%PDF-');
    const details={bytes:bytes.length,pdf,writable:content.openaiMetadata?.writable===true,etag:typeof content.openaiMetadata?.etag==='string'};
    show({resourceRead:details});await observe('resource-read',details);
    if(subscribedUri!==source.file!.resourceUri){
      try{await ext.resources.subscribe({uri:source.file!.resourceUri});subscribedUri=source.file!.resourceUri;show({subscription:true});await observe('subscribe',{subscribed:true});}
      catch{show({subscription:false});await observe('subscribe',{subscribed:false});}
    }
  }catch{show({resourceRead:'Read failed (no source details logged)'});await observe('error');}
  finally{reading=false;if(source!==grant)void readPdf();}
}
app.ontoolresult=result=>{
  const input=result._meta?.['placekeeper/probe'];
  if(!input || typeof input!=='object' || !('nonce' in input) || typeof input.nonce!=='string')return;
  grant=input as typeof grant;show({privateResultReceived:true,invocation:grant!.invocation,hasFile:!!grant!.file});
  if(connected){void observe('mount',capabilities());void readPdf();}
};
app.onhostcontextchanged=context=>{
  const current=ext.modelContext?.getCurrent();
  show({displayMode:context.displayMode??last.displayMode,hostContextPresent:current!==undefined&&current!==null});
  void observe('host-context',{hasContext:current!==undefined&&current!==null,fullscreen:context.displayMode==='fullscreen'});
};
document.querySelector('#read')!.addEventListener('click',()=>void readPdf());
document.querySelector('#reload')!.addEventListener('click',()=>void observe('reload-requested').then(()=>location.reload()));
document.querySelector('#context')!.addEventListener('click',()=>{
  if(!ext.modelContext){show({contextPublish:'Unsupported'});return;}
  void ext.modelContext.update({content:[{type:'text',text:'Placekeeper compatibility test marker. No document content is attached.'}]}).then(()=>{show({contextPublish:'Marker published; remove it in chat to test removal'});return observe('context-published');}).catch(()=>show({contextPublish:'Failed'}));
});
void app.connect().then(()=>{
  connected=true;show({state:'Connected',capabilities:capabilities(),host:app.getHostVersion(),displayMode:app.getHostContext()?.displayMode});
  ext.resources?.addUpdateHandler(event=>{if(event.params.uri===grant?.file?.resourceUri){void observe('resource-updated');void readPdf();}});
  if(grant){void observe('mount',capabilities());void readPdf();}
  setInterval(()=>void observe('heartbeat',{hidden:document.hidden}),10000);
  const tools=(document as Document & {modelContext?:{registerTool:(tool:unknown)=>void}}).modelContext;
  if(tools){try{tools.registerTool({name:'inspect_placekeeper_probe',description:'Inspect the active extension compatibility probe; returns no PDF content.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true},execute:async()=>{await observe('tool-invoked');return JSON.stringify({mountId,connected,hasFile:!!grant?.file});}});show({liveToolRegistered:true});}catch{show({liveToolRegistered:false});}}
}).catch(()=>show({state:'Host connection failed'}));
