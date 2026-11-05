import { parsePreferenceSet, type PreferenceRequest, type PreferenceResult } from './extension-preferences.js';
import { parseHostResourceRequest, parseHostResourceResult, type HostResourceRequest, type HostResourceResult } from './host-resource-protocol.js';
import { codexPickerTimeouts, isCodexCapability, parseCodexAppRequest, parseCodexAppResponse, type CodexAppRequest, type CodexAppResponse } from './codex-mcp-protocol.js';

export const EXTENSION_TOOL = 'extension_app';
export const EXTENSION_META_KEY = 'placekeeper/extension';
export type ExtensionPresentation = Extract<CodexAppResponse, { status: 'active' }>;
export type ExtensionResult =
  | PreferenceResult
  | { status: 'provisional'; grant: string }
  | { status: 'active'; grant: string; presentation: ExtensionPresentation; contextPublished?: boolean }
  | { status: 'context-ready' }
  | { status: 'busy'; recoveryToken: string; canResume: boolean }
  | { status: 'cancelled' | 'unavailable' | 'chooser' | 'closed' }
  | HostResourceResult;
export type ExtensionRequest =
  | PreferenceRequest
  | HostResourceRequest
  | { action: 'open'; pdfPath?: string }
  | { action: 'choose'; recoveryToken: string; choice: 'resume' | 'fork'; operationId: string }
  | { action: 'activate' | 'resume'; grant: string; operationId: string }
  | { action: 'revoke'; grant: string }
  | { action: 'context-published'; grant: string }
  | { action: 'app'; request: CodexAppRequest };
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const operation = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
/** Preserve the native picker budget through the extension envelope. */
export function extensionPickerTimeouts(request: ExtensionRequest): { socketMs: number; sdkMs: number } | undefined {
  return request.action === 'app' ? codexPickerTimeouts(request.request)
    : request.action === 'open' && request.pdfPath === undefined ? { socketMs: 310_000, sdkMs: 315_000 } : undefined;
}

export function parseExtensionRequest(v: unknown): ExtensionRequest | undefined {
  const host = parseHostResourceRequest(v); if (host) return host;
  if (!object(v)) return;
  const keys = (...allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
  if(v.action==='settings-read'&&keys('action'))return {action:'settings-read'};
  if(v.action==='settings-update'&&keys('action','set')){const set=parsePreferenceSet(v.set);if(set)return {action:'settings-update',set};}
  if(v.action==='catalogue'&&keys('action','grant','operation')&&isCodexCapability(v.grant)&&(v.operation==='status'||v.operation==='capture'||v.operation==='remove'))return {action:'catalogue',grant:v.grant,operation:v.operation};
  if(v.action==='mention-search'&&keys('action','query')&&typeof v.query==='string'&&v.query.length<=4096)return {action:'mention-search',query:v.query};
  if(v.action==='mention-read'&&keys('action','uri')&&typeof v.uri==='string'&&v.uri.length<=256)return {action:'mention-read',uri:v.uri};
  if (v.action === 'open' && keys('action','pdfPath') && (v.pdfPath === undefined || typeof v.pdfPath === 'string' && v.pdfPath.length > 0 && v.pdfPath.length < 32768 && !v.pdfPath.includes('\0')))
    return { action: 'open', ...(v.pdfPath === undefined ? {} : { pdfPath: v.pdfPath }) };
  if (v.action === 'choose' && keys('action','recoveryToken','choice','operationId') && isCodexCapability(v.recoveryToken) && (v.choice === 'resume' || v.choice === 'fork') && operation(v.operationId))
    return {action:v.action,recoveryToken:v.recoveryToken,choice:v.choice,operationId:v.operationId};
  if ((v.action === 'activate' || v.action === 'resume') && keys('action','grant','operationId') && isCodexCapability(v.grant) && operation(v.operationId))
    return {action:v.action,grant:v.grant,operationId:v.operationId};
  if ((v.action === 'revoke' || v.action === 'context-published') && keys('action','grant') && isCodexCapability(v.grant)) return {action:v.action,grant:v.grant};
  if (v.action === 'app' && keys('action','request')) {const request=parseCodexAppRequest(v.request);if(request?.authority==='presentation')return {action:'app',request};}
}

export function parseExtensionResult(value: unknown): ExtensionResult | undefined {
  const host = parseHostResourceResult(value); if (host) return host;
  if(!object(value)) return;
  if(value.status==='settings'&&Number.isSafeInteger(value.revision)&&parsePreferenceSet(value.values)&&Object.keys(value.values as object).length===3)return value as unknown as PreferenceResult;
  if(value.status==='catalogue'&&typeof value.included==='boolean'){
    if(value.snapshot===undefined)return {status:'catalogue',included:value.included};
    const s=value.snapshot;if(object(s)&&typeof s.generation==='number'&&Number.isSafeInteger(s.generation)&&typeof s.revision==='number'&&Number.isSafeInteger(s.revision)&&typeof s.capturedAt==='string')return {status:'catalogue',included:value.included,snapshot:{generation:s.generation,revision:s.revision,capturedAt:s.capturedAt}};
  }
  if(value.status==='mention-results'&&Array.isArray(value.items)&&value.items.length<=50){
    const items:Extract<PreferenceResult,{status:'mention-results'}>['items']=[];
    for(const item of value.items){if(!object(item)||item.type!=='resource'||typeof item.resourceUri!=='string'||!/^placekeeper-mention:\/\/[A-Za-z0-9_-]{32}(?:\/\d{1,2})?$/.test(item.resourceUri)||typeof item.title!=='string'||typeof item.subtitle!=='string')return;items.push({type:'resource',resourceUri:item.resourceUri,title:item.title,subtitle:item.subtitle});}
    return {status:'mention-results',items};
  }
  if(value.status==='mention-resource'&&typeof value.text==='string')return {status:'mention-resource',text:value.text};
  if(value.status==='provisional'&&isCodexCapability(value.grant))return {status:'provisional',grant:value.grant};
  if(value.status==='active'&&isCodexCapability(value.grant)) {const presentation=parseCodexAppResponse(value.presentation);if(presentation?.status==='active')return {status:'active',grant:value.grant,presentation,...(typeof value.contextPublished==='boolean'?{contextPublished:value.contextPublished}:{})};}
  if(value.status==='busy'&&isCodexCapability(value.recoveryToken)&&typeof value.canResume==='boolean')return {status:'busy',recoveryToken:value.recoveryToken,canResume:value.canResume};
  if(value.status==='context-ready')return {status:'context-ready'};
  if(value.status==='cancelled'||value.status==='unavailable'||value.status==='chooser'||value.status==='closed')return {status:value.status};
}
