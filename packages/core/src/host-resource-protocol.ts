/** Private, bounded app-to-service transfer protocol. Resource URIs are identifiers. */
export const HOST_RESOURCE_MAX_BYTES = 64 * 1024 * 1024;
export const HOST_RESOURCE_CHUNK_BYTES = 192 * 1024;
export type HostResourceFile = {
    name: string;
    resourceUri: string;
};
export type HostResourceIntent = {
    id: string;
    generation: number;
    revision: number;
    stateDigest: string;
    sourceDigest: string;
    sha256: string;
    byteLength: number;
    ifMatch: string;
    purpose: 'save' | 'export';
};
export type HostResourceRequest = {
    action: 'host-open';
    file: HostResourceFile;
} | {
    action: 'host-resource';
    operation: 'begin';
    ticket?: string;
    grant?: string;
    byteLength: number;
    sha256: string;
    writable: boolean;
    etag?: string;
} | {
    action: 'host-resource';
    operation: 'chunk';
    transfer: string;
    offset: number;
    dataBase64: string;
} | {
    action: 'host-resource';
    operation: 'finish';
    transfer: string;
} | {
    action: 'host-resource';
    operation: 'cancel';
    transfer: string;
} | {
    action: 'host-resource';
    operation: 'save';
    grant: string;
} | {
    action: 'host-resource';
    operation: 'status';
    grant: string;
} | {
    action: 'host-resource';
    operation: 'export';
    grant: string;
    expectedRevision: number;
    generation: number;
} | {
    action: 'host-resource';
    operation: 'save-chunk';
    grant: string;
    intentId: string;
    offset: number;
} | {
    action: 'host-resource';
    operation: 'receipt';
    grant: string;
    intentId: string;
    outcome: 'saved' | 'conflict' | 'unknown';
    etag?: string;
};
export type HostResourceResult = {
    status: 'host-resource';
    file: HostResourceFile;
    ticket: string;
} | {
    status: 'host-transfer';
    transfer: string;
    offset: number;
} | {
    status: 'host-ready';
    generation: number;
} | {
    status: 'host-save';
    intent: HostResourceIntent;
} | {
    status: 'host-chunk';
    dataBase64: string;
    done: boolean;
} | {
    status: 'host-status';
    outcome: 'saved' | 'protected' | 'conflict' | 'unknown' | 'read-only' | 'local-copy';
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const etag = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const offset = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= HOST_RESOURCE_MAX_BYTES;
export function parseHostResourceRequest(v: unknown): HostResourceRequest | undefined {
    if (!object(v))
        return;
    const keys = (...allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
    if (v.action === 'host-open' && keys('action', 'file') && object(v.file) && Object.keys(v.file).every(k => k === 'name' || k === 'resourceUri') && typeof v.file.name === 'string' && v.file.name.length > 0 && v.file.name.length <= 120 && typeof v.file.resourceUri === 'string' && v.file.resourceUri.length > 0 && v.file.resourceUri.length <= 32768)
        return v as HostResourceRequest;
    if (v.action !== 'host-resource')
        return;
    if (v.operation === 'begin' && keys('action', 'operation', 'ticket', 'grant', 'byteLength', 'sha256', 'writable', 'etag') && ((token(v.ticket) && v.grant === undefined) || (token(v.grant) && v.ticket === undefined)) && offset(v.byteLength) && v.byteLength > 0 && digest(v.sha256) && typeof v.writable === 'boolean' && (v.etag === undefined || etag(v.etag)))
        return v as HostResourceRequest;
    if (v.operation === 'chunk' && keys('action', 'operation', 'transfer', 'offset', 'dataBase64') && token(v.transfer) && offset(v.offset) && typeof v.dataBase64 === 'string' && v.dataBase64.length > 0 && v.dataBase64.length <= HOST_RESOURCE_CHUNK_BYTES / 3 * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.dataBase64))
        return v as HostResourceRequest;
    if ((v.operation === 'finish' || v.operation === 'cancel') && keys('action', 'operation', 'transfer') && token(v.transfer))
        return v as HostResourceRequest;
    if (v.operation === 'export' && keys('action', 'operation', 'grant', 'expectedRevision', 'generation') && token(v.grant) && Number.isSafeInteger(v.expectedRevision) && (v.expectedRevision as number) >= 0 && Number.isSafeInteger(v.generation) && (v.generation as number) > 0)
        return v as HostResourceRequest;
    if ((v.operation === 'save' || v.operation === 'status') && keys('action', 'operation', 'grant') && token(v.grant))
        return v as HostResourceRequest;
    if (v.operation === 'save-chunk' && keys('action', 'operation', 'grant', 'intentId', 'offset') && token(v.grant) && token(v.intentId) && offset(v.offset))
        return v as HostResourceRequest;
    if (v.operation === 'receipt' && keys('action', 'operation', 'grant', 'intentId', 'outcome', 'etag') && token(v.grant) && token(v.intentId) && (v.outcome === 'saved' || v.outcome === 'conflict' || v.outcome === 'unknown') && (v.etag === undefined || etag(v.etag)) && (v.outcome !== 'saved' || etag(v.etag)))
        return v as HostResourceRequest;
}
export function parseHostResourceResult(v: unknown): HostResourceResult | undefined {
    if (!object(v))
        return;
    if (v.status === 'host-resource' && token(v.ticket) && parseHostResourceRequest({ action: 'host-open', file: v.file }))
        return v as HostResourceResult;
    if (v.status === 'host-transfer' && token(v.transfer) && offset(v.offset))
        return v as HostResourceResult;
    if (v.status === 'host-ready' && Number.isSafeInteger(v.generation) && (v.generation as number) > 0)
        return v as HostResourceResult;
    if (v.status === 'host-chunk' && typeof v.dataBase64 === 'string' && v.dataBase64.length <= HOST_RESOURCE_CHUNK_BYTES / 3 * 4 && typeof v.done === 'boolean')
        return v as HostResourceResult;
    if (v.status === 'host-status' && ['saved', 'protected', 'conflict', 'unknown', 'read-only', 'local-copy'].includes(v.outcome as string))
        return v as HostResourceResult;
    if (v.status === 'host-save' && object(v.intent) && token(v.intent.id) && Number.isSafeInteger(v.intent.generation) && (v.intent.generation as number) > 0 && Number.isSafeInteger(v.intent.revision) && (v.intent.revision as number) >= 0 && digest(v.intent.stateDigest) && digest(v.intent.sourceDigest) && digest(v.intent.sha256) && offset(v.intent.byteLength) && (v.intent.byteLength as number) > 0 && (v.intent.purpose === 'save' && etag(v.intent.ifMatch) || v.intent.purpose === 'export' && v.intent.ifMatch === ''))
        return v as HostResourceResult;
}
