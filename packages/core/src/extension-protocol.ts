import { parseHostResourceRequest, parseHostResourceResult, type HostResourceRequest, type HostResourceResult, type HostResourceFile } from './host-resource-protocol.js';
import { codexPickerTimeouts, isCodexCapability, parseCodexAppRequest, parseCodexAppResponse, type CodexAppRequest, type CodexAppResponse } from './codex-mcp-protocol.js';

export const EXTENSION_TOOL = 'extension_app';
export const EXTENSION_META_KEY = 'placekeeper/extension';
export type ExtensionPresentation = Extract<CodexAppResponse, { status: 'active' }>;
export interface RecentReviewSummary { id: string; title: string; updatedAt: string; page?: number }
export type ExtensionResult =
  | { status: 'recent-reviews'; items: RecentReviewSummary[] }
  | { status: 'position-saved' }
  | { status: 'provisional'; grant: string; hostFile?: HostResourceFile }
  | { status: 'active'; grant: string; presentation: ExtensionPresentation; contextPublished?: boolean }
  | { status: 'context-ready' }
  | { status: 'busy'; recoveryToken: string; canResume: boolean; canRecover?: true; matchingCopy?: true }
  | { status: 'cancelled' | 'unavailable' | 'chooser' | 'closed' }
  | HostResourceResult;
export type ExtensionRequest =
  | { action: 'recent-list' }
  | { action: 'recent-open'; id: string }
  | { action: 'reading-position'; grant: string; page: number }
  | HostResourceRequest
  | { action: 'open'; pdfPath?: string }
  | { action: 'recheck'; recoveryToken: string }
  | { action: 'choose'; recoveryToken: string; choice: 'resume' | 'fork' | 'recover'; operationId: string }
  | { action: 'activate' | 'resume'; grant: string; operationId: string }
  | { action: 'revoke'; grant: string; operationId?: string }
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
  if(v.action==='recent-list'&&keys('action'))return {action:'recent-list'};
  if(v.action==='recent-open'&&keys('action','id')&&typeof v.id==='string'&&/^[A-Za-z0-9_-]{32}$/.test(v.id))return {action:'recent-open',id:v.id};
  if(v.action==='reading-position'&&keys('action','grant','page')&&isCodexCapability(v.grant)&&Number.isSafeInteger(v.page)&&(v.page as number)>0&&(v.page as number)<=1000000)return {action:'reading-position',grant:v.grant,page:v.page as number};
  if (v.action === 'recheck' && keys('action','recoveryToken') && isCodexCapability(v.recoveryToken))
    return { action: 'recheck', recoveryToken: v.recoveryToken };
  if (v.action === 'open' && keys('action','pdfPath') && (v.pdfPath === undefined || typeof v.pdfPath === 'string' && v.pdfPath.length > 0 && v.pdfPath.length < 32768 && !v.pdfPath.includes('\0')))
    return { action: 'open', ...(v.pdfPath === undefined ? {} : { pdfPath: v.pdfPath }) };
  if (v.action === 'choose' && keys('action','recoveryToken','choice','operationId') && isCodexCapability(v.recoveryToken) && (v.choice === 'resume' || v.choice === 'fork' || v.choice === 'recover') && operation(v.operationId))
    return {action:v.action,recoveryToken:v.recoveryToken,choice:v.choice,operationId:v.operationId};
  if ((v.action === 'activate' || v.action === 'resume') && keys('action','grant','operationId') && isCodexCapability(v.grant) && operation(v.operationId))
    return {action:v.action,grant:v.grant,operationId:v.operationId};
  if (v.action === 'revoke' && keys('action','grant','operationId') && isCodexCapability(v.grant) && (v.operationId === undefined || operation(v.operationId)))
    return { action: 'revoke', grant: v.grant, ...(v.operationId === undefined ? {} : { operationId: v.operationId }) };
  if (v.action === 'context-published' && keys('action','grant') && isCodexCapability(v.grant)) return { action: 'context-published', grant: v.grant };
  if (v.action === 'app' && keys('action','request')) {const request=parseCodexAppRequest(v.request);if(request?.authority==='presentation')return {action:'app',request};}
}

export function parseExtensionResult(value: unknown): ExtensionResult | undefined {
  const host = parseHostResourceResult(value); if (host) return host;
  if(!object(value)) return;
  if(value.status==='position-saved')return {status:'position-saved'};
  if(value.status==='recent-reviews'&&Array.isArray(value.items)&&value.items.length<=50){
    const items:RecentReviewSummary[]=[];
    for(const item of value.items){if(!object(item)||typeof item.id!=='string'||!(/^[A-Za-z0-9_-]{32}$/).test(item.id)||typeof item.title!=='string'||item.title.length>180||typeof item.updatedAt!=='string'||!Number.isFinite(Date.parse(item.updatedAt))||item.page!==undefined&&(!Number.isSafeInteger(item.page)||(item.page as number)<1||(item.page as number)>1000000))return;
      items.push({id:item.id,title:item.title,updatedAt:item.updatedAt,...(item.page===undefined?{}:{page:item.page as number})});}
    return {status:'recent-reviews',items};
  }
  if(value.status==='provisional'&&isCodexCapability(value.grant)){
    const host=value.hostFile===undefined?undefined:parseHostResourceRequest({action:'host-open',file:value.hostFile});
    if(value.hostFile!==undefined&&host?.action!=='host-open')return;
    return {status:'provisional',grant:value.grant,...(host?.action==='host-open'?{hostFile:host.file}:{})};
  }
  if(value.status==='active'&&isCodexCapability(value.grant)) {const presentation=parseCodexAppResponse(value.presentation);if(presentation?.status==='active')return {status:'active',grant:value.grant,presentation,...(typeof value.contextPublished==='boolean'?{contextPublished:value.contextPublished}:{})};}
  if(value.status==='busy'&&isCodexCapability(value.recoveryToken)&&typeof value.canResume==='boolean')return {status:'busy',recoveryToken:value.recoveryToken,canResume:value.canResume,...(value.canRecover===true?{canRecover:true}:{}),...(value.matchingCopy===true?{matchingCopy:true}:{})};
  if(value.status==='context-ready')return {status:'context-ready'};
  if(value.status==='cancelled'||value.status==='unavailable'||value.status==='chooser'||value.status==='closed')return {status:value.status};
}
