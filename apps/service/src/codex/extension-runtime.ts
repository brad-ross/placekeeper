import { realpath } from 'node:fs/promises';
import { ExtensionRecentReviews } from './extension-recent-reviews.js';
import { HostResourcePersistence, type HostCopyRecoveryMatch } from './host-resource-persistence.js';
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
type RecordState = { sessionId:string; grant:string; expires:number; provisional:boolean; watermark:number; contextPublished:boolean; copyAdmission?:{match:HostCopyRecoveryMatch;verified:boolean;offer:Offer}; active?:ExtensionPresentation; lease?:number; disconnected?:true; page?:number };
type AdmissionScope = NonNullable<ReturnType<SessionBroker['nativeAdmissionScope']>>;
type LiveOffer = { scope: AdmissionScope; owners: string[]; ownershipEpoch: number };
type RotationReceipt = {
  operationId: string;
  action: 'activate' | 'resume';
  expires: number;
  record: RecordState;
  result: Extract<ExtensionResult, { status: 'active' }>;
};
type Offer = ({ path: string; hostSessionId?: string; resumeLiveHostReview?: true; releasedLocalSessionId?: string; recoveryOffer?: RecoveryOfferIdentity } | { copyRecovery: HostCopyRecoveryMatch }) & {
  expires: number;
  live?: LiveOffer | undefined;
  targetSessionId?: string;
  hostFile?: HostResourceFile;
  disconnected?: { sessionId: string; records: { record: RecordState; grantDigest: string }[] } | undefined;
  result?: { operationId: string; choice: string; value: ExtensionResult };
};

/** App ownership is independent of trusted chat bindings. Grants never enter browser storage. */
export class ExtensionRuntimeManager {
  readonly #recent:ExtensionRecentReviews;
  readonly #hostFiles=new Map<string,HostResourceFile>();
  readonly #hostTickets=new Map<string,{file:HostResourceFile;expires:number}>();
  readonly #hostSessions=new Set<string>();
  readonly #host:HostResourcePersistence;
  readonly #records=new Map<string,RecordState>();
  readonly #releasedLocalSessions=new Set<string>();
  // Retain the epoch through release so earlier offers cannot survive an intervening grant.
  readonly #ownershipEpochs = new Map<string, number>();
  readonly #revoked = new Map<string, { expires: number; operationId?: string }>();
  readonly #panels=new Map<string,RecordState>();
  readonly #offers=new Map<string,Offer>();
  readonly #receipts = new Map<string, RotationReceipt>();
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
    this.#recent=new ExtensionRecentReviews(broker.recoveryRoot,options.now);this.#backend=options.backend;this.#host=new HostResourcePersistence(broker,options.backend);this.#now=options.now??Date.now;this.#lease=options.panelLeaseMs??30_000;this.#idle=options.grantIdleMs??30*60_000;this.#pick=options.pickPdf;
    if(!Number.isSafeInteger(this.#lease)||this.#lease<=0||!Number.isSafeInteger(this.#idle)||this.#idle<=this.#lease)throw Error('Invalid extension lifetimes');
    this.#timer=setInterval(()=>this.#sweep(),Math.min(this.#lease,1000));this.#timer.unref();
    this.#unsubscribe=broker.onStateInvalidation(event=>{for(const r of this.#records.values())if(r.sessionId===event.sessionId){r.watermark++;if(event.reason==='generation')this.#suspend(r);}});
    this.#unsubscribeEnd=broker.onSessionEnd(id=>{this.#hostFiles.delete(id);this.#releasedLocalSessions.delete(id);this.#ownershipEpochs.delete(id);for(const r of this.#records.values())if(r.sessionId===id)this.#remove(r);});
  }
  #serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.#tail.then(work,work);this.#tail=result.catch(()=>undefined);return result;}
  async dispatch(raw:unknown):Promise<ExtensionResult|CodexAppResponse>{
    const r=parseExtensionRequest(raw);if(!r||this.#closing)return unavailable();
    if(r.action==='recent-list')return {status:'recent-reviews',items:(await this.#recent.list()).map(({id,title,updatedAt,page})=>({id,title,updatedAt,...(page===undefined?{}:{page})}))};
    if(r.action==='recent-open')return this.#serial(()=>this.#openRecent(r.id)).catch(()=>unavailable());
    if(r.action==='reading-position')return this.#serial<ExtensionResult>(async()=>{
      this.#sweep();const record=this.#records.get(digestSecretHex(r.grant));
      if(!record?.active||record.provisional||this.#closing||this.broker.nativeAdmissionScope(record.sessionId)?.documentGeneration!==record.active.generation||this.broker.taskBindings.taskForGeneration(record.sessionId,record.active.generation))return unavailable();
      await this.#recent.position(record.sessionId,r.page);record.page=r.page;return {status:'position-saved'};
    });
    if(r.action==='host-open')return this.#serial(async()=>this.#issueHostTicket(r.file));
    if(r.action==='host-resource')return this.#serial(()=>this.#hostRequest(r)).catch(()=>unavailable());
    if(r.action==='app')return this.handle(r.request);
    if(r.action==='open')return this.open(r);
    if(r.action==='choose')return this.choose(r);
    if(r.action==='recheck')return this.#serial(()=>this.#recheck(r.recoveryToken)).catch(()=>unavailable());
    if(r.action==='context-published')return this.#serial(async()=>{this.#sweep();const record=this.#records.get(digestSecretHex(r.grant));if(!record||record.provisional||this.#closing)return unavailable();record.contextPublished=true;return {status:'context-ready'};});
    if(r.action==='revoke')return await this.revoke(r.grant,r.operationId)?{status:'closed'}:unavailable();
    return this.resume(r.grant,r.operationId,r.action);
  }
  #issueHostTicket(file: HostResourceFile): ExtensionResult {
    const ticket = secret();
    this.#hostTickets.set(digestSecretHex(ticket), { file, expires: this.#now() + 120000 });
    return { status: 'host-resource', ticket, file };
  }
  // Dispatch serializes transfers, intents, receipts, refresh and grant rotation together.
  async #hostRequest(r:Extract<HostResourceRequest,{action:'host-resource'}>):Promise<ExtensionResult>{
    this.#sweep();if(this.#closing)return unavailable();
    if(r.operation==='begin'){
      if(r.ticket){const key=digestSecretHex(r.ticket),ticket=this.#hostTickets.get(key);if(!ticket)return unavailable();
        return this.#host.begin(r,{file:ticket.file,current:()=>!this.#closing&&this.#hostTickets.get(key)===ticket&&ticket.expires>this.#now()});}
      const key=digestSecretHex(r.grant!),record=this.#records.get(key);if(!record||!this.#hostSessions.has(record.sessionId))return unavailable();
      const admission = record.copyAdmission;
      if (admission && r.sha256 !== admission.match.sha256) {
        const result = this.#issueHostTicket(admission.match.file);
        this.#remove(record);
        if (admission.offer.result) admission.offer.result.value = result;
        return result;
      }
      return this.#host.begin(r, {
        sessionId: record.sessionId,
        current: () => !this.#closing && this.#records.get(key) === record,
        ...(admission ? { onVerified: () => { admission.verified = true; } } : {}),
      });
    }
    if(r.operation==='chunk')return this.#host.chunk(r.transfer,r.offset,r.dataBase64);
    if(r.operation==='cancel'){await this.#host.cancel(r.transfer);return {status:'cancelled'};}
    if(r.operation==='finish'){
      const result=await this.#host.finish(r.transfer);
      if ('copyRecovery' in result) {
        const token = secret(), disconnected = this.#disconnected(result.copyRecovery.sessionId);
        this.#offers.set(digestSecretHex(token), { copyRecovery: result.copyRecovery, live: this.#liveOffer(result.copyRecovery.sessionId), ...(disconnected ? {disconnected} : {}), expires: this.#now() + 60000 });
        return { status: 'busy', recoveryToken: token, canResume: !this.#hasReviewGrant(result.copyRecovery.sessionId), matchingCopy: true, ...(disconnected ? {canRecover:true} : {}) };
      }
      if(!('opened' in result))return result;
      const opened=result.opened;
      if(result.file)this.#hostFiles.set(opened.kind==='recovery-offered'?opened.recoverySessionId:opened.launch.sessionId,result.file);
      if(opened.kind==='recovery-offered'){
        const token=secret(),path=await this.broker.importedRecoveryPath(opened.recoverySessionId);
        if(!path)return unavailable();
        this.#offers.set(digestSecretHex(token),{path,hostSessionId:opened.recoverySessionId,expires:this.#now()+60000,recoveryOffer:opened.recoveryOffer});return {status:'busy',recoveryToken:token,canResume:true};
      }
      if(opened.kind==='focused'){
        const token=secret(),scope=this.broker.nativeAdmissionScope(opened.launch.sessionId);if(!scope)return unavailable();
        const sessionId = opened.launch.sessionId;
        const canResume = !this.#hasReviewGrant(sessionId) && await this.#host.state(sessionId) !== undefined;
        const disconnected = this.#disconnected(sessionId);
        this.#offers.set(digestSecretHex(token), { path: scope.canonicalSourcePath, hostSessionId: sessionId, live: this.#liveOffer(sessionId), ...(disconnected ? {disconnected} : {}), expires: this.#now() + 60000, ...(canResume ? { resumeLiveHostReview: true } : {}) });
        return { status: 'busy', recoveryToken: token, canResume, ...(disconnected ? {canRecover:true} : {}) };
      }
      this.#hostSessions.add(opened.launch.sessionId);return this.#provisional(opened);
    }
    const key=digestSecretHex(r.grant),record=this.#records.get(key);if(!record||!this.#hostSessions.has(record.sessionId))return unavailable();
    const assertAuthority=()=>{if(this.#closing||this.#records.get(key)!==record||record.expires<=this.#now())throw Error('Host authority retired');};
    if (record.copyAdmission) return unavailable();
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
      const releasedLocalSessionId = opened.kind === 'focused' && this.#canResumeReleasedLocal(opened.launch.sessionId) ? opened.launch.sessionId : undefined;
      const disconnected = opened.kind === 'focused' ? this.#disconnected(opened.launch.sessionId) : undefined;
      const token=secret();this.#offers.set(digestSecretHex(token),{path,targetSessionId:opened.kind==='recovery-offered'?opened.recoverySessionId:opened.launch.sessionId,...(opened.kind==='focused'?{live:this.#liveOffer(opened.launch.sessionId)}:{}),...(disconnected ? {disconnected} : {}),expires:this.#now()+60_000,...(opened.kind==='recovery-offered'?{recoveryOffer:opened.recoveryOffer}:{}),...(releasedLocalSessionId ? { releasedLocalSessionId } : {})});
      return {status:'busy',recoveryToken:token,canResume:opened.kind==='recovery-offered'||releasedLocalSessionId!==undefined,...(disconnected ? {canRecover:true} : {})};
    }
    return this.#provisional(opened);
  });}
  choose(input:Extract<ExtensionRequest,{action:'choose'}>):Promise<ExtensionResult>{return this.#serial(async()=>{
    this.#sweep();const offer=this.#offers.get(digestSecretHex(input.recoveryToken));
    if(!offer||this.#closing)return unavailable();
    if(offer.result)return offer.result.operationId===input.operationId&&offer.result.choice===input.choice?offer.result.value:unavailable();
    let result: OpenReviewResult | undefined;
    if (input.choice === 'recover') {
      const disconnected = offer.disconnected;
      if (!disconnected || !offer.live || !this.#currentLiveOffer(offer.live) || !this.#stillDisconnected(disconnected)) return unavailable();
      if ('copyRecovery' in offer && !await this.#host.matchesCopyRecovery(offer.copyRecovery)) return unavailable();
      const host = 'copyRecovery' in offer || offer.hostSessionId !== undefined;
      const reopened = host
        ? await this.broker.reopenLiveHostReview(disconnected.sessionId)
        : await this.broker.reopenLiveLocal(disconnected.sessionId, offer.path);
      this.#sweep();
      if (this.#closing || offer.expires <= this.#now() || reopened?.kind !== 'focused' ||
          !this.#currentLiveOffer(offer.live) || !this.#stillDisconnected(disconnected)) return unavailable();
      for (const { record } of disconnected.records) this.#remove(record);
      const value = this.#provisional(reopened, 'copyRecovery' in offer ? {match:offer.copyRecovery,verified:false,offer} : undefined, 'copyRecovery' in offer ? offer.copyRecovery.file : offer.hostFile);
      offer.result = { operationId: input.operationId, choice: input.choice, value };
      return value;
    }
    // Resume takes ownership of the offered session. Fork admits a separate review through the source checks below.
    if (input.choice === 'resume' && offer.live && !this.#currentLiveOffer(offer.live)) return unavailable();
    let hostSessionId: string | undefined;
    if ('copyRecovery' in offer) {
      hostSessionId = offer.copyRecovery.sessionId;
      if (!await this.#host.matchesCopyRecovery(offer.copyRecovery)) return unavailable();
      if (input.choice === 'resume' && offer.live && !this.#currentLiveOffer(offer.live)) return unavailable();
      result = input.choice === 'fork'
        ? await this.#host.fork(hostSessionId, offer.copyRecovery.sha256)
        : await this.#resumeMatchingCopy(hostSessionId, input.operationId);
    } else {
      if (input.choice === 'resume' && !offer.recoveryOffer && !offer.resumeLiveHostReview && !offer.releasedLocalSessionId) return unavailable();
      hostSessionId = offer.hostSessionId;
      if(input.choice==='fork'&&!hostSessionId&&!offer.recoveryOffer&&offer.targetSessionId){
        const exact=await this.broker.openReview({pdfPath:offer.path,surface:'codex-native',recoveryTargetSessionId:offer.targetSessionId});
        if(exact.kind!=='recovery-offered'||exact.recoverySessionId!==offer.targetSessionId)return unavailable();
        offer.recoveryOffer=exact.recoveryOffer;
      }
      if (input.choice === 'resume' && offer.releasedLocalSessionId) {
        if (!this.#canResumeReleasedLocal(offer.releasedLocalSessionId)) return unavailable();
        const reopened = await this.broker.reopenLiveLocal(offer.releasedLocalSessionId, offer.path);
        if (reopened?.kind !== 'focused' || reopened.launch.sessionId !== offer.releasedLocalSessionId ||
            !this.#canResumeReleasedLocal(offer.releasedLocalSessionId)) return unavailable();
        result = reopened;
      } else result = hostSessionId && input.choice === 'fork'
        ? await this.#host.fork(hostSessionId)
        : hostSessionId && offer.resumeLiveHostReview
          ? await this.#resumeMatchingCopy(hostSessionId, input.operationId)
          : await this.broker.openReview({pdfPath:offer.path,surface:'codex-native',recoveryDecision:input.choice,...(offer.targetSessionId?{recoveryTargetSessionId:offer.targetSessionId}:{}),...(offer.recoveryOffer?{recoveryOffer:offer.recoveryOffer,recoveryOperationId:input.operationId}:{})});
    }
    if(this.#closing||!result||result.kind==='recovery-offered')return unavailable();
    if (input.choice === 'resume' && offer.live &&
        (offer.expires <= this.#now() || !this.#currentLiveOffer(offer.live))) return unavailable();
    const admission = 'copyRecovery' in offer && input.choice === 'resume'
      ? { match: offer.copyRecovery, verified: false, offer }
      : undefined;
    const hostFile = 'copyRecovery' in offer ? offer.copyRecovery.file : offer.hostFile;
    if(hostSessionId){this.#hostSessions.add(result.launch.sessionId);const file=hostFile??this.#hostFiles.get(hostSessionId);if(file&&!admission)this.#hostFiles.set(result.launch.sessionId,file);}
    const value = this.#provisional(result, admission, hostFile);
    offer.result={operationId:input.operationId,choice:input.choice,value};return value;
  });}
  async #openRecent(id: string): Promise<ExtensionResult> {
    this.#sweep();const entry=await this.#recent.get(id);if(!entry||this.#closing)return unavailable();
    const live=this.broker.nativeAdmissionScope(entry.sessionId);
    const hostFile=entry.source.kind==='host'?this.#hostFiles.get(entry.sessionId)??entry.source.file:undefined;
    const host=hostFile!==undefined;
    const path=entry.source.kind==='local'?entry.source.path:await this.broker.importedRecoveryPath(entry.sessionId);
    if(!path)return unavailable();
    if(live){
      const scope=await this.broker.sessionScope(entry.sessionId);
      if(!scope || this.broker.taskBindings.taskForGeneration(entry.sessionId,live.documentGeneration))return unavailable();
      const disconnected=this.#disconnected(entry.sessionId),unowned=!this.#hasReviewGrant(entry.sessionId);
      if(unowned&&!host)this.#releasedLocalSessions.add(entry.sessionId);
      const token=secret();this.#offers.set(digestSecretHex(token),{path,expires:this.#now()+60000,targetSessionId:entry.sessionId,live:this.#liveOffer(entry.sessionId),
        ...(hostFile?{hostSessionId:entry.sessionId,hostFile,...(unowned?{resumeLiveHostReview:true as const}:{})}:unowned?{releasedLocalSessionId:entry.sessionId}:{}),
        ...(disconnected?{disconnected}:{})});
      return {status:'busy',recoveryToken:token,canResume:unowned,...(disconnected?{canRecover:true}:{})};
    }
    const opened=await this.broker.openReview({pdfPath:path,surface:'codex-native',recoveryTargetSessionId:entry.sessionId});
    if(opened.kind!=='recovery-offered'||opened.recoverySessionId!==entry.sessionId)return unavailable();
    const token=secret();this.#offers.set(digestSecretHex(token),{path,expires:this.#now()+60000,targetSessionId:entry.sessionId,recoveryOffer:opened.recoveryOffer,
      ...(hostFile?{hostSessionId:entry.sessionId,hostFile}:{})});
    return {status:'busy',recoveryToken:token,canResume:true};
  }
  #liveOffer(sessionId: string): LiveOffer | undefined {
    const scope = this.broker.nativeAdmissionScope(sessionId);
    if (!scope || this.broker.taskBindings.taskForGeneration(sessionId, scope.documentGeneration)) return;
    const owners = [...this.#records].flatMap(([key, record]) => record.sessionId === sessionId ? [key] : []);
    return { scope, owners, ownershipEpoch: this.#ownershipEpochs.get(sessionId) ?? 0 };
  }

  #currentLiveOffer(offer: LiveOffer, allowRelease = false): LiveOffer | undefined {
    const current = this.#liveOffer(offer.scope.reviewSessionId);
    if (!current || current.ownershipEpoch !== offer.ownershipEpoch ||
        current.scope.documentGeneration !== offer.scope.documentGeneration ||
        current.scope.canonicalSourcePath !== offer.scope.canonicalSourcePath ||
        current.scope.sourceDigest !== offer.scope.sourceDigest ||
        (!allowRelease && current.owners.length !== offer.owners.length) ||
        !current.owners.every(owner => offer.owners.includes(owner))) return;
    return current;
  }

  async #recheck(token: string): Promise<ExtensionResult> {
    this.#sweep();
    const key = digestSecretHex(token), offer = this.#offers.get(key);
    if (this.#closing || !offer?.live || offer.result || !this.#currentLiveOffer(offer.live, true)) return unavailable();
    const { scope } = offer.live;
    const sessionId = scope.reviewSessionId;
    const matchingCopy = 'copyRecovery' in offer;
    if (matchingCopy) {
      if (!await this.#host.matchesCopyRecovery(offer.copyRecovery)) return unavailable();
    } else if (offer.hostSessionId) {
      if (await this.#host.state(sessionId) === undefined) return unavailable();
    } else if (await realpath(offer.path) !== scope.canonicalSourcePath) return unavailable();

    this.#sweep();
    const live = this.#currentLiveOffer(offer.live, true);
    if (this.#closing || this.#offers.get(key) !== offer || !live) return unavailable();
    const disconnected = this.#disconnected(sessionId);
    const canResume = matchingCopy || offer.hostSessionId
      ? live.owners.length === 0
      : this.#canResumeReleasedLocal(sessionId);
    const refreshed: Offer = { ...offer, live, disconnected };
    if (canResume && !('copyRecovery' in refreshed)) {
      if (refreshed.hostSessionId) refreshed.resumeLiveHostReview = true;
      else refreshed.releasedLocalSessionId = sessionId;
    }
    // A lost reply can be retried with the same token until the original expiry.
    this.#offers.set(key, refreshed);
    return { status: 'busy', recoveryToken: token, canResume, ...(disconnected ? { canRecover: true } : {}), ...(matchingCopy ? { matchingCopy: true } : {}) };
  }

  #disconnected(sessionId: string): Offer['disconnected'] {
    const scope = this.broker.nativeAdmissionScope(sessionId);
    if (!scope || this.broker.taskBindings.taskForGeneration(sessionId, scope.documentGeneration)) return;
    const records = [...this.#records.values()].filter(record => record.sessionId === sessionId);
    if (records.length && records.every(record => !record.provisional && record.disconnected && !record.active)) return { sessionId, records: records.map(record => ({record,grantDigest:digestSecretHex(record.grant)})) };
  }
  #stillDisconnected(offer: NonNullable<Offer['disconnected']>): boolean {
    const current = this.#disconnected(offer.sessionId);
    return current !== undefined && current.records.length === offer.records.length && current.records.every(currentRecord => offer.records.some(previous => previous.record === currentRecord.record && previous.grantDigest === currentRecord.grantDigest));
  }
  #canResumeReleasedLocal(sessionId: string): boolean {
    const scope = this.broker.nativeAdmissionScope(sessionId);
    return this.#releasedLocalSessions.has(sessionId) && !this.#hasReviewGrant(sessionId) &&
      scope !== undefined && this.broker.taskBindings.taskForGeneration(sessionId, scope.documentGeneration) === undefined;
  }
  #hasReviewGrant(sessionId: string): boolean {
    for (const record of this.#records.values()) {
      if (record.sessionId === sessionId) return true;
    }
    return false;
  }
  async #resumeMatchingCopy(sessionId: string, operationId: string): Promise<OpenReviewResult | undefined> {
    if (this.#hasReviewGrant(sessionId)) return;
    if (this.broker.nativeAdmissionScope(sessionId)) {
      return this.broker.reopenLiveHostReview(sessionId).catch(() => undefined);
    }
    const path = await this.broker.importedRecoveryPath(sessionId);
    if (!path) return;
    const offered = await this.broker.openReview({ pdfPath: path, surface: 'codex-native' });
    if (offered.kind !== 'recovery-offered' || offered.recoverySessionId !== sessionId) return;
    return this.broker.openReview({
      pdfPath: path, surface: 'codex-native', recoveryDecision: 'resume',
      recoveryOffer: offered.recoveryOffer, recoveryOperationId: operationId,
    });
  }
  #registerGrant(record: RecordState): void {
    this.#ownershipEpochs.set(record.sessionId, (this.#ownershipEpochs.get(record.sessionId) ?? 0) + 1);
    this.#records.set(digestSecretHex(record.grant), record);
  }

  #currentRotation(key: string, operationId: string | undefined): RotationReceipt | undefined {
    const receipt = this.#receipts.get(key);
    if (receipt && receipt.operationId === operationId && receipt.expires > this.#now() &&
        receipt.result.grant === receipt.record.grant &&
        this.#records.get(digestSecretHex(receipt.result.grant)) === receipt.record) return receipt;
  }

  #provisional(result:Exclude<OpenReviewResult,{kind:'recovery-offered'}>, copyAdmission?: RecordState['copyAdmission'], hostFile?:HostResourceFile):ExtensionResult{
    this.#releasedLocalSessions.delete(result.launch.sessionId);
    const grant=secret();const record:RecordState={sessionId:result.launch.sessionId,grant,expires:this.#now()+Math.min(60_000,this.#idle),provisional:true,watermark:0,contextPublished:false,...(copyAdmission ? { copyAdmission } : {})};
    this.#registerGrant(record);return {status:'provisional',grant,...(hostFile?{hostFile}:{})};
  }
  resume(grant:string,operationId:string,action:'activate'|'resume'='resume'):Promise<ExtensionResult>{return this.#serial(async()=>{
    this.#sweep();if(this.#closing)return unavailable();const key=digestSecretHex(grant),receipt=this.#receipts.get(key);
    if (receipt) {
      return receipt.action === action && this.#currentRotation(key, operationId) &&
        receipt.result.presentation === receipt.record.active
        ? { ...receipt.result, contextPublished: receipt.record.contextPublished }
        : unavailable();
    }
    const record=this.#records.get(key);if(!record||record.provisional!==(action==='activate'))return unavailable();
    const scope=this.broker.nativeAdmissionScope(record.sessionId);if(!scope)return unavailable();
    // Revalidate local source through the canonical broker before exposing another incarnation.
    if(!this.#hostSessions.has(record.sessionId)&&!await reconcileNativeSource(this.broker,record.sessionId,scope.canonicalSourcePath))return unavailable();
    if(this.#closing||this.#records.get(key)!==record)return unavailable();
    const current=this.broker.nativeAdmissionScope(record.sessionId);if(!current||this.broker.taskBindings.taskForGeneration(record.sessionId,current.documentGeneration)!==undefined)return unavailable();
    const admission = record.copyAdmission;
    if (admission) {
      if (!admission.verified || admission.match.sha256 !== current.sourceDigest) return unavailable();
      const adopted = await this.broker.adoptHostCopySourceIdentity(
        record.sessionId, digestSecretHex(admission.match.file.resourceUri), current.sourceDigest,
        () => !this.#closing && this.#records.get(key) === record,
      );
      if (!adopted || this.#closing || this.#records.get(key) !== record) return unavailable();
      this.#hostFiles.set(record.sessionId, admission.match.file);
      delete record.copyAdmission;
    }
    const sourceScope=await this.broker.sessionScope(record.sessionId);
    const hostFile=this.#hostFiles.get(record.sessionId);
    if(sourceScope && (!this.#hostSessions.has(record.sessionId)||hostFile)){
      await this.broker.protectChromeReview(record.sessionId);
      const recent=await this.#recent.remember({sessionId:record.sessionId,title:sourceScope.sourceDisplayName,
        source:hostFile?{kind:'host',file:hostFile}:{kind:'local',path:current.canonicalSourcePath}}).catch(()=>undefined);
      // Reopen hints are optional; durable review protection above is not.
      if(recent?.page!==undefined)record.page=recent.page;
    }
    if(this.#closing||this.#records.get(key)!==record||this.broker.nativeAdmissionScope(record.sessionId)?.documentGeneration!==current.documentGeneration)return unavailable();
    this.#suspend(record);delete record.disconnected;this.#records.delete(key);record.grant=secret();record.provisional=false;record.expires=this.#now()+this.#idle;
    const presentation:ExtensionPresentation={status:'active',runtimeId:opaque(),attemptId:opaque(),generation:current.documentGeneration,presentationCapability:secret(),reconnectTicket:secret()};
    record.active=presentation;record.lease=this.#now()+this.#lease;this.#registerGrant(record);this.#panels.set(presentation.runtimeId,record);
    this.#backend.attach(this.#scope(record));
    const result:RotationReceipt['result']={status:'active',grant:record.grant,presentation,contextPublished:record.contextPublished};
    this.#receipts.set(key,{operationId,action,expires:this.#now()+30_000,record,result});return result;
  });}
  #scope(r:RecordState):CodexActiveScope{return {sessionId:r.sessionId,runtimeId:r.active!.runtimeId,attemptId:r.active!.attemptId,generation:r.active!.generation,...(r.page?{requestedLocation:{kind:'page' as const,page:r.page}}:{})};}
  #suspend(r:RecordState){if(r.active){this.#backend.detach(r.active.runtimeId);this.#panels.delete(r.active.runtimeId);}delete r.active;}
  #remove(r:RecordState){this.#suspend(r);this.#records.delete(digestSecretHex(r.grant));for(const [key,receipt]of this.#receipts)if(receipt.record===r)this.#receipts.delete(key);}
  #sweep(){const now=this.#now();for(const [key,revoked]of this.#revoked)if(revoked.expires<=now)this.#revoked.delete(key);for(const [key,t]of this.#hostTickets)if(t.expires<=now)this.#hostTickets.delete(key);void this.#host.sweep();for(const r of this.#records.values()){if(r.expires<=now){this.#releasedLocalSessions.add(r.sessionId);this.#remove(r);}else if(r.lease!==undefined&&r.lease<=now){this.#suspend(r);delete r.lease;r.disconnected=true;}}for(const [key,o]of this.#offers)if(o.expires<=now)this.#offers.delete(key);for(const [key,r]of this.#receipts)if(r.expires<=now)this.#receipts.delete(key);}
  async revoke(grant: string, operationId?: string): Promise<boolean> {
    return this.#serial(async () => {
      this.#sweep();
      const key = digestSecretHex(grant), revoked = this.#revoked.get(key);
      if (revoked) return revoked.operationId === undefined || revoked.operationId === operationId;
      const direct = this.#records.get(key);
      const rotation = direct ? undefined : this.#currentRotation(key, operationId);
      const record = direct ?? rotation?.record;
      if (!record) return false;
      const scope = await this.broker.sessionScope(record.sessionId);
      this.#sweep();
      if (rotation ? this.#currentRotation(key, operationId) !== rotation : this.#records.get(key) !== record) return false;
      this.#remove(record);
      if (scope?.sourceDisposition === 'local') this.#releasedLocalSessions.add(record.sessionId);
      this.#revoked.set(key, { expires: this.#now() + 5 * 60_000, ...(rotation ? { operationId: rotation.operationId } : {}) });
      return true;
    });
  }
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
  async close(){this.#closing=true;await this.#host.close();await this.#tail;await Promise.allSettled([...this.#requests]);await this.#host.close();this.#hostTickets.clear();this.#hostSessions.clear();this.#hostFiles.clear();clearInterval(this.#timer);this.#unsubscribe();this.#unsubscribeEnd();for(const r of this.#records.values())this.#remove(r);this.#offers.clear();this.#receipts.clear();this.#revoked.clear();this.#ownershipEpochs.clear();this.#releasedLocalSessions.clear();}
}
