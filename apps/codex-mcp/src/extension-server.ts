import { getResourcePath, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CODEX_MAX_ENCODED_RESPONSE_BYTES, CODEX_REVIEW_UI_RESOURCE } from '../../../packages/core/src/codex-mcp-protocol.js';
import { EXTENSION_META_KEY, EXTENSION_TOOL, parseExtensionRequest } from '../../../packages/core/src/extension-protocol.js';
import type { NativeServiceClient } from './service-client.js';

export const extensionTools:Tool[]=[
  {name:'open_pdf',title:'Placekeeper',description:'Open the selected PDF in Placekeeper.',inputSchema:{type:'object',required:['file'],properties:{file:{type:'object',required:['name','resourceUri'],properties:{name:{type:'string'},resourceUri:{type:'string'}}}}},_meta:{ui:{resourceUri:CODEX_REVIEW_UI_RESOURCE,visibility:['app']},'openai/ui':{entrypoints:[{type:'file',extensions:['.pdf']}]}}},
  {name:'open_placekeeper',title:'Placekeeper',description:'Open Placekeeper and choose a PDF.',inputSchema:{type:'object',properties:{},additionalProperties:false},_meta:{ui:{resourceUri:CODEX_REVIEW_UI_RESOURCE,visibility:['app']},'openai/ui':{entrypoints:[{type:'thread'}]}}},
  {name:EXTENSION_TOOL,description:'Private app-owned review operations.',inputSchema:{type:'object',required:['request'],properties:{request:{type:'object'}},additionalProperties:false},_meta:{ui:{visibility:['app']}}},
];
export async function callExtensionTool(client:NativeServiceClient,name:string,args:unknown,meta:unknown):Promise<CallToolResult>{
  const unavailable:CallToolResult={isError:true,content:[{type:'text',text:'Placekeeper could not open this review. Reopen the PDF through its file menu.'}]};
  try{
    if(!client.extension)return unavailable;
    let response;
    if(name==='open_pdf'){
      const input=OpenAIFileEntrypointInputSchema.parse(args),path=getResourcePath(meta);
      response=path===undefined?await client.extension({action:'host-open',file:input.file}):await client.extension({action:'open',pdfPath:path});
    }else if(name==='open_placekeeper'){
      if(args!==undefined&&(typeof args!=='object'||args===null||Object.keys(args).length))return unavailable;
      response={status:'chooser'};
    }else if(name===EXTENSION_TOOL){
      if(typeof args!=='object'||args===null||Object.keys(args).length!==1||!('request'in args))return unavailable;
      const request=parseExtensionRequest(args.request);
      // Paths are accepted only from the host's entrypoint metadata, never from app arguments.
      if(!request||request.action==='host-open'||request.action==='open'&&request.pdfPath!==undefined)return unavailable;
      response=await client.extension(request);
    }else return unavailable;
    const result:CallToolResult={content:[],_meta:{[EXTENSION_META_KEY]:response}};
    return Buffer.byteLength(JSON.stringify(result))<=CODEX_MAX_ENCODED_RESPONSE_BYTES?result:unavailable;
  }catch{return unavailable;}
}
