import { HostResourcePersistence } from './host-resource-persistence.js';
import type { HostResourceRequest, HostResourceFile } from '../../../../packages/core/src/host-resource-protocol.js';
import { reconcileNativeSource } from "./reconcile-native-source.js";
import { randomBytes } from 'node:crypto';
import { digestSecretHex } from '../../../../packages/core/src/session-security.js';
import { CODEX_MAX_ENCODED_RESPONSE_BYTES, parseCodexAppRequest, type CodexAppResponse } from '../../../../packages/core/src/codex-mcp-protocol.js';
import { parseExtensionRequest, type ExtensionResult, type ExtensionPresentation, type ExtensionRequest } from '../../../../packages/core/src/extension-protocol.js';
import { ReviewExportConflictError } from '../../../../packages/core/src/review-runtime-protocol.js';
import type { UpgradeReviewStatus } from '../../../../packages/core/src/upgrade-review-protocol.js';
import type { SessionBroker } from '../sessions/session-broker.js';
import type { OpenReviewResult, RecoveryOfferIdentity } from '../sessions/session-contracts.js';
import type { CodexActiveScope, CodexServiceRuntimeBackend } from './codex-runtime-backend.js';

const secret = () => randomBytes(32).toString('base64url');
const opaque = () => randomBytes(16).toString('base64url');
const unavailable = (): ExtensionResult => ({status:'unavailable'});
type RecordState = { sessionId:string; grant:string; expires:number; provisional:boolean; watermark:number; contextPublished:boolean; active?:ExtensionPresentation; lease?:number };
type Offer = { path:string;hostSessionId?:string; expires:number; recoveryOffer?:RecoveryOfferIdentity; result?:{operationId:string;choice:string;value:ExtensionResult} };

/** App ownership is independent of trusted chat bindings. Grants never enter browser storage. */
export class ExtensionRuntimeManager {
  readonly #hostTickets=new Map<string,{file:HostResourceFile;expires:number}>();
  readonly #hostSessions=new Set<string>();
  readonly #host:HostResourcePersistence;
  readonly #records=new Map<string,RecordState>();
  readonly #panels=new Map<string,RecordState>();
  readonly #offers=new Map<string,Offer>();
  readonly #receipts=new Map<string,{operationId:string;action:string;expires:number;record:RecordState;result:ExtensionResult}>();
  readonly #now:()=>number;
  readonly #lease:number;
  readonly #idle:number;
  readonly #backend:CodexServiceRuntimeBackend;
  readonly #pick:(()=>Promise<string|undefined>)|undefined;
  readonly #timer:ReturnType<typeof setInterval>;
  readonly #unsubscribe:()=>void;
  readonly #unsubscribeEnd:()=>void;
  readonly #requests=new Set<Promise<unknown>>();
  #tail:Promise<unknown>=Promise.resolve();
  #closing=false;
  constructor(readonly broker:SessionBroker,options:{backend:CodexServiceRuntimeBackend;now?:()=>number;panelLeaseMs?:number;grantIdleMs?:number;pickPdf?:()=>Promise<string|undefined>}) {
    this.#backend=options.backend;this.#host=new HostResourcePersistence(broker,options.backend);this.#now=options.now??Date.now;this.#lease=options.panelLeaseMs??30_000;this.#idle=options.grantIdleMs??30*60_000;this.#pick=options.pickPdf;
    if(!Number.isSafeInteger(this.#lease)||this.#lease<=0||!Number.isSafeInteger(this.#idle)||this.#idle<=this.#lease)throw Error('Invalid extension lifetimes');
    this.#timer=setInterval(()=>this.#sweep(),Math.min(this.#lease,1000));this.#timer.unref();
    this.#unsubscribe=broker.onStateInvalidation(event=>{for(const r of this.#records.values())if(r.sessionId===event.sessionId){r.watermark++;if(event.reason==='generation')this.#suspend(r);}});
    this.#unsubscribeEnd=broker.onSessionEnd(id=>{for(const r of this.#records.values())if(r.sessionId===id)this.#remove(r);});
  }
  #serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.#tail.then(work,work);this.#tail=result.catch(()=>undefined);return result;}
  async dispatch(raw:unknown):Promise<ExtensionResult|CodexAppResponse>{
    const r=parseExtensionRequest(raw);if(!r||this.#closing)return unavailable();
    if(r.action==='host-open')return this.#serial(async()=>{const ticket=secret();this.#hostTickets.set(digestSecretHex(ticket),{file:r.file,expires:this.#now()+120000});return {status:'host-resource',ticket,file:r.file};});
    if(r.action==='host-resource')return this.#serial(()=>this.#hostRequest(r)).catch(()=>unavailable());
    if(r.action==='app')return this.handle(r.request);
    if(r.action==='open')return this.open(r);
    if(r.action==='choose')return this.choose(r);
    if(r.action==='context-published')return this.#serial(async()=>{this.#sweep();const record=this.#records.get(digestSecretHex(r.grant));if(!record||record.provisional||this.#closing)return unavailable();record.contextPublished=true;return {status:'context-ready'};});
    if(r.action==='revoke')return await this.revoke(r.grant)?{status:'closed'}:unavailable();
    return this.resume(r.grant,r.operationId,r.action);
  }
  // Dispatch serializes transfers, intents, receipts, refresh and grant rotation together.
  async #hostRequest(r:Extract<HostResourceRequest,{action:'host-resource'}>):Promise<ExtensionResult>{
    this.#sweep();if(this.#closing)return unavailable();
    if(r.operation==='begin'){
      if(r.ticket){const key=digestSecretHex(r.ticket),ticket=this.#hostTickets.get(key);if(!ticket)return unavailable();
        return this.#host.begin(r,{file:ticket.file,current:()=>!this.#closing&&this.#hostTickets.get(key)===ticket&&ticket.expires>this.#now()});}
      const key=digestSecretHex(r.grant!),record=this.#records.get(key);if(!record||!this.#hostSessions.has(record.sessionId))return unavailable();
      return this.#host.begin(r,{sessionId:record.sessionId,current:()=>!this.#closing&&this.#records.get(key)===record});
    }
    if(r.operation==='chunk')return this.#host.chunk(r.transfer,r.offset,r.dataBase64);
    if(r.operation==='cancel'){await this.#host.cancel(r.transfer);return {status:'cancelled'};}
    if(r.operation==='finish'){
      const result=await this.#host.finish(r.transfer);
      if(!('opened' in result))return result;
      const opened=result.opened;
      if(opened.kind==='recovery-offered'){
        const token=secret(),path=await this.broker.importedRecoveryPath(opened.recoverySessionId);
        if(!path)return unavailable();
        this.#offers.set(digestSecretHex(token),{path,hostSessionId:opened.recoverySessionId,expires:this.#now()+60000,recoveryOffer:opened.recoveryOffer});return {status:'busy',recoveryToken:token,canResume:true};
      }
      if(opened.kind==='focused'){
        const token=secret(),scope=this.broker.nativeAdmissionScope(opened.launch.sessionId);if(!scope)return unavailable();
        this.#offers.set(digestSecretHex(token),{path:scope.canonicalSourcePath,hostSessionId:opened.launch.sessionId,expires:this.#now()+60000});return {status:'busy',recoveryToken:token,canResume:false};
      }
      this.#hostSessions.add(opened.launch.sessionId);return this.#provisional(opened);
    }
    const key=digestSecretHex(r.grant),record=this.#records.get(key);if(!record||!this.#hostSessions.has(record.sessionId))return unavailable();
    const assertAuthority=()=>{if(this.#closing||this.#records.get(key)!==record||record.expires<=this.#now())throw Error('Host authority retired');};
    let result:ExtensionResult;
    if(r.operation==='status')result=await this.#host.status(record.sessionId);
    else if(r.operation==='export')result=await this.#host.export(record.sessionId,r.expectedRevision,r.generation,assertAuthority);
    else if(r.operation==='save')result=await this.#host.save(record.sessionId,assertAuthority);
    else if(r.operation==='save-chunk')result=await this.#host.saveChunk(record.sessionId,r.intentId,r.offset);
    else result=await this.#host.receipt(record.sessionId,r.intentId,r.outcome,r.etag,assertAuthority);
    assertAuthority();return result;
  }
  open(input:{pdfPath?:string}):Promise<ExtensionResult>{return this.#serial(async()=>{
    this.#sweep();if(this.#closing)return unavailable();
    const path=input.pdfPath??await this.#pick?.();
    if(!path)return {status:this.#pick?'cancelled':'chooser'};
    if(this.#closing)return unavailable();
    const opened=await this.broker.openReview({pdfPath:path,surface:'codex-native'});
    if(this.#closing)return unavailable();
    if(opened.kind==='focused'||opened.kind==='recovery-offered') {
      const token=secret();this.#offers.set(digestSecretHex(token),{path,expires:this.#now()+60_000,...(opened.kind==='recovery-offered'?{recoveryOffer:opened.recoveryOffer}:{})});
      return {status:'busy',recoveryToken:token,canResume:opened.kind==='recovery-offered'};
    }
    return this.#provisional(opened);
  });}
  choose(input:Extract<ExtensionRequest,{action:'choose'}>):Promise<ExtensionResult>{return this.#serial(async()=>{
    this.#sweep();const offer=this.#offers.get(digestSecretHex(input.recoveryToken));
    if(!offer||this.#closing||input.choice==='resume'&&!offer.recoveryOffer)return unavailable();
    if(offer.result)return offer.result.operationId===input.operationId&&offer.result.choice===input.choice?offer.result.value:unavailable();
    const result=offer.hostSessionId&&input.choice==='fork'?await this.#host.fork(offer.hostSessionId):await this.broker.openReview({pdfPath:offer.path,surface:'codex-native',recoveryDecision:input.choice,...(offer.recoveryOffer?{recoveryOffer:offer.recoveryOffer,recoveryOperationId:input.operationId}:{})});
    if(this.#closing)return unavailable();
    if(offer.hostSessionId&&result.kind!=='recovery-offered')this.#hostSessions.add(result.launch.sessionId);
    const value=result.kind==='recovery-offered'?unavailable():this.#provisional(result);
    offer.result={operationId:input.operationId,choice:input.choice,value};return value;
  });}
  #provisional(result:Exclude<OpenReviewResult,{kind:'recovery-offered'}>):ExtensionResult{
    const grant=secret();const record:RecordState={sessionId:result.launch.sessionId,grant,expires:this.#now()+Math.min(60_000,this.#idle),provisional:true,watermark:0,contextPublished:false};
    this.#records.set(digestSecretHex(grant),record);return {status:'provisional',grant};
  }
  resume(grant:string,operationId:string,action:'activate'|'resume'='resume'):Promise<ExtensionResult>{return this.#serial(async()=>{
    this.#sweep();if(this.#closing)return unavailable();const key=digestSecretHex(grant),receipt=this.#receipts.get(key);
    if(receipt)return receipt.operationId===operationId&&receipt.action===action&&receipt.result.status==='active'&&receipt.result.presentation===receipt.record.active&&receipt.result.grant===receipt.record.grant&&this.#records.get(digestSecretHex(receipt.record.grant))===receipt.record?{...receipt.result,contextPublished:receipt.record.contextPublished}:unavailable();
    const record=this.#records.get(key);if(!record||record.provisional!==(action==='activate'))return unavailable();
    const scope=this.broker.nativeAdmissionScope(record.sessionId);if(!scope)return unavailable();
    // Revalidate local source through the canonical broker before exposing another incarnation.
    if(!this.#hostSessions.has(record.sessionId)&&!await reconcileNativeSource(this.broker,record.sessionId,scope.canonicalSourcePath))return unavailable();
    if(this.#closing||this.#records.get(key)!==record)return unavailable();
    const current=this.broker.nativeAdmissionScope(record.sessionId);if(!current||this.broker.taskBindings.taskForGeneration(record.sessionId,current.documentGeneration)!==undefined)return unavailable();
    this.#suspend(record);this.#records.delete(key);record.grant=secret();record.provisional=false;record.expires=this.#now()+this.#idle;
    const presentation:ExtensionPresentation={status:'active',runtimeId:opaque(),attemptId:opaque(),generation:current.documentGeneration,presentationCapability:secret(),reconnectTicket:secret()};
    record.active=presentation;record.lease=this.#now()+this.#lease;this.#records.set(digestSecretHex(record.grant),record);this.#panels.set(presentation.runtimeId,record);
    this.#backend.attach(this.#scope(record));
    const result:ExtensionResult={status:'active',grant:record.grant,presentation,contextPublished:record.contextPublished};
    this.#receipts.set(key,{operationId,action,expires:this.#now()+30_000,record,result});return result;
  });}
  #scope(r:RecordState):CodexActiveScope{return {sessionId:r.sessionId,runtimeId:r.active!.runtimeId,attemptId:r.active!.attemptId,generation:r.active!.generation};}
  #suspend(r:RecordState){if(r.active){this.#backend.detach(r.active.runtimeId);this.#panels.delete(r.active.runtimeId);}delete r.active;delete r.lease;}
  #remove(r:RecordState){this.#suspend(r);this.#records.delete(digestSecretHex(r.grant));for(const [key,receipt]of this.#receipts)if(receipt.record===r)this.#receipts.delete(key);}
  #sweep(){const now=this.#now();for(const [key,t]of this.#hostTickets)if(t.expires<=now)this.#hostTickets.delete(key);void this.#host.sweep();for(const r of this.#records.values()){if(r.expires<=now)this.#remove(r);else if(r.lease!==undefined&&r.lease<=now)this.#suspend(r);}for(const [key,o]of this.#offers)if(o.expires<=now)this.#offers.delete(key);for(const [key,r]of this.#receipts)if(r.expires<=now)this.#receipts.delete(key);}
  async revoke(grant:string):Promise<boolean>{return this.#serial(async()=>{this.#sweep();const r=this.#records.get(digestSecretHex(grant));if(!r)return false;this.#remove(r);return true;});}
  handle(raw:unknown):Promise<CodexAppResponse>{const result=this.#handle(raw).catch(()=>({status:'denied',reason:'unavailable'} as const));this.#requests.add(result);void result.finally(()=>this.#requests.delete(result));return result;}
  async #handle(raw:unknown):Promise<CodexAppResponse>{
    this.#sweep();const request=parseCodexAppRequest(raw);if(!request||request.authority!=='presentation')return {status:'denied',reason:'invalid'};
    const r=this.#panels.get(request.runtimeId);
    const current=()=>!this.#closing&&r!==undefined&&this.#panels.get(request.runtimeId)===r&&r.active?.attemptId===request.attemptId&&r.active.generation===request.generation&&r.lease!>this.#now()&&digestSecretHex(r.active.presentationCapability)===digestSecretHex(request.capability)&&this.broker.nativeAdmissionScope(r.sessionId)?.documentGeneration===request.generation&&this.broker.taskBindings.taskForGeneration(r.sessionId,request.generation)===undefined;
    if(!current()||!r)return {status:'denied',reason:'expired'};
    if(request.method==='detach'){this.#remove(r);return {status:'ok',payload:{}};}
    if(request.method==='renew'){r.lease=this.#now()+this.#lease;r.expires=this.#now()+this.#idle;return {status:'ok',payload:{leaseExpiresAt:new Date(r.lease).toISOString()}};}
    if(request.method==='watermark'){const state=this.broker.state(r.sessionId);return {status:'ok',payload:{watermark:r.watermark,sessionId:r.sessionId,documentGeneration:request.generation,reviewRevision:state?.revision}};}
    try{const payload=await this.#backend.handle(this.#scope(r),request,current);if(!current())return {status:'denied',reason:'revoked'};const response:CodexAppResponse={status:'ok',payload};return Buffer.byteLength(JSON.stringify(response))<=CODEX_MAX_ENCODED_RESPONSE_BYTES?response:{status:'denied',reason:'unavailable'};}
    catch(error){if(current()&&error instanceof ReviewExportConflictError)return {status:'operation-error',reason:'export-conflict'};return {status:'denied',reason:'unavailable'};}
  }
  activityCount(){this.#sweep();return this.#panels.size;}
  upgradeCovered(has:(id:string)=>boolean){return [...this.#panels.keys()].every(id=>has(`codex:${id}`));}
  async closeForUpgrade(_status:UpgradeReviewStatus){await this.close();}
  async close(){this.#closing=true;await this.#host.close();await this.#tail;await Promise.allSettled([...this.#requests]);await this.#host.close();this.#hostTickets.clear();this.#hostSessions.clear();clearInterval(this.#timer);this.#unsubscribe();this.#unsubscribeEnd();for(const r of this.#records.values())this.#remove(r);this.#offers.clear();this.#receipts.clear();}
}
